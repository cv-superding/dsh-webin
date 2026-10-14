#!/usr/bin/env node
/**
 * ## ⭐⭐⭐ 「继续生成」按钮选择的行为测试
 *
 * ## 为什么这个测试特别重要
 *
 * 这段脚本会在**真实页面上点按钮**。点错的代价是不对称的：
 *   - 该点没点 ⇒ 只是少续写一次，用户手动点一下就好
 *   - **点错了** ⇒ 可能把正在进行的生成**停掉**、把「深度思考」开关**拨反**
 *     （那会改变后续所有请求的行为）、或者发出一条空消息
 *
 * 「继续生成」和「停止」在**同一个操作条**上，只差一个词。所以这里逐条覆盖
 * 各种误点风险，而不是只测「能点到」。
 *
 * 用假 DOM 驱动生成的脚本，断言「点了哪个 / 有没有点」。
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

const buildContinue = new Function(`return (${extractFn('buildContinueScript')})`)()
const SCRIPT = buildContinue()

/** 造一个假元素。`click()` 只记录，不做别的。 */
function el(opts = {}) {
  const {
    text = '',
    cls = '',
    aria = null,
    visible = true,
    disabled = false,
  } = opts
  return {
    offsetWidth: visible ? 20 : 0,
    offsetHeight: visible ? 20 : 0,
    className: cls,
    textContent: text,
    disabled,
    clicked: false,
    getAttribute(k) {
      if (k === 'aria-label') return aria
      if (k === 'aria-disabled') return disabled ? 'true' : null
      return null
    },
    getBoundingClientRect: () => ({ width: visible ? 20 : 0, height: visible ? 20 : 0 }),
    matches: () => false,
    click() {
      this.clicked = true
    },
  }
}

/** 在假 DOM 上跑脚本，返回 { result, clicked: [...text] }。 */
function run(elements) {
  const sandbox = { JSON, RegExp, Array, String, Number, Object, Boolean, Error }
  sandbox.document = { querySelectorAll: () => elements }
  const ctx = vm.createContext(sandbox)
  const result = JSON.parse(vm.runInContext(SCRIPT, ctx, { filename: 'continue.js' }))
  return { result, clicked: elements.filter((e) => e.clicked).map((e) => e.textContent) }
}

console.log('[1] 正常情形：只有「继续生成」')
{
  const a = el({ text: '继续生成' })
  const { result, clicked } = run([a])
  check('判定为可点', result.ok, true)
  check('点的是「继续生成」', clicked, ['继续生成'])
}

console.log('\n[2] 关键安全用例：「继续生成」与「停止」同屏（真实布局）')
{
  const stop = el({ text: '停止' })
  const cont = el({ text: '继续生成' })
  const { result, clicked } = run([stop, cont])
  check('判定为可点', result.ok, true)
  check('只点了「继续生成」，没碰「停止」', clicked, ['继续生成'])
  check('「停止」未被点击', stop.clicked, false)
}

console.log('\n[3] 只有「停止」⇒ 不许点任何东西')
{
  const stop = el({ text: '停止' })
  const { result, clicked } = run([stop])
  check('判定为不可点', result.ok, false)
  check('没有点击发生', clicked, [])
}

console.log('\n[4] 两个同名按钮 ⇒ 歧义，不敢猜')
{
  const a = el({ text: '继续生成' })
  const b = el({ text: '继续生成' })
  const { result, clicked } = run([a, b])
  check('判定为不可点', result.ok, false)
  check('原因是歧义', result.reason, 'ambiguous')
  check('没有点击发生', clicked, [])
}

console.log('\n[5] 危险开关必须被一票否决')
{
  const cases = [
    ['深度思考', '深度思考'],
    ['智能搜索', '智能搜索'],
    ['上传附件', '上传附件'],
  ]
  for (const [text, label] of cases) {
    const e = el({ text })
    const { clicked } = run([e])
    check(`不点「${label}」`, clicked, [])
  }
}

console.log('\n[6] 发送键（filled / primary）不得被当成续写')
{
  const a = el({ text: '继续生成', cls: 'ds-button--primary ds-button--filled' })
  const { result, clicked } = run([a])
  check('判定为不可点', result.ok, false)
  check('没有点击发生', clicked, [])
}

console.log('\n[7] 不可见按钮不得被点')
{
  const a = el({ text: '继续生成', visible: false })
  const { result, clicked } = run([a])
  check('判定为不可点', result.ok, false)
  check('没有点击发生', clicked, [])
}

console.log('\n[8] 空页面 / 无候选')
{
  const { result, clicked } = run([])
  check('判定为不可点', result.ok, false)
  check('原因是无控件', result.reason, 'no-continue-control')
  check('没有点击发生', clicked, [])
}

console.log('\n[9] 弱语义「继续」（单独成词）也认，但不抢强语义')
{
  const weak = el({ text: '继续' })
  const { result, clicked } = run([weak])
  check('判定为可点', result.ok, true)
  check('点的是「继续」', clicked, ['继续'])
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
process.exitCode = fail === 0 ? 0 : 1
