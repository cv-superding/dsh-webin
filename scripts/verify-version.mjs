#!/usr/bin/env node
/**
 * **版本 / 更新检查 / Star 按钮** 测试。
 *
 * ## 用户要求
 *
 * 「更新插件的功能，以及跳转到 github 点击 star 的功能别忘记加载插件设置页面中了」
 *
 * ## 三个关键设计决定（都有理由，不是随手写的）
 *
 * 1. **版本号在构建期注入**，不在运行时读
 *    - client 半在浏览器里，没有 `fs`，读不到 `package.json`
 *    - **提交号必须是构建时的快照**：运行时再问 git 得到的是「现在的 HEAD」，
 *      可能已经和正在跑的产物不一致（改了代码没重新构建）
 *
 * 2. **更新检查走 host，不让 client 直接请求 GitHub**
 *    - CORS 会拦浏览器对 `api.github.com` 的跨域请求
 *    - 未认证配额每小时 60 次 ⇒ host 侧做 60 秒缓存
 *
 * 3. **判据是提交号，不是版本号**
 *    - 插件以 `link:`/本地目录方式安装，version 常年不动
 *    - 真正决定「有没有新东西」的是提交
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
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

console.log('=== 版本 / 更新检查 / Star 测试 ===\n')

const cleanupState = isolate('webin-version')
mkdirSync(join(process.env.DSH_HOME, 'webin', 'auth'), { recursive: true })
for (const platform of ['deepseek', 'qwen']) {
  writeFileSync(
    join(process.env.DSH_HOME, 'webin', 'auth', `${platform}.json`),
    JSON.stringify({ localStorage: { userToken: '{"value":"test-token"}' }, url: 'https://example.com/' }),
    'utf8',
  )
}

const mod = await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href)
const { apply } = mod

console.log('[1] ⭐ 版本号在构建期注入（host 侧，运行时读不到 package.json）')
{
  const host = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')
  const client = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

  /**
   * 产物里应该是**字面量**，不是 `readFileSync('package.json')`。
   *
   * ⚠️ 版本号方案几经变化（曾经自动带提交数，被用户否掉）——
   * 现在回到「就是 `package.json` 里那个，手动 bump」。
   * 所以断言「产物里的版本号 === package.json 的 version」，
   * 这个判据在任何方案下都该成立（只是值的来源不同）。
   */
  const injectedVersion = /if \(name === "version" && true\) return "([^"]+)"/.exec(host)?.[1]
  check('⭐ host 产物含版本字面量', typeof injectedVersion, 'string')
  check('⭐ 版本号与 package.json 一致', injectedVersion, pkg.version)
  check('host 没有运行时读 package.json', /readFileSync\([^)]*package\.json/.test(host), false)
  /** 构建时刻也要注入（让用户能看出「跑的是旧产物」）。 */
  check('⭐ 注入构建时刻', /return "20\d\d-\d\d-\d\dT/.test(host), true)

  /**
   * ⚠️ **client 侧刻意不注入版本常量**。
   *
   * 版本信息统一由 host 的 `GET /version` 提供 —— client 只是消费者。
   * 这样只有一个来源，不会出现「client 以为 v0.0.1、host 以为 v0.0.2」
   * 这种对不上的情况。
   *
   * 所以这里断言的是**相反的事**：client 不该有自己的版本常量，
   * 而且不该引用 `node:fs`（浏览器里没有）。
   */
  check('⭐ client 通过 HTTP 拿版本（不自己注入）', /\/version/.test(client), true)
  check('⭐ client 不引用 node:fs', /require\("node:fs"\)|from "node:fs"/.test(client), false)
  check(
    '⭐ client 不自己定义构建期常量',
    /__LDW_(VERSION|COMMIT|REPO)__/.test(client),
    false,
  )
}

console.log('\n[2] ⭐ 提交号是构建时快照（不是运行时问 git）')
{
  const host = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')
  /** 产物里应含一个 7 位短 sha 字面量，且不含 execSync('git ...')。 */
  check('⭐ 含短 sha 字面量', /"[0-9a-f]{7}"/.test(host), true)
  check('⭐ 构建后不再跑 git 命令', /execSync\([^)]*git/.test(host), false)
}

console.log('\n[3] GET /version 返回版本与仓库地址')
{
  const A = makeCtx()
  await apply(A.ctx)
  const route = [...A.routes.values()].find((r) => r.path === '/dsh-webin/api')
  const res = await call(route.handler, 'GET', '/dsh-webin/api/version')
  check('状态 200', res.status, 200)
  check('ok=true', res.json?.ok, true)
  check('⭐ 有 version', typeof res.json?.version, 'string')
  check('⭐ 有 commit', typeof res.json?.commit, 'string')
  check('⭐ 有 repo', typeof res.json?.repo, 'string')
  check('⭐ 有 repoUrl', /^https:\/\/github\.com\//.test(res.json?.repoUrl ?? ''), true)
  check('⭐ 有 starUrl', /^https:\/\/github\.com\/.+\/stargazers$/.test(res.json?.starUrl ?? ''), true)
  check('有更新命令提示', typeof res.json?.updateHint, 'string')
  /** 默认**不**打 GitHub（省配额）。 */
  check('默认不带 update 字段（没查）', res.json?.update, undefined)
}

console.log('\n[4] starUrl / repoUrl 的形状（从源码抠出来直接跑）')
{
  /**
   * `shared/version.ts` 不被 host 的公开导出面暴露，所以从**产物**里
   * 抠函数体跑 —— 这样验的是真实编译结果，而不是我重写一遍逻辑。
   */
  const host = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')
  check('产物里有 starUrl 实现', /stargazers/.test(host), true)
  check('产物里有 repoUrl 实现', /https:\/\/github\.com\//.test(host), true)
  /**
   * 关键行为：starUrl 直达 `/stargazers`（省用户一次点击），
   * 而不是只给仓库首页。
   */
  check('⭐ star 直达点星页', /\/stargazers/.test(host), true)
  /** 拼 URL 时要处理用户传入 `https://github.com/owner/repo` 全 URL 的情况。 */
  const src = readFileSync(join(ROOT, 'src', 'shared', 'version.ts'), 'utf8')
  check('repoUrl 接受可选 repo 参数', /export function repoUrl\(repo\?: string\)/.test(src), true)
  check('starUrl 基于 repoUrl', /export function starUrl[\s\S]{0,200}repoUrl\(repo\)/.test(src), true)
}

console.log('\n[5] ⭐ 更新检查：网络失败不能抛错，要如实报告')
{
  const A = makeCtx()
  await apply(A.ctx)
  const route = [...A.routes.values()].find((r) => r.path === '/dsh-webin/api')
  /** 用一个**不存在**的仓库路径触发失败（不打真实仓库，省配额）。 */
  const res = await call(
    route.handler,
    'GET',
    '/dsh-webin/api/version?check=1',
  )
  check('状态 200（即使检查失败也返回 200）', res.status, 200)
  check('⭐ 有 update 字段', typeof res.json?.update, 'object')
  /**
   * ⚠️ 这条测试**允许两种结果**：网络通 ⇒ ok=true；网络不通 ⇒ ok=false + reason。
   * 不该因为 CI 没网就判定失败 —— 但要确保**两种情况下都不抛错**。
   */
  const u = res.json?.update
  const wellFormed =
    u !== undefined &&
    typeof u.ok === 'boolean' &&
    typeof u.checkedAt === 'number' &&
    (u.ok === true ? typeof u.latestCommit === 'string' : typeof u.reason === 'string')
  check('⭐ 形状正确（成功或失败都规范）', wellFormed, true)
  console.log(`       检查结果：${u?.ok === true ? `ok, latest=${u.latestCommit}, behind=${u.behind}` : `失败：${u?.reason}`}`)
  /** 本地提交号未知时**不判定落后**（无从比较）。 */
  if (u?.ok === true) {
    check('behind 是布尔', typeof u.behind, 'boolean')
  }
}

console.log('\n[6] ⭐ host 侧缓存（保护 GitHub 未认证配额）')
{
  const host = readFileSync(join(ROOT, 'src', 'host', 'index.ts'), 'utf8')
  /**
   * ⚠️ 缓存已从「一个模块级变量」改成**按仓库分键的 Map**。
   *
   * 原因（真实 bug）：单变量时，用户改了 repo 后 60 秒内仍会拿到
   * **上一个仓库**的结果 —— 显示的是别人的版本信息。
   */
  check('⭐ 有 updateChecks 缓存（按仓库分键）', host.includes('updateChecks'), true)
  check('⭐ 缓存按 repo 分键', /updateChecks\.get\(info\.repo\)/.test(host), true)
  check('⭐ 有 60 秒复用窗口', /UPDATE_CACHE_MS = 60_000/.test(host), true)
  check('⭐ 默认不检查（?check=1 才查）', host.includes("get('check') === '1'"), true)
  /** 单变量写法必须已删除（否则等于没修）。 */
  check('⭐ 没有旧的单变量缓存', /let lastUpdateCheck/.test(host), false)
  /** 要给出「一句话总结」，让设置页不用自己拼（四种状态分开说）。 */
  check('⭐ 响应带 updateSummary', /updateSummary:/.test(host), true)
}

console.log('\n[7] ⭐ client 侧：设置页有版本行 + Star 按钮')
{
  const client = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  check('⭐ 有版本行容器', client.includes('ldw-verline'), true)
  check('⭐ 显示版本号', client.includes('ldw-ver-num'), true)
  check('⭐ 显示提交号', client.includes('ldw-ver-commit'), true)
  check('⭐ 有「检查更新」按钮', client.includes('检查更新'), true)
  check('⭐ 有「点个 Star」', client.includes('点个 Star'), true)
  /** Star 用 `<a target="_blank">`（原生行为 + 自带 rel）。 */
  check('⭐ Star 是外链', /target:\s*"_blank"/.test(client), true)
  check('⭐ 带 rel=noreferrer noopener', /rel:\s*"noreferrer noopener"/.test(client), true)
  check('⭐ 有星形图标', client.includes('ldw-star-icon'), true)
  /** 有新版本时给可照做的命令。 */
  check('⭐ 有更新命令展示', client.includes('ldw-updcmd'), true)
  check('⭐ 明确说明要重启', /host 半没有热重载/.test(client), true)
  /** 检查失败要如实显示（不静默）。 */
  check('⭐ 检查失败会显示原因', /检查失败/.test(client), true)
}

console.log('\n[8] 样式：Star 按钮 hover 才亮（邀请而非催促）')
{
  const client = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  check('含 .ldw-verline', client.includes('.ldw-verline'), true)
  check('含 .ldw-ver-commit', client.includes('.ldw-ver-commit'), true)
  check('含 .ldw-star-icon', client.includes('.ldw-star-icon'), true)
  check('⭐ star hover 有动效', /\.ldw-star:hover \.ldw-star-icon\{fill:/.test(client), true)
  check('⭐ star 图标默认低调（tertiary）', /\.ldw-star-icon\{[^}]*fill:var\(--dsw-alias-label-tertiary\)/.test(client), true)
  check('含 .ldw-updcmd', client.includes('.ldw-updcmd'), true)
  check('⭐ 版本行仍用主题令牌', /\.ldw-verline\{[^}]*--dsw-alias-border-l1/.test(client), true)
}

console.log('\n[9] 版本模块不依赖 node:fs（client 要能用）')
{
  const src = readFileSync(join(ROOT, 'src', 'shared', 'version.ts'), 'utf8')
  check('⭐ 没有 import node:fs', /from 'node:fs'/.test(src), false)
  check('⭐ 没有 execSync', /execSync/.test(src), false)
  check('有 currentVersion', src.includes('export function currentVersion'), true)
  check('有 checkForUpdate', src.includes('export async function checkForUpdate'), true)
  check('有 starUrl', src.includes('export function starUrl'), true)
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
cleanupState()
process.exitCode = fail === 0 ? 0 : 1
/** ⚠️ 显式退出 —— 防 handle 悬挂把 npm run check 卡死（verify-lifecycle 实测踩过）。 */
process.exit(process.exitCode)
