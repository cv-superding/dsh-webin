import { readFileSync } from 'node:fs'
const bundle = readFileSync('lib/index.js', 'utf8')
function extractClass(name) {
  const s = bundle.indexOf(`var ${name} = class`)
  if (s < 0) throw new Error('找不到 ' + name)
  const bs = bundle.indexOf('{', s)
  let d = 0
  for (let i = bs; i < bundle.length; i++) {
    if (bundle[i] === '{') d++
    else if (bundle[i] === '}') { d--; if (d === 0) return bundle.slice(s, i + 1) }
  }
}
// eslint-disable-next-line no-new-func
const JobQueue = new Function(`${extractClass('JobQueue')}\nreturn JobQueue`)()

let pass = 0, fail = 0
const check = (n, a, e) => {
  const ok = JSON.stringify(a) === JSON.stringify(e)
  if (ok) { pass++; console.log('  OK   ' + n) } else { fail++; console.log(`  FAIL ${n}  期望 ${JSON.stringify(e)} 实际 ${JSON.stringify(a)}`) }
}

console.log('=== 看门狗行为验证 ===\n')

console.log('[1] claimed 3 分钟没结果 → 回收')
{
  const q = new JobQueue()
  const j = q.enqueue('任务', false, 'deepseek', undefined, false, 's1')
  q.claimNext('deepseek', 's1')
  /** 模拟 4 分钟前 claim 的。 */
  const reaped = q.reapStaleClaimed(Date.now() + 240_000)
  check('⭐⭐ 超时任务被回收', reaped, 1)
  const got = q.get(j.id)
  check('⭐ 状态变 failed', got?.failed !== undefined, true)
  check('⭐ 失败原因写明', String(got?.failed).includes('失联'), true)
}

console.log('\n[2] claim 后 1 分钟（未超时）→ 不回收')
{
  const q = new JobQueue()
  q.enqueue('任务', false, 'deepseek', undefined, false, 's1')
  q.claimNext('deepseek', 's1')
  const reaped = q.reapStaleClaimed(Date.now() + 60_000)
  check('⭐⭐ 未超时不回收', reaped, 0)
}

console.log('\n[3] 已完成 / 未领取的 → 不动')
{
  const q = new JobQueue()
  const j1 = q.enqueue('完成', false, 'deepseek', undefined, false, 's1')
  const j2 = q.enqueue('未领', false, 'deepseek', undefined, false, 's1')
  q.claimNext('deepseek', 's1')
  q.settle(j1.id, { text: 'ok', think: '', status: 'finished' })
  const reaped = q.reapStaleClaimed(Date.now() + 400_000)
  check('⭐ done 不动', reaped, 0)
  check('⭐ 未领的也不动', q.get(j2.id)?.claimedAt === undefined, true)
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
process.exitCode = fail === 0 ? 0 : 1
/** ⚠️ 显式退出 —— 防 handle 悬挂把 npm run check 卡死（verify-lifecycle 实测踩过）。 */
process.exit(process.exitCode)
