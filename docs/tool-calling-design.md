# 工具调用设计（参考 cuckoo，不参考 web-login）

> 写于实现前。**所有事实都来自实测**，不是推测。

## 一、实测拿到的事实

### 1.1 DSH 的块契约（从 `dsh-llm/lib/typert.host.js` 读声明）

```ts
interface ToolCallBlock { type: 'tool-call'; id: ToolCallId; name: string; arguments: string }
type StreamChunk =
  | { type: 'block-start'; index: number; blockType: ContentBlockType }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: ToolCallId; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason }
interface ToolSchema { name: string; description: string; parameters: Record<string, unknown> }
```

### 1.2 真实会话里的消息形状（从 `~/.dsh/sessions/*.jsonl.zstd` 解压实测）

会话文件是**分帧 zstd**（每行一个 zstd 帧，魔数 `28 B5 2F FD`），
逐帧解压后拿到 4951 行、851 行含工具调用。实测统计：

| 事件类型 | 数量 |
|---|---|
| `tool/result` | 932 |
| `tool/call` | 916 |
| `assistant/message` | 828 |

**content block 类型**：`text` 1357 / `tool-call` 916 / `reasoning` 371 / `image` 1

**关键结论：`tool-result` 不是 content block**，而是 **`role: 'tool'` 的独立消息**：

```json
{
  "role": "tool",
  "source": { "kind": "tool", "callId": "call_00_DU94v2FIc3IDW0XHJaYO9351" },
  "toolCallId": "call_00_DU94v2FIc3IDW0XHJaYO9351",
  "content": [{ "type": "text", "text": "<path>…</path>\n<type>image</type>…" }],
  "isError": false
}
```

**`tool-call` 块**（在 assistant 消息的 content 里）：

```json
{ "type": "tool-call", "id": "call_00_DU94v2FIc3IDW0XHJaYO9351",
  "name": "read_image",
  "arguments": "{\"file_path\":\"C:\\\\Users\\\\…\"}" }
```

⚠️ `arguments` 是 **JSON 字符串**（不是对象）。

### 1.3 官方 adapter 的约束（`dsh-llm-deepseek/lib/index.js:1666-1693`）

- `role:'tool'` 消息 → `{type:'tool_result', tool_use_id, content, is_error}`
- **每个 `tool_use` 必须立即跟对应的 `tool_result`**，否则抛
  `"DeepSeek Messages tool calls need immediate results"` / `"history ends with unresolved tools"`
- 工具目录走 `options.tools`（**不在 messages 里**）

### 1.4 工具目录体量（从 asar 统计）

DSH 内置 **20 个工具包**（ask-user / bash / fs / fs-search / goal / jobs / present /
pwsh / ralph / skill / str-replace-editor / subagent / todo / web / workflow / cordis…），
加上插件注册的工具，实际下发约 **60 个**。

## 二、cuckoo 的做法（用户指定参考对象）

### 2.1 核心：**JS 代码块，不是 JSON**

cuckoo 的 `src/prompt/deepseek.md` 原文：

> - 需要调用工具时，将 JavaScript 代码输出到以 ` ```ldw ` 开头、以 ` ``` ` 结尾的代码块中
> - **多行文本一律使用反引号（`）模板字符串，直接换行，不需要任何转义**
> - **不要输出 JSON 格式的工具调用，也不要对字符串做 JSON 转义**

### 2.2 为什么这个设计更好（对比 web-login 的 JSON 协议）

web-login 用 JSON，于是它的协议指令里有大量**转义失败的补救条款**：

> rule 5b: 「两个最容易弄坏 JSON 的地方 —— (a) 值里的引号必须转义为 `\"`；
> (b) 值里不能有真实换行，要写 `\n`」
> rule 6: 「围栏里的 JSON 会**泄漏到可见记录和网页对话里**」

cuckoo 的模板直接**禁止转义**：

> 「多行文本一律使用反引号模板字符串，直接换行，**不需要任何转义**」

**这是本质差异**：JSON 协议要求模型做转义（易错），JS 模板字符串不要求（不会错）。
而且 cuckoo 用 `await read(...)` 这种**函数调用形态**，模型见过的代码比构造的 JSON 多得多。

### 2.3 cuckoo 的工具目录格式（`ToolRegistry.getFormattedJsApiForPrompt`）

```ts
return descriptions.map((t, i) => {
  const sig = '`' + t.jsApi + '`';
  return (i + 1) + '. ' + sig + ' — ' + t.description;
}).join('\n');
```

即 **`1. \`read(path)\` — 读取文件`** 一行一个工具。
另有 `api.d.ts`（14.9KB）作为 TypeScript 类型声明给模型看参数细节。

## 三、本插件的设计

### 3.1 协议：抄 cuckoo 的 JS 代码块

````
需要调用工具时，输出一个 ```ldw 代码块，块外不要有任何文字：

```ldw
const r = await read("src/index.ts");
log(r);
```

- 多行文本用反引号模板字符串，直接换行，不做任何转义
- 不要输出 JSON 格式的工具调用
````

**为什么不用 cuckoo 的完整模板**：cuckoo 的模板是给「Cuckoo Code 助手」的
完��系统提示词（含身份、原则、项目信息）。本插件在 **adapter 位置**，
system 由 DSH 提供（实测：`role:'system'` 消息 3 条）。
所以本插件只补**协议段**（怎么调工具），不重写身份。

### 3.2 工具目录：分级下发（抄 cuckoo 的「签名 + 一句话」）

| 级别 | 内容 | 依据 |
|---|---|---|
| 全部工具 | `` `name(签名)` — 首句描述 `` 一行 | cuckoo 的 `getFormattedJsApiForPrompt` |
| 无参数细节 | 参数从 `parameters` JSON Schema 生成签名 | cuckoo 的 `api.d.ts` 思路 |

**不抄 web-login 的分级**（核心 13 个完整 + 长尾一行）—— 用户要求只参考 cuckoo。
cuckoo 对**所有**工具都是「签名 + 一句话」，没有核心/长尾之分。

体量估算：60 个工具 × 平均 80 字符 ≈ **5,000 字符**（对比 web-login 的 5 万）。

### 3.3 消息序列化（DSH 词汇 → 文本）

| DSH 块 | 文本形态 |
|---|---|
| `text` | 原样 |
| `reasoning` | `[thinking] …`（或省略，见下） |
| `tool-call` | ` ```ldw\nconst r = await <name>(<args>);\nlog(r);\n``` ` |
| `role:'tool'` 消息 | `【工具结果】\n<content>` |

⚠️ **reasoning 要不要发**：cuckoo 不把模型的思考回灌（它是 harness，
每轮只发新消息）。本插件同理 —— reasoning 只用于 DSH 侧展示，
**不进网页 prompt**（避免网页记录里堆思考垃圾，那正是参考实现记录的
「网页端思考区出现标记」问题）。

### 3.4 流式捕获：hold-back 扫描器

模型输出 ` ```ldw ` 代码块时，**不能让它流进正文**（会显示在网页记录里）。
必须做 hold-back：检测到 ```ldw 开头就缓冲，直到 ``` 闭合，然后：
1. 把代码块解析成 `tool-call` 块
2. 块外文本正常流出

**与 cuckoo 的差异**：cuckoo 的 `JsRunner` 直接在页面里执行 JS（它有沙箱）。
本插件**不执行** —— 只把调用解析出来交给 DSH，由 DSH 执行
（因为工具是 DSH 的，本插件没有执行权限）。这是架构位置决定的。

### 3.5 请求密度（抄 cuckoo）

cuckoo 用 `randomDelay()` **2000~4000ms** 随机区间（本插件已实现）。
cuckoo **没有**长休机制 —— 所以本插件**也不加**（用户要求只参考 cuckoo）。

## 四、实现清单

| 步骤 | 文件 | 验证 |
|---|---|---|
| 1. 工具目录格式化 | `src/host/tool-catalog.ts` | 单测：签名生成 + 体量预算 |
| 2. 协议段文本 | 同上 | 单测：内容断言 |
| 3. 消息序列化（含 tool-call/tool 消息） | `src/host/serialize.ts` | 单测：用实测形状往返 |
| 4. hold-back 扫描器 | `src/client/tool-scan.ts` | 单测：用实测代码块样本 |
| 5. tool-call chunk 发射 | `src/host/adapter.ts` | 单测：chunk 契约 |
| 6. 端到端 | probe | 真浏览器：发「现在几点」→ 应触发工具调用 |

## 五、验收标准

- [ ] 模型能输出 ```ldw 块并被解析成合法 `tool-call` chunk
- [ ] 代码块**不泄漏**到正文（网页记录里看不到）
- [ ] 工具结果作为下一轮增量发出
- [ ] 工具目录体量 < 8,000 字符（对比 web-login 的 5 万）
- [ ] 首轮 prompt 体量可控，后续轮只发增量
