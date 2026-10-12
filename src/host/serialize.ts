/**
 * 消息序列化：DSH 的消息词汇 → 网页端能吃的文本。
 *
 * ## 实测的 DSH 消息形状（从 `~/.dsh/sessions/*.jsonl.zstd` 解压得到）
 *
 * 会话文件是**分帧 zstd**（每行一个 zstd 帧），解压后实测统计：
 * `tool/result` 932 条、`tool/call` 916 条、`assistant/message` 828 条。
 *
 * content block 类型：`text` 1357 / `tool-call` 916 / `reasoning` 371 / `image` 1。
 *
 * **关键结论：`tool-result` 不是 content block**，而是 `role: 'tool'` 的独立消息：
 *
 * ```json
 * { "role": "tool",
 *   "toolCallId": "call_00_…",
 *   "content": [{ "type": "text", "text": "…" }],
 *   "isError": false }
 * ```
 *
 * 而 `tool-call` 是 assistant 消息 content 里的块：
 *
 * ```json
 * { "type": "tool-call", "id": "call_00_…", "name": "read_image",
 *   "arguments": "{\"file_path\":\"C:\\\\…\"}" }
 * ```
 *
 * ⚠️ `arguments` 是 **JSON 字符串**，不是对象。
 *
 * ## 为什么 reasoning 不回灌
 *
 * cuckoo 是 harness，每轮只发新消息，不重发历史。
 * 本插件虽在 adapter 位置，但差分发送的效果一样：**只发增量**。
 * 思考内容回灌到网页端有两个坏处（参考实现实测记录）：
 *   1. 思考区出现转义标记/协议残留，用户一眼看出不是人；
 *   2. 那团垃圾留在转写里，每轮重发 —— 真正让对话不像人的地方。
 * 所以 reasoning 只给 DSH 侧展示，**不进网页 prompt**。
 */

/** 单条工具结果的文本上限（防止一次读大文件把 prompt 顶爆）。 */
const TOOL_RESULT_LIMIT = 4000

/** DSH 消息（鸭子类型，只读我们用到的字段）。 */
export interface DshMessage {
  role: string
  content?: unknown
  toolCallId?: string
  isError?: boolean
}

/** 从 content 里抽出纯文本（text 块拼接）。 */
export function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const b of content) {
    if (b === null || typeof b !== 'object') continue
    const block = b as { type?: string; text?: unknown }
    // ⚠️ reasoning 刻意跳过（见文件头说明）
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/** 把 `arguments`（JSON 字符串）转成人类可读的参数文本。 */
function formatArguments(raw: string): string {
  try {
    const obj = JSON.parse(raw) as unknown
    if (obj !== null && typeof obj === 'object') return JSON.stringify(obj)
    return String(obj)
  } catch {
    return raw
  }
}

/**
 * 把一条 DSH 消息序列化成文本。
 *
 * @returns 要发出去的文本；空串表示这条不发。
 */
export function serializeMessage(msg: DshMessage): string {
  // ---- role: 'tool' ⇒ 工具结果 ----
  if (msg.role === 'tool') {
    const body = contentToText(msg.content).trim()
    if (body === '') return ''
    const clipped =
      body.length > TOOL_RESULT_LIMIT
        ? `${body.slice(0, TOOL_RESULT_LIMIT)}\n…（结果过长已截断，共 ${body.length} 字符）`
        : body
    const mark = msg.isError === true ? '（失败）' : ''
    return `【工具结果${mark}】\n${clipped}`
  }

  const content = msg.content
  const parts: string[] = []

  // ---- assistant 消息里可能夹着 tool-call 块 ----
  if (Array.isArray(content)) {
    const calls: string[] = []
    for (const b of content) {
      if (b === null || typeof b !== 'object') continue
      const block = b as { type?: string; name?: unknown; arguments?: unknown }
      if (block.type !== 'tool-call') continue
      const name = String(block.name ?? '')
      if (name === '') continue
      const args = typeof block.arguments === 'string' ? formatArguments(block.arguments) : '{}'
      calls.push(`${name}(${args})`)
    }
    if (calls.length > 0) {
      /**
       * 把历史里的工具调用**文本化**成它当时的样子。
       *
       * 为什么要还原成 ```dsh 块而不是别的：模型在**下一轮**会看到
       * 「自己上次是怎么调的」，保持同一种形态能强化协议一致性。
       */
      parts.push(['```dsh', ...calls.map((c) => `await ${c};`), '```'].join('\n'))
    }
  }

  const text = contentToText(content).trim()
  if (text !== '') parts.push(text)
  if (parts.length === 0) return ''

  const roleLabel = msg.role === 'assistant' ? 'Assistant' : msg.role === 'user' ? 'User' : msg.role
  return `## ${roleLabel}\n${parts.join('\n\n')}`
}

/**
 * 把一批消息序列化成一段文本。
 *
 * @param messages - DSH 的 messages（已按调用方要求切片）
 */
export function serializeMessages(messages: readonly DshMessage[]): string {
  const out: string[] = []
  for (const m of messages) {
    const s = serializeMessage(m)
    if (s !== '') out.push(s)
  }
  return out.join('\n\n')
}
