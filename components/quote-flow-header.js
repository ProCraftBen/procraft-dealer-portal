/* ============================================================
 * ProCraft Dealer Portal — Quote Flow Header Component v1.5
 *
 * v1.5 (CB-62 B4-1a): i18n. Step labels, the Discard button and both
 *   confirm() messages are looked up from the language files when
 *   components/i18n.js is present; otherwise the English written here is
 *   used verbatim. Re-renders on pc:i18n-changed.
 *   No language switch here by design (Q-32): the flow pages inherit the
 *   language already chosen elsewhere and remembered in localStorage.
 *
 * Renders a minimal header for the new-quote step1/2/2.5/3 flow:
 *  - (Optional) Orange "Admin Mode" bar
 *  - Green main bar: Logo + Step indicator (1—2—3—4) + Discard button
 *
 * Usage in step pages:
 *   <div id="pcd-quote-flow-header" data-step="1"></div>
 *   <script src="components/quote-flow-header.js?v=1.5"></script>
 *
 * Optional attributes on the mount div:
 *   data-step="1|2|3|4"      — current step (required)
 *     1 = Order Info       (new-quote.html)
 *     2 = Products         (new-quote-step2.html)
 *     3 = Modifications    (new-quote-modifications.html)
 *     4 = Review           (new-quote-step3.html)
 *
 * The component reads context from URL params + sessionStorage + DB:
 *   ?adminDraft=1            → admin creating a draft on dealer's behalf
 *   ?draft={quoteId}         → resuming a Draft or Returned quote
 *   sessionStorage.quoteStep1 → may contain isResumingReturned flag + dealerIdForQuote
 *   sessionStorage.adminDraftDealerId → dealer id for admin-draft mode (PRIMARY SOURCE)
 *   DB lookup (fallback)     → quote.status === 'Returned'
 *                              (handles first entry from quote-detail before
 *                               step1's init() writes sessionStorage)
 *
 * Logo click → confirm dialog (avoids accidental data loss).
 * Discard button → context-aware label + target.
 * Admin Mode bar → shown when admin is editing on dealer's behalf.
 *
 * v1.1 fix: Resolve isResumingReturned in async path (with DB fallback)
 *           so Admin Mode bar shows on first entry to step1, not just
 *           when sessionStorage already has the flag.
 *
 * v1.2 (E1.10): Added Step 2.5 "Modifications" as a full-fledged step.
 *               Total steps now 4 instead of 3. data-step="3" now means
 *               Modifications; data-step="4" means Review (Step 3 page).
 *
 * v1.3 (F5): Fix Admin Mode bar disappearing after navigation.
 *            Previously the bar required ?adminDraft=1 in the URL, which
 *            was only present on initial entry from dashboard. Any
 *            in-flow navigation (Step 2→2.5, Step 2.5→3, Back links)
 *            dropped the param and hid the banner across all subsequent
 *            pages.
 *            Now: banner shows if EITHER
 *              (a) URL has ?adminDraft=1, OR
 *              (b) sessionStorage has adminDraftDealerId (no URL needed)
 *            sessionStorage is the more durable source — it's set when
 *            admin clicks "Create Draft for Dealer" on the dashboard and
 *            persists for the full flow.
 *            Single-file change resolves banner on Step 2 (second entry),
 *            Step 2.5, Step 3, and any future page that uses this header.
 *
 * v1.4 (CB-51.1): Discount visibility in the quote flow.
 *            Renders an empty <div id="pcd-discount-mount"> under the green
 *            bar and then dynamically loads components/navigator.js, which
 *            detects "no #pcd-nav but a #pcd-discount-mount" and runs in
 *            headless mode: it resolves which dealer this flow is serving,
 *            reads that dealer's discount rules and injects a clickable
 *            strip + modal into the mount.
 *
 *            THIS FILE OWNS NO DISCOUNT LOGIC. It does not query
 *            dealer_discount_rules, does not format rules and does not
 *            build the modal — navigator.js is the single owner of all of
 *            that (CB-51). All this file contributes is the mount point and
 *            the load order.
 *
 *            The script is appended AFTER renderSkeleton() has put the
 *            mount in the DOM, so navigator.js always finds it. That makes
 *            ordering a property of this file rather than of every page's
 *            <script> tag sequence — the four step pages need no change.
 * ============================================================ */

// components/navigator.js: this section for zooming 120%

(function injectGlobalStyles() {
  const style = document.createElement('style');
  style.id = 'global-ui-scale';
  style.textContent = `
    @media (min-width: 768px) {
      html {
        zoom: 1.2;
      }
    }
  `;
  document.head.appendChild(style);
})();

// 

(function () {
  'use strict';

  const SUPABASE_URL = window.SB_URL;
  const SUPABASE_KEY = window.SB_KEY;
  const LOGO_URL     = 'https://acwgemgpnusworpxxoai.supabase.co/storage/v1/object/public/assets/ProCraft-DC-Logo-white.png';

  const CSS = `
    .pcd-qfh-wrap { font-family: 'DM Sans', sans-serif; }

    /* Orange Admin Mode bar */
    .pcd-qfh-admin {
      background: #E07B39;
      color: #fff;
      padding: 8px 20px;
      font-size: 12px;
      line-height: 1.5;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-direction: column;
      text-align: center;
      letter-spacing: 0.04em;
    }
    .pcd-qfh-admin-title {
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .pcd-qfh-admin-title svg { width: 12px; height: 12px; fill: #fff; }
    .pcd-qfh-admin-detail {
      font-size: 12px;
      font-weight: 400;
      opacity: 0.95;
      margin-top: 2px;
    }
    .pcd-qfh-admin-detail strong { font-weight: 600; }

    /* Green main bar */
    .pcd-qfh-bar {
      background: #3e5a42;
      height: 60px;
      padding: 0 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      position: sticky;
      top: 0;
      z-index: 100;
    }
    .pcd-qfh-logo {
      height: 38px;
      max-width: 110px;
      object-fit: contain;
      cursor: pointer;
      flex-shrink: 0;
    }

    /* Step indicator (center) */
    .pcd-qfh-steps {
      display: flex;
      align-items: center;
      gap: 0;
    }
    .pcd-qfh-step {
      display: flex;
      align-items: center;
      gap: 7px;
    }
    .pcd-qfh-step:not(:last-child)::after {
      content: '';
      width: 36px;
      height: 1px;
      background: rgba(255,255,255,0.25);
      margin: 0 8px;
    }
    .pcd-qfh-step-circle {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      border: 1.5px solid rgba(255,255,255,0.35);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      font-weight: 500;
      color: rgba(255,255,255,0.5);
      flex-shrink: 0;
      transition: all 0.2s;
    }
    .pcd-qfh-step.done .pcd-qfh-step-circle {
      background: #C9A84C;
      border-color: #C9A84C;
      color: #fff;
    }
    .pcd-qfh-step.active .pcd-qfh-step-circle {
      background: #fff;
      border-color: #fff;
      color: #3e5a42;
    }
    .pcd-qfh-step-label {
      font-size: 10px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: rgba(255,255,255,0.5);
    }
    .pcd-qfh-step.active .pcd-qfh-step-label {
      color: #fff;
      font-weight: 500;
    }
    .pcd-qfh-step.done .pcd-qfh-step-label {
      color: rgba(255,255,255,0.7);
    }

    /* Discard button (right) */
    .pcd-qfh-discard {
      font-size: 11px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: rgba(255,255,255,0.7);
      cursor: pointer;
      border: 1px solid rgba(255,255,255,0.25);
      border-radius: 3px;
      padding: 7px 14px;
      background: transparent;
      font-family: 'DM Sans', sans-serif;
      transition: all 0.15s;
      flex-shrink: 0;
      white-space: nowrap;
    }
    .pcd-qfh-discard:hover {
      color: #fff;
      border-color: rgba(255,255,255,0.5);
      background: rgba(255,255,255,0.05);
    }

    /* CB-51.1: mount point for the headless discount strip.
       Empty until navigator.js injects into it, and it only does so when
       the flow is serving a dealer who actually has rules — so pages with
       nothing to show keep the exact header they have today.
       Deliberately NOT sticky: .pcd-qfh-wrap is only as tall as its
       children, so .pcd-qfh-bar's own sticky positioning has no travel
       room and this header already scrolls away on these pages. The strip
       matches that behaviour instead of inventing a different one. */
    #pcd-discount-mount:empty { display: none; }

    /* Mobile (<500px) — hide step labels, keep circles */
    @media (max-width: 500px) {
      .pcd-qfh-step-label { display: none; }
      .pcd-qfh-step:not(:last-child)::after { width: 24px; margin: 0 6px; }
      .pcd-qfh-bar { padding: 0 14px; }
      .pcd-qfh-logo { height: 32px; max-width: 90px; }
      .pcd-qfh-discard { padding: 6px 10px; font-size: 10px; letter-spacing: 0.08em; }
    }
  `;

  // ═══════════════════════════════════════════════════════════════════
  // CB-62 B4-1a|i18n 區域輔助
  // -------------------------------------------------------------------
  // pcT 未載入或字典未就緒時回 null → 一律帶英文保底,畫面不得出現 "null"。
  // 報價流程四頁【不放語言切換鈕】(Q-32 採 C):語言是全站狀態,dealer 在
  // 進入流程前就選好了,localStorage 全程記住,這四頁只負責以當前語言渲染。
  // ═══════════════════════════════════════════════════════════════════
  function t(key, fallback, params) {
    return (typeof window.pcT === 'function' && window.pcT(key, params)) || fallback;
  }

  // v1.2: 4 steps total. Step 3 (Modifications) inserted between Products and Review.
  // CB-62: label 僅供顯示;TOTAL_STEPS 取陣列長度,翻譯不影響步數。
  const STEP_LABELS = [
    { key: 'flow.step.order_info',    label: 'Order Info' },
    { key: 'flow.step.products',      label: 'Products' },
    { key: 'flow.step.modifications', label: 'Modifications' },
    { key: 'flow.step.review',        label: 'Review' },
  ];
  const TOTAL_STEPS = STEP_LABELS.length;  // = 4

  function injectCss() {
    if (document.getElementById('pcd-qfh-css')) return;
    const style = document.createElement('style');
    style.id = 'pcd-qfh-css';
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  function renderSkeleton(container, currentStep) {
    container.classList.add('pcd-qfh-wrap');
    // v1.2: iterate over TOTAL_STEPS instead of hard-coded [1,2,3]
    const stepNumbers = [];
    for (let i = 1; i <= TOTAL_STEPS; i++) stepNumbers.push(i);

    const stepsHtml = stepNumbers.map((n) => {
      let cls = 'pcd-qfh-step';
      let circle = String(n);
      if (n < currentStep) { cls += ' done'; circle = '✓'; }
      else if (n === currentStep) { cls += ' active'; }
      return `
        <div class="${cls}">
          <div class="pcd-qfh-step-circle">${circle}</div>
          <span class="pcd-qfh-step-label">${t(STEP_LABELS[n - 1].key, STEP_LABELS[n - 1].label)}</span>
        </div>`;
    }).join('');

    container.innerHTML = `
      <div class="pcd-qfh-admin" id="pcd-qfh-admin" style="display:none;">
        <div class="pcd-qfh-admin-title">
          <svg viewBox="0 0 24 24"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z"/></svg>
          Admin Mode
        </div>
        <div class="pcd-qfh-admin-detail" id="pcd-qfh-admin-detail">Creating draft</div>
      </div>
      <div class="pcd-qfh-bar">
        <img class="pcd-qfh-logo" id="pcd-qfh-logo" src="${LOGO_URL}" alt="ProCraft DC"/>
        <div class="pcd-qfh-steps">${stepsHtml}</div>
        <button class="pcd-qfh-discard" id="pcd-qfh-discard">Discard</button>
      </div>
      <div id="pcd-discount-mount"></div>
    `;
  }

  // ── CB-51.1: hand the discount half over to navigator.js ──────────
  // Called immediately after renderSkeleton(), so the mount already exists
  // when the script starts executing. Idempotent, and a no-op if the mount
  // is missing for any reason.
  function loadDiscountModule() {
    if (document.getElementById('pcd-navigator-headless')) return;
    if (!document.getElementById('pcd-discount-mount')) return;
    const s = document.createElement('script');
    s.id    = 'pcd-navigator-headless';
    s.src   = 'components/navigator.js';
    s.async = false;
    document.body.appendChild(s);
  }

  // ── Context resolution (sync only — DB-aware bits resolved later) ──
  function readContext() {
    const params = new URLSearchParams(window.location.search);
    const draftId = params.get('draft') || null;
    const urlAdminDraftFlag = params.get('adminDraft') === '1';

    let isResumingReturnedHint = false;
    let adminDealerIdHint = null;
    try {
      const s1raw = sessionStorage.getItem('quoteStep1');
      if (s1raw) {
        const s1 = JSON.parse(s1raw);
        if (s1 && s1.isResumingReturned) isResumingReturnedHint = true;
        if (s1 && s1.dealerIdForQuote) adminDealerIdHint = s1.dealerIdForQuote;
      }
    } catch (_) { /* ignore */ }

    if (!adminDealerIdHint) {
      adminDealerIdHint = sessionStorage.getItem('adminDraftDealerId') || null;
    }

    // v1.3 (F5): "is this an admin-draft session?" should not require the
    // URL flag every time — sessionStorage.adminDraftDealerId is the durable
    // source (set on dashboard "Create Draft for Dealer", persists across
    // all in-flow navigation). The URL flag is just an additional hint that
    // also forces the admin path even when sessionStorage is missing.
    const adminDraftFlag = urlAdminDraftFlag || !!adminDealerIdHint;

    return { draftId, adminDraftFlag, isResumingReturnedHint, adminDealerIdHint };
  }

  // ── Discard label + target resolver ─────────────────────────
  function resolveDiscard(opts) {
    const label = opts.isResumingReturned
      ? t('flow.btn.cancel_editing', 'Cancel Editing')
      : t('flow.btn.discard', 'Discard');

    let target;
    if (opts.isResumingReturned && opts.draftId) {
      target = `quote-detail.html?id=${opts.draftId}`;
    } else if (opts.adminDraftFlag) {
      target = 'admin-quotes.html';
    } else if (opts.draftId) {
      target = opts.viewerIsAdmin ? 'admin-quotes.html' : 'quotes.html';
    } else {
      target = opts.viewerIsAdmin ? 'admin.html' : 'dashboard.html';
    }

    // 原生 confirm() 無法用標記,於呼叫點查表(CB-62 B4 / Q-31)。
    const confirmMsg = opts.isResumingReturned
      ? t('flow.confirm.cancel_editing', 'Cancel editing? Unsaved changes will be lost.')
      : t('flow.confirm.discard', 'Discard your changes? Unsaved data will be lost.');

    return { label, target, confirmMsg };
  }

  function resolveLogoTarget(viewerIsAdmin) {
    return viewerIsAdmin ? 'admin.html' : 'dashboard.html';
  }

  function bindBehaviors(opts) {
    const btn = document.getElementById('pcd-qfh-discard');
    if (btn) {
      const { label, target, confirmMsg } = resolveDiscard(opts);
      btn.textContent = label;
      btn.onclick = () => {
        if (window.confirm(confirmMsg)) {
          try {
            sessionStorage.removeItem('quoteStep1');
            sessionStorage.removeItem('quoteStep2');
            // v1.3 (F5): also clear admin-draft marker on Discard so the
            // banner doesn't leak into the next quote attempt.
            sessionStorage.removeItem('adminDraftDealerId');
          } catch (_) {}
          window.location.href = target;
        }
      };
    }

    const logo = document.getElementById('pcd-qfh-logo');
    if (logo) {
      logo.onclick = () => {
        if (window.confirm(t('flow.confirm.logo', 'Discard your unsaved changes?'))) {
          try {
            sessionStorage.removeItem('quoteStep1');
            sessionStorage.removeItem('quoteStep2');
            // v1.3 (F5): same as Discard — clear admin-draft marker.
            sessionStorage.removeItem('adminDraftDealerId');
          } catch (_) {}
          window.location.href = resolveLogoTarget(opts.viewerIsAdmin);
        }
      };
    }
  }

  function showAdminBar(dealerName) {
    const bar = document.getElementById('pcd-qfh-admin');
    const detail = document.getElementById('pcd-qfh-admin-detail');
    if (!bar || !detail) return;
    const safeName = (dealerName || '').replace(/[<>&"']/g, (c) => ({
      '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;'
    })[c]);
    detail.innerHTML = `Creating draft for: <strong>${safeName || 'dealer'}</strong>`;
    bar.style.display = 'flex';
  }

  async function resolveAsyncContext(ctx) {
    if (!window.supabase || !window.supabase.createClient) {
      return {
        viewerIsAdmin: false,
        isResumingReturned: ctx.isResumingReturnedHint,
        adminBarDealerName: null,
      };
    }

    const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

    let session = null;
    try {
      const { data } = await sb.auth.getSession();
      session = data && data.session ? data.session : null;
    } catch (_) { /* ignore */ }

    if (!session) {
      return {
        viewerIsAdmin: false,
        isResumingReturned: ctx.isResumingReturnedHint,
        adminBarDealerName: null,
      };
    }

    let viewerIsAdmin = false;
    try {
      const { data: me } = await sb.from('dealers')
        .select('role').eq('id', session.user.id).single();
      const role = me && me.role ? me.role : 'dealer';
      viewerIsAdmin = (role === 'admin' || role === 'super_admin');
    } catch (_) { /* ignore */ }

    let isResumingReturned = ctx.isResumingReturnedHint;
    let quoteOwnerDealerId = null;

    if (ctx.draftId) {
      try {
        const { data: q } = await sb.from('quotes')
          .select('status, dealer_id').eq('id', ctx.draftId).single();
        if (q) {
          quoteOwnerDealerId = q.dealer_id || null;
          if (q.status === 'Returned') isResumingReturned = true;
        }
      } catch (_) { /* ignore */ }
    }

    let adminBarDealerName = null;
    let targetDealerId = null;

    // v1.3 (F5): ctx.adminDraftFlag now reflects URL OR sessionStorage,
    // so this branch fires for the full flow, not just initial entry.
    if (ctx.adminDraftFlag) {
      targetDealerId = ctx.adminDealerIdHint;
    } else if (viewerIsAdmin && ctx.draftId && quoteOwnerDealerId) {
      targetDealerId = quoteOwnerDealerId;
    }

    if (targetDealerId && targetDealerId !== session.user.id) {
      try {
        const { data: targetDealer } = await sb.from('dealers')
          .select('company_name, contact_name')
          .eq('id', targetDealerId).single();
        if (targetDealer) {
          adminBarDealerName = targetDealer.company_name
            || targetDealer.contact_name
            || 'dealer';
        }
      } catch (_) { /* ignore */ }
    }

    return { viewerIsAdmin, isResumingReturned, adminBarDealerName };
  }

  function renderInto(container) {
    const stepAttr = parseInt(container.getAttribute('data-step') || '1', 10);
    // v1.2: bounds check now allows up to TOTAL_STEPS (was 3, now 4)
    const currentStep = (stepAttr >= 1 && stepAttr <= TOTAL_STEPS) ? stepAttr : 1;

    const ctx = readContext();

    injectCss();
    renderSkeleton(container, currentStep);
    loadDiscountModule();

    bindBehaviors({
      draftId:            ctx.draftId,
      adminDraftFlag:     ctx.adminDraftFlag,
      isResumingReturned: ctx.isResumingReturnedHint,
      viewerIsAdmin:      false,
    });

    resolveAsyncContext(ctx).then((res) => {
      bindBehaviors({
        draftId:            ctx.draftId,
        adminDraftFlag:     ctx.adminDraftFlag,
        isResumingReturned: res.isResumingReturned,
        viewerIsAdmin:      res.viewerIsAdmin,
      });

      if (res.adminBarDealerName) {
        showAdminBar(res.adminBarDealerName);
      }
    }).catch(() => { /* fail-soft */ });
  }

  function init() {
    const container = document.getElementById('pcd-quote-flow-header');
    if (!container) return;
    renderInto(container);

    // CB-62 B4-1a:語言變更 → 重繪整條流程列。
    // 這條列沒有使用者輸入(logo / 步驟 / Discard 按鈕),整段重建無風險;
    // 折扣模組由 loadDiscountModule() 於 renderInto 內重新掛回。
    document.addEventListener('pc:i18n-changed', function () {
      renderInto(container);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
