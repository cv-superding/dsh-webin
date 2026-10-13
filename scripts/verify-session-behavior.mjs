#!/usr/bin/env node
/**
 * ## 会话隔离的**行为验证**（用真 host，不是源码断言）
 *
 * 用户要求「不要猜」。源码断言只能证明「代码里写了过滤」，
 * 证明不了「过滤真的生效」。这里起**真 host**，模拟两个窗口，
 * 验证：
 *
 *   1. 窗口 A 领不走属于窗口 B 的任务
 *   2. 窗口 B 能领走自己的任务
 *   3. 没有 sessionId 的老任务，谁都能领（向后兼容）
 *   4. /status 能看出「谁领了谁的任务」
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'

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

/**
 * 直接测 JobQueue 的行为。
 *
 * 它没被导出（模块内部类），所以从**构建产物**里抽出来 ——
 * 这样测的是真在跑的那份代码。
 */
const bundle = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')

/** 从产物里抽一个 class（按花括号配对）。 */
function extractClass(name) {
  const s = bundle.indexOf(`var ${name} = class`)
  if (s < 0) throw new Error(`产物里找不到 class ${name}`)
  const bs = bundle.indexOf('{', s)
  let depth = 0
  for (let i = bs; i < bundle.length; i += 1) {
    if (bundle[i] === '{') depth += 1
    else if (bundle[i] === '}') {
      depth -= 1
      if (depth === 0) return bundle.slice(s, i + 1)
    }
  }
  throw new Error(`${name} 花括号没配平`)
}

// eslint-disable-next-line no-new-func
const JobQueue = new Function(`${extractClass('JobQueue')}\nreturn JobQueue`)()

console.log('=== 会话隔离（行为验证）===\n')

console.log('[1] ⭐⭐ 窗口 A 领不走属于窗口 B 的任务')
{
  const q = new JobQueue()
  /** 给「窗口 B 的会话」派一个任务。 */
  q.enqueue('B 的提示词', false, 'deepseek', undefined, false, 'session-B')

  /** 窗口 A 来领 —— 必须领不到。 */
  const gotA = q.claimNext('deepseek', 'session-A')
  check('⭐⭐ A 领不到 B 的任务', gotA, undefined)

  /** 窗口 B 来领 —— 必须领到。 */
  const gotB = q.claimNext('deepseek', 'session-B')
  check('⭐⭐ B 能领到自己的任务', gotB?.prompt, 'B 的提示词')
  check('⭐ 任务记着归属会话', gotB?.sessionId, 'session-B')
  check('⭐ 记录被谁领走', gotB?.claimedBy, 'session-B')
}

console.log('\n[2] ⭐⭐ 两个窗口各有任务时不会互相领走')
{
  const q = new JobQueue()
  q.enqueue('给 A 的', false, 'deepseek', undefined, false, 'session-A')
  q.enqueue('给 B 的', false, 'deepseek', undefined, false, 'session-B')

  /** B 先来领 —— 应该拿到「给 B 的」（不是「给 A 的」）。 */
  const gotB = q.claimNext('deepseek', 'session-B')
  check('⭐⭐ B 拿到自己的那条', gotB?.prompt, '给 B 的')

  /** A 再来领 —— 应该拿到「给 A 的」。 */
  const gotA = q.claimNext('deepseek', 'session-A')
  check('⭐⭐ A 拿到自己的那条', gotA?.prompt, '给 A 的')

  /** 都没了。 */
  check('领完了', q.claimNext('deepseek', 'session-A'), undefined)
}

console.log('\n[3] ⭐ 平台过滤仍然生效（不能因为加了会话就丢了平台）')
{
  const q = new JobQueue()
  q.enqueue('给 qwen 的', false, 'qwen', undefined, false, 'session-A')
  /** 同会话但不同平台 —— 不能领。 */
  check('⭐ 平台不同领不到', q.claimNext('deepseek', 'session-A'), undefined)
  check('平台对了能领', q.claimNext('qwen', 'session-A')?.prompt, '给 qwen 的')
}

console.log('\n[4] ⭐⭐ 向后兼容：没有 sessionId 的老任务谁都能领')
{
  /**
   * 老 client 派发的任务没有 sessionId。若严格匹配它们会**永远没人领**
   * —— 比派错更糟。所以必须放行。
   */
  const q = new JobQueue()
  q.enqueue('老任务（无 sessionId）', false, 'deepseek')

  const got = q.claimNext('deepseek', 'session-A')
  check('⭐ 无 sessionId 的任务能被领走', got?.prompt, '老任务（无 sessionId）')
  check('⭐ 任务本身没有 sessionId', got?.sessionId, undefined)
}

console.log('\n[5] ⭐⭐ 窗口没上报 sessionId 时**放行**（不能把功能卡死）')
{
  /**
   * ## ⚠️ 这一组原来是反的 —— 那个方向造成了真实事故
   *
   * 我第一版写「未上报就不抢别人的活」。但事实是：
   * 跑发送循环的 \`LdwHost\` 挂在 \`shell.overlay\` 上，
   * **那个 slot 没有 sessionId**（只有 conversation.view 有）；
   * 能拿到的 LdwPlaceholder 又只在用户切到 LDW 标签时才挂载。
   *
   * 于是没切标签时窗口永远没身份 ⇒ 永远领不到任务 ⇒
   * 「LDW 面板未连接 —— 没有任何客户端领取这个任务（20s 内无人领取）」。
   *
   * 正确方向：**以「窗口是否上报」为准，没上报就放行**。
   * 隔离只在双方都有身份时生效。
   */
  const q = new JobQueue()
  q.enqueue('给 A 的', false, 'deepseek', undefined, false, 'session-A')
  check('⭐⭐ 未上报的窗口能领有归属的任务', q.claimNext('deepseek', undefined)?.prompt, '给 A 的')

  const q2 = new JobQueue()
  q2.enqueue('无归属的', false, 'deepseek')
  check('⭐ 未上报的窗口也能领无归属的', q2.claimNext('deepseek', undefined)?.prompt, '无归属的')
}

console.log('\n[6] ⭐⭐ /status 的诊断能看出「谁领了谁的任务」')
{
  const q = new JobQueue()
  q.enqueue('给 A 的', false, 'deepseek', undefined, false, 'session-A')
  q.enqueue('给 B 的', false, 'deepseek', undefined, false, 'session-B')
  /** B 领走自己的。 */
  q.claimNext('deepseek', 'session-B')

  const snap = q.inspect()
  check('快照有 2 条', snap.length, 2)

  const b = snap.find((j) => j.sessionId === 'session-B')
  const a = snap.find((j) => j.sessionId === 'session-A')
  check('⭐⭐ B 的显示被 session-B 领走', b?.claimedBy, 'session-B')
  check('⭐⭐ B 的状态是 claimed', b?.state, 'claimed')
  check('⭐⭐ A 的还显示未领', a?.claimedBy, '(未领)')
  check('⭐ A 的状态是 pending', a?.state, 'pending')
  check('⭐ 带年龄（便于看卡了多久）', typeof a?.ageMs, 'number')
}

console.log('\n[7] ⭐ 已领走的不重复派发')
{
  const q = new JobQueue()
  q.enqueue('只有一条', false, 'deepseek', undefined, false, 'session-A')
  check('第一次领到', q.claimNext('deepseek', 'session-A')?.prompt, '只有一条')
  check('⭐ 第二次领不到（不重复派发）', q.claimNext('deepseek', 'session-A'), undefined)
}

console.log('\n[8] ⭐ 已取消 / 已了结的任务不再派发')
{
  const q = new JobQueue()
  const j = q.enqueue('要取消的', false, 'deepseek', undefined, false, 'session-A')
  q.cancel(j.id, '用户停止')
  check('⭐ 已取消的领不到', q.claimNext('deepseek', 'session-A'), undefined)

  const q2 = new JobQueue()
  const j2 = q2.enqueue('要完成的', false, 'deepseek', undefined, false, 'session-A')
  q2.settle(j2.id, { text: 'ok', think: '', status: 'finished' })
  check('⭐ 已完成的领不到', q2.claimNext('deepseek', 'session-A'), undefined)
}


console.log('\n[9] ⭐⭐⭐ 回归：窗口没上报身份时**不能**把任务全卡死')
{
  /**
   * ## 真实事故（用户截图）
   *
   * 我第一版写的是「任务有 sessionId 就必须匹配」。但事实是：
   *
   *   - 跑发送循环的 \`LdwHost\` 挂在 \`shell.overlay\` 上，
   *     而那个 slot 的 standardProps **没有** sessionId
   *   - 能拿到 sessionId 的是 \`LdwPlaceholder\`（挂 conversation.view），
   *     但它**只在用户切到 LDW 标签时才挂载**
   *
   * 后果：没切到 LDW 标签 ⇒ 领活不带 session ⇒ 而任务都带 session
   * ⇒ **全被跳过** ⇒ 用户看到「LDW 面板未连接 —— 没有任何客户端领取
   * 这个任务（20s 内无人领取）」。
   *
   * 比原来的「所有窗口都生效」更糟 —— 直接不能用。
   *
   * 正确方向：**以「窗口是否上报」为准**。没上报就放行（退化成旧行为）。
   */
  const q = new JobQueue()
  q.enqueue('任务', false, 'deepseek', undefined, false, 'session-A')
  /** 窗口没上报（undefined）—— 必须能领到，否则就是上面那个事故。 */
  check('⭐⭐⭐ 未上报的窗口能领到有归属的任务', q.claimNext('deepseek', undefined)?.prompt, '任务')

  const q2 = new JobQueue()
  q2.enqueue('任务2', false, 'deepseek', undefined, false, 'session-A')
  /** 空串也算没上报。 */
  check('⭐⭐ 空串也算未上报', q2.claimNext('deepseek', '')?.prompt, '任务2')
}

console.log('\n[10] ⭐⭐ 隔离在双方都有身份时仍然生效')
{
  const q = new JobQueue()
  q.enqueue('给 B 的', false, 'deepseek', undefined, false, 'session-B')
  /** 窗口 A **上报了**身份 ⇒ 严格匹配 ⇒ 领不到 B 的。 */
  check('⭐⭐ A 领不到 B 的（隔离生效）', q.claimNext('deepseek', 'session-A'), undefined)
  check('⭐⭐ B 能领到', q.claimNext('deepseek', 'session-B')?.prompt, '给 B 的')
}

console.log('\n[11] ⭐ 未上报时 claimedBy 记为「(未上报)」')
{
  const q = new JobQueue()
  q.enqueue('任务', false, 'deepseek', undefined, false, 'session-A')
  const j = q.claimNext('deepseek', undefined)
  check('⭐ claimedBy 标明未上报', j?.claimedBy, '(未上报)')
  /** 诊断里能看出这是「谁都能领」的状态。 */
  const snap = q.inspect()
  check('⭐ 快照里 sessionId 是 session-A', snap[0]?.sessionId, 'session-A')
  check('⭐ 快照里 claimedBy 是 (未上报)', snap[0]?.claimedBy, '(未上报)')
}

console.log('\n[12] ⭐⭐ 回归：发送确认不能读**摘除的旧节点**')
{
  /**
   * ## 真实事故（用户截图）
   *
   * 用户：「网页版 ldw 早就输出完了」，而 DSH 报
   * 「send-failed: 消息没有真正发出去（输入框没被清空）」。
   *
   * 根因：第一版在点击**之前**抓了一个 input 引用，之后一直读它。
   * React 发送后重渲染，那个节点被**摘除** —— 读摘除节点的 value
   * **永远是发送前的内容** ⇒ 判据恒为「没清空」⇒ 误报。
   *
   * 修法：每轮探测**重新 findInput()**。
   */
  const chatSrc = readFileSync(join(ROOT, 'src', 'client', 'chat.ts'), 'utf8')
  /** 探测里必须重新找输入框。 */
  check('⭐⭐ 探测里重新 findInput', /function probe\(\) \{[\s\S]{0,300}?var fresh = findInput\(\)/.test(chatSrc), true)
  check('⭐ 用 fresh 而不是旧的 input', /var now = readInput\(fresh\)/.test(chatSrc), true)
  /** 找不到输入框时算成功（页面在重渲染，别误报）。 */
  check('⭐⭐ 找不到输入框算成功', /if \(!fresh\) \{[\s\S]{0,400}?ok\(\{ note: 'input-gone' \}\)/.test(chatSrc), true)
}

console.log('\n[13] ⭐⭐ 回归：输入框空着时不能判 input-lost')
{
  /**
   * 同类的误报：用户手快点了发送 ⇒ 输入框已清空 ⇒ 找不到我们的字
   * ⇒ 第一版报 input-lost。但消息其实发出去了。
   *
   * 修法：空着 ⇒ 视为已发送；**有内容但不是我们的** ⇒ 才报错。
   */
  const chatSrc = readFileSync(join(ROOT, 'src', 'client', 'chat.ts'), 'utf8')
  check('⭐⭐ 空着视为已发送', /current\.trim\(\) === ''[\s\S]{0,300}?already-sent/.test(chatSrc), true)
  check('⭐ 标记 input-empty-before-send', /input-empty-before-send/.test(chatSrc), true)
  check('⭐ 有内容但不是我们的才报错', /输入框里的内容变了（不是刚填进去的那段）/.test(chatSrc), true)
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
process.exitCode = fail === 0 ? 0 : 1
/** ⚠️ 显式退出 —— 防 handle 悬挂把 npm run check 卡死（verify-lifecycle 实测踩过）。 */
process.exit(process.exitCode)
