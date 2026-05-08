/* ──────────────────────────────────────────────────────────────────────
 * ProCraft Dealer Portal — Unified Footer Component (v1.2)
 *
 * Self-contained sticky footer that sits at the bottom of every page.
 * Mirrors navigator.js design:
 *   - Dark green background (echoes navbar)
 *   - Gold accent color
 *   - Same typography stack
 *
 * v1.2 CHANGES:
 *   - Fix RWD bug: body > .page now has min-width:0 + width:100%
 *     Previously, flex-shrink:0 + flex-basis:auto caused .page to grow
 *     to its content's natural width (e.g. 1200px wide tables) and
 *     refuse to shrink on mobile, breaking responsive layout. Adding
 *     min-width:0 + width:100% lets .page respect the viewport width.
 *
 * v1.1 CHANGES:
 *   - Added width:100% !important on body to prevent column body from
 *     shrinking to child width.
 *
 * USAGE in any HTML page:
 *   1. Add `<div id="pcd-footer"></div>` near the end of <body>
 *   2. Add `<script src="components/footer.js"></script>` at end of <body>
 *      (after navigator.js if both are used)
 *
 * STICKY BEHAVIOR:
 *   - Internally adds a flex layout to <body> so the footer sticks to the
 *     bottom of the viewport when content is short, and scrolls naturally
 *     when content is long.
 *   - Pages do NOT need to change their own layout CSS — this component
 *     handles it via injected styles applied to <body>.
 *
 * UPDATING CONTENT LATER:
 *   Edit FOOTER_CONTENT below. All pages pick up the change instantly.
 * ────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  // ── Content ──────────────────────────────────────────────────────
  // Edit this object whenever you want to change the footer text.
  const FOOTER_CONTENT = {
    copyright:   '\u00A9 ' + new Date().getFullYear() + ' ProCraft Cabinetry DC LLC. All rights reserved.',
    contactText: 'Questions? Contact us at',
    contactEmail: 'sales@procraftdc.com',
  };

  // ── Inline Styles ────────────────────────────────────────────────
  // The body flex layout is what makes the footer sticky to bottom.
  // We use min-height:100vh + flex column on body, and flex:1 on the
  // main content wrapper so it pushes the footer down on short pages.
  //
  // CRITICAL — min-width:0 + width:100% on body > .page:
  //   Default flex items have min-width:auto, which means they won't
  //   shrink below their content's intrinsic width. With wide tables
  //   inside .page, this caused the page to stay at desktop width even
  //   on mobile viewports, breaking RWD. Setting min-width:0 lets it
  //   shrink; width:100% makes it match the viewport.
  const STYLES = `
    /* Sticky footer layout — turns body into a flex column.
       width:100% is critical — without it, flex column body can shrink
       to intrinsic width on some browsers, breaking the page layout. */
    body {
      display: flex !important;
      flex-direction: column !important;
      min-height: 100vh !important;
      width: 100% !important;
    }
    /* Make .page (main content wrapper used across all pages) grow to
       fill available space — this pushes footer to bottom on short pages.
       min-width:0 + width:100% lets it respect viewport width on mobile,
       so wide internal content (tables) stays inside its scroll container
       instead of forcing .page itself to expand. */
    body > .page {
      flex: 1 0 auto;
      min-width: 0;
      width: 100%;
    }
    /* Footer must not shrink */
    #pcd-footer {
      flex-shrink: 0;
    }

    .pcd-footer {
      background: #3e5a42;
      color: rgba(255,255,255,0.75);
      padding: 14px 24px;
      text-align: center;
      font-family: 'DM Sans', sans-serif;
      font-size: 12px;
      line-height: 1.6;
      letter-spacing: 0.04em;
    }
    .pcd-footer-line { display: block; }
    .pcd-footer-line + .pcd-footer-line { margin-top: 2px; }
    .pcd-footer-email {
      color: #C9A84C;
      text-decoration: none;
      font-weight: 500;
      letter-spacing: 0.06em;
      transition: color 0.2s;
    }
    .pcd-footer-email:hover {
      color: #E2C97E;
      text-decoration: underline;
    }
    @media (max-width: 480px) {
      .pcd-footer { padding: 12px 16px; font-size: 11px; }
    }
  `;

  // ── State ────────────────────────────────────────────────────────
  let _stylesInjected = false;

  // ── Lifecycle ────────────────────────────────────────────────────
  init();

  function init() {
    const container = document.getElementById('pcd-footer');
    if (!container) {
      // No container on this page — nothing to do
      return;
    }

    injectStyles();
    render(container);
  }

  // ── Render ───────────────────────────────────────────────────────
  function injectStyles() {
    if (_stylesInjected) return;
    if (document.getElementById('pcd-footer-styles')) {
      _stylesInjected = true;
      return;
    }
    const styleEl = document.createElement('style');
    styleEl.id = 'pcd-footer-styles';
    styleEl.textContent = STYLES;
    document.head.appendChild(styleEl);
    _stylesInjected = true;
  }

  function render(container) {
    container.innerHTML =
      '<footer class="pcd-footer">' +
        '<span class="pcd-footer-line">' + escapeHtml(FOOTER_CONTENT.copyright) + '</span>' +
        '<span class="pcd-footer-line">' +
          escapeHtml(FOOTER_CONTENT.contactText) + ' ' +
          '<a class="pcd-footer-email" href="mailto:' + encodeURI(FOOTER_CONTENT.contactEmail) + '">' +
            escapeHtml(FOOTER_CONTENT.contactEmail) +
          '</a>' +
        '</span>' +
      '</footer>';
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
