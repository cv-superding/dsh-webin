#!/usr/bin/env node
/**
 * 用真实 Chrome/Edge + CDP 验证 dsh-webin 的页面选择器。
 *
 * 为什么需要：发送脚本（`src/client/chat.ts`）靠选择器找输入框和发送按钮。
 * DeepSeek 前端是压缩过的 SPA，class 名会变；靠读 minified bundle 猜不可靠。
 * 这里起一个真的 Chromium，加载真页面，把**真实 DOM** dump 出来，
 * 再拿 `chat.ts` 里同一套选择器去匹配 —— 匹配不上就当场发现。
 *
 * 用法：
 *   node scripts/probe-dom.mjs                 # 用已保存的登录态（~/.dsh/webin/auth/default.json）
 *   node scripts/probe-dom.mjs --no-session    # 不注入登录态，看登录页结构
 *   node scripts/probe-dom.mjs --headful       # 开有头窗口（肉眼确认）
 *
 * 只读：不发送任何消息，不修改页面状态。
 */
import { spawn } from 'node:child_process'
import { readFileSync, existsSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'

const args = process.argv.slice(2)
const useSession = !args.includes('--no-session')
const headful = args.includes('--headful')

/**
 * 目标站点。默认 DeepSeek；加 `--url <地址>` 可校准任意平台：
 *   node scripts/probe-dom.mjs --url https://www.tongyi.com/qianwen/
 * 这是**加新平台的第一步** —— 拿真实 DOM 去填 Provider 的选择器。
 */
const urlArgIndex = args.indexOf('--url')
const TARGET_URL =
  urlArgIndex >= 0 && args[urlArgIndex + 1] !== undefined ? args[urlArgIndex + 1] : 'https://chat.deepseek.com/'

/** 登录态槽位（按平台分槽）；`--slot <id>` 指定，默认 default。 */
const slotArgIndex = args.indexOf('--slot')
const SLOT = slotArgIndex >= 0 && args[slotArgIndex + 1] !== undefined ? args[slotArgIndex + 1] : 'default'

const DS_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const SNAPSHOT = join(DS_HOME, 'webin', 'auth', `${SLOT}.json`)

const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
]

function findBrowser() {
  for (const b of BROWSERS) if (b !== '' && existsSync(b)) return b
  throw new Error('找不到 Chrome/Edge')
}

/** 极简 CDP 客户端（Node 24 内置 WebSocket）。 */
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
      }, 60_000)
    })
  }

  /** 在页面里跑一段表达式，返回其值。 */
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (r.exceptionDetails !== undefined) {
      throw new Error(`页面异常: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`)
    }
    return r.result.value
  }
}

async function main() {
  const browser = findBrowser()
  const port = 9500 + Math.floor(Math.random() * 400)
  const profile = mkdtempSync(join(tmpdir(), 'dsh-webin-probe-'))

  console.log(`浏览器 : ${browser}`)
  console.log(`调试端口: ${port}`)
  console.log(`临时配置: ${profile}`)
  console.log(`登录态 : ${useSession && existsSync(SNAPSHOT) ? SNAPSHOT : '（不使用）'}`)
  console.log('')

  const child = spawn(
    browser,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      ...(headful ? [] : ['--headless=new']),
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      'about:blank',
    ],
    { stdio: 'ignore', windowsHide: true },
  )

  let ws
  try {
    // 等 CDP 端点就绪
    let target = null
    for (let i = 0; i < 60; i += 1) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/list`)
        const list = await res.json()
        target = list.find((t) => t.type === 'page')
        if (target !== null && target !== undefined) break
      } catch {
        /* 还没起来 */
      }
      await sleep(250)
    }
    if (target === null || target === undefined) throw new Error('CDP 端点没起来')

    ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')), { once: true })
    })
    const cdp = new Cdp(ws)
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')

    // ---- 1) 先到目标域，才能写 localStorage ----
    console.log(`[1] 打开 ${TARGET_URL} …`)
    await cdp.send('Page.navigate', { url: TARGET_URL })
    for (let i = 0; i < 80; i += 1) {
      await sleep(250)
      const ready = await cdp.eval('document.readyState').catch(() => '')
      if (ready === 'complete') break
    }
    console.log('    readyState:', await cdp.eval('document.readyState'))
    console.log('    url       :', await cdp.eval('location.href'))

    // ---- 2) 注入登录态并 reload ----
    if (useSession && existsSync(SNAPSHOT)) {
      const snap = JSON.parse(readFileSync(SNAPSHOT, 'utf8'))
      const entries = Object.entries(snap.localStorage ?? {})
      console.log(`\n[2] 注入登录态（${entries.length} 个 localStorage 键）并重载 …`)
      await cdp.eval(`(() => {
        const data = ${JSON.stringify(snap.localStorage ?? {})};
        for (const [k, v] of Object.entries(data)) { try { localStorage.setItem(k, v); } catch (e) {} }
        return Object.keys(data).length;
      })()`)
      await cdp.send('Page.reload', { ignoreCache: false })
      for (let i = 0; i < 80; i += 1) {
        await sleep(250)
        const ready = await cdp.eval('document.readyState').catch(() => '')
        if (ready === 'complete') break
      }
      // 等 SPA 渲染出输入框（最多 20s）
      for (let i = 0; i < 80; i += 1) {
        const has = await cdp.eval(`document.querySelectorAll('textarea').length > 0`).catch(() => false)
        if (has) break
        await sleep(250)
      }
      console.log('    url       :', await cdp.eval('location.href'))
    }

    // ---- 3) dump 真实 DOM ----
    console.log('\n[3] 页面结构 dump')
    const dump = await cdp.eval(`(() => {
      const vis = (el) => { try { return el.offsetWidth > 0 && el.offsetHeight > 0; } catch (e) { return false; } };
      const desc = (el) => {
        const o = { tag: el.tagName };
        try {
          o.id = el.id || null;
          o.cls = (typeof el.className === 'string' ? el.className : '').slice(0, 90);
          o.role = el.getAttribute('role');
          o.aria = el.getAttribute('aria-label');
          o.title = el.getAttribute('title');
          o.testid = el.getAttribute('data-testid');
          o.type = el.getAttribute('type');
          o.placeholder = el.getAttribute('placeholder');
          o.disabled = el.disabled === true || el.getAttribute('aria-disabled') === 'true';
          o.visible = vis(el);
          const r = el.getBoundingClientRect();
          o.rect = [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
          o.text = (el.textContent || '').trim().slice(0, 30);
        } catch (e) {}
        return o;
      };
      const out = { url: location.href, title: document.title, inputs: [], buttons: [], svgHosts: [] };
      try {
        document.querySelectorAll('textarea').forEach((e) => out.inputs.push(desc(e)));
        document.querySelectorAll('div[contenteditable="true"], [role="textbox"]').forEach((e) => out.inputs.push(desc(e)));
        document.querySelectorAll('button, [role="button"]').forEach((e) => { if (vis(e)) out.buttons.push(desc(e)); });
        try { document.querySelectorAll('button:has(svg), [role="button"]:has(svg), div:has(> svg)').forEach((e) => { if (vis(e)) out.svgHosts.push(desc(e)); }); } catch (e) {}
      } catch (e) { out.error = String(e && e.message); }
      return out;
    })()`)

    console.log(`    title: ${dump.title}`)
    console.log(`    url  : ${dump.url}`)
    console.log(`\n    输入框候选（${dump.inputs.length}）:`)
    for (const i of dump.inputs) console.log('      ' + JSON.stringify(i))
    console.log(`\n    可见按钮（${dump.buttons.length}）:`)
    for (const b of dump.buttons.slice(0, 40)) console.log('      ' + JSON.stringify(b))
    console.log(`\n    含 svg 的可点元素（${dump.svgHosts.length}）:`)
    for (const s of dump.svgHosts.slice(0, 20)) console.log('      ' + JSON.stringify(s))

    // ---- 4) 用 chat.ts 里的同一套选择器去匹配 ----
    console.log('\n[4] 用插件选择器匹配')
    const matched = await cdp.eval(`(() => {
      const vis = (el) => { try { return el.offsetWidth > 0 && el.offsetHeight > 0; } catch (e) { return false; } };
      const dis = (el) => { try { return el.disabled === true || el.getAttribute('aria-disabled') === 'true'; } catch (e) { return true; } };

      const INPUT_SELS = [
        'textarea[placeholder*="给 DeepSeek"]',
        'textarea[placeholder*="DeepSeek"]',
        'textarea[placeholder*="输入"]',
        'textarea[placeholder*="发送"]',
        'textarea[placeholder*="message" i]',
        'textarea[placeholder*="ask" i]',
        'textarea[placeholder*="提问"]',
        'textarea.chat-input',
        'textarea#chat-input',
        'textarea',
        'div[contenteditable="true"]',
        '[role="textbox"]'
      ];
      let inputHit = null;
      for (const sel of INPUT_SELS) {
        let list; try { list = document.querySelectorAll(sel); } catch (e) { continue; }
        for (const el of list) {
          if (!vis(el) || dis(el)) continue;
          inputHit = { sel, tag: el.tagName, cls: (typeof el.className === 'string' ? el.className : '').slice(0, 60), placeholder: el.getAttribute('placeholder') };
          break;
        }
        if (inputHit) break;
      }

      const SEND_SELS = [
        'button[type="submit"]',
        'button[aria-label*="send" i]',
        'button[aria-label*="发送"]',
        'button[title*="send" i]',
        'button[title*="发送"]',
        'button[data-testid*="send" i]',
        'button[data-action="send"]',
        'button[data-type="send"]',
        '[role="button"][aria-label*="send" i]',
        '[role="button"][aria-label*="发送"]',
        '[data-testid="send"]',
        '[data-testid="send-button"]',
        '.send-btn',
        '.submit-btn'
      ];
      const sendHits = [];
      for (const sel of SEND_SELS) {
        let list; try { list = document.querySelectorAll(sel); } catch (e) { continue; }
        for (const el of list) {
          if (!vis(el) || dis(el)) continue;
          sendHits.push({ sel, tag: el.tagName, cls: (typeof el.className === 'string' ? el.className : '').slice(0, 60), aria: el.getAttribute('aria-label') });
        }
      }

      // 输入框附近的候选
      const near = [];
      if (inputHit) {
        let box = document.querySelector(INPUT_SELS.find(s => { try { return document.querySelector(s); } catch(e){ return false; } }) || 'textarea');
        let node = box;
        for (let k = 0; k < 6 && node; k++) {
          node = node.parentElement;
          if (!node) break;
          let cands; try { cands = node.querySelectorAll('button, [role="button"], [role="submit"], div[tabindex]'); } catch (e) { break; }
          for (const el of cands) {
            if (!vis(el) || dis(el)) continue;
            near.push({ level: k + 1, tag: el.tagName, cls: (typeof el.className === 'string' ? el.className : '').slice(0, 50), aria: el.getAttribute('aria-label'), text: (el.textContent || '').trim().slice(0, 16) });
          }
          if (near.length > 0 && k >= 2) break;
        }
      }

      // 停止按钮（发送成功的信号）
      let stopFound = false;
      for (const el of document.querySelectorAll('button, [role="button"]')) {
        if (!vis(el)) continue;
        const t = (el.textContent || '').trim();
        const a = (el.getAttribute('aria-label') || '').toLowerCase();
        if (t === '停止生成' || t === '停止' || a.includes('stop')) { stopFound = true; break; }
      }

      return { inputHit, sendHits: sendHits.slice(0, 10), near: near.slice(0, 12), stopFound,
               textareaCount: document.querySelectorAll('textarea').length };
    })()`)

    console.log('    输入框命中:', JSON.stringify(matched.inputHit))
    console.log('    发送按钮命中数:', matched.sendHits.length)
    for (const h of matched.sendHits) console.log('      ' + JSON.stringify(h))
    console.log('    输入框附近候选:', matched.near.length)
    for (const n of matched.near) console.log('      ' + JSON.stringify(n))
    console.log('    停止按钮可见:', matched.stopFound)
    console.log('    textarea 总数:', matched.textareaCount)

    // ---- 5) 结论 ----
    console.log('\n=== 结论 ===')
    if (matched.inputHit === null) {
      console.log('  ✗ 输入框选择器全部未命中 —— 必须修 chat.ts 的 findInput()')
    } else {
      console.log(`  ✓ 输入框可命中（规则 "${matched.inputHit.sel}"）`)
    }
    if (matched.sendHits.length === 0 && matched.near.length === 0) {
      console.log('  ✗ 发送控件一条都没命中 —— 必须修 collectCandidates()')
    } else {
      console.log(`  ✓ 发送控件可命中（语义 ${matched.sendHits.length} 条 / 邻近 ${matched.near.length} 条）`)
    }
    console.log('\n（本次只读探测，未发送任何消息）')
  } finally {
    try {
      ws?.close()
    } catch {
      /* ignore */
    }
    try {
      child.kill()
    } catch {
      /* ignore */
    }
    // 给 Chromium 一点时间落盘再删
    await sleep(500)
    try {
      const { rmSync } = await import('node:fs')
      rmSync(profile, { recursive: true, force: true })
    } catch {
      /* 临时目录删不掉不影响结论 */
    }
  }
}

main().catch((e) => {
  console.error('探测失败:', e?.message ?? e)
  process.exitCode = 1
})
