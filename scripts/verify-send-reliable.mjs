#!/usr/bin/env node
/**
 * ## 发送可靠性（用户报的「网页版早就有答案了，dsh 还在深度求索」）
 *
 * ## 用户的要求（原话）
 *
 * 「你看我跟你正常聊天，就很顺畅，那是因为我用的是模型的 apikey 接入的方式，
 *   但是我现在想让 LDW 实现同样的……因为这样网页中的内容回显到 dsh 的会话中，
 *   这种方式不封号」
 *
 * ## 为什么 API 接入顺畅、网页版接入容易卡
 *
 * API 接入：**一次请求天然对应一条流** —— 发出请求就有响应，结束就有
 * `[DONE]`，中间不需要猜。
 *
 * 网页版接入：我们只能「操作界面」，于是每一步都要**自己判断**：
 *   - 字填进去了吗？
 *   - 发送键点对了吗？
 *   - 消息真的发出去了吗？
 *   - 回复开始了吗？
 *   - 回复结束了吗？
 *
 * 任何一个判断松掉，就会卡在「DSH 一直等」而网页版其实早就有答案了。
 *
 * 这个脚本守住这几道判断。
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

let pass = 0
let fail = 0
const check = function (name, actual, expected) {
  if (arguments.length < 3) expected = true
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    pass += 1
    console.log(`  OK   ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL ${name}\n       期望 ${e}\n       实际 ${a}`)
  }
}

const chatSrc = readFileSync(join(ROOT, 'src', 'client', 'chat.ts'), 'utf8')
const clientSrc = readFileSync(join(ROOT, 'src', 'client', 'index.ts'), 'utf8')
const bundle = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')

console.log('=== 发送可靠性 ===\n')

console.log('[1] ⭐⭐ 点火前核对：输入框里确实是我们要发的字')
{
  /**
   * fill 和 trigger 是**两次独立的 executeJavaScript**，中间隔 2–4 秒。
   * 这期间 React 可能重渲染换掉输入框节点 —— 那时 trigger 找到的节点
   * 里可能没内容，按发送会：
   *   - 发出一条空消息，或
   *   - 什么都不发生（发送键是禁用态）
   * 而插件完全不知道，继续等一个永远不会来的回复。
   */
  check('⭐ trigger 接收期望文本', /export function buildTriggerScript\(hints\?: SendHints, expectText\?: string\)/.test(chatSrc), true)
  check('⭐ 有 sameText 归一化比较', /function sameText\(a, b\)/.test(chatSrc), true)
  check('⭐ 点火前核对', /if \(!sameText\(readInput\(input\), EXPECT\)\)/.test(chatSrc), true)
  /** React 换节点是常见的 —— 要重扫一遍再判失败，不能一次不匹配就放弃。 */
  check('⭐ 核对失败先重扫输入框', /重新扫一遍所有候选/.test(chatSrc), true)
  check('⭐ 真丢了才报 input-lost', /reason: 'input-lost'/.test(chatSrc), true)
  /** 调用方要真的把 prompt 传进去。 */
  check('⭐ 调用方传了 prompt', /buildTriggerScript\(sendHintsFor\(provider\), prompt\)/.test(clientSrc), true)
}

console.log('\n[2] ⭐⭐ 发送确认：点了之后要确认页面接受了')
{
  check('⭐ 探输入框是否被清空', /now\.trim\(\) === ''/.test(chatSrc), true)
  check('⭐ 失败给 input-not-cleared', /input-not-cleared/.test(chatSrc), true)
  check('⭐ 确认很快（6 × 200ms）', /MAX_TRIES = 6/.test(chatSrc), true)
  check('⭐ 成功标记 confirmed', /confirmed: true/.test(chatSrc), true)
}

console.log('\n[3] ⭐⭐⭐ 早期放弃：发出后 30 秒页面没动静就别等 8 分钟')
{
  /**
   * ## 这是用户报的核心问题
   *
   * 截图：网页版里**根本没有那条消息**，DSH 一直「深度求索中」到超时。
   *
   * 光靠 trigger 确认还不够（确认本身也可能被骗过）。所以再加一道：
   * **发出后 30 秒内页面上必须出现「正在生成」的迹象**。
   *
   * 判据是「一点动静都没有」：
   *   - 条数没增长
   *   - 内容没变化
   *   - 连思考区都是空的
   *
   * 三者都不成立才继续等 —— 正常生成中一定会命中至少一个。
   */
  check('⭐ 有 EARLY_GIVE_UP_MS 常量', /const EARLY_GIVE_UP_MS = 30_000/.test(clientSrc), true)
  check('⭐ 判据含「条数没增长」', /!countGrew &&/.test(clientSrc), true)
  check('⭐ 判据含「内容没变化」', /!contentChanged &&/.test(clientSrc), true)
  check('⭐ 判据含「思考区为空」', /think\.trim\(\) === ''/.test(clientSrc), true)
  check('⭐ 三个条件同时成立才放弃', /waitedMs > EARLY_GIVE_UP_MS &&[\s\S]{0,200}?!countGrew &&[\s\S]{0,100}?!contentChanged &&[\s\S]{0,100}?think\.trim\(\) === ''/.test(clientSrc), true)
  check('⭐ 放弃时交可照做的错误', /消息似乎没有发出去/.test(clientSrc), true)
  check('⭐ 放弃时清 pending', /clearPending\(\)[\s\S]{0,400}?消息似乎没有发出去/.test(clientSrc), true)

  /**
   * ⚠️ 早期放弃必须在「交付判据」**之后** —— 先看有没有结果可交，
   * 没有再判是不是压根没发出去。顺序反了会把正常回复误杀。
   */
  const iDeliver = clientSrc.indexOf("console.log('[dsh-webin] DOM 读到本轮回复'")
  const iEarly = clientSrc.indexOf('waitedMs > EARLY_GIVE_UP_MS')
  check('⭐⭐ 早期放弃在交付判据之后', iDeliver > 0 && iEarly > iDeliver, true)
}

console.log('\n[4] ⭐ 两道超时层次不能乱（早放弃 < 正常放弃 < adapter）')
{
  const cfg = readFileSync(join(ROOT, 'src', 'shared', 'config.ts'), 'utf8')
  const m = /replyTimeoutMs: (\d[\d_]*)/.exec(cfg)
  const replyTimeout = m === null ? 0 : Number(m[1].replace(/_/g, ''))
  check('配置里有 replyTimeoutMs', replyTimeout > 0, true)
  /** 客户端放弃 = 配置的 80%，要晚于 30 秒的早放弃。 */
  check('⭐ 早放弃（30s）早于正常放弃', 30_000 < replyTimeout * 0.8, true)
  check('⭐ 正常放弃用配置的 80%', /currentConfig\(\)\.replyTimeoutMs \* 0\.8/.test(clientSrc), true)
}

console.log('\n[5] ⭐⭐ 产物与源码一致（防止「改了源码没构建」）')
{
  const markers = [
    ['expectText 参数', /expectText/],
    ['sameText 核对', /sameText/],
    ['input-lost', /input-lost/],
    ['EARLY_GIVE_UP_MS', /EARLY_GIVE_UP_MS/],
    ['早期放弃文案', /消息似乎没有发出去/],
  ]
  for (const [label, re] of markers) {
    check(`⭐ 产物含「${label}」`, re.test(bundle), true)
  }
}

console.log('\n[6] ⭐ 错误信息都要「能照做」（用户看得到下一步）')
{
  /**
   * 失败信息不能只说「失败了」—— 用户得知道该干什么。
   */
  check('⭐ input-lost 说清了原因', /输入框里的内容在发送前丢失了/.test(clientSrc), true)
  check('⭐ input-lost 说清了动作', /消息没有发出去，请重试/.test(clientSrc), true)
  check('⭐ input-not-cleared 说清了动作', /请重试/.test(clientSrc), true)
  check('⭐ 早期放弃说清了动作', /请确认 LDW 页面正常后重试/.test(clientSrc), true)
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
process.exitCode = fail === 0 ? 0 : 1
/** ⚠️ 显式退出 —— 防 handle 悬挂把 npm run check 卡死（verify-lifecycle 实测踩过）。 */
process.exit(process.exitCode)
