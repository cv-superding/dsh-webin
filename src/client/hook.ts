/**
 * dsh-webin — 页面内网络观察 hook（自包含 IIFE 源码）。
 *
 * 设计原则（照搬 cuckoo 的思路，代码自行实现）：
 *   **只读观察，绝不改写请求。**
 *   给 `window.fetch` / `XMLHttpRequest` 包一层，原样透传给页面自己用，
 *   只从 SSE 响应里把 AI 回复文本读出来，通过 `CustomEvent` 抛给宿主。
 *
 * 这样 PoW、cookie、`x-hif-*`、TLS/HTTP2 指纹全部由页面自己天然正确 ——
 * 我们一行协议代码都不用写，也就不存在"不像浏览器"的破绽。
 *
 * 为什么不用 cuckoo 的 `hook-sources.ts`：它是 **GPL-3.0-only**，
 * 直接复制会让本项目也变 GPL。这里按同样的协议理解重写。
 *
 * 该函数返回一段字符串，由宿主用 `<webview>.executeJavaScript()` 注入页面主世界。
 */

/** 正在进行的 completion 请求路径。 */
const COMPLETION_PATH = '/api/v0/chat/completion'

/** 用户主动停止生成。 */
const STOP_PATH = '/api/v0/chat/stop_stream'

/** 幂等标记：重复注入不重复打补丁。 */
const MARKER = '__dshWebinHookInstalled__'

/** 事件缓冲在 window 上的键名（与 hook 内一致）。 */
export const EVENT_QUEUE_KEY = `${MARKER}_events`

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
export function buildDeepSeekHook(completionPath: string, stopPath?: string): string {
  return `(function () {
  'use strict';
  if (window.${MARKER}) return 'already-installed';
  window.${MARKER} = true;

  var COMPLETION = ${JSON.stringify(completionPath)};
  var STOP = ${JSON.stringify(stopPath ?? '')};
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
})();`
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
export function buildProbeScript(): string {
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
})();`
}

/** 登录态快照的宿主侧 API 前缀（与 host 半一致）。 */
const API_PREFIX = '/dsh-webin/api'

/** 默认账号槽位。 */
const DEFAULT_SLOT = 'default'

/**
 * 把快照存到 **host 侧**（`~/.dsh/webin/auth/<slot>.json`）。
 *
 * 不用 `window.localStorage`：那是 DSH 主窗口的存储，不归本插件所有，
 * 而且跟 guest partition 一样会随 profile 走。host 的文件系统才是真正落盘的。
 */
export async function saveSnapshot(snapshotJson: string, slot = DEFAULT_SLOT): Promise<boolean> {
  try {
    const res = await fetch(`${API_PREFIX}/auth/${slot}/snapshot`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: snapshotJson,
    })
    return res.ok
  } catch {
    return false
  }
}

/** 从 host 侧取回快照；没有则返回 undefined。 */
export async function loadSnapshot(slot = DEFAULT_SLOT): Promise<string | undefined> {
  try {
    const res = await fetch(`${API_PREFIX}/auth/${slot}/snapshot`, { method: 'GET' })
    if (!res.ok) return undefined
    const text = await res.text()
    return text === '' ? undefined : text
  } catch {
    return undefined
  }
}

/** 清掉 host 侧快照（退出登录时用）。 */
export async function clearSnapshot(slot = DEFAULT_SLOT): Promise<boolean> {
  try {
    const res = await fetch(`${API_PREFIX}/auth/${slot}/snapshot`, { method: 'DELETE' })
    return res.ok
  } catch {
    return false
  }
}

/** 取走 hook 累积的事件（取即清空）。
 *
 * 用轮询而不是事件订阅：`CustomEvent` 跨不过 webview 边界，
 * 而 `<webview>` 的 `ipc-message` 需要 guest 里 `require('electron')` —— guest 是 sandbox 且无 preload，拿不到。
 * 轮询 `executeJavaScript` 是这条路里唯一稳定的桥。
 */
export function buildDrainScript(): string {
  return `(function () {
  try {
    var q = window.${EVENT_QUEUE_KEY};
    if (!q || !q.length) return '[]';
    window.${EVENT_QUEUE_KEY} = [];
    return JSON.stringify(q);
  } catch (e) {
    return '[]';
  }
})();`
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
export function buildScrapeScript(): string {
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
      root: root === document.body ? 'body' : String(root.tagName || '').toLowerCase(),
      trace: trace,
      fallback: fallbackInfo
    });
  } catch (e) {
    return JSON.stringify({ ok: false, last: '', all: [], error: String(e && e.message) });
  }
})();`
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
export function buildSnapshotScript(): string {
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
})();`
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
export function buildRestoreScript(snapshotJson: string): string {
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
})();`
}
