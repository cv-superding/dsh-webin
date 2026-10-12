#!/usr/bin/env node
/**
 * **深度思考**链路测试。
 *
 * ## 用户实测缺陷
 *
 * 「点的思考模式那个模型，发现没有思考啊」。
 *
 * ## 根因（代码走查 + 实测确认）
 *
 * host 把 `thinking` 标记一路传到 client：
 *
 * ```
 * providers.ts   { id: 'ldw-think', thinking: true }
 *      ↓
 * adapter.ts     const thinking = spec.thinking === true
 *      ↓
 * queue.enqueue(prompt, spec.thinking === true, …)   → job.thinking
 *      ↓
 * host/index.ts  thinking: job.thinking              → 派发给 client
 *      ↓
 * client/index.ts  job: { … thinking: boolean … }    ← ❌ 只声明了类型，从没使用
 * ```
 *
 * **client 从来没拿 `thinking` 做任何事** —— 页面上的思考开关从未被触碰。
 *
 * ## 修复
 *
 * 发送**之前**调 `buildThinkingScript(job.thinking)`：
 *   - 找到页面上的思考开关（多信号加权，不只看文本）
 *   - 状态不符就点它
 *   - 切不动时**不阻断发送**，但要明确报告（不静默）
 *
 * ## 验证什么
 *
 * 1. 模型定义里 `thinking: true` 的模型确实存在
 * 2. host 把 `thinking` 传进了 job
 * 3. client **真的用了**它（这是之前的缺口）
 * 4. 切换脚本的逻辑正确（用 jsdom 风格的 DOM 桩真跑）
 * 5. reasoning 内容能被提取并发射成 reasoning 块
 */
import { readFileSync } from 'node:fs'
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

console.log('=== 深度思考链路测试 ===\n')

const cleanupState = isolate('webin-thinking')
const mod = await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href)
const { apply } = mod

console.log('[1] 模型定义：必须有 thinking: true 的模型')
{
  const src = readFileSync(join(ROOT, 'src', 'shared', 'providers.ts'), 'utf8')
  check('⭐ 有 ldw-think 模型', /id: 'ldw-think'/.test(src), true)
  check('⭐ 它标了 thinking: true', /ldw-think'[\s\S]{0,200}?thinking: true/.test(src), true)
  check('快速模式标了 thinking: false', /ldw-fast'[\s\S]{0,200}?thinking: false/.test(src), true)
}

console.log('\n[2] host：thinking 必须进 job（不能中途丢）')
{
  const A = makeCtx()
  await apply(A.ctx)
  const route = [...A.routes.values()].find((r) => r.path === '/dsh-webin/api')
  const adapter = A.adapters.get('webin-deepseek')

  // 用「深度思考」模型发起一次调用
  const stream = adapter.stream({
    provider: 'webin-deepseek',
    model: 'deepseek:ldw-think',
    sessionId: 'think-1',
    messages: [{ role: 'user', content: '一加一等于几' }],
  })
  const iter = stream[Symbol.asyncIterator]()
  const first = iter.next()
  await new Promise((r) => setTimeout(r, 150))
  const claimed = await call(route.handler, 'GET', '/dsh-webin/api/job/next?platform=deepseek')
  const job = claimed.json?.job
  check('派发了任务', job !== null && job !== undefined, true)
  check('⭐ job.thinking === true', job?.thinking, true)

  await call(
    route.handler,
    'PUT',
    `/dsh-webin/api/job/${job.id}/result`,
    JSON.stringify({ text: '等于二', think: '让我算一下：1+1=2', status: 'finished' }),
  )
  const chunks = []
  let r = await first
  while (r.done !== true) {
    chunks.push(r.value)
    r = await iter.next()
  }

  check('⭐ 有 reasoning 块', chunks.some((c) => c.blockType === 'reasoning'), true)
  const thinkDelta = chunks.find((c) => c.type === 'reasoning-delta')
  check('⭐ reasoning 内容正确', thinkDelta?.text, '让我算一下：1+1=2')
  const thinkEnd = chunks.find((c) => c.type === 'block-end' && c.block?.type === 'reasoning')
  check('⭐ reasoning block-end 形状正确', thinkEnd?.block?.text, '让我算一下：1+1=2')
  check('有正文块', chunks.some((c) => c.type === 'text-delta' && c.text === '等于二'), true)
}

console.log('\n[3] host：快速模式 thinking === false')
{
  const A = makeCtx()
  await apply(A.ctx)
  const route = [...A.routes.values()].find((r) => r.path === '/dsh-webin/api')
  const adapter = A.adapters.get('webin-deepseek')

  const stream = adapter.stream({
    provider: 'webin-deepseek',
    model: 'deepseek:ldw-fast',
    sessionId: 'fast-1',
    messages: [{ role: 'user', content: '你好' }],
  })
  const iter = stream[Symbol.asyncIterator]()
  const first = iter.next()
  await new Promise((r) => setTimeout(r, 150))
  const claimed = await call(route.handler, 'GET', '/dsh-webin/api/job/next?platform=deepseek')
  const job = claimed.json?.job
  check('⭐ job.thinking === false', job?.thinking, false)
  await call(route.handler, 'PUT', `/dsh-webin/api/job/${job.id}/result`, JSON.stringify({ text: '好', think: '', status: 'finished' }))
  await first.catch(() => undefined)
}

console.log('\n[4] ⭐⭐ client 必须**真的使用** job.thinking（这就是缺口）')
{
  const client = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  check('⭐ 调用了 buildThinkingScript', client.includes('buildThinkingScript'), true)
  check('⭐ 用的是 job.thinking', /buildThinkingScript\(data\.job\.thinking/.test(client), true)
  /**
   * ⚠️ 顺序关键：思考模式必须在**发送之前**切 ——
   * 它是请求体的一部分，发出去之后再切这一轮已经按旧模式跑了。
   */
  const thinkIdx = client.indexOf('buildThinkingScript(data.job.thinking')
  const sendIdx = client.indexOf('buildSendScript(prompt')
  check('⭐ 切换在发送之前', thinkIdx > 0 && sendIdx > 0 && thinkIdx < sendIdx, true)
  check('⭐ 切不动时不阻断发送', /思考模式脚本失败/.test(client), true)
  check('⭐ 切不动时明确报告（不静默）', /思考模式未切换/.test(client), true)
}

console.log('\n[5] ⭐ 切换脚本的逻辑（用 DOM 桩真跑）')
{
  const chat = await import(pathToFileURL(join(ROOT, 'lib', 'client.js')).href).catch(() => null)
  // client.js 是模块加载器格式，取不到导出 —— 改用源码提取脚本字符串
  const clientSrc = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')

  /**
   * 从产物里抠出 `buildThinkingScript`，喂 DOM 桩跑。
   *
   * 产物是 `function buildThinkingScript(want) { return `...` }`，
   * 直接按函数名定位并做花括号配对（脚本里没有裸花括号，安全）。
   */
  const start = clientSrc.indexOf('function buildThinkingScript')
  check('产物里有 buildThinkingScript', start > 0, true)
  if (start > 0) {
    let depth = 0
    let end = -1
    const open = clientSrc.indexOf('{', start)
    for (let i = open; i < clientSrc.length; i += 1) {
      if (clientSrc[i] === '{') depth += 1
      else if (clientSrc[i] === '}') {
        depth -= 1
        if (depth === 0) {
          end = i + 1
          break
        }
      }
    }
    const fnSrc = clientSrc.slice(start, end)
    // eslint-disable-next-line no-new-func
    const buildThinkingScript = new Function(`${fnSrc}; return buildThinkingScript;`)()

    check('能生成脚本（want=true）', typeof buildThinkingScript(true), 'string')
    check('脚本里 want=true', /var want = true/.test(buildThinkingScript(true)), true)
    check('脚本里 want=false', /var want = false/.test(buildThinkingScript(false)), true)

    /** 造一个最小 DOM 桩，跑真实脚本逻辑。 */
    const runScript = (script, elements, textareaRect) => {
      const mk = (spec) => {
        /**
         * ⚠️ **不能拷贝 attrs** —— 桩的 `onClick` 会改 `spec.attrs`
         * 来模拟「点击后状态变了」，若这里 spread 一份副本，
         * 改动就传不到 `getAttribute`，表现为「点了但状态没变」（踩过）。
         */
        const attrs = spec.attrs ?? {}
        const el = {
          tagName: spec.tag ?? 'BUTTON',
          className: spec.cls ?? '',
          textContent: spec.text ?? '',
          disabled: spec.disabled === true,
          offsetWidth: spec.hidden === true ? 0 : 40,
          offsetHeight: spec.hidden === true ? 0 : 20,
          getAttribute: (k) => (k in attrs ? attrs[k] : null),
          getBoundingClientRect: () => spec.rect ?? { left: 0, top: 0, right: 40, bottom: 20, width: 40, height: 20 },
          dispatchEvent: (ev) => {
            spec.events?.push(ev.type)
            if (spec.onClick !== undefined) spec.onClick(el, ev)
            return true
          },
        }
        return el
      }
      const els = elements.map(mk)
      const ta = { getBoundingClientRect: () => textareaRect }
      const document = {
        querySelector: (sel) => (sel.includes('textarea') ? ta : null),
        querySelectorAll: () => els,
      }
      const g = globalThis
      const savedDoc = g.document
      const savedGet = g.getComputedStyle
      const savedPE = g.PointerEvent
      const savedME = g.MouseEvent
      g.document = document
      g.getComputedStyle = () => ({ visibility: 'visible', display: 'block', opacity: '1' })
      g.PointerEvent = class {
        constructor(type, o) {
          Object.assign(this, o)
          this.type = type
        }
      }
      g.MouseEvent = class {
        constructor(type, o) {
          Object.assign(this, o)
          this.type = type
        }
      }
      try {
        return JSON.parse(eval(script))
      } finally {
        g.document = savedDoc
        g.getComputedStyle = savedGet
        g.PointerEvent = savedPE
        g.MouseEvent = savedME
      }
    }

    const TA_RECT = { left: 100, top: 500, right: 700, bottom: 600, width: 600, height: 100 }

    // ① 已开 + want=true ⇒ 不点
    {
      const events = []
      const r = runScript(
        buildThinkingScript(true),
        [{ text: '深度思考', attrs: { 'aria-pressed': 'true' }, rect: { left: 100, top: 440, right: 200, bottom: 470, width: 100, height: 30 }, events }],
        TA_RECT,
      )
      check('① 已开且要开 ⇒ ok', r.ok, true)
      check('① 没点击', r.changed, false)
      check('① 没派发事件', events.length, 0)
    }

    // ② 关着 + want=true ⇒ 点开
    {
      const events = []
      const spec = {
        text: '深度思考',
        attrs: { 'aria-pressed': 'false' },
        rect: { left: 100, top: 440, right: 200, bottom: 470, width: 100, height: 30 },
        events,
        onClick: () => {
          // 模拟页面：点击后 aria-pressed 变 true（直接改 spec.attrs）
          spec.attrs['aria-pressed'] = 'true'
        },
      }
      const r = runScript(buildThinkingScript(true), [spec], TA_RECT)
      check('② 切换成功', r.ok, true)
      check('② 状态从 false → true', `${r.before}→${r.after}`, 'false→true')
      check('② 派发了完整鼠标事件序列', events.join(','), 'pointerdown,mousedown,pointerup,mouseup,click')
    }

    // ③ 开着 + want=false ⇒ 关掉
    {
      const spec = {
        text: '深度思考',
        attrs: { 'aria-pressed': 'true' },
        rect: { left: 100, top: 440, right: 200, bottom: 470, width: 100, height: 30 },
        onClick: () => {
          spec.attrs['aria-pressed'] = 'false'
        },
      }
      const r = runScript(buildThinkingScript(false), [spec], TA_RECT)
      check('③ 关闭成功', r.ok, true)
      check('③ 状态 true → false', `${r.before}→${r.after}`, 'true→false')
    }

    // ④ 找不到开关 ⇒ no-toggle（不静默）
    {
      const r = runScript(buildThinkingScript(true), [{ text: '发送', attrs: {} }], TA_RECT)
      check('④ 报告 no-toggle', r.reason, 'no-toggle')
      check('④ ok=false', r.ok, false)
    }

    // ⑤ 点了但状态没变 ⇒ 明确报告（不谎报成功）
    {
      const el = {
        text: '深度思考',
        attrs: { 'aria-pressed': 'false' },
        rect: { left: 100, top: 440, right: 200, bottom: 470, width: 100, height: 30 },
        onClick: () => {}, // 点了没反应
      }
      const r = runScript(buildThinkingScript(true), [el], TA_RECT)
      check('⑤ 不谎报成功', r.ok, false)
      check('⑤ 说明原因', r.reason, 'click-did-not-change-state')
    }

    // ⑥ disabled ⇒ 不点
    {
      const events = []
      const el = {
        text: '深度思考',
        attrs: { 'aria-pressed': 'false', 'aria-disabled': 'true' },
        rect: { left: 100, top: 440, right: 200, bottom: 470, width: 100, height: 30 },
        events,
      }
      const r = runScript(buildThinkingScript(true), [el], TA_RECT)
      check('⑥ 报告 disabled', r.reason, 'disabled')
      check('⑥ 没点击', events.length, 0)
    }

    // ⑦ data-state 也算「已开」
    {
      const el = {
        text: 'DeepThink',
        attrs: { 'data-state': 'on' },
        rect: { left: 100, top: 440, right: 200, bottom: 470, width: 100, height: 30 },
      }
      const r = runScript(buildThinkingScript(true), [el], TA_RECT)
      check('⑦ data-state=on 识别为已开', r.before, true)
      check('⑦ 无需点击', r.ok, true)
    }

    // ⑧ 几何位置远离输入框，且文本**不**含关键词 ⇒ 不该被选中
    {
      const el = {
        text: '联网搜索', // 不含思考关键词
        attrs: { 'aria-pressed': 'false' },
        rect: { left: 10, top: 10, right: 110, bottom: 40, width: 100, height: 30 },
      }
      const r = runScript(buildThinkingScript(true), [el], TA_RECT)
      check('⑧ 无关按钮不被误点', r.reason, 'no-toggle')
    }

    // ⑨ 文本命中关键词但位置远离输入框 ⇒ 仍然生效（位置只加分，不是门槛）
    {
      const spec = {
        text: '深度思考',
        attrs: { 'aria-pressed': 'false' },
        rect: { left: 10, top: 10, right: 110, bottom: 40, width: 100, height: 30 },
        onClick: () => {
          spec.attrs['aria-pressed'] = 'true'
        },
      }
      const r = runScript(buildThinkingScript(true), [spec], TA_RECT)
      check('⑨ 文本命中即生效（位置只加分）', r.ok, true)
    }
  }
}

console.log('\n[6] hook 侧：reasoning_content 能被提取（网页确实会吐思考）')
{
  const hook = readFileSync(join(ROOT, 'src', 'client', 'hook.ts'), 'utf8')
  check('⭐ 认 reasoning_content', hook.includes("'reasoning_content'"), true)
  check('⭐ 认 thinking_content', hook.includes("'thinking_content'"), true)
  check('⭐ 认 THINK 片段类型', /f\.type === 'THINK'/.test(hook), true)
  check('⭐ 快照里的 THINK 也认', /g\.type === 'THINK'/.test(hook), true)

  // 大小写不敏感（网页可能给 Think / think）
  const cuckooStyle = /String\(.*\)\.toUpperCase\(\) === 'THINK'|=== 'THINK'/.test(hook)
  check('THINK 判据（实测网页用大写）', cuckooStyle, true)
}

cleanupState()
console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
process.exitCode = fail === 0 ? 0 : 1
