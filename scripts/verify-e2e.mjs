#!/usr/bin/env node

/**
 * ⚠️ **本脚本尚未适配发送流程重构（2026-10-13）**
 *
 * 它引用的 `buildSendScript()` **已被删除** —— 那个函数把
 * 「填充 → 等 2.4s → 校验 → 重试」全塞进一次 executeJavaScript，
 * 是跨进程调用，页面一导航就整体死掉（宿主永远等）。
 *
 * 现在拆成三段（见 `src/client/chat.ts`）：
 *   - `buildFillScript`    只填输入框
 *   - 客户端 `setTimeout`  随机延迟
 *   - `buildTriggerScript` 只点发送
 *
 * 要跑本探针，请先把里面的 `buildSendScript(...)` 换成
 * `buildTriggerScript(...)`（参数也变了：不再收 text / delayMs）。
 * 替换后行为需要**真浏览器**验证，所以没有自动改动。
 */

/**
 * **端到端验证**：模拟 DSH agent loop 调 `deepseek-webin` provider，
 * 验证「模型选择器选 LDW → 网页版回复进对话」这最后一环。
 *
 * 做法：不经过真实 agent，而是直接打 host 的 HTTP 接口走完整链路：
 *   1. 读 `/status` 确认面板在线 + 已登录
 *   2. 用 `job/next` 扮演「client 领活」是不可能的（client 才是领活方），
 *      所以这里反过来：**直接触发一次真实模型调用** —— 通过 DSH 的
 *      `llm` 服务不可从外部调，所以改用「观察法」：
 *      轮询 job 队列，一旦有任务（说明 agent 真的派活了），
 *      交给页面上真实的发送脚本执行，再把结果交回。
 *
 * 换句话说：这个脚本就是**一个外部 client**，用真实浏览器替 DSH 干活。
 * 它跑通 = 插件的 client 半逻辑正确（只是换了个宿主进程跑）。
 *
 * 用法：
 *   node scripts/verify-e2e.mjs            # 等一个真实任务（最多 120s）
 *   node scripts/verify-e2e.mjs --prompt "1+1=?"  # 自造任务，不依赖 agent
 */
import { spawn } from 'node:child_process'
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const args = process.argv.slice(2)
const promptIdx = args.indexOf('--prompt')
const PROMPT = promptIdx >= 0 && args[promptIdx + 1] !== undefined ? args[promptIdx + 1] : undefined
const PLATFORM = (() => {
  const i = args.indexOf('--platform')
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : 'deepseek'
})()

const SRC = dirname(dirname(fileURLToPath(import.meta.url)))
const DS_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const SNAPSHOT = join(DS_HOME, 'webin', 'auth', `${PLATFORM}.json`)

const BASE = 'http://127.0.0.1:19387/dsh-webin/api'
const SECRET = process.env.DSH_WEBIN_SECRET ?? ''

const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
]
const findBrowser = () => {
  for (const b of BROWSERS) if (b !== '' && existsSync(b)) return b
  throw new Error('找不到 Chrome/Edge')
}

function extractFn(bundle, name) {
  const m = bundle.match(new RegExp(`function ${name}\\(([^)]*)\\)\\s*\\{`))
  if (m === null) throw new Error(`产物里找不到 ${name}`)
  const start = m.index
  const openBrace = bundle.indexOf('{', start)
  let depth = 0
  let braceEnd = -1
  for (let i = openBrace; i < bundle.length; i += 1) {
    if (bundle[i] === '{') depth += 1
    else if (bundle[i] === '}') {
      depth -= 1
      if (depth === 0) {
        braceEnd = i + 1
        break
      }
    }
  }
  const rest = bundle.slice(openBrace)
  const nextDecl = rest.search(/\n\t\t(?:function |const |exports\.)/)
  const declEnd = nextDecl < 0 ? bundle.length : openBrace + nextDecl
  const end = braceEnd > 0 && braceEnd <= declEnd ? braceEnd : declEnd

  const before = bundle.slice(0, start)
  const seen = new Set()
  const consts = []
  for (const c of before.matchAll(/^[ \t]*const ([A-Z][A-Z0-9_]*)\s*=\s*([^;\n]+);/gm)) {
    if (seen.has(c[1])) continue
    seen.add(c[1])
    consts.push(`const ${c[1]} = ${c[2]};`)
  }
  const body = bundle.slice(start, end)
  const bodyConsts = new Set([...body.matchAll(/^[ \t]*const ([A-Z][A-Z0-9_]*)\s*=/gm)].map((c) => c[1]))
  const needed = consts.filter((l) => {
    const nm = /const ([A-Z][A-Z0-9_]*)/.exec(l)?.[1]
    return nm !== undefined && !bodyConsts.has(nm)
  })
  // eslint-disable-next-line no-new-func
  return new Function(`${needed.join('\n')}\n${body}\n; return ${name};`)()
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      const p = this.pending.get(msg.id)
      if (p !== undefined) {
        this.pending.delete(msg.id)
        if (msg.error !== undefined) p.reject(new Error(JSON.stringify(msg.error)))
        else p.resolve(msg.result)
      }
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP 超时: ${method}`))
      }, 180_000)
    })
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails !== undefined) {
      throw new Error(`页面异常: ${r.exceptionDetails.text}`)
    }
    return r.result.value
  }
}

const strip = (s) => s.trim().replace(/;\s*$/, '')

async function api(path, init) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  const text = await res.text()
  try {
    return { status: res.status, json: JSON.parse(text) }
  } catch {
    return { status: res.status, text }
  }
}

async function main() {
  const bundle = readFileSync(join(SRC, 'lib', 'client.js'), 'utf8')
  const buildDeepSeekHook = extractFn(bundle, 'buildDeepSeekHook')
  const buildSendScript = extractFn(bundle, 'buildSendScript')
  const buildDrainScript = extractFn(bundle, 'buildDrainScript')
  const buildRestoreScript = extractFn(bundle, 'buildRestoreScript')

  // 从 host 拿平台配置（选择器）
  const status = await api('/status')
  if (status.json?.platforms === undefined) throw new Error('host 不是多平台版（缺 platforms 段）')
  const platform = status.json.platforms.find((p) => p.id === PLATFORM)
  if (platform === undefined) throw new Error(`host 没有平台 ${PLATFORM}`)

  // 从产物里拿 provider 定义。
  //
  // ⚠️ 不要在测试脚本里重新解析 bundle —— 那是在维护第二份解析器。
  // client 半的产物把 `BUILTIN_PROVIDERS` 暴露在模块作用域里，
  // 但它是 CJS bundle 取不到具名导出，所以这里**退一步**：
  // 只从 host 的 `/status` 拿平台元信息（已经有 models/contextWindow），
  // 选择器这类细节**由页面上的诊断脚本报告** —— 那才是权威来源。
  const providerMeta = platform
  console.log(`平台    : ${providerMeta.id}（${providerMeta.name}）`)
  console.log(`首页    : ${providerMeta.homeUrl}`)
  console.log(`模型    : ${providerMeta.models.map((m) => m.id).join(', ')}`)
  console.log(`上下文  : ${providerMeta.contextWindow}`)
  console.log(`快照    : ${SNAPSHOT}（${existsSync(SNAPSHOT) ? '存在' : '不存在'}）`)
  console.log('')

  /**
   * 平台的选择器。这里**手写一份最小集**而不是从 bundle 抠 ——
   * 抠 bundle 是在测试里复刻实现，测过了也不代表插件对。
   * 真正验证选择器是否有效的方式是：发出去、看有没有成功（下面的 stage 断言）。
   */
  const PLATFORM_HINTS = {
    deepseek: {
      inputSelectors: ['textarea[placeholder*="给 DeepSeek"]', 'textarea'],
      sendSelectors: ['button[type="submit"]', '[role="button"][aria-label*="发送"]'],
      signatures: [
        ['ds-button--primary', 60],
        ['ds-button--filled', 40],
        ['ds-button--circle', 50],
      ],
      vetoes: ['ds-toggle-button', 'ds-button--capsule'],
    },
    qwen: {
      inputSelectors: ['div[contenteditable="true"][class*="whitespace-pre-wrap"]', 'div[contenteditable="true"]'],
      sendSelectors: ['button[type="submit"]', 'button[aria-label*="发送"]'],
      signatures: [['rounded-full', 20]],
      vetoes: ['添加附件', '快速', '更多', 'AI生视频', 'PPT创作', 'AI生图'],
    },
  }
  const hints = PLATFORM_HINTS[PLATFORM]
  if (hints === undefined) throw new Error(`测试脚本没有 ${PLATFORM} 的选择器（请补 PLATFORM_HINTS）`)

  /** SSE 观察路径（按平台）。 */
  const COMPLETION_PATH = PLATFORM === 'qwen' ? '/api/v1/chat/completions' : '/api/v0/chat/completion'

  const browser = findBrowser()
  const port = 9300 + Math.floor(Math.random() * 200)
  const profile = mkdtempSync(join(tmpdir(), 'dsh-webin-e2e-'))

  const child = spawn(
    browser,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      'about:blank',
    ],
    { stdio: 'ignore', windowsHide: true },
  )

  let ws
  try {
    let target = null
    for (let i = 0; i < 60; i += 1) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
        target = list.find((t) => t.type === 'page')
        if (target) break
      } catch {
        /* 等 */
      }
      await sleep(250)
    }
    if (!target) throw new Error('CDP 端点没起来')
    ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true })
      ws.addEventListener('error', () => rej(new Error('WS 失败')), { once: true })
    })
    const cdp = new Cdp(ws)
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')

    // ---- 1) 打开平台首页 ----
    await cdp.send('Page.navigate', { url: providerMeta.homeUrl })
    for (let i = 0; i < 80; i += 1) {
      await sleep(250)
      if ((await cdp.eval('document.readyState').catch(() => '')) === 'complete') break
    }
    console.log('[1] 页面:', await cdp.eval('location.href'))

    // ---- 1b) 注入登录态快照并 reload ----
    // ⚠️ 必须做这一步，否则页面停在 sign_in，连输入框都没有（实测踩过）。
    // 这正是插件 buildRestoreScript 干的事 —— 这里复用同一份实现。
    if (existsSync(SNAPSHOT)) {
      const snapText = readFileSync(SNAPSHOT, 'utf8')
      const restored = await cdp.eval(strip(buildRestoreScript(snapText)))
      console.log('[1b] 登录态回写:', restored)
      await cdp.send('Page.reload')
      for (let i = 0; i < 80; i += 1) {
        await sleep(250)
        if ((await cdp.eval('document.readyState').catch(() => '')) === 'complete') break
      }
      // 等输入框渲染出来（SPA 需要时间）
      for (let i = 0; i < 60; i += 1) {
        const has = await cdp
          .eval(`document.querySelectorAll('textarea, div[contenteditable="true"]').length > 0`)
          .catch(() => false)
        if (has) break
        await sleep(250)
      }
      console.log('     页面:', await cdp.eval('location.href'))
    } else {
      console.log('[1b] 无快照，跳过登录态回写（页面可能停在登录页）')
    }

    // ---- 2) 注入 hook ----
    const hookR = await cdp.eval(strip(buildDeepSeekHook(COMPLETION_PATH, undefined)))
    console.log('[2] hook:', hookR)

    // ---- 3) 等任务 ----
    let job = null
    if (PROMPT !== undefined) {
      console.log(`[3] 自造任务（--prompt）: ${JSON.stringify(PROMPT)}`)
      job = { id: `e2e-${Date.now()}`, prompt: PROMPT, platform: PLATFORM }
    } else {
      console.log('[3] 等真实任务（agent 派活，最多 120s）…')
      const deadline = Date.now() + 120_000
      while (Date.now() < deadline) {
        const r = await api(`/job/next?platform=${PLATFORM}`)
        if (r.json?.job !== undefined && r.json.job !== null) {
          job = r.json.job
          break
        }
        await sleep(1500)
      }
      if (job === null) {
        console.log('    没等到任务 —— 请在 DSH 里把模型切到「LDW · DeepSeek 网页版」并发一条消息')
        return
      }
    }
    console.log(`    领到任务 ${job.id}（${job.prompt.length} 字符）`)

    // ---- 4) 用真实发送脚本发送 ----
    const sendR = await cdp.eval(
      `Promise.resolve(${strip(buildSendScript(job.prompt, 500, hints))}).then(r => r).catch(e => 'ERR:' + e.message)`,
    )
    const sent = JSON.parse(String(sendR))
    console.log(`[4] 发送: stage=${sent.stage} how=${sent.how}`)
    console.log(`    signals: ${JSON.stringify(sent.signals)}`)

    // ---- 5) 等 hook 抓回复 ----
    console.log('[5] 等回复（最多 150s）…')
    const dl2 = Date.now() + 150_000
    let done = null
    let streams = 0
    let lastLog = 0
    while (Date.now() < dl2) {
      const raw = String(await cdp.eval(strip(buildDrainScript())))
      if (raw !== '[]' && raw !== '') {
        for (const ev of JSON.parse(raw)) {
          if (ev.name === 'stream') {
            streams += 1
            console.log(
              `    stream#${streams} len=${String(ev.detail?.text ?? '').length} fin=${String(ev.detail?.finished)}`,
            )
          }
          if (ev.name === 'done') {
            done = ev.detail
            console.log(`    DONE status=${String(ev.detail?.status)} len=${String(ev.detail?.text ?? '').length}`)
          }
          if (ev.name === 'error') console.log('    页面错误事件:', JSON.stringify(ev.detail))
        }
      } else if (Date.now() - lastLog > 20_000) {
        // 每 20s 报一次活，避免看起来像卡死
        lastLog = Date.now()
        const st = await cdp.eval(`(() => ({
          reqs: window.__dshWebinHookInstalled___requests || 0,
          url: location.href,
          stop: !!document.querySelector('[class*="stop"], [aria-label*="停止"]')
        }))()`)
        console.log(`    …等待中 requests=${st.reqs} url=${String(st.url).slice(-40)}`)
      }
      if (done !== null) break
      await sleep(700)
    }
    if (done === null) {
      console.log('    ⚠️ 未收到 done —— 页面最终状态：')
      const st = await cdp.eval(`(() => ({
        reqs: window.__dshWebinHookInstalled___requests || 0,
        q: (window.__dshWebinHookInstalled___events || []).length,
        tail: document.body.innerText.slice(-200)
      }))()`)
      console.log('      requests:', st.reqs, '| 队列剩余:', st.q)
      console.log('      正文尾部:', JSON.stringify(String(st.tail).slice(-150)))
    }

    // ---- 6) 交回 host（若任务来自 host 队列）----
    if (done !== null && PROMPT === undefined) {
      await api(`/job/${job.id}/result`, {
        method: 'PUT',
        body: JSON.stringify({
          text: String(done.text ?? ''),
          think: String(done.think ?? ''),
          status: String(done.status ?? 'finished'),
        }),
      })
      console.log('[6] 结果已交回 host')
    }

    console.log('\n=== 端到端结论 ===')
    const checks = [
      ['hook 注入成功', hookR === 'installed' || hookR === 'already-installed'],
      ['发送被确认', sent.stage === 'sent'],
      ['收到 stream 增量', streams > 0],
      ['收到 done 事件', done !== null],
      ['done 带正文', done !== null && String(done.text ?? '').trim() !== ''],
    ]
    let ok = 0
    for (const [n, p] of checks) {
      console.log(`  ${p ? '✓' : '✗'} ${n}`)
      if (p) ok += 1
    }
    if (done !== null) {
      console.log(`\n  网页版回复（前 200 字）：`)
      console.log('  ' + String(done.text ?? '').slice(0, 200).replace(/\n/g, '\n  '))
    }
    console.log(`\n  ${ok}/${checks.length} 通过`)
    process.exitCode = ok === checks.length ? 0 : 1
  } finally {
    try { ws?.close() } catch { /* ignore */ }
    try { child.kill() } catch { /* ignore */ }
    await sleep(500)
    try { rmSync(profile, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

main().catch((e) => {
  console.error('失败:', e?.message ?? e)
  process.exitCode = 1
})
