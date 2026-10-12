/**
 * 工具调用协议层 —— **参考 cuckoo，不参考 dsh-deepseek-web-login**。
 *
 * ## 为什么用 JS 代码块而不是 JSON
 *
 * cuckoo 的 `src/prompt/deepseek.md` 原文：
 *
 * > - 需要调用工具时，将 JavaScript 代码输出到以 ```cuckoo 开头、以 ``` 结尾的代码块中
 * > - 多行文本一律使用反引号（`）模板字符串，直接换行，**不需要任何转义**
 * > - **不要输出 JSON 格式的工具调用，也不要对字符串做 JSON 转义**
 *
 * 对比 web-login 的 JSON 协议：它的指令里塞满了**转义失败的补救条款**
 * （「值里的引号必须转义为 \"」「值里不能有真实换行，要写 \n」
 * 「围栏里的 JSON 会泄漏到可见记录和网页对话里」）。
 *
 * 本质差异：**JSON 协议要求模型做转义（易错），模板字符串不要求（不会错）**。
 * 而且 `await read(...)` 这种函数调用形态，模型见过的代码远多于构造的 JSON。
 *
 * ## 本插件与 cuckoo 的关键差异
 *
 * cuckoo 的 `JsRunner` 在页面沙箱里**真的执行**那段 JS，所以它完全不需要解析参数。
 * 本插件处在 DSH 的 adapter 位置 —— **工具是 DSH 的，本插件没有执行权限**，
 * 所以必须把调用**解析出来**交给 DSH。这就是本模块存在的原因。
 *
 * 解析策略（按可靠性排序）：
 *   1. `JSON.parse` —— 参数写成 JSON 对象时直接成功
 *   2. **宽松修复** —— 未加引号的键 / 单引号 / 尾逗号（模型常犯）
 *   3. **位置参数兜底** —— `read("path")` 按 schema 的属性顺序映射
 *
 * 三步都失败时**不静默丢弃**：把原文当正文透出，并在日志里记一条，
 * 这样用户至少能看到模型写了什么，而不是消息凭空消失。
 */

/** DSH 下发的工具 schema（与 `dsh-llm` 的 `ToolSchema` 一致）。 */
export interface ToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** 解析出来的一个工具调用。 */
export interface ParsedCall {
  name: string
  /** JSON 字符串（DSH 的 `ToolCallBlock.arguments` 就是这个类型）。 */
  arguments: string
}

/** 解析结果。 */
export interface ParseResult {
  /** 去掉工具代码块之后的正文（要流给 DSH 的部分）。 */
  text: string
  calls: ParsedCall[]
  /** 看起来像工具块但解析失败的片段（诊断用）。 */
  failed: string[]
}

/**
 * 代码块的语言标记。
 *
 * 用 `dsh` 而不是参考实现用的那个词：这是**模型要原样输出的标记**，
 * 属于本插件自己的对外协议，不该带别人的项目名。
 */
const FENCE_LANG = 'dsh'

/**
 * 平台信息（抄 cuckoo 的 `buildPlatformInfo()`）。
 *
 * ## 为什么要自己补（实测确认 DSH 没给）
 *
 * 解压 `~/.dsh/sessions/*.jsonl.zstd` 读 `role:'system'` 消息（5943 字符），
 * 里面**只提到一次 Windows**，而且是讲 exit code 语义：
 *
 * > On Windows a killed process settles as `[exit code: 1]` …
 *
 * **没有** cuckoo 那种「命令差异」说明。而模型最容易犯的错就是
 * 在 Windows 上写 Unix 命令（`ls` / `cat` / `pwd`），或在 pwsh 里用 bash 语法。
 *
 * cuckoo 的原文（`prompt-builder.ts:76`）：
 *
 * > - 操作系统：Windows（x64）
 * >   - bash 使用 cmd.exe（Windows 命令：cd / dir / echo %cd% / type / findstr）
 * >   - pwsh 使用 PowerShell（Get-Location / $env:VAR / Get-ChildItem）
 * >   - 路径分隔符为反斜杠 \，传给工具的相对路径统一用正斜杠 /
 *
 * ⚠️ 只在**首轮**带（与工具目录同一个段），后续轮不重复。
 */
export function buildPlatformInfo(platform: string, arch: string): string {
  if (platform === 'win32') {
    return [
      '- 操作系统：Windows（' + arch + '）',
      '  - bash 用 cmd.exe 语法：cd / dir / echo %cd% / type / findstr',
      '  - pwsh 用 PowerShell 语法：Get-Location / $env:VAR / Get-ChildItem',
      '- 路径分隔符是反斜杠 \\，传给工具的相对路径统一用正斜杠 /',
    ].join('\n')
  }
  if (platform === 'darwin') {
    return ['- 操作系统：macOS（' + arch + '）', '  - bash 用 zsh/bash：pwd / ls / cat / grep', '- 路径分隔符是正斜杠 /'].join('\n')
  }
  return ['- 操作系统：Linux（' + arch + '）', '  - bash 用 bash：pwd / ls / cat / grep', '- 路径分隔符是正斜杠 /'].join('\n')
}

/**
 * 工具调用协议指令。
 *
 * 刻意**只讲怎么调**，不讲身份/原则 —— 本插件在 adapter 位置，
 * system 由 DSH 提供（实测会话里有 3 条 `role:'system'` 消息，5943 字符）。
 * cuckoo 的模板是完整系统提示词（含身份、核心原则、项目信息），
 * 那部分在这里是**重复且冲突**的（详见 `docs/project-init-compare.md`）。
 */
export const TOOL_PROTOCOL = [
  '# 工具调用协议',
  '',
  '你可以调用工具来完成任务。需要调用时，把 JavaScript 代码放进以 ```' + FENCE_LANG + ' 开头、以 ``` 结尾的代码块，**代码块外不要有任何文字**：',
  '',
  '```' + FENCE_LANG,
  'const r = await read({"path": "src/index.ts"});',
  'log(r);',
  '```',
  '',
  '规则：',
  '1. 参数写成 **JSON 对象**：`await 工具名({"参数名": 值})`。',
  '2. **多行文本用反引号模板字符串，直接换行，不要做任何转义**（不要写 \\n）。',
  '3. 不要输出 JSON 格式的工具调用，不要用 XML/HTML 标记包裹。',
  '4. 一次只调一个工具；等结果回来再决定下一步。',
  '5. 不要编造工具名或参数名；不确定就先用 `read` 或 `pwsh` 查。',
  '6. 不需要工具时，直接用普通文字回答，**不要**输出代码块。',
  '7. 工具结果是真实的，直接基于结果继续，不要自己模拟输出。',
].join('\n')

/**
 * 从 JSON Schema 生成可读签名（抄 cuckoo 的「`name(签名)`」形态）。
 *
 * 例：`pwsh({command: string, timeout?: number})`
 */
export function buildToolSignature(tool: ToolSchema): string {
  const params = tool.parameters as { properties?: Record<string, unknown>; required?: unknown } | undefined
  const props = params?.properties ?? {}
  const required = new Set(Array.isArray(params?.required) ? (params.required as string[]) : [])
  const names = Object.keys(props)
  if (names.length === 0) return `${tool.name}()`
  const parts = names.map((n) => {
    const spec = props[n] as { type?: unknown } | undefined
    const type = typeof spec?.type === 'string' ? spec.type : 'any'
    return `${n}${required.has(n) ? '' : '?'}: ${type}`
  })
  return `${tool.name}({${parts.join(', ')}})`
}

/** 取描述首句（到第一个句末点），再按上限截断。 */
function firstSentence(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const stop = flat.search(/[.。](\s|$)/)
  const s = stop >= 0 ? flat.slice(0, stop + 1) : flat
  return s.length > limit ? `${s.slice(0, limit)}…` : s
}

/** 单条工具目录条目的描述上限（抄 cuckoo 的「一行」形态）。 */
const TAIL_DESC_CHARS = 160

/**
 * 工具目录（**抄 cuckoo 的格式**）。
 *
 * cuckoo 的 `ToolRegistry.getFormattedJsApiForPrompt()`：
 *
 * ```ts
 * return descriptions.map((t, i) => {
 *   const sig = '`' + t.jsApi + '`';
 *   return (i + 1) + '. ' + sig + ' — ' + t.description;
 * }).join('\n');
 * ```
 *
 * 即「`1. \`read(path)\` — 读取文件`」一行一个工具。
 *
 * ⚠️ **cuckoo 对所有工具都是这个粒度**，没有核心/长尾之分 ——
 * 所以本插件也不分级（用户明确要求只参考 cuckoo）。
 * 实测体量：60 个工具 × 约 80 字符 ≈ 5,000 字符（对比 web-login 的 5 万）。
 */
export function buildToolCatalog(tools: ToolSchema[]): string {
  if (tools.length === 0) return ''
  return tools
    .map((t, i) => `${i + 1}. \`${buildToolSignature(t)}\` — ${firstSentence(t.description, TAIL_DESC_CHARS)}`)
    .join('\n')
}

/**
 * 拼出首轮要带的工具段（协议 + 目录 + 平台信息）。
 *
 * ⚠️ **只在首轮带**（与差分发送一致）：后续轮只发增量，
 * 不重复这段 —— 否则每轮都多几千字符，直接推高单次请求体量。
 *
 * ## 为什么不带「项目目录」「项目介绍」
 *
 * 实测确认 DSH 已经给了（详见 `docs/project-init-compare.md`）：
 *   - **项目目录**：system 末尾有 `Your working directory is …`
 *   - **项目介绍**：`AGENTS.md` 由 `dsh-agent-instructions` 作为
 *     **user 消息**注入（带 `<system-reminder>` 包裹），
 *     会原样进入 `options.messages`，本插件自动带上
 *
 * 重复注入 = 白占体量，而体量是封号风险的主要嫌疑（参考实现实测记录）。
 *
 * @param tools - DSH 下发的工具清单
 * @param platform - `process.platform` 的值（默认取宿主）
 * @param arch - `process.arch` 的值
 */
export function buildToolSection(tools: ToolSchema[], platform?: string, arch?: string): string {
  if (tools.length === 0) return ''
  const catalog = buildToolCatalog(tools)
  const plat = buildPlatformInfo(platform ?? process.platform, arch ?? process.arch)
  return [TOOL_PROTOCOL, '', '# 运行环境', '', plat, '', '# 可用工具', '', catalog].join('\n')
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

/**
 * 宽松修复一个「像 JSON 但不太标准」的对象字面量。
 *
 * 模型常见的四种走样（按出现频率）：
 *   1. 键没加引号：`{path: "x"}` → `{"path": "x"}`
 *   2. 单引号字符串：`{'path': 'x'}` → `{"path": "x"}`
 *   3. **反引号模板字符串**：`` {"command": `Get-ChildItem\n…`} ``
 *      —— 这是 cuckoo 协议**明确要求**的写法（「多行文本一律使用反引号
 *      模板字符串，直接换行，不需要任何转义」），所以是主路径，必须支持
 *   4. 尾逗号：`{"a": 1,}` → `{"a": 1}`
 *
 * 修复是**保守的**：只做上面四种，改不动就返回 null（交给位置参数兜底）。
 */
function repairJsonObject(raw: string): string | null {
  let s = raw.trim()
  if (!s.startsWith('{') || !s.endsWith('}')) return null

  // 1) 给裸键加引号：{ key: ... } / , key: ...  （只处理非字符串上下文里的）
  s = s.replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1"$2"$3')

  /**
   * 2) 单引号 → 双引号；3) 反引号模板字符串 → 双引号字符串。
   *
   * 逐个字符扫描，避免动到字符串内部的撇号。
   *
   * ⚠️ **模板字符串里的换行必须转成 `\n`** —— JSON 不允许字符串里有真实换行。
   * cuckoo 协议让模型「直接换行，不做转义」，所以这里必须替模型做这一步。
   * 双引号与反斜杠也要转义。
   */
  let out = ''
  let inSingle = false
  let inDouble = false
  let inBacktick = false
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i]!

    if (inBacktick) {
      // 模板字符串内部：转义成 JSON 字符串内容
      if (c === '\\') {
        const next = s[i + 1] ?? ''
        out += next === '`' ? '`' : `\\${next}`
        i += 1
        continue
      }
      if (c === '`') {
        inBacktick = false
        out += '"'
        continue
      }
      if (c === '"') {
        out += '\\"'
        continue
      }
      if (c === '\n') {
        out += '\\n'
        continue
      }
      if (c === '\r') continue
      if (c === '\t') {
        out += '\\t'
        continue
      }
      out += c
      continue
    }

    if (c === '\\') {
      out += c + (s[i + 1] ?? '')
      i += 1
      continue
    }
    if (c === '"' && !inSingle) {
      inDouble = !inDouble
      out += c
      continue
    }
    if (c === "'" && !inDouble) {
      inSingle = !inSingle
      out += '"'
      continue
    }
    if (c === '`' && !inDouble && !inSingle) {
      inBacktick = true
      out += '"'
      continue
    }
    out += c
  }
  if (inSingle || inDouble || inBacktick) return null
  s = out

  // 4) 去掉尾逗号
  s = s.replace(/,(\s*[}\]])/g, '$1')

  try {
    JSON.parse(s)
    return s
  } catch {
    return null
  }
}

/** 从 `start` 位置的 `(` 开始找配对的 `)`，返回括号内内容。 */
function balancedParens(text: string, openIndex: number): { body: string; end: number } | null {
  let depth = 0
  let inString: string | null = null
  for (let i = openIndex; i < text.length; i += 1) {
    const c = text[i]!
    if (inString !== null) {
      if (c === '\\') {
        i += 1
        continue
      }
      if (c === inString) inString = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      inString = c
      continue
    }
    if (c === '(') depth += 1
    else if (c === ')') {
      depth -= 1
      if (depth === 0) return { body: text.slice(openIndex + 1, i), end: i + 1 }
    }
  }
  return null
}

/** 用 schema 的属性顺序，把位置参数映射成对象。 */
function positionalToObject(schema: ToolSchema | undefined, body: string): string | null {
  if (schema === undefined) return null
  const params = schema.parameters as { properties?: Record<string, unknown> } | undefined
  const names = Object.keys(params?.properties ?? {})
  if (names.length === 0) return null

  // 切分顶层逗号
  const parts: string[] = []
  let depth = 0
  let cur = ''
  let inString: string | null = null
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i]!
    if (inString !== null) {
      cur += c
      if (c === '\\') {
        cur += body[i + 1] ?? ''
        i += 1
        continue
      }
      if (c === inString) inString = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      inString = c
      cur += c
      continue
    }
    if (c === '{' || c === '[') depth += 1
    if (c === '}' || c === ']') depth -= 1
    if (c === ',' && depth === 0) {
      parts.push(cur.trim())
      cur = ''
      continue
    }
    cur += c
  }
  if (cur.trim() !== '') parts.push(cur.trim())
  if (parts.length === 0 || parts.length > names.length) return null

  const obj: Record<string, unknown> = {}
  for (let i = 0; i < parts.length; i += 1) {
    let v = parts[i]!
    // 裸字符串（没加引号）→ 当字符串处理
    if (!/^["'{[]/.test(v) && !/^(true|false|null|-?\d)/.test(v)) v = JSON.stringify(v)
    else if (v.startsWith("'")) v = `"${v.slice(1, -1)}"`
    try {
      obj[names[i]!] = JSON.parse(v)
    } catch {
      return null
    }
  }
  return JSON.stringify(obj)
}

/**
 * 从模型回复里解析工具调用。
 *
 * @param reply - 模型回复的**完整文本**（含可能的代码块）
 * @param tools - 本轮下发的工具清单（用于校验名字、位置参数兜底）
 */
export function parseToolCalls(reply: string, tools: ToolSchema[]): ParseResult {
  const byName = new Map(tools.map((t) => [t.name, t]))
  const calls: ParsedCall[] = []
  const failed: string[] = []
  let text = ''
  let rest = reply

  for (;;) {
    // 找 ```cuckoo 开围栏
    const open = new RegExp('```[ \\t]*' + FENCE_LANG + '[ \\t]*\\r?\\n', 'i').exec(rest)
    if (open === null) {
      text += rest
      break
    }
    // 围栏前的正文照常保留
    text += rest.slice(0, open.index)
    const afterOpen = rest.slice(open.index + open[0].length)
    const closeIdx = afterOpen.search(/\r?\n[ \t]*```/)
    const block = closeIdx < 0 ? afterOpen : afterOpen.slice(0, closeIdx)
    rest = closeIdx < 0 ? '' : afterOpen.slice(closeIdx).replace(/^\r?\n[ \t]*```[ \t]*\r?\n?/, '')

    // 块内找所有 `await name(` 或裸 `name(`
    let found = 0
    const callRe = /(?:await\s+)?([A-Za-z_$][\w$]*)\s*\(/g
    let m: RegExpExecArray | null
    while ((m = callRe.exec(block)) !== null) {
      const name = m[1]!
      const schema = byName.get(name)
      // 不是工具名（log / JSON.stringify 之类）⇒ 跳过
      if (schema === undefined) continue
      const paren = balancedParens(block, m.index + m[0].length - 1)
      if (paren === null) {
        failed.push(`${name}( … 括号不配对`)
        continue
      }
      const body = paren.body.trim()
      let args: string | null = null
      if (body === '') args = '{}'
      else if (body.startsWith('{')) args = repairJsonObject(body) ?? (() => {
        try {
          JSON.parse(body)
          return body
        } catch {
          return null
        }
      })()
      if (args === null) args = positionalToObject(schema, body)
      if (args === null) {
        failed.push(`${name}( ${body.slice(0, 60)} … 参数解析失败`)
        continue
      }
      calls.push({ name, arguments: args })
      found += 1
      callRe.lastIndex = paren.end
    }
    if (found === 0 && block.trim() !== '') {
      // 有围栏但没解析出任何已知工具 —— 不静默丢弃，把原文透出并记诊断
      failed.push(block.trim().slice(0, 120))
      text += block
    }
  }

  return { text: text.trim(), calls, failed }
}
