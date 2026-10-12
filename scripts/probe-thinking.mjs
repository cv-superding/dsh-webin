#!/usr/bin/env node
/**
 * 探针：网页版的**深度思考开关**长什么样。
 *
 * ## 为什么需要这个
 *
 * 用户实测：「点的思考模式那个模型，发现没有思考啊」。
 *
 * 查代码发现：host 侧把 `thinking` 标记一路传到 client（`job.thinking`），
 * 但 **client 从来没用它做任何事** —— 只声明了类型，没有在页面上开启思考。
 *
 * 所以模型选择器里选「深度思考」，实际发出去的请求还是普通模式。
 *
 * ## 这个探针要回答什么
 *
 * 网页版的思考模式是**怎么切换**的？三种可能，必须实测确认：
 *   1. 一个可点的按钮（「深度思考」/「DeepThink」）
 *   2. 输入框里的一个 toggle chip
 *   3. 请求体里的一个字段（那就没法用「操作界面」的方式做）
 *
 * 用法（需要 LDW 面板已打开）：
 *   node scripts/probe-thinking.mjs
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

const SECRET = process.env.DSH_WEBIN_SECRET ?? ''
const BASE = process.env.DSH_WEBIN_BASE ?? 'http://127.0.0.1:19387'
const API = '/dsh-webin/api'

/** 调 DSH 的本地 API。 */
async function api(path, init) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
    ...init,
  })
  return await res.json()
}

console.log('=== 网页版「深度思考」开关探针 ===\n')

// 先看有没有在线 client
const status = await api(`${API}/status`).catch(() => null)
if (status === null) {
  console.log('⚠️ 连不上 DSH API。设 DSH_WEBIN_SECRET 环境变量后重试。')
  process.exit(1)
}
const clients = status.clients ?? []
console.log(`[1] 在线 client: ${clients.length}`)
for (const c of clients) {
  console.log(`    ${c.platform}  登录=${c.loggedIn}  回复数=${c.replyCount}`)
}
if (clients.length === 0) {
  console.log('\n⚠️ 没有在线 client —— 请先切到 LDW 标签让浏览器起来，再跑这个探针。')
  process.exit(1)
}

/**
 * 探针脚本：在页面里找所有「像思考开关」的元素。
 *
 * 判据（宽松，宁多勿少 —— 探针的目的是**发现**而不是断言）：
 *   - 文本含「思考」「深度」「Think」「Reasoning」「R1」
 *   - 是 button / [role=button] / [role=switch] / input[type=checkbox] / label
 *   - 可见
 */
const PROBE = `(function () {
  var out = { candidates: [], switches: [], checkboxes: [], allButtons: [] };
  var KW = /思考|深度|think|reason|r1|推理/i;

  function visible(el) {
    if (!el) return false;
    if (el.offsetWidth <= 0 || el.offsetHeight <= 0) return false;
    var s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  }
  function describe(el) {
    var r = el.getBoundingClientRect();
    return {
      tag: el.tagName,
      cls: String(el.className || '').slice(0, 90),
      role: el.getAttribute('role'),
      aria: el.getAttribute('aria-label'),
      pressed: el.getAttribute('aria-pressed'),
      checked: el.getAttribute('aria-checked'),
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
      text: String(el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
      title: el.getAttribute('title'),
      dataState: el.getAttribute('data-state'),
      x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height)
    };
  }

  // 所有可能承载「模式切换」的元素
  var sel = 'button, [role="button"], [role="switch"], [role="radio"], [role="menuitem"], label, input[type="checkbox"], [aria-pressed], [aria-checked]';
  var list = document.querySelectorAll(sel);
  for (var i = 0; i < list.length; i++) {
    var el = list[i];
    if (!visible(el)) continue;
    var d = describe(el);
    var hay = (d.text + ' ' + (d.aria || '') + ' ' + (d.title || '') + ' ' + d.cls);
    if (KW.test(hay)) out.candidates.push(d);
    if (el.getAttribute('role') === 'switch' || el.getAttribute('aria-pressed') !== null || el.getAttribute('aria-checked') !== null) out.switches.push(d);
    if (el.tagName === 'INPUT' && el.type === 'checkbox') out.checkboxes.push(d);
  }

  // 输入框附近的所有按钮（思考开关通常在输入区）
  var ta = document.querySelector('textarea');
  if (ta) {
    var box = ta.getBoundingClientRect();
    var near = document.querySelectorAll('button, [role="button"], [role="switch"]');
    for (var j = 0; j < near.length; j++) {
      var e2 = near[j];
      if (!visible(e2)) continue;
      var r2 = e2.getBoundingClientRect();
      // 输入框上方 120px 内、水平方向有重叠
      if (r2.bottom <= box.top + 20 && r2.bottom >= box.top - 140 && r2.right > box.left && r2.left < box.right) {
        out.allButtons.push(describe(e2));
      }
    }
  }

  // localStorage 里有没有模式记忆
  var lsKeys = [];
  try {
    for (var k in localStorage) {
      if (/think|reason|mode|deep/i.test(k)) lsKeys.push(k);
    }
  } catch (e) {}
  out.localStorageKeys = lsKeys;

  return JSON.stringify(out);
})()`

/** 通过 host 的调试通道在页面里跑脚本（复用 diagnose 路径）。 */
async function runInPage(script) {
  const res = await api(`${API}/probe`, {
    method: 'POST',
    body: JSON.stringify({ platform: clients[0].platform, script }),
  })
  return res
}

const raw = await runInPage(PROBE)
if (raw?.ok !== true) {
  console.log('\n⚠️ 页面脚本执行失败:', JSON.stringify(raw).slice(0, 300))
  console.log('（host 可能没有 /probe 路由 —— 那需要先在 host 侧加一个调试通道）')
  process.exit(1)
}
const data = JSON.parse(raw.result)

console.log(`\n[2] 关键词候选（含「思考/深度/think/reason」）: ${data.candidates.length}`)
for (const c of data.candidates) {
  console.log(`    ${c.tag} role=${c.role} pressed=${c.pressed} checked=${c.checked} disabled=${c.disabled}`)
  console.log(`       text="${c.text}" aria="${c.aria}" cls="${c.cls.slice(0, 60)}"`)
}

console.log(`\n[3] 所有 switch / aria-pressed / aria-checked 元素: ${data.switches.length}`)
for (const s of data.switches) {
  console.log(`    ${s.tag} role=${s.role} pressed=${s.pressed} checked=${s.checked} text="${s.text}" aria="${s.aria}"`)
}

console.log(`\n[4] 输入框上方的按钮: ${data.allButtons.length}`)
for (const b of data.allButtons) {
  console.log(`    (${b.x},${b.y} ${b.w}x${b.h}) text="${b.text}" aria="${b.aria}" title="${b.title}" cls="${b.cls.slice(0, 50)}"`)
}

console.log(`\n[5] localStorage 里的模式相关键: ${JSON.stringify(data.localStorageKeys)}`)
