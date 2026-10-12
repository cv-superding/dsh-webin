#!/usr/bin/env node
/**
 * 验证「重启后必须重新登录」的根因。
 *
 * ## 假设
 *
 * `restore` 脚本是在 **`about:blank`** 上执行的（`dom-ready` 第一次触发时），
 * 而 `localStorage` 是**按源隔离**的 —— 在 `about:blank`（opaque origin）上
 * 写 `localStorage` 根本不会落到 `chat.deepseek.com`。
 *
 * 于是重启后：快照明明有效，却因为写错了源而没生效 ⇒ 用户看到登录页 ⇒ 必须重新登录。
 *
 * ## 验证方法
 *
 * 1. 打开 `about:blank`，写 localStorage，再导航到 deepseek，看值还在不在
 * 2. 反过来：先导航到 deepseek，写 localStorage，看值在不在
 * 3. 同时验证 cookie 在 about:blank 上是否可写
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'

const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
]
const findBrowser = () => {
  for (const b of BROWSERS) if (b !== '' && existsSync(b)) return b
  throw new Error('找不到 Chrome')
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
      }, 60_000)
    })
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails !== undefined) {
      return { __error: r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? '') }
    }
    return r.result.value
  }
}

const waitReady = async (cdp) => {
  for (let i = 0; i < 80; i += 1) {
    await sleep(250)
    if ((await cdp.eval('document.readyState').catch(() => '')) === 'complete') return
  }
}

async function main() {
  const browser = findBrowser()
  const port = 9600 + Math.floor(Math.random() * 200)
  const profile = mkdtempSync(join(tmpdir(), 'dsh-webin-origin-'))
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

    console.log('=== 验证「在 about:blank 上写 localStorage 是否对目标域有效」===\n')

    // ---- A) 在 about:blank 上写 ----
    console.log('[A] 在 about:blank 上写 localStorage + cookie')
    console.log('    当前 URL:', await cdp.eval('location.href'))
    const writeOnBlank = await cdp.eval(`(() => {
      try {
        localStorage.setItem('__probe_from_blank', 'VALUE_FROM_BLANK');
        document.cookie = '__probe_cookie_blank=1; path=/';
        return { ok: true, ls: localStorage.getItem('__probe_from_blank'), ck: document.cookie };
      } catch (e) { return { ok: false, err: e.name + ': ' + e.message }; }
    })()`)
    console.log('    写入结果:', JSON.stringify(writeOnBlank))

    // ---- B) 导航到 deepseek，看值还在不在 ----
    console.log('\n[B] 导航到 chat.deepseek.com，检查刚才写的值是否可见')
    await cdp.send('Page.navigate', { url: 'https://chat.deepseek.com/' })
    await waitReady(cdp)
    const afterNav = await cdp.eval(`(() => ({
      url: location.href,
      ls: localStorage.getItem('__probe_from_blank'),
      ck: document.cookie.indexOf('__probe_cookie_blank') >= 0,
      lsCount: localStorage.length
    }))()`)
    console.log('    URL      :', afterNav.url)
    console.log('    localStorage 里能读到吗:', JSON.stringify(afterNav.ls))
    console.log('    cookie 里能读到吗     :', afterNav.ck)
    console.log('    该域 localStorage 键数 :', afterNav.lsCount)

    // ---- C) 在正确域上写，然后 reload 验证 ----
    console.log('\n[C] 在 deepseek 域上写，然后 reload —— 验证正确姿势有效')
    await cdp.eval(`(() => {
      localStorage.setItem('__probe_on_domain', 'VALUE_ON_DOMAIN');
      return true;
    })()`)
    await cdp.send('Page.reload')
    await waitReady(cdp)
    const afterReload = await cdp.eval(`(() => ({
      url: location.href,
      ls: localStorage.getItem('__probe_on_domain'),
      stillBlank: localStorage.getItem('__probe_from_blank')
    }))()`)
    console.log('    URL            :', afterReload.url)
    console.log('    域上写的值还在吗:', JSON.stringify(afterReload.ls))
    console.log('    blank 写的值在吗:', JSON.stringify(afterReload.stillBlank))

    console.log('\n=== 结论 ===')
    const blankLost = afterNav.ls === null
    const domainKept = afterReload.ls === 'VALUE_ON_DOMAIN'
    console.log(`  about:blank 上写的 localStorage 对目标域${blankLost ? '【无效】✓ 假设成立' : '【有效】✗ 假设不成立'}`)
    console.log(`  目标域上写的 localStorage 跨 reload${domainKept ? '【保留】✓' : '【丢失】✗'}`)
    if (blankLost && domainKept) {
      console.log('\n  ⇒ 根因确认：restore 必须在**目标域**上执行，不能在 about:blank 上。')
    }
    process.exitCode = blankLost && domainKept ? 0 : 1
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
