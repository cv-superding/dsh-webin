import fs from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const dir = join(ROOT, 'lib')

// 1) host 半
const host = await import(pathToFileURL(join(dir, 'index.js')).href)
console.log('=== host half ===')
console.log('  exports   :', Object.keys(host).join(', '))
console.log('  name      :', host.name)
console.log('  inject    :', JSON.stringify(host.inject))
console.log('  apply     :', typeof host.apply === 'function' ? 'function' : 'MISSING')

// 2) client 半（静态检查）
const src = fs.readFileSync(join(dir, 'client.js'), 'utf8')

const checks = [
  ['ModuleLoader banner', src.includes('window.__ModuleLoader__.load')],
  ['plugin id = dsh-webin', src.includes('"dsh-webin"')],

  // ---- 挂载点：必须是「常驻宿主 + 占位符」两半 ----
  ['注册 conversation.view（占位符）', src.includes('conversation.view')],
  ['注册 shell.overlay（常驻宿主）', src.includes('shell.overlay')],
  ['宿主 id = ldw-host', src.includes('ldw-host')],
  ['view id = ldw', src.includes('"ldw"')],
  ['label = LDW', src.includes('LDW')],
  ['order = 20', /order:\s*20/.test(src)],
  ['占位符组件存在', src.includes('webin-placeholder')],
  ['宿主组件存在', src.includes('webin-host')],
  ['矩形广播通道存在', src.includes('publishRect') || src.includes('subscribeRect')],
  ['切走时矩形置 null（宿主移出视口）', /publishRect\(null\)/.test(src)],
  ['宿主不重建 DOM（只改 style）', src.includes('visibility')],

  // ---- guest 通道 ----
  ['about:blank# 前缀', src.includes('about:blank#')],
  ['调 dshDesktop.browser', src.includes('dshDesktop')],
  ['acquire 调用', src.includes('acquire')],
  ['release 清理', src.includes('release')],

  // ---- 多平台 ----
  ['内置 provider 表', src.includes('BUILTIN_PROVIDERS') || src.includes('chat.deepseek.com')],
  ['第二平台（qwen）已内置', src.includes('qwen') || src.includes('tongyi')],
  ['workspace 用 provider.id（登录态隔离）', /acquire\(provider\.id\)/.test(src)],
  ['平台选择器 UI', src.includes('webin-select')],
  ['心跳上报 platform', src.includes('platform:') || src.includes('platform,')],
  ['任务按平台领取', src.includes('platform=')],
  ['发送脚本接受平台提示', src.includes('INPUT_SELECTORS') && src.includes('SEND_SELECTORS')],
  ['站点特征评分可配置', src.includes('SIGNATURES') && src.includes('VETOES')],
  ['自定义 provider 装载入口', src.includes('applyCustomProviders')],
  ['切平台重建 guest（依赖 provider.id）', /\}, \[provider\.id\]\)/.test(src)],
  ['登录态持续探测（不只 dom-ready 一次）', src.includes('probeTimer')],
  ['ready 不在 about:blank 阶段置位', src.includes('输入框就绪检查')],
  ['发送脚本等输入框渲染（不一次就失败）', src.includes('waitForInput')],
  ['restore 只在目标域执行（阶段机 restoring）', /["']restoring["']/.test(src)],
  ['restore 报告源与回读校验', src.includes('wrong-origin') && src.includes('verified')],
  ['用阶段机而非计数（某步没发生也不卡住）', src.includes('stageRef')],
  ['加载失败回退阶段（可重试）', /stageRef\.current = ["']boot["']/.test(src)],
  ['渲染进程崩溃可恢复', src.includes('render-process-gone')],
  ['每次 dom-ready 重注入 hook（导航后不失效）', src.includes('buildDeepSeekHook')],
  ['防插队：有待办时不领新活', src.includes('hasPending')],
  ['待办超时兜底（防永久卡死）', src.includes('pendingSinceRef')],
  ['取消时停止页面生成', src.includes('buildStopScript')],
  ['停止键按实测特征定位（--outlined）', src.includes('ds-button--outlined')],
  ['停止键排除发送键特征（--filled/--primary）', /filled\|ds-button--primary/.test(src)],
  ['停止键分数并列时不敢猜', src.includes("reason: 'ambiguous'")],

  // ---- 「只回一个字」的根因（实测抓帧定位）----
  ['处理裸文本增量帧（正文主体）', src.includes('isBareTextDelta')],
  /**
   * ⚠️ 断言**必须跟着修复走**。
   *
   * 早期这里是 `text += obj.v`（裸增量一律进正文）—— 那正是两个 bug 的根因：
   *   1. 思考的裸增量全进正文 ⇒ 思考只剩路径帧那 2 个字
   *   2. 正文的裸增量接错位置 ⇒ 工具围栏开头的三反引号看起来丢了
   *
   * 现在改为按当前 fragment 类型分流（`route(obj.v)`）。
   */
  ['裸文本帧按 fragment 类型分流（不再一律进正文）', /if \(isBareTextDelta\(obj\)\) \{\s*route\(obj\.v\)/.test(src)],
  ['跟踪 fragment 类型表（分流依据）', src.includes('fragmentTypes')],
  ['首帧 -1 也能登记类型（思考不再截断）', /fragmentTypes\.length > 0 \? fragmentTypes\.length - 1 : 0/.test(src)],
  ['裸文本帧排除错误信封', src.includes('typeof obj.code === \'number\'')],

  // ---- 「每次重启新建对话」的修复 ----
  ['优先回到上次会话 URL（不盲开新对话）', src.includes('回到上次会话')],
  ['会话 URL 做平台域校验', /urlPattern.*test.*hostname/.test(src)],
  ['URL 非法时退回 homeUrl', src.includes('target = provider.homeUrl')],

  // ---- 本轮修复的回归点 ----
  /**
   * ⚠️ 发送已按 cuckoo 的架构**拆成三段**（读它的实现后重构）：
   *   ① buildFillScript（只填）② 客户端 setTimeout（随机延迟）
   *   ③ buildTriggerScript（只点发送）
   *
   * 原来是一个大脚本 `buildSendScript`，把「填充 → 等 2.4s → 验证 →
   * 重试」全塞进一次跨进程调用 —— 页面一导航就整体死掉，
   * 导致「一直深度求索中」。
   */
  ['发送：拆分出填充脚本', src.includes('buildFillScript')],
  ['发送：拆分出触发脚本', src.includes('buildTriggerScript')],
  ['发送：触发脚本有多策略候选', src.includes('near-input') || src.includes('scoreByGeometry')],
  ['发送：几何评分', src.includes('scoreByGeometry')],
  ['发送：诊断脚本', src.includes('buildDiagnoseScript')],
  /** 回复改由 DOM 轮询读取（主路径）。 */
  ['回复：DOM 抓取脚本存在', src.includes('buildScrapeScript')],
  ['回复：按条数增长判断新回复', src.includes('baselineRef')],
  ['心跳上报', src.includes('/client/heartbeat')],
  ['done 事件时间戳过滤', src.includes('sentAtRef')],
  ['登录判据含 userInfo', src.includes('hasUserId')],
  ['userInfo.id 解嵌套（value.id）', src.includes('ui.value.id') || src.includes('value.id')],
  ['回写含 cookie（不只 localStorage）', src.includes('cookies:') || /document\.cookie\s*=/.test(src)],
  ['hook 记录 completion 请求计数', src.includes('noteCompletionRequest') || src.includes('_requests')],
  ['快照写入前校验登录态（防空快照覆盖）', src.includes('snapshotLooksLoggedIn')],

  ['无意外 require', !/require\("(?!react|react-dom|cordis|@deepseek-ai)/.test(src)],
]

console.log('')
console.log('=== client half (static) ===')
let pass = 0
for (const [name, ok] of checks) {
  console.log(ok ? '  OK  ' : '  FAIL', name)
  if (ok) pass++
}
console.log(`  ${pass}/${checks.length} 通过`)
process.exitCode = pass === checks.length ? 0 : 1
