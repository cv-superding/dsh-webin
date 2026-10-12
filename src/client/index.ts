/**
 * dsh-webin — client 半。
 *
 * 结构上模仿 cuckoo-code：**不设计协议，操作界面**。
 *   1. 用 DSH 自带的 webview guest 通道拿一个真 Chromium 多进程 guest（等价 cuckoo 的 WebContentsView）
 *   2. 真浏览器里加载 chat.deepseek.com，用户真人登录
 *   3. 注入 hook 只读观察页面自己的 SSE（等价 cuckoo 的 providers/hooks/deepseek.ts）
 *
 * 状态：P0（LDW 标签）+ P1（真实浏览器 + 登录）+ P2（hook 抓回复）+ P3（provider 接进模型选择器）
 */
import { createElement, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  buildDeepSeekHook,
  buildDrainScript,
  buildProbeScript,
  buildRestoreScript,
  buildSnapshotScript,
  loadSnapshot,
  saveSnapshot,
} from './hook'
import { buildDiagnoseScript, buildSendScript, buildStopScript, pickSendDelay } from './chat'
import { DEFAULT_PROVIDER_ID, ProviderRegistry, type Provider } from '../shared/providers'

/**
 * 平台注册表（模块级单例）。
 *
 * 内置表打底；用户自定义 provider 由 host 半从 `~/.dsh/webin/providers/` 读出后，
 * 通过 `applyCustomProviders()` 灌进来。**放在模块级**是因为面板组件会被
 * 反复挂载/卸载（切标签），注册表不该跟着重建。
 */
const registryRef = { current: new ProviderRegistry() }

/** 由 apply() 在启动时调用：装入 host 侧读到的自定义 provider。 */
export function applyCustomProviders(items: unknown[]): { accepted: string[]; rejected: number } {
  const r = registryRef.current.loadCustom(items)
  return { accepted: r.accepted, rejected: r.rejected.length }
}

/** 把 Provider 的定位策略转成发送脚本要的形状。 */
function sendHintsFor(p: Provider): {
  inputSelectors: string[]
  sendSelectors: string[]
  signatures?: Array<[string, number]>
  vetoes?: string[]
} {
  return {
    inputSelectors: p.input.selectors ?? [],
    sendSelectors: p.send.selectors ?? [],
    ...(p.send.signatures === undefined ? {} : { signatures: p.send.signatures }),
    ...(p.send.vetoes === undefined ? {} : { vetoes: p.send.vetoes }),
  }
}

/** webview 导航 + 吞错（导航失败不算致命：发送脚本自己会报具体错误）。 */
function element_loadURL(el: GuestElement, url: string): Promise<void> {
  return el.loadURL(url).then(
    () => undefined,
    () => undefined,
  )
}

export const inject = ['slots']

/** 与主进程门禁严格一致：src 必须精确是 about:blank#<lease>。 */
const LEASE_PREFIX = 'about:blank#'

/**
 * 真实 Chrome UA —— 抹掉 `Electron/44.0.0` 标识。
 *
 * 必要性（实测）：Electron 默认 UA 是
 *   `Mozilla/5.0 ... Chrome/152.0.7977.54 Electron/44.0.0 Safari/537.36`
 * DeepSeek 网页端看到 `Electron/` 直接回「使用环境异常」。
 * `dsh-deepseek-web-login` 的 `src/login.ts:26-32` 记过同一件事，
 * 所以它才要 `buildLoginUserAgent()` 洗白。
 *
 * 版本取内核真实主版本，保持 UA ↔ 内核自洽（写死旧版本反而制造矛盾）。
 */
function buildChromeUserAgent(): string {
  const major = /Chrome\/(\d+)/.exec(navigator.userAgent)?.[1] ?? '0'
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
}

/**
 * 主世界指纹修正。
 *
 * `navigator.webdriver` 在 Electron 里默认就是 false，但显式钉死做双保险；
 * `userAgentData` 补品牌列表（Electron 默认缺 `"Google Chrome"` 品牌）。
 * 这段在 `dom-ready` 注入，早于任何用户交互。
 */
function fingerprintFix(): string {
  const major = /Chrome\/(\d+)/.exec(navigator.userAgent)?.[1] ?? '0'
  const m = JSON.stringify(major)
  return `(function(){try{
var m=${m};
var brands=[{brand:"Google Chrome",version:m},{brand:"Chromium",version:m},{brand:"Not_A Brand",version:"24"}];
var uad={brands:brands,mobile:false,platform:"Windows",
getHighEntropyValues:function(){return Promise.resolve({architecture:"x86",bitness:"64",brands:brands,mobile:false,platform:"Windows",platformVersion:"10.0.0",uaFullVersion:m+".0.0.0",fullVersionList:brands});},
toJSON:function(){return{brands:brands,mobile:false,platform:"Windows"};}};
try{Object.defineProperty(navigator,"userAgentData",{get:function(){return uad;},configurable:true});}catch(e){}
try{Object.defineProperty(navigator,"webdriver",{get:function(){return false;},configurable:true});}catch(e){}
}catch(e){}})();`
}

const CSS = `
/* 常驻宿主：挂在 shell.overlay（root scope，永不卸载），用 fixed 贴到占位符上。 */
.webin-host{position:fixed;display:flex;flex-direction:column;box-sizing:border-box;
  color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);
  border-radius:var(--dsw-radius-md);overflow:hidden}
.webin-placeholder{width:100%;height:100%;min-height:0;flex:auto}
.webin-bar{flex:none;display:flex;align-items:center;gap:8px;height:38px;padding:0 8px;
  box-sizing:border-box;border-bottom:.5px solid var(--dsw-alias-border-l3)}
.webin-title{font:var(--dsw-font-xs-12);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.webin-select{height:26px;max-width:200px;padding:0 6px;border-radius:var(--dsw-radius-sm);cursor:pointer;
  border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12)}
.webin-btn{height:26px;padding:0 10px;border-radius:var(--dsw-radius-sm);cursor:pointer;
  border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12)}
.webin-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.webin-btn:disabled{color:var(--dsw-alias-label-quaternary);cursor:default}
.webin-spacer{flex:auto}
/* webview 的挂载容器：React 从不向它渲染子节点，只由我们用 appendChild 放 guest。
   这样 React 的 reconciliation 不会碰到 webview（它是非受控 DOM）。 */
.webin-guest{flex:auto;min-height:0;display:flex}
.webin-guest webview{width:100%;height:100%;display:flex;border:0}
/* 未就绪提示：盖在 guest 区域上（跳过 38px 工具栏），不遮挡按钮 */
.webin-note{position:absolute;left:0;right:0;bottom:0;top:38px;display:flex;align-items:center;
  justify-content:center;padding:24px;text-align:center;white-space:pre-wrap;
  font:var(--dsw-font-xs-12);color:var(--dsw-alias-label-tertiary)}
.webin-capture{flex:none;max-height:120px;overflow:auto;padding:6px 8px;box-sizing:border-box;
  border-top:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);
  font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary);white-space:pre-wrap}
.webin-badge-on,.webin-badge-off{flex:none;padding:1px 6px;border-radius:var(--dsw-radius-sm);
  font:var(--dsw-font-xxxs-11);white-space:nowrap}
.webin-badge-on{color:var(--dsw-alias-state-success-primary);
  background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent)}
.webin-badge-off{color:var(--dsw-alias-label-quaternary);
  background:var(--dsw-alias-bg-layer-2)}
`

// ---------------------------------------------------------------------------
// 占位符 ↔ 常驻宿主的坐标通道
// ---------------------------------------------------------------------------

/**
 * 为什么需要这层：**`conversation.view` 切标签会卸载组件**。
 *
 * 证据（DSH 客户端 bundle）：
 *   - `conversation.view` 声明为 `kind: 'list'`（`ui-conversation/lib/client.js:18209`）
 *   - 渲染点传了 `{ only: viewId }`（同文件 `:16412-16421`）
 *   - renderer 对 `only` 的处理是 **filter + 单元素 map**，不是 CSS 隐藏
 *     （`ui-renderer/lib/client.js:1193-1196`）；React 兄弟 key 变化 ⇒ 旧子树整体卸载
 *   - 全部 client bundle 里 `keepAlive` / `Offscreen` **零命中**
 *
 * 后果：若把 `<webview>` 直接放在 `conversation.view` 里，用户一切到「对话」看回答，
 * guest 就被销毁、lease 被释放、轮询全停 —— 生成中的回答直接中断。
 *
 * 所以拆成两半：
 *   - **常驻宿主**挂 `shell.overlay`（`kind: 'list'` + `scope: 'root'`，渲染点
 *     `renderSlot('shell.overlay', {})` 不传 `only` ⇒ 永不卸载，`ui-layout/lib/client.js:312,617`）
 *     官方 `ui-chat` 的额度浮层就是这么挂的（`ui-chat/lib/client.js:12473`）
 *   - **占位符**留在 `conversation.view` 里，只负责量自己的矩形并广播
 *
 * ⚠️ 宿主容器**绝不重新挂载**：Electron 的 `<webview>` 一旦从 DOM 移除再插入，
 * guest 会重新加载 —— 那就白拆了。所以宿主只改坐标，DOM 节点自始至终不动。
 */
interface HostRect {
  left: number
  top: number
  width: number
  height: number
  visible: boolean
}

let hostRect: HostRect | null = null
const rectListeners = new Set<(r: HostRect | null) => void>()

function publishRect(rect: HostRect | null): void {
  hostRect = rect
  for (const fn of rectListeners) fn(rect)
}

function subscribeRect(fn: (r: HostRect | null) => void): () => void {
  rectListeners.add(fn)
  fn(hostRect)
  return () => {
    rectListeners.delete(fn)
  }
}

/**
 * 判断一份快照是否**真的处于登录态**。
 *
 * 为什么要解值而不是看键名：DeepSeek 未登录时也会写 `userToken` /
 * `__appKit_userInfo` 这些键，值是 `null`（实测形状）：
 *
 * ```json
 * "userToken": "{\"value\":null,\"__version\":\"0\"}"
 * "__appKit_userInfo": "{\"value\":{\"id\":null},\"__version\":\"0\"}"
 * ```
 *
 * 只看键是否存在会让「登录页的空快照」覆盖掉上一次的有效快照，
 * 下次启动回写的就是一个空 token —— 白存。
 *
 * 判据（任一成立即认为已登录）：
 *   1. `userToken` 解包后是**非空字符串**
 *   2. `__appKit_userInfo` 解包后 `id` 是**非空字符串**
 *
 * 同时排除停在登录路由上的快照（哪怕 token 还在，页面在登录页说明没生效）。
 */
function snapshotLooksLoggedIn(snapshot: {
  localStorage?: Record<string, string>
  url?: string
}): boolean {
  const ls = snapshot.localStorage ?? {}

  /**
   * 解包 AppKit 包装：`{"value":<v>,"__version":"0"}` → `<v>`。
   *
   * ⚠️ 解析失败时**不能把原文当 token** —— 那样 `"{broken"` 这种畸形值
   * 会被当成有效 token（非空字符串），于是坏快照又能覆盖好快照。
   * 只有**看起来像 JSON 却解析失败**的才返回 undefined；
   * 真正的裸 token（不以 `{` 开头）才按原文返回。
   */
  const unwrap = (raw: string | undefined): unknown => {
    if (typeof raw !== 'string' || raw === '') return undefined
    const trimmed = raw.trim()
    if (trimmed === '') return undefined
    // JSON 的空值字面量：`"null"` / `"undefined"` 都不是 token
    if (trimmed === 'null' || trimmed === 'undefined') return undefined
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
      // 裸字符串 token（旧版页面可能这样存）
      return trimmed
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (parsed !== null && typeof parsed === 'object' && 'value' in (parsed as object)) {
        return (parsed as { value: unknown }).value
      }
      return parsed
    } catch {
      // 像 JSON 但解析失败 ⇒ 视为无效，绝不 fallback 成原文
      return undefined
    }
  }

  const token = unwrap(ls.userToken)
  if (typeof token === 'string' && token.trim() !== '') return true

  const info = unwrap(ls['__appKit_userInfo'])
  if (info !== null && typeof info === 'object') {
    const id = (info as { id?: unknown }).id
    if (typeof id === 'string' && id.trim() !== '') return true
  }

  return false
}

interface GuestReservation {
  lease: string
  partition: string
}

/** 宿主 preload 暴露的浏览器 guest 桥（Desktop 主窗口主 frame 才有）。 */
interface DesktopBrowserBridge {
  acquire(workspace: string): Promise<GuestReservation>
  release(lease: string): Promise<void>
  onOpenRequested(lease: string, listener: (url: string) => void): () => void
}

interface GuestElement extends HTMLElement {
  loadURL(url: string): Promise<void>
  executeJavaScript(code: string): Promise<unknown>
  reload(): void
}

function desktopBrowser(): DesktopBrowserBridge | undefined {
  const carrier = (globalThis as unknown as { dshDesktop?: { protocolVersion?: number; browser?: unknown } }).dshDesktop
  if (carrier === undefined || carrier === null) return undefined
  if (carrier.protocolVersion !== 1) return undefined
  const bridge = carrier.browser as DesktopBrowserBridge | undefined
  if (bridge === undefined || typeof bridge.acquire !== 'function') return undefined
  return bridge
}

/**
 * LDW **常驻宿主**：申请一个真实浏览器 guest 并挂载。
 *
 * 挂在 `shell.overlay`（root scope，永不卸载），用 `position:fixed` 贴到
 * `LdwPlaceholder` 量出来的矩形上。**这个组件的 DOM 节点自始至终不移动、不重建** ——
 * Electron 的 `<webview>` 一旦从 DOM 摘除再插回，guest 会重新加载。
 *
 * guest 的三条硬约束来自 DSH 主进程 `will-attach-webview`（main.js:9682-9707）：
 *   - `src` 必须精确等于 `about:blank#<lease>`
 *   - `partition` 必须等于 acquire 返回的 partition
 *   - 一个 lease 只能挂载一次（`lease.attached` 后重挂会被拒）
 */
export function LdwHost(): unknown {
  const hostRef = useRef<HTMLDivElement | null>(null)
  /** webview 的挂载点（React 不向它渲染子节点）。 */
  const guestRef = useRef<HTMLDivElement | null>(null)
  const leaseRef = useRef<string | undefined>(undefined)
  const [status, setStatus] = useState('正在申请浏览器…')
  const [ready, setReady] = useState(false)
  /** 从 guest 抓到的最后一条回复（P2 的可见证据）。 */
  const [lastReply, setLastReply] = useState('')
  /** 抓到的回复条数。 */
  const [replyCount, setReplyCount] = useState(0)
  /** guest 里的登录态（来自 probe）。 */
  const [loggedIn, setLoggedIn] = useState(false)
  /** 最近一次成功发送的记录（时间 / 方式 / 字符数），显示在工具栏上。 */
  const [lastSend, setLastSend] = useState<{ at: string; how: string; chars: number } | undefined>(undefined)
  /** 诊断输出（页面结构 dump）。 */
  const [diagnosis, setDiagnosis] = useState('')
  /** 占位符当前的矩形；null = LDW 标签不在前台。 */
  const [rect, setRect] = useState<HostRect | null>(hostRect)
  /** 自校正偏移量（抵消可能的 transform 祖先；无 transform 时保持 0）。 */
  const [pos, setPos] = useState({ left: 0, top: 0 })

  /** 当前驱动哪个平台。切换它会重建 guest（新 workspace ⇒ 新 partition）。 */
  const [platformId, setPlatformId] = useState<string>(DEFAULT_PROVIDER_ID)
  const provider = useMemo(() => registryRef.current.get(platformId), [platformId])

  useEffect(() => subscribeRect(setRect), [])

  useEffect(() => {
    let disposed = false
    const host = guestRef.current
    if (host === null) return

    const browser = desktopBrowser()
    if (browser === undefined) {
      setStatus('当前环境没有 DSH 桌面浏览器通道。\nLDW 只能在 Desktop 版 DSH 里使用。')
      return
    }

    let cleanupElement: (() => void) | undefined
    /**
     * 启动阶段机：`boot → navigating → restoring → reloading → live`。
     *
     * 用显式阶段标记而不是「第几次 dom-ready」，因为**某一步没发生也不能卡住后续**
     * （早期用计数时，没有快照就永远停在 2，hook 永不注入、插件永久失效）。
     */
    let stage: 'boot' | 'navigating' | 'restoring' | 'reloading' | 'live' = 'boot'
    const stageRef = {
      get current() {
        return stage
      },
      set current(next: typeof stage) {
        if (next !== stage) console.log('[dsh-webin] 阶段', stage, '→', next)
        stage = next
      },
    }
    /** 登录态轮询定时器（只用于显示；功能不依赖它）。 */
    let probeTimer: number | undefined
    /** 是否已经标记过「就绪」（避免重复注入/重复置位）。 */
    let liveMarked = false

    void (async () => {
      try {
        /**
         * **workspace 名决定 partition，也就决定登录态隔离。**
         *
         * `DesktopBrowserGuests.acquire(owner, workspace)` 按 workspace 字符串
         * 缓存 partition（`main.js:9636-9641`），所以用 `provider.id` 当 workspace 名
         * 就能让每个平台拿到独立的 cookie / localStorage —— 多平台登录互不干扰，
         * 且不需要改 DSH 一行。
         */
        const reservation = await browser.acquire(provider.id)
        if (disposed) {
          await browser.release(reservation.lease).catch(() => undefined)
          return
        }
        leaseRef.current = reservation.lease

        const element = document.createElement('webview') as GuestElement
        element.setAttribute('partition', reservation.partition)
        // `useragent` 属性在**导航之前**生效 —— 不能等 dom-ready 再用 setUserAgent，
        // 否则第一次请求已经带着 Electron UA 出去了。
        element.setAttribute('useragent', buildChromeUserAgent())
        element.setAttribute('src', LEASE_PREFIX + reservation.lease)
        element.setAttribute('allowpopups', '')
        host.appendChild(element)
        cleanupElement = () => {
          try {
            element.remove()
          } catch {
            /* ignore */
          }
        }

        /**
         * 标记「页面已可用」：检查输入框 → 置 `ready` → 启动登录态轮询。
         *
         * 抽成函数是因为有两条路径会走到这里（有快照 reload 后、无快照直接进），
         * 而且**幂等**（重复调用无副作用）。
         */
        const markLive = (): void => {
          if (disposed || liveMarked) return
          liveMarked = true
          setStatus('真实浏览器已就绪')
          // 登录态轮询（只用于显示；功能不依赖它）
          if (probeTimer === undefined) {
            probeTimer = window.setInterval(() => {
              if (disposed) return
              const node = hostRef.current?.querySelector('webview') as GuestElement | null
              if (node === null) return
              void node
                .executeJavaScript(buildProbeScript())
                .then((r2) => {
                  if (disposed) return
                  try {
                    const p2 = JSON.parse(String(r2)) as { loggedIn?: boolean }
                    setLoggedIn(p2.loggedIn === true)
                  } catch {
                    /* ignore */
                  }
                })
                .catch(() => undefined)
            }, 5_000)
          }
        }

        element.addEventListener('dom-ready', () => {
          if (disposed) return

          /**
           * ## 登录态恢复的正确时序（这里踩过坑，务必按顺序）
           *
           * 早期实现在**第一次 `dom-ready`（页面还是 `about:blank`）**上跑 restore，
           * 结果是**每次重启都要重新登录**。原因有两层：
           *
           * 1. `about:blank` 是 **opaque origin**，`localStorage` 直接抛
           *    `SecurityError: Access is denied for this document`
           *    （实测，见 `scripts/probe-origin.mjs`）—— 写操作全部静默失败；
           * 2. 就算不抛，**localStorage 按源隔离**：在 A 源写的值 B 源读不到。
           *
           * 而 DSH 的 guest partition 是**内存分区**
           * （`main.js:9638`：`dsh-sidebar-browser-${randomUUID()}`，无 `persist:` 前缀），
           * 门禁又强制 `params.partition === lease.partition`（`main.js:9685`），
           * **不允许我们自己换成持久分区**。所以重启后 storage 一定是空的，
           * 只能靠「快照 + 在正确源上回写」补救。
           *
           * 正确顺序：
           *   1. 先 `loadURL(homeUrl)` 到**目标域**
           *   2. 目标域的 `dom-ready` 里 restore（此时 localStorage 可写、且源正确）
           *   3. `reload` 让页面带着登录态重新初始化
           *   4. 之后的 `dom-ready` 才注入 hook / 探针
           *
           * ⚠️ **`setReady(true)` 必须等到第 4 阶段**。
           * 早期把 `setReady(true)` 放在这里（第 1 阶段），
           * 于是发送循环在页面还是 `about:blank` / 登录页时就去领任务，
           * 必然报 `no-input: 找不到可见的输入框` —— 实测踩过（用户截图里的报错）。
           * `ready` 的语义应该是「页面已经能干活了」，而不是「webview 挂上了」。
           */
          /**
           * ## 阶段机（替代早期的 `documentCount` 计数）
           *
           * 早期用 `documentCount === 1 / 2 / >= 3` 判断该做哪一步，
           * 有两个真实缺陷：
           *
           *   1. **一旦某步没发生，后续永远不发生**。比如没有快照时
           *      `documentCount===2` 分支直接 return 且不 reload，
           *      计数就停在 2 —— 于是 hook 永远不注入、`ready` 永远不置位，
           *      **整个插件永久失效**（用户看到「模型一直不回复」）。
           *   2. **页面后续导航会打乱计数**。用户在 guest 里点了个链接、
           *      或页面自己跳登录页，`documentCount` 继续增长，
           *      重新走进「>= 3」分支 —— 虽然碰巧是对的，但纯属运气。
           *
           * 改成显式阶段标记：**每个阶段只做一次，且不依赖"第几次 dom-ready"**。
           */
          if (stageRef.current === 'boot') {
            stageRef.current = 'navigating'
            /**
             * ## 优先回到「上次的会话 URL」，而不是每次都开新对话
             *
             * 早期无条件 `loadURL(homeUrl)`（= chat.deepseek.com 首页），
             * 页面把它当成「开新对话」—— 于是**每次重启/重挂载都新建一个对话**，
             * 网页版侧栏堆出一排「从1数到800」「8加8等于16」（用户实测看到的）。
             *
             * 更严重的连带后果：host 侧的差分游标还记着「这会话发过 N 条」，
             * 而页面里是一个**空的新对话** —— 下一轮只发增量，模型完全没上下文。
             *
             * 快照里存了 `url`（上次离开时所在的会话页）。只要它还在本平台域内，
             * 就直接回到那个对话，让页面历史与 host 游标对得上。
             * 没有快照 / URL 非法时才退回 homeUrl。
             */
            void (async () => {
              let target = provider.homeUrl
              try {
                const raw = await loadSnapshot(provider.id)
                if (typeof raw === 'string' && raw !== '') {
                  const snap = JSON.parse(raw) as { url?: unknown }
                  const saved = typeof snap.url === 'string' ? snap.url : ''
                  if (saved !== '') {
                    const u = new URL(saved)
                    if (new RegExp(provider.urlPattern).test(u.hostname + u.pathname)) {
                      target = saved
                      console.log('[dsh-webin] 回到上次会话', saved)
                    }
                  }
                }
              } catch {
                /* 快照读不了 / URL 非法就用 homeUrl */
              }
              if (!disposed) void element.loadURL(target).catch(() => undefined)
            })()
            return
          }

          if (stageRef.current === 'navigating') {
            stageRef.current = 'restoring'
            void (async () => {
              const snap = await loadSnapshot(provider.id)
              if (snap === undefined) {
                console.log('[dsh-webin] 无登录态快照，跳过回写')
                stageRef.current = 'live'
                // 没有快照也要继续走「就绪」流程，否则插件永远不工作
                markLive()
                return
              }
              let restored = false
              try {
                const raw = await element.executeJavaScript(buildRestoreScript(snap))
                const r = JSON.parse(String(raw)) as { ok?: boolean; reason?: string }
                restored = r.ok === true
                console.log('[dsh-webin] 登录态回写', provider.id, raw)
                if (!restored) console.warn('[dsh-webin] 回写未成功:', r.reason ?? 'unknown')
              } catch (error) {
                console.warn('[dsh-webin] 登录态回写失败', error)
              }
              if (disposed) return
              if (restored) {
                // 带着刚写回的登录态 reload；下一次 dom-ready 会走到下面的 live 分支
                stageRef.current = 'reloading'
                void element.reload().catch(() => undefined)
              } else {
                stageRef.current = 'live'
                markLive()
              }
            })()
            return
          }

          /**
           * 页面已可用（`live` / `reloading`）。
           *
           * ⚠️ **每次 dom-ready 都重新注入 hook** —— hook 是页面级的，
           * 页面一导航就没了。早期只在特定计数时注入，导航后就失效了。
           * `buildDeepSeekHook()` 自带幂等标记，重复注入无害。
           */
          stageRef.current = 'live'
          markLive()

          // ⚠️ `setReady(true)` 放在这里 —— 页面到这一步才真的能干活。
          // 而且**等确认输入框存在**再置位：SPA 渲染有延迟，
          // 提前置位会让发送循环领到任务却找不到输入框（`no-input`）。
          void element
            .executeJavaScript(`(function () {
              var sels = ${JSON.stringify(provider.input.selectors)};
              for (var i = 0; i < sels.length; i++) {
                var list;
                try { list = document.querySelectorAll(sels[i]); } catch (e) { continue; }
                for (var j = 0; j < list.length; j++) {
                  var el = list[j];
                  if (el.offsetWidth > 0 && el.offsetHeight > 0) return true;
                }
              }
              return false;
            })()`)
            .then((hasInput) => {
              if (disposed) return
              console.log('[dsh-webin] 输入框就绪检查:', hasInput)
              setReady(true)
              if (hasInput === true) setStatus('真实浏览器已就绪')
              else setStatus('页面已加载，但未找到输入框（可能未登录或结构已变）')
            })
            .catch(() => {
              if (disposed) return
              // 检查失败也置位 —— 让发送脚本自己去报具体错误，别卡死
              setReady(true)
            })

          void element.executeJavaScript(fingerprintFix()).catch(() => undefined)
          void element
            .executeJavaScript(buildDeepSeekHook(provider.completionPath, provider.stopPath))
            .then((r) => {
              if (disposed) return
              console.log('[dsh-webin] hook:', provider.id, r)
            })
            .catch((e) => {
              if (disposed) return
              console.error('[dsh-webin] hook 注入失败', e)
            })
          void element
            .executeJavaScript(buildProbeScript())
            .then((raw) => {
              if (disposed) return
              try {
                const info = JSON.parse(String(raw)) as { loggedIn?: boolean } & Record<string, unknown>
                ;(globalThis as unknown as { __dshWebinProbe?: unknown }).__dshWebinProbe = info
                console.log('[dsh-webin] guest probe', info)
                setLoggedIn(info.loggedIn === true)
              } catch {
                /* ignore */
              }
            })
            .catch(() => undefined)

          // 登录态持续探测已抽到 markLive() 里（那里起的 5s 轮询就是干这个的），
          // 避免重复起两个定时器。
        })

        element.addEventListener('did-fail-load', (event) => {
          if (disposed) return
          const e = event as unknown as { isMainFrame?: boolean; errorCode?: number; errorDescription?: string }
          if (e.isMainFrame !== true || e.errorCode === -3) return
          setStatus(`加载失败：${e.errorDescription ?? e.errorCode}`)
          /**
           * ⚠️ **加载失败时不能让阶段机卡住。**
           *
           * 首页加载失败（断网 / DNS / 被墙）时不会触发 `dom-ready`，
           * 阶段就停在 `navigating` —— 之后即使网络恢复，也**永远不会再前进**，
           * 插件表现为「一直不回复」。
           *
           * 所以失败时退回 `boot`，让下一次 `dom-ready` 重新走一遍流程。
           * 退避由浏览器自身的重试节奏决定，不额外加定时器。
           */
          if (stageRef.current === 'navigating' || stageRef.current === 'restoring') {
            console.warn('[dsh-webin] 加载失败，阶段回退到 boot 以便重试')
            stageRef.current = 'boot'
          }
        })

        /**
         * 渲染进程崩溃（OOM / 页面把 GPU 搞挂）后 webview 会重新加载，
         * 阶段机要能重来 —— 否则同样是「永久卡住」。
         */
        element.addEventListener('render-process-gone', () => {
          if (disposed) return
          console.warn('[dsh-webin] guest 渲染进程结束，阶段回退到 boot')
          setStatus('页面进程异常，正在恢复…')
          liveMarked = false
          stageRef.current = 'boot'
        })
      } catch (error) {
        if (disposed) return
        setStatus(`申请浏览器失败：${(error as Error)?.message ?? String(error)}`)
      }
    })()

    return () => {
      disposed = true
      if (probeTimer !== undefined) window.clearInterval(probeTimer)
      cleanupElement?.()
      const lease = leaseRef.current
      leaseRef.current = undefined
      if (lease !== undefined) void browser.release(lease).catch(() => undefined)
    }
    /**
     * ⚠️ 依赖 `provider.id`：切换平台必须**重建 guest**。
     * 每个平台一个 workspace ⇒ 一个 partition ⇒ 一套独立登录态，
     * 复用同一个 guest 就共享登录态了，多平台隔离失效。
     * （早期这里写死 `[]`，切平台不生效 —— 实测发现。）
     */
  }, [provider.id])

  // 轮询取走 hook 累积的事件。
  // CustomEvent 跨不过 webview 边界，guest 又是 sandbox 无 preload 拿不到 ipcRenderer，
  // 所以 executeJavaScript 轮询是唯一稳定的桥。
  //
  // 这里同时承担 P3 的「等回复」：正在跑任务时，把 done 事件作为结果交回 host。
  const pendingJobRef = useRef<string | undefined>(undefined)
  /**
   * 本次发送被确认的时刻（页面时间）。
   *
   * **防串台**：用户在页面上自己聊过天，或上一次回复的 `done` 事件还在队列里，
   * 都可能在我们派发任务后立刻被排空 —— 那样就会把**别人的回复**当成任务结果交回去。
   * 只接受发送确认之后产生的 `done` 事件。
   */
  const sentAtRef = useRef<number>(0)
  /**
   * 当前待办任务（已发送、等回复）。
   *
   * 有值 ⇒ 发送循环**不再领新任务**（否则会插队打断当前生成、回复串台）。
   * 靠 `done`/`error` 事件清空；另有一道超时兜底（见 `pendingSinceRef`），
   * 防止事件丢失导致永久卡住。
   */
  const pendingSinceRef = useRef<number>(0)
  useEffect(() => {
    if (!ready) return
    const timer = window.setInterval(() => {
      const el = hostRef.current?.querySelector('webview') as GuestElement | null
      if (el === null) return
      void el
        .executeJavaScript(buildDrainScript())
        .then((raw) => {
          const text = String(raw)
          if (text === '[]' || text === '') return
          const events = JSON.parse(text) as Array<{ name: string; detail: Record<string, unknown>; at?: number }>
          for (const ev of events) {
            // 只认「本次发送之后」的事件，避免把历史回复当成任务结果
            const at = typeof ev.at === 'number' ? ev.at : 0
            if (at !== 0 && at < sentAtRef.current) continue

            if (ev.name === 'done') {
              const reply = String(ev.detail?.text ?? '')
              if (reply === '') continue
              setLastReply(reply)
              setReplyCount((n) => n + 1)
              console.log('[dsh-webin] reply captured', {
                chars: reply.length,
                status: ev.detail?.status,
                think: String(ev.detail?.think ?? '').length,
              })
              // 有在跑的任务 → 交结果（带上当前页面 URL，host 靠它绑定会话 ↔ 网页对话）
              const jobId = pendingJobRef.current
              if (jobId !== undefined) {
                pendingJobRef.current = undefined
                pendingSinceRef.current = 0
                /** 拿页面当前 URL（= 这条消息落地的对话页）。 */
                void el
                  .executeJavaScript('location.href')
                  .then((u: unknown) => String(u))
                  .catch(() => '')
                  .then((chatUrl) => {
                    void fetch(`/dsh-webin/api/job/${jobId}/result`, {
                      method: 'PUT',
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({
                        text: reply,
                        think: String(ev.detail?.think ?? ''),
                        status: String(ev.detail?.status ?? 'finished'),
                        ...(chatUrl === '' ? {} : { chatUrl }),
                      }),
                    }).catch(() => undefined)
                  })
              }
            } else if (ev.name === 'error') {
              console.warn('[dsh-webin] page reported error', ev.detail)
              const jobId = pendingJobRef.current
              if (jobId !== undefined) {
                pendingJobRef.current = undefined
                pendingSinceRef.current = 0
                void fetch(`/dsh-webin/api/job/${jobId}/result`, {
                  method: 'PUT',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ error: String(ev.detail?.message ?? 'page error') }),
                }).catch(() => undefined)
              }
            }
          }
        })
        .catch(() => undefined)
    }, 500)
    return () => window.clearInterval(timer)
  }, [ready, provider.id])

  /**
   * 心跳：告诉 host「本面板在线、页面处于什么状态」。
   *
   * 为什么需要：host 半的 adapter 要判断「有没有 client 能干活」。
   * 光看任务队列只能知道「有没有人领活」，而心跳能让 `/status` 直接反映
   * 面板是否挂载、是否已登录 —— 排查「模型不回复」时一眼就能定位。
   */
  useEffect(() => {
    if (!ready) return
    /**
     * clientId 里带上平台 —— 一个面板可能切换平台，
     * 带平台后 host 侧 `/status` 能直接看出「哪个平台的面板在线」。
     */
    const clientId = `webin-${provider.id}-${Math.random().toString(36).slice(2, 10)}`
    let stopped = false
    const beat = () => {
      if (stopped) return
      const el = hostRef.current?.querySelector('webview') as GuestElement | null
      const payload = {
        clientId,
        platform: provider.id,
        loggedIn,
        hasGuest: el !== null,
        lastReplyAt: lastReply === '' ? 0 : Date.now(),
        replyCount,
      }
      void fetch('/dsh-webin/api/client/heartbeat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(() => undefined)
    }
    beat()
    const timer = window.setInterval(beat, 5_000)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [ready, provider.id, loggedIn, lastReply, replyCount])

  // P3：领任务 → 打进网页输入框 → 发送 → 等 hook 抓到回复后交回 host。
  // 这就是 cuckoo 的闭环：请求由**页面自己**发出，我们只操作界面。
  //
  // ⚠️ 这里**故意不拿 `loggedIn` 当门控**。探针只是启发式判断（解析 token / 看 URL / 看 DOM），
  // 误判成「未登录」会让整个模型链路彻底不工作 —— 代价远大于收益。
  // 真正该不该发，由发送脚本在页面上自己判断：找不到输入框就报 `no-input`。
  useEffect(() => {
    if (!ready) return
    let stopped = false
    let busy = false

    const tick = async () => {
      if (stopped || busy) return
      /**
       * ## ⚠️ 正在等回复时**绝不能再领新任务**
       *
       * 这是本插件最危险的一个 bug（实测发现）：
       * 发送成功后 `pendingJobRef` 仍然置着，而轮询每 1.5s 跑一次。
       * 早期版本没有这道闸，于是**页面还在生成时又领了下一个任务**，
       * 把新 prompt 打进输入框并发送 —— 后果：
       *   1. 页面上的生成被打断/插队，两个回复混在一起；
       *   2. hook 抓到的 `done` 分不清是哪个任务的（串台）；
       *   3. DSH 那边两个调用都收到错乱的文本。
       *
       * 所以：`pendingJobRef` 有值 = 上一个任务还没交结果 ⇒ 本轮只做
       * 「问 host 是否被取消」，不领新活。
       */
      const hasPending = pendingJobRef.current !== undefined
      const el = hostRef.current?.querySelector('webview') as GuestElement | null
      if (el === null) return
      busy = true
      try {
        /**
         * **待办超时兜底。**
         *
         * 正常情况下 `done` 事件会清掉 `pendingJobRef`。但事件可能丢：
         * 页面导航了、hook 被清了、回复永远不来。那样 `pendingJobRef`
         * 会一直挂着 ⇒ 发送循环**永久罢工**（再也不领新任务），
         * 用户看到的就是「模型一直不回复」。
         *
         * 所以超过 5 分钟就主动放弃这个任务，把错误交回 host 并解锁循环。
         * （adapter 那边的 `timeoutMs` 是 10 分钟，这里更早，避免两边同时超时。）
         */
        if (hasPending && Date.now() - pendingSinceRef.current > 300_000) {
          const stuck = pendingJobRef.current!
          console.warn('[dsh-webin] 待办超时，放弃任务', stuck)
          pendingJobRef.current = undefined
          pendingSinceRef.current = 0
          await fetch(`/dsh-webin/api/job/${stuck}/result`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ error: '等待网页回复超时（客户端 5 分钟兜底）' }),
          }).catch(() => undefined)
          return
        }
        /**
         * 带上 `running=<当前任务>` —— 让 host 有机会说「这个不算数了」。
         *
         * 用户按停止后 host 会把任务标记为 `cancelled`，但我们可能正在
         * 等页面回复（还没交结果），不会再去领活。所以**每次轮询都问一次**，
         * 被取消就去按页面的停止按钮（否则页面白生成到结束、烧配额、还会串台）。
         */
        const running = pendingJobRef.current
        const query =
          '/dsh-webin/api/job/next?platform=' +
          encodeURIComponent(provider.id) +
          (running === undefined ? '' : '&running=' + encodeURIComponent(running))
        const res = await fetch(query)
        if (!res.ok) return
        const data = (await res.json()) as {
          ok: boolean
          job: { id: string; prompt: string; thinking: boolean; expectUrl?: string; freshChat?: boolean } | null
          /** host 说这个任务已被取消。 */
          cancel?: string
        }

        // 被取消：去按页面的停止按钮，并清掉本地待办
        if (typeof data.cancel === 'string' && data.cancel !== '') {
          console.log('[dsh-webin] 任务已被取消，停止页面生成', data.cancel)
          pendingJobRef.current = undefined
          pendingSinceRef.current = 0
          const stopped = await el.executeJavaScript(buildStopScript(sendHintsFor(provider)))
          console.log('[dsh-webin] 停止结果', stopped)
          return
        }

        // 还有任务在等回复 ⇒ 不领新活（否则会插队打断当前生成）
        if (hasPending) return

        if (stopped || data.job === null || data.job === undefined) return

        const { id, prompt } = data.job

        /**
         * ## 会话路由：先导航到这个任务所属的网页对话
         *
         * 用户实测发现的封号级缺陷：换了几个 DSH 窗口聊天，
         * 网页版里全落在**同一个**会话窗口 —— 上下文互相串、
         * 多个话题混在一条流里，行为模式像机器人。
         *
         * host 在任务上带 `expectUrl`（该 DSH 会话绑定的对话页）。
         * 当前页面不在那里时，**先导航过去再发**：
         *   - 同一 DSH 会话的连续任务 → URL 相同，不导航（零开销）
         *   - 切换 DSH 会话 → 导航回各自的对话，各聊各的
         *   - 首次任务（无 expectUrl）→ 在当前页发，落地 URL 由结果带回
         *
         * 导航后页面重载会触发 dom-ready → 阶段机已在 live，
         * hook 会重新注入（幂等），输入框由发送脚本自带的 waitForInput 等。
         */
        if (typeof data.job.expectUrl === 'string' && data.job.expectUrl !== '') {
          const current = await el
            .executeJavaScript('location.href')
            .then((u: unknown) => String(u))
            .catch(() => '')
          if (current !== data.job.expectUrl) {
            console.log('[dsh-webin] 切换到该会话的对话', {
              from: current.slice(-48),
              to: data.job.expectUrl.slice(-48),
            })
            await element_loadURL(el, data.job.expectUrl)
            /** 等页面就绪（输入框出现），最多 25s；失败则继续用当前页发。 */
            const ready = await el
              .executeJavaScript(
                `(function () {
                  var sels = ${JSON.stringify(provider.input.selectors)};
                  var deadline = Date.now() + 25000;
                  return new Promise(function (resolve) {
                    (function attempt() {
                      for (var i = 0; i < sels.length; i++) {
                        var list;
                        try { list = document.querySelectorAll(sels[i]); } catch (e) { continue; }
                        for (var j = 0; j < list.length; j++) {
                          var el = list[j];
                          if (el.offsetWidth > 0 && el.offsetHeight > 0) { resolve(true); return; }
                        }
                      }
                      if (Date.now() > deadline) { resolve(false); return; }
                      setTimeout(attempt, 300);
                    })();
                  });
                })()`,
              )
              .then((r: unknown) => r === true)
              .catch(() => false)
            if (!ready) console.warn('[dsh-webin] 导航后未见输入框，仍尝试发送')
          }
        }

        /**
         * ## 首轮必须**开新对话**（不能占用当前页）
         *
         * `expectUrl` 只覆盖「已绑定」的情况。首轮没有绑定，早期实现退化成
         * 「在当前页发」—— 而当前页可能是**别的会话的对话**。实测后果：
         *
         * ```
         * 会话A 首轮 → 在当前页 X 发 → 绑定 A→X
         * 会话B 首轮 → 无绑定 → 仍在 X 发 → 绑定 B→X   ← 两个会话挤进 X！
         * ```
         *
         * 这正是用户报的「换了几个 DSH 窗口，全都是在网页版的同一个会话窗口」。
         *
         * 所以 `freshChat` 时**显式开新对话**：导航到 homeUrl。
         * 网页版对 homeUrl 的处理就是「新建/当前空白对话」，
         * 不会复用已有对话的内容（实测：重启后导航 homeUrl 会开新对话）。
         */
        if (data.job.freshChat === true && data.job.expectUrl === undefined) {
          const current = await el
            .executeJavaScript('location.href')
            .then((u: unknown) => String(u))
            .catch(() => '')
          /**
           * 只在**确实停在某个对话里**时才导航 —— 已经在首页/新对话就不动，
           * 避免多余的页面重载（每次重载都是一次真实的浏览器行为，
           * 频繁重载本身就是可疑模式）。
           */
          const inChat = /\/a\/chat\/s\//.test(current)
          if (inChat) {
            console.log('[dsh-webin] 首轮：开新对话（不占用当前页）', { from: current.slice(-48) })
            await element_loadURL(el, provider.homeUrl)
            await el
              .executeJavaScript(
                `(function () {
                  var sels = ${JSON.stringify(provider.input.selectors)};
                  var deadline = Date.now() + 25000;
                  return new Promise(function (resolve) {
                    (function attempt() {
                      for (var i = 0; i < sels.length; i++) {
                        var list;
                        try { list = document.querySelectorAll(sels[i]); } catch (e) { continue; }
                        for (var j = 0; j < list.length; j++) {
                          var el = list[j];
                          if (el.offsetWidth > 0 && el.offsetHeight > 0) { resolve(true); return; }
                        }
                      }
                      if (Date.now() > deadline) { resolve(false); return; }
                      setTimeout(attempt, 300);
                    })();
                  });
                })()`,
              )
              .catch(() => false)
          }
        }

        pendingJobRef.current = id
        pendingSinceRef.current = Date.now()
        // 记录派发时刻：只接受此刻之后产生的 done 事件
        sentAtRef.current = Date.now()
        console.log('[dsh-webin] 领到任务', { id, chars: prompt.length })

        const raw = await el.executeJavaScript(buildSendScript(prompt, pickSendDelay(), sendHintsFor(provider)))
        const outcome = JSON.parse(String(raw)) as {
          ok: boolean
          stage: string
          message: string
          how?: string
          signals?: Record<string, unknown>
          candidates?: unknown
          diag?: unknown
        }
        console.log('[dsh-webin] 发送结果', outcome)

        if (!outcome.ok) {
          pendingJobRef.current = undefined
          pendingSinceRef.current = 0
          await fetch(`/dsh-webin/api/job/${id}/result`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              error: `${outcome.stage}: ${outcome.message}`,
            }),
          }).catch(() => undefined)
          return
        }

        // 发送确认：把「真正发出的时刻」作为时间基准，之后的 done 才算本次回复
        sentAtRef.current = Date.now()
        setLastSend({
          at: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
          how: String(outcome.how ?? '?'),
          chars: prompt.length,
        })
        // 成功则不交结果 —— 等 hook 的 done 事件
      } catch (error) {
        console.warn('[dsh-webin] 任务处理失败', error)
      } finally {
        busy = false
      }
    }

    const timer = window.setInterval(() => void tick(), 1_500)
    void tick()
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [ready, provider.id])

  // 登录态快照：定期把能救的部分存到 host 侧（~/.dsh/webin/）。
  // DSH 的 guest partition 是内存分区（main.js:9638 无 persist: 前缀），重启即丢，
  // 这是不改 DSH 前提下唯一的补救手段。
  //
  // ⚠️ 这里**同样不拿 `loggedIn` 当门控**：探针是启发式判断，误报成未登录就再也存不上快照。
  // 改为由**快照内容自己判断** —— 抓不到 token 就不存。
  useEffect(() => {
    if (!ready) return
    let stopped = false
    const save = () => {
      const el = hostRef.current?.querySelector('webview') as GuestElement | null
      if (el === null) return
      void el
        .executeJavaScript(buildSnapshotScript())
        .then(async (raw) => {
          if (stopped) return
          const text = String(raw)
          if (text === '{}' || text === '') return
          let parsed: { localStorage?: Record<string, string>; cookie?: string; url?: string }
          try {
            parsed = JSON.parse(text) as typeof parsed
          } catch {
            return
          }

          /**
           * **只存「确实登录了」的快照。**
           *
           * ⚠️ 这里踩过坑：早期版本只检查 `userToken` **键是否存在**，
           * 而 DeepSeek 未登录时也会写这个键 —— 值是 `{"value":null,"__version":"0"}`。
           * 于是重启后的登录页会把上一次的有效快照**覆盖成空快照**，
           * 下一次启动回写的就是一个 `userToken: null`，等于白存。
           * 实测：快照里 `userToken={"value":null}` + `__appKit_userInfo={"value":{"id":null}}`
           * + `url=https://chat.deepseek.com/sign_in`。
           *
           * 所以必须**解出值**再判断，而不是看键名。
           */
          if (!snapshotLooksLoggedIn(parsed)) {
            console.log('[dsh-webin] 当前未登录，跳过快照（不覆盖上次有效快照）')
            return
          }

          const ok = await saveSnapshot(text, provider.id)
          if (stopped || !ok) return
          console.log('[dsh-webin] 登录态快照已存入 host', {
            keys: Object.keys(parsed.localStorage ?? {}),
            cookieChars: (parsed.cookie ?? '').length,
          })
        })
        .catch(() => undefined)
    }
    save()
    const timer = window.setInterval(save, 30_000)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [ready, provider.id])

  /**
   * 贴到占位符上。
   *
   * ⚠️ 这里**只改坐标，不动 DOM 结构** —— webview 节点在整棵树里位置恒定，
   * 否则 Electron 会重新加载 guest。
   *
   * 标签切走时 `rect` 变 null：把宿主移出视口并 `visibility:hidden`。
   * **不用 `display:none`** —— 那会让 webview 停止布局，某些情况下触发 guest 重排。
   */
  const visible = rect !== null && rect.visible

  /**
   * 自校正定位。
   *
   * 期望位置来自占位符的 `getBoundingClientRect()`（**视口坐标**），
   * 而 `position:fixed` 只在本元素没有 transform 祖先时才严格等于视口坐标。
   * 实测 DSH 的 `shell.overlay` 链路（`ui-layout` 全量 CSS）没有 transform，
   * 但那是**别人代码的前提**，不该由本插件承担。
   *
   * 所以这里不假设：放好之后量一下自己的真实位置，按偏差修正。
   * 有 translate 类祖先时偏差被抵消，没有时偏差为 0、立即收敛。
   *
   * 修正次数**有上限**：若祖先是 scale 之类无法用平移抵消的变换，
   * 迭代不会收敛，此时必须停下来而不是无限重渲染。
   */
  const fixAttemptsRef = useRef(0)
  useLayoutEffect(() => {
    if (!visible || rect === null) {
      fixAttemptsRef.current = 0
      return
    }
    const el = hostRef.current
    if (el === null) return
    if (fixAttemptsRef.current >= 4) return
    const current = el.getBoundingClientRect()
    const dx = rect.left - current.left
    const dy = rect.top - current.top
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
      fixAttemptsRef.current = 0
      return
    }
    fixAttemptsRef.current += 1
    setPos((prev) => ({ left: prev.left + dx, top: prev.top + dy }))
  })

  const box = visible && rect !== null
    ? { left: `${pos.left + rect.left}px`, top: `${pos.top + rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` }
    : { left: '-10000px', top: '0px', width: '800px', height: '600px' }

  return createElement(
    'div',
    {
      className: 'webin-host',
      ref: hostRef,
      style: {
        ...box,
        visibility: visible ? 'visible' : 'hidden',
      },
    },
    [
      createElement('div', { className: 'webin-bar', key: 'bar' }, [
        /**
         * 平台选择器。
         *
         * 切换平台会**重建 guest**（新 workspace ⇒ 新 partition ⇒ 独立登录态）。
         * 这是刻意的：`DesktopBrowserGuests` 的 partition 按 workspace 缓存
         * （`main.js:9636-9641`），复用同一个 workspace 就共享登录态，
         * 而多平台恰恰需要隔离。
         */
        createElement(
          'select',
          {
            className: 'webin-select',
            key: 'p',
            value: platformId,
            onChange: (e: { target: { value: string } }) => {
              setPlatformId(e.target.value)
              setReady(false)
              setStatus('正在切换平台…')
              setLastReply('')
              setReplyCount(0)
              setLoggedIn(false)
              setDiagnosis('')
            },
          },
          registryRef.current.all().map((p) =>
            createElement('option', { key: p.id, value: p.id }, p.name),
          ),
        ),
        createElement(
          'span',
          { className: loggedIn ? 'webin-badge-on' : 'webin-badge-off', key: 'a' },
          loggedIn ? '已登录' : '未登录',
        ),
        createElement('span', { className: 'webin-spacer', key: 's' }),
        createElement(
          'span',
          { className: 'webin-title', key: 'c' },
          lastSend !== undefined
            ? `${lastSend.at} 已发送(${lastSend.how}) · 收到 ${replyCount} 条`
            : replyCount > 0
              ? `已抓取 ${replyCount} 条回复`
              : '等待任务…',
        ),
        createElement(
          'button',
          {
            className: 'webin-btn',
            key: 'd',
            disabled: !ready,
            onClick: () => {
              const el = hostRef.current?.querySelector('webview') as GuestElement | null
              if (el === null) return
              void el
                .executeJavaScript(buildDiagnoseScript(sendHintsFor(provider)))
                .then((raw) => {
                  const text = String(raw)
                  setDiagnosis(text)
                  console.log('[dsh-webin] 页面结构诊断', text)
                })
                .catch((e) => setDiagnosis(`诊断失败：${String(e)}`))
            },
          },
          '诊断',
        ),
        createElement(
          'button',
          {
            className: 'webin-btn',
            key: 'r',
            disabled: !ready,
            onClick: () => {
              const el = hostRef.current?.querySelector('webview') as GuestElement | null
              el?.reload()
            },
          },
          '刷新',
        ),
      ]),
      // webview 的挂载容器：React 只渲染这个空 div，guest 由 effect 里 appendChild 放进来。
      // ⚠️ 必须始终存在于树里（即使还没 ready）—— 容器一旦被 React 卸载重建，
      // 里面 appendChild 进去的 webview 会跟着消失。
      createElement('div', { className: 'webin-guest', key: 'guest', ref: guestRef }),
      ready
        ? null
        : createElement('div', { className: 'webin-note', key: 'n' }, status),
      diagnosis === ''
        ? null
        : createElement('div', { className: 'webin-capture', key: 'diag' }, `【页面结构】${diagnosis.slice(0, 1200)}`),
      lastReply === ''
        ? null
        : createElement(
            'div',
            { className: 'webin-capture', key: 'cap' },
            `【最后一条抓取】${lastReply.slice(0, 400)}${lastReply.length > 400 ? '…' : ''}`,
          ),
    ],
  )
}

/**
 * LDW **占位符**：留在 `conversation.view` 里（就是用户要的那个红框位置）。
 *
 * 它自己不含 webview —— 只负责量出自己的矩形并广播给常驻宿主。
 * 组件被卸载（切标签）时把矩形置 null，宿主随即移出视口，**但 guest 不受影响**。
 */
export function LdwPlaceholder(): unknown {
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const el = ref.current
    if (el === null) return

    /**
     * 量矩形。用 rAF 节流 —— 布局变化（侧栏折叠、窗口缩放、标签切换）都会触发。
     * 注意：占位符消失时 `getBoundingClientRect()` 仍可能返回旧值，
     * 所以卸载路径显式 `publishRect(null)`。
     */
    let frame = 0
    const measure = () => {
      frame = 0
      const node = ref.current
      if (node === null) return
      const r = node.getBoundingClientRect()
      publishRect({
        left: r.left,
        top: r.top,
        width: r.width,
        height: r.height,
        visible: r.width > 0 && r.height > 0,
      })
    }
    const schedule = () => {
      if (frame !== 0) return
      frame = window.requestAnimationFrame(measure)
    }

    measure()
    window.addEventListener('resize', schedule)
    const observer = new ResizeObserver(schedule)
    observer.observe(el)

    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame)
      window.removeEventListener('resize', schedule)
      observer.disconnect()
      // 切走 / 换 Session → 宿主移出视口，但 guest 保持存活
      publishRect(null)
    }
  }, [])

  return createElement('div', { className: 'webin-placeholder', ref })
}

export function apply(ctx: {
  effect(cb: () => unknown, label?: string): void
  slots: {
    inject(key: string, cb: () => unknown): void
    register(options: Record<string, unknown>, component: unknown): unknown
  }
}): void {
  // 样式表随插件生命周期注入 / 卸载
  ctx.effect(() => {
    const style = document.createElement('style')
    style.textContent = CSS
    document.head.appendChild(style)
    return () => style.remove()
  }, 'dsh-webin: stylesheet')

  // ---- 常驻宿主：shell.overlay（root scope，不随标签 / Session 卸载）----
  ctx.effect(
    () =>
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          {
            name: 'shell.overlay',
            id: 'ldw-host',
            order: 20,
          },
          LdwHost,
        ),
      ),
    'dsh-webin: persistent host',
  )

  // ---- 占位符：conversation.view（用户要的红框位置）----
  ctx.effect(
    () =>
      ctx.slots.inject('conversation.view', () =>
        ctx.slots.register(
          {
            name: 'conversation.view',
            id: 'ldw',
            order: 20, // chat=0, trajectory=10 → LDW 排第三
            label: () => 'LDW',
          },
          LdwPlaceholder,
        ),
      ),
    'dsh-webin: conversation view',
  )
}
