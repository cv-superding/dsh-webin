/**
 * 验证「```ldw 围栏保留语言标记」—— 用真实的 DeepSeek DOM 结构。
 *
 * ## 真实事故（用户实测：「工具从来没被调用过」）
 *
 * 抓到的内容：`"ldw\n\n```\nconst r = await pwsh(..."` —— 语言名 `ldw`
 * 作为**独立段落**在前面，围栏本身是裸的。
 *
 * DSH 的解析器认 ` ```ldw `（FENCE_LANG = 'ldw'），裸围栏匹配失败
 * ⇒ **工具调用全部退化成纯文本** ⇒ 模型看起来「不会用工具」。
 *
 * ## 本测试模拟的 DOM（按用户截图里的真实渲染）
 *
 * DeepSeek 把代码块渲染成：
 *
 *     <div class="code-block">
 *       <div class="code-header">ldw</div>   ← 语言标签在这里（pre 外面）
 *       <pre><code>const r = await pwsh(...)</code></pre>
 *     </div>
 *
 * `code` 上**没有** `language-ldw` class ⇒ 旧代码取到空 lang ⇒ 裸围栏。
 */
import { readFileSync } from 'node:fs'

const bundle = readFileSync('lib/client.js', 'utf8')
const m = bundle.match(/function buildScrapeScript\(\)/)
const open = bundle.indexOf('{', m.index)
let depth = 0
let end = -1
for (let i = open; i < bundle.length; i++) {
  if (bundle[i] === '{') depth++
  else if (bundle[i] === '}') {
    depth--
    if (depth === 0) {
      end = i + 1
      break
    }
  }
}
const script = new Function(`${bundle.slice(m.index, end)}; return buildScrapeScript;`)()()

/** ---- DOM 桩（与 verify-scrape 同语义）---- */
const text = (v) => ({ nodeType: 3, nodeValue: v })
function collectAll(n, out = []) {
  for (const c of n.childNodes ?? []) {
    if (c.nodeType === 1) out.push(c)
    collectAll(c, out)
  }
  return out
}
const matches = (n, sel) => {
  if (n.nodeType !== 1) return false
  if (sel.includes(',')) return sel.split(',').some((p) => matches(n, p.trim()))
  const s = sel.trim()
  if (s.startsWith('.')) return String(n.className).split(/\s+/).includes(s.slice(1))
  const st = /^\[class\*=["']([^"']+)["']\]$/.exec(s)
  if (st) return String(n.className).includes(st[1])
  const a = /^\[([\w-]+)(?:=["']?([^\]"']*)["']?)?\]$/.exec(s)
  if (a) {
    const v = n.getAttribute(a[1])
    return a[2] === undefined ? v !== null : v === a[2]
  }
  return n.tagName === s.toUpperCase()
}
function el(tag, opts = {}, ...children) {
  const node = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    className: opts.cls ?? '',
    attrs: opts.attrs ?? {},
    offsetWidth: 100,
    offsetHeight: 20,
    childNodes: children.flat().filter((c) => c != null && c !== ''),
    get children() {
      return this.childNodes.filter((c) => c.nodeType === 1)
    },
    get previousElementSibling() {
      const p = this.parentElement
      if (!p) return null
      const s = p.childNodes.filter((c) => c.nodeType === 1)
      const i = s.indexOf(this)
      return i > 0 ? s[i - 1] : null
    },
    /**
     * ⭐ 下一个元素兄弟（真实 DOM 每个元素都有）——
     * 「语言标签条排除」用它判断「下一个兄弟是不是 pre」，
     * 桩缺了判据会静默失效（与 children / previousElementSibling 同理，踩过）。
     */
    get nextElementSibling() {
      const p = this.parentElement
      if (!p) return null
      const s = p.childNodes.filter((c) => c.nodeType === 1)
      const i = s.indexOf(this)
      return i >= 0 && i < s.length - 1 ? s[i + 1] : null
    },
    getAttribute(k) {
      return k in this.attrs ? this.attrs[k] : null
    },
    querySelectorAll(sel) {
      return collectAll(this).filter((n) => n !== this && matches(n, sel))
    },
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] ?? null
    },
    contains(o) {
      let n = o
      while (n) {
        if (n === this) return true
        n = n.parentElement ?? null
      }
      return false
    },
  }
  Object.defineProperty(node, 'textContent', {
    get() {
      let o = ''
      const w = (x) => {
        if (x.nodeType === 3) {
          o += x.nodeValue
          return
        }
        for (const c of x.childNodes ?? []) w(c)
      }
      w(this)
      return o
    },
  })
  return node
}
const link = (n, p) => {
  if (n == null || n.nodeType !== 1) return
  Object.defineProperty(n, 'parentElement', { value: p, configurable: true })
  for (const c of n.childNodes ?? []) link(c, n)
}
function setup(body) {
  link(body, null)
  globalThis.document = {
    body,
    querySelectorAll(sel) {
      const out = []
      const w = (x) => {
        if (matches(x, sel)) out.push(x)
        for (const c of x.childNodes ?? []) if (c.nodeType === 1) w(c)
      }
      w(body)
      return [...new Set(out)]
    },
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] ?? null
    },
  }
  globalThis.getComputedStyle = () => ({ visibility: 'visible', display: 'block' })
  globalThis.location = { href: 'x' }
}

const FENCE = String.fromCharCode(96, 96, 96)
let pass = 0
let fail = 0
const check = (name, actual, expected) => {
  const ok = actual === expected
  if (ok) pass++
  else fail++
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}`)
  if (!ok) console.log(`       期望 ${JSON.stringify(expected)}\n       实际 ${JSON.stringify(actual)}`)
}

console.log('\n[1] 语言标签在 pre 外面的头部条里（用户截图里的真实结构）')
{
  const codeText = 'const r = await pwsh({"command": "Get-Location; Write-Output x"});'
  const block = el(
    'div',
    { cls: '_codeblock' },
    el('div', { cls: '_codeheader' }, text('ldw')),
    el('pre', {}, el('code', {}, text(codeText))),
  )
  const reply = el(
    'div',
    { cls: 'ds-markdown' },
    block,
    el('p', {}, text('写好了。')),
  )
  setup(el('body', {}, reply))
  const r = JSON.parse(String(eval(script)))
  console.log('  抓到的 last:')
  console.log('  ' + JSON.stringify(String(r.last)))
  check('⭐⭐⭐ 围栏带 ldw 语言标记', String(r.last).includes(FENCE + 'ldw'), true)
  /**
   * ⚠️ 断言「语言名不作为独立段落重复出现」——
   * 收尾围栏本来就是裸的（三项），所以不能笼统断言「没有裸围栏」。
   * 真正要防的是开头被塞一段孤立的 `ldw`。
   */
  check('⭐⭐ 语言名不重复成独立段落', String(r.last).startsWith('ldw'), false)
  check('⭐⭐ 以围栏开头', String(r.last).startsWith(FENCE + 'ldw'), true)
  check('⭐ 代码正文保留', String(r.last).includes('Get-Location'), true)
}

console.log('\n[2] 标准 language-xxx class（老结构仍要работать）')
{
  const codeText = 'const r = await read({"path":"a.ts"});'
  const reply = el(
    'div',
    { cls: 'ds-markdown' },
    el('pre', {}, el('code', { cls: 'language-ldw' }, text(codeText))),
  )
  setup(el('body', {}, reply))
  const r = JSON.parse(String(eval(script)))
  check('⭐⭐⭐ language-xxx 仍然生效', String(r.last).includes(FENCE + 'ldw'), true)
}

console.log('\n[3] 普通代码块（js）不能被误标成 ldw')
{
  const codeText = 'const a = 1;'
  const block = el(
    'div',
    { cls: '_codeblock' },
    el('div', { cls: '_codeheader' }, text('js')),
    el('pre', {}, el('code', {}, text(codeText))),
  )
  const reply = el('div', { cls: 'ds-markdown' }, block)
  setup(el('body', {}, reply))
  const r = JSON.parse(String(eval(script)))
  check('⭐⭐ 语言标记是 js（不是 ldw）', String(r.last).includes(FENCE + 'js'), true)
  check('⭐ 没有误标成 ldw', String(r.last).includes(FENCE + 'ldw'), false)
}

console.log('\n[4] 没有语言标签时不猜（避免误判成工具调用）')
{
  const reply = el(
    'div',
    { cls: 'ds-markdown' },
    el('pre', {}, el('code', {}, text('plain code'))),
  )
  setup(el('body', {}, reply))
  const r = JSON.parse(String(eval(script)))
  const hasBare = new RegExp(FENCE + '\\s*\\n').test(String(r.last))
  check('⭐⭐ 找不到语言就不标（裸围栏）', hasBare, true)
  check('⭐⭐ 绝不臆造 ldw', String(r.last).includes(FENCE + 'ldw'), false)
}


console.log('\n[5] ⭐⭐⭐ 嵌套结构：语言标签与「包着 pre 的容器」是兄弟（真实结构）')
{
  /**
   * ## 真实事故（用户实测：「你到底能不能修好」）
   *
   * 页面 tree 诊断确认的真实结构：
   *
   *     <div class="codeblock">
   *       <div class="header">ldw</div>     ← 标签在这里
   *       <div class="body">
   *         <pre><code>...</code></pre>     ← pre 的直接兄弟里没有标签！
   *       </div>
   *     </div>
   *
   * 只查 pre 的**直接**兄弟会拿不到标签 ⇒ 输出裸围栏 ⇒ 工具调用退化成纯文本。
   * 必须**向上遍历祖先链**。
   */
  const nested = el('div', { cls: 'ds-markdown' },
    el('div', { cls: '_codeblock' },
      el('div', { cls: '_codeheader' }, text('ldw')),
      el('div', { cls: '_codebody' },
        el('pre', {}, el('code', {}, text('const r = await write({"path": "a.txt"});'))),
      ),
    ),
  )
  setup(el('body', {}, nested))
  const r = JSON.parse(String(eval(script)))
  console.log('  抓到的 last: ' + JSON.stringify(String(r.last)))
  check('⭐⭐⭐ 嵌套结构也认语言标记', String(r.last).includes(FENCE + 'ldw'), true)
  check('⭐⭐ 语言名不泄漏为独立段落', String(r.last).startsWith('ldw'), false)
  check('⭐ 以围栏开头', String(r.last).startsWith(FENCE + 'ldw'), true)
}

console.log('\n[6] ⭐⭐ 标签被包在 span 里（另一种真实变体）')
{
  const nested = el('div', { cls: 'ds-markdown' },
    el('div', { cls: '_codeblock' },
      el('div', { cls: '_codeheader' }, el('span', {}, text('ldw'))),
      el('div', { cls: '_codebody' }, el('pre', {}, el('code', {}, text('await pwsh({});')))),
    ),
  )
  setup(el('body', {}, nested))
  const r = JSON.parse(String(eval(script)))
  check('⭐⭐ span 里的标签也认', String(r.last).includes(FENCE + 'ldw'), true)
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
process.exit(fail === 0 ? 0 : 1)
