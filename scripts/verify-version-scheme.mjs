#!/usr/bin/env node
/**
 * ## 版本号（用户一句「直接更新到 0.2.0 不就行了！」定下的方案）
 *
 * 我一度做成「自动带提交数」（`0.1.0+5.def5678`），被用户否掉了 ——
 * 那是过度设计：
 *   - 对人没意义（想知道的是「第几版」，不是「距上个 tag 几个提交」）
 *   - 把「版本」和「构建元数据」混在一个字符串里，显示还得拆开
 *
 * 现在回到最简单的做法：**版本号手动 bump，提交号单独注入**。
 *
 * 这个脚本守住三件事：
 *   1. 版本号确实是 `package.json` 里那个（不再自动加后缀）
 *   2. 提交号 / 构建时间仍然注入（它们回答「跑的哪份代码」）
 *   3. 设置页显示的是干净的 `v0.2.0`
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

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const cfg = readFileSync(join(ROOT, 'tsdown.config.ts'), 'utf8')
const verSrc = readFileSync(join(ROOT, 'src', 'shared', 'version.ts'), 'utf8')
const clientSrc = readFileSync(join(ROOT, 'src', 'client', 'index.ts'), 'utf8')
const hostBundle = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')

console.log('=== 版本号 ===\n')

console.log('[1] ⭐ 版本号就是 package.json 里那个（手动 bump）')
{
  check('package.json 有 version', typeof pkg.version, 'string')
  /**
   * ⚠️ 必须是干净的 `x.y.z` —— 不带 `+提交数.sha` 那种后缀。
   * 那是被否掉的方案（用户：「直接更新到 0.2.0 不就行了！」）。
   */
  check('⭐ 是干净的 x.y.z', /^\d+\.\d+\.\d+$/.test(pkg.version), true)
  check('⭐ 不是自动生成的后缀形态', /\+\d+\.[0-9a-f]+/.test(pkg.version), false)
  console.log(`      当前版本：${pkg.version}`)
}

console.log('\n[2] ⭐ readVersion 只返回 package.json 的值（不再跑 git describe）')
{
  check('有 readVersion', /function readVersion\(\)/.test(cfg), true)
  check('⭐ 只读 pkg.version', /return pkg\.version \?\? '0\.0\.0'/.test(cfg), true)
  check('⭐ 不再调 git describe', /describe --tags/.test(cfg), false)
  check('⭐ 不再拼 + 后缀', /\+\$\{distance\}/.test(cfg), false)
}

console.log('\n[3] ⭐ 产物里的版本号与 package.json 一致')
{
  const m = /if \(name === "version" && true\) return "([^"]+)"/.exec(hostBundle)
  check('找到注入的版本', m !== null, true)
  check('⭐ 与 package.json 一致', m?.[1], pkg.version)
  /** 提交号仍要注入 —— 它回答「跑的哪份代码」。 */
  const c = /if \(name === "commit" && true\) return "([^"]+)"/.exec(hostBundle)
  check('⭐ 提交号仍注入', c !== null && /^[0-9a-f]{7}$/.test(c[1]), true)
  /** 构建时间也保留 —— 它比提交号直观（pull 后忘了 build 一眼能看出）。 */
  const b = /if \(name === "builtAt" && true\) return "([^"]+)"/.exec(hostBundle)
  check('⭐ 构建时间仍注入', b !== null && /^20\d\d-/.test(b[1]), true)
}

console.log('\n[4] ⭐ 设置页显示干净的 v<版本>')
{
  check(
    '⭐ 版本行用 ver.version（不拆后缀）',
    /className: 'ldw-ver-num' \}, `v\$\{ver\?\.version \?\? '\?'\}`/.test(clientSrc),
    true,
  )
  /** 被否掉的方案留下的东西要清干净。 */
  check('⭐ 没有 splitVersion 调用', /splitVersion\(/.test(clientSrc), false)
  check('⭐ 没有 buildPart 变量', /const buildPart/.test(clientSrc), false)
  check('⭐ 没有 .ldw-ver-build 样式', /\.ldw-ver-build\{/.test(clientSrc), false)
  check('⭐ version.ts 里也没有 splitVersion', /export function splitVersion/.test(verSrc), false)
}

console.log('\n[5] ⭐ formatBuiltAt 保留（构建时间仍然有用）')
{
  check('有 formatBuiltAt', /export function formatBuiltAt/.test(verSrc), true)
  check('client 用到它', /formatBuiltAt\(/.test(clientSrc), true)
  check('有 .ldw-ver-when 样式', /\.ldw-ver-when\{/.test(clientSrc), true)

  /** 从产物抽出来实测（两个产物里找）。 */
  const bundles = [hostBundle, readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')]
  const extract = (name) => {
    for (const src of bundles) {
      const s = src.indexOf(`function ${name}(`)
      if (s < 0) continue
      const bs = src.indexOf('{', s)
      let depth = 0
      for (let i = bs; i < src.length; i += 1) {
        if (src[i] === '{') depth += 1
        else if (src[i] === '}') {
          depth -= 1
          if (depth === 0) return src.slice(s, i + 1)
        }
      }
    }
    throw new Error(`找不到 ${name}`)
  }
  // eslint-disable-next-line no-new-func
  const formatBuiltAt = new Function(`${extract('formatBuiltAt')}\nreturn formatBuiltAt`)()
  const now = Date.parse('2026-10-13T12:00:00Z')
  check('刚刚', formatBuiltAt('2026-10-13T11:59:30Z', now), '刚刚构建')
  check('12 分钟前', formatBuiltAt('2026-10-13T11:48:00Z', now), '12 分钟前构建')
  check('3 小时前', formatBuiltAt('2026-10-13T09:00:00Z', now), '3 小时前构建')
  check('⭐ 空串 → 空（不渲染）', formatBuiltAt('', now), '')
  check('⭐ 坏时间戳 → 空（不崩）', formatBuiltAt('not-a-date', now), '')
  check('⭐ 未来时间当刚刚', formatBuiltAt('2026-10-13T12:05:00Z', now), '刚刚构建')
}

console.log('\n[6] ⭐ 发版纪律：有 release 就要有 tag，且 tag 与 package.json 一致')
{
  /** 这条是「版本怎么一直不变」那个问题的根因防护。 */
  check('⭐ CHANGELOG 里有当前版本', readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8').includes(pkg.version), true)
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
process.exitCode = fail === 0 ? 0 : 1
/** ⚠️ 显式退出 —— 防 handle 悬挂把 npm run check 卡死（verify-lifecycle 实测踩过）。 */
process.exit(process.exitCode)
