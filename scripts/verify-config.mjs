#!/usr/bin/env node
/**
 * **配置系统**测试。
 *
 * ## 为什么配置要这么严
 *
 * 用户可以在设置页填任意数字。填错了的后果不是「不好用」，而是**账号风险**：
 *   - 发送间隔填 0 ⇒ 秒发 ⇒ 必封
 *   - 超时填 1 秒 ⇒ 每轮都超时
 *   - 工具结果上限填 100 万 ⇒ 输入框顶爆
 *
 * 所以校验必须在 **host 侧**做，而且：
 *   - 超界**回退默认**（不是夹到边界 —— 用户填 999999 说明他想「不限」，
 *     夹到边界反而更危险）
 *   - **逐条报告**被修正的字段（不静默吞掉，否则用户改了没生效会困惑）
 *   - 坏文件**不影响启动**
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
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

console.log('=== 配置系统测试 ===\n')

const cleanupState = isolate('webin-config')
const mod = await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href)
const { apply } = mod

const A = makeCtx()
await apply(A.ctx)
const route = [...A.routes.values()].find((r) => r.path === '/dsh-webin/api')

console.log('\n[1] GET /config 返回设置页需要的四样')
{
  const res = await call(route.handler, 'GET', '/dsh-webin/api/config')
  check('状态 200', res.status, 200)
  check('ok=true', res.json?.ok, true)
  check('⭐ 当前配置', typeof res.json?.config, 'object')
  check('⭐ 默认值（给「恢复默认」用）', typeof res.json?.defaults, 'object')
  check('⭐ 边界（给输入框 min/max）', typeof res.json?.limits, 'object')
  check('⭐ 问题列表', Array.isArray(res.json?.problems), true)
  check('带摘要', typeof res.json?.summary, 'string')
  check('带文件路径（便于排查）', typeof res.json?.path, 'string')

  const c = res.json?.config
  check('含防封号字段', typeof c?.sendDelayMinMs, 'number')
  check('含长休字段', typeof c?.longBreakAfter, 'number')
  check('含行为字段', typeof c?.replyTimeoutMs, 'number')
  check('含工具开关', typeof c?.enableTools, 'boolean')
  check('含诊断开关', typeof c?.verboseLog, 'boolean')

  const limits = res.json?.limits
  check('⭐ 每个数值字段都有边界', typeof limits?.sendDelayMinMs?.min, 'number')
  check('边界带单位', typeof limits?.sendDelayMinMs?.unit, 'string')
  check('边界带中文标签', typeof limits?.sendDelayMinMs?.label, 'string')
}

console.log('\n[2] PUT /config 保存并立刻生效')
{
  const res = await call(
    route.handler,
    'PUT',
    '/dsh-webin/api/config',
    JSON.stringify({ sendDelayMinMs: 5000, sendDelayMaxMs: 9000, verboseLog: true }),
  )
  check('状态 200', res.status, 200)
  check('ok=true', res.json?.ok, true)
  check('⭐ 保存后的值', res.json?.config?.sendDelayMinMs, 5000)
  check('⭐ 布尔也存住', res.json?.config?.verboseLog, true)
  check('未提供的字段保持默认', res.json?.config?.toolResultLimit, 4000)

  // 再读一次，确认真的落盘了
  const again = await call(route.handler, 'GET', '/dsh-webin/api/config')
  check('⭐ 重新读取仍是新值（已落盘）', again.json?.config?.sendDelayMinMs, 5000)
}

console.log('\n[3] ⭐ 非法值必须被拒绝并报告（不是静默吞掉）')
{
  const res = await call(
    route.handler,
    'PUT',
    '/dsh-webin/api/config',
    JSON.stringify({
      sendDelayMinMs: -100, // 负数
      replyTimeoutMs: 999_999_999, // 超上界
      toolResultLimit: 'abc', // 非数字
      enableTools: 'yes', // 非布尔
    }),
  )
  check('状态 200（保存成功，但字段被修正）', res.status, 200)
  check('⭐ 报告了 4 个问题', res.json?.problems?.length, 4)
  check('⭐ 负数回退默认', res.json?.config?.sendDelayMinMs, 2000)
  check('⭐ 超上界回退默认', res.json?.config?.replyTimeoutMs, 600_000)
  check('⭐ 非数字回退默认', res.json?.config?.toolResultLimit, 4000)
  check('⭐ 非布尔回退默认', res.json?.config?.enableTools, false)

  const fields = (res.json?.problems ?? []).map((p) => p.field)
  check('问题里点名字段', fields.includes('sendDelayMinMs'), true)
  check('问题里说明原因', typeof res.json?.problems?.[0]?.reason, 'string')
}

console.log('\n[4] 上下限填反了自动交换（用户意图明确，不必报错）')
{
  const res = await call(
    route.handler,
    'PUT',
    '/dsh-webin/api/config',
    JSON.stringify({ sendDelayMinMs: 9000, sendDelayMaxMs: 3000 }),
  )
  check('⭐ 自动交换', res.json?.config?.sendDelayMinMs, 3000)
  check('⭐ 交换后上限正确', res.json?.config?.sendDelayMaxMs, 9000)
  check('报告了交换这件事', (res.json?.problems ?? []).some((p) => /交换/.test(p.reason)), true)
}

console.log('\n[5] ⭐ 长休机制：0 = 关闭（默认），>0 = 生效')
{
  const res = await call(route.handler, 'PUT', '/dsh-webin/api/config', JSON.stringify({ longBreakAfter: 12 }))
  check('长休次数存住', res.json?.config?.longBreakAfter, 12)
  check('摘要里体现长休', /长休 每12次/.test(res.json?.summary ?? ''), true)

  const off = await call(route.handler, 'PUT', '/dsh-webin/api/config', JSON.stringify({ longBreakAfter: 0 }))
  check('⭐ 0 = 关闭', /长休 关/.test(off.json?.summary ?? ''), true)
}

console.log('\n[6] DELETE /config 恢复默认')
{
  await call(route.handler, 'PUT', '/dsh-webin/api/config', JSON.stringify({ sendDelayMinMs: 7777, verboseLog: true }))
  const res = await call(route.handler, 'DELETE', '/dsh-webin/api/config')
  check('状态 200', res.status, 200)
  check('⭐ 恢复成默认', res.json?.config?.sendDelayMinMs, 2000)
  check('⭐ 布尔也恢复', res.json?.config?.verboseLog, false)

  const again = await call(route.handler, 'GET', '/dsh-webin/api/config')
  check('⭐ 重新读取是默认值', again.json?.config?.sendDelayMinMs, 2000)
}

console.log('\n[7] ⭐ 坏配置文件不能让插件挂掉')
{
  const cfgPath = join(process.env.DSH_HOME, 'webin', 'config.json')
  writeFileSync(cfgPath, '{ 这不是合法 JSON', 'utf8')

  const res = await call(route.handler, 'GET', '/dsh-webin/api/config')
  check('⭐ 读取不抛错', res.status, 200)
  check('⭐ 回退默认值', res.json?.config?.sendDelayMinMs, 2000)
  check('⭐ 明确报告文件坏了', (res.json?.problems ?? []).some((p) => p.field === '(file)'), true)
}

console.log('\n[8] 未知字段被丢弃（配置文件不会越写越乱）')
{
  await call(route.handler, 'DELETE', '/dsh-webin/api/config')
  const res = await call(
    route.handler,
    'PUT',
    '/dsh/webin/api/config'.replace('/dsh/webin', '/dsh-webin'),
    JSON.stringify({ sendDelayMinMs: 3000, 恶意字段: 'x', __proto__: { polluted: true } }),
  )
  check('状态 200', res.status, 200)
  check('已知字段存住', res.json?.config?.sendDelayMinMs, 3000)
  check('⭐ 未知字段没进配置', Object.prototype.hasOwnProperty.call(res.json?.config ?? {}, '恶意字段'), false)
  check('⭐ 没有原型污染', ({}).polluted, undefined)
}

console.log('\n[9] client 侧：配置真的接进了行为')
{
  const client = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  check('⭐ 启动时拉配置', client.includes('/config'), true)
  check('⭐ 发送间隔从配置读', /pickSendDelay\(.*sendDelayMinMs/.test(client), true)
  check('⭐ 长休接进发送循环', client.includes('noteRequestDone'), true)
  check('⭐ 单轮请求上限接进发送循环', client.includes('canSendThisTurn'), true)
  check('⭐ 快照间隔从配置读', /snapshotIntervalMs/.test(client), true)
  check('⭐ 有配置刷新函数（保存后立刻生效）', client.includes('refreshConfig'), true)

  const host = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')
  check('⭐ host 每轮读配置（改完立刻生效）', /getConfig:\s*\(\)\s*=>/.test(host), true)
  check('⭐ 工具开关接进 toolSection', /enableTools/.test(host), true)
  check('⭐ 工具结果截断接配置', /toolResultLimit/.test(host), true)
}

console.log('\n[10] 设置页渲染出配置表单（防 React #130）')
{
  const clientSrc = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  const React = {
    createElement(type, props, ...children) {
      return { $$typeof: Symbol.for('react.element'), type, props: { ...(props ?? {}), children }, key: null }
    },
  }
  const hooks = {
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useMemo: (fn) => fn(),
    useEffect: () => {},
    useLayoutEffect: () => {},
    useRef: (init) => ({ current: init ?? null }),
    useCallback: (fn) => fn,
  }
  let captured = null
  const fakeRequire = (name) => (name === 'react' ? { ...React, ...hooks } : {})
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'navigator', 'fetch', clientSrc)(
    { __ModuleLoader__: { load: (d) => (captured = d) } },
    { head: { appendChild() {} }, createElement: () => ({ style: {}, remove() {} }), addEventListener() {} },
    { userAgent: 'node' },
    async () => ({ json: async () => ({}) }),
  )
  const exports = captured.factory(fakeRequire)
  let el = null
  let err = null
  try {
    el = exports.LdwSettings()
  } catch (error) {
    err = error.message
  }
  check('⭐ 渲染不抛错', err, null)
  check('⭐ 返回 React 元素', el?.$$typeof, Symbol.for('react.element'))

  const bad = []
  const walk = (n) => {
    if (n === null || n === undefined || typeof n === 'boolean') return
    if (typeof n === 'string' || typeof n === 'number') return
    if (Array.isArray(n)) return n.forEach(walk)
    if (n.$$typeof !== Symbol.for('react.element')) return bad.push(Object.keys(n).join(','))
    walk(n.props?.children)
  }
  walk(el)
  check('⭐ 子树无非法节点', bad, [])
}

cleanupState()
console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
process.exitCode = fail === 0 ? 0 : 1
/** ⚠️ 显式退出 —— 防 handle 悬挂把 npm run check 卡死（verify-lifecycle 实测踩过）。 */
process.exit(process.exitCode)
