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
  /**
   * ⚠️ 断言改过：原来是「单个 req('electron') 在 try 内」。
   *
   * 实测发现**单策略不够** —— `createRequire(import.meta.url)` 在 DSH 里
   * 抛 `Cannot find module 'electron'`（插件 host 跑在 utility 进程，
   * 没有主进程专属的 session API）。改成多策略后判据也变了。
   */
  check(
    '⭐⭐ 每个策略单独 try（失败试下一条）',
    /for \(const get of strategies\) \{\s*try \{/.test(jarSrc),
    true,
  )
  check(
    '⭐⭐ 判据是 session.fromPartition',
    /fromPartition !== undefined\) return electron\.session/.test(jarSrc),
    true,
  )
  check('⭐ 多条策略', (jarSrc.match(/createRequire\(/g) ?? []).length >= 2, true)
  check('⭐ 拿不到返回 undefined', /return undefined\s*\n\}/.test(jarSrc), true)
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


console.log('\n[8] ⭐⭐⭐ 心跳里的诊断字段不能被 handler 丢掉')
{
  /**
   * ## 真实事故
   *
   * client 侧 payload 里明明有 `scrape`（产物核对过），但 /status
   * 永远看不到 —— 因为 host 的 heartbeat handler 是**手工挑字段**
   * 重新组装 beats 的，加类型时忘了同步 handler。
   *
   * 这类 bug 的特征：**类型上有字段 ≠ 运行时会保留**。
   * 所以断言要直接查 handler 里有没有真的存进去。
   */
  const hostSrc = readFileSync(join(ROOT, 'src', 'host', 'index.ts'), 'utf8')

  /** 找到 heartbeat handler 里 beats.set 的那段。 */
  const i = hostSrc.indexOf('beats.set(clientId, {')
  check('找到 heartbeat 的 beats.set', i > 0, true)
  const seg = hostSrc.slice(i, i + 900)

  check('⭐⭐ handler 里存了 scrape', /scrape: payload\.scrape/.test(seg), true)
  /** /status 的 detail 也要暴露它。 */
  check('⭐⭐ /status 暴露 scrape', /scrape: c\.scrape/.test(hostSrc), true)

  /** 产物里也要在（源码对了但没构建 = 用户跑旧代码）。 */
  const bundle = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')
  check('⭐⭐ 产物里 handler 存 scrape', /scrape: payload\.scrape/.test(bundle), true)
  check('⭐⭐ 产物里 /status 暴露 scrape', /scrape: c\.scrape/.test(bundle), true)
}


console.log('\n[9] ⭐⭐⭐ 自动重载 v2：判据是 rev 变化（修复每 2 秒死循环）')
{
  /**
   * ## 用户的话 + 群友实测
   *
   * 「你再仔细检查一下，老是让我重启啥意思」
   * 群友：**面板每 2~2.2 秒无限重载，甚至拖崩 DSH 桌面端**。
   *
   * ## v1 判据为什么死循环
   *
   * 面板上报烘死的 `clientBuiltAt`，host 比 `mtime`，差 5 秒以上回 reload。
   * 但 builtAt 在**构建开始**算、client.js 在**构建末尾**写盘 ——
   * 机器稍慢差值就超容差 ⇒ **永远判定落后** ⇒ 每次心跳都 reload。
   *
   * ## v2 判据：rev 变化 —— 自收敛
   *
   * host 每次心跳回包都带 `bundleRev`；面板第一次记下来，
   * 之后 rev **变了**才 reload。reload 后拿到新 bundle ⇒ 记下的 rev
   * 更新 ⇒ 停止。不需要持久化（模块级变量随 reload 重建，正好重置）。
   */
  const hostSrc = readFileSync(join(ROOT, 'src', 'host', 'index.ts'), 'utf8')
  const clientSrc = readFileSync(join(ROOT, 'src', 'client', 'index.ts'), 'utf8')

  /** ⚠️ v1 判据必须彻底消失（它就是死循环的根源）。 */
  check(
    '⭐⭐⭐ v1 死循环判据已删（mtime - mine > 5_000）',
    hostSrc.includes('st.mtimeMs - mine > 5_000'),
    false,
  )
  check(
    '⭐⭐⭐ v1 上报已删（clientBuiltAt: CLIENT_BUILT_AT）',
    clientSrc.includes('clientBuiltAt: CLIENT_BUILT_AT'),
    false,
  )
  check('⭐⭐ v2 声明 loadedBundleRev', /const loadedBundleRev: \{ current: string \| null \}/.test(clientSrc), true)
  check('⭐⭐ v2 第一次心跳先记录 rev', /loadedBundleRev\.current === null\) \{[\s\S]{0,200}?loadedBundleRev\.current = j\.bundleRev/.test(clientSrc), true)
  check('⭐⭐ v2 rev 变了才重载', /loadedBundleRev\.current === j\.bundleRev\) return/.test(clientSrc), true)
  check('⭐⭐ client 收到变化才重载', /window\.location\.reload\(\)/.test(clientSrc), true)
  /** ⚠️ 有任务在跑时不能重载（会打断生成中的回复）。 */
  check(
    '⭐⭐ 有任务在跑时不重载',
    /if \(pendingJobRef\.current !== undefined\) \{[\s\S]{0,200}?return/.test(clientSrc),
    true,
  )

  check('⭐⭐ host 每次心跳都带 bundleRev', /bundleRev,/.test(hostSrc), true)
  check('⭐⭐ host 用与 DSH 相同的 rev 算法', /plugin-artifact/.test(hostSrc), true)
  check('⭐⭐ host 算产物路径', /function clientBundlePath\(\)/.test(hostSrc), true)

  /** 产物里也要在。 */
  const hb = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')
  const cb = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  check('⭐⭐ 产物 host 带 bundleRev', /bundleRev/.test(hb), true)
  check('⭐⭐ 产物 client 有 loadedBundleRev', /loadedBundleRev/.test(cb), true)
  check('⭐⭐ 产物 client 无 v1 上报', cb.includes('clientBuiltAt:'), false)
}


console.log('\n[10] ⭐⭐ 页面结构报告要能列出「有内容的容器」')
{
  /**
   * ## 上一份报告的结论（推动这次增强）
   *
   *     needle 命中数: 0        ← 那段文字不在页面上
   *     .ds-markdown        → 0
   *     [class*="markdown"] → 0
   *     [class*="content"]  → 5     ← 只有这个有
   *     [class*="ds-"]      → 589   ← ds- 类名体系存在
   *     main / [role=main]  → 0
   *
   * 类名体系是 ds-*，但**回复容器的类名不在我猜的那批里**。
   * 继续猜没意义 —— 直接问页面「哪些元素有较长的文本」。
   */
  const domSrc = readFileSync(join(ROOT, 'src', 'client', 'dom-report.ts'), 'utf8')
  check('⭐⭐ 导出 rich（有文本的元素）', /rich: rich\.slice\(0, 12\)/.test(domSrc), true)
  check('⭐ 按文本长度排序', /rich\.sort\(function \(a, b\) \{ return b\.len - a\.len/.test(domSrc), true)
  /** 只取「叶子级」的，否则全是 body（没信息量）。 */
  check('⭐⭐ 过滤掉「子元素更长」的容器', /hasRicher/.test(domSrc), true)
  check('⭐ 导出页面文本总量', /bodyTextLen: bodyText\.length/.test(domSrc), true)

  const cb = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  check('⭐⭐ 产物里有 rich', /rich: rich\.slice/.test(cb), true)
  check('⭐⭐ 产物里有 bodyTextLen', /bodyTextLen/.test(cb), true)
}


console.log('\n[11] ⭐⭐⭐ 注入式自检：不依赖 DSH 的 HMR（实测它浏览器端不消费）')
{
  /**
   * ## 实测查清的完整事实链
   *
   * DSH 的 client-hmr **服务端全对**：
   *   ✅ host 每 500ms stat 轮询 lib/client.js
   *   ✅ SSE 推 rebuilt 帧（实测收到
   *      {"type":"rebuilt","id":"dsh-webin","rev":"9a4929dc7a68"}）
   *   ✅ 服务器按新 rev 提供新 bundle（拉到的新内容正确）
   *   ❌ **浏览器端不消费那个帧** ⇒ 新代码永不生效
   *
   * 证据：面板 clientId 不变、新字段永不出现（跨多次重启验证）。
   *
   * ## 所以改用「往 index.html 注入自检脚本」
   *
   * 注入的脚本**每次页面加载都跑**，与 client bundle 版本无关 ——
   * 绕开「旧面板读不懂新字段」的死循环。
   */
  const hostSrc = readFileSync(join(ROOT, 'src', 'host', 'index.ts'), 'utf8')

  check('⭐⭐ 声明了 tapIndex', /tapIndex\?\(transform/.test(hostSrc), true)
  check('⭐⭐ 用 tapIndex 注入', /ctx\.webServer\.tapIndex\(\(html\)/.test(hostSrc), true)
  check('⭐⭐ 注入脚本自包含', /__ldwReloadCheck__/.test(hostSrc), true)
  /** tapIndex 不可用时要有降级（不能因此让插件加载失败）。 */
  check(
    '⭐⭐ tapIndex 不可用时优雅降级',
    /typeof ctx\.webServer\.tapIndex !== 'function'[\s\S]{0,200}?return \(\) => undefined/.test(hostSrc),
    true,
  )
  /** 有任务在跑时不重载。 */
  check('⭐⭐ 注入脚本 4 秒轮询', /setInterval\(check, 4000\)/.test(hostSrc), true)

  /** /build 路由（注入脚本问它要当前 rev）。 */
  check('⭐⭐ 有 /build 路由', /API_PREFIX\}\/build/.test(hostSrc), true)
  check('⭐⭐ /build 用与 DSH 相同的 rev 算法', /framedHash|plugin-artifact/.test(hostSrc), true)

  const hb = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')
  check('⭐⭐ 产物有 /build', /API_PREFIX\}\/build/.test(hb), true)
  check('⭐⭐ 产物有注入脚本', /__ldwReloadCheck__/.test(hb), true)
}


console.log('\n[12] ⭐⭐⭐ 虚拟列表探测（DOM 树揭示的真相）')
{
  /**
   * ## DOM 树的决定性证据（自动重载后拿到的）
   *
   *     div.ds-virtual-list.ds-virtual-list--printable.ds-scroll-area
   *       div.ds-virtual-list-items._6f2c522
   *         div.ds-virtual-list-visible-items  k=0 t=0   ← **空的**
   *
   * DeepSeek 用**虚拟滚动**渲染消息列表 —— 只有「可见项」才插入 DOM。
   * 这解释了我为什么一直抓不到回复：容器在，但消息不在 DOM 里。
   *
   * 所以报告要导出虚拟列表的状态（子节点数 / 文本量 / 高度）。
   */
  const domSrc = readFileSync(join(ROOT, 'src', 'client', 'dom-report.ts'), 'utf8')
  check('⭐⭐ 导出 vlist', /vlist: vlist/.test(domSrc), true)
  check('⭐ 查 virtual-list 容器', /\[class\*="virtual-list"\]/.test(domSrc), true)
  check('⭐ 报高度（判断容器是否塌陷）', /h: vr \? Math\.round\(vr\.height\)/.test(domSrc), true)

  /** DOM 树导出（看清页面结构）。 */
  check('⭐⭐ 导出 tree', /tree: tree/.test(domSrc), true)
  check('⭐ 探测 shadow DOM', /shadowHosts: shadowHosts/.test(domSrc), true)
  check('⭐ 探测 iframe', /iframes: iframes/.test(domSrc), true)

  const cb = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  check('⭐⭐ 产物有 vlist', /vlist: vlist/.test(cb), true)
  check('⭐⭐ 产物有 tree', /tree: tree/.test(cb), true)
}


console.log('\n[13] ⭐⭐⭐ webview 同步方法不能链式 .catch()（DSH 被打崩的事故）')
{
  /**
   * ## 真实事故（用户截图：「DeepSeek Harness 无法使用」）
   *
   *     应用无法启动或已意外停止。
   *     web boot: 1 entry did not activate
   *     dsh-webin: import failed (see console for the import error)
   *
   * 崩溃日志（renderer console）：
   *
   *     Uncaught (in promise) TypeError:
   *       Cannot read properties of undefined (reading 'catch')
   *     at dsh-app://app/plugins/??dsh-webin/client.js:4162
   *
   * ## 根因
   *
   * `<webview>.reload()` 是 **Electron 的同步方法**，返回 `undefined`。
   * 代码写了 `.reload().catch(...)` ⇒ 对 undefined 读 .catch ⇒ TypeError
   * ⇒ 整个 client bundle import 失败 ⇒ **DSH 直接弹崩溃框**。
   *
   * ⚠️ 这个 bug 一直存在，被其他错误掩盖；前面的错修掉后它就暴露了。
   *
   * ## 对照
   *
   *   - `reload()`   → 返回 undefined（同步）⇒ **不能链式**
   *   - `loadURL()` → 返回 Promise          ⇒ 可以 .then/.catch
   */
  const chatSrc = readFileSync(join(ROOT, 'src', 'client', 'index.ts'), 'utf8')
  const bundle = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')

  /** 源码：真实代码里不许有 .reload().catch（注释里的除外）。 */
  const realLines = chatSrc
    .split('\n')
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
  check(
    '⭐⭐⭐ 源码没有 .reload().catch()',
    realLines.some((l) => /\.reload\(\)\.catch\(/.test(l)),
    false,
  )
  check(
    '⭐⭐⭐ 产物没有 .reload().catch()（排除注释）',
    bundle
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .some((l) => /\.reload\(\)\.catch\(/.test(l)),
    false,
  )
  /** 直接调用的写法应该在（两处都改成 element.reload()）。 */
  check('⭐ reload 直接调用在', /element\.reload\(\)/.test(chatSrc), true)
  /** 注释里要记下事故，防止再犯。 */
  check('⭐ 事故记录在注释里', /Electron 的同步方法/.test(chatSrc), true)
}


console.log('\n[14] ⭐⭐ 虚拟列表滚动适配 + 页面健康度')
{
  /**
   * ## vlist 诊断的完整结论
   *
   *     ds-virtual-list          scrollH=2415 clientH=502 scrollTop=1913 overflow=auto
     *     ds-virtual-list-items         h=1680→1960→2520→2800（一直涨）
     *     ds-virtual-list-visible-items kids=0 h=0   ← **永远空**
   *
   * 滚动**成功**了（scrollTop 到底部）但项**永不渲染** ⇒
   * 不是视口问题，是这个会话页面的列表渲染器没工作
   * （连续自动发十几条「N+N=?」全进同一会话，高度一直涨 = 占位在加、
   *   项不渲染 + 发送也失败 ⇒ 页面 JS 半坏/风控）。
   */
  const domSrc = readFileSync(join(ROOT, 'src', 'client', 'dom-report.ts'), 'utf8')
  const hookSrc = readFileSync(join(ROOT, 'src', 'client', 'hook.ts'), 'utf8')

  check('⭐⭐ 抓取前滚动到底（虚拟列表适配）', /抓取前把消息列表滚到底/.test(hookSrc), true)
  check('⭐ 滚 ds-virtual-list 的滚动容器', /querySelectorAll\('\[class\*="ds-virtual-list"\]'\)/.test(hookSrc), true)

  check('⭐⭐ 滚动链路诊断', /scrollInfo: scrollInfo/.test(domSrc), true)
  check('⭐⭐ 页面健康度', /health: health/.test(domSrc), true)
  check('⭐ 消息清单导出', /messages: messages/.test(domSrc), true)
  /** needle 匹配的 innerText 兜底。 */
  check('⭐⭐ needle 匹配加 innerText 兜底', /innerText \|\|/.test(domSrc), true)
  /** needle 用提示词（流式渲染的关键观察）。 */
  const clientSrc = readFileSync(join(ROOT, 'src', 'client', 'index.ts'), 'utf8')
  check('⭐⭐⭐ needle 用提示词做', /const needle = p\.length > 24 \? p\.slice\(4, 20\) : p/.test(clientSrc), true)
  check('⭐ 领活时记下提示词', /promptRef\.current = prompt/.test(clientSrc), true)
  /** 报告要重抓（needle 命中 0 的不能缓存当结论）。 */
  check(
    '⭐⭐ needle 命中 0 时继续抓（不缓存坏结论）',
    /needleHits === 0\)\)\s*\{/.test(clientSrc) || /needleHits === 0\)/.test(clientSrc),
    true,
  )
}


console.log('\n[15] ⭐⭐⭐ 交付判据不许有长度门槛（第二处残留，实测卡死）')
{
  /**
   * ## 真实事故（同一个 bug 的第二处）
   *
   * 第一处在抓取侧（hook.ts 的 picked 过滤），已修。
   * **第二处在这里** —— client 交付判据：
   *
   *     if (scraped.ok === true && last.length >= 8 && ...)
   *
   * 实测：问「写一句你好」，网页版答「你好。」（3 字符）。
   * 抓取侧拿到了（lastLen=3），交付判据拒掉 ⇒ state=claimed 永不交付
   * ⇒ 卡 180 秒超时。
   *
   * ## 教训
   *
   * 同一个错误判据会在多处复制。修一处必须全库搜同款。
   */
  const clientSrc = readFileSync(join(ROOT, 'src', 'client', 'index.ts'), 'utf8')
  const cb = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')

  check(
    '⭐⭐⭐ 交付判据没有 length >= 8',
    clientSrc.includes('last.length >= 8 && (countGrew'),
    false,
  )
  check('⭐⭐ 交付只要求非空', /last\.length > 0 && \(countGrew/.test(clientSrc), true)
  check('⭐⭐ 产物同步', cb.includes('last.length >= 8&&(countGrew') || cb.includes('last.length>=8&&(countGrew'), false)
  /** 教训注释要在。 */
  check('⭐ 事故记录在注释里', /第二处残留/.test(clientSrc), true)
}


console.log('\n[16] ⭐⭐⭐ 工具协议默认不下发（实测：污染页面 + 网页版自有工具截胡）')
{
  /**
   * ## 用户实测（鹈鹕任务）的完整证据链
   *
   * 1. 工具协议（~4KB）作为 prompt 发给网页版 ⇒ **被渲染进网页会话**
   *    （页面上能看到「# 工具调用协议…」原文，38KB 页面文本大部分是它）
   * 2. 网页版 DeepSeek **有自己的工具系统**（它自己写文件，
   *    说 "Writing the HTML file"）⇒ **不会**输出 ldw 协议
   *    ⇒ DSH 侧收不到任何工具调用
   * 3. 结果：协议白白发，DSH 的工具一样没通
   */
  const cfgSrc = readFileSync(join(ROOT, 'src', 'shared', 'config.ts'), 'utf8')
  check('⭐⭐⭐ 默认 enableTools: false', /enableTools: false,/.test(cfgSrc), true)
  /** 注释里要有证据链（防止以后被无意改回）。 */
  check('⭐⭐ 证据链注释在', /网页版 DeepSeek.*有自己的工具系统|有自己的工具系统/.test(cfgSrc), true)
}


console.log('\n[17] ⭐⭐⭐ 生成结束闸门：停止按钮在 ⇒ 不交付（42KB 思考事故）')
{
  /**
   * ## 真实事故（用户实测鹈鹕任务）
   *
   * 流式生成的消息出现顺序：#1 用户消息 → #2 思考块 → #3 正文。
   * 交付判据「条数增长 + 3 秒静默」在 #2 刚出现、模型还在思考时
   * 就会满足（思考写完到正文开始之间很容易超 3 秒）
   * ⇒ **把 42KB 思考当回复交付**。
   *
   * ## 完成信号
   *
   * 网页版生成中输入框的发送键（↑）会变成**停止按钮**（方块 ■）；
   * 结束后变回发送。抓取脚本返回 generating 字段；
   * 交付判据：generating === true ⇒ 一律不交付。
   */
  const hookSrc = readFileSync(join(ROOT, 'src', 'client', 'hook.ts'), 'utf8')
  const clientSrc = readFileSync(join(ROOT, 'src', 'client', 'index.ts'), 'utf8')

  check('⭐⭐ 抓取返回 generating', /generating: isGenerating\(\)/.test(hookSrc), true)
  check('⭐ 停止按钮特征（aria-label 停止/stop）', /aria-label\*="停止"/.test(hookSrc), true)
  check('⭐⭐ 交付闸门：generating===true 不交付', /\(scraped as \{ generating\?: boolean \}\)\.generating === true/.test(clientSrc), true)
  /** 字段缺失（旧脚本）时不阻止 —— 宁早勿卡。 */
  check('⭐⭐ 字段缺失不阻止交付', /generating === true\) \{[\s\S]{0,200}?return/.test(clientSrc), true)

  const cb = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  check('⭐⭐ 产物有 generating', cb.includes('generating') ? true : false, true)
}

console.log(`\n=== 静态检查：${pass} 通过 / ${fail} 失败 ===`)
process.exitCode = fail === 0 ? 0 : 1
/** ⚠️ 显式退出 —— 防 handle 悬挂把 npm run check 卡死（verify-lifecycle 实测踩过）。 */
process.exit(process.exitCode)
