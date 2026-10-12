/**
 * dsh-webin — 平台 Provider 契约与注册表。
 *
 * ## 为什么要有这一层
 *
 * 第一版把 DeepSeek 的页面知识（选择器、UA、SSE 路径）硬编码在
 * `chat.ts` / `hook.ts` / `client/index.ts` 里。要支持第二个站点就得改三处，
 * 而且**没有任何东西保证改对了** —— 只能靠人肉记住"发送键不是 button"这类事实。
 *
 * 这一版照 cuckoo-code 的做法抽出来（`src/providers/types.ts` + `registry.ts`）：
 * **平台差异全部收敛到一个 Provider 对象**，驱动层只认接口。
 *
 * ## 与 cuckoo 的差异
 *
 * cuckoo 的 provider 是 CommonJS 单文件、可被用户从磁盘加载（`custom/loader.ts`）。
 * DSH 插件的 client 半跑在沙箱里、**拿不到 `node:fs`**，所以本插件把
 * "可扩展"落在两个层次上：
 *
 *   1. **内置 provider 表**（本文件）—— 新增站点 = 加一个对象
 *   2. **设置页 JSON 覆盖**（见 `custom.ts`）—— 用户在 UI 里贴 JSON，
 *      不改代码即可适配站点改版（选择器变了就改选择器）
 *
 * 用户级自定义 provider 走 host 侧持久化（`~/.dsh/webin/providers/*.json`），
 * 与登录态快照同一套存储，跨重启存活。
 */

/** 输入框/按钮的候选定位策略。 */
export interface ElementHints {
  /** 语义选择器（按优先级）。命中即用。 */
  selectors?: string[]
  /**
   * 站点特征评分规则：`[正则源, 加分]`。
   *
   * 为什么需要：真实站点上「几何位置 + 邻近度」往往**不足以区分**发送键和
   * 它旁边的附件键 —— DeepSeek 实测两者只差 1 分（32 vs 31），DOM 稍变就点错。
   * 站点专属的 class 特征能把分差拉到 175 分。
   */
  signatures?: Array<[string, number]>
  /** 命中即**否决**的正则（如「停止生成」「深度思考」开关）。 */
  vetoes?: string[]
}

/** 一个可驱动站点的完整描述。 */
export interface Provider {
  /** 唯一 id，用作 workspace 名 ⇒ 决定 guest partition ⇒ 决定登录态隔离。 */
  id: string
  /** 显示名（模型选择器里的分组名）。 */
  name: string
  /** 首页 URL（guest 首次导航目标）。 */
  homeUrl: string
  /** 匹配该站点 URL 的正则源（用于判断当前页面是否属于本平台）。 */
  urlPattern: string

  /** 输入框定位。 */
  input: ElementHints
  /** 发送控件定位。 */
  send: ElementHints
  /** 用户信息选择器（可选，用于显示账号）。 */
  userInfoSelector?: string

  /**
   * SSE 回复路径（只读观察用）。
   * hook 靠它识别「页面自己在发 completion 请求」。
   */
  completionPath: string
  /** 停止生成路径（可选）。 */
  stopPath?: string

  /**
   * SSE 帧里正文/思考文本的 JSON Patch 路径判定。
   * 不同站点字段名不同（DeepSeek 用 `response/fragments` + `THINK`）。
   */
  textPaths?: string[]
  thinkPaths?: string[]

  /** 模型列表（进模型选择器）。 */
  models: Array<{ id: string; name: string; description?: string; thinking?: boolean }>
  /** 声明给 DSH 的上下文窗口。 */
  contextWindow: number
  /** 单次输出上限。 */
  maxOutputTokens: number
  /** 思考档位（可选）。 */
  reasoningEfforts?: Array<{ id: string; name: string }>
  defaultReasoningEffort?: string
}

// ---------------------------------------------------------------------------
// 内置 provider
// ---------------------------------------------------------------------------

/**
 * DeepSeek 网页版。
 *
 * 所有选择器与评分规则都来自**真浏览器实测**（`npm run probe:dom` /
 * `npm run probe:send`），不是猜的。改版后先跑探测脚本再改这里。
 */
const DEEPSEEK: Provider = {
  id: 'deepseek',
  name: 'LDW · DeepSeek 网页版',
  homeUrl: 'https://chat.deepseek.com/',
  urlPattern: 'chat\\.deepseek\\.com',
  input: {
    selectors: [
      'textarea[placeholder*="给 DeepSeek"]',
      'textarea[placeholder*="DeepSeek"]',
      'textarea[placeholder*="输入"]',
      'textarea[placeholder*="发送"]',
      'textarea[placeholder*="message" i]',
      'textarea[placeholder*="ask" i]',
      'textarea.chat-input',
      'textarea',
      'div[contenteditable="true"]',
      '[role="textbox"]',
    ],
  },
  send: {
    selectors: [
      'button[type="submit"]',
      'button[aria-label*="send" i]',
      'button[aria-label*="发送"]',
      '[role="button"][aria-label*="send" i]',
      '[role="button"][aria-label*="发送"]',
      '[data-testid="send"]',
      '.send-btn',
    ],
    signatures: [
      // 实测：发送键是 div[role=button].ds-button--primary.ds-button--filled.ds-button--circle
      ['ds-button--primary', 60],
      ['ds-button--filled', 40],
      ['ds-button--circle', 50],
    ],
    vetoes: [
      'ds-toggle-button', // 深度思考 / 智能搜索开关
      'ds-button--capsule', // 附件等胶囊图标键
    ],
  },
  completionPath: '/api/v0/chat/completion',
  stopPath: '/api/v0/chat/stop_stream',
  models: [
    { id: 'ldw-fast', name: 'LDW · 快速模式', description: '真实浏览器驱动，不思考', thinking: false },
    { id: 'ldw-think', name: 'LDW · 深度思考', description: '真实浏览器驱动，开启思考', thinking: true },
  ],
  contextWindow: 1_048_576,
  maxOutputTokens: 32_768,
  reasoningEfforts: [{ id: 'medium', name: '思考' }],
  defaultReasoningEffort: 'medium',
}

/**
 * 通义千问（Qwen）网页版。
 *
 * 结构来自**真浏览器实测**（`npm run probe:dom -- --url https://www.tongyi.com/qianwen/`）：
 *
 *   - 输入框**不是 textarea**，是 `div[contenteditable="true"]`
 *     （class 含 `whitespace-pre-wrap break-words`）
 *   - 输入框附近有一堆**功能键**必须避开：`添加附件`、`快速`、`工作助理 云端`、
 *     `更多`、`AI生视频`、`PPT创作`、`AI生图`、`代码`、`翻译`、`AI写作`
 *   - 发送键是**纯图标按钮**，无 aria-label、无文字（与 DeepSeek 同款问题）
 *
 * ⚠️ 发送键未在首轮探测里现身（页面未登录时它不渲染），
 * 所以下面的选择器是**保守兜底**。第一次用之前请登录后重跑探测，
 * 把真实特征补进 `signatures`。
 */
const QWEN: Provider = {
  id: 'qwen',
  name: 'LDW · 通义千问',
  homeUrl: 'https://www.tongyi.com/qianwen/',
  urlPattern: '(tongyi\\.com|qwen\\.(ai|chat))',
  input: {
    selectors: [
      // 实测：contenteditable，不是 textarea
      'div[contenteditable="true"][class*="whitespace-pre-wrap"]',
      'div[contenteditable="true"]',
      'textarea[placeholder*="输入"]',
      'textarea',
      '[role="textbox"]',
    ],
  },
  send: {
    selectors: [
      'button[type="submit"]',
      'button[aria-label*="发送"]',
      'button[aria-label*="send" i]',
      '[role="button"][aria-label*="发送"]',
      '[data-testid*="send" i]',
    ],
    signatures: [
      // 发送键通常是实心圆角主按钮
      ['rounded-full', 20],
      ['bg-', 15],
    ],
    vetoes: [
      // 实测到的功能键 —— 点了会跑偏（开附件框 / 切模型 / 生成视频…）
      '添加附件',
      'attach',
      '上传',
      'upload',
      '快速',
      '工作助理',
      '更多',
      'AI生视频',
      'PPT创作',
      'AI生图',
      '代码',
      '翻译',
      'AI写作',
      'stop',
      '停止',
      '收起侧边栏',
    ],
  },
  completionPath: '/api/v1/chat/completions',
  models: [
    { id: 'qwen-fast', name: 'LDW · 通义千问', description: '真实浏览器驱动', thinking: false },
  ],
  contextWindow: 131_072,
  maxOutputTokens: 8_192,
}

/** 内置 provider 表。新增站点在这里加一项即可。 */
export const BUILTIN_PROVIDERS: Provider[] = [DEEPSEEK, QWEN]

/** 默认 provider（首个内置项）。 */
export const DEFAULT_PROVIDER_ID = DEEPSEEK.id

// ---------------------------------------------------------------------------
// 注册表
// ---------------------------------------------------------------------------

/**
 * Provider 运行时校验。
 *
 * TS 类型运行时被擦除，"必须实现接口"的真正强制靠这个函数
 * （cuckoo 的 `validate.ts` 做同样的事）。用户自定义 provider 也必须过。
 */
export function validateProvider(p: unknown): string | null {
  if (p === null || typeof p !== 'object') return '必须是对象'
  const o = p as Record<string, unknown>
  if (typeof o.id !== 'string' || o.id === '') return '缺少 id'
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(o.id)) return 'id 只允许字母数字下划线连字符（它会用作 workspace 名）'
  if (typeof o.name !== 'string' || o.name === '') return '缺少 name'
  if (typeof o.homeUrl !== 'string' || !/^https?:\/\//.test(o.homeUrl)) return 'homeUrl 必须是 http(s) URL'
  if (typeof o.urlPattern !== 'string' || o.urlPattern === '') return '缺少 urlPattern'
  try {
    void new RegExp(o.urlPattern)
  } catch {
    return 'urlPattern 不是合法正则'
  }
  const input = o.input as ElementHints | undefined
  if (input === undefined || !Array.isArray(input.selectors) || input.selectors.length === 0) {
    return 'input.selectors 必须是非空数组'
  }
  const send = o.send as ElementHints | undefined
  if (send === undefined || !Array.isArray(send.selectors) || send.selectors.length === 0) {
    return 'send.selectors 必须是非空数组'
  }
  if (typeof o.completionPath !== 'string' || o.completionPath === '') return '缺少 completionPath'
  if (!Array.isArray(o.models) || o.models.length === 0) return 'models 必须是非空数组'
  for (const m of o.models as Array<Record<string, unknown>>) {
    if (typeof m.id !== 'string' || m.id === '') return 'models[].id 必须是非空字符串'
    if (typeof m.name !== 'string' || m.name === '') return 'models[].name 必须是非空字符串'
  }
  if (typeof o.contextWindow !== 'number' || o.contextWindow <= 0) return 'contextWindow 必须是正数'
  if (typeof o.maxOutputTokens !== 'number' || o.maxOutputTokens <= 0) return 'maxOutputTokens 必须是正数'
  // 编译所有正则，避免运行期才炸
  for (const [src] of send.signatures ?? []) {
    try {
      void new RegExp(src)
    } catch {
      return `send.signatures 里有非法正则：${src}`
    }
  }
  for (const src of send.vetoes ?? []) {
    try {
      void new RegExp(src)
    } catch {
      return `send.vetoes 里有非法正则：${src}`
    }
  }
  return null
}

/**
 * Provider 注册表。
 *
 * 语义：**内置打底，自定义覆盖**（按 id 匹配）。用户改坏了某个 provider 时
 * 只跳过那一条，不影响其它 —— 内置的仍然可用。
 */
export class ProviderRegistry {
  private readonly builtins: Provider[]
  private readonly customs = new Map<string, Provider>()

  constructor(builtins: Provider[] = BUILTIN_PROVIDERS) {
    this.builtins = builtins.filter((p) => {
      const err = validateProvider(p)
      if (err !== null) {
        console.warn('[dsh-webin] 内置 provider 校验失败，跳过:', p?.id ?? '?', err)
        return false
      }
      return true
    })
  }

  /**
   * 装入用户自定义 provider（覆盖同 id 的内置项）。
   *
   * @returns 被接受的 id 与拒绝原因
   */
  loadCustom(raw: unknown[]): { accepted: string[]; rejected: Array<{ index: number; reason: string }> } {
    const accepted: string[] = []
    const rejected: Array<{ index: number; reason: string }> = []
    raw.forEach((item, index) => {
      const err = validateProvider(item)
      if (err !== null) {
        rejected.push({ index, reason: err })
        return
      }
      const p = item as Provider
      this.customs.set(p.id, p)
      accepted.push(p.id)
    })
    return { accepted, rejected }
  }

  /** 全部 provider：自定义优先（同 id 覆盖内置）。 */
  all(): Provider[] {
    const out: Provider[] = []
    const seen = new Set<string>()
    for (const p of this.customs.values()) {
      out.push(p)
      seen.add(p.id)
    }
    for (const p of this.builtins) {
      if (seen.has(p.id)) continue
      out.push(p)
    }
    return out
  }

  /** 按 id 取；找不到回退到默认 provider。 */
  get(id: string | undefined): Provider {
    const list = this.all()
    const hit = list.find((p) => p.id === id)
    if (hit !== undefined) return hit
    const fallback = list.find((p) => p.id === DEFAULT_PROVIDER_ID) ?? list[0]
    if (fallback === undefined) throw new Error('dsh-webin: 没有任何可用 provider')
    return fallback
  }

  /** 按 URL 识别所属 provider（页面导航后用）。 */
  byUrl(url: string): Provider | undefined {
    if (url === '') return undefined
    for (const p of this.all()) {
      try {
        if (new RegExp(p.urlPattern).test(url)) return p
      } catch {
        /* 校验阶段已排除非法正则 */
      }
    }
    return undefined
  }

  /** 自定义覆盖了哪些内置 id（设置页显示用）。 */
  overriddenIds(): string[] {
    const builtinIds = new Set(this.builtins.map((p) => p.id))
    return [...this.customs.keys()].filter((id) => builtinIds.has(id))
  }
}
