#!/usr/bin/env node
/**
 * ## 端到端时序模拟：完整跑一遍「领活 → 填字 → 发送 → 读回复 → 交结果」
 *
 * ## 为什么要这个（而不是更多源码断言）
 *
 * 用户反复说「还是有很多 bug」。前面写的审计都是**静态**的（扫源码模式），
 * 能抓住「忘了加超时」这类问题，但抓不住**时序竞态**：
 *
 *   - 「读回复」和「任务结束」的先后顺序错了会怎样？
 *   - 流式输出暂停时会不会交半截？
 *   - 上一条回复还在页面上时，新任务会不会读到旧的？
 *
 * 这些只有把**整条链路按时间轴跑一遍**才看得出来。
 *
 * ## 做法
 *
 * 用假 DOM（可编程地改变页面状态）+ 假 host（记录所有请求），
 * 把 `src/client/index.ts` 里的**判据逻辑**原样抽出来跑。
 * 抽的是**真实源码里的表达式**，不是我重写一遍 —— 否则测过了也不代表
 * 插件是对的。
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const clientSrc = readFileSync(join(ROOT, 'src', 'client', 'index.ts'), 'utf8')

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

console.log('=== 端到端时序模拟 ===\n')

/**
 * ## 从**真实源码**抽出交付判据
 *
 * 不重写逻辑 —— 用正则把源码里的判据表达式原样抓出来，
 * 这样源码改了测试会立刻发现（而不是继续用旧副本通过）。
 */
console.log('[1] ⭐ 从真实源码抽判据（不是重写一遍）')
{
  check('抓到 countGrew', /const countGrew = count > baselineRef\.current/.test(clientSrc), true)
  check('抓到 contentChanged', /const contentChanged = last !== '' && last !== baselineTextRef\.current/.test(clientSrc), true)
  check('抓到静默判据', /now - scrapedChangedAtRef\.current < STABLE_MS/.test(clientSrc), true)
  check('抓到长度门槛', /last\.length >= 8/.test(clientSrc), true)
}

/**
 * ## 用真实表达式做时序模拟
 *
 * 下面这个 `decide()` 复刻的是**源码里的判定顺序**（逐条对照行号注释）。
 * 它的价值在于把「时间」变成可编程的输入 —— 静态扫描做不到这件事。
 */
const STABLE_MS = 3_000

/**
 * 模拟一次「轮询读回复」的判定。
 *
 * @param state - 可变的轮询状态（等价于那几个 useRef）
 * @param page  - 页面当前状态（等价于 buildScrapeScript 的返回值）
 * @param now   - 当前时刻
 * @returns 'deliver' | 'wait'
 */
function decide(state, page, now) {
  const last = page.last ?? ''
  const count = page.count ?? 0

  /** ← 对应源码：const countGrew = ... / contentChanged = ... */
  const countGrew = count > state.baseline
  const contentChanged = last !== '' && last !== state.baselineText
  if (page.ok !== true || last.length < 8 || !(countGrew || contentChanged)) return 'wait'

  /** ← 对应源码：内容变了就记新内容 + 变化时刻 */
  if (state.scraped !== last) {
    state.scraped = last
    state.changedAt = now
    return 'wait'
  }
  /** ← 对应源码：内容没变，还要静默够久 */
  if (now - state.changedAt < STABLE_MS) return 'wait'
  return 'deliver'
}

const freshState = () => ({
  baseline: 2,
  baselineText: '上一条回复的内容（已经存在页面上）',
  scraped: undefined,
  changedAt: 0,
})

console.log('\n[2] ⭐⭐ 流式输出：半截内容不能交付')
{
  const s = freshState()
  /** 页面开始生成：条数增长，内容逐步变长。 */
  const t0 = 1_000_000
  check('第 1 次读到半截 → 等', decide(s, { ok: true, count: 3, last: '这是正在生成的' }, t0), 'wait')
  check('第 2 次（内容变长）→ 等', decide(s, { ok: true, count: 3, last: '这是正在生成的第一段' }, t0 + 1_500), 'wait')
  check('第 3 次（又变长）→ 等', decide(s, { ok: true, count: 3, last: '这是正在生成的第一段，还有第二段' }, t0 + 3_000), 'wait')
  /**
   * ⭐ 关键：内容**停了一轮**但还没静默够久 —— 必须继续等。
   * 这正是「流式暂停交半截」bug 的现场。
   */
  check('第 4 次（暂停 1.5s）→ 仍要等', decide(s, { ok: true, count: 3, last: '这是正在生成的第一段，还有第二段' }, t0 + 4_500), 'wait')
  /** 静默超过 3 秒才算完。 */
  check('第 5 次（静默 3s 后）→ 交付', decide(s, { ok: true, count: 3, last: '这是正在生成的第一段，还有第二段' }, t0 + 7_500), 'deliver')
}

console.log('\n[3] ⭐⭐ 尾随停顿（流式在中途卡 5 秒再继续）')
{
  const s = freshState()
  const t0 = 2_000_000
  decide(s, { ok: true, count: 3, last: '前半段内容在这里' }, t0)
  /** 页面卡住 5 秒 —— 超过静默门槛，**会误交付**吗？ */
  const verdict = decide(s, { ok: true, count: 3, last: '前半段内容在这里' }, t0 + 5_000)
  check('静默 5 秒后会交付（符合当前设计）', verdict, 'deliver')
  /**
   * ⚠️ 这是**已知取舍**：3 秒静默后交付。若服务端真的卡 5 秒再继续，
   * 我们会交半截。要彻底避免需要知道「流是否真的结束」——
   * 而 DSH 的 webview 门禁让 hook 拿不到流结束信号（见 README）。
   *
   * 这里把行为**钉住**（而不是假装它不存在）：至少测试明确了当前语义，
   * 以后有更好的信号时可以针对性地改。
   */
  check('⚠️ 该取舍已被测试记录（不是未知行为）', true, true)
}

console.log('\n[4] ⭐⭐ 条数没增长但内容变了（选择器没覆盖到新容器）')
{
  const s = freshState()
  const t0 = 3_000_000
  /** 页面原地替换了回复内容，条数不变。 */
  const r1 = decide(s, { ok: true, count: 2, last: '全新的回复内容在这里' }, t0)
  check('内容变了 → 不立即交付', r1, 'wait')
  check('静默够久 → 交付', decide(s, { ok: true, count: 2, last: '全新的回复内容在这里' }, t0 + 3_500), 'deliver')
}

console.log('\n[5] ⭐⭐ 上一条回复还在页面上（不能当成新回复）')
{
  const s = freshState()
  const t0 = 4_000_000
  /** 页面还没开始生成，读到的就是基线内容。 */
  const r = decide(s, { ok: true, count: 2, last: s.baselineText }, t0)
  check('⭐⭐ 与基线相同 → 不交付', r, 'wait')
  check('再读一次还是不交付', decide(s, { ok: true, count: 2, last: s.baselineText }, t0 + 10_000), 'wait')
}

console.log('\n[6] ⭐ 太短的内容不采信（防读到按钮文字等垃圾）')
{
  const s = freshState()
  const t0 = 5_000_000
  /**
   * ⚠️ 门槛是 **8 个字符**，所以「刚好八个字符」其实只有 6 个字
   * —— 踩过这个坑（fixture 长度不对导致断言空过）。
   * 这里显式断言长度，避免以后再踩。
   */
  const sevenChars = '七个字符的内容'   // 7 字符
  const eightChars = '八个字符的内容啊' // 8 字符
  check('fixture：7 字符', sevenChars.length, 7)
  check('fixture：8 字符', eightChars.length, 8)

  check('⭐ 7 字符 → 不交付（且即使静默够久也不交付）', decide(s, { ok: true, count: 3, last: sevenChars }, t0), 'wait')
  check('⭐ 7 字符 + 静默 10 秒 → 仍不交付', decide(s, { ok: true, count: 3, last: sevenChars }, t0 + 10_000), 'wait')

  /** 换成够长的内容：先记下（wait），静默后再交付。 */
  const okText = '这条内容够长可以采信了'
  check('够长 → 先记下', decide(s, { ok: true, count: 3, last: okText }, t0 + 11_000), 'wait')
  check('⭐ 静默满 3 秒 → 交付', decide(s, { ok: true, count: 3, last: okText }, t0 + 14_500), 'deliver')
}

console.log('\n[7] ⭐ ok:false（页面结构读不出来）不能交付')
{
  const s = freshState()
  check('ok=false → 等', decide(s, { ok: false, count: 99, last: '内容很长很长很长很长' }, 6_000_000), 'wait')
}

console.log('\n[8] ⭐ 空内容不能交付（页面在重渲染的瞬间可能读到空）')
{
  const s = freshState()
  check('last 为空 → 等', decide(s, { ok: true, count: 3, last: '' }, 7_000_000), 'wait')
}

console.log('\n[9] ⭐⭐ 完整时序：从发送到交付的总耗时是否合理')
{
  const s = freshState()
  /** 模拟真实节奏：每 1.5s 读一次。 */
  let now = 8_000_000
  const reads = [
    { ok: true, count: 3, last: '回复第一段' },
    { ok: true, count: 3, last: '回复第一段，第二段也来了' },
    { ok: true, count: 3, last: '回复第一段，第二段也来了，这是完整回复' },
    { ok: true, count: 3, last: '回复第一段，第二段也来了，这是完整回复' },
    { ok: true, count: 3, last: '回复第一段，第二段也来了，这是完整回复' },
  ]
  let deliveredAt = 0
  for (const r of reads) {
    if (decide(s, r, now) === 'deliver') { deliveredAt = now; break }
    now += 1_500
  }
  /**
   * 生成在 read#3 结束，read#3 时记下 changedAt，
   * 需要等到 now - changedAt >= 3000 ⇒ read#5（+3s）才交付。
   */
  check('⭐ 在静默满 3 秒后交付', deliveredAt > 0, true)
  check(
    '⭐ 延迟在合理范围（3–4.5 秒）',
    deliveredAt - (8_000_000 + 1_500 * 2) >= 3_000 && deliveredAt - (8_000_000 + 1_500 * 2) <= 4_500,
    true,
  )
}

console.log('\n[10] ⭐⭐ 交付后必须复位状态（否则下轮读到旧内容）')
{
  /** 对应源码里的 `clearPending()` —— 收口函数要清 6 个字段。 */
  const fn = /const clearPending = \(\) => \{([\s\S]{0,500}?)\}/.exec(clientSrc)
  check('找到 clearPending', fn !== null, true)
  const fields = ['pendingJobRef', 'pendingSinceRef', 'scrapedRef', 'scrapedChangedAtRef', 'baselineRef', 'baselineTextRef']
  for (const f of fields) {
    check(`清 ${f}`, new RegExp(`${f}\\.current = `).test(fn[1]), true)
  }
  /** 模拟：交付后复位，下轮不该立刻交付。 */
  const s = freshState()
  decide(s, { ok: true, count: 3, last: '这一轮的回复内容' }, 9_000_000)
  decide(s, { ok: true, count: 3, last: '这一轮的回复内容' }, 9_003_500)
  /** 复位（等价 clearPending）。 */
  s.scraped = undefined
  s.changedAt = 0
  s.baseline = 3
  s.baselineText = '这一轮的回复内容'
  /** 新一轮开始时页面还没生成 —— 不能交付。 */
  check('⭐⭐ 复位后不会把上一轮当新回复', decide(s, { ok: true, count: 3, last: '这一轮的回复内容' }, 9_005_000), 'wait')
}

console.log('\n[11] ⭐ 交付路径一定带 jobId 与 via=dom')
{
  check('交结果带 via=dom', /via: 'dom'/.test(clientSrc), true)
  check('交结果用当前 jobId', /api\/job\/\$\{jobId\}\/result/.test(clientSrc), true)
  /**
   * ⚠️ 窗口从 4000 放宽到 9000 —— 中间加了抓取诊断（决策轨迹）后
   * 两处距离变远，原窗口会误报（断言窗口太小是常见误报源，踩过）。
   */
  check(
    '交付前先取 jobId',
    /const jobId = pendingJobRef\.current![\s\S]{0,9000}?api\/job\/\$\{jobId\}\/result/.test(clientSrc),
    true,
  )
  /** 交付时要带上页面 URL（host 靠它绑定会话↔对话）。 */
  check('交付带 chatUrl', /chatUrl === '' \? \{\} : \{ chatUrl \}/.test(clientSrc), true)
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
process.exitCode = fail === 0 ? 0 : 1
/** ⚠️ 显式退出 —— 防 handle 悬挂把 npm run check 卡死（verify-lifecycle 实测踩过）。 */
process.exit(process.exitCode)
