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
 * **冷启动端到端验证** —— 复现并验证用户截图里的 `no-input` 报错已修复。
 *
 * ## 复现的场景
 *
 * 用户重启 DSH 后第一次发消息，报：
 *   `no-input: 找不到可见的输入框（页面结构可能已变，或还停在登录页）`
 *
 * ## 根因（两处）
 *
 * 1. `setReady(true)` 在**第一次 dom-ready（about:blank）**就置位 ——
 *    发送循环拿到 ready=true 立刻去领任务，而页面还没导航到目标域。
 * 2. `buildSendScript()` 只查一次输入框，查不到立刻报错 ——
 *    而 SPA 渲染有延迟，且宿主已经把任务消费掉了。
 *
 * ## 这个脚本验证什么
 *
 * 严格按客户端的**四阶段时序**跑，并断言每一步的状态：
 *   1. about:blank（不可写 storage）
 *   2. 导航到目标域（此时 restore 才有效）
 *   3. restore + reload
 *   4. 等输入框 → 注入 hook → 发送
 *
 * 关键在于**模拟「ready 置位时机」**：只有当阶段 4 确认输入框存在后，
 * 才允许发送。如果脚本能在阶段 4 之前就发出消息，说明修复没生效。
 */
import { spawn } from 'node:child_process'
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const SRC = dirname(dirname(fileURLToPath(import.meta.url)))
const DS_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const SNAPSHOT = join(DS_HOME, 'webin', 'auth', 'deepseek.json')
const PROMPT = process.argv[2] ?? '8+8=? 只回答数字'

const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
]
const findBrowser = () => {
  for (const b of BROWSERS) if (b !== '' && existsSync(b)) return b
  throw new Error('找不到 Chrome')
}

function extract(bundle, pattern, name) {
  const m = bundle.match(pattern)
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
  /**
   * 函数体可能引用模块级常量（如 `MARKER`）。
   * 把这些常量的声明一并带上，否则求值时报 "X is not defined"。
   */
  const before = bundle.slice(0, start)
  const seen = new Set()
  const consts = []
  for (const c of before.matchAll(/^[ \t]*const ([A-Z][A-Z0-9_]*)\s*=\s*([^;\n]+);/gm)) {
    if (seen.has(c[1])) continue
    seen.add(c[1])
    consts.push(`const ${c[1]} = ${c[2]};`)
  }

  const tryCompile = (end) => {
    const text = bundle.slice(start, end)
    const assign = text.match(/^(?:var|const|let)\s+(\w+)\s*=\s*(class\s*\{[\s\S]*)$/)
    const candidate = assign !== null ? `var ${assign[1]} = ${assign[2]};` : text
    const body = bundle.slice(start, end)
    const bodyConsts = new Set([...body.matchAll(/^[ \t]*const ([A-Z][A-Z0-9_]*)\s*=/gm)].map((x) => x[1]))
    const needed = consts.filter((line) => {
      const nm = /const ([A-Z][A-Z0-9_]*)/.exec(line)?.[1]
      return nm !== undefined && !bodyConsts.has(nm)
    })
    try {
      // eslint-disable-next-line no-new-func
      new Function(`${needed.join('\n')}\n${candidate}\n; return ${name};`)
      return `${needed.join('\n')}\n${candidate}`
    } catch {
      return undefined
    }
  }
  if (braceEnd > 0) {
    const ok = tryCompile(braceEnd)
    if (ok !== undefined) return ok
  }
  for (let end = braceEnd > 0 ? braceEnd : start + 400; end > start; end -= 1) {
    if (bundle[end - 1] !== '}') continue
    const ok = tryCompile(end)
    if (ok !== undefined) return ok
  }
  throw new Error(`无法提取 ${name}`)
}

/** 从产物里抠一个函数并求值（自动带上它依赖的模块级常量）。 */
function loadFn(bundle, pattern, name) {
  const src = extract(bundle, pattern, name)
  // eslint-disable-next-line no-new-func
  return new Function(`${src}\n; return ${name};`)()
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
    if (r.exceptionDetails !== undefined) throw new Error(`页面异常: ${r.exceptionDetails.text}`)
    return r.result.value
  }
}

const strip = (s) => s.trim().replace(/;\s*$/, '')

let pass = 0
let fail = 0
/**
 * ⚠️ 用普通函数 + `arguments.length`，不要用默认参数。
 * `expected = true` 会把显式传入的 `undefined` 也替换成 `true`，
 * 于是「断言某值等于 undefined」变成永远失败（或假通过）。
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

async function main() {
  const bundle = readFileSync(join(SRC, 'lib', 'client.js'), 'utf8')
  const buildRestoreScript = loadFn(bundle, /function buildRestoreScript\(/, 'buildRestoreScript')
  const buildDeepSeekHook = loadFn(bundle, /function buildDeepSeekHook\(/, 'buildDeepSeekHook')
  const buildSendScript = loadFn(bundle, /function buildSendScript\(/, 'buildSendScript')
  const buildDrainScript = loadFn(bundle, /function buildDrainScript\(/, 'buildDrainScript')

  const browser = findBrowser()
  const port = 9700 + Math.floor(Math.random() * 200)
  const profile = mkdtempSync(join(tmpdir(), 'dsh-webin-cold-'))
  const child = spawn(
    browser,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
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
    ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true })
      ws.addEventListener('error', () => rej(new Error('WS 失败')), { once: true })
    })
    const cdp = new Cdp(ws)
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')

    console.log('=== 冷启动全流程（模拟 DSH 重启后首次使用）===\n')

    // ---- 阶段 1：about:blank ----
    console.log('[阶段 1] about:blank（对应 documentCount===1）')
    const url1 = await cdp.eval('location.href')
    check('页面是 about:blank', url1, 'about:blank')
    // 此时若跑 restore，必须明确拒绝（旧实现在这里静默失败）
    const r1 = JSON.parse(
      String(await cdp.eval(`(() => { try { return ${strip(buildRestoreScript(readFileSync(SNAPSHOT, 'utf8')))} } catch (e) { return JSON.stringify({ ok:false, reason:'threw', message:String(e.message) }) } })()`)),
    )
    check('此阶段 restore 被拒绝（ok=false）', r1.ok, false)
    console.log(`       reason=${r1.reason} origin=${JSON.stringify(r1.origin)}`)

    // 关键断言：此时**不该**认为 ready
    const hasInputBlank = await cdp.eval(
      `document.querySelectorAll('textarea, div[contenteditable="true"]').length > 0`,
    )
    check('about:blank 上没有输入框（所以不该置 ready）', hasInputBlank, false)

    // ---- 阶段 2：导航到目标域 ----
    console.log('\n[阶段 2] 导航到目标域（对应 documentCount===2 的前半）')
    await cdp.send('Page.navigate', { url: 'https://chat.deepseek.com/' })
    for (let i = 0; i < 80; i += 1) {
      await sleep(250)
      if ((await cdp.eval('document.readyState').catch(() => '')) === 'complete') break
    }
    const url2 = await cdp.eval('location.href')
    check('已在目标域', String(url2).includes('chat.deepseek.com'))
    console.log(`       url=${url2}`)

    // ---- 阶段 3：restore + reload ----
    console.log('\n[阶段 3] 回写登录态 + reload（对应 documentCount===2 的后半）')
    const r3 = JSON.parse(String(await cdp.eval(strip(buildRestoreScript(readFileSync(SNAPSHOT, 'utf8'))))))
    check('restore ok=true', r3.ok, true)
    check('回读校验通过（verified>0）', r3.verified > 0)
    check('源正确', String(r3.origin).includes('chat.deepseek.com'))
    console.log(`       restored=${r3.restored} verified=${r3.verified} cookies=${r3.cookies}`)

    await cdp.send('Page.reload')
    for (let i = 0; i < 80; i += 1) {
      await sleep(250)
      if ((await cdp.eval('document.readyState').catch(() => '')) === 'complete') break
    }

    // ---- 阶段 4：等输入框（这是修 no-input 的关键）----
    console.log('\n[阶段 4] 等输入框就绪（对应 documentCount>=3）')
    const INPUT_SELECTORS = [
      'textarea[placeholder*="给 DeepSeek"]',
      'textarea[placeholder*="DeepSeek"]',
      'textarea[placeholder*="输入"]',
      'textarea',
      'div[contenteditable="true"]',
      '[role="textbox"]',
    ]
    let readyMs = -1
    const t0 = Date.now()
    for (let i = 0; i < 60; i += 1) {
      const has = await cdp.eval(`(function () {
        var sels = ${JSON.stringify(INPUT_SELECTORS)};
        for (var i = 0; i < sels.length; i++) {
          var list; try { list = document.querySelectorAll(sels[i]); } catch (e) { continue; }
          for (var j = 0; j < list.length; j++) {
            var el = list[j];
            if (el.offsetWidth > 0 && el.offsetHeight > 0) return true;
          }
        }
        return false;
      })()`)
      if (has === true) {
        readyMs = Date.now() - t0
        break
      }
      await sleep(250)
    }
    check('输入框最终出现', readyMs >= 0)
    console.log(`       耗时 ${readyMs}ms`)

    const url4 = await cdp.eval('location.href')
    check('已在已登录页面（非 sign_in）', !String(url4).includes('sign_in'))
    console.log(`       url=${url4}`)

    // ---- 阶段 5：注入 hook + 发送 ----
    console.log('\n[阶段 5] 注入 hook + 发送')
    const hookR = await cdp.eval(strip(buildDeepSeekHook('/api/v0/chat/completion', '/api/v0/chat/stop_stream')))
    check('hook 注入成功', hookR === 'installed' || hookR === 'already-installed')
    console.log(`       hook=${hookR}`)

    const hints = {
      inputSelectors: INPUT_SELECTORS,
      sendSelectors: ['button[type="submit"]', '[role="button"][aria-label*="发送"]'],
      signatures: [
        ['ds-button--primary', 60],
        ['ds-button--filled', 40],
        ['ds-button--circle', 50],
      ],
      vetoes: ['ds-toggle-button', 'ds-button--capsule'],
    }
    const sent = JSON.parse(
      String(await cdp.eval(`Promise.resolve(${strip(buildSendScript(PROMPT, 500, hints))}).then(r=>r)`)),
    )
    check('发送成功（stage=sent）', sent.stage, 'sent')
    check('requestSent 铁证', sent.signals?.requestSent, true)
    console.log(`       stage=${sent.stage} how=${sent.how} signals=${JSON.stringify(sent.signals)}`)

    console.log('\n[阶段 6] 等回复')
    let done = null
    let streams = 0
    let lastLog = 0
    const dl = Date.now() + 150_000
    while (Date.now() < dl) {
      const raw = String(await cdp.eval(strip(buildDrainScript())))
      if (raw !== '[]' && raw !== '') {
        for (const ev of JSON.parse(raw)) {
          if (ev.name === 'stream') streams += 1
          if (ev.name === 'done') done = ev.detail
        }
      }
      if (done !== null) break
      if (Date.now() - lastLog > 20_000) {
        lastLog = Date.now()
        const st = await cdp.eval(`(() => ({
          reqs: window.__dshWebinHookInstalled___requests || 0,
          url: location.href
        }))()`)
        console.log(`       …等待中 requests=${st.reqs} url=${String(st.url).slice(-40)}`)
      }
      await sleep(700)
    }
    check('收到 done 事件', done !== null)
    check('done 带正文', done !== null && String(done.text ?? '').trim() !== '')
    console.log(`       stream 事件数=${streams}`)
    if (done !== null) console.log(`       回复: ${JSON.stringify(String(done.text).slice(0, 60))}`)

    console.log(`\n=== 冷启动结论：${pass} 通过 / ${fail} 失败 ===`)
    process.exitCode = fail === 0 ? 0 : 1
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
