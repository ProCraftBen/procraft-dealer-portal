/* ══════════════════════════════════════════════════════════════════════════
 * components/reminder-modal.js — CB-82 Reminder 表單 modal(新增 / 編輯共用)
 *
 * 🔴 存在理由(CB-82 Q-19 = B):
 *    新增與編輯用的是【同一份表單】。單元 7 時這份 modal 內嵌在
 *    quote-detail.html;單元 11 要讓 admin-reminders.html 也能編輯,
 *    若各自留一份,就是 new-quote-step3 / quote-detail / pdf-builder
 *    那個三檔同步單元的翻版 —— 改一個欄位要記得改兩個地方,漏了不報錯。
 *    現在只有一份副本,抽出來的成本最低。
 *
 * 🔴 本模組【只負責表單 UI】,不碰 DB。
 *    resolve(payload) 或 resolve(null)(取消)。寫入由呼叫端自理 ——
 *    quote-detail 做 INSERT、admin-reminders 做 UPDATE,兩者的後續處理
 *    (旗標同步 / 重新載入清單)也不同。把 DB 塞進來會逼出一堆分支。
 *
 * 🔴 形態沿用 components/order-complete.js 的 openDateModal():
 *      - 樣式自注入且冪等(STYLE_ID 守衛),class 全帶 pcrm- 前綴
 *      - 主色帶 fallback,不依賴呼叫頁是否定義 CSS 變數
 *      - DOM 掛 document.body 層級,不受任何父層冒泡影響
 *      - Promise 化
 *    前綴 pcrm- 與既有 pcoc- / pcd- 不碰撞。
 *
 * 🔴 英文硬編碼,不掛任何 i18n 標記。
 *    quote-detail.html 有載入 i18n.js(dealer/admin 共用頁),但 admin
 *    專屬元素一律硬編碼(CB-62 Q-5 / CB-66)。未載入對應 key 的標記會
 *    成為死標記(F-25 同類)。
 *
 * 用法:
 *   const payload = await window.ProCraftReminderModal.open({
 *     title:    'Add Reminder',        // 或 'Edit Reminder'
 *     subtitle: 'PDC09013',            // 顯示在標題下方,通常是單號
 *     values:   { type, reminder_date, subject, description }  // 選填,edit 用
 *   });
 *   // payload === null 代表取消
 *
 * 🔴 solved 的 reminder【不可編輯】(PM Q-20),且 DB 層已擋
 *    (admin_update_quote_reminders 的 USING 含 status = 'marked')。
 *    呼叫端負責不渲染 Edit 按鈕;本模組不檢查狀態 —— 它不知道 status,
 *    也不該知道。
 *
 * 引入:<script src="components/reminder-modal.js"></script>
 *   置於 config.js 之後即可,無其他相依。
 * ═══════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // 冪等防護(對齊 navigator.js 的 __pcdNavigatorLoaded 慣例)。
  if (window.ProCraftReminderModal) return;

  var PCRM_STYLE_ID = 'pcrm-styles';

  // Q-18 定版:僅前端限制,不做 DB CHECK —— 與 reminder_date 必填規則同一理由
  // (admin-only 內部工具,DB 層做長度/條件限制成本不成比例)。
  var PCRM_SUBJECT_MAX = 120;
  var PCRM_DESC_MAX    = 500;

  // 🔴 Type 為 backorder / payment 時 Date 必填(需求書定版)。
  //    正向識別(F-35):列出「需要日期」的型別,不寫 type !== 'other' ——
  //    未來新增第四種型別時,負向判斷會把它一併當成必填,且不報錯。
  var PCRM_DATE_REQUIRED_TYPES = ['backorder', 'payment'];

  // 🔴 模組自帶,不依賴呼叫頁是否有同名函式 —— 兩頁各有一份 escapeHtml,
  //    行為目前相同,但那是巧合不是契約。
  function pcrmEscapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function pcrmInjectStyles() {
    if (document.getElementById(PCRM_STYLE_ID)) return;
    const css = ''
      + '.pcrm-overlay{position:fixed;inset:0;z-index:10000;background:rgba(15,23,42,.55);'
      + 'display:flex;align-items:center;justify-content:center;padding:20px;'
      + "font-family:'DM Sans',sans-serif;-webkit-font-smoothing:antialiased;}"
      + '.pcrm-box{background:#fff;border-radius:10px;width:100%;max-width:520px;'
      + 'box-shadow:0 20px 50px rgba(15,23,42,.28);overflow:hidden;'
      + 'max-height:90vh;display:flex;flex-direction:column;}'
      + '.pcrm-head{padding:20px 24px 14px;border-bottom:1px solid #E5E7EB;flex:0 0 auto;}'
      + '.pcrm-title{margin:0;font-size:17px;font-weight:600;color:#0F172A;letter-spacing:-.01em;}'
      + '.pcrm-sub{margin:4px 0 0;font-size:12px;color:#64748B;}'
      + '.pcrm-body{padding:18px 24px;overflow-y:auto;flex:1 1 auto;}'
      + '.pcrm-field{margin-bottom:16px;}'
      + '.pcrm-field:last-child{margin-bottom:0;}'
      + '.pcrm-label{display:block;font-size:9px;font-weight:600;letter-spacing:.18em;'
      + 'text-transform:uppercase;color:#64748B;margin-bottom:7px;}'
      + '.pcrm-req{color:#C0392B;}'
      + '.pcrm-input,.pcrm-select,.pcrm-area{width:100%;box-sizing:border-box;'
      + 'padding:10px 12px;font-size:14px;font-family:inherit;color:#0F172A;'
      + 'border:1.5px solid #CBD5E1;border-radius:7px;background:#fff;}'
      + '.pcrm-area{min-height:96px;resize:vertical;line-height:1.5;}'
      + '.pcrm-input:focus,.pcrm-select:focus,.pcrm-area:focus{outline:none;'
      + 'border-color:var(--green-dark,#3e5a42);box-shadow:0 0 0 3px rgba(62,90,66,.14);}'
      + '.pcrm-counter{margin-top:5px;font-size:11px;color:#94A3B8;text-align:right;}'
      + '.pcrm-hint{margin-top:5px;font-size:11px;color:#64748B;line-height:1.5;}'
      + '.pcrm-err{display:none;margin:0 0 14px;padding:10px 12px;border-radius:6px;'
      + 'background:#FEF2F2;border:1px solid #FECACA;font-size:12px;line-height:1.55;color:#991B1B;}'
      + '.pcrm-err.show{display:block;}'
      + '.pcrm-foot{padding:14px 24px 20px;display:flex;gap:10px;justify-content:flex-end;'
      + 'border-top:1px solid #E5E7EB;flex:0 0 auto;background:#fff;}'
      + '.pcrm-btn{font-family:inherit;font-size:13px;font-weight:500;padding:9px 18px;'
      + 'border-radius:7px;cursor:pointer;border:1px solid transparent;transition:opacity .15s;}'
      + '.pcrm-btn:disabled{opacity:.5;cursor:not-allowed;}'
      + '.pcrm-cancel{background:#fff;border-color:#CBD5E1;color:#475569;}'
      + '.pcrm-cancel:hover:not(:disabled){background:#F8FAFC;}'
      + '.pcrm-save{background:var(--green-dark,#3e5a42);color:#fff;}'
      + '.pcrm-save:hover:not(:disabled){opacity:.88;}'
      + '@media(max-width:480px){.pcrm-foot{flex-direction:column-reverse;}'
      + '.pcrm-btn{width:100%;}}';
    const el = document.createElement('style');
    el.id = PCRM_STYLE_ID;
    el.textContent = css;
    document.head.appendChild(el);
  }

  /* resolve({type, reminder_date, subject, description}) 或 resolve(null) 代表取消。
   * 驗證未通過時【不關閉】modal —— 關掉會讓使用者重打一次,且看不到錯在哪。 */
  function pcrmOpenModal(opts) {
      opts = opts || {};
    return new Promise(function (resolve) {
      pcrmInjectStyles();

      const label = String(opts.subtitle || '');
      const title = String(opts.title || 'Add Reminder');
      const v     = opts.values || {};

      const overlay = document.createElement('div');
      overlay.className = 'pcrm-overlay';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.innerHTML = ''
        + '<div class="pcrm-box">'
        +   '<div class="pcrm-head">'
        +     '<h3 class="pcrm-title">' + pcrmEscapeHtml(title) + '</h3>'
        +     '<p class="pcrm-sub">' + pcrmEscapeHtml(label) + '</p>'
        +   '</div>'
        +   '<div class="pcrm-body">'
        +     '<div class="pcrm-err" id="pcrm-err"></div>'
        +     '<div class="pcrm-field">'
        +       '<label class="pcrm-label" for="pcrm-type">Type <span class="pcrm-req">*</span></label>'
        +       '<select class="pcrm-select" id="pcrm-type">'
        +         '<option value="">Select a type…</option>'
        +         '<option value="backorder">Backorder</option>'
        +         '<option value="payment">Payment</option>'
        +         '<option value="other">Other</option>'
        +       '</select>'
        +     '</div>'
        +     '<div class="pcrm-field">'
        +       '<label class="pcrm-label" for="pcrm-date">Date</label>'
        +       '<input class="pcrm-input" id="pcrm-date" type="date"/>'
        +       '<div class="pcrm-hint" id="pcrm-date-hint">Required for Backorder and Payment.</div>'
        +     '</div>'
        +     '<div class="pcrm-field">'
        +       '<label class="pcrm-label" for="pcrm-subject">Subject <span class="pcrm-req">*</span></label>'
        +       '<input class="pcrm-input" id="pcrm-subject" type="text" autocomplete="off" maxlength="' + PCRM_SUBJECT_MAX + '"/>'
        +     '</div>'
        +     '<div class="pcrm-field">'
        +       '<label class="pcrm-label" for="pcrm-desc">Description</label>'
        +       '<textarea class="pcrm-area" id="pcrm-desc" maxlength="' + PCRM_DESC_MAX + '"></textarea>'
        +       '<div class="pcrm-counter" id="pcrm-desc-count">0 / ' + PCRM_DESC_MAX + '</div>'
        +     '</div>'
        +   '</div>'
        +   '<div class="pcrm-foot">'
        +     '<button type="button" class="pcrm-btn pcrm-cancel" id="pcrm-cancel">Cancel</button>'
        +     '<button type="button" class="pcrm-btn pcrm-save" id="pcrm-save">Save Reminder</button>'
        +   '</div>'
        + '</div>';

      document.body.appendChild(overlay);

      const elType = overlay.querySelector('#pcrm-type');
      const elDate = overlay.querySelector('#pcrm-date');
      const elSubj = overlay.querySelector('#pcrm-subject');
      const elDesc = overlay.querySelector('#pcrm-desc');
      const elErr  = overlay.querySelector('#pcrm-err');
      const elSave = overlay.querySelector('#pcrm-save');
      const elCnt  = overlay.querySelector('#pcrm-desc-count');

      // ── edit 模式預填 ─────────────────────────────────────
      // 🔴 直接寫 .value，不走 innerHTML —— 使用者輸入的 subject /
      //    description 可能含引號與尖括號，組字串絕對不行。
      // 🔴 reminder_date 為 "YYYY-MM-DD" 純字串，<input type="date"> 的
      //    .value 格式相同，直接貼入；【不】經過 Date 物件往返，
      //    否則會被當成 UTC 午夜解析，美東時區整整少一天。
      if (v.type)          elType.value = v.type;
      if (v.reminder_date) elDate.value = v.reminder_date;
      if (v.subject)       elSubj.value = v.subject;
      if (v.description)   elDesc.value = v.description;
      elCnt.textContent = elDesc.value.length + ' / ' + PCRM_DESC_MAX;

      elDesc.addEventListener('input', function () {
        elCnt.textContent = elDesc.value.length + ' / ' + PCRM_DESC_MAX;
      });

      function showErr(msg) {
        elErr.textContent = msg;
        elErr.classList.add('show');
      }

      let closed = false;
      function close(result) {
        if (closed) return;
        closed = true;
        document.removeEventListener('keydown', onKey, true);
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        resolve(result);
      }

      function onKey(e) {
        if (e.key === 'Escape' || e.key === 'Esc') { e.stopPropagation(); close(null); }
      }
      document.addEventListener('keydown', onKey, true);

      // 覆蓋層點擊關閉;面板內點擊不關(避免打字時誤觸)。
      overlay.addEventListener('click', function (e) { if (e.target === overlay) close(null); });
      overlay.querySelector('#pcrm-cancel').addEventListener('click', function () { close(null); });

      elSave.addEventListener('click', function () {
        elErr.classList.remove('show');

        const type = elType.value;
        // <input type="date"> 的 .value 本身就是 "YYYY-MM-DD" 純字串,直接送。
        // 🔴 全程不得經過 Date 物件往返,否則會被當成 UTC 午夜解析,美東少一天。
        const date = elDate.value;
        const subj = elSubj.value.trim();
        const desc = elDesc.value.trim();

        if (!type) { showErr('Please choose a type.'); elType.focus(); return; }
        if (!subj) { showErr('Subject is required.'); elSubj.focus(); return; }
        if (PCRM_DATE_REQUIRED_TYPES.indexOf(type) !== -1 && !date) {
          showErr('A date is required for Backorder and Payment reminders.');
          elDate.focus();
          return;
        }

        close({
          type:          type,
          reminder_date: date || null,
          subject:       subj,
          description:   desc || null,
        });
      });

      setTimeout(function () { try { elType.focus(); } catch (e) {} }, 30);
    });
  }

  window.ProCraftReminderModal = {
    open: pcrmOpenModal,
    // 常數對外開放:呼叫端若要在自己的畫面上顯示長度限制,不必再抄一份。
    SUBJECT_MAX: PCRM_SUBJECT_MAX,
    DESC_MAX:    PCRM_DESC_MAX,
  };
})();
