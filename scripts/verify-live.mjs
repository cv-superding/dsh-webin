#!/usr/bin/env node
/**
 * ## 真机验证清单（用户要求「你自己测试吧」）
 *
 * 我之前一直只跑离线单测 —— 那些测的是「代码里写了什么」，
 * **证明不了「跑起来是对的」**。
 *
 * 这个脚本做两件事：
 *
 *   1. **静态**：断言那些「只在真机才暴露」的坑已经修掉
 *      （`eval('require')` 在 ESM 里失败、`shell.overlay` 没有 sessionId 等）
 *   2. **活体**：对**运行中的 host** 打真实请求，报告实际行为
 *
 * 活体部分**不判定通过/失败**（因为 host 可能需要重启），
 * 而是**打印事实** —— 让「现在到底能不能用」一眼可见。
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const BASE = 'http://127.0.0.1:19387'
const TOKEN = 'ueMERfrc9WvsZbW8w78KbR_rOGYGx_IFxOSdwCqrupE'

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

const jarSrc = readFileSync(join(ROOT, 'src', 'host', 'cookie-jar.ts'), 'utf8')
const hostBundle = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')
const clientBundle = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')

console.log('=== 真机验证 ===\n')

console.log('[1] ⭐⭐⭐ ESM 里必须用 createRequire（旧代码死在这，实测发现）')
{
  /**
   * ## 真实事故
   *
   * 第一版写 `const req = eval('require')` —— 在 ESM 下抛
   * `ReferenceError: require is not defined`，被 catch 吞掉 ⇒
   * `tryElectronSession()` 永远返回 undefined。
   *
   * 实测证据：对运行中的 host 打 `POST /client/partition` 得到
   * `{"cookieApi":false}` —— 意味着「重启免登录」**从来没生效过**。
   *
   * 本地复现（纯 node ESM）：
   *   eval('require')            → ReferenceError: require is not defined
   *   createRequire(import.meta.url) → ✅ 可用
   */
  check('⭐ 用 createRequire 而不是 eval', /createRequire\(meta\.url\)/.test(jarSrc), true)
  /** ⚠️ 要排除注释 —— 注释里为说明历史会引用旧写法。 */
  check(
    '⭐⭐ 没有 eval(require)（排除注释）',
    jarSrc
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .some((l) => /eval\(['"]require['"]\)/.test(l)),
    false,
  )
  check('⭐ 导入了 createRequire', /import \{ createRequire \} from 'node:module'/.test(jarSrc), true)
  /** 产物里也要对（源码对了但打包器改写也会出问题）。 */
  check('⭐ 产物里用 createRequire', /createRequire\(meta\.url\)/.test(hostBundle), true)
  check('⭐⭐ 产物里没有 eval("require")', /eval\("require"\)/.test(hostBundle), false)
  /** host 产物必须是 ESM（这决定了上面那条为什么必须这样写）。 */
  check('⭐ host 产物是 ESM（有 import 语句）', /^import \{/.test(hostBundle), true)
}

console.log('\n[2] ⭐⭐ 拿不到 electron 时必须优雅降级')
{
  check('⭐ try/catch 包住', /try \{[\s\S]{0,900}?req\('electron'\)[\s\S]{0,900}?\} catch/.test(jarSrc), true)
  check('⭐ 拿不到返回 undefined', /catch \{\s*return undefined\s*\}/.test(jarSrc), true)
  check('⭐ 探测 req 是不是函数', /if \(typeof req !== 'function'\) return undefined/.test(jarSrc), true)
}

console.log('\n[3] ⭐⭐⭐ 领活过滤方向：以「窗口是否上报」为准')
{
  /**
   * ## 真实事故
   *
   * 我第一版写「任务有 sessionId 就必须匹配」。但跑发送循环的 LdwHost
   * 挂在 `shell.overlay` 上，**那个 slot 没有 sessionId**（只有
   * conversation.view 有）⇒ 窗口永远没身份 ⇒ 任务全被跳过 ⇒
   * 「LDW 面板未连接（20s 内无人领取）」。
   *
   * 实测证据：/status 里两条任务的 `claimedBy` 是 `(未领)`。
   */
  const adapterSrc = readFileSync(join(ROOT, 'src', 'host', 'adapter.ts'), 'utf8')
  check('⭐⭐ 有 hasIdentity 判据', /const hasIdentity = sessionId !== undefined && sessionId !== ''/.test(adapterSrc), true)
  check('⭐⭐ 只有上报了才要求匹配', /if \(hasIdentity && job\.sessionId !== undefined && job\.sessionId !== sessionId\) continue/.test(adapterSrc), true)
  /** 旧写法（恒真 ⇒ 卡死）必须消失。 */
  /** ⚠️ 同样要排除注释。 */
  check(
    '⭐⭐ 没有旧的恒真判据（排除注释）',
    adapterSrc
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .some((l) => /if \(job\.sessionId !== undefined && job\.sessionId !== sessionId\) continue/.test(l)),
    false,
  )
}

console.log('\n[4] ⭐⭐ 发送确认必须重新找输入框（不能读摘除节点）')
{
  const chatSrc = readFileSync(join(ROOT, 'src', 'client', 'chat.ts'), 'utf8')
  check('⭐⭐ 探测里重新 findInput', /function probe\(\) \{[\s\S]{0,300}?var fresh = findInput\(\)/.test(chatSrc), true)
  check('⭐ 用 fresh 而不是旧引用', /var now = readInput\(fresh\)/.test(chatSrc), true)
  check('⭐ 产物里也有', /var fresh = findInput\(\)/.test(clientBundle), true)
}

console.log('\n[5] ⭐ 产物比源码新吗（改了源码没构建 = 用户跑旧代码）')
{
  const { statSync } = await import('node:fs')
  const libT = Math.max(
    statSync(join(ROOT, 'lib', 'index.js')).mtimeMs,
    statSync(join(ROOT, 'lib', 'client.js')).mtimeMs,
  )
  const srcFiles = ['src/host/index.ts', 'src/host/adapter.ts', 'src/host/cookie-jar.ts', 'src/client/index.ts', 'src/client/chat.ts', 'src/client/hook.ts']
  const newestSrc = Math.max(...srcFiles.map((f) => statSync(join(ROOT, f)).mtimeMs))
  check('⭐ 产物不早于源码（否则要重新构建）', libT >= newestSrc, true)
  if (libT < newestSrc) {
    console.log(`       lib 落后 ${Math.round((newestSrc - libT) / 1000)} 秒 —— 跑 npm run build`)
  }
}

console.log('\n[6] 活体检查：对运行中的 host 打真实请求（只报告事实）')
{
  const h = { authorization: `Bearer ${TOKEN}` }
  async function api(path, init) {
    try {
      const r = await fetch(BASE + path, { headers: h, ...init })
      return { status: r.status, body: JSON.parse(await r.text()) }
    } catch (e) {
      return { error: String(e).slice(0, 80) }
    }
  }

  const ver = await api('/dsh-webin/api/version')
  if (ver.error !== undefined) {
    console.log('  ⚠️  host 不可达（DSH 没在跑？）:', ver.error)
  } else {
    console.log(`  运行中的版本: v${ver.body.version} · ${ver.body.commit} · 构建于 ${ver.body.builtAt}`)
    const { execSync } = await import('node:child_process')
    const head = execSync('git rev-parse --short HEAD', { encoding: 'utf8', cwd: ROOT }).trim()
    console.log(`  当前 HEAD  : ${head}`)
    if (ver.body.commit !== head) {
      console.log(`  ⚠️  运行中的提交与 HEAD 不一致 —— **host 半需要重启 DSH 才生效**`)
    }

    const st = await api('/dsh-webin/api/status')
    const s = st.body
    console.log(`  client 在线: ${s.clients?.online}（hasGuest=${s.clients?.detail?.[0]?.hasGuest}）`)
    console.log(`  knownSessions: ${s.knownSessions?.length ?? 0} 个`)
    const jobs = s.jobs ?? []
    console.log(`  队列任务: ${jobs.length} 个`)
    for (const j of jobs.slice(-3)) {
      console.log(`    ${j.id} state=${j.state} claimedBy=${j.claimedBy}`)
    }
    const unclaimed = jobs.filter((j) => j.claimedBy === '(未领)').length
    if (unclaimed > 0) {
      console.log(`  ⚠️  有 ${unclaimed} 个任务从未被领取 —— 若 host 未重启，这可能是旧代码的表现`)
    }

    /** 领活三条路径。 */
    const sid = s.knownSessions?.[0]?.sessionId ?? ''
    const a = await api(`/dsh-webin/api/job/next?platform=deepseek&session=${encodeURIComponent(sid)}`)
    console.log(`  领活（正确会话）: job=${a.body?.job === null ? 'null（队列里没有 pending）' : '领到了'}`)
    const b = await api('/dsh-webin/api/job/next?platform=deepseek&session=other-session')
    console.log(`  领活（错误会话）: job=${b.body?.job === null ? 'null ✅ 没领走别人的' : '⚠️ 领到了！'}`)
    const c = await api('/dsh-webin/api/job/next?platform=deepseek')
    console.log(`  领活（不带会话）: job=${c.body?.job === null ? 'null' : '领到了 ✅ 未上报时放行'}`)

    /** cookie API（重启免登录的关键）。 */
    const p = await api('/dsh-webin/api/client/partition', {
      method: 'POST',
      headers: { ...h, 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'deepseek', partition: 'probe', domain: 'chat.deepseek.com' }),
    })

    /** ⭐ 诊断路由：为什么拿不到 Electron session（不猜）。 */
    const dg = await api('/dsh-webin/api/diagnose/electron')
    if (dg.status === 404) {
      console.log('  诊断路由: 404（host 未重启，新路由还没加载）')
    } else if (dg.body?.ok === true) {
      console.log('  ── Electron 诊断 ──')
      console.log('    import.meta.url 可用:', dg.body.hasImportMetaUrl, dg.body.importMetaUrl.slice(0, 80))
      console.log('    require 类型     :', dg.body.requireKind)
      console.log('    electron 类型    :', dg.body.electronKind)
      console.log('    electron 的键    :', JSON.stringify(dg.body.electronKeys))
      console.log('    hasSession       :', dg.body.hasSession)
      console.log('    hasFromPartition :', dg.body.hasFromPartition)
      console.log('    进程类型         :', dg.body.processType)
      console.log('    electron 版本    :', dg.body.electronVersion)
      if (dg.body.error !== undefined) console.log('    ❌ 错误:', dg.body.error)
    }
    console.log(`  cookieApi: ${p.body?.cookieApi}`)
    if (p.body?.cookieApi === false) {
      console.log('  ⚠️  拿不到 Electron session API —— host 未重启（旧代码用了 eval(require)）')
    }
  }
}

console.log('\n[7] ⭐⭐⭐ 心跳不能因为主线程忙就被判掉线（实测发现）')
{
  /**
   * ## 实测现象（连续采样运行中的 host，每 2 秒一次）
   *
   *     12:06:42  心跳延迟=10943ms
   *     12:06:44  心跳延迟=12975ms
   *     12:06:46  心跳延迟=14985ms
   *     12:06:48  在线 0 个          ← 掉线
   *
   * 延迟每次 +2000ms（正好是采样间隔）⇒ **心跳停了**，不是变慢。
   *
   * 根因：心跳间隔 5s，而掉线阈值只有 15s（容忍漏 2 次）。client 那边
   * 同时跑着 500ms / 1500ms / 5000ms 三个定时器，每个都跨进程
   * `executeJavaScript` ⇒ 主线程一忙心跳就漏 ⇒ 判死。
   */
  const hostSrc = readFileSync(join(ROOT, 'src', 'host', 'index.ts'), 'utf8')
  const clientSrc = readFileSync(join(ROOT, 'src', 'client', 'index.ts'), 'utf8')

  const m = /const CLIENT_STALE_MS = ([\d_]+)/.exec(hostSrc)
  const stale = m === null ? 0 : Number(m[1].replace(/_/g, ''))
  check('⭐ 有 CLIENT_STALE_MS', stale > 0, true)
  check('⭐⭐ 阈值 >= 心跳间隔 × 5（容忍漏 4 次以上）', stale >= 5_000 * 5, true)
  console.log('      CLIENT_STALE_MS = ' + stale + 'ms，心跳 5000ms ⇒ 容忍漏 ' + (Math.floor(stale / 5000) - 1) + ' 次')

  const d = /const DRAIN_INTERVAL_MS = ([\d_]+)/.exec(clientSrc)
  const drain = d === null ? 0 : Number(d[1].replace(/_/g, ''))
  check('⭐ 有 DRAIN_INTERVAL_MS', drain > 0, true)
  check('⭐⭐ drain 间隔 >= 1000ms（原来 500ms 太密）', drain >= 1_000, true)
  console.log('      DRAIN_INTERVAL_MS = ' + drain + 'ms（原来是 500ms，每秒 2 次 IPC）')

  check(
    '⭐⭐ 没有硬编码 500ms 轮询（排除注释）',
    clientSrc
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .some((l) => /\}, 500\)/.test(l)),
    false,
  )
}

console.log(`\n=== 静态检查：${pass} 通过 / ${fail} 失败 ===`)
process.exitCode = fail === 0 ? 0 : 1
