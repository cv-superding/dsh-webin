/**
 * 端到端验证工具循环 —— 从「页面抓到的原文」一路跑到「adapter 吐出 tool-call」。
 *
 * ## 为什么必须做这个测试（用户实测「还是一问一答」）
 *
 * 之前的测试都是**分段**验证的：
 *   - verify:scrape / verify:lang  只验证「DOM → markdown」
 *   - verify:tools / verify:tool-chunks  只验证「手写的 markdown → tool-call」
 *
 * **没有一条测试把两段接起来**。于是每段都绿，合起来却是「一问一答」——
 * 因为中间某个格式细节对不上（真实事故：语言标签在 pre 外面 ⇒ 围栏丢了
 * `ldw` ⇒ DSH 的 FENCE_LANG 匹配失败 ⇒ 整块当纯文本 ⇒ finish 报 `stop`
 * ⇒ DSH 认为「这轮结束了」⇒ **永远不会有第二轮**）。
 *
 * ## 「一问一答」的机制（本测试的核心断言）
 *
 * 循环由 **DSH** 驱动，触发条件是 adapter 发出的 `finish` chunk：
 *
 *     finish.reason.kind === 'tool-calls'  ⇒ DSH 执行工具 → 回灌 → 再调 adapter
 *     finish.reason.kind === 'stop'        ⇒ DSH 认为本轮结束 ⇒ 交回用户
 *
 * ⇒ **只要 finish 是 `stop`，就一定是一问一答**，无论模型多听话。
 *
 * ## 输入是真实抓取产物
 *
 * 不是手写的 markdown，而是 buildScrapeScript 对真实 DeepSeek DOM 结构
 * （语言标签在 pre 外面）跑出来的原文 ⇒ 任何一段坏掉都会红。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isolate } from './lib/isolate.mjs'
import {
  makeCtx,
  makeCall,
  runRound,
  prepareState,
  finishKind,
  toolCalls,
  textOut,
  nextSession,
  TOOLS,
} from './lib/adapter-harness.mjs'

const ROOT = process.cwd()
let pass = 0
let fail = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) pass++
  else fail++
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}`)
  if (!ok) {
    console.log(`       期望 ${JSON.stringify(expected)}`)
    console.log(`       实际 ${JSON.stringify(actual)}`)
  }
}

/** ---- 从产物里取 buildScrapeScript（client 半，CJS 包装）---- */
function loadScrapeScript() {
  const bundle = readFileSync(`${ROOT}/lib/client.js`, 'utf8')
  const m = bundle.match(/function buildScrapeScript\(\)/)
  const open = bundle.indexOf('{', m.index)
  let depth = 0
  let end = -1
  for (let i = open; i < bundle.length; i++) {
    if (bundle[i] === '{') depth++
    else if (bundle[i] === '}') {
      depth--
      if (depth === 0) {
        end = i + 1
        break
      }
    }
  }
  return new Function(`${bundle.slice(m.index, end)}; return buildScrapeScript;`)()()
}

/** ---- DOM 桩（与 verify-lang / verify-scrape 同语义）---- */
const text = (v) => ({ nodeType: 3, nodeValue: v })
function collectAll(n, out = []) {
  for (const c of n.childNodes ?? []) {
    if (c.nodeType === 1) out.push(c)
    collectAll(c, out)
  }
  return out
}
const matches = (n, sel) => {
  if (n.nodeType !== 1) return false
  if (sel.includes(',')) return sel.split(',').some((p) => matches(n, p.trim()))
  const s = sel.trim()
  if (s.startsWith('.')) return String(n.className).split(/\s+/).includes(s.slice(1))
  const st = /^\[class\*=["']([^"']+)["']\]$/.exec(s)
  if (st) return String(n.className).includes(st[1])
  const a = /^\[([\w-]+)(?:=["']?([^\]"']*)["']?)?\]$/.exec(s)
  if (a) {
    const v = n.getAttribute(a[1])
    return a[2] === undefined ? v !== null : v === a[2]
  }
  return n.tagName === s.toUpperCase()
}
function el(tag, opts = {}, ...children) {
  const node = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    className: opts.cls ?? '',
    attrs: opts.attrs ?? {},
    offsetWidth: 100,
    offsetHeight: 20,
    childNodes: children.flat().filter((c) => c != null && c !== ''),
    get children() {
      return this.childNodes.filter((c) => c.nodeType === 1)
    },
    get previousElementSibling() {
      const p = this.parentElement
      if (!p) return null
      const s = p.childNodes.filter((c) => c.nodeType === 1)
      const i = s.indexOf(this)
      return i > 0 ? s[i - 1] : null
    },
    get nextElementSibling() {
      const p = this.parentElement
      if (!p) return null
      const s = p.childNodes.filter((c) => c.nodeType === 1)
      const i = s.indexOf(this)
      return i >= 0 && i < s.length - 1 ? s[i + 1] : null
    },
    getAttribute(k) {
      return k in this.attrs ? this.attrs[k] : null
    },
    querySelectorAll(sel) {
      return collectAll(this).filter((n) => n !== this && matches(n, sel))
    },
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] ?? null
    },
    contains(o) {
      let n = o
      while (n) {
        if (n === this) return true
        n = n.parentElement ?? null
      }
      return false
    },
  }
  Object.defineProperty(node, 'textContent', {
    get() {
      let o = ''
      const w = (x) => {
        if (x.nodeType === 3) {
          o += x.nodeValue
          return
        }
        for (const c of x.childNodes ?? []) w(c)
      }
      w(this)
      return o
    },
  })
  return node
}
const link = (n, p) => {
  if (n == null || n.nodeType !== 1) return
  Object.defineProperty(n, 'parentElement', { value: p, configurable: true })
  for (const c of n.childNodes ?? []) link(c, n)
}
function setup(body) {
  link(body, null)
  globalThis.document = {
    body,
    querySelectorAll(sel) {
      const out = []
      const w = (x) => {
        if (matches(x, sel)) out.push(x)
        for (const c of x.childNodes ?? []) if (c.nodeType === 1) w(c)
      }
      w(body)
      return [...new Set(out)]
    },
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] ?? null
    },
  }
  globalThis.getComputedStyle = () => ({ visibility: 'visible', display: 'block' })
  globalThis.location = { href: 'https://chat.deepseek.com/a/chat/s/x' }
}
const scrapeScript = loadScrapeScript()
function scrape(body) {
  setup(body)
  return String(JSON.parse(String(eval(scrapeScript))).last)
}

const NL = String.fromCharCode(10)
const FENCE = String.fromCharCode(96, 96, 96)

/** DeepSeek 风格代码块：语言标签在 pre 外面（真实结构）。 */
function dsCodeBlock(lang, code) {
  return el(
    'div',
    { cls: '_codeblock' },
    el('div', { cls: '_codeheader' }, text(lang)),
    el('pre', {}, el('code', {}, text(code))),
  )
}
const dsReply = (...children) => el('div', { cls: 'ds-markdown' }, ...children)

/** ---- 状态隔离 + 登录快照 ---- */
const cleanupState = await prepareState(isolate, 'webin-tool-e2e')

const mod = await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href)
const A = makeCtx()
await mod.apply(A.ctx)
const route = [...A.routes.values()].find((r) => r.path === '/dsh-webin/api')
const adapter = A.adapters.get('webin-deepseek')
check('测试台就绪（route + adapter）', route !== undefined && adapter !== undefined, true)

console.log('\n[1] ⭐⭐⭐ 真实 DOM 抓取 → finish 必须是 tool-calls（否则必然一问一答）')
{
  const code = 'const r = await pwsh({"command": "Get-Location"});'
  const scraped = scrape(el('body', {}, dsReply(el('p', {}, text('我先看下目录。')), dsCodeBlock('ldw', code))))
  console.log('  抓取原文: ' + JSON.stringify(scraped))
  check('⭐⭐ 抓取含 ```ldw 围栏', scraped.includes(FENCE + 'ldw'), true)

  const { chunks, job } = await runRound(adapter, route, scraped, { tools: TOOLS })
  check('派发了任务', job !== null && job !== undefined, true)
  console.log('  chunk 序列: ' + chunks.map((c) => c.type).join(' → '))
  console.log('  finish.reason: ' + JSON.stringify(chunks.find((c) => c.type === 'finish')?.reason))
  console.log('  tool-call: ' + JSON.stringify(toolCalls(chunks).map((c) => ({ name: c.name, args: c.arguments }))))
  check('⭐⭐⭐ finish 是 tool-calls（不是 stop）', finishKind(chunks), 'tool-calls')
  check('⭐⭐ 吐出 1 个 tool-call', toolCalls(chunks).length, 1)
  check('⭐⭐ 工具名 = pwsh', toolCalls(chunks)[0]?.name, 'pwsh')
  check('⭐⭐ 参数含 Get-Location', String(toolCalls(chunks)[0]?.arguments ?? '').includes('Get-Location'), true)
}

console.log('\n[2] ⭐⭐⭐ 文字 + 工具调用混排（真实回复最常见形态）')
{
  const code = 'const r = await write({"path":"小故事.txt","content":"..."});'
  const scraped = scrape(
    el(
      'body',
      {},
      dsReply(
        el('p', {}, text('我先确认工作目录，然后直接写文件。')),
        dsCodeBlock('ldw', code),
        el('p', {}, text('写好了：小故事.txt')),
      ),
    ),
  )
  console.log('  抓取原文: ' + JSON.stringify(scraped).slice(0, 170))
  const { chunks } = await runRound(adapter, route, scraped, { tools: TOOLS })
  console.log('  finish.reason: ' + JSON.stringify(chunks.find((c) => c.type === 'finish')?.reason))
  check('⭐⭐⭐ finish 是 tool-calls', finishKind(chunks), 'tool-calls')
  check('⭐⭐ 工具名 = write', toolCalls(chunks)[0]?.name, 'write')
  check('⭐⭐ 正文文字也交回（不只工具调用）', textOut(chunks).includes('写好了'), true)
}

console.log('\n[3] ⭐⭐ 多个工具调用（模型一次调两个）')
{
  const code = [
    'const a = await pwsh({"command": "Get-Date"});',
    'const b = await write({"path":"a.txt","content":"x"});',
  ].join(NL)
  const scraped = scrape(el('body', {}, dsReply(dsCodeBlock('ldw', code))))
  const { chunks } = await runRound(adapter, route, scraped, { tools: TOOLS })
  console.log('  调用: ' + JSON.stringify(toolCalls(chunks).map((c) => c.name)))
  check('⭐⭐ finish 是 tool-calls', finishKind(chunks), 'tool-calls')
  check('⭐⭐ 吐出 2 个 tool-call', toolCalls(chunks).length, 2)
  check('⭐ 名字正确', toolCalls(chunks).map((c) => c.name).join(','), 'pwsh,write')
}

console.log('\n[4] ⭐⭐ 纯聊天（无工具块）→ finish 必须是 stop（不能卡住）')
{
  const scraped = scrape(el('body', {}, dsReply(el('p', {}, text('今天天气不错。')))))
  const { chunks } = await runRound(adapter, route, scraped, { tools: TOOLS })
  console.log('  finish.reason: ' + JSON.stringify(chunks.find((c) => c.type === 'finish')?.reason))
  check('⭐⭐ finish 是 stop', finishKind(chunks), 'stop')
  check('⭐ 没有 tool-call', toolCalls(chunks).length, 0)
}

console.log('\n[5] ⭐⭐ 普通 js 代码块不能触发工具调用（防误判）')
{
  const scraped = scrape(el('body', {}, dsReply(dsCodeBlock('js', 'const a = 1;'))))
  const { chunks } = await runRound(adapter, route, scraped, { tools: TOOLS })
  check('⭐⭐ finish 是 stop', finishKind(chunks), 'stop')
  check('⭐⭐ 没有 tool-call', toolCalls(chunks).length, 0)
}

console.log('\n[6] ⭐⭐⭐ 工具结果回灌后第二轮继续（循环真的转起来）')
{
  /**
   * 第二轮：历史里带 `role: 'tool'` 的结果 ⇒ 模型基于结果继续。
   * 断言「回灌内容进了 prompt」+ 第二轮仍能吐 tool-calls。
   */
  const sessionId = nextSession('tool-e2e-loop')
  const stream = adapter.stream({
    provider: 'webin-deepseek',
    model: 'ldw-fast',
    messages: [
      { role: 'user', content: '写个小故事到 txt' },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', id: 'c1', name: 'write', arguments: '{"path":"a.txt"}' }],
      },
      {
        role: 'tool',
        toolCallId: 'c1',
        content: [{ type: 'text', text: '写入成功：a.txt' }],
        isError: false,
      },
    ],
    tools: TOOLS,
    sessionId,
  })
  const iter = stream[Symbol.asyncIterator]()
  const first = iter.next()
  await new Promise((r) => setTimeout(r, 150))
  const claimed = await makeCall(
    route.handler,
    'GET',
    `/dsh-webin/api/job/next?platform=deepseek&session=${encodeURIComponent(sessionId)}`,
  )
  const job = claimed.json?.job
  check('第二轮派发了任务', job !== null && job !== undefined, true)
  check('⭐⭐ prompt 含工具结果（回灌进了下一轮）', String(job?.prompt ?? '').includes('写入成功'), true)
  await makeCall(
    route.handler,
    'PUT',
    `/dsh-webin/api/job/${job.id}/result`,
    JSON.stringify({
      text: '好的，我再确认一下时间。' + NL + FENCE + 'ldw' + NL + 'await pwsh({"command":"Get-Date"});' + NL + FENCE,
      think: '',
      status: 'finished',
    }),
  )
  const chunks = []
  let r = await first
  while (r.done !== true) {
    chunks.push(r.value)
    r = await iter.next()
  }
  check('⭐⭐ 第二轮 finish 是 tool-calls（循环继续）', finishKind(chunks), 'tool-calls')
}

cleanupState()
console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
process.exit(fail === 0 ? 0 : 1)
