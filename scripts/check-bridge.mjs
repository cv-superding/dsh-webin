// 核对 hook 内写入的队列键 与 drain 脚本读取的键 是否字面一致。
// 这是跨 webview 桥的唯一契约，不一致就静默丢事件。
import { readFileSync } from 'node:fs'

const MARKER = '__dshWebinHookInstalled__'
const EVENT_QUEUE_KEY = `${MARKER}_events`

const src = readFileSync('F:/Code/DSH-Code/dsh-webin/dsh-webin/lib/client.js', 'utf8')

// hook 内实际写入用的表达式（源码是 window.${MARKER}_events，构建后 MARKER 已内联）
const writeKey = `${MARKER}_events`

console.log('宿主侧 EVENT_QUEUE_KEY :', EVENT_QUEUE_KEY)
console.log('hook 写入键           :', writeKey)
console.log('两者一致              :', EVENT_QUEUE_KEY === writeKey)
console.log('')

// 确认 bundle 里确实内联了这个字面量
const inlined = src.includes(EVENT_QUEUE_KEY)
console.log('bundle 内联该字面量   :', inlined)
console.log('')

// 找出 bundle 里所有出现该键的行
const lines = src.split('\n')
console.log('出现位置：')
lines.forEach((line, i) => {
  if (line.includes(EVENT_QUEUE_KEY) || line.includes('${MARKER}_events')) {
    console.log(`  行 ${i + 1}: ${line.trim().slice(0, 100)}`)
  }
})
