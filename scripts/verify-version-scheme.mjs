/** 验证 readVersion 的递增行为（从真实 tsdown.config.ts 抽逻辑）。 */
import { readFileSync } from 'node:fs'

const cfg = readFileSync('tsdown.config.ts', 'utf8')
/** 抽出 readVersion 函数体，并去掉 TS 的返回类型标注。 */
const start = cfg.indexOf('function readVersion()')
const braceStart = cfg.indexOf('{', start)
let depth = 0
let end = braceStart
for (let i = braceStart; i < cfg.length; i += 1) {
  if (cfg[i] === '{') depth += 1
  else if (cfg[i] === '}') {
    depth -= 1
    if (depth === 0) { end = i + 1; break }
  }
}
/**
 * ⚠️ 只做一处精确替换（`function readVersion(): string {` → `function readVersion() {`），
 * 不用通用正则去「剥 TS」—— 那个做法我在 verify-update 里连踩两次坑
 * （漏了 `as X`、漏了可选参数 `x?:`）。
 * 这里函数体里没有其他类型标注，所以精确替换就够。
 */
const body = cfg.slice(start, end).replace('function readVersion(): string {', 'function readVersion() {')

const prelude = `
  const pkg = { version: '0.1.0' }
  let __described = ''
  let __count = ''
  let __sha = 'unknown'
  function git(args) {
    if (args === 'describe --tags --long') return __described
    if (args === 'rev-list --count HEAD') return __count
    if (args === 'rev-parse --short HEAD') return __sha
    return ''
  }
  function readCommit() { return git('rev-parse --short HEAD') || 'unknown' }
`
// eslint-disable-next-line no-new-func
const make = new Function(`${prelude}\n${body}\nreturn (d, c, s) => { __described = d; __count = c; __sha = s; return readVersion() }`)()
const readVersion = make

console.log('=== readVersion 行为（用真实源码逻辑）===\n')
const cases = [
  ['v0.1.0-0-g1d6e37d', '', '', '正好在 tag 上'],
  ['v0.1.0-1-gabc1234', '', '', 'tag 后 1 个提交'],
  ['v0.1.0-5-gdef5678', '', '', 'tag 后 5 个提交'],
  ['v0.1.0-31-g9999999', '', '', 'tag 后 31 个提交'],
  ['', '31', '1d6e37d', '没有 tag → 用提交总数'],
  ['', '', 'unknown', '什么都没有 → 退回 package.json'],
  ['0.2.0-3-gaaa1111', '', '', '不带 v 前缀的 tag'],
]
let pass = 0
let fail = 0
for (const [d, c, s, label] of cases) {
  const got = readVersion(d, c, s)
  console.log(`  ${String(d || '(无 tag)').padEnd(22)} → ${got.padEnd(22)} ${label}`)
  /** 关键断言：tag 之后有提交时，版本号必须**不同于** tag 版本。 */
  if (d !== '' && !d.includes('-0-')) {
    const changed = got !== '0.1.0'
    if (changed) pass += 1
    else { fail += 1; console.log('    ❌ 版本号没变！') }
  }
}

console.log('\n=== 关键结论 ===')
const a = readVersion('v0.1.0-0-g1d6e37d', '', '')
const b = readVersion('v0.1.0-1-gabc1234', '', '')
const c = readVersion('v0.1.0-5-gdef5678', '', '')
console.log(`  在 tag 上     : ${a}`)
console.log(`  tag 后 1 提交 : ${b}`)
console.log(`  tag 后 5 提交 : ${c}`)
const distinct = new Set([a, b, c]).size === 3
console.log(`  三者互不相同  : ${distinct ? '✅' : '❌'}`)
console.log(`  ⇒ 每次提交后重新构建，版本号都会变：${distinct ? '成立' : '不成立'}`)

console.log('\n[2] ⭐⭐ splitVersion / formatBuiltAt（从构建产物里抽，测真在跑的代码）')
{
  /**
   * ⚠️ 这两个函数**只进 client 产物** —— `splitVersion` / `formatBuiltAt`
   * 是设置页显示用的，host 半用不到，所以打包器把它摇掉了。
   * 一开始我只在 `lib/index.js` 里找，报「产物里找不到」（踩过）。
   */
  const bundles = {
    host: readFileSync('lib/index.js', 'utf8'),
    client: readFileSync('lib/client.js', 'utf8'),
  }

  /** 在任一产物里找一个具名函数（花括号配对）。 */
  const extract = (name) => {
    for (const [which, src] of Object.entries(bundles)) {
      const s = src.indexOf(`function ${name}(`)
      if (s < 0) continue
      const bs = src.indexOf('{', s)
      let depth = 0
      for (let i = bs; i < src.length; i += 1) {
        if (src[i] === '{') depth += 1
        else if (src[i] === '}') {
          depth -= 1
          if (depth === 0) return src.slice(s, i + 1)
        }
      }
    }
    throw new Error(`两个产物里都找不到 ${name} —— 先跑 npm run build`)
  }

  // eslint-disable-next-line no-new-func
  const splitVersion = new Function(`${extract('splitVersion')}\nreturn splitVersion`)()
  // eslint-disable-next-line no-new-func
  const formatBuiltAt = new Function(`${extract('formatBuiltAt')}\nreturn formatBuiltAt`)()

  let p = 0
  let f2 = 0
  const ck = (name, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected)
    console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${ok ? '' : `  期望 ${JSON.stringify(expected)} 实际 ${JSON.stringify(actual)}`}`)
    if (ok) p += 1
    else f2 += 1
  }

  /** 用户报的问题就在这里：完整版本号必须能拆出「会变的那部分」。 */
  ck('拆 0.1.0+5.def5678', splitVersion('0.1.0+5.def5678'), { base: '0.1.0', build: '5.def5678' })
  ck('无后缀时 build 为空', splitVersion('0.1.0'), { base: '0.1.0', build: '' })
  ck('前缀带 v 也能拆', splitVersion('v0.1.0+0.abc'), { base: 'v0.1.0', build: '0.abc' })

  const now = Date.parse('2026-10-13T12:00:00Z')
  ck('刚刚', formatBuiltAt('2026-10-13T11:59:30Z', now), '刚刚构建')
  ck('12 分钟前', formatBuiltAt('2026-10-13T11:48:00Z', now), '12 分钟前构建')
  ck('3 小时前', formatBuiltAt('2026-10-13T09:00:00Z', now), '3 小时前构建')
  ck('⭐ 空串 → 空（不渲染）', formatBuiltAt('', now), '')
  ck('⭐ 坏时间戳 → 空（不崩）', formatBuiltAt('not-a-date', now), '')
  /** 时钟偏差导致的「未来时间」不能显示成负数。 */
  ck('⭐ 未来时间当刚刚', formatBuiltAt('2026-10-13T12:05:00Z', now), '刚刚构建')
  /** 更早的用绝对时间。 */
  const old = formatBuiltAt('2026-01-02T03:04:00Z', now)
  ck('⭐ 超过一天 → 绝对时间', /\d{4}-\d{2}-\d{2} \d{2}:\d{2} 构建/.test(old), true)

  console.log(`\n  splitVersion/formatBuiltAt：${p} 通过 / ${f2} 失败`)
  if (f2 > 0) process.exitCode = 1
  else if (!distinct || fail > 0) process.exitCode = 1
  else process.exitCode = 0
}
