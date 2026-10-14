#!/usr/bin/env node

/**
 * ✅ **已适配三段式发送（2026-10-13 重构）**
 *
 * 原先的 `buildSendScript()` 已删除 —— 它把「填充 → 等 2.4s → 校验 → 重试」
 * 全塞进一次 executeJavaScript，是跨进程调用，页面一导航就整体死掉（宿主永远等）。
 *
 * 现在按真实链路走三段（见 `src/client/chat.ts`）：
 *   - `buildFillScript`    只填输入框
 *   - 客户端 `setTimeout`  延迟
 *   - `buildTriggerScript` 只点发送
 *
 * ⚠️ 本脚本需要**真浏览器 + 联网 + 已登录**，不在 `npm run check` 链里，
 * 属手动诊断工具。
 */

/**
 * 诊断 `done` 事件为什么没派发。
 *
 * `verify-e2e` 观测到：发送成功、`stream` 增量收到了，但 `done` 始终不来。
 * 可能原因：
 *   a) 回复还没结束（120s 不够 / 网页版在长思考）
 *   b) 提取器判不出 `FINISHED` 状态帧
 *   c) fetch 分支的 `reader` 没读到 EOF（页面用了 XHR 而非 fetch，或流被复用）
 *
 * 这个脚本发一条极短的 prompt，然后**持续 dump 事件队列 + 页面状态**，
 * 看 `stream` 的 `finished` 字段和最后一条 stream 的内容。
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
const PROMPT = process.argv[2] ?? '1+1=? 只回答数字'

const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
]
const findBrowser = () => {
  for (const b of BROWSERS) if (b !== '' && existsSync(b)) return b
  throw new Error('找不到 Chrome')
}

function extractFn(bundle, name) {
  const m = bundle.match(new RegExp(`function ${name}\\(([^)]*)\\)\\s*\\{`))
  if (m === null) throw new Error(`找不到 ${name}`)
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
    if (r.exceptionDetails !== undefined) throw new Error(`页面异常: ${r.exceptionDetails.text}`)
    return r.result.value
  }
}

const strip = (s) => s.trim().replace(/;\s*$/, '')

async function main() {
  const bundle = readFileSync(join(SRC, 'lib', 'client.js'), 'utf8')
  const buildDeepSeekHook = extractFn(bundle, 'buildDeepSeekHook')
  const buildFillScript = extractFn(bundle, 'buildFillScript')
  const buildTriggerScript = extractFn(bundle, 'buildTriggerScript')
  const buildDrainScript = extractFn(bundle, 'buildDrainScript')
  const buildRestoreScript = extractFn(bundle, 'buildRestoreScript')

  const browser = findBrowser()
  const port = 9400 + Math.floor(Math.random() * 200)
  const profile = mkdtempSync(join(tmpdir(), 'dsh-webin-diag-'))
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
      await cdp.eval(strip(buildRestoreScript(readFileSync(SNAPSHOT, 'utf8'))))
      await cdp.send('Page.reload')
      for (let i = 0; i < 80; i += 1) {
        await sleep(250)
        if ((await cdp.eval('document.readyState').catch(() => '')) === 'complete') break
      }
      for (let i = 0; i < 60; i += 1) {
        if (await cdp.eval(`document.querySelectorAll('textarea').length > 0`).catch(() => false)) break
        await sleep(250)
      }
    }

    await cdp.eval(strip(buildDeepSeekHook('/api/v0/chat/completion', '/api/v0/chat/stop_stream')))
    console.log('hook 已装；发送:', JSON.stringify(PROMPT))

    const hints = {
      inputSelectors: ['textarea[placeholder*="给 DeepSeek"]', 'textarea'],
      sendSelectors: ['button[type="submit"]', '[role="button"][aria-label*="发送"]'],
      signatures: [
        ['ds-button--primary', 60],
        ['ds-button--filled', 40],
        ['ds-button--circle', 50],
      ],
      vetoes: ['ds-toggle-button', 'ds-button--capsule'],
    }
    /** 三段式：填充 → 延迟 → 触发（旧 buildSendScript 已删除，见文件头）。 */
    const fillR = JSON.parse(
      String(await cdp.eval(`Promise.resolve(${strip(buildFillScript(PROMPT, hints))}).then(r=>r)`)),
    )
    console.log('填充结果:', fillR.stage, fillR.how)
    await sleep(500)
    const sendR = JSON.parse(
      String(await cdp.eval(`Promise.resolve(${strip(buildTriggerScript(hints, PROMPT))}).then(r=>r)`)),
    )
    console.log('触发结果: ok=' + sendR.ok, sendR.how, 'confirmed=' + sendR.confirmed)

    // 每 2 秒 dump 一次，持续 60 秒
    console.log('\n时间    | 事件队列摘要')
    let sawDone = false
    for (let i = 0; i < 30; i += 1) {
      await sleep(2000)
      const raw = String(await cdp.eval(strip(buildDrainScript())))
      const t = new Date().toLocaleTimeString('zh-CN', { hour12: false })
      if (raw === '[]' || raw === '') {
        console.log(`${t} | （空）`)
        continue
      }
      const evs = JSON.parse(raw)
      const summary = evs
        .map((e) => {
          if (e.name === 'stream') {
            const d = e.detail
            return `stream(len=${String(d.text ?? '').length},fin=${d.finished},think=${String(d.think ?? '').length})`
          }
          if (e.name === 'done') {
            sawDone = true
            return `DONE(len=${String(e.detail?.text ?? '').length},status=${e.detail?.status})`
          }
          if (e.name === 'error') return `ERROR(${e.detail?.message})`
          return e.name
        })
        .join(' ')
      console.log(`${t} | ${summary}`)
      if (sawDone) break
    }

    // 页面最终状态
    const finalState = await cdp.eval(`(() => {
      const q = window.__dshWebinHookInstalled___events || [];
      const reqs = window.__dshWebinHookInstalled___requests;
      return {
        requests: typeof reqs === 'number' ? reqs : 0,
        queueLen: q.length,
        url: location.href,
        tail: document.body.innerText.slice(-200)
      };
    })()`)
    console.log('\n=== 页面最终状态 ===')
    console.log('  completion 请求数:', finalState.requests)
    console.log('  队列剩余事件   :', finalState.queueLen)
    console.log('  URL            :', finalState.url)
    console.log('  正文尾部       :', JSON.stringify(String(finalState.tail).slice(-160)))
    console.log(`\n  done 事件: ${sawDone ? '✓ 收到' : '✗ 未收到'}`)
    process.exitCode = sawDone ? 0 : 1
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
