#!/usr/bin/env node
/**
 * **填充失败（`native-setter-noop`）修复** 测试。
 *
 * ## 用户报的错
 *
 *     /zcode-gpt-image2 调用这个技能，画个"小狗站起来"的图
 *     处理失败 · 本轮运行失败 fill-failed: 输入框类型不支持: native-setter-noop
 *
 * ## 根因（两个叠加，都修了）
 *
 * ### 1. CRLF 让「写入成功」的判定永远失败
 *
 * HTML 规范要求 `<textarea>` 的 value 把 CR+LF 折成单个 LF。
 * 而旧代码写完做**逐字节全等**比较：
 *
 *     if (el.value !== value) return { ok:false, how:'native-setter-noop' }
 *
 * Windows 上 `pwsh` 的输出全是 CRLF ⇒ 只要历史里有过工具结果，
 * 之后每一轮的 prompt 都含 CRLF ⇒ 写进去了也判失败 ⇒ 整轮放弃。
 *
 * 这解释了「有时能用，用着用着就不行了」这个**间歇性**特征。
 *
 * ### 2. 只试第一个候选输入框
 *
 * 第一个填不进去就整轮 `fill-failed`，而页面上往往还有别的可用输入框
 * （隐藏的镜像 textarea、只读的 role=textbox…）。
 * 现在**依次试**，全部失败才报错，并列出每个候选的结果。
 *
 * ## 这个测试要钉住什么
 *
 * ⚠️ 最重要的一条：**生成的脚本里正则必须是 `/\r\n?/g`**。
 * 我一度「以为」产物里写成了 `/\\r\\n?/g`（匹配字面反斜杠）并去「修」它 ——
 * 那是**我自己的测试脚本转义写错**，代码本身是对的。
 * 这个断言就是为了防止将来真的有人把它改错。
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

console.log('=== 填充失败（native-setter-noop）修复测试 ===\n')

const bundle = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
/** host 产物是另一个文件 —— `normalizeNewlines` 在那边。 */
const hostBundle = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')

/** 用花括号配对从**指定产物**里抠一个顶层函数的源码。 */
function extractFnFrom(source, name) {
  const m = source.match(new RegExp(`function ${name}\\(`))
  if (m === null) throw new Error(`产物里找不到 ${name} —— 先跑 npm run build`)
  const open = source.indexOf('{', m.index)
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(m.index, i + 1)
    }
  }
  throw new Error(`${name} 括号不配对`)
}

/** 抠 client 产物里的函数。 */
const extractFn = (name) => extractFnFrom(bundle, name)

console.log('[1] host 侧：序列化时归一化换行')
{
  const src = readFileSync(join(ROOT, 'src', 'host', 'serialize.ts'), 'utf8')
  check('⭐ 有 normalizeNewlines', src.includes('export function normalizeNewlines'), true)
  check('⭐ 正则匹配 CRLF', /replace\(\/\\r\\n\?\/g/.test(src), true)

  const host = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')
  check('产物里也有', host.includes('normalizeNewlines'), true)

  /** 行为验证：用抠出来的函数真的跑一遍。 */
  const fnSrc = extractFnFrom(hostBundle, 'normalizeNewlines')
  const normalizeNewlines = new Function(`${fnSrc}; return normalizeNewlines;`)()
  check('CRLF → LF', normalizeNewlines('a\r\nb'), 'a\nb')
  check('裸 CR → LF', normalizeNewlines('a\rb'), 'a\nb')
  check('已是 LF 不变', normalizeNewlines('a\nb'), 'a\nb')
  check('混合', normalizeNewlines('a\r\nb\rc\n'), 'a\nb\nc\n')
  check('空串', normalizeNewlines(''), '')
}

console.log('\n[2] ⭐ 客户端：生成的脚本里正则必须正确（防误改）')
{
  const buildFillScript = new Function(`${extractFn('buildFillScript')}; return buildFillScript;`)()
  const script = buildFillScript('hello', { inputSelectors: ['textarea'], sendSelectors: [] })

  /**
   * ⚠️⚠️ 这条是本文件**最重要**的断言。
   *
   * 生成脚本是**页面里要 eval 的 JS 源码**，所以里面的正则必须写成
   * `/\r\n?/g`（源码里一个反斜杠）。如果写成 `/\\r\\n?/g`，
   * 那个正则匹配的是「字面反斜杠 + r」，**完全不起作用**且不报错。
   */
  check('⭐ 是 /\\r\\n?/g（单反斜杠，真的匹配 CR）', /\/\\r\\n\?\/g/.test(script), true)
  check('⭐ 不是 /\\\\r（那会匹配字面反斜杠）', /\/\\\\r/.test(script), false)

  /** 真的把它跑起来验证行为 —— 不只看字面。 */
  const fm = script.match(/function toLf\(s\) \{[\s\S]*?\n  \}/)
  check('生成脚本里有 toLf', fm !== null, true)
  if (fm !== null) {
    const toLf = new Function(`${fm[0]}; return toLf;`)()
    check('⭐ CRLF 真的被折成 LF', toLf('a\r\nb'), 'a\nb')
    check('⭐ 裸 CR 也被折', toLf('a\rb'), 'a\nb')
    check('⭐ 混合输入', toLf('a\r\nb\rc\n'), 'a\nb\nc\n')
  }
}

console.log('\n[3] ⭐ 写入判定不再要求逐字节全等')
{
  const script = new Function(`${extractFn('buildFillScript')}; return buildFillScript;`)()(
    'hi',
    { inputSelectors: ['textarea'], sendSelectors: [] },
  )

  /**
   * 判据应该是「非空」而不是「全等」。
   * 全等会让浏览器的任何规范化都变成假失败。
   */
  check('⭐ 判据是非空（readInput 为空才算失败）', /readInput\(el\) === '' \? \{ ok: false/.test(script), true)
  check('⭐ 不再用 el.value !== value 全等比较', /el\.value !== value/.test(script), false)
  /**
   * 事件必须先派发 —— 否则 React 收不到变更。
   *
   * ⚠️ 断言用**位置比较**而不是正则窗口：两处相隔数百字符，
   * 写死 `[\s\S]{0,400}` 这种窗口会因为中间插入注释而假失败（踩过）。
   */
  const iEvent = script.indexOf("dispatchEvent(new Event('input'")
  const iRead = script.indexOf('return readInput(el) ===')
  check('⭐ 先派发 input 事件再判定', iEvent > 0 && iRead > 0 && iEvent < iRead, true)
}

console.log('\n[4] ⭐ 依次试所有候选输入框（不再只用第一个）')
{
  const script = new Function(`${extractFn('buildFillScript')}; return buildFillScript;`)()(
    'hi',
    { inputSelectors: ['textarea'], sendSelectors: [] },
  )

  check('⭐ 收集候选（cands）', /var cands = \[\]/.test(script), true)
  check('⭐ 遍历候选', /for \(var c = 0; c < cands\.length; c\+\+\)/.test(script), true)
  check('⭐ 记录每个候选的结果', /tried\.push\(/.test(script), true)
  check('⭐ 全部失败时报出试了几个', /试了 ' \+ tried\.length/.test(script), true)
  /** 只读的输入框填不进去 —— 提前排除，别浪费尝试。 */
  check('⭐ 排除只读输入框', /function readOnly\(/.test(script), true)
  check('去了重（同一元素不重复试）', /seen\.push\(el\)/.test(script), true)
}

console.log('\n[5] 失败信息要能定位（不能只说「失败了」）')
{
  const script = new Function(`${extractFn('buildFillScript')}; return buildFillScript;`)()(
    'hi',
    { inputSelectors: ['textarea'], sendSelectors: [] },
  )

  check('fill-failed 带 tried 明细', /stage: 'fill-failed',[\s\S]{0,200}tried: tried/.test(script), true)
  check('带 textareas 计数', /textareas: document\.querySelectorAll\('textarea'\)\.length/.test(script), true)
  check('带 editables 计数', /editables: document\.querySelectorAll/.test(script), true)
  check('带当前 url', /url: location\.href/.test(script), true)
}

console.log('\n[6] 已知陷阱：JSDoc 里不能出现反引号（模板字符串内）')
{
  /**
   * `buildSendScript` 的整个函数体是一个**模板字符串**。
   * 在里面写 JSDoc 时用反引号包代码，会把模板字符串**提前终止**，
   * 报 `PARSE_ERROR: Expected a semicolon`（踩过好几次）。
   *
   * 这条断言扫源码，防止再犯。
   */
  const src = readFileSync(join(ROOT, 'src', 'client', 'chat.ts'), 'utf8')
  const lines = src.split('\n')
  const start = lines.findIndex((l) => l.includes('return `(function () {'))
  const end = lines.findIndex((l, i) => i > start && l.trim() === '})();`')
  check('找到模板区间', start >= 0 && end > start, true)

  const offenders = []
  for (let i = start; i <= end; i += 1) {
    if (lines[i].includes('`')) offenders.push(i + 1)
  }
  /** 只允许首尾两行的定界反引号。 */
  check('⭐ 模板内只有首尾两个反引号', offenders.length, 2)
  check('⭐ 它们是第 ' + (start + 1) + ' 与 ' + (end + 1) + ' 行', offenders, [start + 1, end + 1])
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
process.exitCode = fail === 0 ? 0 : 1
