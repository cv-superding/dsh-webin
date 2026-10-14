#!/usr/bin/env node
/**
 * SSE 帧提取器单元测试 —— 用**真浏览器实测抓到的帧序列**做回归。
 *
 * ## 「只回一个字」的完整根因（probe-frames.mjs 实测）
 *
 * DeepSeek 的 completion SSE 帧序列长这样（原始 JSON，逐帧抓取）：
 *
 *     [0] {"request_message_id":1,"response_message_id":2,"model_type":"default"}
 *     [1] {"updated_at":1791791570.734664}
 *     [2] {"v":{"response":{...,"fragments":[{"id":2,"type":"RESPONSE","content":"1",...}]}}}
 *     [3] {"p":"response/fragments/-1/content","o":"APPEND","v":"."}
 *     [4] {"v":" HTTP"}        ← ⚠️ 裸文本帧：没有 p、没有 o
 *     [5] {"v":"（"}            ← ⚠️ 正文主体全是这种
 *     ...
 *     [130]{"p":"response","o":"BATCH","v":[...]}
 *     [131]{"p":"response/status","o":"SET","v":"FINISHED"}
 *
 * 早期实现只认「带 p 且路径匹配」的帧，于是**每个回复只能拿到第一个字**
 * —— 用户看到的就是「只回一个字」「DSH 不回显」。
 * 我最初的 8+8=? 测试拿到完整 "16" 是因为快照帧恰好含完整答案，掩盖了 bug。
 *
 * 这个测试把实测帧序列灌进**产物里的真实提取器**，锁死：
 *   1. 裸文本帧被正确追加
 *   2. 元信息帧（request_message_id / updated_at）不会被误当正文
 *   3. 初始快照 + 裸增量的组合产出完整文本
 *   4. FINISHED 状态正确置位
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = dirname(dirname(fileURLToPath(import.meta.url)))
const bundle = readFileSync(join(SRC, 'lib', 'client.js'), 'utf8')

/**
 * 从产物里抠出 createExtractor。
 *
 * ⚠️ 边界不能只靠花括号配对（函数体里有含花括号的字符串字面量），
 * 用「编译验证」找第一个能编译的结束点。
 */
/**
 * ⚠️ **模板层反转义** —— 抠出来的源码比真正的注入脚本多一层转义。
 *
 * `createExtractor` 这些函数位于 `buildDeepSeekHook` 的**模板字符串内部**，
 * 产物里存的是模板的**源码**：生成脚本里的一个反斜杠，在这里写作两个。
 * 直接 `new Function` 求值会把两个反斜杠当成「转义反斜杠」，
 * 于是正则提前结束 ⇒ `Invalid regular expression flags`
 * （真实事故：hook.ts 里把转义修对之后，本测试反而红了）。
 *
 * 所以求值前先反转义一层：两个反斜杠 ⇒ 一个。
 * 这对字符串里的反斜杠同样正确 —— 模板源码总是比生成代码多一层。
 */
function unescapeTemplateLayer(text) {
  return text.replace(/\\\\/g, '\\')
}

function extractCreateExtractor(bundle) {
  const m = bundle.match(/function createExtractor\(\)\s*\{/)
  if (m === null) throw new Error('产物里找不到 createExtractor —— 先跑 npm run build')
  const start = m.index
  const openBrace = bundle.indexOf('{', start)
  let depth = 0
  let braceEnd = -1
  for (let i = openBrace; i < bundle.length; i += 1) {
    if (bundle[i] === '{') depth += 1
    else if (bundle[i] === '}') {
      depth -= 1
      if (depth === 0) {
        braceEnd = i + 1
        break
      }
    }
  }
  // createExtractor 依赖同层的 lastSeg / classify / isBareTextDelta —— 一起抠
  const seg = bundle.match(/function lastSeg\(p\)\s*\{/)
  const segStart = seg.index
  const classifyM = bundle.match(/function classify\(p\)\s*\{/)
  const bareM = bundle.match(/function isBareTextDelta\(obj\)\s*\{/)

  const cut = (from) => {
    const ob = bundle.indexOf('{', from)
    let d = 0
    for (let i = ob; i < bundle.length; i += 1) {
      if (bundle[i] === '{') d += 1
      else if (bundle[i] === '}') {
        d -= 1
        if (d === 0) return unescapeTemplateLayer(bundle.slice(from, i + 1))
      }
    }
    throw new Error('cut 失败')
  }

  const parts = [cut(segStart), cut(classifyM.index), cut(bareM.index), cut(start)]
  // eslint-disable-next-line no-new-func
  const createExtractor = new Function(`${parts.join('\n')}\n; return createExtractor;`)()
  return createExtractor
}

const createExtractor = extractCreateExtractor(bundle)

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

/** 实测帧序列（probe-frames.mjs 从真浏览器抓的，带语义注释）。 */
const REAL_FRAMES = [
  { request_message_id: 1, response_message_id: 2, model_type: 'default' }, // [0] 元信息
  { updated_at: 1791791570.734664 }, // [1] 心跳
  {
    // [2] 初始快照：首个 fragment 内容 "1"
    v: {
      response: {
        message_id: 2,
        role: 'ASSISTANT',
        status: 'WIP',
        fragments: [{ id: 2, type: 'RESPONSE', content: '1', references: [], stage_id: 1 }],
      },
    },
  },
  { p: 'response/fragments/-1/content', o: 'APPEND', v: '.' }, // [3] 带路径增量
  { v: ' HTTP' }, // [4] ⚠️ 裸文本帧
  { v: '（' }, // [5] ⚠️ 裸文本帧
  { v: 'HyperText' }, // [6] ⚠️
  { v: 'Transfer' },
  { v: 'Protocol' },
  { v: '）是' },
  { v: '一种' },
  { v: '分布式' },
  { p: 'response/status', o: 'SET', v: 'FINISHED' }, // 结束
]

console.log('=== SSE 帧提取器单元测试（实测帧序列）===\n')

console.log('[1] 实测帧序列 → 完整文本')
{
  const ex = createExtractor()
  for (const f of REAL_FRAMES) ex.consume(f)
  const expect = '1. HTTP（HyperTextTransferProtocol）是一种分布式'
  check('拼出完整文本', ex.text, expect)
  check('FINISHED 置位', ex.finished, true)
  check('无业务错误', ex.businessError, null)
}

console.log('\n[2] 只有裸帧（无快照/无带路径帧）→ 也能拼全')
{
  const ex = createExtractor()
  for (const v of ['你', '好', '，', '世', '界', '！']) ex.consume({ v })
  check('裸帧全部累积', ex.text, '你好，世界！')
}

console.log('\n[3] 元信息帧不得被误当正文')
{
  const ex = createExtractor()
  ex.consume({ request_message_id: 1, response_message_id: 2, model_type: 'default' })
  ex.consume({ updated_at: 1791791570.7 })
  check('元信息不产生文本', ex.text, '')
  check('updated_at 数值不被追加', ex.text, '')
}

console.log('\n[4] 空串裸帧不产生噪声')
{
  const ex = createExtractor()
  ex.consume({ v: '' })
  ex.consume({ v: 'a' })
  ex.consume({ v: '' })
  check('空串被忽略', ex.text, 'a')
}

console.log('\n[5] 错误信封 → businessError 而不是正文')
{
  const ex = createExtractor()
  ex.consume({ v: '正常开头' })
  ex.consume({ code: 40001, msg: 'rate limited' })
  check('正文不再增长', ex.text, '正常开头')
  check('业务错误被记录', ex.businessError, 'rate limited')
  // 有 code 的帧绝不能进裸文本分支
  const ex2 = createExtractor()
  ex2.consume({ code: 40001, msg: 'x' })
  check('code 帧不进正文', ex2.text, '')
}

console.log('\n[6] 带 o=SET 的裸值帧不按增量处理（防覆盖语义错乱）')
{
  const ex = createExtractor()
  ex.consume({ v: 'abc' })
  ex.consume({ o: 'SET', v: 'xyz' })
  check('SET 不追加', ex.text, 'abc')
}

console.log('\n[7] 混合：快照重置后继续累积（新回复）')
{
  const ex = createExtractor()
  ex.consume({ v: '旧回复' })
  ex.consume({ p: 'response/status', o: 'SET', v: 'FINISHED' })
  const old = ex.text
  // 新一轮回复：新快照覆盖
  ex.consume({ v: { response: { fragments: [{ type: 'RESPONSE', content: '新' }] } } })
  ex.consume({ v: '回复' })
  check('旧文本存在', old, '旧回复')
  check('新快照覆盖了正文', ex.text, '新回复')
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
process.exitCode = fail === 0 ? 0 : 1
/** ⚠️ 显式退出 —— 防 handle 悬挂把 npm run check 卡死（verify-lifecycle 实测踩过）。 */
process.exit(process.exitCode)
