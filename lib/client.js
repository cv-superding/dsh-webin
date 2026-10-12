window.__ModuleLoader__.load({
	id: "dsh-webin",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		//#region src/client/hook.ts
		/** 幂等标记：重复注入不重复打补丁。 */
		const MARKER = "__dshWebinHookInstalled__";
		/** 事件缓冲在 window 上的键名（与 hook 内一致）。 */
		const EVENT_QUEUE_KEY = `${MARKER}_events`;
		/**
		* 生成注入页面的 hook 源码。
		*
		* 注入后页面每收到一段回复会派发：
		*   - `dsh-webin:stream`  `{ text, think, finished }`  —— 流式增量（节流）
		*   - `dsh-webin:done`    `{ text, think, status }`    —— 本条回复结束
		*   - `dsh-webin:error`   `{ message }`                —— 请求失败 / 业务错误
		*
		* @param completionPath - 该平台 completion 请求的路径（来自 Provider）。
		*   不同站点不同（DeepSeek 是 `/api/v0/chat/completion`）。
		* @param stopPath - 停止生成路径（可选）。
		*/
		function buildDeepSeekHook(completionPath, stopPath) {
			return `(function () {
  'use strict';
  if (window.${MARKER}) return 'already-installed';
  window.${MARKER} = true;

  var COMPLETION = ${JSON.stringify(completionPath)};
  var STOP = ${JSON.stringify(stopPath ?? "")};
  var NS = 'dsh-webin';

  // ---------- SSE 分帧：按空行切（\\n\\n 或 \\r\\n\\r\\n） ----------
  function createFrameDecoder() {
    var buffer = '';
    var scanFrom = 0;
    return {
      push: function (text) {
        buffer += text;
        var frames = [];
        var re = /\\r?\\n\\r?\\n/g;
        var offset = 0;
        var m;
        re.lastIndex = scanFrom;
        while ((m = re.exec(buffer)) !== null) {
          frames.push(buffer.slice(offset, m.index));
          offset = m.index + re.lastIndex - m.index;
          offset = m.index + m[0].length;
        }
        buffer = buffer.slice(offset);
        scanFrom = Math.max(0, buffer.length - 3);
        return frames;
      },
      finish: function () {
        var frames = [];
        if (buffer) frames.push(buffer);
        buffer = '';
        scanFrom = 0;
        return frames;
      }
    };
  }

  /** 取出 SSE 块里的 data: 行（多行用 \\n 拼接）。 */
  function extractData(block) {
    if (!block || !block.trim()) return null;
    var data = null;
    var lines = block.split(/\\r\\n|\\r|\\n/);
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].indexOf('data:') === 0) {
        var d = lines[i].slice(5).trim();
        data = data === null ? d : data + '\\n' + d;
      }
    }
    return data;
  }

  function parseBlock(block) {
    var data = extractData(block);
    if (data === null || data === '[DONE]') return null;
    try { return JSON.parse(data); } catch (e) { return null; }
  }

  // ---------- 请求识别 ----------
  function samePath(url, path) {
    try {
      return new URL(String(url), location.href).pathname === path;
    } catch (e) {
      return String(url).indexOf(path) !== -1;
    }
  }

  /**
   * 记一次「页面自己发出了 completion 请求」。
   *
   * 这是发送脚本判断发送成功的最强信号（见 chat.ts 的 verify()）。
   * 只计数，不干预请求。
   */
  function noteCompletionRequest() {
    try {
      var n = window.${MARKER}_requests;
      window.${MARKER}_requests = (typeof n === 'number' ? n : 0) + 1;
    } catch (e) { /* ignore */ }
  }

  // ---------- 回复提取 ----------
  function createExtractor() {
    var text = '';
    var think = '';
    var finished = false;
    var incomplete = false;
    var businessError = null;

    function lastSeg(p) { return typeof p === 'string' ? p.split('/').pop() : ''; }

    /** JSON Patch 路径 → 判断是不是正文/思考文本。 */
    function classify(p) {
      var seg = lastSeg(p);
      var inResponse = typeof p === 'string' && (p === 'response' || p.indexOf('response/') === 0);
      if (seg === 'reasoning_content' || seg === 'thinking_content') return 'think';
      if (!inResponse) return null;
      if (seg === 'content' || seg === 'text' || seg === 'markdown' || seg === 'delta') return 'text';
      return null;
    }

    /**
     * 帧是不是「裸文本增量」。
     *
     * ## ⚠️ 这是「DSH 只收到一个字」的根因（实测抓帧定位）
     *
     * 真浏览器抓下来的帧序列长这样：
     *
     *     [3]   p=response/fragments/-1/content  o=APPEND  v=渲染   ← 只有首帧带路径
     *     [4]   p=undefined                      o=undefined  v=网页  ← 正文主体全是这种
     *     [5]   p=undefined                      o=undefined  v=的
     *     [6]   p=undefined                      o=undefined  v=流程
     *     ...
     *     [130] p=response                       o=BATCH   v=?
     *     [131] p=response/status                o=SET     v=FINISHED
     *
     * 也就是说**正文的绝大部分是裸字符串帧**（没有 p，v 直接是要追加的文本）。
     * 早期实现只认「带 p 且路径匹配」的帧，于是每个回复只能拿到**第一个字**
     * —— 用户看到的就是「只回一个字」。
     *
     * 判据：没有 p、没有 o（或 o 为 APPEND）、v 是非空字符串。
     * 注意必须**排除**状态/错误信封（那些有 code / data / p）。
     */
    function isBareTextDelta(obj) {
      if (typeof obj.p === 'string') return false;
      if (typeof obj.v !== 'string' || obj.v === '') return false;
      if (typeof obj.code === 'number') return false;
      if (obj.data !== undefined) return false;
      // o 允许缺省或 APPEND；SET 会覆盖，不按增量处理
      if (obj.o !== undefined && obj.o !== 'APPEND') return false;
      return true;
    }

    /** 处理一条 SSE 帧。 */
    function consume(obj) {
      if (!obj || typeof obj !== 'object') return;

      // 业务错误信封：{ code, msg, data: { biz_code, biz_msg } }
      if (typeof obj.code === 'number' && obj.code !== 0 && !obj.p) {
        businessError = String(obj.msg || ('code=' + obj.code));
        return;
      }
      if (obj.data && typeof obj.data.biz_code === 'number' && obj.data.biz_code !== 0) {
        businessError = String(obj.data.biz_msg || ('biz_code=' + obj.data.biz_code));
        return;
      }

      // 状态帧
      if (obj.p === 'response/status' || obj.p === 'quasi_status') {
        if (obj.v === 'FINISHED') finished = true;
        else if (obj.v === 'INCOMPLETE') { incomplete = true; finished = true; }
        return;
      }

      // fragments 追加：{ p: 'response/fragments', o: 'APPEND', v: [ {type, content} ] }
      if (obj.p === 'response/fragments' && obj.o === 'APPEND' && Array.isArray(obj.v)) {
        for (var i = 0; i < obj.v.length; i++) {
          var f = obj.v[i];
          if (!f || typeof f !== 'object') continue;
          var piece = typeof f.content === 'string' ? f.content : (typeof f.text === 'string' ? f.text : '');
          if (!piece) continue;
          if (f.type === 'THINK') think += piece;
          else text += piece;
        }
        return;
      }

      // 快照：{ v: { response: { fragments: [...] } } }
      if (obj.p === undefined && obj.v && typeof obj.v === 'object' && obj.v.response) {
        var frags = obj.v.response.fragments;
        if (Array.isArray(frags)) {
          var t = '';
          var k = '';
          for (var j = 0; j < frags.length; j++) {
            var g = frags[j];
            if (!g || typeof g !== 'object') continue;
            var s = typeof g.content === 'string' ? g.content : (typeof g.text === 'string' ? g.text : '');
            if (!s) continue;
            if (g.type === 'THINK') k += s;
            else t += s;
          }
          // 快照是权威全量，直接覆盖
          if (t) text = t;
          if (k) think = k;
        }
        return;
      }

      // 直接路径写入：{ p: 'response/content', o: 'SET', v: '...' }
      var kind = classify(obj.p);
      if (kind !== null && typeof obj.v === 'string') {
        if (kind === 'think') think = obj.v;
        else if (obj.o === 'APPEND') text += obj.v;
        else text = obj.v;
        return;
      }

      /**
       * **裸文本增量**（正文主体）—— 见 isBareTextDelta 的说明。
       *
       * 放在最后判断：前面的路径匹配、fragments、快照都优先。
       * 这是修复「只回一个字」的关键分支。
       */
      if (isBareTextDelta(obj)) {
        text += obj.v;
        return;
      }
    }

    return {
      consume: consume,
      get text() { return text; },
      get think() { return think; },
      get finished() { return finished; },
      get incomplete() { return incomplete; },
      get businessError() { return businessError; }
    };
  }

  // ---------- 事件派发 ----------
  //
  // CustomEvent 只在**本页面**内可见，跨不过 webview 边界。
  // 所以两件事都做：
  //   1. 派发 CustomEvent —— 页面内其它脚本可用（也便于 DevTools 手工监听调试）
  //   2. 压进 window.__dshWebinEvents 环形缓冲 —— 宿主用 executeJavaScript 轮询取走
  var lastStreamAt = 0;
  var MAX_EVENTS = 200;

  function emit(name, detail) {
    var payload = { name: name, detail: detail, at: Date.now() };
    try {
      window.dispatchEvent(new CustomEvent(NS + ':' + name, { detail: detail }));
    } catch (e) { /* ignore */ }
    try {
      var q = window.${MARKER}_events;
      if (!q) { q = []; window.${MARKER}_events = q; }
      q.push(payload);
      if (q.length > MAX_EVENTS) q.splice(0, q.length - MAX_EVENTS);
    } catch (e) { /* ignore */ }
  }

  function emitStream(ex) {
    var now = Date.now();
    if (!ex.finished && now - lastStreamAt < 100) return;
    lastStreamAt = now;
    emit('stream', { text: ex.text, think: ex.think, finished: ex.finished });
  }

  function emitDone(ex, reason) {
    if (ex.businessError) {
      emit('error', { message: ex.businessError });
      return;
    }
    emit('done', {
      text: ex.text,
      think: ex.think,
      status: ex.incomplete ? 'incomplete' : (ex.finished ? 'finished' : 'unknown'),
      reason: reason || null
    });
  }

  // ---------- 单次请求的观察会话 ----------
  function watchResponse(response, onDone) {
    var ex = createExtractor();
    var decoder = createFrameDecoder();
    var reader = response.body.getReader();
    var dec = new TextDecoder();

    function pump() {
      return reader.read().then(function (r) {
        if (r.done) {
          var rest = decoder.finish();
          for (var i = 0; i < rest.length; i++) {
            var p = parseBlock(rest[i]);
            if (p) ex.consume(p);
          }
          emitDone(ex, 'eof');
          if (onDone) onDone();
          return;
        }
        var chunk = dec.decode(r.value, { stream: true });
        var frames = decoder.push(chunk);
        for (var j = 0; j < frames.length; j++) {
          var parsed = parseBlock(frames[j]);
          if (parsed) ex.consume(parsed);
        }
        emitStream(ex);
        return pump();
      });
    }

    return pump().catch(function (e) {
      emitDone(ex, 'read-error');
      if (onDone) onDone();
    });
  }

  // ---------- 猴补 fetch（只读，原样透传） ----------
  var origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input
        : (input && input.url) ? input.url
        : (input && input.href) ? input.href : '';
      var method = (init && init.method) || (input && input.method) || 'GET';
      var p = origFetch.apply(this, arguments);

      try {
        if (String(method).toUpperCase() === 'POST' && samePath(url, COMPLETION)) {
          noteCompletionRequest();
          p.then(function (res) {
            if (!res || !res.body) {
              // 非流式：可能是限流等业务错误，读一份副本
              try {
                res.clone().json().then(function (j) {
                  var ex = createExtractor();
                  ex.consume(j);
                  if (ex.businessError) emit('error', { message: ex.businessError });
                }).catch(function () {});
              } catch (e) { /* ignore */ }
              return;
            }
            // 必须 clone —— 页面自己要消费原 body，我们只看副本
            try { watchResponse(res.clone()); } catch (e) { /* ignore */ }
          }).catch(function () {});
        }
      } catch (e) { /* ignore */ }

      return p;
    };
  }

  // ---------- 猴补 XHR（只读，原样透传） ----------
  var OrigXHR = window.XMLHttpRequest;
  if (typeof OrigXHR === 'function') {
    var origOpen = OrigXHR.prototype.open;
    var origSend = OrigXHR.prototype.send;
    var info = new WeakMap();

    OrigXHR.prototype.open = function (method, url) {
      try { info.set(this, { method: method, url: url }); } catch (e) { /* ignore */ }
      return origOpen.apply(this, arguments);
    };

    OrigXHR.prototype.send = function () {
      var meta = info.get(this);
      var isTarget = meta && String(meta.method).toUpperCase() === 'POST' && samePath(meta.url, COMPLETION);
      if (isTarget) {
        noteCompletionRequest();
        var ex = createExtractor();
        var decoder = createFrameDecoder();
        var lastLen = 0;
        var done = false;

        this.addEventListener('readystatechange', function () {
          if (this.readyState !== 3 && this.readyState !== 4) return;
          var raw;
          try { raw = this.responseText; } catch (e) { return; }
          if (typeof raw !== 'string' || raw.length <= lastLen) return;
          var chunk = raw.slice(lastLen);
          lastLen = raw.length;
          var frames = decoder.push(chunk);
          for (var i = 0; i < frames.length; i++) {
            var parsed = parseBlock(frames[i]);
            if (parsed) ex.consume(parsed);
          }
          emitStream(ex);
          if (this.readyState === 4 && !done) {
            done = true;
            var rest = decoder.finish();
            for (var j = 0; j < rest.length; j++) {
              var p2 = parseBlock(rest[j]);
              if (p2) ex.consume(p2);
            }
            emitDone(ex, 'xhr-end');
          }
        });
      }
      return origSend.apply(this, arguments);
    };
  }

  return 'installed';
})();`;
		}
		/**
		* 探针：读当前页面的登录态与指纹。
		*
		* ⚠️ **登录判断不能只看 `userToken` 存在与否**。
		* DeepSeek 未登录时这个 key 也可能在（空串 / `{"value":""}` 包装），
		* 早期版本用 `!!localStorage.getItem('userToken')` 导致登录页也报「已登录」。
		*
		* ⚠️ **也不能因为判据太严而误报未登录** —— 那会让发送循环整个不工作。
		* 所以这里返回**分项证据**，由宿主决定怎么用；`loggedIn` 只是综合结论。
		*
		* 判据（按强度）：
		*   1. `__appKit_userInfo` 里能解出非空 `id` —— 最强的正面证据（登录页不会有）
		*   2. `userToken` 解包后非空
		*   3. 负面证据：URL 在登录路由上 / 页面上有登录表单
		*
		* 结论：`loggedIn = 有正面证据 && 无负面证据`；
		* 只有 token 而无 userInfo 时也认（老版本页面可能没有 userInfo）。
		*/
		function buildProbeScript() {
			return `(function () {
  try {
    // ---- 1) token：新版网页端把 token 存成 AppKit 包装 JSON {"value":"<token>"} ----
    function unwrap(raw) {
      if (typeof raw !== 'string' || raw === '') return '';
      var s = raw.trim();
      if (s.charAt(0) === '{') {
        try {
          var o = JSON.parse(s);
          if (o && typeof o.value === 'string') s = o.value;
        } catch (e) { return ''; }
      }
      if (s.length >= 2 && s.charAt(0) === '"' && s.charAt(s.length - 1) === '"') s = s.slice(1, -1);
      return s;
    }

    var raw = null;
    try { raw = localStorage.getItem('userToken'); } catch (e) {}
    var token = unwrap(raw);

    // ---- 2) userInfo.id：最强的正面证据 ----
    //
    // ⚠️ 真实存储形状（实测自 ~/.dsh/webin/auth/default.json）：
    //     {"value":{"id":"b3a51eb9-..."},"__version":"0"}
    // id 是**嵌在 value 里**的，不是顶层字段。早期版本只看顶层 parsed.id，
    // 于是明明登录了却报 hasUserId:false。这里两种形状都认。
    var userId = '';
    try {
      var uiRaw = localStorage.getItem('__appKit_userInfo');
      if (typeof uiRaw === 'string' && uiRaw !== '') {
        var ui = JSON.parse(uiRaw);
        if (ui && typeof ui === 'object') {
          if (ui.value && typeof ui.value === 'object' && typeof ui.value.id === 'string') {
            userId = ui.value.id;          // 实际形状
          } else if (typeof ui.id === 'string') {
            userId = ui.id;                // 兼容扁平形状
          }
        }
      }
    } catch (e) {}

    // ---- 3) 负面证据 ----
    var href = location.href;
    var onAuthRoute = /\\/(sign_in|sign_up|login|register)/i.test(href);

    var hasLoginForm = false;
    try {
      var ph = document.querySelector('input[placeholder*="手机号"], input[placeholder*="phone"], input[type="tel"]');
      var btns = document.querySelectorAll('button, div[role="button"]');
      var hasSendCode = false;
      var hasLoginBtn = false;
      for (var i = 0; i < btns.length; i++) {
        var t = (btns[i].textContent || '').trim();
        if (t === '发送验证码' || t === '获取验证码') hasSendCode = true;
        if (t === '登录' || t === '登 录') hasLoginBtn = true;
      }
      hasLoginForm = !!ph || hasSendCode || hasLoginBtn;
    } catch (e) {}

    var hasPositive = userId !== '' || token !== '';
    var loggedIn = hasPositive && !onAuthRoute && !hasLoginForm;

    var brands = [];
    try {
      brands = (navigator.userAgentData && navigator.userAgentData.brands || []).map(function (b) {
        return b.brand + '/' + b.version;
      });
    } catch (e) {}

    return JSON.stringify({
      loggedIn: loggedIn,
      hasUserId: userId !== '',
      userIdLength: userId.length,
      tokenLength: token.length,
      tokenRawLength: typeof raw === 'string' ? raw.length : 0,
      onAuthRoute: onAuthRoute,
      hasLoginForm: hasLoginForm,
      ua: navigator.userAgent,
      hasElectron: navigator.userAgent.indexOf('Electron') !== -1,
      webdriver: navigator.webdriver,
      brands: brands,
      hookInstalled: !!window.${MARKER},
      url: href
    });
  } catch (e) {
    return '{}';
  }
})();`;
		}
		/** 登录态快照的宿主侧 API 前缀（与 host 半一致）。 */
		const API_PREFIX = "/dsh-webin/api";
		/** 默认账号槽位。 */
		const DEFAULT_SLOT = "default";
		/**
		* 把快照存到 **host 侧**（`~/.dsh/webin/auth/<slot>.json`）。
		*
		* 不用 `window.localStorage`：那是 DSH 主窗口的存储，不归本插件所有，
		* 而且跟 guest partition 一样会随 profile 走。host 的文件系统才是真正落盘的。
		*/
		async function saveSnapshot(snapshotJson, slot = DEFAULT_SLOT) {
			try {
				return (await fetch(`${API_PREFIX}/auth/${slot}/snapshot`, {
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: snapshotJson
				})).ok;
			} catch {
				return false;
			}
		}
		/** 从 host 侧取回快照；没有则返回 undefined。 */
		async function loadSnapshot(slot = DEFAULT_SLOT) {
			try {
				const res = await fetch(`${API_PREFIX}/auth/${slot}/snapshot`, { method: "GET" });
				if (!res.ok) return void 0;
				const text = await res.text();
				return text === "" ? void 0 : text;
			} catch {
				return;
			}
		}
		/** 取走 hook 累积的事件（取即清空）。
		*
		* 用轮询而不是事件订阅：`CustomEvent` 跨不过 webview 边界，
		* 而 `<webview>` 的 `ipc-message` 需要 guest 里 `require('electron')` —— guest 是 sandbox 且无 preload，拿不到。
		* 轮询 `executeJavaScript` 是这条路里唯一稳定的桥。
		*/
		function buildDrainScript() {
			return `(function () {
  try {
    var q = window.${EVENT_QUEUE_KEY};
    if (!q || !q.length) return '[]';
    window.${EVENT_QUEUE_KEY} = [];
    return JSON.stringify(q);
  } catch (e) {
    return '[]';
  }
})();`;
		}
		/**
		* 导出登录态快照。
		*
		* **为什么需要这个**：DSH 的 guest partition 是
		* `dsh-sidebar-browser-${randomUUID()}`（`main.js:9638`）—— **没有 `persist:` 前缀，
		* 是内存分区，连磁盘都不落**。所以 DSH 一重启，cookie / localStorage 全丢，必须重新登录。
		*
		* 这里把能救的东西救出来存到 host 侧，下次启动回写。
		* ⚠️ **局限**：`httpOnly` cookie 读不到（`document.cookie` 看不见它们）。
		*/
		function buildSnapshotScript() {
			return `(function () {
  try {
    var ls = {};
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k === null) continue;
      // 只存可能承载登录态 / 会话的键，避免把无关缓存也搬走
      if (k === 'userToken' || k.indexOf('userToken') !== -1 ||
          k.indexOf('appKit') !== -1 || k.indexOf('hif_') !== -1 ||
          k.indexOf('__appKit') !== -1) {
        ls[k] = localStorage.getItem(k);
      }
    }
    return JSON.stringify({
      localStorage: ls,
      cookie: (function () { try { return document.cookie; } catch (e) { return ''; } })(),
      url: location.href,
      at: Date.now()
    });
  } catch (e) {
    return '{}';
  }
})();`;
		}
		/**
		* 回写登录态快照。传入 `buildSnapshotScript()` 产出的 JSON 字符串。
		*
		* ⚠️ **localStorage 和 cookie 都要回写**。早期版本只写了 localStorage，
		* 但快照里明明存了 cookie —— 那份 cookie 被白存了。
		*
		* ⚠️ **必须在目标域上执行**。`about:blank` 是 opaque origin，
		* `localStorage` 会直接抛 `SecurityError`，而且 storage 按源隔离 ——
		* 在错的源上写等于没写。早期实现在 about:blank 上跑这个脚本，
		* 导致**每次重启 DSH 都要重新登录**（实测，见 `scripts/probe-origin.mjs`）。
		* 所以下面**显式检测源并报告**，不再让异常被静默吞掉。
		*
		* cookie 回写的限制（浏览器安全模型，不是实现问题）：
		*   - `httpOnly` cookie 用 JS 既读不到也写不了
		*   - 写 cookie 必须带正确的 `path`（本站是 `/`）
		*   - 跨域 cookie 需要 `domain`，这里交给浏览器按当前域处理
		*/
		function buildRestoreScript(snapshotJson) {
			return `(function () {
  try {
    var snap = ${JSON.stringify(snapshotJson)};
    var data = typeof snap === 'string' ? JSON.parse(snap) : snap;
    if (!data) return JSON.stringify({ ok: false, restored: 0, cookies: 0, reason: 'no-snapshot' });

    // ---- 0) 源检查：错的源上写了也是白写 ----
    var origin = '';
    try { origin = String(location.origin); } catch (e) { origin = ''; }
    if (!origin || origin === 'null' || origin === 'about:blank') {
      return JSON.stringify({
        ok: false,
        reason: 'wrong-origin',
        origin: origin,
        hint: 'restore 必须在目标域上执行（about:blank 是 opaque origin，storage 不可写）'
      });
    }

    // ---- 1) localStorage ----
    var ls = data.localStorage || {};
    var n = 0;
    var failed = 0;
    for (var k in ls) {
      if (!Object.prototype.hasOwnProperty.call(ls, k)) continue;
      try { localStorage.setItem(k, ls[k]); n++; } catch (e) { failed++; }
    }

    // ---- 2) cookie ----
    // document.cookie 是 "k=v; k2=v2" 形式，逐条写回。
    var ck = typeof data.cookie === 'string' ? data.cookie : '';
    var c = 0;
    if (ck) {
      var parts = ck.split(';');
      for (var i = 0; i < parts.length; i++) {
        var kv = parts[i].trim();
        if (!kv) continue;
        var eq = kv.indexOf('=');
        if (eq <= 0) continue;
        var name = kv.slice(0, eq);
        // 跳过带属性的残留片段（Secure / HttpOnly / SameSite 等）
        if (/^(secure|httponly|samesite|path|domain|expires|max-age)$/i.test(name)) continue;
        try {
          // 先清同名的旧值，避免 domain/path 组合残留导致重复
          document.cookie = name + '=; path=/; max-age=0';
          document.cookie = kv + '; path=/';
          c++;
        } catch (e) {}
      }
    }

    // ---- 3) 回读校验：写失败时不静默 ----
    var verified = 0;
    for (var k2 in ls) {
      if (!Object.prototype.hasOwnProperty.call(ls, k2)) continue;
      try { if (localStorage.getItem(k2) === ls[k2]) verified++; } catch (e) {}
    }

    return JSON.stringify({
      ok: verified > 0 || c > 0,
      restored: n,
      verified: verified,
      failed: failed,
      cookies: c,
      origin: origin
    });
  } catch (e) {
    return JSON.stringify({
      ok: false, restored: 0, cookies: 0, reason: 'exception',
      message: String(e && e.message || e)
    });
  }
})();`;
		}
		//#endregion
		//#region src/client/chat.ts
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
		const SEND_DELAY_MIN_MS = 2e3;
		const SEND_DELAY_MAX_MS = 4e3;
		function buildSendScript(text, delayMs, hints) {
			const inputSelectors = hints?.inputSelectors ?? [
				"textarea[placeholder*=\"给 DeepSeek\"]",
				"textarea[placeholder*=\"DeepSeek\"]",
				"textarea[placeholder*=\"输入\"]",
				"textarea",
				"div[contenteditable=\"true\"]",
				"[role=\"textbox\"]"
			];
			const sendSelectors = hints?.sendSelectors ?? [
				"button[type=\"submit\"]",
				"button[aria-label*=\"send\" i]",
				"button[aria-label*=\"发送\"]",
				"[role=\"button\"][aria-label*=\"发送\"]",
				"[data-testid*=\"send\" i]"
			];
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
})();`;
		}
		/**
		* 诊断脚本：把页面上的输入框与候选发送控件列出来。
		*
		* 发送失败时，宿主面板上点「诊断」就能拿到这份清单 —— 不用再靠用户描述界面。
		* 同时它也是**校准新平台的第一步**：拿这份 dump 去填 Provider 的选择器。
		*/
		function buildDiagnoseScript(hints) {
			const inputSelectors = hints?.inputSelectors ?? [
				"textarea",
				"div[contenteditable=\"true\"]",
				"[role=\"textbox\"]"
			];
			const sendSelectors = hints?.sendSelectors ?? ["button[type=\"submit\"]"];
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
})();`;
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
		function pickSendDelay(min = SEND_DELAY_MIN_MS, max = SEND_DELAY_MAX_MS) {
			const lo = Math.max(0, Math.min(min, max));
			const hi = Math.max(0, Math.max(min, max));
			if (hi <= lo) return lo;
			return Math.floor(Math.random() * (hi - lo + 1)) + lo;
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
		function buildStopScript(hints) {
			const sendSelectors = hints?.sendSelectors ?? ["button[type=\"submit\"]"];
			const vetoes = hints?.vetoes ?? [];
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
})();`;
		}
		//#endregion
		//#region src/shared/providers.ts
		/**
		* DeepSeek 网页版。
		*
		* 所有选择器与评分规则都来自**真浏览器实测**（`npm run probe:dom` /
		* `npm run probe:send`），不是猜的。改版后先跑探测脚本再改这里。
		*/
		const DEEPSEEK = {
			id: "deepseek",
			name: "LDW · DeepSeek 网页版",
			homeUrl: "https://chat.deepseek.com/",
			urlPattern: "chat\\.deepseek\\.com",
			input: { selectors: [
				"textarea[placeholder*=\"给 DeepSeek\"]",
				"textarea[placeholder*=\"DeepSeek\"]",
				"textarea[placeholder*=\"输入\"]",
				"textarea[placeholder*=\"发送\"]",
				"textarea[placeholder*=\"message\" i]",
				"textarea[placeholder*=\"ask\" i]",
				"textarea.chat-input",
				"textarea",
				"div[contenteditable=\"true\"]",
				"[role=\"textbox\"]"
			] },
			send: {
				selectors: [
					"button[type=\"submit\"]",
					"button[aria-label*=\"send\" i]",
					"button[aria-label*=\"发送\"]",
					"[role=\"button\"][aria-label*=\"send\" i]",
					"[role=\"button\"][aria-label*=\"发送\"]",
					"[data-testid=\"send\"]",
					".send-btn"
				],
				signatures: [
					["ds-button--primary", 60],
					["ds-button--filled", 40],
					["ds-button--circle", 50]
				],
				vetoes: ["ds-toggle-button", "ds-button--capsule"]
			},
			completionPath: "/api/v0/chat/completion",
			stopPath: "/api/v0/chat/stop_stream",
			models: [{
				id: "ldw-fast",
				name: "LDW · 快速模式",
				description: "真实浏览器驱动，不思考",
				thinking: false
			}, {
				id: "ldw-think",
				name: "LDW · 深度思考",
				description: "真实浏览器驱动，开启思考",
				thinking: true
			}],
			contextWindow: 1048576,
			maxOutputTokens: 32768,
			reasoningEfforts: [{
				id: "medium",
				name: "思考"
			}],
			defaultReasoningEffort: "medium"
		};
		/** 内置 provider 表。新增站点在这里加一项即可。 */
		const BUILTIN_PROVIDERS = [DEEPSEEK, {
			id: "qwen",
			name: "LDW · 通义千问",
			homeUrl: "https://www.tongyi.com/qianwen/",
			urlPattern: "(tongyi\\.com|qwen\\.(ai|chat))",
			input: { selectors: [
				"div[contenteditable=\"true\"][class*=\"whitespace-pre-wrap\"]",
				"div[contenteditable=\"true\"]",
				"textarea[placeholder*=\"输入\"]",
				"textarea",
				"[role=\"textbox\"]"
			] },
			send: {
				selectors: [
					"button[type=\"submit\"]",
					"button[aria-label*=\"发送\"]",
					"button[aria-label*=\"send\" i]",
					"[role=\"button\"][aria-label*=\"发送\"]",
					"[data-testid*=\"send\" i]"
				],
				signatures: [["rounded-full", 20], ["bg-", 15]],
				vetoes: [
					"添加附件",
					"attach",
					"上传",
					"upload",
					"快速",
					"工作助理",
					"更多",
					"AI生视频",
					"PPT创作",
					"AI生图",
					"代码",
					"翻译",
					"AI写作",
					"stop",
					"停止",
					"收起侧边栏"
				]
			},
			completionPath: "/api/v1/chat/completions",
			models: [{
				id: "qwen-fast",
				name: "LDW · 通义千问",
				description: "真实浏览器驱动",
				thinking: false
			}],
			contextWindow: 131072,
			maxOutputTokens: 8192
		}];
		/** 默认 provider（首个内置项）。 */
		const DEFAULT_PROVIDER_ID = DEEPSEEK.id;
		/**
		* Provider 运行时校验。
		*
		* TS 类型运行时被擦除，"必须实现接口"的真正强制靠这个函数
		* （cuckoo 的 `validate.ts` 做同样的事）。用户自定义 provider 也必须过。
		*/
		function validateProvider(p) {
			if (p === null || typeof p !== "object") return "必须是对象";
			const o = p;
			if (typeof o.id !== "string" || o.id === "") return "缺少 id";
			if (!/^[A-Za-z0-9_-]{1,64}$/.test(o.id)) return "id 只允许字母数字下划线连字符（它会用作 workspace 名）";
			if (typeof o.name !== "string" || o.name === "") return "缺少 name";
			if (typeof o.homeUrl !== "string" || !/^https?:\/\//.test(o.homeUrl)) return "homeUrl 必须是 http(s) URL";
			if (typeof o.urlPattern !== "string" || o.urlPattern === "") return "缺少 urlPattern";
			try {
				new RegExp(o.urlPattern);
			} catch {
				return "urlPattern 不是合法正则";
			}
			const input = o.input;
			if (input === void 0 || !Array.isArray(input.selectors) || input.selectors.length === 0) return "input.selectors 必须是非空数组";
			const send = o.send;
			if (send === void 0 || !Array.isArray(send.selectors) || send.selectors.length === 0) return "send.selectors 必须是非空数组";
			if (typeof o.completionPath !== "string" || o.completionPath === "") return "缺少 completionPath";
			if (!Array.isArray(o.models) || o.models.length === 0) return "models 必须是非空数组";
			for (const m of o.models) {
				if (typeof m.id !== "string" || m.id === "") return "models[].id 必须是非空字符串";
				if (typeof m.name !== "string" || m.name === "") return "models[].name 必须是非空字符串";
			}
			if (typeof o.contextWindow !== "number" || o.contextWindow <= 0) return "contextWindow 必须是正数";
			if (typeof o.maxOutputTokens !== "number" || o.maxOutputTokens <= 0) return "maxOutputTokens 必须是正数";
			for (const [src] of send.signatures ?? []) try {
				new RegExp(src);
			} catch {
				return `send.signatures 里有非法正则：${src}`;
			}
			for (const src of send.vetoes ?? []) try {
				new RegExp(src);
			} catch {
				return `send.vetoes 里有非法正则：${src}`;
			}
			return null;
		}
		/**
		* Provider 注册表。
		*
		* 语义：**内置打底，自定义覆盖**（按 id 匹配）。用户改坏了某个 provider 时
		* 只跳过那一条，不影响其它 —— 内置的仍然可用。
		*/
		var ProviderRegistry = class {
			builtins;
			customs = /* @__PURE__ */ new Map();
			constructor(builtins = BUILTIN_PROVIDERS) {
				this.builtins = builtins.filter((p) => {
					const err = validateProvider(p);
					if (err !== null) {
						console.warn("[dsh-webin] 内置 provider 校验失败，跳过:", p?.id ?? "?", err);
						return false;
					}
					return true;
				});
			}
			/**
			* 装入用户自定义 provider（覆盖同 id 的内置项）。
			*
			* @returns 被接受的 id 与拒绝原因
			*/
			loadCustom(raw) {
				const accepted = [];
				const rejected = [];
				raw.forEach((item, index) => {
					const err = validateProvider(item);
					if (err !== null) {
						rejected.push({
							index,
							reason: err
						});
						return;
					}
					const p = item;
					this.customs.set(p.id, p);
					accepted.push(p.id);
				});
				return {
					accepted,
					rejected
				};
			}
			/** 全部 provider：自定义优先（同 id 覆盖内置）。 */
			all() {
				const out = [];
				const seen = /* @__PURE__ */ new Set();
				for (const p of this.customs.values()) {
					out.push(p);
					seen.add(p.id);
				}
				for (const p of this.builtins) {
					if (seen.has(p.id)) continue;
					out.push(p);
				}
				return out;
			}
			/** 按 id 取；找不到回退到默认 provider。 */
			get(id) {
				const list = this.all();
				const hit = list.find((p) => p.id === id);
				if (hit !== void 0) return hit;
				const fallback = list.find((p) => p.id === DEFAULT_PROVIDER_ID) ?? list[0];
				if (fallback === void 0) throw new Error("dsh-webin: 没有任何可用 provider");
				return fallback;
			}
			/** 按 URL 识别所属 provider（页面导航后用）。 */
			byUrl(url) {
				if (url === "") return void 0;
				for (const p of this.all()) try {
					if (new RegExp(p.urlPattern).test(url)) return p;
				} catch {}
			}
			/** 自定义覆盖了哪些内置 id（设置页显示用）。 */
			overriddenIds() {
				const builtinIds = new Set(this.builtins.map((p) => p.id));
				return [...this.customs.keys()].filter((id) => builtinIds.has(id));
			}
		};
		//#endregion
		//#region src/shared/config.ts
		/** 每个数值字段的边界。超出即拒绝并说明原因。 */
		const LIMITS = {
			sendDelayMinMs: {
				min: 0,
				max: 12e4,
				unit: "ms",
				label: "发送间隔下限"
			},
			sendDelayMaxMs: {
				min: 0,
				max: 3e5,
				unit: "ms",
				label: "发送间隔上限"
			},
			longBreakAfter: {
				min: 0,
				max: 500,
				unit: "次",
				label: "长休触发次数"
			},
			longBreakMinMs: {
				min: 0,
				max: 36e5,
				unit: "ms",
				label: "长休时长下限"
			},
			longBreakMaxMs: {
				min: 0,
				max: 72e5,
				unit: "ms",
				label: "长休时长上限"
			},
			maxRequestsPerTurn: {
				min: 0,
				max: 500,
				unit: "次",
				label: "单轮请求上限"
			},
			replyTimeoutMs: {
				min: 1e4,
				max: 36e5,
				unit: "ms",
				label: "等回复超时"
			},
			claimGraceMs: {
				min: 1e3,
				max: 6e5,
				unit: "ms",
				label: "无人领活宽限"
			},
			toolResultLimit: {
				min: 200,
				max: 2e5,
				unit: "字符",
				label: "工具结果截断"
			},
			snapshotIntervalMs: {
				min: 5e3,
				max: 36e5,
				unit: "ms",
				label: "快照保存间隔"
			}
		};
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
		const DEFAULT_CONFIG = {
			sendDelayMinMs: 2e3,
			sendDelayMaxMs: 4e3,
			longBreakAfter: 0,
			longBreakMinMs: 6e4,
			longBreakMaxMs: 18e4,
			maxRequestsPerTurn: 0,
			replyTimeoutMs: 6e5,
			claimGraceMs: 2e4,
			toolResultLimit: 4e3,
			enableTools: true,
			snapshotIntervalMs: 3e4,
			verboseLog: false
		};
		/** 配置的中文摘要（设置页与日志共用，避免两处措辞不一致）。 */
		function describeConfig(config) {
			return [
				`间隔 ${config.sendDelayMinMs}~${config.sendDelayMaxMs}ms`,
				config.longBreakAfter > 0 ? `长休 每${config.longBreakAfter}次休息 ${Math.round(config.longBreakMinMs / 1e3)}~${Math.round(config.longBreakMaxMs / 1e3)}s` : "长休 关",
				config.maxRequestsPerTurn > 0 ? `单轮上限 ${config.maxRequestsPerTurn}` : "单轮不限",
				`超时 ${Math.round(config.replyTimeoutMs / 1e3)}s`,
				config.enableTools ? "工具 开" : "工具 关"
			].join("，");
		}
		//#endregion
		//#region src/client/index.ts
		/**
		* dsh-webin — client 半。
		*
		* 结构上模仿 cuckoo-code：**不设计协议，操作界面**。
		*   1. 用 DSH 自带的 webview guest 通道拿一个真 Chromium 多进程 guest（等价 cuckoo 的 WebContentsView）
		*   2. 真浏览器里加载 chat.deepseek.com，用户真人登录
		*   3. 注入 hook 只读观察页面自己的 SSE（等价 cuckoo 的 providers/hooks/deepseek.ts）
		*
		* 状态：P0（LDW 标签）+ P1（真实浏览器 + 登录）+ P2（hook 抓回复）+ P3（provider 接进模型选择器）
		*/
		/**
		* 平台注册表（模块级单例）。
		*
		* 内置表打底；用户自定义 provider 由 host 半从 `~/.dsh/webin/providers/` 读出后，
		* 通过 `applyCustomProviders()` 灌进来。**放在模块级**是因为面板组件会被
		* 反复挂载/卸载（切标签），注册表不该跟着重建。
		*/
		const registryRef = { current: new ProviderRegistry() };
		/**
		* 当前配置（模块级缓存）。
		*
		* ## 为什么放模块级 + 定期刷新
		*
		* 配置是用户在**设置页**改的，而设置页与对话区是两个独立挂载点。
		* 发送循环在 `LdwHost` 里，改完配置它不会自动知道 —— 所以：
		*   1. 启动时拉一次
		*   2. 发送前用缓存值（不能每轮都 fetch，那会给 host 添无谓请求）
		*   3. 设置页保存后**主动刷新**（`refreshConfig()`），不必等轮询
		*
		* 不放进 React state 是因为发送循环不在组件渲染路径上 —— 它是个
		* `setInterval` 里的闭包，读 state 会拿到旧值（闭包捕获）。
		*/
		let configRef = { ...DEFAULT_CONFIG };
		/** 拉一次配置（启动时 + 设置页保存后）。失败则保留旧值。 */
		async function refreshConfig() {
			try {
				const data = await (await fetch("/dsh-webin/api/config")).json();
				if (data.config !== void 0) configRef = {
					...DEFAULT_CONFIG,
					...data.config
				};
			} catch {}
			return configRef;
		}
		/** 读当前配置（同步，给发送循环用）。 */
		function currentConfig() {
			return configRef;
		}
		/**
		* 长休状态：连续请求计数。
		*
		* 参考实现有「长休阀门」，本插件默认关闭（`longBreakAfter: 0`），
		* 但用户可以在设置页打开 —— 工具循环连跑十几轮时能压低请求密度。
		*/
		let requestStreak = 0;
		/** 一次请求结束后调用；返回需要休息的毫秒数（0 = 不用休息）。 */
		function noteRequestDone() {
			const cfg = configRef;
			if (cfg.longBreakAfter <= 0) return 0;
			requestStreak += 1;
			if (requestStreak < cfg.longBreakAfter) return 0;
			requestStreak = 0;
			return pickSendDelay(cfg.longBreakMinMs, cfg.longBreakMaxMs);
		}
		/** 单轮请求计数（`maxRequestsPerTurn > 0` 时生效）。 */
		let turnRequests = 0;
		let turnKey = "";
		/** 新的一轮开始（换 job 时调）。 */
		function noteTurnStart(jobId) {
			if (turnKey !== jobId) {
				turnKey = jobId;
				turnRequests = 0;
			}
		}
		/** 本轮还能不能再发请求。 */
		function canSendThisTurn() {
			const cfg = configRef;
			if (cfg.maxRequestsPerTurn <= 0) return true;
			return turnRequests < cfg.maxRequestsPerTurn;
		}
		/** 记一次本轮请求。 */
		function noteTurnRequest() {
			turnRequests += 1;
		}
		/** 由 apply() 在启动时调用：装入 host 侧读到的自定义 provider。 */
		function applyCustomProviders(items) {
			const r = registryRef.current.loadCustom(items);
			return {
				accepted: r.accepted,
				rejected: r.rejected.length
			};
		}
		/** 把 Provider 的定位策略转成发送脚本要的形状。 */
		function sendHintsFor(p) {
			return {
				inputSelectors: p.input.selectors ?? [],
				sendSelectors: p.send.selectors ?? [],
				...p.send.signatures === void 0 ? {} : { signatures: p.send.signatures },
				...p.send.vetoes === void 0 ? {} : { vetoes: p.send.vetoes }
			};
		}
		/** webview 导航 + 吞错（导航失败不算致命：发送脚本自己会报具体错误）。 */
		function element_loadURL(el, url) {
			return el.loadURL(url).then(() => void 0, () => void 0);
		}
		const inject = ["slots"];
		/** 与主进程门禁严格一致：src 必须精确是 about:blank#<lease>。 */
		const LEASE_PREFIX = "about:blank#";
		/**
		* 真实 Chrome UA —— 抹掉 `Electron/44.0.0` 标识。
		*
		* 必要性（实测）：Electron 默认 UA 是
		*   `Mozilla/5.0 ... Chrome/152.0.7977.54 Electron/44.0.0 Safari/537.36`
		* DeepSeek 网页端看到 `Electron/` 直接回「使用环境异常」。
		* `dsh-deepseek-web-login` 的 `src/login.ts:26-32` 记过同一件事，
		* 所以它才要 `buildLoginUserAgent()` 洗白。
		*
		* 版本取内核真实主版本，保持 UA ↔ 内核自洽（写死旧版本反而制造矛盾）。
		*/
		function buildChromeUserAgent() {
			return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${/Chrome\/(\d+)/.exec(navigator.userAgent)?.[1] ?? "0"}.0.0.0 Safari/537.36`;
		}
		/**
		* 主世界指纹修正。
		*
		* `navigator.webdriver` 在 Electron 里默认就是 false，但显式钉死做双保险；
		* `userAgentData` 补品牌列表（Electron 默认缺 `"Google Chrome"` 品牌）。
		* 这段在 `dom-ready` 注入，早于任何用户交互。
		*/
		function fingerprintFix() {
			const major = /Chrome\/(\d+)/.exec(navigator.userAgent)?.[1] ?? "0";
			return `(function(){try{
var m=${JSON.stringify(major)};
var brands=[{brand:"Google Chrome",version:m},{brand:"Chromium",version:m},{brand:"Not_A Brand",version:"24"}];
var uad={brands:brands,mobile:false,platform:"Windows",
getHighEntropyValues:function(){return Promise.resolve({architecture:"x86",bitness:"64",brands:brands,mobile:false,platform:"Windows",platformVersion:"10.0.0",uaFullVersion:m+".0.0.0",fullVersionList:brands});},
toJSON:function(){return{brands:brands,mobile:false,platform:"Windows"};}};
try{Object.defineProperty(navigator,"userAgentData",{get:function(){return uad;},configurable:true});}catch(e){}
try{Object.defineProperty(navigator,"webdriver",{get:function(){return false;},configurable:true});}catch(e){}
}catch(e){}})();`;
		}
		const CSS = `
/* 常驻宿主：挂在 shell.overlay（root scope，永不卸载），用 fixed 贴到占位符上。 */
.webin-host{position:fixed;display:flex;flex-direction:column;box-sizing:border-box;
  color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);
  border-radius:var(--dsw-radius-md);overflow:hidden}
.webin-placeholder{width:100%;height:100%;min-height:0;flex:auto}
.webin-bar{flex:none;display:flex;align-items:center;gap:8px;height:38px;padding:0 8px;
  box-sizing:border-box;border-bottom:.5px solid var(--dsw-alias-border-l3)}
.webin-title{font:var(--dsw-font-xs-12);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.webin-select{height:26px;max-width:200px;padding:0 6px;border-radius:var(--dsw-radius-sm);cursor:pointer;
  border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12)}
.webin-btn{height:26px;padding:0 10px;border-radius:var(--dsw-radius-sm);cursor:pointer;
  border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12)}
.webin-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.webin-btn:disabled{color:var(--dsw-alias-label-quaternary);cursor:default}
.webin-spacer{flex:auto}
/* webview 的挂载容器：React 从不向它渲染子节点，只由我们用 appendChild 放 guest。
   这样 React 的 reconciliation 不会碰到 webview（它是非受控 DOM）。 */
.webin-guest{flex:auto;min-height:0;display:flex}
.webin-guest webview{width:100%;height:100%;display:flex;border:0}
/* 未就绪提示：盖在 guest 区域上（跳过 38px 工具栏），不遮挡按钮 */
.webin-note{position:absolute;left:0;right:0;bottom:0;top:38px;display:flex;align-items:center;
  justify-content:center;padding:24px;text-align:center;white-space:pre-wrap;
  font:var(--dsw-font-xs-12);color:var(--dsw-alias-label-tertiary)}
.webin-capture{flex:none;max-height:120px;overflow:auto;padding:6px 8px;box-sizing:border-box;
  border-top:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);
  font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary);white-space:pre-wrap}
.webin-badge-on,.webin-badge-off{flex:none;padding:1px 6px;border-radius:var(--dsw-radius-sm);
  font:var(--dsw-font-xxxs-11);white-space:nowrap}
.webin-badge-on{color:var(--dsw-alias-state-success-primary);
  background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent)}
.webin-badge-off{color:var(--dsw-alias-label-quaternary);
  background:var(--dsw-alias-bg-layer-2)}

/* ---- 设置页（settings.section）----
   全部用 DSH 的主题 token，不写死颜色 —— 否则切浅色/深色主题会花。 */
.ldw-set{padding:4px 2px 24px;display:flex;flex-direction:column;gap:10px}
.ldw-set-title{margin:0;font:var(--dsw-font-lg-16);color:var(--dsw-alias-label-primary)}
.ldw-set-sub{margin:8px 0 0;font:var(--dsw-font-sm-14);color:var(--dsw-alias-label-primary)}
.ldw-set-note{margin:0;font:var(--dsw-font-xs-12);color:var(--dsw-alias-label-tertiary);line-height:1.6}
.ldw-set-grid{display:flex;flex-direction:column;gap:8px}
.ldw-set-card{padding:10px 12px;border-radius:var(--dsw-radius-md,8px);
  border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);
  display:flex;flex-direction:column;gap:8px}
.ldw-set-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.ldw-set-head strong{font:var(--dsw-font-sm-14);color:var(--dsw-alias-label-primary)}
.ldw-set-id{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-quaternary)}
.ldw-set-tag{padding:1px 6px;border-radius:var(--dsw-radius-sm,6px);font:var(--dsw-font-xxxs-11);
  color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-3)}
.ldw-set-rows{display:flex;flex-direction:column;gap:3px}
.ldw-set-row{display:flex;gap:8px;font:var(--dsw-font-xs-12);line-height:1.5}
.ldw-set-label{flex:none;min-width:52px;color:var(--dsw-alias-label-quaternary)}
.ldw-set-value{color:var(--dsw-alias-label-secondary);word-break:break-all}
.ldw-set-actions{display:flex;gap:8px}
.ldw-set-btn{padding:4px 12px;border-radius:var(--dsw-radius-sm,6px);cursor:pointer;
  border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2);
  font:var(--dsw-font-xs-12);color:var(--dsw-alias-label-secondary)}
.ldw-set-btn:disabled{opacity:.5;cursor:default}
.ldw-set-btn-primary{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3)}
.ldw-set-input{width:100%;box-sizing:border-box;padding:8px;border-radius:var(--dsw-radius-sm,6px);
  border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12);resize:vertical}
.ldw-set-err{padding:8px 10px;border-radius:var(--dsw-radius-sm,6px);
  font:var(--dsw-font-xxs-12);color:var(--dsw-alias-state-error-primary);
  background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent)}

/* ---- 配置表单 ---- */
.ldw-set-details{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md,8px);
  padding:8px 12px;background:var(--dsw-alias-bg-layer-1)}
.ldw-set-details>summary{cursor:pointer;margin:0;list-style:none}
.ldw-set-details>summary::-webkit-details-marker{display:none}
.ldw-set-details>summary::before{content:"▸ ";color:var(--dsw-alias-label-quaternary)}
.ldw-set-details[open]>summary::before{content:"▾ "}
.ldw-set-config{display:flex;flex-direction:column;gap:12px;margin-top:8px}
.ldw-set-group{display:flex;flex-direction:column;gap:6px}
.ldw-set-group-title{margin:0;font:var(--dsw-font-xs-12);color:var(--dsw-alias-label-primary)}
.ldw-set-field{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font:var(--dsw-font-xs-12)}
.ldw-set-field-label{flex:none;min-width:150px;color:var(--dsw-alias-label-secondary)}
.ldw-set-num{width:88px;padding:3px 6px;border-radius:var(--dsw-radius-sm,6px);
  border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2);
  color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12)}
.ldw-set-unit{flex:none;color:var(--dsw-alias-label-quaternary);min-width:24px}
.ldw-set-hint{color:var(--dsw-alias-label-quaternary);font:var(--dsw-font-xxxs-11);line-height:1.5}
`;
		let hostRect = null;
		const rectListeners = /* @__PURE__ */ new Set();
		function publishRect(rect) {
			hostRect = rect;
			for (const fn of rectListeners) fn(rect);
		}
		function subscribeRect(fn) {
			rectListeners.add(fn);
			fn(hostRect);
			return () => {
				rectListeners.delete(fn);
			};
		}
		/**
		* 判断一份快照是否**真的处于登录态**。
		*
		* 为什么要解值而不是看键名：DeepSeek 未登录时也会写 `userToken` /
		* `__appKit_userInfo` 这些键，值是 `null`（实测形状）：
		*
		* ```json
		* "userToken": "{\"value\":null,\"__version\":\"0\"}"
		* "__appKit_userInfo": "{\"value\":{\"id\":null},\"__version\":\"0\"}"
		* ```
		*
		* 只看键是否存在会让「登录页的空快照」覆盖掉上一次的有效快照，
		* 下次启动回写的就是一个空 token —— 白存。
		*
		* 判据（任一成立即认为已登录）：
		*   1. `userToken` 解包后是**非空字符串**
		*   2. `__appKit_userInfo` 解包后 `id` 是**非空字符串**
		*
		* 同时排除停在登录路由上的快照（哪怕 token 还在，页面在登录页说明没生效）。
		*/
		function snapshotLooksLoggedIn(snapshot) {
			const ls = snapshot.localStorage ?? {};
			/**
			* 解包 AppKit 包装：`{"value":<v>,"__version":"0"}` → `<v>`。
			*
			* ⚠️ 解析失败时**不能把原文当 token** —— 那样 `"{broken"` 这种畸形值
			* 会被当成有效 token（非空字符串），于是坏快照又能覆盖好快照。
			* 只有**看起来像 JSON 却解析失败**的才返回 undefined；
			* 真正的裸 token（不以 `{` 开头）才按原文返回。
			*/
			const unwrap = (raw) => {
				if (typeof raw !== "string" || raw === "") return void 0;
				const trimmed = raw.trim();
				if (trimmed === "") return void 0;
				if (trimmed === "null" || trimmed === "undefined") return void 0;
				if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return trimmed;
				try {
					const parsed = JSON.parse(trimmed);
					if (parsed !== null && typeof parsed === "object" && "value" in parsed) return parsed.value;
					return parsed;
				} catch {
					return;
				}
			};
			const token = unwrap(ls.userToken);
			if (typeof token === "string" && token.trim() !== "") return true;
			const info = unwrap(ls["__appKit_userInfo"]);
			if (info !== null && typeof info === "object") {
				const id = info.id;
				if (typeof id === "string" && id.trim() !== "") return true;
			}
			return false;
		}
		function desktopBrowser() {
			const carrier = globalThis.dshDesktop;
			if (carrier === void 0 || carrier === null) return void 0;
			if (carrier.protocolVersion !== 1) return void 0;
			const bridge = carrier.browser;
			if (bridge === void 0 || typeof bridge.acquire !== "function") return void 0;
			return bridge;
		}
		/**
		* LDW **常驻宿主**：申请一个真实浏览器 guest 并挂载。
		*
		* 挂在 `shell.overlay`（root scope，永不卸载），用 `position:fixed` 贴到
		* `LdwPlaceholder` 量出来的矩形上。**这个组件的 DOM 节点自始至终不移动、不重建** ——
		* Electron 的 `<webview>` 一旦从 DOM 摘除再插回，guest 会重新加载。
		*
		* guest 的三条硬约束来自 DSH 主进程 `will-attach-webview`（main.js:9682-9707）：
		*   - `src` 必须精确等于 `about:blank#<lease>`
		*   - `partition` 必须等于 acquire 返回的 partition
		*   - 一个 lease 只能挂载一次（`lease.attached` 后重挂会被拒）
		*/
		function LdwHost() {
			const hostRef = (0, react.useRef)(null);
			/** webview 的挂载点（React 不向它渲染子节点）。 */
			const guestRef = (0, react.useRef)(null);
			const leaseRef = (0, react.useRef)(void 0);
			const [status, setStatus] = (0, react.useState)("正在申请浏览器…");
			const [ready, setReady] = (0, react.useState)(false);
			/** 从 guest 抓到的最后一条回复（P2 的可见证据）。 */
			const [lastReply, setLastReply] = (0, react.useState)("");
			/** 抓到的回复条数。 */
			const [replyCount, setReplyCount] = (0, react.useState)(0);
			/** guest 里的登录态（来自 probe）。 */
			const [loggedIn, setLoggedIn] = (0, react.useState)(false);
			/** 最近一次成功发送的记录（时间 / 方式 / 字符数），显示在工具栏上。 */
			const [lastSend, setLastSend] = (0, react.useState)(void 0);
			/** 诊断输出（页面结构 dump）。 */
			const [diagnosis, setDiagnosis] = (0, react.useState)("");
			/** 占位符当前的矩形；null = LDW 标签不在前台。 */
			const [rect, setRect] = (0, react.useState)(hostRect);
			/** 自校正偏移量（抵消可能的 transform 祖先；无 transform 时保持 0）。 */
			const [pos, setPos] = (0, react.useState)({
				left: 0,
				top: 0
			});
			/** 当前驱动哪个平台。切换它会重建 guest（新 workspace ⇒ 新 partition）。 */
			const [platformId, setPlatformId] = (0, react.useState)(DEFAULT_PROVIDER_ID);
			const provider = (0, react.useMemo)(() => registryRef.current.get(platformId), [platformId]);
			(0, react.useEffect)(() => subscribeRect(setRect), []);
			(0, react.useEffect)(() => {
				let disposed = false;
				const host = guestRef.current;
				if (host === null) return;
				const browser = desktopBrowser();
				if (browser === void 0) {
					setStatus("当前环境没有 DSH 桌面浏览器通道。\nLDW 只能在 Desktop 版 DSH 里使用。");
					return;
				}
				let cleanupElement;
				/**
				* 启动阶段机：`boot → navigating → restoring → reloading → live`。
				*
				* 用显式阶段标记而不是「第几次 dom-ready」，因为**某一步没发生也不能卡住后续**
				* （早期用计数时，没有快照就永远停在 2，hook 永不注入、插件永久失效）。
				*/
				let stage = "boot";
				const stageRef = {
					get current() {
						return stage;
					},
					set current(next) {
						if (next !== stage) console.log("[dsh-webin] 阶段", stage, "→", next);
						stage = next;
					}
				};
				/** 登录态轮询定时器（只用于显示；功能不依赖它）。 */
				let probeTimer;
				/** 是否已经标记过「就绪」（避免重复注入/重复置位）。 */
				let liveMarked = false;
				(async () => {
					try {
						/**
						* **workspace 名决定 partition，也就决定登录态隔离。**
						*
						* `DesktopBrowserGuests.acquire(owner, workspace)` 按 workspace 字符串
						* 缓存 partition（`main.js:9636-9641`），所以用 `provider.id` 当 workspace 名
						* 就能让每个平台拿到独立的 cookie / localStorage —— 多平台登录互不干扰，
						* 且不需要改 DSH 一行。
						*/
						const reservation = await browser.acquire(provider.id);
						if (disposed) {
							await browser.release(reservation.lease).catch(() => void 0);
							return;
						}
						leaseRef.current = reservation.lease;
						const element = document.createElement("webview");
						element.setAttribute("partition", reservation.partition);
						element.setAttribute("useragent", buildChromeUserAgent());
						element.setAttribute("src", LEASE_PREFIX + reservation.lease);
						element.setAttribute("allowpopups", "");
						host.appendChild(element);
						cleanupElement = () => {
							try {
								element.remove();
							} catch {}
						};
						/**
						* 标记「页面已可用」：检查输入框 → 置 `ready` → 启动登录态轮询。
						*
						* 抽成函数是因为有两条路径会走到这里（有快照 reload 后、无快照直接进），
						* 而且**幂等**（重复调用无副作用）。
						*/
						const markLive = () => {
							if (disposed || liveMarked) return;
							liveMarked = true;
							setStatus("真实浏览器已就绪");
							if (probeTimer === void 0) probeTimer = window.setInterval(() => {
								if (disposed) return;
								const node = hostRef.current?.querySelector("webview");
								if (node === null) return;
								node.executeJavaScript(buildProbeScript()).then((r2) => {
									if (disposed) return;
									try {
										const p2 = JSON.parse(String(r2));
										setLoggedIn(p2.loggedIn === true);
									} catch {}
								}).catch(() => void 0);
							}, 5e3);
						};
						element.addEventListener("dom-ready", () => {
							if (disposed) return;
							/**
							* ## 登录态恢复的正确时序（这里踩过坑，务必按顺序）
							*
							* 早期实现在**第一次 `dom-ready`（页面还是 `about:blank`）**上跑 restore，
							* 结果是**每次重启都要重新登录**。原因有两层：
							*
							* 1. `about:blank` 是 **opaque origin**，`localStorage` 直接抛
							*    `SecurityError: Access is denied for this document`
							*    （实测，见 `scripts/probe-origin.mjs`）—— 写操作全部静默失败；
							* 2. 就算不抛，**localStorage 按源隔离**：在 A 源写的值 B 源读不到。
							*
							* 而 DSH 的 guest partition 是**内存分区**
							* （`main.js:9638`：`dsh-sidebar-browser-${randomUUID()}`，无 `persist:` 前缀），
							* 门禁又强制 `params.partition === lease.partition`（`main.js:9685`），
							* **不允许我们自己换成持久分区**。所以重启后 storage 一定是空的，
							* 只能靠「快照 + 在正确源上回写」补救。
							*
							* 正确顺序：
							*   1. 先 `loadURL(homeUrl)` 到**目标域**
							*   2. 目标域的 `dom-ready` 里 restore（此时 localStorage 可写、且源正确）
							*   3. `reload` 让页面带着登录态重新初始化
							*   4. 之后的 `dom-ready` 才注入 hook / 探针
							*
							* ⚠️ **`setReady(true)` 必须等到第 4 阶段**。
							* 早期把 `setReady(true)` 放在这里（第 1 阶段），
							* 于是发送循环在页面还是 `about:blank` / 登录页时就去领任务，
							* 必然报 `no-input: 找不到可见的输入框` —— 实测踩过（用户截图里的报错）。
							* `ready` 的语义应该是「页面已经能干活了」，而不是「webview 挂上了」。
							*/
							/**
							* ## 阶段机（替代早期的 `documentCount` 计数）
							*
							* 早期用 `documentCount === 1 / 2 / >= 3` 判断该做哪一步，
							* 有两个真实缺陷：
							*
							*   1. **一旦某步没发生，后续永远不发生**。比如没有快照时
							*      `documentCount===2` 分支直接 return 且不 reload，
							*      计数就停在 2 —— 于是 hook 永远不注入、`ready` 永远不置位，
							*      **整个插件永久失效**（用户看到「模型一直不回复」）。
							*   2. **页面后续导航会打乱计数**。用户在 guest 里点了个链接、
							*      或页面自己跳登录页，`documentCount` 继续增长，
							*      重新走进「>= 3」分支 —— 虽然碰巧是对的，但纯属运气。
							*
							* 改成显式阶段标记：**每个阶段只做一次，且不依赖"第几次 dom-ready"**。
							*/
							if (stageRef.current === "boot") {
								stageRef.current = "navigating";
								/**
								* ## 优先回到「上次的会话 URL」，而不是每次都开新对话
								*
								* 早期无条件 `loadURL(homeUrl)`（= chat.deepseek.com 首页），
								* 页面把它当成「开新对话」—— 于是**每次重启/重挂载都新建一个对话**，
								* 网页版侧栏堆出一排「从1数到800」「8加8等于16」（用户实测看到的）。
								*
								* 更严重的连带后果：host 侧的差分游标还记着「这会话发过 N 条」，
								* 而页面里是一个**空的新对话** —— 下一轮只发增量，模型完全没上下文。
								*
								* 快照里存了 `url`（上次离开时所在的会话页）。只要它还在本平台域内，
								* 就直接回到那个对话，让页面历史与 host 游标对得上。
								* 没有快照 / URL 非法时才退回 homeUrl。
								*/
								(async () => {
									let target = provider.homeUrl;
									try {
										const raw = await loadSnapshot(provider.id);
										if (typeof raw === "string" && raw !== "") {
											const snap = JSON.parse(raw);
											const saved = typeof snap.url === "string" ? snap.url : "";
											if (saved !== "") {
												const u = new URL(saved);
												if (new RegExp(provider.urlPattern).test(u.hostname + u.pathname)) {
													target = saved;
													console.log("[dsh-webin] 回到上次会话", saved);
												}
											}
										}
									} catch {}
									if (!disposed) element.loadURL(target).catch(() => void 0);
								})();
								return;
							}
							if (stageRef.current === "navigating") {
								stageRef.current = "restoring";
								(async () => {
									const snap = await loadSnapshot(provider.id);
									if (snap === void 0) {
										console.log("[dsh-webin] 无登录态快照，跳过回写");
										stageRef.current = "live";
										markLive();
										return;
									}
									let restored = false;
									try {
										const raw = await element.executeJavaScript(buildRestoreScript(snap));
										const r = JSON.parse(String(raw));
										restored = r.ok === true;
										console.log("[dsh-webin] 登录态回写", provider.id, raw);
										if (!restored) console.warn("[dsh-webin] 回写未成功:", r.reason ?? "unknown");
									} catch (error) {
										console.warn("[dsh-webin] 登录态回写失败", error);
									}
									if (disposed) return;
									if (restored) {
										stageRef.current = "reloading";
										element.reload().catch(() => void 0);
									} else {
										stageRef.current = "live";
										markLive();
									}
								})();
								return;
							}
							/**
							* 页面已可用（`live` / `reloading`）。
							*
							* ⚠️ **每次 dom-ready 都重新注入 hook** —— hook 是页面级的，
							* 页面一导航就没了。早期只在特定计数时注入，导航后就失效了。
							* `buildDeepSeekHook()` 自带幂等标记，重复注入无害。
							*/
							stageRef.current = "live";
							markLive();
							element.executeJavaScript(`(function () {
              var sels = ${JSON.stringify(provider.input.selectors)};
              for (var i = 0; i < sels.length; i++) {
                var list;
                try { list = document.querySelectorAll(sels[i]); } catch (e) { continue; }
                for (var j = 0; j < list.length; j++) {
                  var el = list[j];
                  if (el.offsetWidth > 0 && el.offsetHeight > 0) return true;
                }
              }
              return false;
            })()`).then((hasInput) => {
								if (disposed) return;
								console.log("[dsh-webin] 输入框就绪检查:", hasInput);
								setReady(true);
								if (hasInput === true) setStatus("真实浏览器已就绪");
								else setStatus("页面已加载，但未找到输入框（可能未登录或结构已变）");
							}).catch(() => {
								if (disposed) return;
								setReady(true);
							});
							element.executeJavaScript(fingerprintFix()).catch(() => void 0);
							element.executeJavaScript(buildDeepSeekHook(provider.completionPath, provider.stopPath)).then((r) => {
								if (disposed) return;
								console.log("[dsh-webin] hook:", provider.id, r);
							}).catch((e) => {
								if (disposed) return;
								console.error("[dsh-webin] hook 注入失败", e);
							});
							element.executeJavaScript(buildProbeScript()).then((raw) => {
								if (disposed) return;
								try {
									const info = JSON.parse(String(raw));
									globalThis.__dshWebinProbe = info;
									console.log("[dsh-webin] guest probe", info);
									setLoggedIn(info.loggedIn === true);
								} catch {}
							}).catch(() => void 0);
						});
						element.addEventListener("did-fail-load", (event) => {
							if (disposed) return;
							const e = event;
							if (e.isMainFrame !== true || e.errorCode === -3) return;
							setStatus(`加载失败：${e.errorDescription ?? e.errorCode}`);
							/**
							* ⚠️ **加载失败时不能让阶段机卡住。**
							*
							* 首页加载失败（断网 / DNS / 被墙）时不会触发 `dom-ready`，
							* 阶段就停在 `navigating` —— 之后即使网络恢复，也**永远不会再前进**，
							* 插件表现为「一直不回复」。
							*
							* 所以失败时退回 `boot`，让下一次 `dom-ready` 重新走一遍流程。
							* 退避由浏览器自身的重试节奏决定，不额外加定时器。
							*/
							if (stageRef.current === "navigating" || stageRef.current === "restoring") {
								console.warn("[dsh-webin] 加载失败，阶段回退到 boot 以便重试");
								stageRef.current = "boot";
							}
						});
						/**
						* 渲染进程崩溃（OOM / 页面把 GPU 搞挂）后 webview 会重新加载，
						* 阶段机要能重来 —— 否则同样是「永久卡住」。
						*/
						element.addEventListener("render-process-gone", () => {
							if (disposed) return;
							console.warn("[dsh-webin] guest 渲染进程结束，阶段回退到 boot");
							setStatus("页面进程异常，正在恢复…");
							liveMarked = false;
							stageRef.current = "boot";
						});
					} catch (error) {
						if (disposed) return;
						setStatus(`申请浏览器失败：${error?.message ?? String(error)}`);
					}
				})();
				return () => {
					disposed = true;
					if (probeTimer !== void 0) window.clearInterval(probeTimer);
					cleanupElement?.();
					const lease = leaseRef.current;
					leaseRef.current = void 0;
					if (lease !== void 0) browser.release(lease).catch(() => void 0);
				};
				/**
				* ⚠️ 依赖 `provider.id`：切换平台必须**重建 guest**。
				* 每个平台一个 workspace ⇒ 一个 partition ⇒ 一套独立登录态，
				* 复用同一个 guest 就共享登录态了，多平台隔离失效。
				* （早期这里写死 `[]`，切平台不生效 —— 实测发现。）
				*/
			}, [provider.id]);
			const pendingJobRef = (0, react.useRef)(void 0);
			/**
			* 本次发送被确认的时刻（页面时间）。
			*
			* **防串台**：用户在页面上自己聊过天，或上一次回复的 `done` 事件还在队列里，
			* 都可能在我们派发任务后立刻被排空 —— 那样就会把**别人的回复**当成任务结果交回去。
			* 只接受发送确认之后产生的 `done` 事件。
			*/
			const sentAtRef = (0, react.useRef)(0);
			/**
			* 当前待办任务（已发送、等回复）。
			*
			* 有值 ⇒ 发送循环**不再领新任务**（否则会插队打断当前生成、回复串台）。
			* 靠 `done`/`error` 事件清空；另有一道超时兜底（见 `pendingSinceRef`），
			* 防止事件丢失导致永久卡住。
			*/
			const pendingSinceRef = (0, react.useRef)(0);
			(0, react.useEffect)(() => {
				if (!ready) return;
				const timer = window.setInterval(() => {
					const el = hostRef.current?.querySelector("webview");
					if (el === null) return;
					el.executeJavaScript(buildDrainScript()).then((raw) => {
						const text = String(raw);
						if (text === "[]" || text === "") return;
						const events = JSON.parse(text);
						for (const ev of events) {
							const at = typeof ev.at === "number" ? ev.at : 0;
							if (at !== 0 && at < sentAtRef.current) continue;
							if (ev.name === "done") {
								const reply = String(ev.detail?.text ?? "");
								if (reply === "") continue;
								setLastReply(reply);
								setReplyCount((n) => n + 1);
								console.log("[dsh-webin] reply captured", {
									chars: reply.length,
									status: ev.detail?.status,
									think: String(ev.detail?.think ?? "").length
								});
								const jobId = pendingJobRef.current;
								if (jobId !== void 0) {
									pendingJobRef.current = void 0;
									pendingSinceRef.current = 0;
									/** 拿页面当前 URL（= 这条消息落地的对话页）。 */
									el.executeJavaScript("location.href").then((u) => String(u)).catch(() => "").then((chatUrl) => {
										fetch(`/dsh-webin/api/job/${jobId}/result`, {
											method: "PUT",
											headers: { "content-type": "application/json" },
											body: JSON.stringify({
												text: reply,
												think: String(ev.detail?.think ?? ""),
												status: String(ev.detail?.status ?? "finished"),
												...chatUrl === "" ? {} : { chatUrl }
											})
										}).catch(() => void 0);
									});
								}
							} else if (ev.name === "error") {
								console.warn("[dsh-webin] page reported error", ev.detail);
								const jobId = pendingJobRef.current;
								if (jobId !== void 0) {
									pendingJobRef.current = void 0;
									pendingSinceRef.current = 0;
									fetch(`/dsh-webin/api/job/${jobId}/result`, {
										method: "PUT",
										headers: { "content-type": "application/json" },
										body: JSON.stringify({ error: String(ev.detail?.message ?? "page error") })
									}).catch(() => void 0);
								}
							}
						}
					}).catch(() => void 0);
				}, 500);
				return () => window.clearInterval(timer);
			}, [ready, provider.id]);
			/**
			* 心跳：告诉 host「本面板在线、页面处于什么状态」。
			*
			* 为什么需要：host 半的 adapter 要判断「有没有 client 能干活」。
			* 光看任务队列只能知道「有没有人领活」，而心跳能让 `/status` 直接反映
			* 面板是否挂载、是否已登录 —— 排查「模型不回复」时一眼就能定位。
			*/
			(0, react.useEffect)(() => {
				if (!ready) return;
				/**
				* clientId 里带上平台 —— 一个面板可能切换平台，
				* 带平台后 host 侧 `/status` 能直接看出「哪个平台的面板在线」。
				*/
				const clientId = `webin-${provider.id}-${Math.random().toString(36).slice(2, 10)}`;
				let stopped = false;
				const beat = () => {
					if (stopped) return;
					const el = hostRef.current?.querySelector("webview");
					const payload = {
						clientId,
						platform: provider.id,
						loggedIn,
						hasGuest: el !== null,
						lastReplyAt: lastReply === "" ? 0 : Date.now(),
						replyCount
					};
					fetch("/dsh-webin/api/client/heartbeat", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(payload)
					}).catch(() => void 0);
				};
				beat();
				const timer = window.setInterval(beat, 5e3);
				return () => {
					stopped = true;
					window.clearInterval(timer);
				};
			}, [
				ready,
				provider.id,
				loggedIn,
				lastReply,
				replyCount
			]);
			(0, react.useEffect)(() => {
				if (!ready) return;
				let stopped = false;
				let busy = false;
				const tick = async () => {
					if (stopped || busy) return;
					/**
					* ## ⚠️ 正在等回复时**绝不能再领新任务**
					*
					* 这是本插件最危险的一个 bug（实测发现）：
					* 发送成功后 `pendingJobRef` 仍然置着，而轮询每 1.5s 跑一次。
					* 早期版本没有这道闸，于是**页面还在生成时又领了下一个任务**，
					* 把新 prompt 打进输入框并发送 —— 后果：
					*   1. 页面上的生成被打断/插队，两个回复混在一起；
					*   2. hook 抓到的 `done` 分不清是哪个任务的（串台）；
					*   3. DSH 那边两个调用都收到错乱的文本。
					*
					* 所以：`pendingJobRef` 有值 = 上一个任务还没交结果 ⇒ 本轮只做
					* 「问 host 是否被取消」，不领新活。
					*/
					const hasPending = pendingJobRef.current !== void 0;
					const el = hostRef.current?.querySelector("webview");
					if (el === null) return;
					busy = true;
					try {
						/**
						* **待办超时兜底。**
						*
						* 正常情况下 `done` 事件会清掉 `pendingJobRef`。但事件可能丢：
						* 页面导航了、hook 被清了、回复永远不来。那样 `pendingJobRef`
						* 会一直挂着 ⇒ 发送循环**永久罢工**（再也不领新任务），
						* 用户看到的就是「模型一直不回复」。
						*
						* 所以超过 5 分钟就主动放弃这个任务，把错误交回 host 并解锁循环。
						* （adapter 那边的 `timeoutMs` 是 10 分钟，这里更早，避免两边同时超时。）
						*/
						if (hasPending && Date.now() - pendingSinceRef.current > 3e5) {
							const stuck = pendingJobRef.current;
							console.warn("[dsh-webin] 待办超时，放弃任务", stuck);
							pendingJobRef.current = void 0;
							pendingSinceRef.current = 0;
							await fetch(`/dsh-webin/api/job/${stuck}/result`, {
								method: "PUT",
								headers: { "content-type": "application/json" },
								body: JSON.stringify({ error: "等待网页回复超时（客户端 5 分钟兜底）" })
							}).catch(() => void 0);
							return;
						}
						/**
						* 带上 `running=<当前任务>` —— 让 host 有机会说「这个不算数了」。
						*
						* 用户按停止后 host 会把任务标记为 `cancelled`，但我们可能正在
						* 等页面回复（还没交结果），不会再去领活。所以**每次轮询都问一次**，
						* 被取消就去按页面的停止按钮（否则页面白生成到结束、烧配额、还会串台）。
						*/
						const running = pendingJobRef.current;
						const query = "/dsh-webin/api/job/next?platform=" + encodeURIComponent(provider.id) + (running === void 0 ? "" : "&running=" + encodeURIComponent(running));
						const res = await fetch(query);
						if (!res.ok) return;
						const data = await res.json();
						if (typeof data.cancel === "string" && data.cancel !== "") {
							console.log("[dsh-webin] 任务已被取消，停止页面生成", data.cancel);
							pendingJobRef.current = void 0;
							pendingSinceRef.current = 0;
							const stopped = await el.executeJavaScript(buildStopScript(sendHintsFor(provider)));
							console.log("[dsh-webin] 停止结果", stopped);
							return;
						}
						if (hasPending) return;
						if (stopped || data.job === null || data.job === void 0) return;
						const { id, prompt } = data.job;
						/**
						* ## 会话路由：先导航到这个任务所属的网页对话
						*
						* 用户实测发现的封号级缺陷：换了几个 DSH 窗口聊天，
						* 网页版里全落在**同一个**会话窗口 —— 上下文互相串、
						* 多个话题混在一条流里，行为模式像机器人。
						*
						* host 在任务上带 `expectUrl`（该 DSH 会话绑定的对话页）。
						* 当前页面不在那里时，**先导航过去再发**：
						*   - 同一 DSH 会话的连续任务 → URL 相同，不导航（零开销）
						*   - 切换 DSH 会话 → 导航回各自的对话，各聊各的
						*   - 首次任务（无 expectUrl）→ 在当前页发，落地 URL 由结果带回
						*
						* 导航后页面重载会触发 dom-ready → 阶段机已在 live，
						* hook 会重新注入（幂等），输入框由发送脚本自带的 waitForInput 等。
						*/
						if (typeof data.job.expectUrl === "string" && data.job.expectUrl !== "") {
							const current = await el.executeJavaScript("location.href").then((u) => String(u)).catch(() => "");
							if (current !== data.job.expectUrl) {
								console.log("[dsh-webin] 切换到该会话的对话", {
									from: current.slice(-48),
									to: data.job.expectUrl.slice(-48)
								});
								await element_loadURL(el, data.job.expectUrl);
								if (!await el.executeJavaScript(`(function () {
                  var sels = ${JSON.stringify(provider.input.selectors)};
                  var deadline = Date.now() + 25000;
                  return new Promise(function (resolve) {
                    (function attempt() {
                      for (var i = 0; i < sels.length; i++) {
                        var list;
                        try { list = document.querySelectorAll(sels[i]); } catch (e) { continue; }
                        for (var j = 0; j < list.length; j++) {
                          var el = list[j];
                          if (el.offsetWidth > 0 && el.offsetHeight > 0) { resolve(true); return; }
                        }
                      }
                      if (Date.now() > deadline) { resolve(false); return; }
                      setTimeout(attempt, 300);
                    })();
                  });
                })()`).then((r) => r === true).catch(() => false)) console.warn("[dsh-webin] 导航后未见输入框，仍尝试发送");
							}
						}
						/**
						* ## 首轮必须**开新对话**（不能占用当前页）
						*
						* `expectUrl` 只覆盖「已绑定」的情况。首轮没有绑定，早期实现退化成
						* 「在当前页发」—— 而当前页可能是**别的会话的对话**。实测后果：
						*
						* ```
						* 会话A 首轮 → 在当前页 X 发 → 绑定 A→X
						* 会话B 首轮 → 无绑定 → 仍在 X 发 → 绑定 B→X   ← 两个会话挤进 X！
						* ```
						*
						* 这正是用户报的「换了几个 DSH 窗口，全都是在网页版的同一个会话窗口」。
						*
						* 所以 `freshChat` 时**显式开新对话**：导航到 homeUrl。
						* 网页版对 homeUrl 的处理就是「新建/当前空白对话」，
						* 不会复用已有对话的内容（实测：重启后导航 homeUrl 会开新对话）。
						*/
						if (data.job.freshChat === true && data.job.expectUrl === void 0) {
							const current = await el.executeJavaScript("location.href").then((u) => String(u)).catch(() => "");
							if (/\/a\/chat\/s\//.test(current)) {
								console.log("[dsh-webin] 首轮：开新对话（不占用当前页）", { from: current.slice(-48) });
								await element_loadURL(el, provider.homeUrl);
								await el.executeJavaScript(`(function () {
                  var sels = ${JSON.stringify(provider.input.selectors)};
                  var deadline = Date.now() + 25000;
                  return new Promise(function (resolve) {
                    (function attempt() {
                      for (var i = 0; i < sels.length; i++) {
                        var list;
                        try { list = document.querySelectorAll(sels[i]); } catch (e) { continue; }
                        for (var j = 0; j < list.length; j++) {
                          var el = list[j];
                          if (el.offsetWidth > 0 && el.offsetHeight > 0) { resolve(true); return; }
                        }
                      }
                      if (Date.now() > deadline) { resolve(false); return; }
                      setTimeout(attempt, 300);
                    })();
                  });
                })()`).catch(() => false);
							}
						}
						pendingJobRef.current = id;
						pendingSinceRef.current = Date.now();
						sentAtRef.current = Date.now();
						console.log("[dsh-webin] 领到任务", {
							id,
							chars: prompt.length
						});
						/**
						* ## 应用用户配置
						*
						* 1. **单轮请求上限** —— 工具循环可能连发很多轮，用户可以设个上限
						*    防止意外烧配额（到顶就交个错误让 DSH 停在这一轮）。
						* 2. **发送间隔** —— 从配置读，而不是硬编码 2000~4000ms。
						* 3. **长休** —— 连续 N 次请求后强制休息（默认关）。
						*/
						noteTurnStart(id);
						if (!canSendThisTurn()) {
							console.warn("[dsh-webin] 本轮请求数已达上限，停止发送", { limit: currentConfig().maxRequestsPerTurn });
							pendingJobRef.current = void 0;
							pendingSinceRef.current = 0;
							await fetch(`/dsh-webin/api/job/${id}/result`, {
								method: "PUT",
								headers: { "content-type": "application/json" },
								body: JSON.stringify({ error: `本轮请求数已达上限（${currentConfig().maxRequestsPerTurn}），可在设置页调整` })
							}).catch(() => void 0);
							return;
						}
						noteTurnRequest();
						const cfgNow = currentConfig();
						const breakMs = noteRequestDone();
						if (breakMs > 0) {
							console.log(`[dsh-webin] 长休 ${Math.round(breakMs / 1e3)}s（每 ${cfgNow.longBreakAfter} 次请求休息一次）`);
							await new Promise((r) => setTimeout(r, breakMs));
						}
						const raw = await el.executeJavaScript(buildSendScript(prompt, pickSendDelay(cfgNow.sendDelayMinMs, cfgNow.sendDelayMaxMs), sendHintsFor(provider)));
						const outcome = JSON.parse(String(raw));
						console.log("[dsh-webin] 发送结果", outcome);
						if (!outcome.ok) {
							pendingJobRef.current = void 0;
							pendingSinceRef.current = 0;
							await fetch(`/dsh-webin/api/job/${id}/result`, {
								method: "PUT",
								headers: { "content-type": "application/json" },
								body: JSON.stringify({ error: `${outcome.stage}: ${outcome.message}` })
							}).catch(() => void 0);
							return;
						}
						sentAtRef.current = Date.now();
						setLastSend({
							at: (/* @__PURE__ */ new Date()).toLocaleTimeString("zh-CN", { hour12: false }),
							how: String(outcome.how ?? "?"),
							chars: prompt.length
						});
					} catch (error) {
						console.warn("[dsh-webin] 任务处理失败", error);
					} finally {
						busy = false;
					}
				};
				const timer = window.setInterval(() => void tick(), 1500);
				tick();
				return () => {
					stopped = true;
					window.clearInterval(timer);
				};
			}, [ready, provider.id]);
			(0, react.useEffect)(() => {
				if (!ready) return;
				let stopped = false;
				const save = () => {
					const el = hostRef.current?.querySelector("webview");
					if (el === null) return;
					el.executeJavaScript(buildSnapshotScript()).then(async (raw) => {
						if (stopped) return;
						const text = String(raw);
						if (text === "{}" || text === "") return;
						let parsed;
						try {
							parsed = JSON.parse(text);
						} catch {
							return;
						}
						/**
						* **只存「确实登录了」的快照。**
						*
						* ⚠️ 这里踩过坑：早期版本只检查 `userToken` **键是否存在**，
						* 而 DeepSeek 未登录时也会写这个键 —— 值是 `{"value":null,"__version":"0"}`。
						* 于是重启后的登录页会把上一次的有效快照**覆盖成空快照**，
						* 下一次启动回写的就是一个 `userToken: null`，等于白存。
						* 实测：快照里 `userToken={"value":null}` + `__appKit_userInfo={"value":{"id":null}}`
						* + `url=https://chat.deepseek.com/sign_in`。
						*
						* 所以必须**解出值**再判断，而不是看键名。
						*/
						if (!snapshotLooksLoggedIn(parsed)) {
							console.log("[dsh-webin] 当前未登录，跳过快照（不覆盖上次有效快照）");
							return;
						}
						const ok = await saveSnapshot(text, provider.id);
						if (stopped || !ok) return;
						console.log("[dsh-webin] 登录态快照已存入 host", {
							keys: Object.keys(parsed.localStorage ?? {}),
							cookieChars: (parsed.cookie ?? "").length
						});
					}).catch(() => void 0);
				};
				save();
				/** 快照间隔从配置读（设置页可调），默认 30s。 */
				const timer = window.setInterval(save, Math.max(5e3, currentConfig().snapshotIntervalMs));
				return () => {
					stopped = true;
					window.clearInterval(timer);
				};
			}, [ready, provider.id]);
			/**
			* 贴到占位符上。
			*
			* ⚠️ 这里**只改坐标，不动 DOM 结构** —— webview 节点在整棵树里位置恒定，
			* 否则 Electron 会重新加载 guest。
			*
			* 标签切走时 `rect` 变 null：把宿主移出视口并 `visibility:hidden`。
			* **不用 `display:none`** —— 那会让 webview 停止布局，某些情况下触发 guest 重排。
			*/
			const visible = rect !== null && rect.visible;
			/**
			* 自校正定位。
			*
			* 期望位置来自占位符的 `getBoundingClientRect()`（**视口坐标**），
			* 而 `position:fixed` 只在本元素没有 transform 祖先时才严格等于视口坐标。
			* 实测 DSH 的 `shell.overlay` 链路（`ui-layout` 全量 CSS）没有 transform，
			* 但那是**别人代码的前提**，不该由本插件承担。
			*
			* 所以这里不假设：放好之后量一下自己的真实位置，按偏差修正。
			* 有 translate 类祖先时偏差被抵消，没有时偏差为 0、立即收敛。
			*
			* 修正次数**有上限**：若祖先是 scale 之类无法用平移抵消的变换，
			* 迭代不会收敛，此时必须停下来而不是无限重渲染。
			*/
			const fixAttemptsRef = (0, react.useRef)(0);
			(0, react.useLayoutEffect)(() => {
				if (!visible || rect === null) {
					fixAttemptsRef.current = 0;
					return;
				}
				const el = hostRef.current;
				if (el === null) return;
				if (fixAttemptsRef.current >= 4) return;
				const current = el.getBoundingClientRect();
				const dx = rect.left - current.left;
				const dy = rect.top - current.top;
				if (Math.abs(dx) < .5 && Math.abs(dy) < .5) {
					fixAttemptsRef.current = 0;
					return;
				}
				fixAttemptsRef.current += 1;
				setPos((prev) => ({
					left: prev.left + dx,
					top: prev.top + dy
				}));
			});
			const box = visible && rect !== null ? {
				left: `${pos.left + rect.left}px`,
				top: `${pos.top + rect.top}px`,
				width: `${rect.width}px`,
				height: `${rect.height}px`
			} : {
				left: "-10000px",
				top: "0px",
				width: "800px",
				height: "600px"
			};
			return (0, react.createElement)("div", {
				className: "webin-host",
				ref: hostRef,
				style: {
					...box,
					visibility: visible ? "visible" : "hidden"
				}
			}, [
				(0, react.createElement)("div", {
					className: "webin-bar",
					key: "bar"
				}, [
					(0, react.createElement)("select", {
						className: "webin-select",
						key: "p",
						value: platformId,
						onChange: (e) => {
							setPlatformId(e.target.value);
							setReady(false);
							setStatus("正在切换平台…");
							setLastReply("");
							setReplyCount(0);
							setLoggedIn(false);
							setDiagnosis("");
						}
					}, registryRef.current.all().map((p) => (0, react.createElement)("option", {
						key: p.id,
						value: p.id
					}, p.name))),
					(0, react.createElement)("span", {
						className: loggedIn ? "webin-badge-on" : "webin-badge-off",
						key: "a"
					}, loggedIn ? "已登录" : "未登录"),
					(0, react.createElement)("span", {
						className: "webin-spacer",
						key: "s"
					}),
					(0, react.createElement)("span", {
						className: "webin-title",
						key: "c"
					}, lastSend !== void 0 ? `${lastSend.at} 已发送(${lastSend.how}) · 收到 ${replyCount} 条` : replyCount > 0 ? `已抓取 ${replyCount} 条回复` : "等待任务…"),
					(0, react.createElement)("button", {
						className: "webin-btn",
						key: "d",
						disabled: !ready,
						onClick: () => {
							const el = hostRef.current?.querySelector("webview");
							if (el === null) return;
							el.executeJavaScript(buildDiagnoseScript(sendHintsFor(provider))).then((raw) => {
								const text = String(raw);
								setDiagnosis(text);
								console.log("[dsh-webin] 页面结构诊断", text);
							}).catch((e) => setDiagnosis(`诊断失败：${String(e)}`));
						}
					}, "诊断"),
					(0, react.createElement)("button", {
						className: "webin-btn",
						key: "r",
						disabled: !ready,
						onClick: () => {
							(hostRef.current?.querySelector("webview"))?.reload();
						}
					}, "刷新")
				]),
				(0, react.createElement)("div", {
					className: "webin-guest",
					key: "guest",
					ref: guestRef
				}),
				ready ? null : (0, react.createElement)("div", {
					className: "webin-note",
					key: "n"
				}, status),
				diagnosis === "" ? null : (0, react.createElement)("div", {
					className: "webin-capture",
					key: "diag"
				}, `【页面结构】${diagnosis.slice(0, 1200)}`),
				lastReply === "" ? null : (0, react.createElement)("div", {
					className: "webin-capture",
					key: "cap"
				}, `【最后一条抓取】${lastReply.slice(0, 400)}${lastReply.length > 400 ? "…" : ""}`)
			]);
		}
		/**
		* LDW **占位符**：留在 `conversation.view` 里（就是用户要的那个红框位置）。
		*
		* 它自己不含 webview —— 只负责量出自己的矩形并广播给常驻宿主。
		* 组件被卸载（切标签）时把矩形置 null，宿主随即移出视口，**但 guest 不受影响**。
		*/
		/**
		* ## LDW 设置页（`settings.section`）
		*
		* 用户实测反馈：「dsh 插件没有设置页面」。
		*
		* ## 注册契约（从生态里实测出来的，两个坑）
		*
		* 1. **`register` 必须带 `name` 字段**（就是 slot 名）—— 少了它注��不上，
		*    而且**不报错**，表现为设置页里凭空少一项，极难排查。
		* 2. **渲染函数必须返回 React 元素**（`createElement(...)`）。
		*    直接返回字符串/数组/`undefined` 会触发 **React #130**
		*    （"Element type is invalid"），整个设置面板白屏。
		*
		* 所以下面 `register(options, () => createElement(Panel))` 这个形状不能省。
		*
		* ## 为什么用 host 的 `/providers` 而不是把数据塞进 props
		*
		* 设置页与对话区是**两个独立挂载点**，共享的只有 host 的状态。
		* 所以面板自己去 `GET /dsh-webin/api/providers` 拉数据，
		* 增删也走同一套 API —— 与「provider 可从磁盘热加载」的设计一致。
		*/
		const LDW_API = "/dsh-webin/api";
		/**
		* 配置分组。
		*
		* 分组不是装饰 —— 用户面对 11 个数字会懵。按**意图**分成三组：
		*   - 防封号：担心账号安全时来这调
		*   - 行为：遇到超时/截断时来这调
		*   - 诊断：出问题时来这看
		*/
		const FIELD_GROUPS = [
			{
				title: "防封号",
				note: "网页版对请求密度敏感。调更保守 = 更慢但更安全。",
				fields: [
					{
						key: "sendDelayMinMs",
						label: "发送间隔下限",
						unit: "ms",
						scale: 1e3
					},
					{
						key: "sendDelayMaxMs",
						label: "发送间隔上限",
						unit: "ms",
						scale: 1e3
					},
					{
						key: "longBreakAfter",
						label: "每 N 次请求后长休",
						unit: "次",
						hint: "0 = 关闭。工具循环连跑十几轮时能压低密度。"
					},
					{
						key: "longBreakMinMs",
						label: "长休时长下限",
						unit: "ms",
						scale: 1e3
					},
					{
						key: "longBreakMaxMs",
						label: "长休时长上限",
						unit: "ms",
						scale: 1e3
					},
					{
						key: "maxRequestsPerTurn",
						label: "单轮请求上限",
						unit: "次",
						hint: "0 = 不限。防止工具循环意外烧配额。"
					}
				]
			},
			{
				title: "行为",
				note: "遇到超时、结果被截断时来这调。",
				fields: [
					{
						key: "replyTimeoutMs",
						label: "等网页回复超时",
						unit: "ms",
						scale: 1e3
					},
					{
						key: "claimGraceMs",
						label: "浏览器未打开时的快速失败",
						unit: "ms",
						scale: 1e3
					},
					{
						key: "toolResultLimit",
						label: "工具结果截断",
						unit: "字符",
						hint: "太大可能把输入框顶爆；太小模型看不到关键内容。"
					},
					{
						key: "enableTools",
						label: "允许调用工具",
						bool: true,
						hint: "关掉后模型收不到工具目录，只能纯聊天。"
					},
					{
						key: "snapshotIntervalMs",
						label: "登录态快照间隔",
						unit: "ms",
						scale: 1e3
					}
				]
			},
			{
				title: "诊断",
				note: "出问题时打开，看浏览器控制台。",
				fields: [{
					key: "verboseLog",
					label: "详细日志",
					bool: true
				}]
			}
		];
		/** 设置页面板。 */
		function LdwSettings() {
			const [state, setState] = (0, react.useState)(null);
			const [busy, setBusy] = (0, react.useState)(false);
			const [note, setNote] = (0, react.useState)("");
			const [draft, setDraft] = (0, react.useState)("");
			/** 配置表单的本地编辑态（保存前不生效）。 */
			const [form, setForm] = (0, react.useState)(null);
			const [problems, setProblems] = (0, react.useState)([]);
			const [showAdd, setShowAdd] = (0, react.useState)(false);
			const refresh = (0, react.useMemo)(() => async () => {
				try {
					const data = await (await fetch(`${LDW_API}/providers`)).json();
					setState({
						providers: Array.isArray(data.providers) ? data.providers : [],
						customIds: Array.isArray(data.customIds) ? data.customIds : [],
						defaultProviderId: String(data.defaultProviderId ?? ""),
						errors: Array.isArray(data.errors) ? data.errors : [],
						clients: Array.isArray(data.clients) ? data.clients : []
					});
				} catch (error) {
					setNote(`读取失败：${error?.message ?? String(error)}`);
				}
			}, []);
			(0, react.useEffect)(() => {
				refresh();
				/** 登录态 / 回复数会变，定期刷新（5s 足够，且不打扰）。 */
				const timer = window.setInterval(() => void refresh(), 5e3);
				return () => window.clearInterval(timer);
			}, [refresh]);
			/** 拉配置（进设置页时一次 + 保存后一次）。 */
			const loadConfig = (0, react.useMemo)(() => async () => {
				try {
					const data = await (await fetch(`${LDW_API}/config`)).json();
					if (data.config !== void 0) setForm({
						...DEFAULT_CONFIG,
						...data.config
					});
					setProblems(Array.isArray(data.problems) ? data.problems : []);
				} catch (error) {
					setNote(`配置读取失败：${error?.message ?? String(error)}`);
				}
			}, []);
			(0, react.useEffect)(() => {
				loadConfig();
			}, [loadConfig]);
			/** 改一个字段（只改本地表单）。 */
			const setField = (key, value) => {
				setForm((prev) => prev === null ? prev : {
					...prev,
					[key]: value
				});
			};
			/** 保存配置 → host 校验 → 立刻刷新 client 的模块级缓存。 */
			const saveConfig = async () => {
				if (form === null) return;
				setBusy(true);
				setNote("");
				try {
					const data = await (await fetch(`${LDW_API}/config`, {
						method: "PUT",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(form)
					})).json();
					if (data.ok !== true) {
						setNote(`保存失败：${data.reason ?? "未知原因"}`);
						return;
					}
					if (data.config !== void 0) setForm({
						...DEFAULT_CONFIG,
						...data.config
					});
					setProblems(Array.isArray(data.problems) ? data.problems : []);
					/** ⭐ 关键：让发送循环立刻用上新配置（否则要等下次启动）。 */
					await refreshConfig();
					setNote((data.problems ?? []).length > 0 ? `已保存（${(data.problems ?? []).length} 项被修正）` : "已保存，立刻生效");
				} catch (error) {
					setNote(`保存失败：${error?.message ?? String(error)}`);
				} finally {
					setBusy(false);
				}
			};
			/** 恢复默认配置。 */
			const resetConfig = async () => {
				setBusy(true);
				setNote("");
				try {
					const data = await (await fetch(`${LDW_API}/config`, { method: "DELETE" })).json();
					if (data.ok === true && data.config !== void 0) {
						setForm({
							...DEFAULT_CONFIG,
							...data.config
						});
						setProblems([]);
						await refreshConfig();
						setNote("已恢复默认");
					}
				} catch (error) {
					setNote(`恢复失败：${error?.message ?? String(error)}`);
				} finally {
					setBusy(false);
				}
			};
			/** 提交一个自定义 provider（JSON 文本）。 */
			const submit = async () => {
				setBusy(true);
				setNote("");
				try {
					const data = await (await fetch(`${LDW_API}/providers`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: draft
					})).json();
					if (data.ok === true) {
						setNote("已保存，平台列表已刷新");
						setDraft("");
						await refresh();
					} else setNote(`保存失败：${data.reason ?? data.errors?.[0]?.reason ?? "未知原因"}`);
				} catch (error) {
					setNote(`保存失败：${error?.message ?? String(error)}`);
				} finally {
					setBusy(false);
				}
			};
			/** 删一个自定义 provider。 */
			const remove = async (id) => {
				setBusy(true);
				setNote("");
				try {
					const data = await (await fetch(`${LDW_API}/providers/${encodeURIComponent(id)}`, { method: "DELETE" })).json();
					setNote(data.ok === true ? `已删除 ${id}` : `删除失败：${data.reason ?? "未知原因"}`);
					await refresh();
				} catch (error) {
					setNote(`删除失败：${error?.message ?? String(error)}`);
				} finally {
					setBusy(false);
				}
			};
			if (state === null) return (0, react.createElement)("div", { className: "ldw-set" }, (0, react.createElement)("p", { className: "ldw-set-note" }, "正在读取…"));
			/** 每个平台一张卡片：登录态 + 模型数 + 是否可删。 */
			const cards = state.providers.map((p) => {
				const beats = state.clients.filter((c) => c.platform === p.id);
				const loggedIn = beats.some((c) => c.loggedIn);
				const live = beats.length > 0;
				const isCustom = state.customIds.includes(p.id);
				return (0, react.createElement)(
					"div",
					{
						key: p.id,
						className: "ldw-set-card"
					},
					(0, react.createElement)("div", { className: "ldw-set-head" }, (0, react.createElement)("strong", null, p.name), (0, react.createElement)("code", { className: "ldw-set-id" }, p.id), isCustom ? (0, react.createElement)("span", { className: "ldw-set-tag" }, "自定义") : null),
					(0, react.createElement)("div", { className: "ldw-set-rows" }, row("地址", p.homeUrl), row("模型", p.models.map((m) => m.name).join("、") || "（无）"), row("上下文", `${p.contextWindow.toLocaleString()} token`), row("状态", live ? loggedIn ? "已登录，浏览器在线" : "浏览器在线，未登录" : "浏览器未打开（切到 LDW 标签即可）")),
					/**
					* 只有**自定义**项能删 —— 内置项删不掉（删了下次启动还在），
					* 给它一个按钮只会让人困惑。要改内置项就用同 id 覆盖。
					*/
					isCustom ? (0, react.createElement)("div", { className: "ldw-set-actions" }, (0, react.createElement)("button", {
						type: "button",
						className: "ldw-set-btn",
						disabled: busy,
						onClick: () => void remove(p.id)
					}, "删除")) : null
				);
			});
			/** 渲染一个配置字段。 */
			const renderField = (spec) => {
				if (form === null) return null;
				const value = form[spec.key];
				const limit = LIMITS[spec.key];
				const scale = spec.scale ?? 1;
				const unit = scale === 1e3 ? "秒" : spec.unit ?? "";
				if (spec.bool === true) return (0, react.createElement)("label", {
					key: spec.key,
					className: "ldw-set-field"
				}, (0, react.createElement)("input", {
					type: "checkbox",
					checked: value === true,
					onChange: (e) => setField(spec.key, e.target.checked)
				}), (0, react.createElement)("span", { className: "ldw-set-field-label" }, spec.label), spec.hint !== void 0 ? (0, react.createElement)("span", { className: "ldw-set-hint" }, spec.hint) : null);
				return (0, react.createElement)("label", {
					key: spec.key,
					className: "ldw-set-field"
				}, (0, react.createElement)("span", { className: "ldw-set-field-label" }, spec.label), (0, react.createElement)("input", {
					type: "number",
					className: "ldw-set-num",
					value: scale === 1e3 ? Math.round(Number(value) / scale) : Number(value),
					min: limit === void 0 ? void 0 : Math.round(limit.min / scale),
					max: limit === void 0 ? void 0 : Math.round(limit.max / scale),
					step: 1,
					onChange: (e) => {
						const n = Number(e.target.value);
						if (!Number.isFinite(n)) return;
						setField(spec.key, Math.round(n * scale));
					}
				}), (0, react.createElement)("span", { className: "ldw-set-unit" }, unit), limit !== void 0 ? (0, react.createElement)("span", { className: "ldw-set-hint" }, `${Math.round(limit.min / scale)}~${Math.round(limit.max / scale)}${unit}${spec.hint !== void 0 ? ` · ${spec.hint}` : ""}`) : spec.hint !== void 0 ? (0, react.createElement)("span", { className: "ldw-set-hint" }, spec.hint) : null);
			};
			/** 配置表单（三个分组）。 */
			const configForm = form === null ? (0, react.createElement)("p", { className: "ldw-set-note" }, "正在读取配置…") : (0, react.createElement)("div", { className: "ldw-set-config" }, ...FIELD_GROUPS.map((group) => (0, react.createElement)("div", {
				key: group.title,
				className: "ldw-set-group"
			}, (0, react.createElement)("h4", { className: "ldw-set-group-title" }, group.title), (0, react.createElement)("p", { className: "ldw-set-hint" }, group.note), ...group.fields.map(renderField))), (0, react.createElement)("div", { className: "ldw-set-actions" }, (0, react.createElement)("button", {
				type: "button",
				className: "ldw-set-btn ldw-set-btn-primary",
				disabled: busy,
				onClick: () => void saveConfig()
			}, busy ? "处理中…" : "保存配置"), (0, react.createElement)("button", {
				type: "button",
				className: "ldw-set-btn",
				disabled: busy,
				onClick: () => void resetConfig()
			}, "恢复默认")), problems.length > 0 ? (0, react.createElement)("div", { className: "ldw-set-err" }, (0, react.createElement)("strong", null, `${problems.length} 项被修正`), ...problems.map((p, i) => (0, react.createElement)("div", { key: i }, `${p.field}：${p.reason}`))) : null);
			return (0, react.createElement)(
				"div",
				{ className: "ldw-set" },
				(0, react.createElement)("h2", { className: "ldw-set-title" }, "LDW · 网页版接入"),
				(0, react.createElement)("p", { className: "ldw-set-note" }, "用真实浏览器驱动 AI 网页版。切到「LDW」标签可打开浏览器窗口并登录。"),
				(0, react.createElement)("h3", { className: "ldw-set-sub" }, `平台（${state.providers.length}）`),
				cards.length > 0 ? (0, react.createElement)("div", { className: "ldw-set-grid" }, cards) : (0, react.createElement)("p", null, "（无）"),
				state.errors.length > 0 ? (0, react.createElement)("div", { className: "ldw-set-err" }, (0, react.createElement)("strong", null, `${state.errors.length} 个 provider 文件读不了`), ...state.errors.map((e, i) => (0, react.createElement)("div", { key: i }, `${e.file}：${e.reason}`))) : null,
				/**
				* ---- 配置 ----
				*
				* 折叠起来：默认不展开，避免设置页一上来就是十几个数字吓人。
				*/
				(0, react.createElement)("details", { className: "ldw-set-details" }, (0, react.createElement)("summary", { className: "ldw-set-sub" }, "插件配置"), configForm),
				/** ---- 添加自定义平台（默认折叠）---- */
				(0, react.createElement)("details", {
					className: "ldw-set-details",
					open: showAdd
				}, (0, react.createElement)("summary", {
					className: "ldw-set-sub",
					onClick: () => setShowAdd((v) => !v)
				}, "添加自定义平台"), (0, react.createElement)("p", { className: "ldw-set-note" }, "粘贴一个 Provider JSON（字段见 README）。同 id 会覆盖内置项，删掉即可回退。"), (0, react.createElement)("textarea", {
					className: "ldw-set-input",
					rows: 8,
					placeholder: "{\n  \"id\": \"my-platform\",\n  \"name\": \"我的平台\",\n  \"homeUrl\": \"https://example.com/\",\n  ...\n}",
					value: draft,
					onChange: (e) => setDraft(e.target.value)
				}), (0, react.createElement)("div", { className: "ldw-set-actions" }, (0, react.createElement)("button", {
					type: "button",
					className: "ldw-set-btn ldw-set-btn-primary",
					disabled: busy || draft.trim() === "",
					onClick: () => void submit()
				}, busy ? "处理中…" : "保存"), (0, react.createElement)("button", {
					type: "button",
					className: "ldw-set-btn",
					disabled: busy,
					onClick: () => void refresh()
				}, "刷新"))),
				note !== "" ? (0, react.createElement)("p", { className: "ldw-set-note" }, note) : null
			);
		}
		/** 设置页里的一行「标签 : 值」。 */
		function row(label, value) {
			return (0, react.createElement)("div", {
				className: "ldw-set-row",
				key: label
			}, (0, react.createElement)("span", { className: "ldw-set-label" }, label), (0, react.createElement)("span", { className: "ldw-set-value" }, value));
		}
		function LdwPlaceholder() {
			const ref = (0, react.useRef)(null);
			(0, react.useEffect)(() => {
				const el = ref.current;
				if (el === null) return;
				/**
				* 量矩形。用 rAF 节流 —— 布局变化（侧栏折叠、窗口缩放、标签切换）都会触发。
				* 注意：占位符消失时 `getBoundingClientRect()` 仍可能返回旧值，
				* 所以卸载路径显式 `publishRect(null)`。
				*/
				let frame = 0;
				const measure = () => {
					frame = 0;
					const node = ref.current;
					if (node === null) return;
					const r = node.getBoundingClientRect();
					publishRect({
						left: r.left,
						top: r.top,
						width: r.width,
						height: r.height,
						visible: r.width > 0 && r.height > 0
					});
				};
				const schedule = () => {
					if (frame !== 0) return;
					frame = window.requestAnimationFrame(measure);
				};
				measure();
				window.addEventListener("resize", schedule);
				const observer = new ResizeObserver(schedule);
				observer.observe(el);
				return () => {
					if (frame !== 0) window.cancelAnimationFrame(frame);
					window.removeEventListener("resize", schedule);
					observer.disconnect();
					publishRect(null);
				};
			}, []);
			return (0, react.createElement)("div", {
				className: "webin-placeholder",
				ref
			});
		}
		function apply(ctx) {
			/**
			* 启动时拉一次配置。
			*
			* 发送循环（`LdwHost` 里的 `setInterval`）读的是模块级 `configRef`，
			* 所以必须在它跑起来之前填好 —— 否则第一轮会用默认值。
			*/
			ctx.effect(() => {
				refreshConfig().then((cfg) => {
					console.log("[dsh-webin] 配置已加载", describeConfig(cfg));
				});
			}, "dsh-webin: config");
			ctx.effect(() => {
				const style = document.createElement("style");
				style.textContent = CSS;
				document.head.appendChild(style);
				return () => style.remove();
			}, "dsh-webin: stylesheet");
			ctx.effect(() => ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "ldw-host",
				order: 20
			}, LdwHost)), "dsh-webin: persistent host");
			ctx.effect(() => ctx.slots.inject("conversation.view", () => ctx.slots.register({
				name: "conversation.view",
				id: "ldw",
				order: 20,
				label: () => "LDW"
			}, LdwPlaceholder)), "dsh-webin: conversation view");
			/**
			* ---- 设置页：settings.section ----
			*
			* ⚠️ 两个必须遵守的契约（踩过就不报错，只是白屏 / 少一项）：
			*   1. `register` 的 options 里**必须带 `name`**（slot 名）
			*   2. 组件**必须返回 React 元素** —— 这里用箭头函数包一层
			*      `createElement(LdwSettings)`，直接传 `LdwSettings` 也行，
			*      但包一层能保证「注册的是元素而不是函数引用」这个语义明确
			*
			* `order: 47` —— 排在 `deepseek-web-login`(46) 之后，两者互不干扰。
			*/
			ctx.effect(() => ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "ldw",
				order: 47,
				label: () => "LDW 网页版"
			}, () => (0, react.createElement)(LdwSettings))), "dsh-webin: settings page");
		}
		//#endregion
		exports.LdwHost = LdwHost;
		exports.LdwPlaceholder = LdwPlaceholder;
		exports.LdwSettings = LdwSettings;
		exports.apply = apply;
		exports.applyCustomProviders = applyCustomProviders;
		exports.canSendThisTurn = canSendThisTurn;
		exports.currentConfig = currentConfig;
		exports.inject = inject;
		exports.noteRequestDone = noteRequestDone;
		exports.noteTurnRequest = noteTurnRequest;
		exports.noteTurnStart = noteTurnStart;
		exports.refreshConfig = refreshConfig;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map