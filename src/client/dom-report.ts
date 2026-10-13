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
export function buildDomReportScript(needle: string): string {
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

    /**
     * ⭐⭐⭐ ds-markdown 内部块结构 —— 修「思考混入正文」的关键。
     *
     * ## 已知事实（用户实测鹈鹕任务）
     *
     * 抓取结果 42KB，head 是思考文本 ⇒ 思考也在 .ds-markdown 容器里。
     * 旧的思考类名（think-content 等）匹配不到 ⇒ DeepSeek 新版变了。
     *
     * 导出每个 ds-markdown 的**直接子块**（tag/class/文本量/前 80 字），
     * 一眼看出「思考块长什么样、正文块长什么样」。
     */
    var mdBlocks = [];
    try {
      var mds = document.querySelectorAll('.ds-markdown');
      for (var qi = 0; qi < mds.length && qi < 6; qi++) {
        var blocks = [];
        var mk2 = mds[qi].children || [];
        for (var ri = 0; ri < mk2.length && ri < 12; ri++) {
          var bt = '';
          try { bt = String(mk2[ri].textContent || ''); } catch (e) { bt = ''; }
          blocks.push({
            el: describe(mk2[ri]).slice(0, 80),
            txt: bt.length,
            head: bt.slice(0, 80)
          });
        }
        /** 容器自身的类（可能带状态类）。 */
        mdBlocks.push({
          idx: qi,
          self: describe(mds[qi]).slice(0, 100),
          blockCount: (mds[qi].children || []).length,
          totalText: String(mds[qi].textContent || '').length,
          blocks: blocks
        });
      }
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
      /** ⭐⭐⭐ ds-markdown 内部块结构（修思考混入的关键）。 */
      mdBlocks: mdBlocks,
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
})();`
}
