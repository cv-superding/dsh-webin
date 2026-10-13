#!/usr/bin/env node
/**
 * dsh-webin host 半离线验证。
 *
 * 不依赖运行中的 DSH：在独立 Node 进程里 import 构建产物 `lib/index.js`，
 * 用 mock ctx 调 `apply()`，然后断言关键行为。
 *
 * 覆盖的回归点：
 *   1. contextWindow 必须是 1 Mi（128k 会引发压缩死锁）
 *   2. 路由 / adapter 必须注册**可释放的** disposer（否则重载撞 duplicate route）
 *   3. 同一进程内二次 apply 必须成功（验证无泄漏）
 *   4. 无人领活时 adapter 必须快速失败，而不是干等满超时
 *   5. 心跳路由必须存在，且 /status 反映在线客户端
 */
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { EventEmitter } from 'node:events'
import { isolate } from './lib/isolate.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const require = createRequire(import.meta.url)

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) {
    pass += 1
    console.log(`  OK   ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

// ---------------------------------------------------------------------------
// mock ctx：够用的 Cordis 子集
// ---------------------------------------------------------------------------

function makeCtx(loggerOverride) {
  const routes = new Map()
  const adapters = new Map()
  const disposers = []
  const logs = []

  const ctx = {
    effect(cb, label) {
      const dispose = cb()
      if (typeof dispose === 'function') disposers.push({ label, dispose })
      return dispose
    },
    webServer: {
      register(route) {
        const key = `${route.kind}:${route.path}`
        if (routes.has(key)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
        routes.set(key, route)
        return () => routes.delete(key)
      },
    },
    llm: {
      registerAdapter(providers, adapter) {
        for (const p of providers) {
          if (adapters.has(p)) throw new Error(`llm: provider "${p}" already registered`)
          adapters.set(p, adapter)
        }
        return () => {
          for (const p of providers) adapters.delete(p)
        }
      },
    },
    logger:
      loggerOverride !== undefined
        ? loggerOverride
        : Object.assign(
            (ns) => ({
              info: (m) => logs.push(['info', ns, m]),
              warn: (m) => logs.push(['warn', ns, m]),
              debug: () => {},
            }),
            {
              // Cordis 的 LoggerService 在 prototype 上挂了直通方法（cordis:646）
              info: (m) => logs.push(['info', 'root', m]),
              warn: (m) => logs.push(['warn', 'root', m]),
            },
          ),
  }
  return { ctx, routes, adapters, disposers, logs }
}

/** 造一个假 req/res，直接调用已注册的 prefix handler。 */
function makeHttp(method, url, body) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.destroy = () => {}
  const res = {
    statusCode: 0,
    headers: {},
    chunks: [],
    writeHead(code, headers) {
      this.statusCode = code
      Object.assign(this.headers, headers ?? {})
    },
    end(text) {
      this.chunks.push(text ?? '')
      this.ended = true
      this.resolve?.(this)
    },
  }
  const done = new Promise((resolve) => {
    res.resolve = resolve
  })
  // body 在下一个 tick 投递，模拟真实流
  process.nextTick(() => {
    if (body !== undefined) req.emit('data', Buffer.from(body, 'utf8'))
    req.emit('end')
  })
  return { req, res, done }
}

async function call(handler, method, url, body) {
  const { req, res, done } = makeHttp(method, url, body)
  await handler(req, res)
  await Promise.race([done, new Promise((r) => setTimeout(r, 2000))])
  return { status: res.statusCode, text: res.chunks.join(''), json: safeJson(res.chunks.join('')) }
}

function safeJson(s) {
  try {
    return JSON.parse(s)
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// 开始验证
// ---------------------------------------------------------------------------

console.log('=== dsh-webin host 半验证 ===\n')

/**
 * ⚠️ 隔离状态目录：插件会往 `~/.dsh/webin/`（含**会话游标**）读写。
 * 不隔离的话测试会污染真实状态，而且**测试之间互相污染** ——
 * 落盘的游标让第二次运行判定「无增量」⇒ 不派发任务 ⇒ 本测试全挂。
 * 详见 `scripts/lib/isolate.mjs`。
 */
const cleanupState = isolate('webin-host')

/**
 * ⚠️ **必须写登录快照** —— 插件有登录门禁（用户要求「已登录才能用 LDW 模型」）：
 * 未登录时 `listModels` 返回空、`stream` 以 `WEBIN_NOT_LOGGED_IN` 报错，
 * 于是「有模型」「能领到任务」这些断言全挂。
 * 这里模拟「已经登录过」，让测试专注于 host 装配与生命周期语义。
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
const { apply, name } = mod

console.log('[1] 模块导出')
check('导出 apply()', typeof apply === 'function')
check('name === dsh-webin', name === 'dsh-webin', String(name))

// ---- 第一次装配 ----
const A = makeCtx()
await apply(A.ctx)

console.log('\n[2] 路由与 adapter 注册')
const apiRoute = [...A.routes.values()].find((r) => r.path === '/dsh-webin/api')
check('注册了 /dsh-webin/api 前缀路由', apiRoute !== undefined)
check('注册了 webin-deepseek provider', A.adapters.has('webin-deepseek'))
check(
  'effect 交回了 disposer（可释放）',
  A.disposers.length >= 2,
  `disposers=${A.disposers.length}`,
)

const adapter = A.adapters.get('webin-deepseek')

console.log('\n[2b] 多平台：每个平台一个路由，模型 id 不撞名')
{
  /**
   * 可扩展性的核心断言：**加一个 provider 就多一个路由**，
   * 且各平台的模型 id 全局唯一（否则模型选择器里会互相覆盖）。
   */
  check('deepseek 路由存在', A.adapters.has('webin-deepseek'))
  check('qwen 路由存在（内置第二平台）', A.adapters.has('webin-qwen'))
  check('两个路由是不同的 adapter 注册', A.adapters.size >= 2, `size=${A.adapters.size}`)

  const dsModels = await adapter.listModels('webin-deepseek')
  const qwModels = await adapter.listModels('webin-qwen')
  check('deepseek 有模型', Array.isArray(dsModels) && dsModels.length > 0, `n=${dsModels?.length}`)
  check('qwen 有模型', Array.isArray(qwModels) && qwModels.length > 0, `n=${qwModels?.length}`)
  check(
    '模型 id 带平台前缀（不撞名）',
    dsModels.every((m) => String(m.id).startsWith('deepseek:')) &&
      qwModels.every((m) => String(m.id).startsWith('qwen:')),
    JSON.stringify([dsModels.map((m) => m.id), qwModels.map((m) => m.id)]),
  )

  // 各平台的 contextWindow 独立（qwen 是 128k，不该被 deepseek 的 1M 覆盖）
  const qwInfo = await adapter.resolveModel('webin-qwen', 'qwen:qwen-fast')
  check(
    'qwen 用自己的 contextWindow（131072）',
    qwInfo?.context?.contextWindow === 131_072,
    String(qwInfo?.context?.contextWindow),
  )

  // 向后兼容：旧会话存的无限定 id 仍能解析
  const legacy = await adapter.resolveModel('webin-deepseek', 'ldw-think')
  check(
    '兼容旧 id（无限定前缀）',
    legacy?.context?.contextWindow === 1_048_576,
    String(legacy?.context?.contextWindow),
  )
}

console.log('\n[3] contextWindow 必须是 1 Mi（防压缩死锁）')
const info = await adapter.resolveModel('webin-deepseek', 'ldw-think')
const cw = info?.context?.contextWindow
check('resolveModel 返回 context.contextWindow', typeof cw === 'number', String(cw))
check('contextWindow === 1048576', cw === 1_048_576, `实际 ${String(cw)}`)
check('defaultMaxTokens > 0', typeof info?.defaultMaxTokens === 'number' && info.defaultMaxTokens > 0, String(info?.defaultMaxTokens))

// 复算压缩阈值：min(cw*0.8, cw - maxTokens - 65536)
const headroom = 65536
const maxTok = info.defaultMaxTokens
const threshold = Math.floor(Math.min(cw * 0.8, cw - maxTok - headroom))
const observed = 359_267 // 卡死会话实测 surfaceTokens
check(
  `压缩阈值 ${threshold} 高于该会话实测 ${observed}（不再每步触发压缩）`,
  observed < threshold,
  `threshold=${threshold}`,
)
// 对照：旧的 128k 会怎样
const oldThreshold = Math.floor(Math.min(128_000 * 0.8, 128_000 - 8_192 - headroom))
check(
  `对照组：旧 128k 阈值 ${oldThreshold} < ${observed}，确认旧值必然死锁）`,
  observed > oldThreshold,
)

console.log('\n[4] 无人领活 → 快速失败（不干等满超时）')
{
  const t0 = Date.now()
  const stream = adapter.stream({
    provider: 'webin-deepseek',
    model: 'ldw-think',
    messages: [{ role: 'user', content: 'ping' }],
  })
  let finish
  for await (const chunk of stream) {
    if (chunk?.type === 'finish') finish = chunk
  }
  const elapsed = Date.now() - t0
  const failure = finish?.reason?.failure
  check('流以 error 结束', finish?.reason?.kind === 'error', JSON.stringify(finish?.reason))
  check('错误码 WEBIN_FAILED', failure?.code === 'WEBIN_FAILED', String(failure?.code))
  check(
    `在宽限期内失败（${elapsed}ms，远小于 10 分钟）`,
    elapsed < 40_000,
    `${elapsed}ms`,
  )
  check('错误信息说明了面板未连接', /未连接|无人领取/.test(String(failure?.message)), String(failure?.message))
}

console.log('\n[5] 压缩摘要必须快速拒绝（不排队、不干等）')
{
  /**
   * `compaction-basic` 的 `summarizeWithLlm()` 用「最近一次路由的模型」做摘要，
   * 所以会话切到 LDW 后，压缩会试图把几十万 token 的历史打进网页输入框。
   * adapter 必须**立即拒绝**（purpose === 'compaction'），而不是丢进队列等浏览器。
   */
  const t0 = Date.now()
  const stream = adapter.stream({
    provider: 'webin-deepseek',
    model: 'ldw-think',
    messages: [{ role: 'user', content: 'summarize this' }],
    purpose: 'compaction',
  })
  let finish
  for await (const chunk of stream) {
    if (chunk?.type === 'finish') finish = chunk
  }
  const elapsed = Date.now() - t0
  check('压缩调用以 error 结束', finish?.reason?.kind === 'error', JSON.stringify(finish?.reason))
  check(
    '错误码 WEBIN_COMPACTION_UNSUPPORTED',
    finish?.reason?.failure?.code === 'WEBIN_COMPACTION_UNSUPPORTED',
    String(finish?.reason?.failure?.code),
  )
  check(`立即返回（${elapsed}ms，未进入队列）`, elapsed < 1000, `${elapsed}ms`)
  check(
    '错误信息给出可操作指引（配 summarizationProvider）',
    /summarizationProvider/.test(String(finish?.reason?.failure?.message)),
    String(finish?.reason?.failure?.message).slice(0, 120),
  )
}

console.log('\n[6] 心跳路由 + /status 反映在线数')
{
  const beat = await call(
    apiRoute.handler,
    'POST',
    '/dsh-webin/api/client/heartbeat',
    JSON.stringify({ clientId: 'verify-1', loggedIn: true, hasGuest: true, replyCount: 3 }),
  )
  check('POST /client/heartbeat → 200', beat.status === 200, `status=${beat.status} body=${beat.text}`)

  const status = await call(apiRoute.handler, 'GET', '/dsh-webin/api/status')
  const body = status.json
  check('GET /status → 200', status.status === 200)
  check('status 带 clients 段', body?.clients !== undefined, JSON.stringify(body?.clients))
  check('clients.online === 1', body?.clients?.online === 1, String(body?.clients?.online))
  check('clients.loggedIn === 1', body?.clients?.loggedIn === 1, String(body?.clients?.loggedIn))
  check(
    'status.routes 列出了 heartbeat',
    Array.isArray(body?.routes) && body.routes.some((r) => r.includes('heartbeat')),
  )
}

console.log('\n[7] 任务队列：领活 / 交结果')
{
  // 先让一个 client 领活，避免快速失败。
  // ⚠️ 显式带 sessionId —— 差分发送靠它做键。
  const stream = adapter.stream({
    provider: 'webin-deepseek',
    model: 'ldw-fast',
    sessionId: 'verify-host-session-1',
    messages: [{ role: 'user', content: 'hello' }],
  })
  const iter = stream[Symbol.asyncIterator]()
  const first = iter.next() // 启动 stream，任务入队
  await new Promise((r) => setTimeout(r, 100))

  // 按平台领取：面板只领自己平台的活
  const claimed = await call(apiRoute.handler, 'GET', '/dsh-webin/api/job/next?platform=deepseek&session=verify-host-session-1')
  check('client 能领到任务', claimed.json?.job !== undefined && claimed.json.job !== null, claimed.text)
  check('任务带 prompt', claimed.json?.job?.prompt?.includes('hello'), String(claimed.json?.job?.prompt))
  check('任务带 platform', claimed.json?.job?.platform === 'deepseek', String(claimed.json?.job?.platform))

  // 别的平台不该领到这个任务（多平台隔离）
  const other = await call(apiRoute.handler, 'GET', '/dsh-webin/api/job/next?platform=qwen&session=verify-host-session-1')
  check('别的平台领不到（平台隔离）', other.json?.job === null, other.text)

  const jobId = claimed.json.job.id
  const settled = await call(
    apiRoute.handler,
    'PUT',
    `/dsh-webin/api/job/${jobId}/result`,
    JSON.stringify({ text: 'world', think: '', status: 'finished' }),
  )
  check('交结果 → 200', settled.status === 200, `status=${settled.status}`)

  await first
  let text = ''
  let finished = false
  for await (const chunk of { [Symbol.asyncIterator]: () => iter }) {
    if (chunk?.type === 'text-delta') text += chunk.text ?? ''
    if (chunk?.type === 'finish') {
      finished = true
      check('流正常结束（stop）', chunk.reason?.kind === 'stop', JSON.stringify(chunk.reason))
    }
  }
  check('文本被送回 agent loop', text === 'world', JSON.stringify(text))
  check('收到了 finish', finished)
}

console.log('\n[8] 卸载后重装：不得撞 duplicate route')
{
  for (const d of A.disposers) d.dispose()
  check('disposer 清空了路由', A.routes.size === 0, `routes=${A.routes.size}`)
  check('disposer 清空了 adapter', A.adapters.size === 0, `adapters=${A.adapters.size}`)

  const B = makeCtx()
  let threw
  try {
    await apply(B.ctx)
  } catch (e) {
    threw = e
  }
  check('二次 apply 成功（无幽灵路由）', threw === undefined, String(threw?.message))
  check('二次 apply 后路由在', [...B.routes.values()].some((r) => r.path === '/dsh-webin/api'))
}

console.log('\n[9] logger 畸形形态不得让插件加载失败')
{
  /**
   * `ctx.logger` 是 Cordis 的 callable service，但**不能假设它一定可调用**。
   * 一次 TypeError 就会让整个 `apply()` 抛出、插件装不上 —— 那比丢日志严重得多。
   * 这里把所有可能形态都过一遍。
   */
  const shapes = [
    ['正常 callable', () => ({ info: () => {}, warn: () => {}, debug: () => {} })],
    ['undefined', undefined],
    ['null', null],
    ['不是函数（字符串）', 'nope'],
    ['不是函数（对象）', { some: 'object' }],
    ['callable 返回 undefined', () => undefined],
    ['callable 返回 null', () => null],
    ['callable 返回字符串', () => 'nope'],
    ['callable 抛异常', () => { throw new Error('logger exploded') }],
    ['callable 返回缺方法的对象', () => ({ other: 1 })],
  ]
  for (const [label, shape] of shapes) {
    const C = makeCtx(shape)
    let threw
    try {
      await apply(C.ctx)
    } catch (e) {
      threw = e
    }
    const registered = [...C.routes.values()].some((r) => r.path === '/dsh-webin/api')
    check(`logger=${label} → 仍能加载并注册路由`, threw === undefined && registered, String(threw?.message ?? ''))
  }
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
cleanupState()
process.exitCode = fail === 0 ? 0 : 1
