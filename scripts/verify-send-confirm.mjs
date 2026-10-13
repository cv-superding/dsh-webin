#!/usr/bin/env node
/**
 * ## 发送确认（用户报的「网页版早就有答案了，dsh 还在深度求索」）
 *
 * ## 用户看到的现象
 *
 * 截图里：网页版**根本没有那条消息**（输入框还是空的），
 * 而 DSH 一直「深度求索中」。
 *
 * 另一个截图里 DSH 报的错是「**发送脚本执行超时**（页面可能在发送途中
 * 导航，导致脚本上下文被销毁）」—— 那条消息来自**旧版本**的
 * `buildSendScript`（把填充+等待+校验塞进一次 executeJavaScript）。
 *
 * ## 两个问题
 *
 * 1. **旧版把长等待塞进页面脚本** ⇒ 页面一导航，脚本上下文被销毁 ⇒ 超时。
 *    已修（拆成 fill / 客户端延迟 / trigger 三段短调用）。
 * 2. **trigger 点完就返回 ok:true，从不验证** ⇒ 「点了但没生效」时插件
 *    以为发出去了，一路等一个永远不会来的回复。
 *
 * 这个脚本守住第 2 点的修复。
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

const chatSrc = readFileSync(join(ROOT, 'src', 'client', 'chat.ts'), 'utf8')
const clientSrc = readFileSync(join(ROOT, 'src', 'client', 'index.ts'), 'utf8')
const clientBundle = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')

console.log('=== 发送确认 ===\n')

console.log('[1] ⭐⭐ trigger 必须确认「页面真的接受了」')
{
  /**
   * 判据是**输入框被清空** —— 页面接受发送时一定会把内容搬进消息列表。
   *
   * 为什么用这个信号：
   *   - 不依赖 hook 注入时机（hook 装不上也能用）
   *   - 是**页面自己做的动作**，比「请求计数」可靠
   *   - 不需要知道发送键长什么样
   */
  check('⭐ 有 readInput 辅助', /function readInput\(el\)/.test(chatSrc), true)
  check('⭐ 记录了发送前的内容', /var before = readInput\(input\)/.test(chatSrc), true)
  check('⭐ 探测输入框是否被清空', /now\.trim\(\) === ''/.test(chatSrc), true)
  check('⭐ 返回 confirmed 标记', /confirmed: true/.test(chatSrc), true)
  check('⭐ 失败时给 input-not-cleared', /reason: 'input-not-cleared'/.test(chatSrc), true)
}

console.log('\n[2] ⭐⭐ 确认必须很快（不能拖慢每一轮）')
{
  /**
   * 只等 1.2 秒（6 × 200ms）。真实发送时 React 几乎立刻清空（几十毫秒）。
   * 等太久会拖慢每一轮；这段的目的是「**尽早发现失败**」而不是「确保成功」。
   */
  check('⭐ 探测次数有限（6 次）', /MAX_TRIES = 6/.test(chatSrc), true)
  check('⭐ 间隔 200ms', /setTimeout\(probe, 200\)/.test(chatSrc), true)
  check('⭐ 先等一个 tick 再探（给页面处理点击）', /setTimeout\(probe, 120\)/.test(chatSrc), true)
  /** 不能无限等 —— 那等于把「卡住」从超时挪到这里。 */
  check('⭐ 有终止条件', /if \(tries >= MAX_TRIES\)/.test(chatSrc), true)
}

console.log('\n[3] ⭐⭐ 失败必须立刻交错误（不能干等）')
{
  /**
   * 这是用户报的核心问题：网页版没那条消息，DSH 却一直等。
   * 现在 trigger 报 ok:false ⇒ 立刻 PUT 错误 ⇒ DSH 马上显示失败。
   */
  const seg = clientSrc.slice(clientSrc.indexOf('触发发送 —— **并确认页面真的接受了**'))
  check('找到触发段', seg.length > 0, true)
  check('⭐ 检查 trig.ok', /if \(trig\.ok !== true\)/.test(seg), true)
  check('⭐ 失败立刻交结果', /api\/job\/\$\{id\}\/result/.test(seg), true)
  check('⭐ 在交结果前清 pending', /clearPending\(\)[\s\S]{0,600}?api\/job\/\$\{id\}\/result/.test(seg), true)
  /** 错误信息要能照做 —— 用户得知道下一步。 */
  check('⭐ input-not-cleared 有可照做的提示', /消息没有真正发出去（输入框没被清空）/.test(seg), true)
  check('⭐ 提示里说了「请重试」', /请重试/.test(seg), true)
}

console.log('\n[4] ⭐ 旧版那个「长等待塞进页面脚本」的写法不能回来')
{
  /**
   * 旧版 `buildSendScript` 把「填充 → 等 2.4s → 校验 → 重试」全塞进
   * 一次 executeJavaScript。页面一导航，脚本上下文被销毁 ⇒ 不 resolve
   * 也不 reject ⇒ 宿主永远等。
   *
   * 用户截图里的错误「发送脚本执行超时（页面可能在发送途中导航，
   * 导致脚本上下文被销毁）」就是它。
   */
  check('⭐ 没有 buildSendScript', /export function buildSendScript/.test(chatSrc), false)
  check('⭐ 没有那条旧错误消息', /脚本上下文被销毁/.test(chatSrc), false)
  /** 三段式：fill / 客户端延迟 / trigger。 */
  check('有 buildFillScript', /export function buildFillScript/.test(chatSrc), true)
  check('有 buildTriggerScript', /export function buildTriggerScript/.test(chatSrc), true)
  check('⭐ 延迟在客户端侧（不在页面脚本里）', /await new Promise\(\(r\) => setTimeout\(r, gapMs\)\)/.test(clientSrc), true)
}

console.log('\n[5] ⭐ 产物与源码一致（防止「改了源码没构建」）')
{
  /**
   * ## 这个检查是必须的（真实踩过）
   *
   * `lib/` 是构建产物。我改了 `src/` 但没重新构建时，**用户加载的还是旧产物** ——
   * 于是他会看到**旧版本才有的错误消息**，而我在源码里怎么找都找不到。
   *
   * 排查时正是靠「截图里的错误消息在当前源码里不存在」才发现这一点的。
   *
   * 这里断言：源码里的关键新特性**确实进了产物**。
   */
  const markers = [
    ['readInput 辅助', /function readInput\(el\)/],
    ['confirmed 标记', /confirmed: true/],
    ['input-not-cleared', /input-not-cleared/],
    ['已确认发出', /已确认发出/],
  ]
  for (const [label, re] of markers) {
    check(`⭐ 产物含「${label}」（说明已重新构建）`, re.test(clientBundle), true)
  }
  /** 旧版那条错误消息不能在产物里（否则跑的是旧构建）。 */
  check('⭐ 产物里没有旧版的超时消息', /脚本上下文被销毁/.test(clientBundle), false)
}

console.log('\n[6] ⭐ 成功时也说清楚「已确认」而不是「已触发」')
{
  /**
   * 文案要反映实际把握程度：
   *   - 旧版「已触发」= 我只点了，不知道成不成
   *   - 现在「已确认发出」= 我验证过输入框被清空了
   */
  check('⭐ 状态文案是「已确认发出」', /已确认发出/.test(clientSrc), true)
  check('⭐ 不再是「已触发」', /（已触发，等待页面回复）/.test(clientSrc), false)
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
process.exitCode = fail === 0 ? 0 : 1
/** ⚠️ 显式退出 —— 防 handle 悬挂把 npm run check 卡死（verify-lifecycle 实测踩过）。 */
process.exit(process.exitCode)
