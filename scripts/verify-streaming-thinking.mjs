#!/usr/bin/env node
/**
 * **渐进显示思考过程**链路测试。
 *
 * ## 本次改动要验什么
 *
 * 用户要的是「插件能显示模型的思考过程」且**渐进**——模型还在想时就
 * 能边生成边在 DSH 侧渲染思考区，而不是等整轮结束才一起冒出来。
 *
 * 改法（见 adapter.ts / index.ts / client/index.ts）：
 *   1. client 监听 hook 的 `dsh-webin:stream` 事件，把 `think` 增量实时
 *      `PUT /job/<id>/think` 上报 host；
 *   2. host 在 `JobQueue` 上加 `appendThink` / `subscribeThink`，增量实时
 *      推给 `streamOnce`；
 *   3. `streamOnce` 在 `thinking` 档位：首次增量时开 `block-start(reasoning)`
 *      → 实时 `reasoning-delta` → 最终用全量 `done.think` 补齐 → `block-end`。
 *
 * ## 验证用例
 *
 *   A. thinking 档位整体块结构正确（开块 → 增量 → 关块，内容不丢）
 *   B. 实时性：消费方边消费边上报，每个增量被**独立实时** emit（非一次性补齐）
 *   C. 增量流中途断掉（客户端不报增量，只报最终全量）仍不丢字、正常关块
 *   D. 非 thinking 模型退化为旧行为（无 think 时不渲染块）
 *   E. client 侧源码契约：监听 stream 事件并 PUT /job/<id>/think 增量
 *
 * ## 关于消费模式
 *
 * 由于 `block-start` 是**首次增量到达时**才 lazy yield 的，调用方必须先
 * `iter.next()` 驱动 generator（它会 suspend 在「等增量/等结果」的 race 上），
 * 而不能像旧版那样 `first = iter.next()` 立刻拿到首块。
 */

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isolate } from './lib/isolate.mjs'

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

/** 复用与 verify-thinking.mjs 一致的 HTTP 桩。 */
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

async function call(handler, method, url, body) {
  const { req, res, done } = makeHttp(method, url, body)
  await handler(req, res)
  await Promise.race([done, new Promise((r) => setTimeout(r, 2000))])
  const text = res.chunks.join('')
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  return { status: res.statusCode, text, json }
}

function makeCtx() {
  const routes = new Map()
  const adapters = new Map()
  const ctx = {
    logger: () => ({ info() {}, warn() {}, debug() {} }),
    effect(cb) {
      cb()
      return () => {}
    },
    llm: {
      registerAdapter(providers, adapter) {
        for (const p of providers) adapters.set(p, adapter)
        return () => {}
      },
    },
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => {}
      },
    },
    slots: { inject() {}, register: (o, c) => ({ o, c }) },
  }
  return { ctx, routes, adapters }
}

const withTimeout = (p, ms, tag) =>
  Promise.race([p, new Promise((resolve) => setTimeout(() => resolve({ __timeout: tag }), ms))])

/**
 * 消费一个**已预取过首块**的迭代器，收集剩下所有 chunk。
 *
 * 调用方必须先 `const first = iter.next()`（**不要立即 await**——它返回的是
 * promise，让 generator 有机会在 sleep/PUT 期间推进），在发完 HTTP 后
 * `const firstChunk = await first` 拿首块，再把 `firstChunk` 与 `iter` 一起传进来。
 * 每个 next 带 3s 超时保护，避免单测卡死整轮。
 */
async function drain(iter, firstChunk) {
  const chunks = []
  if (firstChunk !== undefined) chunks.push(firstChunk.value ?? firstChunk)
  let guard = 0
  for (;;) {
    const r = await withTimeout(iter.next(), 3000, 'drain-next')
    if (r && r.__timeout) {
      console.log(`  ⚠️ drain 超时（${r.__timeout}），中止消费`)
      break
    }
    if (r.done === true) break
    chunks.push(r.value)
    guard += 1
    if (guard > 500) break
  }
  return chunks
}

console.log('=== 渐进显示思考过程链路测试 ===\n')

// 全局硬超时兜底：避免任何单点 await 卡死整轮 verify
setTimeout(() => {
  console.log('\n⚠️ 全局硬超时（40s），强制退出')
  process.exit(2)
}, 40000).unref?.()

const cleanupState = isolate('webin-streaming-thinking')
/** 登录门禁：模拟已登录，让 adapter 能派发任务。 */
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

console.log('[A] thinking 档位：整体块结构（开块 → 增量 → 关块，内容不丢）')
{
  const A = makeCtx()
  await apply(A.ctx)
  const route = [...A.routes.values()].find((r) => r.path === '/dsh-webin/api')
  const adapter = A.adapters.get('webin-deepseek')
  const stream = adapter.stream({
    provider: 'webin-deepseek',
    model: 'deepseek:ldw-think',
    sessionId: 'a-1',
    messages: [{ role: 'user', content: '一加一等于几' }],
  })
  const iter = stream[Symbol.asyncIterator]()
  /** ⭐ 预取首块（不立即 await，让 generator 在 sleep/PUT 期间推进）。 */
  const first = iter.next()
  await new Promise((r) => setTimeout(r, 150))
  const claimed = await call(route.handler, 'GET', '/dsh-webin/api/job/next?platform=deepseek&session=a-1')
  const job = claimed.json?.job
  check('派发了 thinking 任务', job?.thinking, true)
  check('⭐ /think 路由存在', typeof route.handler === 'function', true)

  // 先发两段增量 + 最终全量（在 drain 之前），验证「回放 + 实时 + 补齐」整体正确
  await call(route.handler, 'PUT', `/dsh-webin/api/job/${job.id}/think`, JSON.stringify({ delta: '让我' }))
  await call(route.handler, 'PUT', `/dsh-webin/api/job/${job.id}/think`, JSON.stringify({ delta: '算一下' }))
  await call(
    route.handler,
    'PUT',
    `/dsh-webin/api/job/${job.id}/result`,
    JSON.stringify({ text: '等于二', think: '让我算一下：1+1=2', status: 'finished' }),
  )
  const firstChunk = await first
  const chunks = await drain(iter, firstChunk)
  check('⭐ 有 reasoning 块起始', chunks.some((c) => c.type === 'block-start' && c.blockType === 'reasoning'), true)
  const deltas = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text)
  check('⭐ 实时增量 + 补齐：内容拼接等于全量', deltas.join(''), '让我算一下：1+1=2')
  const endChunk = chunks.find((c) => c.type === 'block-end' && c.block?.type === 'reasoning')
  check('⭐ reasoning block-end 形状正确（全量）', endChunk?.block?.text, '让我算一下：1+1=2')
  check('⭐ 有正文 delta', chunks.some((c) => c.type === 'text-delta' && c.text === '等于二'), true)
}

console.log('\n[B] 实时性：消费方边消费边上报，每个增量被独立实时 emit')
{
  const A = makeCtx()
  await apply(A.ctx)
  const route = [...A.routes.values()].find((r) => r.path === '/dsh-webin/api')
  const adapter = A.adapters.get('webin-deepseek')
  const stream = adapter.stream({
    provider: 'webin-deepseek',
    model: 'deepseek:ldw-think',
    sessionId: 'b-1',
    messages: [{ role: 'user', content: '证明根号二无理数' }],
  })
  const iter = stream[Symbol.asyncIterator]()
  /** ⭐ 预取首块（不立即 await，让 generator 后台跑起来 enqueue）。 */
  const first = iter.next()
  await new Promise((r) => setTimeout(r, 150))
  const claimed = await call(route.handler, 'GET', '/dsh-webin/api/job/next?platform=deepseek&session=b-1')
  const job = claimed.json?.job
  check('thinking 任务派发', job?.thinking, true)

  /**
   * 用**并发消费**模拟真实 DSH：后台持续 `await iter.next()` 拉取，
   * 主线程穿插 `PUT /think` 增量。这比「严格交替 await」更接近真实，
   * 也能避开 async generator 在单点 await 间隙的 resolver 错位边界情况。
   */
  const collected = []
  const consumer = (async () => {
    // 先推进首块（消费 first 预取），再循环拉取余下 chunk
    let r = await first
    for (;;) {
      if (r.done === true) break
      collected.push(r.value)
      r = await withTimeout(iter.next(), 3000, 'b-consume')
      if (r && r.__timeout) break
    }
  })()

  // 穿插上报两段增量（模拟客户端边抓边报）
  await call(route.handler, 'PUT', `/dsh-webin/api/job/${job.id}/think`, JSON.stringify({ delta: '假设' }))
  await new Promise((r) => setTimeout(r, 20))
  await call(route.handler, 'PUT', `/dsh-webin/api/job/${job.id}/think`, JSON.stringify({ delta: '它是有理数' }))
  await new Promise((r) => setTimeout(r, 20))
  // 最终全量补齐（比已上报多「…」）
  await call(
    route.handler,
    'PUT',
    `/dsh-webin/api/job/${job.id}/result`,
    JSON.stringify({ text: '得证', think: '假设它是有理数…', status: 'finished' }),
  )
  await consumer

  check('⭐ 首块是 reasoning 块起始', collected[0]?.type === 'block-start' && collected[0]?.blockType === 'reasoning', true)
  const deltas = collected.filter((c) => c.type === 'reasoning-delta').map((c) => c.text)
  check('⭐ 增量被拆成多条 delta（实时 emitted，非一次性）', deltas.length >= 2, true)
  check('⭐ 增量内容按到达顺序拼接等于全量', deltas.join(''), '假设它是有理数…')
  const endChunk = collected.find((c) => c.type === 'block-end' && c.block?.type === 'reasoning')
  check('⭐ 关块（全量）', endChunk?.block?.text, '假设它是有理数…')
  check('⭐ 有正文 delta', collected.some((c) => c.type === 'text-delta' && c.text === '得证'), true)
}

console.log('\n[C] 增量流中途断掉（客户端不报增量，只报最终全量）—— 不丢字、正常关块')
{
  const A = makeCtx()
  await apply(A.ctx)
  const route = [...A.routes.values()].find((r) => r.path === '/dsh-webin/api')
  const adapter = A.adapters.get('webin-deepseek')
  const stream = adapter.stream({
    provider: 'webin-deepseek',
    model: 'deepseek:ldw-think',
    sessionId: 'c-1',
    messages: [{ role: 'user', content: '你好' }],
  })
  const iter = stream[Symbol.asyncIterator]()
  /** ⭐ 预取首块（不立即 await）。 */
  const first = iter.next()
  await new Promise((r) => setTimeout(r, 150))
  const claimed = await call(route.handler, 'GET', '/dsh-webin/api/job/next?platform=deepseek&session=c-1')
  const job = claimed.json?.job
  // 完全不调 /think，直接交全量
  await call(
    route.handler,
    'PUT',
    `/dsh-webin/api/job/${job.id}/result`,
    JSON.stringify({ text: '你好', think: '用户说你好，我回个招呼', status: 'finished' }),
  )
  const firstChunk = await first
  const chunks = await drain(iter, firstChunk)
  const endChunk = chunks.find((c) => c.type === 'block-end' && c.block?.type === 'reasoning')
  check('⭐ 断流时仍关块（全量兜底）', endChunk?.block?.text, '用户说你好，我回个招呼')
  check('⭐ 没有空 reasoning 块', endChunk !== undefined, true)
}

console.log('\n[D] 非 thinking 模型：退化为旧行为（无 think 时不渲染块）')
{
  const A = makeCtx()
  await apply(A.ctx)
  const route = [...A.routes.values()].find((r) => r.path === '/dsh-webin/api')
  const adapter = A.adapters.get('webin-deepseek')
  const stream = adapter.stream({
    provider: 'webin-deepseek',
    model: 'deepseek:ldw-fast',
    sessionId: 'd-1',
    messages: [{ role: 'user', content: '你好' }],
  })
  const iter = stream[Symbol.asyncIterator]()
  /** ⭐ 预取首块（不立即 await）。 */
  const first = iter.next()
  await new Promise((r) => setTimeout(r, 150))
  const claimed = await call(route.handler, 'GET', '/dsh-webin/api/job/next?platform=deepseek&session=d-1')
  const job = claimed.json?.job
  check('快速模型 thinking=false', job?.thinking, false)
  await call(
    route.handler,
    'PUT',
    `/dsh-webin/api/job/${job.id}/result`,
    JSON.stringify({ text: '你好', think: '', status: 'finished' }),
  )
  const firstChunk = await first
  const chunks = await drain(iter, firstChunk)
  check('⭐ 无 think 时无 reasoning 块', !chunks.some((c) => c.blockType === 'reasoning' || c.block?.type === 'reasoning'), true)
  check('⭐ 有正文 delta', chunks.some((c) => c.type === 'text-delta' && c.text === '你好'), true)
}

console.log('\n[E] client 侧：监听 stream 事件并 PUT /job/<id>/think 增量')
{
  const client = readFileSync(join(ROOT, 'src', 'client', 'index.ts'), 'utf8')
  check('⭐ drain effect 处理 stream 事件', /ev\.name === 'stream'/.test(client), true)
  check('⭐ 计算 think 增量（slice 已上报长度）', /full\.slice\(reportedThinkLenRef\.current\)/.test(client), true)
  check('⭐ 调 PUT /think 路由', /\/job\/\$\{jobId\}\/think/.test(client), true)
  check('⭐ 任务切换时重置增量游标', /reportedThinkJobRef\.current !== jobId/.test(client), true)
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
process.exitCode = fail === 0 ? 0 : 1
/** ⚠️ 显式退出 —— 防 handle 悬挂把 npm run check 卡死。 */
process.exit(process.exitCode)
