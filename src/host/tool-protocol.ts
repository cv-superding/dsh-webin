/**
 * 工具调用协议层 —— **参考 cuckoo，不参考 dsh-deepseek-web-login**。
 *
 * ## 为什么用 JS 代码块而不是 JSON
 *
 * cuckoo 的 `src/prompt/deepseek.md` 原文：
 *
 * > - 需要调用工具时，将 JavaScript 代码输出到以 ```ldw 开头、以 ``` 结尾的代码块中
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
const FENCE_LANG = 'ldw'

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
  /**
   * ⚠️ 这条按 **cuckoo 的提示词**加固过。
   *
   * cuckoo 在 system prompt 里写得很明确：「不要输出 JSON 格式的工具调用，
   * 也不要对字符串做 JSON 转义」，并且给了「输出前自查清单」。
   * 而本插件原来只写「不要用 XML/HTML 标记包裹」—— **太笼统**，
   * 模型照样吐网页版原生的 DSML 标记（用户实测整段漏进对话）。
   *
   * 所以这里点名 DSML：**在源头禁止**，比事后剥离可靠。
   */
  '3. **只用上面这一种格式**。不要输出 DSML 标记、XML/HTML 标签、或 JSON 形式的工具调用',
  '   —— 那些形式**不会被识别**，只会原样显示给用户（看起来像乱码）。',
  '   也不要对字符串做 JSON 转义。',
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
/**
 * ## ⭐⭐⭐ 剥离 DSML 工具调用标记
 *
 * ## 用户实测
 *
 * 「DSML 怎么也出来了？」—— 回复里整段漏出了网页版的**原生工具调用语法**。
 *
 * ## 背景
 *
 * 网页版的模型自带一套工具调用标记（DSML），形如
 *
 *     <｜tool_calls｜> ... <｜/tool_calls｜>
 *
 * 标签名用全角竖线 ｜ (U+FF5C) 包裹。
 *
 * 插件用的是**自己的** ```ldw 围栏协议，但模型有时会改用网页版原生的 DSML ——
 * 而插件此前完全不认识它 ⇒ 整段标记原样进入 text ⇒ 漏进 DSH 对话。
 *
 * ## 处理
 *
 * - 整块 DSML 调用**删掉**：它描述的是模型想调用的工具，插件执行不了
 *   （工具由 DSH 执行，插件只负责把 ```ldw 围栏交给 DSH 解析）
 * - 散落的单个 DSML 标签也删掉
 * - 返回剥离计数，便于在诊断里观察出现频率
 *
 * ## ⚠️ 第三种形态：**没有竖线的裸 XML**（用户实测第三次报障）
 *
 * 前两版都假定「标签里一定有竖线」（`<｜DSML｜tool_calls>` 或 `<|tool_calls|>`）。
 * 但用户实测贴回来的泄漏长这样：
 *
 *     </invoke>
 *     </parameter>
 *     </invoke>
 *     </parameter>
 *     …（重复几十次）
 *
 * **一个竖线都没有** ⇒ 两版正则 `striped = 0`，**整段原样漏进对话**。
 * 这是模型吐原生 AntML/XML 工具语法时被网页版截断的残骸。
 *
 * ## 为什么不能用「剥掉所有 XML 标签」来解决
 *
 * 回复正文里合法出现 `<div>` / `<span>` / `<a href>` 是**正常的**
 * （模型讲 HTML、贴代码）。无差别剥标签会**吃掉正文**。
 *
 * 所以第三种形态走**标签白名单** —— 只剥工具调用专属的标签名：
 * `tool_calls` / `function_calls` / `invoke` / `parameter` / `tool_call`
 * / `tool_use` / `tool_result`，并允许 `antml:` / `dsml:` 之类的命名空间前缀。
 *
 * 白名单的安全边界已用回归锁死（`scripts/verify-tool-protocol.mjs`）：
 * `div` / `span` / `a` / `img` / 正文里的 `invoke` 单词 / 数学比较 `${a < b}`
 * / 自定义元素 `<my-invoke-widget>` **一律不得被剥**。
 */
function stripDsml(reply: string): { text: string; stripped: number } {
  let stripped = 0
  let out = reply
  /**
   * ## Real DSML format: DOUBLE full-width bar + the literal token DSML
   *
   * The first version matched `<|<|tool_calls>`-style markup with a SINGLE bar
   * and no DSML token -- so it never matched and the markup kept leaking into
   * the conversation (only the user's second screenshot revealed the real shape):
   *
   *     <||DSML||tool_calls>
   *     <||DSML||invoke name="write">
   *     <||DSML||parameter name="path">...</||DSML||parameter>
   *
   * So the pattern is: an opening angle bracket, 1-3 bars, optional DSML token,
   * 1-3 bars, then a tag name, then a closing angle bracket.
   */
  const BAR = String.fromCharCode(0xff5c);
  /**
   * 形态容错：`<` 之后允许「任意数量的竖线 / DSML 字样」，但**至少要有一个竖线**。
   *
   * 上一版写成「两组竖线夹一个可选 DSML」—— 那样只匹配双竖线形态，
   * **单竖线形态（`<|tool_calls|>`）匹配不上**（实测确认）。
   *
   * 同时「至少一个竖线」这个约束不能丢：否则 `<div>` 也会被当成 DSML 吃掉。
   */
  const OPEN = '<(?:DSML|[' + BAR + '|])*[' + BAR + '|](?:DSML|[' + BAR + '|])*';
  /** Whole tool-call block: from <..calls..> through <../..calls..>. */
  const block = new RegExp(OPEN + '[^>]*tool_calls[^>]*>[\\s\\S]*?' + OPEN + '\\/[^>]*tool_calls[^>]*>', 'gi');
  out = out.replace(block, () => {
    stripped += 1;
    return '';
  });
  /** Stray single tags: <..anything..>. */
  const tag = new RegExp(OPEN + '[^>]{0,60}>', 'g');
  out = out.replace(tag, () => {
    stripped += 1;
    return '';
  });
  /**
   * ## 第三种形态：**没有竖线的裸 XML**（用户第三次报障）
   *
   * 前两版都要求标签里含竖线 ⇒ 对 `</invoke>` / `</parameter>` 这类无竖线残骸
   * `stripped = 0`，整段原样漏进对话（用户实测贴回来几十行）。
   *
   * 走**标签白名单**而不是「剥掉所有 XML」：回复正文里合法出现 `<div>` /
   * `<span>` / `<a href>` 是正常的（模型在讲 HTML），无差别剥会吃掉正文。
   *
   * - `[a-z][\w-]*:` 允许 `antml:` / `dsml:` 之类的命名空间前缀
   * - `\b` 保证不会误吃 `<my-invoke-widget>` 这类自定义元素
   */
  const BARE = '<\\/?\\s*(?:[a-z][\\w-]*:)?(?:tool_calls|function_calls|invoke|parameter|tool_call|tool_use|tool_result)\\b[^>]*>'
  const bare = new RegExp(BARE, 'gi');
  out = out.replace(bare, () => {
    stripped += 1;
    return '';
  });
  return { text: out, stripped }
}

export function parseToolCalls(reply: string, tools: ToolSchema[]): ParseResult {
  const byName = new Map(tools.map((t) => [t.name, t]))
  const calls: ParsedCall[] = []
  const failed: string[] = []
  let text = ''
  /**
   * ⭐ 先剥离 DSML —— 模型有时会用网页版原生的工具调用语法而不是我们的
   * ```ldw 围栏。不剥的话整段标记会漏进可见回复（用户实测报过）。
   */
  const dsml = stripDsml(reply)
  if (dsml.stripped > 0) {
    failed.push(`（已剥离 ${dsml.stripped} 处 DSML 工具标记 —— 模型用了网页版原生语法，插件无法执行）`)
  }
  let rest = dsml.text

  for (;;) {
    // 找 ```ldw 开围栏
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
