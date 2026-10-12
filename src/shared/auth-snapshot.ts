/**
 * 登录态判断 —— **host 与 client 共用**。
 *
 * ## 为什么必须共用
 *
 * 两处需要同一个判断：
 *   1. **client**：决定要不要把当前页面存成快照（未登录不覆盖有效快照）
 *   2. **host**：决定要不要把 LDW 模型列给用户（用户要求「已登录才能用 LDW 模型」）
 *
 * 两处判断不一致的后果很具体：
 *   - client 认为已登录存了快照、host 认为没登录 ⇒ 模型一会儿有一会儿没有
 *   - host 认为已登录、client 认为没登录 ⇒ 模型可选但发不出去
 *
 * ## 判断依据（实测）
 *
 * DeepSeek 未登录时**也会写 `userToken` 键**，值是 `{"value":null,"__version":"0"}`。
 * 所以不能看键是否存在，必须**解出值**再判断。
 *
 * 实测的未登录快照形态：
 *
 *     userToken        = {"value":null,"__version":"0"}
 *     __appKit_userInfo= {"value":{"id":null}}
 *     url              = https://chat.deepseek.com/sign_in
 *
 * 已登录时 `userToken` 是非空字符串（可能被 `{"value":"<token>"}` 包一层），
 * 且 `__appKit_userInfo.value.id` 是 UUID。
 */

/** 快照的最小形状。 */
export interface AuthSnapshotLike {
  localStorage?: Record<string, string>
  url?: string
}

/**
 * 解包 AppKit 的 `{"value":<v>,"__version":"0"}` 包装。
 *
 * ⚠️ 解析失败时**不能把原文当 token** —— 那样 `"{broken"` 这种畸形值
 * 会被当成有效 token（非空字符串），于是坏快照又能覆盖好快照。
 * 只有**看起来像 JSON 却解析失败**的才返回 undefined；
 * 真正的裸 token（不以 `{` 开头）才按原文返回。
 */
export function unwrapAppKit(raw: string | undefined): unknown {
  if (typeof raw !== 'string' || raw === '') return undefined
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  /** JSON 的空值字面量：`"null"` / `"undefined"` 都不是 token。 */
  if (trimmed === 'null' || trimmed === 'undefined') return undefined
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    /** 裸字符串 token（旧版页面可能这样存）。 */
    return trimmed
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (parsed !== null && typeof parsed === 'object' && 'value' in (parsed as object)) {
      return (parsed as { value: unknown }).value
    }
    return parsed
  } catch {
    /** 像 JSON 但解析失败 ⇒ 视为无效，绝不 fallback 成原文。 */
    return undefined
  }
}

/**
 * 这份快照看起来「确实登录了」吗？
 *
 * 判据（任一成立即算已登录）：
 *   - `userToken` 解包后是非空字符串
 *   - `__appKit_userInfo` 解包后 `.id` 是非空字符串
 */
export function snapshotLooksLoggedIn(snapshot: AuthSnapshotLike): boolean {
  const ls = snapshot.localStorage ?? {}

  const token = unwrapAppKit(ls.userToken)
  if (typeof token === 'string' && token.trim() !== '') return true

  const info = unwrapAppKit(ls['__appKit_userInfo'])
  if (info !== null && typeof info === 'object') {
    const id = (info as { id?: unknown }).id
    if (typeof id === 'string' && id.trim() !== '') return true
  }

  return false
}

/**
 * 从原始快照文本判断登录态（**不抛错**）。
 *
 * 坏 JSON 一律视为「未登录」而不是崩溃 —— 配置文件坏了不能让插件挂掉。
 */
export function snapshotTextLooksLoggedIn(text: string | undefined): boolean {
  if (typeof text !== 'string' || text.trim() === '') return false
  try {
    const parsed = JSON.parse(text) as AuthSnapshotLike
    if (parsed === null || typeof parsed !== 'object') return false
    return snapshotLooksLoggedIn(parsed)
  } catch {
    return false
  }
}
