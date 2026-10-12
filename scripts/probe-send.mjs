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
 * 用真实浏览器验证 `chat.ts` 的发送脚本 —— **不真的发出去**。
 *
 * 做法：把 `buildSendScript()` 产出的脚本原样注入真实页面，
 * 但把「触发发送」那一步替换成只报告「选中了哪个元素」。
 * 这样能验证**候选收集 + 评分**是否正确，而不会真的消耗网页版额度、
 * 也不会在聊天记录里留下垃圾。
 *
 * 用法：
 *   node scripts/probe-send.mjs             # 用 ~/.dsh/webin/auth/default.json 的登录态
 *   node scripts/probe-send.mjs --dry-run   # 同上（默认就是 dry-run）
 *   node scripts/probe-send.mjs --live      # ⚠️ 真的发送一条 "ping"，会消耗额度
 */
import { spawn } from 'node:child_process'
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
const LIVE = args.includes('--live')

const DS_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const SNAPSHOT = join(DS_HOME, 'webin', 'auth', 'default.json')
const SRC = join(import.meta.dirname, '..')

const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
]

function findBrowser() {
  for (const b of BROWSERS) if (b !== '' && existsSync(b)) return b
  throw new Error('找不到 Chrome/Edge')
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
      }, 120_000)
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

async function main() {
  /**
   * 从**构建产物**里取出真实的 `buildSendScript` 源码，而不是在这里复刻一份。
   *
   * 为什么：复刻的评分逻辑会跟 `chat.ts` 漂移 —— 那样测过了也不代表插件是对的。
   * `lib/client.js` 是 CJS bundle，直接 import 拿不到具名导出，
   * 所以用正则把 `buildSendScript` 的函数体抠出来 eval 成可调用函数。
   */
  const bundle = readFileSync(join(SRC, 'lib', 'client.js'), 'utf8')
  const fnMatch = bundle.match(/function buildSendScript\(([^)]*)\)\s*\{/)
  if (fnMatch === null) throw new Error('在 lib/client.js 里找不到 buildSendScript —— 先跑 npm run build')
  // 从函数起点做花括号配对，取出完整函数体
  const start = fnMatch.index
  let depth = 0
  let end = -1
  for (let i = bundle.indexOf('{', start); i < bundle.length; i += 1) {
    if (bundle[i] === '{') depth += 1
    else if (bundle[i] === '}') {
      depth -= 1
      if (depth === 0) {
        end = i + 1
        break
      }
    }
  }
  if (end < 0) throw new Error('buildSendScript 函数体配对失败')
  const fnSource = bundle.slice(start, end)
  // eslint-disable-next-line no-new-func
  const buildSendScript = new Function(`${fnSource}; return buildSendScript;`)()
  console.log('已从产物加载 buildSendScript（真实实现，非复刻）')

  const browser = findBrowser()
  const port = 9800 + Math.floor(Math.random() * 150)
  const profile = mkdtempSync(join(tmpdir(), 'dsh-webin-send-'))
  console.log(`模式   : ${LIVE ? '⚠️ LIVE（真发送）' : 'dry-run（不发送）'}`)
  console.log(`浏览器 : ${browser}`)
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
    // 等输入框出现
    for (let i = 0; i < 80; i += 1) {
      if (await cdp.eval(`document.querySelectorAll('textarea').length > 0`).catch(() => false)) break
      await sleep(250)
    }
    console.log('页面:', await cdp.eval('location.href'))

    // ---- 真实产物 dry-run：跑 buildSendScript，但把点击拦下来 ----
    //
    // 做法：注入一段「先给 Element.prototype.click 打桩」的前导脚本，
    // 记录被点的元素而不真正触发。这样能验证**候选选择**是否正确，
    // 又不会真的发消息、不会弹文件选择框。
    console.log('\n[1] 真实 buildSendScript() dry-run（点击被拦截）')
    const script = buildSendScript('__dsh_webin_dry_run__', 0)
    const guarded = `(() => {
      window.__dsh_clicked = null;
      const orig = Element.prototype.click;
      Element.prototype.click = function () {
        window.__dsh_clicked = {
          tag: this.tagName,
          cls: (typeof this.className === 'string' ? this.className : '').slice(0, 90),
          text: (this.textContent || '').trim().slice(0, 20),
          aria: this.getAttribute('aria-label')
        };
        // 不调用 orig —— 拦截真实点击
      };
      return 'guarded';
    })()`
    await cdp.eval(guarded)
    /**
     * ⚠️ `buildSendScript()` 返回的字符串**以 `;` 结尾**（IIFE 语句），
     * 直接拼进 `Promise.resolve(...)` 会变成 `Promise.resolve(<iife>;)` —— 语法错误。
     * 所以要先去掉尾部空白与分号再包装。
     */
    const callable = script.trim().replace(/;\s*$/, '')
    const outcome = await cdp.eval(`Promise.resolve(${callable}).then(r => r).catch(e => 'ERR:' + e.message)`)
    const clicked = await cdp.eval('window.__dsh_clicked')
    const parsed = (() => {
      try {
        return JSON.parse(outcome)
      } catch {
        return { raw: String(outcome).slice(0, 400) }
      }
    })()

    console.log('    buildSendScript 结果:')
    console.log('      stage  :', parsed.stage)
    console.log('      ok     :', parsed.ok)
    console.log('      how    :', parsed.how)
    console.log('      message:', parsed.message)
    if (parsed.signals !== undefined) console.log('      signals:', JSON.stringify(parsed.signals))
    console.log('    被拦截的点击:', JSON.stringify(clicked))
    if (parsed.candidates !== undefined) {
      console.log('    候选清单（前 6）:')
      for (const c of parsed.candidates) console.log('      ' + JSON.stringify(c))
    }

    // 还原 click
    await cdp.eval(`(() => { delete window.__dsh_clicked; return 1; })()`)

    // ---- 2) 候选评分明细（独立复算，便于看分差）----
    console.log('\n[2] 候选评分明细')
    const scored = await cdp.eval(`(() => {
      const vis = (el) => { try { return el.offsetWidth > 0 && el.offsetHeight > 0; } catch (e) { return false; } };
      const dis = (el) => { try { return el.disabled === true || el.getAttribute('aria-disabled') === 'true'; } catch (e) { return true; } };
      const labelOf = (el) => {
        const p = [];
        try {
          if (el.getAttribute) {
            p.push(el.getAttribute('aria-label') || ''); p.push(el.getAttribute('title') || '');
            p.push(el.getAttribute('data-testid') || ''); p.push(el.getAttribute('data-action') || '');
            p.push(el.getAttribute('data-type') || ''); p.push(el.getAttribute('type') || '');
          }
          if (el.className && typeof el.className === 'string') p.push(el.className);
          const t = (el.textContent || '').trim(); if (t.length <= 24) p.push(t);
        } catch (e) {}
        return p.join(' ').toLowerCase();
      };
      const input = document.querySelector('textarea');
      if (!input) return { error: 'no textarea' };
      const out = [], seen = [];
      const push = (el, how, weight) => {
        if (!el || !vis(el) || dis(el)) return;
        for (const s of seen) if (s === el) return;
        seen.push(el);
        const cls = ((typeof el.className === 'string' ? el.className : '') + ' ' + labelOf(el));
        let sig = 0;
        if (/ds-button--primary/.test(cls)) sig += 60;
        if (/ds-button--filled/.test(cls)) sig += 40;
        if (/ds-button--circle/.test(cls)) sig += 50;
        if (/ds-toggle-button/.test(cls)) sig -= 120;
        if (/ds-button--capsule/.test(cls)) sig -= 70;
        if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') sig -= 200;
        const a = input.getBoundingClientRect(), b = el.getBoundingClientRect();
        let geo = 0;
        if (b.top < a.bottom && b.bottom > a.top) geo += 20;
        else if (b.top >= a.bottom - 4 && b.top < a.bottom + 80) geo += 15;
        if (b.left >= a.left + a.width * 0.5) geo += 15;
        geo -= Math.min(30, (Math.abs(b.left - (a.right - b.width)) + Math.abs(b.top - a.bottom)) / 40);
        out.push({ how, weight, sig, geo: Math.round(geo), score: Math.round(weight + sig + geo),
                   tag: el.tagName, cls: (typeof el.className === 'string' ? el.className : '').slice(0, 68),
                   text: (el.textContent || '').trim().slice(0, 18) });
      };
      let box = input;
      for (let k = 0; k < 6 && box; k++) {
        box = box.parentElement; if (!box) break;
        let near; try { near = box.querySelectorAll('button, [role="button"], [role="submit"], a[href="#"], div[tabindex]'); } catch (e) { break; }
        for (const el of near) push(el, 'near-input(L' + (k + 1) + ')', 40 - k * 5);
        if (out.length > 0 && k >= 2) break;
      }
      let svgHosts; try { svgHosts = document.querySelectorAll('button:has(svg), [role="button"]:has(svg), div:has(> svg)'); } catch (e) { svgHosts = []; }
      for (const el of svgHosts) push(el, 'svg-host', 10);
      out.sort((a, b) => b.score - a.score);
      return { top: out.slice(0, 8), total: out.length };
    })()`)

    if (scored.error) throw new Error(scored.error)
    console.log(`    候选总数: ${scored.total}`)
    for (const [i, c] of scored.top.entries()) {
      console.log(`    #${i + 1} score=${String(c.score).padStart(4)} (w=${c.weight} sig=${String(c.sig).padStart(4)} geo=${c.geo}) ${c.how}`)
      console.log(`        <${c.tag}> "${c.text}" cls=${c.cls}`)
    }

    // ---- 3) 填框测试 ----
    console.log('\n[3] 填框测试（原生 setter，不发送）')
    const fillResult = await cdp.eval(`(() => {
      const el = document.querySelector('textarea');
      if (!el) return { ok: false, why: 'no textarea' };
      el.focus();
      const desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
      const probe = '__dsh_webin_probe__';
      if (desc && desc.set) desc.set.call(el, probe); else el.value = probe;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      const readBack = el.value;
      if (desc && desc.set) desc.set.call(el, ''); else el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return { ok: readBack === probe, readBack, cleared: el.value === '' };
    })()`)
    console.log('    ' + JSON.stringify(fillResult))

    // ---- 4) hook 请求计数器是否可读 ----
    console.log('\n[4] hook 请求计数器')
    const reqCount = await cdp.eval(`(() => {
      const n = window.__dshWebinHookInstalled___requests;
      return { present: typeof n === 'number', value: typeof n === 'number' ? n : null,
               hookInstalled: !!window.__dshWebinHookInstalled__ };
    })()`)
    console.log('    ' + JSON.stringify(reqCount))
    console.log('    （dry-run 下 hook 未注入，present=false 属正常；面板运行时应为 true）')

    // ---- 5) LIVE 模式：真的发送 ----
    if (LIVE) {
      console.log('\n[5] ⚠️ LIVE：真的发送 "ping" …')
      const liveScript = buildSendScript('ping', 500).trim().replace(/;\s*$/, '')
      const liveResult = await cdp.eval(`Promise.resolve(${liveScript}).then(r => r).catch(e => 'ERR:' + e.message)`)
      console.log('    发送结果:', String(liveResult).slice(0, 600))
      await sleep(6000)
      const after = await cdp.eval(`(() => ({
        url: location.href,
        tail: document.body.innerText.slice(-300)
      }))()`)
      console.log('    6 秒后 URL:', after.url)
      console.log('    页面尾部:', after.tail.replace(/\\n+/g, ' | ').slice(0, 300))
    }

    console.log('\n=== 结论 ===')
    const top = scored.top[0]
    if (top === undefined) {
      console.log('  ✗ 没有任何候选 —— 发送必然失败')
    } else {
      const isSendKey = /ds-button--primary/.test(top.cls) && /circle/.test(top.cls)
      console.log(`  ${isSendKey ? '✓' : '✗'} 首选候选 score=${top.score} <${top.tag}> cls=${top.cls}`)
      console.log(`      分差（#1 − #2）= ${top.score - (scored.top[1]?.score ?? 0)}`)
    }
    console.log(`  ${parsed.stage === 'sent' ? '✓' : '✗'} buildSendScript stage=${parsed.stage}（dry-run 下点击被拦，sent 即"选中了正确的键"）`)
    console.log(`  ${fillResult.ok ? '✓' : '✗'} 填框（原生 setter）`)
    console.log(LIVE ? '\n（LIVE 模式：已真实发送）' : '\n（dry-run：未发送任何消息）')
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
