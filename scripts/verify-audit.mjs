#!/usr/bin/env node
/**
 * **代码审计** —— 系统性找 bug，不靠逐个猜。
 *
 * 用户说「还是有非常多的bug，务必仔细检查并修复」，所以这里把
 * 已知的 bug **类型**（不是具体实例）写成检查项，扫全量源码。
 *
 * 每一类都对应一个**真实踩过的 bug**，不是假想。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

let pass = 0
let fail = 0
const check = function (name, actual, expected) {
  if (arguments.length < 3) expected = true
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    pass += 1
    console.log(`  OK   ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL ${name}\n       期望 ${e}\n       实际 ${a}`)
  }
}

const read = (p) => readFileSync(join(ROOT, p), 'utf8')
const clientSrc = read('src/client/index.ts')
const chatSrc = read('src/client/chat.ts')
const hookSrc = read('src/client/hook.ts')
const hostSrc = read('src/host/index.ts')
const adapterSrc = read('src/host/adapter.ts')

console.log('=== 代码审计（按 bug 类型扫全量）===\n')

console.log('[A] ⭐ 所有 executeJavaScript 必须有超时护栏')
{
  /**
   * **真实 bug**：裸 `executeJavaScript` 是跨进程调用，页面一导航就
   * 静默死掉（不 resolve、不 reject）⇒ 宿主永远等。
   *
   * 用户实测症状：「一直深度求索中」「插件永久失效」。
   * 我们统一走 `execJs()`（Promise.race 加超时）。
   */
  const offenders = []
  const lines = clientSrc.split('\n')
  lines.forEach((l, i) => {
    /** 排除 execJs 自身的实现、注释、以及说明性引用。 */
    if (!/\.executeJavaScript\(/.test(l)) return
    if (/^\s*(\/\/|\*|\/\*)/.test(l)) return
    if (/el\.executeJavaScript\(code\)/.test(l)) return
    offenders.push(`${i + 1}: ${l.trim().slice(0, 70)}`)
  })
  check('⭐ 客户端没有裸 executeJavaScript', offenders, [])
  /** execJs 自己必须存在且带超时。 */
  check('有 execJs 包装', /function execJs</.test(clientSrc), true)
  check('execJs 用 Promise.race / setTimeout 加超时', /setTimeout\(\(\) => \{[\s\S]{0,200}resolve\(EXEC_TIMEOUT\)/.test(clientSrc), true)
}

console.log('\n[B] ⭐ 每个 await 过的 job 都要有「失败/超时」出口')
{
  /**
   * **真实 bug**：领到任务后如果中途任何一步抛异常，早期实现只打日志
   * ⇒ `pendingJobRef` 永远挂着 ⇒ `hasPending` 恒真 ⇒ **再也不会领新活**。
   *
   * 所以：领任务之后的每个失败路径都必须「交结果 + 清 pending」。
   */
  /** 找出所有把 pendingJobRef 置值的地方（= 领活点）。 */
  const setCount = (clientSrc.match(/pendingJobRef\.current = id/g) ?? []).length
  check('有领活点', setCount > 0, true)
  /** 找出所有清空的地方。 */
  const clearCount = (clientSrc.match(/pendingJobRef\.current = undefined/g) ?? []).length
  check('⭐ 清空点数 >= 领活点数（每条路都有出口）', clearCount >= setCount, true)
  /** 必须有 try/catch/finally 包住整个 tick 主体。 */
  check('⭐ tick 有 finally 复位 busy', /finally \{\s*busy = false\s*\}/.test(clientSrc), true)
  check('⭐ catch 里也交结果', /catch \(error\) \{[\s\S]{0,900}api\/job\/\$\{stuck\}\/result/.test(clientSrc), true)
}

console.log('\n[C] ⭐ 依赖数组不能含「每轮都变」的值（否则反复重建 effect）')
{
  /**
   * **真实 bug**：心跳 effect 的依赖里放了 `lastReply` / `replyCount`，
   * 每来一条回复就**重建整个心跳定时器**。
   *
   * 判据：心跳 / 轮询类 effect 的依赖里不能有随消息变化的状态。
   */
  /**
   * ⚠️ 窗口从 2200/1200 放宽到 4000/3500 —— 心跳 effect 里后来加了
   * 抓取诊断上报与**自动重载**逻辑，原来的窗口不够长会误报
   * （断言窗口太小是这类静态检查的常见误报源，踩过多次）。
   */
  const hb = /useEffect\(\(\) => \{[\s\S]{0,4000}?client\/heartbeat[\s\S]{0,3500}?\}, \[([^\]]*)\]/.exec(clientSrc)
  check('找到心跳 effect', hb !== null, true)
  if (hb !== null) {
    const deps = hb[1]
    check('⭐ 心跳依赖不含 lastReply', /lastReply/.test(deps), false)
    check('⭐ 心跳依赖不含 replyCount', /replyCount/.test(deps), false)
  }
}

console.log('\n[D] ⭐ 变量遮蔽：内层 const 不能盖住外层的状态变量')
{
  /**
   * **真实 bug（刚修的）**：取消分支里写 `const stopped = await execJs(...)`
   * 遮蔽了外层的 `let stopped`（effect 的停止标志）。
   * 这个 tick 内后面的 `if (stopped)` 会看到**局部变量**而不是停止标志。
   *
   * ⚠️ 窗口要够大 —— 这段实际约 865 字符（踩过：写死 600 会匹配不到 return）。
   */
  const block = /任务已被取消[\s\S]{0,1500}?return/.exec(clientSrc)
  check('找到取消分支', block !== null, true)
  if (block !== null) {
    check('⭐ 取消分支不声明 stopped 变量', /const stopped\s*=/.test(block[0]), false)
    check('⭐ 取消分支清 scrapedRef', /scrapedRef\.current = undefined/.test(block[0]), true)
    /**
     * 基线也要清 —— 否则下一个任务用「上一轮的条数/内容」做比对，
     * 可能把上一条回复当成新回复交回去（张冠李戴）。
     */
    check('⭐ 取消分支清 baselineRef', /baselineRef\.current = 0/.test(block[0]), true)
    check('⭐ 取消分支清 baselineTextRef', /baselineTextRef\.current = ''/.test(block[0]), true)
  }
}

console.log('\n[E] ⭐ 模板字符串内不能有裸反引号（会 PARSE_ERROR）')
{
  /**
   * **真实 bug（踩过 5 次）**：`buildXxxScript` 的函数体是模板字符串，
   * 在**注释里**用反引号包代码会把模板**提前终止** ⇒ PARSE_ERROR。
   *
   * ## ⚠️ 判据必须区分「注释里的」和「JS 代码里的」
   *
   * 模板内部本来是 JS 源码，里面有反引号是**合法的**
   * （比如生成 `` `${i+1}. \`${sig}\`` `` 这种字符串）。
   * 真正会炸的是**注释里**的反引号 —— 因为注释不参与字符串转义，
   * 一个反引号就把模板关掉了。
   *
   * 所以只扫「模板区间内的注释行」。
   */
  for (const [name, src] of [
    ['hook.ts', hookSrc],
    ['chat.ts', chatSrc],
  ]) {
    const lines = src.split('\n')
    const starts = []
    lines.forEach((l, i) => {
      if (/^export function \w+/.test(l)) starts.push(i)
    })
    const bad = []
    for (let s = 0; s < starts.length; s += 1) {
      const from = starts[s]
      const to = s + 1 < starts.length ? starts[s + 1] : lines.length
      const fnName = /^export function (\w+)/.exec(lines[from])?.[1] ?? '?'
      /** 该函数是否含模板（只有模板函数才需要这个检查）。 */
      const hasTemplate = lines.slice(from, to).some((l) => /return `\(function/.test(l))
      if (!hasTemplate) continue
      /** 跟踪是否在模板内。 */
      let inTemplate = false
      for (let i = from; i < to; i += 1) {
        const l = lines[i]
        const t = l.trim()
        if (!inTemplate) {
          if (/return `\(function/.test(l)) inTemplate = true
          continue
        }
        /** 模板结束行。 */
        if (/^\}\)\(\);`\s*$/.test(t)) { inTemplate = false; continue }
        /**
         * 只关心**注释行**里的反引号。
         *
         * 注释形态：`//` 开头，或 JSDoc 的 `*` 开头。
         * 代码行里的反引号（合法的字符串拼接）跳过。
         */
        const isComment = t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
        if (isComment && l.includes('`')) bad.push(`${fnName}:${i + 1}`)
      }
    }
    check(`⭐ ${name} 注释里无裸反引号`, bad, [])
  }
}

console.log('\n[F] ⭐ 导航后必须清理「上轮残留」状态')
{
  /**
   * ## 真实 bug（审计发现）
   *
   * 领活后要清三样：`pendingJobRef` / `scrapedRef` / `baseline*Ref`。
   * 原来散落在 **10 个地方**各写一遍，审计发现**只有 1 处写全了** ——
   * 其余要么只清 `scrapedRef`，要么基线两个都不清。
   *
   * 后果很具体：**不清基线** ⇒ 下个任务领到时 `baselineRef` 还是上一轮的
   * 条数 ⇒ `countGrew` 一上来就成立 ⇒ 可能把**上一条回复**当成新回复
   * 交回去（张冠李戴，DSH 里出现答非所问的内容）。
   *
   * 修法：收口成一个 `clearPending()`，**任何**结束任务的地方都调它。
   */
  check('⭐ 有统一的清理函数', /const clearPending = \(\) => \{/.test(clientSrc), true)
  /** 清理函数必须清全部五项。 */
  const fn = /const clearPending = \(\) => \{([\s\S]{0,400}?)\}/.exec(clientSrc)
  check('找到清理函数体', fn !== null, true)
  if (fn !== null) {
    const body = fn[1]
    for (const field of ['pendingJobRef', 'pendingSinceRef', 'scrapedRef', 'baselineRef', 'baselineTextRef']) {
      check(`⭐ clearPending 清 ${field}`, new RegExp(`${field}\\.current = `).test(body), true)
    }
  }
  /**
   * ⚠️ 但 **drain effect 里不能调它** ——
   * 基线由发送循环在领活时设置，drain 清掉会让「本轮回复来了吗」判据失效。
   */
  const lines = clientSrc.split('\n')
  const badCalls = []
  lines.forEach((l, i) => {
    if (!/clearPending\(\)/.test(l)) return
    const t = l.trim()
    /** 注释里的提及不算。 */
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return
    /** 定义处。 */
    if (/const clearPending/.test(l)) return
    /** 发送循环从 ~1400 行开始（drain effect 在它之前）。 */
    if (i + 1 < 1400) badCalls.push(i + 1)
  })
  check('⭐ drain effect 里没有调它（只清 pending）', badCalls, [])
  /** 领活时必须记基线 —— 否则没东西可比。 */
  check('⭐ 领活时记基线条数', /baselineRef\.current = typeof base\.count === 'number'/.test(clientSrc), true)
  check('⭐ 领活时记基线内容', /baselineTextRef\.current = typeof base\.last === 'string'/.test(clientSrc), true)
}

console.log('\n[G] ⭐ DOM 读回复：正文不得含思考')
{
  check('⭐ 有 isThinkNode', /function isThinkNode\(/.test(hookSrc), true)
  check('⭐ 正文渲染跳过思考容器', /if \(!forThink && isThinkNode\(node\)\) return ''/.test(hookSrc), true)
  check('⭐ readThink 用 forThink=true', /render\(found, true\)/.test(hookSrc), true)
  check('⭐ render 递归透传 forThink', /render\(kids\[i\], forThink\)/.test(hookSrc), true)
}

console.log('\n[H] ⭐ 超时层次必须有序（client < adapter）')
{
  /**
   * client 先放弃并交错误，adapter 后超时 —— 反了的话 adapter 会先报错，
   * client 交的结果就没人接收了（且日志会误导）。
   */
  check('⭐ client 用配置的 80%', /currentConfig\(\)\.replyTimeoutMs \* 0\.8/.test(clientSrc), true)
  check('adapter 用配置全量', /timeoutMs = deps\.timeoutMs/.test(adapterSrc), true)
}

console.log('\n[I] ⭐ 每条交结果的路都要带 jobId（不能张冠李戴）')
{
  /** 所有 PUT result 都必须用**当前** jobId。 */
  const puts = (clientSrc.match(/api\/job\/\$\{[a-zA-Z]+\}\/result/g) ?? [])
  const bad = puts.filter((p) => !/\$\{(jobId|stuck|id)\}/.test(p))
  check('⭐ 交结果都用变量插值而不是硬编码', bad, [])
  check('有交结果调用', puts.length > 0, true)
}

console.log('\n[J] ⭐ 清空 URL 检查：不能把空串当「已经在目标页」')
{
  /**
   * `location.href` 读失败时返回空串。若直接拿空串和目标比，
   * `'' !== expectUrl` 会成立 ⇒ 触发一次**没必要的导航**。
   * 更糟的是反过来：把空串当成「已匹配」就发错页面。
   */
  check('⭐ 读 URL 失败时走保守分支', /currentRaw === EXEC_TIMEOUT \? '' : String\(currentRaw\)/.test(clientSrc), true)
  /** 空串绝不能等于 expectUrl（逻辑上安全，但要有测试钉住）。 */
  const emptyEq = "'' === expectUrl"
  check('⭐ 没把空串当匹配', clientSrc.includes(emptyEq), false)
}

console.log('\n[K] ⭐ host 侧：坏输入不能崩')
{
  check('结果 JSON 解析失败有兜底', /catch \{\s*sendJson\(res, 400/.test(hostSrc.replace(/\s+/g, ' ')) || /catch \{\s*sendJson\(res, 400, \{ ok: false, reason: 'invalid-json' \}\)/.test(hostSrc), true)
  /** 配置读取失败要回退默认值，不能抛。 */
  check('⭐ 配置读取有兜底', /readConfig\(\)[\s\S]{0,400}catch/.test(hostSrc), true)
}

console.log('\n[L] ⭐ 未登录门禁：调用时也要拦（不能只靠 listModels）')
{
  const adapter = adapterSrc
  check('⭐ stream 里有登录检查', /WEBIN_NOT_LOGGED_IN/.test(adapter), true)
  check('⭐ listModels 里有登录检查', /if \(!loggedIn\(hit\.id\)\)/.test(adapter), true)
}

console.log('\n[M] ⭐ 编码：不能有替换字符（U+FFFD）')
{
  const files = []
  const walk = (d) => {
    for (const e of readdirSync(join(ROOT, d))) {
      if (['node_modules', '.git', '_backup', 'lib'].includes(e)) continue
      const rel = `${d}/${e}`
      if (statSync(join(ROOT, rel)).isDirectory()) walk(rel)
      else if (/\.(md|ts|mjs|json)$/.test(e)) files.push(rel)
    }
  }
  walk('.')
  /** ⚠️ `read()` 已经拼过 ROOT，这里不能再传绝对路径（踩过）。 */
  const bad = files.filter((f) => {
    try {
      return readFileSync(join(ROOT, f), 'utf8').includes('\uFFFD')
    } catch {
      return false
    }
  })
  check('⭐ 全库无 U+FFFD', bad, [])
}

console.log('\n[N] ⭐ 残留的死代码不要留着误导人')
{
  /** `buildSendScript` 已删（拆成 fill/trigger）。 */
  check('⭐ 源码无 buildSendScript 定义', /export function buildSendScript/.test(chatSrc), false)
  check('⭐ 无对它的调用', /await execJs[^\n]*buildSendScript\(/.test(clientSrc), false)
  /** `buildVerifyScript` 已删（发送不再自证）。 */
  check('⭐ 源码无 buildVerifyScript', /buildVerifyScript/.test(chatSrc), false)
}

console.log('\n[O] ⭐⭐ 所有对 host 的 fetch 必须有超时（防循环永久停摆）')
{
  /**
   * ## 真实 bug（审计发现）
   *
   * 发送循环里有 8 处 `await fetch('/dsh-webin/api/job/.../result')`。
   * 裸 `fetch` **没有超时** —— host 卡住时这个 await 永远挂着，
   * 而 `busy` 已经是 true ⇒ **整个发送循环永久停摆**，
   * 且没有任何异常可捕获（用户看到「什么都不发生」）。
   *
   * 现在统一走 `fetchJson()`（带超时、超时返回 undefined 不抛错）。
   */
  check('⭐ 有 fetchJson 包装', /function fetchJson\(/.test(clientSrc), true)
  check('⭐ fetchJson 用 setTimeout 加超时', /setTimeout\(\(\) => \{[\s\S]{0,200}resolve\(undefined\)/.test(clientSrc), true)
  /** 交结果的路径必须全走 fetchJson。 */
  const rawJobFetch = clientSrc.match(/await fetch\(`\/dsh-webin\/api\/job\//g) ?? []
  check('⭐ 没有裸 await fetch(job)', rawJobFetch, [])
  const rawVoidFetch = clientSrc.match(/void fetch\(`\/dsh-webin\/api\/job\//g) ?? []
  check('⭐ 没有裸 void fetch(job)', rawVoidFetch, [])
  /** 领活请求也要有超时。 */
  check('⭐ 领活请求走 fetchJson', /const res = await fetchJson\(query/.test(clientSrc), true)
  check('有 fetchJson 调用', (clientSrc.match(/fetchJson\(/g) ?? []).length >= 8, true)
}

console.log('\n[P] ⭐⭐ 长等待必须可中断（不能一觉睡到底）')
{
  /**
   * ## 真实 bug（审计发现）
   *
   * 长休原来是 `await new Promise(r => setTimeout(r, breakMs))` ——
   * 一口气睡最多 **3 分钟**。那段时间里：
   *   1. **用户按停止看不到反应**（循环在睡觉，不会问 host「取消了吗」）
   *   2. 用户切会话后，任务醒来仍往**当前页面**发 ⇒ 串台
   *
   * 现在每 2 秒醒一次检查取消。
   */
  check('⭐ 长休分段睡', /Math\.min\(2_000, deadline - Date\.now\(\)\)/.test(clientSrc), true)
  check('⭐ 长休期间检查取消', /长休期间任务被取消/.test(clientSrc), true)
  check('⭐ 取消后不交结果（host 已标记）', /clearPending\(\)\s*\n\s*return/.test(clientSrc), true)
  /** 长休不应再有一觉睡到底的写法。 */
  check('⭐ 没有一觉睡 breakMs', /await new Promise\(\(r\) => setTimeout\(r, breakMs\)\)/.test(clientSrc), false)
}

console.log('\n[Q] ⭐⭐ 点火前必须复查（填完字到按发送之间隔 2–4 秒）')
{
  /**
   * 那 2–4 秒里用户可能按停止、或切到别的会话 —— 两种都不该再发出去，
   * 否则要么发出已取消的消息，要么把内容发进**错误的对话**（串台）。
   */
  check('⭐ 点火前有取消复查', /点火前发现任务已取消/.test(clientSrc), true)
  check('⭐ 取消时清空输入框（不留半截消息）', /buildClearInputScript/.test(clientSrc), true)
  check('⭐ 有清空脚本实现', /export function buildClearInputScript/.test(chatSrc), true)
  /** 清空脚本要能处理 textarea 与 contenteditable 两种。 */
  check('清空支持 textarea', /HTMLTextAreaElement\.prototype/.test(chatSrc), true)
  check('清空支持 contenteditable', /execCommand\('selectAll'/.test(chatSrc), true)
  /** ⚠️ 复查必须在触发**之前**。 */
  const iProbe = clientSrc.indexOf('点火前发现任务已取消')
  /**
   * ⚠️ 必须锚到**主发送路径**的那次触发调用。
   *
   * 只用 `buildTriggerScript(sendHintsFor(provider)` 这个前缀会命中最前面的
   * **「催继续」路径**（它在源码里出现得更早），于是 `iProbe < iTrig`
   * 恒为 false —— 纯误报（真实事故：断言看着红，主路径时序其实是对的）。
   * 带上 `, prompt` 参数才能锚到主路径。
   */
  const iTrig = clientSrc.indexOf('buildTriggerScript(sendHintsFor(provider), prompt)')
  check(
    `⭐ 复查在触发之前（复查@${iProbe} 触发@${iTrig}）`,
    iProbe > 0 && iTrig > 0 && iProbe < iTrig,
    true,
  )
}

console.log('\n[R] ⭐⭐ host 侧：已取消的任务不能被结果「复活」')
{
  /**
   * ## 真实 bug（审计发现）
   *
   * `settle()` 早期直接覆盖 `job.done` / `job.failed`：
   *
   *   1. 用户按停止 ⇒ `cancel()` 设 `failed = 已取消`，调用方已收到错误退出
   *   2. client 那边**还在等页面回复**，稍后 `done` 到达，照样 PUT 结果
   *   3. `settle()` 把 `failed` **覆盖成 `done`** ⇒ 取消掉的任务在队列里
   *      「复活」成成功状态
   *
   * 修法：已取消 / 已了结的任务**一律拒绝**（返回 false ⇒ 调用方收到 404）。
   */
  check('⭐ settle 拒绝已取消的', /if \(job\.cancelled === true\) return false/.test(adapterSrc), true)
  check('⭐ settle 拒绝已了结的', /if \(job\.done !== undefined \|\| job\.failed !== undefined\) return false/.test(adapterSrc), true)
  /** 顺序：两个拒绝都要在写入**之前**。 */
  const iReject = adapterSrc.indexOf('if (job.cancelled === true) return false')
  const iWrite = adapterSrc.indexOf("if ('error' in result) job.failed = result.error")
  check('⭐ 拒绝在写入之前', iReject > 0 && iWrite > iReject, true)
}

console.log('\n[S] ⭐ 队列淘汰只删已了结的（否则要么爆内存要么丢任务）')
{
  /**
   * ## 真实隐患（审计发现）
   *
   * 早期写法：按时间排序取最老的，若已了结就删。
   *
   * 但最老的**通常正是**已完成那条 ⇒ 碰巧能删；可如果最老那条恰好
   * 卡住没了结，就**一个都删不掉** ⇒ map 无限增长。
   *
   * 现在：只在超限时，从**已了结的**里面挑最老的删。
   */
  check('⭐ 只在已了结的里面挑', /if \(j\.done === undefined && j\.failed === undefined\) continue/.test(adapterSrc), true)
  check('⭐ 挑最老的已了结', /j\.createdAt < oldestDone\.createdAt/.test(adapterSrc), true)
  /** 不能再用「排序取 [0] 然后判定了结」那种写法。 */
  check('⭐ 没有旧的 sort+[0] 写法', /sort\(\(a, b\) => a\.createdAt - b\.createdAt\)\[0\]/.test(adapterSrc), false)
}

console.log('\n[T] ⭐ 领活不能重复领同一个任务')
{
  check('⭐ claimNext 跳过已领的', /job\.claimedAt !== undefined\) continue/.test(adapterSrc), true)
  check('⭐ claimNext 按平台过滤', /platform !== undefined && job\.platform !== platform/.test(adapterSrc), true)
}

console.log('\n[U] ⭐⭐ 交付判据：内容不再增长 + 静默够久（防交半截回复）')
{
  /**
   * ## 真实缺陷（审计发现）
   *
   * 早期只用「这次读到的 == 上次读到的」就交付。但流式输出**可能暂停**
   * （网络抖动、服务端排队）—— 暂停期间两次读到同样的半截内容 ⇒
   * **把半截回复交回 DSH**，用户看到回复被截断，且 DSH 认为这轮已结束。
   *
   * 现在两个条件都要满足：
   *   1. 内容与上次相同（没有新增）
   *   2. **且**距离上次**变化**已超过 `STABLE_MS`
   *
   * 用「上次变化时刻」而不是「上次读取时刻」——
   * 后者会被读取频率（1.5s 一轮）影响，白等一轮。
   */
  check('⭐ 有 STABLE_MS 常量', /const STABLE_MS = 3_000/.test(clientSrc), true)
  check('⭐ 有「变化时刻」ref', /scrapedChangedAtRef/.test(clientSrc), true)
  check('⭐ 判据含静默时长', /now - scrapedChangedAtRef\.current < STABLE_MS/.test(clientSrc), true)
  /** 内容变化时要更新「变化时刻」。 */
  check('⭐ 内容变了就记时刻', /scrapedRef\.current = last\s*\n\s*scrapedChangedAtRef\.current = now/.test(clientSrc), true)
  /** 领活时重置变化时刻（新任务从此刻开始算静默）。 */
  check('⭐ 领活时重置变化时刻', /baselineTextRef\.current = typeof base\.last[\s\S]{0,200}scrapedChangedAtRef\.current = Date\.now\(\)/.test(clientSrc), true)
  /** 统一清理要含它。 */
  const fn = /const clearPending = \(\) => \{([\s\S]{0,500}?)\}/.exec(clientSrc)
  check('找到 clearPending', fn !== null, true)
  if (fn !== null) {
    for (const f of ['pendingJobRef', 'pendingSinceRef', 'scrapedRef', 'scrapedChangedAtRef', 'baselineRef', 'baselineTextRef']) {
      check(`⭐ clearPending 清 ${f}`, new RegExp(`${f}\\.current = `).test(fn[1]), true)
    }
  }
}

console.log('\n[V] ⭐ 死代码清单（不能留会误导人的东西）')
{
  /**
   * `REQUEST_COUNT_KEY` 是 SSE hook 时代的产物：客户端靠它读
   * 「页面发了几个 completion 请求」来**自证发送成功**。
   *
   * 改成三段式发送后不再自证（cuckoo 也不自证：点完就算发了），
   * 所以这个常量已无使用者。
   */
  /**
   * ⚠️ 断言的是「没有**声明**」而不是「没有出现」——
   * 注释里会提到这个名字（解释它为什么被删），那是正常的文档。
   */
  check('⭐ 无 REQUEST_COUNT_KEY 死常量（声明）', /export const REQUEST_COUNT_KEY/.test(hookSrc), false)
  check('⭐ 也没人 import 它', /import[^}]*REQUEST_COUNT_KEY/.test(clientSrc), false)
  /** chat.ts 的导出必须都被用到（否则就是死代码）。 */
  const exports = [...chatSrc.matchAll(/^export function (\w+)/gm)].map((m) => m[1])
  const unused = exports.filter((name) => !new RegExp(`\\b${name}\\b`).test(clientSrc))
  check('⭐ chat.ts 没有无人使用的导出', unused, [])
  /** hook.ts 的导出同理。 */
  const hookExports = [...hookSrc.matchAll(/^export function (\w+)/gm)].map((m) => m[1])
  const hookUnused = hookExports.filter((name) => !new RegExp(`\\b${name}\\b`).test(clientSrc))
  check('⭐ hook.ts 没有无人使用的导出', hookUnused, [])
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
process.exitCode = fail === 0 ? 0 : 1
/** ⚠️ 显式退出 —— 防 handle 悬挂把 npm run check 卡死（verify-lifecycle 实测踩过）。 */
process.exit(process.exitCode)
