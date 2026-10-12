# dsh-webin

Unofficial DSH plugin — 用**真实浏览器**驱动多个 AI 网页版（DeepSeek / 通义千问 / …）。

结构上模仿 [cuckoo-code](https://github.com/wangyongpeng90/cuckoo-code)：
**不设计协议，操作界面**。打开真浏览器 → 用真实输入把字打进输入框 → 页面自己发请求 →
插件只在旁边看着页面自己的 SSE 把回复读出来 → 工具结果当普通消息打回聊天框。

**没有任何一行在「调 API」** —— 没有 `create_pow_challenge`、没有 `x-ds-pow-response`、
没有 `x-hif-*` 回放。这是不封号的原因。

---

## 多平台架构

### 一个平台 = 一个 Provider 对象

平台差异（选择器、评分规则、SSE 路径、模型表、上下文窗口）**全部收敛到
一个 `Provider`**（[src/shared/providers.ts](dsh-webin/src/shared/providers.ts)），
驱动层只认接口。新增站点 = 加一个对���。

```ts
const MY_PLATFORM: Provider = {
  id: 'my-platform',            // ← 同时是 workspace 名，决定登录态隔离
  name: 'LDW · 我的平台',
  homeUrl: 'https://example.com/',
  urlPattern: 'example\\.com',
  input: { selectors: ['textarea[placeholder*="输入"]', 'textarea'] },
  send: {
    selectors: ['button[type="submit"]', '[role="button"][aria-label*="发送"]'],
    signatures: [['send-button', 60]],   // 站点特征加分
    vetoes: ['toggle', '停止'],           // 命中即否决
  },
  completionPath: '/api/v1/chat/completions',
  models: [{ id: 'fast', name: '快速' }],
  contextWindow: 131_072,
  maxOutputTokens: 8_192,
}
```

### 登录态隔离靠 workspace，不改 DSH 一行

`DesktopBrowserGuests.acquire(owner, workspace)` 按 **workspace 字符串**缓存 partition
（`main.js:9636-9641`）：

```js
let partition = this.partitions.get(workspace);
if (partition === void 0) {
  partition = `dsh-sidebar-browser-${randomUUID()}`;
  this.partitions.set(workspace, partition);
}
```

所以**用 `provider.id` 当 workspace 名**，各平台自然拿到不同 partition、
不同 cookie / localStorage ⇒ **登录态天然隔离**，零侵入。

### 三个层次的可扩展性

| 层次 | 做法 | 适用 |
|---|---|---|
| **内置表** | 在 `BUILTIN_PROVIDERS` 加一项 | 贡献新平台 |
| **API 装载** | `POST /dsh-webin/api/providers` 贴一个 Provider JSON | 站点改版后修选择器，**不改代码** |
| **磁盘持久化** | `~/.dsh/webin/providers/<id>.json` | 跨重启存活，与登录态同一套存储 |

自定义 provider **覆盖同 id 的内置项**（改坏了删掉即可回退），
且加载时逐个校验（`validateProvider()`）—— 一条坏的不影响其它。

### 运行时校验

TS 类型运行时被擦除，"必须实现接口"靠 `validateProvider()` 真正强制
（cuckoo 的 `validate.ts` 做同样的事）。校验覆盖：id 格式（会用作 workspace 名）、
URL 合法性、正则可编译、models 非空、contextWindow 为正数…

### 加一个平台（三步）

**1. 先探测真实 DOM** —— 不要猜选择器：

```bash
npm run probe:dom    # dump 输入框/按钮结构 + 用当前选择器匹配
```

**2. 照着 `provider.example.json` 填一份 JSON**，然后：

```powershell
$h = @{ Authorization = "Bearer <secret>" }   # 见 ~/.dsh/.credentials.yaml
$body = Get-Content provider.example.json -Raw
Invoke-WebRequest "http://127.0.0.1:19387/dsh-webin/api/providers" -Method Post `
  -Headers $h -ContentType "application/json" -Body $body
```

装好后**立刻生效**（host 会热重载路由），新平台出现在模型选择器里，
文件落在 `~/.dsh/webin/providers/<id>.json`，跨重启存活。

**3. 在 LDW 面板顶部的下拉里选中它**，登录一次即可（登录态独立保存）。

移除：

```powershell
Invoke-WebRequest "http://127.0.0.1:19387/dsh-webin/api/providers/my-platform" `
  -Method Delete -Headers $h
```

查看装载情况（含校验失败原因）：

```powershell
Invoke-WebRequest "http://127.0.0.1:19387/dsh-webin/api/providers" -Headers $h
```

> ⚠️ **内置的 qwen 选择器尚未实测**，第一次用前请跑 `npm run probe:dom` 校准。
> 未校准的 provider 不会静默失败：发送脚本找不到目标时会带诊断清单报错。

---

## 「只回一个字」的根因：裸文本帧没被处理

### 现象

网页版里回复是完整长文，DSH 对话里只有开头一个字。用户实测报障两次。

### 定位过程（`npm run probe:frames`）

先发现页面用 **XHR 而非 fetch** 发 completion（`POST [XHR] /api/v0/chat/completion`），
于是把探测脚本改成拦 XHR 逐帧记录，拿到真实帧序列：

```
[0] {"request_message_id":1,...}                                      ← 元信息
[2] {"v":{"response":{...fragments:[{content:"1"}]}}}                  ← 初始快照
[3] {"p":"response/fragments/-1/content","o":"APPEND","v":"."}         ← 带路径增量
[4] {"v":" HTTP"}        ← ⚠️ 裸文本帧：没有 p、没有 o
[5] {"v":"（"}            ← ⚠️ 正文主体全是这种，占 95% 以上
...
[131]{"p":"response/status","o":"SET","v":"FINISHED"}
```

**正文的绝大部分是裸字符串帧**（`v` 直接是要追加的文本，无路径）。
提取器只认「带 `p` 且路径匹配」的帧 ⇒ 每个回复只拿到快照里的第一个字。

早期测试没暴露是因为 `8+8=?` 的答案 `16` 恰好完整落在快照帧里。

### 修法

`isBareTextDelta()`：无 `p`、`o` 缺省或 APPEND、`v` 为非空字符串 ⇒ `text += v`。
显式排除元信息帧（有 `request_message_id`/`updated_at` 的走不进这个分支）
和错误信封（有 `code`/`data`）。`o: 'SET'` 的裸值帧不按增量处理。

回归：`npm run verify:extract`（13 项）把实测帧序列灌进产物里的真实提取器。

---

## 会话路由：每个 DSH 会话绑定自己的网页对话

### 缺陷（用户实测发现，封号级）

换了几个 DSH 窗口聊天，网页版里全落在**同一个**会话窗口 ——
上下文互相串、多个话题混在一条流里，行为模式像机器人，**不被封才怪**。

### 语义

| 场景 | 行为 |
|---|---|
| DSH 会话首条 | 在当前页发，落地 URL 由结果带回 host 存进游标 |
| 同一会话后续任务 | job 带 `expectUrl`（= 上次落地页），URL 相同则**不导航**（零开销） |
| 切换 DSH 会话 | job 带各自的 `expectUrl`，client **先导航过去再发** |
| 老 client / 抓 URL 失败 | 不绑定，行为不退化（当前页照发） |

### 数据流

```
adapter.stream(sessionId)
  └─ cursors[sessionId].chatUrl → job.expectUrl
       ↓ client
     页面 URL ≠ expectUrl → loadURL(expectUrl) → 等输入框 → 发送
       ↓ 结果
     done → PUT result { text, chatUrl: location.href }
       ↓ host
     cursors[sessionId].chatUrl = result.chatUrl
```

⚠️ 存 `chatUrl` **必须在 `diff.commit()` 之后** —— commit 会整体重写游标，
放前面会被它用旧值覆盖（`verify-session-route` 的 ⭐ 断言就是抓这个的）。

### 实测

`npm run verify:session-e2e`：两次发送分别落在两个不同的对话 URL
��`…/s/8530a042…` 和 `…/s/92020348…`）。

`npm run verify:session-route`（14 项）：两会话互不串、切回仍回原对话、
无 chatUrl 时不退化。

---

## 每次重启新建对话 → 网页版侧栏堆一排会话

### 现象

用户侧栏出现「从1数到800」×3、「8加8等于16」×2 —— 每次重启/重挂载都新建对话。

（其中一部分是探测脚本直接用真实账号发的 —— 已知污染，抱歉。）

### 根因

boot 阶段无条件 `loadURL(homeUrl)`。首页被页面当成「开新对话」。
更严重的连带后果：host 的差分游标记着「这会话发过 N 条」，
而页面里是**空的新对话** ⇒ 下一轮只发增量，模型完全没有上下文。

### 修法

快照里存了 `url`（上次离开时所在页面）。boot 时优先导航到它，
并做平台域校验（`urlPattern` 匹配 hostname+pathname 才用，防串平台）。
非法/无快照时才退回 `homeUrl`。

---

## 差分发送：为什么网页端聊天记录不该出现超长提示词

### 问题

第一版实现里，**每发一条消息，网页端聊天记录里都堆着一条超长提示词**。

根因是位置搞错了：DSH 是标准 LLM 宿主，**每一轮都把完整历史**
（`system` + 全部 `messages`）交给 adapter，由 adapter 自己决定怎么变成
provider 的请求体。对 HTTP provider 这没问题 —— 每次请求本来就该带全量上下文。

但**网页版不是无状态 API**：页面自己维护着对话历史。把整段历史每轮都打进
输入框有两个后果：

1. 网页端聊天记录里堆满**重复的超长提示词**（用户一眼就能看到）；
2. **上下文被重复计数** —— 模型看到的是「历史 + 又一份历史」，
   有效上下文被砍半，还容易被判成刷屏。

### cuckoo 为什么没这问题

因为 **cuckoo 不是 LLM adapter，而是 harness**：

| | cuckoo | 本插件（第一版） |
|---|---|---|
| 架构位置 | Electron 外壳，自己驱动 AI 页面 | DSH 的 `llm` adapter |
| 系统提示词 | `initProject()` 时**只发一次** | 每轮都随历史重发 |
| 每轮发送 | `sendToChat()` 只发**新消息** | flatten 全量历史 |
| 页面角色 | 就是记忆体 | 被当成无状态 API |

`prompt-builder.ts` 的日志写得很清楚 —— 模板在**项目初始化**时组装并发送一次：

```
[Cuckoo Code] 准备发送初始提示（不含目录树），长度: <N>
```

之后每轮走 `chat-input.ts` 的 `sendToChat(msg)`，只发那一条。

### 本插件的做法

本插件处在 adapter 位置（DSH 要求这样），所以**自己补上这层差分** ——
`src/host/adapter.ts` 的 `diffPrompt()`：

| 规则 | 原因 |
|---|---|
| 首轮发 `system` + 全部消息 | 页面需要一次拿到完整设定 |
| 后续轮**只发新增消息** | 页面已有历史，不重复 |
| **跳过页面自己产生的 assistant 回复** | 那是页面吐出来的，重发会让记录里出现重复内容 |
| 历史变短（压缩/回退）→ 从头发 | 否则页面缺上下文 |
| `system` 指纹变了（换 agent/preset）→ 重发 | 新设定必须传达 |
| 增量为空 → 直接返回 `stop`，不发 | 纯重复没有发送意义 |
| 用 `sessionId` 做键 | 多会话并行不互相污染 |

实测各轮长度（`verify-diff.mjs` 第 3 组断言）：

```
首轮 227 字符（含系统提示词）
后续 33, 33, 33, 33 字符（只有增量）
```

回归保护：`npm run verify:diff`（30 项）锁死上述全部规则，
包括「第二轮不含旧回复」「连续多轮每轮都跳过自己的回复」这类容易写错的地方。

### 投递失败**不得**推进游标

`diffPrompt()` 是**纯函数**，游标推进靠返回的 `commit()`，调用方**只在投递成功后**调。

早期版本在算增量的同时就推进游标，于是发送失败/超时后：DSH 认为「这段内容发过了」，
下一轮只发之后的增量 —— 而页面里其实**没有**这段内容 ⇒ **中间那段上下文永久丢失**，
模型从此缺一段记忆。

不推进 ⇒ 下次调用重新算出同样的增量，内容不丢。

---

## 任务生命周期：三个会真实撞上的坑

### 1. 插队（最严重）

发送成功后 `pendingJobRef` 仍置着，而轮询每 1.5s 跑一次。
早期版本没有闸门 ⇒ **页面还在生成时又领了下一个任务**，把新 prompt
打进输入框发送。后果：生成被打断、两个回复混在一起、`done` 分不清归属。

**修法**：`pendingJobRef` 有值 ⇒ 本轮只问 host「是否被取消」，不领新活。

### 2. 取消后任务挂着

用户按停止 → host 侧 `signal.aborted` 抛错退出，但任务**仍留在队列里**
处于 `claimed` 状态：

- `hasClaimed()` 永远 true ⇒ `/status` 误报「面板在干活」
- 页面继续生成到结束 ⇒ **白烧配额**
- 之后回来的 `done` 还可能算成下一个任务的回复 ⇒ **串台**

**修法**：`queue.cancel()` 标记任务；client 每轮轮询带 `?running=<jobId>`，
host 回 `cancel` 就去点页面的停止按钮。

### 3. 待办永久卡死

`pendingJobRef` 靠 `done` 事件清空。若事件丢失（页面导航 / hook 被清 /
回复永不来），它会一直挂着 ⇒ 发送循环**永久罢工**，用户看到「模型一直不回复」。

**修法**：5 分钟超时兜底，交回错误并解锁循环（比 adapter 的 10 分钟更早）。

### 停止键定位：靠实测，不靠猜

真浏览器 dump（`npm run probe:stop`）出来的关键事实：

```
生成中，输入框区域同时存在：
  发送键：ds-button--primary  ds-button--filled  ds-button--circle
  停止键：ds-button--outlinedNeutral  ds-button--outlined  ds-button--circle  ← 生成中才出现
```

| 特征 | 归属 | 用法 |
|---|---|---|
| `--circle` | **两者共有** | 只给 +10 分（不能靠它区分） |
| `--filled` / `--primary` | 发送键独有 | **命中即排除** |
| `--outlined` | 停止键独有 | +60 分（阈值 60） |

而且**生成中发送键不会消失**（早期假设它消失，是错的）。

分数并列时**不敢猜** —— 宁可不停止（只浪费一次配额），
也绝不能误点「深度思考」开关（那会改变后续所有请求的行为）。

实测结果：空闲时返回 `no-stop-control`（不误点），生成中命中
`--outlinedneutral`，score **90**，候选唯一。

---

## 启动阶段机

早期用 `documentCount === 1 / 2 / >= 3` 计数决定做哪一步，有两个真实缺陷：

1. **某步没发生就永久卡住**：没有快照时 `=== 2` 分支直接 return 不 reload，
   计数停在 2 ⇒ hook 永不注入、`ready` 永不置位、**插件永久失效**。
2. **后续导航打乱计数**（用户点链接 / 页面跳登录页）。

改成显式阶段机：

```
boot → navigating → restoring → reloading → live
```

每个阶段只做一次，不依赖「第几次 dom-ready」。另外：

- **每次 `dom-ready` 都重注入 hook**（hook 是页面级的，导航后就没了；
  `buildDeepSeekHook()` 自带幂等标记，重复注入无害）
- **加载失败回退到 `boot`**（否则断网后永远不再前进）
- **渲染进程崩溃回退到 `boot`**（OOM 后 webview 重载，阶段机要能重来）

---

## 当前进度

| 阶段 | 内容 | 状态 |
|---|---|---|
| **P0** | 红框位置注册「LDW」标签 | ✅ 已完成 |
| **P1** | LDW 面板内挂真实 Chromium guest + 加载 DeepSeek 网页版 + UA 洗白 + 登录态探测 | ✅ 已完成（实测可登录，无「环境异常」） |
| **P2** | 注入 hook，只读观察页面自己的 SSE | ✅ 已完成 |
| **P3** | 注册 `deepseek-webin` provider，网页回复 → StreamChunk → 进「对话」 | ✅ 已完成 |
| **P4** | 自动填输入框 + 触发发送 + 工具结果回传 | ✅ 已完成（���策略发送 + 多信号校验） |
| **P5** | 移植 web-login 的账号库 / 设置页 / 统计 | ⬜ 待做 |
| **P6** | 登录态持久化（重启免登录） | ✅ 已完成（快照 + 目标域回写，见下节） |

---

## 为什么重启 DSH 后不用重新登录

### 约束：分区一定是内存分区

DSH 的 guest partition 由 `DesktopBrowserGuests.acquire()` 生成（`main.js:9638`）：

```js
partition = `dsh-sidebar-browser-${randomUUID()}`;   // ← 无 persist: 前缀
```

而 webview 门禁又强制 `params.partition === lease.partition`（`main.js:9685`）：

```js
if (lease === void 0 || lease.owner !== owner || lease.attached || params.partition !== lease.partition) {
  event.preventDefault();
  return;
}
```

**所以插件不能自己换成 `persist:` 分区**（会被门禁拒绝），
重启后 storage 必然是空的。唯一出路是「快照 + 在正确源上回写」。

### 坑：restore 必须在目标域上执行

早期实现在**第一次 `dom-ready`（页面还是 `about:blank`）**上跑 restore，
结果是**每次重启都要重新登录**。实测（`npm run probe:origin`）：

```
[A] about:blank 上写 localStorage
    → SecurityError: Access is denied for this document.
[B] 目标域上写 → 跨 reload 保留 ✓
```

两层原因：

1. `about:blank` 是 **opaque origin**，`localStorage` 直接抛 `SecurityError`；
2. `localStorage` **按源隔离** —— 在 A 源写的值 B 源读不到��

### 正确时序

```
1. loadURL(homeUrl)          → 到目标域
2. dom-ready #2：restore      → 此时 localStorage 可写、且源正确
3. reload()                   → 带着登录态重新初始化
4. dom-ready #3+：注入 hook/探针
```

`restore` 脚本现在会**回读校验**并如实报告，不再静默吞异常：

```json
{"ok":true,"restored":13,"verified":13,"failed":0,"cookies":2,
 "origin":"https://chat.deepseek.com"}
```

在错的源上会明确拒绝：

```json
{"ok":false,"reason":"wrong-origin","origin":"null",
 "hint":"restore 必须在目标域上执行（about:blank 是 opaque origin，storage 不可写）"}
```

回归保护：`npm run verify:restore`（27 项）锁死时序与源校验，
`npm run probe:origin` 在真浏览器上验证源隔离假设。

### 仍然存在的限制

- **httpOnly cookie 无法用 JS 回写**（浏览器安全模型）。本站登录态主要靠
  `localStorage.userToken`，所以不受影响。
- **清空 `~/.dsh/webin/` 后需要重新登录**（快照没了）。
- 登录态快照按**平台**分槽（`auth/deepseek.json`、`auth/qwen.json`），互不覆盖。

---

## 本轮修复（压缩死锁）

### 症状

会话发任何消息都卡住，`compaction/start` 后长时间无响应，最久一次卡 **6 分 12 秒**才被中止：

```
[11:12:00] turn/start 21 → compaction/start → (96s) → aborted
[11:14:10] turn/start 22 → compaction/start → (4s)  → aborted
[11:14:36] turn/start 23 → compaction/start → (372s)→ aborted
```

### 根因（两个 bug 叠加）

**1. `contextWindow` 写错，阈值低到每步都触发压缩**（`src/host/adapter.ts`）

```ts
context: { contextWindow: 128_000 }   // ❌ 网页版真实是 1 Mi
```

compaction-basic 的判定是：

```
thresholdTokens = min(contextWindow × 0.8, contextWindow − maxTokens − headroomTokens)
```

| | contextWindow | maxTokens | headroom | 阈值 | 该会话实测 359,267 tokens |
|---|---|---|---|---|---|
| 修复前 | 128,000 | 8,192 | 65,536 | **54,272** | 超阈值 **6.6 倍** → 每步都压缩 |
| 修复后 | 1,048,576 | 32,768 | 65,536 | **838,860** | 远低于阈值 → 不触发 |

**2. 压缩的摘要调用被路由回 LDW 自己**

`compaction-basic` 的 `summarizeWithLlm()` 用 `routedTarget(session)` 选模型 —— 也就是**最近一次实际路由的 provider**。上一轮把会话切到 `deepseek-webin/ldw-think` 后，压缩就变成「必须经浏览器发消息」。而发送恰好是坏的 ⇒ 摘要任务进了队列没人能完成 ⇒ 干等满 `timeoutMs`（10 分钟）。

**修法**：`waitForJob()` 增加**无人领活快速失败**——超过宽限期（20s）仍没有 client `GET /job/next`，立即判 `WEBIN_FAILED` 并说明原因，不再干等。

### 3. 发送路径失效（`send-failed: 未找到发送按钮，合成 Enter 也无效`）

旧 `chat.ts` 的三个缺陷：

- 发送按钮只找 `<button>` —— DeepSeek 新版用 `div[role="button"]`，永远命中不到
- 兜底扫描只看 4 层祖先里的 `<button>` —— 同样漏掉 `div[role=button]`
- 合成 Enter 只发 `KeyboardEvent`，没有二次尝试

**用真 Chrome 加载真实页面 dump DOM 后**（`npm run probe:send`），拿到的事实：

| 元素 | 真实结构 | 后果 |
|---|---|---|
| 输入框 | `textarea[placeholder="给 DeepSeek 发送消息 "]` | 旧选择器能命中 |
| **发送键** | `div[role=button].ds-button--primary.ds-button--filled.ds-button--circle` | **不是 `<button>`、无 aria-label、无文字**（纯图标）→ 旧代码必然找不到 |
| 附件键 | `div.ds-button--iconLabelPrimary.ds-button--icon.ds-button--capsule` | 与发送键**同尺寸相邻**，点错会弹文件选择框 |
| 开关 | `div.ds-toggle-button`（深度思考 / 智能搜索） | 点了会改发送语义 |

只用「几何位置 + 邻近度」评分时，**发送键 32 分 vs 附件键 31 分 —— 只差 1 分**。
加入站点特征评分后：

| 候选 | 修复前 | 修复后 |
|---|---|---|
| #1 发送键 | 32 | **214** |
| #2 | 31（附件键） | 39 |
| **分差** | **1** | **175** |

### 4. 发送确认判据不可靠

`hasStopControl()` 靠文本找「停止生成」—— **DeepSeek 上是纯图标，测不到**。
而 `grew`（页面正文变长）在 dry-run 里**误报为 true**（页面动画/懒加载也在改文本）。

改成四级判据，并**明确排除 `grew` 单独成立**：

| 判据 | 可靠性 |
|---|---|
| `requestSent`（hook 计数到 completion 请求） | **唯一铁证** |
| `stopControl`（出现停止控件） | 可靠，但本站测不到 |
| `cleared`（输入框被清空） | 单独不可���（dry-run 证明没发送时也可能为空） |
| `grew`（正文变长） | **最弱，不可单独判定** |

### 5. 其他

| 问题 | 修法 |
|---|---|
| 路由 / adapter 未释放 → 重载撞 `duplicate prefix route` | 改用 `ctx.effect()` 交回 disposer |
| `done` 事件可能串台（把用户自己聊的回复当成任务结果） | 用事件时间戳过滤，只认发送确认之后的事件 |
| 发送循环被 `loggedIn` 门控，误判即全链路失效 | 去掉门控，改由发送脚本在页面上自行判断 |
| 登录误报（登录页也显示「已登录」） | 探针改用 `__appKit_userInfo.id` 做强证据 + 负面证据交叉判定 |
| `__appKit_userInfo.id` 解不出（明明登录却报 `hasUserId:false`） | 真实形状是 `{"value":{"id":...}}`，id **嵌在 value 里**；两种形状都认 |
| **空快照覆盖有效快照**（重启后仍要重新登录） | 未登录时 `userToken={"value":null}` —— 早期只查**键是否存在**，于是登录页的空快照盖掉了有效快照。改为 `snapshotLooksLoggedIn()` **解出值**再判断 |
| 快照存了 cookie 但回写时被丢弃 | `buildRestoreScript` 补上 cookie 逐条回写（跳过属性残留片段） |
| `ctx.logger` 畸形会让整个 `apply()` 抛错 → 插件装不上 | `safeLogger()` 显式判类型，10 种畸形形态全部安全降级 |
| 排查困难 | host 加 `POST /client/heartbeat`，`/status` 反映面板在线数 |

### 6. 压缩摘要不依赖浏览器面板

即使 `contextWindow` 修正后不再频繁触发压缩，**摘要本身也不该走浏览器**：
摘要输入动辄几十万 token，塞进网页输入框会让页面卡死，网页版本身也有长度上限。

adapter 现在对 `purpose === 'compaction'` 的调用**立即拒绝**（实测 0ms 返回，不进队列），
并给出可操作指引：

```
压缩摘要不能走 LDW 网页版：摘要输入体量远超网页输入框上限，且会把整轮对话锁在浏览器上。
请把 compaction-basic 的 summarizationProvider / summarizationModel
配成普通 HTTP provider（例如 wb-out / deepseek-v4.1-flash）。
```

根治方式是在 preset 的 `compaction` 组里显式钉死摘要模型：

```yaml
- id: compaction-basic
  name: '@deepseek-ai/dsh-compaction-basic'
  config:
    summarizationProvider: wb-out          # ← 空对时会回退到"最新已路由目标"（= LDW），
    summarizationModel: deepseek-v4.1-flash #   那就是死锁根源
```

`dsh-compaction-basic/README.zh.md:70-71` 原文：
> 与 `summarizationModel` 一起设置；**空对使用最新已路由请求目标**，再回退到 `AgentOptions` 对。

### 验证

```bash
npm run check        # 构建 + 全部离线校验（272 项）
npm run verify:e2e   # ⭐ 端到端：真浏览器 + 真登录态 + 真发送 + 真回复
npm run probe:chain  # 全链路真实验证（会消耗一次网页版额度）
```

`npm run check` 覆盖：contextWindow = 1 Mi、压缩阈值复算、无人领活快速失败、
**压缩摘要立即拒绝**、心跳路由、任务队列领活/交结果全链路、
**卸载后重装不撞重复路由**、**10 种畸形 logger 下仍能加载**、
**差分发送的全部规则**（30 项，含「第二轮不含旧回复」）、
**多平台路由与模型不撞名**、以及两个挂载点声明完整。

**`npm run verify:e2e` 是真浏览器端到端验证** —— 起一个真 Chromium、
注入真登录态（含 cookie）、注入真 hook、用真发送脚本发一条消息、
轮询真 drain 脚本抓回复，最后断言 5 项全绿：

```
[1b] 登录态回写: {"restored":13,"cookies":2}
[4] 发送: stage=sent | signals: {"requestSent":true,...}
[5] stream×4 → DONE status=finished len=2
    网页版回复: 12
  ✓ hook 注入成功  ✓ 发送被确认  ✓ 收到 stream 增量
  ✓ 收到 done 事件  ✓ done 带正文        5/5 通过
```

| prompt | 回复 | 结果 |
|---|---|---|
| `1+1=? 只回答数字` | `2` | 6/6 |
| `2+2=? 只回答数字` | `4` | 6/6 |
| `3+3=? 只回答数字` | `6` | 6/6 |

单次输出形如：

```
[2] hook 注入: installed
[3] 探针: {"loggedIn":true,"hasUserId":true}
[4] stage: sent | signals: {"requestSent":true,...}
[5] ✓ hook 捕获到 completion 请求（计数 1）
[6] stream 事件数: 4
  抓到的回复: 6
  ✓ hook 注入成功  ✓ 发送被确认  ✓ 捕获 completion 请求
  ✓ 收到 stream 增量  ✓ 收到 done 事件  ✓ done 带正文
  6/6 通过
```

另外几个探测脚本（只读或可指定 prompt）：

| 命令 | 作用 |
|---|---|
| `npm run probe:dom` | dump 真实页面结构 + 用插件选择器匹配，验证选择器是否失效。加 `--url <地址>` 可校准任意平台 |
| `npm run probe:send` | dry-run 跑真实 `buildSendScript()`（拦截点击），验证候选评分 |
| `npm run probe:login` | 分阶段验证登录判据（裸访问 / 注入后 / 延时探测），排查 `loggedIn` 误报 |
| `npm run probe:done` | 逐秒 dump 事件队列，排查 `done` 事件为何不来 |

⚠️ 这三个脚本都要求本机有 Chrome/Edge，并会读取 `~/.dsh/webin/auth/default.json`
的登录态��**页面改版后先跑 `probe:dom`**，比看 minified bundle 猜可靠得多。

---

## 架构

```
┌─ DSH Electron 主进程（app.asar/lib/main.js:9617-9803）──────────────┐
│  DesktopBrowserGuests（宿主自带，未修改）                            │
│    ipcMain.handle('dsh-desktop:browser-acquire') → { lease, partition }│
│    ipcMain.handle('dsh-desktop:browser-release')                     │
│    will-attach-webview：校验 about:blank#<lease> + partition          │
└──────────────────────────────────────────────────────────────────────┘
        ▲ window.dshDesktop.browser（宿主 preload 已暴露给主窗口主 frame）
        │
┌─ dsh-webin client 半（本插件）──────────────────────────────────────┐
│                                                                      │
│  ① 常驻宿主  shell.overlay  id='ldw-host'   ← root scope，永不卸载    │
│     └─ acquire(workspace) → <webview src="about:blank#<lease>">      │
│          → 真 Chromium guest → loadURL(chat.deepseek.com)            │
│                                                                      │
│  ② 占位符    conversation.view  id='ldw' order=20  ← 用户要的红框位置 │
│     └─ 只量自己的 rect 并广播（不含 webview）                         │
│                                                                      │
│  ① position:fixed 贴到 ② 的 rect 上；② 卸载时 rect=null → ① 移出视口  │
└──────────────────────────────────────────────────────────────────────┘
```

### 为什么拆成「常驻宿主 + 占位符」两半

**因为 `conversation.view` 切标签会卸载组件。** 四环证据：

| # | 证据 | 位置 |
|---|---|---|
| A | `conversation.view` 声明为 `kind: 'list'` | `ui-conversation/lib/client.js:18209` |
| B | 渲染点传 `{ only: viewId }` | `ui-conversation/lib/client.js:16412-16421` |
| C | renderer 对 `only` 是 **filter + 单元素 map**，不是 CSS 隐藏 | `ui-renderer/lib/client.js:1193-1196` |
| D | 全部 client bundle 里 `keepAlive` / `Offscreen` **零命中** | — |

React 语义下，兄弟元素 key 从 `e<chat>` 变成 `e<ldw>` ⇒ 旧子树整体卸载。
若把 `<webview>` 直接放里面，用户一切到「对话」看回答，guest 就被销毁、
lease 被释放、轮询全停 —— **生成中的回答直接中断**。这正是「把 LDW 当模型用」的核心场景。

`shell.overlay` 则是 `kind: 'list'` + `scope: 'root'`，渲染点
`renderSlot('shell.overlay', {})` **不传 `only`** ⇒ 全部注册项常驻
（`ui-layout/lib/client.js:312,617`）。官方 `ui-chat` 的额度浮层就是这么挂的
（`ui-chat/lib/client.js:12473`）。

⚠️ **宿主容器绝不重新挂载**：Electron 的 `<webview>` 一旦从 DOM 移除再插回，
guest 会重新加载。所以宿主**只改坐标**（`left/top/width/height` + `visibility`），
DOM 节点自始至终不动。切走时也不用 `display:none`（会让 webview 停止布局），
而是移出视口 + `visibility:hidden`。

运行时可用 `cordis_inspect_query`（client / Slots / listSubTree）确认两个挂载点：

```
shell.overlay     → occupants 含 { id: "ldw-host", order: 20, active: true }
conversation.view → occupants 含 { id: "ldw", order: 20, active: true }
```

### 为什么必须走 webview，不能自己开窗

插件跑在 `dsh-desktop-host` 子进程里，`require('electron')` **直接失败**
（已实测：`Cannot find module 'electron'`，`process.type === undefined`）。
所以拿不到 `BrowserWindow` / `WebContentsView`。

DSH 自带的 webview guest 通道是**唯一可用且零新增内核**的真浏览器路径。

### guest 的三条硬约束（来自 `main.js:9682-9707`）

```js
const id = params.src.startsWith("about:blank#") ? params.src.slice(12) : "";
const lease = this.leases.get(id);
if (lease === undefined || lease.owner !== owner || lease.attached
    || params.partition !== lease.partition) { event.preventDefault(); return; }
```

1. `src` 必须**精确**等于 `about:blank#<lease>`
2. `partition` 必须**等于** acquire 返回的 partition
3. **一个 lease 只能挂载一次**（`lease.attached` 后再挂会被拒）→ 重开必须重新 acquire

---

## 开发

```bash
npm install       # 首次
npm run check     # 构建 + 全部校验（272 项）
```

拆开跑：

| 命令 | 内容 |
|---|---|
| `npm run build` | 构建 `lib/index.js` + `lib/client.js` |
| `npm run verify` | client 半静态校验（26 项） |
| `npm run verify:host` | host 半行为验证（30 项，独立进程跑真代码） |
| `npm run preflight` | profile 装配预检（21 项，重启前跑） |
| `npm run probe:dom` | 真实页面结构 dump（只读） |
| `npm run probe:send` | 发送脚本 dry-run（只读，拦截点击） |
| `npm run probe:chain` | **全链路真实验证**（⚠️ 真发送，消耗额度） |

装进 profile（Desktop）：

```jsonc
// ~/.dsh/profiles/desktop/package.json
"dependencies": { "dsh-webin": "link:F:/Code/DSH-Code/dsh-webin/dsh-webin" },
"dsh": { "profile": { "bundles": [ ..., "dsh-webin", ... ] } }
```

并建 junction：

```powershell
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-webin" `
  -Target 'F:\Code\DSH-Code\dsh-webin\dsh-webin'
```

⚠️ **profile 的 `bundles` 只在 Host 启动时读一次 —— 必须重启 DSH 才会加载本插件。**

### 改完哪一半要怎么生效

| 改了什么 | 生效方式 |
|---|---|
| `src/client/*`（面板、发送脚本、hook） | **HMR 自动**，刷新页面即可 |
| `src/host/*`（provider、路由） | **必须重启 DSH**（host 半没有 HMR） |

⚠️ 用插件管理器「禁用再启用」**不能**替代重启：旧版本（无 disposer）留下的幽灵路由
不会被回收，会撞 `webserver: duplicate prefix route "/dsh-webin/api"`。
新版本已用 `ctx.effect()` 修好，但**已经在跑的旧实例**留下的路由仍要重启才清得掉。

### 排查「模型不回复」

按顺序看这三处：

```powershell
# 1. 面板在不在线（online: 0 = 没面板在跑，任务必然无人领取）
$h=@{Authorization="Bearer <secret>"}   # secret 见 ~/.dsh/.credentials.yaml 的 client-connection/browser-session
Invoke-WebRequest "http://127.0.0.1:19387/dsh-webin/api/status" -Headers $h -UseBasicParsing

# 2. 队列里有没有积压
Invoke-WebRequest "http://127.0.0.1:19387/dsh-webin/api/job/next" -Headers $h -UseBasicParsing
```

3. 切到 LDW 标签，点面板上的**「诊断」**按钮 —— 会 dump 页面输入框与按钮结构。

### 挂载点自证

```js
// cordis_inspect_query: platform=client, provider=Slots, method=listSubTree
{ "root": "shell.overlay" }      // 应含 { id: "ldw-host", order: 20, active: true }
{ "root": "conversation.view" }  // 应含 { id: "ldw", order: 20, active: true }
```

---

## 已知限制

### L1：guest partition 不持久（需重启后重新登录）

`main.js:9638`：

```js
partition = `dsh-sidebar-browser-${randomUUID()}`;   // ⚠️ 没有 persist: 前缀
```

没有 `persist:` 前缀 ⇒ **内存分区**，连磁盘都不落。官方 README 原文：
「Cookie 与 Web storage **不跨应用重启保留**」（`ui-sidebar-browser/README.zh.md:110`）。

本插件用**纯插件方案**兜底：登录后每 30s 把 guest 的 `localStorage`（`userToken` /
`appKit*` / `hif_*`）+ 非 httpOnly cookie 存到 `~/.dsh/webin/auth/default.json`，
下次启动导航前回写。

⚠️ **httpOnly cookie 用 JS 读不到** —— 若 DeepSeek 的登录态主要靠它，这条路会不完整。
那种情况下只能改 DSH 那一行（`9638` 加 `persist:` 前缀），代价是升级会被覆盖。

### L2：LDW 必须全局单例

并发多窗口实测 6 分钟封 1 天。单轮体量同理，继续用 DSH 自己的 compaction 压上下文
（现已修正 `contextWindow`，见上）。

## 与 cuckoo / web-login 的关系

| 来源 | 拿什么 | 许可 |
|---|---|---|
| **cuckoo-code** | `providers/hooks/deepseek.ts`（632 行 SSE 拦截器）、`hooks/shared/sse.ts`、`generated/hook-sources.ts`（纯字符串产物）、`infra/user-agent.ts`、`overlay/chat-input.ts` 的填/发逻辑 | ⚠️ **GPL-3.0-only** — 直接抄代码会让本项目也变 GPL，只能参考思路重写 |
| **dsh-deepseek-web-login** | 账号库 `accounts.ts`、`auth.ts`、`paths.ts`、设置页 `client/index.ts`、`protocol.ts`、`gate.ts` | ✅ Apache-2.0，可自由复用 |

**必须丢掉**（web-login 的封号风险源）：

- `src/webapi.ts:95` 的 `x-deepseek-harness` 头 —— **最高风险单点**，每个请求都发
- `src/browser-transport.ts` 整个文件（about:blank 代理 + 页面内 PoW + `--headless=new --no-sandbox` 等自动化 flag）
- `buildDsHeaders()` 手工拼 `origin`/`referer`/`cookie` —— 在页面里会被浏览器**静默丢弃**，实际发出去的是 `Origin: null` + 无 Cookie
- `src/transport.ts` 的传输层开关（真浏览器方案里不存在这个概念）

**换真浏览器也解决不了的**：并发多窗口（实测双窗口 6 分钟封 1 天）与单轮体量。
LDW 必须**全局单例**，并继续用 DSH 自己的 compaction 压上下文。
