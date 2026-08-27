/* ──────────────────────────────────────────────────────────────────────
 * ProCraft Dealer Portal — Order Fulfilled Action (CB-55 / CB-59, v2.0)
 *
 * Order Processing → Order Completed 的【唯一】執行路徑。
 * 由 quote-detail.html 與 admin-quotes.html 共用。
 *
 * ── CB-59 相對 CB-55 的變更 ──────────────────────────────────────────
 *   ① 對外名稱 Complete → Fulfilled(DB status 值【不變】,仍是
 *      'Order Completed' —— 顯示renames 一律 display-only)
 *   ② 新增 fulfillment date 選擇 modal,與 status 同一筆 UPDATE 寫入
 *   ③ 權限由 super_admin only 放寬為 admin + super_admin
 *      (opts.isSuperAdmin → opts.isAdmin)
 *   ④ 移除 native confirm,警語併入 modal,Finish 為唯一確認點
 *
 * ── 為何抽成共用模組(Q-17=B)────────────────────────────────────────
 *   這個動作要出現在兩頁,而它是【不可逆】的:寫錯狀態、漏掉守衛、或兩頁的
 *   確認文案漂移,代價都很高。CB-55 的 B-10a 就是活生生的反例 ——
 *   admin-payments.html 把「寫 quotes」實作了三次,結果三次的 status 守衛
 *   不一致(兩處沒有、一處有)。同一個寫入散在多處,遲早長歪。
 *
 *   CB-59 的 modal 也放在本模組內(Q-1=A):quote-detail.html 全檔沒有任何
 *   modal 基礎設施,若兩頁各寫一份,不但要在該頁憑空長出整套 modal CSS,
 *   兩頁的日期文案與警語也會走上 B-10a 的老路。modal 由本模組自行注入
 *   DOM + scoped CSS,兩頁零 markup。
 *
 * ── 硬規則(不可調換)────────────────────────────────────────────────
 *   ① modal 取得 fulfillment date
 *   ② UPDATE quotes(status + fulfillment_date 同一筆,count:'exact'
 *      + status 前態守衛)
 *   ③ 成功後【才】寄信(非阻斷 —— 寄信失敗不回滾狀態)
 *   ④ 完成後交還呼叫端決定如何刷新
 *
 *   status 與 fulfillment_date 必須同一筆 UPDATE,不拆兩次寫:
 *   拆開會產生「狀態已轉但日期沒寫進去」的中間態,而 status 一旦變成
 *   Order Completed 就再也不符合前態守衛,第二筆補寫將永遠失敗。
 *
 *   status 守衛 .eq('status','Order Processing') 防併發:兩個 admin
 *   同時按 → 只有一個 count=1,另一個 count=0。
 *
 *   ⚠️ CB-55 原註解稱「admin_update_all_quotes 沒有 WITH CHECK,DB 層
 *      不會擋」—— 此敘述不精確。PostgreSQL 在 UPDATE policy 的 WITH CHECK
 *      為 null 時會【自動沿用 USING】作為 WITH CHECK,new row 其實有被檢查。
 *      結論(DB 不擋)仍成立,但理由是該 USING 完全不引用 row 的任何欄位,
 *      只查呼叫者在 dealers 的 role:
 *        USING (EXISTS (SELECT 1 FROM dealers
 *                       WHERE id = auth.uid()
 *                         AND role IN ('admin','super_admin')))
 *      因此無論寫什麼 status 值、或寫新增的 fulfillment_date,DB 都不擋
 *      → 前態守衛必須在前端自己加。(對齊 F-13 教訓:先確認 policy 實際
 *        生效的是 USING 還是 WITH CHECK,再下結論。)
 *
 *   RLS silent failure:Supabase 被擋時回 0 rows 且無 error →
 *   count===0 一律當成「狀態已被他人變更」處理,不假成功。
 *
 * ── 權限放寬的後端證據(CB-59 階段 0,staging 實測)──────────────────
 *   靜態:admin_update_all_quotes USING 只查 role(見上);
 *        trg_enforce_dealer_quote_transition 首行即
 *        `IF auth.uid() IS NULL OR auth.uid() <> OLD.dealer_id
 *         THEN RETURN NEW; END IF;`
 *        → admin 改他人的單直接放行,不進轉換矩陣。
 *   動態:以 role='admin' 帳號實測 UPDATE
 *        → count=1、error=null、re-read 確認 status 已落地。
 *   結論:放寬純屬前端渲染條件,未修改任何 policy / trigger。
 *
 * ── 寄信失敗的處理(Q-12)────────────────────────────────────────────
 *   刻意檢查 res.ok,不採 admin-payments.html 的 fire-and-forget。
 *   感謝信是這張單對外的唯一完成通知,靜默失敗 = dealer 永遠不知道訂單結案。
 *   失敗時明確告知操作者「狀態已轉換但信未寄出,請手動聯繫」。
 *   刻意【不】回滾狀態:狀態轉換優先,不被寄信綁架。
 *
 *   ⚠️ 信體【不帶】fulfillment_date —— body 仍只有 notification_type
 *      + quote_id,send-followup-email Edge Function 零改動、不需 redeploy。
 *
 * ── 呼叫端的責任 ──────────────────────────────────────────────────────
 *   · 只在 admin / super_admin 且 quote.status === 'Order Processing'
 *     時渲染按鈕。本模組會再驗一次,但那是防禦,不是授權來源。
 *   · 傳入 buttonEl 讓本模組做 mid-flight 防呆(連點只算一次)。
 *   · 傳入 onDone 決定刷新方式(整頁 reload vs 只重載列表)。
 *
 * ── USAGE ─────────────────────────────────────────────────────────────
 *   1. <script src="components/order-complete.js"></script>
 *      放在 config.js 之後(需要 window.SB_URL)。
 *   2. await window.ProCraftOrderComplete.run({
 *        supabase: _supabase,
 *        quote:    { id, po_number, draft_number, status },
 *        isAdmin:  true,
 *        buttonEl: document.getElementById('fulfillOrderBtn'),
 *        onDone:   function () { window.location.reload(); }
 *      });
 * ────────────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  // 狀態值集中在此,呼叫端可讀取,避免兩頁各自硬編字串後漂移。
  // ⚠️ DB status 值不因 CB-59 改名而變動 —— Fulfilled 只是顯示層說法。
  var REQUIRED_STATUS = 'Order Processing';
  var TARGET_STATUS   = 'Order Completed';

  var STYLE_ID = 'pcoc-styles';

  /* ── 日期工具 ─────────────────────────────────────────────────────────
   * 🔴 fulfillment_date 是 DB 的 date 型別,PostgREST 收送皆為 "YYYY-MM-DD"
   *    純字串。全程【不得】經過 Date 物件往返,否則會被當成 UTC 午夜解析,
   *    美東時區顯示/送出時整整少一天。
   *    <input type="date"> 的 .value 本身就是 "YYYY-MM-DD",直接送即可。
   * ─────────────────────────────────────────────────────────────────── */

  // 今天(local)。刻意不用 new Date().toISOString().split('T')[0] ——
  // 那取的是 UTC 日期,美東 20:00 後 UTC 已跨日,預設值會變成「明天」。
  function todayLocalISO() {
    var d = new Date();
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  // "2026-08-06" → "August 6, 2026"。以 local 分量建構,不走 UTC 解析。
  function prettyDate(iso) {
    var p = String(iso || '').split('-');
    if (p.length !== 3) return iso || '';
    var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ── modal 樣式(僅注入一次)──────────────────────────────────────────
   * class 全數以 pcoc- 前綴,避免與 admin-quotes.html 既有的
   * .modal-overlay / .modal-box 碰撞。主色帶 fallback,本模組不依賴
   * 頁面是否定義了 CSS 變數。
   * ─────────────────────────────────────────────────────────────────── */
  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var css = ''
      + '.pcoc-overlay{position:fixed;inset:0;z-index:10000;background:rgba(15,23,42,.55);'
      + 'display:flex;align-items:center;justify-content:center;padding:20px;'
      + 'font-family:inherit;-webkit-font-smoothing:antialiased;}'
      + '.pcoc-box{background:#fff;border-radius:10px;width:100%;max-width:440px;'
      + 'box-shadow:0 20px 50px rgba(15,23,42,.28);overflow:hidden;'
      + 'max-height:90vh;display:flex;flex-direction:column;}'
      + '.pcoc-head{padding:20px 24px 14px;border-bottom:1px solid #E5E7EB;}'
      + '.pcoc-title{margin:0;font-size:17px;font-weight:600;color:#0F172A;letter-spacing:-.01em;}'
      + '.pcoc-sub{margin:4px 0 0;font-size:12px;color:#64748B;}'
      + '.pcoc-body{padding:20px 24px;overflow-y:auto;}'
      + '.pcoc-label{display:block;font-size:9px;font-weight:600;letter-spacing:.18em;'
      + 'text-transform:uppercase;color:#64748B;margin-bottom:7px;}'
      + '.pcoc-date{width:100%;box-sizing:border-box;padding:11px 12px;font-size:15px;'
      + 'font-family:inherit;color:#0F172A;border:1.5px solid #CBD5E1;border-radius:7px;'
      + 'background:#fff;}'
      + '.pcoc-date:focus{outline:none;border-color:var(--status-order-completed,#0F766E);'
      + 'box-shadow:0 0 0 3px rgba(15,118,110,.14);}'
      + '.pcoc-note{margin:12px 0 0;padding:10px 12px;border-radius:6px;'
      + 'background:#F0FDFA;border:1px solid #99F6E4;font-size:12px;line-height:1.55;color:#115E59;}'
      + '.pcoc-warn{margin:12px 0 0;padding:10px 12px;border-radius:6px;'
      + 'background:#FFFBEB;border:1px solid #FDE68A;font-size:12px;line-height:1.55;color:#92400E;}'
      + '.pcoc-foot{padding:14px 24px 20px;display:flex;gap:10px;justify-content:flex-end;'
      + 'border-top:1px solid #E5E7EB;}'
      + '.pcoc-btn{font-family:inherit;font-size:13px;font-weight:500;padding:9px 18px;'
      + 'border-radius:7px;cursor:pointer;border:1px solid transparent;transition:opacity .15s;}'
      + '.pcoc-btn:disabled{opacity:.5;cursor:not-allowed;}'
      + '.pcoc-cancel{background:#fff;border-color:#CBD5E1;color:#475569;}'
      + '.pcoc-cancel:hover:not(:disabled){background:#F8FAFC;}'
      + '.pcoc-finish{background:var(--status-order-completed,#0F766E);color:#fff;}'
      + '.pcoc-finish:hover:not(:disabled){opacity:.88;}'
      + '@media(max-width:480px){.pcoc-foot{flex-direction:column-reverse;}'
      + '.pcoc-btn{width:100%;}}';
    var el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = css;
    document.head.appendChild(el);
  }

  /* ── fulfillment date modal ───────────────────────────────────────────
   * resolve(選定的 "YYYY-MM-DD") 或 resolve(null) 代表取消。
   * DOM 掛在 document.body 層級 —— admin-quotes.html 的資料列有
   * toggleDetail onclick,掛 body 天然不受冒泡影響(B-3)。
   * ─────────────────────────────────────────────────────────────────── */
  function openDateModal(quote) {
    return new Promise(function (resolve) {
      injectStyles();

      var label   = quote.po_number || quote.draft_number || 'This order';
      var initial = todayLocalISO();

      var overlay = document.createElement('div');
      overlay.className = 'pcoc-overlay';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.innerHTML = ''
        + '<div class="pcoc-box">'
        +   '<div class="pcoc-head">'
        +     '<h3 class="pcoc-title">Mark as Fulfilled</h3>'
        +     '<p class="pcoc-sub">' + escapeHtml(label) + '</p>'
        +   '</div>'
        +   '<div class="pcoc-body">'
        +     '<label class="pcoc-label" for="pcocDate">Fulfillment Date</label>'
        +     '<input type="date" id="pcocDate" class="pcoc-date" value="' + initial + '">'
        +     '<p class="pcoc-note" id="pcocNote"></p>'
        +     '<p class="pcoc-warn">This order will move to Order Completed and a '
        +       'thank-you email will be sent to the dealer. Order Completed is the '
        +       'final status. This cannot be undone.</p>'
        +   '</div>'
        +   '<div class="pcoc-foot">'
        +     '<button type="button" class="pcoc-btn pcoc-cancel" id="pcocCancel">Cancel</button>'
        +     '<button type="button" class="pcoc-btn pcoc-finish" id="pcocFinish">Finish</button>'
        +   '</div>'
        + '</div>';

      document.body.appendChild(overlay);

      var input  = overlay.querySelector('#pcocDate');
      var note   = overlay.querySelector('#pcocNote');
      var finish = overlay.querySelector('#pcocFinish');
      var cancel = overlay.querySelector('#pcocCancel');

      // 註記文字隨所選日期即時更新。
      // 未來日期【不】延後寄信 —— 這句是票上明列的必要提醒。
      function syncNote() {
        var v = input.value;
        if (!v) {
          note.textContent = 'Please select a fulfillment date.';
          finish.disabled = true;
          return;
        }
        finish.disabled = false;
        note.textContent = 'Fulfillment date set to ' + prettyDate(v)
          + '. The completion email will be sent immediately, regardless of '
          + 'the date selected.';
      }
      syncNote();

      var closed = false;
      function close(value) {
        if (closed) return;
        closed = true;
        document.removeEventListener('keydown', onKey, true);
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        resolve(value);
      }

      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); close(null); }
      }

      input.addEventListener('input',  syncNote);
      input.addEventListener('change', syncNote);
      cancel.addEventListener('click', function () { close(null); });
      finish.addEventListener('click', function () {
        if (!input.value) return;
        close(input.value);
      });
      // 點遮罩本身(非內容)= 取消
      overlay.addEventListener('mousedown', function (e) {
        if (e.target === overlay) close(null);
      });
      document.addEventListener('keydown', onKey, true);

      setTimeout(function () { try { input.focus(); } catch (e) {} }, 30);
    });
  }

  async function run(opts) {
    opts = opts || {};

    var supabase = opts.supabase;
    var quote    = opts.quote;
    var isAdmin  = !!opts.isAdmin;
    var btn      = opts.buttonEl || null;
    var onDone   = opts.onDone || function () { window.location.reload(); };

    // ── 前置檢查 ────────────────────────────────────────────────────────
    //   前三項若不成立,代表呼叫端渲染條件有誤 → 記 log 方便排查,不彈窗
    //   打擾使用者(使用者不該看到本來就不該出現的按鈕所產生的錯誤)。
    if (!supabase || !quote || !quote.id) {
      console.error('[order-complete] missing supabase client or quote.id — aborted.');
      return;
    }
    if (!isAdmin) {
      console.error('[order-complete] caller is not admin/super_admin — aborted.');
      return;
    }
    if (quote.status !== REQUIRED_STATUS) {
      console.error('[order-complete] quote status is "' + quote.status + '", expected "' + REQUIRED_STATUS + '" — aborted.');
      return;
    }
    // mid-flight 防呆:連點只算一次
    if (btn && btn.disabled) return;

    // ── CB-82: 未處理 reminder 警告（前置、僅警告）────────────────
    // 刻意不編入下方 ①②③④ 的步驟序列 —— 那四步是【寫入流程】，
    // 本段是流程開始前的把關，且不寫入任何東西。編號會讓日後對照
    // 注解與實際步驟數不一致。
    //
    // 🔴 本模組【不自行查 DB】—— 旗標由呼叫端傳入（PM 預設值 #9 = B）。
    //    兩個呼叫端本來就已持有該資料：admin-quotes 有標示用的集合，
    //    quote-detail 有該單的未處理數。模組自查等於多一次往返，
    //    且讓本模組多一個對資料表的依賴。
    //
    // 🔴 兩種情境的文案刻意不同：
    //      hasOpenReminder      —— 確知有未處理事項
    //      reminderCheckFailed  —— 查詢失敗，【不知道】有沒有
    //    合併成同一句等於把「查不到」講成「沒有」——
    //    那正是本票要防的事。
    //
    // 🔴 呼叫端若【兩個旗標都沒傳】，實際效果是不警告、直接放行。
    //    漏改呼叫端的症狀是「該警告時沒警告」，不會報錯 ——
    //    故兩個呼叫端必須一起改、一起驗。
    //
    // 🔴 對齊 CB-76 Q-36：破壞性操作用重量級把關，提醒用輕量機制。
    //    此處確實是提醒 —— 只跳 confirm()，按確定照常繼續，
    //    【不擋、不碰狀態轉換】。
    if (opts.reminderCheckFailed) {
      if (!window.confirm(
        'This order could not be checked for unresolved reminders.\n\n'
        + 'There may be outstanding backorder or payment issues that are not shown.\n\n'
        + 'Mark it as fulfilled anyway?'
      )) return;
    } else if (opts.hasOpenReminder) {
      if (!window.confirm(
        'This order still has unresolved reminders.\n\n'
        + 'Open the Reminders page to review them before closing this order.\n\n'
        + 'Mark it as fulfilled anyway?'
      )) return;
    }

    // ── ① fulfillment date(取消 = 什麼都不做)──────────────────────────
    var fulfillmentDate = await openDateModal(quote);
    if (!fulfillmentDate) return;

    // 失敗時要還原按鈕原樣。捕捉原始 innerHTML,本模組因此不需要知道
    // 各頁按鈕長什麼樣,也不需要兩頁共用一份 BTN_INNER 常數。
    var originalHtml = btn ? btn.innerHTML : null;
    if (btn) { btn.disabled = true; btn.innerHTML = 'Saving...'; }

    // ── ② quotes → Order Completed + fulfillment_date(同一筆)──────────
    try {
      var upd = await supabase
        .from('quotes')
        .update({
          status: TARGET_STATUS,
          fulfillment_date: fulfillmentDate
        }, { count: 'exact' })
        .eq('id', quote.id)
        .eq('status', REQUIRED_STATUS);

      if (upd.error) throw upd.error;

      if (upd.count === 0) {
        // 併發或狀態已被他人變更。什麼都沒寫入,也不寄信。
        window.alert(
          'This order is no longer in Order Processing — it may have been changed by someone else.\n\n'
          + 'Nothing was changed and no email was sent.\n\nRefreshing now.'
        );
        onDone();
        return;
      }
    } catch (err) {
      console.error('[order-complete] update failed:', err);
      window.alert(
        'Failed to mark this order as fulfilled: ' + (err && err.message ? err.message : 'An unexpected error occurred.')
        + '\n\nNothing was changed. Please try again.'
      );
      if (btn) { btn.disabled = false; btn.innerHTML = originalHtml; }
      return;
    }

    // ── ③ 感謝信(非阻斷:狀態已轉換,不回滾)──────────────────────────
    //   send-followup-email 內部會重撈 quote 並驗 status === 'Order Completed',
    //   所以此處必須在 ② 成功之後才呼叫,順序不可調換。
    //   body 不帶 fulfillment_date —— Edge Function 零改動。
    var emailOk = true;
    try {
      var sess  = await supabase.auth.getSession();
      var token = (sess && sess.data && sess.data.session) ? sess.data.session.access_token : '';

      var res = await fetch(window.SB_URL + '/functions/v1/send-followup-email', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token
        },
        body: JSON.stringify({
          notification_type: 'order_completed',
          quote_id: quote.id
        })
      });

      if (!res.ok) {
        emailOk = false;
        console.error('[order-complete] send-followup-email returned', res.status);
      }
    } catch (emailErr) {
      emailOk = false;
      console.error('[order-complete] send-followup-email failed (non-blocking):', emailErr);
    }

    // ── ④ 結果回報 + 交還刷新 ───────────────────────────────────────────
    window.alert(emailOk
      ? 'Order marked as fulfilled (' + prettyDate(fulfillmentDate) + '). '
        + 'The dealer has been sent a thank-you email.'
      : 'Order marked as fulfilled (' + prettyDate(fulfillmentDate) + '), '
        + 'but the thank-you email failed to send.\n\n'
        + 'The order status has been updated correctly — please contact the dealer manually.');

    onDone();
  }

  window.ProCraftOrderComplete = {
    run: run,
    REQUIRED_STATUS: REQUIRED_STATUS,
    TARGET_STATUS: TARGET_STATUS
  };
})();
