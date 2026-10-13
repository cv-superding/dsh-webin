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

/** 统一跑 git —— 失败一律返回空串，由调用方决定降级策略。 */
function git(args: string): string {
  try {
    return execSync(`git ${args}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return ''
  }
}

function readCommit(): string {
  return git('rev-parse --short HEAD') || 'unknown'
}

/**
 * 版本号 —— 就是 `package.json` 里那个，**手动 bump**。
 *
 * ## 为什么不做「自动带提交数」
 *
 * 我一度改成 `<tag>+<距 tag 提交数>.<提交号>`（想让它每次提交都变），
 * 但用户一句话点醒了：**「直接更新到 0.2.0 不就行了！」**
 *
 * 那个方案确实过度设计：
 *   - `0.1.0+5.def5678` 对人没有意义 —— 用户想知道的是「这是第几版」，
 *     不是「距上一个 tag 有几个提交」
 *   - 它把「版本」和「构建元数据」混在一个字符串里，显示还得拆开
 *   - 真正的「这份产物是什么时候构建的」由 `builtAt` 回答更直接
 *
 * 所以回到最简单、最可预测的做法：**发版时手动改 `package.json`**。
 * 提交号仍然单独注入（它回答的是「跑的哪份代码」）。
 *
 * ⚠️ 唯一的纪律：**有意义的改动要记得 bump**。
 */
function readVersion(): string {
  return pkg.version ?? '0.0.0'
}

/** 从 `git+https://github.com/owner/repo.git` 里取出 `owner/repo`。 */
function readSlug(): string {
  const url = pkg.repository?.url ?? ''
  const m = /github\.com[/:]([^/]+\/[^/.]+)/.exec(url)
  return m === null ? 'cv-superding/dsh-webin' : m[1]!
}

const BUILD_DEFINE = {
  __LDW_VERSION__: JSON.stringify(readVersion()),
  __LDW_COMMIT__: JSON.stringify(readCommit()),
  __LDW_REPO__: JSON.stringify(readSlug()),
  /**
   * 构建时刻 —— 让用户能确认「这份是什么时候构建的」。
   *
   * 比提交号更直观：`git pull` 之后忘了 `npm run build` 时，
   * 时间戳会明显偏旧，一眼就能看出来。
   */
  __LDW_BUILT_AT__: JSON.stringify(new Date().toISOString()),
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
