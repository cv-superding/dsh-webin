/**
 * adapter 测试台 —— 给「工具循环」相关测试共用。
 *
 * ## 为什么抽出来
 *
 * `verify-tool-chunks` 里那套 makeHttp / makeCtx / runRound 是**调通了的**，
 * 而我在写 `verify-tool-e2e` 时凭记忆重写了一遍 ⇒ 漏了细节（150ms 等待、
 * SSE 的 data/end 事件时序）⇒ **测试挂起**。
 *
 * 这正是用户反复经历的那类问题的缩小版：**「看起来一样的实现，
 * 细节不对就完全不工作」**。所以共用一份，别各写各的。
 *
 * ## 用法
 *
 * ```js
 * import { makeCtx, makeCall, runRound, TOOLS } from './lib/adapter-harness.mjs'
 * const A = makeCtx()
 * await mod.apply(A.ctx)
 * const route = [...A.routes.values()].find((r) => r.path === '/dsh-webin/api')
 * const adapter = A.adapters.get('webin-deepseek')
 * const { chunks, job } = await runRound(adapter, route, '```ldw\n...\n```', { tools: TOOLS })
 * ```
 */

/** 假 HTTP：支持 SSE 的 data/end 事件时序（插件的心跳与 job 路由都靠它）。 */
export function makeHttp(method, url, body) {
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

export const safeJson = (s) => {
  try {
    return JSON.parse(s)
  } catch {
    return undefined
  }
}

/** 调一次路由处理器（带 2 秒兜底，防 SSE 永不结束把测试挂死）。 */
export async function makeCall(handler, method, url, body) {
  const { req, res, done } = makeHttp(method, url, body)
  await handler(req, res)
  await Promise.race([done, new Promise((r) => setTimeout(r, 2000))])
  return { status: res.statusCode, text: res.chunks.join(''), json: safeJson(res.chunks.join('')) }
}

/** 插件 ctx 的最小桩（llm.registerAdapter + webServer.register）。 */
export function makeCtx() {
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

/** 实测形状的工具 schema。 */
export const TOOLS = [
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
  {
    name: 'write',
    description: '写入文件。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path'],
    },
  },
]

/** 每轮独立会话号（游标按 session 隔离，不能复用）。 */
let roundSeq = 0
export const nextSession = (prefix = 'harness') => `${prefix}-${roundSeq++}`

/**
 * 跑一轮：把 `reply` 当作模型回复交回，返回 adapter 吐出的所有 chunk。
 *
 * ⚠️ 两个曾经踩坑的细节（凭记忆重写时漏掉就挂起）：
 *   1. 先 `iter.next()` 推进一步让任务入队，**再等 150ms**（等派发完成）
 *   2. 领活必须带 `session`（派发时带了，窗口不带就领不到）
 *
 * @param adapter - llm adapter
 * @param route - `/dsh-webin/api` 路由
 * @param reply - 交回的回复文本
 * @param opts - `{ sessionId?, tools?, messages?, model? }`
 */
export async function runRound(adapter, route, reply, opts = {}) {
  const sessionId = opts.sessionId ?? nextSession('round')
  const stream = adapter.stream({
    provider: opts.provider ?? 'webin-deepseek',
    model: opts.model ?? 'ldw-fast',
    messages: opts.messages ?? [{ role: 'user', content: '你好' }],
    ...(opts.tools === undefined ? {} : { tools: opts.tools }),
    sessionId,
  })
  const iter = stream[Symbol.asyncIterator]()
  /** ⚠️ 先推进一步让任务入队。 */
  const first = iter.next()
  await new Promise((r) => setTimeout(r, 150))

  /** ⚠️ 领活必须带会话身份。 */
  const claimed = await makeCall(
    route.handler,
    'GET',
    `/dsh-webin/api/job/next?platform=deepseek&session=${encodeURIComponent(sessionId)}`,
  )
  const job = claimed.json?.job
  if (job === null || job === undefined) {
    await first.catch(() => undefined)
    return { chunks: [], job: null }
  }

  await makeCall(
    route.handler,
    'PUT',
    `/dsh-webin/api/job/${job.id}/result`,
    JSON.stringify({ text: reply, think: opts.think ?? '', status: 'finished' }),
  )

  const chunks = []
  let r = await first
  while (r.done !== true) {
    chunks.push(r.value)
    r = await iter.next()
  }
  return { chunks, job }
}

/** 从 chunks 里取 finish 原因 —— 「一问一答」的判定点。 */
export const finishKind = (chunks) => chunks.find((c) => c.type === 'finish')?.reason?.kind
/**
 * 从 chunks 里取工具调用。
 *
 * ⚠️ DSH 的流式契约里工具调用是 **tool-call-delta**（增量）+
 * block-end 里带完整 block —— **没有** type === 'tool-call' 的 chunk。
 * 我一开始按 'tool-call' 过滤，结果恒为空数组、误判成「工具没被调用」
 * （真实踩过 —— 差点又去改没坏的 adapter）。
 *
 * 同时覆盖两种来源，测试才不会因为契约细节写错而误报。
 */
export const toolCalls = (chunks) => {
  const out = []
  for (const c of chunks) {
    if (c.type === 'tool-call-delta') out.push({ name: c.name, arguments: c.argumentsDelta, id: c.id })
    /** block-end 里有完整调用（去重：以 delta 优先）。 */
    if (c.type === 'block-end' && c.block?.type === 'tool-call' && !out.some((x) => x.id === c.block.id)) {
      out.push({ name: c.block.name, arguments: c.block.arguments, id: c.block.id })
    }
  }
  return out
}
/** 从 chunks 里取正文文本。 */
export const textOut = (chunks) =>
  chunks
    .filter((c) => c.type === 'text-delta')
    .map((c) => c.text ?? '')
    .join('')

/**
 * 准备隔离状态目录 + 登录快照（不写快照的话 stream 直接报 NOT_LOGGED_IN）。
 *
 * @param tag - 隔离目录后缀
 * @returns 清理函数
 */
export async function prepareState(isolateFn, tag) {
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const cleanup = isolateFn(tag)
  mkdirSync(join(process.env.DSH_HOME, 'webin', 'auth'), { recursive: true })
  for (const platform of ['deepseek', 'qwen']) {
    writeFileSync(
      join(process.env.DSH_HOME, 'webin', 'auth', `${platform}.json`),
      JSON.stringify({
        localStorage: { userToken: '{"value":"test-token"}' },
        url: 'https://example.com/',
      }),
      'utf8',
    )
  }
  return cleanup
}
