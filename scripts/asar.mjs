#!/usr/bin/env node
/**
 * 从 DSH 的 app.asar 里提取文件（只读，不修改安装目录）。
 *
 * 为什么需要：DSH 的客户端槽系统、compaction 后端、preset 组合等都在
 * `resources/app.asar` 里，是排查「插件为什么不生效」的第一手资料。
 * 装 asar CLI 没必要，asar 格式很简单，直接解析头部即可。
 *
 * 用法：
 *   node scripts/asar.mjs list <关键词>              # 按路径关键词列出文件
 *   node scripts/asar.mjs cat <asar内路径> [输出文件] # 提取一个文件（省略输出则打印）
 *
 * 例：
 *   node scripts/asar.mjs list compaction
 *   node scripts/asar.mjs cat /dsh/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js
 *
 * asar 头部格式（pickle）：
 *   前 16 字节 = 4 个 u32：
 *     [0] = 4（header size 字段自身宽度）
 *     [1] = header 对象总大小
 *     [2] = header 字符串大小
 *     [3] = JSON 大小
 *   JSON 从 offset 16 开始，长度 u32[3]；文件数据基址 = 8 + u32[1]，
 *   每个条目的 offset 相对该基址。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_ASAR = 'F:/AdobeAll/DeepSeekHarness/resources/app.asar'
const ASAR = process.env.DSH_ASAR ?? DEFAULT_ASAR

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

function openAsar(path) {
  const buf = readFileSync(path)
  const u = new Uint32Array(buf.buffer, buf.byteOffset, 4)
  const jsonSize = u[3]
  const baseOffset = 8 + u[1]
  const header = JSON.parse(buf.subarray(16, 16 + jsonSize).toString('utf8'))
  return { buf, header, baseOffset }
}

function walk(node, prefix = '', out = []) {
  for (const [name, child] of Object.entries(node.files ?? {})) {
    const p = `${prefix}/${name}`
    if (child.files !== undefined) walk(child, p, out)
    else out.push({ path: p, size: Number(child.size ?? 0), offset: Number(child.offset ?? 0) })
  }
  return out
}

function locate(header, asarPath) {
  let node = header
  for (const part of asarPath.split('/').filter((s) => s !== '')) {
    node = node.files?.[part]
    if (node === undefined) throw new Error(`asar 里没有这个路径：${asarPath}`)
  }
  if (node.files !== undefined) throw new Error(`这是一个目录，不是文件：${asarPath}`)
  return node
}

const [cmd, ...rest] = process.argv.slice(2)

if (cmd === 'list') {
  const keyword = (rest[0] ?? '').toLowerCase()
  const { header } = openAsar(ASAR)
  const all = walk(header)
  const hits = keyword === '' ? all : all.filter((f) => f.path.toLowerCase().includes(keyword))
  console.log(`asar: ${ASAR}`)
  console.log(`共 ${all.length} 个文件，匹配 "${rest[0] ?? ''}" 的 ${hits.length} 个：\n`)
  for (const f of hits.slice(0, 300)) console.log(`${String(f.size).padStart(9)}  ${f.path}`)
  if (hits.length > 300) console.log(`\n… 还有 ${hits.length - 300} 个未显示`)
} else if (cmd === 'cat') {
  const asarPath = rest[0]
  if (asarPath === undefined) {
    console.error('用法：node scripts/asar.mjs cat <asar内路径> [输出文件]')
    process.exitCode = 1
  } else {
    const { buf, header, baseOffset } = openAsar(ASAR)
    const entry = locate(header, asarPath)
    // ⚠️ asar 头里的 size/offset 是**字符串**，必须先转数字 ——
    // 否则 `baseOffset + entry.offset` 会变成字符串拼接，subarray 取到空区间。
    const start = baseOffset + Number(entry.offset)
    const size = Number(entry.size)
    const data = buf.subarray(start, start + size)
    if (data.length !== size) {
      throw new Error(`读取越界：期望 ${size} 字节，实际 ${data.length}（start=${start}）`)
    }
    const out = rest[1]
    if (out === undefined) process.stdout.write(data)
    else {
      const target = resolve(out)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, data)
      console.log(`已提取 ${data.length} 字节 → ${target}`)
    }
  }
} else {
  console.log(`用法：
  node scripts/asar.mjs list [关键词]              按路径关键词列出文件
  node scripts/asar.mjs cat <asar内路径> [输出文件]  提取一个文件

环境变量 DSH_ASAR 可覆盖 asar 路径（默认 ${DEFAULT_ASAR}）
当前工作目录：${ROOT}`)
  process.exitCode = cmd === undefined ? 0 : 1
}
