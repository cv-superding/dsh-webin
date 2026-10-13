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
}

console.log(`\n=== 装配预检：${pass} 通过 / ${fail} 失败 ===`)
if (fail === 0) {
  console.log('\nprofile 侧已就绪 —— 重启 DSH 后新 host 半会直接生效。')
}
process.exitCode = fail === 0 ? 0 : 1
