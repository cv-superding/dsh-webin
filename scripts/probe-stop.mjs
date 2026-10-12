
/**
 * ⚠️ **本脚本尚未适配发送流程重构（2026-10-13）**
 *
 * 它引用的 `buildSendScript()` **已被删除** —— 那个函数把
 * 「填充 → 等 2.4s → 校验 → 重试」全塞进一次 executeJavaScript，
 * 是跨进程调用，页面一导航就整体死掉（宿主永远等）。
 *
 * 现在拆成三段（见 `src/client/chat.ts`）：
 *   - `buildFillScript`    只填输入框
 *   - 客户端 `setTimeout`  随机延迟
 *   - `buildTriggerScript` 只点发送
 *
 * 要跑本探针，请先把里面的 `buildSendScript(...)` 换成
 * `buildTriggerScript(...)`（参数也变了：不再收 text / delayMs）。
 * 替换后行为需要**真浏览器**验证，所以没有自动改动。
 */

import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir, homedir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'

const b = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js'), 'utf8')
function extract(bundle, pattern, name) {
  const m = bundle.match(pattern); if (!m) throw new Error('找不到 ' + name)
  const start = m.index, openBrace = bundle.indexOf('{', start)
  let depth = 0, braceEnd = -1
  for (let i = openBrace; i < bundle.length; i += 1) {
    if (bundle[i] === '{') depth += 1
    else if (bundle[i] === '}') { depth -= 1; if (depth === 0) { braceEnd = i + 1; break } }
  }
  const before = bundle.slice(0, start); const consts = []; const seen = new Set()
  for (const c of before.matchAll(/^[ \t]*const ([A-Z][A-Z0-9_]*)\s*=\s*([^;\n]+);/gm)) { if (seen.has(c[1])) continue; seen.add(c[1]); consts.push(`const ${c[1]} = ${c[2]};`) }
  const body = bundle.slice(start, braceEnd)
  const bodyConsts = new Set([...body.matchAll(/^[ \t]*const ([A-Z][A-Z0-9_]*)\s*=/gm)].map(x=>x[1]))
  const needed = consts.filter(l => { const nm = /const ([A-Z][A-Z0-9_]*)/.exec(l)?.[1]; return nm && !bodyConsts.has(nm) })
  return `${needed.join('\n')}\n${body}`
}
const load = (pat, nm) => new Function(`${extract(b, pat, nm)}; return ${nm};`)()
const buildStopScript = load(/function buildStopScript\(/, 'buildStopScript')
const buildSendScript = load(/function buildSendScript\(/, 'buildSendScript')
const buildDeepSeekHook = load(/function buildDeepSeekHook\(/, 'buildDeepSeekHook')
const buildRestoreScript = load(/function buildRestoreScript\(/, 'buildRestoreScript')

const SNAP = join(homedir(), '.dsh', 'webin', 'auth', 'deepseek.json')
const browser = ['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find(x=>existsSync(x))
const port = 9950 + Math.floor(Math.random()*40)
const profile = mkdtempSync(join(tmpdir(), 'stop3-'))
const child = spawn(browser, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--headless=new','--no-first-run','about:blank'], { stdio:'ignore', windowsHide:true })
class Cdp { constructor(ws){this.ws=ws;this.id=0;this.pending=new Map();ws.addEventListener('message',ev=>{const m=JSON.parse(ev.data);const p=this.pending.get(m.id);if(p){this.pending.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result)}})}
  send(method,params={}){const id=++this.id;return new Promise((res,rej)=>{this.pending.set(id,{resolve:res,reject:rej});this.ws.send(JSON.stringify({id,method,params}));setTimeout(()=>{if(this.pending.delete(id))rej(new Error('t '+method))},90000)})}
  async eval(e){const r=await this.send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.text);return r.result.value} }
const strip = s => s.trim().replace(/;\s*$/,'')

const hints = { inputSelectors:['textarea[placeholder*="给 DeepSeek"]','textarea'], sendSelectors:['button[type="submit"]','[role="button"][aria-label*="发送"]'], signatures:[['ds-button--primary',60],['ds-button--filled',40],['ds-button--circle',50]], vetoes:['ds-toggle-button','ds-button--capsule'] }

let ws
let pass=0, fail=0
const check=(n,a,e=true)=>{ if(a===e){pass++;console.log('  OK   '+n)}else{fail++;console.log('  FAIL '+n+' — 期望 '+JSON.stringify(e)+'，实际 '+JSON.stringify(a))} }

try {
  let target=null
  for(let i=0;i<60;i++){try{const l=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();target=l.find(t=>t.type==='page');if(target)break}catch{}await sleep(250)}
  ws=new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',()=>j(new Error('ws')),{once:true})})
  const cdp=new Cdp(ws); await cdp.send('Runtime.enable'); await cdp.send('Page.enable')
  await cdp.send('Page.navigate',{url:'https://chat.deepseek.com/'})
  for(let i=0;i<80;i++){await sleep(250);if(await cdp.eval('document.readyState').catch(()=>'')==='complete')break}
  await cdp.eval(strip(buildRestoreScript(readFileSync(SNAP,'utf8'))))
  await cdp.send('Page.reload')
  for(let i=0;i<80;i++){await sleep(250);if(await cdp.eval('document.readyState').catch(()=>'')==='complete')break}
  for(let i=0;i<60;i++){if(await cdp.eval(`document.querySelectorAll('textarea').length>0`).catch(()=>false))break;await sleep(250)}
  await cdp.eval(strip(buildDeepSeekHook('/api/v0/chat/completion','/api/v0/chat/stop_stream')))

  console.log('=== 空闲时（不该找到停止键）===')
  const idle = JSON.parse(String(await cdp.eval(`Promise.resolve(${strip(buildStopScript(hints))}).then(r=>r)`)))
  console.log('  ', JSON.stringify(idle))
  check('空闲时不误点', idle.ok, false)

  const sent = JSON.parse(String(await cdp.eval(`Promise.resolve(${strip(buildSendScript('请从1数到800，用逗号分隔，不要省略任何数字',300,hints))}).then(r=>r)`)))
  console.log('\n发送:', sent.stage, JSON.stringify(sent.signals))

  console.log('\n=== 生成中（应该找到停止键，且是 --outlined 那个）===')
  let hit=null
  for(let i=0;i<14;i++){
    await sleep(700)
    const raw = String(await cdp.eval(`Promise.resolve(${strip(buildStopScript(hints))}).then(r=>r)`))
    const r = JSON.parse(raw)
    console.log(`  [${i}] ${raw}`)
    if(r.ok===true){hit=r;break}
  }
  check('生成中找到并点击了停止键', hit!==null)
  if(hit){
    check('命中 --outlined（停止键独有特征）', /outlined/i.test(String(hit.how)))
    check('没有命中 --filled/--primary（发送键）', !/filled|primary/i.test(String(hit.how)))
    check('分数达到阈值 60+', hit.score>=60)
  }
  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
  process.exitCode = fail===0?0:1
} finally { try{ws?.close()}catch{}; try{child.kill()}catch{}; await sleep(400); try{rmSync(profile,{recursive:true,force:true})}catch{} }
