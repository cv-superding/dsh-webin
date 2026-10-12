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

/** 把 buildSendScript 生成的脚本取出来（注入假常量）。 */
function sendScript() {
  const src = extractFn(bundle, 'buildSendScript')
  const fn = new Function(
    'SEND_DELAY_MIN_MS',
    'SEND_DELAY_MAX_MS',
    `${src}; return buildSendScript;`,
  )(2000, 4000)
  return fn('hi', 100, { inputSelectors: ['textarea'], sendSelectors: [], completionPath: '/api/v0/chat/completion' })
}

console.log('[1] ⭐ 异常必须交回结果（不能只打日志）')
{
  /**
   * 找 `catch (error)` 之后那段 —— 它必须：
   *   1. 清掉 pendingJobRef
   *   2. PUT 一个错误结果给 host
   */
  const i = clientSrc.indexOf("console.warn('[dsh-webin] 任务处理失败', error)")
  check('找到异常处理点', i > 0, true)

  const after = clientSrc.slice(i, i + 1600)
  check('⭐ 清掉 pendingJobRef', /pendingJobRef\.current = undefined/.test(after), true)
  check('⭐ 清掉 pendingSinceRef', /pendingSinceRef\.current = 0/.test(after), true)
  check('⭐ 把错误交回 host', /api\/job\/\$\{stuck\}\/result/.test(after), true)
  check('⭐ 带 error 字段', /error: `客户端处理异常/.test(after), true)
  /** 必须先取值再清 —— 顺序反了就交不回去了。 */
  const iTake = after.indexOf('const stuck = pendingJobRef.current')
  const iClear = after.indexOf('pendingJobRef.current = undefined')
  check('⭐ 先取值再清空（顺序正确）', iTake > 0 && iClear > iTake, true)
}

console.log('\n[2] ⭐ cleared 单独成立**不算**发送成功')
{
  const script = sendScript()
  /** 判据只能是 requestSent 或 stopControl。 */
  check('⭐ ok = requestSent || stopControl', /signals\.ok = signals\.requestSent \|\| signals\.stopControl;/.test(script), true)
  check('⭐ cleared 不再单独判成功', /signals\.ok = [^;]*\|\| signals\.cleared/.test(script), false)
  /** cleared 仍然要采集（作为辅助信号报告）。 */
  check('cleared 仍被采集', /signals\.cleared = readInput\(input\)\.trim\(\) === ''/.test(script), true)
  /** grew 从来不单独采信。 */
  check('grew 仍不单独采信', /signals\.ok = [^;]*signals\.grew/.test(script), false)
}

console.log('\n[3] ⭐ 发送未确认时**明确报失败**（不报假成功）')
{
  const script = sendScript()
  /**
   * 两步都没成功 ⇒ 必须是 `send-failed`，
   * 且错误信息要说明「连请求都没看到」这个事实。
   */
  check('⭐ 未确认时报 send-failed', /stage: sig2\.ok \? 'sent' : 'send-failed'/.test(script), true)
  check('失败信息说明两条路都试了', /发送按钮与合成 Enter 都没生效/.test(script), true)
  /** 诊断信息要带 signal 明细 —— 否则用户没法判断卡在哪。 */
  check('⭐ 带 signals 明细', /signals: sig2/.test(script), true)
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
  const script = sendScript()
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

console.log('\n[8] ⭐ 待办超时兜底仍在（事件真丢了也能恢复）')
{
  /** 5 分钟兜底：即使 done 事件永远不来，也要解锁发送循环。 */
  check('⭐ 有 5 分钟兜底', /Date\.now\(\) - pendingSinceRef\.current > 300_000/.test(clientSrc), true)
  check('兜底也交错误给 host', /等待网页回复超时（客户端 5 分钟兜底）/.test(clientSrc), true)
  check('兜底清掉待办', /const stuck = pendingJobRef\.current!/.test(clientSrc), true)
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
process.exitCode = fail === 0 ? 0 : 1
