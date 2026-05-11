/* ============================================================
 * ProCraft Dealer Portal — Quote Flow Header Component v1.3
 *
 * Renders a minimal header for the new-quote step1/2/2.5/3 flow:
 *  - (Optional) Orange "Admin Mode" bar
 *  - Green main bar: Logo + Step indicator (1—2—3—4) + Discard button
 *
 * Usage in step pages:
 *   <div id="pcd-quote-flow-header" data-step="1"></div>
 *   <script src="components/quote-flow-header.js"></script>
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
 * ============================================================ */

(function () {
  'use strict';

  const SUPABASE_URL = 'https://acwgemgpnusworpxxoai.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_GYx1PEpxNJ9dj5V3WYpPWQ_8YfB0w8M';
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

    /* Mobile (<500px) — hide step labels, keep circles */
    @media (max-width: 500px) {
      .pcd-qfh-step-label { display: none; }
      .pcd-qfh-step:not(:last-child)::after { width: 24px; margin: 0 6px; }
      .pcd-qfh-bar { padding: 0 14px; }
      .pcd-qfh-logo { height: 32px; max-width: 90px; }
      .pcd-qfh-discard { padding: 6px 10px; font-size: 10px; letter-spacing: 0.08em; }
    }
  `;

  // v1.2: 4 steps total. Step 3 (Modifications) inserted between Products and Review.
  const STEP_LABELS = ['Order Info', 'Products', 'Modifications', 'Review'];
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
          <span class="pcd-qfh-step-label">${STEP_LABELS[n - 1]}</span>
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
    `;
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
    const label = opts.isResumingReturned ? 'Cancel Editing' : 'Discard';

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

    const confirmMsg = opts.isResumingReturned
      ? 'Cancel editing? Unsaved changes will be lost.'
      : 'Discard your changes? Unsaved data will be lost.';

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
        if (window.confirm('Discard your unsaved changes?')) {
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
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
