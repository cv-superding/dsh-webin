#!/usr/bin/env node
/**
 * 探针：把 DSH 真正交给 adapter 的 `tools` 与消息形状 dump 出来。
 *
 * ## 为什么需要
 *
 * 要实现工具调用，必须先知道 DSH 到底下发什么：
 *   - `options.tools` 的字段（name / description / parameters 的 JSON Schema 形状）
 *   - 有多少个工具、描述总长度多少（决定 prompt 体量，与封号风险相关）
 *   - `messages` 里 tool-call / tool-result 的**真实块形状**
 *     （类型名、字段名、id 怎么关联）
 *
 * 猜错字段名 = 工具调用永远不工作。所以先 dump 真货。
 *
 * ## 做法
 *
 * 注册一个**临时 adapter**（provider 名 `webin-probe`），它把收到的 options
 * 原样存下来，然后返回一个空的 stop 流。随后通过 DSH 的 llm 服务触发一次调用。
 *
 * ⚠️ 但 adapter 是被 agent loop 调用的，外部触发不了。所以改用**直接读**
 * DSH 的 session 数据：从 `~/.dsh/sessions/` 里找带工具调用的会话，
 * dump 它的消息结构 —— 那正是 DSH 会交给 adapter 的东西。
 *
 * 用法：node scripts/probe-tools.mjs
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')

/** 递归找所有 json/jsonl 会话文件。 */
function findSessionFiles(root, out = [], depth = 0) {
  if (depth > 4 || !existsSync(root)) return out
  for (const name of readdirSync(root)) {
    const p = join(root, name)
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (st.isDirectory()) findSessionFiles(p, out, depth + 1)
    else if (/\.(json|jsonl)$/.test(name) && st.size > 200) out.push({ path: p, size: st.size, mtime: st.mtimeMs })
  }
  return out
}

console.log('=== DSH 工具与消息形状探针 ===\n')

// ---- 1) 找会话文件 ----
const roots = [join(DSH_HOME, 'sessions'), join(DSH_HOME, 'projects'), join(DSH_HOME, 'storage')]
let files = []
for (const r of roots) files = files.concat(findSessionFiles(r))
files.sort((a, b) => b.mtime - a.mtime)
console.log(`[1] 会话文件: 找到 ${files.length} 个（按修改时间排序）`)
files.slice(0, 5).forEach((f) => console.log(`    ${(f.size / 1024).toFixed(0)}KB  ${f.path}`))

// ---- 2) 找带工具调用的消息 ----
console.log('\n[2] 扫描带工具调用的消息结构')
let toolCallSample = null
let toolResultSample = null
let toolSchemaSample = null
let scanned = 0

for (const f of files.slice(0, 40)) {
  let text
  try {
    text = readFileSync(f.path, 'utf8')
  } catch {
    continue
  }
  scanned += 1
  // 逐行找（jsonl）或整体找（json）
  const lines = text.split('\n')
  for (const line of lines) {
    if (line.length < 20) continue
    if (toolCallSample === null && line.includes('tool-call')) {
      try {
        const obj = JSON.parse(line)
        toolCallSample = { file: f.path, obj }
      } catch {
        /* 不是单行 JSON */
      }
    }
    if (toolResultSample === null && line.includes('"tool-result"')) {
      try {
        const obj = JSON.parse(line)
        toolResultSample = { file: f.path, obj }
      } catch {
        /* ignore */
      }
    }
  }
  if (toolCallSample && toolResultSample) break
}

console.log(`    扫描了 ${scanned} 个文件`)

/** 深度查找指定 key 的第一次出现。 */
function findKey(obj, key, depth = 0, path = '') {
  if (depth > 8 || obj === null || typeof obj !== 'object') return null
  if (Array.isArray(obj)) {
    for (let i = 0; i < Math.min(obj.length, 50); i += 1) {
      const r = findKey(obj[i], key, depth + 1, `${path}[${i}]`)
      if (r !== null) return r
    }
    return null
  }
  if (Object.prototype.hasOwnProperty.call(obj, key)) return { value: obj[key], path: `${path}.${key}` }
  for (const k of Object.keys(obj)) {
    const r = findKey(obj[k], key, depth + 1, `${path}.${k}`)
    if (r !== null) return r
  }
  return null
}

if (toolCallSample !== null) {
  const blk = findKey(toolCallSample.obj, 'tool-call')
  console.log(`\n    找到 tool-call 块（${toolCallSample.file.split(/[\\/]/).pop()}）`)
  console.log(`    路径: ${blk?.path}`)
  console.log(`    内容: ${JSON.stringify(blk?.value)?.slice(0, 400)}`)
} else {
  console.log('\n    ⚠️ 没找到 tool-call 块（可能这个会话没用过工具）')
}

if (toolResultSample !== null) {
  const blk = findKey(toolResultSample.obj, 'tool-result')
  console.log(`\n    找到 tool-result 块（${toolResultSample.file.split(/[\\/]/).pop()}）`)
  console.log(`    路径: ${blk?.path}`)
  console.log(`    内容: ${JSON.stringify(blk?.value)?.slice(0, 400)}`)
} else {
  console.log('\n    ⚠️ 没找到 tool-result 块')
}

// ---- 3) 工具 schema：从 DSH 的工具注册表读 ----
console.log('\n[3] 工具目录（从 DSH 的 tool-registry 消息读）')
for (const f of files.slice(0, 40)) {
  let text
  try {
    text = readFileSync(f.path, 'utf8')
  } catch {
    continue
  }
  if (!text.includes('tool-registry')) continue
  for (const line of text.split('\n')) {
    if (!line.includes('tool-registry') || line.length < 50) continue
    try {
      const obj = JSON.parse(line)
      const blk = findKey(obj, 'tool-addition')
      if (blk !== null) {
        toolSchemaSample = blk.value
        console.log(`    找到 tool-addition（${f.path.split(/[\\/]/).pop()}）`)
        console.log(`    ${JSON.stringify(toolSchemaSample).slice(0, 600)}`)
        break
      }
    } catch {
      /* ignore */
    }
  }
  if (toolSchemaSample !== null) break
}
if (toolSchemaSample === null) console.log('    ⚠️ 没找到 tool-addition 块')

// ---- 4) 从 asar 读工具清单（最权威）----
console.log('\n[4] 从 DSH 内置工具清单统计（asar）')
console.log('    见 scripts/probe-tool-catalog.mjs（需要 asar 解析）')
