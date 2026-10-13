#!/usr/bin/env node
/**
 * **设置页**测试 —— 用户实测反馈：「dsh 插件没有设置页面」。
 *
 * ## 注册契约（从生态里实测出来，两个坑都不报错）
 *
 * 1. **`register` 的 options 里必须带 `name`**（slot 名）。
 *    少了它注册不上，而且**不报错** —— 表现为设置页凭空少一项，极难排查。
 * 2. **渲染函数必须返回 React 元素**。直接返回字符串 / 数组 / `undefined`
 *    会触发 **React #130**（"Element type is invalid"），整个设置面板白屏。
 *
 * 这两条都是「静默失败」，所以必须用测试钉住，不能靠肉眼。
 *
 * ## 验证什么
 *
 * - client 注册了 `settings.section`，带 `name` / `id` / `order` / `label`
 * - 渲染函数返回 React 元素（不是裸函数引用、不是字符串）
 * - host 的 `GET /providers` 返回设置页需要的全部字段
 * - 设置页确实渲染出平台卡片（用 React 服务端渲染做真实渲染验证）
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
  const slots = []
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
    slots: {
      inject(key, cb) {
        slots.push({ key, registered: cb() })
      },
      register(options, component) {
        return { options, component }
      },
    },
  }
  return { ctx, routes, adapters, slots }
}

console.log('=== 设置页测试 ===\n')

const cleanupState = isolate('webin-settings')
/**
 * ⚠️ **必须写登录快照** —— 插件有登录门禁（用户要求「已登录才能用 LDW 模型」）：
 * 未登录时 `stream` 直接以 `WEBIN_NOT_LOGGED_IN` 报错，本测试一个任务都拿不到。
 * 这里模拟「已经登录过」，让测试专注于它要验的语义。
 */
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

console.log('[1] client 注册 settings.section（两个静默失败点）')
{
  const client = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  check('⭐ 注册了 settings.section', client.includes('settings.section'), true)
  check('⭐ inject 了 settings.section', /inject\(\s*"settings\.section"/.test(client), true)
  /**
   * ⚠️ `name` 字段是必须的 —— 少了它注册不上且**不报错**。
   * 断言「注册调用里同时出现 settings.section 和 name」。
   */
  check('⭐ register 的 options 带 name', /name:\s*"settings\.section"/.test(client), true)
  check('带 id', /id:\s*"ldw"/.test(client), true)
  check('带 order', /order:\s*47/.test(client), true)
  check('带 label（显示名）', /label:\s*\(\)\s*=>\s*"LDW/.test(client), true)
  /** 渲染函数必须返回元素 —— 不能是裸引用。 */
  check('⭐ 渲染函数返回 createElement', /createElement\(LdwSettings\)/.test(client), true)
}

console.log('\n[2] host 的 GET /providers 返回设置页需要的字段')
{
  const A = makeCtx()
  await apply(A.ctx)
  const route = [...A.routes.values()].find((r) => r.path === '/dsh-webin/api')
  const res = await call(route.handler, 'GET', '/dsh-webin/api/providers')
  check('状态 200', res.status, 200)
  check('ok=true', res.json?.ok, true)
  check('⭐ 返回全部平台（内置 + 自定义）', Array.isArray(res.json?.providers), true)
  check('平台数 ≥ 2（deepseek + qwen）', (res.json?.providers ?? []).length >= 2, true)
  check('⭐ 带 customIds（决定能否删）', Array.isArray(res.json?.customIds), true)
  check('带 errors（读盘错误）', Array.isArray(res.json?.errors), true)
  check('⭐ 带 clients（登录态来源）', Array.isArray(res.json?.clients), true)

  const ds = (res.json?.providers ?? []).find((p) => p.id === 'deepseek')
  check('平台含 id', typeof ds?.id, 'string')
  check('平台含 name', typeof ds?.name, 'string')
  check('平台含 homeUrl', typeof ds?.homeUrl, 'string')
  check('⭐ 平台含 models（设置页要列）', Array.isArray(ds?.models), true)
  check('⭐ 平台含 contextWindow（设置页要显示）', typeof ds?.contextWindow, 'number')
}

console.log('\n[3] ⭐ 真实渲染：设置页必须产出 React 元素树（防 React #130）')
{
  /**
   * ## 为什么要「真实渲染」而不只是查源码
   *
   * React #130（"Element type is invalid"）是**渲染期**错误 ——
   * 源码里 `createElement` 写得再对，只要组件返回了非元素（字符串 / 数组 /
   * undefined），面板就白屏。只有真跑一次渲染才能抓到。
   *
   * ## 怎么跑（产物是 DSH 的模块加载器格式）
   *
   * `lib/client.js` 开头是 `window.__ModuleLoader__.load({ id, factory })`，
   * 不是 ESM —— 所以：
   *   1. 造一个**最小 React 实现**（够渲染用：createElement + 元素对象）
   *   2. 桩掉 `window.__ModuleLoader__`，捕获 factory
   *   3. 用桩 `require('react')` 调 factory 拿到导出
   *   4. 调 `LdwSettings()` 并**遍历返回的元素树**，确认它是合法元素
   *
   * 不依赖真的 react-dom —— 这里验证的是「返回的是元素而不是别的东西」，
   * 那正是 React #130 的成因。
   */
  const clientSrc = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')

  /** 最小 React：createElement 产出一个可识别的元素对象。 */
  const React = {
    createElement(type, props, ...children) {
      return { $$typeof: Symbol.for('react.element'), type, props: { ...(props ?? {}), children }, key: null }
    },
  }
  /** 渲染期用到的 hooks：设置页首帧只用 useState/useMemo/useEffect。 */
  const hooks = {
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useMemo: (fn) => fn(),
    useEffect: () => {},
    useLayoutEffect: () => {},
    useRef: (init) => ({ current: init ?? null }),
    useCallback: (fn) => fn,
  }

  let captured = null
  const fakeWindow = {
    __ModuleLoader__: {
      load(def) {
        captured = def
      },
    },
  }
  const fakeRequire = (name) => {
    if (name === 'react') return { ...React, ...hooks }
    // 其它依赖（client runtime / ui slots）在渲染首帧用不到，给个空对象
    return {}
  }

  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'navigator', 'fetch', clientSrc)(
    fakeWindow,
    { head: { appendChild() {} }, createElement: () => ({ style: {}, remove() {} }), addEventListener() {} },
    { userAgent: 'node' },
    async () => ({ json: async () => ({ ok: true, providers: [], customIds: [], errors: [], clients: [] }) }),
  )

  check('捕获到模块定义', captured !== null, true)
  check('模块 id 是 dsh-webin', captured?.id, 'dsh-webin')

  let exports = null
  let loadError = null
  try {
    exports = captured.factory(fakeRequire)
  } catch (error) {
    loadError = error.message
  }
  check('⭐ 模块能加载（不抛错）', loadError, null)
  check('⭐ 导出 LdwSettings', typeof exports?.LdwSettings, 'function')

  let el = null
  let renderError = null
  try {
    el = exports.LdwSettings()
  } catch (error) {
    renderError = error.message
  }
  check('⭐ 渲染不抛错（React #130 会在这里炸）', renderError, null)
  check('⭐ 返回的是 React 元素（不是字符串/数组/undefined）', el?.$$typeof, Symbol.for('react.element'))
  check('元素 type 是 div', el?.type, 'div')

  /**
   * 遍历元素树，确认**每个节点要么是元素、要么是文本**。
   *
   * ⚠️ 字符串/数字子节点在 React 里是**合法的**（就是文本内容）——
   * 只有「非元素的**对象**」才会触发 React #130。
   * 一开始把字符串也当非法，误报了一条（踩过）。
   */
  const badNodes = []
  const walk = (node) => {
    if (node === null || node === undefined || typeof node === 'boolean') return
    if (typeof node === 'string' || typeof node === 'number') return // 文本节点，合法
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    if (node.$$typeof !== Symbol.for('react.element')) {
      badNodes.push(`非元素对象: ${Object.keys(node).join(',')}`)
      return
    }
    walk(node.props?.children)
  }
  walk(el)
  check('⭐ 子树里没有非元素对象（React #130 的成因）', badNodes, [])

  /** 首帧应该显示「正在读取…」（state 为 null 的分支）。 */
  const text = JSON.stringify(el)
  check('首帧显示读取中', text.includes('正在读取'), true)
}

console.log('\n[3b] 设置页组件内部逻辑（用假 state 跑完整渲染）')
{
  /**
   * 首帧只走到「正在读取…」，覆盖不到平台卡片那段。
   * 这里直接调内部渲染分支不现实（state 在闭包里），
   * 所以改用**源码断言**覆盖卡片分支的关键点。
   */
  const client = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  check('⭐ 有平台卡片渲染', client.includes('ldw-card'), true)
  check('⭐ 卡片显示登录态', /已登录/.test(client), true)
  check('⭐ 卡片显示未打开浏览器的提示', /浏览器未打开/.test(client), true)
  check('⭐ 只对自定义项显示删除按钮', /customIds\.includes/.test(client), true)
  check('有添加自定义平台的输入框', client.includes('ldw-textarea'), true)
  check('⭐ 有读盘错误展示', client.includes('ldw-callout'), true)
  check('⭐ 定期刷新登录态', /setInterval/.test(client), true)
}

console.log('\n[3c] ⭐⭐ 已登录的平台显示状态标签而不是动作按钮')
{
  /**
   * ## 用户要求（截图里红框标出的地方）
   *
   * 「这个地方不要显示『打开浏览器』而是显示『已登录』」
   *
   * ## 为什么这个要求是对的
   *
   * 登录过之后，「打开浏览器」是个**动作按钮** —— 会让人以为还要做点什么。
   * 而实际上什么都不用做，模型已经可用了。
   *
   * 所以：
   *   - 未登录 → 主按钮「去登录」（确实需要用户操作）
   *   - 已登录 → **状态标签**「✓ 已登录」（是状态，不是待办）
   *   - 已登录 + 想进去看看 → 弱化的**小链接**「打开」（次要入口，不能丢）
   *
   * ⚠️ 关键是**别把「打开浏览器」的能力弄丢** ——
   * 用户有时确实要进去改设置 / 退出登录 / 看页面状态。
   * 所以它降级成小链接，而不是删掉。
   */
  const client = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')

  /**
   * ⚠️ 断言的是**按钮文案**，不是「全文不出现这个词」——
   * 注释里会提到它（解释为什么改掉），title 提示里也有
   * （「打开浏览器视图（查看页面状态 / 退出登录）」）。那些都是正常说明文字。
   *
   * 真正的判据：**没有哪个字符串字面量正好是「打开浏览器」**。
   */
  check('⭐ 不再有「打开浏览器」按钮文案', /'打开浏览器'|"打开浏览器"/.test(client), false)

  /** 已登录时是状态标签。 */
  check('⭐ 已登录显示「✓ 已登录」标签', /✓ 已登录/.test(client), true)
  check('⭐ 用 ldw-badge-on 样式（与顶部徽章一致）', /ldw-badge-on/.test(client), true)

  /** 未登录时仍然是主按钮。 */
  check('⭐ 未登录仍有「去登录」主按钮', /去登录/.test(client), true)
  check('⭐ 主按钮只在未登录时用 primary', /ldw-btn primary/.test(client), true)

  /** 已登录时保留次要入口（能力不能丢）。 */
  check('⭐ 已登录保留弱化入口', /ldw-linkbtn/.test(client), true)
  check('⭐ 有 .ldw-linkbtn 样式（像链接而不是按钮）', /\.ldw-linkbtn\{/.test(client), true)

  /** 说明文字要跟着状态变 —— 已登录时不该再说「点了去登录…」。 */
  check('⭐ 说明文字区分已登录/未登录', /已登录的平台可以直接用/.test(client), true)
}

console.log('\n[4] 设置页样式齐全（否则渲染出来是裸文本）')
{
  const client = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  for (const cls of [
    'ldw-set',
    'ldw-hero',
    'ldw-pagehead',
    'ldw-pill',
    'ldw-card',
    'ldw-btn',
    'ldw-textarea',
    'ldw-row',
    'ldw-tag',
    'ldw-switch',
    'ldw-callout',
    'ldw-details',
    'ldw-fieldrow',
    'ldw-skeleton',
  ]) {
    check(`样式含 .${cls}`, client.includes(`.${cls}`), true)
  }
  /** 主题 token 而不是写死颜色 —— 否则切浅色主题会花。 */
  check('⭐ 用主题 token（不写死颜色）', client.includes('--dsw-alias-label-primary'), true)
  /**
   * 写死的色值只允许出现在两处（都是**有意为之**）：
   *   1. `var(--token, #fallback)` 的兜底值 —— 主题没定义该 token 时才用
   *   2. `#fff` —— 开关圆点在「开」状态下的白色，与主题无关
   *
   * 所以判据是「background/color 直接写死十六进制」，
   * 而不是「出现十六进制就报错」（那样会误报上面两种）。
   */
  const hardcoded = [...client.matchAll(/\.ldw-[a-z-]+[^}]*?(?:background|color):\s*#[0-9a-fA-F]{3,6}/g)]
    /** 开关圆点的白色是有意的（见下），排除。 */
    .filter((m) => !m[0].includes('background:#fff'))
    .map((m) => m[0].slice(0, 90))
  check('⭐ 没有直接写死的 background/color', hardcoded, [])
  /** 兜底值与白色圆点确实存在（确认上面那条不是「碰巧没匹配到」）。 */
  check('兜底值写法存在（有意为之）', /var\(--dsw-alias-state-warning-primary,#f0a441\)/.test(client), true)
  check('开关圆点用白色（有意为之）', /aria-checked="true"\]>i::after\{transform:translateX\(16px\);background:#fff/.test(client), true)
}

console.log('\n[4b] ⭐ 视觉系统（参考开源实现的成熟做法）')
{
  const client = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  /** 分层阴影：hairline 边框 + 顶部内高光 + 柔和外阴影（"双层 bezel"）。 */
  check('⭐ 卡片有内高光', /inset 0 1px 0 rgb\(255 255 255/.test(client), true)
  check('⭐ 卡片有外阴影', /0 3px 10px/.test(client), true)
  check('⭐ 卡片 hover 抬升', /\.ldw-card:hover\{transform:translateY\(-2px\)/.test(client), true)
  /** 动效曲线：仪表感 + 回弹。 */
  check('⭐ 有缓动曲线令牌', client.includes('--ease-instrument') && client.includes('--ease-settle'), true)
  /** 键盘可达性：只给键盘聚焦画环。 */
  check('⭐ 用 :focus-visible（鼠标点击不出现环）', client.includes(':focus-visible'), true)
  /** 开关圆点的弹性位移。 */
  check('⭐ 开关圆点带过渡', /\.ldw-switch>i::after\{[^}]*transition:transform/.test(client), true)
  check('⭐ 开关 checked 态位移', /aria-checked="true"\]>i::after\{transform:translateX/.test(client), true)
  /** 状态点呼吸动画（在线指示）。 */
  check('⭐ 状态点有呼吸动画', client.includes('ldw-dot-breathe'), true)
  /** 骨架屏（首次读取不跳动）。 */
  check('⭐ 有骨架屏', client.includes('ldw-skeleton'), true)
  /** 用 color-mix 做半透明 —— 跟随主题色，而不是固定 rgba。 */
  check('⭐ 用 color-mix 跟随主题色', client.includes('color-mix(in srgb'), true)
  /** 页面最大宽度，避免超宽屏一行太长。 */
  check('有最大宽度约束', /max-width:1080px/.test(client), true)
}

console.log('\n[5] 围栏名是中性的 ldw（用户要求）')
{
  const host = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')
  /**
   * ⚠️ 构建时 `FENCE_LANG` 被**常量折叠**了 —— 产物里没有这个标识符，
   * 直接就是字面量 `ldw`（实测确认）。所以断言要看**协议文本**，
   * 而不是常量名。
   */
  check('⭐ 协议里围栏是 ```ldw', host.includes('```ldw'), true)
  check('⭐ 协议说明里也写 ldw', /以 ```ldw 开头/.test(host), true)
  check('⭐ 产物里没有第三方项目围栏', host.includes('```cuckoo'), false)
  check('产物里没有 ```dsh 残留', host.includes('```dsh'), false)
}

cleanupState()
console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
process.exitCode = fail === 0 ? 0 : 1
/** ⚠️ 显式退出 —— 防 handle 悬挂把 npm run check 卡死（verify-lifecycle 实测踩过）。 */
process.exit(process.exitCode)
