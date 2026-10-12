import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import type { UserConfig } from 'tsdown'

const PLUGIN_ID = process.env.DSW_PLUGIN_ID || 'dsh-webin'

/**
 * 构建期注入版本信息。
 *
 * ## 为什么在构建期注入，而不是运行时读
 *
 *   - **client 半在浏览器里跑**，没有 `fs`，读不到 `package.json`；
 *     只能靠构建期把常量写进产物。
 *   - **提交号必须是构建时的快照**。运行时再问 git，读到的是「现在的 HEAD」，
 *     而那可能已经和**正在跑的那份产物**不一致（改了代码还没重新构建）。
 *     更新检查要回答的正是「当前跑的这份是哪个提交」。
 *
 * 读不到 git（比如从 tarball 装的）时退化成 `unknown` —— **不能让构建失败**。
 */
const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
  version?: string
  repository?: { url?: string }
}

function readCommit(): string {
  try {
    return execSync('git rev-parse --short HEAD', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return 'unknown'
  }
}

/** 从 `git+https://github.com/owner/repo.git` 里取出 `owner/repo`。 */
function readSlug(): string {
  const url = pkg.repository?.url ?? ''
  const m = /github\.com[/:]([^/]+\/[^/.]+)/.exec(url)
  return m === null ? 'cv-superding/dsh-webin' : m[1]!
}

const BUILD_DEFINE = {
  __LDW_VERSION__: JSON.stringify(pkg.version ?? '0.0.0'),
  __LDW_COMMIT__: JSON.stringify(readCommit()),
  __LDW_REPO__: JSON.stringify(readSlug()),
}

const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  'cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-runtime/client',
]

const clientBundle: UserConfig = {
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    ...BUILD_DEFINE,
  },
  deps: {
    neverBundle: [...CLIENT_EXTERNALS],
    alwaysBundle: (id: string) => !CLIENT_EXTERNALS.includes(id),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: ' + JSON.stringify(PLUGIN_ID) + ', factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    codeSplitting: false,
  },
}

const hostBundle: UserConfig = {
  entry: { index: 'src/host/index.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  dts: false,
  sourcemap: true,
  clean: false,
  define: { ...BUILD_DEFINE },
  deps: {
    alwaysBundle: (id: string) => !(id.startsWith('node:') || id === 'electron'),
  },
  outputOptions: {
    entryFileNames: 'index.js',
  },
}

export default [hostBundle, clientBundle] satisfies UserConfig[]
