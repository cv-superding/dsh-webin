/**
 * 插件配置 —— 用户可在设置页调整的参数。
 *
 * ## 为什么要有这层
 *
 * 之前所有参数都硬编码在源码里（发送间隔、超时、截断上限…），
 * 用户反馈「设置页面设置的东西太少了」。但**不能把所有常量都暴露** ——
 * 那会变成一堆没人敢动的旋钮。这里只放**有明确取舍**的参数：
 *
 * | 分类 | 用户为什么想调 |
 * |---|---|
 * | 防封号 | 担心账号安全 ⇒ 想把节奏调更保守 |
 * | 行为 | 遇到超时/截断 ⇒ 想放宽 |
 * | 诊断 | 出问题时想看细节 |
 *
 * ## 设计约束
 *
 * 1. **每个字段必须有边界**（`LIMITS`）—— 用户能填 `0` 或 `999999`
 *    会让插件行为崩坏（比如发送间隔 0 秒 = 秒发 = 必封）。
 * 2. **校验在 host 侧做**，不信客户端传什么就存什么。
 * 3. **非法值回退到默认**并**报告原因**，不静默吞掉。
 * 4. 配置文件坏了**不能影响启动** —— 回退默认值。
 */

/** 配置形状（全部有默认值，字段可选 = 用默认）。 */
export interface WebinConfig {
  // ---- 防封号 ----
  /** 每次发送前的随机延迟下限（毫秒）。 */
  sendDelayMinMs: number
  /** 每次发送前的随机延迟上限（毫秒）。 */
  sendDelayMaxMs: number
  /** 连续多少次请求后进入长休（0 = 关闭）。 */
  longBreakAfter: number
  /** 长休时长下限（毫秒）。 */
  longBreakMinMs: number
  /** 长休时长上限（毫秒）。 */
  longBreakMaxMs: number
  /** 单轮（一个 turn）最多允许的网页请求数（0 = 不限）。 */
  maxRequestsPerTurn: number

  // ---- 行为 ----
  /** 等网页回复的超时（毫秒）。 */
  replyTimeoutMs: number
  /** 无人领活时的快速失败宽限（毫秒）。 */
  claimGraceMs: number
  /** 工具结果送进 prompt 时的截断上限（字符）。 */
  toolResultLimit: number
  /** 是否把工具目录下发给模型（关掉 = 模型不会调用工具）。 */
  enableTools: boolean
  /** 登录态快照保存间隔（毫秒）。 */
  snapshotIntervalMs: number

  // ---- 诊断 ----
  /** 是否输出详细日志（派发/游标/解析细节）。 */
  verboseLog: boolean
}

/** 每个数值字段的边界。超出即拒绝并说明原因。 */
export const LIMITS: Record<string, { min: number; max: number; unit: string; label: string }> = {
  sendDelayMinMs: { min: 0, max: 120_000, unit: 'ms', label: '发送间隔下限' },
  sendDelayMaxMs: { min: 0, max: 300_000, unit: 'ms', label: '发送间隔上限' },
  longBreakAfter: { min: 0, max: 500, unit: '次', label: '长休触发次数' },
  longBreakMinMs: { min: 0, max: 3_600_000, unit: 'ms', label: '长休时长下限' },
  longBreakMaxMs: { min: 0, max: 7_200_000, unit: 'ms', label: '长休时长上限' },
  maxRequestsPerTurn: { min: 0, max: 500, unit: '次', label: '单轮请求上限' },
  replyTimeoutMs: { min: 10_000, max: 3_600_000, unit: 'ms', label: '等回复超时' },
  claimGraceMs: { min: 1_000, max: 600_000, unit: 'ms', label: '无人领活宽限' },
  toolResultLimit: { min: 200, max: 200_000, unit: '字符', label: '工具结果截断' },
  snapshotIntervalMs: { min: 5_000, max: 3_600_000, unit: 'ms', label: '快照保存间隔' },
}

/**
 * 默认值。
 *
 * ⚠️ 这些数字**都有实测依据**，改之前先看注释：
 *   - `sendDelay*`：参考实现实测「固定间隔 = 定时器特征」，用 2000~4000 随机
 *   - `longBreakAfter: 0`（默认关）：参考对象没有长休机制，默认跟随
 *   - `replyTimeoutMs: 600_000`：实测最慢一次网页回复 6 分 12 秒（压缩路径）
 *   - `claimGraceMs: 20_000`：浏览器没打开时快速失败，不让用户干等 10 分钟
 *   - `toolResultLimit: 4_000`：防止一次 `read` 大文件把 prompt 顶爆
 */
export const DEFAULT_CONFIG: WebinConfig = {
  sendDelayMinMs: 2_000,
  sendDelayMaxMs: 4_000,
  longBreakAfter: 0,
  longBreakMinMs: 60_000,
  longBreakMaxMs: 180_000,
  maxRequestsPerTurn: 0,

  replyTimeoutMs: 600_000,
  claimGraceMs: 20_000,
  toolResultLimit: 4_000,
  enableTools: true,
  snapshotIntervalMs: 30_000,

  verboseLog: false,
}

/** 校验结果。 */
export interface ConfigCheck {
  ok: boolean
  /** 校验后的配置（非法字段已回退默认）。 */
  config: WebinConfig
  /** 被拒绝的字段与原因（空 = 全部合法）。 */
  problems: { field: string; reason: string; fellBackTo: unknown }[]
}

/**
 * 校验并归一化一份配置。
 *
 * 规则：
 *   - 未知字段**丢弃**（不写入，避免配置文件越长越乱）
 *   - 数值超界 / 非数 ⇒ 回退默认并记一条 problem
 *   - 布尔非真值 ⇒ 回退默认
 *   - `min > max` 的成对字段 ⇒ 交换（用户填反了不必报错，纠正即可）
 */
export function checkConfig(raw: unknown): ConfigCheck {
  const problems: ConfigCheck['problems'] = []
  const out: WebinConfig = { ...DEFAULT_CONFIG }
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, config: out, problems: [{ field: '(root)', reason: '不是对象', fellBackTo: '默认值' }] }
  }
  const src = raw as Record<string, unknown>

  for (const key of Object.keys(DEFAULT_CONFIG) as (keyof WebinConfig)[]) {
    const value = src[key]
    if (value === undefined) continue // 没给 = 用默认
    const fallback = DEFAULT_CONFIG[key]

    if (typeof fallback === 'boolean') {
      if (typeof value === 'boolean') out[key] = value as never
      else problems.push({ field: key, reason: `应为布尔，收到 ${typeof value}`, fellBackTo: fallback })
      continue
    }

    // 数值字段
    const num = typeof value === 'number' ? value : Number(value)
    const limit = LIMITS[key]
    if (!Number.isFinite(num)) {
      problems.push({ field: key, reason: `不是有效数字（${String(value)}）`, fellBackTo: fallback })
      continue
    }
    if (limit !== undefined && (num < limit.min || num > limit.max)) {
      problems.push({
        field: key,
        reason: `${num} 超出范围 ${limit.min}~${limit.max}${limit.unit}`,
        fellBackTo: fallback,
      })
      continue
    }
    out[key] = Math.round(num) as never
  }

  /** 成对区间填反了就交换 —— 用户意图明确，不必报错。 */
  if (out.sendDelayMinMs > out.sendDelayMaxMs) {
    const t = out.sendDelayMinMs
    out.sendDelayMinMs = out.sendDelayMaxMs
    out.sendDelayMaxMs = t
    problems.push({ field: 'sendDelayMinMs/Max', reason: '上下限填反了，已自动交换', fellBackTo: '交换后' })
  }
  if (out.longBreakMinMs > out.longBreakMaxMs) {
    const t = out.longBreakMinMs
    out.longBreakMinMs = out.longBreakMaxMs
    out.longBreakMaxMs = t
    problems.push({ field: 'longBreakMinMs/Max', reason: '上下限填反了，已自动交换', fellBackTo: '交换后' })
  }

  return { ok: problems.length === 0, config: out, problems }
}

/**
 * 算出一次随机发送延迟。
 *
 * 抽成函数是为了让 host 与 client 用**同一套逻辑** ——
 * 否则两边算出不同的间隔，行为不可预测。
 */
export function pickDelay(config: WebinConfig, random: () => number = Math.random): number {
  const min = Math.max(0, Math.min(config.sendDelayMinMs, config.sendDelayMaxMs))
  const max = Math.max(0, Math.max(config.sendDelayMinMs, config.sendDelayMaxMs))
  if (max <= min) return min
  return min + Math.floor(random() * (max - min + 1))
}

/** 配置的中文摘要（设置页与日志共用，避免两处措辞不一致）。 */
export function describeConfig(config: WebinConfig): string {
  const parts = [
    `间隔 ${config.sendDelayMinMs}~${config.sendDelayMaxMs}ms`,
    config.longBreakAfter > 0
      ? `长休 每${config.longBreakAfter}次休息 ${Math.round(config.longBreakMinMs / 1000)}~${Math.round(config.longBreakMaxMs / 1000)}s`
      : '长休 关',
    config.maxRequestsPerTurn > 0 ? `单轮上限 ${config.maxRequestsPerTurn}` : '单轮不限',
    `超时 ${Math.round(config.replyTimeoutMs / 1000)}s`,
    config.enableTools ? '工具 开' : '工具 关',
  ]
  return parts.join('，')
}
