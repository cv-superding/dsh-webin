#!/usr/bin/env node
/**
 * 用真浏览器验证 `buildProbeScript()` 的登录判据。
 *
 * 背景：面板心跳报 `loggedIn:false`，但快照里 `userToken` / `userInfo.id` 都是有效的。
 * 说明**探针脚本本身判错了**，或者它跑的时机太早（页面还没恢复登录态）。
 *
 * 用法：
 *   node scripts/probe-login.mjs               # 用 deepseek 槽的快照
 *   node scripts/probe-login.mjs --slot qwen   # 指定槽
 *   node scripts/probe-login.mjs --steps       # 分阶段打印（导航前/后、注入前/后）
 */
import { spawn } from 'node:child_process'
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const args = process.argv.slice(2)
const slotIdx = args.indexOf('--slot')
const SLOT = slotIdx >= 0 && args[slotIdx + 1] !== undefined ? args[slotIdx + 1] : 'deepseek'

const SRC = dirname(dirname(fileURLToPath(import.meta.url)))
const DS_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const SNAPSHOT = join(DS_HOME, 'webin', 'auth', `${SLOT}.json`)

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

/** 从产物里抠函数（带边界修正 + 前置常量）。 */
function extractFn(bundle, name) {
  const m = bundle.match(new RegExp(`function ${name}\\(([^)]*)\\)\\s*\\{`))
  if (m === null) throw new Error(`产物里找不到 ${name} —— 先跑 npm run build`)
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

const strip = (s) => s.trim().replace(/;\s*$/, '')

async function main() {
  const bundle = readFileSync(join(SRC, 'lib', 'client.js'), 'utf8')
  const buildProbeScript = extractFn(bundle, 'buildProbeScript')
  const buildRestoreScript = extractFn(bundle, 'buildRestoreScript')

  console.log(`槽位    : ${SLOT}`)
  console.log(`快照    : ${SNAPSHOT}（${existsSync(SNAPSHOT) ? '存在' : '不存在'}）`)

  const browser = findBrowser()
  const port = 9100 + Math.floor(Math.random() * 300)
  const profile = mkdtempSync(join(tmpdir(), 'dsh-webin-login-'))

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

    // ---- A) 裸访问：未注入任何登录态 ----
    await cdp.send('Page.navigate', { url: 'https://chat.deepseek.com/' })
    for (let i = 0; i < 80; i += 1) {
      await sleep(250)
      if ((await cdp.eval('document.readyState').catch(() => '')) === 'complete') break
    }
    await sleep(1500)
    const probeA = JSON.parse(String(await cdp.eval(strip(buildProbeScript()))))
    console.log('\n[A] 裸访问（未注入登录态）')
    console.log('    url       :', probeA.url)
    console.log('    loggedIn  :', probeA.loggedIn)
    console.log('    tokenLen  :', probeA.tokenLength, '| hasUserId:', probeA.hasUserId)

    // ---- B) 注入快照（模拟插件的 buildRestoreScript）----
    if (existsSync(SNAPSHOT)) {
      const snapText = readFileSync(SNAPSHOT, 'utf8')
      const restored = await cdp.eval(strip(buildRestoreScript(snapText)))
      console.log('\n[B] 注入快照')
      console.log('    restore 结果:', restored)

      await cdp.send('Page.reload')
      for (let i = 0; i < 80; i += 1) {
        await sleep(250)
        if ((await cdp.eval('document.readyState').catch(() => '')) === 'complete') break
      }

      // 分阶段看：立刻 / 2s / 5s —— 判定是不是「探针跑太早」
      for (const waitMs of [0, 2000, 5000]) {
        if (waitMs > 0) await sleep(waitMs)
        const p = JSON.parse(String(await cdp.eval(strip(buildProbeScript()))))
        console.log(`\n[C] reload 后再等 ${waitMs}ms 探测`)
        console.log('    url      :', p.url)
        console.log('    loggedIn :', p.loggedIn)
        console.log('    tokenLen :', p.tokenLength, '| hasUserId:', p.hasUserId)
        console.log('    onAuthRoute:', p.onAuthRoute, '| hasLoginForm:', p.hasLoginForm)
        console.log('    hookInstalled:', p.hookInstalled)
      }

      // 原始存储对照
      const raw = await cdp.eval(`(() => ({
        url: location.href,
        token: localStorage.getItem('userToken'),
        userInfo: localStorage.getItem('__appKit_userInfo'),
        textareas: document.querySelectorAll('textarea').length,
        bodyHead: document.body.innerText.slice(0, 120)
      }))()`)
      console.log('\n[D] 页面原始存储')
      console.log('    url      :', raw.url)
      console.log('    userToken:', String(raw.token).slice(0, 70))
      console.log('    userInfo :', String(raw.userInfo).slice(0, 70))
      console.log('    textarea 数:', raw.textareas)
      console.log('    正文开头 :', JSON.stringify(String(raw.bodyHead).slice(0, 80)))
    }
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
