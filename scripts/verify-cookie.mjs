#!/usr/bin/env node
/**
 * ## cookie 存档（**解决「重启必须重新登录」**）
 *
 * 用户实测报的：「每次重启 dsh 都需要重新登陆 deepseek？无语了」
 *
 * 根因链（每一环都验证过）：
 *   1. DSH 的 guest partition 是 `dsh-sidebar-browser-${randomUUID()}`
 *      （`lib/main.js:9638`）—— **无 `persist:` 前缀 = 内存分区**，
 *      进程一退 cookie 全丢；
 *   2. DeepSeek 的登录态主要靠 **httpOnly cookie**；
 *   3. 页面里的 `document.cookie` **看不见也写不了** httpOnly cookie。
 *
 * 所以「把 localStorage + document.cookie 存成快照再回写」天生不完整。
 * 插件 host 半跑在 Electron 主进程里，能用
 * `session.fromPartition(name).cookies` 拿到**含 httpOnly** 的全部 cookie。
 *
 * 这里测的就是那条路。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const jarSrc = readFileSync(join(ROOT, 'src', 'host', 'cookie-jar.ts'), 'utf8')
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

console.log('=== cookie 存档（重启免登录）===\n')

console.log('[1] ⭐⭐ 必须用 Electron session API（页面 JS 拿不到 httpOnly）')
{
  check('⭐ 有 cookie-jar 模块', jarSrc.length > 0, true)
  check('⭐ 用 session.fromPartition', /session\.fromPartition/.test(jarSrc), true)
  check('⭐ 用 cookies.get 读取', /\.cookies\.get\(/.test(jarSrc), true)
  check('⭐ 用 cookies.set 写回', /await jar\.set\(/.test(jarSrc), true)
  /** 必须动态 require —— 静态 import 会让打包器把 electron 塞进产物。 */
  check('⭐ 动态 require electron（不静态 import）', /eval\('require'\)/.test(jarSrc), true)
  check('没有静态 import electron', /^import .*from 'electron'/m.test(jarSrc), false)
}

console.log('\n[2] ⭐⭐ 拿不到 electron 时必须优雅降级（不能抛）')
{
  /**
   * 单元测试 / 纯 node 环境下 `require('electron')` 会 MODULE_NOT_FOUND。
   * 那时必须返回 undefined 让调用方走降级路径 —— **绝不能抛错**，
   * 否则整个插件加载失败。
   *
   * ## ⚠️ 断言改过（原来是「单个 req('electron') 在 try 内」）
   *
   * 实测发现单策略不够：`createRequire(import.meta.url)` 在 DSH 里
   * 抛 `Cannot find module 'electron'`（插件 host 跑在 utility 进程，
   * 没有主进程专属的 session API）。
   *
   * 现在改成**多种策略依次尝试**，所以断言要验的是：
   *   1. 每个策略都在 try 里（失败不抛，试下一条）
   *   2. 拿到 session.fromPartition 才算成功
   */
  check(
    '⭐⭐ 每个策略都单独 try 包住',
    /for \(const get of strategies\) \{\s*try \{/.test(jarSrc),
    true,
  )
  check(
    '⭐⭐ 判据是 session.fromPartition',
    /electron\?\.session\?\.fromPartition !== undefined\) return electron\.session/.test(jarSrc),
    true,
  )
  check('⭐ 多条策略（不只一种）', (jarSrc.match(/createRequire\(/g) ?? []).length >= 2, true)
  check('⭐ 拿不到就返回 undefined', /return undefined\s*\n\}/.test(jarSrc), true)
  check('grabCookies 失败返回 undefined', /async function grabCookies[\s\S]{0,900}return undefined/.test(jarSrc), true)
  check('restoreCookies 失败返回 0', /if \(ses === undefined\) return 0/.test(jarSrc), true)
  /** 有 cookieApiAvailable() 让 UI 能告诉用户走哪条路。 */
  check('⭐ 暴露 cookieApiAvailable', /export function cookieApiAvailable/.test(jarSrc), true)
}

console.log('\n[3] ⭐⭐ 写回 cookie 必须带 url（Electron 的硬要求）')
{
  /**
   * Electron 的 `cookies.set()` 要求给 `url` —— 它从 url 推导
   * domain / path / secure。只给 `domain` 不生效（踩过的坑）。
   */
  check('⭐ set 时带 url', /url: `\$\{scheme\}:\/\/\$\{host\}/.test(jarSrc), true)
  check('带 domain', /domain: c\.domain/.test(jarSrc), true)
  check('带 path（空则 /）', /path: c\.path === '' \? '\/' : c\.path/.test(jarSrc), true)
  check('⭐ 保留 httpOnly 标记', /httpOnly: c\.httpOnly === true/.test(jarSrc), true)
  check('保留 secure', /secure: c\.secure === true/.test(jarSrc), true)
  check('保留过期时间', /expirationDate/.test(jarSrc), true)
  check('保留 sameSite', /sameSite/.test(jarSrc), true)
}

console.log('\n[4] ⭐ 域名过滤：要能吃下前导点')
{
  /**
   * Electron 返回的 domain 常带前导点（`.deepseek.com`），
   * 而配置里的 homeUrl hostname 是 `chat.deepseek.com` —— 直接比较会失配。
   */
  check('⭐ 去掉前导点', /replace\(\/\^\\\.\/, ''\)/.test(jarSrc), true)
  check('⭐ 双向后缀匹配', /d === domain \|\| domain\.endsWith/.test(jarSrc), true)
}

console.log('\n[5] ⭐ partition 名由 client 上报（host 猜不到）')
{
  /**
   * DSH 的 partition 是 `dsh-sidebar-browser-${randomUUID()}` ——
   * **随机**，host 无法猜。但 client 在 `browser.acquire()` 的返回值里拿得到。
   */
  check('⭐ client 上报 partition', /api\/client\/partition/.test(clientSrc), true)
  check('⭐ 上报带 partition 字段', /partition: reservation\.partition/.test(clientSrc), true)
  check('⭐ 上报带 domain', /domain: \(\(\) => \{/.test(clientSrc), true)
  check('⭐ host 有接收路由', /client\/partition/.test(hostSrc), true)
  check('host 记住 partition', /partitions\.set\(platform, \{ partition, domain/.test(hostSrc), true)
}

console.log('\n[6] ⭐⭐ 存档 / 写回两个路由都在')
{
  check('⭐ POST /auth/<p>/cookies 存档', /method === 'POST' && pathname\.startsWith\(`\$\{API_PREFIX\}\/auth\/`\) && pathname\.endsWith\('\/cookies'\)/.test(hostSrc), true)
  check('⭐ GET /auth/<p>/cookies 写回', /method === 'GET' && pathname\.startsWith\(`\$\{API_PREFIX\}\/auth\/`\) && pathname\.endsWith\('\/cookies'\)/.test(hostSrc), true)
  /** 还没上报 partition 时要给出可照做的提示，而不是笼统报错。 */
  check('⭐ 未上报时提示去开 LDW', /请先打开 LDW 标签让它上报/.test(hostSrc), true)
  /** 环境不支持时用 501 明确区分（而不是 500 假装是 bug）。 */
  check('⭐ 环境不支持用 501', /sendJson\(res, 501/.test(hostSrc), true)
}

console.log('\n[7] ⭐⭐ client：cookie 写回必须在页面快照之前')
{
  /**
   * cookie 是**请求头**的一部分。页面开始加载后再写就晚了 ——
   * 首屏仍然是登录页（用户看到的正是这个）。
   */
  const iCookie = clientSrc.indexOf('/cookies')
  const iSnap = clientSrc.indexOf('const snap = await loadSnapshot(provider.id)')
  check('找到 cookie 写回', iCookie > 0, true)
  check('找到快照读取', iSnap > 0, true)
  check('⭐⭐ cookie 写回在快照之前', iCookie > 0 && iSnap > 0 && iCookie < iSnap, true)
}

console.log('\n[8] ⭐⭐ cookie 写回成功后必须 reload')
{
  /**
   * 时序：loadURL 开始 → 我们写 cookie → 但页面**已经开始加载**了，
   * 首屏是登录页。不 reload 的话用户看到的就是登录界面（即使 cookie 已好）。
   */
  /** ⚠️ 从「cookie 写回」那段注释开头切 —— cookieRestored 声明在它之前（踩过）。 */
  const seg = clientSrc.slice(clientSrc.indexOf('第一步：让 host 把'), clientSrc.indexOf('第一步：让 host 把') + 6_000)
  check('⭐ 有 cookieRestored 标记', /let cookieRestored = 0/.test(seg), true)
  check('⭐⭐ 写回成功触发 reload', /if \(restored \|\| cookieRestored > 0\)/.test(seg), true)
  check('⭐ 无快照但有 cookie 时也 reload', /if \(cookieRestored > 0\) \{\s*\n\s*stageRef\.current = 'reloading'/.test(seg), true)
}

console.log('\n[9] ⭐ 存档目录在 stateRoot 下，且平台名做安全化')
{
  check('用 stateRoot/cookies', /join\(stateRoot, 'cookies'\)/.test(jarSrc), true)
  /** 自定义 provider 的 id 可能含路径分隔符 —— 必须替换掉。 */
  check('⭐ 平台名安全化', /replace\(\/\[\^A-Za-z0-9_\.-\]\/g, '_'\)/.test(jarSrc), true)
  check('有存档写入', /export function saveCookieArchive/.test(jarSrc), true)
  check('有存档读取', /export function loadCookieArchive/.test(jarSrc), true)
  check('有存档删除', /export function dropCookieArchive/.test(jarSrc), true)
}

console.log('\n[10] ⭐ 存档读写往返（真跑一次）')
{
  /** 把 cookie-jar 的存档逻辑抽出来实测（纯文件 IO，不依赖 electron）。 */
  const dir = mkdtempSync(join(tmpdir(), 'ldw-cookie-'))
  try {
    const start = jarSrc.indexOf('export function saveCookieArchive')
    const end = jarSrc.indexOf('/** 删除 cookie 存档')
    let body = jarSrc.slice(start, end)
    body = body.replace(/export function/g, 'function')
    /** 去掉 TS 类型标注（只处理这个简单片段）。 */
    body = body
      .replace(/\(stateRoot: string, archive: CookieArchive\): void/g, '(stateRoot, archive)')
      .replace(/\(stateRoot: string, platform: string\): CookieArchive \| undefined/g, '(stateRoot, platform)')
      .replace(/const parsed = JSON\.parse\(raw\) as CookieArchive/g, 'const parsed = JSON.parse(raw)')
      .replace(/const raw = readFileSync\(f, 'utf8'\)/g, 'const raw = readFileSync(f, "utf8")')
    const prelude = `
      const { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } = __fs
      const { join } = __path
      function cookieDir(stateRoot) { return join(stateRoot, 'cookies') }
      function cookieFile(stateRoot, platform) {
        const safe = platform.replace(/[^A-Za-z0-9_.-]/g, '_')
        return join(cookieDir(stateRoot), safe + '.json')
      }
    `
    // eslint-disable-next-line no-new-func
    const factory = new Function('__fs', '__path', `${prelude}\n${body}\nreturn { saveCookieArchive, loadCookieArchive }`)
    const { saveCookieArchive, loadCookieArchive } = factory(
      { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync },
      { join },
    )

    const archive = {
      platform: 'deepseek',
      cookies: [
        { name: 'ds_session_id', value: 'abc123', domain: '.deepseek.com', path: '/', secure: true, httpOnly: true },
        { name: 'intercom', value: 'x', domain: '.deepseek.com', path: '/', secure: false, httpOnly: false },
      ],
      at: 1_700_000_000_000,
    }
    saveCookieArchive(dir, archive)
    const back = loadCookieArchive(dir, 'deepseek')
    check('⭐ 往返成功', back !== undefined, true)
    check('⭐ cookie 条数保留', back?.cookies.length, 2)
    check('⭐ httpOnly 标记保留', back?.cookies[0]?.httpOnly, true)
    check('值保留', back?.cookies[0]?.value, 'abc123')

    /** 平台名含路径分隔符时要安全化（不能写到别的目录）。 */
    saveCookieArchive(dir, { ...archive, platform: '../evil/x' })
    /**
     * ⚠️ 断言的是「文件确实落在 cookies/ 里」，不是「文件名不含 ..」——
     * 安全化后是 `.._evil_x`（仍含两个点，但那只是普通字符）。
     * 一开始我写错了断言，误报失败（踩过）。
     */
    const files = readdirSync(join(dir, 'cookies'))
    check('⭐ 平台名被安全化（分隔符换成下划线）', files.includes('.._evil_x.json'), true)
    check('⭐ 没有写到上级目录', existsSync(join(dir, 'evil')), false)

    /** 不存在的存档返回 undefined（不是抛错）。 */
    check('缺存档返回 undefined', loadCookieArchive(dir, 'nope'), undefined)
    /** 坏 JSON 也不能抛。 */
    writeFileSync(join(dir, 'cookies', 'broken.json'), '{not json', 'utf8')
    check('⭐ 坏 JSON 不抛错', loadCookieArchive(dir, 'broken'), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
process.exitCode = fail === 0 ? 0 : 1
/** ⚠️ 显式退出 —— 防 handle 悬挂把 npm run check 卡死（verify-lifecycle 实测踩过）。 */
process.exit(process.exitCode)
