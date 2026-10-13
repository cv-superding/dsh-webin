#!/usr/bin/env node
/**
 * **DOM 读回复脚本**测试 —— 用真实 DOM 树桩跑生成脚本。
 *
 * ## 为什么这个测试最重要
 *
 * 用户的要求：「把网页版的内容，回显到 dsh 的对话窗口中」。
 *
 * 整个设计现在**全押在 DOM 抓取上**（不再依赖 hook 抓 SSE ——
 * 那条路因 DSH 门禁删掉 `preload` 而时序上走不通，见 hook.ts 的说明）。
 *
 * 所以这段脚本一旦有 bug，用户看到的就是**空白回复**。
 * 必须用真实 DOM 结构验证，不能只看源码里有没有关键字。
 *
 * ## 桩的要求
 *
 * 要能表达真实页面的关键结构：
 *   - 嵌套元素（div > p / ul > li / pre > code）
 *   - 文本节点（nodeType 3）
 *   - class（`language-js` 这类要能被读到）
 *   - 可见性（offsetWidth/Height）
 *   - 界面元素（button/svg）要被剔除
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

let pass = 0
let fail = 0
const check = function (name, actual, expected) {
  if (arguments.length < 3) expected = true
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    pass += 1
    console.log(`  OK   ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL ${name}\n       期望 ${e}\n       实际 ${a}`)
  }
}

const bundle = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')

/** 从产物里抠出 buildScrapeScript 并生成脚本。 */
function scrapeScript() {
  const m = bundle.match(/function buildScrapeScript\(\)/)
  if (m === null) throw new Error('产物里找不到 buildScrapeScript —— 先跑 npm run build')
  const open = bundle.indexOf('{', m.index)
  let depth = 0
  for (let i = open; i < bundle.length; i += 1) {
    if (bundle[i] === '{') depth += 1
    else if (bundle[i] === '}') {
      depth -= 1
      if (depth === 0) {
        const fn = new Function(`${bundle.slice(m.index, i + 1)}; return buildScrapeScript;`)()
        return fn()
      }
    }
  }
  throw new Error('buildScrapeScript 括号不配对')
}

// ---------------------------------------------------------------------------
// 极简 DOM 实现（够表达真实页面结构）
// ---------------------------------------------------------------------------

/** 文本节点。 */
const text = (value) => ({ nodeType: 3, nodeValue: value })

/** 元素节点。 */
function el(tag, opts = {}, ...children) {
  const node = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    className: opts.cls ?? '',
    attrs: opts.attrs ?? {},
    /** 默认可见；`hidden: true` 表示不可见（见 getComputedStyle 的说明）。 */
    __hidden: opts.hidden === true,
    offsetWidth: opts.hidden === true ? 0 : 100,
    offsetHeight: opts.hidden === true ? 0 : 20,
    childNodes: children.flat().filter((c) => c !== null && c !== undefined && c !== ''),
    /**
     * ⭐ 元素子节点（真实 DOM 每个元素都有 children）——
     * 思考块排除判据用 `node.children[0]` 判「第一个孩子是不是折叠条」，
     * 桩缺这个 ⇒ fc2 = undefined ⇒ 判据静默跳过 ⇒ 测试测不出排除效果（踩过）。
     */
    get children() {
      return this.childNodes.filter((c) => c.nodeType === 1)
    },
    getAttribute(k) {
      return k in this.attrs ? this.attrs[k] : null
    },
    /**
     * ⭐ 元素自己的 querySelectorAll（真实 DOM 每个元素都有）。
     *
     * 抓取逻辑会先定位 main 再在它里面查 —— 桩缺这个就抛
     * "root.querySelectorAll is not a function"（踩过）。
     * 这里用 document 级实现过滤出**本子树内**的节点。
     */
    querySelectorAll(sel) {
      const all = collectAll(this)
      return all.filter((n) => n !== this && matches(n, sel))
    },
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] ?? null
    },
    /** 深度优先取全部文本（真实 textContent 的语义）。 */
    get textContent() {
      let out = ''
      const walk = (n) => {
        if (n.nodeType === 3) {
          out += n.nodeValue
          return
        }
        for (const c of n.childNodes ?? []) walk(c)
      }
      walk(this)
      return out
    },
    /** querySelectorAll：支持 tag 与 `.class` / `[attr="v"]` 的简单形式。 */
    querySelectorAll(sel) {
      const out = []
      const match = (n) => {
        if (n.nodeType !== 1) return false
        const s = sel.trim()
        if (s.startsWith('.')) return String(n.className).split(/\s+/).includes(s.slice(1))
        if (s.startsWith('[')) {
          const mm = /^\[([\w-]+)(?:=["']?([^\]"']*)["']?)?\]$/.exec(s)
          if (mm === null) return false
          const v = n.getAttribute(mm[1])
          return mm[2] === undefined ? v !== null : v === mm[2]
        }
        return n.tagName === s.toUpperCase()
      }
      const walk = (n) => {
        for (const c of n.childNodes ?? []) {
          if (match(c)) out.push(c)
          walk(c)
        }
      }
      walk(this)
      return out
    },
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] ?? null
    },
    /**
     * ⭐ 前一个元素兄弟（真实 DOM 每个元素都有）——
     * 思考区排除 v3 用「前一个兄弟是折叠条」判思考 body，
     * 桩缺了判据静默失效（与 children 同理，踩过）。
     */
    get previousElementSibling() {
      const p = this.parentElement
      if (!p) return null
      const sibs = p.childNodes.filter((c) => c.nodeType === 1)
      const i = sibs.indexOf(this)
      return i > 0 ? sibs[i - 1] : null
    },
    /**
     * ⭐ 下一个元素兄弟（真实 DOM 每个元素都有）——
     * 「语言标签条排除」用它判「下一个兄弟是不是 pre」，
     * 桩缺了判据静默失效（与 children / previousElementSibling 同理，踩过）。
     */
    get nextElementSibling() {
      const p = this.parentElement
      if (!p) return null
      const sibs = p.childNodes.filter((c) => c.nodeType === 1)
      const i = sibs.indexOf(this)
      return i >= 0 && i < sibs.length - 1 ? sibs[i + 1] : null
    },
    /** ⭐ 真实 DOM 的 contains（思考子树跳过依赖它 —— 桩缺了会静默失效，踩过）。 */
    contains(other) {
      let n = other
      while (n) {
        if (n === this) return true
        n = n.parentElement ?? null
      }
      return false
    },
  }
  return node
}

/** 跑脚本，注入桩 document / getComputedStyle / location。 */
function run(script, roots) {
  const g = globalThis
  const saved = { document: g.document, getComputedStyle: g.getComputedStyle, location: g.location }

  /**
   * 完整的选择器匹配 —— 桩的 `querySelectorAll` 只处理了简单形式，
   * 但真实页面选择器有 `.class` / `[attr]` / `[class*="x"]` 三类混用。
   *
   * ⚠️ 这里**必须和真实 DOM 语义一致**，否则测试会因为桩的缺陷
   * 而误报（踩过：`.ds-markdown` 没被识别，脚本掉到模糊兜底分支）。
   */
  /**
   * ## ⭐ 建立 parentElement 链
   *
   * 真实 DOM 里每个节点都有 parentElement。新的抓取逻辑要用它
   * **往上找祖先**（判断是否在侧边栏里），所以桩必须提供 ——
   * 否则 inChrome 永远返回 false，测试就测不出效果（踩过）。
   */
  const linkParents = (node, parent) => {
    if (node === null || node === undefined || node.nodeType !== 1) return
    Object.defineProperty(node, 'parentElement', {
      value: parent,
      configurable: true,
      writable: true,
    })
    for (const c of node.childNodes ?? []) linkParents(c, node)
  }
  for (const root of roots) linkParents(root, null)

  const matches = (n, sel) => {
    if (n.nodeType !== 1) return false
    /** ⭐ 逗号分组：任一命中即算（真实 querySelectorAll 的语义）。 */
    if (sel.includes(',')) return sel.split(',').some((p) => matches(n, p.trim()))
    const s = sel.trim()
    if (s.startsWith('.')) return String(n.className).split(/\s+/).includes(s.slice(1))
    const star = /^\[class\*=["']([^"']+)["']\]$/.exec(s)
    if (star !== null) return String(n.className).includes(star[1])
    const attr = /^\[([\w-]+)(?:=["']?([^\]"']*)["']?)?\]$/.exec(s)
    if (attr !== null) {
      const v = n.getAttribute(attr[1])
      return attr[2] === undefined ? v !== null : v === attr[2]
    }
    return n.tagName === s.toUpperCase()
  }

  g.document = {
    querySelectorAll(sel) {
      const out = []
      for (const root of roots) {
        if (matches(root, sel)) out.push(root)
        for (const n of collectAll(root)) if (matches(n, sel)) out.push(n)
      }
      return [...new Set(out)]
    },
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] ?? null
    },
  }
  /**
   * 桩的 getComputedStyle。
   *
   * ⚠️ 必须反映**真实的隐藏语义** —— 否则 `present()` 测不出来（踩过）：
   *   - `hidden: true` 的 fixture → `display:none`
   *   - 带 `hidden` 属性 / `aria-hidden="true"` → `display:none`
   *
   * 而**高度为 0 但没被隐藏**的元素（折叠的代码块、刚插入的回复骨架）
   * 必须报成可见 —— 那正是 [19] 要测的场景。
   */
  g.getComputedStyle = (node) => {
    const attrs = node?.attrs ?? {}
    const isHidden =
      node?.__hidden === true ||
      attrs.hidden !== undefined ||
      attrs['aria-hidden'] === 'true'
    return {
      visibility: isHidden ? 'hidden' : 'visible',
      display: isHidden ? 'none' : 'block',
      opacity: '1',
    }
  }
  g.location = { href: 'https://chat.deepseek.com/a/chat/s/test' }
  try {
    return JSON.parse(eval(script))
  } finally {
    g.document = saved.document
    g.getComputedStyle = saved.getComputedStyle
    g.location = saved.location
  }
}

/** 收集子树里所有元素节点。 */
function collectAll(n, out = []) {
  for (const c of n.childNodes ?? []) {
    if (c.nodeType === 1) out.push(c)
    collectAll(c, out)
  }
  return out
}

console.log('=== DOM 读回复脚本测试（真实 DOM 树桩）===\n')

const script = scrapeScript()

console.log('[1] 基本：一条纯文本回复')
{
  const reply = el('div', { cls: 'ds-markdown' }, el('p', {}, text('你好，我是 DeepSeek。')))
  const r = run(script, [reply])
  check('ok=true', r.ok, true)
  check('读到内容', r.last.includes('你好'), true)
  check('count=1', r.count, 1)
}

console.log('\n[2] ⭐⭐ 代码块围栏必须还原（工具调用靠它）')
{
  /**
   * 这是**最关键**的一条。用户报过「工具调用泄漏成正文」：
   * 围栏开头的三反引号丢了，于是 DSH 认不出工具调用。
   *
   * 所以 DOM 抓取必须把 `<pre><code>` 还原成围栏代码块。
   */
  const reply = el(
    'div',
    { cls: 'ds-markdown' },
    el('p', {}, text('我来执行一下：')),
    el('pre', {}, el('code', { cls: 'language-js' }, text('const r = await pwsh({command:"ls"});\nlog(r);'))),
    el('p', {}, text('执行完毕。')),
  )
  const r = run(script, [reply])

  const F = '```'
  check('⭐ 含开头围栏', r.last.includes(`${F}js`), true)
  check('⭐ 含结尾围栏', (r.last.match(/```/g) ?? []).length >= 2, true)
  check('⭐ 代码内容在内', r.last.includes('await pwsh'), true)
  check('⭐ 语言标记被读到', r.last.includes('js'), true)
  /** 围栏必须包住代码（不是散落在旁边）。 */
  check('⭐ 围栏结构完整', /```js\n[\s\S]*?await pwsh[\s\S]*?\n```/.test(r.last), true)
  /** 前后的正文也不能丢。 */
  check('正文（前）保留', r.last.includes('我来执行一下'), true)
  check('正文（后）保留', r.last.includes('执行完毕'), true)
}

console.log('\n[3] ⭐ 无语言标记的代码块也要有围栏')
{
  const reply = el('div', { cls: 'ds-markdown' }, el('pre', {}, el('code', {}, text('plain code here'))))
  const r = run(script, [reply])
  check('⭐ 有围栏', (r.last.match(/```/g) ?? []).length >= 2, true)
  check('围栏后直接换行（无语言）', /```\nplain code/.test(r.last), true)
}

console.log('\n[4] ⭐ 界面元素必须剔除（不是回复内容）')
{
  /**
   * 回复下方有「复制 / 下载 / 点赞」这些按钮，还有输入框。
   * 它们不能被当成回复内容 —— 否则 DSH 里会出现一堆界面文字。
   */
  const reply = el(
    'div',
    { cls: 'ds-markdown' },
    el('p', {}, text('这是真正的回复内容。')),
    el('button', {}, text('复制')),
    el('button', {}, text('下载')),
    el('div', { attrs: { role: 'button' } }, text('点赞')),
    el('textarea', {}, text('给 DeepSeek 发送消息')),
    el('div', { cls: 'toolbar', attrs: { 'aria-hidden': 'true' } }, text('隐藏文字')),
  )
  const r = run(script, [reply])
  check('正文在', r.last.includes('这是真正的回复内容'), true)
  check('⭐ 剔除「复制」', r.last.includes('复制'), false)
  check('⭐ 剔除「下载」', r.last.includes('下载'), false)
  check('⭐ 剔除「点赞」', r.last.includes('点赞'), false)
  check('⭐ 剔除输入框占位', r.last.includes('给 DeepSeek 发送消息'), false)
  check('⭐ 剔除 aria-hidden', r.last.includes('隐藏文字'), false)
}

console.log('\n[5] ⭐ 只取回复容器（不把整个页面当一个回复）')
{
  const reply1 = el('div', { cls: 'ds-markdown' }, el('p', {}, text('第一条回复的内容在这里')))
  const reply2 = el('div', { cls: 'ds-markdown' }, el('p', {}, text('第二条回复的内容在这里')))
  /** 外面套一层「会话容器」，里面有侧栏等杂物。 */
  const page = el('div', { cls: 'page' }, el('nav', {}, text('侧栏导航')), reply1, reply2)
  const r = run(script, [page])
  check('count=2', r.count, 2)
  check('⭐ last 是最后一条', r.last.includes('第二条回复的内容在这里'), true)
  check('⭐ last 不含侧栏', r.last.includes('侧栏导航'), false)
  /** all 按文档顺序排列。 */
  check('⭐ all[0] 是第一条', r.all[0].includes('第一条回复的内容在这里'), true)
}

console.log('\n[6] ⭐ 列表 / 标题 / 行内代码的结构保留')
{
  const reply = el(
    'div',
    { cls: 'ds-markdown' },
    el('h2', {}, text('标题')),
    el('ul', {}, el('li', {}, text('第一项')), el('li', {}, text('第二项'))),
    el('p', {}, text('行内 '), el('code', {}, text('npm run build')), text(' 命令')),
  )
  const r = run(script, [reply])
  check('标题在', r.last.includes('标题'), true)
  check('⭐ 列表项有前缀', /- 第一项/.test(r.last), true)
  check('两项都在', r.last.includes('第二项'), true)
  check('⭐ 行内代码用单反引号', r.last.includes('`npm run build`'), true)
}

console.log('\n[7] 不可见的回复要被跳过')
{
  const hiddenReply = el('div', { cls: 'ds-markdown', hidden: true }, el('p', {}, text('这条回复是隐藏的不可见')))
  const visibleReply = el('div', { cls: 'ds-markdown' }, el('p', {}, text('这条回复是可见的内容')))
  const r = run(script, [hiddenReply, visibleReply])
  check('⭐ 只读可见的', r.count, 1)
  check('读到可见那条', r.last.includes('这条回复是可见的内容'), true)
}

console.log('\n[8] ⭐⭐⭐ 短回复必须采信（这是「一直等」的真正根因）')
{
  /**
   * ## ⚠️⚠️ 这一组原来是**反的** —— 它编码的正是那个 bug
   *
   * 原来断言「太短的内容不算回复」，要求 ds-markdown 里至少 8 个字符。
   * 看起来合理，实际是灾难。
   *
   * ## 端到端现场（探针的原始输出）
   *
   *     root=MAIN  cand=1  present=true  inChrome=false
   *     len=1  txt=5          ← 回复正文就是「5」
   *     ...但 count=0         ← 被长度过滤拒了
   *
   * 用户问「1+1=?只回答数字」，DeepSeek 答「2」—— **一个字符**。于是：
   *   1. 精确候选命中但内容太短 ⇒ 丢弃
   *   2. 所有候选都被拒 ⇒ list 为空
   *   3. 落到 longest-div 兜底 ⇒ **抓走侧边栏的会话列表**
   *   4. 「内容变了吗」永远不成立 ⇒ **DSH 一直等，网页版早答完了**
   *
   * ## 正确判据
   *
   * **精确类名**（.ds-markdown，来自真实页面）命中就是回复 ——
   * 内容再短也是回复。长度过滤只对**模糊候选**保留。
   */
  const tiny = el('div', { cls: 'ds-markdown' }, el('p', {}, text('嗯')))
  const r = run(script, [tiny])
  check('⭐⭐⭐ 一个字的回复也要采信', r.ok, true)
  check('⭐⭐ 内容读得到', String(r.last).trim(), '嗯')
  check('⭐ 命中精确类名', r.selector, '.ds-markdown')

  /** 模糊候选仍然要长度过滤（避免收进按钮碎片）。 */
  const fuzzy = el('div', { cls: 'some-markdown-thing' }, text('嗯'))
  const r2 = run(script, [fuzzy])
  check('⭐ 模糊候选仍然过滤短内容', r2.ok, false)
}

console.log('\n[9] 空 DOM 不抛错（返回结构化失败）')
{
  const r = run(script, [el('div', { cls: 'page' })])
  check('ok=false', r.ok, false)
  check('last 是空串', r.last, '')
  check('⭐ 不抛错（有 all 字段）', Array.isArray(r.all), true)
}

console.log('\n[10] ⭐ 多轮对话：条数增长 = 本轮回复到位')
{
  /**
   * 客户端靠 `count > 基线` 判断「本轮回复来了」。
   * 这里验证 count 真的会随回复条数增长。
   */
  const reply1 = el('div', { cls: 'ds-markdown' }, el('p', {}, text('第一轮回复的内容')))
  const before = run(script, [el('div', { cls: 'page' }, reply1)])
  check('基线 count=1', before.count, 1)

  const reply2 = el('div', { cls: 'ds-markdown' }, el('p', {}, text('第二轮回复的内容')))
  const after = run(script, [el('div', { cls: 'page' }, reply1, reply2)])
  check('⭐ 新增后 count=2', after.count, 2)
  check('⭐ 能判断出增长了', after.count > before.count, true)
  check('last 是新的那条', after.last.includes('第二轮回复的内容'), true)
}

console.log('\n[11] 兜底：没有 markdown 类名时也能读到')
{
  /**
   * 页面改版换掉 class 名时，靠「最长的可见 div」兜底。
   * 这让脚本**不依赖具体类名**（DeepSeek 的 class 是构建期哈希）。
   */
  const reply = el(
    'div',
    { cls: 'x1y2z3' },
    el('p', {}, text('这是一段足够长的回复内容，用来触发最长 div 兜底逻辑。')),
  )
  const r = run(script, [el('div', { cls: 'wrapper' }, reply)])
  check('⭐ 兜底能读到', r.ok, true)
  check('内容正确', r.last.includes('足够长的回复内容'), true)
}

console.log('\n[12] ⭐ 思考过程要读出来（用户明确要求过）')
{
  /**
   * 网页版的「已思考（用时 N 秒）」是折叠区，但 DOM 里内容在
   * —— 所以收起状态下也能读到。这正是 DOM 抓取比 SSE 省事的地方。
   */
  const reply = el(
    'div',
    { cls: 'ds-markdown' },
    el('div', { cls: 'thinking-block' }, el('p', {}, text('用户问的是文件策略，需要先确认工作区。'))),
    el('p', {}, text('已经确认完成，这是最终回复内容。')),
  )
  const r = run(script, [reply])
  check('⭐ 读到思考', r.think.includes('需要先确认工作区'), true)
  check('回复正文不受影响', r.last.includes('最终回复内容'), true)
}

console.log('\n[13] 没有思考时不报错（think 为空串）')
{
  const reply = el('div', { cls: 'ds-markdown' }, el('p', {}, text('这条回复没有思考过程，只有正文。')))
  const r = run(script, [reply])
  check('think 是空串', r.think, '')
  check('⭐ 回复仍然正常', r.ok, true)
}

console.log('\n[14] 「已思考（用时 N 秒）」标题要从思考里剥掉')
{
  /** 那行是界面文字，不是思考内容本身。 */
  const reply = el(
    'div',
    { cls: 'ds-markdown' },
    el(
      'div',
      { cls: 'reasoning' },
      el('p', {}, text('已思考（用时 3 秒）')),
      el('p', {}, text('真正的思考内容在这里。')),
    ),
    el('p', {}, text('这是回复正文的内容部分。')),
  )
  const r = run(script, [reply])
  check('⭐ 剥掉标题行', /已思考/.test(r.think), false)
  check('⭐ 保留思考正文', r.think.includes('真正的思考内容'), true)
}

console.log('\n[15] ⭐⭐ 选择器必须含**真实页面类名**（不是猜的）')
{
  /**
   * 从用户会话记录里提取出 DeepSeek 网页版的 `ds-*` 类名体系：
   *   ds-markdown / ds-pow-response / ds-think-content / ds-textarea
   *   ds-markdown-code-copy-button（界面元素，要剔除）
   *
   * 这些是**实测存在**的类名，比「猜一个看起来合理的」可靠得多。
   */
  check('⭐⭐ 回复用 .ds-markdown', /CANDIDATES = \[[\s\S]{0,200}'\.ds-markdown'/.test(script), true)
  check('回复兜底含 ds-pow-response', script.includes('ds-pow-response'), true)
  check('⭐⭐ 思考用 .ds-think-content', /SEL = \[[\s\S]{0,200}'\.ds-think-content'/.test(script), true)
  /** 精确类名必须排在模糊匹配前面（顺序即优先级）。 */
  const iExact = script.indexOf("'.ds-markdown'")
  const iLoose = script.indexOf("'[class*=\"markdown\"]'")
  check('⭐ 精确类名排在模糊之前', iExact > 0 && iLoose > 0 && iExact < iLoose, true)
}

console.log('\n[16] ⭐ 用真实类名跑一遍（模拟页面真实结构）')
{
  /**
   * 按真实页面的类名体系造结构：
   *   ds-markdown（正文）+ ds-think-content（思考）
   *   + ds-markdown-code-copy-button（界面元素，必须剔除）
   */
  const reply = el(
    'div',
    { cls: 'ds-markdown' },
    el('div', { cls: 'ds-think-content' }, el('p', {}, text('先说结论：需要确认输出目录。'))),
    el('p', {}, text('已经生成好了，这是最终回复。')),
    el(
      'pre',
      {},
      el('code', { cls: 'language-js' }, text('await pwsh({command:"Get-Date"});')),
      /** 代码块右上角的复制按钮 —— 界面元素。 */
      el('button', { cls: 'ds-markdown-code-copy-button' }, text('复制')),
    ),
  )
  const r = run(script, [reply])
  check('⭐ 命中 ds-markdown', r.selector, '.ds-markdown')
  check('读到正文', r.last.includes('已经生成好了'), true)
  check('⭐ 思考也读到了', r.think.includes('需要确认输出目录'), true)
  check('⭐ 复制按钮被剔除', r.last.includes('复制'), false)
  check('⭐ 代码围栏还原', /```js\n[\s\S]*?Get-Date[\s\S]*?\n```/.test(r.last), true)
}

console.log('\n[17] ⭐⭐ 思考内容**不得混进正文**（嵌套结构下的真实风险）')
{
  /**
   * 真实页面里 `ds-think-content` 很可能**嵌套在 `ds-markdown` 内部**
   * （思考是回复的一部分，只是折叠显示）。
   *
   * 那么 `render()` 递归时会**连思考一起读进正文** ——
   * 后果：DSH 的对话里，思考变成正文的一部分（用户明确提过这个问题）。
   *
   * 而思考由 `readThink()` 单独提供 ⇒ **正文里必须把它排除**。
   */
  const reply = el(
    'div',
    { cls: 'ds-markdown' },
    el('div', { cls: 'ds-think-content' }, el('p', {}, text('这段是思考过程，不该出现在正文里。'))),
    el('p', {}, text('这段才是真正的回复正文内容。')),
  )
  const r = run(script, [reply])

  check('⭐ 思考被单独读到', r.think.includes('不该出现在正文里'), true)
  check('⭐⭐ 正文含真正的回复', r.last.includes('这段才是真正的回复正文内容'), true)
  check('⭐⭐ 正文**不含**思考', r.last.includes('不该出现在正文里'), false)
}

console.log('\n[18] ⭐⭐⭐ 折叠元素的内容不能被丢掉（用户报的核心问题之一）')
{
  /**
   * ## 真实场景（用户截图）
   *
   * 回复里有一段 ldw 代码块，它是**折叠状态**（有展开按钮）；
   * 思考区「已思考（用时 N 秒）」也是折叠的。
   *
   * 折叠元素的 `offsetHeight` 是 **0**。而早期代码用 `visible()`（要求
   * 高度 > 0）来过滤候选容器 —— 于是：
   *   - 高度为 0 的回复骨架被跳过 ⇒ 条数不增长 ⇒ 判定「回复还没来」
   *   - 折叠的代码块内容被丢掉 ⇒ 工具调用丢失
   *
   * 后果正是用户报的：**网页版早就有答案了，DSH 还在等**。
   *
   * 修法：
   *   - 挑容器用 `present()`（只排除 display:none / visibility:hidden）
   *   - `render()` 内部**不用任何可见性判据**过滤节点
   */
  check('⭐⭐ 有 present 判据', /function present\(el\)/.test(script), true)
  /**
   * ⚠️ 判据改过：现在 present 不通过时会**记数**（决策轨迹用），
   * 所以形式是 `if (!present(...)) { skipped.present++; continue; }`。
   * 断言只匹配「用 present 过滤」这个语义，不把语句形式写死。
   */
  check(
    '⭐⭐ 候选容器用 present',
    /if \(!present\(found\[i\]\)\) \{ skipped\.present\+\+; continue; \}/.test(script),
    true,
  )
  check('⭐⭐ 兜底也用 present', /if \(!present\(all\[k\]\)\) continue/.test(script), true)
  check('⭐ present 排除 display:none', /s\.display === 'none'/.test(script), true)
  check('⭐ present 排除 visibility:hidden', /s\.visibility === 'hidden'/.test(script), true)
  check('visible 仍然存在', /function visible\(el\)/.test(script), true)

  /** render 内部不能用可见性判据 —— 否则折叠的代码块会被丢掉。 */
  const iRender = script.indexOf('function render(node, forThink)')
  const iThink = script.indexOf('function readThink()')
  check('找到 render', iRender > 0, true)
  check('找到 readThink', iThink > iRender, true)
  const renderBody = script.slice(iRender, iThink)
  check('⭐⭐ render 内部不用 visible 过滤', /visible\(/.test(renderBody), false)
  check('⭐ render 内部也不用 present 过滤（内容一律读）', /present\(/.test(renderBody), false)
}

console.log('\n[19] ⭐⭐ 高度为 0 的回复也要算「有一条回复」')
{
  /**
   * 页面刚插入回复节点时高度可能还是 0（还没撑开）。
   * 那时必须**算作已出现**，否则条数永远不增长。
   *
   * 桩里 getComputedStyle 返回 display:block（= 存在），
   * 但 offsetHeight 为 0 —— 模拟「正在生成、还没撑开」。
   */
  const reply = el('div', { cls: 'ds-markdown' }, el('p', {}, text('这条回复的高度是 0，但内容在。')))
  Object.defineProperty(reply, 'offsetHeight', { value: 0, configurable: true })
  Object.defineProperty(reply, 'offsetWidth', { value: 0, configurable: true })

  const r = run(script, [reply])
  check('⭐⭐ 高度 0 也算一条回复', r.count, 1)
  check('⭐⭐ 内容读得到', r.last.includes('高度是 0，但内容在'), true)
  check('命中 ds-markdown', r.selector, '.ds-markdown')
}

console.log('\n[20] ⭐⭐⭐ 侧边栏不能被当成回复（端到端实测抓到的真 bug）')
{
  /**
   * ## 现场（`node scripts/e2e-echo.mjs` 的真实输出）
   *
   * 问「1+1=?只回答数字」，抓回来 1256 字符，内容是：
   *
   *     开启新对话 / 置顶 / 低光增强Prompt模块设计与实现 /
   *     REN模块去雨Prompt模块架构设计 / 今天 / 1加1等于2 /
   *     在不在 / 技能调用确认 / 昨天
   *
   * —— **侧边栏的会话列表**，不是回复正文。
   *
   * ## 为什么
   *
   * 候选全没命中时走 longest-div 兜底：取**全页最长**的 div 文本。
   * 侧边栏堆着所有历史会话标题，文本长度轻易超过一条回复 ⇒ 抓走侧边栏。
   *
   * ## 判据（两条一起用）
   *
   *   1. **正向**：先找 main 元素，在它里面找 —— 侧边栏不在 main 里
   *   2. **反向**：inChrome 排除 aside/nav/role=navigation/
   *      class 含 sidebar 等的**祖先**
   */
  const sidebarTitles = [
    '低光增强Prompt模块设计与实现',
    'REN模块去雨Prompt模块架构设计',
    '1加1等于2',
    '在不在',
    '技能调用确认',
    '安装 dsh-our-free-model 插件',
    '鹅鹅骑自行车 HTML',
    '模型思考强度无法调节',
  ]
  const sidebar = el(
    'aside',
    { cls: 'ds-sidebar' },
    el('div', { cls: 'sidebar-inner' }, ...sidebarTitles.map((t) => el('div', { cls: 'item' }, text(t)))),
  )
  /** 回复正文（短得多）。 */
  const reply = el('div', { cls: 'ds-markdown' }, el('p', {}, text('5')))
  /** 主内容区包着回复。 */
  const main = el('main', { cls: 'chat-main' }, reply)
  const body = el('body', {}, sidebar, main)

  const r = run(script, [body])
  check('⭐⭐⭐ 抓到的是回复而不是侧边栏', String(r.last).trim(), '5')
  check('⭐⭐ 命中精确类名', r.selector, '.ds-markdown')
  check('⭐ 条数是 1（不是侧边栏那一坨）', r.count, 1)
  check('⭐⭐ 侧边栏的标题没混进来', String(r.last).includes('低光增强'), false)
  check('⭐ 主内容区定位正确', r.root, 'main')
}

console.log('\n[21] ⭐⭐ 没有 main 元素时靠 inChrome 排除侧边栏')
{
  /**
   * 有些布局不用 main 标签。那时只能靠反向排除 —— 所以这条必须独立成立。
   *
   * 桩里侧边栏用 role="navigation"（语义标记），回复在普通 div 里，
   * 且**故意让侧边栏文本更长** —— 逼着兜底路径去选，看它会不会选错。
   */
  const sidebar = el(
    'div',
    { cls: 'x', attrs: { role: 'navigation' } },
    el('div', {}, text('很长的会话标题一'.repeat(20))),
  )
  /** 回复容器：故意不用 ds-markdown，逼兜底路径生效。 */
  const reply = el('div', { cls: 'reply-body' }, text('这是真正的回复正文，长度很短。'))
  const body = el('body', {}, sidebar, reply)

  const r = run(script, [body])
  check('⭐⭐ 兜底路径没选侧边栏', String(r.last).includes('真正的回复正文'), true)
  check('⭐⭐ 侧边栏的长文本没被选中', String(r.last).includes('很长的会话标题'), false)
  check('⭐ 走的是 longest-div 兜底', r.selector, 'longest-div')
}

console.log('\n[22] ⭐⭐ 回复正文里含 nav/sidebar 字样的类名不能被误杀')
{
  /**
   * inChrome 只排除**祖先**，且用词边界匹配。
   * 回复正文自己的类名里含这些词时**不该被排除** ——
   * 否则会误伤（宁可漏排也不能错杀）。
   */
  const reply = el(
    'div',
    { cls: 'ds-markdown' },
    el('p', {}, text('这段文字里提到了 sidebar 和 navigation 两个词。')),
  )
  const r = run(script, [el('body', {}, reply)])
  check('⭐⭐ 正文没被误杀', r.count, 1)
  check('⭐⭐ 内容完整', String(r.last).includes('提到了 sidebar'), true)
}


console.log('\n[23] ⭐⭐⭐ 思考块不混入正文（折叠条判定，实测类名无关）')
{
  /**
   * ## 真实事故（用户实测鹈鹕任务）
   *
   * DeepSeek 新版把思考渲染在 .ds-markdown 容器里，
   * 旧思考类名（think-content）不存在 ⇒ isThinkNode 拦不住 ⇒
   * 42KB 思考被当回复交付。
   *
   * ## 修法（类名无关，用 UI 文案）
   *
   * 思考区的特征：节点文本里有「已思考（用时 N 秒）」折叠条。
   * render 时节点文本含它且位置靠前 ⇒ 整个子树排除。
   */
  const thinkBlock = el('div', { cls: 'ds-markdown' },
    el('div', { cls: 'think-header' }, text('已思考（用时 46 秒）')),
    el('div', { cls: 'think-body' }, text('模型的长篇思考内容应该出现在这里而不是正文里。')),
    el('div', { cls: 'answer' }, text('这是真正的回复正文。')),
  )
  const r = run(script, [thinkBlock])
  check('⭐⭐⭐ 正文不含思考内容', String(r.last).includes('长篇思考内容'), false)
  check('⭐⭐ 正文保留', String(r.last).includes('真正的回复正文'), true)
  /** 思考进 think 字段（readThink 折叠条定位）。 */
  check('⭐ think 字段读到思考', String(r.think).includes('长篇思考内容'), true)
}


console.log('\n[24] ⭐⭐⭐ 侧边栏不能被当回复交付（兜底抓到会话列表 ⇒ 返回空）')
{
  /**
   * ## 真实事故（用户：「绝望了，这又是什么bug」）
   *
   * 所有精确候选 found=0 ⇒ 掉到 longest-div 兜底 ⇒ 抓到**侧边栏**
   * （1110 字符的会话列表：「开启新对话 / 置顶 / 今天 / 新对话…」）
   * 当回复交付。网页版明明答对了（「写好了：小故事.txt」），
   * DSH 收到的却是会话列表。
   *
   * ## 判据（特征组合，不是单一关键词）
   *
   * 含「开启新对话」或换行后的「新对话」+ 含日期分组（今天/昨天/7 天内）
   * + 无代码围栏 + 长度 > 24。
   */
  const sidebarText =
    '开启新对话\n\n置顶\n\n低光增强Prompt模块设计与实现\n\nREN模块去雨架构设计\n\n今天\n\n新对话\n\n在吗\n\n在\n\n21加22等于43'
  const r = run(script, [el('div', { cls: '_77cdc67' }, text(sidebarText))])
  check('⭐⭐⭐ 侧边栏被否决（ok=false）', r.ok, false)
  check('⭐⭐ 交付内容为空', String(r.last), '')
  check('⭐⭐ 兜底信息标了 REJECTED', String(r.fallback).includes('REJECTED=sidebar'), true)

  /** ⚠️ 反向：真实回复不能被误杀（哪怕内容里提到「今天」）。 */
  const fence = String.fromCharCode(96, 96, 96)
  const goodReply = el('div', { cls: 'ds-markdown' },
    text('写好了：' + fence + 'ldw\nawait write({path:"a.txt"});\n' + fence + '\n\n今天的故事写完了。'))
  const r2 = run(script, [goodReply])
  check('⭐⭐⭐ 真回复不被误杀', String(r2.last).includes('写好了'), true)
  check('⭐⭐ 走动兜底也不误判', String(r2.fallback ?? '').includes('REJECTED'), false)
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
process.exitCode = fail === 0 ? 0 : 1
/** ⚠️ 显式退出 —— 防 handle 悬挂把 npm run check 卡死（verify-lifecycle 实测踩过）。 */
process.exit(process.exitCode)
