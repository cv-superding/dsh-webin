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
        if (depth === 0) return src.slice(m.index, i + 1)
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

console.log('\n[4] 生成器可解析（防模板转义把脚本弄坏）')
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
