#!/usr/bin/env node
/**
 * 登录态恢复时序测试 —— **「每次重启 DSH 都要重新登录」的回归保护**。
 *
 * ## 这个 bug 的真实成因（实测确认）
 *
 * 早期实现在**第一次 `dom-ready`（页面还是 `about:blank`）**上跑 restore：
 *
 * ```
 * [A] about:blank 上写 localStorage
 *     → SecurityError: Access is denied for this document.
 * [B] 目标域上写 → 跨 reload 保留 ✓
 * ```
 *
 * 两层原因：
 *   1. `about:blank` 是 **opaque origin**，`localStorage` 直接抛 SecurityError；
 *   2. `localStorage` **按源隔离** —— 在 A 源写的值 B 源读不到。
 *
 * 而 DSH 的 guest partition 是**内存分区**
 * （`main.js:9638`：`dsh-sidebar-browser-${randomUUID()}`，无 `persist:` 前缀），
 * 门禁又强制 `params.partition === lease.partition`（`main.js:9685`），
 * **不允许我们自己换成持久分区**。所以重启后 storage 必然为空，
 * 唯一补救就是「快照 + 在正确源上回写」。
 *
 * ## 这个测试验证什么
 *
 * 1. `buildRestoreScript()` 在**错的源**上会**明确报告失败**（不静默）
 * 2. `buildRestoreScript()` 在**对的源**上能写入并**回读校验**成功
 * 3. 客户端代码的时序是 `导航 → restore → reload`，而不是 `restore → 导航`
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = dirname(dirname(fileURLToPath(import.meta.url)))
const bundle = readFileSync(join(SRC, 'lib', 'client.js'), 'utf8')

/** 从产物里抠函数（编译验证边界）。 */
function extract(bundle, pattern, name) {
  const m = bundle.match(pattern)
  if (m === null) throw new Error(`产物里找不到 ${name} —— 先跑 npm run build`)
  const start = m.index
  const openBrace = bundle.indexOf('{', start)
  let depth = 0
  let braceEnd = -1
  for (let i = openBrace; i < bundle.length; i += 1) {
    if (bundle[i] === '{') depth += 1
    else if (bundle[i] === '}') {
      depth -= 1
      if (depth === 0) {
        braceEnd = i + 1
        break
      }
    }
  }
  const tryCompile = (end) => {
    const text = bundle.slice(start, end)
    const assign = text.match(/^(?:var|const|let)\s+(\w+)\s*=\s*(class\s*\{[\s\S]*)$/)
    const candidate = assign !== null ? `var ${assign[1]} = ${assign[2]};` : text
    try {
      // eslint-disable-next-line no-new-func
      new Function(`${candidate}\n; return ${name};`)
      return candidate
    } catch {
      return undefined
    }
  }
  if (braceEnd > 0) {
    const ok = tryCompile(braceEnd)
    if (ok !== undefined) return ok
  }
  for (let end = braceEnd > 0 ? braceEnd : start + 400; end > start; end -= 1) {
    if (bundle[end - 1] !== '}') continue
    const ok = tryCompile(end)
    if (ok !== undefined) return ok
  }
  throw new Error(`无法提取 ${name}`)
}

const src = extract(bundle, /function buildRestoreScript\(/, 'buildRestoreScript')
// eslint-disable-next-line no-new-func
const buildRestoreScript = new Function(`${src}\n; return buildRestoreScript;`)()

let pass = 0
let fail = 0
const check = (name, actual, expected) => {
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

const SNAP = JSON.stringify({
  localStorage: { userToken: '{"value":"REAL_TOKEN","__version":"0"}', theme: 'dark' },
  cookie: 'smidV2=abc123; .thumbcache_xyz=QQ==',
})

/**
 * 在受控的伪环境里跑 restore 脚本。
 * 用 `new Function` 注入假的 `location` / `localStorage` / `document`。
 */
function runRestore(script, env) {
  // eslint-disable-next-line no-new-func
  const fn = new Function('location', 'localStorage', 'document', `return ${script.trim().replace(/;\s*$/, '')}`)
  return JSON.parse(String(fn(env.location, env.localStorage, env.document)))
}

/** 造一个可用的假 localStorage。 */
function makeStorage(opts = {}) {
  const store = new Map()
  return {
    store,
    api: {
      setItem: (k, v) => {
        if (opts.readonly === true) throw new Error('SecurityError: Access is denied for this document.')
        store.set(k, String(v))
      },
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      removeItem: (k) => store.delete(k),
      get length() {
        return store.size
      },
    },
  }
}

function makeDocument(opts = {}) {
  const cookies = new Map()
  return {
    cookies,
    get cookie() {
      return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
    },
    set cookie(raw) {
      if (opts.readonly === true) return
      const first = String(raw).split(';')[0]
      const eq = first.indexOf('=')
      if (eq <= 0) return
      const name = first.slice(0, eq).trim()
      const value = first.slice(eq + 1).trim()
      if (/max-age=0/i.test(raw) || value === '') cookies.delete(name)
      else cookies.set(name, value)
    },
  }
}

console.log('=== 登录态恢复时序测试 ===\n')

console.log('[1] 错的源（about:blank）→ 必须明确报告失败，不静默')
{
  const script = buildRestoreScript(SNAP)
  const storage = makeStorage({ readonly: true })
  const doc = makeDocument({ readonly: true })
  const r = runRestore(script, {
    location: { origin: 'null', protocol: 'about:' },
    localStorage: storage.api,
    document: doc,
  })
  check('ok=false', r.ok, false)
  check('reason=wrong-origin', r.reason, 'wrong-origin')
  check('没有假装写入成功', r.restored === undefined || r.restored === 0, true)
  check('带可操作提示', typeof r.hint === 'string' && r.hint.includes('目标域'), true)
}

console.log('\n[2] 错的源（origin 为空串）→ 同样拒绝')
{
  const r = runRestore(buildRestoreScript(SNAP), {
    location: { origin: '', protocol: 'https:' },
    localStorage: makeStorage().api,
    document: makeDocument(),
  })
  check('ok=false', r.ok, false)
  check('reason=wrong-origin', r.reason, 'wrong-origin')
}

console.log('\n[3] 对的源 → 写入成功且回读校验通过')
{
  const storage = makeStorage()
  const doc = makeDocument()
  const r = runRestore(buildRestoreScript(SNAP), {
    location: { origin: 'https://chat.deepseek.com', protocol: 'https:' },
    localStorage: storage.api,
    document: doc,
  })
  check('ok=true', r.ok, true)
  check('restored=2（两条 localStorage）', r.restored, 2)
  check('verified=2（回读校验）', r.verified, 2)
  check('failed=0', r.failed, 0)
  check('cookies=2', r.cookies, 2)
  check('报告了源', r.origin, 'https://chat.deepseek.com')
  check('token 真的写进去了', storage.store.get('userToken'), '{"value":"REAL_TOKEN","__version":"0"}')
  check('cookie 真的写进去了', doc.cookies.get('smidV2'), 'abc123')
}

console.log('\n[4] storage 只读（模拟配额满/隐私模式）→ 报告失败而非谎报成功')
{
  const storage = makeStorage({ readonly: true })
  const r = runRestore(buildRestoreScript(SNAP), {
    location: { origin: 'https://chat.deepseek.com', protocol: 'https:' },
    localStorage: storage.api,
    document: makeDocument(),
  })
  // localStorage 全失败，但 cookie 成功了 ⇒ ok 仍为 true（至少恢复了一部分）
  check('failed=2（两条都写失败）', r.failed, 2)
  check('cookies 仍然写入', r.cookies, 2)
  check('verified=0（回读校验如实反映）', r.verified, 0)
}

console.log('\n[5] 空快照 / 无快照 → 安全返回')
{
  const r1 = runRestore(buildRestoreScript('null'), {
    location: { origin: 'https://chat.deepseek.com', protocol: 'https:' },
    localStorage: makeStorage().api,
    document: makeDocument(),
  })
  check('null 快照 → ok=false', r1.ok, false)
  check('reason=no-snapshot', r1.reason, 'no-snapshot')

  const r2 = runRestore(buildRestoreScript(JSON.stringify({ localStorage: {}, cookie: '' })), {
    location: { origin: 'https://chat.deepseek.com', protocol: 'https:' },
    localStorage: makeStorage().api,
    document: makeDocument(),
  })
  check('空内容 → ok=false（没恢复任何东西）', r2.ok, false)
}

console.log('\n[6] 客户端时序：必须先导航，再 restore，再 reload（阶段机）')
{
  /**
   * 这是本 bug 的核心 —— 顺序错了就白干。
   *
   * ⚠️ 早期用 `documentCount === 1 / 2 / >= 3` 计数，有两个真实缺陷：
   *   1. **某步没发生就永久卡住**：没有快照时 `=== 2` 分支直接 return 不 reload，
   *      计数停在 2 ⇒ hook 永不注入、ready 永不置位、插件永久失效。
   *   2. **后续导航打乱计数**（用户点链接 / 页面跳登录页）。
   *
   * 现在改成显式阶段机 `boot → navigating → restoring → reloading → live`，
   * 每个阶段只做一次，且不依赖"第几次 dom-ready"。
   */
  const idxBoot = bundle.indexOf('"boot"')
  const idxNav = bundle.indexOf('"navigating"')
  const idxRestoring = bundle.indexOf('"restoring"')
  const idxReloading = bundle.indexOf('"reloading"')
  const idxRestore = bundle.indexOf('buildRestoreScript(snap)')
  // 导航目标改成动态变量（优先上次会话 URL，否则 homeUrl），所以匹配 loadURL(target)
  const idxLoad = bundle.indexOf('loadURL(target)')
  const idxReload = bundle.indexOf('.reload()')

  check('阶段机存在（boot）', idxBoot > 0, true)
  check('阶段机存在（navigating）', idxNav > 0, true)
  check('阶段机存在（restoring）', idxRestoring > 0, true)
  check('阶段机存在（reloading）', idxReloading > 0, true)
  check('导航在 restore 之前', idxLoad > 0 && idxLoad < idxRestore, true)
  check('restore 在 restoring 阶段', idxRestoring < idxRestore, true)
  check('hook 在 reload 之后注入', bundle.indexOf('buildDeepSeekHook(provider.completionPath') > idxReload, true)

  /**
   * ⚠️ 「restore 在 reload 之前」原来用**全局第一个** `.reload()` 定位。
   *
   * 后来加了「cookie 写回成功后 reload」这条路径 —— 它出现在 restore
   * **之前**（cookie 必须在页面加载前写），于是全局第一个 `.reload()`
   * 不再对应「restore 之后那次」⇒ 断言误报失败（踩过）。
   *
   * 改成**只在 restore 之后**的区间里找 reload。
   */
  check('⭐ restore 之后有 reload', bundle.indexOf('.reload()', idxRestore) > idxRestore, true)

  /**
   * ⭐ cookie 写回必须在页面快照回写**之前** ——
   * cookie 是请求头的一部分，页面开始加载后再写就晚了（首屏仍是登录页）。
   */
  const idxCookieRestore = bundle.indexOf('/cookies')
  check('⭐ cookie 写回存在', idxCookieRestore > 0, true)
  check('⭐ cookie 写回在页面快照之前', idxCookieRestore > 0 && idxCookieRestore < idxRestore, true)

  // 关键：没有快照也要能走到 live（否则插件永久失效）
  /**
   * ⚠️ 窗口要够大 —— 中间插了 cookie 写回逻辑后这段变长了
   * （踩过：写死 200 字符匹配不到 markLive）。
   */
  check('无快照路径会 markLive（不卡住）', /无登录态快照[\s\S]{0,900}markLive\(\)/.test(bundle), true)
  check('加载失败会回退阶段', /stageRef\.current = "boot"/.test(bundle), true)
  check('渲染崩溃会回退阶段', bundle.includes('render-process-gone'), true)
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
process.exitCode = fail === 0 ? 0 : 1
