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
        if (nx !== '' && !LEGIT.has(nx) && SUSPICIOUS.has(nx)) out.push({ line, kind: 'escape', esc: c + nx })
        i += 2
        continue
      }
      if (c === '`') {
        stack.pop()
        /**
         * ⚠️ **误闭合检测**：模板正文里不小心写了一个反引号（典型场景：在
         * 注释里写 markdown 代码片段，如反引号包住的标识符），会**提前终止
         * 模板** ⇒ 后续内容变成代码 ⇒ 构建报 PARSE_ERROR。
         *
         * 判据：闭合后**同一行 60 字符内**又出现一个反引号。
         * 合法的模板结尾后面跟的是换行 / 分号 / 括号，同一行不会再有反引号。
         *
         * （这个坑一天踩了四次，构建报错又很难看懂，所以加在这里提前报。）
         */
        const rest = src.slice(i + 1, i + 61)
        const nlAt = rest.indexOf('\n')
        const tickAt = rest.indexOf('`')
        /**
         * ⚠️ 只对**注释行**报，否则误报一片。
         *
         * 合法的一行里出现多个反引号很常见：模板拼接（`${a}px`, `${b}px`）、
         * 三元里的两个模板、字符串里的三反引号 —— 实测这些全是误报。
         *
         * 而真正的失败模式很具体：**在模板内的注释行里写反引号**
         * （典型：JSDoc 里用反引号包标识符）。那种行 trimmed 后以 * 或 // 开头。
         */
        const lineStart = src.lastIndexOf('\n', i) + 1
        const lineText = src.slice(lineStart, i).trimStart()
        const isCommentLine = lineText.startsWith('*') || lineText.startsWith('//')
        if (isCommentLine && tickAt >= 0 && (nlAt < 0 || tickAt < nlAt)) {
          out.push({ line, kind: 'stray-backtick', esc: '`' })
        }
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
  /**
   * ⭐ 把**最终状态**一起返回 —— 让「扫描器跑偏」可见，而不是静默返回 0 处。
   *
   * 真实教训：构建因模板里的反引号失败，而本审计报「发现 0 处」——
   * 因为它当时不在模板模式（状态提前跑偏），**静默失效**比误报更危险。
   */
  return { hits: out, finalStack: stack.slice(), braceDepth }
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
    // 误闭合：**模板正文的注释行**里写了反引号（下一个反引号在同一行）
    'const tpl = `(function () {',
    '     * 注释里写了 `word` 这样的片段`',
    // 误报防护：合法的一行多个模板，**不该**被报
    'const ok2 = `${a}px` + `${b}px`;',
  ].join('\n')
  const found = scan(sample).hits.map((h) => h.esc)
  check(`自检命中 3 处（实际 ${JSON.stringify(found)}）`, found.length, 3)
  check('自检命中反斜杠-s', found.includes('\\s'), true)
  check('自检命中反斜杠-斜杠', found.includes('\\/'), true)
  check('自检命中误写反引号', found.includes('`'), true)
}

const hits = []
for (const f of files) {
  for (const h of scan(readFileSync(f, 'utf8')).hits) {
    hits.push({ file: relative(ROOT, f), ...h })
  }
}

console.log('\n[1b] ⭐⭐⭐ 扫描器状态自检：每个文件结束时模板必须全部闭合')
{
  /**
   * ## 为什么必须查这个
   *
   * 本审计靠一个状态机跟踪「当前在不在模板字符串里」。一旦状态跑偏
   * （漏配一个反引号、把除法当正则、模板嵌套处理错），它会**静默返回 0 处** ——
   * 而 0 处看起来就像「一切正常」。
   *
   * 真实教训：构建因模板里的反引号失败，而本审计报「发现 0 处」。
   *
   * 判据：文件扫完后，栈里应当只剩最底层的 `code`（所有模板都闭合了）。
   * 不是 ⇒ 扫描器跑偏 ⇒ **大声报错**，不要让它假装通过。
   */
  const unbalanced = []
  for (const abs of files) {
    const r = scan(readFileSync(abs, 'utf8'))
    if (r.finalStack.length !== 1 || r.finalStack[0] !== 'code') {
      unbalanced.push({ file: relative(ROOT, abs), stack: r.finalStack.join('>') })
    }
  }
  check(`扫描器状态正常（${unbalanced.length} 个文件未闭合）`, unbalanced.length, 0)
  for (const u of unbalanced.slice(0, 8)) {
    console.log(`       ${u.file}  残留栈: ${u.stack}`)
  }
}

console.log('\n[2] 模板字符串内的单反斜杠转义')
check(`没有可疑的单反斜杠转义（发现 ${hits.length} 处）`, hits.length, 0)
for (const h of hits) {
  console.log(`       ${h.file}:${h.line}  [${h.esc}]`)
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
process.exitCode = fail === 0 ? 0 : 1
