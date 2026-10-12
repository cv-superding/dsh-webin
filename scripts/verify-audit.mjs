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
  const hb = /useEffect\(\(\) => \{[\s\S]{0,2200}?client\/heartbeat[\s\S]{0,1200}?\}, \[([^\]]*)\]/.exec(clientSrc)
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
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
process.exitCode = fail === 0 ? 0 : 1
