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
  /**
   * 该平台期望的 completion 路径（来自 Provider）。
   *
   * 只用于**诊断展示** —— 把「我们期望的路径」和「页面实际发的路径」
   * 并排给用户看，端点改版时一眼定位（见 buildDiagnoseScript）。
   */
  completionPath?: string
}

/**
 * ## 填充输入框（**短调用，快速返回**）
 *
 * 与 `buildTriggerScript` 配合使用，中间由客户端控制随机延迟。
 * 拆分理由见 `buildTriggerScript` 的说明。
 */
export function buildFillScript(text: string, hints?: SendHints): string {
  const inputSelectors = hints?.inputSelectors ?? [
    'textarea[placeholder*="给 DeepSeek"]',
    'textarea[placeholder*="DeepSeek"]',
    'textarea[placeholder*="输入"]',
    'textarea',
    'div[contenteditable="true"]',
    '[role="textbox"]',
  ]

  return `(function () {
  var TEXT = ${JSON.stringify(text)};
  var INPUT_SELECTORS = ${JSON.stringify(inputSelectors)};

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
    } catch (e) { /* ignore */ }
    return false;
  }

  /** 只读的输入框填不进去 —— 及早排除。 */
  function readOnly(el) {
    try {
      if (el.readOnly === true) return true;
      if (el.getAttribute && el.getAttribute('aria-readonly') === 'true') return true;
    } catch (e) { /* ignore */ }
    return false;
  }

  /** 把 CRLF 折成 LF（textarea 的 value 会做这个规范化，见 toLf 的说明）。 */
  function toLf(s) {
    return String(s).replace(/\\r\\n?/g, '\\n').replace(/\\n\\r/g, '\\n');
  }

  function readInput(el) {
    try {
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el.value || '';
      return el.innerText || el.textContent || '';
    } catch (e) { return ''; }
  }

  /** 填入。判据是「非空」而不是「逐字节全等」—— 见原 setText 的说明。 */
  function setText(el, value) {
    el.focus();
    value = toLf(value);
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      var desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, value);
      else el.value = value;
      try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
      try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}
      try {
        el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: false, inputType: 'insertText', data: value }));
      } catch (e) {}
      return readInput(el) === '' ? { ok: false, how: 'native-setter-noop' } : { ok: true, how: 'native-setter' };
    }
    if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') {
      /**
       * contenteditable：**cuckoo 的做法**（chat-input.ts:59-81）——
       * 先 selectAll + delete 清空，再**分段 paste**（每段 <=6000 字符）。
       *
       * 为什么分段：一次性塞很长的文本会被某些站点识别成附件粘贴。
       * 这里保持 cuckoo 的阈值与做法。
       */
      el.focus();
      try {
        document.execCommand('selectAll', false, undefined);
        document.execCommand('delete', false, undefined);
      } catch (e) {}
      try {
        var CHUNK = 6000;
        for (var i = 0; i < value.length; i += CHUNK) {
          var dt = new DataTransfer();
          dt.setData('text/plain', value.slice(i, i + CHUNK));
          el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
        }
        if (readInput(el).trim().length > 0) return { ok: true, how: 'paste-event' };
      } catch (e) {}
      try {
        if (document.execCommand('insertText', false, value)) return { ok: true, how: 'execCommand-insertText' };
      } catch (e) {}
      el.textContent = value;
      try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
      return readInput(el).trim() === '' ? { ok: false, how: 'textContent-noop' } : { ok: true, how: 'textContent-fallback' };
    }
    return { ok: false, how: 'unsupported-element' };
  }

  try {
    /** 收集候选（依次试，见原实现的说明）。 */
    var cands = [];
    var seen = [];
    for (var i = 0; i < INPUT_SELECTORS.length; i++) {
      var list;
      try { list = document.querySelectorAll(INPUT_SELECTORS[i]); } catch (e) { continue; }
      for (var j = 0; j < list.length; j++) {
        var el = list[j];
        if (!visible(el) || disabled(el) || readOnly(el)) continue;
        var dup = false;
        for (var k = 0; k < seen.length; k++) if (seen[k] === el) { dup = true; break; }
        if (dup) continue;
        seen.push(el);
        cands.push({ el: el, how: INPUT_SELECTORS[i] });
      }
    }

    if (cands.length === 0) {
      return JSON.stringify({
        ok: false, stage: 'no-input',
        message: '找不到可见的输入框（页面结构可能已变，或还停在登录页）',
        diag: {
          url: location.href,
          textareas: document.querySelectorAll('textarea').length,
          editables: document.querySelectorAll('[contenteditable="true"]').length
        }
      });
    }

    var tried = [];
    for (var c = 0; c < cands.length; c++) {
      var attempt = setText(cands[c].el, TEXT);
      tried.push({ how: cands[c].how, tag: cands[c].el.tagName, result: attempt.how });
      if (!attempt.ok) continue;
      if (readInput(cands[c].el).trim().length === 0) {
        tried[tried.length - 1].result += '+empty-after-fill';
        continue;
      }
      /** 记下填充用的选择器 —— 触发阶段要用同一个元素。 */
      window.__dshWebinFilledSelector = cands[c].how;
      return JSON.stringify({
        ok: true, stage: 'filled',
        how: attempt.how, selector: cands[c].how,
        chars: TEXT.length, url: location.href
      });
    }

    return JSON.stringify({
      ok: false, stage: 'fill-failed',
      message: '试了 ' + tried.length + ' 个候选输入框都没写进去',
      tried: tried, url: location.href
    });
  } catch (e) {
    return JSON.stringify({ ok: false, stage: 'fill-error', message: String(e && e.message) });
  }
})();`
}

/**
 * ## 触发发送（**短调用，立刻返回**）
 *
 * 只做「点发送按钮」或「合成 Enter」，**不做任何等待与验证** ——
 * 这与 cuckoo 的 `triggerSend` 一致（chat-input.ts:453-501）：
 *
 *     provider.findSendButton() → btn.click()  // 或
 *     input.dispatchEvent(KeyboardEvent('keydown/keypress/keyup'))
 *
 * 验证交给客户端后续的**短轮询**（读 hook 的请求计数）。
 * 这样单次调用的存活时间只有几十毫秒，导航不可能把它拖死。
 *
 * @param hints - 平台声明（发送按钮选择器、加分/否决特征）
 */
export function buildTriggerScript(hints?: SendHints): string {
  const inputSelectors = hints?.inputSelectors ?? [
    'textarea[placeholder*="DeepSeek"]',
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
  var INPUT_SELECTORS = ${JSON.stringify(inputSelectors)};
  var SEND_SELECTORS = ${JSON.stringify(sendSelectors)};
  var SIGNATURES = ${JSON.stringify(hints?.signatures ?? [])};
  var VETOES = ${JSON.stringify(hints?.vetoes ?? [])};

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
        parts.push(el.getAttribute('type') || '');
      }
      if (el.className && typeof el.className === 'string') parts.push(el.className);
      var t = (el.textContent || '').trim();
      if (t.length <= 24) parts.push(t);
    } catch (e) { /* ignore */ }
    return parts.join(' ').toLowerCase();
  }

  function scoreByLabel(el) {
    var L = labelOf(el);
    var s = 0;
    if (/send|发送|提交|submit/.test(L)) s += 100;
    for (var i = 0; i < SIGNATURES.length; i++) {
      try { if (new RegExp(SIGNATURES[i][0]).test(L)) s += SIGNATURES[i][1]; } catch (e) {}
    }
    for (var j = 0; j < VETOES.length; j++) {
      try { if (new RegExp(VETOES[j]).test(L)) s -= 120; } catch (e) {}
    }
    return s;
  }

  function scoreByGeometry(el, input) {
    try {
      var a = input.getBoundingClientRect();
      var b = el.getBoundingClientRect();
      var score = 0;
      if (b.top < a.bottom && b.bottom > a.top) score += 20;
      else if (b.top >= a.bottom - 4 && b.top < a.bottom + 80) score += 15;
      if (b.left >= a.left + a.width * 0.5) score += 15;
      var dx = Math.abs(b.left - (a.right - b.width));
      var dy = Math.abs(b.top - a.bottom);
      score -= Math.min(30, (dx + dy) / 40);
      return score;
    } catch (e) { return 0; }
  }

  /** 找输入框（触发阶段只需要它做几何参照 + Enter 目标）。 */
  function findInput() {
    for (var i = 0; i < INPUT_SELECTORS.length; i++) {
      var list;
      try { list = document.querySelectorAll(INPUT_SELECTORS[i]); } catch (e) { continue; }
      for (var j = 0; j < list.length; j++) {
        if (visible(list[j]) && !disabled(list[j])) return list[j];
      }
    }
    return null;
  }

  function pressEnter(el) {
    var opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, isComposing: false };
    try { el.dispatchEvent(new KeyboardEvent('keydown', opts)); } catch (e) {}
    try { el.dispatchEvent(new KeyboardEvent('keypress', opts)); } catch (e) {}
    try { el.dispatchEvent(new KeyboardEvent('keyup', opts)); } catch (e) {}
  }

  try {
    var input = findInput();
    if (!input) return JSON.stringify({ ok: false, message: '触发时找不到输入框', url: location.href });

    /**
     * 收集候选发送控件：平台声明的语义选择器优先，再用「输入框附近」
     * 与特征加分兜底（DeepSeek 的发送键是纯图标 div，没有文字）。
     */
    var out = [];
    var seen = [];
    function push(el, how, weight) {
      if (!el || !visible(el) || disabled(el)) return;
      for (var s = 0; s < seen.length; s++) if (seen[s] === el) return;
      seen.push(el);
      /* 输入框本体不算发送键。 */
      if (el === input) return;
      out.push({ el: el, how: how, score: weight + scoreByLabel(el) + scoreByGeometry(el, input) });
    }

    for (var i = 0; i < SEND_SELECTORS.length; i++) {
      var list;
      try { list = document.querySelectorAll(SEND_SELECTORS[i]); } catch (e) { continue; }
      for (var j = 0; j < list.length; j++) push(list[j], SEND_SELECTORS[i], 100);
    }

    /** 输入框附近（往上 6 层）的按钮。 */
    var box = input;
    for (var k = 0; k < 6 && box; k++) {
      box = box.parentElement;
      if (!box) break;
      var near;
      try { near = box.querySelectorAll('button, [role="button"], [role="submit"], div[tabindex]'); } catch (e) { break; }
      for (var m = 0; m < near.length; m++) push(near[m], 'near-input(L' + (k + 1) + ')', 40 - k * 5);
    }

    out.sort(function (a, b) { return b.score - a.score; });
    var best = out.length > 0 ? out[0] : null;

    /**
     * ⚠️ 与 cuckoo 一致的策略：**先点按钮，找不到才用 Enter**。
     *
     * 但这里**立刻返回**，不验证结果 —— 验证是客户端后面的事。
     * 所以两个都做（双保险）：点按钮 **并且** 补一次 Enter？
     * 不行 —— 那可能发出两条。所以只选一个：
     *   - 有够分（>0）的候选按钮 ⇒ 点它
     *   - 否则 ⇒ 合成 Enter
     */
    if (best && best.score > 0) {
      try { best.el.click(); } catch (e) {}
      return JSON.stringify({
        ok: true, how: best.how, method: 'click',
        score: Math.round(best.score),
        candidates: out.slice(0, 5).map(function (c) { return { how: c.how, score: Math.round(c.score) }; }),
        url: location.href
      });
    }

    pressEnter(input);
    return JSON.stringify({
      ok: true, how: 'enter', method: 'enter',
      candidates: out.slice(0, 5).map(function (c) { return { how: c.how, score: Math.round(c.score) }; }),
      url: location.href
    });
  } catch (e) {
    return JSON.stringify({ ok: false, message: String(e && e.message) });
  }
})();`
}

/**
 * ## 检查发送是否被确认（**短调用，立刻返回**）
 *
 * 读 hook 记的 completion 请求计数 —— 这是 DeepSeek 上**唯一可靠的
 * 发送成功信号**（页面真的发出了 POST /api/v0/chat/completion）。
 *
 * 与 cuckoo 的差异：cuckoo 根本不验证（点完就算发了）。
 * 我们多这一层是因为 DSH 需要知道「这一轮到底有没有发出去」，
 * 否则失败时会白等到超时。但**验证本身也是短调用** —— 只读一个数字。
 */
export function buildVerifyScript(): string {
  return `(function () {
  try {
    var n = window.__dshWebinHookInstalled___requests;
    var input = document.querySelector('textarea, div[contenteditable="true"]');
    var text = '';
    try {
      text = input ? (input.tagName === 'TEXTAREA' ? (input.value || '') : (input.innerText || input.textContent || '')) : '';
    } catch (e) {}
    return JSON.stringify({
      requests: typeof n === 'number' ? n : 0,
      inputEmpty: text.trim() === '',
      url: location.href
    });
  } catch (e) {
    return JSON.stringify({ requests: 0, inputEmpty: false, error: String(e && e.message) });
  }
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
  /**
   * 页面实际发过哪些 POST（hook 记录的）。
   *
   * ⚠️ **端点改版时这是最有价值的一栏**：如果 DeepSeek 换了 completion 路径，
   * 我们的精确比较会静默失配（既不报错也抓不到回复），
   * 而这里能直接看出「真实路径 vs 期望路径」。
   */
  try {
    out.postPaths = window.__dshWebinHookInstalled___postPaths || [];
    out.expectedCompletion = ${JSON.stringify(hints?.completionPath ?? '/api/v0/chat/completion')};
    out.completionRequests = window.__dshWebinHookInstalled___requests || 0;
  } catch (e) { /* ignore */ }
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
 * 用户在 DSH 里按停止时，host 会把任务标记为 「cancelled」 并让这次调用报错退出。
 * 但**页面那头不知道** —— 它会继续生成到自然结束。两个后果：
 *   1. 白烧网页版配额（用户已经不要这个结果了）；
 *   2. 页面还在输出，下一个任务打进去会**插队**，回复串台。
 *
 * 所以 client 每轮轮询时带 「?running=<jobId>」，host 说「这个不算数了」
 * 就去点页面的停止按钮。
 *
 * ## 定位规则来自**实测校准**（真浏览器 dump，见 scripts/probe-stop.mjs）
 *
 * DeepSeek 的停止键是纯图标（无 aria-label、无文字），只能靠 class 特征区分。
 * 实测出来的关键事实：
 *
 * 「」「
 * 生成中，输入框区域同时存在：
 *   发送键：ds-button--primary  ds-button--filled  ds-button--circle
 *   停止键：ds-button--outlinedNeutral  ds-button--outlined  ds-button--circle  ← 生成中才出现
 * 「」「
 *
 * 也就是说：
 *   - 「--circle」 是**两者共有**的，不能作为区分特征
 *   - **「--filled」 / 「--primary」 是发送键独有** ⇒ 命中就排除
 *   - **「--outlined」 是停止键独有** ⇒ 命中才计分
 *   - 生成中发送键**不会消失**（早期假设它消失，是错的）
 *
 * 分数阈值 60：只有真正带 「--outlined」 的才够，避免 「--circle」 单独凑分。
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
