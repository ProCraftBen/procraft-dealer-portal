/* ──────────────────────────────────────────────────────────────────────
 * ProCraft Dealer Portal — Unified Navigator Component (v1.4)
 *
 * Self-contained component that renders a consistent navbar + mobile menu
 * across all dealer- and admin-facing pages.
 *
 * v1.4 CHANGES (CB-51 — My Discount pill):
 *   - Dealers who have at least one row in `dealer_discount_rules` get a
 *     gold outlined "MY DISCOUNT" pill as the FIRST item of the desktop
 *     link group (left of Dashboard), and as the first item of the mobile
 *     hamburger menu. Clicking it opens a read-only modal listing that
 *     dealer's rules; each rule expands in place to show its full detail.
 *   - Visibility is strict: role must be exactly 'dealer' AND the rules
 *     query must return >= 1 row. Dealers with zero rules, admins, and
 *     super_admins never see the pill and no space is reserved for it.
 *     A failed query is treated as "no rules" (fail-closed).
 *   - The rules query does NOT block nav rendering. render() completes
 *     first, then loadDiscountPill() runs in the background and injects
 *     the pill when it resolves. Guarded by a generation counter, an
 *     in-flight flag, live mount-point lookups, and an existence check,
 *     so injection is idempotent and can never land on a stale nav.
 *   - One query per page load; the modal reads the cached result and
 *     never re-queries. Read-only throughout — no writes, no migration,
 *     no RLS change. Dealer access relies on the existing CB-47 policy
 *     `dealer_ddr_select_own`.
 *   - Display formatting is deliberately 1:1 with admin-dealers.html so
 *     the same rule reads identically on both sides (Framed/Frameless,
 *     All styles / All SKUs / All types, "20% off" / "$50.00 off").
 *   - All rule text is passed through escapeHtml(). Rule names are
 *     admin-authored free text and must never be interpolated raw.
 *
 * v1.3 CHANGES (F9):
 *   - Nav items may carry `superOnly: true`. Such items render only for
 *     role === 'super_admin' and are filtered out for regular admins.
 *     Applied to the Payments item (admin-payments.html) — the admin
 *     payment management page is restricted to super_admin.
 *   - Filtering happens once on the shared navItems array, so desktop
 *     links and the mobile menu stay in sync automatically.
 *   - Frontend visibility only. This is UX protection, not a security
 *     boundary — actual data access is governed by Supabase RLS.
 *
 * v1.2 CHANGES:
 *   - Brand title updated to full name "ProCraft Cabinetry DC"
 *   - On mobile (<768px), brand title text is hidden — only the logo
 *     remains, since the logo already contains the brand mark and
 *     mobile real estate is tight. Hamburger fills the right side.
 *
 * v1.1 CHANGES:
 *   - Inject CSS immediately on script load (not after session check)
 *   - Render skeleton (green bar + logo) immediately so users see the
 *     nav shape before role lookup finishes — eliminates white-space
 *     flash (FOUC)
 *   - If no session, clear skeleton so login redirect feels clean
 *
 * USAGE in any HTML page:
 *   1. Add `<div id="pcd-nav" data-page="quotes"></div>` near the top of <body>
 *   2. Add `<script src="components/navigator.js"></script>` after the
 *      Supabase client script in <body>
 *   3. Remove the old <nav class="navbar">, <div class="mobile-menu">,
 *      handleLogout() / toggleMenu() functions, and related CSS from the page
 *
 * data-page values:
 *   dashboard | quotes | new-quote | dealer-profile |
 *   dealers | accounts | tags | change-password | (omit for none active)
 *
 * BEHAVIOR:
 *   - On script load: inject CSS + render skeleton (logo only) instantly
 *   - No session → clear skeleton (page's own redirect handles login)
 *   - Dealer role → renders dealer nav (Dashboard / My Orders / New Estimate /
 *     Edit Profile / Change Password / Sign Out)
 *   - Admin / super_admin role → renders admin nav with [Admin] badge
 *     (Dashboard / Quotes / Dealers / Account / Tags / Change Password /
 *     Sign Out)
 *   - super_admin role → additionally sees the Payments item (F9)
 *   - Dealer with >= 1 discount rule → gold "MY DISCOUNT" pill injected
 *     ahead of the link group (desktop) and at the top of the hamburger
 *     menu (mobile); opens the read-only My Discounts modal (CB-51)
 *   - Active item highlighted by data-page match (white text + 2px gold
 *     underline)
 *   - Logo click → dashboard.html (dealer) or admin.html (admin)
 *   - Hamburger menu on mobile, click outside to close
 *   - Sign Out → signOut() + redirect to login.html
 * ────────────────────────────────────────────────────────────────────── */

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

  // ── Constants ────────────────────────────────────────────────────
  const SUPABASE_URL  = window.SB_URL;
  const SUPABASE_ANON = window.SB_KEY;
  const LOGO_URL      = 'https://acwgemgpnusworpxxoai.supabase.co/storage/v1/object/public/assets/ProCraft-DC-Logo-white.png';
  const BRAND_TITLE   = 'ProCraft Cabinetry DC';

  // Navigation item maps — key = data-page value
  // CB-2: dealer-facing labels renamed. data-page / href / page keys are
  // internal identifiers and stay untouched so existing page wiring works.
  const DEALER_NAV = [
    { page: 'dashboard',       label: 'Dashboard',       href: 'dashboard.html' },
    { page: 'quotes',          label: 'My Orders',       href: 'quotes.html' },
    { page: 'new-quote',       label: 'New Estimate',    href: 'new-quote.html' },
    { page: 'dealer-profile',  label: 'Edit Profile',    href: 'dealer-profile.html' },
    { page: 'change-password', label: 'Change Password', href: 'change-password.html' },
  ];

  const ADMIN_NAV = [
    { page: 'dashboard',       label: 'Dashboard',       href: 'admin.html' },
    { page: 'quotes',          label: 'Quotes',          href: 'admin-quotes.html' },
    // F9: super_admin only — regular admins never see this item.
    { page: 'payments',        label: 'Payments',        href: 'admin-payments.html', superOnly: true },
    { page: 'dealers',         label: 'Dealers',         href: 'admin-dealers.html' },
    { page: 'accounts',        label: 'Account',         href: 'admin-accounts.html' },
    { page: 'tags',            label: 'Tags',            href: 'admin-tags.html' },
    { page: 'change-password', label: 'Change Password', href: 'change-password.html' },
  ];

  // ── Inline Styles ────────────────────────────────────────────────
  // Injected once on first render. Uses pcd- prefix to avoid collisions
  // with existing page styles. Falls back to hex colors (not CSS vars)
  // because pages may or may not define the same variable names.
  const STYLES = `
    .pcd-navbar { background: #3e5a42; padding: 0 24px; height: 60px; display: flex; align-items: center; justify-content: space-between; position: sticky; top: 0; z-index: 100; font-family: 'DM Sans', sans-serif; }
    .pcd-nav-brand { display: flex; align-items: center; gap: 10px; cursor: pointer; text-decoration: none; }
    .pcd-nav-brand:hover { opacity: 0.9; }
    .pcd-nav-logo { height: 44px; max-width: 110px; object-fit: contain; }
    .pcd-nav-title { font-family: 'Cormorant Garamond', serif; font-size: 17px; font-weight: 500; letter-spacing: 0.06em; color: #fff; white-space: nowrap; }
    .pcd-nav-badge { font-size: 9px; letter-spacing: 0.15em; text-transform: uppercase; background: #C9A84C; color: #3e5a42; padding: 2px 7px; border-radius: 2px; font-weight: 500; }

    .pcd-nav-right { display: flex; align-items: center; gap: 16px; }
    .pcd-nav-link {
      font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase;
      color: rgba(255,255,255,0.5); text-decoration: none;
      transition: color 0.2s, border-color 0.2s;
      padding: 4px 0;
      border-bottom: 2px solid transparent;
    }
    .pcd-nav-link:hover { color: #fff; }
    .pcd-nav-link.active { color: #fff; border-bottom-color: #C9A84C; }

    .pcd-nav-logout {
      font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase;
      color: rgba(255,255,255,0.5); cursor: pointer;
      border: 1px solid rgba(255,255,255,0.15); border-radius: 3px;
      padding: 6px 12px; background: transparent;
      font-family: 'DM Sans', sans-serif;
      transition: color 0.2s, border-color 0.2s;
    }
    .pcd-nav-logout:hover { color: #fff; border-color: rgba(255,255,255,0.4); }

    /* Hamburger */
    .pcd-hamburger { display: none; flex-direction: column; justify-content: center; gap: 5px; width: 36px; height: 36px; background: none; border: none; cursor: pointer; padding: 4px; }
    .pcd-hamburger span { display: block; width: 22px; height: 2px; background: rgba(255,255,255,0.7); border-radius: 2px; transition: all 0.25s; }
    .pcd-hamburger.open span:nth-child(1) { transform: translateY(7px) rotate(45deg); }
    .pcd-hamburger.open span:nth-child(2) { opacity: 0; }
    .pcd-hamburger.open span:nth-child(3) { transform: translateY(-7px) rotate(-45deg); }

    /* Mobile menu */
    .pcd-mobile-menu { display: none; position: fixed; top: 60px; left: 0; right: 0; background: #3e5a42; border-top: 1px solid rgba(255,255,255,0.08); z-index: 99; flex-direction: column; padding: 8px 0 16px; box-shadow: 0 8px 24px rgba(0,0,0,0.3); font-family: 'DM Sans', sans-serif; }
    .pcd-mobile-menu.show { display: flex; }
    .pcd-mobile-menu a, .pcd-mobile-menu button {
      display: block; width: 100%; padding: 12px 24px;
      font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase;
      color: rgba(255,255,255,0.6); text-decoration: none;
      background: none; border: none; text-align: left; cursor: pointer;
      font-family: 'DM Sans', sans-serif;
      transition: color 0.15s, background 0.15s;
    }
    .pcd-mobile-menu a:hover, .pcd-mobile-menu button:hover { color: #fff; background: rgba(255,255,255,0.05); }
    .pcd-mobile-menu a.active { color: #fff; }
    .pcd-mobile-menu .pcd-menu-divider { height: 1px; background: rgba(255,255,255,0.08); margin: 8px 0; }

    @media (max-width: 768px) {
      .pcd-nav-right { display: none !important; }
      .pcd-hamburger { display: flex !important; }
      .pcd-nav-logo { height: 36px; max-width: 90px; }
      /* v1.2: Hide brand title on mobile — logo carries the brand mark */
      .pcd-nav-title { display: none !important; }
      .pcd-navbar { padding: 0 16px; }
    }

    /* ══ CB-51: My Discount pill (desktop) ═══════════════════════════
       Gold OUTLINE, not filled — it is a modal trigger, not a page link,
       so it deliberately does not share .pcd-nav-link styling.
       No mobile rule needed: .pcd-nav-right is display:none <=768px, so
       the desktop pill disappears with the rest of the link group. */
    .pcd-discount-pill {
      display: inline-flex; align-items: center; gap: 6px;
      font-family: 'DM Sans', sans-serif;
      font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase;
      color: #C9A84C; background: transparent;
      border: 1px solid #C9A84C; border-radius: 999px;
      padding: 5px 12px; cursor: pointer; white-space: nowrap;
      transition: color 0.2s, border-color 0.2s, background 0.2s;
    }
    .pcd-discount-pill:hover {
      color: #E3C87A; border-color: #E3C87A; background: rgba(201,168,76,0.12);
    }
    .pcd-dp-icon {
      width: 14px; height: 14px; flex: none;
      fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round;
    }

    /* CB-51: mobile hamburger entry.
       Selector is .pcd-mobile-menu .pcd-discount-mobile (0,2,0) so it beats
       .pcd-mobile-menu button (0,1,1) without needing !important. */
    .pcd-mobile-menu .pcd-discount-mobile {
      display: flex; align-items: center; gap: 9px; color: #C9A84C;
    }
    .pcd-mobile-menu .pcd-discount-mobile:hover {
      color: #E3C87A; background: rgba(201,168,76,0.08);
    }
    .pcd-dm-badge {
      display: inline-flex; align-items: center; justify-content: center;
      width: 18px; height: 18px; flex: none;
      border: 1px solid currentColor; border-radius: 999px;
      font-size: 10px; line-height: 1; letter-spacing: 0;
    }

    /* ══ CB-51: My Discounts modal ═══════════════════════════════════
       z-index 10000/10001 clears feedback-widget.js (9998/9999) so its
       floating button cannot sit on top of the overlay. */
    .pcd-dmo {
      position: fixed; inset: 0; z-index: 10000;
      display: flex; align-items: center; justify-content: center;
      padding: 20px; background: rgba(20,28,22,0.55);
      font-family: 'DM Sans', sans-serif;
    }
    /* [hidden] must win over display:flex above */
    .pcd-dmo[hidden] { display: none !important; }
    .pcd-dmo-panel {
      position: relative; z-index: 10001;
      width: min(92%, 560px); max-height: 82%;
      display: flex; flex-direction: column; overflow: hidden;
      background: #fff; border-radius: 6px;
      box-shadow: 0 24px 60px rgba(0,0,0,0.35);
    }
    .pcd-dmo-head {
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
      padding: 18px 20px 14px; border-bottom: 1px solid #e8e4da; flex: none;
    }
    .pcd-dmo-title {
      margin: 0; font-family: 'Cormorant Garamond', serif;
      font-size: 22px; font-weight: 500; letter-spacing: 0.02em; color: #2f3d31;
    }
    .pcd-dmo-close {
      background: none; border: none; cursor: pointer;
      font-size: 24px; line-height: 1; color: #8a8a80; padding: 0 4px;
      font-family: 'DM Sans', sans-serif;
    }
    .pcd-dmo-close:hover { color: #2f3d31; }
    /* Q-03: rule list scrolls as a whole */
    .pcd-dmo-body { overflow-y: auto; padding: 6px 20px 14px; }
    .pcd-dmo-rule { border-bottom: 1px solid #eeebe3; }
    .pcd-dmo-rule:last-child { border-bottom: none; }
    .pcd-dmo-rule-head {
      width: 100%; display: flex; align-items: center; justify-content: space-between;
      gap: 10px; padding: 13px 2px; text-align: left; cursor: pointer;
      background: none; border: none;
      font-family: 'DM Sans', sans-serif; font-size: 13px; color: #2f3d31;
    }
    .pcd-dmo-rule-head:hover { color: #7a6220; }
    .pcd-dmo-rule-name { font-weight: 500; overflow-wrap: anywhere; }
    .pcd-dmo-chev { flex: none; font-size: 11px; color: #C9A84C; transition: transform 0.18s; }
    .pcd-dmo-rule-head[aria-expanded="true"] .pcd-dmo-chev { transform: rotate(180deg); }
    .pcd-dmo-rule-body { padding: 2px 2px 14px; }
    .pcd-dmo-rule-body[hidden] { display: none; }
    .pcd-dmo-row { display: flex; gap: 14px; align-items: flex-start; padding: 6px 0; font-size: 12px; }
    .pcd-dmo-row > span:first-child { flex: none; width: 128px; color: #8a8a80; letter-spacing: 0.04em; }
    /* Q-03: no truncation — long SKU lists scroll inside their own cell */
    .pcd-dmo-row > span:last-child {
      flex: 1; color: #2f3d31; max-height: 168px; overflow-y: auto; overflow-wrap: anywhere;
    }
    .pcd-dmo-row.disc > span:last-child { color: #7a6220; font-weight: 500; }
    .pcd-dmo-note {
      flex: none; padding: 12px 20px 15px; border-top: 1px solid #e8e4da;
      font-size: 11px; line-height: 1.5; color: #8a8a80;
    }

    @media (max-width: 768px) {
      .pcd-dmo { padding: 12px; }
      .pcd-dmo-panel { max-height: 88%; width: 100%; }
      .pcd-dmo-row { flex-direction: column; gap: 2px; }
      .pcd-dmo-row > span:first-child { width: auto; }
    }

    /* ── T-Z FALLBACK (leave commented unless staging test T-Z fails) ──
       injectGlobalStyles() applies html { zoom: 1.2 } at >=768px. If the
       overlay renders larger than the viewport or the panel sits off
       centre on desktop, uncomment the block below to cancel the
       inherited zoom, and bump the panel's own font sizes back up.
    @media (min-width: 768px) {
      .pcd-dmo { zoom: 0.8333333; }
      .pcd-dmo-title { font-size: 26.4px; }
      .pcd-dmo-rule-head { font-size: 15.6px; }
      .pcd-dmo-row { font-size: 14.4px; }
      .pcd-dmo-note { font-size: 13.2px; }
    }
    ─────────────────────────────────────────────────────────────────── */
  `;

  // ── State ────────────────────────────────────────────────────────
  let _supabase = null;
  let _stylesInjected = false;

  // CB-51 state
  // _navGeneration: bumped on every render(). A background pill load
  //   captures the value at start and aborts on resolve if it changed,
  //   so a stale query result can never decorate a newer nav.
  let _navGeneration  = 0;
  let _pillLoading    = false;   // in-flight guard — never query twice
  let _discountRules  = null;    // cached rows; modal never re-queries
  let _dmoEl          = null;    // modal root, built lazily once
  let _dmoTrigger     = null;    // element to return focus to on close
  let _dmoPrevOverflow = null;   // body overflow before opening
  let _dmoEscHandler  = null;    // bound only while the modal is open

  // ── Lifecycle ────────────────────────────────────────────────────
  // Run as soon as the script loads. Script is at end of <body>, so DOM is
  // already parsed and the #pcd-nav container exists.
  //
  // v1.1: Render skeleton FIRST (synchronously) before any async work,
  // so users see the green nav bar + logo immediately.
  const _initialContainer = document.getElementById('pcd-nav');
  if (_initialContainer) {
    injectStyles();
    renderSkeleton(_initialContainer);
  }

  init().catch(function (err) {
    console.warn('[navigator] init failed:', err);
  });

  async function init() {
    const container = document.getElementById('pcd-nav');
    if (!container) {
      // Page didn't include the container — nothing to do
      return;
    }

    // Wait for window.supabase global to be available (loaded by page)
    if (!window.supabase || !window.supabase.createClient) {
      console.warn('[navigator] Supabase client library not loaded yet');
      container.innerHTML = '';
      return;
    }

    _supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);

    // Check session — clear skeleton if not signed in
    let session = null;
    try {
      const result = await _supabase.auth.getSession();
      session = result.data ? result.data.session : null;
    } catch (e) {
      console.warn('[navigator] getSession failed:', e);
      container.innerHTML = '';
      return;
    }

    if (!session) {
      // No session — clear skeleton; let the page's own init() redirect
      container.innerHTML = '';
      return;
    }

    // Determine role
    let role = null;
    try {
      const { data: me } = await _supabase
        .from('dealers')
        .select('role')
        .eq('id', session.user.id)
        .single();
      role = me ? me.role : null;
    } catch (e) {
      console.warn('[navigator] role lookup failed:', e);
      container.innerHTML = '';
      return;
    }

    if (!role) {
      // Couldn't determine role — clear skeleton (page will redirect)
      container.innerHTML = '';
      return;
    }

    const isAdmin = role === 'admin' || role === 'super_admin';
    // F9: exact role match — 'admin' must NOT satisfy this.
    const isSuperAdmin = role === 'super_admin';
    // CB-51: exact match on 'dealer'. Deliberately NOT `!isAdmin` — any
    // future role must opt in explicitly rather than inherit the pill.
    const isDealer = role === 'dealer';
    const dataPage = (container.dataset.page || '').toLowerCase();

    render(container, isAdmin, dataPage, isSuperAdmin);
    attachEventListeners();

    // CB-51 (Q-02 A): nav is already on screen. The rules lookup runs in
    // the background and injects the pill when it lands — nav rendering is
    // never delayed by it. Admins never reach this call, so they never
    // issue a request that is guaranteed to come back empty.
    if (isDealer) {
      loadDiscountPill(session.user.id);
    }
  }

  // ── Render ───────────────────────────────────────────────────────
  function injectStyles() {
    if (_stylesInjected) return;
    const styleEl = document.createElement('style');
    styleEl.id = 'pcd-nav-styles';
    styleEl.textContent = STYLES;
    document.head.appendChild(styleEl);
    _stylesInjected = true;
  }

  // v1.1: Skeleton — green bar + logo only. Same height & color as final
  // nav, so when render() replaces it the only visual change is menu items
  // fading in on the right. No layout shift on the rest of the page.
  function renderSkeleton(container) {
    container.innerHTML =
      '<nav class="pcd-navbar">' +
        '<div class="pcd-nav-brand" style="cursor:default;">' +
          '<img class="pcd-nav-logo" src="' + LOGO_URL + '" alt="ProCraft Cabinetry DC"/>' +
        '</div>' +
        '<div></div>' +
      '</nav>';
  }

  function render(container, isAdmin, activePage, isSuperAdmin) {
    // CB-51: any nav rebuild invalidates in-flight pill injections.
    _navGeneration++;

    // F9: drop superOnly items unless the viewer is super_admin. Filtering the
    // shared array once keeps desktop links and the mobile menu identical.
    const navItems  = (isAdmin ? ADMIN_NAV : DEALER_NAV)
      .filter(function (item) { return !item.superOnly || isSuperAdmin; });
    const homeHref  = isAdmin ? 'admin.html' : 'dashboard.html';
    const adminBadge = isAdmin ? '<span class="pcd-nav-badge">Admin</span>' : '';

    // Desktop nav links
    const desktopLinks = navItems.map(function (item) {
      const activeClass = item.page === activePage ? ' active' : '';
      return '<a href="' + item.href + '" class="pcd-nav-link' + activeClass + '">' +
                escapeHtml(item.label) +
              '</a>';
    }).join('');

    // Mobile menu links
    const mobileLinks = navItems.map(function (item) {
      const activeClass = item.page === activePage ? ' class="active"' : '';
      return '<a href="' + item.href + '"' + activeClass + '>' + escapeHtml(item.label) + '</a>';
    }).join('');

    // CB-51: zero-width mount anchors. The pill is inserted with
    // insertAdjacentHTML('afterend', ...) on these, rather than relying on
    // firstChild ordering — that keeps the insertion point explicit and
    // survives any future reshuffle of the link group.
    container.innerHTML =
      '<nav class="pcd-navbar">' +
        '<a class="pcd-nav-brand" href="' + homeHref + '">' +
          '<img class="pcd-nav-logo" src="' + LOGO_URL + '" alt="' + escapeHtml(BRAND_TITLE) + '"/>' +
          '<span class="pcd-nav-title">' + escapeHtml(BRAND_TITLE) + '</span>' +
          adminBadge +
        '</a>' +
        '<div class="pcd-nav-right">' +
          '<span id="pcd-nav-right-mount" hidden></span>' +
          desktopLinks +
          '<button class="pcd-nav-logout" id="pcd-logout-btn">Sign Out</button>' +
        '</div>' +
        '<button class="pcd-hamburger" id="pcd-hamburger">' +
          '<span></span><span></span><span></span>' +
        '</button>' +
      '</nav>' +
      '<div class="pcd-mobile-menu" id="pcd-mobile-menu">' +
        '<span id="pcd-mobile-mount" hidden></span>' +
        mobileLinks +
        '<div class="pcd-menu-divider"></div>' +
        '<button id="pcd-logout-btn-mobile">Sign Out</button>' +
      '</div>';
  }

  // ── Event Listeners ──────────────────────────────────────────────
  function attachEventListeners() {
    const hamburger = document.getElementById('pcd-hamburger');
    const menu      = document.getElementById('pcd-mobile-menu');
    const logoutEl  = document.getElementById('pcd-logout-btn');
    const logoutMob = document.getElementById('pcd-logout-btn-mobile');

    // Hamburger toggle
    if (hamburger && menu) {
      hamburger.addEventListener('click', function (e) {
        e.stopPropagation();
        hamburger.classList.toggle('open');
        menu.classList.toggle('show');
      });
    }

    // Click outside hamburger/menu → close
    document.addEventListener('click', function (e) {
      if (!hamburger || !menu) return;
      if (hamburger.contains(e.target) || menu.contains(e.target)) return;
      hamburger.classList.remove('open');
      menu.classList.remove('show');
    });

    // Logout (desktop + mobile)
    if (logoutEl) logoutEl.addEventListener('click', handleLogout);
    if (logoutMob) logoutMob.addEventListener('click', handleLogout);
  }

  async function handleLogout() {
    try {
      if (_supabase) await _supabase.auth.signOut();
    } catch (e) {
      console.warn('[navigator] signOut failed:', e);
    } finally {
      window.location.href = 'login.html';
    }
  }

  /* ══════════════════════════════════════════════════════════════════
   * CB-51 — My Discount pill + modal
   * Read-only. SELECT on dealer_discount_rules only; never writes.
   * ════════════════════════════════════════════════════════════════ */

  // Fetch this dealer's rules and, if there is at least one, inject the
  // pill. Fail-closed: any error, or zero rows, leaves the nav untouched
  // and reserves no space. Never throws — callers do not await it.
  async function loadDiscountPill(dealerId) {
    if (!dealerId || !_supabase) return;
    if (_pillLoading) return;                 // guard 2: in-flight
    const gen = _navGeneration;               // guard 1: generation
    _pillLoading = true;

    try {
      // Same shape as new-quote-step3.html (CB-47). Dealer visibility comes
      // from the existing RLS policy `dealer_ddr_select_own`; the explicit
      // dealer_id filter mirrors that policy rather than relying on it alone.
      const res = await _supabase
        .from('dealer_discount_rules')
        .select('id,name,construction_type,door_styles,sku_codes,types,discount_type,discount_value')
        .eq('dealer_id', dealerId)
        .order('created_at', { ascending: true });

      if (res.error) {
        console.warn('[navigator][CB-51] discount rules query failed:', res.error);
        return;
      }
      const rows = res.data || [];
      if (!rows.length) return;               // no rules → no pill, no gap

      if (gen !== _navGeneration) return;     // nav was rebuilt — abandon
      _discountRules = rows;
      injectPill();
    } catch (e) {
      console.warn('[navigator][CB-51] discount pill load error:', e);
    } finally {
      _pillLoading = false;
    }
  }

  // Idempotent, atomic injection. Both mount points are re-read live and
  // both must be present before anything is written, so we never end up
  // with a desktop pill and no mobile entry (or vice versa).
  function injectPill() {
    if (document.getElementById('pcd-discount-pill')) return;   // guard 4
    const deskMount = document.getElementById('pcd-nav-right-mount');
    const mobMount  = document.getElementById('pcd-mobile-mount');
    if (!deskMount || !mobMount) return;                        // guard 3

    deskMount.insertAdjacentHTML('afterend',
      '<button type="button" class="pcd-discount-pill" id="pcd-discount-pill"' +
              ' aria-haspopup="dialog" aria-expanded="false">' +
        '<svg class="pcd-dp-icon" viewBox="0 0 24 24" aria-hidden="true">' +
          '<circle cx="7.5" cy="7.5" r="2.75"/>' +
          '<circle cx="16.5" cy="16.5" r="2.75"/>' +
          '<line x1="19" y1="5" x2="5" y2="19"/>' +
        '</svg>' +
        '<span>My Discount</span>' +
      '</button>');

    mobMount.insertAdjacentHTML('afterend',
      '<button type="button" class="pcd-discount-mobile" id="pcd-discount-pill-mobile">' +
        '<span class="pcd-dm-badge" aria-hidden="true">%</span>My Discount' +
      '</button>' +
      '<div class="pcd-menu-divider"></div>');

    const deskBtn = document.getElementById('pcd-discount-pill');
    const mobBtn  = document.getElementById('pcd-discount-pill-mobile');
    if (deskBtn) deskBtn.addEventListener('click', function () { openDiscountModal(deskBtn); });
    if (mobBtn)  mobBtn.addEventListener('click', function () {
      // Close the hamburger first — the document-level click-outside handler
      // ignores clicks inside the menu, so it will not close on its own.
      const hamburger = document.getElementById('pcd-hamburger');
      const menu      = document.getElementById('pcd-mobile-menu');
      if (hamburger) hamburger.classList.remove('open');
      if (menu) menu.classList.remove('show');
      openDiscountModal(mobBtn);
    });
  }

  // ── Formatting (1:1 with admin-dealers.html — Q-05) ──────────────

  // admin-dealers.html normalizeCt(): anything not 'frameless' is 'framed'.
  function ctLabel(v) {
    const t = String(v == null ? '' : v).trim().toLowerCase();
    return (t === 'frameless') ? 'Frameless' : 'Framed';
  }

  // admin-dealers.html: NULL or empty array means "no restriction" = All.
  // Returns escaped HTML — every element goes through escapeHtml().
  function dimText(arr, allTxt) {
    if (!Array.isArray(arr) || !arr.length) return escapeHtml(allTxt);
    return arr.map(function (v) { return escapeHtml(v); }).join(', ');
  }

  // admin-dealers.html ruleSummaryText(): non-'amount' is treated as
  // percentage; non-finite values fall back to 0.
  function discountText(rule) {
    const raw = parseFloat(rule.discount_value);
    const val = isFinite(raw) ? raw : 0;
    return (rule.discount_type === 'amount')
      ? ('$' + val.toFixed(2) + ' off')
      : (val + '% off');
  }

  // ── Modal ────────────────────────────────────────────────────────

  function buildDiscountModal() {
    if (_dmoEl) return _dmoEl;

    const rules = _discountRules || [];
    const rows = rules.map(function (rule, i) {
      const bodyId = 'pcd-dmo-d' + i;
      const name   = escapeHtml(rule.name || ('Rule ' + (i + 1)));
      return '' +
        '<div class="pcd-dmo-rule">' +
          '<button type="button" class="pcd-dmo-rule-head"' +
                  ' aria-expanded="false" aria-controls="' + bodyId + '">' +
            '<span class="pcd-dmo-rule-name">' + name + '</span>' +
            '<span class="pcd-dmo-chev" aria-hidden="true">&#9662;</span>' +
          '</button>' +
          '<div class="pcd-dmo-rule-body" id="' + bodyId + '" hidden>' +
            row('Construction Type', escapeHtml(ctLabel(rule.construction_type))) +
            row('Door Styles', dimText(rule.door_styles, 'All styles')) +
            row('SKU Codes',   dimText(rule.sku_codes,   'All SKUs')) +
            row('Types',       dimText(rule.types,       'All types')) +
            row('Discount', escapeHtml(discountText(rule)), true) +
          '</div>' +
        '</div>';
    }).join('');

    const el = document.createElement('div');
    el.className = 'pcd-dmo';
    el.id = 'pcd-dmo';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'pcd-dmo-title');
    el.hidden = true;
    el.innerHTML =
      '<div class="pcd-dmo-panel">' +
        '<div class="pcd-dmo-head">' +
          '<h2 class="pcd-dmo-title" id="pcd-dmo-title">My Discounts</h2>' +
          '<button type="button" class="pcd-dmo-close" id="pcd-dmo-close" aria-label="Close">&times;</button>' +
        '</div>' +
        '<div class="pcd-dmo-body">' + rows + '</div>' +
        // CB-51 Q-07: remove this one <div> to drop the footnote.
        '<div class="pcd-dmo-note">Rules apply to catalog items only — custom items are never discounted.</div>' +
      '</div>';

    // Overlay click closes; clicks inside the panel do not.
    el.addEventListener('click', function (e) {
      if (e.target === el) closeDiscountModal();
    });
    el.querySelector('#pcd-dmo-close').addEventListener('click', closeDiscountModal);

    // Each rule expands independently; all start collapsed.
    el.querySelectorAll('.pcd-dmo-rule-head').forEach(function (head) {
      head.addEventListener('click', function () {
        const body = document.getElementById(head.getAttribute('aria-controls'));
        if (!body) return;
        const open = body.hidden;
        body.hidden = !open;
        head.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
    });

    document.body.appendChild(el);
    _dmoEl = el;
    return el;

    function row(label, valueHtml, isDiscount) {
      return '<div class="pcd-dmo-row' + (isDiscount ? ' disc' : '') + '">' +
               '<span>' + escapeHtml(label) + '</span>' +
               '<span>' + valueHtml + '</span>' +
             '</div>';
    }
  }

  function openDiscountModal(trigger) {
    if (!_discountRules || !_discountRules.length) return;
    const el = buildDiscountModal();
    _dmoTrigger = trigger || null;
    el.hidden = false;

    _dmoPrevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    _dmoEscHandler = function (e) {
      if (e.key === 'Escape' || e.key === 'Esc') closeDiscountModal();
    };
    document.addEventListener('keydown', _dmoEscHandler);

    const deskBtn = document.getElementById('pcd-discount-pill');
    if (deskBtn) deskBtn.setAttribute('aria-expanded', 'true');

    const closeBtn = el.querySelector('#pcd-dmo-close');
    if (closeBtn) closeBtn.focus();
  }

  function closeDiscountModal() {
    if (!_dmoEl || _dmoEl.hidden) return;
    _dmoEl.hidden = true;

    // Restore the previous value rather than blanking it — a page may have
    // set body overflow for its own reasons.
    document.body.style.overflow = (_dmoPrevOverflow == null ? '' : _dmoPrevOverflow);
    _dmoPrevOverflow = null;

    if (_dmoEscHandler) {
      document.removeEventListener('keydown', _dmoEscHandler);
      _dmoEscHandler = null;
    }

    const deskBtn = document.getElementById('pcd-discount-pill');
    if (deskBtn) deskBtn.setAttribute('aria-expanded', 'false');

    if (_dmoTrigger && document.body.contains(_dmoTrigger)) _dmoTrigger.focus();
    _dmoTrigger = null;
  }

  // ── Helpers ──────────────────────────────────────────────────────
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
})();
