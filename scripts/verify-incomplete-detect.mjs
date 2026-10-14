#!/usr/bin/env node
/**
 * ## ⭐⭐⭐ 「回复不完整」判据的行为测试
 *
 * ## 为什么需要
 *
 * 网页版服务端不可用时会插一条「服务器暂时不可用」并**直接掐断生成**。
 * 插件当时的后果是**交付半截工具调用** —— 用户实测 DSH 收到的是
 *
 *     ldw
 *
 *     const r = await write(
 *
 * 工具调用断在半句，用户看到「已完成」却什么都没做成。
 *
 * 两个判据决定「这一轮能不能当成功交付」，判错的方向性后果：
 *   - 漏判（不完整却交付）⇒ 用户拿到半截结果还以为成功（**实测发生过**）
 *   - 误判（完整却当不完整）⇒ 白白重试，浪费配额与时间
 *
 * 所以两个方向都要覆盖。
 *
 * 判据实现在**生成的抓取脚本内部**（`buildScrapeScript` 的 IIFE 里），
 * 这里从生成结果里把两个函数抠出来单独驱动。
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const BUNDLE = join(ROOT, 'lib', 'client.js')

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

const src = readFileSync(BUNDLE, 'utf8')

/**
 * ⚠️ **模板层反转义** —— 抠出来的源码比真正的注入脚本多一层转义。
 *
 * 这些函数位于 `buildScrapeScript` 的**模板字符串内部**，产物里存的是模板的
 * **源码**：生成脚本里的一个反斜杠，在这里写作两个。
 *
 * 不反转义的话，函数体里的正则会被解释错 —— 实测踩到：
 * `/[ \\t\\r\\n]+$/` 直接求值后变成「匹配空格 / 反斜杠 / 字母 t r n」，
 * 于是尾部真换行修剪不掉，`lastCodeBlockIncomplete` 恒返回 false，
 * 测试全红而代码其实是对的。
 *
 * （同一坑在 `verify-extract` / `verify-fence` 也踩过。）
 */
function unescapeTemplateLayer(text) {
  return text.replace(/\\\\/g, '\\')
}

/** 提取函数源码（跳过字符串 / 模板 / 注释，避免花括号被内容带偏）。 */
function extractFn(name) {
  const re = new RegExp(`function ${name}\\(([^)]*)\\)\\s*\\{`)
  const m = re.exec(src)
  if (m === null) return null
  const open = src.indexOf('{', m.index)
  let depth = 0
  let mode = null
  let tplDepth = 0
  for (let i = open; i < src.length; i += 1) {
    const c = src[i]
    const n = src[i + 1]
    if (mode === null) {
      if (c === "'" || c === '"') mode = c
      else if (c === '`') {
        mode = '`'
        tplDepth = 0
      } else if (c === '/' && n === '/') {
        mode = '//'
        i += 1
      } else if (c === '/' && n === '*') {
        mode = '/*'
        i += 1
      } else if (c === '{') depth += 1
      else if (c === '}') {
        depth -= 1
        if (depth === 0) return unescapeTemplateLayer(src.slice(m.index, i + 1))
      }
      continue
    }
    if (mode === '//') {
      if (c === '\n') mode = null
    } else if (mode === '/*') {
      if (c === '*' && n === '/') {
        mode = null
        i += 1
      }
    } else if (mode === "'" || mode === '"') {
      if (c === '\\') i += 1
      else if (c === mode) mode = null
    } else if (c === '\\') i += 1
    else if (c === '$' && n === '{') {
      tplDepth += 1
      i += 1
    } else if (c === '}' && tplDepth > 0) tplDepth -= 1
    else if (c === '`' && tplDepth === 0) mode = null
  }
  return null
}

/** 两个判据都在 buildScrapeScript 生成的脚本里，先拿到那段脚本。 */
const scrapeScript = new Function(`return (${extractFn('buildScrapeScript')})`)()

const isFenceOpen = new Function(`${extractFn('isFenceOpen')}; return isFenceOpen`)()
const readServerError = new Function(`${extractFn('readServerError')}; return readServerError`)()
const lastCodeBlockIncomplete = new Function(
  `${extractFn('lastCodeBlockIncomplete')}; return lastCodeBlockIncomplete`,
)()

const FENCE = '```'

console.log('[1] isFenceOpen：围栏计数奇偶')
{
  const cases = [
    ['没有围栏', '普通回复，没有代码块', false],
    ['一对围栏（完整）', `${FENCE}ldw\nconst r = 1\n${FENCE}`, false],
    ['只有开头围栏（被截断）', `${FENCE}ldw\nconst r = await write(`, true],
    ['两对围栏（完整）', `${FENCE}a\n${FENCE}\n正文\n${FENCE}b\n${FENCE}`, false],
    ['三对半（奇数）', `${FENCE}a${FENCE}${FENCE}b${FENCE}${FENCE}c`, true],
    ['空串', '', false],
    ['undefined', undefined, false],
  ]
  for (const [label, text, want] of cases) {
    check(`${label} ⇒ ${want ? '不完整' : '完整'}`, isFenceOpen(text), want)
  }
}

console.log('\n[2] isFenceOpen：真实事故样本')
{
  /** 用户实测交付过的那段（工具调用断在半句）。 */
  const real = `${FENCE}ldw\n\nconst r = await write(`
  check('实测的半截工具调用 ⇒ 判为不完整', isFenceOpen(real), true)
  /** 完整版本不该误判。 */
  const ok = `${FENCE}ldw\n\nconst r = await write({ path: 'a.txt' })\n${FENCE}\n\n已创建 a.txt`
  check('完整版本 ⇒ 判为完整', isFenceOpen(ok), false)
}

console.log('\n[3] readServerError：识别服务端提示')
{
  function el(text, opts = {}) {
    const { leaf = true, visible = true } = opts
    return {
      firstElementChild: leaf ? null : {},
      offsetWidth: visible ? 10 : 0,
      offsetHeight: visible ? 10 : 0,
      textContent: text,
    }
  }
  const run = (els) => {
    const sandbox = { JSON, RegExp, Array, String, Number, Object, Boolean, Error }
    sandbox.document = { querySelectorAll: () => els }
    return vm.runInContext(`(${extractFn('readServerError')})()`, vm.createContext(sandbox))
  }

  check('「服务器暂时不可用」被识别', run([el('服务器暂时不可用')]), '服务器暂时不可用')
  check('「请求过于频繁」被识别', run([el('请求过于频繁，请稍后重试')]), '请求过于频繁')
  check('正常页面 ⇒ 空串', run([el('你好，有什么可以帮你的吗')]), '')
  check('非叶子节点不算（父节点文本是拼接的）', run([el('服务器暂时不可用', { leaf: false })]), '')
  check('不可见节点不算', run([el('服务器暂时不可用', { visible: false })]), '')
  check('超长文本不算（横幅是一句话）', run([el('服务器暂时不可用' + 'x'.repeat(80))]), '')
  check('空页面 ⇒ 空串', run([]), '')
}

console.log('\n[4] ⭐⭐⭐ lastCodeBlockIncomplete：围栏被页面补闭合后的唯一信号')
{
  /**
   * ## 为什么这条判据必须存在（实测踩到）
   *
   * 网页版的 markdown 渲染器会给**未闭合的围栏自动补上闭合**，所以从 DOM
   * 读出来的文本围栏永远成对 —— isFenceOpen 判为「完整」，闸门不触发。
   *
   * 用户实测交付过这样的回复（DSH 里显示「已完成」）：
   *
   *     ldw
   *
   *     ```ldw
   *     const r = await tools.write({
   *     ```            ← 这一行是渲染器补的，不是模型写的
   */
  const realTruncated = `${FENCE}ldw\nconst r = await tools.write({\n${FENCE}`
  check('实测的半截工具调用（围栏已补）⇒ 判为没写完', lastCodeBlockIncomplete(realTruncated), true)
  check('同一段文本的 isFenceOpen 反而是 false（说明为何需要新判据）', isFenceOpen(realTruncated), false)

  const complete = `${FENCE}ldw\nconst r = await tools.write({ path: 'a.txt' })\n${FENCE}\n\n已创建`
  check('完整工具调用 ⇒ 判为写完', lastCodeBlockIncomplete(complete), false)

  const cases = [
    ['以左花括号结尾', `${FENCE}js\nconst r = foo({\n${FENCE}`, true],
    ['以左圆括号结尾', `${FENCE}js\nfoo(\n${FENCE}`, true],
    ['以逗号结尾', `${FENCE}js\nfoo(a,\n${FENCE}`, true],
    ['以箭头结尾', `${FENCE}js\nconst f = () =>\n${FENCE}`, true],
    ['以逻辑与结尾', `${FENCE}js\na &&\n${FENCE}`, true],
    ['以点号结尾', `${FENCE}js\nfoo.\n${FENCE}`, true],
    ['以分号结尾（完整）', `${FENCE}js\nfoo();\n${FENCE}`, false],
    ['以右花括号结尾（完整）', `${FENCE}js\nfoo({ a: 1 })\n${FENCE}`, false],
    ['以标识符结尾（完整）', `${FENCE}js\nreturn result\n${FENCE}`, false],
    ['没有代码块', '普通回复，没有围栏', false],
    ['空串', '', false],
  ]
  for (const [label, text, want] of cases) {
    check(`${label} ⇒ ${want ? '没写完' : '完整'}`, lastCodeBlockIncomplete(text), want)
  }

  /**
   * ⚠️ 只在代码块**内部**判 —— 正文以冒号结尾极常见
   * （「步骤如下：」），拿它判会大量误报。
   */
  check('正文以冒号结尾不算（不误报）', lastCodeBlockIncomplete('步骤如下：'), false)
  check('正文以加号结尾不算（不误报）', lastCodeBlockIncomplete('1 + 2 +'), false)
}

console.log('\n[6] ⭐⭐⭐ isGenerating：停止键是**纯图标**，只能靠 class 特征')
{
  /**
   * ## 为什么必须测它（本轮实测：判据错了很久没人发现）
   *
   * 旧判据只找 aria-label / title 含「停止 / stop」的元素 —— 但同一个文件里
   * buildStopScript 的注释早就写明：「DeepSeek 的停止键是**纯图标**
   * （无 aria-label、无文字），只能靠 class 特征区分」。
   *
   * 两处自相矛盾 ⇒ isGenerating() **恒返回 false** ⇒
   *   - 「生成中不交付」那道闸门从来没生效过
   *   - 「页面在生成就不算没发出去」也失效（用户实测：网页版在生成，
   *     DSH 却报「消息似乎没有发出去」）
   *
   * 所以这里用假 DOM 把**校准过的特征**逐条钉住。
   */
  const isGenerating = new Function(
    `${extractFn('labelOfEl')}\n${extractFn('isGenerating')}\nreturn isGenerating`,
  )()

  function el(opts = {}) {
    const { cls = '', aria = null, text = '', visible = true } = opts
    return {
      offsetWidth: visible ? 20 : 0,
      offsetHeight: visible ? 20 : 0,
      className: cls,
      textContent: text,
      getAttribute: (k) => (k === 'aria-label' ? aria : null),
    }
  }
  const run = (els) => {
    const sandbox = { JSON, RegExp, Array, String, Number, Object, Boolean, Error }
    sandbox.document = { querySelectorAll: () => els }
    /** ⚠️ labelOfEl 也要一起注入 —— 少了它 isGenerating 会抛错被吞、恒返回 false。 */
    return vm.runInContext(
      `(() => { ${extractFn('labelOfEl')}\n${extractFn('isGenerating')}\nreturn isGenerating() })()`,
      vm.createContext(sandbox),
    )
  }

  /** 真实校准结论：生成中停止键带 ds-button--outlined。 */
  check('⭐⭐⭐ ds-button--outlined ⇒ 生成中', run([el({ cls: 'ds-button--outlined ds-button--circle' })]), true)
  /** 发送键独有特征 ⇒ 不能误判成生成中。 */
  check('⭐⭐ ds-button--filled ⇒ 不是生成中', run([el({ cls: 'ds-button--filled ds-button--circle' })]), false)
  check('⭐⭐ ds-button--primary ⇒ 不是生成中', run([el({ cls: 'ds-button--primary' })]), false)
  /** 生成中发送键**不会消失** ⇒ 两个都在时仍要判生成中。 */
  check(
    '⭐⭐ 发送键与停止键同屏 ⇒ 仍判生成中',
    run([el({ cls: 'ds-button--filled' }), el({ cls: 'ds-button--outlined' })]),
    true,
  )
  /** 语义兜底：页面改版后若补上 aria-label，也认。 */
  check('⭐ aria-label 含「停止」⇒ 生成中（兜底）', run([el({ aria: '停止生成' })]), true)
  check('⭐ aria-label 含 stop ⇒ 生成中（兜底）', run([el({ aria: 'Stop' })]), true)
  /** 不可见的不算。 */
  check('⭐ 不可见 ⇒ 不算生成中', run([el({ cls: 'ds-button--outlined', visible: false })]), false)
  check('⭐ 空页面 ⇒ 不是生成中', run([]), false)
  /** 普通按钮不能误判。 */
  check('⭐ 普通按钮 ⇒ 不是生成中', run([el({ cls: 'ds-button', text: '发送' })]), false)
}

console.log('\n[5] 生成器可解析（防模板转义把脚本弄坏）')
{
  try {
    new vm.Script(scrapeScript, { filename: 'scrape.js' })
    check('抓取脚本可解析', true, true)
  } catch (e) {
    check('抓取脚本可解析', false, e.message)
  }
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
process.exitCode = fail === 0 ? 0 : 1
