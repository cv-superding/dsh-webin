#!/usr/bin/env node
/**
 * **工具调用 chunk 契约测试** —— 验证 adapter 真的会吐出合法的 `tool-call` chunk。
 *
 * ## 为什么单独测这个
 *
 * `verify-tools.mjs` 测的是「解析器」本身（纯函数）。
 * 但**契约**是另一回事：adapter 必须按 DSH 要求的顺序与字段名发射 chunk：
 *
 * ```
 * { type:'block-start', index, blockType:'tool-call' }
 * { type:'tool-call-delta', index, id, name, argumentsDelta }
 * { type:'block-end', index, block:{ type:'tool-call', id, name, arguments } }
 * { type:'finish', reason:{ kind:'tool-calls' } }     ← 有调用时必须这个
 * ```
 *
 * 字段名写错（比如 `arguments` 写成 `args`）= 工具永远不执行，��且**不会报错**
 * —— 静默失败最难查。所以这里直接断言产物里的字段名与顺序。
 *
 * ## 做法
 *
 * 用 mock Cordis ctx 起真实 host 半，走完整链路：
 *   adapter.stream(带 tools) → client 领活 → 交回一段「带 cuckoo 代码块」的回复
 *   → 断言流里吐出的 chunk 序列
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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

function makeHttp(method, url, body) {
  const chunks = []
  let resolveDone
  const done = new Promise((r) => {
    resolveDone = r
  })
  const req = {
    method,
    url,
    on(event, cb) {
      if (event === 'data' && body !== undefined) setTimeout(() => cb(Buffer.from(body)), 0)
      if (event === 'end')
        setTimeout(() => {
          cb()
          resolveDone()
        }, 1)
      return this
    },
    destroy() {},
  }
  const res = {
    statusCode: 200,
    headers: {},
    chunks,
    writeHead(code, headers) {
      this.statusCode = code
      Object.assign(this.headers, headers ?? {})
      return this
    },
    end(text) {
      if (text !== undefined) chunks.push(String(text))
      resolveDone()
    },
  }
  return { req, res, done }
}

const safeJson = (s) => {
  try {
    return JSON.parse(s)
  } catch {
    return undefined
  }
}

async function call(handler, method, url, body) {
  const { req, res, done } = makeHttp(method, url, body)
  await handler(req, res)
  await Promise.race([done, new Promise((r) => setTimeout(r, 2000))])
  return { status: res.statusCode, text: res.chunks.join(''), json: safeJson(res.chunks.join('')) }
}

function makeCtx() {
  const routes = new Map()
  const adapters = new Map()
  const logs = []
  const ctx = {
    logger: (ns) => ({
      info: (m) => logs.push(['info', ns, m]),
      warn: (m) => logs.push(['warn', ns, m]),
      debug: (m) => logs.push(['debug', ns, m]),
    }),
    effect(cb) {
      const d = cb()
      return () => {}
    },
    llm: {
      registerAdapter(providers, adapter) {
        for (const p of providers) adapters.set(p, adapter)
        return () => {
          for (const p of providers) adapters.delete(p)
        }
      },
    },
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
  }
  return { ctx, routes, adapters, logs }
}

/** 实测形状的工具 schema。 */
const TOOLS = [
  {
    name: 'pwsh',
    description: '在 PowerShell 中执行命令。',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  },
  {
    name: 'read',
    description: '读取文件内容。',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
]

/** 跑一轮：返回收到的所有 chunk。 */
async function runRound(adapter, route, opts) {
  const stream = adapter.stream({
    provider: 'webin-deepseek',
    model: 'ldw-fast',
    sessionId: opts.sessionId ?? 'chunk-test',
    messages: opts.messages,
    ...(opts.system === undefined ? {} : { system: opts.system }),
    ...(opts.tools === undefined ? {} : { tools: opts.tools }),
  })
  const iter = stream[Symbol.asyncIterator]()
  // 先推进一步让任务入队
  const first = iter.next()
  await new Promise((r) => setTimeout(r, 150))

  const claimed = await call(route.handler, 'GET', '/dsh-webin/api/job/next?platform=deepseek')
  const job = claimed.json?.job
  if (job === null || job === undefined) {
    await first.catch(() => undefined)
    return { chunks: [], job: null }
  }

  // 交回一段「带 cuckoo 代码块」的回复（模拟模型输出）
  await call(
    route.handler,
    'PUT',
    `/dsh-webin/api/job/${job.id}/result`,
    JSON.stringify({ text: opts.reply, think: '', status: 'finished' }),
  )

  const chunks = []
  let r = await first
  while (r.done !== true) {
    chunks.push(r.value)
    r = await iter.next()
  }
  return { chunks, job }
}

console.log('=== 工具调用 chunk 契约测试 ===\n')

const mod = await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href)
const { apply } = mod

console.log('[1] 模型输出 cuckoo 代码块 → 必须吐出 tool-call chunk')
{
  const A = makeCtx()
  await apply(A.ctx)
  const route = [...A.routes.values()].find((r) => r.path === '/dsh-webin/api')
  const adapter = A.adapters.get('webin-deepseek')

  const reply = '我来查一下时间。\n\n```cuckoo\nawait pwsh({"command": "Get-Date"});\n```'
  const { chunks } = await runRound(adapter, route, {
    messages: [{ role: 'user', content: '现在几点了' }],
    tools: TOOLS,
    reply,
  })

  const types = chunks.map((c) => c.type)
  console.log(`       chunk 序列: ${types.join(' → ')}`)

  check('有 tool-call 的 block-start', types.includes('block-start'), true)
  check('有 tool-call-delta', types.includes('tool-call-delta'), true)
  check('有 tool-call 的 block-end', types.includes('block-end'), true)

  const start = chunks.find((c) => c.type === 'block-start' && c.blockType === 'tool-call')
  check('blockType 字段名正确（tool-call）', start?.blockType, 'tool-call')

  const delta = chunks.find((c) => c.type === 'tool-call-delta')
  check('delta 有 name', delta?.name, 'pwsh')
  check('⭐ delta 字段名是 argumentsDelta', typeof delta?.argumentsDelta, 'string')
  check('⭐ delta 有 id', typeof delta?.id === 'string' && delta.id.length > 0, true)

  const end = chunks.find((c) => c.type === 'block-end' && c.block?.type === 'tool-call')
  check('⭐ block 字段名是 arguments（不是 args）', typeof end?.block?.arguments, 'string')
  check('block.id 与 delta.id 一致', end?.block?.id, delta?.id)
  check('block.name 与 delta.name 一致', end?.block?.name, delta?.name)
  check('arguments 是合法 JSON', JSON.parse(end?.block?.arguments ?? '{}').command, 'Get-Date')
}

console.log('\n[2] ⭐ 有工具调用时 finish 必须是 tool-calls（否则 DSH 不会执行）')
{
  const A = makeCtx()
  await apply(A.ctx)
  const route = [...A.routes.values()].find((r) => r.path === '/dsh-webin/api')
  const adapter = A.adapters.get('webin-deepseek')

  const { chunks } = await runRound(adapter, route, {
    messages: [{ role: 'user', content: '读文件' }],
    tools: TOOLS,
    reply: '```cuckoo\nawait read({"path": "a.ts"});\n```',
  })
  const finish = chunks.find((c) => c.type === 'finish')
  check('finish.reason.kind === tool-calls', finish?.reason?.kind, 'tool-calls')
}

console.log('\n[3] 无工具调用时 finish 是 stop')
{
  const A = makeCtx()
  await apply(A.ctx)
  const route = [...A.routes.values()].find((r) => r.path === '/dsh-webin/api')
  const adapter = A.adapters.get('webin-deepseek')

  const { chunks } = await runRound(adapter, route, {
    messages: [{ role: 'user', content: '你好' }],
    tools: TOOLS,
    reply: '你好，有什么可以帮你？',
  })
  const finish = chunks.find((c) => c.type === 'finish')
  check('finish.reason.kind === stop', finish?.reason?.kind, 'stop')
  check('没有 tool-call-delta', chunks.some((c) => c.type === 'tool-call-delta'), false)
}

console.log('\n[4] ⭐ 工具代码块不进正文（否则网页记录里会看到协议残留）')
{
  const A = makeCtx()
  await apply(A.ctx)
  const route = [...A.routes.values()].find((r) => r.path === '/dsh-webin/api')
  const adapter = A.adapters.get('webin-deepseek')

  const { chunks } = await runRound(adapter, route, {
    messages: [{ role: 'user', content: '读文件' }],
    tools: TOOLS,
    reply: '让我读一下。\n\n```cuckoo\nawait read({"path": "a.ts"});\n```',
  })
  const textDelta = chunks.find((c) => c.type === 'text-delta')
  check('正文保留', textDelta?.text.includes('让我读一下。'), true)
  check('⭐ 正文不含 cuckoo 标记', textDelta?.text.includes('cuckoo'), false)
  check('⭐ 正文不含 await 调用', textDelta?.text.includes('await read'), false)
}

console.log('\n[5] 首轮带工具目录、后续轮不带（防体量膨胀）')
{
  const A = makeCtx()
  await apply(A.ctx)
  const route = [...A.routes.values()].find((r) => r.path === '/dsh-webin/api')
  const adapter = A.adapters.get('webin-deepseek')

  // 首轮
  const r1 = await runRound(adapter, route, {
    sessionId: 'catalog-test',
    messages: [{ role: 'user', content: '第一条' }],
    tools: TOOLS,
    reply: '好的。',
  })
  check('首轮派发了任务', r1.job !== null, true)
  check('⭐ 首轮 prompt 含工具目录', r1.job.prompt.includes('可用工具'), true)
  check('首轮 prompt 含协议', r1.job.prompt.includes('工具调用协议'), true)
  console.log(`       首轮 prompt: ${r1.job.prompt.length} 字符`)

  // 第二轮（历史增长）
  const r2 = await runRound(adapter, route, {
    sessionId: 'catalog-test',
    messages: [
      { role: 'user', content: '第一条' },
      { role: 'assistant', content: [{ type: 'text', text: '好的。' }] },
      { role: 'user', content: '第二条' },
    ],
    tools: TOOLS,
    reply: '收到。',
  })
  check('第二轮派发了任务', r2.job !== null, true)
  check('⭐ 第二轮 prompt 不含工具目录', r2.job.prompt.includes('可用工具'), false)
  check('⭐ 第二轮 prompt 不含协议', r2.job.prompt.includes('工具调用协议'), false)
  check('第二轮只含增量', r2.job.prompt.includes('第二条') && !r2.job.prompt.includes('第一条'), true)
  console.log(`       第二轮 prompt: ${r2.job.prompt.length} 字符（只有增量）`)
}

console.log('\n[6] 工具结果回灌：role:tool 消息进入下一轮增量')
{
  const A = makeCtx()
  await apply(A.ctx)
  const route = [...A.routes.values()].find((r) => r.path === '/dsh-webin/api')
  const adapter = A.adapters.get('webin-deepseek')

  // 首轮：用户提问 → 模型调工具
  await runRound(adapter, route, {
    sessionId: 'toolresult-test',
    messages: [{ role: 'user', content: '现在几点了' }],
    tools: TOOLS,
    reply: '```cuckoo\nawait pwsh({"command": "Get-Date"});\n```',
  })

  // 第二轮：DSH 把工具结果作为 role:tool 消息交回来
  const r2 = await runRound(adapter, route, {
    sessionId: 'toolresult-test',
    messages: [
      { role: 'user', content: '现在几点了' },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', id: 'call_1', name: 'pwsh', arguments: '{"command":"Get-Date"}' }],
      },
      {
        role: 'tool',
        toolCallId: 'call_1',
        content: [{ type: 'text', text: '2026年10月12日 18:30:00' }],
        isError: false,
      },
    ],
    tools: TOOLS,
    reply: '现在是 18:30。',
  })

  check('第二轮派发了任务', r2.job !== null, true)
  check('⭐ prompt 含工具结果', r2.job.prompt.includes('【工具结果】'), true)
  check('⭐ prompt 含结果正文', r2.job.prompt.includes('2026年10月12日 18:30:00'), true)
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
process.exitCode = fail === 0 ? 0 : 1
