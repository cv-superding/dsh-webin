/**
 * dsh-webin — LLM adapter。
 *
 * 让「LDW 网页版」出现在 DSH 的模型选择器里。
 *
 * ## 这个 adapter 特殊在哪
 *
 * 它**不自己发 HTTP 请求**。cuckoo 的核心洞察是：
 * 请求由**页面自己**发出，TLS / HTTP2 / PoW / cookie / `x-hif-*` 才全部天然正确。
 * 所以这里的 `stream()` 做的是：
 *   1. 把 prompt 交给 client 半（通过一个请求队列）
 *   2. client 半把它**打进网页输入框**，触发真实发送
 *   3. client 半用 hook 观察页面自己的 SSE，把回复送回 host
 *   4. host 把文本转成 `StreamChunk` 交给 agent loop
 *
 * ## 与 client 半的通道
 *
 * host 不能主动推给 client，所以用**拉取模型**：
 *   - host `stream()` 把任务压进队列，然后轮询等结果
 *   - client 每 300ms `GET /dsh-webin/api/job/next` 领任务
 *   - client 完成后 `PUT /dsh-webin/api/job/<id>/result`
 *
 * ## 多平台
 *
 * **provider 路由名按平台拆分**（`webin-deepseek`、`webin-qwen`…），
 * 每个平台在模型选择器里是独立分组。模型 id 加平台前缀，避免跨平台撞名。
 * 平台差异全部来自 `Provider` 契约（`src/shared/providers.ts`）。
 */
import type { Provider } from '../shared/providers'
import { DEFAULT_PROVIDER_ID, ProviderRegistry } from '../shared/providers'
import { buildToolSection, parseToolCalls, type ToolSchema } from './tool-protocol'
import { serializeMessages, type DshMessage } from './serialize'
import { DEFAULT_CONFIG, type WebinConfig } from '../shared/config'

/** 路由名前缀：最终路由名 = `${ROUTE_PREFIX}-${provider.id}`。 */
export const ROUTE_PREFIX = 'webin'

/** 某个平台的 provider 路由名。 */
export function routeFor(providerId: string): string {
  return `${ROUTE_PREFIX}-${providerId}`
}

/** 兼容旧配置：早期版本用的单一路由名。 */
export const LEGACY_PROVIDER = 'deepseek-webin'

// ---------------------------------------------------------------------------
// 任务队列：host 派活 → client 领活 → client 交结果
// ---------------------------------------------------------------------------

interface Job {
  id: string
  prompt: string
  thinking: boolean
  /** 目标平台 id —— client 据此决定把任务交给哪个 webview。 */
  platform: string
  createdAt: number
  /** 已领走的时间（client 拿到后置位，避免重复派发）。 */
  claimedAt?: number
  /** client 交回的结果。 */
  done?: { text: string; think: string; status: string; chatUrl?: string }
  /** client 交回的错误。 */
  failed?: string
  /** 是否被用户取消（abort / 停止）。 */
  cancelled?: boolean
  /**
   * 发送前必须先导航到这个 URL —— 该任务所属 DSH 会话绑定的网页对话。
   *
   * ## 为什么必须有这个（用户实测发现的封号级缺陷）
   *
   * 早期所有 DSH 会话共用**一个**网页对话：换了几个 DSH 窗口聊天，
   * 网页版里全落在同一个会话窗口 —— 上下文互相串、多个话题混在一条流里，
   * 行为模式像机器人，**不被封才怪**。
   *
   * 正确语义：**每个 DSH 会话绑定自己的网页对话**，切会话时导航回去接着聊。
   * host 在任务上带上「期望对话 URL」，client 不匹配就先导航再发。
   */
  expectUrl?: string
  /**
   * 该任务**必须在新对话里发**（首轮，或原绑定已失效）。
   *
   * ## 为什么需要这个（第二个封号级缺陷）
   *
   * `expectUrl` 只覆盖「已绑定」的情况。**首轮没有绑定**，于是 client
   * 退化成「在当前页发」—— 而当前页可能是**别的会话的对话**。实测后果：
   *
   * ```
   * 会话A 首轮 → 在当前页 X 发 → 绑定 A→X
   * 会话B 首轮 → 无绑定 → 仍在 X 发 → 绑定 B→X   ← 两个会话挤进 X！
   * ```
   *
   * 这正是用户报的「换了几个 DSH 窗口，全都是在网页版的同一个会话窗口」。
   *
   * 所以首轮必须**显式开新对话**（点「新对话」或导航到 homeUrl），
   * 绝不能复用当前页。
   */
  freshChat?: boolean
}

class JobQueue {
  private readonly jobs = new Map<string, Job>()
  private seq = 0

  /** 派一个新任务。 */
  enqueue(
    prompt: string,
    thinking: boolean,
    platform: string,
    expectUrl?: string,
    freshChat?: boolean,
  ): Job {
    const job: Job = {
      id: `job-${Date.now()}-${++this.seq}`,
      prompt,
      thinking,
      platform,
      createdAt: Date.now(),
      ...(expectUrl === undefined ? {} : { expectUrl }),
      ...(freshChat === true ? { freshChat: true } : {}),
    }
    this.jobs.set(job.id, job)
    // 只保留最近 50 条，避免长会话内存堆积
    if (this.jobs.size > 50) {
      const oldest = [...this.jobs.values()].sort((a, b) => a.createdAt - b.createdAt)[0]
      if (oldest !== undefined && oldest.done !== undefined) this.jobs.delete(oldest.id)
    }
    return job
  }

  /**
   * client 领一个待办任务（跳过已领走的）。
   *
   * @param platform - 只领该平台的任务。面板可能同时挂着多个平台的 webview，
   *   各自只领自己平台的活，避免 DeepSeek 的面板去发 Qwen 的消息。
   */
  claimNext(platform?: string): Job | undefined {
    for (const job of this.jobs.values()) {
      if (job.done !== undefined || job.failed !== undefined || job.claimedAt !== undefined) continue
      if (platform !== undefined && job.platform !== platform) continue
      job.claimedAt = Date.now()
      return job
    }
    return undefined
  }

  /** client 交结果。 */
  settle(
    id: string,
    result: { text: string; think: string; status: string; chatUrl?: string } | { error: string },
  ): boolean {
    const job = this.jobs.get(id)
    if (job === undefined) return false
    if ('error' in result) job.failed = result.error
    else job.done = result
    return true
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id)
  }

  /** 任务是否已经被领走（用于判断 client 是否在线）。 */
  hasClaimed(): boolean {
    for (const job of this.jobs.values()) {
      if (job.claimedAt !== undefined && job.done === undefined && job.failed === undefined) return true
    }
    return false
  }

  /**
   * 取消一个任务（用户按了停止 / 调用被 abort）。
   *
   * ⚠️ 早期版本在 abort 时**只是抛错退出**，任务仍留在队列里处于 `claimed` 状态：
   *   - `hasClaimed()` 永远返回 true ⇒ `/status` 误报「面板在干活」
   *   - 页面那头也不知道要停，会继续生成到自然结束（白烧配额）
   *   - 万一之后 `done` 事件回来了，还会被当成**下一个任务**的回复（串台）
   *
   * 所以这里标记为已取消，让 client 领活时能看到并去按页面的停止按钮。
   */
  cancel(id: string, reason: string): boolean {
    const job = this.jobs.get(id)
    if (job === undefined) return false
    if (job.done !== undefined || job.failed !== undefined) return false
    job.failed = reason
    job.cancelled = true
    return true
  }
}

/** 重试策略：网页版限流退避较长，必须显式声明（否则落到 10s 默认上限）。 */
const RETRY_POLICY = {
  mode: 'normal' as const,
  maxRetries: 8,
  retryableCodes: ['RATE_LIMIT', 'TIMEOUT', 'TRANSPORT', 'SERVER'],
  initialDelayMs: 40_000,
  maxDelayMs: 117_000,
  jitterRatio: 0.15,
}

/**
 * 会话游标：记住每个会话「上次发到哪」，这一轮只发增量。
 *
 * ## 为什么必须做这层差分（本插件最重要的一处设计）
 *
 * DSH 是标准 LLM 宿主：**每一轮都把完整历史**（system + 全部 messages）交给 adapter，
 * 由 adapter 自己决定怎么变成 provider 的请求体。对 HTTP provider 来说这没问题 ——
 * 每次请求本来就该带全量上下文。
 *
 * 但**网页版不是无状态 API**：页面自己维护着对话历史。
 * 把整段历史每轮都打进输入框有两个后果：
 *
 *   1. **网页端聊天记录里堆满重复的超长提示词** —— 用户一眼就能看到，观感极差；
 *   2. **上下文被重复计数**：模型看到的是「历史 + 又一份历史」，
 *      有效上下文被砍半，还容易被判成刷屏。
 *
 * cuckoo 之所以没这问题，是因为它**不是 LLM adapter，而是 harness**：
 * 系统提示词只在「项目初始化」时发一次（`initProject()` → `buildPrompt()`），
 * 之后每轮只发新消息（`sendToChat()`）。页面自己就是记忆体。
 *
 * 本插件处在 adapter 位置（DSH 要求这样），所以要**自己补上这层差分**。
 * 用 `sessionId` 做键（`GenerateOptions.sessionId` 由 DSH 提供），
 * 多会话并行不会互相污染。
 */
interface SessionCursor {
  /** 已发送过的消息条数（messages 数组下标）。 */
  sentCount: number
  /** system 的指纹 —— 变了说明换了 agent/preset，需要重发。 */
  systemFingerprint: string
  /** 该 DSH 会话绑定的网页对话 URL（发送前 client 先导航到它）。 */
  chatUrl?: string
  /** 最后活动时间（淘汰陈旧会话用）。 */
  at: number
}

/**
 * 游标持久化接口（host 半注入；测试时可省略）。
 *
 * ## 为什么必须持久化（用户实测发现的缺陷）
 *
 * 用户重启 DSH 后：「网页版又新开了一个会话，没有接上之前的那个窗口」。
 *
 * 根因：游标只在 host **内存**里。重启后 `cursors.get(sessionKey)` 是 undefined
 * ⇒ `diff.chatUrl` 为空 ⇒ job 不带 `expectUrl` ⇒ client 在首页发 ⇒ **新开对话**。
 *
 * 而且差分游标本身也丢了 —— 重启后第一轮会**重发全部历史**（网页记录里
 * 又出现超长提示词，正是之前修过的那个问题）。
 *
 * 所以游标必须落盘：会话 ↔ 网页对话 的绑定关系 + 已发送进度。
 */
export interface CursorStore {
  /** 读某个平台的**全部**会话游标（启动时恢复用）。 */
  load(platform: string): Record<string, SessionCursor>
  /** 写/删某个平台的一个会话游标（`undefined` = 删除）。 */
  save(platform: string, key: string, cursor: SessionCursor | undefined): void
}

/** 会话游标表（内存 + 可选磁盘持久化）。 */
class SessionCursors {
  private readonly map = new Map<string, SessionCursor>()

  constructor(
    private readonly limit = 32,
    private readonly store?: CursorStore,
  ) {}

  /**
   * 启动时恢复某个平台的游标。
   *
   * ⚠️ 惰性恢复（首次访问该平台时才读盘）而不是构造时全读：
   * 平台是运行时才知道的（`registry.all()`），构造 `SessionCursors` 时
   * 还不知道有哪些平台。
   */
  private restored = new Set<string>()
  private ensureRestored(platform: string): void {
    if (this.store === undefined || this.restored.has(platform)) return
    this.restored.add(platform)
    try {
      for (const [k, v] of Object.entries(this.store.load(platform))) {
        if (v !== null && typeof v === 'object') this.map.set(`${platform}::${k}`, v)
      }
    } catch {
      /* 读不动就当空表 */
    }
  }

  get(platform: string, key: string): SessionCursor | undefined {
    this.ensureRestored(platform)
    return this.map.get(`${platform}::${key}`)
  }

  set(platform: string, key: string, cursor: SessionCursor): void {
    this.ensureRestored(platform)
    this.map.set(`${platform}::${key}`, cursor)
    this.store?.save(platform, key, cursor)
    // 淘汰：按平台分别算，避免一个平台的活跃会话挤掉另一个平台
    const mine = [...this.map.entries()].filter(([k]) => k.startsWith(`${platform}::`))
    if (mine.length > this.limit) {
      const oldest = mine.sort((a, b) => a[1].at - b[1].at)[0]
      if (oldest !== undefined) {
        this.map.delete(oldest[0])
        this.store?.save(platform, oldest[0].slice(platform.length + 2), undefined)
      }
    }
  }

  /** 会话被压缩/重置时清掉进度。 */
  reset(platform: string, key: string): void {
    this.map.delete(`${platform}::${key}`)
    this.store?.save(platform, key, undefined)
  }

  size(): number {
    return this.map.size
  }
}

/** system 的短指纹（长度 + 头尾片段足够区分，不必上 hash）。 */
function fingerprint(text: string): string {
  if (text === '') return '0'
  return `${text.length}:${text.slice(0, 48)}:${text.slice(-48)}`
}

/**
 * 算出本轮要发的内容（增量）。
 *
 * ## ⚠️ 这个函数**不改状态**
 *
 * 早期版本在这里直接 `cursors.set(...)` 推进游标，造成一个严重 bug：
 * **发送失败时上下文永久丢失** —— 游标已经前进了，下一轮只发之后的消息，
 * 中间那段内容再也不会被发出去（页面里没有，DSH 也认为发过了）。
 *
 * 所以现在拆成两步：
 *   1. `diffPrompt()` —— **纯函数**，只算要发什么
 *   2. 调用方在**确认投递成功后**调 `commit()`
 *
 * 失败时不 commit ⇒ 下次重试会重新算出同样的增量，内容不丢。
 *
 * 判定「需要重发 system」的条件：
 *   - 没有游标（新会话）
 *   - system 指纹变了（换了 agent / preset）
 *   - **历史变短了**（会话被压缩或回退 ⇒ 之前的进度作废，从头发）
 */
function diffPrompt(options: {
  system?: string
  messages: ReadonlyArray<DshMessage>
  /** 平台 id —— 游标按平台分文件持久化，避免跨平台撞键。 */
  platform: string
  sessionKey: string
  cursors: SessionCursors
  /** 工具段（协议 + 目录）；**只在首轮**带，见下方说明。 */
  toolSection?: string
  /** 工具结果截断上限（用户可在设置页调）。 */
  toolResultLimit?: number
}): {
  text: string
  note: string
  isFirst: boolean
  skippedOwnReply: number
  /** 本会话绑定的网页对话 URL（任务派发时带给 client）。 */
  chatUrl?: string
  /** 投递成功后调用，推进游标。失败时**不要**调。 */
  commit: () => void
} {
  const { messages, cursors, sessionKey, platform } = options
  const system = typeof options.system === 'string' ? options.system.trim() : ''
  const fp = fingerprint(system)
  const prev = cursors.get(platform, sessionKey)

  const historyShrank = prev !== undefined && messages.length < prev.sentCount
  const isFirst = prev === undefined || historyShrank
  const needSystem = isFirst || prev.systemFingerprint !== fp
  let start = isFirst ? 0 : prev.sentCount

  /**
   * 跳过页面自己的回复。
   *
   * 只在**非首轮**做：首轮没有「上次发送」，不存在页面自己的回复。
   * 只跳**连续**的 assistant 消息（正常情况下就一条）；
   * 遇到 user/tool 消息就停 —— 那些是新的输入，必须发。
   */
  let skippedOwnReply = 0
  if (!isFirst) {
    while (start < messages.length && messages[start]!.role === 'assistant') {
      start += 1
      skippedOwnReply += 1
    }
  }

  const parts: string[] = []
  if (needSystem && system !== '') parts.push(system)

  /**
   * **工具段只在首轮带。**
   *
   * 与差分发送一致：后续轮只发增量。若每轮都带工具目录，
   * 单次请求体量会平白多几千字符 —— 而参考实现实测记录过
   * 「体量是账号被限制的主要嫌疑」。
   */
  const withTools = isFirst && typeof options.toolSection === 'string' && options.toolSection !== ''
  if (withTools) parts.push(options.toolSection!)

  const body = serializeMessages(messages.slice(start), options.toolResultLimit)
  if (body !== '') parts.push(body)

  return {
    text: parts.join('\n\n'),
    isFirst,
    skippedOwnReply,
    chatUrl: prev?.chatUrl,
    commit: () => {
      cursors.set(platform, sessionKey, {
        sentCount: messages.length,
        systemFingerprint: fp,
        at: Date.now(),
        ...(prev?.chatUrl === undefined ? {} : { chatUrl: prev.chatUrl }),
      })
    },
    note:
      (isFirst
        ? `首轮（系统提示词 ${system.length} 字符 + ${messages.length} 条消息`
        : `增量（第 ${start + 1}..${messages.length} 条`) +
      (skippedOwnReply > 0 ? `，跳过页面自己的 ${skippedOwnReply} 条回复` : '') +
      (withTools ? `，带工具目录 ${options.toolSection!.length} 字符` : '') +
      '）',
  }
}

export interface AdapterDeps {
  queue: JobQueue
  logger?: { info?: (m: string) => void; warn?: (m: string) => void; debug?: (m: string) => void }
  /** 单次等待网页回复的超时。 */
  timeoutMs?: number
  /** 轮询间隔。 */
  pollMs?: number
  /** 无人领活时的快速失败宽限期（毫秒）。 */
  claimGraceMs?: number
  /** 平台注册表（多平台支持）。省略则用内置表。 */
  registry?: ProviderRegistry
  /**
   * 游标持久化（host 半注入 `~/.dsh/webin/sessions/`）。
   *
   * 不注入则纯内存 —— 重启后**会话↔对话绑定丢失**，网页版会新开对话
   * （用户实测踩过），且差分游标丢失导致重发全部历史。
   */
  cursorStore?: CursorStore
  /**
   * 读当前配置（用户可在设置页改）。
   *
   * **每次用时读一次**（而不是构造时读一次）—— 设置页改完要立刻生效，
   * 不能等重启。host 侧传进来的是 `() => readConfig().config`。
   */
  getConfig?: () => WebinConfig
  /**
   * 该平台**已登录**吗？（用户要求「已登录才能用 LDW 模型」）
   *
   * host 侧传 `(id) => isPlatformLoggedIn(id)`。
   * 未注入时**一律视为已登录** —— 测试与降级路径不该被门禁挡住；
   * 真门禁由 host 注入（它才知道快照在哪）。
   */
  isLoggedIn?: (platform: string) => boolean
}
/** 构造 adapter（鸭子类型对象；不继承 LlmAdapter 基类，所以方法要齐）。 */
export function createAdapter(deps: AdapterDeps) {
  const { queue } = deps
  const registry = deps.registry ?? new ProviderRegistry()
  const timeoutMs = deps.timeoutMs ?? 10 * 60 * 1000
  const pollMs = deps.pollMs ?? 250
  /** 每会话的发送进度（差分发送的核心状态）。 */
  const cursors = new SessionCursors(32, deps.cursorStore)

  /**
   * 取当前配置。没有注入时用默认值 —— 测试与降级路径都靠这个。
   */
  const config = (): WebinConfig => deps.getConfig?.() ?? DEFAULT_CONFIG

  /**
   * 该平台是否已登录。
   *
   * **未注入 `isLoggedIn` 时一律返回 true** —— 门禁是 host 的职责
   * （只有它知道快照文件在哪），adapter 不该在没被告知时自作主张挡人。
   */
  const loggedIn = (platform: string): boolean => deps.isLoggedIn?.(platform) ?? true

  /**
   * 模型 id 的全局唯一化。
   *
   * 各平台的模型 id 可能撞名（比如都叫 `fast`），而 DSH 的模型选择器按
   * `provider/model` 定位，同一 provider 路由下重名会互相覆盖。
   * 这里给模型 id 加平台前缀，**但保持向后兼容**：
   * 旧会话里存的 `ldw-think`（无前缀）仍能解析到默认平台的同名模型。
   */
  function qualifyModel(providerId: string, modelId: string): string {
    return `${providerId}:${modelId}`
  }

  /** 从 `平台:模型` 里拆出两段；无前缀时回退到默认平台。 */
  function parseModel(model: string): { providerId: string; modelId: string } {
    const idx = model.indexOf(':')
    if (idx > 0) {
      return { providerId: model.slice(0, idx), modelId: model.slice(idx + 1) }
    }
    return { providerId: DEFAULT_PROVIDER_ID, modelId: model }
  }

  /** 按「路由名 + 模型 id」找到平台与模型定义。 */
  function resolve(route: string, model: string): { provider: Provider; spec: Provider['models'][number] } {
    const byRoute = registry.all().find((p) => routeFor(p.id) === route)
    const parsed = parseModel(model)
    const provider = byRoute ?? registry.get(parsed.providerId)
    const spec = provider.models.find((m) => m.id === parsed.modelId) ?? provider.models[0]!
    return { provider, spec }
  }

  function modelInfoFor(route: string, provider: Provider, spec: Provider['models'][number]) {
    return {
      provider: route,
      id: qualifyModel(provider.id, spec.id),
      name: spec.name,
      description: spec.description ?? provider.name,
      inputModalities: ['text'] as const,
    }
  }

  function resolvedModelInfo(
    route: string,
    provider: Provider,
    spec: Provider['models'][number],
    requested: string,
  ) {
    const id = requested === '' ? qualifyModel(provider.id, spec.id) : requested
    const thinking = spec.thinking === true
    const efforts = provider.reasoningEfforts ?? [{ id: 'medium', name: '思考' }]
    return {
      provider: route,
      id,
      name: spec.name,
      description: spec.description ?? provider.name,
      inputModalities: ['text'] as const,
      /**
       * ⚠️ contextWindow 必须与网页端真实容量一致，否则会引发**会话压缩死锁**：
       * compaction-basic 用 `thresholdTokens = min(contextWindow × 0.8, contextWindow − maxTokens − headroom)`
       * 判定是否压缩。早期版本硬编码 128_000，阈值只有 54272，
       * 而真实会话轻松超过 30 万 token ⇒ 每一步 pre-step 都判定「超阈值」⇒ 反复触发压缩；
       * 而压缩的摘要调用又走 `routedTarget()`（= 最近一次路由的模型 = LDW 自己）
       * ⇒ 摘要必须经浏览器发送 ⇒ 浏览器一旦发不出去就整轮干等超时。
       * 实测后果：turn 21/22/23 连续三轮卡在 `compaction/start`，最久一次卡 6 分 12 秒。
       */
      context: { contextWindow: provider.contextWindow },
      defaultMaxTokens: provider.maxOutputTokens,
      ...(thinking
        ? {
            reasoning: {
              efforts: efforts.map((e) => ({ id: e.id, name: e.name })),
              defaultEffort: provider.defaultReasoningEffort ?? efforts[0]?.id ?? 'medium',
            },
          }
        : {}),
    }
  }

  /** 等 client 把结果交回来。 */
  async function waitForJob(
    job: Job,
    signal?: AbortSignal,
  ): Promise<{ text: string; think: string; status: string; chatUrl?: string }> {
    /** 配置里的超时优先（用户可在设置页调），其次 deps，最后默认 10 分钟。 */
    const deadline = Date.now() + (deps.timeoutMs ?? config().replyTimeoutMs)
    /**
     * 「没人领活」的宽限窗口。
     *
     * LDW 面板没打开（或用户切到了别的标签、guest 被卸载）时，client 半根本不会
     * 来 `GET /job/next`。此时**必须快速失败**，否则一次模型调用会干等满
     * `timeoutMs`（默认 10 分钟）—— 而压缩摘要走的正是这条路，
     * 于是整轮对话被一个没人能完成的任务卡死（实测 turn 23 卡 6 分 12 秒）。
     *
     * 判定：超过宽限期仍未被任何 client 领走 ⇒ 判定面板不在线，立即报错。
     * 宽限期给得比 client 的轮询间隔（1.5s）宽裕得多，不会误杀正在启动的面板。
     */
    const claimGraceMs = deps.claimGraceMs ?? config().claimGraceMs
    let claimedOnce = false

    for (;;) {
      if (signal?.aborted === true) {
        /**
         * 用户按了停止。
         *
         * **必须把任务标记掉**，否则它会一直挂在队列里处于 claimed 状态：
         *   - `hasClaimed()` 永远 true ⇒ `/status` 误报「面板在干活」
         *   - client 那头不知道要停，页面会继续生成到自然结束（白烧配额）
         *   - 之后回来的 `done` 还可能被算成下一个任务的回复（串台）
         *
         * 标记后 client 领活时能看到 `cancelled`，去按页面的停止按钮。
         */
        queue.cancel(job.id, '已取消（用户停止）')
        throw new Error('aborted')
      }
      const current = queue.get(job.id)
      if (current === undefined) throw new Error('job disappeared')
      if (current.failed !== undefined) throw new Error(current.failed)
      if (current.done !== undefined) return current.done

      if (current.claimedAt !== undefined) claimedOnce = true

      if (!claimedOnce && Date.now() > job.createdAt + claimGraceMs) {
        queue.settle(job.id, { error: 'LDW 面板未连接：没有 client 领取这个任务。' })
        throw new Error(
          'LDW 面板未连接 —— 没有任何客户端领取这个任务（' +
            `${Math.round(claimGraceMs / 1000)}s 内无人领取）。\n` +
            '原因通常是：LDW 标签没打开、面板被切走卸载了、或页面还没登录。\n' +
            '请切到 LDW 标签并确认显示「真实浏览器已就绪」。',
        )
      }

      if (Date.now() > deadline) {
        queue.settle(job.id, { error: '等待网页回复超时' })
        throw new Error(
          '等待网页回复超时。可能原因：页面结构变了 / 未登录 / 网页版没吐回复。' +
            '请打开 LDW 标签查看页面状态。',
        )
      }
      await new Promise((r) => setTimeout(r, pollMs))
    }
  }

  /**
   * 把一次模型调用变成 StreamChunk 流。
   *
   * 注意：这里**不返回 async generator 之外的东西**，
   * `block-start` / `text-delta` / `block-end` / `finish` 的顺序是 dsh-llm 的契约。
   */
  async function* streamOnce(options: {
    provider: string
    model: string
    system?: string
    messages: ReadonlyArray<DshMessage>
    signal?: AbortSignal
    /** dsh-llm 的调用用途；压缩摘要会带 `'compaction'`。 */
    purpose?: string
    /** DSH 给的会话标识 —— 差分发送的键。 */
    sessionId?: string
    /**
     * DSH 下发的工具清单。
     *
     * 网页版没有原生 function calling，所以走「JS 代码块协议」（抄 cuckoo）：
     * 首轮把工具目录打进 prompt，模型输出 ```ldw 块，
     * 本 adapter 解析成 `tool-call` chunk 交回 DSH。
     */
    tools?: readonly ToolSchema[]
  }): AsyncIterable<unknown> {
    /**
     * **压缩摘要不能走真实浏览器。**
     *
     * `compaction-basic` 的 `summarizeWithLlm()` 用 `routedTarget(session)` 选摘要模型 ——
     * 也就是「最近一次实际路由的 provider」。一旦会话切到 LDW，压缩就变成
     * 「把整段对话历史打进网页输入框」，这有两个致命问题：
     *
     *   1. **体量**：摘要输入动辄几十万 token，塞进 textarea 会让页面直接卡死；
     *      网页版本身也有输入长度上限。
     *   2. **死锁**：摘要必须等浏览器回话，而浏览器一旦不可用（面板没开 / 未登录 /
     *      页面结构变了），整轮对话就卡在 `compaction/start` 上 —— 实测最久 6 分 12 秒。
     *
     * 所以这里**明确拒绝**并给出可操作的指引，而不是丢进队列干等。
     * 正确做法是把摘要模型配成普通 HTTP provider：
     *
     * ```yaml
     * # compaction-basic 的配置（preset 的 compaction 组内）
     * - id: compaction-basic
     *   name: '@deepseek-ai/dsh-compaction-basic'
     *   config:
     *     summarizationProvider: wb-out
     *     summarizationModel: deepseek-v4.1-flash
     * ```
     */
    if (options.purpose === 'compaction') {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            code: 'WEBIN_COMPACTION_UNSUPPORTED',
            message:
              '压缩摘要不能走 LDW 网页版：摘要输入体量远超网页输入框上限，且会把整轮对话锁在浏览器上。' +
              '请把 compaction-basic 的 summarizationProvider / summarizationModel ' +
              '配成普通 HTTP provider（例如 wb-out / deepseek-v4.1-flash）。',
          },
        },
      }
      return
    }

    const { provider, spec } = resolve(options.provider, options.model)

    /**
     * ## 未登录时**直接报错**（而不是把消息发进网页版）
     *
     * `listModels` 已经不列未登录平台的模型，但**旧会话可能还存着**
     * 那个模型的 id（比如用户登录过、后来清了登录态）。
     * 那时如果照发，页面会跳到登录页，输入框根本不存在 ——
     * 用户看到的是「找不到可见的输入框」这种莫名其妙的错误。
     *
     * 所以这里给一个能直接照做的提示。
     */
    if (!loggedIn(provider.id)) {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            code: 'WEBIN_NOT_LOGGED_IN',
            message:
              `平台「${provider.name}」还没有登录，无法使用它的模型。\n` +
              '请点输入框左边的「LDW」按钮（或切到 LDW 标签），' +
              `在打开的浏览器里登录 ${provider.homeUrl} 后重试。`,
          },
        },
      }
      return
    }

    /**
     * **只发增量** —— 见 `diffPrompt()` 的说明。
     *
     * 会话键：优先用 DSH 给的 `sessionId`；没有时退到「平台 + system 指纹」，
     * 这样至少同一平台的不同 agent 不会互相污染。
     */
    const sessionKey =
      options.sessionId !== undefined && options.sessionId !== ''
        ? String(options.sessionId)
        : `${provider.id}#${fingerprint(options.system ?? '')}`

    /**
     * 工具段（协议 + 目录）—— 只在首轮带，见 `diffPrompt` 的说明。
     *
     * 体量：60 个工具 × 约 80 字符 ≈ 5,000 字符
     * （目录格式是「`name(签名)` — 首句」，对所有工具一视同仁）。
     *
     * ⚠️ 用户可在设置页关掉（`enableTools: false`）—— 关掉后模型收不到
     * 工具目录，自然也不会输出工具代码块。给「只想聊天、不想让它动我机器」
     * 的场景一个开关。
     */
    const cfg = config()
    const toolSection = cfg.enableTools ? buildToolSection([...(options.tools ?? [])]) : ''
    const diff = diffPrompt({
      ...options,
      platform: provider.id,
      sessionKey,
      cursors,
      toolSection,
      toolResultLimit: cfg.toolResultLimit,
    })
    const prompt = diff.text

    if (prompt.trim() === '') {
      /**
       * 增量为空 = 这一轮的输入和历史完全重复。
       *
       * 这在网页版语义下**不需要再发一次** —— 页面里已经有这段内容了。
       * 但 DSH 期望拿到一条 assistant 回复，所以直接回一个空停止，
       * 而不是把整段历史重发一遍（那正是「聊天记录里全是超长提示词」的来源）。
       */
      deps.logger?.debug?.(`${sessionKey} 增量为空，跳过发送`)
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    /**
     * **首轮必须开新对话**（`freshChat`）。
     *
     * 没有绑定时不能「在当前页发」—— 当前页可能是别的会话的对话，
     * 两个 DSH 会话就会挤进同一个网页对话（用户实测报的封号级缺陷）。
     */
    const job = queue.enqueue(
      prompt,
      spec.thinking === true,
      provider.id,
      diff.chatUrl,
      diff.chatUrl === undefined,
    )
    deps.logger?.debug?.(
      `job ${job.id} 已派发（平台=${provider.id}，${diff.note}，${prompt.length} 字符，thinking=${String(spec.thinking)}）`,
    )

    let result: { text: string; think: string; status: string; chatUrl?: string }
    try {
      result = await waitForJob(job, options.signal)
    } catch (error) {
      /**
       * ⚠️ **失败时绝不能推进游标。**
       *
       * 推进了就意味着「DSH 认为这段内容发过了」，下一轮只发之后的增量 ——
       * 而页面里其实没有这段内容 ⇒ **上下文永久丢失**，模型从此缺一段记忆。
       * 不推进 ⇒ 下次调用重新算出同样的增量，内容不丢。
       */
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { code: 'WEBIN_FAILED', message: (error as Error)?.message ?? String(error) },
        },
      }
      return
    }

    /**
     * 投递成功（页面已确认发送、且回复已收回）⇒ 这时才推进游标。
     *
     * 注意：`waitForJob` 成功返回意味着**页面确实处理了这个 prompt**，
     * 所以即使回复内容为空，这段输入也已经进过页面了，游标该推进。
     */
    diff.commit()

    /**
     * 记住「这条 DSH 会话现在绑定的网页对话」。
     *
     * client 交结果时带上了发送成功后的页面 URL（即对话落地页）。
     * 存进游标后，**这个 DSH 会话的后续任务都会要求先导航回这个对话** ——
     * 换别的 DSH 会话聊天时各回各的对话，不再全挤一个窗口（封号级缺陷，用户实测发现）。
     *
     * ⚠️ 必须放在 `diff.commit()` **之后**：commit 会整体重写游标，
     * 放前面的话这里刚存的 chatUrl 会被 commit 用旧值覆盖掉
     * （verify-session-route 的 ⭐ 断言就是抓这个的）。
     */
    if (typeof result.chatUrl === 'string' && result.chatUrl !== '') {
      const cur = cursors.get(provider.id, sessionKey)
      cursors.set(provider.id, sessionKey, {
        sentCount: cur?.sentCount ?? messages.length,
        systemFingerprint: cur?.systemFingerprint ?? fp,
        at: Date.now(),
        chatUrl: result.chatUrl,
      })
      deps.logger?.debug?.(`${sessionKey} 绑定对话 ${result.chatUrl}（已落盘）`)
    }

    /**
     * ## 解析工具调用（抄 cuckoo 的 JS 代码块协议）
     *
     * 网页模型没有原生 function calling，所以让它把调用写成 ```ldw 代码块
     * （cuckoo 的模板明确要求「多行文本用反引号模板字符串，不做任何转义」
     * —— 比 web-login 的 JSON 协议少一整类失败模式）。
     *
     * 这里把代码块**抠出来**转成 DSH 的 `tool-call` chunk：
     *   - 块外文字照常作为正文流给 DSH
     *   - 块本身**绝不进正文**（否则会显示在网页记录里，看起来不像人）
     *
     * ⚠️ 解析失败时不静默丢弃：把原文当正文透出（用户至少能看到模型写了什么），
     * 并记一条日志。宁可多显示一点，也不能让消息凭空消失。
     */
    const parsed = parseToolCalls(result.text, [...(options.tools ?? [])])
    if (parsed.failed.length > 0) {
      deps.logger?.warn?.(`工具调用解析失败 ${parsed.failed.length} 处：${parsed.failed[0]}`)
    }

    let index = 0

    // 思考内容作为 reasoning 块（只给 DSH 展示，不回灌网页 —— 见 serialize.ts 说明）
    if (result.think.trim() !== '') {
      yield { type: 'block-start', index, blockType: 'reasoning' }
      yield { type: 'reasoning-delta', index, text: result.think }
      yield { type: 'block-end', index, block: { type: 'reasoning', text: result.think } }
      index += 1
    }

    // 正文（已剥掉工具代码块）
    if (parsed.text.trim() !== '') {
      yield { type: 'block-start', index, blockType: 'text' }
      yield { type: 'text-delta', index, text: parsed.text }
      yield { type: 'block-end', index, block: { type: 'text', text: parsed.text } }
      index += 1
    }

    // 工具调用：每个调用一个独立的 tool-call 块
    for (const call of parsed.calls) {
      const id = `call_${Date.now().toString(36)}_${index}_${Math.random().toString(36).slice(2, 8)}`
      yield { type: 'block-start', index, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index, id, name: call.name, argumentsDelta: call.arguments }
      yield { type: 'block-end', index, block: { type: 'tool-call', id, name: call.name, arguments: call.arguments } }
      index += 1
    }

    if (parsed.calls.length > 0) {
      deps.logger?.debug?.(`解析出 ${parsed.calls.length} 个工具调用：${parsed.calls.map((c) => c.name).join(', ')}`)
    }

    /**
     * 结束原因：有工具调用时必须是 `tool-calls`
     * （DSH 据此决定「执行工具后继续」而不是「本轮结束」）。
     */
    yield {
      type: 'finish',
      reason: parsed.calls.length > 0 ? { kind: 'tool-calls' } : { kind: 'stop' },
    }
  }

  return {
    providerInfo(provider: string) {
      const hit = registry.all().find((p) => routeFor(p.id) === provider)
      return { id: provider, name: hit?.name ?? provider }
    },

    providerRetryPolicy() {
      return RETRY_POLICY
    },

    /** ⚠️ 必须有：dsh-llm 在计量/压缩路径上**无条件**转调它，缺了会让压缩静默失效。 */
    imageRequestPricing() {
      return undefined
    },

    /**
     * ## 模型清单 —— **未登录的平台不列出**
     *
     * 用户要求：「如果是已登录才能使用 LDW 那俩模型」。
     *
     * 为什么在 `listModels` 做而不是在设置页做：DSH 的模型选择器
     * 就是拿这个清单渲染的。不列出来 ⇒ 用户根本选不到 ⇒ 不会出现
     * 「选了模型但发不出去」这种更糟的体验。
     *
     * ⚠️ 判断用**持久化快照**而不是「浏览器此刻在线」：
     * 否则重启 DSH 后、用户还没切到 LDW 标签时模型会消失，看起来像插件坏了。
     */
    listModels(provider: string) {
      const hit = registry.all().find((p) => routeFor(p.id) === provider)
      if (hit === undefined) return Promise.resolve([])
      if (!loggedIn(hit.id)) {
        deps.logger?.debug?.(`平台 ${hit.id} 未登录，不列出模型`)
        return Promise.resolve([])
      }
      return Promise.resolve(hit.models.map((spec) => modelInfoFor(provider, hit, spec)))
    },

    resolveModel(provider: string, model: string) {
      const { provider: plat, spec } = resolve(provider, String(model ?? ''))
      return Promise.resolve(resolvedModelInfo(provider, plat, spec, String(model ?? '')))
    },

    prepareCall(provider: string, model: string) {
      const { provider: plat, spec } = resolve(provider, String(model ?? ''))
      return Promise.resolve({
        model: resolvedModelInfo(provider, plat, spec, String(model ?? '')),
        stream: (options: Parameters<typeof streamOnce>[0]) => streamOnce(options),
      })
    },

    stream(options: Parameters<typeof streamOnce>[0]) {
      return streamOnce(options)
    },
  }
}

export { JobQueue }
export type { Job }
