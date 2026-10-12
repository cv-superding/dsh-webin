#!/usr/bin/env node
/**
 * 跨平台构建入口（沿用 dsh-deepseek-web-login 的 scripts/build.mjs 模式）。
 * 只认本地已安装的 tsdown，缺了就明确报错，不联网。
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
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
    console.log(`[build] tsdown ${tsdown.version} 构建完成，产物：`)
    if (existsSync(libDir)) {
      for (const name of readdirSync(libDir).sort()) {
        if (!name.endsWith('.js')) continue
        const size = statSync(join(libDir, name)).size
        console.log(`  ${name.padEnd(12)} ${(size / 1024).toFixed(1)} KB`)
      }
    }
  }
} catch (error) {
  console.error('[build] 构建失败：找不到可用的本地 tsdown。')
  console.error('[build] 请先在包目录执行 npm ci 安装开发依赖。')
  console.error(`[build] 原因：${error?.message ?? error}`)
  process.exitCode = 1
}
