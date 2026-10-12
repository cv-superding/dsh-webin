#!/usr/bin/env node
/**
 * 对比：cuckoo 的初始化内容 vs DSH 的 system —— 哪些已有、哪些缺。
 *
 * ## 用户指出的点
 *
 * 「cuckoo 每次还会初始化项目什么的」
 *
 * cuckoo 是 harness，`initProject()` 在**每次进入项目时**把 6 类内容
 * 打进 AI 页面的第一条消息（`src/session/prompt-builder.ts`）：
 *
 * | # | 章节 | 占位符 | 内容来源 |
 * |---|---|---|---|
 * | 1 | 平台信息 | `{{PLATFORM_INFO}}` | `process.platform` / `arch` |
 * | 2 | 项目目录 | `{{PROJECT_DIR}}` | 用户选的目录 |
 * | 3 | 项目介绍 | `{{PROJECT_INTRO_SECTION}}` | `.cuckoo/CUCKOO.md` |
 * | 4 | 工具清单 | `{{TOOLS_LIST}}` + `{{TOOL_API_TYPES}}` | 工具注册表 |
 * | 5 | 技能清单 | `{{SKILLS_SECTION}}` | `scanSkills()` |
 * | 6 | MCP 清单 | `{{MCP_SECTION}}` | 已配置的 MCP server |
 *
 * ## 本插件在 adapter 位置 —— 大部分 DSH 已经给了
 *
 * 实测（解压 `~/.dsh/sessions/*.jsonl.zstd` 读 `role:'system'` 消息）：
 * system 有 **5943 字符**，末尾就是工作目录：
 *
 * ```
 * Your working directory is F:\Code\DSH-Code\dsh-webin.
 * ```
 *
 * 所以「项目目录」DSH 已经给了，**不需要**重复注入（重复反而浪费体量）。
 *
 * 这个脚本逐条核对，明确哪些要补、哪些不要补。
 *
 * 用法：node scripts/probe-init-compare.mjs
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')

console.log('=== cuckoo 初始化内容 vs DSH system 对比 ===\n')

// ---- 1) 读一份真实 DSH system ----
console.log('[1] 读 DSH 的真实 system 消息')
const sessRoot = join(DSH_HOME, 'sessions')
let sysText = ''
if (existsSync(sessRoot)) {
  const files = []
  const walk = (dir, depth = 0) => {
    if (depth > 3) return
    for (const n of readdirSync(dir)) {
      const p = join(dir, n)
      try {
        const st = statSync(p)
        if (st.isDirectory()) walk(p, depth + 1)
        else if (n.endsWith('.zstd')) files.push({ p, size: st.size })
      } catch {
        /* ignore */
      }
    }
  }
  walk(sessRoot)
  files.sort((a, b) => b.size - a.size)

  for (const f of files.slice(0, 6)) {
    try {
      const raw = readFileSync(f.p)
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
          /* 跳过坏帧 */
        }
      }
      for (const line of out.split('\n')) {
        if (!line.includes('"system"')) continue
        const o = JSON.parse(line)
        const msg = o?.data?.message
        if (msg?.role !== 'system') continue
        sysText = (msg.content ?? []).map((b) => b.text ?? '').join('\n')
        break
      }
      if (sysText !== '') break
    } catch {
      /* ignore */
    }
  }
}
if (sysText === '') {
  console.log('    ⚠️ 没读到 system（会话文件可能是新格式）')
} else {
  console.log(`    system 长度: ${sysText.length} 字符`)
}

// ---- 2) 逐条核对 cuckoo 的 6 类 ----
console.log('\n[2] 逐条核对（cuckoo 注入 vs DSH 是否已给）')

const CHECKS = [
  {
    no: 1,
    name: '平台信息（OS / arch / 命令差异）',
    cuckoo: 'buildPlatformInfo()：操作系统、bash/pwsh 差异、路径分隔符',
    dshHas: /Windows|PowerShell|pwsh|bash/i.test(sysText),
    // DSH 的 system 里有没有提 Windows 相关
    note: 'DSH 的 system 提到 pwsh / PowerShell',
  },
  {
    no: 2,
    name: '项目目录',
    cuckoo: '{{PROJECT_DIR}}：用户选择的目录绝对路径',
    dshHas: /working directory is/i.test(sysText),
    note: 'DSH system 末尾有「Your working directory is …」',
  },
  {
    no: 3,
    name: '项目介绍（.cuckoo/CUCKOO.md）',
    cuckoo: 'readProjectIntro()：项目自述文件内容',
    dshHas: false,
    note: 'DSH 不读项目自述文件',
  },
  {
    no: 4,
    name: '工具清单',
    cuckoo: 'getFormattedJsApiForPrompt()：`name(签名)` — 描述',
    dshHas: false,
    note: 'DSH 走 options.tools 传（不在 system 里）—— 本插件已实现',
  },
  {
    no: 5,
    name: '技能清单',
    cuckoo: 'scanSkills() + buildSkillsSection()',
    dshHas: /skill/i.test(sysText),
    note: 'DSH 的 system 提到 skill 工具',
  },
  {
    no: 6,
    name: 'MCP 清单',
    cuckoo: 'listConfiguredServers()：已启用的 MCP server',
    dshHas: /mcp/i.test(sysText),
    note: 'DSH 有 MCP 工具',
  },
]

for (const c of CHECKS) {
  const mark = c.dshHas ? '✓ 已有' : '✗ 缺'
  console.log(`\n  ${c.no}. ${c.name}  →  ${mark}`)
  console.log(`     cuckoo: ${c.cuckoo}`)
  console.log(`     说明  : ${c.note}`)
}

// ---- 3) 结论 ----
console.log('\n[3] 结论')
console.log('    DSH 的 system 已经覆盖：平台信息、项目目录、技能/MCP 的提及')
console.log('    本插件需要补的只有：**工具清单**（走 options.tools，已在 tool-protocol.ts 实现）')
console.log('')
console.log('    ⚠️ 不要重复注入 DSH 已有的内容：')
console.log('       - 项目目录重复 = 白占体量（而体量是封号风险的主要嫌疑）')
console.log('       - 平台信息重复 = 同上')
console.log('       - 身份/原则重复 = 与 DSH 的 system 冲突（cuckoo 的模板是完整系统提示词，')
console.log('         本插件在 adapter 位置，system 由 DSH 提供）')
