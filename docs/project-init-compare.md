# cuckoo 的「项目初始化」vs 本插件（实测对比）

> 用户指出：「cuckoo 每次还会初始化项目什么的」。
> 这份文档逐条核对 cuckoo 注入的 6 类内容，明确**哪些要补、哪些绝对不能补**。

## 一、cuckoo 初始化了什么

cuckoo 是 harness，`initProject()` 在进入项目时把 6 类内容打进 AI 页面
（`src/session/prompt-builder.ts` 的 `buildPrompt()`）：

| # | 章节 | 占位符 | 来源 |
|---|---|---|---|
| 1 | 平台信息 | `{{PLATFORM_INFO}}` | `process.platform` / `arch` |
| 2 | 项目目录 | `{{PROJECT_DIR}}` | 用户选的目录 |
| 3 | 项目介绍 | `{{PROJECT_INTRO_SECTION}}` | `.cuckoo/CUCKOO.md` |
| 4 | 工具清单 | `{{TOOLS_LIST}}` + `{{TOOL_API_TYPES}}` | 工具注册表 |
| 5 | 技能清单 | `{{SKILLS_SECTION}}` | `scanSkills()` |
| 6 | MCP 清单 | `{{MCP_SECTION}}` | 已启用的 MCP server |

外加**完整的身份与原则**（「你是一个由 Cuckoo Code 驱动的 AI 编程助手」、
「先思考再编码」「简洁至上」…）。

## 二、DSH 已经给了什么（实测）

解压最新会话（`~/.dsh/sessions/*.jsonl.zstd`，**分帧 zstd**）读消息：

### 2.1 system 消息（5943 字符）

末尾就是工作目录：

```
Your working directory is F:\Code\DSH-Code\dsh-webin.
```

还含工具使用指引（「Use the read tool — not shell commands like cat」等）。
**不含** AGENTS.md、不含工具目录。

### 2.2 AGENTS.md 走的是 **user 消息**，不是 system

`@deepseek-ai/dsh-agent-instructions/lib/index.js`：

```js
import { createUserMessage } from "@deepseek-ai/dsh-llm";
const DEFAULT_INSTRUCTION_FILE_CANDIDATES = ["AGENTS.md", "CLAUDE.md"];
const SYSTEM_REMINDER_OPEN = "<system-reminder>";
const AGENT_INSTRUCTIONS_INTRO = "The following workspace instructions may be relevant to your work…"
```

实测：**最新 4 个会话全部含** `system-reminder` + `AGENTS.md` + `HANSHUANG`
（即 `~/.dsh/AGENTS.md` 的内容）。

⇒ 本插件在 adapter 位置，**这些 user 消息会原样进入 `options.messages`**，
自动被序列化发出。**不需要额外做什么**。

### 2.3 工具目录走 `options.tools`

`dsh-llm/lib/index.js:2312`：

```js
const projectedTools = projectToolUpdates(projectedMessages, resolvedOptions.tools, …);
iterator = dispatch(this.forAdapter(projectedOptions, adapter))[Symbol.asyncIterator]();
```

`forAdapter` 只改 messages，**`tools` 原样透传**。
⇒ 本插件能拿到完整工具清单（已在 `tool-protocol.ts` 实现格式化）。

## 三、逐条结论

| # | cuckoo 章节 | DSH 是否已给 | 本插件怎么做 |
|---|---|---|---|
| 1 | 平台信息 | ✅ system 里有 pwsh/PowerShell 指引 | **不补**（重复占体量） |
| 2 | 项目目录 | ✅ system 末尾「working directory is …」 | **不补**（同上） |
| 3 | 项目介绍 | ✅ AGENTS.md 走 user 消息自动进入 | **不补**（已自动带上） |
| 4 | 工具清单 | ⚠️ 走 `options.tools`，需自己格式化 | **已实现** |
| 5 | 技能清单 | ✅ skill 工具在工具清单里 | 不补 |
| 6 | MCP 清单 | ✅ MCP 工具在工具清单里 | 不补 |
| — | 身份与原则 | ✅ system 提供（「You are a coding agent…」） | **不补**（重复会与 DSH 冲突） |

**只有第 4 项要自己做** —— 而且已经做完了。

## 四、为什么不能照抄 cuckoo 的全部初始化

三个理由，每个都有实测依据：

### 4.1 位置不同：cuckoo 是 harness，本插件是 adapter

cuckoo 自己驱动 AI 页面，**system 由它提供**，所以它必须写完整身份+原则。
本插件在 DSH 的 adapter 位置，**system 由 DSH 提供**（实测 5943 字符）。
再注入一份身份 = 两份冲突的指令，模型行为会摇摆。

### 4.2 体量是封号风险（参考实现的血证）

`dsh-deepseek-web-login` 实测记录：

> 「会话内实测单次输入从 9.7k token 一路涨到 **293k**…
> 四个账号两天内陆续被限制，**体量是主要嫌疑**」

重复注入项目目录/平台信息 = 白占体量，直接推高风险。

### 4.3 差分发送已经保证「只发一次」

cuckoo 的 `initProject()` 在**每次进入项目**时重发整段提示词 ——
因为它没有差分机制（每次 `sendToChat` 是新消息，但系统提示词靠手动重发）。

本插件的差分发送（`diffPrompt`）保证：
- 首轮：system + **工具目录** + 协议 + 全部消息
- 后续轮：**只有增量**（实测 11 字符 vs 首轮 533 字符）

⇒ 工具目录天然「只发一次」，不需要额外的初始化动作。

## 五、实测数据

```
首轮 prompt: 533 字符（system + 工具协议 + 工具目录 + 首条消息）
第二轮 prompt: 11 字符（只有增量）
```

对比 cuckoo：每次初始化重发约 6 万字符（工具目录 + 模板 + 项目信息）。

## 六、如果将来要补「项目介绍」

`AGENTS.md` 已由 DSH 自动注入，所以**当前不需要**。
若用户想要类似 `.cuckoo/CUCKOO.md` 的项目自述文件，
正确做法是**让用户把内容写进 `AGENTS.md`**（DSH 已有机制），
而不是本插件自己读文件再注入 —— 那会与 DSH 的机制重复。
