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
 * `[class*="markdown"]` 命中 **0** 说明：**页面上根本没有带
 * "markdown" 的类名** —— 我的候选表整个是错的（那些类名来自
 * 用户历史会话记录，当前页面结构已经变了）。
 *
 * 继续猜类名没有意义。**直接把页面结构导出来看。**
 *
 * ## 独立文件的原因
 *
 * `hook.ts` 有 1392 行、大量模板字符串。之前用脚本往里插入代码时
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
        if (t.indexOf(NEEDLE) === -1) continue;
        var kids = all[j].children || [];
        var deepest = true;
        for (var c = 0; c < kids.length; c++) {
          var kt = '';
          try { kt = String(kids[c].textContent || ''); } catch (e) { kt = ''; }
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
      topClasses: top.slice(0, 45)
    });
  } catch (e) {
    return JSON.stringify({ ok: false, error: String(e && e.message) });
  }
})();`
}
