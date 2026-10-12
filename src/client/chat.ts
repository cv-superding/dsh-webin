/**
 * dsh-webin — 页面操作脚本（模仿 cuckoo 的 `overlay/chat-input.ts`）。
 *
 * 这里做的是**真实操作界面**，不是调 API：
 *   1. 把文本写进 DeepSeek 的输入框（原生 value setter，兼容 React 受控组件）
 *   2. 触发发送（优先点发送按钮，兜底合成 Enter）
 *   3. 等 hook 抓到回复
 *
 * ## 为什么这一版重写了
 *
 * 旧版在真实页面上报 `send-failed: 未找到发送按钮，合成 Enter 也无效`，
 * 直接把整条链路打断（一次模型调用失败 → 该轮对话报错 → 压缩也无法经浏览器完成）。
 *
 * 旧版的三个缺陷：
 *   1. **发送按钮只找 `<button>`** —— DeepSeek 新版把发送控件做成
 *      `div[role="button"]`（内含 `<svg>` 箭头），`querySelectorAll('button')`
 *      根本命中不到，于是永远走 Enter 兜底。
 *   2. **兜底扫描只看 4 层祖先里的 `<button>`** —— 同样漏掉 `div[role=button]`。
 *   3. **合成 Enter 只派发 KeyboardEvent** —— React 的受控输入在某些实现里
 *      需要 `InputEvent` + `inputType`，且 `isTrusted=false` 的事件对
 *      「keydown 触发提交」的处理器不生效，需要多路兜底。
 *
 * 这一版的做法：**多策略候选 + 评分 + 发送后多信号校验 + 失败时带诊断输出**。
 */

/** 发送前随机延迟区间（cuckoo 用 2000~4000ms，消除"定时器特征"）。 */
const SEND_DELAY_MIN_MS = 2_000
const SEND_DELAY_MAX_MS = 4_000

/**
 * 生成「填输入框 + 发送」的页面脚本。
 *
 * 返回一个 Promise，resolve 为 JSON 字符串：
 *   `{ ok, stage, message, how, signals, candidates?, diag? }`
 *
 * `stage` 取值：`no-input` / `fill-failed` / `sent` / `send-failed`。
 * 失败时带上候选控件清单（`candidates`）与页面概况（`diag`），便于定位页面结构变化。
 *
 * @param hints - 平台定位策略（来自 Provider）：
 *   - `inputSelectors`：输入框候选（按优先级）
 *   - `sendSelectors`：发送控件候选
 *   - `signatures`：站点特征评分 `[正则源, 加分]`
 *   - `vetoes`：命中即否决的正则源
 */
export interface SendHints {
  inputSelectors: string[]
  sendSelectors: string[]
  signatures?: Array<[string, number]>
  vetoes?: string[]
}

export function buildSendScript(text: string, delayMs: number, hints?: SendHints): string {
  const inputSelectors = hints?.inputSelectors ?? [
    'textarea[placeholder*="给 DeepSeek"]',
    'textarea[placeholder*="DeepSeek"]',
    'textarea[placeholder*="输入"]',
    'textarea',
    'div[contenteditable="true"]',
    '[role="textbox"]',
  ]
  const sendSelectors = hints?.sendSelectors ?? [
    'button[type="submit"]',
    'button[aria-label*="send" i]',
    'button[aria-label*="发送"]',
    '[role="button"][aria-label*="发送"]',
    '[data-testid*="send" i]',
  ]

  return `(function () {
  var TEXT = ${JSON.stringify(text)};
  var DELAY = ${String(delayMs)};
  var INPUT_SELECTORS = ${JSON.stringify(inputSelectors)};
  var SEND_SELECTORS = ${JSON.stringify(sendSelectors)};
  var SIGNATURES = ${JSON.stringify(hints?.signatures ?? [])};
  var VETOES = ${JSON.stringify(hints?.vetoes ?? [])};

  // ---------- 通用工具 ----------

  function visible(el) {
    if (!el) return false;
    try {
      if (el.offsetWidth > 0 && el.offsetHeight > 0) return true;
      var r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return true;
      var s = window.getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
    } catch (e) { return false; }
  }

  function disabled(el) {
    if (!el) return true;
    try {
      if (el.disabled === true) return true;
      if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return true;
      if (el.classList && el.classList.contains('disabled')) return true;
    } catch (e) { /* ignore */ }
    return false;
  }

  function labelOf(el) {
    if (!el) return '';
    var parts = [];
    try {
      if (el.getAttribute) {
        parts.push(el.getAttribute('aria-label') || '');
        parts.push(el.getAttribute('title') || '');
        parts.push(el.getAttribute('data-testid') || '');
        parts.push(el.getAttribute('data-action') || '');
        parts.push(el.getAttribute('data-type') || '');
        parts.push(el.getAttribute('type') || '');
      }
      if (el.className && typeof el.className === 'string') parts.push(el.className);
      var t = (el.textContent || '').trim();
      if (t.length <= 24) parts.push(t);
    } catch (e) { /* ignore */ }
    return parts.join(' ').toLowerCase();
  }

  function describe(el) {
    if (!el) return null;
    var out = { tag: el.tagName };
    try {
      out.role = el.getAttribute('role') || null;
      out.aria = el.getAttribute('aria-label') || null;
      out.title = el.getAttribute('title') || null;
      out.testid = el.getAttribute('data-testid') || null;
      out.type = el.getAttribute('type') || null;
      out.cls = (typeof el.className === 'string' ? el.className : '').slice(0, 80);
      var r = el.getBoundingClientRect();
      out.rect = [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
      out.text = (el.textContent || '').trim().slice(0, 30);
      out.disabled = disabled(el);
      out.visible = visible(el);
    } catch (e) { /* ignore */ }
    return out;
  }

  // ---------- 输入框 ----------

  function findInput() {
    var sels = INPUT_SELECTORS;
    for (var i = 0; i < sels.length; i++) {
      var list;
      try { list = document.querySelectorAll(sels[i]); } catch (e) { continue; }
      for (var j = 0; j < list.length; j++) {
        var el = list[j];
        if (!visible(el) || disabled(el)) continue;
        return { el: el, how: sels[i] };
      }
    }
    return null;
  }

  // ---------- 发送目标 ----------

  /** 收集候选发送控件（不限 <button>，含 div[role=button]）。 */
  function collectCandidates(input) {
    var out = [];
    var seen = [];
    function push(el, how, weight) {
      if (!el || !visible(el) || disabled(el)) return;
      for (var i = 0; i < seen.length; i++) if (seen[i] === el) return;
      seen.push(el);
      var score = weight + scoreByLabel(el) + scoreBySiteSignature(el) + scoreByGeometry(el, input);
      out.push({ el: el, how: how, score: score });
    }

    // 1) 平台声明的语义选择器（来自 Provider.sendSelectors）
    var semantic = SEND_SELECTORS;
    for (var i = 0; i < semantic.length; i++) {
      var list;
      try { list = document.querySelectorAll(semantic[i]); } catch (e) { continue; }
      for (var j = 0; j < list.length; j++) push(list[j], semantic[i], 100);
    }

    // 2) 输入框附近的发送控件：从输入框往上找，逐层扩大范围
    var box = input;
    for (var k = 0; k < 6 && box; k++) {
      box = box.parentElement;
      if (!box) break;
      var near;
      try {
        near = box.querySelectorAll('button, [role="button"], [role="submit"], a[href="#"], div[tabindex]');
      } catch (e) { break; }
      for (var m = 0; m < near.length; m++) push(near[m], 'near-input(L' + (k + 1) + ')', 40 - k * 5);
      // 找到第一个同时含输入框和候选按钮的容器就够了
      if (out.length > 0 && k >= 2) break;
    }

    // 3) 兜底：所有含 svg 的可点元素（DeepSeek 的箭头按钮就是这种）
    var svgHosts;
    try { svgHosts = document.querySelectorAll('button:has(svg), [role="button"]:has(svg), div:has(> svg)'); } catch (e) { svgHosts = []; }
    for (var n = 0; n < svgHosts.length; n++) push(svgHosts[n], 'svg-host', 10);

    out.sort(function (a, b) { return b.score - a.score; });
    return out;
  }

  function scoreByLabel(el) {
    var L = labelOf(el);
    if (!L) return 0;
    if (/send|发送|submit|提交/.test(L)) return 50;
    if (/stop|停止|中断/.test(L)) return -80;   // 生成中的"停止"按钮绝不能点
    if (/attach|上传|附件|file|image|图片|deep|think|search|联网|语音|mic/.test(L)) return -60;
    return 0;
  }

  /**
   * 站点特征评分。
   *
   * **这是实测出来的，不是猜的**：用真 Chrome 加载 chat.deepseek.com、
   * 注入登录态后 dump 真实 DOM（scripts/probe-send.mjs）得到的事实：
   *
   *   - 发送键：div[role=button].ds-button.ds-button--primary.ds-button--filled.ds-button--circle
   *     —— **不是 button 元素，没有 aria-label，没有文字**（纯图标）
   *   - 紧邻它左边有个同样尺寸的图标键：
   *     .ds-button--iconLabelPrimary.ds-button--icon.ds-button--capsule
   *     —— 那是附件键，点错会弹文件选择框
   *   - 输入框下方两个开关：.ds-toggle-button（「深度思考」「智能搜索」）
   *     —— 点了会改发送语义，绝不能误点
   *
   * 只用「几何位置 + 邻近度」评分时，发送键 32 分、附件键 31 分 —— **只差 1 分**，
   * DOM 稍一变动就会点错。所以必须把这些 class 特征显式编码进评分。
   *
   * 这些规则是**加分项而非唯一路径**：命中不了还有几何/语义兜底，
   * 页面大改时最坏退化成"找不到发送键"，不会误点开关。
   */
  function scoreBySiteSignature(el) {
    var cls = '';
    try { cls = (typeof el.className === 'string' ? el.className : '') + ' ' + labelOf(el); } catch (e) { return 0; }
    var s = 0;

    // 平台声明的加分特征（SIGNATURES = [[正则源, 加分], ...]）
    for (var i = 0; i < SIGNATURES.length; i++) {
      var src = SIGNATURES[i][0];
      var add = SIGNATURES[i][1];
      try {
        if (new RegExp(src).test(cls)) s += add;
      } catch (e) { /* 校验阶段已排除非法正则 */ }
    }

    // 平台声明的否决特征（VETOES = [正则源, ...]）—— 命中即重罚
    for (var j = 0; j < VETOES.length; j++) {
      try {
        if (new RegExp(VETOES[j]).test(cls)) s -= 120;
      } catch (e) { /* ignore */ }
    }

    // 输入框本体/镜像不是按钮（通用规则，与平台无关）
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') s -= 200;

    return s;
  }

  /** 发送控件通常在输入框的右侧或右下方。 */
  function scoreByGeometry(el, input) {
    try {
      var a = input.getBoundingClientRect();
      var b = el.getBoundingClientRect();
      var score = 0;
      // 垂直方向与输入框有重叠，或紧贴其下沿（DeepSeek 的发送键在输入框下方右侧）
      if (b.top < a.bottom && b.bottom > a.top) score += 20;
      else if (b.top >= a.bottom - 4 && b.top < a.bottom + 80) score += 15;
      // 在输入框右半部分
      if (b.left >= a.left + a.width * 0.5) score += 15;
      // 离输入框越近越好（用右下角距离，贴合"发送键在右下"的布局）
      var dx = Math.abs(b.left - (a.right - b.width));
      var dy = Math.abs(b.top - a.bottom);
      score -= Math.min(30, (dx + dy) / 40);
      return score;
    } catch (e) { return 0; }
  }

  // ---------- 填入 ----------

  function setText(el, value) {
    el.focus();
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      // React 受控组件：必须走原型链上的原生 setter，直接 el.value = x 不触发 onChange
      var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      var desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, value);
      else el.value = value;
      if (el.value !== value) return { ok: false, how: 'native-setter-noop' };
      // 两路事件都发：React 16/17 监听 input，个别实现监听 InputEvent
      try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
      try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}
      try {
        el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: false, inputType: 'insertText', data: value }));
      } catch (e) {}
      return { ok: true, how: 'native-setter' };
    }
    if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') {
      // contenteditable：优先 paste（cuckoo 的做法，长文本最快且不触发附件识别）
      try {
        var sel = window.getSelection();
        if (sel) {
          var range = document.createRange();
          range.selectNodeContents(el);
          sel.removeAllRanges();
          sel.addRange(range);
          document.execCommand('selectAll', false, undefined);
          document.execCommand('delete', false, undefined);
        }
      } catch (e) {}
      try {
        var dt = new DataTransfer();
        dt.setData('text/plain', value);
        el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
        if ((el.innerText || el.textContent || '').trim().length > 0) {
          return { ok: true, how: 'paste-event' };
        }
      } catch (e) {}
      try {
        if (document.execCommand('insertText', false, value)) return { ok: true, how: 'execCommand-insertText' };
      } catch (e) {}
      el.textContent = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return { ok: true, how: 'textContent-fallback' };
    }
    return { ok: false, how: 'unsupported-element' };
  }

  function readInput(el) {
    try {
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el.value || '';
      return el.innerText || el.textContent || '';
    } catch (e) { return ''; }
  }

  // ---------- 发送 ----------

  function pressEnter(el) {
    var opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, isComposing: false };
    try { el.dispatchEvent(new KeyboardEvent('keydown', opts)); } catch (e) {}
    try { el.dispatchEvent(new KeyboardEvent('keypress', opts)); } catch (e) {}
    try { el.dispatchEvent(new KeyboardEvent('keyup', opts)); } catch (e) {}
  }

  /**
   * 生成中会出现的"停止"控件。
   *
   * ⚠️ **在 DeepSeek 上这个信号基本无效**：实测（scripts/probe-send.mjs）
   * 发送键和停止键都是**纯图标 div**，既没有 aria-label 也没有文字，
   * 靠文本匹配找不到。保留它只为兼容其它站点形态，**不作为主判据**。
   */
  function hasStopControl() {
    var all;
    try { all = document.querySelectorAll('button, [role="button"]'); } catch (e) { return false; }
    for (var i = 0; i < all.length; i++) {
      if (!visible(all[i])) continue;
      var L = labelOf(all[i]);
      var t = (all[i].textContent || '').trim();
      if (/stop|停止|中断/.test(L) || t === '停止生成' || t === '停止') return true;
    }
    return false;
  }

  /**
   * hook 是否观察到一次新的 completion 请求。
   *
   * **这才是 DeepSeek 上最可靠的发送成功信号**：发送生效 ⇔ 页面自己发出了
   * POST /api/v0/chat/completion。hook（hook.ts）会把这个事实记在
   * window.__dshWebinHookInstalled___requests 上。
   *
   * 为什么不能只看"输入框被清空"：发送失败时页面可能也清空输入框
   * （React 受控状态被重置），那样会误判成功、然后永远等不到回复。
   */
  function sentRequestCount() {
    try {
      var n = window.__dshWebinHookInstalled___requests;
      return typeof n === 'number' ? n : 0;
    } catch (e) { return 0; }
  }

  /** 发送成功的多信号校验。 */
  function verify(input, before) {
    var signals = {};
    signals.cleared = readInput(input).trim() === '';
    signals.stopControl = hasStopControl();
    signals.requestSent = sentRequestCount() > before.requests;
    var nowLen = 0;
    try { nowLen = document.body.innerText.length; } catch (e) {}
    signals.grew = nowLen > before.bodyLen + 20;

    /**
     * 判据优先级（实测校准）：
     *
     *   1. **requestSent** —— 页面真的发出了 completion 请求。**唯一铁证**。
     *   2. stopControl —— 出现了停止生成控件（生成中）。可靠，但 DeepSeek 上是纯图标，测不到。
     *   3. cleared —— 输入框被清空。**单独不可信**：dry-run 实测发现，
     *      点击被拦截、消息根本没发出去时输入框也可能是空的。
     *   4. grew —— 页面正文变长。**最弱**：dry-run 实测它会在没发送时误报为 true
     *      （页面本身有动画/懒加载在改文本）。**只能作为辅助，不能单独判定成功**。
     *
     * 所以：铁证优先；cleared 单独成立也算（有些站点确实清空即发送）；
     * 但 **grew 单独成立不算** —— 否则会把"没发出去"误判成成功，
     * 然后一直等一个永远不会来的回复。
     */
    signals.ok = signals.requestSent || signals.stopControl || signals.cleared;
    return signals;
  }

  return new Promise(function (resolve) {
  /**
   * 输入框可能还没渲染出来（SPA 首次加载 / 刚 reload 完）。
   *
   * 早期实现只查一次，查不到就报 no-input 直接失败 —— 而宿主此时
   * 已经把任务消费掉了，用户看到的就是「处理失败」。
   * 这里改成**轮询等一会儿**（最多 12 秒），页面渲染完自然就能命中。
   */
  function waitForInput(timeoutMs) {
    var deadline = Date.now() + timeoutMs;
    return new Promise(function (resolve) {
      (function attempt() {
        var found = findInput();
        if (found) { resolve(found); return; }
        if (Date.now() > deadline) { resolve(null); return; }
        setTimeout(attempt, 300);
      })();
    });
  }

  waitForInput(12000).then(function (found) {
    if (!found) {
      resolve(JSON.stringify({
        ok: false, stage: 'no-input',
        message: '等了 12 秒仍找不到可见的输入框（页面结构可能已变，或还停在登录页）',
        diag: {
          textareas: document.querySelectorAll('textarea').length,
          editables: document.querySelectorAll('[contenteditable="true"]').length,
          url: location.href,
          bodyHead: (document.body ? document.body.innerText : '').slice(0, 120)
        }
      }));
      return;
    }
    var input = found.el;

    var filled = setText(input, TEXT);
    if (!filled.ok) {
      resolve(JSON.stringify({ ok: false, stage: 'fill-failed', message: '输入框类型不支持：' + filled.how, how: filled.how }));
      return;
    }

    // 校验真的填进去了 —— contenteditable 的合成事件可能被页面拒绝
    var after = readInput(input);
    if (after.trim().length === 0) {
      resolve(JSON.stringify({
        ok: false, stage: 'fill-failed',
        message: '填入后输入框仍为空（页面拒绝了合成输入事件）',
        how: filled.how, inputHow: found.how
      }));
      return;
    }

    // 等 React 把状态吃进去再发
    setTimeout(function () {
      var before = { bodyLen: 0, requests: sentRequestCount() };
      try { before.bodyLen = document.body.innerText.length; } catch (e) {}

      var cands = collectCandidates(input);
      var target = cands.length > 0 ? cands[0] : null;
      var usedEnter = false;

      if (target && target.score > 0) {
        try { target.el.click(); } catch (e) {}
      } else {
        pressEnter(input);
        usedEnter = true;
      }

      // 最多观察 2.4s：先按 150ms 密集看，再看两次兜底
      var waited = 0;
      var timer = setInterval(function () {
        waited += 150;
        var sig = verify(input, before);
        var lastChance = waited >= 2400;
        if (!sig.ok && !lastChance) return;
        clearInterval(timer);

        // 还没成功：换另一条路再试一次（点按钮 ↔ 合成 Enter）
        if (!sig.ok) {
          if (usedEnter && target) { try { target.el.click(); } catch (e) {} }
          else pressEnter(input);
          setTimeout(function () {
            var sig2 = verify(input, before);
            resolve(JSON.stringify({
              ok: sig2.ok,
              stage: sig2.ok ? 'sent' : 'send-failed',
              message: sig2.ok
                ? (usedEnter ? '合成 Enter 生效（二次尝试）' : '点击发送按钮生效（二次尝试）')
                : '发送按钮与合成 Enter 都没生效',
              how: usedEnter ? 'enter(retry)' : ((target && target.how) || 'none'),
              signals: sig2,
              inputHow: found.how,
              fillHow: filled.how,
              candidates: cands.slice(0, 6).map(function (c) { return { how: c.how, score: Math.round(c.score), el: describe(c.el) }; }),
              diag: { url: location.href, textareas: document.querySelectorAll('textarea').length }
            }));
          }, 1200);
          return;
        }

        resolve(JSON.stringify({
          ok: true,
          stage: 'sent',
          message: usedEnter ? '已合成 Enter' : ('已点击发送控件 ' + target.how),
          how: usedEnter ? 'enter' : target.how,
          signals: sig,
          inputHow: found.how,
          fillHow: filled.how
        }));
      }, 150);
    }, DELAY);
    });
  });
})();`
}

/**
 * 诊断脚本：把页面上的输入框与候选发送控件列出来。
 *
 * 发送失败时，宿主面板上点「诊断」就能拿到这份清单 —— 不用再靠用户描述界面。
 * 同时它也是**校准新平台的第一步**：拿这份 dump 去填 Provider 的选择器。
 */
export function buildDiagnoseScript(hints?: SendHints): string {
  const inputSelectors = hints?.inputSelectors ?? ['textarea', 'div[contenteditable="true"]', '[role="textbox"]']
  const sendSelectors = hints?.sendSelectors ?? ['button[type="submit"]']
  return `(function () {
  var INPUT_SELECTORS = ${JSON.stringify(inputSelectors)};
  var SEND_SELECTORS = ${JSON.stringify(sendSelectors)};
  function visible(el) {
    if (!el) return false;
    try { return el.offsetWidth > 0 && el.offsetHeight > 0; } catch (e) { return false; }
  }
  function describe(el) {
    var o = { tag: el.tagName };
    try {
      o.role = el.getAttribute('role');
      o.aria = el.getAttribute('aria-label');
      o.title = el.getAttribute('title');
      o.testid = el.getAttribute('data-testid');
      o.type = el.getAttribute('type');
      o.cls = (typeof el.className === 'string' ? el.className : '').slice(0, 60);
      var r = el.getBoundingClientRect();
      o.rect = [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
      o.text = (el.textContent || '').trim().slice(0, 24);
      o.disabled = el.disabled === true || el.getAttribute('aria-disabled') === 'true';
    } catch (e) {}
    return o;
  }
  var out = { url: location.href, inputs: [], buttons: [], svgHosts: [] };
  try {
    var tas = document.querySelectorAll('textarea');
    for (var i = 0; i < tas.length; i++) {
      var d = describe(tas[i]);
      d.placeholder = tas[i].getAttribute('placeholder');
      d.visible = visible(tas[i]);
      out.inputs.push(d);
    }
    var ces = document.querySelectorAll('div[contenteditable="true"], [role="textbox"]');
    for (var j = 0; j < ces.length; j++) {
      var e2 = describe(ces[j]);
      e2.visible = visible(ces[j]);
      out.inputs.push(e2);
    }
    var bs = document.querySelectorAll('button, [role="button"]');
    for (var k = 0; k < bs.length; k++) {
      if (!visible(bs[k])) continue;
      out.buttons.push(describe(bs[k]));
    }
    try {
      var sv = document.querySelectorAll('button:has(svg), [role="button"]:has(svg)');
      for (var m = 0; m < sv.length; m++) out.svgHosts.push(describe(sv[m]));
    } catch (e) {}
  } catch (e) { out.error = String(e && e.message); }
  return JSON.stringify(out);
})();`
}

/**
 * 生成「确保深度思考开关处于期望状态」的页面脚本。
 *
 * ## 为什么需要它（用户实测发现的缺陷）
 *
 * 「点的思考模式那个模型，发现没有思考啊」。
 *
 * 查代码发现：host 把 `thinking` 标记一路传到 client（`job.thinking`），
 * **但 client 从来没用它做任何事** —— 只声明了类型，没在页面上开启思考。
 * 所以模型选择器里选「深度思考」，实际请求还是普通模式。
 *
 * ## 为什么不能只看文本
 *
 * 页面文案会变（中英文、A/B 测试）。所以判据是**多信号加权**：
 *   1. 文本 / aria-label 含思考关键词（+100，主信号）
 *   2. `aria-pressed` / `aria-checked` / `role=switch`（+20，开关语义）
 *   3. 几何位置在输入框上方 0~140px 且水平重叠（+40）
 *
 * ## 状态判定
 *
 * 开关的「已开启」表达方式不统一，实测三种任一命中即算开：
 *   `aria-pressed="true"` / `aria-checked="true"` / `data-state="on"` / class 含 active…
 *
 * ## 三个拒绝盲点的情况（都会报出来，不静默）
 *
 *   - `no-toggle`：没找到开关（页面改版？）
 *   - `ambiguous`：多个同分候选且状态不一致 —— **盲点可能把已开的关掉**
 *   - `disabled`：开关不可点（未登录 / 该模型不支持思考）
 *
 * @param want - 期望状态（true = 要思考）
 */
export function buildThinkingScript(want: boolean): string {
  return `(function () {
  var want = ${want ? 'true' : 'false'};
  var KW = /深度思考|思考|deep\\s*think|think|reason|推理|R1/i;

  function visible(el) {
    if (!el) return false;
    if (el.offsetWidth <= 0 || el.offsetHeight <= 0) return false;
    var s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  }

  /** 开关当前是否「已开启」。三种表达方式任一命中即算开。 */
  function isOn(el) {
    if (el.getAttribute('aria-pressed') === 'true') return true;
    if (el.getAttribute('aria-checked') === 'true') return true;
    var st = el.getAttribute('data-state');
    if (st === 'on' || st === 'checked' || st === 'active') return true;
    var cls = String(el.className || '');
    if (/(^|[\\s-])(active|selected|checked|enabled)([\\s-]|$)/i.test(cls)) return true;
    return false;
  }

  /** 输入框用作几何参照；找不到就退化成「只按文本找」。 */
  var ta = document.querySelector('textarea, div[contenteditable="true"]');
  var box = ta ? ta.getBoundingClientRect() : null;

  var sel = 'button, [role="button"], [role="switch"], [role="radio"], [role="menuitemcheckbox"], label, [aria-pressed], [aria-checked], [data-state]';
  var list = document.querySelectorAll(sel);
  var scored = [];
  for (var i = 0; i < list.length; i++) {
    var el = list[i];
    if (!visible(el)) continue;
    var text = String(el.textContent || '').replace(/\\s+/g, ' ').trim();
    var aria = el.getAttribute('aria-label') || '';
    var title = el.getAttribute('title') || '';
    var hay = text + ' ' + aria + ' ' + title;

    var score = 0;
    if (KW.test(hay)) score += 100;
    if (el.getAttribute('aria-pressed') !== null) score += 20;
    if (el.getAttribute('aria-checked') !== null) score += 20;
    if (el.getAttribute('role') === 'switch') score += 20;
    if (box) {
      var r = el.getBoundingClientRect();
      if (r.bottom <= box.top + 20 && r.bottom >= box.top - 140 && r.right > box.left && r.left < box.right) score += 40;
    }
    if (score < 100) continue;

    scored.push({
      score: score, el: el,
      text: text.slice(0, 40), aria: aria, on: isOn(el),
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
      tag: el.tagName, cls: String(el.className || '').slice(0, 70)
    });
  }

  if (scored.length === 0) {
    return JSON.stringify({ ok: false, reason: 'no-toggle', want: want, found: 0 });
  }

  scored.sort(function (a, b) { return b.score - a.score; });
  var best = scored[0];

  /** 有歧义（多个同分候选且状态不一致）时不盲点 —— 点错可能把已开的关掉。 */
  if (scored.length > 1 && scored[1].score === best.score && scored[1].on !== best.on) {
    return JSON.stringify({
      ok: false, reason: 'ambiguous', want: want,
      candidates: scored.slice(0, 4).map(function (c) { return { text: c.text, aria: c.aria, on: c.on, score: c.score }; })
    });
  }

  var before = best.on;
  if (best.disabled) {
    return JSON.stringify({ ok: false, reason: 'disabled', want: want, before: before, text: best.text });
  }
  if (before === want) {
    return JSON.stringify({ ok: true, changed: false, before: before, after: before, text: best.text, score: best.score });
  }

  /** 真实鼠标事件序列 —— 有些框架只认 pointerdown / mouseup。 */
  try {
    var r2 = best.el.getBoundingClientRect();
    var opts = {
      bubbles: true, cancelable: true,
      clientX: r2.left + r2.width / 2, clientY: r2.top + r2.height / 2
    };
    /**
     * view 只在浏览器里有意义。用 try 兜住 ——
     * 某些环境（测试桩 / 隔离上下文）没有 window，硬引用会让整个脚本抛错，
     * 那样连「点一下」都做不到。
     */
    try { opts.view = window; } catch (e) {}
    try { best.el.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch (e) {}
    best.el.dispatchEvent(new MouseEvent('mousedown', opts));
    try { best.el.dispatchEvent(new PointerEvent('pointerup', opts)); } catch (e) {}
    best.el.dispatchEvent(new MouseEvent('mouseup', opts));
    best.el.dispatchEvent(new MouseEvent('click', opts));
  } catch (e) {
    return JSON.stringify({ ok: false, reason: 'click-failed: ' + String(e && e.message), want: want, before: before });
  }

  var after = isOn(best.el);
  return JSON.stringify({
    ok: after === want, changed: true, before: before, after: after, want: want,
    text: best.text, score: best.score,
    reason: after === want ? undefined : 'click-did-not-change-state'
  });
})()`
}

/**
 * 发送前随机延迟（消除固定间隔的"定时器特征"）。
 *
 * 区间由**用户配置**决定（设置页可调），省略时用默认 2000~4000ms。
 * 参考实现实测：固定间隔本身就是可识别的定时器签名。
 *
 * @param min - 下限（毫秒）
 * @param max - 上限（毫秒）
 */
export function pickSendDelay(min = SEND_DELAY_MIN_MS, max = SEND_DELAY_MAX_MS): number {
  const lo = Math.max(0, Math.min(min, max))
  const hi = Math.max(0, Math.max(min, max))
  if (hi <= lo) return lo
  return Math.floor(Math.random() * (hi - lo + 1)) + lo
}

/**
 * 生成「停止生成」的页面脚本。
 *
 * ## 为什么需要它
 *
 * 用户在 DSH 里按停止时，host 会把任务标记为 `cancelled` 并让这次调用报错退出。
 * 但**页面那头不知道** —— 它会继续生成到自然结束。两个后果：
 *   1. 白烧网页版配额（用户已经不要这个结果了）；
 *   2. 页面还在输出，下一个任务打进去会**插队**，回复串台。
 *
 * 所以 client 每轮轮询时带 `?running=<jobId>`，host 说「这个不算数了」
 * 就去点页面的停止按钮。
 *
 * ## 定位规则来自**实测校准**（真浏览器 dump，见 scripts/probe-stop.mjs）
 *
 * DeepSeek 的停止键是纯图标（无 aria-label、无文字），只能靠 class 特征区分。
 * 实测出来的关键事实：
 *
 * ```
 * 生成中，输入框区域同时存在：
 *   发送键：ds-button--primary  ds-button--filled  ds-button--circle
 *   停止键：ds-button--outlinedNeutral  ds-button--outlined  ds-button--circle  ← 生成中才出现
 * ```
 *
 * 也就是说：
 *   - `--circle` 是**两者共有**的，不能作为区分特征
 *   - **`--filled` / `--primary` 是发送键独有** ⇒ 命中就排除
 *   - **`--outlined` 是停止键独有** ⇒ 命中才计分
 *   - 生成中发送键**不会消失**（早期假设它消失，是错的）
 *
 * 分数阈值 60：只有真正带 `--outlined` 的才够，避免 `--circle` 单独凑分。
 * 分数并列时**不敢猜** —— 宁可不停止（只是浪费一次配额），
 * 也绝不能误点「深度思考」开关（那会改变后续所有请求的行为）。
 *
 * @param hints - 平台定位策略（复用发送脚本的选择器与否决规则）
 */
export function buildStopScript(hints?: SendHints): string {
  const sendSelectors = hints?.sendSelectors ?? ['button[type="submit"]']
  const vetoes = hints?.vetoes ?? []
  return `(function () {
  try {
    function visible(el) {
      if (!el) return false;
      try {
        if (el.offsetWidth > 0 && el.offsetHeight > 0) return true;
        var r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      } catch (e) { return false; }
    }
    function labelOf(el) {
      var parts = [];
      try {
        if (el.getAttribute) {
          parts.push(el.getAttribute('aria-label') || '');
          parts.push(el.getAttribute('title') || '');
          parts.push(el.getAttribute('data-testid') || '');
        }
        if (el.className && typeof el.className === 'string') parts.push(el.className);
        var t = (el.textContent || '').trim();
        if (t.length <= 24) parts.push(t);
      } catch (e) {}
      return parts.join(' ').toLowerCase();
    }

    var all;
    try { all = document.querySelectorAll('button, [role="button"]'); } catch (e) { all = []; }
    var hits = [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (!visible(el)) continue;
      var L = labelOf(el);

      // ---- 一票否决：绝不能误点的东西 ----
      var vetoed = false;
      var vs = ${JSON.stringify(vetoes)};
      for (var v = 0; v < vs.length; v++) {
        try { if (new RegExp(vs[v]).test(L)) { vetoed = true; break; } } catch (e) {}
      }
      if (vetoed) continue;
      if (/附件|attach|上传|upload|深度思考|智能搜索|联网/.test(L)) continue;

      // ---- 强语义：文本/aria 明确说停止 ----
      if (/stop|停止|中断|abort/.test(L)) { hits.push({ el: el, score: 100, why: 'semantic' }); continue; }

      // ---- 站点特征（实测校准）----
      // 发送键独有 ⇒ 明确排除
      if (/ds-button--filled|ds-button--primary/.test(L)) continue;
      // 命中发送选择器也排除
      var sels = ${JSON.stringify(sendSelectors)};
      var isSend = false;
      for (var s = 0; s < sels.length; s++) {
        try { if (el.matches && el.matches(sels[s])) { isSend = true; break; } } catch (e) {}
      }
      if (isSend) continue;

      var score = 0;
      // 停止键独有：--outlined
      if (/ds-button--outlined/.test(L)) score += 60;
      if (/ds-button--outlinedneutral/.test(L)) score += 20;
      // 圆形是共有特征，只给很小的分
      if (/ds-button--circle/.test(L)) score += 10;

      if (score >= 60) hits.push({ el: el, score: score, why: L.slice(0, 50) });
    }

    if (!hits.length) return JSON.stringify({ ok: false, reason: 'no-stop-control' });
    hits.sort(function (a, b) { return b.score - a.score; });
    var top = hits[0];

    // 分数并列时不敢猜 —— 宁可不停止，也不能点错
    if (hits.length > 1 && hits[1].score === top.score) {
      return JSON.stringify({ ok: false, reason: 'ambiguous', candidates: hits.length, top: top.score });
    }

    try {
      top.el.click();
      return JSON.stringify({ ok: true, how: top.why, score: top.score, candidates: hits.length });
    } catch (e) {
      return JSON.stringify({ ok: false, reason: 'click-failed', message: String(e && e.message) });
    }
  } catch (e) {
    return JSON.stringify({ ok: false, reason: 'exception', message: String(e && e.message) });
  }
})();`
}
