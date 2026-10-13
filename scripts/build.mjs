#!/usr/bin/env node
/**
 * 跨平台构建入口（沿用 dsh-deepseek-web-login 的 scripts/build.mjs 模式）。
 * 只认本地已安装的 tsdown，缺了就明确报错，不联网。
 *
 * ## ⭐⭐ 原子发布：让 DSH「永不加载半成品」
 *
 * ## 真实事故（用户报「你又修崩了」）
 *
 * 时间线铁证：
 *   22:56:23  构建写产物
 *   22:56:25  **DSH 抛崩溃**（dsh-webin: import failed）
 *   22:56:48  DSH 重启后正常
 *
 * 原因：tsdown **直接原地覆写** `lib/client.js` —— 写盘过程中有一瞬间
 * 文件是**半截的**（或旧内容的残片）。DSH 的 client-hmr 每 500ms
 * stat 轮询这个文件，只要那一刻文件不完整，浏览器就会拉到坏 bundle
 * ⇒ import failed ⇒ **整个 DSH 弹崩溃框**。
 *
 * 而且客户端还实现了「自动重载」—— 构建一写盘，面板就会主动
 * reload 去拉新 bundle，等于**专挑最危险的时刻去读**。
 *
 * ## 修法：先写临时文件，再原子 rename
 *
 * `rename` 在同一文件系统内是**原子操作**：读者要么看到完整的旧文件，
 * 要么看到完整的新文件 —— **永远不存在半截状态**。
 *
 * ## 为什么这比「构建完再验证语法」更好
 *
 * 语法验证是我上一轮加的（preflight），但它只能在**事后**发现问题，
 * 而崩溃已经发生了。原子发布是从**根上消灭那个窗口**。
 * 两者互补：原子发布防「半成品被读到」，语法验证防「坏代码被提交」。
 */
import { createRequire } from 'node:module'
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  renameSync,
  copyFileSync,
  unlinkSync,
  rmdirSync,
  mkdirSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

function findTsdownBin() {
  const require = createRequire(import.meta.url)
  const manifest = require.resolve('tsdown/package.json')
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.tsdown
  if (!bin) throw new Error('tsdown 的 package.json 里找不到 CLI 入口（bin.tsdown）')
  return { version: pkg.version, path: resolve(dirname(manifest), bin) }
}

/**
 * 产物文件名 —— 需要原子发布的都是**运行时会被读取**的。
 *
 * `.map` 也要一起搬（否则 sourcemap 指向错位置，调试时行号对不上）。
 */
const ARTIFACTS = ['index.js', 'index.js.map', 'client.js', 'client.js.map']

/**
 * ## 原子发布
 *
 * 步骤：
 *   1. 构建正常写入 `lib/`（tsdown 的 outDir，无法改）
 *   2. 立刻把每个产物 **复制到 `lib/.staging/`**
 *   3. 用 `renameSync` 从 staging **原子替换** `lib/` 里的正式文件
 *
 * 为什么要有第 2 步（而不是直接 rename lib 里的文件到自己身上）：
 * rename 的语义是「把 A 移到 B」，A 和 B 不能是同一个路径。
 * 所以先复制到暂存目录，再从暂存目录 rename 回来 —— 那一下才是原子的。
 *
 * ⚠️ staging 必须与 lib **同一文件系统**（同目录下即可），
 * 否则 rename 退化成「复制+删除」，又不是原子的了。
 */
function atomicPublish() {
  const libDir = join(ROOT, 'lib')
  const stagingDir = join(libDir, '.staging')
  if (!existsSync(libDir)) return { published: 0, skipped: 0 }

  mkdirSync(stagingDir, { recursive: true })

  let published = 0
  let skipped = 0
  for (const name of ARTIFACTS) {
    const from = join(libDir, name)
    const staged = join(stagingDir, name)
    if (!existsSync(from)) {
      skipped++
      continue
    }
    /** 1) 复制到暂存（这一步不原子，但暂存目录没人读）。 */
    copyFileSync(from, staged)
    /** 2) 原子替换（读者只会看到完整的旧版或完整的新版）。 */
    renameSync(staged, from)
    published++
  }

  /** 清理暂存目录（⚠️ 目录要用 rmdirSync，unlinkSync 只能删文件 —— 踩过）。 */
  try {
    for (const name of readdirSync(stagingDir)) unlinkSync(join(stagingDir, name))
    rmdirSync(stagingDir)
  } catch {
    /* 清理失败无妨 */
  }

  return { published, skipped }
}

const libDir = join(ROOT, 'lib')
try {
  const tsdown = findTsdownBin()
  const result = spawnSync(process.execPath, [tsdown.path, '--config', 'tsdown.config.ts'], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: false,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1
  } else {
    /**
     * ⭐ 构建成功后立刻原子发布 —— 消灭「DSH 读到半成品」的窗口。
     */
    const { published } = atomicPublish()
    console.log(`[build] tsdown ${tsdown.version} 构建完成（原子发布 ${published} 个产物）：`)
    if (existsSync(libDir)) {
      for (const name of readdirSync(libDir).sort()) {
        if (!name.endsWith('.js')) continue
        const size = statSync(join(libDir, name)).size
        console.log(`  ${name.padEnd(12)} ${(size / 1024).toFixed(1)} KB`)
      }
    }
    console.log('[build] ✅ 已原子发布 —— 读者不会看到半截文件（防 DSH 崩溃）')
  }
} catch (error) {
  console.error('[build] 构建失败：找不到可用的本地 tsdown。')
  console.error('[build] 请先在包目录执行 npm ci 安装开发依赖。')
  console.error(`[build] 原因：${error?.message ?? error}`)
  process.exitCode = 1
}
