#!/usr/bin/env node
/**
 * **登录门禁 + 输入框 LDW 入口** 测试。
 *
 * ## 用户的两条要求
 *
 * 1. 「每次新建会话的时候，应该在这里加个 LDW，让登录一下」
 *    → `conversation.input.left` 注册一个入口按钮（新建会话也在视野里）
 * 2. 「如果是已登录才能使用 LDW 那俩模型」
 *    → 未登录的平台**不列出模型**，且**调用时直接报错**
 *
 * ## 为什么判据是「登录快照」而不是「浏览器在线」
 *
 * 用「在线」会导致：重启 DSH 后、用户还没切到 LDW 标签时，模型从选择器里
 * 消失 —— 用户会以为插件坏了。快照是持久化的，记录「上次确实登录过」。
 *
 * ## 为什么不能只看「快照文件存在」
 *
 * DeepSeek 未登录时**也会写 `userToken` 键**，值是 `{"value":null}`。
 * 实测过这个坑：早期版本因此把空快照当成有效快照，覆盖了真快照。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isolate } from './lib/isolate.mjs'

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

function makeHttp(method, url, body) {
  const chunks = []
  let resolveDone
  const done = new Promise((r) => {
    resolveDone = r
  })
  const req = {
    method,
    url,
    on(event, cb) {
      if (event === 'data' && body !== undefined) setTimeout(() => cb(Buffer.from(body)), 0)
      if (event === 'end')
        setTimeout(() => {
          cb()
          resolveDone()
        }, 1)
      return this
    },
    destroy() {},
  }
  const res = {
    statusCode: 200,
    headers: {},
    chunks,
    writeHead(code, headers) {
      this.statusCode = code
      Object.assign(this.headers, headers ?? {})
      return this
    },
    end(text) {
      if (text !== undefined) chunks.push(String(text))
      resolveDone()
    },
  }
  return { req, res, done }
}

async function call(handler, method, url, body) {
  const { req, res, done } = makeHttp(method, url, body)
  await handler(req, res)
  await Promise.race([done, new Promise((r) => setTimeout(r, 2000))])
  const text = res.chunks.join('')
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  return { status: res.statusCode, text, json }
}

function makeCtx() {
  const routes = new Map()
  const adapters = new Map()
  const ctx = {
    logger: () => ({ info() {}, warn() {}, debug() {} }),
    effect(cb) {
      cb()
      return () => {}
    },
    llm: {
      registerAdapter(providers, adapter) {
        for (const p of providers) adapters.set(p, adapter)
        return () => {}
      },
    },
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => {}
      },
    },
    slots: { inject() {}, register: (o, c) => ({ o, c }) },
  }
  return { ctx, routes, adapters }
}

/** 写一份登录快照到 state 目录。 */
function writeSnapshot(platform, body) {
  const dir = join(process.env.DSH_HOME, 'webin', 'auth')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${platform}.json`), typeof body === 'string' ? body : JSON.stringify(body), 'utf8')
}

console.log('=== 登录门禁 + 输入框 LDW 入口 测试 ===\n')

const cleanupState = isolate('webin-login-gate')
const mod = await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href)
const { apply } = mod

console.log('[1] 未登录时：不列出模型')
{
  const A = makeCtx()
  await apply(A.ctx)
  const adapter = A.adapters.get('webin-deepseek')
  const models = await adapter.listModels('webin-deepseek')
  check('⭐ 未登录 ⇒ 模型清单为空', models.length, 0)
}

console.log('\n[2] ⭐ 登录后：列出模型')
{
  writeSnapshot('deepseek', {
    localStorage: { userToken: '{"value":"tok-abc","__version":"0"}' },
    url: 'https://chat.deepseek.com/',
  })
  const A = makeCtx()
  await apply(A.ctx)
  const adapter = A.adapters.get('webin-deepseek')
  const models = await adapter.listModels('webin-deepseek')
  check('⭐ 已登录 ⇒ 有模型', models.length > 0, true)
  check('含 ldw-fast', models.some((m) => m.id.includes('ldw-fast')), true)
  check('含 ldw-think', models.some((m) => m.id.includes('ldw-think')), true)
}

console.log('\n[3] ⭐ 未登录快照（userToken=null）不算登录')
{
  /**
   * 实测坑：DeepSeek 未登录时也写 `userToken` 键，值是 `{"value":null}`。
   * 只看「键存在」会误判成已登录。
   */
  writeSnapshot('deepseek', {
    localStorage: {
      userToken: '{"value":null,"__version":"0"}',
      __appKit_userInfo: '{"value":{"id":null}}',
    },
    url: 'https://chat.deepseek.com/sign_in',
  })
  const A = makeCtx()
  await apply(A.ctx)
  const adapter = A.adapters.get('webin-deepseek')
  const models = await adapter.listModels('webin-deepseek')
  check('⭐ null token ⇒ 不算登录', models.length, 0)
}

console.log('\n[4] 坏快照文件不能让插件挂掉')
{
  writeSnapshot('deepseek', '{ 这不是合法 JSON')
  const A = makeCtx()
  let threw = null
  try {
    await apply(A.ctx)
  } catch (e) {
    threw = String(e)
  }
  check('⭐ 坏文件不影响加载', threw, null)
  const adapter = A.adapters.get('webin-deepseek')
  const models = await adapter.listModels('webin-deepseek')
  check('坏文件 ⇒ 视为未登录', models.length, 0)
}

console.log('\n[5] ⭐ 畸形 token（像 JSON 但解析失败）不能被当成有效')
{
  writeSnapshot('deepseek', { localStorage: { userToken: '{broken' } })
  const A = makeCtx()
  await apply(A.ctx)
  const adapter = A.adapters.get('webin-deepseek')
  const models = await adapter.listModels('webin-deepseek')
  check('⭐ 畸形值不算登录', models.length, 0)
}

console.log('\n[6] 裸字符串 token（旧版页面写法）算登录')
{
  writeSnapshot('deepseek', { localStorage: { userToken: 'raw-token-without-wrapper' } })
  const A = makeCtx()
  await apply(A.ctx)
  const adapter = A.adapters.get('webin-deepseek')
  const models = await adapter.listModels('webin-deepseek')
  check('裸 token 算登录', models.length > 0, true)
}

console.log('\n[7] ⭐ 未登录时调用模型 → 明确报错（不是莫名其妙的输入框错误）')
{
  writeSnapshot('deepseek', { localStorage: { userToken: '{"value":null}' } })
  const A = makeCtx()
  await apply(A.ctx)
  const adapter = A.adapters.get('webin-deepseek')

  const stream = adapter.stream({
    provider: 'webin-deepseek',
    model: 'deepseek:ldw-fast',
    sessionId: 'gate-1',
    messages: [{ role: 'user', content: '你好' }],
  })
  const chunks = []
  for await (const c of stream) chunks.push(c)
  const finish = chunks.find((c) => c.type === 'finish')
  check('⭐ 以 error 结束', finish?.reason?.kind, 'error')
  check('⭐ 错误码 WEBIN_NOT_LOGGED_IN', finish?.reason?.failure?.code, 'WEBIN_NOT_LOGGED_IN')
  check('⭐ 提示里说了怎么登录', /登录/.test(finish?.reason?.failure?.message ?? ''), true)
  check('⭐ 提示里提到 LDW 按钮或标签', /LDW/.test(finish?.reason?.failure?.message ?? ''), true)
  /** 不能真的派发任务（否则页面会跳登录页）。 */
  check('没有派发任务', chunks.some((c) => c.type === 'text-delta'), false)
}

console.log('\n[8] GET /status 暴露 loggedInPlatforms')
{
  writeSnapshot('deepseek', { localStorage: { userToken: '{"value":"tok"}' } })
  const A = makeCtx()
  await apply(A.ctx)
  const route = [...A.routes.values()].find((r) => r.path === '/dsh-webin/api')
  const res = await call(route.handler, 'GET', '/dsh-webin/api/status')
  check('状态 200', res.status, 200)
  check('⭐ 有 loggedInPlatforms', Array.isArray(res.json?.loggedInPlatforms), true)
  check('⭐ deepseek 在里面', (res.json?.loggedInPlatforms ?? []).includes('deepseek'), true)
  check('qwen 不在（没登录过）', (res.json?.loggedInPlatforms ?? []).includes('qwen'), false)
}

console.log('\n[9] GET /providers 也带 loggedInPlatforms（设置页要用）')
{
  const A = makeCtx()
  await apply(A.ctx)
  const route = [...A.routes.values()].find((r) => r.path === '/dsh-webin/api')
  const res = await call(route.handler, 'GET', '/dsh-webin/api/providers')
  check('有 loggedInPlatforms', Array.isArray(res.json?.loggedInPlatforms), true)
}

console.log('\n[10] ⭐ client 侧：输入框左侧注册了 LDW 入口')
{
  const client = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  check('⭐ 注册了 conversation.input.left', client.includes('conversation.input.left'), true)
  check('⭐ inject 了该 slot', /inject\("conversation\.input\.left"/.test(client), true)
  check('⭐ register 带 name', /name:\s*"conversation\.input\.left"/.test(client), true)
  check('id 是 ldw-login', /id:\s*"ldw-login"/.test(client), true)
  /** 三个状态文案。 */
  check('⭐ 显示「LDW 已登录」', client.includes('LDW 已登录'), true)
  /**
   * ⚠️ 断言不能写死引号风格 —— 产物会把 `'x'` 压成 `"x"`。
   * 所以用「双引号 + 后面紧跟冒号」这种**带上下文**的判据，
   * 而不是裸的 `'LDW 登录'`（踩过）。
   */
  check('⭐ 显示「LDW 登录」（未登录时催一下）', /"LDW 登录"/.test(client), true)
  check('⭐ 显示「LDW 未就绪」（面板没起）', client.includes('LDW 未就绪'), true)
  /**
   * ⭐ **有标签栏时不渲染**（用户明确要求「图2这个页面不用加LDW登录」）。
   *
   * 判据是 `hasTabs` 驱动 `return null` —— 标签栏存在说明用户能自己
   * 点「LDW」标签，这个按钮就是冗余的。
   */
  check('⭐ 有标签栏时隐藏按钮', /if \(hasTabs\) return null/.test(client), true)
  check('⭐ 用 MutationObserver 盯标签栏出现', /new MutationObserver/.test(client), true)
  /**
   * ⭐ **点击打开设置页**（用户要求：「设置页面加个登录按钮，然后点击按钮
   * 之后自动打开设置界面」）。
   *
   * 之前点击是「切到 LDW 标签」，在新会话空页面上必然失败 ——
   * 因为标签栏是 `tabs.length > 1` 才渲染的。
   */
  check('⭐ 点击打开设置页', /openSettingsAtLdwSection/.test(client), true)
  check('⭐ 找设置模态框（data-shortcut-modal）', client.includes('data-shortcut-modal'), true)
  check('⭐ 按文字找设置按钮', /t === "设置"/.test(client) || /t === '设置'/.test(client), true)
  check('⭐ 有快捷键兜底（Ctrl+,）', /code: "Comma"|code: 'Comma'/.test(client), true)
  check('⭐ 切到 LDW 分区', /t\.includes\("ldw"\)|t\.includes\('ldw'\)/.test(client), true)
  /** 失败要给**具体**原因，不是笼统一句。 */
  check('⭐ 找不到设置按钮时给具体原因', /没找到设置按钮，也没唤出设置页/.test(client), true)
  check('⭐ 没有 LDW 分区时给具体原因', /设置页里没有 LDW 分区/.test(client), true)
  check('⭐ 用 rAF 等 React 提交（不是定时器轮询）', /requestAnimationFrame/.test(client), true)
  check('⭐ 定期刷新登录态', /setInterval/.test(client), true)
  /** 样式。 */
  check('样式含 .ldw-entry', client.includes('.ldw-entry'), true)
  check('⭐ 未登录时用警示色', /\.ldw-entry:has\(\.ldw-dot\.warn\)/.test(client), true)
}

console.log('\n[10b] ⭐ 设置页有登录按钮（用户要求的入口在这）')
{
  const client = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  /** 设置页从 /providers 读登录态。 */
  check('⭐ 读 loggedInPlatforms', client.includes('loggedInPlatforms'), true)
  /** 登录区：一行一个平台，带「去登录」。 */
  check('⭐ 有「登录」分区标题', /"登录"/.test(client), true)
  check('⭐ 有「去登录」按钮', client.includes('去登录'), true)
  check('⭐ 已登录时按钮变「打开浏览器」', client.includes('打开浏览器'), true)
  check('样式含 .ldw-loginrow', client.includes('.ldw-loginrow'), true)
  check('样式含 .ldw-loginrow-name', client.includes('.ldw-loginrow-name'), true)
  /** 说明登录态会持久化（用户最关心重启后还要不要重登）。 */
  check('⭐ 说明登录态会保存', /重启 DSH 后仍有效/.test(client), true)
  /**
   * ⭐ 「去登录」= 切到本插件的浏览器视图。
   * 那是**唯一**能真正输账号密码的地方。
   */
  check('⭐ 去登录会切视图', /switchToLdwView/.test(client), true)
  /** 切视图三条路依次试（精确 → 宽泛 → 兜底）。 */
  check('⭐ 先找标签栏内的 tab', client.includes('data-conversation-tabs'), true)
  /**
   * ⚠️ 产物里选择器是 `"[role=\"tab\"]"` —— 引号被转义了，
   * 所以判据不能写裸的 `[role="tab"]`（踩过）。用 `role=` + `tab` 两段找。
   */
  check('⭐ 兜底找 role=tab', /\[role=\\"tab\\"\]/.test(client), true)
  /** ⚠️ 不能点到自己 —— 否则无限套娃。 */
  check('⭐ 排除自己的按钮（防套娃）', /classList\.contains\("ldw-entry"\)/.test(client), true)
  /** 找不到时说明下一步做什么。 */
  check('⭐ 找不到标签时给下一步', /先发一条消息让会话建立/.test(client), true)
}

console.log('\n[11] client 与 host 用同一套登录判断（不能各写一份）')
{
  const shared = readFileSync(join(ROOT, 'src', 'shared', 'auth-snapshot.ts'), 'utf8')
  check('共用模块存在', shared.includes('snapshotLooksLoggedIn'), true)
  check('有文本入口（host 用）', shared.includes('snapshotTextLooksLoggedIn'), true)
  const client = readFileSync(join(ROOT, 'src', 'client', 'index.ts'), 'utf8')
  check('⭐ client 从 shared 导入（不是本地副本）', /from '\.\.\/shared\/auth-snapshot'/.test(client), true)
  check('⭐ client 没有本地重复定义', /^function snapshotLooksLoggedIn/m.test(client), false)
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
cleanupState()
process.exitCode = fail === 0 ? 0 : 1
