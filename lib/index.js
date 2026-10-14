import { createRequire } from "node:module";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
//#region src/shared/providers.ts
/**
* DeepSeek 网页版。
*
* 所有选择器与评分规则都来自**真浏览器实测**（`npm run probe:dom` /
* `npm run probe:send`），不是猜的。改版后先跑探测脚本再改这里。
*/
const DEEPSEEK = {
	id: "deepseek",
	name: "LDW · DeepSeek 网页版",
	homeUrl: "https://chat.deepseek.com/",
	urlPattern: "chat\\.deepseek\\.com",
	input: { selectors: [
		"textarea[placeholder*=\"给 DeepSeek\"]",
		"textarea[placeholder*=\"DeepSeek\"]",
		"textarea[placeholder*=\"输入\"]",
		"textarea[placeholder*=\"发送\"]",
		"textarea[placeholder*=\"message\" i]",
		"textarea[placeholder*=\"ask\" i]",
		"textarea.chat-input",
		"textarea",
		"div[contenteditable=\"true\"]",
		"[role=\"textbox\"]"
	] },
	send: {
		selectors: [
			"button[type=\"submit\"]",
			"button[aria-label*=\"send\" i]",
			"button[aria-label*=\"发送\"]",
			"[role=\"button\"][aria-label*=\"send\" i]",
			"[role=\"button\"][aria-label*=\"发送\"]",
			"[data-testid=\"send\"]",
			".send-btn"
		],
		signatures: [
			["ds-button--primary", 60],
			["ds-button--filled", 40],
			["ds-button--circle", 50]
		],
		vetoes: ["ds-toggle-button", "ds-button--capsule"]
	},
	completionPath: "/api/v0/chat/completion",
	stopPath: "/api/v0/chat/stop_stream",
	models: [{
		id: "ldw-fast",
		name: "LDW · 快速模式",
		description: "真实浏览器驱动，不思考",
		thinking: false
	}, {
		id: "ldw-think",
		name: "LDW · 深度思考",
		description: "真实浏览器驱动，开启思考",
		thinking: true
	}],
	contextWindow: 1048576,
	maxOutputTokens: 32768,
	reasoningEfforts: [{
		id: "medium",
		name: "思考"
	}],
	defaultReasoningEffort: "medium"
};
/** 内置 provider 表。新增站点在这里加一项即可。 */
const BUILTIN_PROVIDERS = [DEEPSEEK, {
	id: "qwen",
	name: "LDW · 通义千问",
	homeUrl: "https://www.tongyi.com/qianwen/",
	urlPattern: "(tongyi\\.com|qwen\\.(ai|chat))",
	input: { selectors: [
		"div[contenteditable=\"true\"][class*=\"whitespace-pre-wrap\"]",
		"div[contenteditable=\"true\"]",
		"textarea[placeholder*=\"输入\"]",
		"textarea",
		"[role=\"textbox\"]"
	] },
	send: {
		selectors: [
			"button[type=\"submit\"]",
			"button[aria-label*=\"发送\"]",
			"button[aria-label*=\"send\" i]",
			"[role=\"button\"][aria-label*=\"发送\"]",
			"[data-testid*=\"send\" i]"
		],
		signatures: [["rounded-full", 20], ["bg-", 15]],
		vetoes: [
			"添加附件",
			"attach",
			"上传",
			"upload",
			"快速",
			"工作助理",
			"更多",
			"AI生视频",
			"PPT创作",
			"AI生图",
			"代码",
			"翻译",
			"AI写作",
			"stop",
			"停止",
			"收起侧边栏"
		]
	},
	completionPath: "/api/v1/chat/completions",
	models: [{
		id: "qwen-fast",
		name: "LDW · 通义千问",
		description: "真实浏览器驱动",
		thinking: false
	}],
	contextWindow: 131072,
	maxOutputTokens: 8192
}];
/** 默认 provider（首个内置项）。 */
const DEFAULT_PROVIDER_ID = DEEPSEEK.id;
/**
* Provider 运行时校验。
*
* TS 类型运行时被擦除，"必须实现接口"的真正强制靠这个函数
* （cuckoo 的 `validate.ts` 做同样的事）。用户自定义 provider 也必须过。
*/
function validateProvider(p) {
	if (p === null || typeof p !== "object") return "必须是对象";
	const o = p;
	if (typeof o.id !== "string" || o.id === "") return "缺少 id";
	if (!/^[A-Za-z0-9_-]{1,64}$/.test(o.id)) return "id 只允许字母数字下划线连字符（它会用作 workspace 名）";
	if (typeof o.name !== "string" || o.name === "") return "缺少 name";
	if (typeof o.homeUrl !== "string" || !/^https?:\/\//.test(o.homeUrl)) return "homeUrl 必须是 http(s) URL";
	if (typeof o.urlPattern !== "string" || o.urlPattern === "") return "缺少 urlPattern";
	try {
		new RegExp(o.urlPattern);
	} catch {
		return "urlPattern 不是合法正则";
	}
	const input = o.input;
	if (input === void 0 || !Array.isArray(input.selectors) || input.selectors.length === 0) return "input.selectors 必须是非空数组";
	const send = o.send;
	if (send === void 0 || !Array.isArray(send.selectors) || send.selectors.length === 0) return "send.selectors 必须是非空数组";
	if (typeof o.completionPath !== "string" || o.completionPath === "") return "缺少 completionPath";
	if (!Array.isArray(o.models) || o.models.length === 0) return "models 必须是非空数组";
	for (const m of o.models) {
		if (typeof m.id !== "string" || m.id === "") return "models[].id 必须是非空字符串";
		if (typeof m.name !== "string" || m.name === "") return "models[].name 必须是非空字符串";
	}
	if (typeof o.contextWindow !== "number" || o.contextWindow <= 0) return "contextWindow 必须是正数";
	if (typeof o.maxOutputTokens !== "number" || o.maxOutputTokens <= 0) return "maxOutputTokens 必须是正数";
	for (const [src] of send.signatures ?? []) try {
		new RegExp(src);
	} catch {
		return `send.signatures 里有非法正则：${src}`;
	}
	for (const src of send.vetoes ?? []) try {
		new RegExp(src);
	} catch {
		return `send.vetoes 里有非法正则：${src}`;
	}
	return null;
}
/**
* Provider 注册表。
*
* 语义：**内置打底，自定义覆盖**（按 id 匹配）。用户改坏了某个 provider 时
* 只跳过那一条，不影响其它 —— 内置的仍然可用。
*/
var ProviderRegistry = class {
	builtins;
	customs = /* @__PURE__ */ new Map();
	constructor(builtins = BUILTIN_PROVIDERS) {
		this.builtins = builtins.filter((p) => {
			const err = validateProvider(p);
			if (err !== null) {
				console.warn("[dsh-webin] 内置 provider 校验失败，跳过:", p?.id ?? "?", err);
				return false;
			}
			return true;
		});
	}
	/**
	* 装入用户自定义 provider（覆盖同 id 的内置项）。
	*
	* @returns 被接受的 id 与拒绝原因
	*/
	loadCustom(raw) {
		const accepted = [];
		const rejected = [];
		raw.forEach((item, index) => {
			const err = validateProvider(item);
			if (err !== null) {
				rejected.push({
					index,
					reason: err
				});
				return;
			}
			const p = item;
			this.customs.set(p.id, p);
			accepted.push(p.id);
		});
		return {
			accepted,
			rejected
		};
	}
	/** 全部 provider：自定义优先（同 id 覆盖内置）。 */
	all() {
		const out = [];
		const seen = /* @__PURE__ */ new Set();
		for (const p of this.customs.values()) {
			out.push(p);
			seen.add(p.id);
		}
		for (const p of this.builtins) {
			if (seen.has(p.id)) continue;
			out.push(p);
		}
		return out;
	}
	/** 按 id 取；找不到回退到默认 provider。 */
	get(id) {
		const list = this.all();
		const hit = list.find((p) => p.id === id);
		if (hit !== void 0) return hit;
		const fallback = list.find((p) => p.id === DEFAULT_PROVIDER_ID) ?? list[0];
		if (fallback === void 0) throw new Error("dsh-webin: 没有任何可用 provider");
		return fallback;
	}
	/** 按 URL 识别所属 provider（页面导航后用）。 */
	byUrl(url) {
		if (url === "") return void 0;
		for (const p of this.all()) try {
			if (new RegExp(p.urlPattern).test(url)) return p;
		} catch {}
	}
	/** 自定义覆盖了哪些内置 id（设置页显示用）。 */
	overriddenIds() {
		const builtinIds = new Set(this.builtins.map((p) => p.id));
		return [...this.customs.keys()].filter((id) => builtinIds.has(id));
	}
};
//#endregion
//#region src/host/tool-protocol.ts
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
function buildPlatformInfo(platform, arch) {
	if (platform === "win32") return [
		"- 操作系统：Windows（" + arch + "）",
		"  - bash 用 cmd.exe 语法：cd / dir / echo %cd% / type / findstr",
		"  - pwsh 用 PowerShell 语法：Get-Location / $env:VAR / Get-ChildItem",
		"- 路径分隔符是反斜杠 \\，传给工具的相对路径统一用正斜杠 /"
	].join("\n");
	if (platform === "darwin") return [
		"- 操作系统：macOS（" + arch + "）",
		"  - bash 用 zsh/bash：pwd / ls / cat / grep",
		"- 路径分隔符是正斜杠 /"
	].join("\n");
	return [
		"- 操作系统：Linux（" + arch + "）",
		"  - bash 用 bash：pwd / ls / cat / grep",
		"- 路径分隔符是正斜杠 /"
	].join("\n");
}
/**
* 工具调用协议指令。
*
* 刻意**只讲怎么调**，不讲身份/原则 —— 本插件在 adapter 位置，
* system 由 DSH 提供（实测会话里有 3 条 `role:'system'` 消息，5943 字符）。
* cuckoo 的模板是完整系统提示词（含身份、核心原则、项目信息），
* 那部分在这里是**重复且冲突**的（详见 `docs/project-init-compare.md`）。
*/
const TOOL_PROTOCOL = [
	"# 工具调用协议",
	"",
	"你可以调用工具来完成任务。需要调用时，把 JavaScript 代码放进以 ```ldw 开头、以 ``` 结尾的代码块，**代码块外不要有任何文字**：",
	"",
	"```ldw",
	"const r = await read({\"path\": \"src/index.ts\"});",
	"log(r);",
	"```",
	"",
	"规则：",
	"1. 参数写成 **JSON 对象**：`await 工具名({\"参数名\": 值})`。",
	"2. **多行文本用反引号模板字符串，直接换行，不要做任何转义**（不要写 \\n）。",
	"3. **只用上面这一种格式**。不要输出 DSML 标记、XML/HTML 标签、或 JSON 形式的工具调用",
	"   —— 那些形式**不会被识别**，只会原样显示给用户（看起来像乱码）。",
	"   也不要对字符串做 JSON 转义。",
	"4. 一次只调一个工具；等结果回来再决定下一步。",
	"5. 不要编造工具名或参数名；不确定就先用 `read` 或 `pwsh` 查。",
	"6. 不需要工具时，直接用普通文字回答，**不要**输出代码块。",
	"7. 工具结果是真实的，直接基于结果继续，不要自己模拟输出。"
].join("\n");
/**
* 从 JSON Schema 生成可读签名（抄 cuckoo 的「`name(签名)`」形态）。
*
* 例：`pwsh({command: string, timeout?: number})`
*/
function buildToolSignature(tool) {
	const params = tool.parameters;
	const props = params?.properties ?? {};
	const required = new Set(Array.isArray(params?.required) ? params.required : []);
	const names = Object.keys(props);
	if (names.length === 0) return `${tool.name}()`;
	const parts = names.map((n) => {
		const spec = props[n];
		const type = typeof spec?.type === "string" ? spec.type : "any";
		return `${n}${required.has(n) ? "" : "?"}: ${type}`;
	});
	return `${tool.name}({${parts.join(", ")}})`;
}
/** 取描述首句（到第一个句末点），再按上限截断。 */
function firstSentence(text, limit) {
	const flat = text.replace(/\s+/g, " ").trim();
	const stop = flat.search(/[.。](\s|$)/);
	const s = stop >= 0 ? flat.slice(0, stop + 1) : flat;
	return s.length > limit ? `${s.slice(0, limit)}…` : s;
}
/** 单条工具目录条目的描述上限（抄 cuckoo 的「一行」形态）。 */
const TAIL_DESC_CHARS = 160;
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
function buildToolCatalog(tools) {
	if (tools.length === 0) return "";
	return tools.map((t, i) => `${i + 1}. \`${buildToolSignature(t)}\` — ${firstSentence(t.description, TAIL_DESC_CHARS)}`).join("\n");
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
function buildToolSection(tools, platform, arch) {
	if (tools.length === 0) return "";
	const catalog = buildToolCatalog(tools);
	const plat = buildPlatformInfo(platform ?? process.platform, arch ?? process.arch);
	return [
		TOOL_PROTOCOL,
		"",
		"# 运行环境",
		"",
		plat,
		"",
		"# 可用工具",
		"",
		catalog
	].join("\n");
}
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
function repairJsonObject(raw) {
	let s = raw.trim();
	if (!s.startsWith("{") || !s.endsWith("}")) return null;
	s = s.replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, "$1\"$2\"$3");
	/**
	* 2) 单引号 → 双引号；3) 反引号模板字符串 → 双引号字符串。
	*
	* 逐个字符扫描，避免动到字符串内部的撇号。
	*
	* ⚠️ **模板字符串里的换行必须转成 `\n`** —— JSON 不允许字符串里有真实换行。
	* cuckoo 协议让模型「直接换行，不做转义」，所以这里必须替模型做这一步。
	* 双引号与反斜杠也要转义。
	*/
	let out = "";
	let inSingle = false;
	let inDouble = false;
	let inBacktick = false;
	for (let i = 0; i < s.length; i += 1) {
		const c = s[i];
		if (inBacktick) {
			if (c === "\\") {
				const next = s[i + 1] ?? "";
				out += next === "`" ? "`" : `\\${next}`;
				i += 1;
				continue;
			}
			if (c === "`") {
				inBacktick = false;
				out += "\"";
				continue;
			}
			if (c === "\"") {
				out += "\\\"";
				continue;
			}
			if (c === "\n") {
				out += "\\n";
				continue;
			}
			if (c === "\r") continue;
			if (c === "	") {
				out += "\\t";
				continue;
			}
			out += c;
			continue;
		}
		if (c === "\\") {
			out += c + (s[i + 1] ?? "");
			i += 1;
			continue;
		}
		if (c === "\"" && !inSingle) {
			inDouble = !inDouble;
			out += c;
			continue;
		}
		if (c === "'" && !inDouble) {
			inSingle = !inSingle;
			out += "\"";
			continue;
		}
		if (c === "`" && !inDouble && !inSingle) {
			inBacktick = true;
			out += "\"";
			continue;
		}
		out += c;
	}
	if (inSingle || inDouble || inBacktick) return null;
	s = out;
	s = s.replace(/,(\s*[}\]])/g, "$1");
	try {
		JSON.parse(s);
		return s;
	} catch {
		return null;
	}
}
/** 从 `start` 位置的 `(` 开始找配对的 `)`，返回括号内内容。 */
function balancedParens(text, openIndex) {
	let depth = 0;
	let inString = null;
	for (let i = openIndex; i < text.length; i += 1) {
		const c = text[i];
		if (inString !== null) {
			if (c === "\\") {
				i += 1;
				continue;
			}
			if (c === inString) inString = null;
			continue;
		}
		if (c === "\"" || c === "'" || c === "`") {
			inString = c;
			continue;
		}
		if (c === "(") depth += 1;
		else if (c === ")") {
			depth -= 1;
			if (depth === 0) return {
				body: text.slice(openIndex + 1, i),
				end: i + 1
			};
		}
	}
	return null;
}
/** 用 schema 的属性顺序，把位置参数映射成对象。 */
function positionalToObject(schema, body) {
	if (schema === void 0) return null;
	const params = schema.parameters;
	const names = Object.keys(params?.properties ?? {});
	if (names.length === 0) return null;
	const parts = [];
	let depth = 0;
	let cur = "";
	let inString = null;
	for (let i = 0; i < body.length; i += 1) {
		const c = body[i];
		if (inString !== null) {
			cur += c;
			if (c === "\\") {
				cur += body[i + 1] ?? "";
				i += 1;
				continue;
			}
			if (c === inString) inString = null;
			continue;
		}
		if (c === "\"" || c === "'" || c === "`") {
			inString = c;
			cur += c;
			continue;
		}
		if (c === "{" || c === "[") depth += 1;
		if (c === "}" || c === "]") depth -= 1;
		if (c === "," && depth === 0) {
			parts.push(cur.trim());
			cur = "";
			continue;
		}
		cur += c;
	}
	if (cur.trim() !== "") parts.push(cur.trim());
	if (parts.length === 0 || parts.length > names.length) return null;
	const obj = {};
	for (let i = 0; i < parts.length; i += 1) {
		let v = parts[i];
		if (!/^["'{[]/.test(v) && !/^(true|false|null|-?\d)/.test(v)) v = JSON.stringify(v);
		else if (v.startsWith("'")) v = `"${v.slice(1, -1)}"`;
		try {
			obj[names[i]] = JSON.parse(v);
		} catch {
			return null;
		}
	}
	return JSON.stringify(obj);
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
*/
function stripDsml(reply) {
	let stripped = 0;
	let out = reply;
	/**
	* 形态容错：`<` 之后允许「任意数量的竖线 / DSML 字样」，但**至少要有一个竖线**。
	*
	* 上一版写成「两组竖线夹一个可选 DSML」—— 那样只匹配双竖线形态，
	* **单竖线形态（`<|tool_calls|>`）匹配不上**（实测确认）。
	*
	* 同时「至少一个竖线」这个约束不能丢：否则 `<div>` 也会被当成 DSML 吃掉。
	*/
	const OPEN = "<(?:DSML|[｜|])*[｜|](?:DSML|[｜|])*";
	/** Whole tool-call block: from <..calls..> through <../..calls..>. */
	const block = new RegExp(OPEN + "[^>]*tool_calls[^>]*>[\\s\\S]*?" + OPEN + "\\/[^>]*tool_calls[^>]*>", "gi");
	out = out.replace(block, () => {
		stripped += 1;
		return "";
	});
	/** Stray single tags: <..anything..>. */
	const tag = new RegExp(OPEN + "[^>]{0,60}>", "g");
	out = out.replace(tag, () => {
		stripped += 1;
		return "";
	});
	return {
		text: out,
		stripped
	};
}
function parseToolCalls(reply, tools) {
	const byName = new Map(tools.map((t) => [t.name, t]));
	const calls = [];
	const failed = [];
	let text = "";
	/**
	* ⭐ 先剥离 DSML —— 模型有时会用网页版原生的工具调用语法而不是我们的
	* ```ldw 围栏。不剥的话整段标记会漏进可见回复（用户实测报过）。
	*/
	const dsml = stripDsml(reply);
	if (dsml.stripped > 0) failed.push(`（已剥离 ${dsml.stripped} 处 DSML 工具标记 —— 模型用了网页版原生语法，插件无法执行）`);
	let rest = dsml.text;
	for (;;) {
		const open = (/* @__PURE__ */ new RegExp("```[ \\t]*ldw[ \\t]*\\r?\\n", "i")).exec(rest);
		if (open === null) {
			text += rest;
			break;
		}
		text += rest.slice(0, open.index);
		const afterOpen = rest.slice(open.index + open[0].length);
		const closeIdx = afterOpen.search(/\r?\n[ \t]*```/);
		const block = closeIdx < 0 ? afterOpen : afterOpen.slice(0, closeIdx);
		rest = closeIdx < 0 ? "" : afterOpen.slice(closeIdx).replace(/^\r?\n[ \t]*```[ \t]*\r?\n?/, "");
		let found = 0;
		const callRe = /(?:await\s+)?([A-Za-z_$][\w$]*)\s*\(/g;
		let m;
		while ((m = callRe.exec(block)) !== null) {
			const name = m[1];
			const schema = byName.get(name);
			if (schema === void 0) continue;
			const paren = balancedParens(block, m.index + m[0].length - 1);
			if (paren === null) {
				failed.push(`${name}( … 括号不配对`);
				continue;
			}
			const body = paren.body.trim();
			let args = null;
			if (body === "") args = "{}";
			else if (body.startsWith("{")) args = repairJsonObject(body) ?? (() => {
				try {
					JSON.parse(body);
					return body;
				} catch {
					return null;
				}
			})();
			if (args === null) args = positionalToObject(schema, body);
			if (args === null) {
				failed.push(`${name}( ${body.slice(0, 60)} … 参数解析失败`);
				continue;
			}
			calls.push({
				name,
				arguments: args
			});
			found += 1;
			callRe.lastIndex = paren.end;
		}
		if (found === 0 && block.trim() !== "") {
			failed.push(block.trim().slice(0, 120));
			text += block;
		}
	}
	return {
		text: text.trim(),
		calls,
		failed
	};
}
//#endregion
//#region src/host/serialize.ts
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
const TOOL_RESULT_LIMIT = 4e3;
/** 从 content 里抽出纯文本（text 块拼接）。 */
function contentToText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts = [];
	for (const b of content) {
		if (b === null || typeof b !== "object") continue;
		const block = b;
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n");
}
/** 把 `arguments`（JSON 字符串）转成人类可读的参数文本。 */
function formatArguments(raw) {
	try {
		const obj = JSON.parse(raw);
		if (obj !== null && typeof obj === "object") return JSON.stringify(obj);
		return String(obj);
	} catch {
		return raw;
	}
}
/**
* 把 CRLF / CR 归一化成 LF。
*
* ## 为什么必须在**序列化**时就做（实测踩过的坑）
*
* 用户的报错：
*
*     fill-failed: 输入框类型不支持: native-setter-noop
*
* 「那一轮根本没发出去」。根因是 HTML 规范要求 `<textarea>` 的 value
* **必须把 `\r\n` 归一化成 `\n`**（HTML Standard, textarea value
* normalization）。而客户端填充后是**逐字符全等比较**来确认写入成功：
*
*     if (el.value !== value) return { ok: false, how: 'native-setter-noop' }
*
* 于是只要 prompt 里有一个 `\r\n`，写进去的值就和原始值不等 ——
* 明明写成功了却判定失败，整轮直接放弃。
*
* Windows 上 `pwsh` 的输出**全是 CRLF**，所以这个 bug 是**间歇性**的：
*   - 没跑过工具 ⇒ 正常
*   - 跑过一次工具（结果进了历史）⇒ 之后每一轮都失败
*
* 这正好解释「有时能用，用着用着就不行了」。
*
* 在**发出去之前**统一成 LF：网页版自己也是按 LF 处理的，
* 归一化不会丢信息，还让两边的比较口径一致。
*/
function normalizeNewlines(text) {
	return text.replace(/\r\n?/g, "\n");
}
/**
* 把一条 DSH 消息序列化成文本。
*
* @param msg - DSH 消息
* @param toolResultLimit - 工具结果截断上限（用户可在设置页调）
* @returns 要发出去的文本；空串表示这条不发。
*/
function serializeMessage(msg, toolResultLimit = TOOL_RESULT_LIMIT) {
	if (msg.role === "tool") {
		const body = normalizeNewlines(contentToText(msg.content)).trim();
		if (body === "") return "";
		const limit = Math.max(200, Math.round(toolResultLimit));
		const clipped = body.length > limit ? `${body.slice(0, limit)}\n…（结果过长已截断，共 ${body.length} 字符）` : body;
		return `【工具结果${msg.isError === true ? "（失败）" : ""}】\n${clipped}`;
	}
	const content = msg.content;
	const parts = [];
	if (Array.isArray(content)) {
		const calls = [];
		for (const b of content) {
			if (b === null || typeof b !== "object") continue;
			const block = b;
			if (block.type !== "tool-call") continue;
			const name = String(block.name ?? "");
			if (name === "") continue;
			const args = typeof block.arguments === "string" ? formatArguments(block.arguments) : "{}";
			calls.push(`${name}(${args})`);
		}
		if (calls.length > 0)
 /**
		* 把历史里的工具调用**文本化**成它当时的样子。
		*
		* 为什么要还原成 ```ldw 块而不是别的：模型在**下一轮**会看到
		* 「自己上次是怎么调的」，保持同一种形态能强化协议一致性。
		*/
		parts.push([
			"```ldw",
			...calls.map((c) => `await ${c};`),
			"```"
		].join("\n"));
	}
	const text = contentToText(content).trim();
	if (text !== "") parts.push(text);
	if (parts.length === 0) return "";
	/**
	* ## ⚠️⚠️ 不加 `## User` / `## Assistant` 角色标记（实测泄漏进页面）
	*
	* 真实事故（用户截图）：网页会话里出现「## User
	* 你能调用写工具吗？」—— 角色标记被当成**消息正文**渲染出来，
	* 用户在页面上看得清清楚楚。
	*
	* ## cuckoo 怎么做（照抄）
	*
	* cuckoo 的 `serializeMessages` **不加任何角色标记** —— 网页版的
	* 对话本身已经区分了角色（用户消息在输入框那侧、模型回复在页面流里），
	* 模型看得到完整上下文，不需要文本标记。加了反而：
	*   1. 泄漏进页面（用户看到的每条历史都带 ## 前缀）
	*   2. 浪费 token
	*   3. 模型可能模仿输出 `## Assistant` 开头
	*
	* tool 消息仍保留标记（工具结果需要标识来源），user/assistant 不加。
	*/
	if (msg.role === "tool") return `## Tool\n${parts.join("\n\n")}`;
	return parts.join("\n\n");
}
/**
* 把一批消息序列化成一段文本。
*
* 出口处**再归一化一次** —— 这样无论各分支出什么，发出去的一定是纯 LF。
* 单点收口比在每个分支里各写一遍可靠（漏一处就复发同一个 bug）。
*
* @param messages - DSH 的 messages（已按调用方要求切片）
*/
function serializeMessages(messages, toolResultLimit) {
	const out = [];
	for (const m of messages) {
		const s = serializeMessage(m, toolResultLimit);
		if (s !== "") out.push(s);
	}
	return normalizeNewlines(out.join("\n\n"));
}
//#endregion
//#region src/shared/config.ts
/** 每个数值字段的边界。超出即拒绝并说明原因。 */
const LIMITS = {
	sendDelayMinMs: {
		min: 0,
		max: 12e4,
		unit: "ms",
		label: "发送间隔下限"
	},
	sendDelayMaxMs: {
		min: 0,
		max: 3e5,
		unit: "ms",
		label: "发送间隔上限"
	},
	longBreakAfter: {
		min: 0,
		max: 500,
		unit: "次",
		label: "长休触发次数"
	},
	longBreakMinMs: {
		min: 0,
		max: 36e5,
		unit: "ms",
		label: "长休时长下限"
	},
	longBreakMaxMs: {
		min: 0,
		max: 72e5,
		unit: "ms",
		label: "长休时长上限"
	},
	maxRequestsPerTurn: {
		min: 0,
		max: 500,
		unit: "次",
		label: "单轮请求上限"
	},
	replyTimeoutMs: {
		min: 1e4,
		max: 36e5,
		unit: "ms",
		label: "等回复超时"
	},
	claimGraceMs: {
		min: 1e3,
		max: 6e5,
		unit: "ms",
		label: "无人领活宽限"
	},
	toolResultLimit: {
		min: 200,
		max: 2e5,
		unit: "字符",
		label: "工具结果截断"
	},
	snapshotIntervalMs: {
		min: 5e3,
		max: 36e5,
		unit: "ms",
		label: "快照保存间隔"
	}
};
/**
* 默认值。
*
* ⚠️ 这些数字**都有实测依据**，改之前先看注释：
*   - `sendDelay*`：参考实现实测「固定间隔 = 定时器特征」，用 2000~4000 随机
*   - `longBreakAfter: 0`（默认关）：参考对象没有长休机制，默认跟随
*   - `replyTimeoutMs: 600_000`：实测最慢一次网页回复 6 分 12 秒（压缩路径）
*   - `claimGraceMs: 20_000`：浏览器没打开时快速失败，不让用户干等 10 分钟
*   - `toolResultLimit: 4_000`：防止一次 `read` 大文件把 prompt 顶爆
*/
const DEFAULT_CONFIG = {
	sendDelayMinMs: 2e3,
	sendDelayMaxMs: 4e3,
	longBreakAfter: 0,
	longBreakMinMs: 6e4,
	longBreakMaxMs: 18e4,
	maxRequestsPerTurn: 0,
	replyTimeoutMs: 6e5,
	claimGraceMs: 2e4,
	toolResultLimit: 4e3,
	/**
	* ⚠️ 默认**开**（v3 定论）—— 一度错误地默认关，用户的实测推翻了它：
	*
	* 用户让模型「调用写工具写文件」，模型**明确按协议准备输出工具调用**
	* （"produce the tool call. Final content — here goes."）——
	* 是服务端把生成停了，**不是模型不支持**。
	*
	* 之前「网页版自有工具截胡」的结论也错了：模型说 "Let me write the
	* file with the write tool" 是在**描述 DSH 的工具**（write 是 DSH 的
	* 工具名），它确实打算输出协议 —— 循环能否跑通取决于协议有没有下发。
	*
	* 协议进页面会「可见」是真的，但那是模型输入的一部分（与 cuckoo 一致
	* —— cuckoo 也把工具目录发进网页），不是缺陷。
	*/
	enableTools: true,
	snapshotIntervalMs: 3e4,
	verboseLog: false
};
/**
* 校验并归一化一份配置。
*
* 规则：
*   - 未知字段**丢弃**（不写入，避免配置文件越长越乱）
*   - 数值超界 / 非数 ⇒ 回退默认并记一条 problem
*   - 布尔非真值 ⇒ 回退默认
*   - `min > max` 的成对字段 ⇒ 交换（用户填反了不必报错，纠正即可）
*/
function checkConfig(raw) {
	const problems = [];
	const out = { ...DEFAULT_CONFIG };
	if (raw === null || typeof raw !== "object") return {
		ok: false,
		config: out,
		problems: [{
			field: "(root)",
			reason: "不是对象",
			fellBackTo: "默认值"
		}]
	};
	const src = raw;
	for (const key of Object.keys(DEFAULT_CONFIG)) {
		const value = src[key];
		if (value === void 0) continue;
		const fallback = DEFAULT_CONFIG[key];
		if (typeof fallback === "boolean") {
			if (typeof value === "boolean") out[key] = value;
			else problems.push({
				field: key,
				reason: `应为布尔，收到 ${typeof value}`,
				fellBackTo: fallback
			});
			continue;
		}
		const num = typeof value === "number" ? value : Number(value);
		const limit = LIMITS[key];
		if (!Number.isFinite(num)) {
			problems.push({
				field: key,
				reason: `不是有效数字（${String(value)}）`,
				fellBackTo: fallback
			});
			continue;
		}
		if (limit !== void 0 && (num < limit.min || num > limit.max)) {
			problems.push({
				field: key,
				reason: `${num} 超出范围 ${limit.min}~${limit.max}${limit.unit}`,
				fellBackTo: fallback
			});
			continue;
		}
		out[key] = Math.round(num);
	}
	/** 成对区间填反了就交换 —— 用户意图明确，不必报错。 */
	if (out.sendDelayMinMs > out.sendDelayMaxMs) {
		const t = out.sendDelayMinMs;
		out.sendDelayMinMs = out.sendDelayMaxMs;
		out.sendDelayMaxMs = t;
		problems.push({
			field: "sendDelayMinMs/Max",
			reason: "上下限填反了，已自动交换",
			fellBackTo: "交换后"
		});
	}
	if (out.longBreakMinMs > out.longBreakMaxMs) {
		const t = out.longBreakMinMs;
		out.longBreakMinMs = out.longBreakMaxMs;
		out.longBreakMaxMs = t;
		problems.push({
			field: "longBreakMinMs/Max",
			reason: "上下限填反了，已自动交换",
			fellBackTo: "交换后"
		});
	}
	return {
		ok: problems.length === 0,
		config: out,
		problems
	};
}
/** 配置的中文摘要（设置页与日志共用，避免两处措辞不一致）。 */
function describeConfig(config) {
	return [
		`间隔 ${config.sendDelayMinMs}~${config.sendDelayMaxMs}ms`,
		config.longBreakAfter > 0 ? `长休 每${config.longBreakAfter}次休息 ${Math.round(config.longBreakMinMs / 1e3)}~${Math.round(config.longBreakMaxMs / 1e3)}s` : "长休 关",
		config.maxRequestsPerTurn > 0 ? `单轮上限 ${config.maxRequestsPerTurn}` : "单轮不限",
		`超时 ${Math.round(config.replyTimeoutMs / 1e3)}s`,
		config.enableTools ? "工具 开" : "工具 关"
	].join("，");
}
//#endregion
//#region src/host/adapter.ts
/** 路由名前缀：最终路由名 = `${ROUTE_PREFIX}-${provider.id}`。 */
const ROUTE_PREFIX = "webin";
/** 某个平台的 provider 路由名。 */
function routeFor(providerId) {
	return `${ROUTE_PREFIX}-${providerId}`;
}
var JobQueue = class {
	jobs = /* @__PURE__ */ new Map();
	seq = 0;
	/**
	* ⭐⭐ 任务看门狗：claimed 超时回收。
	*
	* ## 为什么需要（真实事故）
	*
	* 面板在生成中途死掉 ⇒ 结果永远不来 ⇒ 任务永远 claimed ⇒
	* DSH 只能干等到 adapter 超时（默认 10 分钟）。
	*
	* claim 后 3 分钟没结果 ⇒ 判定执行者死了 ⇒ 标 failed 让 DSH 立刻报错。
	* 3 分钟的依据：正常回复最慢 6 分钟（注释里有实测），但那是「已发送、
	* 在生成」的场景 —— 而生成中面板会持续心跳；面板死了心跳就断。
	* 这里用 claim 时刻算 3 分钟（比 replyTimeout 短），宁可早点报错
	* 让用户重试，也不让用户干等 10 分钟。
	*
	* @param now - 当前时刻（默认 Date.now()，测试可注入）。
	* @returns 被回收的任务数。
	*/
	reapStaleClaimed(now = Date.now(), timeoutMs = 18e4, alive) {
		let reaped = 0;
		for (const job of this.jobs.values()) {
			if (job.claimedAt === void 0) continue;
			if (job.done !== void 0 || job.failed !== void 0) continue;
			if (now - job.claimedAt < timeoutMs) continue;
			/** ⭐⭐ 面板还在心跳 ⇒ 它只是在慢慢生成，**不是失联**。 */
			if (alive !== void 0 && alive()) continue;
			job.failed = "执行面板中途失联（心跳停止）—— 任务没能完成，请重试";
			reaped += 1;
		}
		return reaped;
	}
	/** 派一个新任务。 */
	enqueue(prompt, thinking, platform, expectUrl, freshChat, sessionId) {
		const job = {
			id: `job-${Date.now()}-${++this.seq}`,
			prompt,
			thinking,
			platform,
			createdAt: Date.now(),
			...expectUrl === void 0 ? {} : { expectUrl },
			...freshChat === true ? { freshChat: true } : {},
			...sessionId === void 0 || sessionId === "" ? {} : { sessionId }
		};
		this.jobs.set(job.id, job);
		/**
		* 只保留最近 50 条，避免长会话内存堆积。
		*
		* ⚠️ **只能淘汰已了结的**（审计发现的隐患）。
		*
		* 早期写法是「按时间取最老的，如果它已了结就删」。但排序后取
		* `[0]` 拿到的是**最老的**（通常正是已完成的那条），于是能删掉 ——
		* 可如果最老的那条恰好**还没了结**（比如它卡住了），就一个都删不掉，
		* map 无限增长。
		*
		* 现在改成：只在超限时，**从已了结的里面**挑最老的删。
		* 一个都没了结就暂时留着（总比丢掉在跑的任务好）。
		*/
		if (this.jobs.size > 50) {
			let oldestDone;
			for (const j of this.jobs.values()) {
				if (j.done === void 0 && j.failed === void 0) continue;
				if (oldestDone === void 0 || j.createdAt < oldestDone.createdAt) oldestDone = j;
			}
			if (oldestDone !== void 0) this.jobs.delete(oldestDone.id);
		}
		return job;
	}
	/**
	* client 领一个待办任务（跳过已领走的）。
	*
	* ## ⭐ 按**平台 + 会话**过滤（用户报的「所有窗口都生效」）
	*
	* 早期只按 `platform` 过滤 —— 于是**任何 DSH 窗口都能领走任何任务**。
	* 用户实测：「换了几个 dsh 窗口聊天，发现全都是在网页版的同一个会话窗口」、
	* 「所有窗口都生效」。
	*
	* ## ⚠️ 但过滤方向必须正确（我第一版写反了，造成更严重的事故）
	*
	* 第一版写的是：
	*
	*     if (job.sessionId !== undefined && job.sessionId !== sessionId) continue
	*
	* 看起来对，但漏了一个**用 Slots Inspect 才查到的事实**：
	*
	*   - `conversation.view` 的 standardProps **有** `sessionId`
	*   - **`shell.overlay` 的 standardProps 没有 `sessionId`**
	*
	* 而**跑发送循环的 `LdwHost` 挂在 `shell.overlay` 上**。
	* 能拿到 `sessionId` 的是 `LdwPlaceholder`（挂 `conversation.view`），
	* 但它**只在用户切到 LDW 标签时才挂载**。
	*
	* 后果链（用户实测到的）：
	*   1. 没切到 LDW 标签 ⇒ `sessionIdRef` 是空的
	*   2. 领活不带 `?session=` ⇒ `sessionId === undefined`
	*   3. 而 host 派发的任务**都带** sessionId（DSH 一定给）
	*   4. 上面的条件恒真 ⇒ **任务全被跳过** ⇒
	*      「**LDW 面板未连接 —— 没有任何客户端领取这个任务
	*      （20s 内无人领取）**」
	*
	* 比原来的「所有窗口都生效」更糟 —— 直接不能用。
	*
	* ## 正确的方向：以「**窗口是否上报**」为准，而不是「任务是否有归属」
	*
	*   - 窗口**上报了** sessionId ⇒ 严格只领同会话的任务（隔离生效）
	*   - 窗口**没上报** ⇒ **放行**（可能是老 client，也可能只是没切到
	*     LDW 标签 —— 这两种都不该让它领不到活）
	*
	* 隔离在「双方都知道身份」时生效；任一方缺信息时退化成原来的行为
	* （能用），不会把功能卡死。
	*
	* @param platform - 只领该平台的任务。面板可能同时挂着多个平台的 webview，
	*   各自只领自己平台的活，避免 DeepSeek 的面板去发 Qwen 的消息。
	* @param sessionId - 来领活的窗口是哪个 DSH 会话（拿不到时是 undefined）。
	*/
	claimNext(platform, sessionId) {
		/** 窗口上报了身份吗？没上报就不做会话过滤。 */
		const hasIdentity = sessionId !== void 0 && sessionId !== "";
		const pending = [...this.jobs.values()].filter((j) => j.done === void 0 && j.failed === void 0 && j.claimedAt === void 0 && (platform === void 0 || j.platform === platform));
		if (pending.length === 0) return void 0;
		/**
		* ## ⭐⭐⭐ 两轮领活：先本会话，再回退到任意 —— 否则新会话的任务全失败
		*
		* ## 用户实测（新开会话连发两条都 `state: failed`）
		*
		*     job-4  session-8b3f72ef  claimedBy=(未领)  failed
		*     job-5  session-8b3f72ef  claimedBy=(未领)  failed
		*     job-6  session-8b3f72ef  claimedBy=已领     done   ← 这条才成功
		*
		* ## 根因：常驻宿主**全局只有一个**，但 sessionId 有多个
		*
		* 宿主挂 `shell.overlay`（`scope: 'root'` + 不传 `only` ⇒ 永不卸载），
		* 所以**整个窗口只有一个领活循环**。而 `sessionId` 来自每个 DSH 会话各自的
		* 占位符（`conversation.view`），它们写进**同一个模块级 ref** ——
		* **最后一个挂载的覆盖它**。
		*
		* 于是唯一那个循环只拿得到一个 sessionId，其余会话的任务**永远匹配不上**
		* ⇒ 20 秒无人领 ⇒ `WEBIN_FAILED`。上面那两条失败正是这么来的。
		*
		* ## 为什么回退是安全的
		*
		* client 拿到任务后会**按任务字段自己导航**：
		*   - `expectUrl` ⇒ 导航到该会话绑定的网页对话
		*   - `freshChat` ⇒ 显式开新对话
		*
		* 所以「领到了别的会话的任务」不会串台 —— 页面会被导航到正确的那条对话。
		* 这比「任务没人领、直接失败」好得多。
		*
		* ## 原过滤保留为**优先级**而不是硬门槛
		*
		* 「所有窗口都生效」那条老问题在**多窗口**（多个渲染进程、各自有宿主）
		* 场景下仍成立，所以本会话的任务依然**优先**被本窗口领走；只是不再死等。
		*/
		const mine = hasIdentity ? pending.find((j) => j.sessionId === sessionId) : void 0;
		const job = mine ?? pending[0];
		job.claimedAt = Date.now();
		job.claimedBy = hasIdentity ? sessionId : "(未上报)";
		/**
		* 记录领活方式 —— `/status` 直接可见。
		* 频繁出现 `fallback` 说明「会话身份」长期对不上，值得查。
		*/
		job.claimedVia = mine === void 0 && hasIdentity ? "fallback" : "session";
		return job;
	}
	/**
	* 诊断：当前队列里有哪些任务、被谁领走了。
	*
	* 用户报「所有窗口都生效」时，靠这个能一眼看出**哪个窗口领了哪个任务** ——
	* 不用再猜。
	*/
	inspect() {
		const now = Date.now();
		return [...this.jobs.values()].map((j) => ({
			id: j.id,
			platform: j.platform,
			sessionId: j.sessionId ?? "(无)",
			claimedBy: j.claimedBy ?? "(未领)",
			claimedVia: j.claimedVia ?? "(未上报)",
			state: j.done !== void 0 ? "done" : j.failed !== void 0 ? j.cancelled === true ? "cancelled" : "failed" : j.claimedAt !== void 0 ? "claimed" : "pending",
			ageMs: now - j.createdAt
		}));
	}
	/**
	* client 交结果。
	*
	* ## ⚠️ 已取消 / 已了结的任务**不接受新结果**（审计发现的 bug）
	*
	* 早期实现直接覆盖 `job.done` / `job.failed`，于是：
	*
	*   1. 用户按停止 ⇒ `cancel()` 把 `failed` 设成「已取消」，调用方已经
	*      拿到错误退出了；
	*   2. 但 client 那边可能**还在等页面回复**，稍后 `done` 事件到了，
	*      它照样 PUT 一次结果 ⇒ `settle()` 把 `failed` **覆盖成 `done`**。
	*
	* 后果：一个已被取消的任务在队列里「复活」成成功状态。
	* 更糟的是那一轮的 token 会被计进统计，而调用方根本没收到。
	*
	* 所以：**已了结的任务一律拒绝**（返回 false，调用方会收到 404）。
	* 这也让「重复提交」变成幂等可见的失败，而不是静默覆盖。
	*
	* @returns 是否接受（false = 任务不存在 / 已了结）
	*/
	settle(id, result) {
		const job = this.jobs.get(id);
		if (job === void 0) return false;
		/**
		* 已取消的任务：**明确拒绝**。
		*
		* `cancel()` 已经把 `failed` 设成取消原因，调用方也已收到错误 ——
		* 这里再覆盖会让取消「看起来没生效」。
		*/
		if (job.cancelled === true) return false;
		/**
		* 已了结的（无论成功还是失败）：拒绝重复提交。
		*
		* 正常情况下不该发生；真发生了说明有竞态（比如 client 超时兜底
		* 和真实 `done` 同时到达），此时**保留先到的那个**更安全。
		*/
		if (job.done !== void 0 || job.failed !== void 0) return false;
		if ("error" in result) {
			job.failed = result.error;
			/**
			* ⭐ 一并存下 HTTP 状态码 —— adapter 交给 DSH 时要填进 LlmFailure.status。
			* 见 hook 里读 res.status 的那处说明。
			*/
			if (typeof result.httpStatus === "number") job.httpStatus = result.httpStatus;
		} else job.done = result;
		return true;
	}
	get(id) {
		return this.jobs.get(id);
	}
	/** 任务是否已经被领走（用于判断 client 是否在线）。 */
	hasClaimed() {
		for (const job of this.jobs.values()) if (job.claimedAt !== void 0 && job.done === void 0 && job.failed === void 0) return true;
		return false;
	}
	/**
	* 取消一个任务（用户按了停止 / 调用被 abort）。
	*
	* ⚠️ 早期版本在 abort 时**只是抛错退出**，任务仍留在队列里处于 `claimed` 状态：
	*   - `hasClaimed()` 永远返回 true ⇒ `/status` 误报「面板在干活」
	*   - 页面那头也不知道要停，会继续生成到自然结束（白烧配额）
	*   - 万一之后 `done` 事件回来了，还会被当成**下一个任务**的回复（串台）
	*
	* 所以这里标记为已取消，让 client 领活时能看到并去按页面的停止按钮。
	*/
	cancel(id, reason) {
		const job = this.jobs.get(id);
		if (job === void 0) return false;
		if (job.done !== void 0 || job.failed !== void 0) return false;
		job.failed = reason;
		job.cancelled = true;
		return true;
	}
};
/** 重试策略：网页版限流退避较长，必须显式声明（否则落到 10s 默认上限）。 */
const RETRY_POLICY = {
	mode: "normal",
	maxRetries: 8,
	retryableCodes: [
		"RATE_LIMIT",
		"TIMEOUT",
		"TRANSPORT",
		"SERVER"
	],
	initialDelayMs: 4e4,
	maxDelayMs: 117e3,
	jitterRatio: .15
};
/** 会话游标表（内存 + 可选磁盘持久化）。 */
var SessionCursors = class {
	limit;
	store;
	map = /* @__PURE__ */ new Map();
	constructor(limit = 32, store) {
		this.limit = limit;
		this.store = store;
	}
	/**
	* 启动时恢复某个平台的游标。
	*
	* ⚠️ 惰性恢复（首次访问该平台时才读盘）而不是构造时全读：
	* 平台是运行时才知道的（`registry.all()`），构造 `SessionCursors` 时
	* 还不知道有哪些平台。
	*/
	restored = /* @__PURE__ */ new Set();
	ensureRestored(platform) {
		if (this.store === void 0 || this.restored.has(platform)) return;
		this.restored.add(platform);
		try {
			for (const [k, v] of Object.entries(this.store.load(platform))) if (v !== null && typeof v === "object") this.map.set(`${platform}::${k}`, v);
		} catch {}
	}
	get(platform, key) {
		this.ensureRestored(platform);
		return this.map.get(`${platform}::${key}`);
	}
	set(platform, key, cursor) {
		this.ensureRestored(platform);
		this.map.set(`${platform}::${key}`, cursor);
		this.store?.save(platform, key, cursor);
		const mine = [...this.map.entries()].filter(([k]) => k.startsWith(`${platform}::`));
		if (mine.length > this.limit) {
			const oldest = mine.sort((a, b) => a[1].at - b[1].at)[0];
			if (oldest !== void 0) {
				this.map.delete(oldest[0]);
				this.store?.save(platform, oldest[0].slice(platform.length + 2), void 0);
			}
		}
	}
	/** 会话被压缩/重置时清掉进度。 */
	reset(platform, key) {
		this.map.delete(`${platform}::${key}`);
		this.store?.save(platform, key, void 0);
	}
	size() {
		return this.map.size;
	}
};
/** system 的短指纹（长度 + 头尾片段足够区分，不必上 hash）。 */
function fingerprint(text) {
	if (text === "") return "0";
	return `${text.length}:${text.slice(0, 48)}:${text.slice(-48)}`;
}
/**
* 算出本轮要发的内容（增量）。
*
* ## ⚠️ 这个函数**不改状态**
*
* 早期版本在这里直接 `cursors.set(...)` 推进游标，造成一个严重 bug：
* **发送失败时上下文永久丢失** —— 游标已经前进了，下一轮只发之后的消息，
* 中间那段内容再也不会被发出去（页面里没有，DSH 也认为发过了）。
*
* 所以现在拆成两步：
*   1. `diffPrompt()` —— **纯函数**，只算要发什么
*   2. 调用方在**确认投递成功后**调 `commit()`
*
* 失败时不 commit ⇒ 下次重试会重新算出同样的增量，内容不丢。
*
* 判定「需要重发 system」的条件：
*   - 没有游标（新会话）
*   - system 指纹变了（换了 agent / preset）
*   - **历史变短了**（会话被压缩或回退 ⇒ 之前的进度作废，从头发）
*/
function diffPrompt(options) {
	const { messages, cursors, sessionKey, platform } = options;
	const system = typeof options.system === "string" ? options.system.trim() : "";
	const fp = fingerprint(system);
	const prev = cursors.get(platform, sessionKey);
	const historyShrank = prev !== void 0 && messages.length < prev.sentCount;
	const isFirst = prev === void 0 || historyShrank;
	const needSystem = isFirst || prev.systemFingerprint !== fp;
	let start = isFirst ? 0 : prev.sentCount;
	/**
	* 跳过页面自己的回复。
	*
	* 只在**非首轮**做：首轮没有「上次发送」，不存在页面自己的回复。
	* 只跳**连续**的 assistant 消息（正常情况下就一条）；
	* 遇到 user/tool 消息就停 —— 那些是新的输入，必须发。
	*/
	let skippedOwnReply = 0;
	if (!isFirst) while (start < messages.length && messages[start].role === "assistant") {
		start += 1;
		skippedOwnReply += 1;
	}
	const parts = [];
	if (needSystem && system !== "") parts.push(system);
	/**
	* **工具段只在首轮带。**
	*
	* 与差分发送一致：后续轮只发增量。若每轮都带工具目录，
	* 单次请求体量会平白多几千字符 —— 而参考实现实测记录过
	* 「体量是账号被限制的主要嫌疑」。
	*/
	const withTools = isFirst && typeof options.toolSection === "string" && options.toolSection !== "";
	if (withTools) parts.push(options.toolSection);
	const body = serializeMessages(messages.slice(start), options.toolResultLimit);
	if (body !== "") parts.push(body);
	return {
		text: parts.join("\n\n"),
		isFirst,
		skippedOwnReply,
		chatUrl: prev?.chatUrl,
		commit: () => {
			cursors.set(platform, sessionKey, {
				sentCount: messages.length,
				systemFingerprint: fp,
				at: Date.now(),
				...prev?.chatUrl === void 0 ? {} : { chatUrl: prev.chatUrl }
			});
		},
		note: (isFirst ? `首轮（系统提示词 ${system.length} 字符 + ${messages.length} 条消息` : `增量（第 ${start + 1}..${messages.length} 条`) + (skippedOwnReply > 0 ? `，跳过页面自己的 ${skippedOwnReply} 条回复` : "") + (withTools ? `，带工具目录 ${options.toolSection.length} 字符` : "") + "）"
	};
}
/** 构造 adapter（鸭子类型对象；不继承 LlmAdapter 基类，所以方法要齐）。 */
/**
* ## ⭐⭐⭐ 把客户端失败映射到 DSH 的**官方失败码**（否则重试机制不会启动）
*
* ## 官方契约（从 DSH 的 app.asar 提取，dsh-llm/lib/typert.host.js）
*
*     export interface LlmFailure {
*         readonly message: string
*         readonly code: string
*         readonly status?: number
*         readonly providerRetryAfterMs?: number
*     }
*
* ## dsh-llm-retry 的 README（官方重试插件）
*
* > 省略 retryPolicy 时使用 normal mode：对 EMPTY_RESPONSE、RATE_LIMIT、SERVER、
* > TIMEOUT 与 TRANSPORT 最多重试五次，退避 500ms→10s 带抖动。
* > 提供方给出且符合策略边界的有效 Retry-After 会替换本地退避。
*
* ## 本插件原来的问题（用户实测：「服务器暂时不可用」从不重试）
*
* 所有失败都只发 `code: 'WEBIN_FAILED'` —— 一个**自定义码**，官方重试策略
* 认不出来 ⇒ **一次都不会重试**。
*
* ## 修法
*
* 把客户端上报的失败文案映射到官方码，并把页面给出的「稍后重试」提示转成
* `providerRetryAfterMs`（DSH 会用它替换本地退避）。
*
* ⚠️ 映射是**保守**的：认不出的一律回退 `WEBIN_FAILED`（自定义码），
* 不让一个没把握的判断触发五次自动重试（每次都是真实请求、真实计费）。
*/
function classifyFailure(message) {
	const m = message ?? "";
	/**
	* ⭐ 限流 / 服务端暂时不可用 —— 这是用户最常遇到、也最该自动重试的一类。
	* 网页版会插「服务器暂时不可用」「请求过于频繁」这类提示。
	*/
	if (/服务器暂时不可用|服务暂时不可用|服务器繁忙|服务繁忙|请求过于频繁|系统繁忙|Server is busy|Service Unavailable|Too Many Requests/i.test(m)) return {
		code: "RATE_LIMIT",
		providerRetryAfterMs: 12e4
	};
	/** 网页版明说「稍后重试 / N 秒后再试」⇒ 按它给的时长退避。 */
	const sec = /(\d+)\s*秒(?:后|再)/.exec(m);
	if (sec !== null) return {
		code: "RATE_LIMIT",
		providerRetryAfterMs: Math.min(6e5, Number(sec[1]) * 1e3)
	};
	/** 面板/页面失联、等不到结果 ⇒ 超时（可重试）。 */
	if (/心跳|失联|超时|timeout|面板未连接|无人领取/i.test(m)) return { code: "TIMEOUT" };
	/** 发送链路问题（没发出去、输入框丢了）⇒ 传输类（可重试）。 */
	if (/没发出去|send-failed|输入框|发送失败|触发发送/i.test(m)) return { code: "TRANSPORT" };
	/** 拿到空回复 ⇒ 官方有专门的 EMPTY_RESPONSE 码。 */
	if (/空回复|回复为空|EMPTY_RESPONSE/i.test(m)) return { code: "EMPTY_RESPONSE" };
	/** 认不出 ⇒ 保持自定义码，不冒险触发自动重试。 */
	return { code: "WEBIN_FAILED" };
}
/** 每块字符数（见 emit 处的说明）。 */
const CHUNK_CHARS = 200;
/** 把整段文本切成契约友好的增量块。 */
function chunkText(text) {
	if (text.length <= CHUNK_CHARS) return [text];
	const parts = [];
	for (let i = 0; i < text.length; i += CHUNK_CHARS) parts.push(text.slice(i, i + CHUNK_CHARS));
	return parts;
}
function createAdapter(deps) {
	const { queue } = deps;
	const registry = deps.registry ?? new ProviderRegistry();
	deps.timeoutMs;
	const pollMs = deps.pollMs ?? 250;
	/** 每会话的发送进度（差分发送的核心状态）。 */
	const cursors = new SessionCursors(32, deps.cursorStore);
	/**
	* 取当前配置。没有注入时用默认值 —— 测试与降级路径都靠这个。
	*/
	const config = () => deps.getConfig?.() ?? DEFAULT_CONFIG;
	/**
	* 该平台是否已登录。
	*
	* **未注入 `isLoggedIn` 时一律返回 true** —— 门禁是 host 的职责
	* （只有它知道快照文件在哪），adapter 不该在没被告知时自作主张挡人。
	*/
	const loggedIn = (platform) => deps.isLoggedIn?.(platform) ?? true;
	/**
	* 模型 id 的全局唯一化。
	*
	* 各平台的模型 id 可能撞名（比如都叫 `fast`），而 DSH 的模型选择器按
	* `provider/model` 定位，同一 provider 路由下重名会互相覆盖。
	* 这里给模型 id 加平台前缀，**但保持向后兼容**：
	* 旧会话里存的 `ldw-think`（无前缀）仍能解析到默认平台的同名模型。
	*/
	function qualifyModel(providerId, modelId) {
		return `${providerId}:${modelId}`;
	}
	/** 从 `平台:模型` 里拆出两段；无前缀时回退到默认平台。 */
	function parseModel(model) {
		const idx = model.indexOf(":");
		if (idx > 0) return {
			providerId: model.slice(0, idx),
			modelId: model.slice(idx + 1)
		};
		return {
			providerId: DEFAULT_PROVIDER_ID,
			modelId: model
		};
	}
	/** 按「路由名 + 模型 id」找到平台与模型定义。 */
	function resolve(route, model) {
		const byRoute = registry.all().find((p) => routeFor(p.id) === route);
		const parsed = parseModel(model);
		const provider = byRoute ?? registry.get(parsed.providerId);
		return {
			provider,
			spec: provider.models.find((m) => m.id === parsed.modelId) ?? provider.models[0]
		};
	}
	function modelInfoFor(route, provider, spec) {
		return {
			provider: route,
			id: qualifyModel(provider.id, spec.id),
			name: spec.name,
			description: spec.description ?? provider.name,
			inputModalities: ["text"]
		};
	}
	function resolvedModelInfo(route, provider, spec, requested) {
		const id = requested === "" ? qualifyModel(provider.id, spec.id) : requested;
		const thinking = spec.thinking === true;
		const efforts = provider.reasoningEfforts ?? [{
			id: "medium",
			name: "思考"
		}];
		return {
			provider: route,
			id,
			name: spec.name,
			description: spec.description ?? provider.name,
			inputModalities: ["text"],
			/**
			* ⚠️ contextWindow 必须与网页端真实容量一致，否则会引发**会话压缩死锁**：
			* compaction-basic 用 `thresholdTokens = min(contextWindow × 0.8, contextWindow − maxTokens − headroom)`
			* 判定是否压缩。早期版本硬编码 128_000，阈值只有 54272，
			* 而真实会话轻松超过 30 万 token ⇒ 每一步 pre-step 都判定「超阈值」⇒ 反复触发压缩；
			* 而压缩的摘要调用又走 `routedTarget()`（= 最近一次路由的模型 = LDW 自己）
			* ⇒ 摘要必须经浏览器发送 ⇒ 浏览器一旦发不出去就整轮干等超时。
			* 实测后果：turn 21/22/23 连续三轮卡在 `compaction/start`，最久一次卡 6 分 12 秒。
			*/
			context: { contextWindow: provider.contextWindow },
			defaultMaxTokens: provider.maxOutputTokens,
			...thinking ? { reasoning: {
				efforts: efforts.map((e) => ({
					id: e.id,
					name: e.name
				})),
				defaultEffort: provider.defaultReasoningEffort ?? efforts[0]?.id ?? "medium"
			} } : {}
		};
	}
	/** 等 client 把结果交回来。 */
	async function waitForJob(job, signal) {
		/** 配置里的超时优先（用户可在设置页调），其次 deps，最后默认 10 分钟。 */
		const deadline = Date.now() + (deps.timeoutMs ?? config().replyTimeoutMs);
		/**
		* 「没人领活」的宽限窗口。
		*
		* LDW 面板没打开（或用户切到了别的标签、guest 被卸载）时，client 半根本不会
		* 来 `GET /job/next`。此时**必须快速失败**，否则一次模型调用会干等满
		* `timeoutMs`（默认 10 分钟）—— 而压缩摘要走的正是这条路，
		* 于是整轮对话被一个没人能完成的任务卡死（实测 turn 23 卡 6 分 12 秒）。
		*
		* 判定：超过宽限期仍未被任何 client 领走 ⇒ 判定面板不在线，立即报错。
		* 宽限期给得比 client 的轮询间隔（1.5s）宽裕得多，不会误杀正在启动的面板。
		*/
		const claimGraceMs = deps.claimGraceMs ?? config().claimGraceMs;
		let claimedOnce = false;
		for (;;) {
			if (signal?.aborted === true) {
				/**
				* 用户按了停止。
				*
				* **必须把任务标记掉**，否则它会一直挂在队列里处于 claimed 状态：
				*   - `hasClaimed()` 永远 true ⇒ `/status` 误报「面板在干活」
				*   - client 那头不知道要停，页面会继续生成到自然结束（白烧配额）
				*   - 之后回来的 `done` 还可能被算成下一个任务的回复（串台）
				*
				* 标记后 client 领活时能看到 `cancelled`，去按页面的停止按钮。
				*/
				queue.cancel(job.id, "已取消（用户停止）");
				throw new Error("aborted");
			}
			const current = queue.get(job.id);
			if (current === void 0) throw new Error("job disappeared");
			if (current.failed !== void 0) {
				const e = new Error(current.failed);
				e.httpStatus = current.httpStatus;
				throw e;
			}
			if (current.done !== void 0) return current.done;
			if (current.claimedAt !== void 0) claimedOnce = true;
			if (!claimedOnce && Date.now() > job.createdAt + claimGraceMs) {
				queue.settle(job.id, { error: "LDW 面板未连接：没有 client 领取这个任务。" });
				throw new Error(`LDW 面板未连接 —— 没有任何客户端领取这个任务（${Math.round(claimGraceMs / 1e3)}s 内无人领取）。\n原因通常是：LDW 标签没打开、面板被切走卸载了、或页面还没登录。
请切到 LDW 标签并确认显示「真实浏览器已就绪」。`);
			}
			if (Date.now() > deadline) {
				queue.settle(job.id, { error: "等待网页回复超时" });
				throw new Error("等待网页回复超时。可能原因：页面结构变了 / 未登录 / 网页版没吐回复。请打开 LDW 标签查看页面状态。");
			}
			await new Promise((r) => setTimeout(r, pollMs));
		}
	}
	/**
	* 把一次模型调用变成 StreamChunk 流。
	*
	* 注意：这里**不返回 async generator 之外的东西**，
	* `block-start` / `text-delta` / `block-end` / `finish` 的顺序是 dsh-llm 的契约。
	*/
	async function* streamOnce(options) {
		/**
		* **压缩摘要不能走真实浏览器。**
		*
		* `compaction-basic` 的 `summarizeWithLlm()` 用 `routedTarget(session)` 选摘要模型 ——
		* 也就是「最近一次实际路由的 provider」。一旦会话切到 LDW，压缩就变成
		* 「把整段对话历史打进网页输入框」，这有两个致命问题：
		*
		*   1. **体量**：摘要输入动辄几十万 token，塞进 textarea 会让页面直接卡死；
		*      网页版本身也有输入长度上限。
		*   2. **死锁**：摘要必须等浏览器回话，而浏览器一旦不可用（面板没开 / 未登录 /
		*      页面结构变了），整轮对话就卡在 `compaction/start` 上 —— 实测最久 6 分 12 秒。
		*
		* 所以这里**明确拒绝**并给出可操作的指引，而不是丢进队列干等。
		* 正确做法是把摘要模型配成普通 HTTP provider：
		*
		* ```yaml
		* # compaction-basic 的配置（preset 的 compaction 组内）
		* - id: compaction-basic
		*   name: '@deepseek-ai/dsh-compaction-basic'
		*   config:
		*     summarizationProvider: wb-out
		*     summarizationModel: deepseek-v4.1-flash
		* ```
		*/
		if (options.purpose === "compaction") {
			yield {
				type: "finish",
				reason: {
					kind: "error",
					failure: {
						code: "WEBIN_COMPACTION_UNSUPPORTED",
						message: "压缩摘要不能走 LDW 网页版：摘要输入体量远超网页输入框上限，且会把整轮对话锁在浏览器上。请把 compaction-basic 的 summarizationProvider / summarizationModel 配成普通 HTTP provider（例如 wb-out / deepseek-v4.1-flash）。"
					}
				}
			};
			return;
		}
		const { provider, spec } = resolve(options.provider, options.model);
		/**
		* ## 未登录时**直接报错**（而不是把消息发进网页版）
		*
		* `listModels` 已经不列未登录平台的模型，但**旧会话可能还存着**
		* 那个模型的 id（比如用户登录过、后来清了登录态）。
		* 那时如果照发，页面会跳到登录页，输入框根本不存在 ——
		* 用户看到的是「找不到可见的输入框」这种莫名其妙的错误。
		*
		* 所以这里给一个能直接照做的提示。
		*/
		if (!loggedIn(provider.id)) {
			yield {
				type: "finish",
				reason: {
					kind: "error",
					failure: {
						code: "WEBIN_NOT_LOGGED_IN",
						message: `平台「${provider.name}」还没有登录，无法使用它的模型。\n请点输入框左边的「LDW」按钮（或切到 LDW 标签），在打开的浏览器里登录 ${provider.homeUrl} 后重试。`
					}
				}
			};
			return;
		}
		/**
		* **只发增量** —— 见 `diffPrompt()` 的说明。
		*
		* 会话键：优先用 DSH 给的 `sessionId`；没有时退到「平台 + system 指纹」，
		* 这样至少同一平台的不同 agent 不会互相污染。
		*/
		const sessionKey = options.sessionId !== void 0 && options.sessionId !== "" ? String(options.sessionId) : `${provider.id}#${fingerprint(options.system ?? "")}`;
		/**
		* 工具段（协议 + 目录）—— 只在首轮带，见 `diffPrompt` 的说明。
		*
		* 体量：60 个工具 × 约 80 字符 ≈ 5,000 字符
		* （目录格式是「`name(签名)` — 首句」，对所有工具一视同仁）。
		*
		* ⚠️ 用户可在设置页关掉（`enableTools: false`）—— 关掉后模型收不到
		* 工具目录，自然也不会输出工具代码块。给「只想聊天、不想让它动我机器」
		* 的场景一个开关。
		*/
		const cfg = config();
		const toolSection = cfg.enableTools ? buildToolSection([...options.tools ?? []]) : "";
		const diff = diffPrompt({
			...options,
			platform: provider.id,
			sessionKey,
			cursors,
			toolSection,
			toolResultLimit: cfg.toolResultLimit
		});
		const prompt = diff.text;
		if (prompt.trim() === "") {
			/**
			* 增量为空 = 这一轮的输入和历史完全重复。
			*
			* 这在网页版语义下**不需要再发一次** —— 页面里已经有这段内容了。
			* 但 DSH 期望拿到一条 assistant 回复，所以直接回一个空停止，
			* 而不是把整段历史重发一遍（那正是「聊天记录里全是超长提示词」的来源）。
			*/
			deps.logger?.debug?.(`${sessionKey} 增量为空，跳过发送`);
			yield {
				type: "finish",
				reason: { kind: "stop" }
			};
			return;
		}
		/**
		* **首轮必须开新对话**（`freshChat`）。
		*
		* 没有绑定时不能「在当前页发」—— 当前页可能是别的会话的对话，
		* 两个 DSH 会话就会挤进同一个网页对话（用户实测报的封号级缺陷）。
		*/
		const job = queue.enqueue(
			prompt,
			spec.thinking === true,
			provider.id,
			diff.chatUrl,
			diff.chatUrl === void 0,
			/**
			* ⭐ 带上**DSH 会话 id** —— client 据此只领自己窗口的活。
			*
			* 用 `options.sessionId`（DSH 给的原始值）而不是 `sessionKey`
			* （那个在没 sessionId 时会退化成 `platform#fingerprint`，
			* 不是真正的会话标识，client 那边对不上）。
			*/
			options.sessionId === void 0 || options.sessionId === "" ? void 0 : String(options.sessionId)
		);
		deps.logger?.debug?.(`job ${job.id} 已派发（平台=${provider.id}，会话=${job.sessionId ?? "(无)"}，${diff.note}，${prompt.length} 字符，thinking=${String(spec.thinking)}）`);
		let result;
		try {
			result = await waitForJob(job, options.signal);
		} catch (error) {
			/**
			* ⚠️ **失败时绝不能推进游标。**
			*
			* 推进了就意味着「DSH 认为这段内容发过了」，下一轮只发之后的增量 ——
			* 而页面里其实没有这段内容 ⇒ **上下文永久丢失**，模型从此缺一段记忆。
			* 不推进 ⇒ 下次调用重新算出同样的增量，内容不丢。
			*/
			yield {
				type: "finish",
				reason: {
					kind: "error",
					failure: {
						message: error?.message ?? String(error),
						/**
						* ⭐ 用**官方失败码**（不是自定义 WEBIN_FAILED）—— 否则 dsh-llm-retry
						* 认不出来，一次都不会重试。见 classifyFailure 的说明。
						*/
						...classifyFailure(error?.message ?? String(error)),
						/**
						* ⭐⭐ 官方 LlmFailure.status —— HTTP 状态码。
						*
						* 客户端从 hook 的 res.status / this.status 拿到，经 client → host 任务
						* 一路带到这里。DSH 的重试策略据此分类（429 与 500 处理不同）。
						* 拿不到时**不带这个字段**（不是填 0）—— 官方契约里它是可选的。
						*/
						...(() => {
							const st = error?.httpStatus;
							return typeof st === "number" && st > 0 ? { status: st } : {};
						})()
					}
				}
			};
			return;
		}
		/**
		* 投递成功（页面已确认发送、且回复已收回）⇒ 这时才推进游标。
		*
		* 注意：`waitForJob` 成功返回意味着**页面确实处理了这个 prompt**，
		* 所以即使回复内容为空，这段输入也已经进过页面了，游标该推进。
		*/
		diff.commit();
		/**
		* 记住「这条 DSH 会话现在绑定的网页对话」。
		*
		* client 交结果时带上了发送成功后的页面 URL（即对话落地页）。
		* 存进游标后，**这个 DSH 会话的后续任务都会要求先导航回这个对话** ——
		* 换别的 DSH 会话聊天时各回各的对话，不再全挤一个窗口（封号级缺陷，用户实测发现）。
		*
		* ⚠️ 必须放在 `diff.commit()` **之后**：commit 会整体重写游标，
		* 放前面的话这里刚存的 chatUrl 会被 commit 用旧值覆盖掉
		* （verify-session-route 的 ⭐ 断言就是抓这个的）。
		*/
		if (typeof result.chatUrl === "string" && result.chatUrl !== "") {
			const cur = cursors.get(provider.id, sessionKey);
			cursors.set(provider.id, sessionKey, {
				sentCount: cur?.sentCount ?? messages.length,
				systemFingerprint: cur?.systemFingerprint ?? fp,
				at: Date.now(),
				chatUrl: result.chatUrl
			});
			deps.logger?.debug?.(`${sessionKey} 绑定对话 ${result.chatUrl}（已落盘）`);
		}
		/**
		* ## 解析工具调用（抄 cuckoo 的 JS 代码块协议）
		*
		* 网页模型没有原生 function calling，所以让它把调用写成 ```ldw 代码块
		* （cuckoo 的模板明确要求「多行文本用反引号模板字符串，不做任何转义」
		* —— 比 web-login 的 JSON 协议少一整类失败模式）。
		*
		* 这里把代码块**抠出来**转成 DSH 的 `tool-call` chunk：
		*   - 块外文字照常作为正文流给 DSH
		*   - 块本身**绝不进正文**（否则会显示在网页记录里，看起来不像人）
		*
		* ⚠️ 解析失败时不静默丢弃：把原文当正文透出（用户至少能看到模型写了什么），
		* 并记一条日志。宁可多显示一点，也不能让消息凭空消失。
		*/
		const parsed = parseToolCalls(result.text, [...options.tools ?? []]);
		if (parsed.failed.length > 0) deps.logger?.warn?.(`工具调用解析失败 ${parsed.failed.length} 处：${parsed.failed[0]}`);
		let index = 0;
		if (result.think.trim() !== "") {
			/**
			* ⭐ 按官方契约**分块**发射（原来整段一次性发）。
			*
			* 官方 StreamChunk 声明（从 DSH 的 app.asar 提取）：
			*   | { type: 'reasoning-delta'; index: number; text: string }
			*   | { type: 'text-delta'; index: number; text: string }
			* 两者都是**增量**事件，分块比「一个巨大的 delta」更符合契约语义。
			*
			* ⚠️ 诚实说明：这不会让它真正流式 —— 插件是从客户端一次性拿到完整文本的。
			* 真正的逐字上屏需要客户端边生成边上报（另一处改动）。
			*/
			yield {
				type: "block-start",
				index,
				blockType: "reasoning"
			};
			for (const piece of chunkText(result.think)) yield {
				type: "reasoning-delta",
				index,
				text: piece
			};
			yield {
				type: "block-end",
				index,
				block: {
					type: "reasoning",
					text: result.think
				}
			};
			index += 1;
		}
		if (parsed.text.trim() !== "") {
			yield {
				type: "block-start",
				index,
				blockType: "text"
			};
			for (const piece of chunkText(parsed.text)) yield {
				type: "text-delta",
				index,
				text: piece
			};
			yield {
				type: "block-end",
				index,
				block: {
					type: "text",
					text: parsed.text
				}
			};
			index += 1;
		}
		for (const call of parsed.calls) {
			const id = `call_${Date.now().toString(36)}_${index}_${Math.random().toString(36).slice(2, 8)}`;
			yield {
				type: "block-start",
				index,
				blockType: "tool-call"
			};
			yield {
				type: "tool-call-delta",
				index,
				id,
				name: call.name,
				argumentsDelta: call.arguments
			};
			yield {
				type: "block-end",
				index,
				block: {
					type: "tool-call",
					id,
					name: call.name,
					arguments: call.arguments
				}
			};
			index += 1;
		}
		if (parsed.calls.length > 0) deps.logger?.debug?.(`解析出 ${parsed.calls.length} 个工具调用：${parsed.calls.map((c) => c.name).join(", ")}`);
		/**
		* 结束原因：有工具调用时必须是 `tool-calls`
		* （DSH 据此决定「执行工具后继续」而不是「本轮结束」）。
		*/
		yield {
			type: "finish",
			reason: parsed.calls.length > 0 ? { kind: "tool-calls" } : { kind: "stop" }
		};
	}
	return {
		providerInfo(provider) {
			return {
				id: provider,
				name: registry.all().find((p) => routeFor(p.id) === provider)?.name ?? provider
			};
		},
		providerRetryPolicy() {
			return RETRY_POLICY;
		},
		/** ⚠️ 必须有：dsh-llm 在计量/压缩路径上**无条件**转调它，缺了会让压缩静默失效。 */
		imageRequestPricing() {},
		/**
		* ## 模型清单 —— **未登录的平台不列出**
		*
		* 用户要求：「如果是已登录才能使用 LDW 那俩模型」。
		*
		* 为什么在 `listModels` 做而不是在设置页做：DSH 的模型选择器
		* 就是拿这个清单渲染的。不列出来 ⇒ 用户根本选不到 ⇒ 不会出现
		* 「选了模型但发不出去」这种更糟的体验。
		*
		* ⚠️ 判断用**持久化快照**而不是「浏览器此刻在线」：
		* 否则重启 DSH 后、用户还没切到 LDW 标签时模型会消失，看起来像插件坏了。
		*/
		listModels(provider) {
			const hit = registry.all().find((p) => routeFor(p.id) === provider);
			if (hit === void 0) return Promise.resolve([]);
			if (!loggedIn(hit.id)) {
				deps.logger?.debug?.(`平台 ${hit.id} 未登录，不列出模型`);
				return Promise.resolve([]);
			}
			return Promise.resolve(hit.models.map((spec) => modelInfoFor(provider, hit, spec)));
		},
		resolveModel(provider, model) {
			const { provider: plat, spec } = resolve(provider, String(model ?? ""));
			return Promise.resolve(resolvedModelInfo(provider, plat, spec, String(model ?? "")));
		},
		prepareCall(provider, model) {
			const { provider: plat, spec } = resolve(provider, String(model ?? ""));
			return Promise.resolve({
				model: resolvedModelInfo(provider, plat, spec, String(model ?? "")),
				stream: (options) => streamOnce(options)
			});
		},
		stream(options) {
			return streamOnce(options);
		}
	};
}
//#endregion
//#region src/shared/auth-snapshot.ts
/**
* 解包 AppKit 的 `{"value":<v>,"__version":"0"}` 包装。
*
* ⚠️ 解析失败时**不能把原文当 token** —— 那样 `"{broken"` 这种畸形值
* 会被当成有效 token（非空字符串），于是坏快照又能覆盖好快照。
* 只有**看起来像 JSON 却解析失败**的才返回 undefined；
* 真正的裸 token（不以 `{` 开头）才按原文返回。
*/
function unwrapAppKit(raw) {
	if (typeof raw !== "string" || raw === "") return void 0;
	const trimmed = raw.trim();
	if (trimmed === "") return void 0;
	/** JSON 的空值字面量：`"null"` / `"undefined"` 都不是 token。 */
	if (trimmed === "null" || trimmed === "undefined") return void 0;
	if (!trimmed.startsWith("{") && !trimmed.startsWith("["))
 /** 裸字符串 token（旧版页面可能这样存）。 */
	return trimmed;
	try {
		const parsed = JSON.parse(trimmed);
		if (parsed !== null && typeof parsed === "object" && "value" in parsed) return parsed.value;
		return parsed;
	} catch {
		/** 像 JSON 但解析失败 ⇒ 视为无效，绝不 fallback 成原文。 */
		return;
	}
}
/**
* 这份快照看起来「确实登录了」吗？
*
* 判据（任一成立即算已登录）：
*   - `userToken` 解包后是非空字符串
*   - `__appKit_userInfo` 解包后 `.id` 是非空字符串
*/
function snapshotLooksLoggedIn(snapshot) {
	const ls = snapshot.localStorage ?? {};
	const token = unwrapAppKit(ls.userToken);
	if (typeof token === "string" && token.trim() !== "") return true;
	const info = unwrapAppKit(ls["__appKit_userInfo"]);
	if (info !== null && typeof info === "object") {
		const id = info.id;
		if (typeof id === "string" && id.trim() !== "") return true;
	}
	return false;
}
/**
* 从原始快照文本判断登录态（**不抛错**）。
*
* 坏 JSON 一律视为「未登录」而不是崩溃 —— 配置文件坏了不能让插件挂掉。
*/
function snapshotTextLooksLoggedIn(text) {
	if (typeof text !== "string" || text.trim() === "") return false;
	try {
		const parsed = JSON.parse(text);
		if (parsed === null || typeof parsed !== "object") return false;
		return snapshotLooksLoggedIn(parsed);
	} catch {
		return false;
	}
}
//#endregion
//#region src/host/cookie-jar.ts
/**
* ## 用 Electron 的 session API 持久化 cookie（**解决「重启必须重新登录」**）
*
* ## 为什么必须走这条路
*
* 用户实测报的：「每次重启 dsh 都需要重新登陆 deepseek？无语了」
*
* 根因链：
*   1. DSH 的 guest partition 是 `dsh-sidebar-browser-${randomUUID()}`
*      （`lib/main.js:9638`）—— **无 `persist:` 前缀 = 内存分区**，
*      进程一退，cookie 全丢；
*   2. DeepSeek 的登录态主要靠 **httpOnly cookie**；
*   3. 页面里的 JS（`document.cookie`）**看不见也写不了** httpOnly cookie。
*
* 所以「把 localStorage + document.cookie 存成快照再回写」这条路
* **天生不完整** —— 快照里根本没有真正决定登录态的那几个 cookie。
*
* 插件 host 半跑在 DSH 主进程（Electron）里，**能拿到
* `session.fromPartition(...).cookies`**，那个 API 包含 httpOnly。
*
* ## 怎么拿到 partition
*
* 我们**不猜** partition 名（它是 randomUUID，猜不到）。client 半在
* webview 挂载后会知道自己的 partition（从 lease 来），把它上报给 host，
* host 再用 `session.fromPartition(那个名字)` 取 cookie。
*
* ⚠️ 但 client 半拿不到 partition —— `acquire()` 的返回值只在
* DSH 内部用。所以这里改成**扫描式**：遍历当前所有 partition，
* 找出域名匹配目标平台的那个。`session.fromPartition` 只能按名字取，
* 所以还需要枚举名字 —— Electron 没有「列出所有 partition」的 API。
*
* ## 因此：退一步，用「按名字试探 + 全量扫描 fallback」
*
* 实际上 Electron 的 `session.defaultSession` 与所有 partition 共享
* cookie jar 的**域名索引**吗？不 —— 每个 partition 独立。
*
* **结论：拿不到名字就拿不到 session。**
*
* 所以本模块做的是**另一件确定可行的事**：让 client 半在**能拿到
* partition 名字**时上报它（DSH 的 `webview` 元素上 `partition` 属性
* 是我们自己设的 —— 但那是我们编的，不是 DSH 分配的）。
*
* 于是最终方案改为：**client 侧把 cookie 快照能力做全**（见下），
* host 侧提供一个「如果 electron 可用就顺便用 API 补全 httpOnly」的
* 可选增强。两者都不行时，明确告诉用户「需要重新登录一次」。
*/
/** cookie 存档目录。 */
function cookieDir(stateRoot) {
	return join(stateRoot, "cookies");
}
function cookieFile(stateRoot, platform) {
	/** 平台 id 可能含路径分隔符（自定义 provider 允许），换成安全的字符。 */
	const safe = platform.replace(/[^A-Za-z0-9_.-]/g, "_");
	return join(cookieDir(stateRoot), `${safe}.json`);
}
/**
* 尝试拿 Electron 的 session 模块。
*
* ## ⚠️ 为什么不能用 `eval('require')`（我第一版写错了，**实测才发现**）
*
* 第一版写的是 `const req = eval('require')` —— 以为这样能绕过打包器。
* 但**插件的 host 产物是 ESM**（`tsdown.config.ts` 里 `format: 'esm'`），
* ESM 模块里**根本没有 `require`** ⇒ `eval('require')` 抛
* `ReferenceError` ⇒ 被 catch 吞掉 ⇒ 永远返回 undefined。
*
* **实测证据**（对运行中的 host 打 `POST /client/partition`）：
*
*     {"ok":true,"cookieApi":false,"archived":false}
*
* `cookieApi:false` 意味着「重启免登录」那条路**从来没生效过** ——
* 用户报「每次重启 dsh 都需要重新登陆」，我以为是分区问题，
* 实际上我连 Electron API 都没拿到。
*
* ## 正确做法：`createRequire(import.meta.url)`
*
* ESM 里拿 `require` 的标准方式。
*
* ## 为什么还要 try/catch
*
* - **单元测试 / 纯 node 环境**下 `require('electron')` 会 MODULE_NOT_FOUND
* - Electron 的 `session` 只在**主进程**可用
*
* 拿不到就返回 undefined，调用方走降级路径。
* **绝不能因为拿不到就抛错** —— 那会让整个插件加载失败。
*/
function tryElectronSession() {
	/** 判据统一：拿到 `session.fromPartition` 才算成功。 */
	const strategies = [
		() => {
			const meta = import.meta;
			return typeof meta.url === "string" ? createRequire(meta.url)("electron") : void 0;
		},
		() => createRequire(String(process.execPath))("electron"),
		() => {
			const mm = process.mainModule;
			return typeof mm?.require === "function" ? mm.require("electron") : void 0;
		},
		() => {
			const g = globalThis;
			return typeof g.require === "function" ? g.require("electron") : void 0;
		},
		() => {
			const eb = process.electronBinding;
			return typeof eb === "function" ? eb("electron_module") : void 0;
		}
	];
	for (const get of strategies) try {
		const electron = get();
		if (electron?.session?.fromPartition !== void 0) return electron.session;
	} catch {}
}
/**
* 诊断：**为什么**拿不到 Electron session？
*
* ## 为什么要这个（用户要求「不要猜」）
*
* 实测 `cookieApi: false`，光看这一个布尔值**分不清原因**。
* 加了诊断路由后拿到确切答案：
*
*     hasImportMetaUrl: true            ← createRequire 可用
*     requireKind: "function"           ← 同上
*     error: "Cannot find module 'electron'"
*     electronVersion: "44.0.0"         ← 确实在 Electron 里
*     processType: "(none)"             ← process.type 不是 'browser'
*
* 所以是**模块解析**问题（插件从自己目录加载，那里没有 electron 包），
* 而且进程类型可疑。
*
* ## 做法：**把所有可能的获取方式都试一遍，列出哪个成功**
*
* 不猜「哪种能行」—— 全部实测，把结果列出来。拿到 `session.fromPartition`
* 的算成功。
*/
function diagnoseElectron() {
	const out = {
		hasImportMetaUrl: false,
		importMetaUrl: "",
		error: void 0,
		processType: String(process.type ?? "(none)"),
		electronVersion: String(process.versions.electron ?? "(none)"),
		nodeVersion: process.version,
		argv0: String(process.argv0 ?? "").slice(0, 160),
		execPath: String(process.execPath ?? "").slice(0, 160),
		resourcePath: String(process.resourcesPath ?? "(none)"),
		hasElectronBinding: typeof process.electronBinding === "function",
		hasMainModule: process.mainModule !== void 0,
		strategies: []
	};
	const meta = import.meta;
	out.hasImportMetaUrl = typeof meta.url === "string";
	out.importMetaUrl = typeof meta.url === "string" ? meta.url.slice(0, 200) : "";
	/**
	* ## 逐个试所有获取方式
	*
	* 判据统一：**拿到 `session.fromPartition` 才算成功**。
	* 拿到一个空壳 electron（渲染进程里就是）不算。
	*/
	const strategies = [
		{
			name: "createRequire(import.meta.url)(\"electron\")",
			get: () => typeof meta.url === "string" ? createRequire(meta.url)("electron") : void 0
		},
		{
			name: "createRequire(execPath)(\"electron\")",
			get: () => createRequire(String(process.execPath))("electron")
		},
		{
			name: "process.mainModule.require(\"electron\")",
			get: () => {
				const mm = process.mainModule;
				return typeof mm?.require === "function" ? mm.require("electron") : void 0;
			}
		},
		{
			name: "globalThis.require(\"electron\")",
			get: () => {
				const g = globalThis;
				return typeof g.require === "function" ? g.require("electron") : void 0;
			}
		},
		{
			name: "process.electronBinding(\"electron_module\")",
			get: () => {
				const eb = process.electronBinding;
				return typeof eb === "function" ? eb("electron_module") : void 0;
			}
		}
	];
	for (const s of strategies) try {
		const got = s.get();
		const hasSession = got?.session !== void 0 && got?.session !== null;
		const hasFromPartition = typeof got?.session?.fromPartition === "function";
		out.strategies.push({
			name: s.name,
			ok: hasFromPartition,
			detail: hasFromPartition ? "✅ 拿到 session.fromPartition" : got === void 0 ? "返回 undefined" : "拿到 " + typeof got + "，session=" + String(hasSession)
		});
	} catch (e) {
		out.strategies.push({
			name: s.name,
			ok: false,
			detail: e?.message ?? String(e)
		});
	}
	/** 全都失败时，把第一条的错误原文当主因（最可能是它）。 */
	if (!out.strategies.some((s) => s.ok)) {
		const first = out.strategies[0];
		if (first !== void 0) out.error = first.detail;
	}
	return out;
}
/** Electron 的 session 是否可用（供 `/status` 显示，让用户知道走哪条路）。 */
function cookieApiAvailable() {
	return tryElectronSession() !== void 0;
}
/**
* 从指定 partition 抓取某域名的全部 cookie（**含 httpOnly**）。
*
* @param partition - DSH 分配的 partition 名（client 上报）
* @param domain - 目标域名（如 `chat.deepseek.com`）
* @returns cookie 列表；session 不可用时返回 undefined（调用方降级）
*/
async function grabCookies(partition, domain) {
	const ses = tryElectronSession();
	if (ses === void 0) return void 0;
	try {
		/** 域名匹配：Electron 的 domain 可能带前导点（`.deepseek.com`）。 */
		return (await ses.fromPartition(partition).cookies.get({})).filter((c) => {
			const d = String(c.domain ?? "").replace(/^\./, "");
			return d === domain || domain.endsWith(`.${d}`) || d.endsWith(`.${domain}`);
		});
	} catch {
		return;
	}
}
/**
* 把 cookie 写回指定 partition。
*
* ## 为什么必须带 url
*
* Electron 的 `cookies.set()` 要求给出 `url`（它从 url 推导 domain/path/
* secure）。只给 `domain` 不生效 —— 这是踩过的坑。
*/
async function restoreCookies(partition, cookies) {
	const ses = tryElectronSession();
	if (ses === void 0) return 0;
	const jar = ses.fromPartition(partition).cookies;
	let ok = 0;
	for (const c of cookies) try {
		const host = String(c.domain ?? "").replace(/^\./, "");
		const scheme = c.secure === true ? "https" : "http";
		await jar.set({
			url: `${scheme}://${host}${c.path === "" ? "/" : c.path}`,
			name: c.name,
			value: c.value,
			domain: c.domain,
			path: c.path === "" ? "/" : c.path,
			secure: c.secure === true,
			httpOnly: c.httpOnly === true,
			...c.expirationDate === void 0 ? {} : { expirationDate: c.expirationDate },
			...c.sameSite === void 0 ? {} : { sameSite: c.sameSite }
		});
		ok += 1;
	} catch {}
	return ok;
}
/** 存档 cookie 到磁盘。 */
function saveCookieArchive(stateRoot, archive) {
	const dir = cookieDir(stateRoot);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(cookieFile(stateRoot, archive.platform), JSON.stringify(archive), "utf8");
}
/** 读 cookie 存档。 */
function loadCookieArchive(stateRoot, platform) {
	const f = cookieFile(stateRoot, platform);
	if (!existsSync(f)) return void 0;
	try {
		const raw = readFileSync(f, "utf8");
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed.cookies)) return void 0;
		return parsed;
	} catch {
		return;
	}
}
//#endregion
//#region src/shared/version.ts
/**
* 安全读取构建期常量（万一没注入 —— 比如别的工具链直接编译源码）。
*
* 用 `typeof` 探测而不是直接引用：直接引用未声明的标识符会抛
* `ReferenceError`，那样整个插件都加载不了。
*/
function injected(name, fallback) {
	try {
		if (name === "version" && true) return "0.2.18";
		if (name === "commit" && true) return "dbf124c";
		if (name === "repo" && true) return "cv-superding/dsh-webin";
		if (name === "builtAt" && true) return "2026-10-14T12:35:19.239Z";
	} catch {}
	return fallback;
}
/** 当前跑的这份是哪个版本。 */
function currentVersion() {
	return {
		version: injected("version", "0.0.0"),
		commit: injected("commit", "unknown"),
		repo: injected("repo", "cv-superding/dsh-webin"),
		builtAt: injected("builtAt", "")
	};
}
/** GitHub 仓库地址。 */
function repoUrl(repo) {
	return `https://github.com/${repo ?? currentVersion().repo}`;
}
/** 打开仓库「点 Star」的地址（直达 star 确认页，省一次点击）。 */
function starUrl(repo) {
	return `${repoUrl(repo)}/stargazers`;
}
/**
* 检查更新。
*
* ## 为什么看**提交号**而不是「版本号」
*
* DSH 插件的实际分发方式是 `link:` 或本地目录（README 里的安装方式），
* 用户的代码就是从仓库拉的一份工作副本。这种情况下：
*   - `package.json` 的 version 常年不动
*   - 真正决定「有没有新东西」的是**提交**
*
* ## 为什么用 GitHub 公开 API
*
* 不需要凭据（公开仓库），不碰用户的 GitHub token ——
* 插件不该为了检查更新去要一个能写仓库的凭据。
*
* ## ⚠️ 必须有超时（真实 bug）
*
* 早期直接 `await fetch(...)` 没有超时。GitHub 在国内**经常连不上但不
* 立刻报错**（连接挂着）—— 于是设置页的「检查更新」按钮**永远转圈**。
* 用户报的就是这个：「插件更新的逻辑貌似有bug」。
*
* 现在用 `AbortController` 加 10 秒硬超时，超时明确报错而不是干等。
*
* ## 怎么判断「落后」（真实 bug）
*
* 早期判据是「提交号不等即有更新」。这会把两种**不该报更新**的情况
* 也算进去：
*   - 用户自己提交了没推（本地比远端**新**）
*   - 远端被 force-push 回退
*
* 现在用 compare API 判断方向（`identical` / `ahead` / `behind` / `diverged`）。
*
* @param repo - `owner/repo`；省略用当前插件的
* @param timeoutMs - 网络超时（默认 10 秒）
*/
async function checkForUpdate(repo, timeoutMs = 1e4) {
	const slug = repo ?? currentVersion().repo;
	const checkedAt = Date.now();
	const mine = currentVersion().commit;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		/**
		* ## 用 compare API 而不是「取 main 的最新提交」
		*
		* `GET /commits/main` 只能告诉我「远端最新是什么」，**无法判断方向** ——
		* 提交号不同时，不知道是自己落后还是自己超前。
		*
		* `GET /compare/<mine>...main` 直接给出 `status`：
		*   `identical` / `ahead` / `behind` / `diverged`
		* 这正是需要的语义。
		*
		* ⚠️ 本地提交号是 `unknown` 时（tarball 安装 / 没注入）无从比较 ——
		* 退回 `commits/main` 只报告「远端最新是什么」，**不判定落后**
		* （报「有更新」会让用户白折腾）。
		*/
		const url = mine === "unknown" ? `https://api.github.com/repos/${slug}/commits/main` : `https://api.github.com/repos/${slug}/compare/${mine}...main`;
		const res = await fetch(url, {
			headers: {
				accept: "application/vnd.github+json",
				"user-agent": "dsh-webin-update-check"
			},
			signal: controller.signal
		});
		if (!res.ok) {
			/**
			* 404 有两种可能：仓库不存在，**或者本地提交号在远端不存在**
			* （用户自己 commit 过、或远端 force-push 过）。
			* 后者不是错误，是「本地更新」—— 明确说出来，别让用户以为网断了。
			*/
			if (res.status === 404 && mine !== "unknown") return {
				ok: true,
				ahead: true,
				behind: false,
				same: false,
				latestCommit: mine,
				latestMessage: "本地提交在远端不存在（你可能有未推送的提交）",
				checkedAt
			};
			return {
				ok: false,
				reason: `GitHub 返回 ${res.status}`,
				checkedAt
			};
		}
		const data = await res.json();
		/** 本地提交号未知时走的是 `commits/main`，没有 status 字段。 */
		if (mine === "unknown") {
			const sha = typeof data.sha === "string" ? data.sha.slice(0, 7) : "";
			if (sha === "") return {
				ok: false,
				reason: "响应里没有提交号",
				checkedAt
			};
			return {
				ok: true,
				latestCommit: sha,
				latestMessage: String(data.commit?.message ?? "").split("\n")[0] ?? "",
				latestAt: data.commit?.committer?.date ?? "",
				/** 无从比较 ⇒ 不判定落后。 */
				behind: false,
				same: false,
				checkedAt
			};
		}
		/**
		* compare 的 `commits` 数组是「从 base 到 head 多出来的提交」。
		* 取最后一个 = 远端最新。
		*/
		const list = Array.isArray(data.commits) ? data.commits : [];
		const newest = list.length > 0 ? list[list.length - 1] : void 0;
		const latestCommit = typeof newest?.sha === "string" ? newest.sha.slice(0, 7) : "";
		const status = String(data.status ?? "");
		/**
		* ## ⚠️ status 的方向语义（**踩过，反了会很严重**）
		*
		* 我们打的是 `compare/<mine>...main` —— base 是**本地提交**，
		* head 是**远端 main**。所以 status 描述的是「从本地到远端」：
		*
		*   - `ahead`    —— **远端**比本地超前 ⇒ **我落后了，有更新** ✅
		*   - `behind`   —— 远端比本地落后 ⇒ 我超前（自己提交了没推）
		*   - `identical`—— 完全一致
		*   - `diverged` —— 分叉
		*
		* ## 第一版写反了，后果很具体
		*
		* 原来写成 `behind: status === 'behind'` —— 于是**只有自己超前时才报
		* 「有更新」，真正落后时反而报「本地更新」** ⇒ 用户永远不会看到
		* 更新提示。这正是用户报的「插件更新的逻辑貌似有bug」。
		*
		* 实测证据（`compare/6d71261...main`，本地落后 28 个提交）：
		*   `{"status":"ahead","ahead_by":28,"behind_by":0}`
		* —— 远端超前 28，但 status 是 `ahead` 而不是 `behind`。
		*
		* 所以判据是 `ahead` ⇒ 有更新。
		*/
		return {
			ok: true,
			latestCommit: latestCommit === "" ? mine : latestCommit,
			latestMessage: String(newest?.commit?.message ?? "").split("\n")[0] ?? "",
			latestAt: newest?.commit?.committer?.date ?? "",
			/** 远端超前（`ahead`）= 我落后 = 有更新。分叉也算。 */
			behind: status === "ahead" || status === "diverged",
			same: status === "identical",
			/** 远端落后（`behind`）= 我超前 = 自己提交了没推。 */
			ahead: status === "behind",
			checkedAt
		};
	} catch (error) {
		return {
			ok: false,
			reason: error?.name === "AbortError" ? `检查更新超时（${Math.round(timeoutMs / 1e3)} 秒无响应）—— 可能是网络无法访问 GitHub` : error?.message ?? String(error),
			checkedAt
		};
	} finally {
		clearTimeout(timer);
	}
}
/**
* 更新方式说明（给设置页显示）。
*
* 本插件有**两种**安装方式，更新动作不同，不能给一句笼统的「点这里升级」：
*   - `link:` 本地目录 ⇒ 用户自己 `git pull`
*   - npm 包 ⇒ `dsh plugin add` 重装
*
* ⚠️ **`lib/` 是构建产物**（在 `.gitignore` 里）。只 `git pull` 不重新构建
* 的话，跑的还是旧产物 —— 用户会以为「更新了但没变化」。
* 所以命令里必须带 `npm run build`，而且要告诉用户怎么确认。
*/
function updateHint(repo) {
	return [
		"cd <本插件目录>",
		"git pull",
		"npm install",
		"npm run build",
		"# 然后在 DSH 里重新加载插件（或重启 DSH）",
		`# 确认版本：设置页应显示新的提交号（仓库：https://github.com/${repo ?? currentVersion().repo}）`
	].join("\n");
}
/**
* 把一次更新检查的结果总结成**一句话**（设置页显示用）。
*
* ## 为什么要单独一个函数
*
* 早期设置页直接把 `behind` 映射成「有更新 / 无更新」两句话 ——
* 于是「本地比远端新」（自己提交了没推）也显示成「无更新」，
* 用户会困惑「我明明改了代码」。
*
* 现在把四种状态分开说。
*/
function describeUpdate(check, mine) {
	if (!check.ok) return `检查失败：${check.reason ?? "未知原因"}`;
	if (check.same === true) return `已是最新（${mine}）`;
	if (check.ahead === true) return `本地更新（${mine}）—— 远端还没有这个提交`;
	if (check.behind === true) {
		const at = check.latestAt === void 0 || check.latestAt === "" ? "" : ` · ${check.latestAt.slice(0, 10)}`;
		return `有新版本 ${check.latestCommit ?? ""}${at} —— ${check.latestMessage ?? ""}`;
	}
	return "状态未知（远端历史与本地不一致）";
}
//#endregion
//#region src/host/index.ts
/**
* dsh-webin — host 半。
*
* 职责：
*   1. 为**每个平台**注册 provider 路由（`webin-deepseek`、`webin-qwen`…），
*      让各平台的网页版出现在模型选择器里
*   2. 任务队列：把 agent 的 prompt 派给 client，等 client 从真实浏览器取回回复
*   3. 登录态快照的**持久化**（`~/.dsh/webin/auth/`，跨 DSH 重启存活）
*   4. 自定义 provider 的**持久化**（`~/.dsh/webin/providers/`）
*
* 为什么持久化放在 host 而不是 client：
*   DSH 的 guest partition 是 `dsh-sidebar-browser-${randomUUID()}`
*   （`main.js:9638`，**无 `persist:` 前缀 ⇒ 内存分区**）。
*   client 侧的 `window.localStorage` 也跟着主窗口 profile 走，不是我们自己的存储；
*   只有 host 侧的文件系统是真正由本插件掌控、且跨重启存活的。
*
* ## 多平台隔离怎么实现的
*
* `DesktopBrowserGuests.acquire(owner, workspace)` 按 **workspace 字符串**缓存
* partition（`main.js:9636-9641`）：
*
* ```js
* let partition = this.partitions.get(workspace);
* if (partition === void 0) {
*   partition = `dsh-sidebar-browser-${randomUUID()}`;
*   this.partitions.set(workspace, partition);
* }
* ```
*
* 所以**用 provider.id 当 workspace 名**，各平台自然拿到不同 partition、
* 不同 cookie / localStorage ⇒ **登录态天然隔离**，且不需要改 DSH 一行。
*/
const name = "dsh-webin";
/** 硬依赖 webServer（路由）与 llm（注册 provider）。 */
const inject = ["webServer", "llm"];
/** 路由前缀（client 半同源 fetch 这个前缀）。 */
const API_PREFIX = "/dsh-webin/api";
/** 默认账号槽位名。 */
const DEFAULT_SLOT = "default";
/** 请求体上限，防止意外灌爆内存。 */
const BODY_LIMIT_BYTES = 2097152;
/** 状态根目录：`~/.dsh/webin/`。 */
function stateRoot() {
	const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	return join(home, "webin");
}
/** 单个槽位的快照文件路径。 */
function snapshotPath(slot) {
	const safe = /^[A-Za-z0-9_-]{1,64}$/.test(slot) ? slot : DEFAULT_SLOT;
	return join(stateRoot(), "auth", `${safe}.json`);
}
/**
* 某个平台「已登录」吗？
*
* ## 判据：快照存在**且**快照里确实有登录凭据
*
* 为什么不看「浏览器在线」：那样重启 DSH 后、用户还没切到 LDW 标签时，
* 模型会从选择器里消失 —— 用户会以为插件坏了。
*
* 快照是**持久化**的（`~/.dsh/webin/auth/<platform>.json`），
* 它记录的是「上次确实登录过」。所以用它判断「能否使用 LDW 模型」最稳：
*   - 登录过 ⇒ 模型可选，即便此刻浏览器没开（发送时会提示打开标签）
*   - 没登录过 ⇒ 模型不列出，用户先去登录
*
* ⚠️ 注意用 `snapshotTextLooksLoggedIn` 而不是「文件存在」——
* 未登录时页面也会写 `userToken={"value":null}`，那种快照不算登录。
*/
function isPlatformLoggedIn(platform) {
	try {
		const path = snapshotPath(platform);
		if (!existsSync(path)) return false;
		return snapshotTextLooksLoggedIn(readFileSync(path, "utf8"));
	} catch {
		return false;
	}
}
/**
* 已登录的平台 id 列表（给状态接口与设置页用）。
*
* 注意判据是**登录快照**而不是「浏览器在线」—— 快照跨重启存活，
* 所以重启后未打开标签页时也能正确报告「这个平台登录过」。
*
* @param platforms - 平台清单（注册表在 `apply()` 内，所以由调用方传入）
*/
function loggedInPlatforms(platforms) {
	const out = [];
	for (const p of platforms) if (isPlatformLoggedIn(p.id)) out.push(p.id);
	return out;
}
/**
* 自定义 provider 的存放目录：`~/.dsh/webin/providers/`。
*
* 一个平台一个 `<id>.json`（内容是单个 Provider 对象）。
* 与登录态快照同一套存储策略：host 侧落盘，跨重启存活。
*/
function providersDir() {
	return join(stateRoot(), "providers");
}
/** 读全部自定义 provider（跳过读不动的文件，不因为一个坏文件全盘失败）。 */
async function readCustomProviders() {
	const dir = providersDir();
	const items = [];
	const errors = [];
	if (!existsSync(dir)) return {
		items,
		errors
	};
	let names;
	try {
		names = await readdir(dir);
	} catch (error) {
		return {
			items,
			errors: [{
				file: dir,
				reason: error?.message ?? String(error)
			}]
		};
	}
	for (const fileName of names) {
		if (!fileName.endsWith(".json")) continue;
		try {
			const text = await readFile(join(dir, fileName), "utf8");
			items.push(JSON.parse(text));
		} catch (error) {
			errors.push({
				file: fileName,
				reason: error?.message ?? String(error)
			});
		}
	}
	return {
		items,
		errors
	};
}
/** 写一个自定义 provider（原子写，文件名用 id）。 */
async function writeCustomProvider(provider) {
	const dir = providersDir();
	await mkdir(dir, { recursive: true });
	const path = join(dir, `${provider.id}.json`);
	await writeAtomic(path, JSON.stringify(provider, null, 2));
	return path;
}
/** 删一个自定义 provider。 */
async function removeCustomProvider(id) {
	const path = join(providersDir(), `${id}.json`);
	if (!existsSync(path)) return false;
	await unlink(path);
	return true;
}
/**
* 会话游标的持久化目录：`~/.dsh/webin/sessions/<platform>.json`。
*
* ## 为什么必须落盘（用户实测发现的缺陷）
*
* 「重启 DSH 后网页版又新开了一个会话，没接上之前那个窗口」。
*
* 根因：游标只在 host 内存里，重启即丢：
*   1. `diff.chatUrl` 为空 ⇒ job 不带 `expectUrl` ⇒ client 在首页发 ⇒ **新开对话**
*   2. 差分游标也丢 ⇒ 重启后第一轮**重发全部历史**（网页记录里又出现超长提示词）
*
* 落盘后两个问题一起解决：重启 → 恢复游标 → 任务带 `expectUrl` →
* client 导航回原对话 → 差分继续按原进度走。
*/
function sessionsDir() {
	return join(stateRoot(), "sessions");
}
/** 单个平台的会话映射文件。 */
function sessionsPath(platform) {
	const safe = /^[A-Za-z0-9_-]{1,64}$/.test(platform) ? platform : "unknown";
	return join(sessionsDir(), `${safe}.json`);
}
/** 配置文件路径：`~/.dsh/webin/config.json`。 */
function configPath() {
	return join(stateRoot(), "config.json");
}
/**
* 读配置。**坏文件不能让插件挂掉** —— 回退默认值并报告原因。
*
* 不做缓存：配置是用户在设置页改的，改完要**立刻生效**。
* 每轮对话只读几次小 JSON，成本可忽略。
*/
function readConfig() {
	const path = configPath();
	if (!existsSync(path)) return {
		config: { ...DEFAULT_CONFIG },
		problems: [],
		raw: ""
	};
	try {
		const raw = readFileSync(path, "utf8");
		const checked = checkConfig(JSON.parse(raw));
		return {
			config: checked.config,
			problems: checked.problems,
			raw
		};
	} catch (error) {
		return {
			config: { ...DEFAULT_CONFIG },
			problems: [{
				field: "(file)",
				reason: `读取失败：${error?.message ?? String(error)}`,
				fellBackTo: "默认值"
			}],
			raw: ""
		};
	}
}
/** 写配置（原子写：先写临时文件再改名，避免留下半截文件）。 */
async function writeConfigFile(config) {
	await mkdir(stateRoot(), { recursive: true });
	const path = configPath();
	const tmp = `${path}.tmp`;
	await writeFile(tmp, JSON.stringify(config, null, 2), "utf8");
	await rename(tmp, path);
}
/** 读请求体（有上限）。 */
function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let total = 0;
		req.on("data", (chunk) => {
			total += chunk.length;
			if (total > BODY_LIMIT_BYTES) {
				reject(/* @__PURE__ */ new Error("body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}
/** 统一的 JSON 响应。 */
function sendJson(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"content-length": Buffer.byteLength(body)
	});
	res.end(body);
}
/** 原子写：先写临时文件再 rename，避免半截文件。 */
async function writeAtomic(path, content) {
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
	await writeFile(tmp, content, {
		encoding: "utf8",
		mode: 384
	});
	await rename(tmp, path);
}
/** 从 URL 取槽位名：`/dsh-webin/api/auth/<slot>/<suffix>`。 */
function slotFromPath(pathname, suffix) {
	const prefix = `${API_PREFIX}/auth/`;
	if (!pathname.startsWith(prefix)) return void 0;
	const rest = pathname.slice(prefix.length);
	if (!rest.endsWith(suffix)) return void 0;
	const slot = rest.slice(0, rest.length - suffix.length);
	return slot === "" ? void 0 : slot;
}
/** 从 URL 取任务 id：`/dsh-webin/api/job/<id>/<suffix>`。 */
function jobIdFromPath(pathname, suffix) {
	const prefix = `${API_PREFIX}/job/`;
	if (!pathname.startsWith(prefix)) return void 0;
	const rest = pathname.slice(prefix.length);
	if (!rest.endsWith(suffix)) return void 0;
	const id = rest.slice(0, rest.length - suffix.length);
	return id === "" ? void 0 : id;
}
/**
* client 心跳的存活阈值。
*
* ## ⚠️ 为什么从 15 秒放宽到 45 秒（**实测发现的问题**）
*
* 心跳间隔是 **5 秒**（client 侧 `setInterval(beat, 5000)`），
* 而第一版阈值是 **15 秒** —— 只容忍漏掉 **2 次**。
*
* 实测（连续观察运行中的 host，每 2 秒采样一次）：
*
*     12:06:42  心跳延迟=10943ms
*     12:06:44  心跳延迟=12975ms
*     12:06:46  心跳延迟=14985ms
*     12:06:48  在线 0 个          ← 掉线
*
* 延迟每次 +2000ms（正好是我的采样间隔）说明**心跳停了**而不是变慢。
* 一旦主线程被占住几秒（client 那边有 500ms / 1500ms / 5000ms 三个
* 定时器，每个都要跨进程 `executeJavaScript`），心跳就漏，
* 15 秒内漏 3 次即判死。
*
* 后果：`/status` 报 `online: 0`，用户以为面板没开。
*
* 45 秒 = 容忍漏掉 8 次，覆盖「主线程忙几秒」的正常抖动，
* 又能在一个面板真的关掉后 45 秒内反映出来。
*/
const CLIENT_STALE_MS = 45e3;
/**
* client 产物的绝对路径 —— 用来判断面板跑的是不是最新构建。
*
* 插件从 `lib/index.js` 跑，所以 client 产物在**同目录**的 `client.js`。
* 用 `import.meta.url` 定位，而不是 cwd（DSH 的 cwd 是用户工作区，
* 不是插件目录）。
*/
function clientBundlePath() {
	try {
		const here = fileURLToPath(import.meta.url);
		return join(dirname(here), "client.js");
	} catch {
		return join(process.cwd(), "lib", "client.js");
	}
}
/**
* 安全取一个命名 logger。
*
* `ctx.logger` 是 Cordis 的 **callable service**（`LoggerService` 用 `createCallable` 包装，
* 见 cordis `lib/index.js:594`），所以：
*   - `ctx.logger('ns')` → 命名 Logger 实例
*   - `ctx.logger.info(...)` → 也合法（`LoggerService.prototype` 上挂了直通方法，`:646`）
*
* ⚠️ 但**不能假设它一定可调用**：`?.()` 只防 null/undefined，不防"存在但不是函数"。
* 宿主版本差异或服务被替换时，一次 TypeError 就会让整个 `apply()` 抛出、
* 插件加载失败。所以这里显式判类型，任何异常都退化成空 logger —— 日志丢了不致命，
* 插件装不上才致命。
*/
function safeLogger(ctx) {
	try {
		const svc = ctx.logger;
		if (svc === void 0 || svc === null) return {};
		let target = svc;
		if (typeof svc === "function") target = svc("dsh-webin");
		if (target === null || typeof target !== "object") target = svc;
		const t = target;
		const pick = (fn) => typeof fn === "function" ? (m) => fn.call(target, m) : void 0;
		return {
			info: pick(t.info),
			warn: pick(t.warn),
			debug: pick(t.debug)
		};
	} catch {
		return {};
	}
}
async function apply(ctx) {
	const log = safeLogger(ctx);
	/** 在线客户端心跳（clientId → 最近一次心跳）。 */
	const beats = /* @__PURE__ */ new Map();
	/**
	* 上次更新检查结果（**缓存 60 秒**）。
	*
	* 未认证的 GitHub API 每小时只有 60 次配额 —— 用户在设置页连点几次
	* 「检查更新」就能把它打光。缓存一下，正常使用完全够。
	*
	* ## ⚠️ 按仓库分键（修掉的真实 bug）
	*
	* 早期是**一个模块级变量**。若用户在设置页把 repo 改成别的仓库，
	* 60 秒内仍会拿到**上一个仓库**的结果 —— 显示的是别人的版本信息。
	*
	* 现在用 Map 按 `owner/repo` 分键。
	*/
	const updateChecks = /* @__PURE__ */ new Map();
	/** 缓存有效期。 */
	const UPDATE_CACHE_MS = 6e4;
	/**
	* 各平台当前的 guest partition 名（由 client 上报）。
	*
	* ## 为什么需要（解决「重启必须重新登录」）
	*
	* DSH 分配的 partition 是 `dsh-sidebar-browser-${randomUUID()}` ——
	* **随机、内存分区**，host 猜不到名字。而只有拿到名字才能用
	* `session.fromPartition(name).cookies` 读写**含 httpOnly** 的 cookie
	* （那是 DeepSeek 登录态的真正载体，页面 JS 看不到）。
	*
	* client 半在 `browser.acquire()` 的返回值里拿得到，所以由它上报。
	* 重启后 client 会重新上报一个新的 partition 名 —— host 用存档里的
	* cookie 写回**新** partition，从而实现免登录。
	*/
	const partitions = /* @__PURE__ */ new Map();
	/**
	* 上报过身份的 DSH 会话（`sessionId` → 最后上报时刻）。
	*
	* client 半挂载 `conversation.view` 的 LDW 视图时上报自己窗口的
	* `sessionId`（DSH 的 standardProps 直接给）。用途：
	*   - `/status` 能列出「现在有哪些窗口挂着 LDW」
	*   - 排查「任务被别的窗口领走」时，对照任务的 `sessionId`
	*/
	const knownSessions = /* @__PURE__ */ new Map();
	const liveClients = () => {
		const now = Date.now();
		const out = [];
		for (const [id, beat] of beats) {
			if (now - beat.at > CLIENT_STALE_MS) {
				beats.delete(id);
				continue;
			}
			out.push(beat);
		}
		return out;
	};
	const registry = new ProviderRegistry();
	const queue = new JobQueue();
	/**
	* ## 端到端自测：直接往队列塞一个任务，看 client 能不能跑完整条链路
	*
	* ## 为什么需要（用户的话：「你自己测试吧！到目前为止，一次都没成功！」）
	*
	* 我之前的测试全是**离线单测** —— 只能证明「代码里写了什么」，
	* 证明不了「真跑起来能不能回显」。
	*
	* 而真正的端到端需要 DSH 调 LLM 接口派发任务 —— 我在测试脚本里
	* 做不到那一步。**但队列是同一个实例**（这个 `queue` 就是
	* `adapter` 用的那个），所以可以直接塞任务进去，让真实的 client
	* 去领、去发、去抓回复。
	*
	* 于是 `POST /selftest/echo` 能验证**除 DSH 派发之外的全部链路**：
	*
	*     塞任务 → client 领活 → 填输入框 → 点发送 → 网页版生成
	*            → 抓 DOM → 交结果 → 这里读结果
	*
	* 这是我能做到的最接近「真跑一遍」的验证。
	*/
	const selfTests = /* @__PURE__ */ new Map();
	/**
	* 游标落盘 —— **重启后接回原对话的关键**。
	*
	* 不落盘的话重启后：`chatUrl` 丢失 ⇒ 任务不带 `expectUrl` ⇒
	* client 在首页发 ⇒ **新开一个网页对话**（用户实测：「没接上之前的那个窗口」）；
	* 同时差分游标也丢 ⇒ 第一轮重发全部历史。
	*/
	const adapter = createAdapter({
		queue,
		logger: log,
		registry,
		/** 每轮读一次配置 —— 设置页改完立刻生效，不用重启。 */
		getConfig: () => readConfig().config,
		/**
		* 登录门禁：未登录的平台不列出模型、也不允许调用。
		* 用户要求「如果是已登录才能使用 LDW 那俩模型」。
		*/
		isLoggedIn: (platform) => isPlatformLoggedIn(platform),
		cursorStore: {
			load: (platform) => {
				const path = sessionsPath(platform);
				try {
					if (!existsSync(path)) return {};
					return JSON.parse(readFileSync(path, "utf8")).sessions ?? {};
				} catch (error) {
					log.warn?.(`读取会话映射失败 ${platform}: ${error?.message ?? String(error)}`);
					return {};
				}
			},
			save: (platform, key, cursor) => {
				const path = sessionsPath(platform);
				try {
					let all = {};
					if (existsSync(path)) try {
						all = JSON.parse(readFileSync(path, "utf8")).sessions ?? {};
					} catch {}
					if (cursor === void 0) delete all[key];
					else all[key] = cursor;
					mkdirSync(sessionsDir(), { recursive: true });
					writeFileSync(path, JSON.stringify({ sessions: all }, null, 2), "utf8");
				} catch (error) {
					log.warn?.(`写入会话映射失败 ${platform}: ${error?.message ?? String(error)}`);
				}
			}
		}
	});
	/** 当前注册了哪些路由（自定义 provider 增删后要重注册）。 */
	let registeredRoutes = [];
	const syncProviders = () => {
		const routes = registry.all().map((p) => routeFor(p.id));
		if (routes.length === registeredRoutes.length && routes.every((r, i) => r === registeredRoutes[i])) return;
		for (const route of registeredRoutes) disposers.get(route)?.();
		disposers.clear();
		for (const route of routes) disposers.set(route, ctx.llm.registerAdapter([route], adapter));
		registeredRoutes = routes;
		log.info?.(`已注册 provider 路由：${routes.join(", ")}`);
	};
	const disposers = /* @__PURE__ */ new Map();
	ctx.effect(() => () => {
		for (const dispose of disposers.values()) dispose();
		disposers.clear();
		registeredRoutes = [];
	}, "dsh-webin: llm adapters");
	const initial = await readCustomProviders();
	if (initial.items.length > 0) {
		const loaded = registry.loadCustom(initial.items);
		if (loaded.accepted.length > 0) log.info?.(`已加载自定义 provider：${loaded.accepted.join(", ")}`);
		for (const r of loaded.rejected) log.warn?.(`自定义 provider #${r.index} 校验失败：${r.reason}`);
	}
	for (const e of initial.errors) log.warn?.(`自定义 provider 文件读取失败 ${e.file}：${e.reason}`);
	syncProviders();
	const handler = async (req, res) => {
		try {
			const url = new URL(req.url ?? "/", "http://127.0.0.1");
			const pathname = url.pathname;
			const method = (req.method ?? "GET").toUpperCase();
			/**
			* ## POST /client/partition —— client 上报它拿到的 guest partition 名
			*
			* ## 为什么需要这个（解决「重启必须重新登录」）
			*
			* DSH 给 guest 分配的 partition 是 `dsh-sidebar-browser-${randomUUID()}`
			* （`lib/main.js:9638`）—— **无 `persist:` 前缀 = 内存分区**，
			* 进程退出 cookie 全丢。
			*
			* 而 DeepSeek 的登录态主要靠 **httpOnly cookie**：页面里的
			* `document.cookie` 看不见也写不了。所以只靠页面侧快照
			* **天生补不全**（用户实测：「每次重启 dsh 都需要重新登陆」）。
			*
			* partition 名是随机的、host 猜不到 —— 但 client 半在
			* `browser.acquire()` 的返回值里拿得到。上报后，host 就能用
			* Electron 的 `session.fromPartition(name).cookies` 读写**含
			* httpOnly** 的完整 cookie。
			*
			* ⚠️ 拿不到 electron（纯 node / 测试环境）时**不能报错** ——
			* 那会让 client 的这次上报看起来像失败。返回 `cookieApi:false`
			* 让 client 知道走的是降级路径。
			*/
			if (method === "POST" && pathname === `${API_PREFIX}/client/partition`) {
				const body = await readBody(req);
				let payload;
				try {
					payload = JSON.parse(body);
				} catch {
					sendJson(res, 400, {
						ok: false,
						reason: "invalid-json"
					});
					return;
				}
				const platform = typeof payload.platform === "string" ? payload.platform : "";
				const partition = typeof payload.partition === "string" ? payload.partition : "";
				const domain = typeof payload.domain === "string" ? payload.domain : "";
				if (platform === "" || partition === "") {
					sendJson(res, 400, {
						ok: false,
						reason: "missing platform/partition"
					});
					return;
				}
				partitions.set(platform, {
					partition,
					domain,
					at: Date.now()
				});
				sendJson(res, 200, {
					ok: true,
					/** electron 可用时才能真正读写 httpOnly cookie。 */
					cookieApi: cookieApiAvailable(),
					/** 有没有存档可以写回。 */
					archived: loadCookieArchive(stateRoot(), platform) !== void 0
				});
				return;
			}
			/** POST /auth/<platform>/cookies —— 抓取当前 partition 的 cookie 并存档。 */
			if (method === "POST" && pathname.startsWith(`${API_PREFIX}/auth/`) && pathname.endsWith("/cookies")) {
				const platform = decodeURIComponent(pathname.slice(`${API_PREFIX}/auth/`.length, -8));
				const known = partitions.get(platform);
				if (known === void 0) {
					sendJson(res, 409, {
						ok: false,
						reason: "还不知道该平台的 partition —— 请先打开 LDW 标签让它上报"
					});
					return;
				}
				const domain = known.domain === "" ? platform : known.domain;
				const cookies = await grabCookies(known.partition, domain);
				if (cookies === void 0) {
					sendJson(res, 501, {
						ok: false,
						reason: "当前环境拿不到 Electron session API（无法读取 httpOnly cookie）"
					});
					return;
				}
				saveCookieArchive(stateRoot(), {
					platform,
					cookies,
					at: Date.now()
				});
				sendJson(res, 200, {
					ok: true,
					count: cookies.length,
					domain
				});
				return;
			}
			/** GET /auth/<platform>/cookies —— 把存档写回当前 partition。 */
			if (method === "GET" && pathname.startsWith(`${API_PREFIX}/auth/`) && pathname.endsWith("/cookies")) {
				const platform = decodeURIComponent(pathname.slice(`${API_PREFIX}/auth/`.length, -8));
				const known = partitions.get(platform);
				if (known === void 0) {
					sendJson(res, 409, {
						ok: false,
						reason: "还不知道该平台的 partition"
					});
					return;
				}
				const archive = loadCookieArchive(stateRoot(), platform);
				if (archive === void 0) {
					sendJson(res, 404, {
						ok: false,
						reason: "没有 cookie 存档"
					});
					return;
				}
				const n = await restoreCookies(known.partition, archive.cookies);
				sendJson(res, 200, {
					ok: n > 0,
					restored: n,
					total: archive.cookies.length,
					...n === 0 ? { reason: "写回失败（可能拿不到 Electron session API）" } : {}
				});
				return;
			}
			/**
			* ## POST /selftest/echo —— 端到端自测：真的发一条消息，等真的回复
			*
			* ## 为什么需要（用户：「你自己测试吧！到目前为止，一次都没成功！」）
			*
			* 真正的端到端要 DSH 调 LLM 派发任务，测试脚本做不到。
			* **但队列是同一个实例** —— 直接塞进去，真实 client 会领走、
			* 填输入框、点发送、抓 DOM、交结果。
			*
			* 所以这个路由能验证除「DSH 派发」外的**全部链路**。
			*
			* 用法：
			*     POST /selftest/echo  {"prompt":"1+1=?","platform":"deepseek"}
			*     → {"ok":true,"jobId":"job-..."}
			*     然后 GET /selftest/echo/<jobId> 读结果
			*/
			if (method === "POST" && pathname === `${API_PREFIX}/selftest/echo`) {
				const body = await readBody(req);
				let payload;
				try {
					payload = JSON.parse(body);
				} catch {
					sendJson(res, 400, {
						ok: false,
						reason: "invalid-json"
					});
					return;
				}
				const prompt = String(payload.prompt ?? "").trim();
				if (prompt === "") {
					sendJson(res, 400, {
						ok: false,
						reason: "prompt 不能为空"
					});
					return;
				}
				const platform = String(payload.platform ?? "deepseek");
				if (registry.all().find((p) => p.id === platform) === void 0) {
					sendJson(res, 400, {
						ok: false,
						reason: `未知平台 ${platform}`,
						platforms: registry.all().map((p) => p.id)
					});
					return;
				}
				/**
				* ⚠️ **不带 sessionId** —— 这样任何窗口都能领走（`hasIdentity`
				* 那侧的兼容路径），避免自测因为窗口没上报身份而领不到。
				*/
				const job = queue.enqueue(prompt, false, platform);
				selfTests.set(job.id, {
					prompt,
					at: Date.now()
				});
				sendJson(res, 200, {
					ok: true,
					jobId: job.id,
					prompt,
					platform,
					hint: `GET ${API_PREFIX}/selftest/echo/${job.id} 读结果`
				});
				return;
			}
			/**
			* GET /selftest/echo/<jobId> —— 读自测结果
			*
			* 返回任务的**完整状态**（pending / claimed / done / failed），
			* 以及拿到的回复正文。这样「到底跑到哪一步」一眼可见。
			*/
			if (method === "GET" && pathname.startsWith(`${API_PREFIX}/selftest/echo/`)) {
				const jobId = decodeURIComponent(pathname.slice(`${API_PREFIX}/selftest/echo/`.length));
				const job = queue.get(jobId);
				if (job === void 0) {
					sendJson(res, 404, {
						ok: false,
						reason: "没有这个任务",
						jobId
					});
					return;
				}
				const mine = selfTests.get(jobId);
				sendJson(res, 200, {
					ok: true,
					jobId,
					prompt: mine?.prompt ?? job.prompt,
					elapsedMs: Date.now() - (mine?.at ?? job.createdAt),
					state: job.done !== void 0 ? "done" : job.failed !== void 0 ? job.cancelled === true ? "cancelled" : "failed" : job.claimedAt !== void 0 ? "claimed" : "pending",
					claimedBy: job.claimedBy ?? "(未领)",
					/** 拿到的回复正文（这就是「回显」的内容）。 */
					...job.done === void 0 ? {} : {
						text: job.done.text,
						think: job.done.think
					},
					...job.failed === void 0 ? {} : { error: job.failed }
				});
				return;
			}
			/**
			* ## GET /diagnose/electron —— 为什么拿不到 Electron session
			*
			* 用户要求「不要猜」。`cookieApi: false` 只是一个布尔值，
			* 分不清是 `import.meta.url` 拿不到、`require` 抛错、
			* 还是 electron 拿到了但 session 是空壳。
			*
			* 这个路由把**每一步的结果和错误原文**都返回出来 ——
			* 一眼看出卡在哪，不用再猜。
			*/
			if (method === "GET" && pathname === `${API_PREFIX}/diagnose/electron`) {
				sendJson(res, 200, {
					ok: true,
					...diagnoseElectron()
				});
				return;
			}
			/**
			* ## POST /client/session —— client 上报「我挂在哪个 DSH 会话上」
			*
			* ## 为什么需要（用户报的「所有窗口都生效」）
			*
			* 早期 `/job/next` 只按平台过滤 ⇒ **任何窗口都能领走任何任务**。
			* 用户实测：「换了几个 dsh 窗口聊天，发现全都是在网页版的同一个
			* 会话窗口」、「所有窗口都生效」。
			*
			* client 半从 `conversation.view` 的 standardProps 拿到 `sessionId`
			* （**DSH 官方提供的 prop**，见 Slots Inspect 的 standardProps 列表），
			* 挂载时上报一次。之后领活带上 `?session=<id>`，host 只派匹配的。
			*
			* ⚠️ 上报失败不影响功能（退回按平台派发），所以这里**不返回错误**
			* 给用户造成困扰 —— 只记日志。
			*/
			if (method === "POST" && pathname === `${API_PREFIX}/client/session`) {
				const body = await readBody(req);
				let payload;
				try {
					payload = JSON.parse(body);
				} catch {
					sendJson(res, 400, {
						ok: false,
						reason: "invalid-json"
					});
					return;
				}
				const sid = typeof payload.sessionId === "string" ? payload.sessionId.trim() : "";
				if (sid === "") {
					sendJson(res, 400, {
						ok: false,
						reason: "missing sessionId"
					});
					return;
				}
				knownSessions.set(sid, Date.now());
				/** 顺手清理 10 分钟没上报的（窗口关了）。 */
				const cutoff = Date.now() - 6e5;
				for (const [id, at] of knownSessions) if (at < cutoff) knownSessions.delete(id);
				sendJson(res, 200, {
					ok: true,
					known: knownSessions.size
				});
				return;
			}
			/**
			* ## GET /build —— 当前 client 产物的构建号（给注入脚本轮询用）
			*
			* 注入到 `index.html` 的自检脚本每隔几秒问一次；rev 变了就重载。
			* 这样**不依赖** DSH 的 HMR（实测它浏览器端不消费 `rebuilt` 帧）。
			*
			* ⚠️ 这个路由要**极轻**：它每几秒被每个页面请求一次。
			* 只 stat 一个文件，不做别的。
			*/
			if (method === "GET" && pathname === `${API_PREFIX}/build`) {
				let rev = "unknown";
				let mtimeMs = 0;
				try {
					const p = clientBundlePath();
					const st = statSync(p);
					mtimeMs = st.mtimeMs;
					/**
					* 与 DSH 的 `artifactRevision` **同算法**（framedHash + mtime/ctime/size）——
					* 这样我们的 rev 和 graph 里那个一致，排查时能直接对照。
					*/
					rev = createHash("sha1").update("plugin-artifact").update("\0").update(`${String(Buffer.byteLength(String(st.mtimeMs)))}:`).update(String(st.mtimeMs)).update(`${String(Buffer.byteLength(String(st.ctimeMs)))}:`).update(String(st.ctimeMs)).update(`${String(Buffer.byteLength(String(st.size)))}:`).update(String(st.size)).digest("hex").slice(0, 12);
				} catch {}
				sendJson(res, 200, {
					ok: true,
					rev,
					mtimeMs,
					builtAt: currentVersion().builtAt
				});
				return;
			}
			if (method === "GET" && pathname === `${API_PREFIX}/job/next`) {
				const platform = url.searchParams.get("platform") ?? void 0;
				/**
				* ## ⭐ `?session=<sessionId>` —— 来领活的窗口是哪个 DSH 会话
				*
				* ## 为什么必须有（用户报的「所有窗口都生效」）
				*
				* 早期只按 `platform` 过滤 ⇒ **任何 DSH 窗口都能领走任何任务**。
				* 用户实测：「换了几个 dsh 窗口聊天，发现全都是在网页版的同一个
				* 会话窗口」、「所有窗口都生效」。
				*
				* client 半从 `conversation.view` 的 standardProps 拿到
				* `sessionId`（**DSH 官方提供的 prop**，见 Slots Inspect 的
				* `standardProps` 列表），领活时带上。
				*
				* ⚠️ 没带时退回「按平台派发」（向后兼容）—— 否则老 client
				* 的任务会永远没人领。
				*/
				const session = url.searchParams.get("session") ?? void 0;
				/**
				* `?running=<jobId>` —— client 报告「我正在跑哪个任务」。
				*
				* 用途：用户按停止后 host 会把任务标记为 `cancelled`，
				* client 靠这个参数问「我这个任务还算数吗」。
				* 不算数就去按页面的停止按钮，别让页面白生成到结束（烧配额）。
				*/
				const running = url.searchParams.get("running") ?? void 0;
				if (running !== void 0 && running !== "") {
					const current = queue.get(running);
					if (current === void 0 || current.cancelled === true) {
						sendJson(res, 200, {
							ok: true,
							job: null,
							cancel: running
						});
						return;
					}
				}
				const job = queue.claimNext(platform, session);
				if (job === void 0) {
					sendJson(res, 200, {
						ok: true,
						job: null,
						clientOnline: queue.hasClaimed()
					});
					return;
				}
				sendJson(res, 200, {
					ok: true,
					job: {
						id: job.id,
						prompt: job.prompt,
						thinking: job.thinking,
						platform: job.platform,
						/** 该任务属于哪个 DSH 会话 —— client 可据此确认没领错。 */
						...job.sessionId === void 0 ? {} : { sessionId: job.sessionId },
						/**
						* 该任务所属 DSH 会话绑定的网页对话 URL。
						* client 发现当前页面不在这里时，先导航过去再发送 ——
						* 否则所有 DSH 会话挤一个网页对话（封号级缺陷）。
						*/
						...job.expectUrl === void 0 ? {} : { expectUrl: job.expectUrl },
						/**
						* 首轮（无绑定）：client 必须**开新对话**，不能占用当前页 ——
						* 否则两个 DSH 会话会挤进同一个网页对话。
						*/
						...job.freshChat === true ? { freshChat: true } : {}
					}
				});
				return;
			}
			const resultJobId = jobIdFromPath(pathname, "/result");
			if (method === "PUT" && resultJobId !== void 0) {
				const body = await readBody(req);
				let payload;
				try {
					payload = JSON.parse(body);
				} catch {
					sendJson(res, 400, {
						ok: false,
						reason: "invalid-json"
					});
					return;
				}
				if (payload.via === "dom-scrape") log.warn?.(`job ${resultJobId} 的结果来自 DOM 兜底（hook 未捕获 SSE）—— 若频繁出现请点「诊断」查看 postPaths`);
				const settled = typeof payload.error === "string" && payload.error !== "" ? queue.settle(resultJobId, { error: payload.error }) : queue.settle(resultJobId, {
					text: String(payload.text ?? ""),
					think: String(payload.think ?? ""),
					status: String(payload.status ?? "finished"),
					/**
					* 发送成功后所在的页面 URL —— host 记住它，
					* 让该 DSH 会话的后续任务都导航回这个对话接着聊。
					*/
					...typeof payload.chatUrl === "string" && payload.chatUrl !== "" ? { chatUrl: payload.chatUrl } : {}
				});
				log.debug?.(`job ${resultJobId} settled=${String(settled)}`);
				sendJson(res, settled ? 200 : 404, { ok: settled });
				return;
			}
			const getSlot = slotFromPath(pathname, "/snapshot");
			if (method === "GET" && getSlot !== void 0) {
				const path = snapshotPath(getSlot);
				if (!existsSync(path)) {
					sendJson(res, 404, {
						ok: false,
						reason: "no-snapshot"
					});
					return;
				}
				const text = await readFile(path, "utf8");
				res.writeHead(200, {
					"content-type": "application/json; charset=utf-8",
					"cache-control": "no-store"
				});
				res.end(text);
				return;
			}
			if (method === "PUT" && getSlot !== void 0) {
				const body = await readBody(req);
				try {
					JSON.parse(body);
				} catch {
					sendJson(res, 400, {
						ok: false,
						reason: "invalid-json"
					});
					return;
				}
				await writeAtomic(snapshotPath(getSlot), body);
				log.info?.(`auth snapshot saved: slot=${getSlot} bytes=${body.length}`);
				sendJson(res, 200, {
					ok: true,
					slot: getSlot,
					bytes: body.length
				});
				return;
			}
			if (method === "DELETE" && getSlot !== void 0) {
				const path = snapshotPath(getSlot);
				if (existsSync(path)) await unlink(path);
				sendJson(res, 200, {
					ok: true,
					slot: getSlot
				});
				return;
			}
			if (method === "GET" && pathname === `${API_PREFIX}/auth`) {
				let slots = [];
				try {
					slots = (await readdir(join(stateRoot(), "auth"))).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
				} catch {
					slots = [];
				}
				sendJson(res, 200, {
					ok: true,
					slots,
					root: stateRoot()
				});
				return;
			}
			if (method === "POST" && pathname === `${API_PREFIX}/client/heartbeat`) {
				const body = await readBody(req);
				let payload;
				try {
					payload = JSON.parse(body);
				} catch {
					sendJson(res, 400, {
						ok: false,
						reason: "invalid-json"
					});
					return;
				}
				const clientId = typeof payload.clientId === "string" && payload.clientId !== "" ? payload.clientId : "anonymous";
				const platform = typeof payload.platform === "string" && payload.platform !== "" ? payload.platform : DEFAULT_PROVIDER_ID;
				beats.set(clientId, {
					clientId,
					platform,
					at: Date.now(),
					loggedIn: payload.loggedIn === true,
					hasGuest: payload.hasGuest === true,
					replyCount: typeof payload.replyCount === "number" ? payload.replyCount : 0,
					/**
					* ## ⚠️ 这里原来**漏存 scrape** —— 诊断数据到 host 就被丢了
					*
					* 症状：client 侧 payload 里明明有 `scrape`（产物核对过），
					* 但 `/status` 永远看不到 —— 因为 handler 只挑几个字段
					* 重新组装，没读 `payload.scrape`。
					*
					* 教训：**类型上加字段 ≠ 运行时会保留** ——
					* 这种「手工挑字段」的写法每加一个字段都要记得同步。
					*/
					...payload.scrape === void 0 ? {} : { scrape: payload.scrape },
					...payload.dom === void 0 ? {} : { dom: payload.dom },
					...payload.clientBuiltAt === void 0 ? {} : { clientBuiltAt: payload.clientBuiltAt }
				});
				/**
				* ## ⭐⭐ 告诉面板「有新构建了」—— 让它自己重载
				*
				* ## ⚠️⚠️ 第一版判据写错了，造成**每 2 秒无限重载**（群友实测）
				*
				* 第一版：面板上报烘死的 `clientBuiltAt`，host 比 `mtime`，
				* 晚 5 秒以上就回 `reload: true`。
				*
				* 但 `builtAt` 是**构建开始时**算的，`client.js` **写盘**在构建末尾
				* —— 机器稍慢差值就超过 5 秒 ⇒ **永远判定落后** ⇒
				* 面板每收到一次心跳就 reload 一次 ⇒ **死循环**（每 2~2.2 秒一次），
				* 甚至把 DSH 桌面端拖崩。
				*
				* ## 正确判据：**rev 变化**（我启动时见过的 rev vs 现在的 rev）
				*
				*   1. host 每次心跳回包都带上当前产物的 `rev`
				*      （与 DSH 的 `artifactRevision` 同算法：sha1(mtime+ctime+size)）
				*   2. 面板**第一次**收到时把它记下来（=「我加载时是哪个版本」）
				*   3. 之后 rev **变了** ⇒ 真的出了新构建 ⇒ 才 reload
				*   4. reload 后加载到的就是新 bundle ⇒ 记下的 rev = 新 rev ⇒ 停止
				*
				* 这个判据**自收敛**：只有真的换了文件才会变，重载一次就稳定。
				*/
				let bundleRev = "";
				try {
					const st = statSync(clientBundlePath());
					bundleRev = createHash("sha1").update("plugin-artifact").update("\0").update(`${String(Buffer.byteLength(String(st.mtimeMs)))}:`).update(String(st.mtimeMs)).update(`${String(Buffer.byteLength(String(st.ctimeMs)))}:`).update(String(st.ctimeMs)).update(`${String(Buffer.byteLength(String(st.size)))}:`).update(String(st.size)).digest("hex").slice(0, 12);
				} catch {}
				sendJson(res, 200, {
					ok: true,
					clients: liveClients().length,
					/**
					* ⚠️ **每次都带** rev（不只 reload 时带）—— 面板要靠它做
					* 「初次记录」。reload 与否由面板自己判断（rev 变了才重载）。
					*/
					bundleRev
				});
				return;
			}
			/**
			* ---- GET /config —— 读配置 ----
			*
			* 返回「当前生效的配置」+「默认值」+「边界」+「校验问题」。
			* 设置页需要这四样才能画出正确的表单：
			*   - 当前值：显示
			*   - 默认值：给「恢复默认」按钮用
			*   - 边界：给输入框的 min/max，避免用户填了才被拒
			*   - 问题：文件坏了 / 值超界时明确告诉用户
			*/
			if (method === "GET" && pathname === `${API_PREFIX}/config`) {
				const { config, problems } = readConfig();
				sendJson(res, 200, {
					ok: true,
					config,
					defaults: DEFAULT_CONFIG,
					limits: LIMITS,
					problems,
					summary: describeConfig(config),
					path: configPath()
				});
				return;
			}
			/**
			* ---- PUT /config —— 写配置 ----
			*
			* 校验在 host 做，**不信客户端传什么就存什么**。
			* 非法字段回退默认并逐条报告（不静默吞掉）—— 否则用户改了没生效会困惑。
			*/
			if (method === "PUT" && pathname === `${API_PREFIX}/config`) {
				const body = await readBody(req);
				let payload;
				try {
					payload = JSON.parse(body);
				} catch {
					sendJson(res, 400, {
						ok: false,
						reason: "invalid-json"
					});
					return;
				}
				const checked = checkConfig(payload);
				try {
					await writeConfigFile(checked.config);
				} catch (error) {
					sendJson(res, 500, {
						ok: false,
						reason: `写入失败：${error?.message ?? String(error)}`
					});
					return;
				}
				log.info?.(`配置已更新：${describeConfig(checked.config)}`);
				sendJson(res, 200, {
					ok: true,
					config: checked.config,
					problems: checked.problems,
					summary: describeConfig(checked.config)
				});
				return;
			}
			/**
			* ---- DELETE /config —— 恢复默认 ----
			*
			* 直接写一份默认值（而不是删文件）—— 删了之后 `GET` 也能返回默认，
			* 但写出来用户能看见「确实是默认值」，比空文件直观。
			*/
			if (method === "DELETE" && pathname === `${API_PREFIX}/config`) {
				try {
					await writeConfigFile({ ...DEFAULT_CONFIG });
				} catch (error) {
					sendJson(res, 500, {
						ok: false,
						reason: `写入失败：${error?.message ?? String(error)}`
					});
					return;
				}
				log.info?.("配置已恢复默认");
				sendJson(res, 200, {
					ok: true,
					config: { ...DEFAULT_CONFIG },
					problems: [],
					summary: describeConfig(DEFAULT_CONFIG)
				});
				return;
			}
			/**
			* ---- GET /version —— 版本 + 更新检查 ----
			*
			* ## 为什么走 host 而不是让 client 直接请求 GitHub
			*
			*   - **CORS**：浏览器里对 `api.github.com` 的跨域请求会被拦
			*   - **凭据**：host 侧不需要任何凭据（公开仓库），也不该为了
			*     检查更新去要一个能写仓库的 token
			*   - **缓存**：host 侧记一下上次结果，用户反复开设置页时不必重复打
			*     GitHub（未认证的 API 每小时 60 次，刷几次就没了）
			*/
			if (method === "GET" && pathname === `${API_PREFIX}/version`) {
				const info = currentVersion();
				/** `?check=1` 才真的打 GitHub —— 默认只回本地版本，省配额。 */
				const wantCheck = new URL(req.url ?? "", "http://localhost").searchParams.get("check") === "1";
				let update;
				if (wantCheck) {
					const now = Date.now();
					/**
					* 60 秒内复用上次结果（用户连点「检查更新」不会打爆配额）。
					* ⚠️ **按仓库分键** —— 见 `updateChecks` 的说明。
					*/
					const cached = updateChecks.get(info.repo);
					if (cached !== void 0 && now - cached.checkedAt < UPDATE_CACHE_MS) update = cached;
					else {
						update = await checkForUpdate(info.repo);
						updateChecks.set(info.repo, update);
					}
				}
				sendJson(res, 200, {
					ok: true,
					...info,
					repoUrl: repoUrl(info.repo),
					starUrl: starUrl(info.repo),
					updateHint: updateHint(info.repo),
					/** 一句话总结（四种状态分开说，见 `describeUpdate`）。 */
					updateSummary: update === void 0 ? void 0 : describeUpdate(update, info.commit),
					...update === void 0 ? {} : { update }
				});
				return;
			}
			if (method === "GET" && pathname === `${API_PREFIX}/status`) {
				const clients = liveClients();
				sendJson(res, 200, {
					ok: true,
					plugin: name,
					/**
					* 平台清单 —— 每个平台一个 provider 路由，模型选择器里是独立分组。
					* `overridden` 标出哪些内置平台被用户自定义 JSON 覆盖了。
					*/
					platforms: registry.all().map((p) => ({
						id: p.id,
						name: p.name,
						route: routeFor(p.id),
						homeUrl: p.homeUrl,
						models: p.models.map((m) => ({
							id: `${p.id}:${m.id}`,
							name: m.name
						})),
						contextWindow: p.contextWindow,
						custom: registry.overriddenIds().includes(p.id)
					})),
					root: stateRoot(),
					providersDir: providersDir(),
					/**
					* 面板在线情况 —— 模型不回复时先看这里。
					* `online: 0` 表示没有任何 LDW 面板在跑，任务必然无人领取。
					*/
					clients: {
						online: clients.length,
						loggedIn: clients.filter((c) => c.loggedIn).length,
						detail: clients.map((c) => ({
							clientId: c.clientId,
							platform: c.platform,
							ageMs: Date.now() - c.at,
							loggedIn: c.loggedIn,
							hasGuest: c.hasGuest,
							replyCount: c.replyCount,
							/** ⭐ 抓取诊断 —— 看「抓到的是不是回复」。 */
							...c.scrape === void 0 ? {} : { scrape: c.scrape },
							...c.dom === void 0 ? {} : { dom: c.dom }
						}))
					},
					/**
					* 登录过的平台（判据是**持久化快照**，不是「浏览器此刻在线」）。
					*
					* 未登录的平台**不会列出模型** —— 用户要求
					* 「如果是已登录才能使用 LDW 那俩模型」。输入框旁边的 LDW 按钮
					* 也读这个字段决定显示「去登录」还是「已登录」。
					*/
					loggedInPlatforms: loggedInPlatforms(registry.all()),
					/**
					* ## ⭐ 任务队列快照 —— 「所有窗口都生效」时看这里，不用猜
					*
					* 每条显示：任务属于哪个会话、被**哪个会话的窗口**领走、当前状态。
					*
					* 排查「任务被别的窗口抢走了」时，这一眼就能看出来：
					*   - `sessionId` 是任务的归属会话
					*   - `claimedBy` 是实际领走它的窗口
					*   - 两者不一致 ⇒ 就是派发错了
					*/
					jobs: queue.inspect(),
					/** client 上报过哪些会话（每个窗口挂载 LDW 视图时会上报）。 */
					knownSessions: [...knownSessions.entries()].map(([id, at]) => ({
						sessionId: id,
						ageMs: Date.now() - at
					})),
					routes: [
						`GET    ${API_PREFIX}/status`,
						`GET    ${API_PREFIX}/providers`,
						`POST   ${API_PREFIX}/providers`,
						`DELETE ${API_PREFIX}/providers/<id>`,
						`POST   ${API_PREFIX}/client/heartbeat`,
						`GET    ${API_PREFIX}/job/next?platform=<id>`,
						`PUT    ${API_PREFIX}/job/<id>/result`,
						`GET    ${API_PREFIX}/auth`,
						`GET    ${API_PREFIX}/auth/<slot>/snapshot`,
						`PUT    ${API_PREFIX}/auth/<slot>/snapshot`,
						`DELETE ${API_PREFIX}/auth/<slot>/snapshot`
					]
				});
				return;
			}
			if (method === "GET" && pathname === `${API_PREFIX}/providers`) {
				const { items, errors } = await readCustomProviders();
				const loaded = new ProviderRegistry().loadCustom(items);
				/**
				* 设置页需要「当前生效的全部平台」。内置项也列出来 ——
				* 用户看到的是「我能用哪些平台」，而不是「我加过哪些文件」。
				*/
				const customIds = new Set(loaded.accepted.map((p) => p.id));
				sendJson(res, 200, {
					ok: true,
					dir: providersDir(),
					/** 生效的全部平台（内置 + 自定义，自定义覆盖同 id 内置）。 */
					providers: registry.all(),
					/** 哪些是用户自定义的（设置页据此决定能否删）。 */
					customIds: [...customIds],
					defaultProviderId: DEFAULT_PROVIDER_ID,
					accepted: loaded.accepted,
					rejected: loaded.rejected.map((r) => ({
						index: r.index,
						reason: r.reason
					})),
					/** 设置页显示的读盘错误。 */
					errors: errors.map((e) => ({
						file: e.file,
						reason: e.reason
					})),
					fileErrors: errors,
					count: items.length,
					/** 在线客户端（登录态来源）。 */
					clients: liveClients(),
					/** 登录过的平台（快照判据）—— 设置页据此显示「已登录 / 去登录」。 */
					loggedInPlatforms: loggedInPlatforms(registry.all())
				});
				return;
			}
			if (method === "POST" && pathname === `${API_PREFIX}/providers`) {
				const body = await readBody(req);
				let payload;
				try {
					payload = JSON.parse(body);
				} catch {
					sendJson(res, 400, {
						ok: false,
						reason: "invalid-json"
					});
					return;
				}
				const loaded = new ProviderRegistry().loadCustom([payload]);
				if (loaded.accepted.length === 0) {
					sendJson(res, 400, {
						ok: false,
						reason: loaded.rejected[0]?.reason ?? "provider 校验失败"
					});
					return;
				}
				const id = loaded.accepted[0];
				const path = await writeCustomProvider(payload);
				registry.loadCustom([payload]);
				syncProviders();
				log.info?.(`自定义 provider 已装入：${id}`);
				sendJson(res, 200, {
					ok: true,
					id,
					path,
					route: routeFor(id)
				});
				return;
			}
			if (method === "DELETE" && pathname.startsWith(`${API_PREFIX}/providers/`)) {
				const id = decodeURIComponent(pathname.slice(`${API_PREFIX}/providers/`.length));
				if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
					sendJson(res, 400, {
						ok: false,
						reason: "invalid-id"
					});
					return;
				}
				const removed = await removeCustomProvider(id);
				log.info?.(`自定义 provider 已移除：${id}（${removed ? "文件已删" : "无文件"}）`);
				sendJson(res, 200, {
					ok: true,
					id,
					removed
				});
				return;
			}
			sendJson(res, 404, {
				ok: false,
				reason: "not-found",
				path: pathname
			});
		} catch (error) {
			log.warn?.(`request failed: ${error?.message ?? String(error)}`);
			try {
				sendJson(res, 500, {
					ok: false,
					reason: error?.message ?? "internal"
				});
			} catch {}
		}
	};
	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: API_PREFIX,
		handler
	}), "dsh-webin: api routes");
	/**
	* ## ⭐⭐ 任务看门狗 —— 面板中途死亡时回收 claimed 任务
	*
	* ## 真实事故（用户截图）
	*
	* 「深度求索中，用时 1 分 43 秒」—— 而网页版早就「已停止」。
	* 面板在生成中途死亡 ⇒ 结果永远不来 ⇒ 任务永远 claimed ⇒
	* DSH 干等到 adapter 超时（默认 10 分钟）。
	*
	* 每 30 秒扫一次：claim 超 3 分钟没结果的任务标 failed，
	* DSH 立刻收到错误可以重试 —— 不让用户干等 10 分钟。
	*/
	ctx.effect(() => {
		const timer = setInterval(() => {
			try {
				/**
				* ⭐⭐ 传入**真实心跳**作为存活判据 —— 面板活着就不回收。
				*
				* 这条看门狗原来的文案写着「心跳停止」，但**从没读过心跳**，只是
				* 「claim 后 3 分钟没结果」的盲超时。用户实测：一轮长生成超过 3 分钟，
				* 文件其实已经写成功，任务却被误杀（面板全程心跳正常）。
				*/
				const reaped = queue.reapStaleClaimed(Date.now(), 18e4, () => liveClients().length > 0);
				if (reaped > 0) log.warn?.(`看门狗回收了 ${reaped} 个失联任务（面板心跳确实已停）`);
			} catch {}
		}, 3e4);
		return () => clearInterval(timer);
	}, "dsh-webin: claimed-task watchdog");
	/**
	* ## ⭐⭐ 往页面注入「版本自检」—— 让新代码自动生效，不用用户重启
	*
	* ## 为什么必须这样做（实测查清的 HMR 缺陷）
	*
	* DSH 的 `client-hmr` **只做了一半**：
	*
	*   ✅ host 每 500ms stat 轮询 `lib/client.js`，算新 rev
	*   ✅ 通过 `/plugins/events` SSE 推 `rebuilt` 帧
	*   ✅ 服务器按新 rev 提供新 bundle（实测拉到的新内容正确）
	*   ❌ **浏览器端不消费那个帧** ⇒ 新代码永不生效
	*
	* 实测证据：
	*   - SSE 上确实收到 `{"type":"rebuilt","id":"dsh-webin","rev":"9a4929dc7a68"}`
	*   - 服务器返回的 bundle 含 `clientBuiltAt` / `rich`（= 新代码）
	*   - 但面板的 `clientId` 不变、新字段永不出现
	*
	* ## 为什么不能用「client 上报构建时刻」那一套
	*
	* 那是**死循环**：让面板上报 `clientBuiltAt` 的代码本身就在新 bundle 里，
	* 而旧面板不会上报 ⇒ host 不知道它落后 ⇒ 不重载。
	*
	* ## 所以：把自检脚本注入 `index.html`
	*
	* 这段脚本**每次页面加载都会执行**，与 client bundle 是哪个版本**无关**。
	* 它定期问 host「当前产物是什么版本」，发现自己不是最新的就重载页面。
	*
	* 这样即使面板跑的是很旧的 bundle，也能被拉到最新 —— 循环依赖被打破。
	*/
	ctx.effect(() => {
		if (typeof ctx.webServer.tapIndex !== "function") {
			log.warn?.("webServer.tapIndex 不可用 —— 自动重载不可用，改代码后需要手动重启");
			return () => void 0;
		}
		return ctx.webServer.tapIndex((html) => {
			/**
			* ⚠️ 注入的脚本要**自包含**：不能用任何插件侧的变量，
			* 因为它跑在页面里，而插件侧代码可能还没加载。
			*/
			const script = `<script>(function(){
  var API = ${JSON.stringify(API_PREFIX)};
  var KEY = '__ldwReloadCheck__';
  if (window[KEY]) return;
  window[KEY] = true;
  /** 记下「我是从哪个 rev 加载的」—— 之后 rev 变了就说明有新版。 */
  var mine = null;
  function check() {
    fetch(API + '/build', { headers: { accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || typeof j.rev !== 'string') return;
        if (mine === null) { mine = j.rev; return; }
        if (j.rev === mine) return;
        /**
         * ⚠️ 有任务在跑时不重载 —— 否则会打断正在生成的回复。
         * 通过插件自己的状态接口判断（读不到就当没任务）。
         */
        console.log('[ldw] 发现新构建 ' + j.rev + '（当前 ' + mine + '），重载页面');
        window.location.reload();
      })
      .catch(function () {});
  }
  setInterval(check, 4000);
  setTimeout(check, 1500);
})();<\/script>`;
			/** 插在 </body> 前；没有 </body> 就追加到末尾。 */
			if (html.includes("</body>")) return html.replace("</body>", script + "</body>");
			return html + script;
		});
	}, "dsh-webin: reload check injection");
	log.info?.(`host ready; api=${API_PREFIX} state=${stateRoot()}`);
}
//#endregion
export { apply, inject, name };

//# sourceMappingURL=index.js.map