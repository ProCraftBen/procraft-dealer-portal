/* ============================================================
 * ProCraft Dealer Portal — Quote Flow Header Component v1.1
 *
 * Renders a minimal header for the new-quote step1/2/3 flow:
 *  - (Optional) Orange "Admin Mode" bar
 *  - Green main bar: Logo + Step indicator (1—2—3) + Discard button
 *
 * Usage in step pages:
 *   <div id="pcd-quote-flow-header" data-step="1"></div>
 *   <script src="components/quote-flow-header.js"></script>
 *
 * Optional attributes on the mount div:
 *   data-step="1|2|3"        — current step (required)
 *
 * The component reads context from URL params + sessionStorage + DB:
 *   ?adminDraft=1            → admin creating a draft on dealer's behalf
 *   ?draft={quoteId}         → resuming a Draft or Returned quote
 *   sessionStorage.quoteStep1 → may contain isResumingReturned flag
 *   sessionStorage.adminDraftDealerId → dealer id for admin-draft mode
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

  const STEP_LABELS = ['Order Info', 'Products', 'Review'];

  function injectCss() {
    if (document.getElementById('pcd-qfh-css')) return;
    const style = document.createElement('style');
    style.id = 'pcd-qfh-css';
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  function renderSkeleton(container, currentStep) {
    container.classList.add('pcd-qfh-wrap');
    const stepsHtml = [1, 2, 3].map((n) => {
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
  // Returns: {
  //   draftId, adminDraftFlag,
  //   isResumingReturnedHint  — from sessionStorage (may be false even when actually
  //                             resuming Returned, if step1 hasn't written sessionStorage yet)
  //   adminDealerIdHint       — from sessionStorage (admin-draft mode)
  // }
  function readContext() {
    const params = new URLSearchParams(window.location.search);
    const draftId = params.get('draft') || null;
    const adminDraftFlag = params.get('adminDraft') === '1';

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

    return { draftId, adminDraftFlag, isResumingReturnedHint, adminDealerIdHint };
  }

  // ── Discard label + target resolver ─────────────────────────
  function resolveDiscard(opts) {
    // Label: "Cancel Editing" only when resuming a Returned quote
    const label = opts.isResumingReturned ? 'Cancel Editing' : 'Discard';

    // Target URL
    let target;
    if (opts.isResumingReturned && opts.draftId) {
      target = `quote-detail.html?id=${opts.draftId}`;
    } else if (opts.adminDraftFlag) {
      target = 'admin-quotes.html';
    } else if (opts.draftId) {
      // Editing a plain Draft → list of quotes
      target = opts.viewerIsAdmin ? 'admin-quotes.html' : 'quotes.html';
    } else {
      // Brand new quote
      target = opts.viewerIsAdmin ? 'admin.html' : 'dashboard.html';
    }

    // Confirm message
    const confirmMsg = opts.isResumingReturned
      ? 'Cancel editing? Unsaved changes will be lost.'
      : 'Discard your changes? Unsaved data will be lost.';

    return { label, target, confirmMsg };
  }

  // ── Logo click target (where to go when user confirms) ──────
  function resolveLogoTarget(viewerIsAdmin) {
    return viewerIsAdmin ? 'admin.html' : 'dashboard.html';
  }

  function bindBehaviors(opts) {
    // Discard button
    const btn = document.getElementById('pcd-qfh-discard');
    if (btn) {
      const { label, target, confirmMsg } = resolveDiscard(opts);
      btn.textContent = label;
      // Replace listener on every call so re-binding (after async resolves) wins
      btn.onclick = () => {
        if (window.confirm(confirmMsg)) {
          try {
            sessionStorage.removeItem('quoteStep1');
            sessionStorage.removeItem('quoteStep2');
          } catch (_) {}
          window.location.href = target;
        }
      };
    }

    // Logo click — confirm before leaving
    const logo = document.getElementById('pcd-qfh-logo');
    if (logo) {
      logo.onclick = () => {
        if (window.confirm('Discard your unsaved changes?')) {
          try {
            sessionStorage.removeItem('quoteStep1');
            sessionStorage.removeItem('quoteStep2');
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

  // ── Async resolver: figure out viewer role + isResumingReturned + admin-mode dealer ──
  // Resolution priority for isResumingReturned:
  //   1. sessionStorage hint (set by step pages after their own init())
  //   2. DB lookup on quote.status when ?draft=xxx is present
  //
  // The DB fallback handles the first entry into step1 from quote-detail's
  // "Edit & Resubmit" button: at that moment sessionStorage is empty, but the
  // header still needs to know it's a Returned-resume to show the Admin bar.
  async function resolveAsyncContext(ctx) {
    // Fail-soft: if Supabase not present, skip async work
    if (!window.supabase || !window.supabase.createClient) {
      return {
        viewerIsAdmin: false,
        isResumingReturned: ctx.isResumingReturnedHint,
        adminBarDealerName: null,
      };
    }

    const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

    // Get session
    let session = null;
    try {
      const { data } = await sb.auth.getSession();
      session = data && data.session ? data.session : null;
    } catch (_) { /* ignore */ }

    if (!session) {
      // Not logged in — page itself will redirect; skip
      return {
        viewerIsAdmin: false,
        isResumingReturned: ctx.isResumingReturnedHint,
        adminBarDealerName: null,
      };
    }

    // Resolve viewer role
    let viewerIsAdmin = false;
    try {
      const { data: me } = await sb.from('dealers')
        .select('role').eq('id', session.user.id).single();
      const role = me && me.role ? me.role : 'dealer';
      viewerIsAdmin = (role === 'admin' || role === 'super_admin');
    } catch (_) { /* ignore */ }

    // ── v1.1: Resolve isResumingReturned via DB fallback ──
    // Start with sessionStorage hint; if we have ?draft and the hint is false,
    // ask the DB whether the quote is actually Returned.
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
      } catch (_) { /* ignore — fall back to sessionStorage hint */ }
    }

    // ── Decide which dealer (if any) to show in Admin Mode bar ──
    // Show the bar when:
    //   - adminDraftFlag (?adminDraft=1) — admin creating draft on dealer's behalf
    //   - viewer is admin AND quote owner is a different user (resuming someone
    //     else's Draft or Returned quote)
    let adminBarDealerName = null;
    let targetDealerId = null;

    if (ctx.adminDraftFlag) {
      targetDealerId = ctx.adminDealerIdHint;
    } else if (viewerIsAdmin && ctx.draftId && quoteOwnerDealerId) {
      targetDealerId = quoteOwnerDealerId;
    }

    // Only show bar if target dealer is different from logged-in user
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
    const currentStep = (stepAttr >= 1 && stepAttr <= 3) ? stepAttr : 1;

    const ctx = readContext();

    injectCss();
    renderSkeleton(container, currentStep);

    // Initial bind with sessionStorage-only hints (best effort, non-admin assumed)
    bindBehaviors({
      draftId:            ctx.draftId,
      adminDraftFlag:     ctx.adminDraftFlag,
      isResumingReturned: ctx.isResumingReturnedHint,
      viewerIsAdmin:      false,
    });

    // Async: resolve viewer role + isResumingReturned (with DB fallback) + admin bar
    resolveAsyncContext(ctx).then((res) => {
      // Re-bind behaviors with fully-resolved info (Discard label/target may change)
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
