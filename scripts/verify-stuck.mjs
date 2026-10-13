#!/usr/bin/env node
/**
 * **「网页版停了，DSH 还在等」修复** 测试。
 *
 * ## 用户报的症状
 *
 * 网页版那边回复**已经完成**（输入框恢复、出现反馈按钮），
 * 但 DSH 一直转圈等到超时。状态栏那行自相矛盾：
 *
 *     22:12:15 已发送(思考模式未切换 (click-did-not-change-state)) · 收到 0 条
 *
 * ## 两个叠加的根因（都修了）
 *
 * ### ① 异常分支**只打日志，不交结果** ⇒ 永久僵死
 *
 *     } catch (error) {
 *       console.warn('[dsh-webin] 任务处理失败', error)   // ← 结果永不交回
 *     }
 *
 * 领到任务时 `pendingJobRef` 就置位了。此时若 `executeJavaScript` 抛异常
 * （超时 / 页面在发送途中导航 / 脚本报错），结果**永不交回** ⇒ host 一直等。
 * 更糟的是下一轮 `tick` 因为 `hasPending` 为真**再也不领新活** ——
 * 整个链路就此僵死，用户看到的就是「DSH 还在等待」。
 *
 * ### ② `cleared` 单独成立被判成功 ⇒ 假成功 + 空等
 *
 * 原来：`signals.ok = requestSent || stopControl || cleared`
 *
 * `cleared`（输入框被清空）**单独不可信**。用户实测：页面清空了输入框，
 * 但 `requestSent` 是 false（hook 没看到请求）—— 说明要么请求真没发，
 * 要么**路径没匹配上**（`samePath` 是精确比较）。两种都不该报成功。
 *
 * 第三方线索：用户截图里网页版弹了「快速、专家、识图模式已合并升级」——
 * **产品刚发版**，端点有可能变了。所以顺带加了 `notePostPath`：
 * 记下页面实际发过的 POST 路径，诊断面板直接对比「期望 vs 实际」。
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

let pass = 0
let fail = 0
const check = function (name, actual, expected) {
  if (arguments.length < 3) expected = true
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    pass += 1
    console.log(`  OK   ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL ${name}\n       期望 ${e}\n       实际 ${a}`)
  }
}

console.log('=== 「网页版停了 DSH 还在等」修复测试 ===\n')

const clientSrc = readFileSync(join(ROOT, 'src', 'client', 'index.ts'), 'utf8')
const chatSrc = readFileSync(join(ROOT, 'src', 'client', 'chat.ts'), 'utf8')
const hookSrc = readFileSync(join(ROOT, 'src', 'client', 'hook.ts'), 'utf8')
const bundle = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')

/** 从产物里抠一个函数（花括号配对）。 */
function extractFn(source, name) {
  const m = source.match(new RegExp(`function ${name}\\(`))
  if (m === null) return ''
  const open = source.indexOf('{', m.index)
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(m.index, i + 1)
    }
  }
  return ''
}

/**
 * 取填充脚本（注入假常量）。
 *
 * ⚠️ 发送已按 cuckoo 的架构拆成两段：`buildFillScript` + `buildTriggerScript`。
 * 原来那个把「填充 → 等 2.4s → 验证 → 重试」全塞进一次跨进程调用的
 * `buildSendScript` **已经删掉** —— 它正是「一直深度求索中」的根源。
 */
function fillScript() {
  const src = extractFn(bundle, 'buildFillScript')
  if (src === '') throw new Error('产物里找不到 buildFillScript —— 先跑 npm run build')
  const fn = new Function(`${src}; return buildFillScript;`)()
  return fn('hi', { inputSelectors: ['textarea'], sendSelectors: [] })
}

/** 取触发脚本。 */
function triggerScript() {
  const src = extractFn(bundle, 'buildTriggerScript')
  if (src === '') throw new Error('产物里找不到 buildTriggerScript —— 先跑 npm run build')
  const fn = new Function(`${src}; return buildTriggerScript;`)()
  return fn({ inputSelectors: ['textarea'], sendSelectors: [] })
}

console.log('[1] ⭐ 异常必须交回结果（不能只打日志）')
{
  /**
   * 找 `catch (error)` 之后那段 —— 它必须：
   *   1. 清掉任务状态（现在走统一的 `clearPending()`）
   *   2. PUT 一个错误结果给 host
   *
   * ⚠️ 清理已**收口**成 `clearPending()`（审计发现散落的 10 处里
   * 只有 1 处写全了 —— 漏清基线会把上一条回复当成新回复交回去）。
   * 所以这里断言「调了 clearPending」而不是逐个字段检查。
   */
  const i = clientSrc.indexOf("console.warn('[dsh-webin] 任务处理失败', error)")
  check('找到异常处理点', i > 0, true)

  const after = clientSrc.slice(i, i + 1600)
  check('⭐ 调 clearPending 清任务状态', /clearPending\(\)/.test(after), true)
  check('⭐ 把错误交回 host', /api\/job\/\$\{stuck\}\/result/.test(after), true)
  check('⭐ 带 error 字段', /error: `客户端处理异常/.test(after), true)
  /** 必须先取值再清 —— 顺序反了就交不回去了（stuck 变量要先拿到 jobId）。 */
  const iTake = after.indexOf('const stuck = pendingJobRef.current')
  const iClear = after.indexOf('clearPending()')
  check('⭐ 先取值再清空（顺序正确）', iTake > 0 && iClear > iTake, true)
}

console.log('\n[2] ⭐ 发送拆成两个短调用（照 cuckoo 的架构）')
{
  /**
   * 这是本轮最核心的修正：原来「填充 + 等待 + 验证 + 重试」全在一次
   * `executeJavaScript` 里 —— 那是跨进程调用，页面一导航就整体死掉
   * （不 resolve、不 reject）⇒ 宿主永远等 ⇒「一直深度求索中」。
   *
   * cuckoo 的做法（`src/overlay/chat-input.ts:137-171`）：
   * 页面脚本只做瞬时动作，**等待放在客户端**。
   */
  check('⭐ 填充脚本已拆分', /buildFillScript/.test(clientSrc), true)
  check('⭐ 触发脚本已拆分', /buildTriggerScript/.test(clientSrc), true)
  /**
   * 断言「真的不再用它」—— 用**调用形态**判断，而不是文本出现
   * （注释里提到它做历史说明是允许的）。
   */
  check('⭐ 不再调用大脚本', /await execJs<[^>]*>\(\s*el,\s*buildSendScript\(/.test(clientSrc), false)
  check('⭐ 源码里没有该函数定义', /export function buildSendScript/.test(chatSrc), false)
  /** 随机延迟必须在**客户端**侧。 */
  check('⭐ 延迟在客户端 setTimeout', /await new Promise\(\(r\) => setTimeout\(r, gapMs\)\)/.test(clientSrc), true)
  check('用 pickSendDelay 取延迟', /pickSendDelay\(cfgNow\.sendDelayMinMs/.test(clientSrc), true)
  /** 填充与触发是两次独立调用。 */
  const iFill = clientSrc.indexOf('buildFillScript(prompt')
  /**
   * ⚠️ 只匹配函数名前缀 —— 现在调用是多行的（多了 expectText 参数），
   * 把参数写死会在加参数时误报失败（踩过）。
   */
  const iTrig = clientSrc.indexOf('buildTriggerScript(sendHintsFor(provider)')
  check('⭐ 两次独立调用（填充在前）', iFill > 0 && iTrig > iFill, true)
}

console.log('\n[3] ⭐ 填充判据是非空（不因浏览器规范化误报失败）')
{
  const script = fillScript()
  check('⭐ 判据用 readInput 非空', /readInput\(el\) === ''/.test(script), true)
  check('⭐ 没有逐字节全等比较', /el\.value !== value/.test(script), false)
  /** CRLF 归一化（textarea 会做这个规范化）。 */
  check('⭐ 有 toLf 归一化', /function toLf\(/.test(script), true)
  check('⭐ contenteditable 分段 paste（cuckoo 同款）', /CHUNK = 6000/.test(script), true)
  check('⭐ 依次试多个候选输入框', /for \(var c = 0; c < cands\.length; c\+\+\)/.test(script), true)
  check('失败时列出试过哪些', /tried: tried/.test(script), true)
}

console.log('\n[3b] ⭐ 触发脚本：有候选就点，否则合成 Enter')
{
  const script = triggerScript()
  /** 与 cuckoo 的 fallbackSend 一致（chat-input.ts:482-501）。 */
  check('⭐ 有候选按钮就点', /best\.el\.click\(\)/.test(script), true)
  check('⭐ 没有就合成 Enter', /pressEnter\(input\)/.test(script), true)
  /**
   * ⭐ 两者只选一个（不会发两条）。
   *
   * ⚠️ 原来断言的是 `if (best && best.score > 0) { ... return }` 那个形态 ——
   * 后来加了「发送确认」（点完要等 1.2 秒探输入框是否被清空），
   * 于是不能再直接 `return`，改成了 if/else + 统一 Promise 收口。
   *
   * 所以断言改成验**语义**：点击在 if 分支里，Enter 在 else 分支里。
   */
  check(
    '⭐ 两者只选一个（点击 / Enter 互斥）',
    /if \(best && best\.score > 0\) \{[\s\S]{0,300}?best\.el\.click\(\)[\s\S]{0,200}?\} else \{[\s\S]{0,200}?pressEnter\(input\)/.test(
      script,
    ),
    true,
  )
  /** ⭐ 发送确认：探输入框是否被清空（用户报的「网页版没那条消息」）。 */
  check('⭐ 有发送确认（探输入框清空）', /readInput\(input\)/.test(script), true)
  check('⭐ 确认失败给 input-not-cleared', /input-not-cleared/.test(script), true)
  /** 输入框附近也纳入候选（DeepSeek 的发送键是纯图标 div）。 */
  check('⭐ 附近按钮纳入候选', /near-input\(L/.test(script), true)
  check('点了哪个要报告（便于排查）', /candidates: out\.slice\(0, 5\)/.test(script), true)
}

console.log('\n[4] ⭐ 记录页面实际发过的 POST 路径（端点改版时定位用）')
{
  const b = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  check('⭐ 有 notePostPath', b.includes('notePostPath'), true)
  check('⭐ 路径表挂在 window 上', b.includes('___postPaths'), true)
  /** fetch 与 XHR 两条路都要记（页面可能用任一种）。 */
  const fetchHook = b.slice(b.indexOf('window.fetch = function'), b.indexOf('window.fetch = function') + 1600)
  check('⭐ fetch 路径记录', /notePostPath\(url\)/.test(fetchHook), true)
  const xhrHook = b.slice(b.indexOf('OrigXHR.prototype.send'), b.indexOf('OrigXHR.prototype.send') + 900)
  check('⭐ XHR 路径记录', /notePostPath\(meta\.url\)/.test(xhrHook), true)
  /** 记录里要能看出「是否匹配我们的期望路径」。 */
  check('⭐ 记录带 matched 标记', /matched: matched/.test(b) || /matched: true/.test(b), true)
  /**
   * 同一路径去重（否则轮询几次就刷屏）。
   *
   * ⚠️ `list[i]` 里的方括号在正则里是字符类，必须转义（踩过）。
   */
  check('⭐ 同路径去重 + 计数', /list\[i\]\.count = \(list\[i\]\.count \|\| 1\) \+ 1/.test(b), true)
  check('⭐ 去重时保留曾匹配的事实', /if \(matched\) list\[i\]\.matched = true/.test(b), true)
  /** 上限保护。 */
  check('有长度上限', /list\.length > 20/.test(b), true)
}

console.log('\n[5] ⭐ 诊断脚本暴露「期望 vs 实际」路径对比')
{
  /** 诊断脚本（另一个函数）里要带这三样。 */
  const diagSrc = extractFn(bundle, 'buildDiagnoseScript')
  const diag = new Function(
    `${diagSrc}; return buildDiagnoseScript;`,
  )({ inputSelectors: ['textarea'], sendSelectors: [], completionPath: '/api/v0/chat/completion' })

  check('诊断脚本含 postPaths', /postPaths/.test(diag), true)
  check('⭐ 含期望的 completion 路径', /expectedCompletion/.test(diag), true)
  check('⭐ 期望值来自 Provider', /\/api\/v0\/chat\/completion/.test(diag), true)
  check('含 completion 请求计数', /completionRequests/.test(diag), true)
  check('保留原有 inputs/buttons', /inputs: \[\]/.test(diag) && /buttons: \[\]/.test(diag), true)
}

console.log('\n[6] SendHints 支持 completionPath（诊断用）')
{
  check('接口有 completionPath', /completionPath\?: string/.test(chatSrc), true)
  check('⭐ 注释说明只用于诊断', /只用于\*\*诊断展示\*\*/.test(chatSrc), true)
  /** sendHintsFor 要把 provider 的路径带过去。 */
  check('⭐ sendHintsFor 传 completionPath', /completionPath: p\.completionPath/.test(clientSrc), true)
}

console.log('\n[7] 已知陷阱仍在防线上：模板内不能有反引号')
{
  /**
   * 这次修复又踩了一次：新写的 JSDoc 里用反引号包代码
   * ⇒ 模板字符串提前终止 ⇒ PARSE_ERROR。
   * 两个模板都要扫。
   */
  for (const [label, src] of [['hook.ts', hookSrc], ['chat.ts', chatSrc]]) {
    const lines = src.split('\n')
    const start = lines.findIndex((l) => l.includes('return `(function () {'))
    let end = -1
    for (let i = start; i < lines.length; i += 1) {
      if (lines[i].trim() === '})();`') {
        end = i
        break
      }
    }
    const offenders = []
    for (let i = start; i <= end; i += 1) if (lines[i].includes('`')) offenders.push(i + 1)
    check(`${label} 模板内只有首尾反引号`, offenders, [start + 1, end + 1])
  }
}

console.log('\n[8] ⭐ DOM 读回复是**主路径**（不再是 20s 兜底）')
{
  /**
   * 用户的要求：「我想要的插件很简单，就是把网页版的内容，回显到 dsh 的对话窗口中」。
   *
   * 所以 DOM 抓取从「20 秒兜底」提升为**主路径** ——
   * 内容渲染在页面上，什么时候读都读得到，不依赖 hook 注入时机
   * （而 DSH 门禁删掉了 preload，我们无法像 cuckoo 那样提前注入）。
   */
  check('⭐ 3 秒后就开始读（不等 20s）', /waitedMs > 3_000/.test(clientSrc), true)
  check('⭐ 不再有 20s 兜底门槛', /waitedMs > 20_000/.test(clientSrc), false)
  check('⭐ 主路径调用 buildScrapeScript', /buildScrapeScript\(\)/.test(clientSrc), true)
  check('⭐ 结果标了 via=dom', /via: 'dom'/.test(clientSrc), true)
  /** 条数增长 = 本轮回复到位（比「内容变了」可靠）。 */
  check('⭐ 按条数增长判断', /count > baselineRef\.current/.test(clientSrc), true)
  /** 连续两次读到相同内容才算生成完（避免交半截回复）。 */
  check('⭐ 内容稳定才交（防半截）', /scrapedRef\.current !== last/.test(clientSrc), true)
  check('⭐ 派发前记基线', /baselineRef\.current = typeof base\.count === 'number'/.test(clientSrc), true)
  /**
   * ⭐ 放弃门槛**从配置读**，不硬编码。
   *
   * 原来写死 5 分钟，但配置里 `replyTimeoutMs` 默认 **10 分钟**
   * （注释记着「实测最慢一次网页回复 6 分 12 秒」）——
   * 于是慢回复会在 5 分钟被**提前掐断**，用户看到「超时」，
   * 而网页版其实还在正常生成。
   */
  check('⭐ 放弃门槛取配置的 80%', /currentConfig\(\)\.replyTimeoutMs \* 0\.8/.test(clientSrc), true)
  check('⭐ 不再硬编码 5 分钟', /waitedMs > 300_000/.test(clientSrc), false)
  check('有下限保护（至少 60 秒）', /Math\.max\(60_000, Math\.round\(currentConfig\(\)/.test(clientSrc), true)
  check('放弃时也交错误给 host', /等待网页回复超时（\$\{Math\.round\(giveUpMs \/ 1000\)\} 秒）/.test(clientSrc), true)
  /**
   * ⚠️ 不能用下面的 `cfgNow` —— 那个变量在这个位置还没声明（TDZ）。
   */
  check('用 currentConfig() 而不是 cfgNow（避免 TDZ）', /const giveUpMs = [^\n]*currentConfig\(\)/.test(clientSrc), true)
}

console.log('\n[8b] ⭐ 交付判据：条数增长 **或** 内容变化（任一成立）')
{
  /**
   * 只判条数有漏洞：页面若把回复渲染在基线选择器**匹配不到**的容器里
   * （改版 / A/B 测试），`count` 永远不增长 ⇒ 一直等到超时。
   * 加上内容比对后，只要出现**新内容**就能交付。
   */
  const i = clientSrc.indexOf('const countGrew = count > baselineRef.current')
  check('⭐ 有 countGrew 判据', i > 0, true)
  check('⭐ 有 contentChanged 判据', /const contentChanged = last !== '' && last !== baselineTextRef\.current/.test(clientSrc), true)
  check('⭐ 两者取「或」', /\(countGrew \|\| contentChanged\)/.test(clientSrc), true)
  check('⭐ 派发时记基线的内容', /baselineTextRef\.current = typeof base\.last === 'string'/.test(clientSrc), true)
  check('有 baselineTextRef 声明', /const baselineTextRef = useRef<string>\(''\)/.test(clientSrc), true)
}

console.log('\n[9] ⭐ Hook 自愈守护（「收到 0 条」的根治）')
{
  check('⭐ 有 hook 存活探测', /MARKER_CHECK/.test(clientSrc), true)
  check('⭐ 每 1.5s 检查一次', /setInterval\(ensureHook, 1_500\)/.test(clientSrc), true)
  check('⭐ 不在就重新注入', /hook 不在（页面已导航），重新注入/.test(clientSrc), true)
  /** 导航事件预注入（比 dom-ready 早得多）。 */
  check('⭐ 监听 did-start-navigation', /did-start-navigation/.test(clientSrc), true)
  check('⭐ 只关心主框架跨文档导航', /isMainFrame === false \|\| e\.isSameDocument === true/.test(clientSrc), true)
}

console.log('\n[10] ⭐ executeJavaScript 全部有超时护栏（防静默死锁）')
{
  check('⭐ 有 execJs 包装', /function execJs</.test(clientSrc), true)
  check('⭐ 有 EXEC_TIMEOUT sentinel', /export const EXEC_TIMEOUT/.test(clientSrc), true)
  /** 三个短调用都走 execJs（各自独立超时）。 */
  check('⭐ 填充走 execJs', /execJs<string>\(\s*el,\s*buildFillScript\(/.test(clientSrc), true)
  /**
   * ⚠️ 这个调用跨了多行，而且中间夹着 JSDoc 注释 ——
   * 所以不能用「execJs 紧跟 buildTriggerScript」那种紧邻匹配。
   * 改成：确认 buildTriggerScript 调用**出现在某个 execJs 调用内部**
   * （用「往前找最近的 execJs」判断）。
   */
  {
    const iTrigCall = clientSrc.indexOf('buildTriggerScript(sendHintsFor(provider)')
    const before = clientSrc.slice(Math.max(0, iTrigCall - 400), iTrigCall)
    check('⭐ 触发走 execJs', iTrigCall > 0 && /execJs<string>\(/.test(before), true)
  }
  check('⭐ 抓 DOM 走 execJs', /execJs<string>\(el, buildScrapeScript\(\), 12_000\)/.test(clientSrc), true)
  check('⭐ drain 走 execJs', /execJs<string>\(el, buildDrainScript\(\), 10_000\)/.test(clientSrc), true)
  check('⭐ 思考脚本走 execJs', /execJs<string>\(el, buildThinkingScript/.test(clientSrc), true)
  /** 超时都有明确的错误交回。 */
  check('⭐ 填充超时当失败交回', /填充输入框超时/.test(clientSrc), true)
  check('⭐ 触发超时当失败交回', /触发发送超时/.test(clientSrc), true)
  /** 超时不能 reject —— 抛出去会被外层 catch 吞掉，反而变静默。 */
  check('⭐ 超时走 resolve 而不是 reject', /resolve\(EXEC_TIMEOUT\)/.test(clientSrc), true)
  check('不用 reject 传超时', /reject\(EXEC_TIMEOUT\)/.test(clientSrc), false)
}

console.log('\n[11] ⭐ DOM 抓取脚本本身（从产物里真跑一遍）')
{
  const scrapeSrc = extractFn(bundle, 'buildScrapeScript')
  check('产物里有 buildScrapeScript', scrapeSrc !== '', true)

  const script = new Function(`${scrapeSrc}; return buildScrapeScript;`)()()
  check('是自执行脚本', /^\(function \(\) \{/.test(script.trim()), true)
  /** 必须尝试多种选择器（页面类名是哈希，不能依赖具体类名）。 */
  check('⭐ 多个候选选择器', (script.match(/data-message-author-role|ds-markdown|class\*="markdown"/g) ?? []).length >= 2, true)
  /** 剔除界面元素（按钮/输入框/图标不是回复内容）。 */
  check('⭐ 剔除界面元素', /function isChrome\(/.test(script), true)
  check('⭐ 剔除的标签齐全', /BUTTON.*TEXTAREA.*INPUT.*SVG/.test(script), true)
  /**
   * ⭐⭐ **代码块围栏必须还原** —— 工具调用就靠它。
   *
   * 只取 textContent 会丢掉围栏边界，那正是用户报过的
   * 「工具调用泄漏成正文：ldw 开头没有三反引号」。
   */
  check('⭐⭐ 还原代码块围栏', /FENCE/.test(script), true)
  check('⭐ 用 charCode 拼反引号（模板里不能有裸反引号）', /String\.fromCharCode\(96\)/.test(script), true)
  check('⭐ 取 pre > code 的内容', /tag === 'pre'/.test(script), true)
  check('⭐ 读取语言标记', /language-\(\[/.test(script), true)
  check('⭐ 有最短长度门槛', /t\.length >= 8/.test(script), true)
  /** 返回结构：all + last + count（客户端靠 count 判断新增）。 */
  check('⭐ 返回 all/last/count', /all: list/.test(script) && /count: list\.length/.test(script), true)
  /** 异常也不能抛（抛了会让调用方卡住）。 */
  check('⭐ 内部 try/catch 兜底', /catch \(e\) \{[\s\S]{0,80}return JSON\.stringify\(\{ ok: false/.test(script), true)
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
process.exitCode = fail === 0 ? 0 : 1
