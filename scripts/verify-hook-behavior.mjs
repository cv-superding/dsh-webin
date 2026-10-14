#!/usr/bin/env node
/**
 * ## ⭐⭐⭐ SSE 解析的行为测试（不是「源码里写了什么」，而是「跑起来对不对」）
 *
 * ## 为什么需要
 *
 * 页面内 hook 负责从网页版自己的 SSE 流里读回复。它长期**从未真正运行过** ——
 * `hook.ts` 里一个正则少写一层反斜杠，生成的脚本非法，注入直接抛
 * `SyntaxError`，这条路径整个没生效（而主路径读 DOM 照常工作，所以故障静默）。
 *
 * 转义修好之后，**解析逻辑第一次真正被执行**，因此必须补行为测试：
 * 把 hook 脚本放进沙箱、喂合成的 SSE 帧、断言它吐出来的事件。
 *
 * 测试的是「帧 → 事件」的映射，含三条真实事故对应的判据：
 *   1. 裸增量帧（没有 p）必须归给**最近一次路径帧**指向的 fragment
 *      —— 早期实现一律塞进正文，导致思考丢失 / 围栏丢失
 *   2. `response/fragments` 的首帧负责登记**类型表**（THINK / RESPONSE）
 *   3. 状态帧 `FINISHED` 才结束；业务错误信封要单独报 error
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const BUNDLE = join(ROOT, 'lib', 'client.js')

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

const src = readFileSync(BUNDLE, 'utf8')

/** 提取函数源码（跳过字符串 / 模板 / 注释，避免花括号被内容带偏）。 */
function extractFn(name) {
  const re = new RegExp(`function ${name}\\(([^)]*)\\)\\s*\\{`)
  const m = re.exec(src)
  if (m === null) return null
  const open = src.indexOf('{', m.index)
  let depth = 0
  let mode = null
  let tplDepth = 0
  for (let i = open; i < src.length; i += 1) {
    const c = src[i]
    const n = src[i + 1]
    if (mode === null) {
      if (c === "'" || c === '"') mode = c
      else if (c === '`') {
        mode = '`'
        tplDepth = 0
      } else if (c === '/' && n === '/') {
        mode = '//'
        i += 1
      } else if (c === '/' && n === '*') {
        mode = '/*'
        i += 1
      } else if (c === '{') depth += 1
      else if (c === '}') {
        depth -= 1
        if (depth === 0) return src.slice(m.index, i + 1)
      }
      continue
    }
    if (mode === '//') {
      if (c === '\n') mode = null
    } else if (mode === '/*') {
      if (c === '*' && n === '/') {
        mode = null
        i += 1
      }
    } else if (mode === "'" || mode === '"') {
      if (c === '\\') i += 1
      else if (c === mode) mode = null
    } else if (c === '\\') i += 1
    else if (c === '$' && n === '{') {
      tplDepth += 1
      i += 1
    } else if (c === '}' && tplDepth > 0) tplDepth -= 1
    else if (c === '`' && tplDepth === 0) mode = null
  }
  return null
}

const PRELUDE =
  'const MARKER = "__dshWebinHookInstalled__";\n' +
  'const EVENT_QUEUE_KEY = MARKER + "_events";\n' +
  'const COMPLETION_PATH = "/api/v0/chat/completion";\n' +
  'const STOP_PATH = "/api/v0/chat/stop_stream";\n'

const buildHook = new Function(
  `${PRELUDE}\nreturn (${extractFn('buildDeepSeekHook')})`,
)()
const buildDrain = new Function(
  `${PRELUDE}\nreturn (${extractFn('buildDrainScript')})`,
)()

const HOOK_SCRIPT = buildHook('/api/v0/chat/completion', '/api/v0/chat/stop_stream')
const DRAIN_SCRIPT = buildDrain()

/** 造一个带 body 的假 Response；`clone()` 返回同内容的另一份。 */
function makeResponse(text) {
  const bytes = new TextEncoder().encode(text)
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(bytes)
      c.close()
    },
  })
  return {
    ok: true,
    status: 200,
    body: stream,
    clone() {
      return makeResponse(text)
    },
  }
}

/** 把 hook 装进一个干净沙箱，返回 { ctx, drain }。 */
function bootHook(responder) {
  const sandbox = {
    console,
    TextEncoder,
    TextDecoder,
    ReadableStream,
    Uint8Array,
    Array,
    Object,
    String,
    Number,
    Boolean,
    JSON,
    Math,
    Date,
    RegExp,
    Error,
    TypeError,
    Promise,
    WeakMap,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  }
  sandbox.window = sandbox
  sandbox.self = sandbox
  sandbox.location = { href: 'https://chat.deepseek.com/', pathname: '/', protocol: 'https:' }
  sandbox.document = { addEventListener() {}, removeEventListener() {}, readyState: 'complete' }
  sandbox.addEventListener = () => {}
  sandbox.removeEventListener = () => {}
  sandbox.dispatchEvent = () => true
  sandbox.CustomEvent = class {
    constructor(type, init) {
      this.type = type
      this.detail = init && init.detail
    }
  }
  sandbox.XMLHttpRequest = function () {}
  sandbox.XMLHttpRequest.prototype = { open() {}, send() {}, addEventListener() {} }
  sandbox.fetch = (url, init) => Promise.resolve(responder(String(url), init || {}))

  const ctx = vm.createContext(sandbox)
  vm.runInContext(HOOK_SCRIPT, ctx, { filename: 'injected-hook.js' })
  return {
    ctx,
    drain: () => JSON.parse(vm.runInContext(DRAIN_SCRIPT, ctx, { filename: 'drain.js' })),
  }
}

const frame = (obj) => `data: ${JSON.stringify(obj)}\n\n`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

console.log('[1] 正常一轮：思考 + 正文（含裸增量归属）')
{
  /**
   * ⚠️ 路径帧的分流依据是**路径末段字段名**，不是类型表：
   *   reasoning_content / thinking_content  ⇒ THINK
   *   content / text / markdown / delta      ⇒ RESPONSE
   * 所以思考帧必须写 `reasoning_content`（写成 `content` 会被正当地判为正文
   * —— 第一版测试就是这么写错的，误判成 hook 的 bug）。
   */
  const sse =
    frame({ p: 'response/fragments', o: 'APPEND', v: [{ type: 'THINK', content: '' }, { type: 'RESPONSE', content: '' }] }) +
    frame({ p: 'response/fragments/0/reasoning_content', o: 'APPEND', v: '想一下' }) +
    frame({ p: 'response/fragments/1/content', o: 'APPEND', v: '你好' }) +
    frame({ v: '，世界' }) +
    frame({ v: '！' }) +
    frame({ p: 'response/status', o: 'SET', v: 'FINISHED' })

  const h = bootHook(() => makeResponse(sse))
  await h.ctx.fetch('/api/v0/chat/completion', { method: 'POST' })
  await sleep(60)
  const evs = h.drain()
  const done = evs.filter((e) => e.name === 'done').pop()

  check('产生了 done 事件', done !== undefined, true)
  check('正文合并正确（裸增量归给正文 fragment）', done?.detail?.text, '你好，世界！')
  check('思考合并正确（reasoning_content 帧进 think）', done?.detail?.think, '想一下')
  check('status 为 finished', done?.detail?.status, 'finished')
  check('没有 error 事件', evs.filter((e) => e.name === 'error').length, 0)
}

console.log('\n[2] 裸增量不得污染正文（首帧只带路径、不带内容）')
{
  const sse =
    frame({ p: 'response/fragments', o: 'APPEND', v: [{ type: 'THINK', content: '' }, { type: 'RESPONSE', content: '' }] }) +
    frame({ v: '只有裸增量' }) +
    frame({ p: 'response/status', o: 'SET', v: 'FINISHED' })

  const h = bootHook(() => makeResponse(sse))
  await h.ctx.fetch('/api/v0/chat/completion', { method: 'POST' })
  await sleep(60)
  const done = h.drain().filter((e) => e.name === 'done').pop()
  check('裸增量落在 RESPONSE（末个 fragment）', done?.detail?.text, '只有裸增量')
  check('思考仍为空', done?.detail?.think, '')
}

console.log('\n[3] 业务错误信封要报 error')
{
  const sse =
    frame({ p: 'response/fragments', o: 'APPEND', v: [{ type: 'RESPONSE', content: '' }] }) +
    frame({ v: '开头' }) +
    frame({ code: 401, msg: '登录已过期' })

  const h = bootHook(() => makeResponse(sse))
  await h.ctx.fetch('/api/v0/chat/completion', { method: 'POST' })
  await sleep(60)
  const evs = h.drain()
  const err = evs.filter((e) => e.name === 'error').pop()
  check('产生了 error 事件', err !== undefined, true)
  check('error 带上业务消息', err?.detail?.message, '登录已过期')
}

console.log('\n[4] 非目标路径不得被解析（只观察 completion）')
{
  const sse = frame({ v: '不该被读到的内容' }) + frame({ p: 'response/status', o: 'SET', v: 'FINISHED' })
  const h = bootHook(() => makeResponse(sse))
  await h.ctx.fetch('/api/v0/chat/some_other_api', { method: 'POST' })
  await sleep(60)
  const evs = h.drain()
  check('没有 done 事件', evs.filter((e) => e.name === 'done').length, 0)
  check('没有 error 事件', evs.filter((e) => e.name === 'error').length, 0)
}

console.log('\n[5] ⭐⭐⭐ F25：无 fragment 时思考必须被缓冲（照参考实现移植）')
{
  /**
   * ## 为什么必须有这条
   *
   * 参考实现（dsh-deepseek-web-login）用**真实帧**复现并记录了这个事故：
   *
   * > 思考的归属完全依赖首帧快照里的 THINK fragment。一旦快照没能进入状态机，
   * > fragments 就一直是空的，而旧实现在「无 fragment 可续」时**无条件当正文
   * > 发射** ⇒ 整段思考上屏。实测：一轮 2062 字符、两轮 10526 / 4360 字符
   * > 全部进正文。
   *
   * dsh-webin 的 route() 有一模一样的缺陷：
   *
   *     var kind = forceKind ?? (currentIsThink() ? 'think' : 'text');   // 空表 ⇒ 'text'
   *
   * ## 修法（照参考实现）
   *
   * 开了思考、但还没有任何 fragment 时，裸增量先**缓冲**，等 fragment 出现
   * 再按它的类型定归属。未开思考时不缓冲，保持旧行为。
   */
  const frame = (obj) => `data: ${JSON.stringify(obj)}\n\n`
  const FENCE3 = '```'

  /** ① 开了思考 + 快照丢失（首帧就是裸增量）⇒ 不许进正文。 */
  {
    const sse =
      frame({ v: '这是思考的内容，绝不该进正文。' }) +
      frame({ p: 'response/fragments', o: 'APPEND', v: [{ type: 'THINK', content: '' }] }) +
      frame({ v: '继续思考' }) +
      frame({ p: 'response/status', o: 'SET', v: 'FINISHED' })

    const h = bootHook(() => makeResponse(sse), { thinking_enabled: true })
    await h.ctx.fetch('/api/v0/chat/completion', { method: 'POST', body: '{"thinking_enabled":true}' })
    await sleep(60)
    const done = h.drain().filter((e) => e.name === 'done').pop()

    check('⭐⭐⭐ 快照丢失时思考不进正文', done?.detail?.text ?? '', '')
    check('⭐⭐ 缓冲的思考归属到 think', (done?.detail?.think ?? '').includes('这是思考的内容'), true)
  }

  /** ② 没开思考 ⇒ 保持旧行为（裸增量直接进正文，不缓冲）。 */
  {
    const sse =
      frame({ v: '这是正文。' }) +
      frame({ p: 'response/fragments', o: 'APPEND', v: [{ type: 'RESPONSE', content: '' }] }) +
      frame({ p: 'response/status', o: 'SET', v: 'FINISHED' })

    const h = bootHook(() => makeResponse(sse), { thinking_enabled: false })
    await h.ctx.fetch('/api/v0/chat/completion', { method: 'POST', body: '{"thinking_enabled":false}' })
    await sleep(60)
    const done = h.drain().filter((e) => e.name === 'done').pop()
    check('⭐⭐ 未开思考时裸增量仍进正文', (done?.detail?.text ?? '').includes('这是正文'), true)
  }

  /** ③ 正常流（首帧快照带 THINK）⇒ 思考与正文各归各位。 */
  {
    const sse =
      frame({ p: 'response/fragments', o: 'APPEND', v: [{ type: 'THINK', content: '' }, { type: 'RESPONSE', content: '' }] }) +
      frame({ p: 'response/fragments/0/reasoning_content', o: 'APPEND', v: '想一下' }) +
      frame({ p: 'response/fragments/1/content', o: 'APPEND', v: '答案' }) +
      frame({ p: 'response/status', o: 'SET', v: 'FINISHED' })

    const h = bootHook(() => makeResponse(sse), { thinking_enabled: true })
    await h.ctx.fetch('/api/v0/chat/completion', { method: 'POST', body: '{"thinking_enabled":true}' })
    await sleep(60)
    const done = h.drain().filter((e) => e.name === 'done').pop()
    check('⭐⭐ 正常流：思考归 think', done?.detail?.think, '想一下')
    check('⭐⭐ 正常流：正文归 text', done?.detail?.text, '答案')
  }
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
process.exitCode = fail === 0 ? 0 : 1
