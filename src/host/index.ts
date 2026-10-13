/**
 * dsh-webin — host 半。
 *
 * 职责：
 *   1. 为**每个平台**注册 provider 路由（`webin-deepseek`、`webin-qwen`…），
 *      让各平台的网页版出现在模型选择器里
 *   2. 任务队列：把 agent 的 prompt 派给 client，等 client 从真实浏览器取回回复
 *   3. 登录态快照的**持久化**（`~/.dsh/webin/auth/`，跨 DSH 重启存活）
 *   4. 自定义 provider 的**持久化**（`~/.dsh/webin/providers/`）
 *
 * 为什么持久化放在 host 而不是 client：
 *   DSH 的 guest partition 是 `dsh-sidebar-browser-${randomUUID()}`
 *   （`main.js:9638`，**无 `persist:` 前缀 ⇒ 内存分区**）。
 *   client 侧的 `window.localStorage` 也跟着主窗口 profile 走，不是我们自己的存储；
 *   只有 host 侧的文件系统是真正由本插件掌控、且跨重启存活的。
 *
 * ## 多平台隔离怎么实现的
 *
 * `DesktopBrowserGuests.acquire(owner, workspace)` 按 **workspace 字符串**缓存
 * partition（`main.js:9636-9641`）：
 *
 * ```js
 * let partition = this.partitions.get(workspace);
 * if (partition === void 0) {
 *   partition = `dsh-sidebar-browser-${randomUUID()}`;
 *   this.partitions.set(workspace, partition);
 * }
 * ```
 *
 * 所以**用 provider.id 当 workspace 名**，各平台自然拿到不同 partition、
 * 不同 cookie / localStorage ⇒ **登录态天然隔离**，且不需要改 DSH 一行。
 */
import { mkdir, readFile, writeFile, rename, readdir, unlink } from 'node:fs/promises'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createAdapter, JobQueue, routeFor, ROUTE_PREFIX } from './adapter'
import type { CursorStore, SessionCursor } from './adapter'
import { DEFAULT_PROVIDER_ID, ProviderRegistry } from '../shared/providers'
import { snapshotTextLooksLoggedIn } from '../shared/auth-snapshot'
import {
  cookieApiAvailable,
  grabCookies,
  loadCookieArchive,
  restoreCookies,
  saveCookieArchive,
} from './cookie-jar'
import {
  checkForUpdate,
  describeUpdate,
  currentVersion,
  repoUrl,
  starUrl,
  updateHint,
  type UpdateCheck,
} from '../shared/version'
import {
  checkConfig,
  DEFAULT_CONFIG,
  describeConfig,
  LIMITS,
  type ConfigCheck,
  type WebinConfig,
} from '../shared/config'

export const name = 'dsh-webin'

/** 硬依赖 webServer（路由）与 llm（注册 provider）。 */
export const inject = ['webServer', 'llm']

/** 路由前缀（client 半同源 fetch 这个前缀）。 */
const API_PREFIX = '/dsh-webin/api'

/** 默认账号槽位名。 */
const DEFAULT_SLOT = 'default'

/** 请求体上限，防止意外灌爆内存。 */
const BODY_LIMIT_BYTES = 2 * 1024 * 1024

/** 状态根目录：`~/.dsh/webin/`。 */
function stateRoot(): string {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'webin')
}

/** 单个槽位的快照文件路径。 */
function snapshotPath(slot: string): string {
  const safe = /^[A-Za-z0-9_-]{1,64}$/.test(slot) ? slot : DEFAULT_SLOT
  return join(stateRoot(), 'auth', `${safe}.json`)
}

/**
 * 某个平台「已登录」吗？
 *
 * ## 判据：快照存在**且**快照里确实有登录凭据
 *
 * 为什么不看「浏览器在线」：那样重启 DSH 后、用户还没切到 LDW 标签时，
 * 模型会从选择器里消失 —— 用户会以为插件坏了。
 *
 * 快照是**持久化**的（`~/.dsh/webin/auth/<platform>.json`），
 * 它记录的是「上次确实登录过」。所以用它判断「能否使用 LDW 模型」最稳：
 *   - 登录过 ⇒ 模型可选，即便此刻浏览器没开（发送时会提示打开标签）
 *   - 没登录过 ⇒ 模型不列出，用户先去登录
 *
 * ⚠️ 注意用 `snapshotTextLooksLoggedIn` 而不是「文件存在」——
 * 未登录时页面也会写 `userToken={"value":null}`，那种快照不算登录。
 */
function isPlatformLoggedIn(platform: string): boolean {
  try {
    const path = snapshotPath(platform)
    if (!existsSync(path)) return false
    return snapshotTextLooksLoggedIn(readFileSync(path, 'utf8'))
  } catch {
    return false
  }
}

/**
 * 已登录的平台 id 列表（给状态接口与设置页用）。
 *
 * 注意判据是**登录快照**而不是「浏览器在线」—— 快照跨重启存活，
 * 所以重启后未打开标签页时也能正确报告「这个平台登录过」。
 *
 * @param platforms - 平台清单（注册表在 `apply()` 内，所以由调用方传入）
 */
function loggedInPlatforms(platforms: readonly { id: string }[]): string[] {
  const out: string[] = []
  for (const p of platforms) {
    if (isPlatformLoggedIn(p.id)) out.push(p.id)
  }
  return out
}

/**
 * 自定义 provider 的存放目录：`~/.dsh/webin/providers/`。
 *
 * 一个平台一个 `<id>.json`（内容是单个 Provider 对象）。
 * 与登录态快照同一套存储策略：host 侧落盘，跨重启存活。
 */
function providersDir(): string {
  return join(stateRoot(), 'providers')
}

/** 读全部自定义 provider（跳过读不动的文件，不因为一个坏文件全盘失败）。 */
async function readCustomProviders(): Promise<{ items: unknown[]; errors: Array<{ file: string; reason: string }> }> {
  const dir = providersDir()
  const items: unknown[] = []
  const errors: Array<{ file: string; reason: string }> = []
  if (!existsSync(dir)) return { items, errors }
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (error) {
    return { items, errors: [{ file: dir, reason: (error as Error)?.message ?? String(error) }] }
  }
  for (const fileName of names) {
    if (!fileName.endsWith('.json')) continue
    try {
      const text = await readFile(join(dir, fileName), 'utf8')
      items.push(JSON.parse(text))
    } catch (error) {
      errors.push({ file: fileName, reason: (error as Error)?.message ?? String(error) })
    }
  }
  return { items, errors }
}

/** 写一个自定义 provider（原子写，文件名用 id）。 */
async function writeCustomProvider(provider: { id: string }): Promise<string> {
  const dir = providersDir()
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${provider.id}.json`)
  await writeAtomic(path, JSON.stringify(provider, null, 2))
  return path
}

/** 删一个自定义 provider。 */
async function removeCustomProvider(id: string): Promise<boolean> {
  const path = join(providersDir(), `${id}.json`)
  if (!existsSync(path)) return false
  await unlink(path)
  return true
}

/**
 * 会话游标的持久化目录：`~/.dsh/webin/sessions/<platform>.json`。
 *
 * ## 为什么必须落盘（用户实测发现的缺陷）
 *
 * 「重启 DSH 后网页版又新开了一个会话，没接上之前那个窗口」。
 *
 * 根因：游标只在 host 内存里，重启即丢：
 *   1. `diff.chatUrl` 为空 ⇒ job 不带 `expectUrl` ⇒ client 在首页发 ⇒ **新开对话**
 *   2. 差分游标也丢 ⇒ 重启后第一轮**重发全部历史**（网页记录里又出现超长提示词）
 *
 * 落盘后两个问题一起解决：重启 → 恢复游标 → 任务带 `expectUrl` →
 * client 导航回原对话 → 差分继续按原进度走。
 */
function sessionsDir(): string {
  return join(stateRoot(), 'sessions')
}

/** 单个平台的会话映射文件。 */
function sessionsPath(platform: string): string {
  const safe = /^[A-Za-z0-9_-]{1,64}$/.test(platform) ? platform : 'unknown'
  return join(sessionsDir(), `${safe}.json`)
}

/** 配置文件路径：`~/.dsh/webin/config.json`。 */
function configPath(): string {
  return join(stateRoot(), 'config.json')
}

/**
 * 读配置。**坏文件不能让插件挂掉** —— 回退默认值并报告原因。
 *
 * 不做缓存：配置是用户在设置页改的，改完要**立刻生效**。
 * 每轮对话只读几次小 JSON，成本可忽略。
 */
function readConfig(): { config: WebinConfig; problems: ConfigCheck['problems']; raw: string } {
  const path = configPath()
  if (!existsSync(path)) return { config: { ...DEFAULT_CONFIG }, problems: [], raw: '' }
  try {
    const raw = readFileSync(path, 'utf8')
    const checked = checkConfig(JSON.parse(raw))
    return { config: checked.config, problems: checked.problems, raw }
  } catch (error) {
    return {
      config: { ...DEFAULT_CONFIG },
      problems: [
        { field: '(file)', reason: `读取失败：${(error as Error)?.message ?? String(error)}`, fellBackTo: '默认值' },
      ],
      raw: '',
    }
  }
}

/** 写配置（原子写：先写临时文件再改名，避免留下半截文件）。 */
async function writeConfigFile(config: WebinConfig): Promise<void> {
  await mkdir(stateRoot(), { recursive: true })
  const path = configPath()
  const tmp = `${path}.tmp`
  await writeFile(tmp, JSON.stringify(config, null, 2), 'utf8')
  await rename(tmp, path)
}

/** 读请求体（有上限）。 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > BODY_LIMIT_BYTES) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** 统一的 JSON 响应。 */
function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** 原子写：先写临时文件再 rename，避免半截文件。 */
async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, content, { encoding: 'utf8', mode: 0o600 })
  await rename(tmp, path)
}

/** 从 URL 取槽位名：`/dsh-webin/api/auth/<slot>/<suffix>`。 */
function slotFromPath(pathname: string, suffix: string): string | undefined {
  const prefix = `${API_PREFIX}/auth/`
  if (!pathname.startsWith(prefix)) return undefined
  const rest = pathname.slice(prefix.length)
  if (!rest.endsWith(suffix)) return undefined
  const slot = rest.slice(0, rest.length - suffix.length)
  return slot === '' ? undefined : slot
}

/** 从 URL 取任务 id：`/dsh-webin/api/job/<id>/<suffix>`。 */
function jobIdFromPath(pathname: string, suffix: string): string | undefined {
  const prefix = `${API_PREFIX}/job/`
  if (!pathname.startsWith(prefix)) return undefined
  const rest = pathname.slice(prefix.length)
  if (!rest.endsWith(suffix)) return undefined
  const id = rest.slice(0, rest.length - suffix.length)
  return id === '' ? undefined : id
}

/**
 * 客户端心跳表。
 *
 * 作用：host 半（尤其是 adapter）需要知道「LDW 面板此刻在不在线」。
 * 面板被切走 / 卸载 / 页面没登录，都会体现在这张表上 —— 排查
 * 「模型不回复」时，`GET /dsh-webin/api/status` 一眼就能定位到哪一环断了。
 */
interface ClientBeat {
  clientId: string
  /** 该面板驱动哪个平台（一个面板一个 webview）。 */
  platform: string
  at: number
  loggedIn: boolean
  hasGuest: boolean
  replyCount: number
}

/** 心跳超过这个时长即视为离线。 */
const CLIENT_STALE_MS = 15_000

/**
 * 安全取一个命名 logger。
 *
 * `ctx.logger` 是 Cordis 的 **callable service**（`LoggerService` 用 `createCallable` 包装，
 * 见 cordis `lib/index.js:594`），所以：
 *   - `ctx.logger('ns')` → 命名 Logger 实例
 *   - `ctx.logger.info(...)` → 也合法（`LoggerService.prototype` 上挂了直通方法，`:646`）
 *
 * ⚠️ 但**不能假设它一定可调用**：`?.()` 只防 null/undefined，不防"存在但不是函数"。
 * 宿主版本差异或服务被替换时，一次 TypeError 就会让整个 `apply()` 抛出、
 * 插件加载失败。所以这里显式判类型，任何异常都退化成空 logger —— 日志丢了不致命，
 * 插件装不上才致命。
 */
function safeLogger(ctx: { logger?: unknown }): {
  info?: (m: string) => void
  warn?: (m: string) => void
  debug?: (m: string) => void
} {
  try {
    const svc = ctx.logger as
      | (((ns: string) => unknown) & { info?: unknown; warn?: unknown; debug?: unknown })
      | undefined
    if (svc === undefined || svc === null) return {}

    let target: unknown = svc
    if (typeof svc === 'function') target = svc('dsh-webin')

    if (target === null || typeof target !== 'object') {
      // 退化：直接用服务本身（若它自带 info/warn/debug）
      target = svc
    }
    const t = target as { info?: unknown; warn?: unknown; debug?: unknown }
    const pick = (fn: unknown): ((m: string) => void) | undefined =>
      typeof fn === 'function' ? (m: string) => (fn as (m: string) => void).call(target, m) : undefined
    return { info: pick(t.info), warn: pick(t.warn), debug: pick(t.debug) }
  } catch {
    return {}
  }
}

export async function apply(ctx: {
  effect(cb: () => unknown, label?: string): void
  webServer: {
    register(route: {
      kind: 'exact' | 'prefix'
      path: string
      handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
    }): () => void
  }
  logger?: unknown
  llm: {
    registerAdapter(providers: string[], adapter: unknown): () => void
  }
}): void {
  const log = safeLogger(ctx)

  /** 在线客户端心跳（clientId → 最近一次心跳）。 */
  const beats = new Map<string, ClientBeat>()

  /**
   * 上次更新检查结果（**缓存 60 秒**）。
   *
   * 未认证的 GitHub API 每小时只有 60 次配额 —— 用户在设置页连点几次
   * 「检查更新」就能把它打光。缓存一下，正常使用完全够。
   *
   * ## ⚠️ 按仓库分键（修掉的真实 bug）
   *
   * 早期是**一个模块级变量**。若用户在设置页把 repo 改成别的仓库，
   * 60 秒内仍会拿到**上一个仓库**的结果 —— 显示的是别人的版本信息。
   *
   * 现在用 Map 按 `owner/repo` 分键。
   */
  const updateChecks = new Map<string, UpdateCheck>()
  /** 缓存有效期。 */
  const UPDATE_CACHE_MS = 60_000

  /**
   * 各平台当前的 guest partition 名（由 client 上报）。
   *
   * ## 为什么需要（解决「重启必须重新登录」）
   *
   * DSH 分配的 partition 是 `dsh-sidebar-browser-${randomUUID()}` ——
   * **随机、内存分区**，host 猜不到名字。而只有拿到名字才能用
   * `session.fromPartition(name).cookies` 读写**含 httpOnly** 的 cookie
   * （那是 DeepSeek 登录态的真正载体，页面 JS 看不到）。
   *
   * client 半在 `browser.acquire()` 的返回值里拿得到，所以由它上报。
   * 重启后 client 会重新上报一个新的 partition 名 —— host 用存档里的
   * cookie 写回**新** partition，从而实现免登录。
   */
  const partitions = new Map<string, { partition: string; domain: string; at: number }>()

  /**
   * 上报过身份的 DSH 会话（`sessionId` → 最后上报时刻）。
   *
   * client 半挂载 `conversation.view` 的 LDW 视图时上报自己窗口的
   * `sessionId`（DSH 的 standardProps 直接给）。用途：
   *   - `/status` 能列出「现在有哪些窗口挂着 LDW」
   *   - 排查「任务被别的窗口领走」时，对照任务的 `sessionId`
   */
  const knownSessions = new Map<string, number>()
  const liveClients = (): ClientBeat[] => {
    const now = Date.now()
    const out: ClientBeat[] = []
    for (const [id, beat] of beats) {
      if (now - beat.at > CLIENT_STALE_MS) {
        beats.delete(id)
        continue
      }
      out.push(beat)
    }
    return out
  }

  // ---- provider 注册：每个平台一个路由，让它们出现在模型选择器 ----
  //
  // ⚠️ 必须走 `ctx.effect` 把 disposer 交回 Cordis。
  // 直接 `ctx.webServer.register(...)` 而不释放，会在插件卸载后**留下幽灵路由**：
  // 再次启用时撞上 `webserver: duplicate prefix route "/dsh-webin/api"` 而激活失败
  // （实测踩过）。adapter 同理，重复注册会抛 "provider already registered"。
  const registry = new ProviderRegistry()
  const queue = new JobQueue()
  /**
   * 游标落盘 —— **重启后接回原对话的关键**。
   *
   * 不落盘的话重启后：`chatUrl` 丢失 ⇒ 任务不带 `expectUrl` ⇒
   * client 在首页发 ⇒ **新开一个网页对话**（用户实测：「没接上之前的那个窗口」）；
   * 同时差分游标也丢 ⇒ 第一轮重发全部历史。
   */
  const adapter = createAdapter({
    queue,
    logger: log,
    registry,
    /** 每轮读一次配置 —— 设置页改完立刻生效，不用重启。 */
    getConfig: () => readConfig().config,
    /**
     * 登录门禁：未登录的平台不列出模型、也不允许调用。
     * 用户要求「如果是已登录才能使用 LDW 那俩模型」。
     */
    isLoggedIn: (platform) => isPlatformLoggedIn(platform),
    cursorStore: {
      load: (platform) => {
        const path = sessionsPath(platform)
        try {
          if (!existsSync(path)) return {}
          const parsed = JSON.parse(readFileSync(path, 'utf8')) as { sessions?: Record<string, SessionCursor> }
          return parsed.sessions ?? {}
        } catch (error) {
          log.warn?.(`读取会话映射失败 ${platform}: ${(error as Error)?.message ?? String(error)}`)
          return {}
        }
      },
      save: (platform, key, cursor) => {
        const path = sessionsPath(platform)
        try {
          let all: Record<string, SessionCursor> = {}
          if (existsSync(path)) {
            try {
              const parsed = JSON.parse(readFileSync(path, 'utf8')) as { sessions?: Record<string, SessionCursor> }
              all = parsed.sessions ?? {}
            } catch {
              /* 文件坏了就重写 */
            }
          }
          if (cursor === undefined) delete all[key]
          else all[key] = cursor
          mkdirSync(sessionsDir(), { recursive: true })
          writeFileSync(path, JSON.stringify({ sessions: all }, null, 2), 'utf8')
        } catch (error) {
          log.warn?.(`写入会话映射失败 ${platform}: ${(error as Error)?.message ?? String(error)}`)
        }
      },
    },
  })

  /** 当前注册了哪些路由（自定义 provider 增删后要重注册）。 */
  let registeredRoutes: string[] = []
  const syncProviders = (): void => {
    const routes = registry.all().map((p) => routeFor(p.id))
    // 路由集合没变就不动 —— 重复注册同一个 provider 会抛 DUPLICATE_ADAPTER
    if (routes.length === registeredRoutes.length && routes.every((r, i) => r === registeredRoutes[i])) return
    for (const route of registeredRoutes) disposers.get(route)?.()
    disposers.clear()
    for (const route of routes) {
      disposers.set(route, ctx.llm.registerAdapter([route], adapter))
    }
    registeredRoutes = routes
    log.info?.(`已注册 provider 路由：${routes.join(', ')}`)
  }
  const disposers = new Map<string, () => void>()

  ctx.effect(() => () => {
    for (const dispose of disposers.values()) dispose()
    disposers.clear()
    registeredRoutes = []
  }, 'dsh-webin: llm adapters')

  // 首次装配：先读磁盘上的自定义 provider，再注册
  const initial = await readCustomProviders()
  if (initial.items.length > 0) {
    const loaded = registry.loadCustom(initial.items)
    if (loaded.accepted.length > 0) log.info?.(`已加载自定义 provider：${loaded.accepted.join(', ')}`)
    for (const r of loaded.rejected) log.warn?.(`自定义 provider #${r.index} 校验失败：${r.reason}`)
  }
  for (const e of initial.errors) log.warn?.(`自定义 provider 文件读取失败 ${e.file}：${e.reason}`)
  syncProviders()

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const pathname = url.pathname
      const method = (req.method ?? 'GET').toUpperCase()

      // ---- 任务队列：client 领活 / 交结果 ----

      /**
       * ## POST /client/partition —— client 上报它拿到的 guest partition 名
       *
       * ## 为什么需要这个（解决「重启必须重新登录」）
       *
       * DSH 给 guest 分配的 partition 是 `dsh-sidebar-browser-${randomUUID()}`
       * （`lib/main.js:9638`）—— **无 `persist:` 前缀 = 内存分区**，
       * 进程退出 cookie 全丢。
       *
       * 而 DeepSeek 的登录态主要靠 **httpOnly cookie**：页面里的
       * `document.cookie` 看不见也写不了。所以只靠页面侧快照
       * **天生补不全**（用户实测：「每次重启 dsh 都需要重新登陆」）。
       *
       * partition 名是随机的、host 猜不到 —— 但 client 半在
       * `browser.acquire()` 的返回值里拿得到。上报后，host 就能用
       * Electron 的 `session.fromPartition(name).cookies` 读写**含
       * httpOnly** 的完整 cookie。
       *
       * ⚠️ 拿不到 electron（纯 node / 测试环境）时**不能报错** ——
       * 那会让 client 的这次上报看起来像失败。返回 `cookieApi:false`
       * 让 client 知道走的是降级路径。
       */
      if (method === 'POST' && pathname === `${API_PREFIX}/client/partition`) {
        const body = await readBody(req)
        let payload: { platform?: string; partition?: string; domain?: string }
        try {
          payload = JSON.parse(body) as typeof payload
        } catch {
          sendJson(res, 400, { ok: false, reason: 'invalid-json' })
          return
        }
        const platform = typeof payload.platform === 'string' ? payload.platform : ''
        const partition = typeof payload.partition === 'string' ? payload.partition : ''
        const domain = typeof payload.domain === 'string' ? payload.domain : ''
        if (platform === '' || partition === '') {
          sendJson(res, 400, { ok: false, reason: 'missing platform/partition' })
          return
        }
        partitions.set(platform, { partition, domain, at: Date.now() })
        sendJson(res, 200, {
          ok: true,
          /** electron 可用时才能真正读写 httpOnly cookie。 */
          cookieApi: cookieApiAvailable(),
          /** 有没有存档可以写回。 */
          archived: loadCookieArchive(stateRoot(), platform) !== undefined,
        })
        return
      }

      /** POST /auth/<platform>/cookies —— 抓取当前 partition 的 cookie 并存档。 */
      if (method === 'POST' && pathname.startsWith(`${API_PREFIX}/auth/`) && pathname.endsWith('/cookies')) {
        const platform = decodeURIComponent(pathname.slice(`${API_PREFIX}/auth/`.length, -'/cookies'.length))
        const known = partitions.get(platform)
        if (known === undefined) {
          sendJson(res, 409, {
            ok: false,
            reason: '还不知道该平台的 partition —— 请先打开 LDW 标签让它上报',
          })
          return
        }
        const domain = known.domain === '' ? platform : known.domain
        const cookies = await grabCookies(known.partition, domain)
        if (cookies === undefined) {
          sendJson(res, 501, {
            ok: false,
            reason: '当前环境拿不到 Electron session API（无法读取 httpOnly cookie）',
          })
          return
        }
        saveCookieArchive(stateRoot(), { platform, cookies, at: Date.now() })
        sendJson(res, 200, { ok: true, count: cookies.length, domain })
        return
      }

      /** GET /auth/<platform>/cookies —— 把存档写回当前 partition。 */
      if (method === 'GET' && pathname.startsWith(`${API_PREFIX}/auth/`) && pathname.endsWith('/cookies')) {
        const platform = decodeURIComponent(pathname.slice(`${API_PREFIX}/auth/`.length, -'/cookies'.length))
        const known = partitions.get(platform)
        if (known === undefined) {
          sendJson(res, 409, { ok: false, reason: '还不知道该平台的 partition' })
          return
        }
        const archive = loadCookieArchive(stateRoot(), platform)
        if (archive === undefined) {
          sendJson(res, 404, { ok: false, reason: '没有 cookie 存档' })
          return
        }
        const n = await restoreCookies(known.partition, archive.cookies)
        sendJson(res, 200, {
          ok: n > 0,
          restored: n,
          total: archive.cookies.length,
          ...(n === 0 ? { reason: '写回失败（可能拿不到 Electron session API）' } : {}),
        })
        return
      }

      /**
       * ## POST /client/session —— client 上报「我挂在哪个 DSH 会话上」
       *
       * ## 为什么需要（用户报的「所有窗口都生效」）
       *
       * 早期 `/job/next` 只按平台过滤 ⇒ **任何窗口都能领走任何任务**。
       * 用户实测：「换了几个 dsh 窗口聊天，发现全都是在网页版的同一个
       * 会话窗口」、「所有窗口都生效」。
       *
       * client 半从 `conversation.view` 的 standardProps 拿到 `sessionId`
       * （**DSH 官方提供的 prop**，见 Slots Inspect 的 standardProps 列表），
       * 挂载时上报一次。之后领活带上 `?session=<id>`，host 只派匹配的。
       *
       * ⚠️ 上报失败不影响功能（退回按平台派发），所以这里**不返回错误**
       * 给用户造成困扰 —— 只记日志。
       */
      if (method === 'POST' && pathname === `${API_PREFIX}/client/session`) {
        const body = await readBody(req)
        let payload: { sessionId?: string; platform?: string }
        try {
          payload = JSON.parse(body) as typeof payload
        } catch {
          sendJson(res, 400, { ok: false, reason: 'invalid-json' })
          return
        }
        const sid = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : ''
        if (sid === '') {
          sendJson(res, 400, { ok: false, reason: 'missing sessionId' })
          return
        }
        knownSessions.set(sid, Date.now())
        /** 顺手清理 10 分钟没上报的（窗口关了）。 */
        const cutoff = Date.now() - 600_000
        for (const [id, at] of knownSessions) if (at < cutoff) knownSessions.delete(id)
        sendJson(res, 200, { ok: true, known: knownSessions.size })
        return
      }

      // GET /job/next —— client 领一个待办任务
      // `?platform=<id>` 让每个平台的 webview 只领自己的活
      if (method === 'GET' && pathname === `${API_PREFIX}/job/next`) {
        const platform = url.searchParams.get('platform') ?? undefined
        /**
         * ## ⭐ `?session=<sessionId>` —— 来领活的窗口是哪个 DSH 会话
         *
         * ## 为什么必须有（用户报的「所有窗口都生效」）
         *
         * 早期只按 `platform` 过滤 ⇒ **任何 DSH 窗口都能领走任何任务**。
         * 用户实测：「换了几个 dsh 窗口聊天，发现全都是在网页版的同一个
         * 会话窗口」、「所有窗口都生效」。
         *
         * client 半从 `conversation.view` 的 standardProps 拿到
         * `sessionId`（**DSH 官方提供的 prop**，见 Slots Inspect 的
         * `standardProps` 列表），领活时带上。
         *
         * ⚠️ 没带时退回「按平台派发」（向后兼容）—— 否则老 client
         * 的任务会永远没人领。
         */
        const session = url.searchParams.get('session') ?? undefined
        /**
         * `?running=<jobId>` —— client 报告「我正在跑哪个任务」。
         *
         * 用途：用户按停止后 host 会把任务标记为 `cancelled`，
         * client 靠这个参数问「我这个任务还算数吗」。
         * 不算数就去按页面的停止按钮，别让页面白生成到结束（烧配额）。
         */
        const running = url.searchParams.get('running') ?? undefined
        if (running !== undefined && running !== '') {
          const current = queue.get(running)
          if (current === undefined || current.cancelled === true) {
            sendJson(res, 200, { ok: true, job: null, cancel: running })
            return
          }
        }

        const job = queue.claimNext(platform, session)
        if (job === undefined) {
          sendJson(res, 200, { ok: true, job: null, clientOnline: queue.hasClaimed() })
          return
        }
        sendJson(res, 200, {
          ok: true,
          job: {
            id: job.id,
            prompt: job.prompt,
            thinking: job.thinking,
            platform: job.platform,
            /** 该任务属于哪个 DSH 会话 —— client 可据此确认没领错。 */
            ...(job.sessionId === undefined ? {} : { sessionId: job.sessionId }),
            /**
             * 该任务所属 DSH 会话绑定的网页对话 URL。
             * client 发现当前页面不在这里时，先导航过去再发送 ——
             * 否则所有 DSH 会话挤一个网页对话（封号级缺陷）。
             */
            ...(job.expectUrl === undefined ? {} : { expectUrl: job.expectUrl }),
            /**
             * 首轮（无绑定）：client 必须**开新对话**，不能占用当前页 ——
             * 否则两个 DSH 会话会挤进同一个网页对话。
             */
            ...(job.freshChat === true ? { freshChat: true } : {}),
          },
        })
        return
      }

      // PUT /job/<id>/result —— client 交结果
      const resultJobId = jobIdFromPath(pathname, '/result')
      if (method === 'PUT' && resultJobId !== undefined) {
        const body = await readBody(req)
        let payload: {
          text?: string
          think?: string
          status?: string
          error?: string
          chatUrl?: string
          /**
           * 结果来源标记。`dom-scrape` = hook 没抓到 SSE，
           * 客户端从页面 DOM 兜底捞的（见 `buildScrapeScript`）。
           *
           * 不走主路径，所以要**记日志** —— 频繁出现说明 hook
           * 有问题（而不是「偶发的页面慢」）。
           */
          via?: string
        }
        try {
          payload = JSON.parse(body) as typeof payload
        } catch {
          sendJson(res, 400, { ok: false, reason: 'invalid-json' })
          return
        }
        if (payload.via === 'dom-scrape') {
          log.warn?.(
            `job ${resultJobId} 的结果来自 DOM 兜底（hook 未捕获 SSE）—— ` +
              '若频繁出现请点「诊断」查看 postPaths',
          )
        }
        const settled =
          typeof payload.error === 'string' && payload.error !== ''
            ? queue.settle(resultJobId, { error: payload.error })
            : queue.settle(resultJobId, {
                text: String(payload.text ?? ''),
                think: String(payload.think ?? ''),
                status: String(payload.status ?? 'finished'),
                /**
                 * 发送成功后所在的页面 URL —— host 记住它，
                 * 让该 DSH 会话的后续任务都导航回这个对话接着聊。
                 */
                ...(typeof payload.chatUrl === 'string' && payload.chatUrl !== ''
                  ? { chatUrl: payload.chatUrl }
                  : {}),
              })
        log.debug?.(`job ${resultJobId} settled=${String(settled)}`)
        sendJson(res, settled ? 200 : 404, { ok: settled })
        return
      }

      // GET /auth/<slot>/snapshot —— 取快照
      const getSlot = slotFromPath(pathname, '/snapshot')
      if (method === 'GET' && getSlot !== undefined) {
        const path = snapshotPath(getSlot)
        if (!existsSync(path)) {
          sendJson(res, 404, { ok: false, reason: 'no-snapshot' })
          return
        }
        const text = await readFile(path, 'utf8')
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(text)
        return
      }

      // PUT /auth/<slot>/snapshot —— 存快照
      if (method === 'PUT' && getSlot !== undefined) {
        const body = await readBody(req)
        try {
          JSON.parse(body)
        } catch {
          sendJson(res, 400, { ok: false, reason: 'invalid-json' })
          return
        }
        await writeAtomic(snapshotPath(getSlot), body)
        log.info?.(`auth snapshot saved: slot=${getSlot} bytes=${body.length}`)
        sendJson(res, 200, { ok: true, slot: getSlot, bytes: body.length })
        return
      }

      // DELETE /auth/<slot>/snapshot —— 清快照（退出登录）
      if (method === 'DELETE' && getSlot !== undefined) {
        const path = snapshotPath(getSlot)
        if (existsSync(path)) await unlink(path)
        sendJson(res, 200, { ok: true, slot: getSlot })
        return
      }

      // GET /auth —— 列出所有槽位
      if (method === 'GET' && pathname === `${API_PREFIX}/auth`) {
        let slots: string[] = []
        try {
          slots = (await readdir(join(stateRoot(), 'auth')))
            .filter((f) => f.endsWith('.json'))
            .map((f) => f.slice(0, -5))
        } catch {
          slots = []
        }
        sendJson(res, 200, { ok: true, slots, root: stateRoot() })
        return
      }

      // POST /client/heartbeat —— client 上报在线状态
      if (method === 'POST' && pathname === `${API_PREFIX}/client/heartbeat`) {
        const body = await readBody(req)
        let payload: {
          clientId?: string
          platform?: string
          loggedIn?: boolean
          hasGuest?: boolean
          replyCount?: number
        }
        try {
          payload = JSON.parse(body) as typeof payload
        } catch {
          sendJson(res, 400, { ok: false, reason: 'invalid-json' })
          return
        }
        const clientId = typeof payload.clientId === 'string' && payload.clientId !== '' ? payload.clientId : 'anonymous'
        const platform =
          typeof payload.platform === 'string' && payload.platform !== '' ? payload.platform : DEFAULT_PROVIDER_ID
        beats.set(clientId, {
          clientId,
          platform,
          at: Date.now(),
          loggedIn: payload.loggedIn === true,
          hasGuest: payload.hasGuest === true,
          replyCount: typeof payload.replyCount === 'number' ? payload.replyCount : 0,
        })
        sendJson(res, 200, { ok: true, clients: liveClients().length })
        return
      }

      /**
       * ---- GET /config —— 读配置 ----
       *
       * 返回「当前生效的配置」+「默认值」+「边界」+「校验问题」。
       * 设置页需要这四样才能画出正确的表单：
       *   - 当前值：显示
       *   - 默认值：给「恢复默认」按钮用
       *   - 边界：给输入框的 min/max，避免用户填了才被拒
       *   - 问题：文件坏了 / 值超界时明确告诉用户
       */
      if (method === 'GET' && pathname === `${API_PREFIX}/config`) {
        const { config, problems } = readConfig()
        sendJson(res, 200, {
          ok: true,
          config,
          defaults: DEFAULT_CONFIG,
          limits: LIMITS,
          problems,
          summary: describeConfig(config),
          path: configPath(),
        })
        return
      }

      /**
       * ---- PUT /config —— 写配置 ----
       *
       * 校验在 host 做，**不信客户端传什么就存什么**。
       * 非法字段回退默认并逐条报告（不静默吞掉）—— 否则用户改了没生效会困惑。
       */
      if (method === 'PUT' && pathname === `${API_PREFIX}/config`) {
        const body = await readBody(req)
        let payload: unknown
        try {
          payload = JSON.parse(body)
        } catch {
          sendJson(res, 400, { ok: false, reason: 'invalid-json' })
          return
        }
        const checked = checkConfig(payload)
        try {
          await writeConfigFile(checked.config)
        } catch (error) {
          sendJson(res, 500, { ok: false, reason: `写入失败：${(error as Error)?.message ?? String(error)}` })
          return
        }
        log.info?.(`配置已更新：${describeConfig(checked.config)}`)
        sendJson(res, 200, {
          ok: true,
          config: checked.config,
          problems: checked.problems,
          summary: describeConfig(checked.config),
        })
        return
      }

      /**
       * ---- DELETE /config —— 恢复默认 ----
       *
       * 直接写一份默认值（而不是删文件）—— 删了之后 `GET` 也能返回默认，
       * 但写出来用户能看见「确实是默认值」，比空文件直观。
       */
      if (method === 'DELETE' && pathname === `${API_PREFIX}/config`) {
        try {
          await writeConfigFile({ ...DEFAULT_CONFIG })
        } catch (error) {
          sendJson(res, 500, { ok: false, reason: `写入失败：${(error as Error)?.message ?? String(error)}` })
          return
        }
        log.info?.('配置已恢复默认')
        sendJson(res, 200, { ok: true, config: { ...DEFAULT_CONFIG }, problems: [], summary: describeConfig(DEFAULT_CONFIG) })
        return
      }

      /**
       * ---- GET /version —— 版本 + 更新检查 ----
       *
       * ## 为什么走 host 而不是让 client 直接请求 GitHub
       *
       *   - **CORS**：浏览器里对 `api.github.com` 的跨域请求会被拦
       *   - **凭据**：host 侧不需要任何凭据（公开仓库），也不该为了
       *     检查更新去要一个能写仓库的 token
       *   - **缓存**：host 侧记一下上次结果，用户反复开设置页时不必重复打
       *     GitHub（未认证的 API 每小时 60 次，刷几次就没了）
       */
      if (method === 'GET' && pathname === `${API_PREFIX}/version`) {
        const info = currentVersion()
        const url = new URL(req.url ?? '', 'http://localhost')
        /** `?check=1` 才真的打 GitHub —— 默认只回本地版本，省配额。 */
        const wantCheck = url.searchParams.get('check') === '1'
        let update: UpdateCheck | undefined
        if (wantCheck) {
          const now = Date.now()
          /**
           * 60 秒内复用上次结果（用户连点「检查更新」不会打爆配额）。
           * ⚠️ **按仓库分键** —— 见 `updateChecks` 的说明。
           */
          const cached = updateChecks.get(info.repo)
          if (cached !== undefined && now - cached.checkedAt < UPDATE_CACHE_MS) {
            update = cached
          } else {
            update = await checkForUpdate(info.repo)
            updateChecks.set(info.repo, update)
          }
        }
        sendJson(res, 200, {
          ok: true,
          ...info,
          repoUrl: repoUrl(info.repo),
          starUrl: starUrl(info.repo),
          updateHint: updateHint(info.repo),
          /** 一句话总结（四种状态分开说，见 `describeUpdate`）。 */
          updateSummary: update === undefined ? undefined : describeUpdate(update, info.commit),
          ...(update === undefined ? {} : { update }),
        })
        return
      }

      // GET /status —— 自检
      if (method === 'GET' && pathname === `${API_PREFIX}/status`) {
        const clients = liveClients()
        sendJson(res, 200, {
          ok: true,
          plugin: name,
          /**
           * 平台清单 —— 每个平台一个 provider 路由，模型选择器里是独立分组。
           * `overridden` 标出哪些内置平台被用户自定义 JSON 覆盖了。
           */
          platforms: registry.all().map((p) => ({
            id: p.id,
            name: p.name,
            route: routeFor(p.id),
            homeUrl: p.homeUrl,
            models: p.models.map((m) => ({ id: `${p.id}:${m.id}`, name: m.name })),
            contextWindow: p.contextWindow,
            custom: registry.overriddenIds().includes(p.id),
          })),
          root: stateRoot(),
          providersDir: providersDir(),
          /**
           * 面板在线情况 —— 模型不回复时先看这里。
           * `online: 0` 表示没有任何 LDW 面板在跑，任务必然无人领取。
           */
          clients: {
            online: clients.length,
            loggedIn: clients.filter((c) => c.loggedIn).length,
            detail: clients.map((c) => ({
              clientId: c.clientId,
              platform: c.platform,
              ageMs: Date.now() - c.at,
              loggedIn: c.loggedIn,
              hasGuest: c.hasGuest,
              replyCount: c.replyCount,
            })),
          },
          /**
           * 登录过的平台（判据是**持久化快照**，不是「浏览器此刻在线」）。
           *
           * 未登录的平台**不会列出模型** —— 用户要求
           * 「如果是已登录才能使用 LDW 那俩模型」。输入框旁边的 LDW 按钮
           * 也读这个字段决定显示「去登录」还是「已登录」。
           */
          loggedInPlatforms: loggedInPlatforms(registry.all()),
          /**
           * ## ⭐ 任务队列快照 —— 「所有窗口都生效」时看这里，不用猜
           *
           * 每条显示：任务属于哪个会话、被**哪个会话的窗口**领走、当前状态。
           *
           * 排查「任务被别的窗口抢走了」时，这一眼就能看出来：
           *   - `sessionId` 是任务的归属会话
           *   - `claimedBy` 是实际领走它的窗口
           *   - 两者不一致 ⇒ 就是派发错了
           */
          jobs: queue.inspect(),
          /** client 上报过哪些会话（每个窗口挂载 LDW 视图时会上报）。 */
          knownSessions: [...knownSessions.entries()].map(([id, at]) => ({
            sessionId: id,
            ageMs: Date.now() - at,
          })),
          routes: [
            `GET    ${API_PREFIX}/status`,
            `GET    ${API_PREFIX}/providers`,
            `POST   ${API_PREFIX}/providers`,
            `DELETE ${API_PREFIX}/providers/<id>`,
            `POST   ${API_PREFIX}/client/heartbeat`,
            `GET    ${API_PREFIX}/job/next?platform=<id>`,
            `PUT    ${API_PREFIX}/job/<id>/result`,
            `GET    ${API_PREFIX}/auth`,
            `GET    ${API_PREFIX}/auth/<slot>/snapshot`,
            `PUT    ${API_PREFIX}/auth/<slot>/snapshot`,
            `DELETE ${API_PREFIX}/auth/<slot>/snapshot`,
          ],
        })
        return
      }

      // ---- 自定义 provider 管理 ----
      // GET /providers —— 列出**全部**平台（内置 + 自定义）与校验结果
      if (method === 'GET' && pathname === `${API_PREFIX}/providers`) {
        const { items, errors } = await readCustomProviders()
        const probe = new ProviderRegistry()
        const loaded = probe.loadCustom(items)
        /**
         * 设置页需要「当前生效的全部平台」。内置项也列出来 ——
         * 用户看到的是「我能用哪些平台」，而不是「我加过哪些文件」。
         */
        const customIds = new Set(loaded.accepted.map((p) => p.id))
        sendJson(res, 200, {
          ok: true,
          dir: providersDir(),
          /** 生效的全部平台（内置 + 自定义，自定义覆盖同 id 内置）。 */
          providers: registry.all(),
          /** 哪些是用户自定义的（设置页据此决定能否删）。 */
          customIds: [...customIds],
          defaultProviderId: DEFAULT_PROVIDER_ID,
          accepted: loaded.accepted,
          rejected: loaded.rejected.map((r) => ({ index: r.index, reason: r.reason })),
          /** 设置页显示的读盘错误。 */
          errors: errors.map((e) => ({ file: e.file, reason: e.reason })),
          fileErrors: errors,
          count: items.length,
          /** 在线客户端（登录态来源）。 */
          clients: liveClients(),
          /** 登录过的平台（快照判据）—— 设置页据此显示「已登录 / 去登录」。 */
          loggedInPlatforms: loggedInPlatforms(registry.all()),
        })
        return
      }

      // POST /providers —— 装一个自定义 provider（JSON body = Provider 对象）
      if (method === 'POST' && pathname === `${API_PREFIX}/providers`) {
        const body = await readBody(req)
        let payload: unknown
        try {
          payload = JSON.parse(body)
        } catch {
          sendJson(res, 400, { ok: false, reason: 'invalid-json' })
          return
        }
        const check = new ProviderRegistry()
        const loaded = check.loadCustom([payload])
        if (loaded.accepted.length === 0) {
          sendJson(res, 400, {
            ok: false,
            reason: loaded.rejected[0]?.reason ?? 'provider 校验失败',
          })
          return
        }
        const id = loaded.accepted[0]!
        const path = await writeCustomProvider(payload as { id: string })
        // 热加载：让新平台立刻出现在模型选择器里
        registry.loadCustom([payload])
        syncProviders()
        log.info?.(`自定义 provider 已装入：${id}`)
        sendJson(res, 200, { ok: true, id, path, route: routeFor(id) })
        return
      }

      // DELETE /providers/<id> —— 移除一个自定义 provider
      if (method === 'DELETE' && pathname.startsWith(`${API_PREFIX}/providers/`)) {
        const id = decodeURIComponent(pathname.slice(`${API_PREFIX}/providers/`.length))
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
          sendJson(res, 400, { ok: false, reason: 'invalid-id' })
          return
        }
        const removed = await removeCustomProvider(id)
        log.info?.(`自定义 provider 已移除：${id}（${removed ? '文件已删' : '无文件'}）`)
        sendJson(res, 200, { ok: true, id, removed })
        return
      }

      sendJson(res, 404, { ok: false, reason: 'not-found', path: pathname })
    } catch (error) {
      log.warn?.(`request failed: ${(error as Error)?.message ?? String(error)}`)
      try {
        sendJson(res, 500, { ok: false, reason: (error as Error)?.message ?? 'internal' })
      } catch {
        /* 响应可能已开始，忽略 */
      }
    }
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler }),
    'dsh-webin: api routes',
  )
  log.info?.(`host ready; api=${API_PREFIX} state=${stateRoot()}`)
}
