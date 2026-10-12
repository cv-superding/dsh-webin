#!/usr/bin/env node
/**
 * **技能 / MCP / 斜杠命令支持** 测试。
 *
 * ## 用户问的
 *
 * 「怎么还用不了 dsh 的斜杠命令呢？？估计 skill 和 mcp 估计也不支持，你都加上！！」
 *
 * ## 实情：三者**本来就支持**，它们不是三条独立的通道
 *
 * 查清 DSH 的机制后（`dsh-llm/lib/index.js` 的 `projectToolUpdates`）：
 *
 *   - **普通工具、skill、MCP 工具** 全部经 `options.tools` 到达适配器。
 *     `deferLoading`（skill/MCP 常用的延迟加载标记）只影响
 *     **`developer` 消息里的 tool-addition 记账**，工具本身照旧在
 *     `tools` 数组里传下来（源码第 788-793 行：`immediateTools = tools`
 *     只是去掉 `deferLoading` 字段）。
 *     我们的 `buildToolSection` 遍历整个数组 ⇒ **自动全都有**。
 *
 *   - **斜杠命令** 在 DSH 侧**就已经展开**成提示词了。适配器收到
 *     `options.messages` 时它已经是普通文本 —— 不存在「不支持」的问题。
 *
 * 所以「用不了」的真正原因是**填充失败**（`native-setter-noop`），
 * 那一轮根本没发出去。见 `verify-fill.mjs`。
 *
 * 这个测试的价值：把「本来就支持」这件事**钉住**，防止将来有人
 * 改动工具目录逻辑时把 skill / MCP 漏掉（比如只认某类名字前缀）。
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

console.log('=== 技能 / MCP / 斜杠命令支持测试 ===\n')

const bundle = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')

/** 从产物里抠函数源码（花括号配对）。 */
function extract(name) {
  const m = bundle.match(new RegExp(`function ${name}\\(`))
  if (m === null) return ''
  const open = bundle.indexOf('{', m.index)
  let depth = 0
  for (let i = open; i < bundle.length; i += 1) {
    if (bundle[i] === '{') depth += 1
    else if (bundle[i] === '}') {
      depth -= 1
      if (depth === 0) return bundle.slice(m.index, i + 1)
    }
  }
  return ''
}

const src = ['buildToolCatalog', 'buildToolSection', 'firstSentence', 'buildToolSignature', 'positionalToObject']
  .map(extract)
  .filter((s) => s !== '')
  .join('\n')

const { buildToolSection } = new Function(
  `const TOOL_PROTOCOL = 'PROTOCOL'; const TAIL_DESC_CHARS = 80;
   function buildPlatformInfo() { return 'PLATFORM'; }
   ${src}; return { buildToolSection };`,
)()

console.log('[1] ⭐ 技能（skill）工具会进目录')
{
  const section = buildToolSection(
    [
      { name: 'pwsh', description: 'Run a PowerShell command.' },
      {
        name: 'skill',
        description: 'Load the full instructions for a skill. Call it before acting on a task that names a skill.',
      },
    ],
    'win32',
    'x64',
  )
  check('⭐ skill 在目录里', section.includes('skill'), true)
  check('⭐ skill 的参数签名也列了', /skill\(/.test(section), true)
  check('skill 的说明被带上了', /instructions for a skill/.test(section), true)
}

console.log('\n[2] ⭐ MCP 工具会进目录（带命名空间前缀也一样）')
{
  const section = buildToolSection(
    [
      { name: 'mcp__github__create_issue', description: 'Create an issue in a GitHub repository via MCP.' },
      { name: 'mcp__filesystem__read_file', description: 'Read a file through the filesystem MCP server.' },
    ],
    'win32',
    'x64',
  )
  check('⭐ mcp__ 前缀工具在目录里', section.includes('mcp__github__create_issue'), true)
  check('⭐ 第二个 MCP 工具也在', section.includes('mcp__filesystem__read_file'), true)
  check('MCP 说明被带上', /via MCP/.test(section), true)
}

console.log('\n[3] ⭐ 三类工具混在一起都要在（不能只认某一类）')
{
  const tools = [
    { name: 'pwsh', description: 'Run a PowerShell command.' },
    { name: 'skill', description: 'Load the full instructions for a skill.' },
    { name: 'mcp__github__create_issue', description: 'Create an issue via MCP.' },
    { name: 'read', description: 'Read a UTF-8 text file.' },
    { name: 'edit', description: 'Edit an existing UTF-8 text file.' },
  ]
  const section = buildToolSection(tools, 'win32', 'x64')
  const missing = tools.filter((t) => !section.includes(t.name)).map((t) => t.name)
  check('⭐ 一个都没漏', missing, [])
  /** 序号连续 = 没有中途丢弃。 */
  check('目录条数正确', (section.match(/^\d+\. /gm) ?? []).length, tools.length)
}

console.log('\n[4] ⭐ 工具数量多的时候不能截断（skill/MCP 会让工具变多）')
{
  /** 模拟真实规模：内置工具 + 一批 skill + 一批 MCP。 */
  const tools = []
  for (let i = 0; i < 30; i += 1) tools.push({ name: `builtin_${i}`, description: `Built-in tool ${i}.` })
  for (let i = 0; i < 20; i += 1) tools.push({ name: `skill_${i}`, description: `Skill ${i} instructions.` })
  for (let i = 0; i < 40; i += 1) {
    tools.push({ name: `mcp__srv${i}__op`, description: `MCP operation ${i}.` })
  }
  const section = buildToolSection(tools, 'win32', 'x64')
  const missing = tools.filter((t) => !section.includes(t.name)).map((t) => t.name)
  check(`全部 ${tools.length} 个工具都在`, missing, [])

  /** 最后一个也要在 —— 证明没有「只取前 N 个」。 */
  check('⭐ 最后一个 MCP 工具也在', section.includes('mcp__srv39__op'), true)
}

console.log('\n[5] 目录里每个工具都有签名行（不是只有名字罗列）')
{
  const section = buildToolSection(
    [
      { name: 'skill', description: 'Load skill instructions.' },
      { name: 'mcp__x__y', description: 'MCP op.' },
    ],
    'win32',
    'x64',
  )
  check('skill 有签名行', /^\d+\. `skill\(/m.test(section), true)
  check('MCP 有签名行', /^\d+\. `mcp__x__y\(/m.test(section), true)
}

console.log('\n[6] 无工具时不出目录（不做无用注入）')
{
  check('空数组 ⇒ 空串', buildToolSection([], 'win32', 'x64'), '')
  check('没有「# 可用工具」标题', buildToolSection([], 'win32', 'x64').includes('# 可用工具'), false)
}

console.log('\n[7] ⭐ 适配器遍历整个 tools 数组（不按名字过滤）')
{
  const adapter = readFileSync(join(ROOT, 'src', 'host', 'adapter.ts'), 'utf8')
  /**
   * 关键：必须是 `[...(options.tools ?? [])]` 这种**全量透传**。
   * 如果将来有人加 `.filter(t => t.name.startsWith('pwsh'))` 之类的过滤，
   * skill / MCP 就会被悄悄丢掉 —— 这条断言挡住那种改动。
   */
  check('⭐ 全量透传 tools', /buildToolSection\(\[\.\.\.\(options\.tools \?\? \[\]\)\]\)/.test(adapter), true)
  check('⭐ 没有按名字过滤工具', /tools[\s\S]{0,80}\.filter\(/.test(adapter), false)
}

console.log('\n[8] ⭐ 斜杠命令：DSH 侧已展开，适配器收到的是普通文本')
{
  const adapter = readFileSync(join(ROOT, 'src', 'host', 'adapter.ts'), 'utf8')
  /**
   * 斜杠命令不存在「适配器支不支持」的问题 —— 它在 DSH 的命令层就
   * 展开成 user 消息了。适配器只需要把 `options.messages` 序列化出去。
   *
   * 这条断言确认适配器**不**对消息内容做任何按前缀的丢弃
   * （比如「以 / 开头的跳过」那种会把命令吃掉的逻辑）。
   */
  check('⭐ 没有按 "/" 前缀丢弃消息', /startsWith\(['"]\/['"]\)[\s\S]{0,60}continue/.test(adapter), false)
  check('序列化走 messages 全量', /serializeMessages\(/.test(adapter) || /diffPrompt\(/.test(adapter), true)
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
process.exitCode = fail === 0 ? 0 : 1
