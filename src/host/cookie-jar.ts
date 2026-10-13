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
import { join } from 'node:path'

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
 * ## 为什么用 try + 动态 require
 *
 * - 插件 host 半在 Electron 主进程里跑时，`require('electron')` 可用
 * - 但**单元测试 / 纯 node 环境**下不可用（会 MODULE_NOT_FOUND）
 * - 而且 Electron 的 `session` 只在主进程可用，渲染进程拿到的是空壳
 *
 * 所以这里探测式获取：拿不到就返回 undefined，调用方走降级路径。
 * **绝不能因为拿不到就抛错** —— 那会让整个插件加载失败。
 */
function tryElectronSession(): {
  fromPartition: (name: string) => {
    cookies: {
      get: (filter: Record<string, unknown>) => Promise<CookieArchive['cookies']>
      set: (details: Record<string, unknown>) => Promise<void>
      remove: (url: string, name: string) => Promise<void>
    }
  }
} | undefined {
  try {
    /** 动态 require —— 静态 import 会让打包器把 electron 塞进产物。 */
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const req = eval('require') as (m: string) => unknown
    const electron = req('electron') as {
      session?: {
        fromPartition: (name: string) => {
          cookies: {
            get: (filter: Record<string, unknown>) => Promise<CookieArchive['cookies']>
            set: (details: Record<string, unknown>) => Promise<void>
            remove: (url: string, name: string) => Promise<void>
          }
        }
      }
    }
    if (electron?.session?.fromPartition === undefined) return undefined
    return electron.session
  } catch {
    return undefined
  }
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
