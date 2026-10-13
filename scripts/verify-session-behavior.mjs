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

console.log('\n[5] ⭐⭐ 窗口没上报 sessionId 时不抢别人的活')
{
  const q = new JobQueue()
  q.enqueue('给 A 的', false, 'deepseek', undefined, false, 'session-A')
  /** 没上报的窗口（sessionId=undefined）—— 不能领走有归属的任务。 */
  check('⭐⭐ 未上报的窗口领不到有归属的任务', q.claimNext('deepseek', undefined), undefined)
  /** 但能领没有归属的。 */
  q.enqueue('无归属的', false, 'deepseek')
  check('⭐ 未上报的窗口能领无归属的', q.claimNext('deepseek', undefined)?.prompt, '无归属的')
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

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
process.exitCode = fail === 0 ? 0 : 1
