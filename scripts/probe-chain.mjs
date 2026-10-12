#!/usr/bin/env node
/**
 * dsh-webin **全链路**真实验证：注入 hook → 发送 → 抓回复。
 *
 * 这是插件核心价值（"把网页版当模型用"）的端到端证明：
 *   1. 注入真实 `buildDeepSeekHook()`（与面板同一条路径）
 *   2. 用真实 `buildSendScript()` 发一条消息
 *   3. 轮询 `buildDrainScript()` 取 hook 累积的事件
 *   4. 断言拿到了 `done` 事件且带正文
 *
 * 与 `probe-send.mjs` 的区别：那个只验证"发得出去"，这个验证"**收得回来**"。
 *
 * ⚠️ 会真的消耗一次网页版额度（��一条极短的 prompt）。
 *
 * 用法：
 *   node scripts/probe-chain.mjs              # 默认发 "1+1=?" 
 *   node scripts/probe-chain.mjs "你的问题"    # 自定义
 *   node scripts/probe-chain.mjs --no-send    # 只注入 hook，不发送（看 hook 是否装上）
 */
import { spawn } from 'node:child_process'
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'

const argv = process.argv.slice(2)
const NO_SEND = argv.includes('--no-send')
const PROMPT = argv.find((a) => !a.startsWith('--')) ?? '1+1=? 只回答数字'

const DS_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const SNAPSHOT = join(DS_HOME, 'webin', 'auth', 'default.json')
const SRC = join(import.meta.dirname, '..')

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

/**
 * 从 CJS bundle 里抠出一个具名函数并实例化。
 *
 * ⚠️ 这些函数体引用了模块级常量（MARKER、EVENT_QUEUE_KEY、COMPLETION_PATH …），
 * 单独抠函数体会报 "X is not defined"。所以要把**常量声明**也一起带上。
 *
 * ⚠️ 边界不能只靠花括号配对：函数体里含**字符串**（注入页面的 JS 源码），
 * 字符串里的 `{` / `}` 会让配对跑飞（`buildProbeScript` 会一路吃到模块末尾）。
 * 所以改成「配对 + 下一个顶层 `function`/`const` 声明」取较近者。
 */
function extractFn(bundle, name) {
  const m = bundle.match(new RegExp(`function ${name}\\(([^)]*)\\)\\s*\\{`))
  if (m === null) throw new Error(`产物里找不到 ${name} —— 先跑 npm run build`)
  const start = m.index
  const openBrace = bundle.indexOf('{', start)

  // 上界 1：花括号配对
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

  // 上界 2：下一个顶层声明（缩进一级的 function / const / exports.）
  const rest = bundle.slice(openBrace)
  const nextDecl = rest.search(/\n\t\t(?:function |const |exports\.)/)
  const declEnd = nextDecl < 0 ? bundle.length : openBrace + nextDecl

  const end = braceEnd > 0 && braceEnd <= declEnd ? braceEnd : declEnd
  if (end <= openBrace) throw new Error(`${name} 边界判定失败`)

  /**
   * 只取**函数定义之前**声明的常量：函数用到的常量按定义顺序必然在它之前。
   */
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
  const needed = consts.filter((line) => {
    const nm = /const ([A-Z][A-Z0-9_]*)/.exec(line)?.[1]
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
      throw new Error(`页面异常: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`)
    }
    return r.result.value
  }
}

const strip = (s) => s.trim().replace(/;\s*$/, '')

async function main() {
  const bundle = readFileSync(join(SRC, 'lib', 'client.js'), 'utf8')
  const buildDeepSeekHook = extractFn(bundle, 'buildDeepSeekHook')
  const buildSendScript = extractFn(bundle, 'buildSendScript')
  const buildDrainScript = extractFn(bundle, 'buildDrainScript')
  const buildProbeScript = extractFn(bundle, 'buildProbeScript')
  console.log('已从产物加载：buildDeepSeekHook / buildSendScript / buildDrainScript / buildProbeScript')

  const browser = findBrowser()
  const port = 9200 + Math.floor(Math.random() * 300)
  const profile = mkdtempSync(join(tmpdir(), 'dsh-webin-chain-'))
  console.log(`prompt : ${NO_SEND ? '(不发送)' : JSON.stringify(PROMPT)}`)
  console.log('')

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

    await cdp.send('Page.navigate', { url: 'https://chat.deepseek.com/' })
    for (let i = 0; i < 80; i += 1) {
      await sleep(250)
      if ((await cdp.eval('document.readyState').catch(() => '')) === 'complete') break
    }

    if (existsSync(SNAPSHOT)) {
      const snap = JSON.parse(readFileSync(SNAPSHOT, 'utf8'))
      await cdp.eval(`(() => { const d = ${JSON.stringify(snap.localStorage ?? {})};
        for (const [k, v] of Object.entries(d)) { try { localStorage.setItem(k, v); } catch (e) {} } return 1; })()`)
      await cdp.send('Page.reload')
      for (let i = 0; i < 80; i += 1) {
        await sleep(250)
        if ((await cdp.eval('document.readyState').catch(() => '')) === 'complete') break
      }
    }
    for (let i = 0; i < 80; i += 1) {
      if (await cdp.eval(`document.querySelectorAll('textarea').length > 0`).catch(() => false)) break
      await sleep(250)
    }
    console.log('[1] 页面:', await cdp.eval('location.href'))

    // ---- 注入 hook（与面板同一条路径）----
    const hookResult = await cdp.eval(strip(buildDeepSeekHook()))
    console.log('[2] hook 注入:', hookResult)

    const probe = JSON.parse(String(await cdp.eval(strip(buildProbeScript()))))
    console.log('[3] 探针:', JSON.stringify({ loggedIn: probe.loggedIn, hasUserId: probe.hasUserId, url: probe.url }))

    if (NO_SEND) {
      console.log('\n（--no-send：到此为止）')
      return
    }

    // ---- 发送 ----
    console.log(`\n[4] 发送 ${JSON.stringify(PROMPT)} …`)
    const sendOutcome = await cdp.eval(
      `Promise.resolve(${strip(buildSendScript(PROMPT, 500))}).then(r => r).catch(e => 'ERR:' + e.message)`,
    )
    const parsedSend = (() => {
      try {
        return JSON.parse(sendOutcome)
      } catch {
        return { raw: String(sendOutcome).slice(0, 300) }
      }
    })()
    console.log('    stage:', parsedSend.stage, '| how:', parsedSend.how)
    console.log('    signals:', JSON.stringify(parsedSend.signals))

    // ---- 轮询 drain，等 done 事件 ----
    console.log('\n[5] 轮询 drain 等回复（最多 90s）…')
    const deadline = Date.now() + 90_000
    let done = null
    let streamCount = 0
    let sawRequest = false
    while (Date.now() < deadline) {
      const raw = String(await cdp.eval(strip(buildDrainScript())))
      if (raw !== '[]' && raw !== '') {
        const events = JSON.parse(raw)
        for (const ev of events) {
          if (ev.name === 'stream') streamCount += 1
          if (ev.name === 'done') done = ev.detail
          if (ev.name === 'error') console.log('    页面报错事件:', JSON.stringify(ev.detail))
        }
      }
      const reqN = await cdp.eval(`(() => { const n = window.__dshWebinHookInstalled___requests; return typeof n === 'number' ? n : 0; })()`)
      if (reqN > 0 && !sawRequest) {
        sawRequest = true
        console.log(`    ✓ hook 捕获到 completion 请求（计数 ${reqN}）`)
      }
      if (done !== null) break
      await sleep(700)
    }

    console.log(`\n[6] 结果`)
    console.log(`    completion 请求被捕获: ${sawRequest}`)
    console.log(`    stream 事件数        : ${streamCount}`)

    console.log('\n=== 全链路结论 ===')
    const checks = [
      ['hook 注入成功', hookResult === 'installed' || hookResult === 'already-installed'],
      ['发送被确认', parsedSend.stage === 'sent'],
      ['hook 捕获到 completion 请求', sawRequest],
      ['收到 stream 增量', streamCount > 0],
      ['收到 done 事件', done !== null],
      ['done 带正文', done !== null && String(done.text ?? '').trim().length > 0],
    ]
    let ok = 0
    for (const [name, pass] of checks) {
      console.log(`  ${pass ? '✓' : '✗'} ${name}`)
      if (pass) ok += 1
    }
    if (done !== null) {
      console.log(`\n  抓到的回复（前 300 字）：`)
      console.log('  ' + String(done.text ?? '').slice(0, 300).replace(/\n/g, '\n  '))
      if (String(done.think ?? '').trim() !== '') {
        console.log(`\n  思考内容（前 200 字）：`)
        console.log('  ' + String(done.think).slice(0, 200).replace(/\n/g, '\n  '))
      }
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
