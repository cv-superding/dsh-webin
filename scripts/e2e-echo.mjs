#!/usr/bin/env node
/**
 * ## 真正的端到端测试：发一条消息，等网页版回复，看能不能回显
 *
 * 用户的话：「你自己测试吧！之前让你测试的，你肯定没测试，到目前为止，
 * 一次都没成功！」
 *
 * **对。** 之前全是离线单测 —— 只能证明「代码里写了什么」。
 *
 * 这个脚本走**真实链路**：
 *
 *     POST /selftest/echo  （往真队列塞任务）
 *       → 真实 client 领活
 *       → 真实填输入框、点发送
 *       → 网页版真的生成
 *       → 真实抓 DOM
 *       → 交回结果
 *       → 这里读出来
 *
 * 唯一没覆盖的是「DSH 调 LLM 接口派发」那一步 —— 那在测试脚本里做不到，
 * 但队列是同一个实例，所以**其余全部是真的**。
 *
 * ⚠️ 这会**真的往你的 DeepSeek 网页版发一条消息**。用最小的提示词。
 */
const BASE = 'http://127.0.0.1:19387'
const TOKEN = 'ueMERfrc9WvsZbW8w78KbR_rOGYGx_IFxOSdwCqrupE'
const h = { authorization: `Bearer ${TOKEN}` }

async function api(path, init) {
  const r = await fetch(BASE + path, { headers: h, ...init })
  const t = await r.text()
  try {
    return { status: r.status, body: JSON.parse(t) }
  } catch {
    return { status: r.status, body: t }
  }
}

const PROMPT = process.argv[2] ?? '1+1=?只回答数字'
const TIMEOUT_MS = Number(process.argv[3] ?? 180_000)

console.log('=== 端到端回显测试 ===\n')

console.log('[1] 前置检查')
const st = await api('/dsh-webin/api/status')
const clients = st.body.clients ?? {}
console.log(`  client 在线: ${clients.online}  loggedIn: ${clients.loggedIn}  hasGuest: ${clients.detail?.[0]?.hasGuest}`)
if ((clients.online ?? 0) === 0) {
  console.log('\n❌ 没有 client 在线 —— 请先打开 DSH 的 LDW 标签，让面板跑起来。')
  console.log('   （面板不跑，任务没人领，测不了。）')
  process.exit(1)
}
const logged = st.body.loggedInPlatforms ?? []
console.log(`  已登录平台: ${JSON.stringify(logged)}`)
if (!logged.includes('deepseek')) {
  console.log('\n❌ deepseek 未登录 —— 先在 LDW 面板里登录。')
  process.exit(1)
}

console.log(`\n[2] 派发测试任务: ${JSON.stringify(PROMPT)}`)
const post = await api('/dsh-webin/api/selftest/echo', {
  method: 'POST',
  headers: { ...h, 'content-type': 'application/json' },
  body: JSON.stringify({ prompt: PROMPT, platform: 'deepseek' }),
})
if (post.status === 404) {
  console.log('  ❌ 404 —— host 未重启，自测路由还没加载。')
  console.log('     请重启 DSH 后再跑。')
  process.exit(1)
}
if (post.body?.ok !== true) {
  console.log('  ❌ 派发失败:', JSON.stringify(post.body))
  process.exit(1)
}
const jobId = post.body.jobId
console.log(`  ✅ 已入队: ${jobId}`)

console.log('\n[3] 等 client 领活并跑完（最长 ' + Math.round(TIMEOUT_MS / 1000) + ' 秒）')
const started = Date.now()
let lastState = ''
let done = null
while (Date.now() - started < TIMEOUT_MS) {
  await new Promise((r) => setTimeout(r, 2000))
  const r = await api(`/dsh-webin/api/selftest/echo/${encodeURIComponent(jobId)}`)
  if (r.status !== 200) continue
  const b = r.body
  const secs = Math.round((Date.now() - started) / 1000)
  if (b.state !== lastState) {
    console.log(`  [${secs}s] ${b.state}  claimedBy=${b.claimedBy}`)
    lastState = b.state
  } else if (secs % 10 === 0) {
    console.log(`  [${secs}s] 仍在 ${b.state}…`)
  }
  if (b.state === 'done' || b.state === 'failed' || b.state === 'cancelled') {
    done = b
    break
  }
}

console.log('\n[4] 结果')
if (done === null) {
  console.log(`  ❌ 超时（${Math.round(TIMEOUT_MS / 1000)} 秒）—— 任务一直没结束`)
  console.log('     可能原因：网页版没生成 / DOM 抓不到 / 面板掉线')
  const r = await api(`/dsh-webin/api/selftest/echo/${encodeURIComponent(jobId)}`)
  console.log('     最后状态:', JSON.stringify(r.body))
  process.exit(1)
}

console.log(`  状态: ${done.state}   耗时: ${Math.round(done.elapsedMs / 1000)} 秒`)
if (done.state === 'done') {
  console.log(`  ✅ 回显正文（${String(done.text ?? '').length} 字符）:`)
  console.log('  ┌─────────────────────────────────────')
  for (const line of String(done.text ?? '').split('\n').slice(0, 20)) {
    console.log('  │ ' + line)
  }
  console.log('  └─────────────────────────────────────')
  if (done.think) console.log(`  （思考内容 ${String(done.think).length} 字符）`)
  console.log('\n🎉 端到端通了 —— 网页版的回复成功回显。')
} else {
  console.log(`  ❌ ${done.state}: ${done.error ?? '(无错误信息)'}`)
  process.exit(1)
}
