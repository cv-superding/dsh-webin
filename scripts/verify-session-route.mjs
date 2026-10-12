#!/usr/bin/env node
/**
 * 会话路由测试 —— **「所有 DSH 会话挤一个网页对话」的回归保护**。
 *
 * ## 用户实测发现的封号级缺陷
 *
 * 换了几个 DSH 窗口聊天，网页版里全落在**同一个**会话窗口：
 * 上下文互相串、多个话题混在一条流里，行为模式像机器人。
 *
 * ## 修复后的语义
 *
 * 每个 DSH 会话（sessionId）绑定**自己的**网页对话：
 *   1. 首次任务 → 在当前页发，落地 URL 由结果带回 host，存进游标
 *   2. 同一会话的后续任务 → job 带 expectUrl（= 上次落地页），
 *      client 发现 URL 相同就不导航（零开销）
 *   3. 切换 DSH 会话 → job 带**各自**的 expectUrl，client 先导航再发
 *
 * ## 验证什么
 *
 * 用 mock HTTP 桩打真实的 host 半：
 *   A. 两个 DSH 会话先后发消息 → 第二个任务带 expectUrl（第一个会话的落地页）
 *   B. 两个会话各自交回 chatUrl → 各自的游标记住各的
 *   C. 切回第一个会话再发 → expectUrl 是第一个会话的 URL（不是第二个的）
 *   D. client 静态检查：确实有「先导航再发」的逻辑
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

let pass = 0
let fail = 0
const check = function (name, actual, expected) {
  if (arguments.length < 3) expected = true
  const ok = actual === expected
  if (ok) {
    pass += 1
    console.log(`  OK   ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL ${name} — 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
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
      if (event === 'end') setTimeout(() => { cb(); resolveDone() }, 1)
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
  const disposers = []
  const logs = []
  const ctx = {
    logger: (ns) => ({
      info: (m) => logs.push(['info', ns, m]),
      warn: (m) => logs.push(['warn', ns, m]),
      debug: () => {},
    }),
    effect(cb) {
      const d = cb()
      if (typeof d === 'function') disposers.push(d)
      else if (d !== undefined && typeof d.then === 'function') disposers.push(() => {})
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
  return { ctx, routes, adapters, disposers, logs }
}

console.log('=== 会话路由测试 ===\n')

const mod = await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href)
const { apply } = mod

/**
 * 跑一个完整的「stream → 领活 → 交结果」循环，返回该任务的字段。
 *
 * ⚠️ **messages 必须随轮次递增**：真实 DSH 每轮把「完整历史」交给 adapter，
 * 差分发送靠它算增量。若每轮只传一条且相同，游标会判定「增量为空，跳过发送」
 * —— 任务根本不入队（这正是差分发送的正确行为，不是 bug）。
 * 所以这里用 `history` 数组累积每轮的消息，模拟真实调用形态。
 *
 * @param chatUrl - 模拟 client 交回的落地页 URL
 */
async function runOne(adapter, route, sessionId, history, chatUrl, seen) {
  const stream = adapter.stream({
    provider: 'webin-deepseek',
    model: 'ldw-fast',
    sessionId,
    messages: history.map((t) => ({ role: 'user', content: t })),
  })
  const iter = stream[Symbol.asyncIterator]()
  const last = iter.next()
  await new Promise((r) => setTimeout(r, 150))

  const claimed = await call(route.handler, 'GET', '/dsh-webin/api/job/next?platform=deepseek')
  const job = claimed.json?.job ?? null
  if (job === null) {
    await last.catch(() => undefined)
    return null
  }
  seen.push(job)
  await call(
    route.handler,
    'PUT',
    `/dsh-webin/api/job/${job.id}/result`,
    JSON.stringify({ text: 'ok', think: '', status: 'finished', chatUrl }),
  )
  await last.catch(() => undefined)
  return job
}

console.log('[A] 两个 DSH 会话 → 各自的网页对话互不串')
{
  const A = makeCtx()
  await apply(A.ctx)
  const route = [...A.routes.values()].find((r) => r.path === '/dsh-webin/api')
  const adapter = A.adapters.get('webin-deepseek')
  const seen = []
  const h1 = ['会话一的消息']
  const h2 = ['会话二的消息']

  // 会话 1 首条：落地在 /a/chat/s/AAA
  const j1 = await runOne(adapter, route, 'sess-1', h1, 'https://chat.deepseek.com/a/chat/s/AAA', seen)
  check('会话1 首条无 expectUrl（还没绑定）', j1?.expectUrl, undefined)

  // 会话 2 首条：落地在 /a/chat/s/BBB —— 不该被会话 1 的绑定污染
  const j2 = await runOne(adapter, route, 'sess-2', h2, 'https://chat.deepseek.com/a/chat/s/BBB', seen)
  check('会话2 首条也无 expectUrl（各自独立）', j2?.expectUrl, undefined)

  // 会话 1 第二条：必须带上它自己的 URL（AAA），不是 BBB
  h1.push('会话一继续')
  const j1b = await runOne(adapter, route, 'sess-1', h1, 'https://chat.deepseek.com/a/chat/s/AAA', seen)
  check('⭐ 会话1 第二条 expectUrl=AAA', j1b?.expectUrl, 'https://chat.deepseek.com/a/chat/s/AAA')

  // 会话 2 第二条：必须是 BBB
  h2.push('会话二继续')
  const j2b = await runOne(adapter, route, 'sess-2', h2, 'https://chat.deepseek.com/a/chat/s/BBB', seen)
  check('⭐ 会话2 第二条 expectUrl=BBB', j2b?.expectUrl, 'https://chat.deepseek.com/a/chat/s/BBB')

  // 切回会话 1：还是 AAA
  h1.push('再切回会话一')
  const j1c = await runOne(adapter, route, 'sess-1', h1, 'https://chat.deepseek.com/a/chat/s/AAA', seen)
  check('⭐ 切回会话1 仍是 AAA', j1c?.expectUrl, 'https://chat.deepseek.com/a/chat/s/AAA')
}

console.log('\n[B] 交回的 chatUrl 存进游标（同会话后续任务都带着它）')
{
  const B = makeCtx()
  await apply(B.ctx)
  const route = [...B.routes.values()].find((r) => r.path === '/dsh-webin/api')
  const adapter = B.adapters.get('webin-deepseek')
  const seen = []
  const h = ['第一条']

  await runOne(adapter, route, 'only', h, 'https://chat.deepseek.com/a/chat/s/XYZ', seen)
  h.push('第二条')
  const again = await runOne(adapter, route, 'only', h, 'https://chat.deepseek.com/a/chat/s/XYZ', seen)
  check('同会话后续任务带 expectUrl', again?.expectUrl, 'https://chat.deepseek.com/a/chat/s/XYZ')
}

console.log('\n[C] 不交 chatUrl（老 client / 抓 URL 失败）→ 不绑定，行为不退化')
{
  const C = makeCtx()
  await apply(C.ctx)
  const route = [...C.routes.values()].find((r) => r.path === '/dsh-webin/api')
  const adapter = C.adapters.get('webin-deepseek')
  const seen = []
  const h = ['第一条']

  const j1 = await runOne(adapter, route, 'no-url', h, undefined, seen)
  check('无 chatUrl 时任务不带 expectUrl', j1?.expectUrl, undefined)
  h.push('第二条')
  const j2 = await runOne(adapter, route, 'no-url', h, undefined, seen)
  check('后续任务也不带（不报错）', j2?.expectUrl, undefined)
}

console.log('\n[D] 静态：client 有「先导航到 expectUrl 再发」的逻辑')
{
  const src = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  check('任务字段被读取', src.includes('expectUrl'))
  check('URL 不匹配时导航', /location\.href[\s\S]{0,600}loadURL/.test(src))
  check('导航后等输入框出现（25s 轮询）', /Date\.now\(\) \+ 25000/.test(src))
  check('交结果时带 chatUrl', src.includes('chatUrl'))
  // host 侧
  const host = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')
  check('host 派发时带 expectUrl', host.includes('expectUrl'))
  check('host 接收结果的 chatUrl', host.includes('chatUrl'))
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
process.exitCode = fail === 0 ? 0 : 1
