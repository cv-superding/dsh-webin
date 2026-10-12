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
 * 抓**原始 SSE 帧**，定位「DSH 只收到一个字」的根因。
 *
 * ## 现象
 *
 * 网页版里回复是完整的长文（`[小寒 ROUTE] 没收到具体目标…`），
 * 但 DSH 对话里只显示了开头两个字（`[小`）。
 *
 * ## 可能原因（本脚本逐条验证）
 *
 *   a) hook 的 `done` 提前触发 —— 比如 `eof` 早于真正结束
 *   b) 页面**发了多个 completion 请求**（智能搜索/深度思考会），
 *      第一个结束的请求带着不完整文本先触发 done，被 client 当成结果交回
 *   c) 快照帧（`{v:{response:{fragments}}}`）**覆盖**了已累积的正文，把文本截断
 *   d) `response/fragments/-1/content` 这种路径没被 classify 识别
 *
 * 脚本做两件事：
 *   1. 装一个**独立**的帧记录器（不依赖插件的 hook），把每一帧原样存下来
 *   2. 同时装插件的 hook，对比「原始帧」与「hook 提取结果」
 *
 * 用法：node scripts/probe-frames.mjs [prompt]
 */
import { spawn } from 'node:child_process'
import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const SRC = dirname(dirname(fileURLToPath(import.meta.url)))
const DS_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const SNAPSHOT = join(DS_HOME, 'webin', 'auth', 'deepseek.json')
const PROMPT = process.argv[2] ?? '请写一段 200 字左右的说明，介绍浏览器是怎么渲染网页的。'

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
  const before = bundle.slice(0, start)
  const consts = []
  const seen = new Set()
  for (const c of before.matchAll(/^[ \t]*const ([A-Z][A-Z0-9_]*)\s*=\s*([^;\n]+);/gm)) {
    if (seen.has(c[1])) continue
    seen.add(c[1])
    consts.push(`const ${c[1]} = ${c[2]};`)
  }
  const body = bundle.slice(start, braceEnd)
  const bodyConsts = new Set([...body.matchAll(/^[ \t]*const ([A-Z][A-Z0-9_]*)\s*=/gm)].map((x) => x[1]))
  const needed = consts.filter((l) => {
    const nm = /const ([A-Z][A-Z0-9_]*)/.exec(l)?.[1]
    return nm !== undefined && !bodyConsts.has(nm)
  })
  return `${needed.join('\n')}\n${body}`
}
const load = (b, pat, nm) => {
  // eslint-disable-next-line no-new-func
  return new Function(`${extract(b, pat, nm)}; return ${nm};`)()
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
  const buildRestoreScript = load(bundle, /function buildRestoreScript\(/, 'buildRestoreScript')
  const buildDeepSeekHook = load(bundle, /function buildDeepSeekHook\(/, 'buildDeepSeekHook')
  const buildSendScript = load(bundle, /function buildSendScript\(/, 'buildSendScript')
  const buildDrainScript = load(bundle, /function buildDrainScript\(/, 'buildDrainScript')

  const browser = findBrowser()
  const port = 9200 + Math.floor(Math.random() * 90)
  const profile = mkdtempSync(join(tmpdir(), 'dsh-webin-frames-'))
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

    await cdp.send('Page.navigate', { url: 'https://chat.deepseek.com/' })
    for (let i = 0; i < 80; i += 1) {
      await sleep(250)
      if ((await cdp.eval('document.readyState').catch(() => '')) === 'complete') break
    }
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
    console.log('页面:', await cdp.eval('location.href'))

    /**
     * ---- 独立帧记录器 ----
     *
     * 在插件 hook **之前**装（这样能看到原始帧），只记录不改行为。
     * 记录：每个 completion 请求的 id、每帧的 p/o/v 摘要、以及请求结束时刻。
     */
    await cdp.eval(`(function () {
      if (window.__framesProbe) return 'already';
      window.__framesProbe = true;
      window.__frames = [];
      var O = window.XMLHttpRequest;
      var oOpen = O.prototype.open, oSend = O.prototype.send;
      var meta = new WeakMap();
      O.prototype.open = function (m, u) { try { meta.set(this, { m: m, u: u }); } catch (e) {} return oOpen.apply(this, arguments); };
      O.prototype.send = function () {
        var me = meta.get(this);
        if (!me || String(me.m).toUpperCase() !== 'POST' || String(me.u).indexOf('/api/v0/chat/completion') === -1) {
          return oSend.apply(this, arguments);
        }
        window.__frames.push({ t: Date.now(), req: 1, kind: 'request-start' });
        var self = this, last = 0, n = 0;
        this.addEventListener('readystatechange', function () {
          if (self.readyState !== 3 && self.readyState !== 4) return;
          var raw; try { raw = self.responseText; } catch (e) { return; }
          if (typeof raw !== 'string' || raw.length <= last) return;
          var chunk = raw.slice(last); last = raw.length;
          var lines = chunk.split(/\\r?\\n/);
          for (var i = 0; i < lines.length; i++) {
            var L = lines[i].trim();
            if (!L || L.indexOf('data:') !== 0) continue;
            var pl = L.slice(5).trim();
            if (pl === '[DONE]') { window.__frames.push({ t: Date.now(), req: 1, kind: 'DONE-marker' }); continue; }
            var o = null; try { o = JSON.parse(pl); } catch (e) { continue; }
            n++;
            window.__frames.push({
              t: Date.now(), req: 1, kind: 'frame', seq: n,
              p: o.p, o: o.o,
              vType: Array.isArray(o.v) ? 'array' : typeof o.v,
              vBrief: Array.isArray(o.v)
                ? o.v.map(function (x) { return x && x.type ? (x.type + ':' + String(x.content || x.text || '').slice(0, 30)) : '?'; }).join('|')
                : String(o.v === undefined ? '' : o.v).slice(0, 60)
            });
          }
          if (self.readyState === 4) window.__frames.push({ t: Date.now(), req: 1, kind: 'eof' });
        });
        return oSend.apply(this, arguments);
      };
      return 'installed';
    })()`)
    console.log('独立帧记录器(XHR): 已装')

    // 装插件 hook
    const hookR = await cdp.eval(strip(buildDeepSeekHook('/api/v0/chat/completion', '/api/v0/chat/stop_stream')))
    console.log('插件 hook:', hookR)

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
    const sent = JSON.parse(
      String(await cdp.eval(`Promise.resolve(${strip(buildSendScript(PROMPT, 400, hints))}).then(r=>r)`)),
    )
    console.log('发送:', sent.stage, JSON.stringify(sent.signals))

    // 轮询 drain，记录每次拿到的 done
    console.log('\n=== 事件流（每 600ms）===')
    const dones = []
    const streams = []
    const deadline = Date.now() + 150_000
    while (Date.now() < deadline) {
      const raw = String(await cdp.eval(strip(buildDrainScript())))
      if (raw !== '[]' && raw !== '') {
        for (const ev of JSON.parse(raw)) {
          if (ev.name === 'stream') {
            streams.push(ev.detail)
            console.log(`  [stream] len=${String(ev.detail?.text ?? '').length} fin=${ev.detail?.finished}`)
          }
          if (ev.name === 'done') {
            dones.push(ev.detail)
            console.log(
              `  [DONE] status=${ev.detail?.status} len=${String(ev.detail?.text ?? '').length} ` +
                `text=${JSON.stringify(String(ev.detail?.text ?? '').slice(0, 60))}`,
            )
          }
          if (ev.name === 'error') console.log(`  [error] ${JSON.stringify(ev.detail)}`)
        }
      }
      // 连续 8 秒没有新事件就停
      if (dones.length > 0 && streams.length > 0) {
        const last = streams[streams.length - 1]
        if (last?.finished === true) break
      }
      await sleep(600)
    }

    // 收集原始帧
    const frames = await cdp.eval('JSON.stringify(window.__frames || [])')
    const parsed = JSON.parse(String(frames))
    const outPath = join(SRC, '.probe', 'frames.json')
    try {
      writeFileSync(outPath, JSON.stringify(parsed, null, 2), 'utf8')
      console.log(`\n原始帧已存: ${outPath}（${parsed.length} 条）`)
    } catch {
      /* ignore */
    }

    console.log('\n=== 原始帧统计 ===')
    const byReq = new Map()
    for (const f of parsed) {
      if (!byReq.has(f.req)) byReq.set(f.req, { frames: 0, eof: 0, starts: 0, doneMarker: 0 })
      const s = byReq.get(f.req)
      if (f.kind === 'frame') s.frames += 1
      if (f.kind === 'eof') s.eof += 1
      if (f.kind === 'request-start') s.starts += 1
      if (f.kind === 'DONE-marker') s.doneMarker += 1
    }
    for (const [req, s] of byReq) {
      console.log(`  请求 #${req}: frames=${s.frames} eof=${s.eof} DONE=${s.doneMarker}`)
    }
    console.log(`  completion 请求总数: ${byReq.size}`)

    console.log('\n=== 关键帧（p / o / v 摘要，前 40 条）===')
    parsed
      .filter((f) => f.kind === 'frame')
      .slice(0, 40)
      .forEach((f) => console.log(`  #${f.req} p=${f.p} o=${f.o} v[${f.vType}]=${f.vBrief}`))

    console.log('\n=== 结论 ===')
    console.log(`  收到的 done 事件数: ${dones.length}`)
    for (const [i, d] of dones.entries()) {
      console.log(`    done#${i}: len=${String(d?.text ?? '').length} status=${d?.status}`)
    }
    const finalLen = String(dones[dones.length - 1]?.text ?? '').length
    console.log(`  最后一个 done 的正文长度: ${finalLen}`)
    console.log(`  completion 请求数: ${byReq.size}${byReq.size > 1 ? '  ← ⚠️ 多个请求，可能第一个先触发 done' : ''}`)
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
