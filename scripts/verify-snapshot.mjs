#!/usr/bin/env node
/**
 * `snapshotLooksLoggedIn()` 的单元测试。
 *
 * 背景：这个函数是为了修一个**实测踩到的 bug** ——
 * DeepSeek 未登录时也会写 `userToken` / `__appKit_userInfo` 这些键，
 * 值是 `null`。早期版本只检查键是否存在，于是重启后的登录页
 * **把上一次的有效快照覆盖成空快照**，下次启动回写的就是一个空 token。
 *
 * 真实污染样本（实测自 ~/.dsh/webin/auth/default.json）：
 *   url: https://chat.deepseek.com/sign_in
 *   userToken: {"value":null,"__version":"0"}
 *   __appKit_userInfo: {"value":{"id":null},"__version":"0"}
 *
 * 用法：node scripts/verify-snapshot.mjs
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = dirname(dirname(fileURLToPath(import.meta.url)))

// 从产物里取真实实现（与运行时同一份代码）
//
// ⚠️ 边界不能只靠花括号配对：函数体里含**字符串字面量**（如 `'{'`、`'['`），
// 里面的花括号会让配对跑飞。所以取「配对结果」与「下一个顶层声明」的较近者。
const bundle = readFileSync(join(SRC, 'lib', 'client.js'), 'utf8')
const m = bundle.match(/function snapshotLooksLoggedIn\(([^)]*)\)\s*\{/)
if (m === null) throw new Error('产物里找不到 snapshotLooksLoggedIn —— 先跑 npm run build')
const start = m.index
const openBrace = bundle.indexOf('{', start)

let depth = 0
let braceEnd = -1
for (let i = openBrace; i < bundle.length; i += 1) {
  if (bundle[i] === '{') depth += 1
  else if (bundle[i] === '}') {
    depth -= 1
    if (depth === 0) {
      braceEnd = i + 1
      break
    }
  }
}
const rest = bundle.slice(openBrace)
const nextDecl = rest.search(/\n\t\t(?:function |const |exports\.)/)
const declEnd = nextDecl < 0 ? bundle.length : openBrace + nextDecl
const end = braceEnd > 0 && braceEnd <= declEnd ? braceEnd : declEnd

// eslint-disable-next-line no-new-func
const snapshotLooksLoggedIn = new Function(`${bundle.slice(start, end)}\n; return snapshotLooksLoggedIn;`)()

let pass = 0
let fail = 0
const check = (name, actual, expected) => {
  const ok = actual === expected
  if (ok) {
    pass += 1
    console.log(`  OK   ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL ${name} — 期望 ${expected}，实际 ${actual}`)
  }
}

const wrap = (v) => JSON.stringify({ value: v, __version: '0' })

console.log('=== snapshotLooksLoggedIn 单元测试 ===\n')

console.log('[1] 真实污染样本（必须判为未登录）')
check(
  'userToken={"value":null} + userInfo.id=null（实测样本）',
  snapshotLooksLoggedIn({
    localStorage: {
      userToken: '{"value":null,"__version":"0"}',
      __appKit_userInfo: '{"value":{"id":null},"__version":"0"}',
    },
    url: 'https://chat.deepseek.com/sign_in',
  }),
  false,
)

console.log('\n[2] 有效登录态（必须判为已登录）')
check(
  'userToken 非空',
  snapshotLooksLoggedIn({
    localStorage: { userToken: wrap('QoM8CcRUzgH/gtKWVe/Off35y7rQZAiY45dkBapHNbLn5sKWcNJhrhfeewRe2M1B') },
  }),
  true,
)
check(
  'userInfo.id 非空（token 缺失也能认）',
  snapshotLooksLoggedIn({
    localStorage: { __appKit_userInfo: '{"value":{"id":"b3a51eb9-c8b5-4688-be25-1d96d4ab6ccf"},"__version":"0"}' },
  }),
  true,
)

console.log('\n[3] 各种空/畸形值（必须判为未登录）')
check('空对象', snapshotLooksLoggedIn({}), false)
check('localStorage 缺失', snapshotLooksLoggedIn({ url: 'x' }), false)
check('localStorage 为空对象', snapshotLooksLoggedIn({ localStorage: {} }), false)
check('userToken 空串', snapshotLooksLoggedIn({ localStorage: { userToken: '' } }), false)
check('userToken = {"value":""}', snapshotLooksLoggedIn({ localStorage: { userToken: wrap('') } }), false)
check('userToken = {"value":"   "}', snapshotLooksLoggedIn({ localStorage: { userToken: wrap('   ') } }), false)
check('userToken = null', snapshotLooksLoggedIn({ localStorage: { userToken: wrap(null) } }), false)
check('userToken = {}', snapshotLooksLoggedIn({ localStorage: { userToken: '{}' } }), false)
check('userToken 非法 JSON', snapshotLooksLoggedIn({ localStorage: { userToken: '{broken' } }), false)
check('userToken = "null"', snapshotLooksLoggedIn({ localStorage: { userToken: 'null' } }), false)
check('userInfo.id 空串', snapshotLooksLoggedIn({ localStorage: { __appKit_userInfo: '{"value":{"id":""}}' } }), false)
check('userInfo.id = 0（非字符串）', snapshotLooksLoggedIn({ localStorage: { __appKit_userInfo: '{"value":{"id":0}}' } }), false)
check('userInfo = {"value":null}', snapshotLooksLoggedIn({ localStorage: { __appKit_userInfo: wrap(null) } }), false)

console.log('\n[4] 兼容扁平形状（没有 value 包装）')
check('userToken 裸字符串', snapshotLooksLoggedIn({ localStorage: { userToken: 'raw-token-abc' } }), true)
check('userInfo 扁平 {id:"x"}', snapshotLooksLoggedIn({ localStorage: { __appKit_userInfo: '{"id":"abc"}' } }), true)

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
process.exitCode = fail === 0 ? 0 : 1
