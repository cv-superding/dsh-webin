#!/usr/bin/env node
/**
 * ## ⭐⭐⭐ 模板字符串里的单反斜杠转义审计
 *
 * ## 为什么需要（真实事故，两例）
 *
 * 插件把注入页面的 JS **当字符串生成**，写在一个个模板字符串里。模板字符串
 * 会吃掉一层转义：
 *
 *   - 单写的斜杠转义 ⇒ 退化成裸斜杠  ⇒ 正则提前结束 ⇒ **语法错误**
 *     （`hook.ts` 的 `fragmentIndexOf`，页面抛
 *      `SyntaxError: Invalid regular expression flags`，hook 注入整个失败）
 *   - 单写的字符类转义 ⇒ 退化成普通字母 ⇒ **静默算错**
 *     （`dom-report.ts` 的 `dc.split(/\s+/)` 变成 `split(/s+/)`，
 *      按字母 s 切分，`ds-` 类名一个都提取不到 —— 不报错，只是结果悄悄变错）
 *
 * 第二种更危险：没有异常、没有日志，只有「诊断输出莫名其妙是空的」。
 *
 * ## 判据
 *
 * 在模板字符串内部，**任何单反斜杠 + 正则类字符**都是可疑的 ——
 * 必须写成双反斜杠。少数真正需要控制字符的转义（`\n` `\t` 等）在白名单里。
 *
 * ⚠️ 扫描器必须正确处理 `${}` 嵌套：`${}` 里面是**代码**，那里出现的
 * `/\s+/` 是普通正则、完全合法（第一版扫描器没处理嵌套，报了两处误报）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SRC = join(ROOT, 'src')

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

/** 模板字符串里合法的转义（真控制字符 / 引号 / 模板自身语法）。 */
const LEGIT = new Set(['n', 'r', 't', 'b', 'f', 'v', '0', 'x', 'u', '`', '$', '\\', "'", '"'])
/** 正则里常见、必须双写的字符 —— 单写即为可疑。 */
const SUSPICIOUS = new Set('dDsSwWbB/.*+?^()[]{}|-,:;#!<>=%&~')

/**
 * 找出所有「模板字符串内部的单反斜杠 + 可疑字符」。
 *
 * 状态机：栈顶 `tpl` 表示在模板文本里，`code` 表示在代码里。
 * 模板里遇到 `${` 压入 `code`；代码里遇到配对的 `}` 弹回模板。
 *
 * ⚠️ 代码模式还必须识别**正则字面量** —— 否则正则里的反引号会被当成
 * 模板起点，状态从此错位（真实踩到：`/\r?\n[ \t]*```/` 用来匹配代码围栏，
 * 里面的三个反引号把扫描器带偏，之后一路误报）。
 * `/` 是除法还是正则，靠**前一个有效字符**判断（标准做法）。
 */
const REGEX_ALLOWED_AFTER = new Set([
  '', '(', '[', '{', ',', ';', ':', '=', '!', '&', '|', '?', '+', '-', '*', '%', '^', '<', '>', '~',
])

function scan(src) {
  const out = []
  const stack = ['code']
  let braceDepth = 0
  let line = 1
  let i = 0
  let lastSig = ''
  const at = (k) => src[k]

  while (i < src.length) {
    const c = at(i)
    const n = at(i + 1)
    if (c === '\n') line += 1

    if (stack[stack.length - 1] === 'tpl') {
      if (c === '\\') {
        const nx = at(i + 1) ?? ''
        if (nx !== '' && !LEGIT.has(nx) && SUSPICIOUS.has(nx)) out.push({ line, esc: c + nx })
        i += 2
        continue
      }
      if (c === '`') {
        stack.pop()
        i += 1
        continue
      }
      if (c === '$' && n === '{') {
        stack.push('code')
        braceDepth = 0
        lastSig = ''
        i += 2
        continue
      }
      i += 1
      continue
    }

    /* ---- code ---- */
    if (c === '`') {
      stack.push('tpl')
      i += 1
      continue
    }
    if (c === "'" || c === '"') {
      const q = c
      i += 1
      while (i < src.length && at(i) !== q) {
        if (at(i) === '\\') i += 1
        if (at(i) === '\n') line += 1
        i += 1
      }
      i += 1
      lastSig = q
      continue
    }
    if (c === '/' && n === '/') {
      while (i < src.length && at(i) !== '\n') i += 1
      continue
    }
    if (c === '/' && n === '*') {
      i += 2
      while (i < src.length && !(at(i) === '*' && at(i + 1) === '/')) {
        if (at(i) === '\n') line += 1
        i += 1
      }
      i += 2
      continue
    }
    /** 正则字面量：跳过它（含字符类与 flags），别让里面的反引号带偏状态。 */
    if (c === '/' && REGEX_ALLOWED_AFTER.has(lastSig)) {
      i += 1
      let inClass = false
      while (i < src.length) {
        const rc = at(i)
        if (rc === '\\') {
          i += 2
          continue
        }
        if (rc === '\n') line += 1
        if (rc === '[') inClass = true
        else if (rc === ']') inClass = false
        else if (rc === '/' && !inClass) {
          i += 1
          while (i < src.length && /[a-z]/i.test(at(i))) i += 1
          break
        }
        i += 1
      }
      lastSig = '/'
      continue
    }
    if (c === '{') {
      braceDepth += 1
      lastSig = c
      i += 1
      continue
    }
    if (c === '}') {
      if (braceDepth === 0 && stack.length > 1) {
        stack.pop()
        i += 1
        continue
      }
      braceDepth -= 1
      lastSig = c
      i += 1
      continue
    }
    if (!/\s/.test(c)) lastSig = c
    i += 1
  }
  return out
}

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, acc)
    else if (name.endsWith('.ts')) acc.push(p)
  }
  return acc
}

const files = walk(SRC)
console.log(`[1] 扫描 ${files.length} 个源文件`)

/**
 * ⚠️ 先自检扫描器本身 —— 否则它一旦静默退化成空操作，
 * 后面那个「0 处」就毫无意义（**测试假绿是最坏的绿**）。
 */
console.log('\n[0] 扫描器自检（合成样本）')
{
  const sample = [
    'const plain = `a ${x} b`;',
    'const good = `re = /\\\\s+/`;',
    'const bad = `re = /\\s+/`;',
    'const bad2 = `p = /a\\/b/`;',
    'const codeRe = /[\\s]+/.test(s);',
    'const nested = `x ${/[`]+/.test(s) ? 1 : 2} y`;',
    'const ctrl = `line\\nbreak`;',
  ].join('\n')
  const found = scan(sample).map((h) => h.esc)
  check(`自检命中 2 处（实际 ${JSON.stringify(found)}）`, found.length, 2)
  check('自检命中反斜杠-s', found.includes('\\s'), true)
  check('自检命中反斜杠-斜杠', found.includes('\\/'), true)
}

const hits = []
for (const f of files) {
  for (const h of scan(readFileSync(f, 'utf8'))) {
    hits.push({ file: relative(ROOT, f), ...h })
  }
}

console.log('\n[2] 模板字符串内的单反斜杠转义')
check(`没有可疑的单反斜杠转义（发现 ${hits.length} 处）`, hits.length, 0)
for (const h of hits) {
  console.log(`       ${h.file}:${h.line}  [${h.esc}]`)
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
process.exitCode = fail === 0 ? 0 : 1
