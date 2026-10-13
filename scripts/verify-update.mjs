#!/usr/bin/env node
/**
 * ## 更新检查逻辑（用户报「貌似有bug」的那块）
 *
 * 这里测的是**行为**，不是源码模式 —— 因为更新检查的 bug 全是逻辑错，
 * 不是「忘了加某个关键字」。
 *
 * 做法：把 `checkForUpdate` 的源码抽出来，喂**假的 GitHub 响应**，
 * 断言它给出的结论。网络层用假 fetch 替换。
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const verSrc = readFileSync(join(ROOT, 'src', 'shared', 'version.ts'), 'utf8')
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

console.log('=== 更新检查逻辑 ===\n')

/**
 * 把 `checkForUpdate` 抽成可调用函数。
 *
 * ## ⚠️ 不要手写「去类型标注」的正则
 *
 * 我一开始手写正则剥 TS 类型，连着踩了两次：
 *   1. 只处理了函数签名 ⇒ 函数体里的 `as {...}` 报 `Unexpected identifier 'as'`
 *   2. 补了 `as` 但漏了可选参数 `repo?:` ⇒ `Unexpected token '?'`
 *
 * TS 的类型语法形态太多，手写正则必然漏。**用项目自己的构建产物** ——
 * `lib/index.js` 里已经有编译好的 `checkForUpdate`（JS），直接抽它。
 * 这样测的就是**真正在跑的那份代码**，比从 TS 源码转译更可信。
 */
function buildCheckForUpdate(mineCommit, fetchImpl) {
  const hostBundle = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')

  /** 切出编译后的函数体（到下一个顶层 `function` 或 `/**` 为止）。 */
  const start = hostBundle.indexOf('async function checkForUpdate(')
  if (start < 0) throw new Error('产物里找不到 checkForUpdate —— 先跑 npm run build')
  /** 找函数结尾：从 start 起做花括号配对。 */
  const braceStart = hostBundle.indexOf('{', start)
  let depth = 0
  let end = braceStart
  for (let i = braceStart; i < hostBundle.length; i += 1) {
    const ch = hostBundle[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) { end = i + 1; break }
    }
  }
  const body = hostBundle.slice(start, end)

  const prelude = `
    const __mine = ${JSON.stringify(mineCommit)}
    function currentVersion() { return { version: '0.1.0', commit: __mine, repo: 'cv-superding/dsh-webin' } }
    const setTimeout = globalThis.setTimeout
    const clearTimeout = globalThis.clearTimeout
    const AbortController = globalThis.AbortController
    const fetch = __fetch
  `
  // eslint-disable-next-line no-new-func
  const factory = new Function('__fetch', `${prelude}\n${body}\nreturn checkForUpdate`)
  return factory(fetchImpl)
}

/** 造一个假的 fetch：按 URL 返回预设响应。 */
function fakeFetch(handler) {
  return async (url, init) => {
    const r = handler(String(url), init)
    if (r instanceof Error) throw r
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
    }
  }
}

console.log('[1] ⭐ 正常：远端有更新的提交（behind）')
{
  const fn = buildCheckForUpdate('aaaaaaa', fakeFetch(() => ({
    status: 200,
    body: {
      status: 'behind',
      commits: [
        { sha: 'bbbbbbb1', commit: { message: 'feat: 第一', committer: { date: '2026-01-01T00:00:00Z' } } },
        { sha: 'ccccccc2', commit: { message: 'fix: 最新', committer: { date: '2026-01-02T00:00:00Z' } } },
      ],
    },
  })))
  const r = await fn()
  check('ok', r.ok, true)
  check('⭐ behind', r.behind, true)
  check('⭐ same 为 false', r.same, false)
  check('取远端**最后**一个提交', r.latestCommit, 'ccccccc')
  check('带提交说明', r.latestMessage, 'fix: 最新')
  check('带时间', r.latestAt, '2026-01-02T00:00:00Z')
}

console.log('\n[2] ⭐⭐ 本地比远端新（自己提交了没推）—— 不该报「有更新」')
{
  /**
   * ## 真实 bug
   *
   * 早期判据是「提交号不等即有更新」，于是这种情况误报「有更新」。
   * 用户会去 `git pull`，然后发现什么都没变 —— 白折腾。
   */
  const fn = buildCheckForUpdate('aaaaaaa', fakeFetch(() => ({
    status: 200,
    body: { status: 'ahead', ahead_by: 2, behind_by: 0, commits: [] },
  })))
  const r = await fn()
  check('ok', r.ok, true)
  check('⭐⭐ behind 为 false（不报有更新）', r.behind, false)
  check('⭐ ahead 为 true', r.ahead, true)
}

console.log('\n[3] ⭐ 完全一致（identical）')
{
  const fn = buildCheckForUpdate('aaaaaaa', fakeFetch(() => ({
    status: 200,
    body: { status: 'identical', ahead_by: 0, behind_by: 0, commits: [] },
  })))
  const r = await fn()
  check('same 为 true', r.same, true)
  check('behind 为 false', r.behind, false)
  check('ahead 为 false', r.ahead, false)
}

console.log('\n[4] ⭐ 分叉（diverged）—— 报有更新，让用户自己判断')
{
  const fn = buildCheckForUpdate('aaaaaaa', fakeFetch(() => ({
    status: 200,
    body: {
      status: 'diverged',
      ahead_by: 1,
      behind_by: 3,
      commits: [{ sha: 'ddddddd9', commit: { message: '远端的新提交', committer: { date: '2026-01-03T00:00:00Z' } } }],
    },
  })))
  const r = await fn()
  check('⭐ behind 为 true（分叉也算有更新）', r.behind, true)
  check('带远端提交号', r.latestCommit, 'ddddddd')
}

console.log('\n[5] ⭐⭐ 404 + 本地提交号 → 说明是「本地更新」而不是网络错')
{
  /**
   * ## 真实场景
   *
   * 用户自己 commit 过（或远端 force-push 过），本地提交号在远端**不存在**。
   * compare API 会返回 404。
   *
   * 早期直接把 404 当成「GitHub 返回 404」报错 —— 用户以为仓库没了。
   */
  const fn = buildCheckForUpdate('aaaaaaa', fakeFetch(() => ({ status: 404, body: {} })))
  const r = await fn()
  check('⭐ ok 仍为 true（不是错误）', r.ok, true)
  check('⭐ ahead 为 true', r.ahead, true)
  check('⭐ 说明文字讲清了原因', /未推送/.test(r.latestMessage ?? ''), true)
}

console.log('\n[6] ⭐⭐ 超时必须报「超时」而不是干等')
{
  /**
   * ## 真实 bug（用户报的「插件更新的逻辑貌似有bug」）
   *
   * 早期 `await fetch(...)` 没有超时。GitHub 在国内经常**连不上但不立刻
   * 报错** ⇒ 设置页按钮永远转圈。
   */
  const fn = buildCheckForUpdate(
    'aaaaaaa',
    /** 永不 resolve，只在 abort 时抛 AbortError（模拟真实 fetch 的行为）。 */
    (_url, init) =>
      new Promise((_resolve, reject) => {
        const sig = init?.signal
        if (sig) {
          sig.addEventListener('abort', () => {
            const e = new Error('aborted')
            e.name = 'AbortError'
            reject(e)
          })
        }
      }),
  )
  const t0 = Date.now()
  const r = await fn(undefined, 300)
  const took = Date.now() - t0
  check('ok 为 false', r.ok, false)
  check('⭐ 明确说是超时', /超时/.test(r.reason ?? ''), true)
  check('⭐ 提到网络无法访问 GitHub', /GitHub/.test(r.reason ?? ''), true)
  check('⭐ 真的在超时时间内返回（不是干等）', took < 2_000, true)
}

console.log('\n[7] ⭐ 网络错误（非超时）要原样报出来')
{
  const fn = buildCheckForUpdate('aaaaaaa', fakeFetch(() => new Error('getaddrinfo ENOTFOUND')))
  const r = await fn()
  check('ok 为 false', r.ok, false)
  check('带原始错误', /ENOTFOUND/.test(r.reason ?? ''), true)
  check('⭐ 不误报成超时', /超时/.test(r.reason ?? ''), false)
}

console.log('\n[8] ⭐ 本地提交号 unknown → 退回 commits/main，且不判定落后')
{
  const fn = buildCheckForUpdate('unknown', fakeFetch((url) => {
    check('⭐ 打的是 commits/main 而不是 compare', /\/commits\/main$/.test(url), true)
    return {
      status: 200,
      body: {
        sha: 'eeeeeee5',
        commit: { message: 'chore: 最新', committer: { date: '2026-02-01T00:00:00Z' } },
      },
    }
  }))
  const r = await fn()
  check('ok', r.ok, true)
  check('⭐ behind 为 false（无从比较就不报更新）', r.behind, false)
  check('报告远端最新', r.latestCommit, 'eeeeeee')
}

console.log('\n[9] ⭐ 用的是 compare API（能判断方向）')
{
  let seen = ''
  const fn = buildCheckForUpdate('aaaaaaa', fakeFetch((url) => {
    seen = url
    return { status: 200, body: { status: 'identical', commits: [] } }
  }))
  await fn()
  check('⭐ URL 含 compare/<mine>...main', /\/compare\/aaaaaaa\.\.\.main$/.test(seen), true)
}

console.log('\n[10] ⭐ 请求头：不带任何凭据')
{
  let headers = {}
  const fn = buildCheckForUpdate('aaaaaaa', fakeFetch((_url, init) => {
    headers = init?.headers ?? {}
    return { status: 200, body: { status: 'identical', commits: [] } }
  }))
  await fn()
  check('⭐ 没有 authorization 头', Object.keys(headers).some((k) => /authorization/i.test(k)), false)
  check('带 accept', String(headers.accept ?? '').includes('github'), true)
  check('带 user-agent', typeof headers['user-agent'], 'string')
}

console.log('\n[11] ⭐ 源码层面：describeUpdate 覆盖四种状态')
{
  const d = verSrc.slice(verSrc.indexOf('export function describeUpdate'))
  check('same → 已是最新', /check\.same === true\) return `已是最新/.test(d), true)
  check('⭐ ahead → 本地更新', /check\.ahead === true\) return `本地更新/.test(d), true)
  check('behind → 有新版本', /check\.behind === true/.test(d), true)
  check('兜底 → 状态未知', /状态未知/.test(d), true)
}

console.log('\n[12] ⭐⭐ 客户端「检查更新」也必须带超时')
{
  /**
   * host 侧那次 GitHub 请求有 10 秒超时，但如果 **host 整个卡住**，
   * 客户端这个 fetch 会永远挂着 ⇒ 按钮永远「检查中…」。
   */
  const seg = clientSrc.slice(clientSrc.indexOf('const loadVersion = useMemo'))
  /** ⚠️ 窗口要够大 —— 这段实际约 2600 字符（踩过：写 1200 匹配不到 updateSummary）。 */
  const firstFetch = seg.slice(0, 3_000)
  check('⭐ 用 fetchJson（带超时）', /fetchJson\(`\$\{LDW_API\}\/version/.test(firstFetch), true)
  check('⭐ 没有裸 fetch', /await fetch\(`\$\{LDW_API\}\/version/.test(firstFetch), false)
  check('⭐ 超时后有明确提示', /检查失败：请求超时/.test(firstFetch), true)
  check('⭐ 用了 host 的 updateSummary', /updateSummary/.test(firstFetch), true)
  /** 四种状态都要能显示出来（不能只区分「有/无更新」）。 */
  check('⭐ 显示 ahead 状态', /本地更新（远端还没有你的提交）/.test(firstFetch), true)
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
process.exitCode = fail === 0 ? 0 : 1
