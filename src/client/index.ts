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
  buildScrollScript,
  buildDeepSeekHook,
  buildDrainScript,
  buildProbeScript,
  buildRestoreScript,
  buildScrapeScript,
  buildSnapshotScript,
  loadSnapshot,
  saveSnapshot,
} from './hook'
/**
 * 导出页面真实结构 —— 用来**发现**类名，而不是猜。
 *
 * ⚠️ 必须真的**调用**它（见下面诊断按钮里的用法），否则打包器会
 * tree-shake 掉 —— 只在源码里 import 是不够的（踩过：import 了
 * 但产物里搜不到）。
 */
import { buildDomReportScript } from './dom-report'
import {
  buildClearInputScript,
  buildContinueScript,
  buildDiagnoseScript,
  buildFillScript,
  buildStopScript,
  buildThinkingScript,
  buildTriggerScript,
  pickSendDelay,
} from './chat'
import { DEFAULT_PROVIDER_ID, ProviderRegistry, type Provider } from '../shared/providers'
import { DEFAULT_CONFIG, describeConfig, LIMITS, type WebinConfig } from '../shared/config'
import { snapshotLooksLoggedIn } from '../shared/auth-snapshot'
import { currentVersion, formatBuiltAt } from '../shared/version'

/**
 * 平台注册表（模块级单例）。
 *
 * 内置表打底；用户自定义 provider 由 host 半从 `~/.dsh/webin/providers/` 读出后，
 * 通过 `applyCustomProviders()` 灌进来。**放在模块级**是因为面板组件会被
 * 反复挂载/卸载（切标签），注册表不该跟着重建。
 */
const registryRef = { current: new ProviderRegistry() }

/**
 * 当前配置（模块级缓存）。
 *
 * ## 为什么放模块级 + 定期刷新
 *
 * 配置是用户在**设置页**改的，而设置页与对话区是两个独立挂载点。
 * 发送循环在 `LdwHost` 里，改完配置它不会自动知道 —— 所以：
 *   1. 启动时拉一次
 *   2. 发送前用缓存值（不能每轮都 fetch，那会给 host 添无谓请求）
 *   3. 设置页保存后**主动刷新**（`refreshConfig()`），不必等轮询
 *
 * 不放进 React state 是因为发送循环不在组件渲染路径上 —— 它是个
 * `setInterval` 里的闭包，读 state 会拿到旧值（闭包捕获）。
 */
let configRef: WebinConfig = { ...DEFAULT_CONFIG }

/** 拉一次配置（启动时 + 设置页保存后）。失败则保留旧值。 */
export async function refreshConfig(): Promise<WebinConfig> {
  try {
    const res = await fetch('/dsh-webin/api/config')
    const data = (await res.json()) as { config?: Partial<WebinConfig> }
    if (data.config !== undefined) {
      configRef = { ...DEFAULT_CONFIG, ...data.config }
    }
  } catch {
    /* 拉不到就用现有值（默认值兜底），不影响功能 */
  }
  return configRef
}

/** 读当前配置（同步，给发送循环用）。 */
export function currentConfig(): WebinConfig {
  return configRef
}

/**
 * 长休状态：连续请求计数。
 *
 * 参考实现有「长休阀门」，本插件默认关闭（`longBreakAfter: 0`），
 * 但用户可以在设置页打开 —— 工具循环连跑十几轮时能压低请求密度。
 */
let requestStreak = 0

/** 一次请求结束后调用；返回需要休息的毫秒数（0 = 不用休息）。 */
export function noteRequestDone(): number {
  const cfg = configRef
  if (cfg.longBreakAfter <= 0) return 0
  requestStreak += 1
  if (requestStreak < cfg.longBreakAfter) return 0
  requestStreak = 0
  return pickSendDelay(cfg.longBreakMinMs, cfg.longBreakMaxMs)
}

/** 单轮请求计数（`maxRequestsPerTurn > 0` 时生效）。 */
let turnRequests = 0
let turnKey = ''

/** 新的一轮开始（换 job 时调）。 */
export function noteTurnStart(jobId: string): void {
  if (turnKey !== jobId) {
    turnKey = jobId
    turnRequests = 0
  }
}

/** 本轮还能不能再发请求。 */
export function canSendThisTurn(): boolean {
  const cfg = configRef
  if (cfg.maxRequestsPerTurn <= 0) return true
  return turnRequests < cfg.maxRequestsPerTurn
}

/** 记一次本轮请求。 */
export function noteTurnRequest(): void {
  turnRequests += 1
}

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
  completionPath?: string
} {
  return {
    inputSelectors: p.input.selectors ?? [],
    sendSelectors: p.send.selectors ?? [],
    /** 只用于诊断展示（端点改版时对比「期望 vs 实际」）。 */
    completionPath: p.completionPath,
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

/**
 * ## 带超时护栏的 `executeJavaScript`
 *
 * ## 为什么必须有这个（用户实测踩到的死锁）
 *
 * 用户症状：「一直深度求索中，网页版早就有回复和思考内容了，但就是不输出」。
 *
 * 排查发现状态栏那行的 `how` 字段**还是「思考模式未切换」那条消息**，
 * 而不是发送方式 —— 说明发送之后的 `setLastSend` **从未执行**。
 * 也就是说这一句永远没有 settle：
 *
 *     const raw = await el.executeJavaScript(buildSendScript(...))
 *
 * ## 为什么会永不 settle
 *
 * `executeJavaScript` 是**跨进程**调用（渲染进程 ← → 主进程）。
 * 页面一旦**导航**（`location` 变了、或者 SPA 做了硬跳转），
 * 旧的 JS 上下文就被销毁，挂在里面的 Promise **静默死掉** ——
 * 不 resolve、不 reject、不抛错。宿主这边就永远等下去。
 *
 * 这解释了全部四个症状：
 *   1. `setLastSend` 没执行（await 卡住）⇒ 状态栏还是思考那条消息
 *   2. `busy` 永远为 true ⇒ 整个 `tick` 循环冻死 ⇒ DSH 一直等
 *   3. 注入的 hook 随导航一起被销毁 ⇒ 「收到 0 条」
 *   4. 网页版自己跑完了（那是新上下文里的事，我们既没看到也没收到）
 *
 * ## 为什么用 Promise.race 而不是给 `executeJavaScript` 传超时
 *
 * DSH 的 guest 桥只暴露 `executeJavaScript(code): Promise<unknown>`，
 * 没有超时参数（实测查过）。所以只能在**外部**赛跑：
 * 超时就认输，宁可报一个明确的超时错误，也不要静默卡死。
 *
 * @param el - guest 元素
 * @param code - 要执行的脚本
 * @param timeoutMs - 超时（默认 30s）；超时 resolve 成 sentinel 而不是 reject
 * @returns 脚本结果；超时返回 {@link EXEC_TIMEOUT}
 */
export const EXEC_TIMEOUT = Symbol('dsh-webin:exec-timeout')

/**
 * 判定「回复生成完了」所需的**静默时长**（毫秒）。
 *
 * ## 为什么需要它（审计发现的缺陷）
 *
 * 早期只用「这次读到的内容 == 上次读到的」就交付。但流式输出**可能暂停**
 * （网络抖动、服务端排队），暂停期间两次读到同样的半截内容 ⇒
 * **把半截回复交回 DSH**，用户看到回复被截断，而且 DSH 认为这轮已结束。
 *
 * 加上「静默够久」这个条件后，只有内容真的不再增长才交付。
 *
 * 3000ms 的取值：DeepSeek 的流式增量间隔通常在几百毫秒内，
 * 3 秒静默足以区分「暂停」和「结束」，又不会让用户等太久。
 */
const STABLE_MS = 3_000

/**
 * ## 带超时的 `fetch`（**所有对 host 的请求都必须走这里**）
 *
 * ## 为什么（审计发现的真实风险）
 *
 * 发送循环里有 8 处 `await fetch('/dsh-webin/api/job/.../result')`。
 * 裸 `fetch` **没有超时** —— 如果 host 卡住（事件循环被占、
 * 正在写大文件、或者干脆挂了），这个 `await` 会永远挂着，
 * 而 `busy` 已经是 `true` ⇒ **整个发送循环永久停摆**。
 *
 * 用户会看到的现象和「一直深度求索中」一样：什么都不发生，
 * 且没有任何报错（因为没有异常可捕获）。
 *
 * 这里的超时**只保护「等响应」这一段**，不取消请求本身
 * （请求可能已经到达 host 并被处理，取消反而会造成状态不一致）。
 * 超时后返回 `undefined`，调用方按「交结果可能没成功」继续 ——
 * 关键是**循环要能继续转**。
 *
 * @param input - 请求 URL
 * @param init - fetch 选项
 * @param timeoutMs - 超时（默认 15s）
 * @returns 响应；超时/失败返回 undefined（**不抛错**）
 */
function fetchJson(input: string, init?: RequestInit, timeoutMs = 15_000): Promise<Response | undefined> {
  return new Promise((resolve) => {
    let settled = false
    const timer = window.setTimeout(() => {
      if (settled) return
      settled = true
      console.warn(`[dsh-webin] fetch 超时 ${timeoutMs}ms: ${input}`)
      resolve(undefined)
    }, timeoutMs)
    fetch(input, init).then(
      (res) => {
        if (settled) return
        settled = true
        window.clearTimeout(timer)
        resolve(res)
      },
      (error) => {
        if (settled) return
        settled = true
        window.clearTimeout(timer)
        console.warn(`[dsh-webin] fetch 失败: ${input}`, error)
        resolve(undefined)
      },
    )
  })
}

/**
 * 探测 hook 是否**仍在本页面**。
 *
 * 判据是 hook 自己写的标记（与 `hook.ts` 的 `MARKER` 必须一致）。
 * 新文档里那个标记**必然**不存在，所以这个探测能可靠地发现导航。
 *
 * @returns 返回 `'true'` / `'false'` 字符串（`executeJavaScript` 的返回值）
 */
const MARKER_CHECK = `(function () {
  try { return window.__dshWebinHookInstalled__ === true ? 'true' : 'false'; }
  catch (e) { return 'false'; }
})();`

function execJs<T = unknown>(el: GuestElement, code: string, timeoutMs = 30_000): Promise<T | typeof EXEC_TIMEOUT> {
  return new Promise((resolve) => {
    let settled = false
    const timer = window.setTimeout(() => {
      if (settled) return
      settled = true
      console.warn(`[dsh-webin] executeJavaScript 超时 ${timeoutMs}ms（页面可能已导航）`)
      resolve(EXEC_TIMEOUT)
    }, timeoutMs)

    el.executeJavaScript(code).then(
      (value) => {
        if (settled) return
        settled = true
        window.clearTimeout(timer)
        resolve(value as T)
      },
      (error) => {
        if (settled) return
        settled = true
        window.clearTimeout(timer)
        /**
         * ⚠️ 失败也走 resolve（用 sentinel）而不是 reject ——
         * 调用方几乎都是「拿到字符串就 JSON.parse」，抛出去会被
         * 外层 catch 吞掉，反而不如让它们显式处理 sentinel。
         */
        console.warn('[dsh-webin] executeJavaScript 失败', error)
        resolve(EXEC_TIMEOUT)
      },
    )
  })
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
.webin-title{font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-secondary);white-space:nowrap}
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
/* 未就绪提示：盖在 guest 区域上（跳过 38px 工具栏）。
   ⚠️ **必须 pointer-events:none** —— 用户实测报过「点开 LDW 会卡在这个界面
   点不了，只能等『真实浏览器已就绪』」：这层原本会吃掉鼠标事件，
   而启动阶段（loadURL + 快照读取 + 登录态回写）最长要几十秒，
   那段时间里登录表单/二维码全都点不动。
   提示文字只是状态说明，**不该拦住底下的页面**。 */
.webin-note{position:absolute;left:0;right:0;bottom:0;top:38px;display:flex;align-items:center;
  justify-content:center;padding:24px;text-align:center;white-space:pre-wrap;pointer-events:none;
  font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-tertiary)}
.webin-capture{flex:none;max-height:120px;overflow:auto;padding:6px 8px;box-sizing:border-box;
  border-top:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);
  font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary);white-space:pre-wrap}
/* 次要入口（已登录时的「打开」）—— 刻意做得像链接而不是按钮：
   它是「想进去看看」的旁路，不是「待办事项」。
   用户报过「不要显示『打开浏览器』而是显示『已登录』」——
   主视觉必须是状态标签，这个只能是弱化的小入口。 */
.ldw-linkbtn{border:0;background:none;padding:2px 4px;cursor:pointer;
  font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-quaternary);text-decoration:underline;
  text-underline-offset:2px;text-decoration-color:color-mix(in srgb,currentColor 40%,transparent)}
.ldw-linkbtn:hover{color:var(--dsw-alias-label-secondary)}
.webin-badge-on,.webin-badge-off{flex:none;padding:1px 6px;border-radius:var(--dsw-radius-sm);
  font:var(--dsw-font-xxxs-11);white-space:nowrap}
.webin-badge-on{color:var(--dsw-alias-state-success-primary);
  background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent)}
.webin-badge-off{color:var(--dsw-alias-label-quaternary);
  background:var(--dsw-alias-bg-layer-2)}

/* ══════════════════════════════════════════════════════════════════════
   LDW 设置页 · 视觉系统
   ──────────────────────────────────────────────────────────────────────
   令牌：所有色值取自宿主 --dsw-alias-* 变量，昼夜由宿主切换，本页不写死颜色。
   层级：layer-3 凹槽/页面底 · layer-2 面板 · layer-1 浮起元素。
   动效：transform/opacity 优先；常规 150–300ms、覆盖层 300–400ms。
   ══════════════════════════════════════════════════════════════════════ */
.ldw-set{--ease-instrument:cubic-bezier(.16,1,.3,1);--ease-settle:cubic-bezier(.34,1.4,.4,1);
  display:flex;flex-direction:column;gap:20px;max-width:1080px;font-size:13px;line-height:1.55;
  color:var(--dsw-alias-label-primary);-webkit-font-smoothing:antialiased}
.ldw-set *{box-sizing:border-box}
.ldw-set ::selection{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 24%,transparent)}
/* 键盘可达性：只给键盘聚焦画环，鼠标点击不出现 */
.ldw-set :focus-visible{outline:2px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 78%,transparent);
  outline-offset:2px;box-shadow:0 0 0 4px color-mix(in srgb,var(--dsw-alias-state-business-primary) 13%,transparent)}

/* ══ 页头 hero ═══════════════════════════════════════════════════════ */
.ldw-hero{position:relative;display:flex;flex-direction:column;gap:14px;padding:22px 24px;border-radius:20px;
  border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2) 78%,transparent);
  background:linear-gradient(165deg,color-mix(in srgb,var(--dsw-alias-bg-layer-3) 88%,transparent),
    color-mix(in srgb,var(--dsw-alias-bg-layer-1) 82%,transparent));overflow:hidden}
.ldw-hero::before{content:"";position:absolute;inset:0;pointer-events:none;
  background:radial-gradient(120% 150% at 12% -20%,color-mix(in srgb,var(--dsw-alias-state-business-primary) 13%,transparent),transparent 58%),
    radial-gradient(90% 120% at 88% 130%,color-mix(in srgb,var(--dsw-alias-state-success-primary) 7%,transparent),transparent 60%)}
.ldw-hero>*{position:relative}
.ldw-pagehead{display:flex;align-items:flex-end;gap:14px;flex-wrap:wrap}
.ldw-pagetitle{display:flex;flex-direction:column;gap:6px;min-width:0}
.ldw-pagetitle h2{margin:0;font-size:23px;font-weight:760;letter-spacing:-.6px;line-height:1.2;
  background:linear-gradient(120deg,var(--dsw-alias-label-primary) 20%,
    color-mix(in srgb,var(--dsw-alias-label-primary) 55%,var(--dsw-alias-state-business-primary)));
  -webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
.ldw-pagesub{margin:0;font-size:12.5px;color:var(--dsw-alias-label-secondary);max-width:70ch}
.ldw-pills{display:flex;gap:6px;flex-wrap:wrap;margin-left:auto}
.ldw-pill{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;
  border:1px solid var(--dsw-alias-border-l1);
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 78%,transparent);
  box-shadow:inset 0 1px 0 rgb(255 255 255 / 4%);font-size:11.5px;
  color:var(--dsw-alias-label-secondary);white-space:nowrap;
  transition:border-color .16s ease,color .16s ease}
.ldw-pill.strong{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
.ldw-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-tertiary);flex:none}
@keyframes ldw-dot-breathe{0%,100%{opacity:1}50%{opacity:.55}}
.ldw-dot.ok{background:var(--dsw-alias-state-success-primary);
  box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-success-primary) 18%,transparent);
  animation:ldw-dot-breathe 2.6s ease-in-out infinite}
.ldw-dot.warn{background:var(--dsw-alias-state-warn-primary);
  box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-warn-primary) 18%,transparent)}
.ldw-dot.err{background:var(--dsw-alias-state-error-primary);
  box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-error-primary) 18%,transparent)}

/* ══ 区块与分节 ══════════════════════════════════════════════════════ */
.ldw-sec{display:flex;flex-direction:column;gap:10px}
.ldw-sechead{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;padding-bottom:6px;
  border-bottom:1px solid var(--dsw-alias-border-l1)}
.ldw-sec-title{font-size:14px;font-weight:680;letter-spacing:-.2px}
.ldw-sec-hint{font-size:11.5px;color:var(--dsw-alias-label-tertiary);margin-left:auto}
.ldw-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(252px,1fr));gap:10px}

/* ══ 卡片（双层 bezel：hairline 边框 + 顶部内高光 + 柔和外阴影）═════ */
.ldw-card{position:relative;display:flex;flex-direction:column;gap:8px;padding:12px 13px;border-radius:13px;
  border:1px solid var(--dsw-alias-border-l2);
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 80%,transparent);
  box-shadow:inset 0 1px 0 rgb(255 255 255 / 6%),
    0 1px 2px color-mix(in srgb,var(--dsw-alias-state-business-primary) 7%,transparent),
    0 3px 10px color-mix(in srgb,var(--dsw-alias-state-business-primary) 4%,transparent);
  transition:transform .2s cubic-bezier(.32,.72,0,1),box-shadow .24s ease,border-color .18s ease}
.ldw-card:hover{transform:translateY(-2px);
  border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 66%,var(--dsw-alias-border-l2));
  box-shadow:inset 0 1px 0 rgb(255 255 255 / 9%),
    0 16px 34px color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent)}
.ldw-card-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ldw-card-name{font-size:13.5px;font-weight:640;letter-spacing:-.15px}
.ldw-card-id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;
  color:var(--dsw-alias-label-quaternary)}

/* ══ 面板（浮起容器）══════════════════════════════════════════════════ */
.ldw-panel{padding:16px;border-radius:16px;border:1px solid var(--dsw-alias-border-l2);
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 82%,transparent);
  box-shadow:inset 0 1px 0 rgb(255 255 255 / 5%),0 2px 6px rgb(0 0 0 / 4%);
  display:flex;flex-direction:column;gap:12px}
.ldw-glass{background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 68%,transparent);
  backdrop-filter:blur(16px) saturate(150%);-webkit-backdrop-filter:blur(16px) saturate(150%);
  border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2) 78%,transparent);
  box-shadow:inset 0 1px 0 rgb(255 255 255 / 6%),0 12px 34px rgb(0 0 0 / 9%)}

/* ══ 键值行 ══════════════════════════════════════════════════════════ */
.ldw-rows{display:flex;flex-direction:column;gap:4px}
.ldw-row{display:flex;gap:8px;font-size:12px;line-height:1.5;align-items:baseline}
.ldw-row-label{flex:none;min-width:56px;color:var(--dsw-alias-label-quaternary)}
.ldw-row-value{color:var(--dsw-alias-label-secondary);word-break:break-all;min-width:0}

/* ══ 表单控件 ════════════════════════════════════════════════════════ */
.ldw-field{display:flex;flex-direction:column;gap:4px;min-width:120px}
.ldw-field-inline{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.ldw-field-label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.ldw-input{font:inherit;font-size:12px;padding:6px 10px;border-radius:9px;
  border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);
  box-shadow:inset 0 1px 2px rgb(0 0 0 / 5%);color:var(--dsw-alias-label-primary);
  min-width:0;width:100%;transition:border-color .16s ease,box-shadow .16s ease}
.ldw-input:focus{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 62%,var(--dsw-alias-border-l2));
  box-shadow:inset 0 1px 2px rgb(0 0 0 / 5%),0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-business-primary) 14%,transparent)}
.ldw-num{width:96px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;
  padding:5px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-bg-layer-1);box-shadow:inset 0 1px 2px rgb(0 0 0 / 5%);
  color:var(--dsw-alias-label-primary);transition:border-color .16s ease,box-shadow .16s ease}
.ldw-num:focus{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 62%,var(--dsw-alias-border-l2));
  box-shadow:inset 0 1px 2px rgb(0 0 0 / 5%),0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-business-primary) 14%,transparent)}
.ldw-unit{flex:none;font-size:11px;color:var(--dsw-alias-label-quaternary);min-width:22px}
.ldw-note{font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:1.5;margin:0}
.ldw-textarea{font:inherit;font-size:11.5px;padding:10px;border-radius:11px;resize:vertical;
  border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);
  box-shadow:inset 0 1px 2px rgb(0 0 0 / 5%);color:var(--dsw-alias-label-primary);width:100%;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;line-height:1.6;
  transition:border-color .16s ease,box-shadow .16s ease}
.ldw-textarea:focus{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 62%,var(--dsw-alias-border-l2));
  box-shadow:inset 0 1px 2px rgb(0 0 0 / 5%),0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-business-primary) 14%,transparent)}

/* ══ 开关（role=switch，圆点带弹性位移）═════════════════════════════ */
.ldw-switch{display:inline-flex;align-items:center;gap:9px;cursor:pointer;user-select:none;
  -webkit-tap-highlight-color:transparent;background:none;border:none;padding:0;
  font:inherit;color:inherit;text-align:left}
.ldw-switch>i{width:36px;height:20px;border-radius:999px;background:var(--dsw-alias-bg-layer-1);
  border:1px solid var(--dsw-alias-border-l2);box-shadow:inset 0 1px 3px rgb(0 0 0 / 8%);
  position:relative;transition:background .2s ease,border-color .2s ease,box-shadow .2s ease;flex:none}
.ldw-switch:hover>i{filter:brightness(1.05)}
.ldw-switch[aria-checked="true"]:hover>i{filter:brightness(1.08)}
.ldw-switch>i::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;
  background:var(--dsw-alias-label-secondary);box-shadow:0 1px 3px rgb(0 0 0 / 22%);
  transition:transform .26s cubic-bezier(.34,1.3,.64,1),background .2s ease,width .16s ease}
.ldw-switch:active>i::after{width:17px}
.ldw-switch[aria-checked="true"]>i{background:var(--dsw-alias-state-business-primary);
  border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 85%,#000);
  box-shadow:inset 0 1px 3px rgb(0 0 0 / 12%)}
.ldw-switch[aria-checked="true"]>i::after{transform:translateX(16px);background:#fff}
.ldw-switch[aria-checked="true"]:active>i::after{transform:translateX(13px)}
.ldw-switch:focus-visible>i{box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-business-primary) 22%,transparent)}
.ldw-switch:disabled{opacity:.45;cursor:default}

/* ══ 按钮 ════════════════════════════════════════════════════════════ */
.ldw-btn{font:inherit;font-size:12px;font-weight:580;padding:6px 14px;border-radius:9px;
  border:1px solid var(--dsw-alias-border-l2);
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 84%,transparent);
  box-shadow:inset 0 1px 0 rgb(255 255 255 / 5%),0 1px 2px rgb(0 0 0 / 6%);
  color:var(--dsw-alias-label-primary);cursor:pointer;
  transition:transform .18s var(--ease-instrument),border-color .2s var(--ease-instrument),
    background .2s var(--ease-instrument),box-shadow .22s var(--ease-instrument),opacity .16s ease}
.ldw-btn:hover:not(:disabled){border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 62%,var(--dsw-alias-border-l2));
  background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 7%,var(--dsw-alias-bg-layer-3));
  transform:translateY(-1px);box-shadow:inset 0 1px 0 rgb(255 255 255 / 7%),0 3px 8px rgb(0 0 0 / 9%)}
.ldw-btn:active:not(:disabled){transform:translateY(0)}
.ldw-btn.primary{background:linear-gradient(180deg,
    color-mix(in srgb,var(--dsw-alias-state-business-primary) 88%,#fff),
    var(--dsw-alias-state-business-primary));
  border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 82%,#000);
  color:var(--dsw-alias-label-primary-inverted,#fff);
  box-shadow:inset 0 1px 0 rgb(255 255 255 / 18%),
    0 2px 8px color-mix(in srgb,var(--dsw-alias-state-business-primary) 32%,transparent)}
.ldw-btn.danger:hover:not(:disabled){border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 62%,var(--dsw-alias-border-l2));
  background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 9%,var(--dsw-alias-bg-layer-3))}
.ldw-btn:disabled{opacity:.45;cursor:default;box-shadow:none;transform:none}
.ldw-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}

/* ══ 折叠区 ══════════════════════════════════════════════════════════ */
.ldw-details{border:1px solid var(--dsw-alias-border-l2);border-radius:14px;padding:0;
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 72%,transparent);overflow:hidden}
.ldw-details>summary{cursor:pointer;list-style:none;padding:13px 16px;
  display:flex;align-items:center;gap:9px;font-size:13px;font-weight:620;
  transition:background .16s ease}
.ldw-details>summary:hover{background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 52%,transparent)}
.ldw-details>summary::-webkit-details-marker{display:none}
.ldw-details>summary::before{content:"";width:0;height:0;flex:none;
  border-left:5px solid var(--dsw-alias-label-tertiary);
  border-top:4px solid transparent;border-bottom:4px solid transparent;
  transition:transform .22s var(--ease-instrument)}
.ldw-details[open]>summary::before{transform:rotate(90deg)}
.ldw-details-body{padding:0 16px 16px;display:flex;flex-direction:column;gap:14px}

/* ══ 配置分组 ════════════════════════════════════════════════════════ */
.ldw-group{display:flex;flex-direction:column;gap:9px}
.ldw-group-title{margin:0;font-size:12.5px;font-weight:640;letter-spacing:-.1px;
  display:flex;align-items:center;gap:7px}
.ldw-group-title::before{content:"";width:3px;height:12px;border-radius:2px;flex:none;
  background:var(--dsw-alias-state-business-primary)}
.ldw-fieldrow{display:grid;grid-template-columns:minmax(150px,1.1fr) auto 1fr;gap:10px;
  align-items:center;padding:5px 0}
.ldw-fieldrow .ldw-hint{font-size:11px;color:var(--dsw-alias-label-quaternary);line-height:1.45}

/* ══ 提示条 ══════════════════════════════════════════════════════════ */
.ldw-callout{display:flex;gap:9px;padding:10px 12px;border-radius:11px;
  border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary) 34%,transparent);
  background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 9%,transparent);
  font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-secondary)}
.ldw-callout.err{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 34%,transparent);
  background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 9%,transparent)}
.ldw-callout strong{color:var(--dsw-alias-label-primary);font-weight:620}
.ldw-callout ul{margin:5px 0 0;padding-left:18px}
.ldw-callout li{margin:2px 0}

/* ══ 标签（自定义 / 状态）════════════════════════════════════════════ */
.ldw-tag{padding:2px 8px;border-radius:999px;font-size:10.5px;font-weight:560;white-space:nowrap;
  border:1px solid var(--dsw-alias-border-l1);
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 72%,transparent);
  color:var(--dsw-alias-label-tertiary)}
.ldw-tag.ok{color:var(--dsw-alias-state-success-primary);
  border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 38%,transparent);
  background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 11%,transparent)}
.ldw-tag.warn{color:var(--dsw-alias-state-warn-primary);
  border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 38%,transparent);
  background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 11%,transparent)}

/* ══ 骨架屏（首次读取时的 shimmer）══════════════════════════════════ */
@keyframes ldw-shimmer{0%{opacity:.45}50%{opacity:.85}100%{opacity:.45}}
.ldw-skeleton{animation:ldw-shimmer 1.5s ease-in-out infinite;border-radius:8px;
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 70%,transparent);height:13px}

/* ══ 版本行（hero 内第二行）═════════════════════════════════════════ */
.ldw-verline{display:flex;align-items:center;gap:9px;flex-wrap:wrap;
  padding-top:12px;border-top:1px solid var(--dsw-alias-border-l1)}
.ldw-ver{display:inline-flex;align-items:baseline;gap:6px}
.ldw-ver-num{font-size:12.5px;font-weight:640;color:var(--dsw-alias-label-primary);letter-spacing:-.15px}
/* 构建时间 —— 比提交号直观：pull 后忘了 build 时一眼能看出偏旧。 */
.ldw-ver-when{font-size:10.5px;color:var(--dsw-alias-label-quaternary)}
.ldw-ver-commit{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;
  padding:1px 6px;border-radius:6px;color:var(--dsw-alias-label-tertiary);
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 72%,transparent);
  border:1px solid var(--dsw-alias-border-l1)}
.ldw-ver-note{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-left:auto}
/* Star 按钮：默认低调，hover 才亮出星色 —— 是邀请，不是催促 */
.ldw-star{display:inline-flex;align-items:center;gap:6px;text-decoration:none}
.ldw-star-icon{width:13px;height:13px;flex:none;fill:var(--dsw-alias-label-tertiary);
  transition:fill .2s ease,transform .24s cubic-bezier(.34,1.4,.4,1)}
.ldw-star:hover .ldw-star-icon{fill:var(--dsw-alias-state-warn-primary);
  transform:rotate(-12deg) scale(1.12)}
.ldw-updcmd{margin:6px 0 4px;padding:6px 9px;border-radius:8px;
  background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;
  color:var(--dsw-alias-label-secondary);overflow-x:auto;white-space:pre}

/* ══ 登录行（设置页「登录」区）══════════════════════════════════════ */
.ldw-loginrow{display:flex;align-items:center;gap:9px;flex-wrap:wrap;
  padding:9px 11px;border-radius:11px;
  border:1px solid var(--dsw-alias-border-l1);
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 52%,transparent);
  transition:border-color .18s ease,background .18s ease}
.ldw-loginrow:hover{border-color:var(--dsw-alias-border-l2);
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 74%,transparent)}
.ldw-loginrow-name{font-size:12.5px;font-weight:600;
  color:var(--dsw-alias-label-primary);white-space:nowrap}

/* ══════════════════════════════════════════════════════════════════════
   输入框左侧的 LDW 入口（conversation.input.left）
   ──────────────────────────────────────────────────────────────────────
   与工具栏里其它紧凑控件同高同圆角，不抢视线；未登录时才用警示色，
   登录后就是一粒安静的绿点 —— 状态用颜色说话，不靠文字喊。
   ══════════════════════════════════════════════════════════════════════ */
.ldw-entry{display:inline-flex;align-items:center;gap:6px;flex:none;
  height:26px;padding:0 9px;border-radius:8px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l1);
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 62%,transparent);
  font:inherit;font-size:11.5px;color:var(--dsw-alias-label-secondary);
  white-space:nowrap;
  transition:border-color .18s ease,background .18s ease,color .18s ease,transform .16s ease}
.ldw-entry:hover{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 52%,var(--dsw-alias-border-l2));
  background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 8%,var(--dsw-alias-bg-layer-2));
  color:var(--dsw-alias-label-primary);transform:translateY(-1px)}
.ldw-entry:active{transform:translateY(0)}
.ldw-entry:focus-visible{outline:2px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 78%,transparent);
  outline-offset:2px}
/* 未登录时整体偏警示色 —— 一眼看出「这里需要你做点什么」 */
.ldw-entry:has(.ldw-dot.warn){border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 42%,transparent);
  color:var(--dsw-alias-state-warn-primary)}
.ldw-entry-note{margin-left:4px;font-size:10.5px;color:var(--dsw-alias-label-quaternary)}
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

/**
 * 当前窗口挂在哪个 DSH 会话上。
 *
 * ## 谁写入
 *
 * `LdwPlaceholder`（挂在 `conversation.view` 上）从 props 拿到 DSH 给的
 * `sessionId` 后写进来并上报 host。
 *
 * ## 谁读
 *
 * 发送循环领活时带上它（`?session=<id>`）—— host 据此只派发属于本窗口的
 * 任务。没有它就会「所有窗口都生效」（用户实测报过）。
 *
 * ⚠️ 是模块级而不是 state：发送循环跑在 `setInterval` 里，读 state 会拿到
 * 闭包里的旧值。ref 语义更合适。
 */
const sessionIdRef: { current: string } = { current: '' }

/** 「props 已经打过日志了吗」—— 只打一次，不刷屏。 */
let propsLogged = false

/**
 * 最近一次 DOM 抓取的诊断信息（跟着心跳上报给 host）。
 *
 * ## 为什么需要（用户：「不要猜」）
 *
 * 端到端测试抓到侧边栏而不是回复时，我**看不到**抓取脚本内部
 * 选了什么容器、命中哪个 selector、主内容区定位到哪 —— 只能
 * 改代码→重启→再看，一轮一轮猜。
 *
 * 把这几项挂上去，`/status` 就能直接看到，不用猜。
 */
/**
 * 页面结构报告 —— 抓取失败时**自动**导出一次（不需要用户点按钮）。
 *
 * ## 为什么需要
 *
 * trace 显示**所有候选都命中 0 个** —— 说明类名表整个是错的。
 * 要修就得先看到**真实页面结构**，而等用户点诊断按钮太慢。
 *
 * 所以抓取走到 `longest-div` 兜底时自动导一次，跟着心跳上报：
 *   - `chain`：含回复文字的元素祖先链 ⇒ 回复容器就在这条链上
 *   - `topClasses`：出现 >= 2 次的类名频次
 *   - `cands`：各候选选择器实际命中几个
 *
 * 只抓一次 —— 不给页面加持续负担。
 */
const domReportRef: { current: Record<string, unknown> | undefined } = { current: undefined }

/**
 * ## 面板加载时的产物 rev（自动重载判据 v2）
 *
 * ## ⚠️ v1 判据（builtAt vs mtime）造成**每 2 秒无限重载**，已废弃
 *
 * v1 让面板上报烘死的 `clientBuiltAt`，host 比 `mtime` —— 但 builtAt
 * 在构建开始算、client.js 在构建末尾写盘，机器稍慢差值就超容差
 * ⇒ **永远判定落后** ⇒ 每次心跳都 reload ⇒ 死循环（群友实测每 2 秒一次，
 * 甚至拖崩 DSH 桌面端 —— 用户拿这个问题去找了别的 agent）。
 *
 * ## v2：只比「rev 变没变」—— 自收敛
 *
 * 第一次心跳把 host 回的 `bundleRev` 记下来（= 我加载时是哪个版本）；
 * 之后 rev **变了** ⇒ 真的出了新构建 ⇒ 才 reload。reload 后拿到的
 * 就是新 bundle ⇒ 记下的 rev 更新 ⇒ 停止。
 *
 * **不需要任何持久化**：模块级变量在 reload 后随模块重建，正好重置。
 */
const loadedBundleRev: { current: string | null } = { current: null }

/**
 * 当前任务的提示词 —— 诊断时用它做 needle。
 *
 * ## 为什么需要（用户的关键观察）
 *
 * 用户指出：「网页版都是一个字一个字蹦出来的」—— 回复是**流式逐字渲染**。
 * 这意味着：
 *   1. 回复**确实在 DOM 里**（用户看得见）—— 我之前「消息不在 DOM 里」
 *      的结论是错的：那是**发消息前的一瞬**抓的快照，抓早了
 *   2. 所以诊断的 needle 应该用**提示词本身**（它作为用户消息一定在
 *      页面上），而不是「抓到的内容」（抓到的可能是侧边栏）
 */
const promptRef: { current: string } = { current: '' }

/** DOM 报告上次抓取时刻（限流：20 秒最多一次，防拖死 tick —— 见抓取处注释）。 */
const domReportAtRef: { current: number } = { current: 0 }

/**
 * 看门狗催继续的计数（照抄 cuckoo watchdog：最多 3 次）。
 * 每个新任务开始时重置为 0（见 clearPending）。
 */
const watchdogCountRef: { current: number } = { current: 0 }

/**
 * ⭐ 点页面自己「继续生成」按钮的计数。
 *
 * 与看门狗（发「请继续」新消息）分开计数：两者是**不同的补救手段**，
 * 一个失败不该消耗另一个的额度。
 * 每个新任务开始时重置为 0（见 clearPending）。
 */
const continueCountRef: { current: number } = { current: 0 }

/**
 * ⭐ 「回复不完整」的重试计数（服务端掐断 / 围栏没闭合）。
 *
 * 与续写计数、看门狗计数**各自独立** —— 三种补救手段互不占用额度。
 * 每个新任务开始时重置为 0（见 clearPending）。
 */
const retryCountRef: { current: number } = { current: 0 }

const scrapeDiagRef: {
  current: {
    selector?: string
    count?: number
    root?: string
    lastLen?: number
    /** 内容前 60 字 —— 一眼看出抓的是不是侧边栏。 */
    head?: string
    at?: number
    /** ⭐ 决策轨迹：每个候选的 found/picked/skipped。 */
    trace?: unknown[]
    /** 兜底路径的信息。 */
    fallback?: string
  }
} = { current: {} }

/**
 * drain 轮询间隔。
 *
 * ## ⚠️ 为什么从 500ms 放宽到 1500ms（**实测发现的问题**）
 *
 * 这个轮询每轮都要跨进程 `executeJavaScript` 去读 hook 事件数组 ——
 * 也就是**每秒 2 次 IPC**，而且**空闲时也在跑**。
 *
 * 加上 hook 看门狗（1500ms）和心跳（5000ms），client 侧同时跑着三个
 * 定时器，每个都打 IPC。实测后果：
 *
 *     心跳延迟 10943ms → 12975ms → 14985ms → **掉线**
 *
 * 延迟每次 +2000ms（正好是采样间隔）说明心跳**停了** —— 主线程被
 * 这些 IPC 往返占住，5 秒的心跳漏成了 15 秒以上，触发 host 的
 * `CLIENT_STALE_MS` 判死。
 *
 * ## 为什么放宽到 1500ms 是安全的
 *
 * drain 只是 hook 事件的**辅助通道**（主路径是 DOM 抓取，1.5s 一轮）。
 * 事件在页面里是**累积在数组里**的，晚读一轮不会丢 —— 只是延迟一点。
 * 而少掉 2/3 的 IPC 能让主线程喘过来，心跳才稳。
 *
 * 副作用：hook 抓到回复后的交付最多晚 1.5 秒。可接受 ——
 * 相比「面板被判掉线」，这个代价小得多。
 */
const DRAIN_INTERVAL_MS = 1_500

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

  /**
   * 上面三个值的**最新镜像**，供心跳读取。
   *
   * ## 为什么需要（真实 bug）
   *
   * 心跳 effect 原来把 `loggedIn` / `lastReply` / `replyCount` 放进依赖数组，
   * 于是**每来一条回复就重建整个 effect** —— 定时器被反复清掉重建，
   * 心跳间隔变得不稳定（可能翻倍），host 侧可能判定「面板掉线」。
   *
   * 用 ref 镜像：发送时读 ref（永远是最新值），effect 只依赖 `ready` / 平台。
   * 这样定时器起来一次就不再重建。
   */
  const loggedInRef = useRef(false)
  const lastReplyAtRef = useRef(0)
  const replyCountRef = useRef(0)
  loggedInRef.current = loggedIn
  replyCountRef.current = replyCount
  if (lastReply !== '') lastReplyAtRef.current = Date.now()
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
        /**
         * ## ⭐ 把 partition 上报给 host（解决「重启必须重新登录」）
         *
         * ## 为什么要上报
         *
         * DSH 的 guest partition 是 `dsh-sidebar-browser-${randomUUID()}`
         * （`lib/main.js:9638`）—— **无 `persist:` 前缀 = 内存分区**，
         * 进程退出 cookie 全丢。
         *
         * 而 DeepSeek 的登录态主要靠 **httpOnly cookie**，页面里的
         * `document.cookie` **看不见也写不了**它们 —— 所以「快照
         * localStorage + document.cookie」这条路天生不完整
         * （用户实测：「每次重启 dsh 都需要重新登陆」）。
         *
         * **partition 名是随机的，host 猜不到** —— 但它就在这个返回值里。
         * 上报之后，host 半（跑在 Electron 主进程）就能用
         * `session.fromPartition(name).cookies` 读写**含 httpOnly** 的
         * 完整 cookie，重启后写回去即可免登录。
         *
         * ⚠️ 上报失败不能影响主流程（这只是增强，不是必需）。
         */
        void fetchJson('/dsh-webin/api/client/partition', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            platform: provider.id,
            partition: reservation.partition,
            /** 目标域名 —— host 侧按它过滤 cookie。 */
            domain: (() => {
              try {
                return new URL(provider.homeUrl).hostname
              } catch {
                return ''
              }
            })(),
          }),
        })

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
              /** ⚠️ 带超时 —— 5 秒一次，裸调用会在导航时堆积死掉的 Promise。 */
              void execJs<string>(node, buildProbeScript(), 8_000).then((r2) => {
                if (disposed || r2 === EXEC_TIMEOUT) return
                try {
                  const p2 = JSON.parse(String(r2)) as { loggedIn?: boolean }
                  setLoggedIn(p2.loggedIn === true)
                } catch {
                  /* ignore */
                }
              })
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
              /**
               * ## ⭐ 第一步：让 host 把 **httpOnly cookie** 写回当前 partition
               *
               * 这比页面侧快照更根本 —— DeepSeek 的登录态主要靠
               * httpOnly cookie，而页面 JS 既读不到也写不了它们。
               *
               * 顺序很重要：**必须在页面加载前写**（cookie 是请求头的一部分，
               * 页面开始加载后再写就晚了，首屏仍然是登录页）。
               * 这里处于 `navigating` 阶段，页面刚 loadURL、还没渲染完，
               * 是能赶上的最早时机。
               *
               * ⚠️ 失败不阻断（走页面快照那条降级路径）。
               */
              let cookieRestored = 0
              try {
                const res = await fetchJson(
                  `/dsh-webin/api/auth/${encodeURIComponent(provider.id)}/cookies`,
                  undefined,
                  10_000,
                )
                if (res !== undefined && res.ok) {
                  const j = (await res.json()) as { restored?: number; total?: number }
                  cookieRestored = typeof j.restored === 'number' ? j.restored : 0
                  console.log('[dsh-webin] httpOnly cookie 已写回', {
                    restored: cookieRestored,
                    total: j.total ?? 0,
                  })
                } else if (res !== undefined && res.status !== 404 && res.status !== 409) {
                  console.log('[dsh-webin] cookie 写回跳过', res.status)
                }
              } catch {
                /* 不阻断 */
              }

              const snap = await loadSnapshot(provider.id)
              if (snap === undefined) {
                console.log('[dsh-webin] 无登录态快照，跳过回写')
                stageRef.current = 'live'
                /**
                 * ⚠️ cookie 写回成功时**必须 reload** ——
                 * 页面是在 cookie 写回**之前**开始加载的，首屏还是登录页；
                 * 不 reload 的话用户看到的就是登录界面（即使 cookie 已经好了）。
                 */
                if (cookieRestored > 0) {
                  stageRef.current = 'reloading'
                  /**
                   * ## ⚠️⚠️ `reload()` **不返回 Promise** —— 不能 `.catch()`
                   *
                   * ## 真实事故（DSH 直接崩溃）
                   *
                   * 崩溃日志：
                   *
                   *     TypeError: Cannot read properties of undefined (reading 'catch')
                   *     at dsh-app://app/plugins/??dsh-webin/client.js:4162
                   *     Error: web boot: 1 entry did not activate
                   *     dsh-webin: import failed
                   *
                   * 根因：`<webview>.reload()` 是 **Electron 的同步方法**，
                   * 返回 `undefined` —— 而这里写了 `.reload().catch(...)`，
                   * 于是对 `undefined` 读 `.catch` ⇒ **抛 TypeError**。
                   *
                   * 这个异常发生在 effect 里，冒泡成 unhandled rejection ⇒
                   * **整个 client bundle import 失败** ⇒ DSH 报
                   * 「应用无法启动或已意外停止」。
                   *
                   * ⚠️ 这个 bug **一直存在**，只是之前被别的错误掩盖了；
                   * 等前面那些错修掉后它就暴露出来，直接把 DSH 打崩。
                   *
                   * 正确写法：直接调用，不做链式。
                   */
                  element.reload()
                  return
                }
                // 没有快照也要继续走「就绪」流程，否则插件永远不工作
                markLive()
                return
              }
              let restored = false
              try {
                /** ⚠️ 带超时 —— 裸调用在导航时会静默死掉，卡住整个启动流程。 */
                const raw = await execJs<string>(element, buildRestoreScript(snap), 15_000)
                if (raw === EXEC_TIMEOUT) throw new Error('回写脚本超时')
                const r = JSON.parse(String(raw)) as { ok?: boolean; reason?: string }
                restored = r.ok === true
                console.log('[dsh-webin] 登录态回写', provider.id, raw)
                if (!restored) console.warn('[dsh-webin] 回写未成功:', r.reason ?? 'unknown')
              } catch (error) {
                console.warn('[dsh-webin] 登录态回写失败', error)
              }
              if (disposed) return
              /** cookie 写回也算「有东西变了」，同样需要 reload。 */
              if (restored || cookieRestored > 0) {
                // 带着刚写回的登录态 reload；下一次 dom-ready 会走到下面的 live 分支
                stageRef.current = 'reloading'
                /**
                 * ⚠️ 同上：`<webview>.reload()` 是同步方法、返回 `undefined`，
                 * 不能 `.catch()` —— 那会抛 `TypeError: Cannot read properties
                 * of undefined (reading 'catch')`，把整个 client bundle 打崩
                 * （DSH 直接弹「应用无法启动」，见第一处的完整事故记录）。
                 */
                element.reload()
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
          //
          // ⚠️ **必须用 execJs（带超时）**：裸 `executeJavaScript` 在页面
          // 导航时会静默死掉（不 resolve / 不 reject），于是这个 `.then`
          // 永不执行 ⇒ `setReady(true)` 永不置位 ⇒ **插件永久失效**。
          // 早期版本正是这个 bug（用户看到「一直不回复」）。
          void execJs<boolean>(
            element,
            `(function () {
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
            })()`,
            15_000,
          ).then((hasInput) => {
            if (disposed) return
            console.log('[dsh-webin] 输入框就绪检查:', hasInput)
            /**
             * 无论结果如何都要置位 —— 超时/异常也置位。
             * 让发送脚本自己去报具体错误，好过整个插件静默卡死。
             */
            setReady(true)
            if (hasInput === true) setStatus('真实浏览器已就绪')
            else setStatus('页面已加载，但未找到输入框（可能未登录或结构已变）')
          })

          void execJs(element, fingerprintFix(), 10_000).catch(() => undefined)
          void execJs<string>(
            element,
            buildDeepSeekHook(provider.completionPath, provider.stopPath),
            15_000,
          ).then((r) => {
            if (disposed) return
            if (r === EXEC_TIMEOUT) console.warn('[dsh-webin] hook 注入超时')
            else console.log('[dsh-webin] hook:', provider.id, r)
          })
          void execJs<string>(element, buildProbeScript(), 10_000).then((raw) => {
            if (disposed) return
            if (raw === EXEC_TIMEOUT) return
            try {
              const info = JSON.parse(String(raw)) as { loggedIn?: boolean } & Record<string, unknown>
              ;(globalThis as unknown as { __dshWebinProbe?: unknown }).__dshWebinProbe = info
              console.log('[dsh-webin] guest probe', info)
              setLoggedIn(info.loggedIn === true)
            } catch {
              /* ignore */
            }
          })

          // 登录态持续探测已抽到 markLive() 里（那里起的 5s 轮询就是干这个的），
          // 避免重复起两个定时器。
        })

        /**
         * ## ⚠️ 导航时**立刻**重新注入 hook（不能只靠 `dom-ready`）
         *
         * 用户症状：「一直深度求索中，网页版早就有回复和思考内容了，但就是不输出」，
         * 状态栏显示「收到 0 条」。
         *
         * 根因：hook 是**页面级**的，一次导航就没了。而 `dom-ready` 是在
         * 页面**主要资源加载完之后**才触发的 —— 此时页面自己的脚本
         * （包括它发 completion 请求的代码）**早就跑起来了**。
         *
         * 于是出现这个致命时序：
         *
         *     t0  我们发消息 → 页面从 / 硬跳转到 /a/chat/s/<id>
         *     t1  导航 ⇒ **hook 被销毁**
         *     t2  新页面起来，立刻发 completion 请求 ← 此时没有 hook！
         *     t3  dom-ready 才触发 ⇒ 我们再注入，但请求已经发出去了
         *     t4  我们看不到任何 SSE ⇒ 收到 0 条 ⇒ DSH 空等
         *
         * 新会话（`freshChat`）必然走这条路：首轮会导航到首页/新对话页。
         *
         * `did-start-navigation` 在主框架导航**开始**时就触发，比
         * `dom-ready` 早得多。而且 hook 是**幂等**的（自带 MARKER 标记），
         * 重复注入只是一次函数调用，代价极低。
         *
         * 另外每次导航也把「已就绪」重新置一下 —— 新页面需要重新探测输入框。
         */
        element.addEventListener('did-start-navigation', (event) => {
          if (disposed) return
          const e = event as unknown as { isMainFrame?: boolean; isSameDocument?: boolean }
          /** 只关心主框架的**跨文档**导航（同文档 hash 变化不算）。 */
          if (e.isMainFrame === false || e.isSameDocument === true) return
          console.log('[dsh-webin] 主框架开始导航，预注入 hook')
          /**
           * 这时新文档还没建立，注入大概率打在上一个文档上（无害，幂等）。
           * 真正的价值是**紧接着的 `dom-ready` 会立刻再注一次** ——
           * 两次机会总比一次好，而且这次能给日志一个明确的时间点。
           */
          void execJs<string>(
            element,
            buildDeepSeekHook(provider.completionPath, provider.stopPath),
            10_000,
          )
            .then((r) => {
              if (disposed) return
              if (r !== EXEC_TIMEOUT) console.log('[dsh-webin] 预注入 hook:', r)
            })
            .catch(() => undefined)
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

  /**
   * ## ⭐ Hook 自愈守护（**这是「收到 0 条」的根治手段**）
   *
   * ## 为什么不能只靠 `dom-ready` 注入
   *
   * hook 是**页面级**的，一次导航就没了。而 `dom-ready` 在页面主要资源
   * 加载完**之后**才触发 —— 此时页面自己的脚本（包括它发 completion
   * 请求的那段）**早就跑起来了**。于是：
   *
   *     t0  我们发消息 → 页面从 / 硬跳到 /a/chat/s/<id>
   *     t1  导航 ⇒ hook 被销毁
   *     t2  新页面起来，**立刻**发出 completion 请求 ← 此刻没有 hook
   *     t3  dom-ready 才到 ⇒ 我们补注入，但请求已经发完了
   *     t4  我们看不到任何 SSE ⇒ 收到 0 条 ⇒ DSH 一直等
   *
   * 用户实测就是这个：「一直深度求索中，网页版早就有回复和思考内容了，
   * 但就是不输出」。新会话（`freshChat`）**必然**走这条路。
   *
   * ## 为什么用「守护」而不是继续加事件监听
   *
   * 导航的触发方式太多（`did-start-navigation` / `did-navigate` /
   * SPA 硬跳 / 页面自己 `location.replace`），靠穷举事件永远有漏网。
   *
   * 所以改成**状态自愈**：每 1.5s 问一句「hook 还在吗」，
   * 不在就装上。判据是 hook 自己写在 window 上的标记 ——
   * 新文档里那个标记**必然**不存在，所以一定能测出来。
   *
   * 代价：每 1.5s 一次 `executeJavaScript`（读一个布尔值）。
   * 与「抓不到回复导致整轮失败」相比，这个代价可以忽略。
   */
  useEffect(() => {
    if (!ready) return
    let stopped = false
    const ensureHook = () => {
      if (stopped) return
      const el = hostRef.current?.querySelector('webview') as GuestElement | null
      if (el === null) return
      void execJs<string>(el, `${MARKER_CHECK}`, 8_000)
        .then((r) => {
          if (stopped) return
          if (r === EXEC_TIMEOUT) return
          /**
           * 返回 'true' = hook 在（新文档里标记不可能存在）。
           * 注意不能用 `if (!r)` —— 空字符串、'false' 都得重新注入。
           */
          if (String(r) === 'true') return
          console.log('[dsh-webin] hook 不在（页面已导航），重新注入')
          return execJs<string>(
            el,
            buildDeepSeekHook(provider.completionPath, provider.stopPath),
            10_000,
          ).then((installed) => {
            if (stopped) return
            console.log('[dsh-webin] hook 补注入:', installed)
          })
        })
        .catch(() => undefined)
    }
    ensureHook()
    const timer = window.setInterval(ensureHook, 1_500)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [ready, provider.id, provider.completionPath, provider.stopPath])

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
  /**
   * 已经用 DOM 兜底捞过哪个任务。
   *
   * 防止同一个任务被反复捞 —— 每轮都去读 DOM 会把同一段内容重复交回去。
   * 主路径（hook 的 `done` 事件）拿到结果时也会清掉它。
   */
  const scrapedRef = useRef<string | undefined>(undefined)
  /**
   * 派发任务时页面上已有几条 assistant 回复。
   *
   * ## 为什么需要基线（而不是「内容变了」）
   *
   * 判断「本轮回复来了」最可靠的判据是**条数变多** ——
   * 只有真的新增一条 assistant 消息才会增长。
   * 而「内容变了」会被页面重渲染、动画、光标闪烁误触发。
   *
   * 所以发送前记下条数，之后等它超过这个基线。
   */
  const baselineRef = useRef<number>(0)
  /**
   * 派发任务时页面上最后一条回复的内容。
   *
   * ## 为什么条数之外还要记内容
   *
   * 「条数增长」是主判据，但有漏洞：如果页面把回复渲染在基线选择器
   * **匹配不到**的容器里（改版、A/B 测试），`count` 永远不增长，
   * 我们就会一直等到 5 分钟超时 —— 用户看到的是「一直等」。
   *
   * 记下基线内容后，只要页面上出现了**不一样的**内容就能交付。
   * 两个判据取「任一成立」，比只看条数稳得多。
   */
  const baselineTextRef = useRef<string>('')
  /**
   * 上一次 DOM 内容**发生变化**的时刻。
   *
   * ## 为什么记「变化时刻」而不是「上次读取时刻」
   *
   * 稳定性判据是「内容不再增长」。用「上次读取时刻」会被**读取频率**
   * 影响（每 1.5s 一轮）—— 内容其实早就停了，但因为我们刚读了一次，
   * 计时就重置，白等一轮。
   *
   * 记「上次变化时刻」才是真正的静默时长。
   */
  const scrapedChangedAtRef = useRef<number>(0)
  useEffect(() => {
    if (!ready) return
    const timer = window.setInterval(() => {
      const el = hostRef.current?.querySelector('webview') as GuestElement | null
      if (el === null) return
      /**
       * ⚠️ 用 `execJs`（带超时）。轮询是 500ms 一次，裸调用在页面导航时
       * 会堆积一堆永不 settle 的 Promise —— 每个都占着闭包和事件监听。
       * 超时给 10s（drain 只是读一个数组，正常是毫秒级）。
       */
      void execJs<string>(el, buildDrainScript(), 10_000)
        .then((raw) => {
          if (raw === EXEC_TIMEOUT) return
          const text = String(raw)
          if (text === '[]' || text === '') return
          const events = JSON.parse(text) as Array<{ name: string; detail: Record<string, unknown>; at?: number }>
          for (const ev of events) {
            // 只认「本次发送之后」的事件，避免把历史回复当成任务结果
            const at = typeof ev.at === 'number' ? ev.at : 0
            if (at !== 0 && at < sentAtRef.current) continue

            if (ev.name === 'done') {
              /**
               * ⭐⭐⭐ **这条路径才是思考泄漏的真凶**（实测：DOM 侧读到的是干净的
               * 23 字符工具调用，而用户收到的是长思考）。
               *
               * hook 的 `done` 事件带 `{text, think}` —— text 里可能混着思考，
               * 而它先触发、清掉 pending、把 text **原样**交付。所以必须在这里
               * 也过一遍剔除（与 DOM 路径同一道兜底）。
               */
              const replyRaw = String(ev.detail?.text ?? '')
              const reply = stripThinkFromText(replyRaw, String(ev.detail?.think ?? ''), 'hook')
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
                /**
                 * ⚠️ 这里**只清 pending，不动基线**。
                 *
                 * 这是 drain 轮询 effect（与发送循环是两个独立 effect），
                 * 基线（`baselineRef` / `baselineTextRef`）由**发送循环**在
                 * 领活时设置。在这里清掉会让发送循环的「本轮回复来了吗」
                 * 判据失效（它自己会在结束任务时通过 `clearPending()` 收口）。
                 */
                pendingJobRef.current = undefined
                pendingSinceRef.current = 0
                scrapedRef.current = undefined
                /** 拿页面当前 URL（= 这条消息落地的对话页）。 */
                void execJs<string>(el, 'location.href', 8_000)
                  .then((u) => (u === EXEC_TIMEOUT ? '' : String(u)))
                  .then((chatUrl) => {
                    void fetchJson(`/dsh-webin/api/job/${jobId}/result`, {
                      method: 'PUT',
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({
                        text: reply,
                        think: String(ev.detail?.think ?? ''),
                        status: String(ev.detail?.status ?? 'finished'),
                        ...(chatUrl === '' ? {} : { chatUrl }),
                      }),
                    })
                  })
              }
            } else if (ev.name === 'error') {
              console.warn('[dsh-webin] page reported error', ev.detail)
              const jobId = pendingJobRef.current
              if (jobId !== undefined) {
                /** 同上：drain effect 只清 pending，不碰基线。 */
                pendingJobRef.current = undefined
                pendingSinceRef.current = 0
                scrapedRef.current = undefined
                void fetchJson(`/dsh-webin/api/job/${jobId}/result`, {
                  method: 'PUT',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ error: String(ev.detail?.message ?? 'page error') }),
                })
              }
            }
          }
        })
        .catch(() => undefined)
    }, DRAIN_INTERVAL_MS)
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
      /**
       * ⚠️ 每次心跳都**现读**这些值，而不是把它们放进依赖数组。
       *
       * ## 为什么（真实 bug）
       *
       * 早期把 `loggedIn` / `lastReply` / `replyCount` 放进依赖数组，
       * 于是**每来一条回复就重建整个 effect** —— 定时器被反复清掉重建。
       * 后果：心跳间隔变得不稳定（可能长达两倍），host 侧可能判定
       * 「面板掉线」，而且回复越多重建越频繁。
       *
       * 用 ref 保存最新值：effect 只在 `ready` / 平台变化时重建一次。
       */
      const payload = {
        clientId,
        platform: provider.id,
        loggedIn: loggedInRef.current,
        hasGuest: el !== null,
        lastReplyAt: lastReplyAtRef.current,
        replyCount: replyCountRef.current,
        /**
        /**
         * ## ⭐ 抓取诊断 —— 让「页面上到底抓到了什么」可见
         *
         * ## 为什么加（用户：「不要猜」）
         *
         * 端到端测试抓到的是侧边栏而不是回复，但我**看不到**抓取脚本
         * 内部的判断过程 —— 只能改代码、重启、再看，一轮一轮猜。
         *
         * 把最近一次抓取的 `selector` / `count` / `root` / 内容长度
         * 跟着心跳送上来，`/status` 就能直接看到。
         */
        scrape: scrapeDiagRef.current,
        /** ⭐ 页面结构报告（抓取失败时自动导出一次）。 */
        ...(domReportRef.current === undefined ? {} : { dom: domReportRef.current }),
      }
      void fetch('/dsh-webin/api/client/heartbeat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
        .then((res) => (res.ok ? res.json() : undefined))
        .then((j: { bundleRev?: string } | undefined) => {
          if (stopped || j === undefined || typeof j.bundleRev !== 'string') return
          /**
           * ## ⭐⭐ 自动重载 v2 —— 判据是 **rev 变化**（修复死循环）
           *
           * ## ⚠️ v1 判据（builtAt vs mtime）造成**每 2 秒无限重载**
           *
           * 群友实测：面板每 2~2.2 秒重载一次、永不停止，甚至拖崩
           * DSH 桌面端。根因：`builtAt` 在**构建开始**算，`client.js`
           * 在**构建末尾**写盘 —— 机器稍慢差值就超 5 秒容差 ⇒
           * **永远判定落后** ⇒ 每次心跳都要求重载 ⇒ 死循环。
           *
           * ## v2：只比「rev 变没变」—— 自收敛
           *
           *   1. host 每次心跳回包都带当前产物 `bundleRev`
           *   2. 面板第一次收到时记下来（= 我加载时是哪个版本）
           *   3. 之后 rev **变了** ⇒ 真的出了新构建 ⇒ 才 reload
           *   4. reload 后加载到新 bundle ⇒ 记下的 rev 更新 ⇒ 停止
           *
           * **自收敛**：只有文件真的换了 rev 才会变。不需要任何持久化
           * （模块级变量就够了 —— reload 会重建模块，正好重置）。
           *
           * ⚠️ 有任务在跑时不重载 —— 否则打断正在生成的回复。
           */
          if (loadedBundleRev.current === null) {
            /** 第一次心跳：记下「我加载时是哪个版本」。 */
            loadedBundleRev.current = j.bundleRev
            return
          }
          if (loadedBundleRev.current === j.bundleRev) return
          if (pendingJobRef.current !== undefined) {
            console.log('[dsh-webin] 发现新构建，但当前有任务在跑 —— 等它结束再重载')
            return
          }
          console.log('[dsh-webin] 发现新构建，自动重载页面', {
            mine: loadedBundleRev.current,
            latest: j.bundleRev,
          })
          window.location.reload()
        })
        .catch(() => undefined)
    }
    beat()
    const timer = window.setInterval(beat, 5_000)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [ready, provider.id])

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
       * ## ⭐ 任务状态清理**只有一个出口**
       *
       * ## 为什么必须收口（审计发现的真实 bug）
       *
       * 领活后需要清三样：`pendingJobRef` / `scrapedRef` / `baseline*Ref`。
       * 原来这些清理**散落在 10 个地方**各写一遍，审计发现只有 1 处写全了 ——
       * 其余要么只清 `scrapedRef`，要么两个基线都不清。
       *
       * 后果很具体：**不清基线** ⇒ 下个任务领到时 `baselineRef` 还是
       * 上一轮的条数 ⇒ `countGrew` 一上来就成立 ⇒ 可能把**上一条回复**
       * 当成新回复交回去（张冠李戴，DSH 里出现答非所问的内容）。
       *
       * 所以收口成一个函数：**任何**结束任务的地方都调它，
       * 不再依赖「写代码的人记得清哪几个」。
       */
      
/**
 * ## ⭐⭐⭐ 先滚到底、等渲染、再抓（拆开两步）
 *
 * ## 为什么不能一步做完（真实事故：交付了侧边栏）
 *
 * DeepSeek 的消息列表是**虚拟列表** —— 只把视口内的消息插进 DOM。
 * 设置 `scrollTop` 只是**触发**滚动，页面要等下一帧才重渲染；
 * 而抓取脚本是一次 eval 同步跑完的。
 *
 * 所以「滚完立刻抓」抓到的还是滚动前的内容 ⇒ 精确候选 found=0 ⇒
 * 掉到 longest-div 兜底 ⇒ **抓到侧边栏**（1110 字符的会话列表）当回复交付。
 *
 * 用户实测症状：DSH 收到的「回复」是
 * 「开启新对话 / 置顶 / 今天 / 新对话…」，而网页版明明答对了。
 *
 * ## 顺序
 *
 *   1. `buildScrollScript` —— 把消息列表滚到底
 *   2. **等 400ms**（2~3 帧，让虚拟列表把新消息渲染进 DOM）
 *   3. `buildScrapeScript` —— 此时才读得到最新回复
 *
 * 滚动本身**不改页面内容**，无副作用（用户看回复本来就在底部）。
 *
 * @param el - guest webview
 * @param timeoutMs - 抓取超时
 * @returns 抓取脚本的原始返回（可能是 {@link EXEC_TIMEOUT}）
 */
async function scrapeWithScroll(el: WebviewElement, timeoutMs: number): Promise<string> {
  /** 滚 —— 失败不致命（页面结构可能变），继续抓。 */
  try {
    await execJs<string>(el, buildScrollScript(), 5_000)
  } catch {
    /* 滚动失败继续抓 */
  }
  /** ⭐ 关键：等虚拟列表重渲染（2~3 帧）。少了这步就会抓到旧内容/侧边栏。 */
  await new Promise((r) => setTimeout(r, 400))
  return execJs<string>(el, buildScrapeScript(), timeoutMs)
}

/**
 * ## ⭐⭐⭐ 剔除混进正文的思考（**两条交付路径共用**）
 *
 * ## 为什么必须有，而且必须在两处都调
 *
 * 真实页面上 `ds-think-content` **嵌套在 `ds-markdown` 内部**（思考是回复的一部分，
 * 只是折叠显示），所以「正文」里天然可能带着思考。
 *
 * ## 用户实测（我前四轮改错了地方）
 *
 * 我一直在改 **DOM 抓取**侧的排除（`render` / `readThink`），但 `/status` 的
 * 抓取诊断显示 DOM 侧读到的是**干净的** 23 字符工具调用 —— 而用户收到的却是
 * 长长的思考。⇒ **泄漏在 hook 路径上**：hook 的 `done` 事件带着 `{text, think}`，
 * 它先触发、清掉 pending、把 `text` **原样**交付，而那个 text 里混着思考。
 *
 * 所以这道兜底必须**两条路径都调**。
 *
 * ## 判据（与页面特征无关）
 *
 * `think` 是单独读出来的。若它出现在正文里，说明正文把思考也读进去了 ⇒ 删掉那段。
 * 先试直接子串；不中再按「逐行」定位（应对换行/缩进差异）。
 * 只处理足够长的思考（≥ 20 字），避免把正常正文里的短句误删。
 *
 * @param text  - 待清洗的正文
 * @param think - 单独读出来的思考（可能为空）
 * @param tag   - 日志用的来源标记（`dom` / `hook`）
 */
const stripThinkFromText = (text: string, think: string, tag: string): string => {
  const t = think.trim()
  if (t.length < 20) return text
  const at = text.indexOf(t)
  if (at >= 0) {
    console.warn(`[dsh-webin] 正文里混进了思考（${tag}），已剔除（直接命中）`, { removed: t.length })
    return (text.slice(0, at) + text.slice(at + t.length)).trim()
  }
  /** 逐行兜底：思考的首行与末行都在正文里 ⇒ 删掉它们之间的区间。 */
  const tLines = t.split('\n').map((s) => s.trim()).filter((s) => s !== '')
  const head = tLines[0]
  const tail = tLines[tLines.length - 1]
  if (tLines.length >= 2 && head !== undefined && tail !== undefined) {
    const lLines = text.split('\n')
    const hi = lLines.findIndex((s) => s.trim() === head)
    const ti = lLines.findIndex((s, i) => i > hi && s.trim() === tail)
    if (hi >= 0 && ti > hi) {
      console.warn(`[dsh-webin] 正文里混进了思考（${tag}），已剔除（逐行命中）`, { from: hi, to: ti })
      return [...lLines.slice(0, hi), ...lLines.slice(ti + 1)].join('\n').trim()
    }
  }
  return text
}

const clearPending = () => {
        pendingJobRef.current = undefined
        pendingSinceRef.current = 0
        scrapedRef.current = undefined
        scrapedChangedAtRef.current = 0
        baselineRef.current = 0
        baselineTextRef.current = ''
        /** 看门狗计数归零（新任务重新有 3 次催继续的机会）。 */
        watchdogCountRef.current = 0
        /** 点「继续生成」的计数同样归零。 */
        continueCountRef.current = 0
        /** 不完整重试计数同样归零。 */
        retryCountRef.current = 0
      }
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
         * ## ⭐ 轮询页面 DOM 读回复（**主路径**）
         *
         * 用户的要求：「我想要的插件很简单，就是把网页版的内容，回显到 dsh
         * 的对话窗口中」。
         *
         * ## 为什么改成主路径
         *
         * 原来把「hook 抓 SSE」当主路径，DOM 只当 20 秒后的兜底。
         * 但抓 SSE 有个**解决不了的时序问题**（读 cuckoo 才看明白）：
         *
         *   cuckoo 能在页面脚本执行**之前**注入 hook，靠的是 **preload**
         *   （`src/bridge/entry.ts:52-68`）。而 DSH 的 webview 门禁
         *   （`lib/main.js:9690`）把 preferences 清空后只设固定几项，
         *   **`preload` 不在里面** —— 所以我只能等 `dom-ready`，
         *   那时页面脚本早已跑完、请求早已发出 ⇒ 永远「收到 0 条」。
         *
         * 而 DOM 里的内容**什么时候读都读得到**，不依赖任何注入时机。
         * cuckoo 自己也把 DOM 抓取当默认模式
         * （`src/providers/types.ts:72`：「默认 false = DOM 抓取」）。
         *
         * ## 怎么判断「本轮回复已经来了」
         *
         * 判据是**回复条数变多**（而不是「最后一条变了」）——
         * 后者在页面重渲染时会误判。所以派发任务前记下基线条数，
         * 之后等它增长。
         *
         * 同时要求「页面不再生成」（输入框可用）—— 否则会读到半截回复。
         * 这里不主动检测停止按钮（DeepSeek 上是纯图标，测不到），
         * 改用**连续两次读到相同内容**作为「已稳定」的判据。
         */
        const waitedMs = Date.now() - pendingSinceRef.current

        /**
         * 放弃门槛：**从配置读**，比 adapter 的 `timeoutMs` 早一点。
         *
         * ## 为什么不能硬编码（之前的缺陷）
         *
         * 原来写死 5 分钟。但配置里的 `replyTimeoutMs` 默认是 **10 分钟**
         * （注释记着「实测最慢一次网页回复 6 分 12 秒」）——
         * 于是慢回复会在 5 分钟被**提前掐断**，用户看到「超时」，
         * 而网页版其实还在正常生成。
         *
         * 现在按配置的 80% 算（留出余量让 adapter 那次超时不会先触发），
         * 用户调大「等回复超时」时这里跟着变。
         *
         * ⚠️ 用 `currentConfig()` 直接读，不用下面的 `cfgNow` ——
         * 那个变量在这个位置还没声明（会踩 TDZ）。
         */
        const giveUpMs = Math.max(60_000, Math.round(currentConfig().replyTimeoutMs * 0.8))

        /**
         * ## ⭐⭐⭐ 早期放弃：发出后 2 分钟页面**确实**没动静 ⇒ 大概率没发出去
         *
         * ## 为什么改成这样（用户连续三轮被误报）
         *
         * 原判据是「发出后 **30 秒**页面无动静 ⇒ 没发出去」。但它只看 DOM 有没有
         * 动静，而**网页版处在思考阶段时，插件的 DOM 读取什么都看不到**：
         * 还没有 `.ds-markdown` 回复容器 ⇒ 条数没增长、内容没变化、思考区也没读到
         * —— 三个条件同时成立 ⇒ 30 秒就判失败，**而页面正在正常生成**。
         *
         * ## 参照 cuckoo 的实现（用户要求）
         *
         * cuckoo **压根没有这道判据** —— 它唯一的超时是「SSE 流静默 300 秒」。
         * 而且它的错误处理订阅的是**真实错误事件**（429 等），不是拿 DOM 猜。
         * 我们仍然保留这道判据（因为 dsh-webin 的发送确认确实可能被骗过），
         * 但必须补上 cuckoo 式的「有真实依据才下结论」：
         *
         * ## 现在的判据（全部成立才判失败）
         *
         *   1. 已等满 120 秒（原来是 30 秒 —— 太激进）
         *   2. 条数没增长、内容没变化、思考区为空
         *   3. **页面不在生成中**（`generating !== true`）
         *   4. ⭐⭐ **抓取确实看见了页面**（`scrapedOk === true`）
         *
         * 第 4 条是关键补充：抓取是瞎的时候，「没变化」与「页面没动静」
         * **完全无法区分**。看不见就不下结论，继续等（最坏走 giveUpMs 硬超时）。
         *
         * 另：发送时 `buildTriggerScript` 已经确认过「输入框被清空」，
         * 所以这条判据本质上是在**推翻自己刚刚确认过的事** —— 必须极其保守。
         */
const EARLY_GIVE_UP_MS = 120_000

        if (hasPending && waitedMs > 3_000) {
          const jobId = pendingJobRef.current!
          const scrapedRaw = await scrapeWithScroll(el, 12_000)
          if (scrapedRaw !== EXEC_TIMEOUT) {
            try {
              const scraped = JSON.parse(String(scrapedRaw)) as {
                ok?: boolean
                last?: string
                think?: string
                count?: number
                selector?: string
                root?: string
              }
              /**
               * ⭐ 记下抓取诊断 —— 跟着心跳上报，`/status` 直接可见。
               *
               * 这样「抓到侧边栏还是回复」不用猜：看 `selector` 和
               * `head` 就知道。
               */
              scrapeDiagRef.current = {
                trace: Array.isArray((scraped as { trace?: unknown }).trace)
                  ? ((scraped as { trace?: unknown[] }).trace ?? []).slice(0, 8)
                  : [],
                fallback: String((scraped as { fallback?: unknown }).fallback ?? ""),
                selector: scraped.selector ?? '',
                count: typeof scraped.count === 'number' ? scraped.count : -1,
                root: scraped.root ?? '',
                lastLen: typeof scraped.last === 'string' ? scraped.last.length : -1,
                head: typeof scraped.last === 'string' ? scraped.last.slice(0, 60) : '',
                at: Date.now(),
              }
              /**
               * ## ⭐ 页面结构报告（用**提示词**做 needle，在流式期间抓）
               *
               * ## 为什么 needle 必须换（用户的关键观察）
               *
               * 用户指出：「网页版都是一个字一个字蹦出来的」——
               * 回复是**流式逐字渲染**的。这意味着：
               *
               *   1. 回复**确实在 DOM 里**（用户亲眼看得见）——
               *      我之前「消息不在 DOM 里」的结论是**错的**：
               *      那份报告是在**发消息前的一瞬**抓的快照，抓早了
               *   2. 之前 needle 用「抓到的内容前 20 字」——但抓到的是
               *      **侧边栏**，而 `innerText` 会把换行折叠/规范化，
               *      所以那个 needle 在页面上根本匹配不到（`needle 命中 0`
               *      的真正原因），「祖先链」自然是空的
               *
               * ## 现在的 needle
               *
               * 用**提示词本身** —— 它作为用户消息**一定**渲染在页面上，
               * 找到含它的最深元素，祖先链上就有「用户消息容器」，
               * 而**回复容器通常和它是兄弟**（同一个消息列表的相邻项）。
               *
               * ## 时机：流式期间抓，但**必须限流**
               *
               * 流式渲染意味着 DOM 每一刻都在变 —— 要在流式期间抓。
               * 但这份报告很重（全页遍历 + 15 秒超时的跨进程调用）——
               * **不限流的话 needle=0 时每 1.5 秒轮询都会跑一次** ⇒
               * tick 循环被拖死 ⇒ 心跳饿死 ⇒ 面板被判死 ⇒ 任务卡 claimed
               * （真实事故：job-5 卡 200 秒，面板心跳 44s 后消失）。
               *
               * 所以：**每 20 秒最多抓一次**，且命中 0 的报告不缓存当结论。
               */
              if (
                Date.now() - domReportAtRef.current > 20_000 &&
                (domReportRef.current === undefined ||
                  (domReportRef.current as { needleHits?: number }).needleHits === 0)
              ) {
                /**
                 * ⚠️ needle 用提示词的中段（前 20 字可能被输入框回显
                 * 逻辑改写，中段更稳）；提示词太短时用全文。
                 */
                const p = promptRef.current
                const needle = p.length > 24 ? p.slice(4, 20) : p
                void execJs<string>(el, buildDomReportScript(needle), 15_000)
                  .then((domRaw) => {
                    if (domRaw === EXEC_TIMEOUT) return
                    try {
                      const parsed = JSON.parse(String(domRaw)) as Record<string, unknown>
                      domReportRef.current = parsed
                      domReportAtRef.current = Date.now()
                      const hits = (parsed as { needleHits?: number }).needleHits ?? 0
                      console.log('[dsh-webin] 页面结构已导出（needle=' + needle.slice(0, 12) + '… 命中 ' + hits + '）')
                    } catch {
                      /* 解析失败就算了，不影响主链路 */
                    }
                  })
                  .catch(() => undefined)
              }
              const last = typeof scraped.last === 'string' ? scraped.last : ''
              const think = typeof scraped.think === 'string' ? scraped.think : ''

              /**
               * ## ⭐⭐⭐ 安全网：正文里混进了思考 ⇒ 剔掉（与页面特征无关）
               *
               * ⚠️ 实现已**收口**到模块级的 `stripThinkFromText`，两条交付路径共用。
               *
               * ## 为什么必须收口（本轮最贵的教训）
               *
               * 「什么算思考 / 怎么剔除」这套判据原来散落在**四处**
               * （`render` 排除 / `readThink` 定位 / 前缀清理 / 这里的 DOM 兜底），
               * 每轮只改到一两处 ⇒ 用户连续三轮看到同一个症状。
               *
               * 现在：hook 路径与 DOM 路径都调**同一个** `stripThinkFromText`。
               */
              const lastClean = stripThinkFromText(last, think, 'dom')
              const count = typeof scraped.count === 'number' ? scraped.count : 0
              /**
               * ⭐ 回复是否停在未闭合围栏里（= 没写完）。抓取脚本算好的，
               * 这里只取用 —— 见 hook.ts 的 isFenceOpen。
               */
              const fenceOpen = (scraped as { fenceOpen?: boolean }).fenceOpen === true
              /**
               * ⭐ 页面是否**仍在生成**（停止按钮在）。
               *
               * 这是「消息到底发出去没有」最可靠的信号 —— 页面在生成就说明
               * 消息一定送到了（见下面「早期放弃」的说明）。
               */
              const generating = (scraped as { generating?: boolean }).generating === true
              /**
               * ⭐ 抓取**是否真的看见了页面**（找到至少一条回复）。
               *
               * ⚠️ 这条是「早期放弃」能不能下结论的前提：抓取是瞎的时候，
               * 「条数没增长 / 内容没变化」与「页面确实没动静」**完全无法区分**。
               * 实测现场：思考阶段还没有 `.ds-markdown` 容器 ⇒ ok=false、
               * count=0、selector 为空 —— 于是三个判据全部成立，误判成没发出去。
               */
              const scrapedOk = (scraped as { ok?: boolean }).ok === true
              /**
               * ⭐ 代码块正文是否明显没写完。围栏被网页版渲染器补过闭合时，
               * 这条是**唯一**能发现截断的信号（见 hook.ts 的
               * lastCodeBlockIncomplete）。
               */
              const codeTrailingIncomplete =
                (scraped as { codeTrailingIncomplete?: boolean }).codeTrailingIncomplete === true
              /**
               * ⭐ 页面上的服务端错误提示（「服务器暂时不可用」等，空串 = 没有）。
               * 非空 ⇒ 生成是被服务端掐断的，不能当成功交付。
               */
              const serverError =
                typeof (scraped as { serverError?: unknown }).serverError === 'string'
                  ? ((scraped as { serverError?: string }).serverError ?? '')
                  : ''

              /**
               * ## 本轮回复来了吗？—— 两个判据**任一**成立
               *
               *   1. **条数比基线多** —— 正常情况（新增了一条 assistant 消息）
               *   2. **内容与基线不同** —— 兜底：页面把回复渲染在基线选择器
               *      匹配不到的容器里、或者原地替换而不是追加
               *
               * 只判条数不够稳：选择器一旦没覆盖到真实容器，`count` 永远
               * 不增长，就会一直等到 5 分钟超时（用户看到的就是「一直等」）。
               * 加上内容比对后，只要页面上出现了**新的**内容就能交付。
               *
               * ## ⚠️⚠️ 这里原来还有一处 `last.length >= 8` —— 同一个 bug 的
               * **第二处残留**（第一处在抓取侧，已修）。
               *
               * 真实事故：问「写一句你好」，网页版答「你好。」—— **3 个字符**。
               * 抓取侧拿到了（lastLen=3），但这里 `last.length >= 8` 拒掉
               * ⇒ state=claimed 永远不交付 ⇒ **又卡 180 秒超时**。
               *
               * 教训：**同一个错误的判据会在多处复制** —— 修一处时必须
               * 全库搜同款。已在 verify-live 加断言防再犯。
               */
              const countGrew = count > baselineRef.current
              const contentChanged = last !== '' && last !== baselineTextRef.current
              if (scraped.ok === true && last.length > 0 && (countGrew || contentChanged)) {
                /**
                 * ## 稳定性判据：内容**不再增长**才算生成完
                 *
                 * ## 为什么不能只比「与上次相同」（审计发现的缺陷）
                 *
                 * 早期写法是「这次读到的 == 上次读到的」就交付。但那不够：
                 * 流式输出**可能暂停**（网络抖动、服务端排队），暂停期间
                 * 两次读到同样的半截内容 ⇒ **把半截回复交回 DSH**。
                 *
                 * 用户会看到回复被截断（而且 DSH 认为这轮已经结束了）。
                 *
                 * ## 现在的判据（两个都要满足）
                 *
                 *   1. 内容与上次**相同**（没有新增）
                 *   2. **且**距离上次变化已超过 {@link STABLE_MS}（默认 3 秒）
                 *
                 * 用「上次变化时刻」而不是「上次读取时刻」—— 后者会被
                 * 读取频率影响（1.5s 一轮），前者才是真正的「静默时长」。
                 *
                 * 代价是最快也要等 3 秒才交付 —— 相比「交半截回复」，
                 * 这个代价完全值得。
                 *
                 * ## ⭐⭐ 还要过「生成结束」闸门（真实事故：42KB 思考被当回复）
                 *
                 * 流式生成的消息出现顺序：#1 用户消息 → **#2 思考块** → #3 正文。
                 * 「条数增长 + 3 秒静默」在 **#2 刚出现、模型还在思考** 时就会
                 * 满足（思考是长文本，写完到开始正文之间很容易超 3 秒）
                 * ⇒ **把思考当回复交付**（用户实测收到 42KB 思考）。
                 *
                 * 真正的完成信号：网页版生成中输入框的发送键（↑）会变成
                 * **停止按钮**（方块 ■）；生成结束变回发送。抓取脚本返回
                 * `generating` 字段 —— **仍在生成时一律不交付**。
                 *
                 * ⚠️ `generating === undefined`（旧抓取脚本/字段缺失）时不阻止 ——
                 * 宁可早交付也不卡死（卡死是用户最难受的）。
                 */
                const now = Date.now()
                if (scrapedRef.current !== lastClean) {
                  /** 内容变了：记录新内容 + **变化时刻**，等下一轮。 */
                  scrapedRef.current = lastClean
                  scrapedChangedAtRef.current = now
                  return
                }
                /** 内容没变 —— 还要确认已经静默够久。 */
                if (now - scrapedChangedAtRef.current < STABLE_MS) {
                  return
                }
                /**
                 * ⭐⭐ 生成结束闸门：页面还在生成（停止按钮在）⇒ 不交付。
                 */
                if (generating === true) {
                  console.log('[dsh-webin] 内容静默但页面仍在生成（停止按钮在）—— 继续等')
                  scrapedChangedAtRef.current = now
                  return
                }

                /**
                 * ## ⭐⭐⭐ 网页版自己停了 ⇒ 点它自己的「继续生成」
                 *
                 * ## 为什么必须在这里（交付闸门之前）
                 *
                 * 服务端主动停止时，页面显示「已停止」+「继续生成」按钮。
                 * 此时 `generating === false`（停止键不在）⇒ 交付闸门放行 ⇒
                 * **半截回复被当成本轮结果交付**，用户看到「已完成」但任务没做完
                 * （实测：6 秒就交付了，因为静默只等了 STABLE_MS）。
                 *
                 * 原有看门狗要等 **12 秒**静默才动手，而且动作是**发一条新消息**
                 * 「请继续」—— 续写落在新的 assistant 消息里，正文被切成两段，
                 * 限流时新请求还会被拒。点页面自己的按钮是**同一条消息**的续写，
                 * 语义正确、立即生效。
                 *
                 * ## 顺序
                 *
                 * 页面自己的按钮（正确做法）⇒ 点不到才退回看门狗（发「请继续」）。
                 */
                const CONTINUE_MAX = 3

                /**
                 * ## ⭐⭐⭐ 不完整闸门：服务端掐断 / 围栏没闭合 ⇒ 不能当成功交付
                 *
                 * ## 用户实测（两个症状，同一根因）
                 *
                 * 网页版服务端不可用时会插一条「服务器暂时不可用」并**直接掐断
                 * 生成**。插件当时两种后果都没处理：
                 *
                 *   1. **交付半截工具调用** —— DSH 收到的是
                 *      「ldw + const r = await write(」，工具调用断在半句，
                 *      用户看到「已完成」却什么都没做成；
                 *   2. **用户不知道真实原因** —— 界面写「已完成」，用户以为
                 *      是插件 bug，不会想到「服务端拒绝、该重试」。
                 *
                 * ## 判据（任一成立即本轮不算成功）
                 *
                 *   - `serverError` 非空 ⇒ 页面上明确写着服务端错误
                 *   - `fenceOpen === true` ⇒ 回复停在未闭合围栏里，一定没写完
                 *
                 * ## 重试动作
                 *
                 * 先点页面自己的「继续生成」（同一条消息续写）；点不到就
                 * **重发原 prompt** —— 服务端可能已经恢复，新一次请求能过。
                 *
                 * ## 提醒用户
                 *
                 * 面板状态 + 控制台。重试耗尽后交付时还会在正文前加一条明确
                 * 警告 —— 宁可让用户看到「这次没成功」，也不要给一个看起来
                 * 成功、实际半截的结果。
                 */
                const RETRY_MAX = 3
                /**
                 * ⚠️ 三个判据都要判 —— 它们覆盖**不同的截断形态**：
                 *
                 *   - `serverError`：页面明确写了服务端错误（最直接）
                 *   - `fenceOpen`：围栏计数为奇数（渲染前的截断）
                 *   - `codeTrailingIncomplete`：围栏成对但**代码块正文没写完**
                 *
                 * 第三条是实测补上的：网页版的 markdown 渲染器会给未闭合的围栏
                 * **自动补闭合**，所以从 DOM 读出来的围栏永远成对 —— 只靠前两条
                 * 会漏判，半截工具调用照样交付（实测 `const r = await tools.write({`）。
                 */
                const incompleteReason =
                  serverError !== ''
                    ? `服务端提示「${serverError}」`
                    : fenceOpen === true
                      ? '回复停在未闭合的代码围栏里（工具调用被截断）'
                      : codeTrailingIncomplete === true
                        ? '代码块正文没写完（工具调用被截断，围栏由页面自动补全）'
                        : ''
                if (incompleteReason !== '' && retryCountRef.current < RETRY_MAX) {
                  retryCountRef.current += 1
                  console.warn(
                    `[dsh-webin] 本轮回复不完整：${incompleteReason} —— 第 ${retryCountRef.current}/${RETRY_MAX} 次重试`,
                    { serverError, fenceOpen, codeTrailingIncomplete, chars: last.length },
                  )
                  /** ⭐ 提醒用户（面板状态栏）。 */
                  setStatus(
                    `回复被中断：${incompleteReason}\n正在自动重试（第 ${retryCountRef.current}/${RETRY_MAX} 次）…`,
                  )
                  /**
                   * 重试动作一：点页面自己的「继续生成」。
                   * 服务端已恢复时这是最省事、语义最正确的一条路。
                   */
                  const contRaw2 = await execJs<string>(
                    el,
                    buildContinueScript(sendHintsFor(provider)),
                    8_000,
                  )
                  let retried = false
                  if (contRaw2 !== EXEC_TIMEOUT) {
                    try {
                      if ((JSON.parse(String(contRaw2)) as { ok?: boolean }).ok === true) retried = true
                    } catch {
                      /* 解析失败按「点不到」处理 */
                    }
                  }
                  /**
                   * 重试动作二：点不到「继续生成」⇒ **重发原 prompt**。
                   * 服务端限流通常几秒就恢复，新一次请求比死等有效。
                   */
                  if (!retried && promptRef.current !== '') {
                    const fillRaw2 = await execJs<string>(
                      el,
                      buildFillScript(promptRef.current, sendHintsFor(provider)),
                      30_000,
                    )
                    if (fillRaw2 !== EXEC_TIMEOUT) {
                      await new Promise((r) => setTimeout(r, pickSendDelay(currentConfig())))
                      const trigRaw2 = await execJs<string>(
                        el,
                        buildTriggerScript(sendHintsFor(provider), promptRef.current),
                        15_000,
                      )
                      if (trigRaw2 !== EXEC_TIMEOUT) {
                        try {
                          if ((JSON.parse(String(trigRaw2)) as { ok?: boolean }).ok === true) retried = true
                        } catch {
                          /* 按失败处理 */
                        }
                      }
                    }
                  }
                  console.log(
                    retried
                      ? '[dsh-webin] 重试已发出 —— 等页面重新生成'
                      : '[dsh-webin] 重试没能发出（继续按钮与重发都失败）—— 稍后再试',
                  )
                  /** 重置静默计时，给页面时间重新进入生成态。 */
                  scrapedChangedAtRef.current = Date.now()
                  return
                }
                /** 重试耗尽仍不完整 ⇒ 交付时带警告（见下面的 deliveredText）。 */
                if (incompleteReason !== '') {
                  console.warn(
                    `[dsh-webin] 重试 ${RETRY_MAX} 次后仍不完整（${incompleteReason}）—— 交付并标注警告`,
                  )
                  setStatus(`回复被中断且重试未成功：${incompleteReason}\n已把现有内容交付，并在开头标注警告。`)
                }

                if (continueCountRef.current < CONTINUE_MAX) {
                  const contRaw = await execJs<string>(
                    el,
                    buildContinueScript(sendHintsFor(provider)),
                    8_000,
                  )
                  if (contRaw !== EXEC_TIMEOUT) {
                    let cont: { ok?: boolean; reason?: string; how?: string } = {}
                    try {
                      cont = JSON.parse(String(contRaw)) as typeof cont
                    } catch {
                      /* 解析失败按「点不到」处理 */
                    }
                    if (cont.ok === true) {
                      continueCountRef.current += 1
                      console.log(
                        `[dsh-webin] 网页版已停止但页面有「继续生成」—— 已点击续写（第 ${continueCountRef.current}/${CONTINUE_MAX} 次）`,
                        { how: cont.how },
                      )
                      /**
                       * 重置静默计时并给页面一点时间重新进入生成态。
                       * **不重置基线** —— 续写会往同一条消息里追加，
                       * 条数不变、内容变长，基线保持原样才能正确判定「内容变化」。
                       */
                      scrapedChangedAtRef.current = Date.now()
                      return
                    }
                  }
                }

                /**
                 * ## ⭐⭐⭐ 看门狗（照抄 cuckoo `bridge/loop/watchdog.ts` 的本质）
                 *
                 * ## 对应的场景（用户实测两次）
                 *
                 * 模型长时间思考（46 秒）后**服务端把生成停了** ——
                 * 正文一个字没写，页面停在「已停止」+「继续生成」。
                 * 早期行为：把思考当回复交付（42KB）/ 卡到超时。
                 *
                 * ## cuckoo 的做法（本质照抄，信号换成了 DOM 静默）
                 *
                 * cuckoo：SSE 流静默超阈值 ⇒ 发提示词「请继续」催模型接着写，
                 * 最多 3 次；3 次还不动才算完。
                 *
                 * 我的信号：DOM 静默（内容没变 + 不在生成中）⇒ 同样的动作。
                 * SSE 静默检测用不了（hook 是 dom-ready 注入，晚于页面脚本，
                 * 抓不到完整流）—— 但 DOM 静默是等价信号：生成中页面每 1.5s
                 * 都在变，静默 = 断流。
                 *
                 * ## 判据
                 *
                 *   - 内容静默 ≥ 12 秒（STABLE_MS 的 4 倍 —— 正常停顿 3 秒内）
                 *   - 且**不在生成中**（停止按钮不在）
                 *   - 且**正文从未出现过**（交付了思考就是白交 —— 判据：
                 *     最后内容是「长思考+短正文」的形状不可靠，改用
                 *     「本轮已交付过思考？没有」+ 思考存在 ⇒ 大概率只思考完）
                 *   - 催继续最多 3 次（WATCHDOG_MAX），每次间隔 12 秒
                 *   - 3 次后放弃 ⇒ 正常交付（有什么交什么）
                 */
                const IDLE_WATCH_MS = 12_000
                if (
                  now - scrapedChangedAtRef.current >= IDLE_WATCH_MS &&
                  think.length > 0 &&
                  watchdogCountRef.current < 3
                ) {
                  watchdogCountRef.current += 1
                  console.log(
                    `[dsh-webin] 看门狗：流静默 ${Math.round((now - scrapedChangedAtRef.current) / 1000)}s 且只有思考（第 ${watchdogCountRef.current}/3 次催继续）`,
                  )
                  /**
                   * 催继续 = 把「请继续」打进输入框并点发送。
                   * 复用 fill/trigger 两段式（与正式发送同一套可靠路径）。
                   */
                  void (async () => {
                    try {
                      const fillRaw = await execJs<string>(
                        el,
                        buildFillScript('请继续', sendHintsFor(provider)),
                        30_000,
                      )
                      if (fillRaw === EXEC_TIMEOUT) return
                      await new Promise((r) => setTimeout(r, pickSendDelay(currentConfig())))
                      await execJs<string>(
                        el,
                        buildTriggerScript(sendHintsFor(provider), '请继续'),
                        15_000,
                      )
                      /** 催完重置静默计时 + 记住新的基线（消息列表又长了一条）。 */
                      scrapedChangedAtRef.current = Date.now()
                      baselineRef.current = count
                      baselineTextRef.current = last
                    } catch {
                      /* 催失败不致命 —— 走原来的交付路径 */
                    }
                  })()
                  return
                }

                console.log('[dsh-webin] DOM 读到本轮回复', {
                  chars: last.length,
                  thinkChars: think.length,
                  count,
                  判据: countGrew ? '条数增长' : '内容变化',
                  静默ms: now - scrapedChangedAtRef.current,
                  selector: scraped.selector,
                })
                clearPending()
                /**
                 * ⭐ 不完整时在正文前加一条**明确警告**。
                 *
                 * 用户要的是「提醒用户」—— 面板状态栏容易被忽略，而这条会跟着
                 * 回复一起进 DSH 对话，用户一定看得到。宁可显得啰嗦，也不要让
                 * 一个半截结果看起来像成功。
                 */
                const deliveredText =
                  incompleteReason === ''
                    ? lastClean
                    : `⚠️ **本次回复不完整**：${incompleteReason}。\n` +
                      `已自动重试 ${RETRY_MAX} 次仍未成功，以下内容可能被截断（例如工具调用断在半句）。\n` +
                      `建议：稍等片刻后重新发送，或在 LDW 面板里点「继续生成」。\n\n---\n\n` +
                      lastClean
                const chatUrlRaw = await execJs<string>(el, 'location.href', 8_000)
                const chatUrl = chatUrlRaw === EXEC_TIMEOUT ? '' : String(chatUrlRaw)
                await fetchJson(`/dsh-webin/api/job/${jobId}/result`, {
                  method: 'PUT',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({
                    text: deliveredText,
                    think,
                    status: 'finished',
                    via: 'dom',
                    ...(chatUrl === '' ? {} : { chatUrl }),
                  }),
                })
                return
              }

              /**
               * ## ⭐⭐⭐ 早期放弃：发出后 30 秒页面**确实没动静** ⇒ 根本没发出去
               *
               * ## 用户实测（真实事故：页面在生成，插件却报「没发出去」）
               *
               * 网页版正在**思考阶段**（还没开始渲染正文）时，插件的 DOM 读取
               * 什么都看不到：
               *   - `.ds-markdown`（回复容器）还没出现 ⇒ 条数没增长
               *   - 内容没变化
               *   - 思考区也没读到（选择器可能已变）
               *
               * 三个条件同时成立 ⇒ 30 秒就报「消息似乎没有发出去」并**判本轮失败**，
               * 而网页版其实正在正常生成 —— 用户看到 DSH 停了、网页版还在转。
               *
               * ## 修法：`generating` 一票否决
               *
               * 页面在生成（停止按钮在）就**证明消息送到了** —— 这是比「DOM 有没有
               * 变化」可靠得多的信号。所以 `generating === true` 时绝不放弃。
               *
               * 其余条件保持不变（真要判断「没发出去」，那三条仍然是对的）。
               *
               * ⚠️ 必须放在「交付判据」**之后**：先看有没有结果可交，
               * 没有再判是不是压根没发出去。
               */
              if (
                waitedMs > EARLY_GIVE_UP_MS &&
                !countGrew &&
                !contentChanged &&
                think.trim() === '' &&
                /** ⭐ 页面在生成 ⇒ 消息一定发出去了，绝不判失败。 */
                generating !== true &&
                /**
                 * ⭐⭐ **抓取必须真的看见了页面**才允许下结论。
                 *
                 * 抓取是瞎的（ok=false：一个回复容器都没找到）时，「条数没增长 /
                 * 内容没变化」跟「页面确实没动静」无法区分 —— 而思考阶段恰好
                 * 就是这种状态（还没有 .ds-markdown）。这正是用户反复被误报的现场。
                 *
                 * 看不见就**不下结论**，继续等（最坏走 giveUpMs 硬超时）。
                 */
                scrapedOk === true
              ) {
                console.warn('[dsh-webin] 发出后 30 秒页面无动静，判定没发出去', {
                  waitedMs,
                  count,
                  baseline: baselineRef.current,
                  lastChars: last.length,
                  generating,
                  scrapedOk,
                  selector: scraped.selector,
                })
                clearPending()
                await fetchJson(`/dsh-webin/api/job/${jobId}/result`, {
                  method: 'PUT',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({
                    error:
                      '消息似乎没有发出去：发出后 2 分钟内网页版没有任何反应' +
                      '（既没有新消息，也没有开始生成）。请确认 LDW 页面正常后重试。',
                  }),
                })
                return
              }
            } catch {
              /* 解析失败就等下一轮 */
            }
          }
        }

        if (hasPending && waitedMs > giveUpMs) {
          const stuck = pendingJobRef.current!
          console.warn('[dsh-webin] 待办超时，放弃任务', stuck, { waitedMs, giveUpMs })
          clearPending()
          await fetchJson(`/dsh-webin/api/job/${stuck}/result`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              error:
                `等待网页回复超时（${Math.round(giveUpMs / 1000)} 秒）。` +
                '页面上没有可读取的回复内容 —— 请检查网页版里的状态。',
            }),
          })
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
        /**
         * ## ⭐ 领活必须带上**本窗口的会话身份**（用户报的「所有窗口都生效」）
         *
         * host 据此只派发属于本会话的任务。不带的话任何窗口都能领走任何
         * 任务 —— 用户实测：「换了几个 dsh 窗口聊天，发现全都是在网页版的
         * 同一个会话窗口」。
         *
         * `sessionIdRef` 由 `LdwPlaceholder`（挂 `conversation.view`）从
         * DSH 给的 standardProps 写入 —— 是**官方 prop**，不是猜的。
         *
         * ⚠️ 没拿到时不带这个参数（host 退回按平台派发），
         * 而不是拿一个空串去匹配 —— 那会导致谁也领不到活。
         */
        const sid = sessionIdRef.current
        const query =
          '/dsh-webin/api/job/next?platform=' +
          encodeURIComponent(provider.id) +
          (sid === '' ? '' : '&session=' + encodeURIComponent(sid)) +
          (running === undefined ? '' : '&running=' + encodeURIComponent(running))
        /**
         * ⚠️ **领活请求也必须带超时**（审计发现）。
         *
         * 裸 `await fetch` 在 host 卡住时会永远挂着 —— 而 `busy` 已经是
         * `true` ⇒ 发送循环**永久停摆**，且没有任何报错可捕获。
         * 超时后直接 return（下一轮 1.5s 后再试），循环保持活着。
         */
        const res = await fetchJson(query, undefined, 10_000)
        if (res === undefined || !res.ok) return
        const data = (await res.json()) as {
          ok: boolean
          job: { id: string; prompt: string; thinking: boolean; expectUrl?: string; freshChat?: boolean } | null
          /** host 说这个任务已被取消。 */
          cancel?: string
        }

        // 被取消：去按页面的停止按钮，并清掉本地待办
        if (typeof data.cancel === 'string' && data.cancel !== '') {
          console.log('[dsh-webin] 任务已被取消，停止页面生成', data.cancel)
          clearPending()
          /**
           * ⚠️ 必须**一并清掉上一轮的比对状态**。
           *
           * 否则下一个任务会用「上一轮的内容」做稳定性比对 ——
           * `scrapedRef.current !== last` 立刻成立，可能把上一条回复
           * 当成新回复交回去（张冠李戴）。
           */
          scrapedRef.current = undefined
          baselineRef.current = 0
          baselineTextRef.current = ''
          /** ⚠️ 带超时 —— 停止脚本卡住会让这个 tick 永远不返回。 */
          const stopResult = await execJs(el, buildStopScript(sendHintsFor(provider)), 10_000)
          console.log('[dsh-webin] 停止结果', stopResult === EXEC_TIMEOUT ? '超时' : stopResult)
          return
        }

        // 还有任务在等回复 ⇒ 不领新活（否则会插队打断当前生成）
        if (hasPending) return

        if (stopped || data.job === null || data.job === undefined) return

        const { id, prompt } = data.job

        /**
         * ⭐ 记下提示词 —— 诊断时用它做 needle。
         *
         * ## 为什么（用户的关键观察：「网页版都是一个字一个字蹦出来的」）
         *
         * 回复是**流式逐字渲染**的。这意味着：
         *   1. 回复**确实在 DOM 里**（用户看得见）—— 我之前「消息不在
         *      DOM 里」的结论是错的：那是**发消息前的一瞬**抓的快照
         *   2. 所以诊断的 needle 必须用**提示词本身**（它作为用户消息
         *      一定在页面上），而不是「上次抓到的内容」（那可能是侧边栏）
         */
        promptRef.current = prompt

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
          const currentRaw = await execJs<string>(el, 'location.href', 8_000)
          const current = currentRaw === EXEC_TIMEOUT ? '' : String(currentRaw)
          if (current !== data.job.expectUrl) {
            console.log('[dsh-webin] 切换到该会话的对话', {
              from: current.slice(-48),
              to: data.job.expectUrl.slice(-48),
            })
            await element_loadURL(el, data.job.expectUrl)
            /** 等页面就绪（输入框出现），最多 25s；失败则继续用当前页发。 */
            const readyRaw = await execJs<unknown>(el,
              
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
              30_000,
            )
            /** 超时/异常一律视为「没就绪」—— 后面警告但仍尝试发送。 */
            const ready = readyRaw === true
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
          const currentRaw = await execJs<string>(el, 'location.href', 8_000)
          const current = currentRaw === EXEC_TIMEOUT ? '' : String(currentRaw)
          /**
           * 只在**确实停在某个对话里**时才导航 —— 已经在首页/新对话就不动，
           * 避免多余的页面重载（每次重载都是一次真实的浏览器行为，
           * 频繁重载本身就是可疑模式）。
           */
          const inChat = /\/a\/chat\/s\//.test(current)
          if (inChat) {
            console.log('[dsh-webin] 首轮：开新对话（不占用当前页）', { from: current.slice(-48) })
            await element_loadURL(el, provider.homeUrl)
            /** ⚠️ 带超时 —— 否则导航途中脚本死掉会让这个 tick 永远不返回。 */
            const freshReady = await execJs<unknown>(
              el,
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
              30_000,
            )
            if (freshReady !== true) console.warn('[dsh-webin] 新对话页未见输入框，仍尝试发送')
          }
        }

        pendingJobRef.current = id
        pendingSinceRef.current = Date.now()
        scrapedRef.current = undefined
        /**
         * 记下「派发前页面上已有几条回复」—— 之后靠条数增长判断本轮回复到位。
         *
         * 取不到就保守用 0（那样只要页面上有一条够长的内容就会被当成本轮结果）。
         * 代价是可能把上一条回复误交回去，所以**发送前**读更稳 ——
         * 此刻页面还没生成新内容。
         */
        {
          /**
           * ⭐ 基线也用「先滚后抓」—— 否则基线读到的是滚动前的内容，
           * 而交付时读到的是滚动后的 ⇒ 同一个页面两次读数不一致，
           * 「内容变化」判据会误报（真实事故的相关因素）。
           */
          const baseRaw = await scrapeWithScroll(el, 8_000)
          if (baseRaw !== EXEC_TIMEOUT) {
            try {
              const base = JSON.parse(String(baseRaw)) as { count?: number; last?: string }
              baselineRef.current = typeof base.count === 'number' ? base.count : 0
              baselineTextRef.current = typeof base.last === 'string' ? base.last : ''
              /** 基线读完就重置「变化时刻」—— 新任务从此刻开始算静默。 */
              scrapedChangedAtRef.current = Date.now()
            } catch {
              baselineRef.current = 0
              baselineTextRef.current = ''
              scrapedChangedAtRef.current = Date.now()
            }
          } else {
            /**
             * ## ⚠️ 基线读取**超时**时必须也重置（修掉的真实 bug）
             *
             * 早期这个分支**什么都不做** —— 于是 `baselineRef` 保留
             * **上一轮**的值。而 `scrapedRef` 在上面已经清成 `undefined`。
             *
             * 后果很隐蔽：
             *   - 上一轮结束时页面有 5 条回复 ⇒ `baselineRef = 5`
             *   - 本轮页面也是 5 条（新回复还没渲染）⇒ `countGrew = false`
             *   - `baselineTextRef` 还是上一轮的内容 ⇒ 若内容恰好相同，
             *     `contentChanged = false`
             *   - ⇒ **两个判据都不成立**，一路等到早放弃 / 超时
             *
             * 用户看到的就是「网页版早就有答案了，DSH 还在等」。
             *
             * 重置成 0 的代价：本轮可能把「页面上最长的那条内容」当成本轮结果。
             * 但这有 `STABLE_MS` 静默判据兜底，而且**比卡死好** ——
             * 卡死是用户明确报过的、最难受的现象。
             */
            console.warn('[dsh-webin] 基线读取超时，重置为 0（宁可放宽也不卡死）')
            baselineRef.current = 0
            baselineTextRef.current = ''
            scrapedChangedAtRef.current = Date.now()
          }
        }
        // 记录派发时刻：只接受此刻之后产生的 done 事件
        sentAtRef.current = Date.now()
        console.log('[dsh-webin] 领到任务', { id, chars: prompt.length })

        /**
         * ## 应用用户配置
         *
         * 1. **单轮请求上限** —— 工具循环可能连发很多轮，用户可以设个上限
         *    防止意外烧配额（到顶就交个错误让 DSH 停在这一轮）。
         * 2. **发送间隔** —— 从配置读，而不是硬编码 2000~4000ms。
         * 3. **长休** —— 连续 N 次请求后强制休息（默认关）。
         */
        noteTurnStart(id)
        if (!canSendThisTurn()) {
          console.warn('[dsh-webin] 本轮请求数已达上限，停止发送', { limit: currentConfig().maxRequestsPerTurn })
          clearPending()
          await fetchJson(`/dsh-webin/api/job/${id}/result`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              error: `本轮请求数已达上限（${currentConfig().maxRequestsPerTurn}），可在设置页调整`,
            }),
          })
          return
        }
        noteTurnRequest()

        const cfgNow = currentConfig()
        const breakMs = noteRequestDone()
        if (breakMs > 0) {
          /**
           * ## ⚠️ 长休必须**分段睡**，不能一觉睡到底（审计发现的 bug）
           *
           * 原实现是 `await new Promise(r => setTimeout(r, breakMs))` ——
           * 一口气睡最多 **3 分钟**（`longBreakMaxMs` 默认 180000）。
           * 那段时间里 `busy` 一直是 `true`，于是：
           *
           *   1. **用户按停止看不到反应** —— 循环在睡觉，不会去问 host
           *      「这个任务取消了吗」，页面继续白生成、烧配额；
           *   2. 用户切到别的 DSH 会话后，这个任务醒来仍会往**当前页面**发
           *      （而当前页面可能已经换成另一个会话的对话）⇒ 串台。
           *
           * 改成每 2 秒醒一次检查取消；被取消就立刻停止发送并交结果。
           * 这样「长休」只影响**发送时机**，不影响响应性。
           */
          console.log(`[dsh-webin] 长休 ${Math.round(breakMs / 1000)}s（每 ${cfgNow.longBreakAfter} 次请求休息一次）`)
          const deadline = Date.now() + breakMs
          let cancelledDuringBreak = false
          while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, Math.min(2_000, deadline - Date.now())))
            if (stopped) return
            /** 醒来先问一次「这个任务还算数吗」。 */
            const probe = await fetchJson(
              `/dsh-webin/api/job/next?platform=${encodeURIComponent(provider.id)}&running=${encodeURIComponent(id)}`,
              undefined,
              8_000,
            )
            if (probe !== undefined && probe.ok) {
              try {
                const p = (await probe.json()) as { cancel?: string }
                if (typeof p.cancel === 'string' && p.cancel !== '') {
                  console.log('[dsh-webin] 长休期间任务被取消，放弃发送', p.cancel)
                  cancelledDuringBreak = true
                  break
                }
              } catch {
                /* 解析失败就当没取消 */
              }
            }
          }
          if (cancelledDuringBreak) {
            /**
             * ⚠️ 被取消时**不交结果** —— host 那边已经把这个任务标记为
             * cancelled 并让调用方报错退出了，再交一次结果会 404
             * （或者更糟：覆盖掉真正的结果）。
             */
            clearPending()
            return
          }
        }

        /**
         * ## 先把页面的思考模式切到期望状态
         *
         * 「点的思考模式那个模型，发现没有思考啊」—— 根因是 host 把
         * `job.thinking` 传过来了，但这里**从来没用它做任何事**。
         *
         * ⚠️ 必须在**发送之前**做：思考模式是请求体的一部分，
         * 发出去之后再切就晚了（这一轮已经按旧模式跑了）。
         *
         * 切不动时**不阻断发送** —— 思考与否是增强，不是必需。
         * 但要明确告诉用户（否则又是一次「点了没反应」的静默失败）。
         */
        try {
          const thinkRaw = await execJs<string>(el, buildThinkingScript(data.job.thinking === true), 20_000)
          if (thinkRaw === EXEC_TIMEOUT) {
            console.warn('[dsh-webin] 思考模式脚本超时，跳过（不阻断发送）')
          } else {
            const think = JSON.parse(String(thinkRaw)) as {
              ok: boolean
              changed?: boolean
              before?: boolean
              after?: boolean
              reason?: string
              text?: string
            }
            if (think.ok === true) {
              if (think.changed === true) {
                console.log(`[dsh-webin] 思考模式已切换 ${think.before} → ${think.after}`, { 开关: think.text })
              }
            } else {
              console.warn('[dsh-webin] 思考模式未能切换', think)
              setLastSend({
                at: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
                how: `思考模式未切换（${think.reason ?? '未知'}）`,
                chars: 0,
              })
            }
          }
        } catch (error) {
          console.warn('[dsh-webin] 思考模式脚本失败', error)
        }

        /**
         * ## ⚠️ 用 `execJs` 而不是裸 `executeJavaScript`
         *
         * ## 三步拆开（照 cuckoo 的架构重构）
         *
         * 原来把「填充 → 等 2.4s 验证 → 可能再等 1.2s 重试」全塞进**一次**
         * `executeJavaScript`。那是跨进程调用，页面一导航就整体死掉
         * （不 resolve / 不 reject）⇒ 宿主永远等 ⇒「一直深度求索中」。
         *
         * cuckoo 的做法（`src/overlay/chat-input.ts:137-171`）：
         *
         *     const timer = setTimeout(() => triggerSend(input), sendDelay)
         *     return true        // ← 立刻返回，不等任何确认
         *
         * 即：**页面脚本只做瞬时动作，等待在客户端**。
         * 所以这里拆成三个短调用，中间由客户端控制节奏：
         *
         *     ① buildFillScript    —— 只填（几百毫秒）
         *     ② setTimeout          —— 随机延迟（防封号，客户端侧）
         *     ③ buildTriggerScript —— 只点发送（几十毫秒）
         *
         * 这样导航最多毁掉一次短调用，不会让整条链路僵死。
         */
        const fillRaw = await execJs<string>(
          el,
          buildFillScript(prompt, sendHintsFor(provider)),
          30_000,
        )

        if (fillRaw === EXEC_TIMEOUT) {
          clearPending()
          await fetchJson(`/dsh-webin/api/job/${id}/result`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ error: '填充输入框超时（页面可能正在导航），请重试。' }),
          })
          return
        }

        const fill = JSON.parse(String(fillRaw)) as {
          ok: boolean
          stage?: string
          message?: string
          how?: string
          chars?: number
        }
        console.log('[dsh-webin] 填充结果', fill)

        if (!fill.ok) {
          clearPending()
          await fetchJson(`/dsh-webin/api/job/${id}/result`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ error: `${fill.stage ?? 'fill-failed'}: ${fill.message ?? '填充失败'}` }),
          })
          return
        }

        /**
         * ② 随机延迟 —— **在客户端侧**（cuckoo 同款）。
         *
         * 页面脚本不该长时间持有 Promise：延迟放这里，
         * 单次 executeJavaScript 的存活时间就只有几十毫秒。
         */
        const gapMs = pickSendDelay(cfgNow.sendDelayMinMs, cfgNow.sendDelayMaxMs)
        console.log(`[dsh-webin] 已填入 ${fill.chars ?? prompt.length} 字符，${gapMs}ms 后触发发送`)
        await new Promise((r) => setTimeout(r, gapMs))

        /**
         * ## ⚠️ 点火前**最后一次检查**（审计发现的 bug）
         *
         * 从「填完字」到「真的按发送」之间隔了 2–4 秒。这段时间里用户可能：
         *   - 按了停止（host 把任务标记为 cancelled）
         *   - 切到别的 DSH 会话（当前网页对话已经不是这个任务该在的地方）
         *
         * 两种情况下都**不该再发出去** —— 否则要么发一条用户已经取消的消息，
         * 要么把内容发进**错误的对话**（上下文串台，用户实测报过这个）。
         *
         * 检查到取消就**清空输入框**（把已经填进去的字删掉，避免用户手动
         * 误发一条半截内容）。
         */
        {
          const probe = await fetchJson(
            `/dsh-webin/api/job/next?platform=${encodeURIComponent(provider.id)}&running=${encodeURIComponent(id)}`,
            undefined,
            8_000,
          )
          if (probe !== undefined && probe.ok) {
            try {
              const p = (await probe.json()) as { cancel?: string; job?: unknown }
              if (typeof p.cancel === 'string' && p.cancel !== '') {
                console.log('[dsh-webin] 点火前发现任务已取消，撤销发送', p.cancel)
                /** 清掉已填入的内容 —— 不要留下一条随时可能被误发的半截消息。 */
                await execJs(el, buildClearInputScript(sendHintsFor(provider)), 8_000)
                clearPending()
                return
              }
            } catch {
              /* 解析失败就按「没取消」继续（宁可发出也不要静默卡住） */
            }
          }
          if (stopped) return
        }

        /**
         * ③ 触发发送 —— **并确认页面真的接受了**。
         *
         * ## ⭐ 为什么现在要确认（用户报的「网页版早就有答案了，dsh 还在深度求索」）
         *
         * 早期这一步点完就返回 `ok:true`，**从不验证**。于是「点了但没生效」
         * （按钮被遮挡 / 是禁用态 / 点错了元素）时，插件以为发出去了，
         * 一路等一个**永远不会来的回复**。
         *
         * 用户看到的现象正是：
         *   - 网页版里**根本没有那条消息**（输入框还留着字，或者已被清空但没发）
         *   - DSH 一直「深度求索中」，直到超时
         *
         * 现在 `buildTriggerScript` 内部会等 1.2 秒探「输入框是否被清空」
         * （页面接受发送时一定会清空），失败就 `ok:false` ⇒ 这里立刻交错误。
         *
         * 超时给 15 秒：脚本内部最多等 1.2 秒，剩下的是跨进程开销余量。
         */
        const trigRaw = await execJs<string>(
          el,
          /**
           * ⚠️ 把**要发的字**传进去（第三个参数）—— trigger 会先核对
           * 输入框里确实是这段内容才点火。
           *
           * 原因：fill 和 trigger 之间隔 2–4 秒，页面可能重渲染换掉
           * 输入框节点。不核对的话会发空消息或什么都不发生，而插件不知道，
           * 继续等一个永远不会来的回复（用户报的「网页版里没那条消息」）。
           */
          buildTriggerScript(sendHintsFor(provider), prompt),
          15_000,
        )
        const trig =
          trigRaw === EXEC_TIMEOUT
            ? { ok: false, how: 'timeout', message: '触发发送超时（页面可能正在导航）' }
            : (JSON.parse(String(trigRaw)) as {
                ok: boolean
                how?: string
                method?: string
                message?: string
                confirmed?: boolean
                reason?: string
                left?: string
              })
        console.log('[dsh-webin] 触发结果', trig)

        if (trig.ok !== true) {
          clearPending()
          /**
           * 错误信息要**能照做** —— 用户看到「发送失败」时得知道下一步。
           *
           * 两种常见失败分开说：
           *   - `input-lost`      字不见了（页面重渲染）⇒ 重试
           *   - `input-not-cleared` 点了但没生效 ⇒ 重试
           */
          const detail =
            trig.reason === 'input-lost'
              ? '输入框里的内容在发送前丢失了（页面重渲染）—— 消息没有发出去，请重试。'
              : trig.reason === 'input-not-cleared'
                ? '消息没有真正发出去（输入框没被清空）。可能是页面还没就绪或按钮被遮挡，请重试。'
                : (trig.message ?? '触发发送失败')
          await fetchJson(`/dsh-webin/api/job/${id}/result`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ error: `send-failed: ${detail}` }),
          })
          return
        }

        /**
         * 发送已触发。
         *
         * `sentAtRef` 是「只接受此刻之后的 done 事件」的时间基准；
         * 同时它也被下面的 **DOM 轮询**当成「什么时候可以开始读回复」的起点。
         *
         * ⚠️ 这里**不代表发送一定成功** —— cuckoo 也不验证（点完就算发了）。
         * 我们靠后续的 DOM 轮询来确认「页面上真的出现了新回复」。
         */
        sentAtRef.current = Date.now()
        setLastSend({
          at: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
          /** 现在能说「已确认」了 —— `buildTriggerScript` 探过输入框是否被清空。 */
          how: `${trig.method ?? trig.how ?? '?'}（已确认发出，等待页面回复）`,
          chars: prompt.length,
        })
        // 不在这里交结果 —— 由 DOM 轮询 / hook 事件来交。
      } catch (error) {
        /**
         * ## ⚠️ 异常**必须交回 host**，否则 DSH 永远等
         *
         * 用户实测：网页版那边回复已经完成了，但 DSH 一直转圈等到超时。
         *
         * 根因就在这里 —— 早期实现只打一行日志：
         *
         *     } catch (error) {
         *       console.warn('[dsh-webin] 任务处理失败', error)   // ← pendingJobRef 已置位
         *     }
         *
         * 此时 `pendingJobRef` 已经有值（领到任务时就置了），而结果**永不交回**
         * ⇒ host 侧一直等 ⇒ DSH 一直等。任何异常都会触发：
         * `executeJavaScript` 超时、页面在发送途中导航、`JSON.parse` 失败…
         *
         * 而且下一轮 `tick` 因为 `hasPending` 为真**再也不领新活**，
         * 整个链路就此僵死。
         *
         * 所以：异常也要把任务了结掉（交个错误），并**清掉待办**。
         */
        console.warn('[dsh-webin] 任务处理失败', error)
        const stuck = pendingJobRef.current
        clearPending()
        if (stuck !== undefined) {
          void fetchJson(`/dsh-webin/api/job/${stuck}/result`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              error: `客户端处理异常：${(error as Error)?.message ?? String(error)}`,
            }),
          })
        }
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
      /** ⚠️ 带超时 —— 这个每 30s 跑一次，裸调用会在导航时堆积死掉的 Promise。 */
      void execJs<string>(el, buildSnapshotScript(), 10_000)
        .then(async (raw) => {
          if (stopped) return
          if (raw === EXEC_TIMEOUT) return
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
          /**
           * ## ⭐ 顺便让 host 抓一次**含 httpOnly** 的 cookie
           *
           * 页面侧的 `document.cookie` 看不见 httpOnly —— 而那正是
           * DeepSeek 登录态的载体。host 半跑在 Electron 主进程里，
           * 能用 `session.fromPartition(partition).cookies` 读到全部。
           *
           * partition 名已经由 client 在挂载 webview 时上报过，
           * 所以这里只需要说一句「现在存」。
           *
           * ⚠️ 失败**不影响**页面快照（那是另一条独立的恢复路径）——
           * 拿不到 electron API 时这里会 501，属于预期降级。
           */
          void fetchJson(`/dsh-webin/api/auth/${encodeURIComponent(provider.id)}/cookies`, {
            method: 'POST',
          }).then((res) => {
            if (stopped || res === undefined) return
            if (!res.ok) {
              /** 501 = 环境不支持（纯 node）；409 = 还没上报 partition。都不是致命错。 */
              console.log('[dsh-webin] cookie 存档跳过', res.status)
              return
            }
            void res
              .json()
              .then((j: { count?: number; domain?: string }) => {
                console.log('[dsh-webin] httpOnly cookie 已存档', {
                  count: j.count ?? 0,
                  domain: j.domain ?? '',
                })
              })
              .catch(() => undefined)
          })
          console.log('[dsh-webin] 登录态快照已存入 host', {
            keys: Object.keys(parsed.localStorage ?? {}),
            cookieChars: (parsed.cookie ?? '').length,
          })
        })
        .catch(() => undefined)
    }
    save()
    /** 快照间隔从配置读（设置页可调），默认 30s。 */
    const timer = window.setInterval(save, Math.max(5_000, currentConfig().snapshotIntervalMs))
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
              /**
               * ## 诊断要回答「DOM 抓取到底看到了什么」
               *
               * 现在整个设计押在 DOM 抓取上，所以诊断必须包含它 ——
               * 否则用户说「还是不行」时我只能靠猜。
               *
               * 两份数据合并：
               *   1. `buildDiagnoseScript` —— 输入框/按钮/POST 路径
               *   2. `buildScrapeScript`   —— **它实际读到了哪几条回复**
               *      （`count` / `selector` / 每条的长度与前 80 字）
               */
              void (async () => {
                try {
                  const raw = await execJs<string>(el, buildDiagnoseScript(sendHintsFor(provider)), 15_000)
                  const base = raw === EXEC_TIMEOUT ? '{"error":"诊断脚本超时"}' : String(raw)
                  /** ⭐ 诊断也走「先滚后抓」—— 否则诊断看到的是滚动前的页面（旧内容）。 */
                  const scrapeRaw = await scrapeWithScroll(el, 12_000)
                  /**
                   * ## ⭐ 导出页面真实结构（发现类名，而不是猜）
                   *
                   * ## 为什么必须做（trace 给出的决定性证据）
                   *
                   * 端到端跑完读 trace，拿到：
                   *
                   *     .ds-markdown          → found: 0
                   *     [class*="markdown"]   → found: 0   ← 极宽泛的匹配也是 0！
                   *     root: "body"                        ← 没有 main
                   *
                   * `[class*="markdown"]` 命中 0 说明页面上**根本没有**
                   * 带 "markdown" 的类名 —— 我的候选表整个是错的。
                   *
                   * 继续猜没意义，所以这里把结构导出来：
                   *   - `chain`：含「最后一条回复文字」的元素祖先链
                   *     ⇒ 回复容器与消息列表容器都在这条链上
                   *   - `topClasses`：出现 >= 2 次的类名频次
                   *   - `cands`：各候选选择器**实际命中几个**
                   *
                   * needle 用「最后一条回复的前 20 字」—— 那是页面上
                   * 一定存在的文字，用它反查容器最可靠。
                   */
                  const scrapeForNeedle =
                    scrapeRaw === EXEC_TIMEOUT
                      ? ''
                      : (() => {
                          try {
                            const s = JSON.parse(String(scrapeRaw)) as { last?: string }
                            return String(s.last ?? '').slice(0, 20)
                          } catch {
                            return ''
                          }
                        })()
                  const domRaw = await execJs<string>(el, buildDomReportScript(scrapeForNeedle), 15_000)
                  let merged = base
                  try {
                    const parsed = JSON.parse(base) as Record<string, unknown>
                    if (domRaw !== EXEC_TIMEOUT) {
                      try {
                        parsed.dom = JSON.parse(String(domRaw)) as unknown
                      } catch {
                        parsed.dom = { error: 'DOM 报告 JSON 解析失败' }
                      }
                    }
                    if (scrapeRaw !== EXEC_TIMEOUT) {
                      const s = JSON.parse(String(scrapeRaw)) as {
                        ok?: boolean
                        count?: number
                        selector?: string
                        last?: string
                        think?: string
                      }
                      parsed.scrape = {
                        ok: s.ok === true,
                        /** 读到几条回复 —— 这里若是 0，说明选择器没匹配上。 */
                        count: s.count ?? 0,
                        /** 命中的选择器（`longest-div` = 走了兜底）。 */
                        selector: s.selector ?? '',
                        最后一条长度: (s.last ?? '').length,
                        最后一条开头: (s.last ?? '').slice(0, 80),
                        思考长度: (s.think ?? '').length,
                      }
                    } else {
                      parsed.scrape = { error: 'DOM 抓取脚本超时' }
                    }
                    merged = JSON.stringify(parsed, null, 2)
                  } catch {
                    /* JSON 解析失败就用原文 */
                  }
                  setDiagnosis(merged)
                  console.log('[dsh-webin] 页面结构诊断', merged)
                } catch (e) {
                  setDiagnosis(`诊断失败：${String(e)}`)
                }
              })()
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
/**
 * ## LDW 设置页（`settings.section`）
 *
 * 用户实测反馈：「dsh 插件没有设置页面」。
 *
 * ## 注册契约（从生态里实测出来的，两个坑）
 *
 * 1. **`register` 必须带 `name` 字段**（就是 slot 名）—— 少了它注册不上，
 *    而且**不报错**，表现为设置页里凭空少一项，极难排查。
 * 2. **渲染函数必须返回 React 元素**（`createElement(...)`）。
 *    直接返回字符串/数组/`undefined` 会触发 **React #130**
 *    （"Element type is invalid"），整个设置面板白屏。
 *
 * 所以下面 `register(options, () => createElement(Panel))` 这个形状不能省。
 *
 * ## 为什么用 host 的 `/providers` 而不是把数据塞进 props
 *
 * 设置页与对话区是**两个独立挂载点**，共享的只有 host 的状态。
 * 所以面板自己去 `GET /dsh-webin/api/providers` 拉数据，
 * 增删也走同一套 API —— 与「provider 可从磁盘热加载」的设计一致。
 */
const LDW_API = '/dsh-webin/api'

/** 版本 / 更新检查状态。 */
interface VersionState {
  version: string
  commit: string
  repo: string
  repoUrl: string
  starUrl: string
  updateHint: string
  /** 构建时刻（ISO）—— 让用户确认「这份是什么时候构建的」。 */
  builtAt?: string
  update?: {
    ok: boolean
    reason?: string
    latestCommit?: string
    latestMessage?: string
    latestAt?: string
    behind?: boolean
    /** 本地提交与远端相同。 */
    same?: boolean
    /** 本地提交比远端新（自己提交了没推）。 */
    ahead?: boolean
    checkedAt: number
  }
}

/** 设置页用的 host 状态形状（与 `GET /providers` 的响应对应）。 */
interface SettingsState {
  providers: Provider[]
  /** 用户自定义的 provider id（只有这些能删）。 */
  customIds: string[]
  defaultProviderId: string
  errors: { file: string; reason: string }[]
  clients: { clientId: string; platform: string; loggedIn: boolean; replyCount: number; at: number }[]
  /**
   * 登录过的平台（判据是**持久化快照**，不是「浏览器此刻在线」）。
   *
   * 未登录的平台不会列出模型，所以这个字段决定设置页显示
   * 「已登录」还是「去登录」。
   */
  loggedInPlatforms: string[]
}

/** 配置表单的字段描述（决定分组与渲染方式）。 */
interface FieldSpec {
  key: keyof WebinConfig
  label: string
  /** 单位（ms 会自动显示成秒，便于阅读）。 */
  unit?: string
  hint?: string
  /** 布尔字段渲染成开关。 */
  bool?: boolean
  /** 数值字段的显示换算（存 ms，显示秒）。 */
  scale?: number
}

/**
 * 配置分组。
 *
 * 分组不是装饰 —— 用户面对 11 个数字会懵。按**意图**分成三组：
 *   - 防封号：担心账号安全时来这调
 *   - 行为：遇到超时/截断时来这调
 *   - 诊断：出问题时来这看
 */
const FIELD_GROUPS: { title: string; note: string; fields: FieldSpec[] }[] = [
  {
    title: '防封号',
    note: '网页版对请求密度敏感。调更保守 = 更慢但更安全。',
    fields: [
      { key: 'sendDelayMinMs', label: '发送间隔下限', unit: 'ms', scale: 1000 },
      { key: 'sendDelayMaxMs', label: '发送间隔上限', unit: 'ms', scale: 1000 },
      {
        key: 'longBreakAfter',
        label: '每 N 次请求后长休',
        unit: '次',
        hint: '0 = 关闭。工具循环连跑十几轮时能压低密度。',
      },
      { key: 'longBreakMinMs', label: '长休时长下限', unit: 'ms', scale: 1000 },
      { key: 'longBreakMaxMs', label: '长休时长上限', unit: 'ms', scale: 1000 },
      {
        key: 'maxRequestsPerTurn',
        label: '单轮请求上限',
        unit: '次',
        hint: '0 = 不限。防止工具循环意外烧配额。',
      },
    ],
  },
  {
    title: '行为',
    note: '遇到超时、结果被截断时来这调。',
    fields: [
      { key: 'replyTimeoutMs', label: '等网页回复超时', unit: 'ms', scale: 1000 },
      { key: 'claimGraceMs', label: '浏览器未打开时的快速失败', unit: 'ms', scale: 1000 },
      {
        key: 'toolResultLimit',
        label: '工具结果截断',
        unit: '字符',
        hint: '太大可能把输入框顶爆；太小模型看不到关键内容。',
      },
      {
        key: 'enableTools',
        label: '允许调用工具',
        bool: true,
        hint: '关掉后模型收不到工具目录，只能纯聊天。',
      },
      { key: 'snapshotIntervalMs', label: '登录态快照间隔', unit: 'ms', scale: 1000 },
    ],
  },
  {
    title: '诊断',
    note: '出问题时打开，看浏览器控制台。',
    fields: [{ key: 'verboseLog', label: '详细日志', bool: true }],
  },
]

/** 设置页面板。 */
export function LdwSettings(): unknown {
  const [state, setState] = useState<SettingsState | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [draft, setDraft] = useState('')
  /** 配置表单的本地编辑态（保存前不生效）。 */
  const [form, setForm] = useState<WebinConfig | null>(null)
  const [problems, setProblems] = useState<{ field: string; reason: string }[]>([])
  const [showAdd, setShowAdd] = useState(false)
  /** 版本 + 更新检查状态。 */
  const [ver, setVer] = useState<VersionState | null>(null)
  const [checking, setChecking] = useState(false)
  const [checkNote, setCheckNote] = useState('')

  /**
   * 拉版本信息。
   *
   * ⚠️ `check=1` 才真的打 GitHub —— 默认只回本地版本。
   * 未认证的 API 每小时 60 次配额，设置页一打开就查会很快打光。
   */
  const loadVersion = useMemo(
    () => async (check: boolean) => {
      if (check) setChecking(true)
      try {
        /**
         * ⚠️ **必须带超时**（真实 bug）。
         *
         * 早期直接 `await fetch(...)` —— 而 `?check=1` 会让 host 去问
         * GitHub。国内网络下那次请求**可能一直挂着不报错**，
         * 于是这个 fetch 永不返回 ⇒ 按钮永远显示「检查中…」。
         *
         * 用户报的就是这个：「插件更新的逻辑貌似有bug」。
         *
         * host 侧那次请求自己有 10 秒超时，这里给 20 秒（留出余量），
         * 兜住「host 整个卡住」的情况。
         */
        const res = await fetchJson(`${LDW_API}/version${check ? '?check=1' : ''}`, undefined, 20_000)
        if (res === undefined) {
          if (check) setCheckNote('检查失败：请求超时（host 无响应）')
          return
        }
        const data = (await res.json()) as VersionState & { ok?: boolean }
        setVer({
          version: String(data.version ?? '?'),
          commit: String(data.commit ?? '?'),
          repo: String(data.repo ?? ''),
          repoUrl: String(data.repoUrl ?? ''),
          starUrl: String(data.starUrl ?? ''),
          updateHint: String(data.updateHint ?? ''),
          builtAt: String(data.builtAt ?? ''),
          ...(data.update === undefined ? {} : { update: data.update }),
        })
        if (check) {
          /**
           * 用 host 给的一句话总结（四种状态分开说）。
           *
           * 早期这里自己拼：「behind ? 有新提交 : 已是最新」——
           * 于是「本地比远端新」（自己提交了没推）也显示成「已是最新」，
           * 用户会困惑「我明明改了代码」。
           */
          const summary = (data as { updateSummary?: string }).updateSummary
          setCheckNote(
            typeof summary === 'string' && summary !== ''
              ? summary
              : data.update?.ok !== true
                ? `检查失败：${data.update?.reason ?? '未知原因'}`
                : data.update?.behind === true
                  ? `有新提交 ${data.update.latestCommit}`
                  : data.update?.ahead === true
                    ? '本地更新（远端还没有你的提交）'
                    : '已是最新',
          )
        }
      } catch (error) {
        if (check) setCheckNote(`检查失败：${(error as Error)?.message ?? String(error)}`)
      } finally {
        if (check) setChecking(false)
      }
    },
    [],
  )

  useEffect(() => {
    void loadVersion(false)
  }, [loadVersion])

  const refresh = useMemo(
    () => async () => {
      try {
        const res = await fetch(`${LDW_API}/providers`)
        const data = (await res.json()) as Partial<SettingsState> & { ok?: boolean }
        setState({
          providers: Array.isArray(data.providers) ? data.providers : [],
          customIds: Array.isArray(data.customIds) ? data.customIds : [],
          defaultProviderId: String(data.defaultProviderId ?? ''),
          errors: Array.isArray(data.errors) ? data.errors : [],
          clients: Array.isArray(data.clients) ? data.clients : [],
          loggedInPlatforms: Array.isArray(data.loggedInPlatforms) ? data.loggedInPlatforms : [],
        })
      } catch (error) {
        setNote(`读取失败：${(error as Error)?.message ?? String(error)}`)
      }
    },
    [],
  )

  useEffect(() => {
    void refresh()
    /** 登录态 / 回复数会变，定期刷新（5s 足够，且不打扰）。 */
    const timer = window.setInterval(() => void refresh(), 5000)
    return () => window.clearInterval(timer)
  }, [refresh])

  /** 拉配置（进设置页时一次 + 保存后一次）。 */
  const loadConfig = useMemo(
    () => async () => {
      try {
        const res = await fetch(`${LDW_API}/config`)
        const data = (await res.json()) as {
          config?: WebinConfig
          problems?: { field: string; reason: string }[]
        }
        if (data.config !== undefined) setForm({ ...DEFAULT_CONFIG, ...data.config })
        setProblems(Array.isArray(data.problems) ? data.problems : [])
      } catch (error) {
        setNote(`配置读取失败：${(error as Error)?.message ?? String(error)}`)
      }
    },
    [],
  )

  useEffect(() => {
    void loadConfig()
  }, [loadConfig])

  /** 改一个字段（只改本地表单）。 */
  const setField = (key: keyof WebinConfig, value: unknown) => {
    setForm((prev) => (prev === null ? prev : { ...prev, [key]: value }))
  }

  /** 保存配置 → host 校验 → 立刻刷新 client 的模块级缓存。 */
  const saveConfig = async () => {
    if (form === null) return
    setBusy(true)
    setNote('')
    try {
      const res = await fetch(`${LDW_API}/config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(form),
      })
      const data = (await res.json()) as {
        ok?: boolean
        reason?: string
        config?: WebinConfig
        problems?: { field: string; reason: string }[]
      }
      if (data.ok !== true) {
        setNote(`保存失败：${data.reason ?? '未知原因'}`)
        return
      }
      if (data.config !== undefined) setForm({ ...DEFAULT_CONFIG, ...data.config })
      setProblems(Array.isArray(data.problems) ? data.problems : [])
      /** ⭐ 关键：让发送循环立刻用上新配置（否则要等下次启动）。 */
      await refreshConfig()
      setNote(
        (data.problems ?? []).length > 0
          ? `已保存（${(data.problems ?? []).length} 项被修正）`
          : '已保存，立刻生效',
      )
    } catch (error) {
      setNote(`保存失败：${(error as Error)?.message ?? String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  /** 恢复默认配置。 */
  const resetConfig = async () => {
    setBusy(true)
    setNote('')
    try {
      const res = await fetch(`${LDW_API}/config`, { method: 'DELETE' })
      const data = (await res.json()) as { ok?: boolean; config?: WebinConfig }
      if (data.ok === true && data.config !== undefined) {
        setForm({ ...DEFAULT_CONFIG, ...data.config })
        setProblems([])
        await refreshConfig()
        setNote('已恢复默认')
      }
    } catch (error) {
      setNote(`恢复失败：${(error as Error)?.message ?? String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  /** 提交一个自定义 provider（JSON 文本）。 */
  const submit = async () => {
    setBusy(true)
    setNote('')
    try {
      const res = await fetch(`${LDW_API}/providers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: draft,
      })
      const data = (await res.json()) as { ok?: boolean; reason?: string; errors?: { reason: string }[] }
      if (data.ok === true) {
        setNote('已保存，平台列表已刷新')
        setDraft('')
        await refresh()
      } else {
        setNote(`保存失败：${data.reason ?? data.errors?.[0]?.reason ?? '未知原因'}`)
      }
    } catch (error) {
      setNote(`保存失败：${(error as Error)?.message ?? String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  /** 删一个自定义 provider。 */
  const remove = async (id: string) => {
    setBusy(true)
    setNote('')
    try {
      const res = await fetch(`${LDW_API}/providers/${encodeURIComponent(id)}`, { method: 'DELETE' })
      const data = (await res.json()) as { ok?: boolean; reason?: string }
      setNote(data.ok === true ? `已删除 ${id}` : `删除失败：${data.reason ?? '未知原因'}`)
      await refresh()
    } catch (error) {
      setNote(`删除失败：${(error as Error)?.message ?? String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  /**
   * ---- 首次读取：骨架屏 ----
   *
   * 不用「正在读取…」一行字 —— 骨架屏能让布局提前稳定，
   * 数据到位时不会整页跳动。
   */
  if (state === null) {
    return createElement(
      'div',
      { className: 'ldw-set' },
      createElement(
        'div',
        { className: 'ldw-hero' },
        createElement(
          'div',
          { className: 'ldw-pagehead' },
          createElement(
            'div',
            { className: 'ldw-pagetitle' },
            createElement('h2', null, 'LDW · 网页版接入'),
            createElement('p', { className: 'ldw-pagesub' }, '正在读取平台与配置…'),
          ),
        ),
      ),
      createElement(
        'div',
        { className: 'ldw-grid' },
        ...[0, 1].map((i) =>
          createElement(
            'div',
            { key: i, className: 'ldw-card' },
            createElement('div', { className: 'ldw-skeleton', style: { width: '55%' } }),
            createElement('div', { className: 'ldw-skeleton', style: { width: '85%' } }),
            createElement('div', { className: 'ldw-skeleton', style: { width: '70%' } }),
          ),
        ),
      ),
    )
  }

  /** 有浏览器在线且已登录的平台数 —— 页头状态点用。 */
  const liveCount = state.clients.filter((c) => c.loggedIn).length
  const customCount = state.providers.filter((p) => state.customIds.includes(p.id)).length

  /** 每个平台一张卡片。 */
  const cards = state.providers.map((p) => {
    const beats = state.clients.filter((c) => c.platform === p.id)
    const loggedIn = beats.some((c) => c.loggedIn)
    const live = beats.length > 0
    const isCustom = state.customIds.includes(p.id)
    /** 状态点：在线且登录=ok；在线未登录=warn；不在线=灰。 */
    const dot = live ? (loggedIn ? 'ok' : 'warn') : ''
    const statusText = live
      ? loggedIn
        ? '已登录'
        : '未登录'
      : '浏览器未打开'

    return createElement(
      'div',
      { key: p.id, className: 'ldw-card' },
      createElement(
        'div',
        { className: 'ldw-card-head' },
        createElement('span', { className: `ldw-dot ${dot}`.trim() }),
        createElement('span', { className: 'ldw-card-name' }, p.name),
        createElement('span', { className: 'ldw-card-id' }, p.id),
        createElement('span', { className: 'ldw-tag' + (isCustom ? ' warn' : '') }, isCustom ? '自定义' : '内置'),
      ),
      createElement(
        'div',
        { className: 'ldw-rows' },
        row('状态', statusText),
        row('地址', p.homeUrl),
        row('模型', p.models.map((m) => m.name).join('、') || '（无）'),
        row('上下文', `${p.contextWindow.toLocaleString()} token`),
      ),
      /**
       * 只有**自定义**项能删 —— 内置项删不掉（删了下次启动还在），
       * 给它一个按钮只会让人困惑。要改内置项就用同 id 覆盖。
       */
      isCustom
        ? createElement(
            'div',
            { className: 'ldw-actions' },
            createElement(
              'button',
              {
                type: 'button',
                className: 'ldw-btn danger',
                disabled: busy,
                onClick: () => void remove(p.id),
              },
              '删除',
            ),
          )
        : null,
    )
  })

  /** 渲染一个配置字段。 */
  const renderField = (spec: FieldSpec): unknown => {
    if (form === null) return null
    const value = form[spec.key]
    const limit = LIMITS[spec.key as string]
    const scale = spec.scale ?? 1
    const unit = scale === 1000 ? '秒' : (spec.unit ?? '')
    const rangeText =
      limit === undefined
        ? ''
        : `${Math.round(limit.min / scale)}~${Math.round(limit.max / scale)}${unit}`

    /** 布尔字段：用开关（与参考实现的 Switch 同款交互）。 */
    if (spec.bool === true) {
      return createElement(
        'div',
        { key: spec.key as string, className: 'ldw-fieldrow' },
        createElement(
          'button',
          {
            type: 'button',
            className: 'ldw-switch',
            role: 'switch',
            'aria-checked': value === true ? 'true' : 'false',
            onClick: () => setField(spec.key, value !== true),
          },
          createElement('i'),
          createElement('span', { className: 'ldw-field-label' }, spec.label),
        ),
        createElement('span'),
        createElement('span', { className: 'ldw-hint' }, spec.hint ?? ''),
      )
    }

    return createElement(
      'div',
      { key: spec.key as string, className: 'ldw-fieldrow' },
      createElement('span', { className: 'ldw-field-label' }, spec.label),
      createElement(
        'span',
        { className: 'ldw-field-inline' },
        createElement('input', {
          type: 'number',
          className: 'ldw-num',
          value: scale === 1000 ? Math.round(Number(value) / scale) : Number(value),
          min: limit === undefined ? undefined : Math.round(limit.min / scale),
          max: limit === undefined ? undefined : Math.round(limit.max / scale),
          step: 1,
          onChange: (e: { target: { value: string } }) => {
            const n = Number(e.target.value)
            if (!Number.isFinite(n)) return
            setField(spec.key, Math.round(n * scale))
          },
        }),
        createElement('span', { className: 'ldw-unit' }, unit),
      ),
      createElement(
        'span',
        { className: 'ldw-hint' },
        [rangeText, spec.hint].filter((s) => s !== undefined && s !== '').join(' · '),
      ),
    )
  }

  /** 配置表单（三个分组）。 */
  const configForm =
    form === null
      ? createElement('p', { className: 'ldw-note' }, '正在读取配置…')
      : createElement(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 18 } },
          ...FIELD_GROUPS.map((group) =>
            createElement(
              'div',
              { key: group.title, className: 'ldw-group' },
              createElement('h4', { className: 'ldw-group-title' }, group.title),
              createElement('p', { className: 'ldw-note' }, group.note),
              ...group.fields.map(renderField),
            ),
          ),
          createElement(
            'div',
            { className: 'ldw-actions' },
            createElement(
              'button',
              {
                type: 'button',
                className: 'ldw-btn primary',
                disabled: busy,
                onClick: () => void saveConfig(),
              },
              busy ? '处理中…' : '保存配置',
            ),
            createElement(
              'button',
              { type: 'button', className: 'ldw-btn', disabled: busy, onClick: () => void resetConfig() },
              '恢复默认',
            ),
            createElement(
              'span',
              { className: 'ldw-note', style: { marginLeft: 'auto' } },
              '改完立刻生效，不用重启',
            ),
          ),
          problems.length > 0
            ? createElement(
                'div',
                { className: 'ldw-callout' },
                createElement(
                  'div',
                  null,
                  createElement('strong', null, `${problems.length} 项被修正`),
                  createElement(
                    'ul',
                    null,
                    ...problems.map((p, i) => createElement('li', { key: i }, `${p.field}：${p.reason}`)),
                  ),
                ),
              )
            : null,
        )

  return createElement(
    'div',
    { className: 'ldw-set' },

    /* ── 页头 ─────────────────────────────────────────────────────── */
    createElement(
      'header',
      { className: 'ldw-hero' },
      createElement(
        'div',
        { className: 'ldw-pagehead' },
        createElement(
          'div',
          { className: 'ldw-pagetitle' },
          createElement('h2', null, 'LDW · 网页版接入'),
          createElement(
            'p',
            { className: 'ldw-pagesub' },
            '用真实浏览器驱动 AI 网页版 —— 真实登录、真实输入、真实发送，回复由页面自己的 SSE 读出。',
          ),
        ),
        createElement(
          'div',
          { className: 'ldw-pills' },
          createElement(
            'span',
            { className: 'ldw-pill strong' },
            createElement('span', { className: `ldw-dot ${liveCount > 0 ? 'ok' : ''}`.trim() }),
            liveCount > 0 ? `${liveCount} 个已登录` : '浏览器未打开',
          ),
          createElement('span', { className: 'ldw-pill' }, `${state.providers.length} 个平台`),
          customCount > 0 ? createElement('span', { className: 'ldw-pill' }, `${customCount} 个自定义`) : null,
        ),
      ),


      /**
       * 版本行 —— 放在 hero 里（页头第二行）。
       *
       * 三样东西并排：当前版本、检查更新、去 GitHub 点 Star。
       * 都在这一个位置，因为它们是同一类「关于这个插件」的操作。
       */
      createElement(
        'div',
        { className: 'ldw-verline' },
        createElement(
          'span',
          { className: 'ldw-ver' },
          createElement('span', { className: 'ldw-ver-num' }, `v${ver?.version ?? '?'}`),
          createElement('code', { className: 'ldw-ver-commit' }, ver?.commit ?? '?'),
          /**
           * 构建时间 —— 比提交号更直观。
           *
           * `git pull` 之后忘了 `npm run build` 时，时间戳会明显偏旧，
           * 一眼就能看出「跑的还是旧产物」。
           */
          ver?.builtAt === undefined || ver.builtAt === ''
            ? null
            : createElement(
                'span',
                { className: 'ldw-ver-when', title: `构建于 ${ver.builtAt}` },
                formatBuiltAt(ver.builtAt),
              ),
        ),
        createElement(
          'button',
          {
            type: 'button',
            className: 'ldw-btn',
            disabled: checking,
            onClick: () => void loadVersion(true),
          },
          checking ? '检查中…' : '检查更新',
        ),
        /**
         * Star 按钮 —— 用 `<a target="_blank">` 而不是 `window.open`：
         * 前者是浏览器原生行为（中键 / 右键「新标签打开」都能用），
         * 也自带 `rel` 安全属性。参考实现也是这么做的。
         */
        createElement(
          'a',
          {
            className: 'ldw-btn ldw-star',
            href: ver?.starUrl ?? 'https://github.com/cv-superding/dsh-webin/stargazers',
            target: '_blank',
            rel: 'noreferrer noopener',
            title: `在 GitHub 上给 ${ver?.repo ?? 'dsh-webin'} 点 Star`,
          },
          createElement(
            'svg',
            { viewBox: '0 0 16 16', 'aria-hidden': 'true', className: 'ldw-star-icon' },
            createElement('path', {
              d: 'M8 .25a.75.75 0 01.673.418l1.882 3.815 4.21.612a.75.75 0 01.416 1.279l-3.046 2.97.719 4.192a.75.75 0 01-1.088.791L8 12.347l-3.766 1.98a.75.75 0 01-1.088-.79l.72-4.194L.818 6.374a.75.75 0 01.416-1.28l4.21-.611L7.327.668A.75.75 0 018 .25z',
            }),
          ),
          '点个 Star',
        ),
        checkNote !== '' ? createElement('span', { className: 'ldw-ver-note' }, checkNote) : null,
      ),

      /** 有新提交时给一条明确的行动指引（含可照做的命令）。 */
      ver?.update?.ok === true && ver.update.behind === true
        ? createElement(
            'div',
            { className: 'ldw-callout' },
            createElement(
              'div',
              null,
              createElement('strong', null, `有新版本：${ver.update.latestCommit}`),
              ver.update.latestMessage !== undefined && ver.update.latestMessage !== ''
                ? createElement('div', null, ver.update.latestMessage)
                : null,
              createElement(
                'div',
                { className: 'ldw-updcmd' },
                createElement('code', null, ver.updateHint),
              ),
              createElement(
                'div',
                { className: 'ldw-note' },
                '本插件以本地目录 / npm 包方式安装，所以更新要在你那边执行上面的命令；改完重启 DSH（host 半没有热重载）。',
              ),
            ),
          )
        : null,
    ),

    /* ── 平台 ─────────────────────────────────────────────────────── */
    createElement(
      'section',
      { className: 'ldw-sec' },
      createElement(
        'div',
        { className: 'ldw-sechead' },
        createElement('span', { className: 'ldw-sec-title' }, '平台'),
        createElement(
          'span',
          { className: 'ldw-sec-hint' },
          '切到 LDW 标签可打开浏览器窗口并登录',
        ),
      ),
      cards.length > 0
        ? createElement('div', { className: 'ldw-grid' }, cards)
        : createElement('p', { className: 'ldw-note' }, '（没有可用平台）'),
      state.errors.length > 0
        ? createElement(
            'div',
            { className: 'ldw-callout err' },
            createElement(
              'div',
              null,
              createElement('strong', null, `${state.errors.length} 个 provider 文件读不了`),
              createElement(
                'ul',
                null,
                ...state.errors.map((e, i) => createElement('li', { key: i }, `${e.file}：${e.reason}`)),
              ),
            ),
          )
        : null,
    ),

    /* ── 登录（用户要求的「设置页面加个登录按钮」）─────────────────── */
    createElement(
      'section',
      { className: 'ldw-sec' },
      createElement(
        'div',
        { className: 'ldw-sechead' },
        createElement('span', { className: 'ldw-sec-title' }, '登录'),
        createElement('span', { className: 'ldw-sec-hint' }, '未登录的平台不会出现在模型选择器里'),
      ),
      createElement(
        'div',
        { className: 'ldw-panel' },
        /**
         * 每个平台一行：状态 + 「去登录」。
         *
         * 「去登录」= 切到 LDW 标签（浏览器在那里）。那是**唯一**能真正
         * 完成登录的地方 —— 登录要在真实页面上输账号密码。
         */
        ...state.providers.map((p) => {
          const isLogged = state.loggedInPlatforms.includes(p.id)
          const online = state.clients.some((c) => c.platform === p.id)
          return createElement(
            'div',
            { key: p.id, className: 'ldw-loginrow' },
            createElement('span', { className: `ldw-dot ${isLogged ? 'ok' : online ? 'warn' : ''}`.trim() }),
            createElement('span', { className: 'ldw-loginrow-name' }, p.name),
            createElement(
              'span',
              { className: 'ldw-note' },
              isLogged
                ? online
                  ? '已登录，浏览器在线'
                  : '已登录（浏览器未打开）'
                : online
                  ? '未登录 —— 浏览器已打开，去页面里登录'
                  : '未登录',
            ),
            /**
             * ## 已登录时**不显示按钮**，只显示状态标签
             *
             * 用户要求：「这个地方不要显示『打开浏览器』而是显示『已登录』」。
             *
             * 理由很实在：登录过之后，「打开浏览器」这个**动作按钮**会让人
             * 以为还要做点什么 —— 而实际上什么都不用做，模型已经可用了。
             * 显示成状态标签（带 ✓）才是准确的信息。
             *
             * ⚠️ 但也不能把「打开浏览器」这个能力弄丢：
             * 用户有时**确实**想进去看看（改设置、退出登录、看看页面状态）。
             * 所以已登录时给一个**弱化的小链接**（`ldw-linkbtn`），
             * 而不是显眼的主按钮 —— 视觉上它是「次要入口」而不是「待办事项」。
             */
            createElement(
              'span',
              { className: 'ldw-actions', style: { marginLeft: 'auto' } },
              isLogged
                ? createElement(
                    'span',
                    { className: 'ldw-badge-on', title: '模型已可用，无需其他操作' },
                    '✓ 已登录',
                  )
                : createElement(
                    'button',
                    {
                      type: 'button',
                      className: 'ldw-btn primary',
                      onClick: () => goToPlatform(p.id),
                    },
                    '去登录',
                  ),
              /** 已登录时保留一个次要入口（想进去看看 / 退出登录时用）。 */
              isLogged
                ? createElement(
                    'button',
                    {
                      type: 'button',
                      className: 'ldw-linkbtn',
                      title: '打开浏览器视图（查看页面状态 / 退出登录）',
                      onClick: () => goToPlatform(p.id),
                    },
                    '打开',
                  )
                : null,
            ),
          )
        }),
        createElement(
          'p',
          { className: 'ldw-note' },
          state.loggedInPlatforms.length > 0
            ? '已登录的平台可以直接用 —— 不需要再点任何按钮。需要查看页面状态或退出登录时，点「打开」。'
            : '点了「去登录」会切到本插件的浏览器视图 —— 在那里完成网页版登录。登录态会自动保存，重启 DSH 后仍有效。',
        ),
      ),
    ),

    /* ── 插件配置（默认折叠，避免一屏全是数字）───────────────────── */
    createElement(
      'details',
      { className: 'ldw-details' },
      createElement(
        'summary',
        null,
        '插件配置',
        createElement(
          'span',
          { className: 'ldw-sec-hint' },
          form === null ? '' : describeConfig(form),
        ),
      ),
      createElement('div', { className: 'ldw-details-body' }, configForm),
    ),

    /* ── 添加自定义平台（默认折叠）───────────────────────────────── */
    createElement(
      'details',
      { className: 'ldw-details', open: showAdd },
      createElement('summary', { onClick: () => setShowAdd((v) => !v) }, '添加自定义平台'),
      createElement(
        'div',
        { className: 'ldw-details-body' },
        createElement(
          'p',
          { className: 'ldw-note' },
          '粘贴一个 Provider JSON（字段见 README）。同 id 会覆盖内置项，删掉即可回退。',
        ),
        createElement('textarea', {
          className: 'ldw-textarea',
          rows: 9,
          placeholder:
            '{\n  "id": "my-platform",\n  "name": "我的平台",\n  "homeUrl": "https://example.com/",\n  "urlPattern": "example\\\\.com",\n  "input": { "selectors": ["textarea"] },\n  "send": { "selectors": ["button[type=\\"submit\\"]"] },\n  "completionPath": "/api/chat",\n  "models": [{ "id": "fast", "name": "快速" }],\n  "contextWindow": 131072,\n  "maxOutputTokens": 8192\n}',
          value: draft,
          onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
        }),
        createElement(
          'div',
          { className: 'ldw-actions' },
          createElement(
            'button',
            {
              type: 'button',
              className: 'ldw-btn primary',
              disabled: busy || draft.trim() === '',
              onClick: () => void submit(),
            },
            busy ? '处理中…' : '保存',
          ),
          createElement(
            'button',
            { type: 'button', className: 'ldw-btn', disabled: busy, onClick: () => void refresh() },
            '刷新',
          ),
        ),
      ),
    ),

    /* ── 操作反馈 ─────────────────────────────────────────────────── */
    note !== ''
      ? createElement(
          'div',
          { className: 'ldw-callout' },
          createElement('div', null, createElement('strong', null, '提示'), createElement('div', null, note)),
        )
      : null,
  )
}

/** 设置页里的一行「标签 : 值」。 */
function row(label: string, value: string): unknown {
  return createElement(
    'div',
    { className: 'ldw-set-row', key: label },
    createElement('span', { className: 'ldw-set-label' }, label),
    createElement('span', { className: 'ldw-set-value' }, value),
  )
}

/**
 * 切到本插件的浏览器视图（`conversation.view` id=`ldw`）。
 *
 * ## 为什么靠「点标签按钮」而不是调 API
 *
 * 切视图的 `selectView` 是 **session header** 的注入属性，既不在
 * `conversation.input.left` 也不在 `settings.section` 的 standardProps 里
 * （实测查过两个 slot 的契约）。硬拿不到的东西就别硬拿 —— 直接点 DSH
 * 自己渲染的那个标签按钮，与我们操作网页版的思路一致（不设计协议，
 * 操作界面）。
 *
 * ## 三条路依次尝试（从最精确到最宽泛）
 *
 *   1. `[data-conversation-tabs]` 里文本含 `LDW` 的 `button[role=tab]`
 *   2. 全文档里文本含 `LDW` 的 `[role=tab]`（标签栏容器换了也能找到）
 *   3. 侧栏/视图列表里文本含 `LDW` 的可点元素
 *
 * **都必须命中一个真实存在的元素**；找不到就返回原因，
 * 让调用方显示出来 —— 不静默失败、不假装成功。
 *
 * @returns 空串表示成功；否则是**具体**的失败原因
 */
function switchToLdwView(): string {
  try {
    /** 候选：先精确（标签栏内），再宽泛（全文档 role=tab），最后兜底。 */
    const scopes: { root: ParentNode; selector: string }[] = [
      { root: document, selector: '[data-conversation-tabs] button[role="tab"]' },
      { root: document, selector: '[role="tab"]' },
      { root: document, selector: 'button, a' },
    ]
    for (const { root, selector } of scopes) {
      const candidates = root.querySelectorAll(selector)
      for (let i = 0; i < candidates.length; i += 1) {
        const el = candidates[i] as HTMLElement
        const text = String(el.textContent ?? '').trim().toUpperCase()
        if (!text.includes('LDW')) continue
        /** 排除我们自己的按钮（`ldw-entry`）—— 否则点自己会无限套娃。 */
        if (el.classList.contains('ldw-entry')) continue
        el.click()
        return ''
      }
    }
    return '页面上没有 LDW 标签 —— 先发一条消息让会话建立，标签栏才会出现'
  } catch (error) {
    return `切换失败：${(error as Error)?.message ?? String(error)}`
  }
}

/** 设置页里「去登录」用的跳转（带反馈）。 */
function goToPlatform(platform: string): void {
  const err = switchToLdwView()
  if (err !== '') {
    /** 没标签栏时至少把浏览器视图指出来，不让用户干等。 */
    console.warn(`[dsh-webin] 切到 ${platform} 的浏览器视图失败：${err}`)
  }
}

/** 文本归一化 —— 去空白 + 小写，用于按文字找按钮。 */
function normText(s: string | null | undefined): string {
  return String(s ?? '').replace(/\s+/g, '').toLowerCase()
}

/** 在候选里找文本匹配的可点元素。 */
function findClickable(root: ParentNode, match: (text: string) => boolean): HTMLElement | null {
  const els = root.querySelectorAll('button, [role="button"], a')
  for (let i = 0; i < els.length; i += 1) {
    const el = els[i] as HTMLElement
    if (match(normText(el.textContent))) return el
  }
  return null
}

/** 设置模态框元素（DSH 的设置页是 portal 到 body 的 dialog）。 */
function settingsDialog(): HTMLElement | null {
  return document.querySelector('[data-shortcut-modal="settings"]')
}

/**
 * ## 打开设置页并切到 LDW 分区
 *
 * 设置页是 DSH 的**模态对话框** —— `[data-shortcut-modal="settings"]`
 * （`role=dialog` + `aria-modal`，portal 到 `document.body`；实测查过
 * `dsh-client-ui-settings-general` 的 `SettingsRoot`）。
 *
 * 打开它两条路，依次尝试：
 *   1. 点侧栏那个**真实的**设置按钮（按文字找「设置」）
 *   2. 派发 DSH 注册的 `settings.open` 快捷键（Ctrl+, / Ctrl+Alt+,）
 *
 * 打开后点导航里文本含 `LDW` 的那一行 —— 那是我们注册的
 * `settings.section`（id=`ldw`，label=`LDW 网页版`）。
 *
 * 全程走真实 DOM，不设计新协议。**每一步失败都返回具体原因** ——
 * 「找不到对话标签栏」这种笼统提示让人不知道下一步做什么。
 *
 * @returns 空串表示成功；否则是**具体**的失败原因
 */
function openSettingsAtLdwSection(): string {
  try {
    if (settingsDialog() === null) {
      /** 路子 1：点侧栏真实的设置按钮。 */
      const trigger =
        findClickable(document, (t) => t === '设置' || t === 'settings') ??
        findClickable(document, (t) => t.includes('设置') || t.includes('settings'))
      if (trigger !== null) trigger.click()

      /**
       * 路子 2：派发快捷键。
       *
       * DSH 注册的默认键：桌面 `primary+Comma`、web `primary+alt+Comma`。
       * 都试一遍 —— 派发合成事件走的是 DSH 自己的快捷键系统，
       * 不绕过任何逻辑。
       */
      if (settingsDialog() === null) {
        for (const ev of [
          { key: ',', code: 'Comma', ctrlKey: true, altKey: true },
          { key: ',', code: 'Comma', ctrlKey: true, altKey: false },
          { key: ',', code: 'Comma', metaKey: true, altKey: false },
        ]) {
          for (const target of [document, document.body, window]) {
            target.dispatchEvent(new KeyboardEvent('keydown', { ...ev, bubbles: true, cancelable: true }))
          }
          if (settingsDialog() !== null) break
        }
      }

      if (settingsDialog() === null) {
        return trigger === null
          ? '没找到设置按钮，也没唤出设置页 —— 请手动打开 设置 → LDW 网页版'
          : '点了设置按钮但设置页没打开 —— 请手动打开 设置 → LDW 网页版'
      }
    }

    const dialog = settingsDialog()
    if (dialog === null) return '设置页没打开'
    const row = findClickable(dialog, (t) => t.includes('ldw'))
    if (row === null) return '设置页里没有 LDW 分区 —— 插件可能没启用（试试重启 DSH）'
    row.click()
    return ''
  } catch (error) {
    return `打开设置失败：${(error as Error)?.message ?? String(error)}`
  }
}


/**
 * ## 输入框左侧的 LDW 入口（`conversation.input.left`）
 *
 * 用户要求：「每次新建会话的时候，应该在这里加个 LDW，让登录一下」。
 * 后续修正：「图2这个页面不用加LDW登录」+「点击那个LDW都不行哎」
 *
 * ## 为什么之前点了没反应
 *
 * 之前点击是「切到 LDW 标签」—— 找 `[data-conversation-tabs]` 里文本含 LDW
 * 的按钮。但在**新建会话的空页面**上那个标签栏根本不存在：
 *
 *     showTabs = !hideChrome && tabs.length > 1
 *
 * 标签栏只在「有会话」且「有多个视图」时渲染。所以空会话页面上点击
 * 必然报「找不到对话标签栏」—— 那不是 bug，是那个动作在这一页做不到。
 *
 * ## 现在的行为
 *
 * | 页面 | 行为 |
 * |---|---|
 * | **没有会话/标签栏**（新建会话页） | 显示按钮；点击**打开设置页的 LDW 区** |
 * | **有标签栏** | **不渲染**（用户明确说「图2不用加」） |
 *
 * 登录本身在设置页里做（那里有平台卡、登录态、去登录入口），
 * 所以按钮的职责就是**把用户送到设置页**。
 *
 * ## 怎么打开设置页
 *
 * 设置页是 DSH 的**模态对话框**：`[data-shortcut-modal="settings"]`
 * （`role=dialog` + `aria-modal`，portal 到 `document.body`）。
 *
 * 打开它有两个途径，这里**依次尝试**：
 *   1. 点侧栏那个真实的设置按钮（找文本含「设置 / Settings」的按钮）
 *   2. 派发 DSH 注册的 `settings.open` 快捷键（Ctrl+, / Ctrl+Alt+,）
 *
 * 打开之后再点导航里文本含 `LDW` 的那一行 —— 那是我们自己注册的
 * `settings.section`（id=`ldw`, label=`LDW 网页版`）。
 *
 * 全程走真实 DOM，不设计新协议 —— 与我们操作网页版的思路一致。
 * 每一步失败都**明确说明卡在哪**，不静默。
 */
export function LdwLoginButton(): unknown {
  const [status, setStatus] = useState<{ loggedIn: boolean; online: boolean } | null>(null)
  const [note, setNote] = useState('')

  /**
   * 这一页有没有会话标签栏？
   *
   * 有 ⇒ 用户能自己点「LDW」标签，这个按钮是冗余的 ⇒ 不渲染（用户要求）。
   * 用 `MutationObserver` 盯着，因为标签栏是**异步**出现的（会话建立后才渲染）。
   */
  const [hasTabs, setHasTabs] = useState(false)

  useEffect(() => {
    let alive = true
    const probe = () => {
      if (!alive) return
      setHasTabs(document.querySelector('[data-conversation-tabs]') !== null)
    }
    probe()
    const observer = new MutationObserver(probe)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => {
      alive = false
      observer.disconnect()
    }
  }, [])

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const res = await fetch(`${LDW_API}/status`)
        const data = (await res.json()) as {
          loggedInPlatforms?: string[]
          clients?: { online?: number }
        }
        if (!alive) return
        setStatus({
          loggedIn: (data.loggedInPlatforms ?? []).length > 0,
          online: Number(data.clients?.online ?? 0) > 0,
        })
      } catch {
        if (alive) setStatus({ loggedIn: false, online: false })
      }
    }
    void load()
    /** 登录发生在别处，所以定期回读状态（登录后这里要变绿）。 */
    const timer = window.setInterval(() => void load(), 5_000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [])

  /**
   * 打开设置页并切到 LDW 分区。
   *
   * 逻辑抽在 `openSettingsAtLdwSection()` 里（与设置页共用一套 DOM 探测），
   * 这里只负责把失败原因显示出来 —— 不静默失败。
   */
  const openSettingsAtLdw = () => {
    const first = openSettingsAtLdwSection()
    if (first === '') {
      setNote('')
      return
    }
    /**
     * 设置页是**异步挂载**的：点了设置按钮之后 React 才渲染导航行。
     * 所以等一帧再试一次 —— 用 `requestAnimationFrame` 而不是定时器，
     * React 提交后 rAF 一定已经能看到 DOM。
     */
    requestAnimationFrame(() => {
      const second = openSettingsAtLdwSection()
      setNote(second === '' ? '' : second)
    })
  }

  if (hasTabs) return null

  if (status === null) return null

  const { loggedIn, online } = status
  const dot = loggedIn ? 'ok' : online ? 'warn' : ''

  return createElement(
    'button',
    {
      type: 'button',
      className: 'ldw-entry',
      onClick: openSettingsAtLdw,
      title:
        note !== ''
          ? note
          : loggedIn
            ? '打开设置页的 LDW 分区（已登录）'
            : '打开设置页登录 LDW',
    },
    createElement('span', { className: `ldw-dot ${dot}`.trim() }),
    createElement('span', null, loggedIn ? 'LDW 已登录' : online ? 'LDW 登录' : 'LDW 未就绪'),
    note !== '' ? createElement('span', { className: 'ldw-entry-note' }, note) : null,
  )
}


export function LdwPlaceholder(props?: { sessionId?: string }): unknown {
  const ref = useRef<HTMLDivElement | null>(null)

  /**
   * ## ⭐ 上报「我挂在哪个 DSH 会话上」（用户报的「所有窗口都生效」）
   *
   * ## 事实（不是猜的）
   *
   * `conversation.view` 的 standardProps 里**直接有 `sessionId: SessionId`**
   * —— 这是 DSH 官方提供的 prop（用 Slots Inspect 查到的
   * `standardProps` 列表，含 `sessionId`、`useSession`、`useChat` 等）。
   *
   * ## 为什么需要
   *
   * 早期 `/job/next` 只按平台过滤 ⇒ **任何 DSH 窗口都能领走任何任务**。
   * 用户实测：「换了几个 dsh 窗口聊天，发现全都是在网页版的同一个会话窗口」、
   * 「所有窗口都生效」。
   *
   * 上报之后，host 派发时能带上目标会话，client 领活时也只领自己的。
   *
   * ⚠️ 拿不到 sessionId 时**不报错**（退回按平台派发）—— 那只是不够精确，
   * 比整个功能坏掉好。
   */
  useEffect(() => {
    const sid = typeof props?.sessionId === 'string' ? props.sessionId.trim() : ''
    /**
     * ## ⚠️ 把「实际收到了什么 props」打出来 —— 不猜
     *
     * 我按 Slots Inspect 的 `standardProps` 列表认定 `conversation.view`
     * 会传 `sessionId`。但**契约写着有 ≠ 运行时真的传了** ——
     * 所以第一次挂载时把**实际收到的 key** 打出来，
     * 一眼就能确认（而不是靠我推断）。
     *
     * 用户要求「不要猜」—— 这就是把推断变成观测。
     */
    if (!propsLogged) {
      propsLogged = true
      const keys = props === undefined ? [] : Object.keys(props)
      console.log('[dsh-webin] conversation.view 收到的 props', {
        keys,
        sessionId: sid === '' ? '(空)' : sid,
        hasSessionId: sid !== '',
      })
    }
    if (sid === '') return
    sessionIdRef.current = sid
    void fetchJson('/dsh-webin/api/client/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: sid }),
    }).then((res) => {
      if (res !== undefined && res.ok) {
        console.log('[dsh-webin] 已上报会话身份', sid)
      }
    })
  }, [props?.sessionId])

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
  /**
   * 启动时拉一次配置。
   *
   * 发送循环（`LdwHost` 里的 `setInterval`）读的是模块级 `configRef`，
   * 所以必须在它跑起来之前填好 —— 否则第一轮会用默认值。
   */
  ctx.effect(() => {
    void refreshConfig().then((cfg) => {
      console.log('[dsh-webin] 配置已加载', describeConfig(cfg))
    })
  }, 'dsh-webin: config')

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

  /**
   * ---- 设置页：settings.section ----
   *
   * ⚠️ 两个必须遵守的契约（踩过就不报错，只是白屏 / 少一项）：
   *   1. `register` 的 options 里**必须带 `name`**（slot 名）
   *   2. 组件**必须返回 React 元素** —— 这里用箭头函数包一层
   *      `createElement(LdwSettings)`，直接传 `LdwSettings` 也行，
   *      但包一层能保证「注册的是元素而不是函数引用」这个语义明确
   *
   * `order: 47` —— 排在 `deepseek-web-login`(46) 之后，两者互不干扰。
   */
  ctx.effect(
    () =>
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'ldw',
            order: 47,
            label: () => 'LDW 网页版',
          },
          () => createElement(LdwSettings),
        ),
      ),
    'dsh-webin: settings page',
  )

  /**
   * ---- 输入框左侧的 LDW 入口：conversation.input.left ----
   *
   * 用户要求：「每次新建会话的时候，应该在这里加个 LDW，让登录一下」。
   *
   * 这个位置在**每一条会话**里都在（包括刚新建的空会话），
   * 所以它是「第一次怎么开始」的正确入口 —— 之前只能靠切 LDW 标签，
   * 而新建会话时那个标签不在视野里。
   *
   * `order: 10` —— 排在左侧控件前段，紧邻工作区 / 模式选择器。
   */
  ctx.effect(
    () =>
      ctx.slots.inject('conversation.input.left', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.left',
            id: 'ldw-login',
            order: 10,
            label: () => 'LDW',
          },
          LdwLoginButton,
        ),
      ),
    'dsh-webin: composer entry',
  )
}
