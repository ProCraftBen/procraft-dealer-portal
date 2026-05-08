
/* ──────────────────────────────────────────────────────────────────────
 * ProCraft Dealer Portal — Unified Navigator Component (v1.0)
 *
 * Self-contained component that renders a consistent navbar + mobile menu
 * across all dealer- and admin-facing pages.
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
 *   - No session → renders nothing (page's own redirect handles login)
 *   - Dealer role → renders dealer nav (Dashboard / My Quotes / New Quote /
 *     Edit Profile / Change Password / Sign Out)
 *   - Admin / super_admin role → renders admin nav with [Admin] badge
 *     (Dashboard / Quotes / Dealers / Account / Tags / Change Password /
 *     Sign Out)
 *   - Active item highlighted by data-page match (white text + 2px gold
 *     underline)
 *   - Logo click → dashboard.html (dealer) or admin.html (admin)
 *   - Hamburger menu on mobile, click outside to close
 *   - Sign Out → signOut() + redirect to login.html
 * ────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  // ── Constants ────────────────────────────────────────────────────
  const SUPABASE_URL  = 'https://acwgemgpnusworpxxoai.supabase.co';
  const SUPABASE_ANON = 'sb_publishable_GYx1PEpxNJ9dj5V3WYpPWQ_8YfB0w8M';
  const LOGO_URL      = 'https://acwgemgpnusworpxxoai.supabase.co/storage/v1/object/public/assets/ProCraft-DC-Logo-white.png';

  // Navigation item maps — key = data-page value
  const DEALER_NAV = [
    { page: 'dashboard',       label: 'Dashboard',       href: 'dashboard.html' },
    { page: 'quotes',          label: 'My Quotes',       href: 'quotes.html' },
    { page: 'new-quote',       label: 'New Quote',       href: 'new-quote.html' },
    { page: 'dealer-profile',  label: 'Edit Profile',    href: 'dealer-profile.html' },
    { page: 'change-password', label: 'Change Password', href: 'change-password.html' },
  ];

  const ADMIN_NAV = [
    { page: 'dashboard',       label: 'Dashboard',       href: 'admin.html' },
    { page: 'quotes',          label: 'Quotes',          href: 'admin-quotes.html' },
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
    .pcd-nav-title { font-family: 'Cormorant Garamond', serif; font-size: 17px; font-weight: 500; letter-spacing: 0.12em; text-transform: uppercase; color: #fff; }
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
    }
  `;

  // ── State ────────────────────────────────────────────────────────
  let _supabase = null;
  let _stylesInjected = false;

  // ── Lifecycle ────────────────────────────────────────────────────
  // Run as soon as the script loads. Script is at end of <body>, so DOM is
  // already parsed and the #pcd-nav container exists.
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
      return;
    }

    _supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);

    // Check session — render nothing if not signed in
    let session = null;
    try {
      const result = await _supabase.auth.getSession();
      session = result.data ? result.data.session : null;
    } catch (e) {
      console.warn('[navigator] getSession failed:', e);
      return;
    }

    if (!session) {
      // No session — let the page's own init() handle the redirect
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
      return;
    }

    if (!role) {
      // Couldn't determine role — don't render (page will redirect)
      return;
    }

    const isAdmin = role === 'admin' || role === 'super_admin';
    const dataPage = (container.dataset.page || '').toLowerCase();

    injectStyles();
    render(container, isAdmin, dataPage);
    attachEventListeners();
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

  function render(container, isAdmin, activePage) {
    const navItems  = isAdmin ? ADMIN_NAV : DEALER_NAV;
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

    container.innerHTML =
      '<nav class="pcd-navbar">' +
        '<a class="pcd-nav-brand" href="' + homeHref + '">' +
          '<img class="pcd-nav-logo" src="' + LOGO_URL + '" alt="ProCraft DC"/>' +
          '<span class="pcd-nav-title">ProCraft DC</span>' +
          adminBadge +
        '</a>' +
        '<div class="pcd-nav-right">' +
          desktopLinks +
          '<button class="pcd-nav-logout" id="pcd-logout-btn">Sign Out</button>' +
        '</div>' +
        '<button class="pcd-hamburger" id="pcd-hamburger">' +
          '<span></span><span></span><span></span>' +
        '</button>' +
      '</nav>' +
      '<div class="pcd-mobile-menu" id="pcd-mobile-menu">' +
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
