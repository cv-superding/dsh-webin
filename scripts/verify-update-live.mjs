/**
 * 验证：更新检查的方向判断在**真实 GitHub** 上的四种情况。
 *
 * 上一轮发现一个「鸡生蛋」现象：产物里的提交号是**构建时**的 HEAD，
 * 而提交这个产物本身会产生新提交 ⇒ 最后那个提交永远无法包含自己的哈希。
 *
 * 这不是 bug，是固有限制。但它意味着：
 *   - 用户 pull 到的产物，提交号通常比远端 HEAD **落后一两个提交**
 *   - 于是「检查更新」可能显示「本地更新」（ahead）而不是「已是最新」
 *
 * 这里验证的是：**判断逻辑本身正确**（用已知的提交号去比）。
 */
import { readFileSync } from 'node:fs'

const hostBundle = readFileSync('lib/index.js', 'utf8')

function extract() {
  const start = hostBundle.indexOf('async function checkForUpdate(')
  const braceStart = hostBundle.indexOf('{', start)
  let depth = 0
  let end = braceStart
  for (let i = braceStart; i < hostBundle.length; i += 1) {
    const ch = hostBundle[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) { end = i + 1; break }
    }
  }
  return hostBundle.slice(start, end)
}

function makeFn(mine) {
  const prelude = `
    function currentVersion() { return { version: '0.1.0', commit: ${JSON.stringify(mine)}, repo: 'cv-superding/dsh-webin' } }
    const setTimeout = globalThis.setTimeout
    const clearTimeout = globalThis.clearTimeout
    const AbortController = globalThis.AbortController
    const fetch = globalThis.fetch
  `
  // eslint-disable-next-line no-new-func
  return new Function(`${prelude}\n${extract()}\nreturn checkForUpdate`)()
}

/** 拿远端真实 HEAD。 */
const res = await fetch('https://api.github.com/repos/cv-superding/dsh-webin/commits/main', {
  headers: { accept: 'application/vnd.github+json', 'user-agent': 'ldw-verify' },
})
const head = (await res.json()).sha.slice(0, 7)
console.log('远端 main HEAD =', head)
console.log('')

let pass = 0
let fail = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${ok ? '' : `  期望 ${JSON.stringify(expected)} 实际 ${JSON.stringify(actual)}`}`)
  if (ok) pass += 1
  else fail += 1
}

console.log('=== 1) 用远端真实 HEAD 比 → 应判 same ===')
{
  const r = await makeFn(head)()
  check('ok', r.ok, true)
  check('same', r.same, true)
  check('behind', r.behind, false)
  check('ahead', r.ahead, false)
}

console.log('\n=== 2) 用一个「远端不存在」的假提交号 → 应判 ahead（本地更新）===')
{
  const r = await makeFn('deadbee')()
  check('ok', r.ok, true)
  check('⭐ ahead', r.ahead, true)
  check('behind', r.behind, false)
}

console.log('\n=== 3) 用一个「远端存在的旧提交」→ 应判 behind（有更新）===')
{
  /** 第一个提交 —— 肯定在远端历史里，且不是 HEAD。 */
  const first = '6d71261'
  const r = await makeFn(first)()
  check('ok', r.ok, true)
  check('⭐ behind', r.behind, true)
  check('ahead', r.ahead, false)
  check('报告远端最新', r.latestCommit, head)
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
process.exitCode = fail === 0 ? 0 : 1
/** ⚠️ 显式退出 —— 防 handle 悬挂把 npm run check 卡死（verify-lifecycle 实测踩过）。 */
process.exit(process.exitCode)
