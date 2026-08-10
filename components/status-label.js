/* ──────────────────────────────────────────────────────────────────────
 * ProCraft Dealer Portal — Quote Status Label (v1.1)
 *
 * CB-56 項目 A —— quote status「顯示名稱」的唯一真相來源。
 * CB-62 B1    —— 加入 i18n 支援(見下方【多語系】)。
 *
 * ═══ 核心紅線:顯示 ≠ 值 ═══════════════════════════════════════════════
 * 本檔【只管給人看的文字】。DB 的 quotes.status 值永遠不變:
 *   · 寫入      .update({ status: 'Pending' })          ← 不受本檔影響
 *   · 比對      q.status === 'Pending'                  ← 不受本檔影響
 *   · 查詢      .eq('status', 'Pending')                ← 不受本檔影響
 *   · filter    <option value="Pending">                ← value 屬性不受本檔影響
 * 水合(hydrate)只覆寫 textContent,結構上碰不到任何 value 屬性。
 * 改動 status 底層值會牽動 F2 trigger / n8n filter / RLS —— 嚴禁。
 * v1.1 完整繼承這條紅線,多語系【只換顯示文字】。
 * ═════════════════════════════════════════════════════════════════════
 *
 * ═══ 多語系(CB-62 B1)|開關是「i18n.js 有沒有載入」═══════════════════
 * 本檔先問一句 typeof window.pcT === 'function':
 *
 *   admin.html / admin-quotes.html   → 沒載 i18n.js → pcT 不存在
 *                                    → 【行為與 v1.0 完全一致,永遠英文】
 *   dealer 端頁面                     → 有載 i18n.js
 *                                    → 查 status.*,查無退回英文
 *
 * admin 頁【不需要】任何旗標、role 判斷或黑名單 —— 它們只是沒載 i18n.js。
 * 這也是本檔不會退役的原因:它同時是 admin 端的唯一真相,以及 dealer 端
 * 的英文 fallback 層。
 *
 * 查詢鏈:
 *   status.<label|short>.<slug>   (僅當 pcT 存在)
 *        ↓ 查無
 *   LABEL / SHORT map             (本檔內的英文)
 *        ↓ 查無
 *   DB 原值(label)/ 跳過(short)
 *
 * 【🔴 兩條英文字串刻意重複|改一邊就要改另一邊】
 *   下方 LABEL map 的 'Pending' 與 'Returned',在 i18n/en.json 的
 *   status.label.pending / status.label.returned 也各有一份。
 *   本檔這份是 admin 頁在用的(admin 永不進 i18n 體系);en.json 那份是
 *   dealer 頁在用的。兩處必須同步。
 *   → 與 login Bridge 同一種耦合模式,完整說明見 i18n/README.md §10。
 *   其餘七種狀態只存在於 en.json;admin 頁走 fallback 顯示 DB 原值,
 *   與今天的畫面完全相同。
 *
 * 【🔴 status.short.* 只有兩條,這是刻意的】
 *   短標題是給窄版 stat 卡用的。查無時本檔【跳過該節點】,絕不退回完整名
 *   —— 把 'Payment Processing' 寫進一張為 'Waiting' 設計的卡會撐破版面。
 *   實作上以 SHORT map 是否收錄該狀態作為閘門:SHORT map 決定「哪些狀態
 *   有短版」,i18n 只負責「那兩條怎麼翻」。這樣既維持只有兩條的不變量,
 *   也不會對不存在的 key 發出假警告。
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
 *   → dealer 端 payment.html 的 payments.status 另走 status.payment.*
 *     命名空間(CB-62 B1 / Q-9),同樣不進本檔。
 *
 * 【載入時機】
 *   <script src="components/status-label.js?v=1.1"> 一律插在 config.js
 *   那行的正下方。dealer 端頁面的順序為:
 *     supabase CDN → config.js → 本檔 → i18n.js → lang-switch.js
 *     → navigator.js → footer.js → 頁面 inline script
 *   本檔【不要求】i18n.js 先載入 —— 首次水合時若 pcT 尚未就位就走英文
 *   (英文零 FOUC),之後靠 pc:i18n-changed 事件補渲染。
 *
 * 【實際引用頁面|5 頁】
 *   dashboard.html / quotes.html / quote-detail.html /
 *   admin-quotes.html / admin.html
 *   · payment.html 不載入 —— 該頁不渲染任何 quote status 文字(M-4)。
 *   · ⚠️ admin-payments.html 有一個 data-pc-status-label 標記【但沒有載入
 *     本檔】,該標記自始未生效,畫面靠 HTML 原文撐著。屬既有債,已另開
 *     F-25 追蹤,CB-62 不處理。在它修好之前,改本檔的 'Pending' 顯示名
 *     不會反映到那一頁。
 *
 * 【兩種用法】
 *   (1) JS 渲染的文字 → 呼叫 pcQuoteStatusLabel(q.status)
 *   (2) 靜態 HTML 文字 → 加 data-pc-status-label / data-pc-status-short
 *       屬性,由本檔於 DOMContentLoaded 自動水合(M-2)。
 *       ⚠️ HTML 內仍須寫正確英文作為 fallback → 英文情況水合是 no-op,
 *          零 FOUC;水合的真正價值是「日後改字只需動一處」。
 *
 * 【🔴 節點所有權|同一節點禁掛兩種標記】
 *   帶 data-pc-status-* 的節點由本檔獨佔,i18n.js 永不碰它。
 *   絕不可在同一個元素上同時放 data-i18n 與 data-pc-status-*
 *   —— 兩個水合器會互相覆寫,結果取決於載入順序。
 *
 * 【JS 動態產生的內容不歸本檔管】
 *   本檔不掛 MutationObserver。頁面用 template literal 產生的狀態文字,
 *   必須由該頁自行監聽 pc:i18n-changed 並重繪。dashboard.html 是參考實作。
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
  // Payment Processing / Order Processing / Order Completed / Closed /
  // Cancelled)刻意不入 map,由 fallback 直接回原值 —— 沿用 CB-2 的
  // `|| q.status` 語意,日後新增狀態就算忘了更新本檔也只會顯示 DB 原值,
  // 不會變空白。
  //
  // 🔴 這兩條與 i18n/en.json 的 status.label.* 重複,改一邊就要改另一邊。
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
  //
  // 🔴 本 map 同時是「哪些狀態有短版」的唯一閘門(見檔頭說明)。
  // ===================================================================
  var SHORT = {
    'Pending':  'Waiting',
    'Returned': 'Revising'
  };

  // ===================================================================
  // DB 值 → i18n key slug(CB-62 B1)
  // -------------------------------------------------------------------
  // 明確列舉,【不做字串轉換推導】。日後新增狀態時,若忘了加進本表,
  // 結果是該狀態不翻譯(顯示英文),而不是組出一個不存在的 key。
  // ===================================================================
  var SLUG = {
    'Draft':              'draft',
    'Stock Review':       'stock_review',
    'Pending':            'pending',
    'Returned':           'returned',
    'Payment Processing': 'payment_processing',
    'Order Processing':   'order_processing',
    'Order Completed':    'order_completed',
    'Closed':             'closed',
    'Cancelled':          'cancelled'
  };

  var LABEL_MAP = Object.freeze(LABEL);
  var SHORT_MAP = Object.freeze(SHORT);
  var SLUG_MAP  = Object.freeze(SLUG);

  function has(map, key) {
    return Object.prototype.hasOwnProperty.call(map, key);
  }

  // ── i18n 查詢;pcT 不存在(admin 頁)或查無時一律回 null ──
  // 回 null 而非空字串,呼叫端才能明確區分「沒翻譯」與「翻譯成空字串」。
  function i18nLookup(kind, status) {
    if (typeof window.pcT !== 'function') return null;
    if (!has(SLUG_MAP, status)) return null;          // 未登錄的狀態 → 不查,避免假警告
    var out = window.pcT('status.' + kind + '.' + SLUG_MAP[status]);
    return (typeof out === 'string' && out !== '') ? out : null;
  }

  // ── 完整顯示名;i18n → 英文 map → DB 原值 ──
  function pcQuoteStatusLabel(status) {
    if (status == null || status === '') return '';
    var t = i18nLookup('label', status);
    if (t !== null) return t;
    return has(LABEL_MAP, status) ? LABEL_MAP[status] : String(status);
  }

  // ── 短標題;僅限 SHORT_MAP 收錄的狀態,其餘退完整名 ──
  // 🔴 i18n 查詢以 SHORT_MAP 為閘門:SHORT_MAP 決定「哪些狀態有短版」,
  //    i18n 只負責「怎麼翻」。維持只有兩條的不變量。
  function pcQuoteStatusShort(status) {
    if (status == null || status === '') return '';
    if (has(SHORT_MAP, status)) {
      var t = i18nLookup('short', status);
      return (t !== null) ? t : SHORT_MAP[status];
    }
    return pcQuoteStatusLabel(status);
  }

  // ===================================================================
  // 靜態 HTML 水合(M-2)
  // -------------------------------------------------------------------
  //   <option value="Pending" data-pc-status-label="Pending">Waiting for Payment</option>
  //   <div class="stat-label" data-pc-status-short="Pending">Waiting</div>
  //
  // ⚠️ 兩條安全規則(v1.0 起,v1.1 完整保留):
  //   (1) 只寫 textContent,絕不觸碰 value / 任何其他屬性。
  //   (2) 解不出顯示名時【直接跳過】,保留 HTML 原文。對短標題而言尤其
  //       關鍵 —— 絕不退回完整名,否則
  //       data-pc-status-short="Payment Processing" 會把刻意設計的卡片
  //       暱稱 'Payment' 撐破版。
  //
  // 可重複呼叫(冪等)。
  // ===================================================================

  // 完整名:i18n → LABEL_MAP → 跳過(不退 DB 原值,維持 v1.0 的靜態語意)
  function resolveLabelAttr(key) {
    var t = i18nLookup('label', key);
    if (t !== null) return t;
    return has(LABEL_MAP, key) ? LABEL_MAP[key] : null;
  }

  // 🔴 短標題:以 SHORT_MAP 為閘門,查無一律 null(跳過),永不退完整名
  function resolveShortAttr(key) {
    if (!has(SHORT_MAP, key)) return null;
    var t = i18nLookup('short', key);
    return (t !== null) ? t : SHORT_MAP[key];
  }

  function hydrateAttr(scope, attrName, resolve) {
    var nodes = scope.querySelectorAll('[' + attrName + ']');
    for (var i = 0; i < nodes.length; i++) {
      var el  = nodes[i];
      var key = el.getAttribute(attrName);
      if (!key) continue;
      var next = resolve(key);
      if (next === null) continue;            // 解不出 → 保留 HTML 原文
      if (el.textContent !== next) el.textContent = next;
    }
  }

  function pcHydrateStatusLabels(root) {
    var scope = root || document;
    if (!scope || typeof scope.querySelectorAll !== 'function') return;
    hydrateAttr(scope, 'data-pc-status-label', resolveLabelAttr);
    hydrateAttr(scope, 'data-pc-status-short', resolveShortAttr);
  }

  // ── 對外掛載 ──
  window.PC_QUOTE_STATUS_LABEL = LABEL_MAP;
  window.PC_QUOTE_STATUS_SHORT = SHORT_MAP;
  window.PC_QUOTE_STATUS_SLUG  = SLUG_MAP;
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

  // ── 語言變更後重新水合(CB-62 B1)──
  // 語言檔是非同步載入的:首次水合時 pcT 可能還沒有字典,此時走英文
  // (正確,英文零 FOUC),i18n.js 載完會發出本事件,這裡再補一次。
  // 使用者手動切換語言時同理。admin 頁沒有 i18n.js,本事件永遠不會發生。
  document.addEventListener('pc:i18n-changed', function () {
    pcHydrateStatusLabels(document);
  });
})();
