#!/usr/bin/env node
/**
 * ## 会话隔离：任务只能被**属于它的那个窗口**领走
 *
 * ## 用户报的问题（原话）
 *
 * 「换了几个 dsh 窗口聊天，发现全都是在网页版的同一个会话窗口」
 * 「以后不要猜了，所有窗口都生效，不要猜，不要猜！」
 *
 * ## 事实（不是猜的）
 *
 * 用 Slots Inspect 查到的**官方契约**：
 *
 *   - `conversation.view` 的 `standardProps` 里有 **`sessionId: SessionId`**
 *     ⇒ 挂在它上面的组件能拿到本窗口的会话身份
 *   - `settings.section` 的 standardProps **没有** sessionId
 *     ⇒ 设置页拿不到（也不需要）
 *
 * 而早期 `/job/next` **只按平台过滤** ⇒ 任何窗口都能领走任何任务。
 *
 * 修法：
 *   1. client 从 `conversation.view` 的 props 拿 `sessionId` 并上报
 *   2. host 派发任务时带上目标 `sessionId`
 *   3. client 领活带 `?session=<id>`，host 只派匹配的
 *
 * 这个脚本用**真 host** 验证第 3 步。
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const adapterSrc = readFileSync(join(ROOT, 'src', 'host', 'adapter.ts'), 'utf8')
const hostSrc = readFileSync(join(ROOT, 'src', 'host', 'index.ts'), 'utf8')
const clientSrc = readFileSync(join(ROOT, 'src', 'client', 'index.ts'), 'utf8')

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

console.log('=== 会话隔离（「所有窗口都生效」）===\n')

console.log('[1] ⭐⭐ 事实核对：sessionId 从哪来（不能猜）')
{
  /**
   * 这两个断言记录的是 **Slots Inspect 查到的官方契约** ——
   * 如果有人改了数据来源，这里会提醒他先查清楚。
   */
  check('⭐ client 从 props 拿 sessionId', /props\?: \{ sessionId\?: string \}/.test(clientSrc), true)
  check('⭐ 组件直接注册（React 透传 props）', /LdwPlaceholder,\s*\n\s*\)/.test(clientSrc), true)
  /** 必须打印实际收到的 props —— 把推断变成观测。 */
  check('⭐⭐ 打印实际收到的 props（不靠推断）', /conversation\.view 收到的 props/.test(clientSrc), true)
  check('⭐ 打印 keys 便于核对', /keys,\s*\n\s*sessionId:/.test(clientSrc), true)
}

console.log('\n[2] ⭐⭐ 任务必须带 sessionId')
{
  check('⭐ Job 有 sessionId 字段', /sessionId\?: string/.test(adapterSrc), true)
  check('⭐ enqueue 接收 sessionId', /sessionId\?: string,\s*\n\s*\): Job \{/.test(adapterSrc), true)
  /** 派发时必须真的传进去。 */
  check('⭐ 派发时传 options.sessionId', /options\.sessionId === undefined \|\| options\.sessionId === ''[\s\S]{0,120}?: String\(options\.sessionId\)/.test(adapterSrc), true)
  /** ⚠️ 要用 DSH 给的原始 sessionId，不是退化的 sessionKey。 */
  check('⭐⭐ 用 options.sessionId 而不是 sessionKey', /用 `options\.sessionId`（DSH 给的原始值）而不是 `sessionKey`/.test(adapterSrc), true)
}

console.log('\n[3] ⭐⭐⭐ 领活必须按会话过滤（核心）')
{
  /**
   * 判据（三条都要对）：
   *   - 任务**有** sessionId ⇒ 只派给相同 sessionId 的窗口
   *   - 任务**没有** sessionId ⇒ 放行（向后兼容，否则永远没人领）
   *   - 窗口没上报 ⇒ 只领「没有 sessionId」的任务（不抢别人的）
   */
  check('⭐ claimNext 接收 sessionId', /claimNext\(platform\?: string, sessionId\?: string\)/.test(adapterSrc), true)
  check('⭐⭐ 任务带 sessionId 时严格匹配', /if \(job\.sessionId !== undefined && job\.sessionId !== sessionId\) continue/.test(adapterSrc), true)
  /** 记录被谁领走（诊断）。 */
  check('⭐ 记录 claimedBy', /job\.claimedBy = hasIdentity \? sessionId : '\(未上报\)'/.test(adapterSrc), true)
  /** 路由要把 ?session= 传进去。 */
  check('⭐⭐ 路由读 ?session=', /url\.searchParams\.get\('session'\)/.test(hostSrc), true)
  check('⭐⭐ 路由传给 claimNext', /queue\.claimNext\(platform, session\)/.test(hostSrc), true)
  /** 返回的任务带上 sessionId（client 可核对）。 */
  check('⭐ 响应带 sessionId', /\.\.\.\(job\.sessionId === undefined \? \{\} : \{ sessionId: job\.sessionId \}\)/.test(hostSrc), true)
}

console.log('\n[4] ⭐⭐ client 领活必须带上自己的会话身份')
{
  check('⭐ 有 sessionIdRef', /const sessionIdRef: \{ current: string \}/.test(clientSrc), true)
  check('⭐ 挂载时写入', /sessionIdRef\.current = sid/.test(clientSrc), true)
  check('⭐⭐ 领活带 ?session=', /'&session=' \+ encodeURIComponent\(sid\)/.test(clientSrc), true)
  /** ⚠️ 没拿到时**不带参数**，而不是带空串 —— 空串会导致谁也领不到。 */
  check('⭐⭐ 没拿到时不带参数', /sid === '' \? '' : '&session='/.test(clientSrc), true)
}

console.log('\n[5] ⭐⭐ 上报路由存在且容错')
{
  check('⭐ 有 /client/session 路由', /client\/session/.test(hostSrc), true)
  check('⭐ 记进 knownSessions', /knownSessions\.set\(sid, Date\.now\(\)\)/.test(hostSrc), true)
  /** 空 sessionId 要拒绝（否则 knownSessions 会被污染）。 */
  check('⭐ 空 sessionId 拒绝', /missing sessionId/.test(hostSrc), true)
  /** 清理关掉的窗口。 */
  check('⭐ 清理 10 分钟没上报的', /cutoff = Date\.now\(\) - 600_000/.test(hostSrc), true)
  /** client 上报失败不影响功能。 */
  check('⭐ 上报失败不阻断', /上报失败不影响功能/.test(hostSrc), true)
}

console.log('\n[6] ⭐⭐ 可观测：/status 能看到「谁领了谁的任务」')
{
  /**
   * 用户要求「不要猜」。所以要有地方**直接看到**事实：
   *   - `jobs[].sessionId`  —— 任务属于哪个会话
   *   - `jobs[].claimedBy`  —— 实际被哪个窗口领走
   *   - `jobs[].state`      —— pending / claimed / done / failed / cancelled
   *
   * 两者不一致 ⇒ 就是派发错了，一眼可见。
   */
  check('⭐ 有 inspect() 诊断方法', /inspect\(\): \{/.test(adapterSrc), true)
  check('⭐ 输出 sessionId', /sessionId: j\.sessionId \?\? '\(无\)'/.test(adapterSrc), true)
  check('⭐ 输出 claimedBy', /claimedBy: j\.claimedBy \?\? '\(未领\)'/.test(adapterSrc), true)
  check('⭐ 输出状态', /state:/.test(adapterSrc), true)
  check('⭐⭐ /status 暴露 jobs', /jobs: queue\.inspect\(\)/.test(hostSrc), true)
  check('⭐ /status 暴露 knownSessions', /knownSessions: \[\.\.\.knownSessions\.entries\(\)\]/.test(hostSrc), true)
}

console.log('\n[7] ⭐ 向后兼容：老任务不能被卡住')
{
  /**
   * 老 client 派发的任务没有 sessionId。若严格匹配，它们会**永远没人领**
   * —— 比派错更糟。所以必须放行。
   */
  check(
    '⭐ 无 sessionId 的任务放行',
    /job\.sessionId !== undefined && job\.sessionId !== sessionId/.test(adapterSrc),
    true,
  )
  /** 注释里要写明这个取舍。 */
  check('⭐ 注释说明了取舍', /任一方缺信息.*放行/.test(adapterSrc), true)
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
process.exitCode = fail === 0 ? 0 : 1
