// 复现插件里的 UA 构造逻辑，验证输出。
// 用真实的 Electron 默认 UA 作为输入。
const nav = {
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.54 Electron/44.0.0 Safari/537.36',
}

function buildChromeUserAgent() {
  const major = /Chrome\/(\d+)/.exec(nav.userAgent)?.[1] ?? '0'
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
}

const ua = buildChromeUserAgent()
console.log('输入 (Electron 默认):')
console.log('  ' + nav.userAgent)
console.log('')
console.log('输出 (插件实际设置):')
console.log('  ' + ua)
console.log('')
console.log('  含 Electron 标识 : ' + ua.includes('Electron'))
console.log('  含 Chrome 主版本 : ' + (/Chrome\/(\d+)/.exec(ua)?.[1] ?? 'n/a'))
console.log('  与内置内核自洽   : ' + (ua.includes('Chrome/152') ? '是 (Chromium 152)' : '否'))

// 与官方 Chrome 152 的 UA 对比
const realChrome =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'
console.log('')
console.log('  与官方 Chrome 152 UA 逐字符相同 : ' + (ua === realChrome))
