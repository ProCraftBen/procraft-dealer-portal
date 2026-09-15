/* ══════════════════════════════════════════════════════════════════════
 * components/order-close.js  —  CB-92 已付款單作廢改單(Void Paid Order & Close)
 * ──────────────────────────────────────────────────────────────────────
 * 比照 components/order-complete.js:IIFE、自行注入 modal、class 前綴 pcvc-。
 *
 * ── 授權與寫入全部在 DB ─────────────────────────────────────────────────
 *   本模組只呼叫 RPC public.close_paid_order(),不直接寫任何表。
 *   RPC 於單一交易內:super_admin 授權 → 前態守衛 → store credit = 0
 *   → confirmed 恰 1 筆且 id 相符 → quotes Closed → payments cancelled。
 *   🔴 本模組的所有前置檢查都只是【UX 鏡像】,不是授權來源。
 *      任何一項鏡像與 DB 不一致時,以 RPC 的結果為準。
 *
 * ── 自動帶入項(Q-16)───────────────────────────────────────────────────
 *   金額 / 付款方式 / 處理人 / 日期 在 modal 中【唯讀】顯示,
 *   並明確標示 "Auto-filled — cannot be edited"(主 PM 要求)。
 *   🔴 寫入 DB 的說明由 RPC 從 DB 重新讀值組合,不採用本模組顯示的值。
 *      畫面上的 Preview 只是預覽。
 *
 * ── 畫面與 DB 的對帳(Q-7)────────────────────────────────────────────
 *   modal 顯示的 confirmed payment id 會作為 p_payment_id 送出。
 *   RPC 斷言兩者相同,不同即 RAISE(40001)—— 作廢的必定是操作者看到的那筆。
 *
 * ── 重量級把關(Q-9,對齊 CB-76 Q-36)───────────────────────────────────
 *   須輸入【本單】PO# 完全相符,Void 按鈕才會啟用。
 *   Q-17 已撤回:沒有「新單 PO#」欄位,此處只有一個 PO# 輸入。
 *
 * ── 不做的事 ──────────────────────────────────────────────────────────
 *   不寄信(Q-11)、不寫 quotes.close_reason(Q-3)、不改 PDF(Q-12)。
 *
 * ── 呼叫端的責任 ──────────────────────────────────────────────────────
 *   · 只在 role === 'super_admin' 且 status ∈ {Order Processing, Order Completed}
 *     時渲染按鈕。本模組會再驗一次,但那是防禦,不是授權來源。
 *   · 傳入 buttonEl 做 mid-flight 防呆。
 *   · 傳入 onDone 決定刷新方式。
 *
 * ── USAGE ─────────────────────────────────────────────────────────────
 *   1. <script src="components/order-close.js"></script>
 *   2. await window.ProCraftOrderClose.run({
 *        supabase:     _supabase,
 *        quote:        { id, po_number, draft_number, status },
 *        isSuperAdmin: true,
 *        buttonEl:     document.getElementById('voidCloseBtn'),
 *        onDone:       function () { window.location.reload(); }
 *      });
 *   3. 顯示分類名:window.ProCraftOrderClose.closeReasonLabel(quote.close_reason_type)
 * ────────────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  // DB canonical 值。比對一律用這些值,顯示名另行 map(顯示 ≠ 值)。
  var SOURCE_STATUSES = ['Order Processing', 'Order Completed'];
  var RPC_NAME        = 'close_paid_order';
  var REASON_MAX      = 500;   // 與 RPC 的 char_length 上限一致

  // close_reason_type 值域(與 quotes_close_reason_type_check 三值一致)
  var CLOSE_REASON_TYPES = ['bulk_return', 'bulk_exchange', 'other'];
  var CLOSE_REASON_LABELS = {
    bulk_return:   'Bulk return',
    bulk_exchange: 'Bulk exchange',
    other:         'Other'
  };

  var STYLE_ID = 'pcvc-styles';

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // 未知值原樣顯示,不猜(F-35):值域外的值出現代表 CHECK 被動過,應被看見。
  function closeReasonLabel(value) {
    if (value == null) return '';
    return Object.prototype.hasOwnProperty.call(CLOSE_REASON_LABELS, value)
      ? CLOSE_REASON_LABELS[value]
      : String(value);
  }

  // 與 RPC 相同的正規化:所有空白(含換行)壓成單一空格並去頭尾。
  function normalizeReason(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  }

  // 以 code point 計數,對齊 PostgreSQL char_length(emoji 不算兩個)。
  function codePointLength(s) {
    return Array.from(s).length;
  }

  // 與 RPC to_char(..., 'FM999,999,999,990.00') 相同的呈現。
  function formatAmount(n) {
    var v = Number(n);
    if (!isFinite(v)) return String(n);
    return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // 美東當日 YYYY-MM-DD(與 RPC 的 America/New_York 一致;不走 toISOString 的 UTC)。
  function todayNewYorkISO() {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
      }).format(new Date());
    } catch (e) {
      return '';
    }
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var css = ''
      + '.pcvc-overlay{position:fixed;inset:0;z-index:10000;background:rgba(15,23,42,.55);'
      + 'display:flex;align-items:center;justify-content:center;padding:20px;'
      + 'font-family:inherit;-webkit-font-smoothing:antialiased;}'
      + '.pcvc-box{background:#fff;border-radius:10px;width:100%;max-width:520px;'
      + 'box-shadow:0 20px 50px rgba(15,23,42,.28);overflow:hidden;'
      + 'max-height:92vh;display:flex;flex-direction:column;}'
      + '.pcvc-head{padding:20px 24px 14px;border-bottom:1px solid #E5E7EB;}'
      + '.pcvc-title{margin:0;font-size:17px;font-weight:600;color:#0F172A;letter-spacing:-.01em;}'
      + '.pcvc-sub{margin:4px 0 0;font-size:12px;color:#64748B;}'
      + '.pcvc-body{padding:18px 24px;overflow-y:auto;}'
      + '.pcvc-section{margin:0 0 18px;}'
      + '.pcvc-section:last-child{margin-bottom:0;}'
      + '.pcvc-label{display:block;font-size:9px;font-weight:600;letter-spacing:.18em;'
      + 'text-transform:uppercase;color:#64748B;margin-bottom:7px;}'
      + '.pcvc-auto{border:1px dashed #CBD5E1;border-radius:7px;background:#F8FAFC;padding:10px 12px;}'
      + '.pcvc-auto-tag{display:inline-block;font-size:10px;font-weight:600;color:#475569;'
      + 'background:#E2E8F0;border-radius:4px;padding:2px 6px;margin-bottom:8px;}'
      + '.pcvc-auto-row{display:flex;justify-content:space-between;gap:12px;font-size:13px;'
      + 'color:#334155;padding:3px 0;}'
      + '.pcvc-auto-row span:first-child{color:#64748B;}'
      + '.pcvc-auto-row span:last-child{font-weight:500;text-align:right;}'
      + '.pcvc-input,.pcvc-select,.pcvc-textarea{width:100%;box-sizing:border-box;padding:10px 12px;'
      + 'font-size:14px;font-family:inherit;color:#0F172A;border:1.5px solid #CBD5E1;'
      + 'border-radius:7px;background:#fff;}'
      + '.pcvc-textarea{min-height:84px;resize:vertical;line-height:1.5;}'
      + '.pcvc-input:focus,.pcvc-select:focus,.pcvc-textarea:focus{outline:none;border-color:#B91C1C;'
      + 'box-shadow:0 0 0 3px rgba(185,28,28,.12);}'
      + '.pcvc-hint{margin:6px 0 0;font-size:11px;color:#64748B;line-height:1.5;}'
      + '.pcvc-count{float:right;}'
      + '.pcvc-preview{margin:0;padding:10px 12px;border-radius:6px;background:#F1F5F9;'
      + 'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.55;'
      + 'color:#334155;word-break:break-word;}'
      + '.pcvc-danger{margin:0 0 18px;padding:10px 12px;border-radius:6px;background:#FEF2F2;'
      + 'border:1px solid #FECACA;font-size:12px;line-height:1.6;color:#991B1B;}'
      + '.pcvc-danger ul{margin:6px 0 0;padding-left:18px;}'
      + '.pcvc-block{margin:0 0 18px;padding:10px 12px;border-radius:6px;background:#FFFBEB;'
      + 'border:1px solid #FDE68A;font-size:12px;line-height:1.55;color:#92400E;}'
      + '.pcvc-error{margin:12px 0 0;padding:10px 12px;border-radius:6px;background:#FEF2F2;'
      + 'border:1px solid #FCA5A5;font-size:12px;line-height:1.55;color:#991B1B;white-space:pre-wrap;}'
      + '.pcvc-loading{font-size:13px;color:#64748B;padding:8px 0;}'
      + '.pcvc-foot{padding:14px 24px 20px;display:flex;gap:10px;justify-content:flex-end;'
      + 'border-top:1px solid #E5E7EB;}'
      + '.pcvc-btn{font-family:inherit;font-size:13px;font-weight:500;padding:9px 18px;'
      + 'border-radius:7px;cursor:pointer;border:1px solid transparent;transition:opacity .15s;}'
      + '.pcvc-btn:disabled{opacity:.45;cursor:not-allowed;}'
      + '.pcvc-cancel{background:#fff;border-color:#CBD5E1;color:#475569;}'
      + '.pcvc-cancel:hover:not(:disabled){background:#F8FAFC;}'
      + '.pcvc-void{background:#B91C1C;color:#fff;}'
      + '.pcvc-void:hover:not(:disabled){opacity:.88;}'
      + '.pcvc-hidden{display:none;}'
      + '@media(max-width:480px){.pcvc-foot{flex-direction:column-reverse;}.pcvc-btn{width:100%;}}';
    var el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = css;
    document.head.appendChild(el);
  }

  /* ── 載入 modal 需要顯示的資料(全部唯讀)────────────────────────────────
   * 回傳 { ok, blockers[], payment, activeCredits, actorName, today }。
   * blockers 非空 → modal 只顯示原因、Void 按鈕永遠停用。
   * 🔴 查詢失敗一律列為 blocker(fail-closed),不把「查不到」當成「沒有」。
   * ─────────────────────────────────────────────────────────────────── */
  async function loadContext(supabase, quote) {
    var ctx = { blockers: [], payment: null, activeCredits: null, actorName: '', today: todayNewYorkISO() };

    if (!quote.po_number) {
      ctx.blockers.push('This order has no PO number, so it cannot be confirmed for voiding.');
    }

    // ① confirmed payment(鏡像 RPC ⑤)
    try {
      var pay = await supabase
        .from('payments')
        .select('id, total_paid, payment_method, confirmed_at')
        .eq('quote_id', quote.id)
        .eq('status', 'confirmed');
      if (pay.error) throw pay.error;
      var rows = pay.data || [];
      if (rows.length !== 1) {
        ctx.blockers.push('Expected exactly 1 confirmed payment on this order, found ' + rows.length
          + '. A paid order can only be voided when it has exactly one confirmed payment.');
      } else {
        ctx.payment = rows[0];
      }
    } catch (e) {
      console.error('[order-close] payments lookup failed:', e);
      ctx.blockers.push('Could not load the payment for this order: '
        + (e && e.message ? e.message : 'unknown error'));
    }

    // ② store credit(鏡像 RPC ④)
    try {
      var sc = await supabase.rpc('get_quote_store_credit_count', { p_quote_id: quote.id });
      if (sc.error) throw sc.error;
      var c = Array.isArray(sc.data) ? sc.data[0] : sc.data;
      var n = c ? Number(c.active_count) : NaN;
      if (!isFinite(n)) throw new Error('store credit count was not returned');
      ctx.activeCredits = n;
      if (n !== 0) {
        ctx.blockers.push('This order has ' + n + ' active store credit(s). Void them before closing the order.');
      }
    } catch (e) {
      console.error('[order-close] store credit check failed:', e);
      ctx.blockers.push('Could not verify store credits for this order: '
        + (e && e.message ? e.message : 'unknown error'));
    }

    // ③ 處理人(僅供預覽;RPC 自行從 DB 讀取)
    try {
      var sess = await supabase.auth.getSession();
      var uid = sess && sess.data && sess.data.session ? sess.data.session.user.id : null;
      if (!uid) throw new Error('not signed in');
      var me = await supabase.from('dealers').select('contact_name').eq('id', uid).single();
      if (me.error) throw me.error;
      ctx.actorName = (me.data && me.data.contact_name ? String(me.data.contact_name) : '').trim();
      if (!ctx.actorName) {
        ctx.blockers.push('Your account has no contact name. Add one before voiding an order.');
      }
    } catch (e) {
      console.error('[order-close] actor lookup failed:', e);
      ctx.blockers.push('Could not load your account: ' + (e && e.message ? e.message : 'unknown error'));
    }

    return ctx;
  }

  /* ── modal ────────────────────────────────────────────────────────────
   * resolve(RPC 回傳的 data)代表作廢成功;resolve(null)代表取消。
   * RPC 失敗時 modal 不關閉,錯誤原文顯示於內,可修正後重試。
   * ─────────────────────────────────────────────────────────────────── */
  function openModal(supabase, quote) {
    return new Promise(function (resolve) {
      injectStyles();

      var label = quote.po_number || quote.draft_number || 'This order';

      var overlay = document.createElement('div');
      overlay.className = 'pcvc-overlay';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.innerHTML = ''
        + '<div class="pcvc-box">'
        +   '<div class="pcvc-head">'
        +     '<h3 class="pcvc-title">Void Paid Order &amp; Close</h3>'
        +     '<p class="pcvc-sub">' + escapeHtml(label) + ' &middot; ' + escapeHtml(quote.status) + '</p>'
        +   '</div>'
        +   '<div class="pcvc-body" id="pcvcBody">'
        +     '<div class="pcvc-loading">Checking this order…</div>'
        +   '</div>'
        +   '<div class="pcvc-foot">'
        +     '<button type="button" class="pcvc-btn pcvc-cancel" id="pcvcCancel">Cancel</button>'
        +     '<button type="button" class="pcvc-btn pcvc-void" id="pcvcVoid" disabled>Void &amp; Close</button>'
        +   '</div>'
        + '</div>';
      document.body.appendChild(overlay);

      var body    = overlay.querySelector('#pcvcBody');
      var btnVoid = overlay.querySelector('#pcvcVoid');
      var btnCanc = overlay.querySelector('#pcvcCancel');

      var busy = false;
      var closed = false;
      var ctx = null;

      function close(value) {
        if (closed) return;
        closed = true;
        document.removeEventListener('keydown', onKey, true);
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        resolve(value);
      }
      function onKey(e) {
        if (e.key === 'Escape' && !busy) { e.preventDefault(); close(null); }
      }
      btnCanc.addEventListener('click', function () { if (!busy) close(null); });
      overlay.addEventListener('mousedown', function (e) {
        if (e.target === overlay && !busy) close(null);
      });
      document.addEventListener('keydown', onKey, true);

      loadContext(supabase, quote).then(function (loaded) {
        if (closed) return;
        ctx = loaded;
        render();
      });

      function render() {
        if (ctx.blockers.length) {
          body.innerHTML = ''
            + '<div class="pcvc-block"><strong>This order cannot be voided right now.</strong><ul>'
            + ctx.blockers.map(function (b) { return '<li>' + escapeHtml(b) + '</li>'; }).join('')
            + '</ul></div>'
            + '<p class="pcvc-hint">Nothing has been changed.</p>';
          btnVoid.disabled = true;
          return;
        }

        var p = ctx.payment;
        var typeOptions = CLOSE_REASON_TYPES.map(function (v) {
          return '<option value="' + escapeHtml(v) + '">' + escapeHtml(CLOSE_REASON_LABELS[v]) + '</option>';
        }).join('');

        body.innerHTML = ''
          + '<div class="pcvc-danger"><strong>This cannot be undone.</strong><ul>'
          +   '<li>The order moves to <strong>Closed</strong> permanently.</li>'
          +   '<li>The confirmed payment below is marked <strong>cancelled</strong> and no longer counts as revenue.</li>'
          +   '<li>The receipt for this order will no longer be available.</li>'
          +   '<li>No email is sent. Refunds or price differences are handled outside the portal.</li>'
          + '</ul></div>'

          + '<div class="pcvc-section">'
          +   '<span class="pcvc-label">Payment being voided</span>'
          +   '<div class="pcvc-auto">'
          +     '<span class="pcvc-auto-tag">Auto-filled — cannot be edited</span>'
          +     '<div class="pcvc-auto-row"><span>Amount received</span><span>$' + escapeHtml(formatAmount(p.total_paid)) + '</span></div>'
          +     '<div class="pcvc-auto-row"><span>Payment method</span><span>' + escapeHtml(p.payment_method || 'not recorded') + '</span></div>'
          +     '<div class="pcvc-auto-row"><span>Voided by</span><span>' + escapeHtml(ctx.actorName) + '</span></div>'
          +     '<div class="pcvc-auto-row"><span>Date</span><span>' + escapeHtml(ctx.today || '—') + ' (America/New_York)</span></div>'
          +   '</div>'
          + '</div>'

          + '<div class="pcvc-section">'
          +   '<label class="pcvc-label" for="pcvcType">Close reason type</label>'
          +   '<select id="pcvcType" class="pcvc-select">'
          +     '<option value="" selected disabled>Select a type…</option>'
          +     typeOptions
          +   '</select>'
          + '</div>'

          + '<div class="pcvc-section">'
          +   '<label class="pcvc-label" for="pcvcReason">Void reason <span class="pcvc-count" id="pcvcCount">0 / ' + REASON_MAX + '</span></label>'
          +   '<textarea id="pcvcReason" class="pcvc-textarea" maxlength="' + (REASON_MAX * 2) + '" '
          +     'placeholder="e.g. Customer changed products after payment. Replaced by PDC09068 (paid in cash). Card payment refund handled in QBO."></textarea>'
          +   '<p class="pcvc-hint">Write in English — this is saved to the payment record. '
          +     'If there is a replacement order or a price difference, note it here.</p>'
          + '</div>'

          + '<div class="pcvc-section">'
          +   '<span class="pcvc-label">Preview (final text is composed by the server)</span>'
          +   '<p class="pcvc-preview" id="pcvcPreview"></p>'
          + '</div>'

          + '<div class="pcvc-section">'
          +   '<label class="pcvc-label" for="pcvcConfirm">Type this order\u2019s PO number to confirm</label>'
          +   '<input type="text" id="pcvcConfirm" class="pcvc-input" autocomplete="off" spellcheck="false" '
          +     'placeholder="' + escapeHtml(quote.po_number) + '">'
          + '</div>'

          + '<div class="pcvc-error pcvc-hidden" id="pcvcError"></div>';

        var selType = body.querySelector('#pcvcType');
        var txt     = body.querySelector('#pcvcReason');
        var cnt     = body.querySelector('#pcvcCount');
        var prev    = body.querySelector('#pcvcPreview');
        var conf    = body.querySelector('#pcvcConfirm');
        var errBox  = body.querySelector('#pcvcError');

        function currentState() {
          var reason = normalizeReason(txt.value);
          var len = codePointLength(reason);
          return {
            type: selType.value,
            reason: reason,
            len: len,
            typeOk: CLOSE_REASON_TYPES.indexOf(selType.value) !== -1,
            reasonOk: len > 0 && len <= REASON_MAX,
            confirmOk: conf.value.trim() === quote.po_number
          };
        }

        function sync() {
          var s = currentState();
          cnt.textContent = s.len + ' / ' + REASON_MAX;
          cnt.style.color = s.len > REASON_MAX ? '#B91C1C' : '';
          prev.textContent = 'CB-92 void | Type: ' + (s.typeOk ? s.type : '…')
            + ' | Received: $' + formatAmount(p.total_paid) + ' (' + (p.payment_method || 'not recorded') + ')'
            + ' | Reason: ' + (s.reason || '…')
            + ' | By: ' + ctx.actorName
            + ' | Date: ' + (ctx.today || '…') + ' (America/New_York)';
          btnVoid.disabled = busy || !(s.typeOk && s.reasonOk && s.confirmOk);
        }

        selType.addEventListener('change', sync);
        txt.addEventListener('input', sync);
        conf.addEventListener('input', sync);
        sync();

        btnVoid.onclick = async function () {
          var s = currentState();
          if (busy || !(s.typeOk && s.reasonOk && s.confirmOk)) return;

          busy = true;
          errBox.classList.add('pcvc-hidden');
          errBox.textContent = '';
          selType.disabled = txt.disabled = conf.disabled = true;
          btnCanc.disabled = true;
          btnVoid.disabled = true;
          btnVoid.textContent = 'Voiding…';

          try {
            var res = await supabase.rpc(RPC_NAME, {
              p_quote_id:          quote.id,
              p_payment_id:        p.id,
              p_close_reason_type: s.type,
              p_reason:            s.reason
            });
            if (res.error) throw res.error;

            // 🔴 正向確認回傳內容就是這張單、這筆 payment —— 不以「沒報錯」當成功。
            var d = res.data || {};
            if (d.quote_id !== quote.id || d.payment_id !== p.id) {
              console.error('[order-close] unexpected RPC result:', d);
              throw new Error('The server response did not match this order. Please reload and check the order status before trying again.');
            }
            close(d);
          } catch (e) {
            console.error('[order-close] ' + RPC_NAME + ' failed:', e);
            busy = false;
            selType.disabled = txt.disabled = conf.disabled = false;
            btnCanc.disabled = false;
            btnVoid.textContent = 'Void & Close';
            errBox.textContent = 'Nothing was changed.\n\n' + (e && e.message ? e.message : 'An unexpected error occurred.');
            errBox.classList.remove('pcvc-hidden');
            sync();
          }
        };

        setTimeout(function () { try { selType.focus(); } catch (e) {} }, 30);
      }
    });
  }

  async function run(opts) {
    opts = opts || {};
    var supabase     = opts.supabase;
    var quote        = opts.quote;
    var isSuperAdmin = !!opts.isSuperAdmin;
    var btn          = opts.buttonEl || null;
    var onDone       = opts.onDone || function () { window.location.reload(); };

    if (!supabase || !quote || !quote.id) {
      console.error('[order-close] missing supabase client or quote.id — aborted.');
      return;
    }
    if (!isSuperAdmin) {
      console.error('[order-close] caller is not super_admin — aborted.');
      return;
    }
    if (SOURCE_STATUSES.indexOf(quote.status) === -1) {
      console.error('[order-close] quote status is "' + quote.status + '", expected one of ' + SOURCE_STATUSES.join(' / ') + ' — aborted.');
      return;
    }
    if (btn && btn.disabled) return;

    if (btn) btn.disabled = true;
    var result;
    try {
      result = await openModal(supabase, quote);
    } finally {
      if (btn) btn.disabled = false;
    }
    if (!result) return;

    window.alert('Order ' + (result.po_number || quote.po_number || '') + ' has been voided and closed.\n\n'
      + 'The payment is now cancelled and no longer counts as revenue.');
    onDone(result);
  }

  window.ProCraftOrderClose = {
    run: run,
    closeReasonLabel: closeReasonLabel,
    SOURCE_STATUSES: SOURCE_STATUSES.slice(),
    CLOSE_REASON_TYPES: CLOSE_REASON_TYPES.slice()
  };
})();
