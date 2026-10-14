#!/usr/bin/env node
/**
 * ## ⭐⭐⭐ 生成的注入脚本必须是合法 JS
 *
 * ## 为什么需要（真实事故：SSE 观察路径从未生效）
 *
 * 插件把大量 JS **当字符串生成**，再 `executeJavaScript` 注入页面。这些字符串
 * 写在一个个模板字符串里，而模板字符串**会吃掉一层转义**：
 *
 *   - 单写的斜杠转义 ⇒ 退化成裸斜杠
 *   - 单写的字符类转义 ⇒ 退化成普通字母
 *
 * 于是 `hook.ts` 里一个正则少写一层反斜杠，注入到页面的脚本就变成非法 JS，
 * 页面直接抛 `SyntaxError: Invalid regular expression flags` —— **整个 hook
 * 注入失败**。而 SSE 观察是辅助路径，主路径（读 DOM）照常工作，所以这个故障
 * 一直静默存在，直到用 CDP 打开真页面才暴露。
 *
 * 这类 bug 的特征：**只看源码永远看不出来**（源码里那行正则长得完全正常），
 * 只有把生成结果真正解析一遍才会现形。
 *
 * 本脚本提取产物里所有 `build*Script` / `build*Hook` 生成器，逐个调用，
 * 再用 `vm.Script` **只编译不执行**地解析结果。
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
 * 生成器引用的 bundle 作用域常量 —— 用**真实值**补上，
 * 免得 stub 改变生成结果（那就测不出真问题了）。
 */
const PRELUDE = [
  'const MARKER = "__dshWebinHookInstalled__";',
  'const EVENT_QUEUE_KEY = MARKER + "_events";',
  'const REQUEST_COUNT_KEY = MARKER + "_requests";',
].join('\n')

/** 按参数名给一组合理实参，覆盖各生成器的签名。 */
const ARGS = {
  text: '你好',
  hints: {},
  expectText: '你好',
  completionPath: '/api/v0/chat/completion',
  stopPath: '/api/v0/chat/stop_stream',
  want: true,
  needle: '你好',
  snapshotJson: '{"cookies":[]}',
  lease: 'about:blank#abc',
  url: 'https://chat.deepseek.com/',
}

/**
 * ⚠️ 这几个 `build*` 名字虽然像，但**返回的不是 JS 脚本**（是 UA 字符串等），
 * 解析它们没有意义。加进来要写清理由，别用「跳过」掩盖真问题。
 */
const NOT_A_SCRIPT = new Set([
  /** 返回 User-Agent 字符串，供 webRequest 头用，不是注入脚本。 */
  'buildChromeUserAgent',
])

/**
 * 提取 `function NAME(args) { ... }` 的完整源码。
 *
 * ⚠️ 不能只数花括号 —— 这些函数体里**全是字符串**（生成脚本本身），
 * 字符串里的花括号会把配对带偏（`buildProbeScript` 就被带偏过）。
 * 所以扫描时要跳过字符串 / 模板字符串 / 注释。
 */
function extract(name) {
  const re = new RegExp(`function ${name}\\(([^)]*)\\)\\s*\\{`)
  const m = re.exec(src)
  if (m === null) return null
  const open = src.indexOf('{', m.index)
  let depth = 0
  /** null=代码  "'"=单引号串  '"'=双引号串  '`'=模板串  '//'|'/*'=注释 */
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
        if (depth === 0) return { args: m[1], body: src.slice(m.index, i + 1) }
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
    } else {
      /* 模板串：` 结束；${ 里回到代码（用 tplDepth 记嵌套） */
      if (c === '\\') i += 1
      else if (c === '$' && n === '{') {
        tplDepth += 1
        i += 1
      } else if (c === '}' && tplDepth > 0) tplDepth -= 1
      else if (c === '`' && tplDepth === 0) mode = null
    }
  }
  return null
}

const names = [...new Set([...src.matchAll(/function (build[A-Za-z0-9_]*)\s*\(/g)].map((m) => m[1]))]

console.log(`[1] 提取生成器`)
check('产物里找到生成器（>= 10 个）', names.length >= 10, true)
console.log(`       共 ${names.length} 个: ${names.join(', ')}`)

console.log(`\n[2] 逐个解析生成的脚本`)
let parsed = 0
let unextractable = 0
for (const name of names) {
  if (NOT_A_SCRIPT.has(name)) continue

  const ex = extract(name)
  if (ex === null) {
    unextractable += 1
    console.log(`  ??   ${name} —— 提取失败（花括号配对被字符串内容干扰），跳过`)
    continue
  }
  const params = ex.args
    .split(',')
    .map((s) => s.trim().split(/[=:]/)[0].trim())
    .filter(Boolean)

  let fn
  try {
    // eslint-disable-next-line no-new-func
    fn = new Function(`${PRELUDE}\nreturn (${ex.body})`)()
  } catch (e) {
    unextractable += 1
    console.log(`  ??   ${name} —— 无法求值（${e.message}），跳过`)
    continue
  }

  let out
  try {
    out = fn(...params.map((p) => (p in ARGS ? ARGS[p] : undefined)))
  } catch (e) {
    check(`${name} 能正常生成`, false, `调用抛错: ${e.message}`)
    continue
  }
  if (typeof out !== 'string' || out.length === 0) continue

  parsed += 1
  try {
    new vm.Script(out, { filename: `${name}.js` })
    check(`${name} 生成的脚本可解析（${out.length} 字符）`, true, true)
  } catch (e) {
    check(`${name} 生成的脚本可解析`, false, `${e.message}`)
    /** 打印出错那几行 —— 定位靠它。 */
    const mm = /\.js:(\d+)/.exec(e.stack ?? '')
    if (mm !== null) {
      const ln = Number(mm[1])
      const lines = out.split('\n')
      for (let i = Math.max(0, ln - 3); i < Math.min(lines.length, ln + 2); i += 1) {
        console.log(`       ${String(i + 1).padStart(5)}| ${lines[i].slice(0, 180)}`)
      }
    }
  }
}

check('实际解析了足够多的生成器（>= 10 个）', parsed >= 10, true)
console.log(`       已解析 ${parsed} 个，无法提取 ${unextractable} 个`)

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
process.exitCode = fail === 0 ? 0 : 1
