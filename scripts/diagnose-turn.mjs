#!/usr/bin/env node
/**
 * 诊断：LDW 那一轮到底发生了什么。
 *
 * ## 要回答的问题（截图看到三个症状）
 *
 * 1. DSH 的对话区把工具调用**当正文显示**了（`ldw const r = await pwsh(...)`）
 *    ⇒ 解析器没把它转成 tool-call，泄漏成了文本
 * 2. 网页版里用户消息显示成 `## User` + 内容
 *    ⇒ 我们的序列化表头漏进了网页对话，看起来像转写稿而不是聊天
 * 3. 网页版显示「已思考（用时 1 秒）」，但 DSH 对话区**没有**思考块
 *    ⇒ 要么提取失败，要么 reasoning 没发出去
 *
 * 这个脚本读会话文件（分帧 zstd），把那一轮的真实内容打出来。
 *
 * 用法：node scripts/diagnose-turn.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { join } from 'node:path'
import { homedir } from 'node:os'

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')

/** 找最近改动的会话文件。 */
function findLatestSessions(limit = 3) {
  const root = join(DSH_HOME, 'sessions')
  const out = []
  const walk = (dir, depth = 0) => {
    if (depth > 3) return
    let names
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const n of names) {
      const p = join(dir, n)
      let st
      try {
        st = statSync(p)
      } catch {
        continue
      }
      if (st.isDirectory()) walk(p, depth + 1)
      else if (n.endsWith('.zstd')) out.push({ path: p, size: st.size, mtime: st.mtimeMs })
    }
  }
  walk(root)
  out.sort((a, b) => b.mtime - a.mtime)
  return out.slice(0, limit)
}

/** 分帧 zstd 解压（每行一个 zstd 帧）。 */
function decode(file) {
  const raw = readFileSync(file)
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const offsets = []
  let i = 0
  while (i < raw.length - 4) {
    const idx = raw.indexOf(MAGIC, i)
    if (idx < 0) break
    offsets.push(idx)
    i = idx + 4
  }
  let out = ''
  for (let k = 0; k < offsets.length; k += 1) {
    const end = k + 1 < offsets.length ? offsets[k + 1] : raw.length
    try {
      out += zstdDecompressSync(raw.subarray(offsets[k], end)).toString('utf8')
    } catch {
      /* 坏帧跳过 */
    }
  }
  return out
}

console.log('=== LDW 那一轮的真实数据 ===\n')

const files = findLatestSessions(3)
if (files.length === 0) {
  console.log('没找到会话文件')
  process.exit(1)
}
for (const f of files) {
  console.log(`  ${new Date(f.mtime).toLocaleString()}  ${(f.size / 1024).toFixed(0)}KB  ${f.path.split(/[\\/]/).slice(-2)[0]}`)
}

const latest = files[0]
console.log(`\n[1] 分析最近的会话：${latest.path.split(/[\\/]/).slice(-2)[0]}\n`)

const text = decode(latest.path)
const lines = text.split('\n').filter((l) => l.trim() !== '')
console.log(`    解压 ${text.length} 字符，${lines.length} 行\n`)

/** 收集消息事件。 */
const events = []
for (const line of lines) {
  let o
  try {
    o = JSON.parse(line)
  } catch {
    continue
  }
  const msg = o?.data?.message
  if (msg === undefined) continue
  events.push({ type: o.type, turn: o.data?.turn, step: o.data?.step, msg })
}

console.log(`[2] 消息事件 ${events.length} 条，看最后 8 条\n`)

const tail = events.slice(-8)
for (const ev of tail) {
  const m = ev.msg
  const blocks = Array.isArray(m.content) ? m.content : []
  console.log(`--- ${ev.type}  turn=${ev.turn} step=${ev.step}  role=${m.role}`)
  if (m.role === 'tool') {
    const body = blocks.map((b) => (typeof b.text === 'string' ? b.text : `[${b.type}]`)).join('')
    console.log(`    工具结果 (${body.length} 字符): ${JSON.stringify(body.slice(0, 160))}`)
    continue
  }
  for (const b of blocks) {
    const t = b.type
    if (t === 'text') {
      const s = String(b.text ?? '')
      console.log(`    text (${s.length} 字符):`)
      console.log('      ' + JSON.stringify(s.slice(0, 400)))
      /** 关键：看有没有围栏泄漏。 */
      if (s.includes('```')) {
        console.log('      ⚠️ 含 ``` 围栏 —— 未解析成 tool-call！')
        const idx = s.indexOf('```')
        console.log('      围栏附近: ' + JSON.stringify(s.slice(Math.max(0, idx - 40), idx + 120)))
      }
      if (/await\s+\w+\s*\(/.test(s)) {
        console.log('      ⚠️ 含 await 调用 —— 但没成为 tool-call')
      }
    } else if (t === 'reasoning') {
      const s = String(b.text ?? '')
      console.log(`    ⭐ reasoning (${s.length} 字符): ${JSON.stringify(s.slice(0, 200))}`)
    } else if (t === 'tool-call') {
      console.log(`    ✅ tool-call: name=${b.name} args=${String(b.arguments).slice(0, 120)}`)
    } else {
      console.log(`    ${t}: ${JSON.stringify(b).slice(0, 150)}`)
    }
  }
}

/** 统计这一会话里的块类型分布。 */
const dist = new Map()
for (const ev of events) {
  const blocks = Array.isArray(ev.msg.content) ? ev.msg.content : []
  for (const b of blocks) {
    const k = `${ev.msg.role}/${b.type}`
    dist.set(k, (dist.get(k) ?? 0) + 1)
  }
}
console.log('\n[3] 全会话块类型分布')
for (const [k, v] of [...dist].sort((a, b) => b[1] - a[1])) console.log(`    ${String(v).padStart(5)}  ${k}`)

/** 找带围栏的 assistant 文本（泄漏的证据）。 */
console.log('\n[4] 所有含 ``` 的 assistant 文本（泄漏证据）')
let leaked = 0
for (const ev of events) {
  if (ev.msg.role !== 'assistant') continue
  const blocks = Array.isArray(ev.msg.content) ? ev.msg.content : []
  for (const b of blocks) {
    if (b.type !== 'text') continue
    const s = String(b.text ?? '')
    if (!s.includes('```')) continue
    leaked += 1
    if (leaked <= 3) {
      console.log(`    --- turn=${ev.turn} step=${ev.step} (${s.length} 字符)`)
      console.log('    ' + JSON.stringify(s.slice(0, 300)))
    }
  }
}
console.log(`    共 ${leaked} 处`)

/** 找含「## User」的文本（序列化泄漏）。 */
console.log('\n[5] 含 "## User" / "## Assistant" 的文本')
let hdr = 0
for (const ev of events) {
  const blocks = Array.isArray(ev.msg.content) ? ev.msg.content : []
  for (const b of blocks) {
    const s = String(b.text ?? '')
    if (s.includes('## User') || s.includes('## Assistant')) hdr += 1
  }
}
console.log(`    共 ${hdr} 处（这些是发到网页版的文本 —— 会显示在网页对话里）`)

/** 找工具目录（确认 tools 是否下发过）。 */
console.log('\n[6] 有没有下发过工具目录')
let catalog = 0
for (const ev of events) {
  const blocks = Array.isArray(ev.msg.content) ? ev.msg.content : []
  for (const b of blocks) {
    const s = String(b.text ?? '')
    if (s.includes('工具调用协议') || s.includes('可用工具')) catalog += 1
  }
}
console.log(`    含「工具调用协议 / 可用工具」的块: ${catalog} 个`)
console.log('    （注意：工具目录只发到网页版，不在 DSH 会话里 —— 这里为 0 是正常的）')
