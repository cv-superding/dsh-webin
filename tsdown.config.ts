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
 * ## ⭐ 版本号**自动**带上「距最近 tag 的提交数」
 *
 * ## 为什么必须自动（用户报的「版本怎么一直是 0.1.0？？？」）
 *
 * 原来版本号就是 `package.json` 里那个**手动**字段。我整轮只在建 release
 * 时 bump 过一次（`0.0.1 → 0.1.0`），之后又推了 **5 个提交**都没动它 ——
 * 于是设置页一直显示 `0.1.0`。
 *
 * 用户看到版本号不变，**自然会以为「更新没生效」** —— 即使提交号确实变了。
 * 这是个真实体验缺陷，不是「用户没看懂」。
 *
 * ## 做法：`<tag 版本>+<距 tag 的提交数>.<提交号>`
 *
 * 用 `git describe --tags --long` 拿「最近 tag + 距离」：
 *
 *     v0.1.0-0-g1d6e37d  →  0.1.0+0.1d6e37d   （正好在 tag 上）
 *     v0.1.0-5-gabc1234  →  0.1.0+5.abc1234   （tag 之后 5 个提交）
 *
 * 这样**每次提交后重新构建，版本号都会变**，不需要谁记得手动 bump。
 *
 * 格式用 `+`（semver 的 build metadata）而不是 `-`：
 *   - `+` 后面不参与优先级比较，不会让 npm 误判版本大小
 *   - 语义上它本来就是「构建元数据」，正合适
 *
 * ⚠️ 没有 tag 时（`git describe` 失败）退回 `<package.json 版本>+<提交总数>.<提交号>`，
 * 再不行就退回原值 —— **不能让构建失败**。
 */
function readVersion(): string {
  const base = pkg.version ?? '0.0.0'
  const described = git('describe --tags --long')
  if (described !== '') {
    /** 形态：`v0.1.0-5-gabc1234`（也可能没有 `v` 前缀）。 */
    const m = /^v?(.+?)-(\d+)-g([0-9a-f]+)$/.exec(described)
    if (m !== null) {
      const [, tag, distance, sha] = m
      /**
       * tag 上的版本号优先于 `package.json` ——
       * 两者不一致时，tag 才是「用户实际拿到的那个版本」的权威来源。
       */
      return `${tag}+${distance}.${sha}`
    }
  }
  /** 没 tag：用提交总数当单调递增的构建号。 */
  const count = git('rev-list --count HEAD')
  const sha = readCommit()
  if (count !== '' && sha !== 'unknown') return `${base}+${count}.${sha}`
  return base
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
