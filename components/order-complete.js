/* ──────────────────────────────────────────────────────────────────────
 * ProCraft Dealer Portal — Order Complete Action (CB-55, v1.0)
 *
 * Order Processing → Order Completed 的【唯一】執行路徑。
 * 由 quote-detail.html 與 admin-quotes.html 共用。
 *
 * ── 為何抽成共用模組(Q-17=B)────────────────────────────────────────
 *   這個動作要出現在兩頁,而它是【不可逆】的:寫錯狀態、漏掉守衛、或兩頁的
 *   確認文案漂移,代價都很高。CB-55 的 B-10a 就是活生生的反例 ——
 *   admin-payments.html 把「寫 quotes」實作了三次,結果三次的 status 守衛
 *   不一致(兩處沒有、一處有)。同一個寫入散在多處,遲早長歪。
 *
 *   既有的 releaseStock() 只存在於 quote-detail.html,所以當時不需要抽。
 *   本動作跨兩頁,所以抽。components/ 是全站既有的共用機制
 *   (navigator / footer / feedback-widget),不是為此新增的 pattern。
 *
 * ── 硬規則(不可調換)────────────────────────────────────────────────
 *   ① UPDATE quotes(count:'exact' + status 守衛)
 *   ② 成功後【才】寄信(非阻斷 —— 寄信失敗不回滾狀態)
 *   ③ 完成後交還呼叫端決定如何刷新
 *
 *   status 守衛 .eq('status','Order Processing') 防併發:兩個 super_admin
 *   同時按 → 只有一個 count=1,另一個 count=0。
 *   admin_update_all_quotes policy 沒有 WITH CHECK,DB 層不會擋,
 *   所以守衛必須在前端自己加。
 *
 *   RLS silent failure:Supabase 被擋時回 0 rows 且無 error →
 *   count===0 一律當成「狀態已被他人變更」處理,不假成功。
 *
 * ── 寄信失敗的處理(Q-12)────────────────────────────────────────────
 *   刻意檢查 res.ok,不採 admin-payments.html 的 fire-and-forget。
 *   感謝信是這張單對外的唯一完成通知,靜默失敗 = dealer 永遠不知道訂單結案。
 *   失敗時明確告知操作者「狀態已轉換但信未寄出,請手動聯繫」。
 *   刻意【不】回滾狀態:狀態轉換優先,不被寄信綁架。
 *
 * ── 呼叫端的責任 ──────────────────────────────────────────────────────
 *   · 只在 super_admin 且 quote.status === 'Order Processing' 時渲染按鈕。
 *     本模組會再驗一次,但那是防禦,不是授權來源。
 *   · 傳入 buttonEl 讓本模組做 mid-flight 防呆(連點只算一次)。
 *   · 傳入 onDone 決定刷新方式(整頁 reload vs 只重載列表)。
 *
 * ── USAGE ─────────────────────────────────────────────────────────────
 *   1. <script src="components/order-complete.js"></script>
 *      放在 config.js 之後(需要 window.SB_URL)。
 *   2. await window.ProCraftOrderComplete.run({
 *        supabase:     _supabase,
 *        quote:        { id, po_number, draft_number, status },
 *        isSuperAdmin: true,
 *        buttonEl:     document.getElementById('completeOrderBtn'),
 *        onDone:       function () { window.location.reload(); }
 *      });
 * ────────────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  // 狀態值集中在此,呼叫端可讀取,避免兩頁各自硬編字串後漂移。
  var REQUIRED_STATUS = 'Order Processing';
  var TARGET_STATUS   = 'Order Completed';

  // 確認彈窗文案(Q-11:native confirm,不另做 modal)。
  // 單一來源 —— 兩頁共用同一份,不會出現「兩頁講的話不一樣」。
  function buildConfirmMessage(quote) {
    var label = quote.po_number || quote.draft_number || 'This order';
    return 'Mark ' + label + ' as complete?\n\n'
      + label + ' will move to Order Completed and a thank-you email will be sent '
      + 'to the dealer immediately.\n\n'
      + 'Order Completed is the final status. This cannot be undone.';
  }

  async function run(opts) {
    opts = opts || {};

    var supabase     = opts.supabase;
    var quote        = opts.quote;
    var isSuperAdmin = !!opts.isSuperAdmin;
    var btn          = opts.buttonEl || null;
    var onDone       = opts.onDone || function () { window.location.reload(); };

    // ── 前置檢查 ────────────────────────────────────────────────────────
    //   前三項若不成立,代表呼叫端渲染條件有誤 → 記 log 方便排查,不彈窗
    //   打擾使用者(使用者不該看到本來就不該出現的按鈕所產生的錯誤)。
    if (!supabase || !quote || !quote.id) {
      console.error('[order-complete] missing supabase client or quote.id — aborted.');
      return;
    }
    if (!isSuperAdmin) {
      console.error('[order-complete] caller is not super_admin — aborted.');
      return;
    }
    if (quote.status !== REQUIRED_STATUS) {
      console.error('[order-complete] quote status is "' + quote.status + '", expected "' + REQUIRED_STATUS + '" — aborted.');
      return;
    }
    // mid-flight 防呆:連點只算一次
    if (btn && btn.disabled) return;

    if (!window.confirm(buildConfirmMessage(quote))) return;

    // 失敗時要還原按鈕原樣。捕捉原始 innerHTML,本模組因此不需要知道
    // 各頁按鈕長什麼樣,也不需要兩頁共用一份 BTN_INNER 常數。
    var originalHtml = btn ? btn.innerHTML : null;
    if (btn) { btn.disabled = true; btn.innerHTML = 'Completing...'; }

    // ── ① quotes → Order Completed ─────────────────────────────────────
    try {
      var upd = await supabase
        .from('quotes')
        .update({ status: TARGET_STATUS }, { count: 'exact' })
        .eq('id', quote.id)
        .eq('status', REQUIRED_STATUS);

      if (upd.error) throw upd.error;

      if (upd.count === 0) {
        // 併發或狀態已被他人變更。什麼都沒寫入,也不寄信。
        window.alert(
          'This order is no longer in Order Processing — it may have been changed by someone else.\n\n'
          + 'Nothing was completed and no email was sent.\n\nRefreshing now.'
        );
        onDone();
        return;
      }
    } catch (err) {
      console.error('[order-complete] update failed:', err);
      window.alert(
        'Failed to complete this order: ' + (err && err.message ? err.message : 'An unexpected error occurred.')
        + '\n\nNothing was changed. Please try again.'
      );
      if (btn) { btn.disabled = false; btn.innerHTML = originalHtml; }
      return;
    }

    // ── ② 感謝信(非阻斷:狀態已轉換,不回滾)──────────────────────────
    //   send-followup-email 內部會重撈 quote 並驗 status === 'Order Completed',
    //   所以此處必須在 ① 成功之後才呼叫,順序不可調換。
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

    // ── ③ 結果回報 + 交還刷新 ───────────────────────────────────────────
    window.alert(emailOk
      ? 'Order marked as complete. The dealer has been sent a thank-you email.'
      : 'Order marked as complete, but the thank-you email failed to send.\n\n'
        + 'The order status has been updated correctly — please contact the dealer manually.');

    onDone();
  }

  window.ProCraftOrderComplete = {
    run: run,
    REQUIRED_STATUS: REQUIRED_STATUS,
    TARGET_STATUS: TARGET_STATUS
  };
})();
