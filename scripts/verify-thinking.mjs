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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
  const claimed = await call(route.handler, 'GET', '/dsh-webin/api/job/next?platform=deepseek&session=think-1')
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
  const claimed = await call(route.handler, 'GET', '/dsh-webin/api/job/next?platform=deepseek&session=fast-1')
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
  /**
   * ⚠️ 发送已拆成 `buildFillScript` + `buildTriggerScript`（照 cuckoo 重构），
   * 所以这里比对「思考切换」与**填充**的先后 —— 填充是发送的第一步。
   */
  /**
   * ⚠️ 必须带逗号：`buildFillScript(prompt` 是 `buildFillScript(promptRef.current`
   * 的**前缀** —— 不收紧的话会命中「不完整重试」里的重发调用（它在轮询循环里，
   * 位置比真正的发送早），断言就成了拿错参照点（同类误报见 verify-audit）。
   */
  const sendIdx = client.indexOf('buildFillScript(prompt,')
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
  /**
   * ⚠️ 断言跟着修复走。
   *
   * 早期是「fragment 里 type === 'THINK' 就直接 think +=」——
   * 但**裸增量帧没有 type**，所以思考的绝大部分内容被当正文了
   * （实测：网页显示「已思考（用时 1 秒）」，DSH 只收到 2 个字）。
   *
   * 现在改为：维护 fragmentTypes 类型表 + currentIndex，
   * 裸增量按当前 fragment 类型分流。
   */
  check('⭐ 有 fragment 类型表', hook.includes('fragmentTypes'), true)
  check('⭐ 裸增量按类型分流', /route\(obj\.v\)/.test(hook), true)
  check('⭐ 大小写不敏感判 THINK', /toUpperCase\(\) === 'THINK'/.test(hook), true)
  check('⭐ 快照重建类型表（不叠加）', /fragmentTypes\.length = frags\.length/.test(hook), true)
}

cleanupState()
console.log('\n[?] ⭐⭐⭐ 正文里混进思考时必须剔除（用户实测）')
{
  /**
   * ## 用户实测
   *
   * 「感觉把思考内容也当正文输出了」—— DSH 对话里显示的是模型的英文思考过程。
   *
   * ## 根因
   *
   * 真实页面上 `ds-think-content` **嵌套在 `ds-markdown` 内部**（思考是回复的
   * 一部分，只是折叠显示），递归渲染正文时会把思考一起读进去。
   *
   * hook 侧有两层排除，但**都依赖页面特征**（类名 / 折叠条文案「已思考（用时」），
   * 页面一改版就失效。
   *
   * ## 修法
   *
   * 加一道**与页面特征无关**的兜底：`think` 是单独读出来的，若它出现在正文里
   * 就删掉那段。先试直接子串，不中再按逐行定位。
   */
  const clientSrc = readFileSync(join(ROOT, 'src', 'client', 'index.ts'), 'utf8')
  check('⭐⭐⭐ 有「正文混进思考」的兜底', /正文里混进了思考，已剔除/.test(clientSrc), true)
  check('⭐⭐ 先试直接子串', /const at = last\.indexOf\(thinkTrim\)/.test(clientSrc), true)
  check('⭐⭐ 不中再逐行定位', /lLines\.findIndex/.test(clientSrc), true)
  /** 只对足够长的思考生效，避免误删正常正文里的短句。 */
  check('⭐⭐ 有最小长度门槛', /thinkTrim\.length >= 20/.test(clientSrc), true)
  /** 交付必须用剔除后的文本（用 last 就等于没修）。 */
  check('⭐⭐⭐ 交付用剔除后的 lastClean', /\? lastClean/.test(clientSrc), true)
  check('⭐⭐ 变化判定也用 lastClean', /scrapedRef\.current !== lastClean/.test(clientSrc), true)
}

console.log('\n[?] ⭐⭐⭐ readThink 必须认**新版**文案（真根因）')
{
  /**
   * ## 用户实测（第三次报同一个症状）
   *
   * 思考又被当正文输出。查下来真根因在 `readThink()`：
   *
   *     if (wt.indexOf('已思考') === -1 || wt.length > 200) continue;
   *
   * 它**硬匹配旧文案「已思考」** —— 而页面已改成「**已完成分析**」，
   * 匹配不上 ⇒ `readThink()` 返回**空** ⇒ 上一版加的「正文混进思考就剔除」
   * 兜底**根本没有东西可剔除** ⇒ 思考原样漏出。
   *
   * ⚠️ 教训：同一份文案判据散落在多处（render 排除 / readThink 定位 / 前缀清理），
   * 改一处漏两处。所以现在**统一用 isThinkLabel()**，不再各写各的。
   */
  const hookSrc = readFileSync(join(ROOT, 'src', 'client', 'hook.ts'), 'utf8')

  check('⭐⭐⭐ 折叠条定位改用 isThinkLabel', /if \(!isThinkLabel\(wt\)\) continue;/.test(hookSrc), true)
  check('⭐⭐ 深层判据也用 isThinkLabel', /isThinkLabel\(String\(wkk\[wj\]\.textContent/.test(hookSrc), true)
  check('⭐⭐ 前缀清理含新文案', hookSrc.includes('已完成分析') && hookSrc.includes('正在分析请求'), true)
  /** 逐行去掉「思考 · 用户」这类分组标题。 */
  check('⭐⭐ 逐行过滤标签行', /segs\.every/.test(hookSrc), true)
  /** 不许再残留硬匹配的旧文案判据。 */
  check(
    '⭐⭐ 不再有硬匹配「已思考」的定位',
    !/wt\.indexOf\('已思考'\)/.test(hookSrc),
    true,
  )
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
process.exitCode = fail === 0 ? 0 : 1
/** ⚠️ 显式退出 —— 防 handle 悬挂把 npm run check 卡死（verify-lifecycle 实测踩过）。 */
process.exit(process.exitCode)
