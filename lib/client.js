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
		* ⚠️ 已删除 `REQUEST_COUNT_KEY` 导出。
		*
		* 它原本是「自证发送成功」时代的产物：客户端读
		* `window.__dshWebinHookInstalled___requests` 来确认「页面真的发出了
		* completion 请求」。改成三段式发送后**不再自证**（cuckoo 也不自证 ——
		* 点完发送就算发了，成功与否交给后续的 DOM 轮询确认）。
		*
		* hook 内部仍然写这个计数（`${MARKER}_requests`），因为诊断脚本会直接
		* 按字符串读它 —— 那是有用的排查信息，只是不再需要一个导出常量。
		*/
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
   * 记下**所有** POST 请求的路径（最近 20 条）。
   *
   * ## 为什么需要这个（用户实测踩过的坑）
   *
   * 用户症状：状态栏「已发送 · 收到 0 条」，网页版那边回复明明完成了，
   * DSH 一直等到超时 —— 最难查的一类故障。
   *
   * 排查时最想知道的是：**页面到底往哪个路径发的请求？**
   * 如果 DeepSeek 改了端点（比如加版本前缀），「samePath」 的**精确比较**
   * 会静默失配 —— 既不报错也抓不到回复。
   *
   * 所以把所有 POST 路径记下来，诊断面板直接展示：
   * 下次端点变了，一眼就能看出「真实路径 vs 我们期望的路径」。
   */
  function notePostPath(url) {
    try {
      var p;
      try { p = new URL(String(url), location.href).pathname; }
      catch (e) { p = String(url); }
      var list = window.${MARKER}_postPaths;
      if (!Array.isArray(list)) { list = []; window.${MARKER}_postPaths = list; }
      var matched = samePath(url, COMPLETION);
      /** 去重：同一路径只留一条，但保留「曾匹配过」与调用次数。 */
      for (var i = 0; i < list.length; i++) {
        if (list[i].path === p) {
          list[i].at = Date.now();
          list[i].count = (list[i].count || 1) + 1;
          if (matched) list[i].matched = true;
          return;
        }
      }
      list.push({ path: p, at: Date.now(), matched: matched, count: 1 });
      if (list.length > 20) list.splice(0, list.length - 20);
    } catch (e) { /* ignore */ }
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

    /**
     * ## fragment 索引 → 类型 的映射（**修复思考丢失 / 围栏丢失的关键**）
     *
     * ## 实测现象（用户报的两个症状，同一根因）
     *
     * 1. 网页版显示了思考（「已思考（用时 1 秒）」），但 DSH 只收到 **2 个字符**
     *    （就是「用户」两个字）。
     * 2. 工具调用的围栏**开头的三个反引号丢了**：
     *    实际收到的是「ldw + 换行 + const r = await pwsh(...)」开头，
     *    于是解析器找不到 ldw 围栏，整段被当正文显示在对话区。
     *
     * ## 根因
     *
     * 网页版的 response.fragments 是**数组**，每个 fragment 有 type
     * （THINK / RESPONSE）。SSE 里只有**首帧**带完整路径
     * （response/fragments/-1/content），后续全是**裸增量帧**（没有 p）。
     *
     * 裸增量归给谁，只能靠「最近一次路径帧指向哪个 fragment」。
     * 早期实现**没跟踪这个** —— 裸增量一律 text += v，于是：
     *   - 思考的裸增量全被当正文 ⇒ think 只剩路径帧那一小段
     *   - 正文的裸增量接在 ldw 后面 ⇒ 围栏看起来「丢了」
     *
     * ## 修法
     *
     * 维护 fragmentTypes[i]（类型表）与 currentIndex（当前指向）：
     *   - 路径帧 response/fragments/&lt;i&gt;/&lt;field&gt; ⇒ 更新类型表并切 currentIndex
     *   - -1 表示「最后一个 fragment」，解析成实际下标
     *   - 裸增量按 fragmentTypes[currentIndex] 分流到 think / text
     *
     * 这样即使网页端只发一次路径帧，后续裸增量也能正确归位。
     *
     * ⚠️ 本注释在模板字符串内，**不能出现反引号**（会让构建报 PARSE_ERROR）。
     */
    var fragmentTypes = [];
    var currentIndex = -1;

    function lastSeg(p) { return typeof p === 'string' ? p.split('/').pop() : ''; }

    /**
     * 从路径里解析 fragment 下标。
     *
     * response/fragments/0/content  ⇒ 0
     * response/fragments/-1/content ⇒ 最后一个（= fragmentTypes.length - 1）
     *
     * ## ⚠️ 「-1」 的语义（这里是第一个坑）
     *
     * 「-1」 意思是「最后一个 fragment」。但**首帧就是 「-1」** 时，
     * 类型表还是空的 —— 早期实现返回 null，于是类型表**从未登记**，
     * 后续裸增量全部走错分支（这正是思考只有 2 个字的根因）。
     *
     * 正确做法：「-1」 且表为空 ⇒ **分配下标 0**（第一个 fragment）。
     *
     * @returns 下标；不是 fragment 路径时返回 null。
     */
    function fragmentIndexOf(p) {
      if (typeof p !== 'string') return null;
      var m = /^response\/fragments\/(-?\d+)\//.exec(p);
      if (m === null) return null;
      var i = Number(m[1]);
      if (i < 0) {
        /** -1 = 最后一个。表为空时视为「第 0 个」（首帧就是 -1 的情况）。 */
        return fragmentTypes.length > 0 ? fragmentTypes.length - 1 : 0;
      }
      return i;
    }

    /** 路径里的字段名是不是「思考」字段。 */
    function isThinkField(p) {
      var seg = lastSeg(p);
      return seg === 'reasoning_content' || seg === 'thinking_content';
    }

    /** 路径里的字段名是不是「正文」字段。 */
    function isTextField(p) {
      var seg = lastSeg(p);
      return seg === 'content' || seg === 'text' || seg === 'markdown' || seg === 'delta';
    }

    /** JSON Patch 路径 → 判断是不是正文/思考文本。 */
    function classify(p) {
      var seg = lastSeg(p);
      var inResponse = typeof p === 'string' && (p === 'response' || p.indexOf('response/') === 0);
      if (seg === 'reasoning_content' || seg === 'thinking_content') return 'think';
      if (!inResponse) return null;
      if (seg === 'content' || seg === 'text' || seg === 'markdown' || seg === 'delta') return 'text';
      return null;
    }

    /** 当前 fragment 是不是思考。 */
    function currentIsThink() {
      if (currentIndex < 0 || currentIndex >= fragmentTypes.length) return false;
      return String(fragmentTypes[currentIndex]).toUpperCase() === 'THINK';
    }

    /** 把一段文本按当前 fragment 类型分流。 */
    function route(piece, forceKind) {
      if (!piece) return;
      var kind = forceKind !== undefined && forceKind !== null ? forceKind : (currentIsThink() ? 'think' : 'text');
      if (kind === 'think') think += piece;
      else text += piece;
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
          /**
           * ⚠️ **先登记类型再分流** —— 每个新 fragment 都要进类型表，
           * 这样后续裸增量才知道自己该去哪（见 fragmentTypes 的说明）。
           */
          var idx = fragmentTypes.length;
          fragmentTypes.push(typeof f.type === 'string' ? f.type : 'RESPONSE');
          currentIndex = idx;
          if (!piece) continue;
          route(piece, String(f.type).toUpperCase() === 'THINK' ? 'think' : 'text');
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
            /**
             * 快照是权威全量：**重建类型表**（而不是叠加）。
             * 否则重复快照会让类型表越堆越长，-1 会解析到错误下标。
             */
            fragmentTypes[j] = typeof g.type === 'string' ? g.type : 'RESPONSE';
            if (!s) continue;
            if (String(g.type).toUpperCase() === 'THINK') k += s;
            else t += s;
          }
          fragmentTypes.length = frags.length;
          currentIndex = frags.length - 1;
          if (t) text = t;
          if (k) think = k;
        }
        return;
      }

      /**
       * fragment 路径帧：response/fragments/&lt;i&gt;/&lt;field&gt;
       *
       * ⚠️ **这是修复思考丢失 / 围栏丢失的关键分支。**
       *
       * 网页端只在 fragment 开始时发一次带路径的帧，后续全是裸增量。
       * 这里记下「当前指向哪个 fragment」以及「它是什么类型」，
       * 裸增量才能正确分流到 think / text。
       *
       * 实测：-1 指「最后一个 fragment」。思考阶段它指向 THINK，
       * 正文阶段指向 RESPONSE —— 所以**必须在切换时更新类型**。
       */
      var fragIdx = fragmentIndexOf(obj.p);
      if (fragIdx !== null && typeof obj.v === 'string') {
        currentIndex = fragIdx;
        /**
         * 该字段决定这个 fragment 是什么类型：
         * reasoning_content ⇒ THINK；content / text ⇒ RESPONSE。
         * 以字段为准（比 type 字段可靠 —— 路径帧不带 type）。
         */
        if (isThinkField(obj.p)) fragmentTypes[fragIdx] = 'THINK';
        else if (isTextField(obj.p)) fragmentTypes[fragIdx] = 'RESPONSE';
        var kindFrag = isThinkField(obj.p) ? 'think' : isTextField(obj.p) ? 'text' : null;
        if (kindFrag === 'think') think += obj.v;
        else if (kindFrag === 'text') {
          if (obj.o === 'APPEND' || obj.o === undefined) text += obj.v;
          else text = obj.v;
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
       * **裸文本增量**（正文/思考的主体）—— 见 isBareTextDelta 的说明。
       *
       * ⚠️ **不能一律当正文**：按当前 fragment 类型分流。
       * 早期实现写死 text += obj.v，导致两个症状（实测复现）：
       *   1. 思考的裸增量全进正文 ⇒ think 只剩路径帧那 2 个字
       *   2. 正文的裸增量接在 ldw 后面 ⇒ 工具围栏开头的三反引号看起来丢了
       */
      if (isBareTextDelta(obj)) {
        route(obj.v);
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
        if (String(method).toUpperCase() === 'POST') {
          /** 记下路径（诊断用，见 notePostPath）。 */
          notePostPath(url);
        }
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
      var isPost = meta && String(meta.method).toUpperCase() === 'POST';
      /** 记下路径（诊断用）。 */
      if (isPost) notePostPath(meta.url);
      var isTarget = isPost && samePath(meta.url, COMPLETION);
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
		* ## 从页面 DOM 读回复（**主路径**）
		*
		* 用户的要求：「我想要的插件很简单，就是把网页版的内容，回显到 dsh 的对话窗口中」。
		*
		* ## 为什么它是主路径（读 cuckoo 之后的设计修正）
		*
		* 原来我把「抓 SSE」当主路径，DOM 只当 20 秒后的兜底。那条路有个
		* **解决不了的时序问题**：
		*
		*   cuckoo 能在页面脚本执行**之前**注入 hook，靠的是 **preload**
		*   （`src/bridge/entry.ts:52-68`，注释写着「必须在页面脚本执行前…
		*   才能覆盖到 window.fetch / XHR」）。
		*
		*   而 DSH 的 webview 门禁（`lib/main.js:9690`）把 preferences
		*   **清空后只设固定几项**，`preload` 不在里面。所以我只能等
		*   `dom-ready` —— 那时**页面脚本早已跑完、请求早已发出**。
		*   这就是「收到 0 条」的根源，靠加事件监听治不好（时序已经错了）。
		*
		* ## DOM 抓取没有这个问题
		*
		* 内容渲染在页面上，**什么时候读都读得到**，不依赖注入时机。
		* cuckoo 自己也把 DOM 抓取当默认模式（`src/providers/types.ts:72`：
		* 「是否使用网络拦截模式（默认 false = DOM 抓取）」）。
		*
		* ## 返回结构化内容（不只是纯文本）
		*
		* 网页版的回复里，**工具调用是代码块**（`<pre><code>`）。只取 textContent
		* 会丢掉代码块边界（三反引号）—— 那正是用户报过的「工具调用泄漏成正文」。
		*
		* 所以这里**按 DOM 结构还原 markdown**：
		*   - `<pre><code>` ⇒ 围栏代码块（含语言标记）
		*   - 段落 / 列表 / 标题 ⇒ 保留换行结构
		*   - 行内 `<code>` ⇒ 单反引号
		*   - 按钮 / 输入框 / 图标 ⇒ 剔除（界面不是回复）
		*
		* 这样 DSH 侧解析围栏的代码**不用改**，直接就能认出工具调用。
		*/
		function buildScrapeScript() {
			return `(function () {
  try {
    /**
     * 回复容器候选（从最精确到最宽泛）。
     *
     * ## ⭐ 前面的来自**真实页面的类名**（不是猜的）
     *
     * 从用户会话记录里提取出 DeepSeek 网页版的 「ds-*」 类名体系：
     *   - 「ds-markdown」       —— 回复正文容器（**最精确的命中**）
     *   - 「ds-pow-response」   —— 回复包装
     *   - 「ds-think-content」  —— 思考内容（由 readThink 单独处理）
     *
     * 后面几个是**语义/结构兜底** —— 页面改版换掉类名时还能用。
     * ⚠️ 但要小心：「[class*="markdown"]」 会命中 「ds-markdown-code-copy-button」
     * 这类子元素，所以精确类名必须排在前面（顺序即优先级）。
     */
    var CANDIDATES = [
      '.ds-markdown',
      '[data-message-author-role="assistant"]',
      '[data-role="assistant"]',
      '.ds-pow-response',
      '[class*="assistant"]',
      '[class*="markdown"]'
    ];

    /** 反引号用 charCode 拼，避免模板字符串里出现裸反引号。 */
    var BT = String.fromCharCode(96);
    var FENCE = BT + BT + BT;

    function visible(el) {
      if (!el) return false;
      try {
        if (el.offsetWidth <= 0 || el.offsetHeight <= 0) return false;
        var s = getComputedStyle(el);
        return s.visibility !== 'hidden' && s.display !== 'none';
      } catch (e) { return false; }
    }

    /**
     * 元素是否**存在且不是明确隐藏**（比 visible 宽）。
     *
     * ## ⚠️ 挑回复容器要用这个，不能用 visible
     *
     * 真实页面上「高度为 0 但内容在」的情况非常多：
     *   - 代码块收起时 pre 的高度是 0（用户截图里那个展开按钮）
     *   - 思考区收起时容器高度是 0
     *   - **正在生成的回复骨架高度可能还是 0**（节点刚插入、还没撑开）
     *
     * 用 visible 过滤候选容器的话，最后一种会让「条数」永远不增长
     * ⇒ 判定「本轮回复还没来」⇒ 卡住。
     * 用户报的「网页版早就有答案了，DSH 还在等」很可能就是这个。
     *
     * 这里只排除**明确不在页面上**的：display:none / visibility:hidden /
     * aria-hidden=true。高度为 0 一律算存在。
     */
    function present(el) {
      if (!el) return false;
      try {
        var s = getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden') return false;
        if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return false;
        return true;
      } catch (e) { return true; }
    }

    /** 该节点是「界面元素」而不是「回复内容」吗。 */
    function isChrome(el) {
      var tag = el.tagName;
      if (tag === 'BUTTON' || tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SVG' ||
          tag === 'PATH' || tag === 'SELECT' || tag === 'OPTION') return true;
      try {
        if (el.getAttribute('role') === 'button') return true;
        if (el.getAttribute('contenteditable') === 'true') return true;
        if (el.getAttribute('aria-hidden') === 'true') return true;
      } catch (e) {}
      return false;
    }

    /**
     * 该节点是**思考容器**吗。
     *
     * ## ⚠️ 为什么必须在正文渲染里排除它（测试确认的真实 bug）
     *
     * 真实页面里 ds-think-content **嵌套在 ds-markdown 内部**
     * （思考是回复的一部分，只是折叠显示）。
     *
     * 那么递归渲染正文时会**连思考一起读进去** —— 后果是 DSH 的对话里
     * 思考变成了正文的一部分。而思考由 readThink() 单独提供，
     * 两者必须分开。
     *
     * 所以正文渲染遇到思考容器**直接跳过**（内容交给 readThink）。
     */
    function isThinkNode(el) {
      try {
        var c = String(el.className || '');
        if (c.indexOf('think-content') >= 0) return true;
        if (c.indexOf('thinking') >= 0) return true;
        if (c.indexOf('reasoning') >= 0) return true;
        if (el.getAttribute('data-thinking') !== null) return true;
        if (el.getAttribute('data-reasoning') !== null) return true;
      } catch (e) {}
      return false;
    }

    /** 递归渲染成 markdown，重点是**保留代码块围栏**（工具调用靠它）。 */
    function render(node, forThink) {
      if (!node) return '';
      if (node.nodeType === 3) return node.nodeValue || '';
      if (node.nodeType !== 1) return '';
      if (isChrome(node)) return '';
      /**
       * ⭐ 思考内容交给 readThink 单独读 —— 正文里必须排除。
       *
       * forThink 为真时**不跳过** —— 否则 readThink 渲染自己
       * 找到的思考容器时会得到空串（踩过：改完正文排除后思考读不到了）。
       */
      if (!forThink && isThinkNode(node)) return '';

      var tag = String(node.tagName || '').toLowerCase();
      if (tag === 'br') return '\\n';

      /** 代码块 —— 最关键的一支。 */
      if (tag === 'pre') {
        var codeEl = node.querySelector('code');
        var raw = ((codeEl || node).textContent || '').replace(/\\n+$/, '');
        var lang = '';
        try {
          var m = /language-([\\w+-]+)/.exec(codeEl ? String(codeEl.className || '') : '');
          if (m) lang = m[1];
        } catch (e) {}
        return '\\n\\n' + FENCE + lang + '\\n' + raw + '\\n' + FENCE + '\\n\\n';
      }
      if (tag === 'code') return BT + (node.textContent || '') + BT;

      var BLOCK = { p: 2, div: 1, li: 1, tr: 1, h1: 2, h2: 2, h3: 2, h4: 2, h5: 2, h6: 2,
        blockquote: 2, table: 2, ul: 1, ol: 1, hr: 2 };
      var isBlock = Object.prototype.hasOwnProperty.call(BLOCK, tag);

      var out = tag === 'li' ? '- ' : '';
      var kids = node.childNodes || [];
      for (var i = 0; i < kids.length; i++) out += render(kids[i], forThink);

      if (isBlock) {
        out = out.replace(/[ \\t]+$/, '');
        out += BLOCK[tag] >= 2 ? '\\n\\n' : '\\n';
      }
      return out;
    }

    function tidy(s) {
      return String(s || '').replace(/\\n{3,}/g, '\\n\\n').replace(/^[\\s\\n]+|[\\s\\n]+$/g, '');
    }

    /**
     * 读思考过程。
     *
     * ## 为什么单独处理
     *
     * 网页版的思考（「已思考（用时 N 秒）」）是**可折叠**区域，
     * 默认收起。用户明确要求过要看到思考，所以：
     *   - 先找思考容器（按文字特征 + 结构特征）
     *   - 收起状态下 textContent 仍能读到（DOM 里内容在，只是被 CSS 隐藏）
     *     所以**不受折叠影响** —— 这正是 DOM 抓取比 SSE 省事的地方
     *
     * ⚠️ 找不到就返回空串，**不能让整条回复失败**。
     */
    function readThink() {
      /**
       * 思考容器的候选选择器。
       *
       * ## ⭐ 前两个来自**真实页面的类名**（不是猜的）
       *
       * 从用户会话记录里提取出 DeepSeek 网页版的 「ds-*」 类名体系，其中：
       *   - 「ds-think-content」  —— 思考内容容器（精确命中）
       *   - 「ds-markdown」       —— 回复正文容器
       *   - 「ds-pow-response」   —— 回复包装
       *   - 「ds-markdown-code-copy-button」 —— 代码块上的复制按钮（界面元素，要剔除）
       *
       * 所以优先用 「ds-think-content」（精确），后面几个是页面改版时的兜底。
       */
      var SEL = [
        '.ds-think-content',
        '[class*="think-content"]',
        '[class*="thinking"]',
        '[class*="reasoning"]',
        '[class*="think"]',
        '[data-thinking]',
        '[data-reasoning]'
      ];
      var found = null;
      for (var i = 0; i < SEL.length && !found; i++) {
        var list;
        try { list = document.querySelectorAll(SEL[i]); } catch (e) { continue; }
        /** 取**最后一个**（最新一轮的思考）。可见性不作硬要求 —— */
        /** 折叠时容器可能高度为 0，但内容仍在 DOM 里。 */
        for (var j = list.length - 1; j >= 0; j--) {
          found = list[j];
          break;
        }
      }
      if (!found) return '';
      var t = tidy(render(found, true));
      /**
       * 去掉「已思考（用时 N 秒）」这类标题行 —— 它是界面文字，
       * 不是思考内容本身。
       */
      t = t.replace(/^已?思考[（(]?[^\\n]{0,20}[)）]?\\s*/i, '');
      t = t.replace(/^思考过程\\s*/i, '');
      return tidy(t);
    }

    /**
     * ## ⭐⭐ 排除「非回复区」—— 端到端实测抓到的真 bug
     *
     * ## 现场（「node scripts/e2e-echo.mjs」 的真实输出）
     *
     * 问「1+1=?只回答数字」，抓回来 1256 字符，内容是：
     *
     *     开启新对话
     *     置顶
     *     低光增强Prompt模块设计与实现
     *     REN模块去雨Prompt模块架构设计
     *     今天
     *     1加1等于2
     *     在不在
     *     技能调用确认
     *     昨天
     *
     * —— 这是**侧边栏的会话列表**，不是回复正文！
     *
     * ## 为什么会这样
     *
     * 候选全都没命中时走 「longest-div」 兜底：取**全页最长的 div 文本**。
     * 而侧边栏把**所有历史会话标题**堆在一起，文本长度很容易超过
     * 一条回复 ⇒ 兜底抓走了侧边栏。
     *
     * 后果正是用户报的「网页版早就输出完了，DSH 就是不输出」——
     * 抓到的内容和回复无关，所以「内容变了吗」的判据要么一直不变
     * （卡住），要么一变就交了一堆垃圾。
     *
     * ## 判据
     *
     * 侧边栏/导航区有稳定的语义标记，**按语义排除**而不是按位置猜：
     *   - 「<aside>」 / 「<nav>」 标签（语义化布局）
     *   - 「role="navigation"」 / 「role="complementary"」
     *   - class/id 里含 sidebar / sider / nav / menu / drawer / history
     *
     * ⚠️ 只排除**祖先**是这些区域的元素 —— 不能因为元素自身 class 里
     * 有个 "nav" 就排除（回复正文里可能有 「nav」 这个词的类名）。
     */
    function inChrome(el) {
      if (!el) return false;
      var node = el;
      /** 往上找 8 层 —— 再深就不可能是侧边栏了。 */
      for (var d = 0; d < 8 && node; d++) {
        var tag = String(node.tagName || '').toLowerCase();
        if (tag === 'aside' || tag === 'nav') return true;
        var role = node.getAttribute ? String(node.getAttribute('role') || '') : '';
        if (role === 'navigation' || role === 'complementary' || role === 'banner') return true;
        var cls = '';
        try { cls = String(node.className || ''); } catch (e) { cls = ''; }
        var id = node.getAttribute ? String(node.getAttribute('id') || '') : '';
        var mark = (cls + ' ' + id).toLowerCase();
        /**
         * ⚠️ 用**词边界**匹配，避免误伤 —— 例如正文里可能有
         * 「ds-markdown」 这种含 "mark" 的类名（不在列表里，但同理）。
         */
        if (/(^|[^a-z])(sidebar|sider|drawer|side-nav|sidenav|nav-list|navlist|menu-list|history-list|conversation-list|session-list)([^a-z]|$)/.test(mark)) {
          return true;
        }
        node = node.parentElement;
      }
      return false;
    }

    /**
     * ## ⭐ 主内容区（优先在它里面找回复）
     *
     * 排除法（「inChrome」）能挡住侧边栏，但如果页面结构变了、
     * 侧边栏换了标记，还是会漏。
     *
     * 所以再加一层**正向**判据：先找 「<main>」（或 「role="main"」），
     * 在它**里面**找回复 —— 侧边栏天然不在 main 里。
     *
     * 找不到 main 就退回 「document.body」（那时只能靠 inChrome 排除）。
     */
    function mainRoot() {
      try {
        var m = document.querySelector('main, [role="main"]');
        if (m) return m;
      } catch (e) { /* 忽略 */ }
      /**
       * ⚠️ body 可能为 null，而且**必须确认它有 querySelectorAll** ——
       * 直接返回它会让调用方抛
       * "root.querySelectorAll is not a function"（实测踩过）。
       */
      var b = document.body;
      if (b && typeof b.querySelectorAll === 'function') return b;
      return document;
    }

    /**
     * ## ⭐⭐⭐ 抓取前把消息列表滚到底（虚拟列表适配）
     *
     * ## 根因（vlist 诊断给出的决定性证据）
     *
     *     ds-virtual-list-items          h=1680  ← 消息总高度（有内容）
     *     ds-virtual-list-visible-items  kids=0 h=0  ← 但可见区是空的
     *
     * DeepSeek 用**虚拟滚动**：只把「视口内」的消息插进 DOM。
     * 新回复在列表**底部**，视口若停在别处，最新回复就**不在 DOM 里**
     * —— 这就是「网页版早就有答案了，DSH 抓不到」的最终根因。
     *
     * 修法：抓取前把虚拟列表的滚动容器滚到底，强制渲染最新消息。
     * 改滚动位置**不改页面内容**，无副作用（用户看回复本来就在底部）。
     */
    try {
      var scrollers = document.querySelectorAll('[class*="ds-virtual-list"]');
      for (var sv = 0; sv < scrollers.length; sv++) {
        var svEl = scrollers[sv];
        /** 滚动容器是它的父级（ds-scroll-area），或它自己。 */
        var target = svEl.parentElement && String(svEl.parentElement.className || '').indexOf('ds-scroll-area') !== -1
          ? svEl.parentElement
          : svEl;
        if (target.scrollHeight > target.clientHeight) {
          target.scrollTop = target.scrollHeight;
        }
      }
    } catch (e) { /* 滚动失败不影响抓取 */ }

    var list = [];
    var usedSelector = '';
    var root = mainRoot();
    /**
     * ## ⭐ 决策轨迹 —— 每个候选为什么被选中/跳过
     *
     * ## 为什么加（用户：「不要猜」）
     *
     * 抓到侧边栏时，我**看不到**内部判断过程：是 「.ds-markdown」 没匹配上？
     * 还是匹配上了但被 present/inChrome 过滤？还是长度不够？
     *
     * 有了轨迹，一次调用就能看出卡在哪 —— 不用改代码、重启、再看。
     */
    var trace = [];
    for (var c = 0; c < CANDIDATES.length; c++) {
      var found;
      /**
       * ⚠️ 在**主内容区**里查，而不是全文档 —— 这一条就能挡掉侧边栏。
       * 万一 main 里没有（有些布局不用 main），再用全文档兜一次。
       */
      try { found = root.querySelectorAll(CANDIDATES[c]); } catch (e) { continue; }
      if (found.length === 0 && root !== document.body) {
        try { found = document.querySelectorAll(CANDIDATES[c]); } catch (e) { continue; }
      }
      /** 记录：命中几个节点。 */
      var skipped = { present: 0, chrome: 0, short: 0 };
      /**
       * ⭐ 这个候选是不是**精确类名**（.ds-markdown 这类）。
       *
       * ## ⚠️⚠️ 精确候选**不能**做长度过滤（这是「一直等」的真正根因）
       *
       * ## 现场（端到端探针的原始输出）
       *
       *     root=MAIN  cand=1  present=true  inChrome=false
       *     len=1  txt=5          ← 回复正文就是「5」
       *     ...但 count=0         ← 被长度过滤拒了
       *
       * 用户问「1+1=?只回答数字」，DeepSeek 答「2」—— **一个字符**。
       * 而这里原来要求 「t.length >= 8」，于是：
       *
       *   1. 精确候选 「.ds-markdown」 命中，但内容太短 ⇒ **被丢弃**
       *   2. 「picked」 为空 ⇒ 换下一个候选
       *   3. 所有候选都被拒 ⇒ 「list」 为空
       *   4. 落到 「longest-div」 兜底 ⇒ 抓走**侧边栏的会话列表**
       *      （长、稳定、永远不变）
       *   5. 「内容变了吗」的判据永远不成立 ⇒
       *      **DSH 一直等，而网页版早就答完了**
       *
       * 这正是用户反复报的那句话：
       *   「网页版早就输出完了，dsh 窗口还是深度求索中」
       *
       * ## 修法：精确候选不做长度过滤
       *
       * 「.ds-markdown」 是**真实页面的类名**（从用户会话记录里提取的），
       * 它命中就是回复正文 —— 内容再短也是回复。
       * 长度过滤只对**模糊候选**（「[class*="markdown"]」 这种）保留，
       * 因为那些可能命中按钮/标签之类的小元素。
       */
      var precise = CANDIDATES[c].charAt(0) === '.' && CANDIDATES[c].indexOf('*') === -1;
      var picked = [];
      for (var i = 0; i < found.length; i++) {
        /**
         * 用 present 而不是 visible —— 正在生成的回复骨架高度可能是 0，
         * 但它确实是本轮的新回复。见 present 的说明。
         */
        if (!present(found[i])) { skipped.present++; continue; }
        /** ⭐ 排除侧边栏/导航区（端到端实测抓到的 bug）。 */
        if (inChrome(found[i])) { skipped.chrome++; continue; }
        var t = tidy(render(found[i]));
        /**
         * ⚠️ 精确候选：**只要非空就收**（回复可能只有一个字）。
         * 模糊候选：仍然要求 >= 8，避免收进按钮文字之类的碎片。
         */
        if (precise ? t.length > 0 : t.length >= 8) picked.push(t);
        else skipped.short++;
      }
      trace.push({
        sel: CANDIDATES[c],
        found: found.length,
        picked: picked.length,
        precise: precise,
        skipped: skipped.present + "/" + skipped.chrome + "/" + skipped.short
      });
      if (picked.length > 0) { list = picked; usedSelector = CANDIDATES[c]; break; }
    }

    /**
     * 最后手段：主内容区里最长的 div。
     *
     * ⚠️ 原来扫的是 「document.querySelectorAll('div')」（**全页**），
     * 于是侧边栏的会话列表经常胜出 —— 端到端实测就是这么抓到
     * 「开启新对话 / 置顶 / 昨天」的。现在**只在主内容区里扫**，
     * 并且仍然过一遍 inChrome。
     */
    if (list.length === 0) {
    var fallbackInfo = "";
      var all = root.querySelectorAll('div');
      var best = '';
      for (var k = 0; k < all.length; k++) {
        if (!present(all[k])) continue;
        if (inChrome(all[k])) continue;
        var txt = tidy(render(all[k]));
        if (txt.length > best.length) best = txt;
      }
      if (best.length >= 8) { list = [best]; usedSelector = 'longest-div'; }
      fallbackInfo = "divs=" + all.length + " bestLen=" + best.length;
    }

    return JSON.stringify({
      ok: list.length > 0,
      /** 全部候选；**最后一条**是最新一轮的回复。 */
      all: list,
      last: list.length > 0 ? list[list.length - 1] : '',
      /** 思考过程（读不到就是空串，不影响回复）。 */
      think: readThink(),
      selector: usedSelector,
      count: list.length,
      url: location.href,
      /** 诊断：主内容区是从哪找到的（排查抓错区时看这个）。 */
      root: root === document.body ? 'body' : String(root.tagName || '').toLowerCase()
,
      trace: trace,
      fallback: fallbackInfo
    });
  } catch (e) {
    return JSON.stringify({ ok: false, last: '', all: [], error: String(e && e.message) });
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
		//#region src/client/dom-report.ts
		/**
		* ## 导出页面真实结构 —— 用来**发现**类名，而不是猜
		*
		* ## 为什么需要（trace 给出的决定性证据）
		*
		* 端到端跑完读 trace，拿到：
		*
		*     .ds-markdown          → found: 0
		*     [class*="markdown"]   → found: 0     ← 极宽泛的匹配也是 0！
		*     [class*="assistant"]  → found: 0
		*     root: "body"                          ← 没有 main
		*     fallback: divs=865 bestLen=1234       ← 兜底抓了侧边栏
		*
		* 「[class*="markdown"]」 命中 **0** 说明：**页面上根本没有带
		* "markdown" 的类名** —— 我的候选表整个是错的（那些类名来自
		* 用户历史会话记录，当前页面结构已经变了）。
		*
		* 继续猜类名没有意义。**直接把页面结构导出来看。**
		*
		* ## 独立文件的原因
		*
		* 「hook.ts」 有 1392 行、大量模板字符串。之前用脚本往里插入代码时
		* **两次改坏文件**（一次删了 1019 行）。新功能放独立文件，
		* 主文件不动 —— 风险低得多。
		*
		* ## 导出什么（按「能不能帮我定位回复容器」排序）
		*
		*   1. **含目标文本的元素链** —— 传进刚发出的提示词，找到含它的
		*      最深元素，再往上列出祖先链 ⇒ 回复容器与消息列表容器都在这条链上
		*   2. **类名频次表** —— 哪些类名大量出现（回复容器通常如此）
		*   3. **顶层布局** —— body 的直接子元素（看清页面分区）
		*/
		/**
		* 生成「导出页面结构」的脚本源码。
		*
		* @param needle - 页面上**一定存在**的文字（通常是刚发出的提示词）。
		*   用它反查「消息在哪个容器里」是最可靠的定位法 ——
		*   比猜类名可靠得多，因为文字是我们自己放进去的。
		*/
		function buildDomReportScript(needle) {
			return `(function () {
  try {
    var NEEDLE = ${JSON.stringify(needle)};
    var all = document.querySelectorAll('*');

    /** 类名频次：找「大量重复出现」的类名（回复容器通常如此）。 */
    var freq = {};
    for (var i = 0; i < all.length; i++) {
      var cls = '';
      try { cls = String(all[i].className || ''); } catch (e) { cls = ''; }
      if (typeof cls !== 'string' || cls === '') continue;
      var parts = cls.split(/\\s+/);
      for (var p = 0; p < parts.length; p++) {
        if (parts[p] === '') continue;
        freq[parts[p]] = (freq[parts[p]] || 0) + 1;
      }
    }
    var top = [];
    for (var k in freq) if (freq[k] >= 2) top.push({ cls: k, n: freq[k] });
    top.sort(function (a, b) { return b.n - a.n; });

    /** 把元素描述成 tag#id.class[role=x] 的短串。 */
    function describe(el) {
      if (!el) return '';
      var tag = String(el.tagName || '').toLowerCase();
      var cls = '';
      try { cls = String(el.className || ''); } catch (e) { cls = ''; }
      var id = el.getAttribute ? String(el.getAttribute('id') || '') : '';
      var role = el.getAttribute ? String(el.getAttribute('role') || '') : '';
      var s = tag;
      if (id) s += '#' + id;
      if (typeof cls === 'string' && cls !== '') s += '.' + cls.split(/\\s+/).join('.');
      if (role) s += '[role=' + role + ']';
      return s.slice(0, 140);
    }

    /**
     * 含 NEEDLE 的**最深**元素 —— 那就是消息文字所在的节点。
     *
     * 判据：它自己含 NEEDLE，但**没有子元素**也含（再往下就切碎了）。
     */
    var hits = [];
    if (NEEDLE !== '') {
      for (var j = 0; j < all.length; j++) {
        var t = '';
        try { t = String(all[j].textContent || ''); } catch (e) { t = ''; }
        /** ⭐ textContent 没命中时再试 innerText（渲染树，实测有内容而 textContent 没有的情况）。 */
        if (t.indexOf(NEEDLE) === -1) {
          try { t = String(all[j].innerText || ''); } catch (e) { t = ''; }
          if (t.indexOf(NEEDLE) === -1) continue;
        }
        var kids = all[j].children || [];
        var deepest = true;
        for (var c = 0; c < kids.length; c++) {
          var kt = '';
          try { kt = String(kids[c].textContent || ''); } catch (e) { kt = ''; }
          if (kt.indexOf(NEEDLE) === -1) {
            try { kt = String(kids[c].innerText || ''); } catch (e) { kt = ''; }
          }
          if (kt.indexOf(NEEDLE) !== -1) { deepest = false; break; }
        }
        if (deepest) hits.push(all[j]);
      }
    }

    /** 祖先链（从最深往上 14 层）—— 回复容器与消息列表都在链上。 */
    var chain = [];
    var node = hits.length > 0 ? hits[0] : null;
    for (var d = 0; d < 14 && node; d++) {
      chain.push(describe(node));
      node = node.parentElement;
    }

    /** body 直接子元素（页面分区）。 */
    var layout = [];
    var bk = (document.body && document.body.children) || [];
    for (var b = 0; b < bk.length && b < 15; b++) layout.push(describe(bk[b]));

    /**
     * 各候选选择器**实际命中几个** —— 与 scrape 的 trace 对照，
     * 确认「是选择器错了还是页面真的没有」。
     */
    var cands = {};
    var CAND = [
      '.ds-markdown', '[class*="markdown"]', '[class*="assistant"]',
      '[class*="message"]', '[class*="chat"]', '[class*="response"]',
      '[class*="answer"]', '[class*="content"]', 'main', '[role="main"]',
      '[class*="ds-"]'
    ];
    for (var q = 0; q < CAND.length; q++) {
      try { cands[CAND[q]] = document.querySelectorAll(CAND[q]).length; }
      catch (e) { cands[CAND[q]] = -1; }
    }

    /**
     * ⭐ 把「有内容的容器」列出来 —— 按文本长度排序。
     *
     * ## 为什么需要（上一份报告的结论）
     *
     * 上一份报告显示 needle 命中 0、所有常见类名命中 0，但
     * 「[class*="ds-"]」 有 589 个。说明类名体系是 ds-*，但
     * **回复内容的容器类名不在我猜的那批里**。
     *
     * 所以直接问页面：**哪些元素有较长的文本？** 那些就是候选容器。
     * 比猜类名可靠得多。
     */
    var rich = [];
    for (var z = 0; z < all.length; z++) {
      var tx = '';
      try { tx = String(all[z].textContent || ''); } catch (e) { tx = ''; }
      if (tx.length < 20) continue;
      /** 只要「叶子级」的（子元素里没有更长的文本），避免全是 body。 */
      var kk = all[z].children || [];
      var hasRicher = false;
      for (var y = 0; y < kk.length; y++) {
        var kx = '';
        try { kx = String(kk[y].textContent || ''); } catch (e) { kx = ''; }
        if (kx.length >= tx.length * 0.9) { hasRicher = true; break; }
      }
      if (hasRicher) continue;
      rich.push({ el: describe(all[z]), len: tx.length, head: tx.slice(0, 50) });
    }
    rich.sort(function (a, b) { return b.len - a.len; });

    /** ⭐ 5 个 content 元素是什么（它们可能是消息容器）。 */
    var contentEls = [];
    try {
      var ce = document.querySelectorAll('[class*="content"]');
      for (var ci = 0; ci < ce.length; ci++) {
        var ct = '';
        try { ct = String(ce[ci].textContent || ''); } catch (e) { ct = ''; }
        contentEls.push({ el: describe(ce[ci]), len: ct.length, head: ct.slice(0, 60), kids: (ce[ci].children || []).length });
      }
    } catch (e) {}

    /** ⭐ 所有带 ds- 的容器类名（去重，按出现次数）—— 找到消息列表容器。 */
    var dsClasses = [];
    try {
      var seenDs = {};
      var allDs = document.querySelectorAll('[class*="ds-"]');
      for (var di = 0; di < allDs.length; di++) {
        var dc = '';
        try { dc = String(allDs[di].className || ''); } catch (e) { dc = ''; }
        if (typeof dc !== 'string') continue;
        var parts2 = dc.split(/\s+/);
        for (var pi = 0; pi < parts2.length; pi++) {
          if (parts2[pi].indexOf('ds-') !== 0) continue;
          seenDs[parts2[pi]] = (seenDs[parts2[pi]] || 0) + 1;
        }
      }
      for (var dk in seenDs) dsClasses.push({ cls: dk, n: seenDs[dk] });
      dsClasses.sort(function (a, b) { return b.n - a.n; });
    } catch (e) {}

    /**
     * ⭐⭐ DOM 树结构（从 #root 往下 7 层）—— 看清页面到底长什么样。
     *
     * ## 为什么需要
     *
     * 上一份报告：页面文本量只有 56 字符、needle 命中 0、
     * rich 里只有 script/style + 侧边栏 ⇒ **消息不在 DOM 里**。
     *
     * 但侧边栏有会话标题「加法结果」（= 我们发的提示词）⇒
     * 消息确实发出去了、会话也建了。那消息渲染到哪去了？
     *
     * 所以直接把树打出来看 —— 比继续猜快。
     */
    var tree = [];
    function walk(node, depth, path) {
      if (!node || depth > 7 || tree.length > 90) return;
      var kids = node.children || [];
      var tx = '';
      try { tx = String(node.textContent || ''); } catch (e) { tx = ''; }
      var desc = describe(node);
      /** 有 shadow root 的要标出来 —— textContent/querySelectorAll 都穿不过去。 */
      var sr = false;
      try { sr = node.shadowRoot !== undefined && node.shadowRoot !== null; } catch (e) {}
      tree.push({
        d: depth,
        el: desc.slice(0, 90),
        kids: kids.length,
        txt: tx.length,
        shadow: sr
      });
      for (var i2 = 0; i2 < kids.length && tree.length < 90; i2++) {
        walk(kids[i2], depth + 1, path);
      }
    }
    var rootEl = null;
    try { rootEl = document.getElementById('root'); } catch (e) {}
    walk(rootEl || document.body, 0, '');

    /** shadow DOM 宿主数量（消息可能在里面）。 */
    var shadowHosts = 0;
    try {
      for (var si = 0; si < all.length; si++) {
        if (all[si].shadowRoot) shadowHosts++;
      }
    } catch (e) {}

    /** iframe 数量（消息可能在另一个文档里）。 */
    var iframes = 0;
    try { iframes = document.querySelectorAll('iframe').length; } catch (e) {}

    /**
     * ⭐⭐⭐ 虚拟列表专项 —— DeepSeek 用 ds-virtual-list 渲染消息。
     *
     * ## 为什么（DOM 树给出的决定性证据）
     *
     *     div.ds-virtual-list.ds-virtual-list--printable
     *       div.ds-virtual-list-items._6f2c522
     *         div.ds-virtual-list-visible-items  k=0 t=0   ← **空的**
     *
     * 消息列表是**虚拟滚动**的：只有「可见项」才插入 DOM。
     * 如果容器高度是 0 / 未激活 / 没滚到位置，消息就**不在 DOM 里** ——
     * 这解释了我一直抓不到回复的原因。
     *
     * 所以要把虚拟列表的状态导出来：它有几个子容器、各有多少子节点、
     * 高度多少。
     */
    var vlist = [];
    try {
      var vls = document.querySelectorAll('[class*="virtual-list"]');
      for (var vi = 0; vi < vls.length && vi < 12; vi++) {
        var vk = (vls[vi].children || []).length;
        var vt = '';
        try { vt = String(vls[vi].textContent || ''); } catch (e) { vt = ''; }
        var vr = null;
        try { vr = vls[vi].getBoundingClientRect(); } catch (e) {}
        vlist.push({
          el: describe(vls[vi]).slice(0, 90),
          kids: vk,
          txt: vt.length,
          h: vr ? Math.round(vr.height) : -1,
          w: vr ? Math.round(vr.width) : -1
        });
      }
    } catch (e) {}

    /**
     * ⭐⭐⭐ visible-items 的完整内幕。
     *
     * ## 已知事实（上一份 vlist 报告）
     *
     *     ds-virtual-list            h=502  kids=4   ← 外壳正常
     *     ds-virtual-list-items      h=280  kids=1   ← 中层正常
     *     ds-virtual-list-visible-items  h=0  kids=0 ← ⭐ 高度 0，空的
     *
     * 而 bodyText 里有回复内容「21加22等于43」（出现在标题/横幅）。
     * ⇒ 消息已发送、回复已生成，但**消息列表没渲染**。
     *
     * 要查：visible-items 的父链上有没有「占位/骨架/空白填充」节点 ——
     * 虚拟列表通常用一个大高度的空白 div 占位、滚动时才往 visible 区插节点。
     */
    var vdetail = [];
    try {
      var vi2 = document.querySelector('[class*="ds-virtual-list-visible-items"]');
      if (vi2) {
        /** 它自己。 */
        vdetail.push({ what: 'visible-items 自身', el: describe(vi2).slice(0, 90), kids: (vi2.children || []).length, txt: String(vi2.textContent || '').length });
        /** 它的父链往上 6 层，每层的子元素概况。 */
        var p = vi2.parentElement;
        for (var pi3 = 0; pi3 < 6 && p; pi3++) {
          var kidInfo = [];
          for (var ki = 0; ki < (p.children || []).length && ki < 8; ki++) {
            var kc = p.children[ki];
            var kr = null;
            try { kr = kc.getBoundingClientRect(); } catch (e) {}
            kidInfo.push(describe(kc).slice(0, 46) + '(h=' + (kr ? Math.round(kr.height) : -1) + ',t=' + String(kc.textContent || '').length + ')');
          }
          var pr = null;
          try { pr = p.getBoundingClientRect(); } catch (e) {}
          vdetail.push({ what: '父' + (pi3 + 1) + ' 层', el: describe(p).slice(0, 90), kids: (p.children || []).length, txt: String(p.textContent || '').length, kidsDetail: kidInfo.join(' | ').slice(0, 400), h: pr ? Math.round(pr.height) : -1 });
          p = p.parentElement;
        }
      }
    } catch (e) {}

    /**
     * ⭐⭐⭐ visible-items 的直接子元素 —— **这就是消息清单**。
     *
     * ## 实测确认的祖先链（needle=提示词时拿到）
     *
     *     div._72b6158                      ← 用户消息气泡
     *     div._81e7b5e                      ← 用户消息项
     *     div.ds-virtual-list-visible-items ← **消息容器**
     *     div.ds-virtual-list-items
     *     div.ds-virtual-list
     *
     * 回复和用户消息是**兄弟**（同一个消息列表的相邻项）。
     * 把 visible-items 的每个孩子列出来（tag/class/文本量/前 60 字），
     * 就能直接看出「回复项长什么样、内容是什么」。
     */
    var messages = [];
    try {
      var vis = document.querySelector('[class*="ds-virtual-list-visible-items"]');
      if (vis) {
        var mk = vis.children || [];
        for (var mi = 0; mi < mk.length && mi < 20; mi++) {
          var mt = '';
          try { mt = String(mk[mi].textContent || ''); } catch (e) { mt = ''; }
          var mr = null;
          try { mr = mk[mi].getBoundingClientRect(); } catch (e) {}
          messages.push({
            el: describe(mk[mi]).slice(0, 100),
            kids: (mk[mi].children || []).length,
            txt: mt.length,
            head: mt.slice(0, 60),
            h: mr ? Math.round(mr.height) : -1
          });
        }
      }
    } catch (e) {}

    /**
     * ⭐⭐⭐ 虚拟列表滚动链路详查。
     *
     * 实测：items h=1960（有内容）但 visible-items kids=0。
     * 我把外层 scroll-area.scrollTop 拉到底没生效 ——
     * 需要知道**到底哪个节点**是可以滚的（scrollHeight > clientHeight），
     * 以及虚拟列表把「渲染窗口」挂在哪个属性上。
     */
    var scrollInfo = [];
    try {
      var vl = document.querySelector('[class*="ds-virtual-list--printable"]');
      var node = vl;
      for (var si2 = 0; si2 < 5 && node; si2++) {
        var sr = null;
        try { sr = node.getBoundingClientRect(); } catch (e) {}
        scrollInfo.push({
          el: describe(node).slice(0, 80),
          scrollH: node.scrollHeight,
          clientH: node.clientHeight,
          scrollTop: node.scrollTop,
          h: sr ? Math.round(sr.height) : -1,
          overflowY: (function () { try { return getComputedStyle(node).overflowY; } catch (e) { return '?'; } })()
        });
        node = node.parentElement;
      }
    } catch (e) {}

    /** ⭐ 页面健康度：React root 是否空转、错误覆盖层是否存在。 */
    var health = { textarea: 0, buttons: 0, errorOverlay: false, reactRootKids: 0 };
    try {
      health.textarea = document.querySelectorAll('textarea, [contenteditable="true"]').length;
      health.buttons = document.querySelectorAll('button, [role="button"]').length;
      var rr = document.getElementById('root');
      health.reactRootKids = rr ? (rr.children || []).length : -1;
      /** DeepSeek/React 的错误覆盖层。 */
      health.errorOverlay = !!document.querySelector('[id*="webpack"], [class*="error-overlay"], nextjs-portal');
    } catch (e) {}

    /** 页面上的文本总量 —— 判断「内容到底渲染了没」。 */
    var bodyText = '';
    try { bodyText = String(document.body ? document.body.innerText || document.body.textContent || '' : ''); } catch (e) { bodyText = ''; }

    return JSON.stringify({
      ok: true,
      url: location.href,
      title: String(document.title || '').slice(0, 100),
      totalElements: all.length,
      needleHits: hits.length,
      needleEls: hits.slice(0, 3).map(describe),
      chain: chain,
      layout: layout,
      cands: cands,
      /** ⭐ 有较长文本的元素（按长度降序）—— 回复容器必在其中。 */
      rich: rich.slice(0, 12),
      /** ⭐ content 元素详情。 */
      contentEls: contentEls,
      /** ⭐ 所有 ds- 类名（去重计数）—— 找消息列表容器。 */
      dsClasses: dsClasses.slice(0, 60),
      /** ⭐⭐ DOM 树（#root 往下 7 层，最多 90 个节点）。 */
      tree: tree,
      /** shadow DOM 宿主数 —— 消息可能在里面（textContent 穿不过去）。 */
      shadowHosts: shadowHosts,
      /** iframe 数 —— 消息可能在另一个文档里。 */
      iframes: iframes,
      /** ⭐⭐⭐ 消息清单（visible-items 的直接子元素）。 */
      messages: messages,
      /** ⭐⭐⭐ 虚拟列表状态（消息容器）。 */
      vlist: vlist,
      /** ⭐⭐⭐ visible-items 内幕（父链上有没有占位骨架）。 */
      vdetail: vdetail,
      /** ⭐ 页面健康度。 */
      health: health,
      /** ⭐⭐⭐ 滚动链路（哪个节点能滚）。 */
      scrollInfo: scrollInfo,
      /** 页面文本总量 —— 判断内容渲染了没。 */
      bodyTextLen: bodyText.length,
      bodyTextHead: bodyText.slice(0, 300),
      topClasses: top.slice(0, 45)
    });
  } catch (e) {
    return JSON.stringify({ ok: false, error: String(e && e.message) });
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
		/**
		* ## 填充输入框（**短调用，快速返回**）
		*
		* 与 `buildTriggerScript` 配合使用，中间由客户端控制随机延迟。
		* 拆分理由见 `buildTriggerScript` 的说明。
		*/
		function buildFillScript(text, hints) {
			const inputSelectors = hints?.inputSelectors ?? [
				"textarea[placeholder*=\"给 DeepSeek\"]",
				"textarea[placeholder*=\"DeepSeek\"]",
				"textarea[placeholder*=\"输入\"]",
				"textarea",
				"div[contenteditable=\"true\"]",
				"[role=\"textbox\"]"
			];
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
})();`;
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
		function buildTriggerScript(hints, expectText) {
			const inputSelectors = hints?.inputSelectors ?? [
				"textarea[placeholder*=\"DeepSeek\"]",
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
  var INPUT_SELECTORS = ${JSON.stringify(inputSelectors)};
  var SEND_SELECTORS = ${JSON.stringify(sendSelectors)};
  var SIGNATURES = ${JSON.stringify(hints?.signatures ?? [])};
  var VETOES = ${JSON.stringify(hints?.vetoes ?? [])};
  /**
   * 期望输入框里有的内容（fill 阶段填进去的）。
   *
   * ## ⭐ 为什么要把「要发的字」传进来（本轮新修）
   *
   * fill 和 trigger 是**两次独立的 executeJavaScript**，中间隔 2–4 秒。
   * 这期间页面可能重渲染（React 换掉了输入框节点），于是 trigger 找到的
   * 输入框**可能不是 fill 填的那个** —— 那时点发送会：
   *   - 发出一条**空消息**，或者
   *   - 什么都没发生（新节点里没内容，发送键是禁用态）
   *
   * 而插件完全不知道，继续等一个永远不会来的回复。
   *
   * 现在把期望文本传进来，**点火前先核对**：输入框里确实有我们填的字
   * 才按发送。对不上就明确报错（而不是赌一把）。
   *
   * 空串表示不做这个校验（调用方没传）。
   */
  var EXPECT = ${JSON.stringify(expectText ?? "")};

  /**
   * 归一化后比较（换行 / 首尾空白 / 中间的连续空白都不该导致误判）。
   * 只比较**前 200 字符** —— 长 prompt 尾部可能被输入框截断显示，
   * 而我们只需要确认「是同一段内容」。
   */
  function sameText(a, b) {
    if (b === '') return true;
    var na = String(a || '').replace(/\\s+/g, ' ').trim().slice(0, 200);
    var nb = String(b || '').replace(/\\s+/g, ' ').trim().slice(0, 200);
    return na === nb;
  }

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

  /**
   * 读输入框当前内容。
   *
   * textarea / input 用 value；contenteditable 用 innerText（它比
   * textContent 更接近用户看到的内容 —— 会忽略隐藏元素）。
   *
   * ⚠️ 发送确认靠它判断「页面是否接受了这条消息」。
   */
  function readInput(el) {
    if (!el) return '';
    try {
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return String(el.value || '');
      return String(el.innerText || el.textContent || '');
    } catch (e) { return ''; }
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
     * ## ⭐ 点火前核对：输入框里确实是我们填的字吗
     *
     * 见 EXPECT 的说明 —— 两次调用之间页面可能重渲染，换掉了输入框节点。
     * 那时按发送会发空消息或什么都不发生，而插件不知道。
     *
     * ⚠️ 核对失败**不直接放弃**，而是重新找一遍输入框：
     * React 换节点是常见现象，新节点里内容通常还在（React 会保留 state）。
     * 重找之后还没有，才报错。
     */
    if (!sameText(readInput(input), EXPECT)) {
      /** 重新扫一遍所有候选，看是不是换了节点。 */
      var again = null;
      for (var q = 0; q < INPUT_SELECTORS.length && !again; q++) {
        var ql;
        try { ql = document.querySelectorAll(INPUT_SELECTORS[q]); } catch (e) { continue; }
        for (var qj = 0; qj < ql.length; qj++) {
          if (visible(ql[qj]) && !disabled(ql[qj]) && sameText(readInput(ql[qj]), EXPECT)) {
            again = ql[qj];
            break;
          }
        }
      }
      if (again) {
        /** 找到带内容的那个节点 —— 用它继续。 */
        input = again;
      } else {
        /**
         * ## ⚠️ 找不到「带我们那段字」的输入框时，**不能直接判失败**
         *
         * 第一版直接报 「input-lost」。但有几种**正常**情况会走到这里：
         *
         *   1. **页面已经接受了这条消息**（用户手快点了发送、或按了快捷键），
         *      输入框被清空 ⇒ 当然找不到我们的字
         *   2. React 重渲染把内容换成等价的 DOM（空白/换行不同），
         *      「sameText」 的归一化没覆盖到
         *
         * 这两种情况下判失败会让用户看到**假的** send-failed，
         * 而消息其实已经发出去了。
         *
         * 所以分情况：
         *   - 输入框**空着** ⇒ 内容已被搬走 ⇒ 视为已发送（交给后续 DOM 轮询确认）
         *   - 输入框**有内容但不是我们的** ⇒ fill 被顶掉了 ⇒ 报错
         *     （这时发出去会发错内容，必须拦）
         */
        var current = readInput(input);
        if (current.trim() === '') {
          return JSON.stringify({
            ok: true,
            how: 'already-sent',
            method: 'none',
            confirmed: false,
            note: 'input-empty-before-send',
            url: location.href,
          });
        }
        return JSON.stringify({
          ok: false,
          reason: 'input-lost',
          message: '输入框里的内容变了（不是刚填进去的那段）—— 没有发送，请重试',
          got: current.slice(0, 60),
          url: location.href,
        });
      }
    }

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
     * 两个都做（点按钮 + 补 Enter）不行 —— 那可能发出两条。
     * 所以只选一个：有够分（>0）的候选按钮就点它，否则合成 Enter。
     */
    var how;
    var method;
    if (best && best.score > 0) {
      try { best.el.click(); } catch (e) {}
      how = best.how;
      method = 'click';
    } else {
      pressEnter(input);
      how = 'enter';
      method = 'enter';
    }

    /**
     * ## ⭐⭐ 发送**确认**（用户报的「网页版早就有答案了，dsh 还在深度求索」）
     *
     * ## 为什么必须确认
     *
     * 早期这里点完就返回 ok:true，**从不验证**。于是「点了但没生效」
     * （按钮被遮挡 / 是禁用态 / 点了别的元素）时，插件以为发出去了，
     * 一路等一个**永远不会来的回复**。
     *
     * ## 判据：输入框被清空
     *
     * 页面接受发送时**一定会清空输入框**（把内容搬进消息列表）。
     * 这个信号不依赖任何注入时机（hook 装不上也能用）。
     *
     * ## ⚠️⚠️ 但必须**每次重新找输入框**（我第一版漏了，造成误报）
     *
     * 第一版在点击**之前**抓了一个 「input」 引用，之后一直读它。
     * 问题是：React 发送后会**重渲染**，那个节点可能已经被**摘除**
     * （detached）—— 读一个摘除节点的 「.value」 **永远是发送前的内容**，
     * 于是判据恒为「没清空」⇒ **误报 send-failed**。
     *
     * 用户实测（截图）：「网页版 ldw 早就输出完了」，而 DSH 报
     * 「send-failed: 消息没有真正发出去（输入框没被清空）」——
     * 就是读了一个摘除的旧节点。
     *
     * 现在每一轮探测都**重新 「findInput()」**，并且：
     *   - 找不到输入框 ⇒ 也算「页面接受了」（输入框可能被整体换掉）
     *   - 找到但已清空 ⇒ 接受
     *   - 找到且内容明显变短 ⇒ 接受
     *
     * ⚠️ 只等 **1.2 秒**（分几次探）：真实发送时 React 几乎立刻清空。
     * 1.2 秒内没动静 ⇒ 判定失败并**立刻交错误**，不干等到超时。
     */
    return new Promise(function (resolve) {
      var before = readInput(input);
      var tries = 0;
      var MAX_TRIES = 6;      /* 6 × 200ms = 1.2s */
      function ok(extra) {
        var o = {
          ok: true, how: how, method: method, confirmed: true,
          candidates: out.slice(0, 5).map(function (c) { return { how: c.how, score: Math.round(c.score) }; }),
          url: location.href
        };
        for (var k in extra) if (extra[k] !== undefined) o[k] = extra[k];
        resolve(JSON.stringify(o));
      }
      function probe() {
        tries++;
        /**
         * ⭐ **重新找输入框** —— 不能复用点击前抓的引用（它可能已被摘除）。
         */
        var fresh = findInput();
        if (!fresh) {
          /**
           * 找不到输入框 ⇒ 页面多半正在切换/重渲染 ⇒ 算发送成功。
           *
           * 为什么不判失败：判失败会让用户看到一个**假的** send-failed
           * （而消息其实发出去了）。宁可放过，交给后续的 DOM 轮询确认 ——
           * 那里有 30 秒早期放弃兜底，不会真的干等。
           */
          ok({ note: 'input-gone' });
          return;
        }
        var now = readInput(fresh);
        /** 输入框空了（或至少明显变短）⇒ 页面接受了。 */
        if (now.trim() === '' || (before !== '' && now.length < before.length * 0.5)) {
          ok({});
          return;
        }
        if (tries >= MAX_TRIES) {
          resolve(JSON.stringify({
            ok: false, how: how, method: method, confirmed: false,
            reason: 'input-not-cleared',
            message: '点了发送但输入框没被清空 —— 消息很可能没发出去',
            left: now.slice(0, 40),
            candidates: out.slice(0, 5).map(function (c) { return { how: c.how, score: Math.round(c.score) }; }),
            url: location.href
          }));
          return;
        }
        setTimeout(probe, 200);
      }
      /** 先给页面一个 tick 处理点击，再开始探。 */
      setTimeout(probe, 120);
    });
  } catch (e) {
    return JSON.stringify({ ok: false, message: String(e && e.message) });
  }
})();`;
		}
		/**
		* ## 清空输入框（撤销一次已填入但未发送的内容）
		*
		* ## 什么时候用
		*
		* 「填完字」到「按发送」之间隔了 2–4 秒。这期间用户可能按了停止，
		* 或者切到了别的会话 —— 那时**不该再发出去**。
		*
		* 但输入框里已经有内容了，留着它有两个风险：
		*   1. 用户手动按 Enter 会发出一条半截/已取消的消息
		*   2. 下一个任务填充时可能和旧内容混在一起
		*
		* 所以取消时显式清空。
		*
		* @param hints - 平台声明（输入框选择器）
		*/
		function buildClearInputScript(hints) {
			const inputSelectors = hints?.inputSelectors ?? [
				"textarea[placeholder*=\"DeepSeek\"]",
				"textarea",
				"div[contenteditable=\"true\"]",
				"[role=\"textbox\"]"
			];
			return `(function () {
  var INPUT_SELECTORS = ${JSON.stringify(inputSelectors)};

  function visible(el) {
    if (!el) return false;
    try { return el.offsetWidth > 0 && el.offsetHeight > 0; } catch (e) { return false; }
  }

  try {
    var hit = null;
    for (var i = 0; i < INPUT_SELECTORS.length && !hit; i++) {
      var list;
      try { list = document.querySelectorAll(INPUT_SELECTORS[i]); } catch (e) { continue; }
      for (var j = 0; j < list.length; j++) {
        if (visible(list[j])) { hit = list[j]; break; }
      }
    }
    if (!hit) return JSON.stringify({ ok: false, reason: 'no-input' });

    hit.focus();
    if (hit.tagName === 'TEXTAREA' || hit.tagName === 'INPUT') {
      /** 走原生 setter —— 直接赋值不会触发 React 的 onChange。 */
      var proto = hit.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      var desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(hit, '');
      else hit.value = '';
      try { hit.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
      return JSON.stringify({ ok: true, how: 'native-setter' });
    }

    /** contenteditable：selectAll + delete。 */
    try {
      document.execCommand('selectAll', false, undefined);
      document.execCommand('delete', false, undefined);
    } catch (e) {}
    var left = String(hit.innerText || hit.textContent || '').trim();
    if (left !== '') {
      /** 兜底：直接清 textContent 再补事件。 */
      hit.textContent = '';
      try { hit.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
      left = String(hit.innerText || hit.textContent || '').trim();
    }
    return JSON.stringify({ ok: left === '', how: 'execCommand-delete', left: left.slice(0, 40) });
  } catch (e) {
    return JSON.stringify({ ok: false, reason: String(e && e.message) });
  }
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
  /**
   * 页面实际发过哪些 POST（hook 记录的）。
   *
   * ⚠️ **端点改版时这是最有价值的一栏**：如果 DeepSeek 换了 completion 路径，
   * 我们的精确比较会静默失配（既不报错也抓不到回复），
   * 而这里能直接看出「真实路径 vs 期望路径」。
   */
  try {
    out.postPaths = window.__dshWebinHookInstalled___postPaths || [];
    out.expectedCompletion = ${JSON.stringify(hints?.completionPath ?? "/api/v0/chat/completion")};
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
})();`;
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
		function buildThinkingScript(want) {
			return `(function () {
  var want = ${want ? "true" : "false"};
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
})()`;
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
		//#region src/shared/auth-snapshot.ts
		/**
		* 解包 AppKit 的 `{"value":<v>,"__version":"0"}` 包装。
		*
		* ⚠️ 解析失败时**不能把原文当 token** —— 那样 `"{broken"` 这种畸形值
		* 会被当成有效 token（非空字符串），于是坏快照又能覆盖好快照。
		* 只有**看起来像 JSON 却解析失败**的才返回 undefined；
		* 真正的裸 token（不以 `{` 开头）才按原文返回。
		*/
		function unwrapAppKit(raw) {
			if (typeof raw !== "string" || raw === "") return void 0;
			const trimmed = raw.trim();
			if (trimmed === "") return void 0;
			/** JSON 的空值字面量：`"null"` / `"undefined"` 都不是 token。 */
			if (trimmed === "null" || trimmed === "undefined") return void 0;
			if (!trimmed.startsWith("{") && !trimmed.startsWith("["))
 /** 裸字符串 token（旧版页面可能这样存）。 */
			return trimmed;
			try {
				const parsed = JSON.parse(trimmed);
				if (parsed !== null && typeof parsed === "object" && "value" in parsed) return parsed.value;
				return parsed;
			} catch {
				/** 像 JSON 但解析失败 ⇒ 视为无效，绝不 fallback 成原文。 */
				return;
			}
		}
		/**
		* 这份快照看起来「确实登录了」吗？
		*
		* 判据（任一成立即算已登录）：
		*   - `userToken` 解包后是非空字符串
		*   - `__appKit_userInfo` 解包后 `.id` 是非空字符串
		*/
		function snapshotLooksLoggedIn(snapshot) {
			const ls = snapshot.localStorage ?? {};
			const token = unwrapAppKit(ls.userToken);
			if (typeof token === "string" && token.trim() !== "") return true;
			const info = unwrapAppKit(ls["__appKit_userInfo"]);
			if (info !== null && typeof info === "object") {
				const id = info.id;
				if (typeof id === "string" && id.trim() !== "") return true;
			}
			return false;
		}
		//#endregion
		//#region src/shared/version.ts
		/**
		* 把构建时刻（ISO）格式化成给人看的样子。
		*
		* ## 为什么要显示构建时间
		*
		* 提交号对多数人没概念。而「什么时候构建的」很直观：
		* `git pull` 之后忘了 `npm run build`，时间戳会明显偏旧 ——
		* 一眼就能看出「跑的还是旧产物」。
		*
		* ## 显示规则（相对时间优先，因为「多久以前」比绝对时间更有信息量）
		*
		*   - 一分钟内      → `刚刚构建`
		*   - 一小时内      → `12 分钟前构建`
		*   - 24 小时内     → `3 小时前构建`
		*   - 更早          → `2026-10-13 10:30 构建`
		*
		* ⚠️ 时间戳非法 / 为空时返回空串（调用方据此不渲染）——
		* **不能让一个坏时间戳把设置页搞崩**。
		*
		* @param iso - 构建时刻（ISO 字符串）
		* @param now - 当前时刻（测试可注入）
		*/
		function formatBuiltAt(iso, now = Date.now()) {
			if (iso === "") return "";
			const t = Date.parse(iso);
			if (Number.isNaN(t)) return "";
			const diff = now - t;
			/** 时钟偏差导致的「未来时间」当成刚刚。 */
			if (diff < 6e4) return "刚刚构建";
			if (diff < 36e5) return `${Math.floor(diff / 6e4)} 分钟前构建`;
			if (diff < 864e5) return `${Math.floor(diff / 36e5)} 小时前构建`;
			/** 更早：给绝对时间（本地时区，精确到分钟）。 */
			const d = new Date(t);
			const pad = (n) => String(n).padStart(2, "0");
			return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} 构建`;
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
		* 导出页面真实结构 —— 用来**发现**类名，而不是猜。
		*
		* ⚠️ 必须真的**调用**它（见下面诊断按钮里的用法），否则打包器会
		* tree-shake 掉 —— 只在源码里 import 是不够的（踩过：import 了
		* 但产物里搜不到）。
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
				/** 只用于诊断展示（端点改版时对比「期望 vs 实际」）。 */
				completionPath: p.completionPath,
				...p.send.signatures === void 0 ? {} : { signatures: p.send.signatures },
				...p.send.vetoes === void 0 ? {} : { vetoes: p.send.vetoes }
			};
		}
		/** webview 导航 + 吞错（导航失败不算致命：发送脚本自己会报具体错误）。 */
		function element_loadURL(el, url) {
			return el.loadURL(url).then(() => void 0, () => void 0);
		}
		/**
		* ## 带超时护栏的 `executeJavaScript`
		*
		* ## 为什么必须有这个（用户实测踩到的死锁）
		*
		* 用户症状：「一直深度求索中，网页版早就有回复和思考内容了，但就是不输出」。
		*
		* 排查发现状态栏那行的 `how` 字段**还是「思考模式未切换」那条消息**，
		* 而不是发送方式 —— 说明发送之后的 `setLastSend` **从未执行**。
		* 也就是说这一句永远没有 settle：
		*
		*     const raw = await el.executeJavaScript(buildSendScript(...))
		*
		* ## 为什么会永不 settle
		*
		* `executeJavaScript` 是**跨进程**调用（渲染进程 ← → 主进程）。
		* 页面一旦**导航**（`location` 变了、或者 SPA 做了硬跳转），
		* 旧的 JS 上下文就被销毁，挂在里面的 Promise **静默死掉** ——
		* 不 resolve、不 reject、不抛错。宿主这边就永远等下去。
		*
		* 这解释了全部四个症状：
		*   1. `setLastSend` 没执行（await 卡住）⇒ 状态栏还是思考那条消息
		*   2. `busy` 永远为 true ⇒ 整个 `tick` 循环冻死 ⇒ DSH 一直等
		*   3. 注入的 hook 随导航一起被销毁 ⇒ 「收到 0 条」
		*   4. 网页版自己跑完了（那是新上下文里的事，我们既没看到也没收到）
		*
		* ## 为什么用 Promise.race 而不是给 `executeJavaScript` 传超时
		*
		* DSH 的 guest 桥只暴露 `executeJavaScript(code): Promise<unknown>`，
		* 没有超时参数（实测查过）。所以只能在**外部**赛跑：
		* 超时就认输，宁可报一个明确的超时错误，也不要静默卡死。
		*
		* @param el - guest 元素
		* @param code - 要执行的脚本
		* @param timeoutMs - 超时（默认 30s）；超时 resolve 成 sentinel 而不是 reject
		* @returns 脚本结果；超时返回 {@link EXEC_TIMEOUT}
		*/
		const EXEC_TIMEOUT = Symbol("dsh-webin:exec-timeout");
		/**
		* 判定「回复生成完了」所需的**静默时长**（毫秒）。
		*
		* ## 为什么需要它（审计发现的缺陷）
		*
		* 早期只用「这次读到的内容 == 上次读到的」就交付。但流式输出**可能暂停**
		* （网络抖动、服务端排队），暂停期间两次读到同样的半截内容 ⇒
		* **把半截回复交回 DSH**，用户看到回复被截断，而且 DSH 认为这轮已结束。
		*
		* 加上「静默够久」这个条件后，只有内容真的不再增长才交付。
		*
		* 3000ms 的取值：DeepSeek 的流式增量间隔通常在几百毫秒内，
		* 3 秒静默足以区分「暂停」和「结束」，又不会让用户等太久。
		*/
		const STABLE_MS = 3e3;
		/**
		* ## 带超时的 `fetch`（**所有对 host 的请求都必须走这里**）
		*
		* ## 为什么（审计发现的真实风险）
		*
		* 发送循环里有 8 处 `await fetch('/dsh-webin/api/job/.../result')`。
		* 裸 `fetch` **没有超时** —— 如果 host 卡住（事件循环被占、
		* 正在写大文件、或者干脆挂了），这个 `await` 会永远挂着，
		* 而 `busy` 已经是 `true` ⇒ **整个发送循环永久停摆**。
		*
		* 用户会看到的现象和「一直深度求索中」一样：什么都不发生，
		* 且没有任何报错（因为没有异常可捕获）。
		*
		* 这里的超时**只保护「等响应」这一段**，不取消请求本身
		* （请求可能已经到达 host 并被处理，取消反而会造成状态不一致）。
		* 超时后返回 `undefined`，调用方按「交结果可能没成功」继续 ——
		* 关键是**循环要能继续转**。
		*
		* @param input - 请求 URL
		* @param init - fetch 选项
		* @param timeoutMs - 超时（默认 15s）
		* @returns 响应；超时/失败返回 undefined（**不抛错**）
		*/
		function fetchJson(input, init, timeoutMs = 15e3) {
			return new Promise((resolve) => {
				let settled = false;
				const timer = window.setTimeout(() => {
					if (settled) return;
					settled = true;
					console.warn(`[dsh-webin] fetch 超时 ${timeoutMs}ms: ${input}`);
					resolve(void 0);
				}, timeoutMs);
				fetch(input, init).then((res) => {
					if (settled) return;
					settled = true;
					window.clearTimeout(timer);
					resolve(res);
				}, (error) => {
					if (settled) return;
					settled = true;
					window.clearTimeout(timer);
					console.warn(`[dsh-webin] fetch 失败: ${input}`, error);
					resolve(void 0);
				});
			});
		}
		/**
		* 探测 hook 是否**仍在本页面**。
		*
		* 判据是 hook 自己写的标记（与 `hook.ts` 的 `MARKER` 必须一致）。
		* 新文档里那个标记**必然**不存在，所以这个探测能可靠地发现导航。
		*
		* @returns 返回 `'true'` / `'false'` 字符串（`executeJavaScript` 的返回值）
		*/
		const MARKER_CHECK = `(function () {
  try { return window.__dshWebinHookInstalled__ === true ? 'true' : 'false'; }
  catch (e) { return 'false'; }
})();`;
		function execJs(el, code, timeoutMs = 3e4) {
			return new Promise((resolve) => {
				let settled = false;
				const timer = window.setTimeout(() => {
					if (settled) return;
					settled = true;
					console.warn(`[dsh-webin] executeJavaScript 超时 ${timeoutMs}ms（页面可能已导航）`);
					resolve(EXEC_TIMEOUT);
				}, timeoutMs);
				el.executeJavaScript(code).then((value) => {
					if (settled) return;
					settled = true;
					window.clearTimeout(timer);
					resolve(value);
				}, (error) => {
					if (settled) return;
					settled = true;
					window.clearTimeout(timer);
					/**
					* ⚠️ 失败也走 resolve（用 sentinel）而不是 reject ——
					* 调用方几乎都是「拿到字符串就 JSON.parse」，抛出去会被
					* 外层 catch 吞掉，反而不如让它们显式处理 sentinel。
					*/
					console.warn("[dsh-webin] executeJavaScript 失败", error);
					resolve(EXEC_TIMEOUT);
				});
			});
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
/* 未就绪提示：盖在 guest 区域上（跳过 38px 工具栏）。
   ⚠️ **必须 pointer-events:none** —— 用户实测报过「点开 LDW 会卡在这个界面
   点不了，只能等『真实浏览器已就绪』」：这层原本会吃掉鼠标事件，
   而启动阶段（loadURL + 快照读取 + 登录态回写）最长要几十秒，
   那段时间里登录表单/二维码全都点不动。
   提示文字只是状态说明，**不该拦住底下的页面**。 */
.webin-note{position:absolute;left:0;right:0;bottom:0;top:38px;display:flex;align-items:center;
  justify-content:center;padding:24px;text-align:center;white-space:pre-wrap;pointer-events:none;
  font:var(--dsw-font-xs-12);color:var(--dsw-alias-label-tertiary)}
.webin-capture{flex:none;max-height:120px;overflow:auto;padding:6px 8px;box-sizing:border-box;
  border-top:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);
  font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary);white-space:pre-wrap}
/* 次要入口（已登录时的「打开」）—— 刻意做得像链接而不是按钮：
   它是「想进去看看」的旁路，不是「待办事项」。
   用户报过「不要显示『打开浏览器』而是显示『已登录』」——
   主视觉必须是状态标签，这个只能是弱化的小入口。 */
.ldw-linkbtn{border:0;background:none;padding:2px 4px;cursor:pointer;
  font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-quaternary);text-decoration:underline;
  text-underline-offset:2px;text-decoration-color:color-mix(in srgb,currentColor 40%,transparent)}
.ldw-linkbtn:hover{color:var(--dsw-alias-label-secondary)}
.webin-badge-on,.webin-badge-off{flex:none;padding:1px 6px;border-radius:var(--dsw-radius-sm);
  font:var(--dsw-font-xxxs-11);white-space:nowrap}
.webin-badge-on{color:var(--dsw-alias-state-success-primary);
  background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent)}
.webin-badge-off{color:var(--dsw-alias-label-quaternary);
  background:var(--dsw-alias-bg-layer-2)}

/* ══════════════════════════════════════════════════════════════════════
   LDW 设置页 · 视觉系统
   ──────────────────────────────────────────────────────────────────────
   令牌：所有色值取自宿主 --dsw-alias-* 变量，昼夜由宿主切换，本页不写死颜色。
   层级：layer-3 凹槽/页面底 · layer-2 面板 · layer-1 浮起元素。
   动效：transform/opacity 优先；常规 150–300ms、覆盖层 300–400ms。
   ══════════════════════════════════════════════════════════════════════ */
.ldw-set{--ease-instrument:cubic-bezier(.16,1,.3,1);--ease-settle:cubic-bezier(.34,1.4,.4,1);
  display:flex;flex-direction:column;gap:20px;max-width:1080px;font-size:13px;line-height:1.55;
  color:var(--dsw-alias-label-primary);-webkit-font-smoothing:antialiased}
.ldw-set *{box-sizing:border-box}
.ldw-set ::selection{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 24%,transparent)}
/* 键盘可达性：只给键盘聚焦画环，鼠标点击不出现 */
.ldw-set :focus-visible{outline:2px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 78%,transparent);
  outline-offset:2px;box-shadow:0 0 0 4px color-mix(in srgb,var(--dsw-alias-state-business-primary) 13%,transparent)}

/* ══ 页头 hero ═══════════════════════════════════════════════════════ */
.ldw-hero{position:relative;display:flex;flex-direction:column;gap:14px;padding:22px 24px;border-radius:20px;
  border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2) 78%,transparent);
  background:linear-gradient(165deg,color-mix(in srgb,var(--dsw-alias-bg-layer-3) 88%,transparent),
    color-mix(in srgb,var(--dsw-alias-bg-layer-1) 82%,transparent));overflow:hidden}
.ldw-hero::before{content:"";position:absolute;inset:0;pointer-events:none;
  background:radial-gradient(120% 150% at 12% -20%,color-mix(in srgb,var(--dsw-alias-state-business-primary) 13%,transparent),transparent 58%),
    radial-gradient(90% 120% at 88% 130%,color-mix(in srgb,var(--dsw-alias-state-success-primary) 7%,transparent),transparent 60%)}
.ldw-hero>*{position:relative}
.ldw-pagehead{display:flex;align-items:flex-end;gap:14px;flex-wrap:wrap}
.ldw-pagetitle{display:flex;flex-direction:column;gap:6px;min-width:0}
.ldw-pagetitle h2{margin:0;font-size:23px;font-weight:760;letter-spacing:-.6px;line-height:1.2;
  background:linear-gradient(120deg,var(--dsw-alias-label-primary) 20%,
    color-mix(in srgb,var(--dsw-alias-label-primary) 55%,var(--dsw-alias-state-business-primary)));
  -webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
.ldw-pagesub{margin:0;font-size:12.5px;color:var(--dsw-alias-label-secondary);max-width:70ch}
.ldw-pills{display:flex;gap:6px;flex-wrap:wrap;margin-left:auto}
.ldw-pill{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;
  border:1px solid var(--dsw-alias-border-l1);
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 78%,transparent);
  box-shadow:inset 0 1px 0 rgb(255 255 255 / 4%);font-size:11.5px;
  color:var(--dsw-alias-label-secondary);white-space:nowrap;
  transition:border-color .16s ease,color .16s ease}
.ldw-pill.strong{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
.ldw-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-tertiary);flex:none}
@keyframes ldw-dot-breathe{0%,100%{opacity:1}50%{opacity:.55}}
.ldw-dot.ok{background:var(--dsw-alias-state-success-primary);
  box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-success-primary) 18%,transparent);
  animation:ldw-dot-breathe 2.6s ease-in-out infinite}
.ldw-dot.warn{background:var(--dsw-alias-state-warning-primary,#f0a441);
  box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 18%,transparent)}
.ldw-dot.err{background:var(--dsw-alias-state-error-primary);
  box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-error-primary) 18%,transparent)}

/* ══ 区块与分节 ══════════════════════════════════════════════════════ */
.ldw-sec{display:flex;flex-direction:column;gap:10px}
.ldw-sechead{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;padding-bottom:6px;
  border-bottom:1px solid var(--dsw-alias-border-l1)}
.ldw-sec-title{font-size:14px;font-weight:680;letter-spacing:-.2px}
.ldw-sec-hint{font-size:11.5px;color:var(--dsw-alias-label-tertiary);margin-left:auto}
.ldw-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(252px,1fr));gap:10px}

/* ══ 卡片（双层 bezel：hairline 边框 + 顶部内高光 + 柔和外阴影）═════ */
.ldw-card{position:relative;display:flex;flex-direction:column;gap:8px;padding:12px 13px;border-radius:13px;
  border:1px solid var(--dsw-alias-border-l2);
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 80%,transparent);
  box-shadow:inset 0 1px 0 rgb(255 255 255 / 6%),
    0 1px 2px color-mix(in srgb,var(--dsw-alias-state-business-primary) 7%,transparent),
    0 3px 10px color-mix(in srgb,var(--dsw-alias-state-business-primary) 4%,transparent);
  transition:transform .2s cubic-bezier(.32,.72,0,1),box-shadow .24s ease,border-color .18s ease}
.ldw-card:hover{transform:translateY(-2px);
  border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 66%,var(--dsw-alias-border-l2));
  box-shadow:inset 0 1px 0 rgb(255 255 255 / 9%),
    0 16px 34px color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent)}
.ldw-card-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ldw-card-name{font-size:13.5px;font-weight:640;letter-spacing:-.15px}
.ldw-card-id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;
  color:var(--dsw-alias-label-quaternary)}

/* ══ 面板（浮起容器）══════════════════════════════════════════════════ */
.ldw-panel{padding:16px;border-radius:16px;border:1px solid var(--dsw-alias-border-l2);
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 82%,transparent);
  box-shadow:inset 0 1px 0 rgb(255 255 255 / 5%),0 2px 6px rgb(0 0 0 / 4%);
  display:flex;flex-direction:column;gap:12px}
.ldw-glass{background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 68%,transparent);
  backdrop-filter:blur(16px) saturate(150%);-webkit-backdrop-filter:blur(16px) saturate(150%);
  border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2) 78%,transparent);
  box-shadow:inset 0 1px 0 rgb(255 255 255 / 6%),0 12px 34px rgb(0 0 0 / 9%)}

/* ══ 键值行 ══════════════════════════════════════════════════════════ */
.ldw-rows{display:flex;flex-direction:column;gap:4px}
.ldw-row{display:flex;gap:8px;font-size:12px;line-height:1.5;align-items:baseline}
.ldw-row-label{flex:none;min-width:56px;color:var(--dsw-alias-label-quaternary)}
.ldw-row-value{color:var(--dsw-alias-label-secondary);word-break:break-all;min-width:0}

/* ══ 表单控件 ════════════════════════════════════════════════════════ */
.ldw-field{display:flex;flex-direction:column;gap:4px;min-width:120px}
.ldw-field-inline{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.ldw-field-label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.ldw-input{font:inherit;font-size:12px;padding:6px 10px;border-radius:9px;
  border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);
  box-shadow:inset 0 1px 2px rgb(0 0 0 / 5%);color:var(--dsw-alias-label-primary);
  min-width:0;width:100%;transition:border-color .16s ease,box-shadow .16s ease}
.ldw-input:focus{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 62%,var(--dsw-alias-border-l2));
  box-shadow:inset 0 1px 2px rgb(0 0 0 / 5%),0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-business-primary) 14%,transparent)}
.ldw-num{width:96px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;
  padding:5px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-bg-layer-1);box-shadow:inset 0 1px 2px rgb(0 0 0 / 5%);
  color:var(--dsw-alias-label-primary);transition:border-color .16s ease,box-shadow .16s ease}
.ldw-num:focus{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 62%,var(--dsw-alias-border-l2));
  box-shadow:inset 0 1px 2px rgb(0 0 0 / 5%),0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-business-primary) 14%,transparent)}
.ldw-unit{flex:none;font-size:11px;color:var(--dsw-alias-label-quaternary);min-width:22px}
.ldw-note{font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:1.5;margin:0}
.ldw-textarea{font:inherit;font-size:11.5px;padding:10px;border-radius:11px;resize:vertical;
  border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);
  box-shadow:inset 0 1px 2px rgb(0 0 0 / 5%);color:var(--dsw-alias-label-primary);width:100%;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;line-height:1.6;
  transition:border-color .16s ease,box-shadow .16s ease}
.ldw-textarea:focus{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 62%,var(--dsw-alias-border-l2));
  box-shadow:inset 0 1px 2px rgb(0 0 0 / 5%),0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-business-primary) 14%,transparent)}

/* ══ 开关（role=switch，圆点带弹性位移）═════════════════════════════ */
.ldw-switch{display:inline-flex;align-items:center;gap:9px;cursor:pointer;user-select:none;
  -webkit-tap-highlight-color:transparent;background:none;border:none;padding:0;
  font:inherit;color:inherit;text-align:left}
.ldw-switch>i{width:36px;height:20px;border-radius:999px;background:var(--dsw-alias-bg-layer-1);
  border:1px solid var(--dsw-alias-border-l2);box-shadow:inset 0 1px 3px rgb(0 0 0 / 8%);
  position:relative;transition:background .2s ease,border-color .2s ease,box-shadow .2s ease;flex:none}
.ldw-switch:hover>i{filter:brightness(1.05)}
.ldw-switch[aria-checked="true"]:hover>i{filter:brightness(1.08)}
.ldw-switch>i::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;
  background:var(--dsw-alias-label-secondary);box-shadow:0 1px 3px rgb(0 0 0 / 22%);
  transition:transform .26s cubic-bezier(.34,1.3,.64,1),background .2s ease,width .16s ease}
.ldw-switch:active>i::after{width:17px}
.ldw-switch[aria-checked="true"]>i{background:var(--dsw-alias-state-business-primary);
  border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 85%,#000);
  box-shadow:inset 0 1px 3px rgb(0 0 0 / 12%)}
.ldw-switch[aria-checked="true"]>i::after{transform:translateX(16px);background:#fff}
.ldw-switch[aria-checked="true"]:active>i::after{transform:translateX(13px)}
.ldw-switch:focus-visible>i{box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-business-primary) 22%,transparent)}
.ldw-switch:disabled{opacity:.45;cursor:default}

/* ══ 按钮 ════════════════════════════════════════════════════════════ */
.ldw-btn{font:inherit;font-size:12px;font-weight:580;padding:6px 14px;border-radius:9px;
  border:1px solid var(--dsw-alias-border-l2);
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 84%,transparent);
  box-shadow:inset 0 1px 0 rgb(255 255 255 / 5%),0 1px 2px rgb(0 0 0 / 6%);
  color:var(--dsw-alias-label-primary);cursor:pointer;
  transition:transform .18s var(--ease-instrument),border-color .2s var(--ease-instrument),
    background .2s var(--ease-instrument),box-shadow .22s var(--ease-instrument),opacity .16s ease}
.ldw-btn:hover:not(:disabled){border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 62%,var(--dsw-alias-border-l2));
  background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 7%,var(--dsw-alias-bg-layer-3));
  transform:translateY(-1px);box-shadow:inset 0 1px 0 rgb(255 255 255 / 7%),0 3px 8px rgb(0 0 0 / 9%)}
.ldw-btn:active:not(:disabled){transform:translateY(0)}
.ldw-btn.primary{background:linear-gradient(180deg,
    color-mix(in srgb,var(--dsw-alias-state-business-primary) 88%,#fff),
    var(--dsw-alias-state-business-primary));
  border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 82%,#000);
  color:var(--dsw-alias-label-on-accent,#fff);
  box-shadow:inset 0 1px 0 rgb(255 255 255 / 18%),
    0 2px 8px color-mix(in srgb,var(--dsw-alias-state-business-primary) 32%,transparent)}
.ldw-btn.danger:hover:not(:disabled){border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 62%,var(--dsw-alias-border-l2));
  background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 9%,var(--dsw-alias-bg-layer-3))}
.ldw-btn:disabled{opacity:.45;cursor:default;box-shadow:none;transform:none}
.ldw-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}

/* ══ 折叠区 ══════════════════════════════════════════════════════════ */
.ldw-details{border:1px solid var(--dsw-alias-border-l2);border-radius:14px;padding:0;
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 72%,transparent);overflow:hidden}
.ldw-details>summary{cursor:pointer;list-style:none;padding:13px 16px;
  display:flex;align-items:center;gap:9px;font-size:13px;font-weight:620;
  transition:background .16s ease}
.ldw-details>summary:hover{background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 52%,transparent)}
.ldw-details>summary::-webkit-details-marker{display:none}
.ldw-details>summary::before{content:"";width:0;height:0;flex:none;
  border-left:5px solid var(--dsw-alias-label-tertiary);
  border-top:4px solid transparent;border-bottom:4px solid transparent;
  transition:transform .22s var(--ease-instrument)}
.ldw-details[open]>summary::before{transform:rotate(90deg)}
.ldw-details-body{padding:0 16px 16px;display:flex;flex-direction:column;gap:14px}

/* ══ 配置分组 ════════════════════════════════════════════════════════ */
.ldw-group{display:flex;flex-direction:column;gap:9px}
.ldw-group-title{margin:0;font-size:12.5px;font-weight:640;letter-spacing:-.1px;
  display:flex;align-items:center;gap:7px}
.ldw-group-title::before{content:"";width:3px;height:12px;border-radius:2px;flex:none;
  background:var(--dsw-alias-state-business-primary)}
.ldw-fieldrow{display:grid;grid-template-columns:minmax(150px,1.1fr) auto 1fr;gap:10px;
  align-items:center;padding:5px 0}
.ldw-fieldrow .ldw-hint{font-size:11px;color:var(--dsw-alias-label-quaternary);line-height:1.45}

/* ══ 提示条 ══════════════════════════════════════════════════════════ */
.ldw-callout{display:flex;gap:9px;padding:10px 12px;border-radius:11px;
  border:1px solid color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 34%,transparent);
  background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 9%,transparent);
  font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-secondary)}
.ldw-callout.err{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 34%,transparent);
  background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 9%,transparent)}
.ldw-callout strong{color:var(--dsw-alias-label-primary);font-weight:620}
.ldw-callout ul{margin:5px 0 0;padding-left:18px}
.ldw-callout li{margin:2px 0}

/* ══ 标签（自定义 / 状态）════════════════════════════════════════════ */
.ldw-tag{padding:2px 8px;border-radius:999px;font-size:10.5px;font-weight:560;white-space:nowrap;
  border:1px solid var(--dsw-alias-border-l1);
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 72%,transparent);
  color:var(--dsw-alias-label-tertiary)}
.ldw-tag.ok{color:var(--dsw-alias-state-success-primary);
  border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 38%,transparent);
  background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 11%,transparent)}
.ldw-tag.warn{color:var(--dsw-alias-state-warning-primary,#f0a441);
  border-color:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 38%,transparent);
  background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 11%,transparent)}

/* ══ 骨架屏（首次读取时的 shimmer）══════════════════════════════════ */
@keyframes ldw-shimmer{0%{opacity:.45}50%{opacity:.85}100%{opacity:.45}}
.ldw-skeleton{animation:ldw-shimmer 1.5s ease-in-out infinite;border-radius:8px;
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 70%,transparent);height:13px}

/* ══ 版本行（hero 内第二行）═════════════════════════════════════════ */
.ldw-verline{display:flex;align-items:center;gap:9px;flex-wrap:wrap;
  padding-top:12px;border-top:1px solid var(--dsw-alias-border-l1)}
.ldw-ver{display:inline-flex;align-items:baseline;gap:6px}
.ldw-ver-num{font-size:12.5px;font-weight:640;color:var(--dsw-alias-label-primary);letter-spacing:-.15px}
/* 构建时间 —— 比提交号直观：pull 后忘了 build 时一眼能看出偏旧。 */
.ldw-ver-when{font-size:10.5px;color:var(--dsw-alias-label-quaternary)}
.ldw-ver-commit{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;
  padding:1px 6px;border-radius:6px;color:var(--dsw-alias-label-tertiary);
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 72%,transparent);
  border:1px solid var(--dsw-alias-border-l1)}
.ldw-ver-note{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-left:auto}
/* Star 按钮：默认低调，hover 才亮出星色 —— 是邀请，不是催促 */
.ldw-star{display:inline-flex;align-items:center;gap:6px;text-decoration:none}
.ldw-star-icon{width:13px;height:13px;flex:none;fill:var(--dsw-alias-label-tertiary);
  transition:fill .2s ease,transform .24s cubic-bezier(.34,1.4,.4,1)}
.ldw-star:hover .ldw-star-icon{fill:var(--dsw-alias-state-warning-primary,#f0a441);
  transform:rotate(-12deg) scale(1.12)}
.ldw-updcmd{margin:6px 0 4px;padding:6px 9px;border-radius:8px;
  background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;
  color:var(--dsw-alias-label-secondary);overflow-x:auto;white-space:pre}

/* ══ 登录行（设置页「登录」区）══════════════════════════════════════ */
.ldw-loginrow{display:flex;align-items:center;gap:9px;flex-wrap:wrap;
  padding:9px 11px;border-radius:11px;
  border:1px solid var(--dsw-alias-border-l1);
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 52%,transparent);
  transition:border-color .18s ease,background .18s ease}
.ldw-loginrow:hover{border-color:var(--dsw-alias-border-l2);
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 74%,transparent)}
.ldw-loginrow-name{font-size:12.5px;font-weight:600;
  color:var(--dsw-alias-label-primary);white-space:nowrap}

/* ══════════════════════════════════════════════════════════════════════
   输入框左侧的 LDW 入口（conversation.input.left）
   ──────────────────────────────────────────────────────────────────────
   与工具栏里其它紧凑控件同高同圆角，不抢视线；未登录时才用警示色，
   登录后就是一粒安静的绿点 —— 状态用颜色说话，不靠文字喊。
   ══════════════════════════════════════════════════════════════════════ */
.ldw-entry{display:inline-flex;align-items:center;gap:6px;flex:none;
  height:26px;padding:0 9px;border-radius:8px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l1);
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 62%,transparent);
  font:inherit;font-size:11.5px;color:var(--dsw-alias-label-secondary);
  white-space:nowrap;
  transition:border-color .18s ease,background .18s ease,color .18s ease,transform .16s ease}
.ldw-entry:hover{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 52%,var(--dsw-alias-border-l2));
  background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 8%,var(--dsw-alias-bg-layer-2));
  color:var(--dsw-alias-label-primary);transform:translateY(-1px)}
.ldw-entry:active{transform:translateY(0)}
.ldw-entry:focus-visible{outline:2px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 78%,transparent);
  outline-offset:2px}
/* 未登录时整体偏警示色 —— 一眼看出「这里需要你做点什么」 */
.ldw-entry:has(.ldw-dot.warn){border-color:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 42%,transparent);
  color:var(--dsw-alias-state-warning-primary,#f0a441)}
.ldw-entry-note{margin-left:4px;font-size:10.5px;color:var(--dsw-alias-label-quaternary)}
`;
		let hostRect = null;
		const rectListeners = /* @__PURE__ */ new Set();
		/**
		* 当前窗口挂在哪个 DSH 会话上。
		*
		* ## 谁写入
		*
		* `LdwPlaceholder`（挂在 `conversation.view` 上）从 props 拿到 DSH 给的
		* `sessionId` 后写进来并上报 host。
		*
		* ## 谁读
		*
		* 发送循环领活时带上它（`?session=<id>`）—— host 据此只派发属于本窗口的
		* 任务。没有它就会「所有窗口都生效」（用户实测报过）。
		*
		* ⚠️ 是模块级而不是 state：发送循环跑在 `setInterval` 里，读 state 会拿到
		* 闭包里的旧值。ref 语义更合适。
		*/
		const sessionIdRef = { current: "" };
		/** 「props 已经打过日志了吗」—— 只打一次，不刷屏。 */
		let propsLogged = false;
		/**
		* 最近一次 DOM 抓取的诊断信息（跟着心跳上报给 host）。
		*
		* ## 为什么需要（用户：「不要猜」）
		*
		* 端到端测试抓到侧边栏而不是回复时，我**看不到**抓取脚本内部
		* 选了什么容器、命中哪个 selector、主内容区定位到哪 —— 只能
		* 改代码→重启→再看，一轮一轮猜。
		*
		* 把这几项挂上去，`/status` 就能直接看到，不用猜。
		*/
		/**
		* 页面结构报告 —— 抓取失败时**自动**导出一次（不需要用户点按钮）。
		*
		* ## 为什么需要
		*
		* trace 显示**所有候选都命中 0 个** —— 说明类名表整个是错的。
		* 要修就得先看到**真实页面结构**，而等用户点诊断按钮太慢。
		*
		* 所以抓取走到 `longest-div` 兜底时自动导一次，跟着心跳上报：
		*   - `chain`：含回复文字的元素祖先链 ⇒ 回复容器就在这条链上
		*   - `topClasses`：出现 >= 2 次的类名频次
		*   - `cands`：各候选选择器实际命中几个
		*
		* 只抓一次 —— 不给页面加持续负担。
		*/
		const domReportRef = { current: void 0 };
		/**
		* ## 面板加载时的产物 rev（自动重载判据 v2）
		*
		* ## ⚠️ v1 判据（builtAt vs mtime）造成**每 2 秒无限重载**，已废弃
		*
		* v1 让面板上报烘死的 `clientBuiltAt`，host 比 `mtime` —— 但 builtAt
		* 在构建开始算、client.js 在构建末尾写盘，机器稍慢差值就超容差
		* ⇒ **永远判定落后** ⇒ 每次心跳都 reload ⇒ 死循环（群友实测每 2 秒一次，
		* 甚至拖崩 DSH 桌面端 —— 用户拿这个问题去找了别的 agent）。
		*
		* ## v2：只比「rev 变没变」—— 自收敛
		*
		* 第一次心跳把 host 回的 `bundleRev` 记下来（= 我加载时是哪个版本）；
		* 之后 rev **变了** ⇒ 真的出了新构建 ⇒ 才 reload。reload 后拿到的
		* 就是新 bundle ⇒ 记下的 rev 更新 ⇒ 停止。
		*
		* **不需要任何持久化**：模块级变量在 reload 后随模块重建，正好重置。
		*/
		const loadedBundleRev = { current: null };
		/**
		* 当前任务的提示词 —— 诊断时用它做 needle。
		*
		* ## 为什么需要（用户的关键观察）
		*
		* 用户指出：「网页版都是一个字一个字蹦出来的」—— 回复是**流式逐字渲染**。
		* 这意味着：
		*   1. 回复**确实在 DOM 里**（用户看得见）—— 我之前「消息不在 DOM 里」
		*      的结论是错的：那是**发消息前的一瞬**抓的快照，抓早了
		*   2. 所以诊断的 needle 应该用**提示词本身**（它作为用户消息一定在
		*      页面上），而不是「抓到的内容」（抓到的可能是侧边栏）
		*/
		const promptRef = { current: "" };
		/** DOM 报告上次抓取时刻（限流：20 秒最多一次，防拖死 tick —— 见抓取处注释）。 */
		const domReportAtRef = { current: 0 };
		const scrapeDiagRef = { current: {} };
		/**
		* drain 轮询间隔。
		*
		* ## ⚠️ 为什么从 500ms 放宽到 1500ms（**实测发现的问题**）
		*
		* 这个轮询每轮都要跨进程 `executeJavaScript` 去读 hook 事件数组 ——
		* 也就是**每秒 2 次 IPC**，而且**空闲时也在跑**。
		*
		* 加上 hook 看门狗（1500ms）和心跳（5000ms），client 侧同时跑着三个
		* 定时器，每个都打 IPC。实测后果：
		*
		*     心跳延迟 10943ms → 12975ms → 14985ms → **掉线**
		*
		* 延迟每次 +2000ms（正好是采样间隔）说明心跳**停了** —— 主线程被
		* 这些 IPC 往返占住，5 秒的心跳漏成了 15 秒以上，触发 host 的
		* `CLIENT_STALE_MS` 判死。
		*
		* ## 为什么放宽到 1500ms 是安全的
		*
		* drain 只是 hook 事件的**辅助通道**（主路径是 DOM 抓取，1.5s 一轮）。
		* 事件在页面里是**累积在数组里**的，晚读一轮不会丢 —— 只是延迟一点。
		* 而少掉 2/3 的 IPC 能让主线程喘过来，心跳才稳。
		*
		* 副作用：hook 抓到回复后的交付最多晚 1.5 秒。可接受 ——
		* 相比「面板被判掉线」，这个代价小得多。
		*/
		const DRAIN_INTERVAL_MS = 1500;
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
			/**
			* 上面三个值的**最新镜像**，供心跳读取。
			*
			* ## 为什么需要（真实 bug）
			*
			* 心跳 effect 原来把 `loggedIn` / `lastReply` / `replyCount` 放进依赖数组，
			* 于是**每来一条回复就重建整个 effect** —— 定时器被反复清掉重建，
			* 心跳间隔变得不稳定（可能翻倍），host 侧可能判定「面板掉线」。
			*
			* 用 ref 镜像：发送时读 ref（永远是最新值），effect 只依赖 `ready` / 平台。
			* 这样定时器起来一次就不再重建。
			*/
			const loggedInRef = (0, react.useRef)(false);
			const lastReplyAtRef = (0, react.useRef)(0);
			const replyCountRef = (0, react.useRef)(0);
			loggedInRef.current = loggedIn;
			replyCountRef.current = replyCount;
			if (lastReply !== "") lastReplyAtRef.current = Date.now();
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
						/**
						* ## ⭐ 把 partition 上报给 host（解决「重启必须重新登录」）
						*
						* ## 为什么要上报
						*
						* DSH 的 guest partition 是 `dsh-sidebar-browser-${randomUUID()}`
						* （`lib/main.js:9638`）—— **无 `persist:` 前缀 = 内存分区**，
						* 进程退出 cookie 全丢。
						*
						* 而 DeepSeek 的登录态主要靠 **httpOnly cookie**，页面里的
						* `document.cookie` **看不见也写不了**它们 —— 所以「快照
						* localStorage + document.cookie」这条路天生不完整
						* （用户实测：「每次重启 dsh 都需要重新登陆」）。
						*
						* **partition 名是随机的，host 猜不到** —— 但它就在这个返回值里。
						* 上报之后，host 半（跑在 Electron 主进程）就能用
						* `session.fromPartition(name).cookies` 读写**含 httpOnly** 的
						* 完整 cookie，重启后写回去即可免登录。
						*
						* ⚠️ 上报失败不能影响主流程（这只是增强，不是必需）。
						*/
						fetchJson("/dsh-webin/api/client/partition", {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({
								platform: provider.id,
								partition: reservation.partition,
								/** 目标域名 —— host 侧按它过滤 cookie。 */
								domain: (() => {
									try {
										return new URL(provider.homeUrl).hostname;
									} catch {
										return "";
									}
								})()
							})
						});
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
								/** ⚠️ 带超时 —— 5 秒一次，裸调用会在导航时堆积死掉的 Promise。 */
								execJs(node, buildProbeScript(), 8e3).then((r2) => {
									if (disposed || r2 === EXEC_TIMEOUT) return;
									try {
										const p2 = JSON.parse(String(r2));
										setLoggedIn(p2.loggedIn === true);
									} catch {}
								});
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
									/**
									* ## ⭐ 第一步：让 host 把 **httpOnly cookie** 写回当前 partition
									*
									* 这比页面侧快照更根本 —— DeepSeek 的登录态主要靠
									* httpOnly cookie，而页面 JS 既读不到也写不了它们。
									*
									* 顺序很重要：**必须在页面加载前写**（cookie 是请求头的一部分，
									* 页面开始加载后再写就晚了，首屏仍然是登录页）。
									* 这里处于 `navigating` 阶段，页面刚 loadURL、还没渲染完，
									* 是能赶上的最早时机。
									*
									* ⚠️ 失败不阻断（走页面快照那条降级路径）。
									*/
									let cookieRestored = 0;
									try {
										const res = await fetchJson(`/dsh-webin/api/auth/${encodeURIComponent(provider.id)}/cookies`, void 0, 1e4);
										if (res !== void 0 && res.ok) {
											const j = await res.json();
											cookieRestored = typeof j.restored === "number" ? j.restored : 0;
											console.log("[dsh-webin] httpOnly cookie 已写回", {
												restored: cookieRestored,
												total: j.total ?? 0
											});
										} else if (res !== void 0 && res.status !== 404 && res.status !== 409) console.log("[dsh-webin] cookie 写回跳过", res.status);
									} catch {}
									const snap = await loadSnapshot(provider.id);
									if (snap === void 0) {
										console.log("[dsh-webin] 无登录态快照，跳过回写");
										stageRef.current = "live";
										/**
										* ⚠️ cookie 写回成功时**必须 reload** ——
										* 页面是在 cookie 写回**之前**开始加载的，首屏还是登录页；
										* 不 reload 的话用户看到的就是登录界面（即使 cookie 已经好了）。
										*/
										if (cookieRestored > 0) {
											stageRef.current = "reloading";
											/**
											* ## ⚠️⚠️ `reload()` **不返回 Promise** —— 不能 `.catch()`
											*
											* ## 真实事故（DSH 直接崩溃）
											*
											* 崩溃日志：
											*
											*     TypeError: Cannot read properties of undefined (reading 'catch')
											*     at dsh-app://app/plugins/??dsh-webin/client.js:4162
											*     Error: web boot: 1 entry did not activate
											*     dsh-webin: import failed
											*
											* 根因：`<webview>.reload()` 是 **Electron 的同步方法**，
											* 返回 `undefined` —— 而这里写了 `.reload().catch(...)`，
											* 于是对 `undefined` 读 `.catch` ⇒ **抛 TypeError**。
											*
											* 这个异常发生在 effect 里，冒泡成 unhandled rejection ⇒
											* **整个 client bundle import 失败** ⇒ DSH 报
											* 「应用无法启动或已意外停止」。
											*
											* ⚠️ 这个 bug **一直存在**，只是之前被别的错误掩盖了；
											* 等前面那些错修掉后它就暴露出来，直接把 DSH 打崩。
											*
											* 正确写法：直接调用，不做链式。
											*/
											element.reload();
											return;
										}
										markLive();
										return;
									}
									let restored = false;
									try {
										/** ⚠️ 带超时 —— 裸调用在导航时会静默死掉，卡住整个启动流程。 */
										const raw = await execJs(element, buildRestoreScript(snap), 15e3);
										if (raw === EXEC_TIMEOUT) throw new Error("回写脚本超时");
										const r = JSON.parse(String(raw));
										restored = r.ok === true;
										console.log("[dsh-webin] 登录态回写", provider.id, raw);
										if (!restored) console.warn("[dsh-webin] 回写未成功:", r.reason ?? "unknown");
									} catch (error) {
										console.warn("[dsh-webin] 登录态回写失败", error);
									}
									if (disposed) return;
									/** cookie 写回也算「有东西变了」，同样需要 reload。 */
									if (restored || cookieRestored > 0) {
										stageRef.current = "reloading";
										/**
										* ⚠️ 同上：`<webview>.reload()` 是同步方法、返回 `undefined`，
										* 不能 `.catch()` —— 那会抛 `TypeError: Cannot read properties
										* of undefined (reading 'catch')`，把整个 client bundle 打崩
										* （DSH 直接弹「应用无法启动」，见第一处的完整事故记录）。
										*/
										element.reload();
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
							execJs(element, `(function () {
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
            })()`, 15e3).then((hasInput) => {
								if (disposed) return;
								console.log("[dsh-webin] 输入框就绪检查:", hasInput);
								/**
								* 无论结果如何都要置位 —— 超时/异常也置位。
								* 让发送脚本自己去报具体错误，好过整个插件静默卡死。
								*/
								setReady(true);
								if (hasInput === true) setStatus("真实浏览器已就绪");
								else setStatus("页面已加载，但未找到输入框（可能未登录或结构已变）");
							});
							execJs(element, fingerprintFix(), 1e4).catch(() => void 0);
							execJs(element, buildDeepSeekHook(provider.completionPath, provider.stopPath), 15e3).then((r) => {
								if (disposed) return;
								if (r === EXEC_TIMEOUT) console.warn("[dsh-webin] hook 注入超时");
								else console.log("[dsh-webin] hook:", provider.id, r);
							});
							execJs(element, buildProbeScript(), 1e4).then((raw) => {
								if (disposed) return;
								if (raw === EXEC_TIMEOUT) return;
								try {
									const info = JSON.parse(String(raw));
									globalThis.__dshWebinProbe = info;
									console.log("[dsh-webin] guest probe", info);
									setLoggedIn(info.loggedIn === true);
								} catch {}
							});
						});
						/**
						* ## ⚠️ 导航时**立刻**重新注入 hook（不能只靠 `dom-ready`）
						*
						* 用户症状：「一直深度求索中，网页版早就有回复和思考内容了，但就是不输出」，
						* 状态栏显示「收到 0 条」。
						*
						* 根因：hook 是**页面级**的，一次导航就没了。而 `dom-ready` 是在
						* 页面**主要资源加载完之后**才触发的 —— 此时页面自己的脚本
						* （包括它发 completion 请求的代码）**早就跑起来了**。
						*
						* 于是出现这个致命时序：
						*
						*     t0  我们发消息 → 页面从 / 硬跳转到 /a/chat/s/<id>
						*     t1  导航 ⇒ **hook 被销毁**
						*     t2  新页面起来，立刻发 completion 请求 ← 此时没有 hook！
						*     t3  dom-ready 才触发 ⇒ 我们再注入，但请求已经发出去了
						*     t4  我们看不到任何 SSE ⇒ 收到 0 条 ⇒ DSH 空等
						*
						* 新会话（`freshChat`）必然走这条路：首轮会导航到首页/新对话页。
						*
						* `did-start-navigation` 在主框架导航**开始**时就触发，比
						* `dom-ready` 早得多。而且 hook 是**幂等**的（自带 MARKER 标记），
						* 重复注入只是一次函数调用，代价极低。
						*
						* 另外每次导航也把「已就绪」重新置一下 —— 新页面需要重新探测输入框。
						*/
						element.addEventListener("did-start-navigation", (event) => {
							if (disposed) return;
							const e = event;
							/** 只关心主框架的**跨文档**导航（同文档 hash 变化不算）。 */
							if (e.isMainFrame === false || e.isSameDocument === true) return;
							console.log("[dsh-webin] 主框架开始导航，预注入 hook");
							/**
							* 这时新文档还没建立，注入大概率打在上一个文档上（无害，幂等）。
							* 真正的价值是**紧接着的 `dom-ready` 会立刻再注一次** ——
							* 两次机会总比一次好，而且这次能给日志一个明确的时间点。
							*/
							execJs(element, buildDeepSeekHook(provider.completionPath, provider.stopPath), 1e4).then((r) => {
								if (disposed) return;
								if (r !== EXEC_TIMEOUT) console.log("[dsh-webin] 预注入 hook:", r);
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
			/**
			* ## ⭐ Hook 自愈守护（**这是「收到 0 条」的根治手段**）
			*
			* ## 为什么不能只靠 `dom-ready` 注入
			*
			* hook 是**页面级**的，一次导航就没了。而 `dom-ready` 在页面主要资源
			* 加载完**之后**才触发 —— 此时页面自己的脚本（包括它发 completion
			* 请求的那段）**早就跑起来了**。于是：
			*
			*     t0  我们发消息 → 页面从 / 硬跳到 /a/chat/s/<id>
			*     t1  导航 ⇒ hook 被销毁
			*     t2  新页面起来，**立刻**发出 completion 请求 ← 此刻没有 hook
			*     t3  dom-ready 才到 ⇒ 我们补注入，但请求已经发完了
			*     t4  我们看不到任何 SSE ⇒ 收到 0 条 ⇒ DSH 一直等
			*
			* 用户实测就是这个：「一直深度求索中，网页版早就有回复和思考内容了，
			* 但就是不输出」。新会话（`freshChat`）**必然**走这条路。
			*
			* ## 为什么用「守护」而不是继续加事件监听
			*
			* 导航的触发方式太多（`did-start-navigation` / `did-navigate` /
			* SPA 硬跳 / 页面自己 `location.replace`），靠穷举事件永远有漏网。
			*
			* 所以改成**状态自愈**：每 1.5s 问一句「hook 还在吗」，
			* 不在就装上。判据是 hook 自己写在 window 上的标记 ——
			* 新文档里那个标记**必然**不存在，所以一定能测出来。
			*
			* 代价：每 1.5s 一次 `executeJavaScript`（读一个布尔值）。
			* 与「抓不到回复导致整轮失败」相比，这个代价可以忽略。
			*/
			(0, react.useEffect)(() => {
				if (!ready) return;
				let stopped = false;
				const ensureHook = () => {
					if (stopped) return;
					const el = hostRef.current?.querySelector("webview");
					if (el === null) return;
					execJs(el, `${MARKER_CHECK}`, 8e3).then((r) => {
						if (stopped) return;
						if (r === EXEC_TIMEOUT) return;
						/**
						* 返回 'true' = hook 在（新文档里标记不可能存在）。
						* 注意不能用 `if (!r)` —— 空字符串、'false' 都得重新注入。
						*/
						if (String(r) === "true") return;
						console.log("[dsh-webin] hook 不在（页面已导航），重新注入");
						return execJs(el, buildDeepSeekHook(provider.completionPath, provider.stopPath), 1e4).then((installed) => {
							if (stopped) return;
							console.log("[dsh-webin] hook 补注入:", installed);
						});
					}).catch(() => void 0);
				};
				ensureHook();
				const timer = window.setInterval(ensureHook, 1500);
				return () => {
					stopped = true;
					window.clearInterval(timer);
				};
			}, [
				ready,
				provider.id,
				provider.completionPath,
				provider.stopPath
			]);
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
			/**
			* 已经用 DOM 兜底捞过哪个任务。
			*
			* 防止同一个任务被反复捞 —— 每轮都去读 DOM 会把同一段内容重复交回去。
			* 主路径（hook 的 `done` 事件）拿到结果时也会清掉它。
			*/
			const scrapedRef = (0, react.useRef)(void 0);
			/**
			* 派发任务时页面上已有几条 assistant 回复。
			*
			* ## 为什么需要基线（而不是「内容变了」）
			*
			* 判断「本轮回复来了」最可靠的判据是**条数变多** ——
			* 只有真的新增一条 assistant 消息才会增长。
			* 而「内容变了」会被页面重渲染、动画、光标闪烁误触发。
			*
			* 所以发送前记下条数，之后等它超过这个基线。
			*/
			const baselineRef = (0, react.useRef)(0);
			/**
			* 派发任务时页面上最后一条回复的内容。
			*
			* ## 为什么条数之外还要记内容
			*
			* 「条数增长」是主判据，但有漏洞：如果页面把回复渲染在基线选择器
			* **匹配不到**的容器里（改版、A/B 测试），`count` 永远不增长，
			* 我们就会一直等到 5 分钟超时 —— 用户看到的是「一直等」。
			*
			* 记下基线内容后，只要页面上出现了**不一样的**内容就能交付。
			* 两个判据取「任一成立」，比只看条数稳得多。
			*/
			const baselineTextRef = (0, react.useRef)("");
			/**
			* 上一次 DOM 内容**发生变化**的时刻。
			*
			* ## 为什么记「变化时刻」而不是「上次读取时刻」
			*
			* 稳定性判据是「内容不再增长」。用「上次读取时刻」会被**读取频率**
			* 影响（每 1.5s 一轮）—— 内容其实早就停了，但因为我们刚读了一次，
			* 计时就重置，白等一轮。
			*
			* 记「上次变化时刻」才是真正的静默时长。
			*/
			const scrapedChangedAtRef = (0, react.useRef)(0);
			(0, react.useEffect)(() => {
				if (!ready) return;
				const timer = window.setInterval(() => {
					const el = hostRef.current?.querySelector("webview");
					if (el === null) return;
					/**
					* ⚠️ 用 `execJs`（带超时）。轮询是 500ms 一次，裸调用在页面导航时
					* 会堆积一堆永不 settle 的 Promise —— 每个都占着闭包和事件监听。
					* 超时给 10s（drain 只是读一个数组，正常是毫秒级）。
					*/
					execJs(el, buildDrainScript(), 1e4).then((raw) => {
						if (raw === EXEC_TIMEOUT) return;
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
									/**
									* ⚠️ 这里**只清 pending，不动基线**。
									*
									* 这是 drain 轮询 effect（与发送循环是两个独立 effect），
									* 基线（`baselineRef` / `baselineTextRef`）由**发送循环**在
									* 领活时设置。在这里清掉会让发送循环的「本轮回复来了吗」
									* 判据失效（它自己会在结束任务时通过 `clearPending()` 收口）。
									*/
									pendingJobRef.current = void 0;
									pendingSinceRef.current = 0;
									scrapedRef.current = void 0;
									/** 拿页面当前 URL（= 这条消息落地的对话页）。 */
									execJs(el, "location.href", 8e3).then((u) => u === EXEC_TIMEOUT ? "" : String(u)).then((chatUrl) => {
										fetchJson(`/dsh-webin/api/job/${jobId}/result`, {
											method: "PUT",
											headers: { "content-type": "application/json" },
											body: JSON.stringify({
												text: reply,
												think: String(ev.detail?.think ?? ""),
												status: String(ev.detail?.status ?? "finished"),
												...chatUrl === "" ? {} : { chatUrl }
											})
										});
									});
								}
							} else if (ev.name === "error") {
								console.warn("[dsh-webin] page reported error", ev.detail);
								const jobId = pendingJobRef.current;
								if (jobId !== void 0) {
									/** 同上：drain effect 只清 pending，不碰基线。 */
									pendingJobRef.current = void 0;
									pendingSinceRef.current = 0;
									scrapedRef.current = void 0;
									fetchJson(`/dsh-webin/api/job/${jobId}/result`, {
										method: "PUT",
										headers: { "content-type": "application/json" },
										body: JSON.stringify({ error: String(ev.detail?.message ?? "page error") })
									});
								}
							}
						}
					}).catch(() => void 0);
				}, DRAIN_INTERVAL_MS);
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
					/**
					* ⚠️ 每次心跳都**现读**这些值，而不是把它们放进依赖数组。
					*
					* ## 为什么（真实 bug）
					*
					* 早期把 `loggedIn` / `lastReply` / `replyCount` 放进依赖数组，
					* 于是**每来一条回复就重建整个 effect** —— 定时器被反复清掉重建。
					* 后果：心跳间隔变得不稳定（可能长达两倍），host 侧可能判定
					* 「面板掉线」，而且回复越多重建越频繁。
					*
					* 用 ref 保存最新值：effect 只在 `ready` / 平台变化时重建一次。
					*/
					const payload = {
						clientId,
						platform: provider.id,
						loggedIn: loggedInRef.current,
						hasGuest: el !== null,
						lastReplyAt: lastReplyAtRef.current,
						replyCount: replyCountRef.current,
						/**
						/**
						* ## ⭐ 抓取诊断 —— 让「页面上到底抓到了什么」可见
						*
						* ## 为什么加（用户：「不要猜」）
						*
						* 端到端测试抓到的是侧边栏而不是回复，但我**看不到**抓取脚本
						* 内部的判断过程 —— 只能改代码、重启、再看，一轮一轮猜。
						*
						* 把最近一次抓取的 `selector` / `count` / `root` / 内容长度
						* 跟着心跳送上来，`/status` 就能直接看到。
						*/
						scrape: scrapeDiagRef.current,
						/** ⭐ 页面结构报告（抓取失败时自动导出一次）。 */
						...domReportRef.current === void 0 ? {} : { dom: domReportRef.current }
					};
					fetch("/dsh-webin/api/client/heartbeat", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(payload)
					}).then((res) => res.ok ? res.json() : void 0).then((j) => {
						if (stopped || j === void 0 || typeof j.bundleRev !== "string") return;
						/**
						* ## ⭐⭐ 自动重载 v2 —— 判据是 **rev 变化**（修复死循环）
						*
						* ## ⚠️ v1 判据（builtAt vs mtime）造成**每 2 秒无限重载**
						*
						* 群友实测：面板每 2~2.2 秒重载一次、永不停止，甚至拖崩
						* DSH 桌面端。根因：`builtAt` 在**构建开始**算，`client.js`
						* 在**构建末尾**写盘 —— 机器稍慢差值就超 5 秒容差 ⇒
						* **永远判定落后** ⇒ 每次心跳都要求重载 ⇒ 死循环。
						*
						* ## v2：只比「rev 变没变」—— 自收敛
						*
						*   1. host 每次心跳回包都带当前产物 `bundleRev`
						*   2. 面板第一次收到时记下来（= 我加载时是哪个版本）
						*   3. 之后 rev **变了** ⇒ 真的出了新构建 ⇒ 才 reload
						*   4. reload 后加载到新 bundle ⇒ 记下的 rev 更新 ⇒ 停止
						*
						* **自收敛**：只有文件真的换了 rev 才会变。不需要任何持久化
						* （模块级变量就够了 —— reload 会重建模块，正好重置）。
						*
						* ⚠️ 有任务在跑时不重载 —— 否则打断正在生成的回复。
						*/
						if (loadedBundleRev.current === null) {
							/** 第一次心跳：记下「我加载时是哪个版本」。 */
							loadedBundleRev.current = j.bundleRev;
							return;
						}
						if (loadedBundleRev.current === j.bundleRev) return;
						if (pendingJobRef.current !== void 0) {
							console.log("[dsh-webin] 发现新构建，但当前有任务在跑 —— 等它结束再重载");
							return;
						}
						console.log("[dsh-webin] 发现新构建，自动重载页面", {
							mine: loadedBundleRev.current,
							latest: j.bundleRev
						});
						window.location.reload();
					}).catch(() => void 0);
				};
				beat();
				const timer = window.setInterval(beat, 5e3);
				return () => {
					stopped = true;
					window.clearInterval(timer);
				};
			}, [ready, provider.id]);
			(0, react.useEffect)(() => {
				if (!ready) return;
				let stopped = false;
				let busy = false;
				const tick = async () => {
					if (stopped || busy) return;
					/**
					* ## ⭐ 任务状态清理**只有一个出口**
					*
					* ## 为什么必须收口（审计发现的真实 bug）
					*
					* 领活后需要清三样：`pendingJobRef` / `scrapedRef` / `baseline*Ref`。
					* 原来这些清理**散落在 10 个地方**各写一遍，审计发现只有 1 处写全了 ——
					* 其余要么只清 `scrapedRef`，要么两个基线都不清。
					*
					* 后果很具体：**不清基线** ⇒ 下个任务领到时 `baselineRef` 还是
					* 上一轮的条数 ⇒ `countGrew` 一上来就成立 ⇒ 可能把**上一条回复**
					* 当成新回复交回去（张冠李戴，DSH 里出现答非所问的内容）。
					*
					* 所以收口成一个函数：**任何**结束任务的地方都调它，
					* 不再依赖「写代码的人记得清哪几个」。
					*/
					const clearPending = () => {
						pendingJobRef.current = void 0;
						pendingSinceRef.current = 0;
						scrapedRef.current = void 0;
						scrapedChangedAtRef.current = 0;
						baselineRef.current = 0;
						baselineTextRef.current = "";
					};
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
						* ## ⭐ 轮询页面 DOM 读回复（**主路径**）
						*
						* 用户的要求：「我想要的插件很简单，就是把网页版的内容，回显到 dsh
						* 的对话窗口中」。
						*
						* ## 为什么改成主路径
						*
						* 原来把「hook 抓 SSE」当主路径，DOM 只当 20 秒后的兜底。
						* 但抓 SSE 有个**解决不了的时序问题**（读 cuckoo 才看明白）：
						*
						*   cuckoo 能在页面脚本执行**之前**注入 hook，靠的是 **preload**
						*   （`src/bridge/entry.ts:52-68`）。而 DSH 的 webview 门禁
						*   （`lib/main.js:9690`）把 preferences 清空后只设固定几项，
						*   **`preload` 不在里面** —— 所以我只能等 `dom-ready`，
						*   那时页面脚本早已跑完、请求早已发出 ⇒ 永远「收到 0 条」。
						*
						* 而 DOM 里的内容**什么时候读都读得到**，不依赖任何注入时机。
						* cuckoo 自己也把 DOM 抓取当默认模式
						* （`src/providers/types.ts:72`：「默认 false = DOM 抓取」）。
						*
						* ## 怎么判断「本轮回复已经来了」
						*
						* 判据是**回复条数变多**（而不是「最后一条变了」）——
						* 后者在页面重渲染时会误判。所以派发任务前记下基线条数，
						* 之后等它增长。
						*
						* 同时要求「页面不再生成」（输入框可用）—— 否则会读到半截回复。
						* 这里不主动检测停止按钮（DeepSeek 上是纯图标，测不到），
						* 改用**连续两次读到相同内容**作为「已稳定」的判据。
						*/
						const waitedMs = Date.now() - pendingSinceRef.current;
						/**
						* 放弃门槛：**从配置读**，比 adapter 的 `timeoutMs` 早一点。
						*
						* ## 为什么不能硬编码（之前的缺陷）
						*
						* 原来写死 5 分钟。但配置里的 `replyTimeoutMs` 默认是 **10 分钟**
						* （注释记着「实测最慢一次网页回复 6 分 12 秒」）——
						* 于是慢回复会在 5 分钟被**提前掐断**，用户看到「超时」，
						* 而网页版其实还在正常生成。
						*
						* 现在按配置的 80% 算（留出余量让 adapter 那次超时不会先触发），
						* 用户调大「等回复超时」时这里跟着变。
						*
						* ⚠️ 用 `currentConfig()` 直接读，不用下面的 `cfgNow` ——
						* 那个变量在这个位置还没声明（会踩 TDZ）。
						*/
						const giveUpMs = Math.max(6e4, Math.round(currentConfig().replyTimeoutMs * .8));
						/**
						* ## ⭐⭐ 早期放弃：页面上一轮都没开始，就别等 8 分钟
						*
						* ## 为什么需要（用户报的核心问题）
						*
						* 用户的截图：**网页版里根本没有那条消息**，DSH 却一直「深度求索中」，
						* 直到超时才报错。
						*
						* 根因是「发送其实没成功，但插件以为成功了」。现在 trigger 会确认
						* （核对内容 + 探输入框清空），但**确认本身也可能被骗过**
						* （比如页面清空了输入框却没真发出去）。
						*
						* 所以再加一道：**发出后 30 秒内页面上必须出现「正在生成」的迹象** ——
						* 条数增长、或者内容变化、或者思考区出现。
						* 一样都没有 ⇒ 大概率根本没发出去 ⇒ **立刻报错**，让用户重试。
						*
						* 为什么是 30 秒：DeepSeek 正常几百毫秒内就会插入用户消息并开始
						* 渲染回复骨架。30 秒还没动静，基本可以断定没发出去。
						* 而正常生成中的页面**每 1.5 秒就会被我们读到内容变化**，不会误伤。
						*/
						const EARLY_GIVE_UP_MS = 3e4;
						if (hasPending && waitedMs > 3e3) {
							const jobId = pendingJobRef.current;
							const scrapedRaw = await execJs(el, buildScrapeScript(), 12e3);
							if (scrapedRaw !== EXEC_TIMEOUT) try {
								const scraped = JSON.parse(String(scrapedRaw));
								/**
								* ⭐ 记下抓取诊断 —— 跟着心跳上报，`/status` 直接可见。
								*
								* 这样「抓到侧边栏还是回复」不用猜：看 `selector` 和
								* `head` 就知道。
								*/
								scrapeDiagRef.current = {
									trace: Array.isArray(scraped.trace) ? (scraped.trace ?? []).slice(0, 8) : [],
									fallback: String(scraped.fallback ?? ""),
									selector: scraped.selector ?? "",
									count: typeof scraped.count === "number" ? scraped.count : -1,
									root: scraped.root ?? "",
									lastLen: typeof scraped.last === "string" ? scraped.last.length : -1,
									head: typeof scraped.last === "string" ? scraped.last.slice(0, 60) : "",
									at: Date.now()
								};
								/**
								* ## ⭐ 页面结构报告（用**提示词**做 needle，在流式期间抓）
								*
								* ## 为什么 needle 必须换（用户的关键观察）
								*
								* 用户指出：「网页版都是一个字一个字蹦出来的」——
								* 回复是**流式逐字渲染**的。这意味着：
								*
								*   1. 回复**确实在 DOM 里**（用户亲眼看得见）——
								*      我之前「消息不在 DOM 里」的结论是**错的**：
								*      那份报告是在**发消息前的一瞬**抓的快照，抓早了
								*   2. 之前 needle 用「抓到的内容前 20 字」——但抓到的是
								*      **侧边栏**，而 `innerText` 会把换行折叠/规范化，
								*      所以那个 needle 在页面上根本匹配不到（`needle 命中 0`
								*      的真正原因），「祖先链」自然是空的
								*
								* ## 现在的 needle
								*
								* 用**提示词本身** —— 它作为用户消息**一定**渲染在页面上，
								* 找到含它的最深元素，祖先链上就有「用户消息容器」，
								* 而**回复容器通常和它是兄弟**（同一个消息列表的相邻项）。
								*
								* ## 时机：流式期间抓，但**必须限流**
								*
								* 流式渲染意味着 DOM 每一刻都在变 —— 要在流式期间抓。
								* 但这份报告很重（全页遍历 + 15 秒超时的跨进程调用）——
								* **不限流的话 needle=0 时每 1.5 秒轮询都会跑一次** ⇒
								* tick 循环被拖死 ⇒ 心跳饿死 ⇒ 面板被判死 ⇒ 任务卡 claimed
								* （真实事故：job-5 卡 200 秒，面板心跳 44s 后消失）。
								*
								* 所以：**每 20 秒最多抓一次**，且命中 0 的报告不缓存当结论。
								*/
								if (scrapeDiagRef.current.selector === "longest-div" && Date.now() - domReportAtRef.current > 2e4 && (domReportRef.current === void 0 || domReportRef.current.needleHits === 0)) {
									/**
									* ⚠️ needle 用提示词的中段（前 20 字可能被输入框回显
									* 逻辑改写，中段更稳）；提示词太短时用全文。
									*/
									const p = promptRef.current;
									const needle = p.length > 24 ? p.slice(4, 20) : p;
									execJs(el, buildDomReportScript(needle), 15e3).then((domRaw) => {
										if (domRaw === EXEC_TIMEOUT) return;
										try {
											const parsed = JSON.parse(String(domRaw));
											domReportRef.current = parsed;
											domReportAtRef.current = Date.now();
											const hits = parsed.needleHits ?? 0;
											console.log("[dsh-webin] 页面结构已导出（needle=" + needle.slice(0, 12) + "… 命中 " + hits + "）");
										} catch {}
									}).catch(() => void 0);
								}
								const last = typeof scraped.last === "string" ? scraped.last : "";
								const think = typeof scraped.think === "string" ? scraped.think : "";
								const count = typeof scraped.count === "number" ? scraped.count : 0;
								/**
								* ## 本轮回复来了吗？—— 两个判据**任一**成立
								*
								*   1. **条数比基线多** —— 正常情况（新增了一条 assistant 消息）
								*   2. **内容与基线不同** —— 兜底：页面把回复渲染在基线选择器
								*      匹配不到的容器里、或者原地替换而不是追加
								*
								* 只判条数不够稳：选择器一旦没覆盖到真实容器，`count` 永远
								* 不增长，就会一直等到 5 分钟超时（用户看到的就是「一直等」）。
								* 加上内容比对后，只要页面上出现了**新的**内容就能交付。
								*
								* ## ⚠️⚠️ 这里原来还有一处 `last.length >= 8` —— 同一个 bug 的
								* **第二处残留**（第一处在抓取侧，已修）。
								*
								* 真实事故：问「写一句你好」，网页版答「你好。」—— **3 个字符**。
								* 抓取侧拿到了（lastLen=3），但这里 `last.length >= 8` 拒掉
								* ⇒ state=claimed 永远不交付 ⇒ **又卡 180 秒超时**。
								*
								* 教训：**同一个错误的判据会在多处复制** —— 修一处时必须
								* 全库搜同款。已在 verify-live 加断言防再犯。
								*/
								const countGrew = count > baselineRef.current;
								const contentChanged = last !== "" && last !== baselineTextRef.current;
								if (scraped.ok === true && last.length > 0 && (countGrew || contentChanged)) {
									/**
									* ## 稳定性判据：内容**不再增长**才算生成完
									*
									* ## 为什么不能只比「与上次相同」（审计发现的缺陷）
									*
									* 早期写法是「这次读到的 == 上次读到的」就交付。但那不够：
									* 流式输出**可能暂停**（网络抖动、服务端排队），暂停期间
									* 两次读到同样的半截内容 ⇒ **把半截回复交回 DSH**。
									*
									* 用户会看到回复被截断（而且 DSH 认为这轮已经结束了）。
									*
									* ## 现在的判据（两个都要满足）
									*
									*   1. 内容与上次**相同**（没有新增）
									*   2. **且**距离上次变化已超过 {@link STABLE_MS}（默认 3 秒）
									*
									* 用「上次变化时刻」而不是「上次读取时刻」—— 后者会被
									* 读取频率影响（1.5s 一轮），前者才是真正的「静默时长」。
									*
									* 代价是最快也要等 3 秒才交付 —— 相比「交半截回复」，
									* 这个代价完全值得。
									*/
									const now = Date.now();
									if (scrapedRef.current !== last) {
										/** 内容变了：记录新内容 + **变化时刻**，等下一轮。 */
										scrapedRef.current = last;
										scrapedChangedAtRef.current = now;
										return;
									}
									/** 内容没变 —— 还要确认已经静默够久。 */
									if (now - scrapedChangedAtRef.current < STABLE_MS) return;
									console.log("[dsh-webin] DOM 读到本轮回复", {
										chars: last.length,
										thinkChars: think.length,
										count,
										判据: countGrew ? "条数增长" : "内容变化",
										静默ms: now - scrapedChangedAtRef.current,
										selector: scraped.selector
									});
									clearPending();
									const chatUrlRaw = await execJs(el, "location.href", 8e3);
									const chatUrl = chatUrlRaw === EXEC_TIMEOUT ? "" : String(chatUrlRaw);
									await fetchJson(`/dsh-webin/api/job/${jobId}/result`, {
										method: "PUT",
										headers: { "content-type": "application/json" },
										body: JSON.stringify({
											text: last,
											think,
											status: "finished",
											via: "dom",
											...chatUrl === "" ? {} : { chatUrl }
										})
									});
									return;
								}
								/**
								* ## ⭐⭐ 早期放弃：发出后 30 秒页面还没动静 ⇒ 根本没发出去
								*
								* 见 `EARLY_GIVE_UP_MS` 的说明。这里只判「**一点动静都没有**」：
								*   - 条数没增长
								*   - 内容没变化
								*   - 连思考区都是空的
								*
								* 三者都不成立才继续等 —— 正常生成中一定会命中至少一个。
								*
								* ⚠️ 必须放在「交付判据」**之后**：先看有没有结果可交，
								* 没有再判是不是压根没发出去。
								*/
								if (waitedMs > EARLY_GIVE_UP_MS && !countGrew && !contentChanged && think.trim() === "") {
									console.warn("[dsh-webin] 发出后 30 秒页面无动静，判定没发出去", {
										waitedMs,
										count,
										baseline: baselineRef.current,
										lastChars: last.length
									});
									clearPending();
									await fetchJson(`/dsh-webin/api/job/${jobId}/result`, {
										method: "PUT",
										headers: { "content-type": "application/json" },
										body: JSON.stringify({ error: "消息似乎没有发出去：发出后 30 秒内网页版没有任何反应（既没有新消息，也没有开始生成）。请确认 LDW 页面正常后重试。" })
									});
									return;
								}
							} catch {}
						}
						if (hasPending && waitedMs > giveUpMs) {
							const stuck = pendingJobRef.current;
							console.warn("[dsh-webin] 待办超时，放弃任务", stuck, {
								waitedMs,
								giveUpMs
							});
							clearPending();
							await fetchJson(`/dsh-webin/api/job/${stuck}/result`, {
								method: "PUT",
								headers: { "content-type": "application/json" },
								body: JSON.stringify({ error: `等待网页回复超时（${Math.round(giveUpMs / 1e3)} 秒）。页面上没有可读取的回复内容 —— 请检查网页版里的状态。` })
							});
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
						/**
						* ## ⭐ 领活必须带上**本窗口的会话身份**（用户报的「所有窗口都生效」）
						*
						* host 据此只派发属于本会话的任务。不带的话任何窗口都能领走任何
						* 任务 —— 用户实测：「换了几个 dsh 窗口聊天，发现全都是在网页版的
						* 同一个会话窗口」。
						*
						* `sessionIdRef` 由 `LdwPlaceholder`（挂 `conversation.view`）从
						* DSH 给的 standardProps 写入 —— 是**官方 prop**，不是猜的。
						*
						* ⚠️ 没拿到时不带这个参数（host 退回按平台派发），
						* 而不是拿一个空串去匹配 —— 那会导致谁也领不到活。
						*/
						const sid = sessionIdRef.current;
						/**
						* ⚠️ **领活请求也必须带超时**（审计发现）。
						*
						* 裸 `await fetch` 在 host 卡住时会永远挂着 —— 而 `busy` 已经是
						* `true` ⇒ 发送循环**永久停摆**，且没有任何报错可捕获。
						* 超时后直接 return（下一轮 1.5s 后再试），循环保持活着。
						*/
						const res = await fetchJson("/dsh-webin/api/job/next?platform=" + encodeURIComponent(provider.id) + (sid === "" ? "" : "&session=" + encodeURIComponent(sid)) + (running === void 0 ? "" : "&running=" + encodeURIComponent(running)), void 0, 1e4);
						if (res === void 0 || !res.ok) return;
						const data = await res.json();
						if (typeof data.cancel === "string" && data.cancel !== "") {
							console.log("[dsh-webin] 任务已被取消，停止页面生成", data.cancel);
							clearPending();
							/**
							* ⚠️ 必须**一并清掉上一轮的比对状态**。
							*
							* 否则下一个任务会用「上一轮的内容」做稳定性比对 ——
							* `scrapedRef.current !== last` 立刻成立，可能把上一条回复
							* 当成新回复交回去（张冠李戴）。
							*/
							scrapedRef.current = void 0;
							baselineRef.current = 0;
							baselineTextRef.current = "";
							/** ⚠️ 带超时 —— 停止脚本卡住会让这个 tick 永远不返回。 */
							const stopResult = await execJs(el, buildStopScript(sendHintsFor(provider)), 1e4);
							console.log("[dsh-webin] 停止结果", stopResult === EXEC_TIMEOUT ? "超时" : stopResult);
							return;
						}
						if (hasPending) return;
						if (stopped || data.job === null || data.job === void 0) return;
						const { id, prompt } = data.job;
						/**
						* ⭐ 记下提示词 —— 诊断时用它做 needle。
						*
						* ## 为什么（用户的关键观察：「网页版都是一个字一个字蹦出来的」）
						*
						* 回复是**流式逐字渲染**的。这意味着：
						*   1. 回复**确实在 DOM 里**（用户看得见）—— 我之前「消息不在
						*      DOM 里」的结论是错的：那是**发消息前的一瞬**抓的快照
						*   2. 所以诊断的 needle 必须用**提示词本身**（它作为用户消息
						*      一定在页面上），而不是「上次抓到的内容」（那可能是侧边栏）
						*/
						promptRef.current = prompt;
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
							const currentRaw = await execJs(el, "location.href", 8e3);
							const current = currentRaw === EXEC_TIMEOUT ? "" : String(currentRaw);
							if (current !== data.job.expectUrl) {
								console.log("[dsh-webin] 切换到该会话的对话", {
									from: current.slice(-48),
									to: data.job.expectUrl.slice(-48)
								});
								await element_loadURL(el, data.job.expectUrl);
								if (!(await execJs(el, `(function () {
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
                })()`, 3e4) === true)) console.warn("[dsh-webin] 导航后未见输入框，仍尝试发送");
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
							const currentRaw = await execJs(el, "location.href", 8e3);
							const current = currentRaw === EXEC_TIMEOUT ? "" : String(currentRaw);
							if (/\/a\/chat\/s\//.test(current)) {
								console.log("[dsh-webin] 首轮：开新对话（不占用当前页）", { from: current.slice(-48) });
								await element_loadURL(el, provider.homeUrl);
								if (await execJs(el, `(function () {
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
                })()`, 3e4) !== true) console.warn("[dsh-webin] 新对话页未见输入框，仍尝试发送");
							}
						}
						pendingJobRef.current = id;
						pendingSinceRef.current = Date.now();
						scrapedRef.current = void 0;
						/**
						* 记下「派发前页面上已有几条回复」—— 之后靠条数增长判断本轮回复到位。
						*
						* 取不到就保守用 0（那样只要页面上有一条够长的内容就会被当成本轮结果）。
						* 代价是可能把上一条回复误交回去，所以**发送前**读更稳 ——
						* 此刻页面还没生成新内容。
						*/
						{
							const baseRaw = await execJs(el, buildScrapeScript(), 8e3);
							if (baseRaw !== EXEC_TIMEOUT) try {
								const base = JSON.parse(String(baseRaw));
								baselineRef.current = typeof base.count === "number" ? base.count : 0;
								baselineTextRef.current = typeof base.last === "string" ? base.last : "";
								/** 基线读完就重置「变化时刻」—— 新任务从此刻开始算静默。 */
								scrapedChangedAtRef.current = Date.now();
							} catch {
								baselineRef.current = 0;
								baselineTextRef.current = "";
								scrapedChangedAtRef.current = Date.now();
							}
							else {
								/**
								* ## ⚠️ 基线读取**超时**时必须也重置（修掉的真实 bug）
								*
								* 早期这个分支**什么都不做** —— 于是 `baselineRef` 保留
								* **上一轮**的值。而 `scrapedRef` 在上面已经清成 `undefined`。
								*
								* 后果很隐蔽：
								*   - 上一轮结束时页面有 5 条回复 ⇒ `baselineRef = 5`
								*   - 本轮页面也是 5 条（新回复还没渲染）⇒ `countGrew = false`
								*   - `baselineTextRef` 还是上一轮的内容 ⇒ 若内容恰好相同，
								*     `contentChanged = false`
								*   - ⇒ **两个判据都不成立**，一路等到早放弃 / 超时
								*
								* 用户看到的就是「网页版早就有答案了，DSH 还在等」。
								*
								* 重置成 0 的代价：本轮可能把「页面上最长的那条内容」当成本轮结果。
								* 但这有 `STABLE_MS` 静默判据兜底，而且**比卡死好** ——
								* 卡死是用户明确报过的、最难受的现象。
								*/
								console.warn("[dsh-webin] 基线读取超时，重置为 0（宁可放宽也不卡死）");
								baselineRef.current = 0;
								baselineTextRef.current = "";
								scrapedChangedAtRef.current = Date.now();
							}
						}
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
							clearPending();
							await fetchJson(`/dsh-webin/api/job/${id}/result`, {
								method: "PUT",
								headers: { "content-type": "application/json" },
								body: JSON.stringify({ error: `本轮请求数已达上限（${currentConfig().maxRequestsPerTurn}），可在设置页调整` })
							});
							return;
						}
						noteTurnRequest();
						const cfgNow = currentConfig();
						const breakMs = noteRequestDone();
						if (breakMs > 0) {
							/**
							* ## ⚠️ 长休必须**分段睡**，不能一觉睡到底（审计发现的 bug）
							*
							* 原实现是 `await new Promise(r => setTimeout(r, breakMs))` ——
							* 一口气睡最多 **3 分钟**（`longBreakMaxMs` 默认 180000）。
							* 那段时间里 `busy` 一直是 `true`，于是：
							*
							*   1. **用户按停止看不到反应** —— 循环在睡觉，不会去问 host
							*      「这个任务取消了吗」，页面继续白生成、烧配额；
							*   2. 用户切到别的 DSH 会话后，这个任务醒来仍会往**当前页面**发
							*      （而当前页面可能已经换成另一个会话的对话）⇒ 串台。
							*
							* 改成每 2 秒醒一次检查取消；被取消就立刻停止发送并交结果。
							* 这样「长休」只影响**发送时机**，不影响响应性。
							*/
							console.log(`[dsh-webin] 长休 ${Math.round(breakMs / 1e3)}s（每 ${cfgNow.longBreakAfter} 次请求休息一次）`);
							const deadline = Date.now() + breakMs;
							let cancelledDuringBreak = false;
							while (Date.now() < deadline) {
								await new Promise((r) => setTimeout(r, Math.min(2e3, deadline - Date.now())));
								if (stopped) return;
								/** 醒来先问一次「这个任务还算数吗」。 */
								const probe = await fetchJson(`/dsh-webin/api/job/next?platform=${encodeURIComponent(provider.id)}&running=${encodeURIComponent(id)}`, void 0, 8e3);
								if (probe !== void 0 && probe.ok) try {
									const p = await probe.json();
									if (typeof p.cancel === "string" && p.cancel !== "") {
										console.log("[dsh-webin] 长休期间任务被取消，放弃发送", p.cancel);
										cancelledDuringBreak = true;
										break;
									}
								} catch {}
							}
							if (cancelledDuringBreak) {
								/**
								* ⚠️ 被取消时**不交结果** —— host 那边已经把这个任务标记为
								* cancelled 并让调用方报错退出了，再交一次结果会 404
								* （或者更糟：覆盖掉真正的结果）。
								*/
								clearPending();
								return;
							}
						}
						/**
						* ## 先把页面的思考模式切到期望状态
						*
						* 「点的思考模式那个模型，发现没有思考啊」—— 根因是 host 把
						* `job.thinking` 传过来了，但这里**从来没用它做任何事**。
						*
						* ⚠️ 必须在**发送之前**做：思考模式是请求体的一部分，
						* 发出去之后再切就晚了（这一轮已经按旧模式跑了）。
						*
						* 切不动时**不阻断发送** —— 思考与否是增强，不是必需。
						* 但要明确告诉用户（否则又是一次「点了没反应」的静默失败）。
						*/
						try {
							const thinkRaw = await execJs(el, buildThinkingScript(data.job.thinking === true), 2e4);
							if (thinkRaw === EXEC_TIMEOUT) console.warn("[dsh-webin] 思考模式脚本超时，跳过（不阻断发送）");
							else {
								const think = JSON.parse(String(thinkRaw));
								if (think.ok === true) {
									if (think.changed === true) console.log(`[dsh-webin] 思考模式已切换 ${think.before} → ${think.after}`, { 开关: think.text });
								} else {
									console.warn("[dsh-webin] 思考模式未能切换", think);
									setLastSend({
										at: (/* @__PURE__ */ new Date()).toLocaleTimeString("zh-CN", { hour12: false }),
										how: `思考模式未切换（${think.reason ?? "未知"}）`,
										chars: 0
									});
								}
							}
						} catch (error) {
							console.warn("[dsh-webin] 思考模式脚本失败", error);
						}
						/**
						* ## ⚠️ 用 `execJs` 而不是裸 `executeJavaScript`
						*
						* ## 三步拆开（照 cuckoo 的架构重构）
						*
						* 原来把「填充 → 等 2.4s 验证 → 可能再等 1.2s 重试」全塞进**一次**
						* `executeJavaScript`。那是跨进程调用，页面一导航就整体死掉
						* （不 resolve / 不 reject）⇒ 宿主永远等 ⇒「一直深度求索中」。
						*
						* cuckoo 的做法（`src/overlay/chat-input.ts:137-171`）：
						*
						*     const timer = setTimeout(() => triggerSend(input), sendDelay)
						*     return true        // ← 立刻返回，不等任何确认
						*
						* 即：**页面脚本只做瞬时动作，等待在客户端**。
						* 所以这里拆成三个短调用，中间由客户端控制节奏：
						*
						*     ① buildFillScript    —— 只填（几百毫秒）
						*     ② setTimeout          —— 随机延迟（防封号，客户端侧）
						*     ③ buildTriggerScript —— 只点发送（几十毫秒）
						*
						* 这样导航最多毁掉一次短调用，不会让整条链路僵死。
						*/
						const fillRaw = await execJs(el, buildFillScript(prompt, sendHintsFor(provider)), 3e4);
						if (fillRaw === EXEC_TIMEOUT) {
							clearPending();
							await fetchJson(`/dsh-webin/api/job/${id}/result`, {
								method: "PUT",
								headers: { "content-type": "application/json" },
								body: JSON.stringify({ error: "填充输入框超时（页面可能正在导航），请重试。" })
							});
							return;
						}
						const fill = JSON.parse(String(fillRaw));
						console.log("[dsh-webin] 填充结果", fill);
						if (!fill.ok) {
							clearPending();
							await fetchJson(`/dsh-webin/api/job/${id}/result`, {
								method: "PUT",
								headers: { "content-type": "application/json" },
								body: JSON.stringify({ error: `${fill.stage ?? "fill-failed"}: ${fill.message ?? "填充失败"}` })
							});
							return;
						}
						/**
						* ② 随机延迟 —— **在客户端侧**（cuckoo 同款）。
						*
						* 页面脚本不该长时间持有 Promise：延迟放这里，
						* 单次 executeJavaScript 的存活时间就只有几十毫秒。
						*/
						const gapMs = pickSendDelay(cfgNow.sendDelayMinMs, cfgNow.sendDelayMaxMs);
						console.log(`[dsh-webin] 已填入 ${fill.chars ?? prompt.length} 字符，${gapMs}ms 后触发发送`);
						await new Promise((r) => setTimeout(r, gapMs));
						/**
						* ## ⚠️ 点火前**最后一次检查**（审计发现的 bug）
						*
						* 从「填完字」到「真的按发送」之间隔了 2–4 秒。这段时间里用户可能：
						*   - 按了停止（host 把任务标记为 cancelled）
						*   - 切到别的 DSH 会话（当前网页对话已经不是这个任务该在的地方）
						*
						* 两种情况下都**不该再发出去** —— 否则要么发一条用户已经取消的消息，
						* 要么把内容发进**错误的对话**（上下文串台，用户实测报过这个）。
						*
						* 检查到取消就**清空输入框**（把已经填进去的字删掉，避免用户手动
						* 误发一条半截内容）。
						*/
						{
							const probe = await fetchJson(`/dsh-webin/api/job/next?platform=${encodeURIComponent(provider.id)}&running=${encodeURIComponent(id)}`, void 0, 8e3);
							if (probe !== void 0 && probe.ok) try {
								const p = await probe.json();
								if (typeof p.cancel === "string" && p.cancel !== "") {
									console.log("[dsh-webin] 点火前发现任务已取消，撤销发送", p.cancel);
									/** 清掉已填入的内容 —— 不要留下一条随时可能被误发的半截消息。 */
									await execJs(el, buildClearInputScript(sendHintsFor(provider)), 8e3);
									clearPending();
									return;
								}
							} catch {}
							if (stopped) return;
						}
						/**
						* ③ 触发发送 —— **并确认页面真的接受了**。
						*
						* ## ⭐ 为什么现在要确认（用户报的「网页版早就有答案了，dsh 还在深度求索」）
						*
						* 早期这一步点完就返回 `ok:true`，**从不验证**。于是「点了但没生效」
						* （按钮被遮挡 / 是禁用态 / 点错了元素）时，插件以为发出去了，
						* 一路等一个**永远不会来的回复**。
						*
						* 用户看到的现象正是：
						*   - 网页版里**根本没有那条消息**（输入框还留着字，或者已被清空但没发）
						*   - DSH 一直「深度求索中」，直到超时
						*
						* 现在 `buildTriggerScript` 内部会等 1.2 秒探「输入框是否被清空」
						* （页面接受发送时一定会清空），失败就 `ok:false` ⇒ 这里立刻交错误。
						*
						* 超时给 15 秒：脚本内部最多等 1.2 秒，剩下的是跨进程开销余量。
						*/
						const trigRaw = await execJs(
							el,
							/**
							* ⚠️ 把**要发的字**传进去（第三个参数）—— trigger 会先核对
							* 输入框里确实是这段内容才点火。
							*
							* 原因：fill 和 trigger 之间隔 2–4 秒，页面可能重渲染换掉
							* 输入框节点。不核对的话会发空消息或什么都不发生，而插件不知道，
							* 继续等一个永远不会来的回复（用户报的「网页版里没那条消息」）。
							*/
							buildTriggerScript(sendHintsFor(provider), prompt),
							15e3
						);
						const trig = trigRaw === EXEC_TIMEOUT ? {
							ok: false,
							how: "timeout",
							message: "触发发送超时（页面可能正在导航）"
						} : JSON.parse(String(trigRaw));
						console.log("[dsh-webin] 触发结果", trig);
						if (trig.ok !== true) {
							clearPending();
							/**
							* 错误信息要**能照做** —— 用户看到「发送失败」时得知道下一步。
							*
							* 两种常见失败分开说：
							*   - `input-lost`      字不见了（页面重渲染）⇒ 重试
							*   - `input-not-cleared` 点了但没生效 ⇒ 重试
							*/
							const detail = trig.reason === "input-lost" ? "输入框里的内容在发送前丢失了（页面重渲染）—— 消息没有发出去，请重试。" : trig.reason === "input-not-cleared" ? "消息没有真正发出去（输入框没被清空）。可能是页面还没就绪或按钮被遮挡，请重试。" : trig.message ?? "触发发送失败";
							await fetchJson(`/dsh-webin/api/job/${id}/result`, {
								method: "PUT",
								headers: { "content-type": "application/json" },
								body: JSON.stringify({ error: `send-failed: ${detail}` })
							});
							return;
						}
						/**
						* 发送已触发。
						*
						* `sentAtRef` 是「只接受此刻之后的 done 事件」的时间基准；
						* 同时它也被下面的 **DOM 轮询**当成「什么时候可以开始读回复」的起点。
						*
						* ⚠️ 这里**不代表发送一定成功** —— cuckoo 也不验证（点完就算发了）。
						* 我们靠后续的 DOM 轮询来确认「页面上真的出现了新回复」。
						*/
						sentAtRef.current = Date.now();
						setLastSend({
							at: (/* @__PURE__ */ new Date()).toLocaleTimeString("zh-CN", { hour12: false }),
							/** 现在能说「已确认」了 —— `buildTriggerScript` 探过输入框是否被清空。 */
							how: `${trig.method ?? trig.how ?? "?"}（已确认发出，等待页面回复）`,
							chars: prompt.length
						});
					} catch (error) {
						/**
						* ## ⚠️ 异常**必须交回 host**，否则 DSH 永远等
						*
						* 用户实测：网页版那边回复已经完成了，但 DSH 一直转圈等到超时。
						*
						* 根因就在这里 —— 早期实现只打一行日志：
						*
						*     } catch (error) {
						*       console.warn('[dsh-webin] 任务处理失败', error)   // ← pendingJobRef 已置位
						*     }
						*
						* 此时 `pendingJobRef` 已经有值（领到任务时就置了），而结果**永不交回**
						* ⇒ host 侧一直等 ⇒ DSH 一直等。任何异常都会触发：
						* `executeJavaScript` 超时、页面在发送途中导航、`JSON.parse` 失败…
						*
						* 而且下一轮 `tick` 因为 `hasPending` 为真**再也不领新活**，
						* 整个链路就此僵死。
						*
						* 所以：异常也要把任务了结掉（交个错误），并**清掉待办**。
						*/
						console.warn("[dsh-webin] 任务处理失败", error);
						const stuck = pendingJobRef.current;
						clearPending();
						if (stuck !== void 0) fetchJson(`/dsh-webin/api/job/${stuck}/result`, {
							method: "PUT",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ error: `客户端处理异常：${error?.message ?? String(error)}` })
						});
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
					/** ⚠️ 带超时 —— 这个每 30s 跑一次，裸调用会在导航时堆积死掉的 Promise。 */
					execJs(el, buildSnapshotScript(), 1e4).then(async (raw) => {
						if (stopped) return;
						if (raw === EXEC_TIMEOUT) return;
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
						/**
						* ## ⭐ 顺便让 host 抓一次**含 httpOnly** 的 cookie
						*
						* 页面侧的 `document.cookie` 看不见 httpOnly —— 而那正是
						* DeepSeek 登录态的载体。host 半跑在 Electron 主进程里，
						* 能用 `session.fromPartition(partition).cookies` 读到全部。
						*
						* partition 名已经由 client 在挂载 webview 时上报过，
						* 所以这里只需要说一句「现在存」。
						*
						* ⚠️ 失败**不影响**页面快照（那是另一条独立的恢复路径）——
						* 拿不到 electron API 时这里会 501，属于预期降级。
						*/
						fetchJson(`/dsh-webin/api/auth/${encodeURIComponent(provider.id)}/cookies`, { method: "POST" }).then((res) => {
							if (stopped || res === void 0) return;
							if (!res.ok) {
								/** 501 = 环境不支持（纯 node）；409 = 还没上报 partition。都不是致命错。 */
								console.log("[dsh-webin] cookie 存档跳过", res.status);
								return;
							}
							res.json().then((j) => {
								console.log("[dsh-webin] httpOnly cookie 已存档", {
									count: j.count ?? 0,
									domain: j.domain ?? ""
								});
							}).catch(() => void 0);
						});
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
							/**
							* ## 诊断要回答「DOM 抓取到底看到了什么」
							*
							* 现在整个设计押在 DOM 抓取上，所以诊断必须包含它 ——
							* 否则用户说「还是不行」时我只能靠猜。
							*
							* 两份数据合并：
							*   1. `buildDiagnoseScript` —— 输入框/按钮/POST 路径
							*   2. `buildScrapeScript`   —— **它实际读到了哪几条回复**
							*      （`count` / `selector` / 每条的长度与前 80 字）
							*/
							(async () => {
								try {
									const raw = await execJs(el, buildDiagnoseScript(sendHintsFor(provider)), 15e3);
									const base = raw === EXEC_TIMEOUT ? "{\"error\":\"诊断脚本超时\"}" : String(raw);
									const scrapeRaw = await execJs(el, buildScrapeScript(), 12e3);
									/**
									* ## ⭐ 导出页面真实结构（发现类名，而不是猜）
									*
									* ## 为什么必须做（trace 给出的决定性证据）
									*
									* 端到端跑完读 trace，拿到：
									*
									*     .ds-markdown          → found: 0
									*     [class*="markdown"]   → found: 0   ← 极宽泛的匹配也是 0！
									*     root: "body"                        ← 没有 main
									*
									* `[class*="markdown"]` 命中 0 说明页面上**根本没有**
									* 带 "markdown" 的类名 —— 我的候选表整个是错的。
									*
									* 继续猜没意义，所以这里把结构导出来：
									*   - `chain`：含「最后一条回复文字」的元素祖先链
									*     ⇒ 回复容器与消息列表容器都在这条链上
									*   - `topClasses`：出现 >= 2 次的类名频次
									*   - `cands`：各候选选择器**实际命中几个**
									*
									* needle 用「最后一条回复的前 20 字」—— 那是页面上
									* 一定存在的文字，用它反查容器最可靠。
									*/
									const scrapeForNeedle = scrapeRaw === EXEC_TIMEOUT ? "" : (() => {
										try {
											const s = JSON.parse(String(scrapeRaw));
											return String(s.last ?? "").slice(0, 20);
										} catch {
											return "";
										}
									})();
									const domRaw = await execJs(el, buildDomReportScript(scrapeForNeedle), 15e3);
									let merged = base;
									try {
										const parsed = JSON.parse(base);
										if (domRaw !== EXEC_TIMEOUT) try {
											parsed.dom = JSON.parse(String(domRaw));
										} catch {
											parsed.dom = { error: "DOM 报告 JSON 解析失败" };
										}
										if (scrapeRaw !== EXEC_TIMEOUT) {
											const s = JSON.parse(String(scrapeRaw));
											parsed.scrape = {
												ok: s.ok === true,
												/** 读到几条回复 —— 这里若是 0，说明选择器没匹配上。 */
												count: s.count ?? 0,
												/** 命中的选择器（`longest-div` = 走了兜底）。 */
												selector: s.selector ?? "",
												最后一条长度: (s.last ?? "").length,
												最后一条开头: (s.last ?? "").slice(0, 80),
												思考长度: (s.think ?? "").length
											};
										} else parsed.scrape = { error: "DOM 抓取脚本超时" };
										merged = JSON.stringify(parsed, null, 2);
									} catch {}
									setDiagnosis(merged);
									console.log("[dsh-webin] 页面结构诊断", merged);
								} catch (e) {
									setDiagnosis(`诊断失败：${String(e)}`);
								}
							})();
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
		* 1. **`register` 必须带 `name` 字段**（就是 slot 名）—— 少了它注册不上，
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
			/** 版本 + 更新检查状态。 */
			const [ver, setVer] = (0, react.useState)(null);
			const [checking, setChecking] = (0, react.useState)(false);
			const [checkNote, setCheckNote] = (0, react.useState)("");
			/**
			* 拉版本信息。
			*
			* ⚠️ `check=1` 才真的打 GitHub —— 默认只回本地版本。
			* 未认证的 API 每小时 60 次配额，设置页一打开就查会很快打光。
			*/
			const loadVersion = (0, react.useMemo)(() => async (check) => {
				if (check) setChecking(true);
				try {
					/**
					* ⚠️ **必须带超时**（真实 bug）。
					*
					* 早期直接 `await fetch(...)` —— 而 `?check=1` 会让 host 去问
					* GitHub。国内网络下那次请求**可能一直挂着不报错**，
					* 于是这个 fetch 永不返回 ⇒ 按钮永远显示「检查中…」。
					*
					* 用户报的就是这个：「插件更新的逻辑貌似有bug」。
					*
					* host 侧那次请求自己有 10 秒超时，这里给 20 秒（留出余量），
					* 兜住「host 整个卡住」的情况。
					*/
					const res = await fetchJson(`${LDW_API}/version${check ? "?check=1" : ""}`, void 0, 2e4);
					if (res === void 0) {
						if (check) setCheckNote("检查失败：请求超时（host 无响应）");
						return;
					}
					const data = await res.json();
					setVer({
						version: String(data.version ?? "?"),
						commit: String(data.commit ?? "?"),
						repo: String(data.repo ?? ""),
						repoUrl: String(data.repoUrl ?? ""),
						starUrl: String(data.starUrl ?? ""),
						updateHint: String(data.updateHint ?? ""),
						builtAt: String(data.builtAt ?? ""),
						...data.update === void 0 ? {} : { update: data.update }
					});
					if (check) {
						/**
						* 用 host 给的一句话总结（四种状态分开说）。
						*
						* 早期这里自己拼：「behind ? 有新提交 : 已是最新」——
						* 于是「本地比远端新」（自己提交了没推）也显示成「已是最新」，
						* 用户会困惑「我明明改了代码」。
						*/
						const summary = data.updateSummary;
						setCheckNote(typeof summary === "string" && summary !== "" ? summary : data.update?.ok !== true ? `检查失败：${data.update?.reason ?? "未知原因"}` : data.update?.behind === true ? `有新提交 ${data.update.latestCommit}` : data.update?.ahead === true ? "本地更新（远端还没有你的提交）" : "已是最新");
					}
				} catch (error) {
					if (check) setCheckNote(`检查失败：${error?.message ?? String(error)}`);
				} finally {
					if (check) setChecking(false);
				}
			}, []);
			(0, react.useEffect)(() => {
				loadVersion(false);
			}, [loadVersion]);
			const refresh = (0, react.useMemo)(() => async () => {
				try {
					const data = await (await fetch(`${LDW_API}/providers`)).json();
					setState({
						providers: Array.isArray(data.providers) ? data.providers : [],
						customIds: Array.isArray(data.customIds) ? data.customIds : [],
						defaultProviderId: String(data.defaultProviderId ?? ""),
						errors: Array.isArray(data.errors) ? data.errors : [],
						clients: Array.isArray(data.clients) ? data.clients : [],
						loggedInPlatforms: Array.isArray(data.loggedInPlatforms) ? data.loggedInPlatforms : []
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
			/**
			* ---- 首次读取：骨架屏 ----
			*
			* 不用「正在读取…」一行字 —— 骨架屏能让布局提前稳定，
			* 数据到位时不会整页跳动。
			*/
			if (state === null) return (0, react.createElement)("div", { className: "ldw-set" }, (0, react.createElement)("div", { className: "ldw-hero" }, (0, react.createElement)("div", { className: "ldw-pagehead" }, (0, react.createElement)("div", { className: "ldw-pagetitle" }, (0, react.createElement)("h2", null, "LDW · 网页版接入"), (0, react.createElement)("p", { className: "ldw-pagesub" }, "正在读取平台与配置…")))), (0, react.createElement)("div", { className: "ldw-grid" }, ...[0, 1].map((i) => (0, react.createElement)("div", {
				key: i,
				className: "ldw-card"
			}, (0, react.createElement)("div", {
				className: "ldw-skeleton",
				style: { width: "55%" }
			}), (0, react.createElement)("div", {
				className: "ldw-skeleton",
				style: { width: "85%" }
			}), (0, react.createElement)("div", {
				className: "ldw-skeleton",
				style: { width: "70%" }
			})))));
			/** 有浏览器在线且已登录的平台数 —— 页头状态点用。 */
			const liveCount = state.clients.filter((c) => c.loggedIn).length;
			const customCount = state.providers.filter((p) => state.customIds.includes(p.id)).length;
			/** 每个平台一张卡片。 */
			const cards = state.providers.map((p) => {
				const beats = state.clients.filter((c) => c.platform === p.id);
				const loggedIn = beats.some((c) => c.loggedIn);
				const live = beats.length > 0;
				const isCustom = state.customIds.includes(p.id);
				/** 状态点：在线且登录=ok；在线未登录=warn；不在线=灰。 */
				const dot = live ? loggedIn ? "ok" : "warn" : "";
				const statusText = live ? loggedIn ? "已登录" : "未登录" : "浏览器未打开";
				return (0, react.createElement)(
					"div",
					{
						key: p.id,
						className: "ldw-card"
					},
					(0, react.createElement)("div", { className: "ldw-card-head" }, (0, react.createElement)("span", { className: `ldw-dot ${dot}`.trim() }), (0, react.createElement)("span", { className: "ldw-card-name" }, p.name), (0, react.createElement)("span", { className: "ldw-card-id" }, p.id), (0, react.createElement)("span", { className: "ldw-tag" + (isCustom ? " warn" : "") }, isCustom ? "自定义" : "内置")),
					(0, react.createElement)("div", { className: "ldw-rows" }, row("状态", statusText), row("地址", p.homeUrl), row("模型", p.models.map((m) => m.name).join("、") || "（无）"), row("上下文", `${p.contextWindow.toLocaleString()} token`)),
					/**
					* 只有**自定义**项能删 —— 内置项删不掉（删了下次启动还在），
					* 给它一个按钮只会让人困惑。要改内置项就用同 id 覆盖。
					*/
					isCustom ? (0, react.createElement)("div", { className: "ldw-actions" }, (0, react.createElement)("button", {
						type: "button",
						className: "ldw-btn danger",
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
				const rangeText = limit === void 0 ? "" : `${Math.round(limit.min / scale)}~${Math.round(limit.max / scale)}${unit}`;
				/** 布尔字段：用开关（与参考实现的 Switch 同款交互）。 */
				if (spec.bool === true) return (0, react.createElement)("div", {
					key: spec.key,
					className: "ldw-fieldrow"
				}, (0, react.createElement)("button", {
					type: "button",
					className: "ldw-switch",
					role: "switch",
					"aria-checked": value === true ? "true" : "false",
					onClick: () => setField(spec.key, value !== true)
				}, (0, react.createElement)("i"), (0, react.createElement)("span", { className: "ldw-field-label" }, spec.label)), (0, react.createElement)("span"), (0, react.createElement)("span", { className: "ldw-hint" }, spec.hint ?? ""));
				return (0, react.createElement)("div", {
					key: spec.key,
					className: "ldw-fieldrow"
				}, (0, react.createElement)("span", { className: "ldw-field-label" }, spec.label), (0, react.createElement)("span", { className: "ldw-field-inline" }, (0, react.createElement)("input", {
					type: "number",
					className: "ldw-num",
					value: scale === 1e3 ? Math.round(Number(value) / scale) : Number(value),
					min: limit === void 0 ? void 0 : Math.round(limit.min / scale),
					max: limit === void 0 ? void 0 : Math.round(limit.max / scale),
					step: 1,
					onChange: (e) => {
						const n = Number(e.target.value);
						if (!Number.isFinite(n)) return;
						setField(spec.key, Math.round(n * scale));
					}
				}), (0, react.createElement)("span", { className: "ldw-unit" }, unit)), (0, react.createElement)("span", { className: "ldw-hint" }, [rangeText, spec.hint].filter((s) => s !== void 0 && s !== "").join(" · ")));
			};
			/** 配置表单（三个分组）。 */
			const configForm = form === null ? (0, react.createElement)("p", { className: "ldw-note" }, "正在读取配置…") : (0, react.createElement)("div", { style: {
				display: "flex",
				flexDirection: "column",
				gap: 18
			} }, ...FIELD_GROUPS.map((group) => (0, react.createElement)("div", {
				key: group.title,
				className: "ldw-group"
			}, (0, react.createElement)("h4", { className: "ldw-group-title" }, group.title), (0, react.createElement)("p", { className: "ldw-note" }, group.note), ...group.fields.map(renderField))), (0, react.createElement)("div", { className: "ldw-actions" }, (0, react.createElement)("button", {
				type: "button",
				className: "ldw-btn primary",
				disabled: busy,
				onClick: () => void saveConfig()
			}, busy ? "处理中…" : "保存配置"), (0, react.createElement)("button", {
				type: "button",
				className: "ldw-btn",
				disabled: busy,
				onClick: () => void resetConfig()
			}, "恢复默认"), (0, react.createElement)("span", {
				className: "ldw-note",
				style: { marginLeft: "auto" }
			}, "改完立刻生效，不用重启")), problems.length > 0 ? (0, react.createElement)("div", { className: "ldw-callout" }, (0, react.createElement)("div", null, (0, react.createElement)("strong", null, `${problems.length} 项被修正`), (0, react.createElement)("ul", null, ...problems.map((p, i) => (0, react.createElement)("li", { key: i }, `${p.field}：${p.reason}`))))) : null);
			return (0, react.createElement)("div", { className: "ldw-set" }, (0, react.createElement)(
				"header",
				{ className: "ldw-hero" },
				(0, react.createElement)("div", { className: "ldw-pagehead" }, (0, react.createElement)("div", { className: "ldw-pagetitle" }, (0, react.createElement)("h2", null, "LDW · 网页版接入"), (0, react.createElement)("p", { className: "ldw-pagesub" }, "用真实浏览器驱动 AI 网页版 —— 真实登录、真实输入、真实发送，回复由页面自己的 SSE 读出。")), (0, react.createElement)("div", { className: "ldw-pills" }, (0, react.createElement)("span", { className: "ldw-pill strong" }, (0, react.createElement)("span", { className: `ldw-dot ${liveCount > 0 ? "ok" : ""}`.trim() }), liveCount > 0 ? `${liveCount} 个已登录` : "浏览器未打开"), (0, react.createElement)("span", { className: "ldw-pill" }, `${state.providers.length} 个平台`), customCount > 0 ? (0, react.createElement)("span", { className: "ldw-pill" }, `${customCount} 个自定义`) : null)),
				/**
				* 版本行 —— 放在 hero 里（页头第二行）。
				*
				* 三样东西并排：当前版本、检查更新、去 GitHub 点 Star。
				* 都在这一个位置，因为它们是同一类「关于这个插件」的操作。
				*/
				(0, react.createElement)(
					"div",
					{ className: "ldw-verline" },
					(0, react.createElement)(
						"span",
						{ className: "ldw-ver" },
						(0, react.createElement)("span", { className: "ldw-ver-num" }, `v${ver?.version ?? "?"}`),
						(0, react.createElement)("code", { className: "ldw-ver-commit" }, ver?.commit ?? "?"),
						/**
						* 构建时间 —— 比提交号更直观。
						*
						* `git pull` 之后忘了 `npm run build` 时，时间戳会明显偏旧，
						* 一眼就能看出「跑的还是旧产物」。
						*/
						ver?.builtAt === void 0 || ver.builtAt === "" ? null : (0, react.createElement)("span", {
							className: "ldw-ver-when",
							title: `构建于 ${ver.builtAt}`
						}, formatBuiltAt(ver.builtAt))
					),
					(0, react.createElement)("button", {
						type: "button",
						className: "ldw-btn",
						disabled: checking,
						onClick: () => void loadVersion(true)
					}, checking ? "检查中…" : "检查更新"),
					/**
					* Star 按钮 —— 用 `<a target="_blank">` 而不是 `window.open`：
					* 前者是浏览器原生行为（中键 / 右键「新标签打开」都能用），
					* 也自带 `rel` 安全属性。参考实现也是这么做的。
					*/
					(0, react.createElement)("a", {
						className: "ldw-btn ldw-star",
						href: ver?.starUrl ?? "https://github.com/cv-superding/dsh-webin/stargazers",
						target: "_blank",
						rel: "noreferrer noopener",
						title: `在 GitHub 上给 ${ver?.repo ?? "dsh-webin"} 点 Star`
					}, (0, react.createElement)("svg", {
						viewBox: "0 0 16 16",
						"aria-hidden": "true",
						className: "ldw-star-icon"
					}, (0, react.createElement)("path", { d: "M8 .25a.75.75 0 01.673.418l1.882 3.815 4.21.612a.75.75 0 01.416 1.279l-3.046 2.97.719 4.192a.75.75 0 01-1.088.791L8 12.347l-3.766 1.98a.75.75 0 01-1.088-.79l.72-4.194L.818 6.374a.75.75 0 01.416-1.28l4.21-.611L7.327.668A.75.75 0 018 .25z" })), "点个 Star"),
					checkNote !== "" ? (0, react.createElement)("span", { className: "ldw-ver-note" }, checkNote) : null
				),
				/** 有新提交时给一条明确的行动指引（含可照做的命令）。 */
				ver?.update?.ok === true && ver.update.behind === true ? (0, react.createElement)("div", { className: "ldw-callout" }, (0, react.createElement)("div", null, (0, react.createElement)("strong", null, `有新版本：${ver.update.latestCommit}`), ver.update.latestMessage !== void 0 && ver.update.latestMessage !== "" ? (0, react.createElement)("div", null, ver.update.latestMessage) : null, (0, react.createElement)("div", { className: "ldw-updcmd" }, (0, react.createElement)("code", null, ver.updateHint)), (0, react.createElement)("div", { className: "ldw-note" }, "本插件以本地目录 / npm 包方式安装，所以更新要在你那边执行上面的命令；改完重启 DSH（host 半没有热重载）。"))) : null
			), (0, react.createElement)("section", { className: "ldw-sec" }, (0, react.createElement)("div", { className: "ldw-sechead" }, (0, react.createElement)("span", { className: "ldw-sec-title" }, "平台"), (0, react.createElement)("span", { className: "ldw-sec-hint" }, "切到 LDW 标签可打开浏览器窗口并登录")), cards.length > 0 ? (0, react.createElement)("div", { className: "ldw-grid" }, cards) : (0, react.createElement)("p", { className: "ldw-note" }, "（没有可用平台）"), state.errors.length > 0 ? (0, react.createElement)("div", { className: "ldw-callout err" }, (0, react.createElement)("div", null, (0, react.createElement)("strong", null, `${state.errors.length} 个 provider 文件读不了`), (0, react.createElement)("ul", null, ...state.errors.map((e, i) => (0, react.createElement)("li", { key: i }, `${e.file}：${e.reason}`))))) : null), (0, react.createElement)("section", { className: "ldw-sec" }, (0, react.createElement)("div", { className: "ldw-sechead" }, (0, react.createElement)("span", { className: "ldw-sec-title" }, "登录"), (0, react.createElement)("span", { className: "ldw-sec-hint" }, "未登录的平台不会出现在模型选择器里")), (0, react.createElement)(
				"div",
				{ className: "ldw-panel" },
				/**
				* 每个平台一行：状态 + 「去登录」。
				*
				* 「去登录」= 切到 LDW 标签（浏览器在那里）。那是**唯一**能真正
				* 完成登录的地方 —— 登录要在真实页面上输账号密码。
				*/
				...state.providers.map((p) => {
					const isLogged = state.loggedInPlatforms.includes(p.id);
					const online = state.clients.some((c) => c.platform === p.id);
					return (0, react.createElement)(
						"div",
						{
							key: p.id,
							className: "ldw-loginrow"
						},
						(0, react.createElement)("span", { className: `ldw-dot ${isLogged ? "ok" : online ? "warn" : ""}`.trim() }),
						(0, react.createElement)("span", { className: "ldw-loginrow-name" }, p.name),
						(0, react.createElement)("span", { className: "ldw-note" }, isLogged ? online ? "已登录，浏览器在线" : "已登录（浏览器未打开）" : online ? "未登录 —— 浏览器已打开，去页面里登录" : "未登录"),
						/**
						* ## 已登录时**不显示按钮**，只显示状态标签
						*
						* 用户要求：「这个地方不要显示『打开浏览器』而是显示『已登录』」。
						*
						* 理由很实在：登录过之后，「打开浏览器」这个**动作按钮**会让人
						* 以为还要做点什么 —— 而实际上什么都不用做，模型已经可用了。
						* 显示成状态标签（带 ✓）才是准确的信息。
						*
						* ⚠️ 但也不能把「打开浏览器」这个能力弄丢：
						* 用户有时**确实**想进去看看（改设置、退出登录、看看页面状态）。
						* 所以已登录时给一个**弱化的小链接**（`ldw-linkbtn`），
						* 而不是显眼的主按钮 —— 视觉上它是「次要入口」而不是「待办事项」。
						*/
						(0, react.createElement)(
							"span",
							{
								className: "ldw-actions",
								style: { marginLeft: "auto" }
							},
							isLogged ? (0, react.createElement)("span", {
								className: "ldw-badge-on",
								title: "模型已可用，无需其他操作"
							}, "✓ 已登录") : (0, react.createElement)("button", {
								type: "button",
								className: "ldw-btn primary",
								onClick: () => goToPlatform(p.id)
							}, "去登录"),
							/** 已登录时保留一个次要入口（想进去看看 / 退出登录时用）。 */
							isLogged ? (0, react.createElement)("button", {
								type: "button",
								className: "ldw-linkbtn",
								title: "打开浏览器视图（查看页面状态 / 退出登录）",
								onClick: () => goToPlatform(p.id)
							}, "打开") : null
						)
					);
				}),
				(0, react.createElement)("p", { className: "ldw-note" }, state.loggedInPlatforms.length > 0 ? "已登录的平台可以直接用 —— 不需要再点任何按钮。需要查看页面状态或退出登录时，点「打开」。" : "点了「去登录」会切到本插件的浏览器视图 —— 在那里完成网页版登录。登录态会自动保存，重启 DSH 后仍有效。")
			)), (0, react.createElement)("details", { className: "ldw-details" }, (0, react.createElement)("summary", null, "插件配置", (0, react.createElement)("span", { className: "ldw-sec-hint" }, form === null ? "" : describeConfig(form))), (0, react.createElement)("div", { className: "ldw-details-body" }, configForm)), (0, react.createElement)("details", {
				className: "ldw-details",
				open: showAdd
			}, (0, react.createElement)("summary", { onClick: () => setShowAdd((v) => !v) }, "添加自定义平台"), (0, react.createElement)("div", { className: "ldw-details-body" }, (0, react.createElement)("p", { className: "ldw-note" }, "粘贴一个 Provider JSON（字段见 README）。同 id 会覆盖内置项，删掉即可回退。"), (0, react.createElement)("textarea", {
				className: "ldw-textarea",
				rows: 9,
				placeholder: "{\n  \"id\": \"my-platform\",\n  \"name\": \"我的平台\",\n  \"homeUrl\": \"https://example.com/\",\n  \"urlPattern\": \"example\\\\.com\",\n  \"input\": { \"selectors\": [\"textarea\"] },\n  \"send\": { \"selectors\": [\"button[type=\\\"submit\\\"]\"] },\n  \"completionPath\": \"/api/chat\",\n  \"models\": [{ \"id\": \"fast\", \"name\": \"快速\" }],\n  \"contextWindow\": 131072,\n  \"maxOutputTokens\": 8192\n}",
				value: draft,
				onChange: (e) => setDraft(e.target.value)
			}), (0, react.createElement)("div", { className: "ldw-actions" }, (0, react.createElement)("button", {
				type: "button",
				className: "ldw-btn primary",
				disabled: busy || draft.trim() === "",
				onClick: () => void submit()
			}, busy ? "处理中…" : "保存"), (0, react.createElement)("button", {
				type: "button",
				className: "ldw-btn",
				disabled: busy,
				onClick: () => void refresh()
			}, "刷新")))), note !== "" ? (0, react.createElement)("div", { className: "ldw-callout" }, (0, react.createElement)("div", null, (0, react.createElement)("strong", null, "提示"), (0, react.createElement)("div", null, note))) : null);
		}
		/** 设置页里的一行「标签 : 值」。 */
		function row(label, value) {
			return (0, react.createElement)("div", {
				className: "ldw-set-row",
				key: label
			}, (0, react.createElement)("span", { className: "ldw-set-label" }, label), (0, react.createElement)("span", { className: "ldw-set-value" }, value));
		}
		/**
		* 切到本插件的浏览器视图（`conversation.view` id=`ldw`）。
		*
		* ## 为什么靠「点标签按钮」而不是调 API
		*
		* 切视图的 `selectView` 是 **session header** 的注入属性，既不在
		* `conversation.input.left` 也不在 `settings.section` 的 standardProps 里
		* （实测查过两个 slot 的契约）。硬拿不到的东西就别硬拿 —— 直接点 DSH
		* 自己渲染的那个标签按钮，与我们操作网页版的思路一致（不设计协议，
		* 操作界面）。
		*
		* ## 三条路依次尝试（从最精确到最宽泛）
		*
		*   1. `[data-conversation-tabs]` 里文本含 `LDW` 的 `button[role=tab]`
		*   2. 全文档里文本含 `LDW` 的 `[role=tab]`（标签栏容器换了也能找到）
		*   3. 侧栏/视图列表里文本含 `LDW` 的可点元素
		*
		* **都必须命中一个真实存在的元素**；找不到就返回原因，
		* 让调用方显示出来 —— 不静默失败、不假装成功。
		*
		* @returns 空串表示成功；否则是**具体**的失败原因
		*/
		function switchToLdwView() {
			try {
				/** 候选：先精确（标签栏内），再宽泛（全文档 role=tab），最后兜底。 */
				const scopes = [
					{
						root: document,
						selector: "[data-conversation-tabs] button[role=\"tab\"]"
					},
					{
						root: document,
						selector: "[role=\"tab\"]"
					},
					{
						root: document,
						selector: "button, a"
					}
				];
				for (const { root, selector } of scopes) {
					const candidates = root.querySelectorAll(selector);
					for (let i = 0; i < candidates.length; i += 1) {
						const el = candidates[i];
						if (!String(el.textContent ?? "").trim().toUpperCase().includes("LDW")) continue;
						/** 排除我们自己的按钮（`ldw-entry`）—— 否则点自己会无限套娃。 */
						if (el.classList.contains("ldw-entry")) continue;
						el.click();
						return "";
					}
				}
				return "页面上没有 LDW 标签 —— 先发一条消息让会话建立，标签栏才会出现";
			} catch (error) {
				return `切换失败：${error?.message ?? String(error)}`;
			}
		}
		/** 设置页里「去登录」用的跳转（带反馈）。 */
		function goToPlatform(platform) {
			const err = switchToLdwView();
			if (err !== "")
 /** 没标签栏时至少把浏览器视图指出来，不让用户干等。 */
			console.warn(`[dsh-webin] 切到 ${platform} 的浏览器视图失败：${err}`);
		}
		/** 文本归一化 —— 去空白 + 小写，用于按文字找按钮。 */
		function normText(s) {
			return String(s ?? "").replace(/\s+/g, "").toLowerCase();
		}
		/** 在候选里找文本匹配的可点元素。 */
		function findClickable(root, match) {
			const els = root.querySelectorAll("button, [role=\"button\"], a");
			for (let i = 0; i < els.length; i += 1) {
				const el = els[i];
				if (match(normText(el.textContent))) return el;
			}
			return null;
		}
		/** 设置模态框元素（DSH 的设置页是 portal 到 body 的 dialog）。 */
		function settingsDialog() {
			return document.querySelector("[data-shortcut-modal=\"settings\"]");
		}
		/**
		* ## 打开设置页并切到 LDW 分区
		*
		* 设置页是 DSH 的**模态对话框** —— `[data-shortcut-modal="settings"]`
		* （`role=dialog` + `aria-modal`，portal 到 `document.body`；实测查过
		* `dsh-client-ui-settings-general` 的 `SettingsRoot`）。
		*
		* 打开它两条路，依次尝试：
		*   1. 点侧栏那个**真实的**设置按钮（按文字找「设置」）
		*   2. 派发 DSH 注册的 `settings.open` 快捷键（Ctrl+, / Ctrl+Alt+,）
		*
		* 打开后点导航里文本含 `LDW` 的那一行 —— 那是我们注册的
		* `settings.section`（id=`ldw`，label=`LDW 网页版`）。
		*
		* 全程走真实 DOM，不设计新协议。**每一步失败都返回具体原因** ——
		* 「找不到对话标签栏」这种笼统提示让人不知道下一步做什么。
		*
		* @returns 空串表示成功；否则是**具体**的失败原因
		*/
		function openSettingsAtLdwSection() {
			try {
				if (settingsDialog() === null) {
					/** 路子 1：点侧栏真实的设置按钮。 */
					const trigger = findClickable(document, (t) => t === "设置" || t === "settings") ?? findClickable(document, (t) => t.includes("设置") || t.includes("settings"));
					if (trigger !== null) trigger.click();
					/**
					* 路子 2：派发快捷键。
					*
					* DSH 注册的默认键：桌面 `primary+Comma`、web `primary+alt+Comma`。
					* 都试一遍 —— 派发合成事件走的是 DSH 自己的快捷键系统，
					* 不绕过任何逻辑。
					*/
					if (settingsDialog() === null) for (const ev of [
						{
							key: ",",
							code: "Comma",
							ctrlKey: true,
							altKey: true
						},
						{
							key: ",",
							code: "Comma",
							ctrlKey: true,
							altKey: false
						},
						{
							key: ",",
							code: "Comma",
							metaKey: true,
							altKey: false
						}
					]) {
						for (const target of [
							document,
							document.body,
							window
						]) target.dispatchEvent(new KeyboardEvent("keydown", {
							...ev,
							bubbles: true,
							cancelable: true
						}));
						if (settingsDialog() !== null) break;
					}
					if (settingsDialog() === null) return trigger === null ? "没找到设置按钮，也没唤出设置页 —— 请手动打开 设置 → LDW 网页版" : "点了设置按钮但设置页没打开 —— 请手动打开 设置 → LDW 网页版";
				}
				const dialog = settingsDialog();
				if (dialog === null) return "设置页没打开";
				const row = findClickable(dialog, (t) => t.includes("ldw"));
				if (row === null) return "设置页里没有 LDW 分区 —— 插件可能没启用（试试重启 DSH）";
				row.click();
				return "";
			} catch (error) {
				return `打开设置失败：${error?.message ?? String(error)}`;
			}
		}
		/**
		* ## 输入框左侧的 LDW 入口（`conversation.input.left`）
		*
		* 用户要求：「每次新建会话的时候，应该在这里加个 LDW，让登录一下」。
		* 后续修正：「图2这个页面不用加LDW登录」+「点击那个LDW都不行哎」
		*
		* ## 为什么之前点了没反应
		*
		* 之前点击是「切到 LDW 标签」—— 找 `[data-conversation-tabs]` 里文本含 LDW
		* 的按钮。但在**新建会话的空页面**上那个标签栏根本不存在：
		*
		*     showTabs = !hideChrome && tabs.length > 1
		*
		* 标签栏只在「有会话」且「有多个视图」时渲染。所以空会话页面上点击
		* 必然报「找不到对话标签栏」—— 那不是 bug，是那个动作在这一页做不到。
		*
		* ## 现在的行为
		*
		* | 页面 | 行为 |
		* |---|---|
		* | **没有会话/标签栏**（新建会话页） | 显示按钮；点击**打开设置页的 LDW 区** |
		* | **有标签栏** | **不渲染**（用户明确说「图2不用加」） |
		*
		* 登录本身在设置页里做（那里有平台卡、登录态、去登录入口），
		* 所以按钮的职责就是**把用户送到设置页**。
		*
		* ## 怎么打开设置页
		*
		* 设置页是 DSH 的**模态对话框**：`[data-shortcut-modal="settings"]`
		* （`role=dialog` + `aria-modal`，portal 到 `document.body`）。
		*
		* 打开它有两个途径，这里**依次尝试**：
		*   1. 点侧栏那个真实的设置按钮（找文本含「设置 / Settings」的按钮）
		*   2. 派发 DSH 注册的 `settings.open` 快捷键（Ctrl+, / Ctrl+Alt+,）
		*
		* 打开之后再点导航里文本含 `LDW` 的那一行 —— 那是我们自己注册的
		* `settings.section`（id=`ldw`, label=`LDW 网页版`）。
		*
		* 全程走真实 DOM，不设计新协议 —— 与我们操作网页版的思路一致。
		* 每一步失败都**明确说明卡在哪**，不静默。
		*/
		function LdwLoginButton() {
			const [status, setStatus] = (0, react.useState)(null);
			const [note, setNote] = (0, react.useState)("");
			/**
			* 这一页有没有会话标签栏？
			*
			* 有 ⇒ 用户能自己点「LDW」标签，这个按钮是冗余的 ⇒ 不渲染（用户要求）。
			* 用 `MutationObserver` 盯着，因为标签栏是**异步**出现的（会话建立后才渲染）。
			*/
			const [hasTabs, setHasTabs] = (0, react.useState)(false);
			(0, react.useEffect)(() => {
				let alive = true;
				const probe = () => {
					if (!alive) return;
					setHasTabs(document.querySelector("[data-conversation-tabs]") !== null);
				};
				probe();
				const observer = new MutationObserver(probe);
				observer.observe(document.body, {
					childList: true,
					subtree: true
				});
				return () => {
					alive = false;
					observer.disconnect();
				};
			}, []);
			(0, react.useEffect)(() => {
				let alive = true;
				const load = async () => {
					try {
						const data = await (await fetch(`${LDW_API}/status`)).json();
						if (!alive) return;
						setStatus({
							loggedIn: (data.loggedInPlatforms ?? []).length > 0,
							online: Number(data.clients?.online ?? 0) > 0
						});
					} catch {
						if (alive) setStatus({
							loggedIn: false,
							online: false
						});
					}
				};
				load();
				/** 登录发生在别处，所以定期回读状态（登录后这里要变绿）。 */
				const timer = window.setInterval(() => void load(), 5e3);
				return () => {
					alive = false;
					window.clearInterval(timer);
				};
			}, []);
			/**
			* 打开设置页并切到 LDW 分区。
			*
			* 逻辑抽在 `openSettingsAtLdwSection()` 里（与设置页共用一套 DOM 探测），
			* 这里只负责把失败原因显示出来 —— 不静默失败。
			*/
			const openSettingsAtLdw = () => {
				if (openSettingsAtLdwSection() === "") {
					setNote("");
					return;
				}
				/**
				* 设置页是**异步挂载**的：点了设置按钮之后 React 才渲染导航行。
				* 所以等一帧再试一次 —— 用 `requestAnimationFrame` 而不是定时器，
				* React 提交后 rAF 一定已经能看到 DOM。
				*/
				requestAnimationFrame(() => {
					const second = openSettingsAtLdwSection();
					setNote(second === "" ? "" : second);
				});
			};
			if (hasTabs) return null;
			if (status === null) return null;
			const { loggedIn, online } = status;
			return (0, react.createElement)("button", {
				type: "button",
				className: "ldw-entry",
				onClick: openSettingsAtLdw,
				title: note !== "" ? note : loggedIn ? "打开设置页的 LDW 分区（已登录）" : "打开设置页登录 LDW"
			}, (0, react.createElement)("span", { className: `ldw-dot ${loggedIn ? "ok" : online ? "warn" : ""}`.trim() }), (0, react.createElement)("span", null, loggedIn ? "LDW 已登录" : online ? "LDW 登录" : "LDW 未就绪"), note !== "" ? (0, react.createElement)("span", { className: "ldw-entry-note" }, note) : null);
		}
		function LdwPlaceholder(props) {
			const ref = (0, react.useRef)(null);
			/**
			* ## ⭐ 上报「我挂在哪个 DSH 会话上」（用户报的「所有窗口都生效」）
			*
			* ## 事实（不是猜的）
			*
			* `conversation.view` 的 standardProps 里**直接有 `sessionId: SessionId`**
			* —— 这是 DSH 官方提供的 prop（用 Slots Inspect 查到的
			* `standardProps` 列表，含 `sessionId`、`useSession`、`useChat` 等）。
			*
			* ## 为什么需要
			*
			* 早期 `/job/next` 只按平台过滤 ⇒ **任何 DSH 窗口都能领走任何任务**。
			* 用户实测：「换了几个 dsh 窗口聊天，发现全都是在网页版的同一个会话窗口」、
			* 「所有窗口都生效」。
			*
			* 上报之后，host 派发时能带上目标会话，client 领活时也只领自己的。
			*
			* ⚠️ 拿不到 sessionId 时**不报错**（退回按平台派发）—— 那只是不够精确，
			* 比整个功能坏掉好。
			*/
			(0, react.useEffect)(() => {
				const sid = typeof props?.sessionId === "string" ? props.sessionId.trim() : "";
				/**
				* ## ⚠️ 把「实际收到了什么 props」打出来 —— 不猜
				*
				* 我按 Slots Inspect 的 `standardProps` 列表认定 `conversation.view`
				* 会传 `sessionId`。但**契约写着有 ≠ 运行时真的传了** ——
				* 所以第一次挂载时把**实际收到的 key** 打出来，
				* 一眼就能确认（而不是靠我推断）。
				*
				* 用户要求「不要猜」—— 这就是把推断变成观测。
				*/
				if (!propsLogged) {
					propsLogged = true;
					const keys = props === void 0 ? [] : Object.keys(props);
					console.log("[dsh-webin] conversation.view 收到的 props", {
						keys,
						sessionId: sid === "" ? "(空)" : sid,
						hasSessionId: sid !== ""
					});
				}
				if (sid === "") return;
				sessionIdRef.current = sid;
				fetchJson("/dsh-webin/api/client/session", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ sessionId: sid })
				}).then((res) => {
					if (res !== void 0 && res.ok) console.log("[dsh-webin] 已上报会话身份", sid);
				});
			}, [props?.sessionId]);
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
			/**
			* ---- 输入框左侧的 LDW 入口：conversation.input.left ----
			*
			* 用户要求：「每次新建会话的时候，应该在这里加个 LDW，让登录一下」。
			*
			* 这个位置在**每一条会话**里都在（包括刚新建的空会话），
			* 所以它是「第一次怎么开始」的正确入口 —— 之前只能靠切 LDW 标签，
			* 而新建会话时那个标签不在视野里。
			*
			* `order: 10` —— 排在左侧控件前段，紧邻工作区 / 模式选择器。
			*/
			ctx.effect(() => ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
				name: "conversation.input.left",
				id: "ldw-login",
				order: 10,
				label: () => "LDW"
			}, LdwLoginButton)), "dsh-webin: composer entry");
		}
		//#endregion
		exports.EXEC_TIMEOUT = EXEC_TIMEOUT;
		exports.LdwHost = LdwHost;
		exports.LdwLoginButton = LdwLoginButton;
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