#!/usr/bin/env node
/**
 * dsh-webin 装配预检。
 *
 * 目的：在**重启 DSH 之前**确认 profile 侧一切就绪，避免"重启了但没生效，
 * 只好再重启一次"。
 *
 * 检查项：
 *   1. profile 的 bundles 列表包含 dsh-webin
 *   2. node_modules/dsh-webin 是指向源目录的 junction
 *   3. lib/index.js 与 lib/client.js 存在，且比 src 新（构建没过期）
 *   4. package.json 的 exports / main 指向的文件真实存在
 *   5. dsh.bundle.patch 与 dsh.client 声明完整
 *   6. cordis.patch.yml 能被解析出 insert 行
 *   7. host 半能被 import 且导出 apply
 *   8. client 半带 ModuleLoader banner
 */
import { readFileSync, existsSync, statSync, lstatSync, readlinkSync, readdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { homedir } from 'node:os'

const SRC = dirname(dirname(fileURLToPath(import.meta.url)))
const PROFILE = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', 'desktop')
const LINKED = join(PROFILE, 'node_modules', 'dsh-webin')

let pass = 0
let fail = 0
/** 无法在本环境验证的项（环境限制，既不算通过也不算失败）。 */
let skip = 0
const check = (name, ok, detail) => {
  if (ok) {
    pass += 1
    console.log(`  OK   ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

console.log('=== dsh-webin 装配预检 ===')
console.log(`源目录   : ${SRC}`)
console.log(`profile  : ${PROFILE}`)
console.log('')

// ---- 1) bundles 声明 ----
console.log('[1] profile 装配声明')
let pkg
try {
  pkg = JSON.parse(readFileSync(join(PROFILE, 'package.json'), 'utf8'))
} catch (e) {
  check('读 profile/package.json', false, String(e?.message))
}
if (pkg !== undefined) {
  const bundles = pkg?.dsh?.profile?.bundles ?? []
  check('bundles 含 dsh-webin', bundles.includes('dsh-webin'), JSON.stringify(bundles))
  check('dependencies 声明了 dsh-webin', pkg?.dependencies?.['dsh-webin'] !== undefined, JSON.stringify(pkg?.dependencies))
}

// ---- 2) junction ----
console.log('\n[2] node_modules 链接')
let linkedOk = false
try {
  const st = lstatSync(LINKED)
  const isLink = st.isSymbolicLink() || (st.attributes ?? 0) & 0x400 // ReparsePoint
  let target = ''
  try {
    target = readlinkSync(LINKED)
  } catch {
    /* junction 在某些 Node 版本上 readlink 会失败 */
  }
  linkedOk = existsSync(join(LINKED, 'package.json'))
  check('node_modules/dsh-webin 可解析', linkedOk)
  check('链接目标指向源目录', target === '' || resolve(target) === resolve(SRC), `target=${target}`)
  void isLink
} catch (e) {
  check('node_modules/dsh-webin 存在', false, String(e?.message))
}

// ---- 3) 构建新鲜度 ----
console.log('\n[3] 构建新鲜度')
const libIndex = join(SRC, 'lib', 'index.js')
const libClient = join(SRC, 'lib', 'client.js')
check('lib/index.js 存在', existsSync(libIndex))
check('lib/client.js 存在', existsSync(libClient))

if (existsSync(libIndex) && existsSync(libClient)) {
  const newestSrc = Math.max(
    ...readdirSync(join(SRC, 'src', 'host')).map((f) => statSync(join(SRC, 'src', 'host', f)).mtimeMs),
    ...readdirSync(join(SRC, 'src', 'client')).map((f) => statSync(join(SRC, 'src', 'client', f)).mtimeMs),
  )
  const oldestLib = Math.min(statSync(libIndex).mtimeMs, statSync(libClient).mtimeMs)
  check(
    '产物不比源码旧（构建未过期）',
    oldestLib >= newestSrc,
    `lib=${new Date(oldestLib).toISOString()} src=${new Date(newestSrc).toISOString()}`,
  )
}

// ---- 4) exports 指向真实文件 ----
console.log('\n[4] package.json exports')
const self = JSON.parse(readFileSync(join(SRC, 'package.json'), 'utf8'))
const mainPath = join(SRC, self.main ?? './lib/index.js')
check(`main 指向的文件存在（${self.main}）`, existsSync(mainPath))
const clientExport = self?.exports?.['./client']?.default
check('./client 导出存在', typeof clientExport === 'string', String(clientExport))
if (typeof clientExport === 'string') {
  check(`./client 指向的文件存在（${clientExport}）`, existsSync(join(SRC, clientExport)))
}

// ---- 5) dsh 装配字段 ----
console.log('\n[5] dsh 装配字段')
check('dsh.bundle.patch 已声明', typeof self?.dsh?.bundle?.patch === 'string', String(self?.dsh?.bundle?.patch))
check('dsh.client.platform = web', self?.dsh?.client?.platform === 'web', String(self?.dsh?.client?.platform))
check(
  'dsh.client.inject 不含已从 DSH 移除的 dsh-client-runtime',
  Array.isArray(self?.dsh?.client?.inject) &&
    !self.dsh.client.inject.includes('@deepseek-ai/dsh-client-runtime'),
  JSON.stringify(self?.dsh?.client?.inject),
)

// ---- 6) bundle patch 文件 ----
console.log('\n[6] bundle patch 文件')
const patchPath = join(SRC, self?.dsh?.bundle?.patch ?? 'cordis.patch.yml')
if (existsSync(patchPath)) {
  const text = readFileSync(patchPath, 'utf8')
  check('patch 含 insert 段', text.includes('insert:'))
  check('patch 声明了 dsh-webin 行', text.includes('dsh-webin'))
} else {
  check('patch 文件存在', false, patchPath)
}

// ---- 7) host 半可加载 ----
console.log('\n[7] host 半加载')
try {
  const mod = await import(pathToFileURL(libIndex).href)
  check('导出 apply()', typeof mod.apply === 'function')
  check('name === dsh-webin', mod.name === 'dsh-webin', String(mod.name))
  check('inject 含 webServer 与 llm', Array.isArray(mod.inject) && mod.inject.includes('webServer') && mod.inject.includes('llm'), JSON.stringify(mod.inject))
} catch (e) {
  check('import lib/index.js', false, String(e?.message))
}

// ---- 8) client 半 banner ----
console.log('\n[8] client 半产物')
if (existsSync(libClient)) {
  const src = readFileSync(libClient, 'utf8')
  check('带 ModuleLoader banner', src.includes('window.__ModuleLoader__.load'))
  check('注册 shell.overlay（常驻宿主）', src.includes('shell.overlay'))
  check('注册 conversation.view（占位符）', src.includes('conversation.view'))

  /**
   * ## ⭐⭐⭐ 产物语法完整性 —— 半截产物会让 DSH 崩溃（实测踩过）
   *
   * 一次**被中断的构建**留下半截 lib/client.js（语法坏），
   * DSH 加载 ⇒ "dsh-webin: import failed" ⇒ **整个 DSH 弹崩溃框**。
   *
   * 构建被中断的来源：npm run check 跑到一半被打断（构建是第一环）。
   * 所以这里用 node --check 逐个验证语法。
   */
  /**
   * ⚠️ 用 `spawnSync(process.execPath, [...])` 而**不是** `execSync('node --check ...')`。
   *
   * `execSync` 在 Windows 上会经 `cmd.exe` 解析执行，于是平白多出一个
   * `cmd.exe` 依赖：受限环境（沙箱 / 组策略拉黑 cmd.exe）会直接抛
   * `spawnSync cmd.exe EBUSY`，而这里只是想验一个文件的语法。
   *
   * 参数固定时不需要 shell；用 `process.execPath` 还免掉了 PATH 查找 ——
   * 校验的是「当前这个 node」能否解析产物，语义也更准确。
   */
  const { spawnSync } = await import('node:child_process')
  const vm = await import('node:vm')
  for (const f of [libClient, join(SRC, 'lib', 'index.js')]) {
    const name = f.split(/[\\/]/).pop()
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' })
    if (r.status === 0) {
      check(`语法完整 ${name}`, true, true)
      continue
    }
    if (r.error === undefined) {
      check(`语法完整 ${name}`, false, `--check 报错：${String(r.stderr ?? '').slice(0, 110)}`)
      continue
    }
    /**
     * ## 子进程起不来 = 环境问题，不是产物问题
     *
     * 受限环境（沙箱 / 组策略禁止创建进程）里 `spawnSync` 直接抛
     * `EBUSY` / `EPERM`。这种情况**不能报 FAIL** —— 产物可能是好的，
     * 报红只会让人去查一个不存在的构建缺陷。
     *
     * 退回**进程内解析**：`vm.Script` 只编译、不执行，足以验语法。
     * ESM 形态没法在进程内只解析（`vm.SourceTextModule` 需要
     * `--experimental-vm-modules`），那种情况如实报 **SKIP**，不假装通过。
     */
    try {
      new vm.Script(readFileSync(f, 'utf8'), { filename: f })
      pass += 1
      console.log(`  OK   ${name}（进程内解析 —— 子进程不可用：${r.error.code}）`)
    } catch (e) {
      if (String(e?.message ?? '').includes('Cannot use import statement')) {
        skip += 1
        console.log(`  SKIP ${name}（ESM 无法进程内只解析，且子进程不可用：${r.error.code}）`)
      } else {
        check(`语法完整 ${name}`, false, String(e?.message ?? '').slice(0, 110))
      }
    }
  }
}

console.log(
  `\n=== 装配预检：${pass} 通过 / ${fail} 失败${skip > 0 ? ` / ${skip} 跳过（环境限制）` : ''} ===`,
)
if (fail === 0) {
  console.log('\nprofile 侧已就绪 —— 重启 DSH 后新 host 半会直接生效。')
}
process.exitCode = fail === 0 ? 0 : 1
