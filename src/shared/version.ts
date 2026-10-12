/**
 * 版本信息与更新检查。
 *
 * ## 三个常量来自构建期注入（`tsdown.config.ts` 的 `define`）
 *
 *   - `__LDW_VERSION__` — `package.json` 的 version
 *   - `__LDW_COMMIT__`  — 构建时的 `git rev-parse --short HEAD`
 *   - `__LDW_REPO__`    — `owner/repo`
 *
 * 为什么必须构建期注入而不是运行时读：
 *   - client 半在浏览器里，没有 `fs`，读不到 `package.json`
 *   - **提交号必须是构建时的快照** —— 运行时再问 git 得到的是「现在的 HEAD」，
 *     可能已经和正在跑的产物不一致（改了代码没重新构建）
 *
 * `declare` 只为让 TS 认识这三个标识符；构建期它们会被替换成字面量，
 * 所以运行时**不会**真的去读未定义的全局变量。
 */
declare const __LDW_VERSION__: string
declare const __LDW_COMMIT__: string
declare const __LDW_REPO__: string

/**
 * 安全读取构建期常量（万一没注入 —— 比如别的工具链直接编译源码）。
 *
 * 用 `typeof` 探测而不是直接引用：直接引用未声明的标识符会抛
 * `ReferenceError`，那样整个插件都加载不了。
 */
function injected(name: string, fallback: string): string {
  try {
    if (name === 'version' && typeof __LDW_VERSION__ === 'string') return __LDW_VERSION__
    if (name === 'commit' && typeof __LDW_COMMIT__ === 'string') return __LDW_COMMIT__
    if (name === 'repo' && typeof __LDW_REPO__ === 'string') return __LDW_REPO__
  } catch {
    /* 没注入 */
  }
  return fallback
}

/** 本插件的版本信息。 */
export interface PluginVersion {
  /** `package.json` 的 version。 */
  version: string
  /** 构建时的提交号（短）。 */
  commit: string
  /** `owner/repo`。 */
  repo: string
}

/** 当前跑的这份是哪个版本。 */
export function currentVersion(): PluginVersion {
  return {
    version: injected('version', '0.0.0'),
    commit: injected('commit', 'unknown'),
    repo: injected('repo', 'cv-superding/dsh-webin'),
  }
}

/** GitHub 仓库地址。 */
export function repoUrl(repo?: string): string {
  return `https://github.com/${repo ?? currentVersion().repo}`
}

/** 打开仓库「点 Star」的地址（直达 star 确认页，省一次点击）。 */
export function starUrl(repo?: string): string {
  return `${repoUrl(repo)}/stargazers`
}

/** 更新检查的判据（**只看提交号**，理由见 `checkForUpdate`）。 */
export interface UpdateCheck {
  /** 检查是否成功（网络失败时为 false，并带 reason）。 */
  ok: boolean
  /** 失败原因（ok=false 时有值）。 */
  reason?: string
  /** 远端最新提交号（短）。 */
  latestCommit?: string
  /** 远端最新提交的说明首行。 */
  latestMessage?: string
  /** 远端最新提交的时间（ISO）。 */
  latestAt?: string
  /** 本地是否落后。 */
  behind?: boolean
  /** 检查发生的时刻。 */
  checkedAt: number
}

/**
 * 检查更新。
 *
 * ## 为什么看**提交号**而不是「版本号」
 *
 * DSH 插件的实际分发方式是 `link:` 或本地目录（README 里的安装方式），
 * 用户的代码就是从仓库拉的一份工作副本。这种情况下：
 *   - `package.json` 的 version 常年不动（我一次都没 bump 过）
 *   - 真正决定「有没有新东西」的是**提交**
 *
 * 所以判据是「远端 main 的最新提交 ≠ 我构建时的提交」。
 *
 * ## 为什么用 GitHub 公开 API
 *
 * 不需要凭据（公开仓库），不碰用户的 GitHub token ——
 * 插件不该为了检查更新去要一个能写仓库的凭据。
 *
 * @param repo - `owner/repo`；省略用当前插件的
 */
export async function checkForUpdate(repo?: string): Promise<UpdateCheck> {
  const slug = repo ?? currentVersion().repo
  const checkedAt = Date.now()
  try {
    const res = await fetch(`https://api.github.com/repos/${slug}/commits/main`, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'dsh-webin-update-check',
      },
    })
    if (!res.ok) {
      return { ok: false, reason: `GitHub 返回 ${res.status}`, checkedAt }
    }
    const data = (await res.json()) as {
      sha?: string
      commit?: { message?: string; committer?: { date?: string } }
    }
    const sha = typeof data.sha === 'string' ? data.sha.slice(0, 7) : ''
    if (sha === '') return { ok: false, reason: '响应里没有提交号', checkedAt }

    const mine = currentVersion().commit
    return {
      ok: true,
      latestCommit: sha,
      latestMessage: String(data.commit?.message ?? '').split('\n')[0] ?? '',
      latestAt: data.commit?.committer?.date ?? '',
      /**
       * 本地提交号是 `unknown`（tarball 安装 / 没注入）时**不判定落后** ——
       * 无从比较，报「有更新」会让用户白折腾。
       */
      behind: mine !== 'unknown' && mine !== sha,
      checkedAt,
    }
  } catch (error) {
    return { ok: false, reason: (error as Error)?.message ?? String(error), checkedAt }
  }
}

/**
 * 更新方式说明（给设置页显示）。
 *
 * 本插件有**两种**安装方式，更新动作不同，不能给一句笼统的「点这里升级」：
 *   - `link:` 本地目录 ⇒ 用户自己 `git pull`（我们改不了他的工作副本）
 *   - npm 包 ⇒ `dsh plugin add` 重装
 *
 * 所以设置页给的是**可照做的命令**，而不是一个假按钮。
 */
export function updateHint(repo?: string): string {
  const slug = repo ?? currentVersion().repo
  return `cd <本插件目录> && git pull && npm install && npm run build`
}

/** 一个提交号是不是「看起来像」短 sha（用于校验用户手填的值）。 */
export function looksLikeCommit(value: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(value.trim())
}
