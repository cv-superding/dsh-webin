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
  /**
   * 本地提交与远端**相同**。
   *
   * 与 `behind` 分开表达，因为「不落后」有两种含义：
   *   - `same === true` —— 确实是同一份
   *   - `same === false && behind === false` —— **本地更新**（自己提交过没推）
   */
  same?: boolean
  /**
   * 本地提交**比远端新**（远端历史里找不到本地提交）。
   *
   * ⚠️ 早期把「提交号不同」直接当成「有更新」，于是本地自己提交过、
   * 或者远端被 force-push 回退时都会误报「有更新」。
   */
  ahead?: boolean
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
 *   - `package.json` 的 version 常年不动
 *   - 真正决定「有没有新东西」的是**提交**
 *
 * ## 为什么用 GitHub 公开 API
 *
 * 不需要凭据（公开仓库），不碰用户的 GitHub token ——
 * 插件不该为了检查更新去要一个能写仓库的凭据。
 *
 * ## ⚠️ 必须有超时（真实 bug）
 *
 * 早期直接 `await fetch(...)` 没有超时。GitHub 在国内**经常连不上但不
 * 立刻报错**（连接挂着）—— 于是设置页的「检查更新」按钮**永远转圈**。
 * 用户报的就是这个：「插件更新的逻辑貌似有bug」。
 *
 * 现在用 `AbortController` 加 10 秒硬超时，超时明确报错而不是干等。
 *
 * ## 怎么判断「落后」（真实 bug）
 *
 * 早期判据是「提交号不等即有更新」。这会把两种**不该报更新**的情况
 * 也算进去：
 *   - 用户自己提交了没推（本地比远端**新**）
 *   - 远端被 force-push 回退
 *
 * 现在用 compare API 判断方向（`identical` / `ahead` / `behind` / `diverged`）。
 *
 * @param repo - `owner/repo`；省略用当前插件的
 * @param timeoutMs - 网络超时（默认 10 秒）
 */
export async function checkForUpdate(repo?: string, timeoutMs = 10_000): Promise<UpdateCheck> {
  const slug = repo ?? currentVersion().repo
  const checkedAt = Date.now()
  const mine = currentVersion().commit

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    /**
     * ## 用 compare API 而不是「取 main 的最新提交」
     *
     * `GET /commits/main` 只能告诉我「远端最新是什么」，**无法判断方向** ——
     * 提交号不同时，不知道是自己落后还是自己超前。
     *
     * `GET /compare/<mine>...main` 直接给出 `status`：
     *   `identical` / `ahead` / `behind` / `diverged`
     * 这正是需要的语义。
     *
     * ⚠️ 本地提交号是 `unknown` 时（tarball 安装 / 没注入）无从比较 ——
     * 退回 `commits/main` 只报告「远端最新是什么」，**不判定落后**
     * （报「有更新」会让用户白折腾）。
     */
    const url =
      mine === 'unknown'
        ? `https://api.github.com/repos/${slug}/commits/main`
        : `https://api.github.com/repos/${slug}/compare/${mine}...main`

    const res = await fetch(url, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'dsh-webin-update-check',
      },
      signal: controller.signal,
    })
    if (!res.ok) {
      /**
       * 404 有两种可能：仓库不存在，**或者本地提交号在远端不存在**
       * （用户自己 commit 过、或远端 force-push 过）。
       * 后者不是错误，是「本地更新」—— 明确说出来，别让用户以为网断了。
       */
      if (res.status === 404 && mine !== 'unknown') {
        return {
          ok: true,
          ahead: true,
          behind: false,
          same: false,
          latestCommit: mine,
          latestMessage: '本地提交在远端不存在（你可能有未推送的提交）',
          checkedAt,
        }
      }
      return { ok: false, reason: `GitHub 返回 ${res.status}`, checkedAt }
    }

    const data = (await res.json()) as {
      sha?: string
      status?: string
      ahead_by?: number
      behind_by?: number
      commits?: { sha?: string; commit?: { message?: string; committer?: { date?: string } } }[]
      commit?: { message?: string; committer?: { date?: string } }
    }

    /** 本地提交号未知时走的是 `commits/main`，没有 status 字段。 */
    if (mine === 'unknown') {
      const sha = typeof data.sha === 'string' ? data.sha.slice(0, 7) : ''
      if (sha === '') return { ok: false, reason: '响应里没有提交号', checkedAt }
      return {
        ok: true,
        latestCommit: sha,
        latestMessage: String(data.commit?.message ?? '').split('\n')[0] ?? '',
        latestAt: data.commit?.committer?.date ?? '',
        /** 无从比较 ⇒ 不判定落后。 */
        behind: false,
        same: false,
        checkedAt,
      }
    }

    /**
     * compare 的 `commits` 数组是「远端比本地多的提交」（status=behind 时）。
     * 取最后一个 = 远端最新。
     */
    const list = Array.isArray(data.commits) ? data.commits : []
    const newest = list.length > 0 ? list[list.length - 1] : undefined
    const latestCommit = typeof newest?.sha === 'string' ? newest.sha.slice(0, 7) : ''
    const status = String(data.status ?? '')

    return {
      ok: true,
      latestCommit: latestCommit === '' ? mine : latestCommit,
      latestMessage: String(newest?.commit?.message ?? '').split('\n')[0] ?? '',
      latestAt: newest?.commit?.committer?.date ?? '',
      behind: status === 'behind' || status === 'diverged',
      same: status === 'identical',
      ahead: status === 'ahead',
      checkedAt,
    }
  } catch (error) {
    /** `AbortError` 说明是超时，不是网络错误 —— 要分开说，否则用户排查方向会错。 */
    const aborted = (error as Error)?.name === 'AbortError'
    return {
      ok: false,
      reason: aborted
        ? `检查更新超时（${Math.round(timeoutMs / 1000)} 秒无响应）—— 可能是网络无法访问 GitHub`
        : ((error as Error)?.message ?? String(error)),
      checkedAt,
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 更新方式说明（给设置页显示）。
 *
 * 本插件有**两种**安装方式，更新动作不同，不能给一句笼统的「点这里升级」：
 *   - `link:` 本地目录 ⇒ 用户自己 `git pull`
 *   - npm 包 ⇒ `dsh plugin add` 重装
 *
 * ⚠️ **`lib/` 是构建产物**（在 `.gitignore` 里）。只 `git pull` 不重新构建
 * 的话，跑的还是旧产物 —— 用户会以为「更新了但没变化」。
 * 所以命令里必须带 `npm run build`，而且要告诉用户怎么确认。
 */
export function updateHint(repo?: string): string {
  const slug = repo ?? currentVersion().repo
  return [
    'cd <本插件目录>',
    'git pull',
    'npm install',
    'npm run build',
    '# 然后在 DSH 里重新加载插件（或重启 DSH）',
    `# 确认版本：设置页应显示新的提交号（仓库：https://github.com/${slug}）`,
  ].join('\n')
}

/** 一个提交号是不是「看起来像」短 sha（用于校验用户手填的值）。 */
export function looksLikeCommit(value: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(value.trim())
}

/**
 * 把一次更新检查的结果总结成**一句话**（设置页显示用）。
 *
 * ## 为什么要单独一个函数
 *
 * 早期设置页直接把 `behind` 映射成「有更新 / 无更新」两句话 ——
 * 于是「本地比远端新」（自己提交了没推）也显示成「无更新」，
 * 用户会困惑「我明明改了代码」。
 *
 * 现在把四种状态分开说。
 */
export function describeUpdate(check: UpdateCheck, mine: string): string {
  if (!check.ok) return `检查失败：${check.reason ?? '未知原因'}`
  if (check.same === true) return `已是最新（${mine}）`
  if (check.ahead === true) return `本地更新（${mine}）—— 远端还没有这个提交`
  if (check.behind === true) {
    const at = check.latestAt === undefined || check.latestAt === '' ? '' : ` · ${check.latestAt.slice(0, 10)}`
    return `有新版本 ${check.latestCommit ?? ''}${at} —— ${check.latestMessage ?? ''}`
  }
  return '状态未知（远端历史与本地不一致）'
}
