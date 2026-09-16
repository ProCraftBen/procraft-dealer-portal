/* ══════════════════════════════════════════════════════════════════════
 * components/stock-release-check.js  —  CB-95 Confirm Stock 前置檢查(delivery 勾選)
 * ──────────────────────────────────────────────────────────────────────
 * 比照 components/order-close.js:IIFE、自行注入 modal、class 前綴 pcsrc-。
 *
 * ── 本模組只負責一件事 ────────────────────────────────────────────────
 *   delivery 單按 Confirm Stock 時,要求 admin 勾選確認後才能繼續(CB-95 需求 ②)。
 *   運費 NULL 閘門、重新讀取、UPDATE 守衛全部留在 quote-detail.html 的
 *   releaseStock(),不在本模組。
 *
 * ── 🔴 不留痕(CB-95 決定 #6)────────────────────────────────────────
 *   純前端的防手滑 + 儀式性提醒,不是責任聲明。本模組不讀、不寫任何表。
 *   誰按了 Confirm Stock 由 CB-83 account_events 記錄;勾選本身不記錄。
 *
 * ── 文案(CB-95 Q-6 = C)──────────────────────────────────────────────
 *   業主原文:我已檢視 delivery 地點,並確認與客戶所選的 scale(價格與距離相匹配)。
 *   dealer 端級距以車程時間標示,故 distance / drive time 並列,語意不變。
 *   🔴 admin 專屬元素:英文硬編碼,不掛任何 i18n 標記(CB-62 Q-5 / CB-66)。
 *
 * ── 🔴 fail-closed ────────────────────────────────────────────────────
 *   無法開啟 modal(無 document.body、已有一個開著)一律 resolve(false),
 *   呼叫端視同取消 —— 不把「沒問到」當成「已確認」。
 *
 * ── 呼叫端的責任 ──────────────────────────────────────────────────────
 *   · 只在 logistic_type === 'delivery' 時呼叫(正向識別,F-35)。
 *     判斷依據須為 releaseStock() 重新讀取的值,不是頁面快照(CB-95 Q-2 B)。
 *   · resolve(true) 才可繼續走既有 confirm();resolve(false) 必須直接 return。
 *
 * ── USAGE ─────────────────────────────────────────────────────────────
 *   1. <script src="components/stock-release-check.js"></script>
 *   2. const ok = await window.ProCraftStockReleaseCheck.confirmDelivery({
 *        poLabel: _quote.po_number || _quote.draft_number || 'This order'
 *      });
 *      if (!ok) return;
 * ────────────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  var STYLE_ID    = 'pcsrc-styles';
  var OVERLAY_CLS = 'pcsrc-overlay';

  var TITLE_TEXT    = 'Confirm delivery rate';
  var CONTEXT_TEXT  = 'This order uses delivery. Check the delivery location before releasing it for payment.';
  var CHECKBOX_TEXT = 'I have reviewed the delivery location and confirm it matches the delivery rate '
                    + 'the customer selected (price matches distance / drive time from ProCraft DC).';

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    // 主色沿用放行按鈕的 --status-stock-review(CB-43 T14-1 鎖定),不新增色值。
    var accent = 'var(--status-stock-review,#0891B2)';
    var css = ''
      // 比照 order-close.js Stage 3 修正:由遮罩層捲動,按鈕在任何視窗高度下都捲得到。
      + '.pcsrc-overlay{position:fixed;inset:0;z-index:10000;background:rgba(15,23,42,.55);'
      + 'display:flex;justify-content:center;padding:20px;overflow-y:auto;'
      + '-webkit-overflow-scrolling:touch;font-family:inherit;-webkit-font-smoothing:antialiased;}'
      + '.pcsrc-box{background:#fff;border-radius:10px;width:100%;max-width:460px;margin:auto 0;'
      + 'box-shadow:0 20px 50px rgba(15,23,42,.28);}'
      + '.pcsrc-head{padding:18px 22px 12px;border-bottom:1px solid #E5E7EB;}'
      + '.pcsrc-title{margin:0;font-size:17px;font-weight:600;color:#0F172A;letter-spacing:-.01em;}'
      + '.pcsrc-sub{margin:4px 0 0;font-size:12px;color:#64748B;}'
      + '.pcsrc-body{padding:16px 22px;}'
      + '.pcsrc-context{margin:0 0 14px;font-size:13px;line-height:1.55;color:#334155;}'
      + '.pcsrc-check{display:flex;gap:10px;align-items:flex-start;padding:12px;border-radius:7px;'
      + 'border:1.5px solid #CBD5E1;background:#F8FAFC;cursor:pointer;}'
      + '.pcsrc-check:hover{border-color:#94A3B8;}'
      + '.pcsrc-check input{flex:0 0 auto;width:18px;height:18px;margin:1px 0 0;cursor:pointer;'
      + 'accent-color:' + accent + ';}'
      + '.pcsrc-check input:focus-visible{outline:2px solid ' + accent + ';outline-offset:2px;}'
      + '.pcsrc-check span{font-size:13px;line-height:1.55;color:#0F172A;}'
      + '.pcsrc-foot{padding:12px 22px 18px;display:flex;gap:10px;justify-content:flex-end;'
      + 'border-top:1px solid #E5E7EB;}'
      + '.pcsrc-btn{font-family:inherit;font-size:13px;font-weight:500;padding:9px 18px;'
      + 'border-radius:7px;cursor:pointer;border:1px solid transparent;transition:opacity .15s;}'
      + '.pcsrc-btn:disabled{opacity:.45;cursor:not-allowed;}'
      + '.pcsrc-btn:focus-visible{outline:2px solid ' + accent + ';outline-offset:2px;}'
      + '.pcsrc-cancel{background:#fff;border-color:#CBD5E1;color:#475569;}'
      + '.pcsrc-cancel:hover:not(:disabled){background:#F8FAFC;}'
      + '.pcsrc-continue{background:' + accent + ';color:#fff;}'
      + '.pcsrc-continue:hover:not(:disabled){opacity:.88;}'
      + '@media(max-width:480px){.pcsrc-foot{flex-direction:column-reverse;}.pcsrc-btn{width:100%;}}'
      + '@media(prefers-reduced-motion:reduce){.pcsrc-btn{transition:none;}}';
    var el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = css;
    document.head.appendChild(el);
  }

  /* ── modal ────────────────────────────────────────────────────────────
   * resolve(true)  = 已勾選並按 Continue。
   * resolve(false) = Cancel / Esc / 點遮罩 / 無法開啟。
   * 每次開啟都是全新 DOM,勾選一律從未勾開始(不沿用上一次)。
   * ─────────────────────────────────────────────────────────────────── */
  function confirmDelivery(opts) {
    return new Promise(function (resolve) {
      // 🔴 fail-closed:開不了 = 沒確認
      if (!document.body || document.querySelector('.' + OVERLAY_CLS)) {
        resolve(false);
        return;
      }

      injectStyles();

      var label = (opts && opts.poLabel) ? opts.poLabel : 'This order';
      var prevFocus = document.activeElement;

      var overlay = document.createElement('div');
      overlay.className = OVERLAY_CLS;
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-labelledby', 'pcsrcTitle');
      overlay.innerHTML = ''
        + '<div class="pcsrc-box">'
        +   '<div class="pcsrc-head">'
        +     '<h3 class="pcsrc-title" id="pcsrcTitle">' + escapeHtml(TITLE_TEXT) + '</h3>'
        +     '<p class="pcsrc-sub">' + escapeHtml(label) + '</p>'
        +   '</div>'
        +   '<div class="pcsrc-body">'
        +     '<p class="pcsrc-context">' + escapeHtml(CONTEXT_TEXT) + '</p>'
        +     '<label class="pcsrc-check" for="pcsrcAck">'
        +       '<input type="checkbox" id="pcsrcAck">'
        +       '<span>' + escapeHtml(CHECKBOX_TEXT) + '</span>'
        +     '</label>'
        +   '</div>'
        +   '<div class="pcsrc-foot">'
        +     '<button type="button" class="pcsrc-btn pcsrc-cancel" id="pcsrcCancel">Cancel</button>'
        +     '<button type="button" class="pcsrc-btn pcsrc-continue" id="pcsrcContinue" disabled>Continue</button>'
        +   '</div>'
        + '</div>';
      document.body.appendChild(overlay);

      var ack     = overlay.querySelector('#pcsrcAck');
      var btnCont = overlay.querySelector('#pcsrcContinue');
      var btnCanc = overlay.querySelector('#pcsrcCancel');

      var closed = false;

      function close(value) {
        if (closed) return;
        closed = true;
        document.removeEventListener('keydown', onKey, true);
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        if (prevFocus && typeof prevFocus.focus === 'function') {
          try { prevFocus.focus(); } catch (e) { /* 焦點還原失敗不影響結果 */ }
        }
        resolve(value);
      }
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); close(false); }
      }

      ack.addEventListener('change', function () {
        btnCont.disabled = !ack.checked;
      });
      // 🔴 Continue 的判準以【當下勾選狀態】為準,不信任 disabled 屬性本身
      //    (disabled 可被 DevTools 移除;防手滑的前提是勾選真的存在)。
      btnCont.addEventListener('click', function () {
        if (ack.checked === true) close(true);
      });
      btnCanc.addEventListener('click', function () { close(false); });
      overlay.addEventListener('mousedown', function (e) {
        if (e.target === overlay) close(false);
      });
      document.addEventListener('keydown', onKey, true);

      ack.focus();
    });
  }

  window.ProCraftStockReleaseCheck = {
    confirmDelivery: confirmDelivery
  };
})();
