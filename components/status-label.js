/* ──────────────────────────────────────────────────────────────────────
 * ProCraft Dealer Portal — Quote Status Label (v1.0)
 *
 * CB-56 項目 A —— quote status「顯示名稱」的唯一真相來源。
 *
 * ═══ 核心紅線:顯示 ≠ 值 ═══════════════════════════════════════════════
 * 本檔【只管給人看的文字】。DB 的 quotes.status 值永遠不變:
 *   · 寫入      .update({ status: 'Pending' })          ← 不受本檔影響
 *   · 比對      q.status === 'Pending'                  ← 不受本檔影響
 *   · 查詢      .eq('status', 'Pending')                ← 不受本檔影響
 *   · filter    <option value="Pending">                ← value 屬性不受本檔影響
 * 水合(hydrate)只覆寫 textContent,結構上碰不到任何 value 屬性。
 * 改動 status 底層值會牽動 F2 trigger / n8n filter / RLS —— 嚴禁。
 * ═════════════════════════════════════════════════════════════════════
 *
 * 【B-1 命名衝突防範|絕對不可違反】
 *   dashboard / quotes / quote-detail / admin-quotes / admin-payments
 *   五頁的 inline <script> 頂層各自宣告過 `const statusLabel`。本檔若也
 *   宣告同名變數,同一 global script scope 重複宣告 = SyntaxError,
 *   【整頁 JS 全死】。因此本檔對外一律使用 PC_ / pc 前綴,永不使用
 *   `statusLabel` 這個識別字。
 *
 * 【與 payment status 的分野|不可混用】
 *   admin-payments.html 的 `const statusLabel`(processing / confirmed /
 *   failed / cancelled)是【payments.status】,與本檔的【quotes.status】
 *   語意完全不同。那個變數維持原樣,永遠不併入本檔。
 *   → 本檔只收 quotes.status,不收 payments.status。
 *
 * 【載入時機】
 *   <script src="components/status-label.js?v=1.0"> 一律插在 config.js
 *   那行的正下方(supabase CDN → config.js → 本檔 → navigator.js →
 *   footer.js → 頁面 inline script)。無 defer / async,同步依序執行,
 *   頁面 inline script 執行時 window.PC_* 必定就位。
 *
 * 【引用頁面|6 頁】
 *   dashboard.html / quotes.html / quote-detail.html /
 *   admin-quotes.html / admin.html / admin-payments.html
 *   payment.html 不載入 —— 該頁不渲染任何 quote status 文字(M-4)。
 *
 * 【兩種用法】
 *   (1) JS 渲染的文字 → 呼叫 pcQuoteStatusLabel(q.status)
 *   (2) 靜態 HTML 文字 → 加 data-pc-status-label / data-pc-status-short
 *       屬性,由本檔於 DOMContentLoaded 自動水合(M-2)。
 *       ⚠️ HTML 內仍須寫正確文字作為 fallback → 正常情況水合是 no-op,
 *          零 FOUC;水合的真正價值是「日後改字只需動本檔一行」。
 * ────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  // 冪等防護(對齊 CB-51.1 navigator.js 的 __pcdNavigatorLoaded 慣例)。
  // 即使日後某頁重複掛載本檔,也只會執行一次,Object.freeze 不會被二次覆寫。
  if (window.__pcdStatusLabelLoaded) return;
  window.__pcdStatusLabelLoaded = true;

  // ===================================================================
  // 完整顯示名(badge / filter 文字 / dropdown 文字 / 散文)
  // -------------------------------------------------------------------
  // 只收「DB 值 ≠ 顯示名」的狀態。其餘七種(Draft / Stock Review /
  // Payment Processing / Order Processing / Order Completed / Closed)
  // 刻意不入 map,由 fallback 直接回原值 —— 沿用 CB-2 的 `|| q.status`
  // 語意,日後新增狀態就算忘了更新本檔也只會顯示 DB 原值,不會變空白。
  // ===================================================================
  var LABEL = {
    'Pending':  'Waiting for Payment',   // CB-56:DB 值仍為 'Pending'
    'Returned': 'Revising'               // CB-2 既有 mapping,收斂至此
  };

  // ===================================================================
  // stat 卡短標題
  // -------------------------------------------------------------------
  // 卡片標題本來就是暱稱制(Payment Processing → 'Payment'、
  // Order Processing → 'Order'、Returned → 'Revising'),為的是不破版。
  // 'Waiting' 與既有 Total / Draft / Revising / Payment / Order 同級。
  // admin.html 的卡片是多字標題、寬度充裕,直接用 data-pc-status-label
  // 取完整字,不走本 map(M-1)。
  // ===================================================================
  var SHORT = {
    'Pending':  'Waiting',
    'Returned': 'Revising'
  };

  var LABEL_MAP = Object.freeze(LABEL);
  var SHORT_MAP = Object.freeze(SHORT);

  function has(map, key) {
    return Object.prototype.hasOwnProperty.call(map, key);
  }

  // ── 完整顯示名;查無則 fallback 回 DB 原值 ──
  function pcQuoteStatusLabel(status) {
    if (status == null || status === '') return '';
    return has(LABEL_MAP, status) ? LABEL_MAP[status] : String(status);
  }

  // ── 短標題;查無則退完整名,再退 DB 原值 ──
  function pcQuoteStatusShort(status) {
    if (status == null || status === '') return '';
    if (has(SHORT_MAP, status)) return SHORT_MAP[status];
    return pcQuoteStatusLabel(status);
  }

  // ===================================================================
  // 靜態 HTML 水合(M-2)
  // -------------------------------------------------------------------
  //   <option value="Pending" data-pc-status-label="Pending">Waiting for Payment</option>
  //   <div class="stat-label" data-pc-status-short="Pending">Waiting</div>
  //
  // ⚠️ 兩條安全規則:
  //   (1) 只寫 textContent,絕不觸碰 value / 任何其他屬性。
  //   (2) 屬性值【不在 map 內】時直接跳過,保留 HTML 原文 —— 否則
  //       data-pc-status-short="Payment Processing" 會被 fallback 覆寫成
  //       'Payment Processing',把刻意設計的卡片暱稱 'Payment' 撐破版。
  //
  // 可重複呼叫(冪等)。JS 動態產生的內容請直接呼叫 pcQuoteStatusLabel(),
  // 不要依賴水合 —— 本檔不掛 MutationObserver。
  // ===================================================================
  function hydrateAttr(scope, attrName, map) {
    var nodes = scope.querySelectorAll('[' + attrName + ']');
    for (var i = 0; i < nodes.length; i++) {
      var el  = nodes[i];
      var key = el.getAttribute(attrName);
      if (!key || !has(map, key)) continue;   // 不在 map → 保留 HTML 原文
      var next = map[key];
      if (el.textContent !== next) el.textContent = next;
    }
  }

  function pcHydrateStatusLabels(root) {
    var scope = root || document;
    if (!scope || typeof scope.querySelectorAll !== 'function') return;
    hydrateAttr(scope, 'data-pc-status-label', LABEL_MAP);
    hydrateAttr(scope, 'data-pc-status-short', SHORT_MAP);
  }

  // ── 對外掛載 ──
  window.PC_QUOTE_STATUS_LABEL = LABEL_MAP;
  window.PC_QUOTE_STATUS_SHORT = SHORT_MAP;
  window.pcQuoteStatusLabel    = pcQuoteStatusLabel;
  window.pcQuoteStatusShort    = pcQuoteStatusShort;
  window.pcHydrateStatusLabels = pcHydrateStatusLabels;

  // ── 自動水合 ──
  // 本檔載入位置在 <body> 尾端的 script 區塊,理論上 DOM 已解析完;
  // 但保留 readyState 分支,避免日後有人把它移到 <head> 就靜默失效。
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      pcHydrateStatusLabels(document);
    });
  } else {
    pcHydrateStatusLabels(document);
  }
})();
