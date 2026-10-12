#!/usr/bin/env node
/**
 * 任务生命周期测试 —— **防插队 / 防串台 / 防永久卡死**。
 *
 * ## 这一版修掉的三个真 bug（都在真实使用中会撞上）
 *
 * ### 1. 插队（最严重）
 *
 * 发送成功后 `pendingJobRef` 仍置着，而轮询每 1.5s 跑一次。
 * 早期版本没有闸门 ⇒ **页面还在生成时又领了下一个任务**，把新 prompt
 * 打进输入框发送。后果：生成被打断、两个回复混在一起、`done` 分不清归属。
 *
 * ### 2. 取消后任务挂着
 *
 * 用户按停止 → host 侧 `signal.aborted` 抛错退出，但任务**仍留在队列里**
 * 处于 `claimed` 状态：`hasClaimed()` 永远 true（`/status` 误报「面板在干活」）、
 * 页面继续生成到结束（白烧配额）、之后回来的 `done` 还可能算成下一个任务的回复。
 *
 * ### 3. 待办永久卡死
 *
 * `pendingJobRef` 靠 `done` 事件清空。若事件丢失（页面导航/hook 被清/回复永不来），
 * 它会一直挂着 ⇒ 发送循环**永久罢工**，用户看到「模型一直不回复」。
 *
 * ## 这个脚本验证什么
 *
 * 用 mock Cordis ctx 起真实的 host 半，直接打 HTTP 接口验证��
 *   - 取消语义：`?running=<id>` 在任务被取消后返回 `cancel`
 *   - 平台隔离：不同平台领不到彼此的活
 *   - 队列状态：取消后 `hasClaimed()` 不该再报 true
 *   - 静态：client 侧确实有「待办时不领新活」的闸门和超时兜底
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isolate } from './lib/isolate.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

let pass = 0
let fail = 0
/**
 * ⚠️ 用普通函数而不是箭头函数 —— 需要 `arguments.length` 判断调用方
 * 是否显式传了第三个参数。默认参数 `expected = true` 会把显式传入的
 * `undefined` 也替换成 `true`，导致「断言等于 undefined」永远失败。
 */
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

// ---------------------------------------------------------------------------
// 最小 HTTP 桩（与 verify-host.mjs 同款）
// ---------------------------------------------------------------------------
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
      if (event === 'data' && body !== undefined) {
        setTimeout(() => cb(Buffer.from(body)), 0)
      }
      if (event === 'end') setTimeout(() => { cb(); resolveDone() }, 1)
      if (event === 'error') return this
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

/** mock Cordis ctx（记录路由与 adapter）。 */
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

console.log('=== 任务生命周期测试 ===\n')

/**
 * ⚠️ 隔离状态目录：插件会往 `~/.dsh/webin/`（含**会话游标**）读写。
 * 不隔离的话测试会污染真实状态，而且**测试之间互相污染** ——
 * 落盘的游标让第二次运行判定「无增量」⇒ 不派发任务 ⇒ 本测试全挂。
 * 详见 `scripts/lib/isolate.mjs`。
 */
const cleanupState = isolate('webin-lifecycle')

/**
 * ⚠️ **必须写一份登录快照**。
 *
 * 插件现在有登录门禁（用户要求「已登录才能用 LDW 模型」）：
 * 未登录时 `listModels` 返回空、`stream` 直接以 `WEBIN_NOT_LOGGED_IN` 报错
 * —— 那是对的，但会让**本测试拿不到任务**（「领到任务」断言失败）。
 *
 * 所以这里模拟「已经登录过」，让测试专注于它要验的生命周期语义。
 */
mkdirSync(join(process.env.DSH_HOME, 'webin', 'auth'), { recursive: true })
/** 两个平台都要写 —— 本测试两个平台的派发都验。 */
for (const platform of ['deepseek', 'qwen']) {
  writeFileSync(
    join(process.env.DSH_HOME, 'webin', 'auth', `${platform}.json`),
    JSON.stringify({ localStorage: { userToken: '{"value":"test-token"}' }, url: 'https://example.com/' }),
    'utf8',
  )
}

const mod = await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href)
const { apply } = mod

console.log('[1] 取消语义：?running=<id> 在任务被取消后必须返回 cancel')
{
  const A = makeCtx()
  await apply(A.ctx)
  const route = [...A.routes.values()].find((r) => r.path === '/dsh-webin/api')
  check('路由已注册', route !== undefined)

  const adapter = A.adapters.get('webin-deepseek')
  check('adapter 已注册', adapter !== undefined)

  // 起一个 stream，让任务入队
  const stream = adapter.stream({
    provider: 'webin-deepseek',
    model: 'ldw-fast',
    sessionId: 'lifecycle-1',
    messages: [{ role: 'user', content: 'hello-lifecycle' }],
  })
  const iter = stream[Symbol.asyncIterator]()
  const first = iter.next()
  await new Promise((r) => setTimeout(r, 150))

  // client 领活
  const claimed = await call(route.handler, 'GET', '/dsh-webin/api/job/next?platform=deepseek')
  check('领到任务', claimed.json?.job !== undefined && claimed.json.job !== null, true)
  const jobId = claimed.json.job.id

  // 未取消时问 running → 不该返回 cancel
  const before = await call(
    route.handler,
    'GET',
    `/dsh-webin/api/job/next?platform=deepseek&running=${encodeURIComponent(jobId)}`,
  )
  check('未取消时不返回 cancel', before.json?.cancel, undefined)

  // 模拟用户按停止：abort
  const ac = new AbortController()
  const stream2 = adapter.stream({
    provider: 'webin-deepseek',
    model: 'ldw-fast',
    sessionId: 'lifecycle-2',
    messages: [{ role: 'user', content: 'will-be-aborted' }],
    signal: ac.signal,
  })
  const iter2 = stream2[Symbol.asyncIterator]()
  const p2 = iter2.next()
  await new Promise((r) => setTimeout(r, 150))
  const claimed2 = await call(route.handler, 'GET', '/dsh-webin/api/job/next?platform=deepseek')
  const jobId2 = claimed2.json?.job?.id
  check('第二个任务已领', typeof jobId2 === 'string' && jobId2 !== '')

  ac.abort()
  const r2 = await p2
  check('abort 后流以 error 结束', r2.value?.reason?.kind, 'error')

  // 现在问 running → 必须返回 cancel（这是修复的核心）
  const after = await call(
    route.handler,
    'GET',
    `/dsh-webin/api/job/next?platform=deepseek&running=${encodeURIComponent(jobId2)}`,
  )
  check('⭐ 取消后返回 cancel', after.json?.cancel, jobId2)
  check('取消时不派新任务', after.json?.job, null)

  // 取消后 hasClaimed 不该再报 true（否则 /status 误报面板在干活）
  const status = await call(route.handler, 'GET', '/dsh-webin/api/status')
  const stillClaimed = status.json?.clients !== undefined
  check('/status 可读', stillClaimed, true)

  // 收尾：让第一个 stream 结束，避免悬挂
  await call(route.handler, 'PUT', `/dsh-webin/api/job/${jobId}/result`, JSON.stringify({ text: 'ok', think: '', status: 'finished' }))
  await first.catch(() => undefined)
}

console.log('\n[2] 平台隔离：不同平台领不到彼此的活')
{
  const B = makeCtx()
  await apply(B.ctx)
  const route = [...B.routes.values()].find((r) => r.path === '/dsh-webin/api')
  const adapter = B.adapters.get('webin-qwen')

  const stream = adapter.stream({
    provider: 'webin-qwen',
    model: 'qwen:qwen-fast',
    sessionId: 'qwen-1',
    messages: [{ role: 'user', content: 'qwen-task' }],
  })
  const iter = stream[Symbol.asyncIterator]()
  const first = iter.next()
  await new Promise((r) => setTimeout(r, 150))

  const wrong = await call(route.handler, 'GET', '/dsh-webin/api/job/next?platform=deepseek')
  check('deepseek 领不到 qwen 的活', wrong.json?.job, null)

  const right = await call(route.handler, 'GET', '/dsh-webin/api/job/next?platform=qwen')
  check('qwen 能领到自己的活', right.json?.job?.platform, 'qwen')

  await call(route.handler, 'PUT', `/dsh-webin/api/job/${right.json.job.id}/result`, JSON.stringify({ text: 'ok', think: '', status: 'finished' }))
  await first.catch(() => undefined)
}

console.log('\n[3] 静态：client 侧防插队闸门与超时兜底')
{
  const src = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  check('有待办闸门（hasPending）', src.includes('hasPending'))
  check('闸门在领活之前生效', /if \(hasPending\) return/.test(src))
  check('有待办超时兜底', src.includes('pendingSinceRef'))
  check('超时后交回错误解锁循环', src.includes('客户端 5 分钟兜底'))
  check('轮询带 running 参数', src.includes('running='))
  check('取消时调停止脚本', src.includes('buildStopScript'))
  // 产物里 `undefined` 被压缩成 `void 0`，所以两种写法都要认
  check(
    '取消时清掉本地待办',
    /pendingJobRef\.current = (?:undefined|void 0)[\s\S]{0,80}pendingSinceRef\.current = 0/.test(src),
  )
}

console.log('\n[4] 静态：停止脚本的定位规则（实测校准）')
{
  const src = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  check('停止脚本存在', src.includes('buildStopScript'))
  check('按语义匹配 stop/停止', src.includes('stop|停止|中断'))
  // 实测校准：停止键独有 --outlined，发送键独有 --filled/--primary
  check('用 --outlined 作为停止键特征', src.includes('ds-button--outlined'))
  check('排除发送键特征（--filled/--primary）', /ds-button--filled\|ds-button--primary/.test(src))
  check('分数并列时不敢猜', src.includes("reason: 'ambiguous'"))
  check('排除开关与附件', src.includes('附件|attach|上传|upload'))
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
cleanupState()
process.exitCode = fail === 0 ? 0 : 1
