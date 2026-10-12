/**
 * 测试隔离：把 `DSH_HOME` 指向临时目录。
 *
 * ## 为什么必须有这个（踩过的坑）
 *
 * 插件的状态根是 `~/.dsh/webin/`（登录快照、自定义 provider、**会话游标**）。
 * 测试里 `await apply(ctx)` 会真的去读写它 —— 早期版本没有隔离，
 * 结果**测试往用户的真实状态目录写了垃圾**：
 *
 * ```
 * ~/.dsh/webin/sessions/deepseek.json
 *   { "chunk-test": …, "catalog-test": …, "toolresult-test": …, "lifecycle-1": … }
 * ```
 *
 * 更糟的是**测试之间互相污染**：`chunk-test` 这个键第一次跑完就落盘了，
 * 第二次跑时游标说「已发过 N 条」⇒ 差分判定「无增量」⇒ 不派发任务
 * ⇒ 工具调用测试全挂（表现为「chunk 序列为空」，很难看出真因）。
 *
 * 所以：**任何会 `apply()` 的测试都必须先调 `isolate()`**。
 *
 * ## 用法
 *
 * ```js
 * import { isolate } from './lib/isolate.mjs'
 * const cleanup = isolate()        // 必须在 import lib/index.js **之前**
 * // …跑测试…
 * cleanup()                        // 结束时删临时目录
 * ```
 *
 * ⚠️ 必须在**动态 import 插件产物之前**调用 —— 插件在模块加载期就可能
 * 计算 `stateRoot()`（它读 `DSH_HOME` 环境变量）。
 */
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * 把 DSH_HOME 指向临时目录。
 *
 * @param label - 临时目录名前缀（便于排查是哪个测试留下的）
 * @returns 清理函数（删除临时目录）
 */
export function isolate(label = 'dsh-webin-test') {
  const dir = mkdtempSync(join(tmpdir(), `${label}-`))
  process.env.DSH_HOME = dir
  // 预建 webin 子目录，避免插件首次写入时的竞态
  mkdirSync(join(dir, 'webin'), { recursive: true })
  return () => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 删不掉不致命 */
    }
  }
}
