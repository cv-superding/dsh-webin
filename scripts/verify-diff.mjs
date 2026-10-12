#!/usr/bin/env node
/**
 * `diffPrompt()` 单元测试 —— **差分发送**是「网页版聊天记录堆满超长提示词」的根治点。
 *
 * 背景（用户实测反馈）：
 *   「为啥每次发消息，我看网页版聊天记录里面都是超级长的提示词」
 *
 * 原因：DSH 是标准 LLM 宿主，**每轮都把完整历史**交给 adapter。
 * 早期实现直接 flatten 全量 → 网页端每轮都收到「system + 全部历史」，
 * 于是聊天记录里堆满重复的超长提示词。
 *
 * cuckoo 没这问题是因为它**不是 adapter 而是 harness**：
 * 系统提示词只在项目初始化发一次，之后每轮只发新消息。
 * 本插件在 adapter 位置，所以必须自己补这层差分。
 *
 * 这个测试锁死三件事：
 *   1. 首轮发 system + 全部消息
 *   2. 后续轮**只发新增**（不重复 system、不重复旧消息）
 *   3. 历史变短（压缩/回退）时从头发 —— 否则页面会缺上下文
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = dirname(dirname(fileURLToPath(import.meta.url)))
const bundle = readFileSync(join(SRC, 'lib', 'index.js'), 'utf8')

/**
 * 从产物里抠出一段可独立求值的声明。
 *
 * ⚠️ 不能只靠花括号配对：函数体里含**字符串字面量**（如 `"{"`），
 * 会把配对带偏；而「找下一个顶层声明」又会误伤函数体里的嵌套声明。
 * 所以**用编译来验证**：从候选结束位置往回退，取第一个能编译通过的。
 */
function extract(bundle, pattern, name) {
  const m = bundle.match(pattern)
  if (m === null) throw new Error(`产物里找不到 ${name} —— 先跑 npm run build`)
  const start = m.index

  /** 尝试把 bundle[start..end] 变成一段可求值的声明。 */
  const tryCompile = (end) => {
    const text = bundle.slice(start, end)
    // `var X = class { ... }` → 补分号后是合法语句
    const assign = text.match(/^(?:var|const|let)\s+(\w+)\s*=\s*(class\s*\{[\s\S]*)$/)
    const candidate = assign !== null ? `var ${assign[1]} = ${assign[2]};` : text
    try {
      // eslint-disable-next-line no-new-func
      new Function(`${candidate}\n; return typeof ${name} === 'function' ? ${name} : undefined;`)
      return candidate
    } catch {
      return undefined
    }
  }

  // 候选 1：花括号配对结果（正确时最准）
  const openBrace = bundle.indexOf('{', start)
  let depth = 0
  let braceEnd = -1
  for (let i = openBrace; i < bundle.length; i += 1) {
    if (bundle[i] === '{') depth += 1
    else if (bundle[i] === '}') {
      depth -= 1
      if (depth === 0) {
        braceEnd = i + 1
        break
      }
    }
  }
  if (braceEnd > 0) {
    const ok = tryCompile(braceEnd)
    if (ok !== undefined) return ok
  }

  // 候选 2：逐个往后找能编译的结束点（粗到细）
  for (let end = braceEnd > 0 ? braceEnd : start + 200; end > start; end -= 1) {
    if (bundle[end - 1] !== '}') continue
    const ok = tryCompile(end)
    if (ok !== undefined) return ok
  }
  throw new Error(`无法提取 ${name}（编译验证全部失败）`)
}

const src = [
  // diffPrompt 现在走 serializeMessages 做消息序列化（支持 tool-call / tool 消息），
  // 所以要把它的传递闭包一起带上 —— 否则 `serializeMessages is not defined`。
  extract(bundle, /function fingerprint\(/, 'fingerprint'),
  /**
   * `serializeMessage` / `serializeMessages` 现在都调用 `normalizeNewlines`
   * （把 CRLF 折成 LF，见 verify-fill.mjs）。少了它就
   * `ReferenceError: normalizeNewlines is not defined`（踩过）。
   */
  extract(bundle, /function normalizeNewlines\(/, 'normalizeNewlines'),
  extract(bundle, /function serializeMessage\(/, 'serializeMessage'),
  extract(bundle, /function serializeMessages\(/, 'serializeMessages'),
  extract(bundle, /function contentToText\(/, 'contentToText'),
  extract(bundle, /function formatArguments\(/, 'formatArguments'),
  extract(bundle, /function diffPrompt\(/, 'diffPrompt'),
  // 产物里 class 被转成 `var SessionCursors = class {`
  extract(bundle, /(?:var|class)\s+SessionCursors\s*=\s*class\s*\{/, 'SessionCursors'),
  /**
   * `serializeMessage` 的默认参数引用了模块级常量 `TOOL_RESULT_LIMIT`。
   * 缺了它 ⇒ `ReferenceError: TOOL_RESULT_LIMIT is not defined`（踩过）。
   *
   * ⚠️ 产物里这行有前导 tab，所以 `^const` 匹配不到 —— 要允许空白。
   */
  extract(bundle, /^[ \t]*const TOOL_RESULT_LIMIT = /m, 'TOOL_RESULT_LIMIT'),
].join('\n')

// eslint-disable-next-line no-new-func
const { diffPrompt, SessionCursors } = new Function(
  `${src}\n; return { diffPrompt, SessionCursors };`,
)()

let pass = 0
let fail = 0
const check = (name, actual, expected) => {
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

const SYS = 'X'.repeat(200) + 'SYSTEM_TAIL'
const um = (t) => ({ role: 'user', content: t })
const am = (t) => ({ role: 'assistant', content: t })

/**
 * 模拟**真实调用点**：算出增量 → 投递 → 成功后 commit。
 *
 * diffPrompt() 现在是**纯函数**（不推进游标），游标推进靠返回的 commit()。
 * 这是为了修一个严重 bug：早期版本在算增量的同时就推进游标，
 * 于是**发送失败时那段上下文永久丢失**（下一轮只发之后的增量，页面里却没有中间那段）。
 * 所以测试也必须按真实用法来：只有投递成功才 commit。
 *
 * @param ok - 模拟投递是否成功。传 false 可验证「失败不推进游标」。
 */
const send = (opts, ok = true) => {
  // 平台是游标分文件持久化的维度；测试统一用 deepseek
  const r = diffPrompt({ platform: 'deepseek', ...opts })
  if (ok) r.commit()
  return r
}

console.log('=== diffPrompt 差分发送单元测试 ===\n')

console.log('[1] 首轮：必须发 system + 全部消息')
{
  const c = new SessionCursors()
  const r = send({ system: SYS, messages: [um('你好')], sessionKey: 's1', cursors: c })
  check('包含 system', r.text.includes('SYSTEM_TAIL'), true)
  check('包含首条用户消息', r.text.includes('你好'), true)
  check('标记为首轮', r.isFirst, true)
}

console.log('\n[2] 第二轮：只发新增，不重复 system 与旧消息')
{
  const c = new SessionCursors()
  send({ system: SYS, messages: [um('第一句')], sessionKey: 's1', cursors: c })
  const r2 = send({
    system: SYS,
    messages: [um('第一句'), am('第一答'), um('第二句')],
    sessionKey: 's1',
    cursors: c,
  })
  check('不含 system（关键）', r2.text.includes('SYSTEM_TAIL'), false)
  check('不含旧用户消息', r2.text.includes('第一句'), false)
  check('不含旧回复（页面自己已产生）', r2.text.includes('第一答'), false)
  check('含新增用户消息', r2.text.includes('第二句'), true)
  check('标记为非首轮', r2.isFirst, false)
  check('报告跳过了 1 条自己的回复', r2.skippedOwnReply, 1)
  // 这是用户报的那个 bug 的核心断言：第二轮长度应远小于全量
  check('第二轮长度 < 50 字符', r2.text.length < 50, true)
}

console.log('\n[2b] 连续多轮：每轮都要跳过页面自己的回复')
{
  const c = new SessionCursors()
  const msgs = [um('起')]
  send({ system: SYS, messages: [...msgs], sessionKey: 's1', cursors: c })
  const seen = []
  for (let turn = 0; turn < 4; turn += 1) {
    msgs.push(am(`回复${turn}`))
    const r1 = send({ system: SYS, messages: [...msgs], sessionKey: 's1', cursors: c })
    seen.push(r1.text.length)
    msgs.push(um(`输入${turn}`))
    const r2 = send({ system: SYS, messages: [...msgs], sessionKey: 's1', cursors: c })
    seen.push(r2.text.length)
  }
  check('「只有自己的回复」时增量为空', seen.filter((_, i) => i % 2 === 0).every((n) => n === 0), true)
  check('「有新输入」时增量非空且短', seen.filter((_, i) => i % 2 === 1).every((n) => n > 0 && n < 60), true)
  console.log(`       各步长度: ${seen.join(', ')}`)
}

console.log('\n[3] 多轮累积：每轮只发各自的新增（模拟真实 agent 循环）')
{
  const c = new SessionCursors()
  const msgs = [um('任务：读文件')]
  const sizes = []
  for (let turn = 0; turn < 5; turn += 1) {
    const r = send({ system: SYS, messages: [...msgs], sessionKey: 's1', cursors: c })
    sizes.push(r.text.length)
    msgs.push(am(`第${turn}轮回复`), um(`第${turn}轮结果`))
  }
  check('首轮含 system（>200）', sizes[0] > 200, true)
  check('后续轮都不含 system（每轮 <100）', sizes.slice(1).every((s) => s < 100), true)
  check('没有一轮重复发全量', sizes.slice(1).every((s) => s < sizes[0]), true)
  console.log(`       各轮长度: ${sizes.join(', ')}`)
}

console.log('\n[4] 历史变短（压缩/回退）→ 必须从头发')
{
  const c = new SessionCursors()
  send({ system: SYS, messages: [um('a'), am('b'), um('c'), am('d')], sessionKey: 's1', cursors: c })
  // 压缩后只剩 2 条
  const r = send({ system: SYS, messages: [um('压缩摘要'), am('好的')], sessionKey: 's1', cursors: c })
  check('重发 system', r.text.includes('SYSTEM_TAIL'), true)
  check('包含压缩后的摘要', r.text.includes('压缩摘要'), true)
  check('标记为首轮', r.isFirst, true)
}

console.log('\n[5] system 变了（换 agent/preset）→ 重发 system')
{
  const c = new SessionCursors()
  send({ system: SYS, messages: [um('a')], sessionKey: 's1', cursors: c })
  const r = send({
    system: 'NEW_SYSTEM_PROMPT_TAIL',
    messages: [um('a'), am('b'), um('c')],
    sessionKey: 's1',
    cursors: c,
  })
  check('含新 system', r.text.includes('NEW_SYSTEM_PROMPT_TAIL'), true)
  check('不含旧 system', r.text.includes('SYSTEM_TAIL'), false)
  check('含新增消息', r.text.includes('c'), true)
}

console.log('\n[6] 会话隔离：不同 sessionId 互不影响')
{
  const c = new SessionCursors()
  send({ system: SYS, messages: [um('会话A的消息')], sessionKey: 'A', cursors: c })
  const rb = send({ system: SYS, messages: [um('会话B的消息')], sessionKey: 'B', cursors: c })
  check('B 是新会话（发 system）', rb.text.includes('SYSTEM_TAIL'), true)
  check('B 有自己的消息', rb.text.includes('会话B的消息'), true)
  check('B 不含 A 的消息', rb.text.includes('会话A的消息'), false)
  check('游标表有 2 个会话', c.size(), 2)
}

console.log('\n[7] 完全相同的历史重复调用 → 增量为空（不重发）')
{
  const c = new SessionCursors()
  const msgs = [um('只发一次')]
  send({ system: SYS, messages: msgs, sessionKey: 's1', cursors: c })
  const again = send({ system: SYS, messages: msgs, sessionKey: 's1', cursors: c })
  check('增量为空串', again.text, '')
}

console.log('\n[8] 边界：无 system / 空消息 / 数组 content')
{
  const c = new SessionCursors()
  const r1 = send({ messages: [um('无系统提示')], sessionKey: 's1', cursors: c })
  check('无 system 时不报错', r1.text.includes('无系统提示'), true)

  const c2 = new SessionCursors()
  const r2 = send({
    system: SYS,
    messages: [{ role: 'user', content: [{ type: 'text', text: '数组块' }] }],
    sessionKey: 's2',
    cursors: c2,
  })
  check('数组 content 能提取', r2.text.includes('数组块'), true)

  const c3 = new SessionCursors()
  const r3 = send({ system: SYS, messages: [], sessionKey: 's3', cursors: c3 })
  check('空消息列表只发 system', r3.text.includes('SYSTEM_TAIL') && !r3.text.includes('## '), true)
}

console.log('\n[9] 游标表淘汰：不无限增长')
{
  const c = new SessionCursors(4)
  for (let i = 0; i < 10; i += 1) {
    send({ system: SYS, messages: [um(`m${i}`)], sessionKey: `s${i}`, cursors: c })
  }
  check('上限生效（<=4）', c.size() <= 4, true)
}

console.log('\n[10] ⭐ 投递失败**不得**推进游标（否则上下文永久丢失）')
{
  /**
   * 这是本轮修的最严重的一个 bug。
   *
   * 早期版本 `diffPrompt()` 在算增量的同时就 `cursors.set(...)`。
   * 于是发送失败/超时后：DSH 认为「这段内容发过了」，下一轮只发之后的增量 ——
   * 而页面里其实**没有**这段内容 ⇒ 中间那段上下文永久丢失，模型从此缺一段记忆。
   *
   * 修法：拆成「纯函数算增量」+「成功后 commit」。
   */
  const c = new SessionCursors()

  // 第一轮：投递失败
  const r1 = send({ system: SYS, messages: [um('第一句')], sessionKey: 's1', cursors: c }, false)
  check('失败时仍然返回了内容（供重试）', r1.text.includes('第一句'), true)
  check('失败后游标未建立', c.get('deepseek', 's1'), undefined)

  // 第二轮：同样的历史重试 —— 必须重新算出**完整**增量
  const r2 = send({ system: SYS, messages: [um('第一句')], sessionKey: 's1', cursors: c })
  check('重试仍含 system（没被当成已发过）', r2.text.includes('SYSTEM_TAIL'), true)
  check('重试仍含那条消息', r2.text.includes('第一句'), true)
  check('重试被标记为首轮', r2.isFirst, true)

  // 第三轮：这次成功了，再追加消息才走增量
  const r3 = send({ system: SYS, messages: [um('第一句'), am('答复'), um('第二句')], sessionKey: 's1', cursors: c })
  check('成功后转为增量（不含 system）', r3.text.includes('SYSTEM_TAIL'), false)
  check('成功后只发新消息', r3.text.includes('第二句') && !r3.text.includes('第一句'), true)

  // 中途失败不会让已成功的进度回退
  const r4 = send({ system: SYS, messages: [um('第一句'), am('答复'), um('第二句'), am('答复2'), um('第三句')], sessionKey: 's1', cursors: c }, false)
  check('失败那轮没推进游标', c.get('deepseek', 's1').sentCount, 3)
  const r5 = send({ system: SYS, messages: [um('第一句'), am('答复'), um('第二句'), am('答复2'), um('第三句')], sessionKey: 's1', cursors: c })
  check('重试补齐了第三句', r5.text.includes('第三句'), true)
  check('重试没有重复发第二句', r5.text.includes('第二句'), false)
  void r4
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
process.exitCode = fail === 0 ? 0 : 1
