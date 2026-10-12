#!/usr/bin/env node
/**
 * 复现：为什么工具围栏的开头 ``` 会丢，思考只抓到 2 个字。
 *
 * ## 实测到的原始文本（从用户会话文件解出来的，一字未改）
 *
 * ```
 * "ldw\nconst r = await pwsh({...});\nlog(r);\n```\n\n真的。刚这条 `pwsh` 就是..."
 * ```
 *
 * 注意：**开头是 `ldw`，三个反引号不见了**；结尾的 ` ``` ` 还在。
 *
 * ## 同一轮的另一条证据
 *
 * `reasoning` 块只有 **2 个字符**（`"用户"`），而网页版显示「已思考（用时 1 秒）」。
 *
 * ## 共同根因假设
 *
 * 网页版的 SSE 里，**正文和思考是按 fragment 分的**，而 fragment 的切换
 * 通过 `response/fragments/-1/content` 这类路径帧表达。如果：
 *   - ` ``` ` 这三个反引号被网页端**当成 markdown 代码围栏**处理，
 *     它可能被放在一个**独立的 fragment** 里，或在传输时被转义
 *   - 或者我们的解码器在某个环节吃掉了它
 *
 * 这个脚本把**各种可能的帧序列**喂进提取器，找出哪种会产生观察到的结果。
 *
 * 用法：node scripts/repro-fence.mjs
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const bundle = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')

/**
 * 从产物里抠出 `createExtractor` 源码。
 *
 * ⚠️ 用「编译验证」定位边界，**不用花括号配对** ——
 * 函数体里有字符串字面量含花括号，配对会提前结束（这个坑踩过多次）。
 */
function extractFn(bundle, name) {
  const start = bundle.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`产物里找不到 ${name}`)
  const rest = bundle.slice(start)
  const nextDecl = rest.slice(1).search(/\n(?:function |const |var |\/\/#endregion)/)
  const end = nextDecl < 0 ? bundle.length : start + 1 + nextDecl
  for (let e = end; e > start; e -= 1) {
    if (bundle[e - 1] !== '}') continue
    const src = bundle.slice(start, e)
    try {
      // eslint-disable-next-line no-new-func
      new Function(src)
      return src
    } catch {
      /* 继续退 */
    }
  }
  throw new Error(`${name} 无法提取`)
}

// eslint-disable-next-line no-new-func
const createExtractor = new Function(
  `${extractFn(bundle, 'createExtractor')}\n; return createExtractor;`,
)()

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

/** 喂一串帧，返回提取结果。 */
function feed(frames) {
  const ex = createExtractor()
  for (const f of frames) ex.consume(f)
  return { text: ex.text, think: ex.think }
}

console.log('=== 工具围栏 / 思考提取 复现测试 ===\n')

console.log('[1] 基准：正常帧序列（路径帧 + 裸增量）')
{
  const r = feed([
    { p: 'response/fragments/-1/content', o: 'APPEND', v: '```' },
    { v: 'ldw' },
    { v: '\nconst r = await pwsh(' },
    { v: '{"command":"Get-Date"}' },
    { v: ');\nlog(r);\n' },
    { v: '```' },
  ])
  check('文本含完整围栏', r.text.includes('```ldw'), true)
  check('文本含结尾围栏', r.text.includes('```\n') || r.text.endsWith('```'), true)
}

console.log('\n[2] ⭐ 复现观察到的现象：开头 ``` 缺失')
{
  /**
   * 实测拿到的文本是 `ldw\n...\n``` ` —— 开头三个反引号没了。
   * 试着找出哪种帧序列会产生这个结果。
   */
  const r = feed([
    // 假设：``` 被单独放在一个「非字符串」帧里，或路径帧的 v 不是字符串
    { p: 'response/fragments/-1/content', o: 'APPEND', v: 'ldw' },
    { v: '\nconst r = await pwsh(' },
    { v: '{"command":"Get-Date"}' },
    { v: ');\nlog(r);\n' },
    { v: '```' },
  ])
  console.log(`       文本: ${JSON.stringify(r.text.slice(0, 60))}`)
  check('确实复现了「开头无围栏」', r.text.startsWith('ldw'), true)
}

console.log('\n[3] ⭐ 修复后：思考与正文正确分流')
{
  /**
   * 这是**网页端真实的帧形态**（实测）：
   *   - 思考开始时：`response/fragments/-1/reasoning_content` APPEND
   *   - 之后思考的裸增量：没有 p
   *   - 正文开始时：`response/fragments/-1/content` APPEND
   *   - 之后正文的裸增量：没有 p
   *
   * ⚠️ **首帧就是 `-1`** —— 这是关键。类型表此时还是空的，
   * 早期实现返回 null ⇒ 类型表从未登记 ⇒ 后续裸增量全走错分支。
   */
  const r = feed([
    { p: 'response/fragments/-1/reasoning_content', o: 'APPEND', v: '用户' },
    { v: '问真假的' },
    { v: '，是在质疑我' },
  ])
  console.log(`       think=${JSON.stringify(r.think)}  text=${JSON.stringify(r.text)}`)
  check('⭐ 思考完整（不再只有 2 字）', r.think, '用户问真假的，是在质疑我')
  check('⭐ 思考没混进正文', r.text, '')
}

console.log('\n[4] ⭐⭐ 关键：fragment 类型切换后，裸增量正确归位')
{
  const r = feed([
    // 思考阶段：-1 指向 THINK
    { p: 'response/fragments/-1/reasoning_content', o: 'APPEND', v: '用户' },
    { v: '问真假的' },
    { v: '，是在质疑' },
    { v: '我列出的工具清单' },
    // 正文阶段：-1 指向 RESPONSE（同一个下标，类型被更新）
    { p: 'response/fragments/-1/content', o: 'APPEND', v: '真的。' },
    { v: '刚这条' },
  ])
  console.log(`       think=${JSON.stringify(r.think)}`)
  console.log(`       text=${JSON.stringify(r.text)}`)
  check('⭐ 思考完整', r.think, '用户问真假的，是在质疑我列出的工具清单')
  check('⭐ 正文干净（不含思考内容）', r.text, '真的。刚这条')
}

console.log('\n[5] ⭐⭐ 修复验证：`-1` 路径帧 + 裸增量（真实帧形态）')
{
  /**
   * 这是**网页端真实的帧形态**：
   *   - 思考开始时：`response/fragments/-1/reasoning_content` APPEND 「用户」
   *   - 之后思考的裸增量：没有 p
   *   - 正文开始时：`response/fragments/-1/content` APPEND 「真的。」
   *   - 之后正文的裸增量：没有 p
   *
   * 修复前：裸增量一律进 text ⇒ think 只有「用户」
   * 修复后：按当前 fragment 类型分流 ⇒ think 完整
   */
  const r = feed([
    { p: 'response/fragments/-1/reasoning_content', o: 'APPEND', v: '用户' },
    { v: '问真假的' },
    { v: '，是在质疑' },
    { v: '我列出的工具清单' },
    { p: 'response/fragments/-1/content', o: 'APPEND', v: '真的。' },
    { v: '刚这条' },
  ])
  console.log(`       think=${JSON.stringify(r.think)}`)
  console.log(`       text=${JSON.stringify(r.text)}`)
  check('⭐ 思考完整（不再截断）', r.think, '用户问真假的，是在质疑我列出的工具清单')
  check('⭐ 正文不含思考内容', r.text, '真的。刚这条')
}

console.log('\n[6] ⭐⭐ 修复验证：工具围栏不再丢开头')
{
  /**
   * 工具调用时的真实形态：
   *   - `response/fragments/-1/content` APPEND 「```」← 开围栏
   *   - 裸增量接 `ldw`、换行、代码…
   *
   * 修复前：首帧「```」进 text，但后续裸增量**也进 text** —— 顺序是对的，
   * 那为什么会丢？因为**思考阶段的裸增量先污染了 text**，
   * 且首帧的「```」可能被当成 THINK 阶段的一部分。
   *
   * 修复后：按类型分流，围栏完整。
   */
  const r = feed([
    // 思考阶段
    { p: 'response/fragments/-1/reasoning_content', o: 'APPEND', v: '我要调工具' },
    { v: '验证一下' },
    // 正文阶段（含工具围栏）
    { p: 'response/fragments/-1/content', o: 'APPEND', v: '```' },
    { v: 'ldw' },
    { v: '\nconst r = await pwsh(' },
    { v: '{"command":"Get-Date"}' },
    { v: ');\nlog(r);\n' },
    { v: '```' },
  ])
  console.log(`       text=${JSON.stringify(r.text)}`)
  check('⭐ 围栏开头完整', r.text.startsWith('```ldw'), true)
  check('⭐ 围栏结尾完整', r.text.endsWith('```'), true)
  check('⭐ 思考与正文分离', r.think, '我要调工具验证一下')
  check('⭐ 思考没污染正文', r.text.includes('我要调工具'), false)
}

console.log('\n[7] 快照重建类型表（重复快照不能让表越堆越长）')
{
  const r = feed([
    { p: 'response/fragments/-1/reasoning_content', o: 'APPEND', v: '思考一' },
    { v: '思考二' },
    // 完整快照：THINK + RESPONSE
    { v: { response: { fragments: [{ type: 'THINK', content: '思考一思考二' }, { type: 'RESPONSE', content: '正文' }] } } },
    // 快照后的裸增量应归给最后一个 fragment（RESPONSE）
    { v: '继续正文' },
  ])
  console.log(`       think=${JSON.stringify(r.think)}  text=${JSON.stringify(r.text)}`)
  check('快照后思考正确', r.think, '思考一思考二')
  check('⭐ 快照后裸增量归 RESPONSE', r.text, '正文继续正文')
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
