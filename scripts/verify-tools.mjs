#!/usr/bin/env node
/**
 * 工具调用协议测试 —— 用**实测的真实形状**做回归。
 *
 * ## 事实来源（都是实测，不是推测）
 *
 * 1. **DSH 的块契约**（`dsh-llm/lib/typert.host.js` 的类型声明）：
 *    `ToolCallBlock { type:'tool-call'; id; name; arguments }`，
 *    `arguments` 是 **JSON 字符串**。
 * 2. **真实会话消息形状**（解压 `~/.dsh/sessions/*.jsonl.zstd`，分帧 zstd）：
 *    - `tool-call` 是 assistant content 里的块
 *    - **`tool-result` 是 `role:'tool'` 的独立消息**（不是 content block！）
 * 3. **cuckoo 的协议**（`src/prompt/deepseek.md`）：
 *    ```ldw 代码块 + 「多行文本用反引号，不做任何转义」
 *
 * ## 验证什么
 *
 * - 工具目录格式（cuckoo 的「`name(签名)` — 首句」）
 * - 协议指令（含「不要输出 JSON」「不做转义」）
 * - 序列化：tool-call 块 / role:tool 消息 → 文本
 * - 解析：```ldw 块 → tool-call（含各种走样参数的修复）
 * - 代码块**不泄漏**到正文
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = dirname(dirname(fileURLToPath(import.meta.url)))
const bundle = readFileSync(join(SRC, 'lib', 'index.js'), 'utf8')

/**
 * 从产物抠出一个**自包含**的函数源码。
 *
 * 难点：产物里的函数会互相引用（`parseToolCalls` 用 `repairJsonObject` /
 * `balancedParens` / `positionalToObject`），也可能引用模块级常量。
 * 无脑全带会拉进无关的连锁依赖（`DEFAULT_PROVIDER_ID = DEEPSEEK.id` ⇒ `DEEPSEEK`…），
 * 所以按**传递闭包**收集：从目标函数出发，只带它真正引用到的函数与常量。
 */
function extractClosure(bundle, entryName) {
  // 索引所有函数与**模块级**常量
  //
  // ⚠️ 常量必须限定在模块级。靠缩进判断**不可靠** —— 产物里模块级与
  // 函数体内部都用 1 个 tab。若用宽松匹配，局部 const
  // （`const params = tool.parameters;`）会被当成模块级常量收进来，
  // 拼出的源码就变成「函数外引用局部变量」
  // ⇒ `ReferenceError: tool is not defined`（踩过）。
  //
  // 精确判据：常量的偏移**不落在任何函数区间内**。
  const fnRe = /^[ \t]*(?:function\s+([A-Za-z_$][\w$]*)\s*\(|(?:var|const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*function)/gm
  const constRe = /^[ \t]*const ([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+);/gm

  /**
   * 抠出一段完整源码。
   *
   * ⚠️ **不能用花括号配对**：函数体里有字符串字面量含花括号
   * （`repairJsonObject` 里就有 `'{'`、`'}'`），配对会提前结束，
   * 算出的区间偏小 ⇒ 常量归属判断出错（踩过）。
   *
   * 改用**编译验证**：从「下一个顶层声明」的偏移作为候选结束点，
   * 能编译通过就采用。产物是格式化过的，顶层声明总在行首，所以可靠。
   */
  const slice = (start) => {
    // 找下一个顶层声明的位置作为候选边界
    const rest = bundle.slice(start)
    const nextDecl = rest.slice(1).search(/\n(?:function |const |var |\/\/#endregion)/)
    const end = nextDecl < 0 ? bundle.length : start + 1 + nextDecl
    // 从后往前退，找到第一个能编译通过的结束点
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
    return null
  }

  // 索引所有函数，并记下它们的字符区间
  const fns = new Map()
  const fnRanges = []
  for (const m of bundle.matchAll(fnRe)) {
    const name = m[1] ?? m[2]
    const src = slice(m.index)
    if (src === null) continue
    fnRanges.push([m.index, m.index + src.length])
    if (name !== undefined && !fns.has(name)) fns.set(name, src)
  }

  /** 常量是否在模块级：偏移不落在任何函数区间内。 */
  const inAnyFunction = (offset) => fnRanges.some(([a, b]) => offset >= a && offset < b)

  const consts = new Map()
  for (const m of bundle.matchAll(constRe)) {
    if (inAnyFunction(m.index)) continue
    if (!consts.has(m[1])) consts.set(m[1], `const ${m[1]} = ${m[2]};`)
  }

  /**
   * 多行常量（如 `TOOL_PROTOCOL` 是 `.join('\n')` 的数组）。
   *
   * 单行正则抓不到它们，但函数会引用 —— 缺了就是 `X is not defined`。
   * 用编译验证从声明处往后找第一个能编译的结束点。
   */
  for (const m of bundle.matchAll(/^[ \t]*const ([A-Za-z_$][\w$]*)\s*=/gm)) {
    if (consts.has(m[1])) continue
    if (inAnyFunction(m.index)) continue
    const rest = bundle.slice(m.index)
    const nextDecl = rest.slice(1).search(/\n(?:function |const |var |\/\/#endregion)/)
    const end = nextDecl < 0 ? bundle.length : m.index + 1 + nextDecl
    for (let e = end; e > m.index; e -= 1) {
      if (bundle[e - 1] !== ';') continue
      const src = bundle.slice(m.index, e)
      try {
        // eslint-disable-next-line no-new-func
        new Function(`${src}\n; return ${m[1]};`)
        consts.set(m[1], src)
        break
      } catch {
        /* 继续退 */
      }
    }
  }

  // 传递闭包
  const needFns = new Set()
  const needConsts = new Set()
  const visit = (src) => {
    for (const [n] of fns) {
      if (needFns.has(n)) continue
      // 排除「自己声明自己」的误判
      if (!new RegExp(`(?<![.\\w$])${n}\\s*\\(`).test(src)) continue
      needFns.add(n)
      visit(fns.get(n))
    }
    for (const [n, line] of consts) {
      if (needConsts.has(n)) continue
      if (!new RegExp(`\\b${n}\\b`).test(src)) continue
      needConsts.add(n)
      visit(line)
    }
  }

  const entry = fns.get(entryName)
  if (entry === undefined) throw new Error(`产物里找不到函数 ${entryName}`)
  needFns.add(entryName)
  visit(entry)

  return [...needConsts].map((n) => consts.get(n)).join('\n') + '\n' + [...needFns].map((n) => fns.get(n)).join('\n')
}

const loadFn = (_b, _pat, nm) => {
  // eslint-disable-next-line no-new-func
  return new Function(`${extractClosure(bundle, nm)}; return ${nm};`)()
}

const buildToolSignature = loadFn(bundle, /function buildToolSignature\(/, 'buildToolSignature')
const buildToolCatalog = loadFn(bundle, /function buildToolCatalog\(/, 'buildToolCatalog')
const buildToolSection = loadFn(bundle, /function buildToolSection\(/, 'buildToolSection')
const buildPlatformInfo = loadFn(bundle, /function buildPlatformInfo\(/, 'buildPlatformInfo')
const parseToolCalls = loadFn(bundle, /function parseToolCalls\(/, 'parseToolCalls')
const serializeMessage = loadFn(bundle, /function serializeMessage\(/, 'serializeMessage')
const serializeMessages = loadFn(bundle, /function serializeMessages\(/, 'serializeMessages')

// TOOL_PROTOCOL 是模块级常量
const protoMatch = bundle.match(/const TOOL_PROTOCOL = (\[[\s\S]*?\])\.join/)
if (protoMatch === null) throw new Error('找不到 TOOL_PROTOCOL')
// eslint-disable-next-line no-new-func
const TOOL_PROTOCOL = new Function(`return ${protoMatch[1]}.join('\\n');`)()

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

/** 实测的工具 schema 样例（形状抄自 DSH 真实下发）。 */
const TOOLS = [
  {
    name: 'read',
    description: '读取文件内容。返回带行号的窗口，支持 offset/limit 分段读取大文件。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } },
      required: ['path'],
    },
  },
  {
    name: 'pwsh',
    description: '在 PowerShell 中执行命令。沙箱拒绝是策略判定，不要换个方式重试。',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  },
  { name: 'glob', description: '按路径模式查找文件。', parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } },
]

console.log('=== 工具调用协议测试 ===\n')

console.log('[1] 工具目录格式（抄 cuckoo 的「`name(签名)` — 首句」）')
{
  const sig = buildToolSignature(TOOLS[0])
  check('签名含必填参数', sig.includes('path: string'), true)
  check('签名含可选参数（带 ?）', sig.includes('offset?: number'), true)
  check('签名无参数时是 name()', buildToolSignature({ name: 'x', description: '', parameters: {} }), 'x()')

  const catalog = buildToolCatalog(TOOLS)
  const lines = catalog.split('\n')
  check('一行一个工具', lines.length, 3)
  check('编号从 1 开始', lines[0].startsWith('1. `read('), true)
  check('含破折号与描述', lines[0].includes('— 读取文件内容。'), true)
  check('描述取首句（不拖长尾）', lines[1].includes('— 在 PowerShell 中执行命令。'), true)
}

console.log('\n[2] 协议指令（核心：不做转义）')
{
  check('含 ```ldw 围栏', TOOL_PROTOCOL.includes('```ldw'), true)
  check('明确要求 JSON 对象参数', TOOL_PROTOCOL.includes('JSON 对象'), true)
  check('⭐ 明确禁止转义', /不要做任何转义/.test(TOOL_PROTOCOL), true)
  check('明确禁止 JSON 格式调用', TOOL_PROTOCOL.includes('不要输出 JSON 格式的工具调用'), true)
  check('禁止 XML/HTML 标记', TOOL_PROTOCOL.includes('XML/HTML'), true)
  check('一次只调一个', TOOL_PROTOCOL.includes('一次只调一个工具'), true)
  /**
   * 围栏名必须保持中性的 `ldw`。
   *
   * 它是**模型要原样输出的标记**，属于本插件自己的对外协议，
   * 不该带任何第三方项目名（用户明确要求过）。
   */
  check('⭐ 围栏名不含第三方项目名', /```(?!ldw)\w/.test(TOOL_PROTOCOL), false)
}

console.log('\n[3] 工具段体量（防封号：不能像 web-login 那样 5 万字符）')
{
  const section = buildToolSection(TOOLS)
  check('含协议', section.includes('工具调用协议'), true)
  check('含目录', section.includes('可用工具'), true)
  check('含运行环境（抄 cuckoo 的 buildPlatformInfo）', section.includes('运行环境'), true)
  check('运行环境说明命令差异', /bash|pwsh/i.test(section), true)
  // 实测：60 个工具 × 约 80 字符 ≈ 5000
  const sixtyTools = Array.from({ length: 60 }, (_, i) => ({
    name: `tool_${i}`,
    description: '这是一个工具，用来做某些事情。后面还有很多细节说明。',
    parameters: { type: 'object', properties: { arg: { type: 'string' } }, required: ['arg'] },
  }))
  const big = buildToolSection(sixtyTools)
  console.log(`       60 个工具的段长: ${big.length} 字符`)
  check('⭐ 60 个工具仍 < 8000 字符', big.length < 8000, true)
}

console.log('\n[3b] 平台信息：Windows 上必须说清 cmd/pwsh 差异（DSH 的 system 没给）')
{
  const win = buildPlatformInfo('win32', 'x64')
  check('标明 Windows', win.includes('Windows'), true)
  check('cmd.exe 语法', win.includes('cmd.exe'), true)
  check('PowerShell 语法', win.includes('PowerShell'), true)
  check('路径分隔符说明', win.includes('反斜杠'), true)

  const mac = buildPlatformInfo('darwin', 'arm64')
  check('macOS 用 zsh/bash', mac.includes('zsh'), true)
  const linux = buildPlatformInfo('linux', 'x64')
  check('Linux 用 bash', linux.includes('bash'), true)

  // ⚠️ 不能重复注入 DSH 已给的东西（体量 = 封号风险）
  const section = buildToolSection(TOOLS)
  check('⭐ 不重复注入项目目录（DSH system 已有）', /working directory is/i.test(section), false)
  check('⭐ 不重复注入身份（DSH system 已有）', section.includes('You are a'), false)
}

console.log('\n[4] 序列化：tool-call 块 → 文本（用实测形状）')
{
  // 实测形状：assistant content 里的 tool-call，arguments 是 JSON 字符串
  const msg = {
    role: 'assistant',
    content: [
      { type: 'reasoning', text: '我需要读文件' },
      { type: 'text', text: '让我看看。' },
      {
        type: 'tool-call',
        id: 'call_00_DU94v2FIc3IDW0XHJaYO9351',
        name: 'read_image',
        arguments: '{"file_path":"C:\\\\Users\\\\29436\\\\.dsh\\\\x.png"}',
      },
    ],
  }
  const s = serializeMessage(msg)
  check('含角色标签', s.startsWith('## Assistant'), true)
  check('含正文', s.includes('让我看看。'), true)
  check('含 cuckoo 代码块（还原当时形态）', s.includes('```ldw'), true)
  check('含 await 调用', s.includes('await read_image('), true)
  check('⭐ reasoning 不回灌（只给 DSH 展示）', s.includes('我需要读文件'), false)
}

console.log('\n[5] 序列化：role:tool 消息 → 文本（实测：不是 content block！）')
{
  const msg = {
    role: 'tool',
    toolCallId: 'call_00_DU94v2FIc3IDW0XHJaYO9351',
    content: [{ type: 'text', text: '<path>C:\\x.png</path>\n<type>image</type>' }],
    isError: false,
  }
  const s = serializeMessage(msg)
  check('含工具结果标记', s.includes('【工具结果】'), true)
  check('含内容', s.includes('<path>'), true)

  const err = serializeMessage({ ...msg, isError: true })
  check('失败时标记出来', err.includes('（失败）'), true)
}

console.log('\n[6] 序列化：超长工具结果被截断（防体量爆炸）')
{
  const huge = 'x'.repeat(10000)
  const s = serializeMessage({ role: 'tool', content: [{ type: 'text', text: huge }] })
  check('被截断', s.length < 6000, true)
  check('说明截断原因', s.includes('已截断'), true)
}

console.log('\n[7] 解析：标准 cuckoo 代码块')
{
  const reply = '好的，我来读文件。\n\n```ldw\nconst r = await read({"path": "src/index.ts"});\nlog(r);\n```\n'
  const r = parseToolCalls(reply, TOOLS)
  check('解析出 1 个调用', r.calls.length, 1)
  check('工具名正确', r.calls[0].name, 'read')
  // 断言「语义等价」而不是字符串精确匹配 —— JSON 里的空格无关紧要
  check('参数可 JSON 解析', JSON.parse(r.calls[0].arguments).path, 'src/index.ts')
  check('⭐ 代码块不进正文', r.text.includes('await read'), false)
  check('正文保留', r.text.includes('好的，我来读文件。'), true)
}

console.log('\n[8] 解析：参数走样时的修复（模型常见四种）')
{
  // ① 键没加引号
  const r1 = parseToolCalls('```ldw\nawait read({path: "a.ts"});\n```', TOOLS)
  check('裸键被修复', JSON.parse(r1.calls[0]?.arguments ?? '{}').path, 'a.ts')

  // ② 单引号
  const r2 = parseToolCalls("```ldw\nawait read({'path': 'b.ts'});\n```", TOOLS)
  check('单引号被修复', JSON.parse(r2.calls[0]?.arguments ?? '{}').path, 'b.ts')

  // ③ 尾逗号
  const r3 = parseToolCalls('```ldw\nawait read({"path": "c.ts",});\n```', TOOLS)
  check('尾逗号被修复', JSON.parse(r3.calls[0]?.arguments ?? '{}').path, 'c.ts')

  // ④ 位置参数（schema 属性顺序兜底）
  const r4 = parseToolCalls('```ldw\nawait read("d.ts");\n```', TOOLS)
  check('位置参数按 schema 映射', JSON.parse(r4.calls[0]?.arguments ?? '{}').path, 'd.ts')
}

console.log('\n[9] 解析：多行文本（cuckoo 的模板字符串，不做转义）')
{
  const reply = '```ldw\nawait pwsh({"command": `Get-ChildItem\nWrite-Output "done"`});\n```'
  const r = parseToolCalls(reply, TOOLS)
  check('多行命令能解析', r.calls.length, 1)
  check('含真实换行（未被转义破坏）', r.calls[0]?.arguments.includes('Get-ChildItem'), true)
}

console.log('\n[10] 解析：非工具函数不误判（log / JSON 等）')
{
  const r = parseToolCalls('```ldw\nlog("hello");\nJSON.stringify({a:1});\n```', TOOLS)
  check('log 不被当成工具', r.calls.length, 0)
  check('未解析出调用时原文透出（不静默丢弃）', r.text.includes('log("hello")') || r.failed.length > 0, true)
}

console.log('\n[11] 解析：无代码块时原样返回')
{
  const r = parseToolCalls('就是普通回答，没有工具调用。', TOOLS)
  check('无调用', r.calls.length, 0)
  check('正文完整', r.text, '就是普通回答，没有工具调用。')
}

console.log('\n[12] 解析：一次多个调用（批量）')
{
  const reply = '```ldw\nawait glob({"pattern": "*.ts"});\nawait read({"path": "a.ts"});\n```'
  const r = parseToolCalls(reply, TOOLS)
  check('解析出 2 个', r.calls.length, 2)
  check('顺序正确', r.calls.map((c) => c.name).join(','), 'glob,read')
}

console.log('\n[13] 序列化往返：工具调用历史 → 文本 → 模型能看懂')
{
  const msgs = [
    { role: 'user', content: [{ type: 'text', text: '读一下 a.ts' }] },
    {
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"path":"a.ts"}' }],
    },
    { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: '文件内容在这里' }], isError: false },
  ]
  const s = serializeMessages(msgs)
  check('含用户消息', s.includes('## User') && s.includes('读一下 a.ts'), true)
  check('含调用还原', s.includes('```ldw') && s.includes('await read('), true)
  check('含工具结果', s.includes('【工具结果】') && s.includes('文件内容在这里'), true)
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
process.exitCode = fail === 0 ? 0 : 1
