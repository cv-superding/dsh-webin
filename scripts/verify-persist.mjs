#!/usr/bin/env node
/**
 * **重启后接回原对话** + **首轮开新对话** —— 两个封号级缺陷的回归测试。
 *
 * ## 缺陷一：重启后新开对话（用户实测）
 *
 * > 「重启完之后，我看网页版又新开了一个会话，没有接上之前的那个窗口」
 *
 * 根因：游标只在 host **内存**里，重启即丢：
 *   1. `chatUrl` 丢 ⇒ 任务不带 `expectUrl` ⇒ client 在首页发 ⇒ **新开对话**
 *   2. 差分游标丢 ⇒ 重启后第一轮**重发全部历史**
 *
 * 修复：游标落盘到 `~/.dsh/webin/sessions/<platform>.json`。
 *
 * ## 缺陷二：多个 DSH 会话挤同一个网页对话（用户实测）
 *
 * > 「换了几个dsh窗口聊天，发现全都是在网页版的同一个会话窗口」
 *
 * 根因（比缺陷一更隐蔽）：`expectUrl` 只覆盖「已绑定」的情况，
 * **首轮没有绑定** ⇒ client 退化成「在当前页发」⇒ 而当前页可能是别的会话的对话：
 *
 * ```
 * 会话A 首轮 → 在当前页 X 发 → 绑定 A→X
 * 会话B 首轮 → 无绑定 → 仍在 X 发 → 绑定 B→X   ← 两个会话挤进 X！
 * ```
 *
 * 修复：首轮带 `freshChat`，client **显式开新对话**。
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'

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

/** 带临时 DSH_HOME 的 ctx（游标落盘到临时目录，不污染真实状态）。 */
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
      cb()
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

/** 跑一轮：返回派发给 client 的 job（不交结果，只看 job 内容）。 */
async function claimJob(adapter, route, opts) {
  const stream = adapter.stream({
    provider: 'webin-deepseek',
    model: 'ldw-fast',
    sessionId: opts.sessionId,
    messages: opts.messages,
    ...(opts.system === undefined ? {} : { system: opts.system }),
  })
  const iter = stream[Symbol.asyncIterator]()
  const first = iter.next()
  await new Promise((r) => setTimeout(r, 120))
  const claimed = await call(route.handler, 'GET', '/dsh-webin/api/job/next?platform=deepseek')
  const job = claimed.json?.job ?? null
  // 收尾：交一个空结果让流结束，避免悬挂
  if (job !== null) {
    await call(
      route.handler,
      'PUT',
      `/dsh-webin/api/job/${job.id}/result`,
      JSON.stringify({ text: 'ok', think: '', status: 'finished', chatUrl: opts.landingUrl ?? '' }),
    )
  }
  await first.catch(() => undefined)
  try {
    await iter.next()
  } catch {
    /* ignore */
  }
  return job
}

console.log('=== 重启后接回原对话 + 首轮开新对话 测试 ===\n')

// 用临时 DSH_HOME，避免污染真实状态
const TMP = mkdtempSync(join(tmpdir(), 'dsh-webin-persist-'))
process.env.DSH_HOME = TMP
mkdirSync(join(TMP, 'webin'), { recursive: true })

/**
 * ⚠️ **必须写登录快照** —— 插件有登录门禁（用户要求「已登录才能用 LDW 模型」）：
 * 未登录时 `stream` 直接以 `WEBIN_NOT_LOGGED_IN` 报错，本测试一个任务都拿不到。
 * 这里模拟「已经登录过」，让测试专注于它要验的语义。
 */
mkdirSync(join(process.env.DSH_HOME, 'webin', 'auth'), { recursive: true })
for (const platform of ['deepseek', 'qwen']) {
  writeFileSync(
    join(process.env.DSH_HOME, 'webin', 'auth', `${platform}.json`),
    JSON.stringify({ localStorage: { userToken: '{"value":"test-token"}' }, url: 'https://example.com/' }),
    'utf8',
  )
}
const mod = await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href)
const { apply } = mod

console.log('[1] 首轮必须带 freshChat（否则会占用别人的对话）')
{
  const A = makeCtx()
  await apply(A.ctx)
  const route = [...A.routes.values()].find((r) => r.path === '/dsh-webin/api')
  const adapter = A.adapters.get('webin-deepseek')

  const job = await claimJob(adapter, route, {
    sessionId: 'fresh-1',
    messages: [{ role: 'user', content: '第一条消息' }],
  })
  check('派发了任务', job !== null, true)
  check('⭐ 首轮带 freshChat=true', job?.freshChat, true)
  check('首轮没有 expectUrl（无绑定）', job?.expectUrl, undefined)
}

console.log('\n[2] ⭐ 游标落盘：重启后能恢复会话↔对话绑定')
{
  const A = makeCtx()
  await apply(A.ctx)
  const route = [...A.routes.values()].find((r) => r.path === '/dsh-webin/api')
  const adapter = A.adapters.get('webin-deepseek')

  // 第一轮：交回一个落地 URL（模拟发送成功后页面所在对话）
  const CHAT = 'https://chat.deepseek.com/a/chat/s/8530a042-1111-2222-3333-444455556666'
  const job1 = await claimJob(adapter, route, {
    sessionId: 'persist-1',
    messages: [{ role: 'user', content: '你好' }],
    landingUrl: CHAT,
  })
  check('第一轮派发', job1 !== null, true)

  // 确认落盘文件存在
  const file = join(TMP, 'webin', 'sessions', 'deepseek.json')
  let saved
  try {
    saved = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    saved = null
  }
  check('⭐ 游标文件已写入', saved !== null, true)
  check('⭐ 文件里有该会话的绑定', saved?.sessions?.['persist-1']?.chatUrl, CHAT)
  check('文件里记了已发送条数', saved?.sessions?.['persist-1']?.sentCount, 1)

  // 第二轮（同一 host）：应带 expectUrl
  const job2 = await claimJob(adapter, route, {
    sessionId: 'persist-1',
    messages: [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      { role: 'user', content: '第二条' },
    ],
  })
  check('同一进程内第二轮带 expectUrl', job2?.expectUrl, CHAT)
  check('同一进程内第二轮不带 freshChat', job2?.freshChat, undefined)
}

console.log('\n[3] ⭐⭐ 模拟重启：新 host 实例必须从磁盘恢复绑定')
{
  // 关键：**重新 import 一份模块**模拟重启（模块级状态清空）
  const fresh = await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href + `?restart=${Date.now()}`)
  const A = makeCtx()
  await fresh.apply(A.ctx)
  const route = [...A.routes.values()].find((r) => r.path === '/dsh-webin/api')
  const adapter = A.adapters.get('webin-deepseek')

  const CHAT = 'https://chat.deepseek.com/a/chat/s/8530a042-1111-2222-3333-444455556666'
  /**
   * ⚠️ 必须**追加一条新消息**，不能重发 test[2] 用过的同一批 ——
   * 差分发送会把「历史完全重复」判定为无需发送（正确行为），
   * 那样流会直接 finish，拿不到 job，测试会误报失败。
   */
  const job = await claimJob(adapter, route, {
    sessionId: 'persist-1',
    messages: [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      { role: 'user', content: '第二条' },
      { role: 'assistant', content: [{ type: 'text', text: 'ok2' }] },
      { role: 'user', content: '第三条（重启后）' },
    ],
  })
  check('重启后派发了任务', job !== null, true)
  check('⭐⭐ 重启后仍带 expectUrl（接回原对话）', job?.expectUrl, CHAT)
  check('⭐⭐ 重启后不再 freshChat（不会新开对话）', job?.freshChat, undefined)
  check('⭐ 重启后差分继续（只发增量，不重发历史）', job?.prompt.includes('第三条（重启后）'), true)
  check('⭐ 重启后没有重发第一条', job?.prompt.includes('你好'), false)
  check('⭐ 重启后没有重发第二条', job?.prompt.includes('第二条'), false)
}

console.log('\n[4] 未绑定过的会话在重启后仍应 freshChat（不能借用别人的对话）')
{
  const fresh = await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href + `?restart2=${Date.now()}`)
  const A = makeCtx()
  await fresh.apply(A.ctx)
  const route = [...A.routes.values()].find((r) => r.path === '/dsh-webin/api')
  const adapter = A.adapters.get('webin-deepseek')

  const job = await claimJob(adapter, route, {
    sessionId: 'brand-new-session',
    messages: [{ role: 'user', content: '全新的会话' }],
  })
  check('⭐ 新会话带 freshChat', job?.freshChat, true)
  check('新会话不带 expectUrl', job?.expectUrl, undefined)
}

console.log('\n[5] 损坏的游标文件不能让插件挂掉')
{
  const file = join(TMP, 'webin', 'sessions', 'deepseek.json')
  writeFileSync(file, '{ 这不是合法 JSON', 'utf8')
  const fresh = await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href + `?restart3=${Date.now()}`)
  const A = makeCtx()
  let threw = null
  try {
    await fresh.apply(A.ctx)
  } catch (e) {
    threw = String(e)
  }
  check('⭐ 坏文件不导致加载失败', threw, null)
  const route = [...A.routes.values()].find((r) => r.path === '/dsh-webin/api')
  const adapter = A.adapters.get('webin-deepseek')
  const job = await claimJob(adapter, route, {
    sessionId: 'persist-1',
    messages: [{ role: 'user', content: '坏了之后还能用' }],
  })
  check('⭐ 坏文件后仍能派发任务', job !== null, true)
  check('坏文件后按新会话处理（freshChat）', job?.freshChat, true)
}

console.log('\n[6] client 侧：freshChat 分支存在且逻辑正确')
{
  const client = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  check('⭐ client 处理 freshChat', client.includes('freshChat'), true)
  check('⭐ 只在对话页里才导航（避免多余重载）', /\/\\\/a\\\/chat\\\/s\\\/\//.test(client), true)
  check('client 导航到 homeUrl', /homeUrl/.test(client), true)
  check('导航后等输入框（最多 25s）', client.includes('25000'), true)
  // ⚠️ bundle 会把 `undefined` 压成 `void 0`、把 `'x'` 压成 `"x"`
  check('⭐ 判据是「无绑定才开新对话」', /freshChat === true && .*expectUrl === void 0/.test(client), true)
}

rmSync(TMP, { recursive: true, force: true })
console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
process.exitCode = fail === 0 ? 0 : 1
