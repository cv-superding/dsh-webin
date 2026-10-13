/**
 * ## 用 Electron 的 session API 持久化 cookie（**解决「重启必须重新登录」**）
 *
 * ## 为什么必须走这条路
 *
 * 用户实测报的：「每次重启 dsh 都需要重新登陆 deepseek？无语了」
 *
 * 根因链：
 *   1. DSH 的 guest partition 是 `dsh-sidebar-browser-${randomUUID()}`
 *      （`lib/main.js:9638`）—— **无 `persist:` 前缀 = 内存分区**，
 *      进程一退，cookie 全丢；
 *   2. DeepSeek 的登录态主要靠 **httpOnly cookie**；
 *   3. 页面里的 JS（`document.cookie`）**看不见也写不了** httpOnly cookie。
 *
 * 所以「把 localStorage + document.cookie 存成快照再回写」这条路
 * **天生不完整** —— 快照里根本没有真正决定登录态的那几个 cookie。
 *
 * 插件 host 半跑在 DSH 主进程（Electron）里，**能拿到
 * `session.fromPartition(...).cookies`**，那个 API 包含 httpOnly。
 *
 * ## 怎么拿到 partition
 *
 * 我们**不猜** partition 名（它是 randomUUID，猜不到）。client 半在
 * webview 挂载后会知道自己的 partition（从 lease 来），把它上报给 host，
 * host 再用 `session.fromPartition(那个名字)` 取 cookie。
 *
 * ⚠️ 但 client 半拿不到 partition —— `acquire()` 的返回值只在
 * DSH 内部用。所以这里改成**扫描式**：遍历当前所有 partition，
 * 找出域名匹配目标平台的那个。`session.fromPartition` 只能按名字取，
 * 所以还需要枚举名字 —— Electron 没有「列出所有 partition」的 API。
 *
 * ## 因此：退一步，用「按名字试探 + 全量扫描 fallback」
 *
 * 实际上 Electron 的 `session.defaultSession` 与所有 partition 共享
 * cookie jar 的**域名索引**吗？不 —— 每个 partition 独立。
 *
 * **结论：拿不到名字就拿不到 session。**
 *
 * 所以本模块做的是**另一件确定可行的事**：让 client 半在**能拿到
 * partition 名字**时上报它（DSH 的 `webview` 元素上 `partition` 属性
 * 是我们自己设的 —— 但那是我们编的，不是 DSH 分配的）。
 *
 * 于是最终方案改为：**client 侧把 cookie 快照能力做全**（见下），
 * host 侧提供一个「如果 electron 可用就顺便用 API 补全 httpOnly」的
 * 可选增强。两者都不行时，明确告诉用户「需要重新登录一次」。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

/**
 * Electron `session` 的最小结构（只声明我们用到的那几项）。
 *
 * 抽成类型是因为 `tryElectronSession()` 现在要**多种策略依次尝试** ——
 * 每种的返回值都要用同一个判据检查。
 */
interface ElectronSession {
  fromPartition: (name: string) => {
    cookies: {
      get: (filter: Record<string, unknown>) => Promise<CookieArchive['cookies']>
      set: (details: Record<string, unknown>) => Promise<void>
      remove: (url: string, name: string) => Promise<void>
    }
  }
}

/** 一个平台的 cookie 存档。 */
export interface CookieArchive {
  platform: string
  /** Electron 的 `cookies.get()` 返回的原始条目（含 httpOnly）。 */
  cookies: {
    name: string
    value: string
    domain: string
    path: string
    secure: boolean
    httpOnly: boolean
    expirationDate?: number
    sameSite?: string
  }[]
  /** 存档时刻。 */
  at: number
}

/** cookie 存档目录。 */
function cookieDir(stateRoot: string): string {
  return join(stateRoot, 'cookies')
}

function cookieFile(stateRoot: string, platform: string): string {
  /** 平台 id 可能含路径分隔符（自定义 provider 允许），换成安全的字符。 */
  const safe = platform.replace(/[^A-Za-z0-9_.-]/g, '_')
  return join(cookieDir(stateRoot), `${safe}.json`)
}

/**
 * 尝试拿 Electron 的 session 模块。
 *
 * ## ⚠️ 为什么不能用 `eval('require')`（我第一版写错了，**实测才发现**）
 *
 * 第一版写的是 `const req = eval('require')` —— 以为这样能绕过打包器。
 * 但**插件的 host 产物是 ESM**（`tsdown.config.ts` 里 `format: 'esm'`），
 * ESM 模块里**根本没有 `require`** ⇒ `eval('require')` 抛
 * `ReferenceError` ⇒ 被 catch 吞掉 ⇒ 永远返回 undefined。
 *
 * **实测证据**（对运行中的 host 打 `POST /client/partition`）：
 *
 *     {"ok":true,"cookieApi":false,"archived":false}
 *
 * `cookieApi:false` 意味着「重启免登录」那条路**从来没生效过** ——
 * 用户报「每次重启 dsh 都需要重新登陆」，我以为是分区问题，
 * 实际上我连 Electron API 都没拿到。
 *
 * ## 正确做法：`createRequire(import.meta.url)`
 *
 * ESM 里拿 `require` 的标准方式。
 *
 * ## 为什么还要 try/catch
 *
 * - **单元测试 / 纯 node 环境**下 `require('electron')` 会 MODULE_NOT_FOUND
 * - Electron 的 `session` 只在**主进程**可用
 *
 * 拿不到就返回 undefined，调用方走降级路径。
 * **绝不能因为拿不到就抛错** —— 那会让整个插件加载失败。
 */
function tryElectronSession(): ElectronSession | undefined {
  /** 判据统一：拿到 `session.fromPartition` 才算成功。 */
  const strategies: (() => unknown)[] = [
    () => {
      const meta = import.meta as unknown as { url?: string }
      return typeof meta.url === 'string' ? createRequire(meta.url)('electron') : undefined
    },
    /** ⭐ 以 Electron 可执行文件为基准 —— 它的 node_modules 里有 electron。 */
    () => createRequire(String(process.execPath))('electron'),
    () => {
      const mm = (process as unknown as { mainModule?: { require?: (m: string) => unknown } }).mainModule
      return typeof mm?.require === 'function' ? mm.require('electron') : undefined
    },
    () => {
      const g = globalThis as unknown as { require?: (m: string) => unknown }
      return typeof g.require === 'function' ? g.require('electron') : undefined
    },
    () => {
      const eb = (process as unknown as { electronBinding?: (n: string) => unknown }).electronBinding
      return typeof eb === 'function' ? eb('electron_module') : undefined
    },
  ]

  for (const get of strategies) {
    try {
      const electron = get() as { session?: ElectronSession } | undefined
      if (electron?.session?.fromPartition !== undefined) return electron.session
    } catch {
      /** 这条不行就试下一条 —— 不抛。 */
    }
  }
  return undefined
}

/**
 * 诊断：**为什么**拿不到 Electron session？
 *
 * ## 为什么要这个（用户要求「不要猜」）
 *
 * 实测 `cookieApi: false`，光看这一个布尔值**分不清原因**。
 * 加了诊断路由后拿到确切答案：
 *
 *     hasImportMetaUrl: true            ← createRequire 可用
 *     requireKind: "function"           ← 同上
 *     error: "Cannot find module 'electron'"
 *     electronVersion: "44.0.0"         ← 确实在 Electron 里
 *     processType: "(none)"             ← process.type 不是 'browser'
 *
 * 所以是**模块解析**问题（插件从自己目录加载，那里没有 electron 包），
 * 而且进程类型可疑。
 *
 * ## 做法：**把所有可能的获取方式都试一遍，列出哪个成功**
 *
 * 不猜「哪种能行」—— 全部实测，把结果列出来。拿到 `session.fromPartition`
 * 的算成功。
 */
export function diagnoseElectron(): {
  hasImportMetaUrl: boolean
  importMetaUrl: string
  error?: string
  processType: string
  electronVersion: string
  nodeVersion: string
  argv0: string
  execPath: string
  resourcePath: string
  hasElectronBinding: boolean
  hasMainModule: boolean
  /** 逐个策略的结果 —— 哪个成功一眼可见。 */
  strategies: { name: string; ok: boolean; detail: string }[]
} {
  const out = {
    hasImportMetaUrl: false,
    importMetaUrl: '',
    error: undefined as string | undefined,
    processType: String((process as unknown as { type?: string }).type ?? '(none)'),
    electronVersion: String((process.versions as unknown as { electron?: string }).electron ?? '(none)'),
    nodeVersion: process.version,
    argv0: String(process.argv0 ?? '').slice(0, 160),
    execPath: String(process.execPath ?? '').slice(0, 160),
    resourcePath: String((process as unknown as { resourcesPath?: string }).resourcesPath ?? '(none)'),
    hasElectronBinding:
      typeof (process as unknown as { electronBinding?: unknown }).electronBinding === 'function',
    hasMainModule: (process as unknown as { mainModule?: unknown }).mainModule !== undefined,
    strategies: [] as { name: string; ok: boolean; detail: string }[],
  }

  const meta = import.meta as unknown as { url?: string }
  out.hasImportMetaUrl = typeof meta.url === 'string'
  out.importMetaUrl = typeof meta.url === 'string' ? meta.url.slice(0, 200) : ''

  /**
   * ## 逐个试所有获取方式
   *
   * 判据统一：**拿到 `session.fromPartition` 才算成功**。
   * 拿到一个空壳 electron（渲染进程里就是）不算。
   */
  const strategies: { name: string; get: () => unknown }[] = [
    {
      name: 'createRequire(import.meta.url)("electron")',
      get: () => (typeof meta.url === 'string' ? createRequire(meta.url)('electron') : undefined),
    },
    {
      name: 'createRequire(execPath)("electron")',
      get: () => createRequire(String(process.execPath))('electron'),
    },
    {
      name: 'process.mainModule.require("electron")',
      get: () => {
        const mm = (process as unknown as { mainModule?: { require?: (m: string) => unknown } })
          .mainModule
        return typeof mm?.require === 'function' ? mm.require('electron') : undefined
      },
    },
    {
      name: 'globalThis.require("electron")',
      get: () => {
        const g = globalThis as unknown as { require?: (m: string) => unknown }
        return typeof g.require === 'function' ? g.require('electron') : undefined
      },
    },
    {
      name: 'process.electronBinding("electron_module")',
      get: () => {
        const eb = (process as unknown as { electronBinding?: (n: string) => unknown }).electronBinding
        return typeof eb === 'function' ? eb('electron_module') : undefined
      },
    },
  ]

  for (const s of strategies) {
    try {
      const got = s.get() as { session?: { fromPartition?: unknown } } | undefined
      const hasSession = got?.session !== undefined && got?.session !== null
      const hasFromPartition = typeof got?.session?.fromPartition === 'function'
      out.strategies.push({
        name: s.name,
        ok: hasFromPartition,
        detail: hasFromPartition
          ? '✅ 拿到 session.fromPartition'
          : got === undefined
            ? '返回 undefined'
            : '拿到 ' + typeof got + '，session=' + String(hasSession),
      })
    } catch (e) {
      out.strategies.push({ name: s.name, ok: false, detail: (e as Error)?.message ?? String(e) })
    }
  }

  /** 全都失败时，把第一条的错误原文当主因（最可能是它）。 */
  if (!out.strategies.some((s) => s.ok)) {
    const first = out.strategies[0]
    if (first !== undefined) out.error = first.detail
  }

  return out
}

/** Electron 的 session 是否可用（供 `/status` 显示，让用户知道走哪条路）。 */
export function cookieApiAvailable(): boolean {
  return tryElectronSession() !== undefined
}

/**
 * 从指定 partition 抓取某域名的全部 cookie（**含 httpOnly**）。
 *
 * @param partition - DSH 分配的 partition 名（client 上报）
 * @param domain - 目标域名（如 `chat.deepseek.com`）
 * @returns cookie 列表；session 不可用时返回 undefined（调用方降级）
 */
export async function grabCookies(
  partition: string,
  domain: string,
): Promise<CookieArchive['cookies'] | undefined> {
  const ses = tryElectronSession()
  if (ses === undefined) return undefined
  try {
    const all = await ses.fromPartition(partition).cookies.get({})
    /** 域名匹配：Electron 的 domain 可能带前导点（`.deepseek.com`）。 */
    return all.filter((c) => {
      const d = String(c.domain ?? '').replace(/^\./, '')
      return d === domain || domain.endsWith(`.${d}`) || d.endsWith(`.${domain}`)
    })
  } catch {
    return undefined
  }
}

/**
 * 把 cookie 写回指定 partition。
 *
 * ## 为什么必须带 url
 *
 * Electron 的 `cookies.set()` 要求给出 `url`（它从 url 推导 domain/path/
 * secure）。只给 `domain` 不生效 —— 这是踩过的坑。
 */
export async function restoreCookies(
  partition: string,
  cookies: CookieArchive['cookies'],
): Promise<number> {
  const ses = tryElectronSession()
  if (ses === undefined) return 0
  const jar = ses.fromPartition(partition).cookies
  let ok = 0
  for (const c of cookies) {
    try {
      const host = String(c.domain ?? '').replace(/^\./, '')
      const scheme = c.secure === true ? 'https' : 'http'
      await jar.set({
        url: `${scheme}://${host}${c.path === '' ? '/' : c.path}`,
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path === '' ? '/' : c.path,
        secure: c.secure === true,
        httpOnly: c.httpOnly === true,
        ...(c.expirationDate === undefined ? {} : { expirationDate: c.expirationDate }),
        ...(c.sameSite === undefined ? {} : { sameSite: c.sameSite }),
      })
      ok += 1
    } catch {
      /* 单条失败不影响其他 */
    }
  }
  return ok
}

/** 存档 cookie 到磁盘。 */
export function saveCookieArchive(stateRoot: string, archive: CookieArchive): void {
  const dir = cookieDir(stateRoot)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(cookieFile(stateRoot, archive.platform), JSON.stringify(archive), 'utf8')
}

/** 读 cookie 存档。 */
export function loadCookieArchive(stateRoot: string, platform: string): CookieArchive | undefined {
  const f = cookieFile(stateRoot, platform)
  if (!existsSync(f)) return undefined
  try {
    const raw = readFileSync(f, 'utf8')
    const parsed = JSON.parse(raw) as CookieArchive
    if (!Array.isArray(parsed.cookies)) return undefined
    return parsed
  } catch {
    return undefined
  }
}

/** 删除 cookie 存档（用户登出时）。 */
export function dropCookieArchive(stateRoot: string, platform: string): boolean {
  const f = cookieFile(stateRoot, platform)
  if (!existsSync(f)) return false
  try {
    rmSync(f)
    return true
  } catch {
    return false
  }
}
