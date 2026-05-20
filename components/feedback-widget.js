/**
 * ═══════════════════════════════════════════════════════════════════
 * ProCraft Dealer Portal — Feedback Widget
 * ═══════════════════════════════════════════════════════════════════
 *
 * Usage:
 *   <script src="components/feedback-widget.js?v=1.2"></script>
 *   (Place AFTER the supabase-js script and AFTER user is logged in.)
 *
 * The widget:
 *   - Auto-detects logged-in session; renders nothing if not authenticated
 *   - Renders a persistent tab on the left edge of the viewport
 *     · Desktop: 24px wide with vertical "Feedback" text
 *     · Mobile:  6px wide with no text (more compact)
 *   - Click tab → opens modal directly (no intermediate button step)
 *   - Modal: sentiment / category / message
 *   - On submit → INSERTs row into portal_feedback table
 *   - Tab stays visible at all times (no hide button)
 *
 * Storage scope:
 *   - All UI inside Shadow DOM (no CSS leakage to/from portal)
 *
 * Dependencies (must exist in page before this script runs):
 *   - window.supabase (from @supabase/supabase-js@2 CDN)
 *
 * Version: 1.2
 *   - Tab now opens modal directly (removed expand-to-pill intermediate step)
 *   - Removed × hide button and session-hide flag
 *   - Removed mobile auto-collapse timer
 * ═══════════════════════════════════════════════════════════════════
 */

(function () {
  'use strict';

  // ──────────────────────────────────────────────────────────────────
  // CONFIG
  // ──────────────────────────────────────────────────────────────────
  const SUPABASE_URL  = 'https://acwgemgpnusworpxxoai.supabase.co';
  const SUPABASE_KEY  = 'sb_publishable_GYx1PEpxNJ9dj5V3WYpPWQ_8YfB0w8M';
  const MOBILE_BREAKPOINT = 700;
  const MESSAGE_MAX = 2000;

  const CATEGORIES = [
    { value: 'bug',         icon: '🐛', label: 'Bug' },
    { value: 'feature',     icon: '💡', label: 'Feature' },
    { value: 'hard_to_use', icon: '😖', label: 'Hard to use' },
    { value: 'visual',      icon: '🎨', label: 'Visual' },
    { value: 'other',       icon: '💬', label: 'Other' },
  ];
  const SENTIMENTS = [
    { value: 'positive', icon: '😀', label: 'Good' },
    { value: 'neutral',  icon: '😐', label: 'OK' },
    { value: 'negative', icon: '😞', label: 'Bad' },
  ];

  // ──────────────────────────────────────────────────────────────────
  // GUARD: don't double-mount
  // ──────────────────────────────────────────────────────────────────
  if (window.__PCD_FEEDBACK_WIDGET_MOUNTED__) {
    console.log('[FeedbackWidget] Already mounted, skipping');
    return;
  }
  window.__PCD_FEEDBACK_WIDGET_MOUNTED__ = true;

  // ──────────────────────────────────────────────────────────────────
  // STATE
  // ──────────────────────────────────────────────────────────────────
  let _supabase     = null;
  let _session      = null;
  let _dealerRow    = null;     // { company_name, role, ... }
  let _host         = null;     // shadow host element
  let _shadow       = null;     // shadow root
  let _isMobile     = false;

  // Form state
  let _selectedSentiment = null;
  let _selectedCategory  = null;

  // ──────────────────────────────────────────────────────────────────
  // CSS (injected into shadow root)
  // ──────────────────────────────────────────────────────────────────
  const CSS = `
    :host {
      all: initial;
      font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif;
      color: #2C3A32;
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    /* ─── Tab (the only trigger) ─── */
    /* Desktop: 24px wide with vertical "Feedback" text
       Mobile:  6px wide, no text (compact) */
    .pfb-tab {
      position: fixed;
      bottom: 80px; left: 0;
      z-index: 9998;
      width: 24px;
      min-height: 100px;
      background: #3e5a42;
      color: #fff;
      border-radius: 0 4px 4px 0;
      cursor: pointer;
      box-shadow: 2px 2px 8px rgba(0,0,0,0.18);
      transition: width 0.2s ease, background 0.2s ease;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 12px 0;
      font-family: inherit;
      font-size: 11px;
      font-weight: 500;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      writing-mode: vertical-rl;
      text-orientation: mixed;
      user-select: none;
      border: none;
    }
    .pfb-tab:hover {
      width: 28px;
      background: #4a6b4f;
    }

    /* ─── Modal overlay ─── */
    .pfb-overlay {
      position: fixed;
      inset: 0;
      z-index: 9999;
      background: rgba(44, 58, 50, 0.55);
      display: none;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .pfb-overlay.show { display: flex; }
    .pfb-modal {
      width: 100%;
      max-width: 500px;
      max-height: 92vh;
      background: #fff;
      border-radius: 8px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.25);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .pfb-modal-header {
      padding: 16px 20px;
      border-bottom: 1px solid #DDD8CC;
      background: #FAFAF8;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .pfb-modal-title {
      font-family: 'Cormorant Garamond', Georgia, serif;
      font-size: 20px;
      font-weight: 400;
      color: #3e5a42;
      letter-spacing: 0.02em;
    }
    .pfb-modal-close {
      background: none;
      border: none;
      cursor: pointer;
      color: #7A8C82;
      font-size: 26px;
      line-height: 1;
      padding: 0 4px;
      transition: color 0.15s;
    }
    .pfb-modal-close:hover { color: #2C3A32; }

    .pfb-modal-body {
      padding: 20px;
      overflow-y: auto;
      flex: 1;
    }

    /* ─── Field group ─── */
    .pfb-field { margin-bottom: 18px; }
    .pfb-field:last-child { margin-bottom: 0; }
    .pfb-label {
      display: block;
      font-size: 11px;
      font-weight: 500;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: #7A8C82;
      margin-bottom: 8px;
    }
    .pfb-label .pfb-required { color: #C0392B; margin-left: 2px; }
    .pfb-label .pfb-optional {
      color: #B5B0A0;
      font-size: 9px;
      letter-spacing: 0.1em;
      margin-left: 6px;
      text-transform: none;
      font-weight: 400;
    }

    /* ─── Sentiment / Category buttons ─── */
    .pfb-options { display: flex; flex-wrap: wrap; gap: 6px; }
    .pfb-option {
      background: #fff;
      border: 1.5px solid #DDD8CC;
      border-radius: 6px;
      padding: 8px 12px;
      font-family: inherit;
      font-size: 12px;
      color: #2C3A32;
      cursor: pointer;
      transition: all 0.15s;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      line-height: 1;
    }
    .pfb-option:hover { border-color: #C9A84C; }
    .pfb-option.selected {
      border-color: #3e5a42;
      background: rgba(62, 90, 66, 0.06);
      color: #3e5a42;
      font-weight: 500;
    }
    .pfb-option-icon { font-size: 16px; line-height: 1; }

    /* ─── Textarea ─── */
    .pfb-textarea-wrap { position: relative; }
    .pfb-textarea {
      width: 100%;
      min-height: 100px;
      max-height: 240px;
      padding: 10px 12px;
      border: 1.5px solid #DDD8CC;
      border-radius: 6px;
      font-family: inherit;
      font-size: 13px;
      color: #2C3A32;
      resize: vertical;
      transition: border-color 0.15s;
      background: #fff;
      line-height: 1.5;
    }
    .pfb-textarea:focus { outline: none; border-color: #3e5a42; }
    .pfb-textarea::placeholder { color: #B5B0A0; }
    .pfb-counter {
      text-align: right;
      font-size: 11px;
      color: #B5B0A0;
      margin-top: 4px;
      letter-spacing: 0.02em;
    }
    .pfb-counter.warn { color: #E07B39; }
    .pfb-counter.error { color: #C0392B; font-weight: 500; }

    /* ─── Error message (in footer area) ─── */
    .pfb-error {
      padding: 8px 12px;
      background: rgba(192, 57, 43, 0.08);
      border-left: 3px solid #C0392B;
      color: #C0392B;
      font-size: 12px;
      line-height: 1.4;
      border-radius: 3px;
      margin: 0 20px;
      display: none;
    }
    .pfb-error.show { display: block; }

    /* ─── Footer / buttons ─── */
    .pfb-modal-footer {
      padding: 14px 20px;
      border-top: 1px solid #DDD8CC;
      background: #FAFAF8;
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }
    .pfb-btn {
      padding: 9px 18px;
      font-family: inherit;
      font-size: 11px;
      font-weight: 500;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      cursor: pointer;
      border-radius: 4px;
      transition: all 0.15s;
      min-height: 38px;
      border: 1px solid transparent;
    }
    .pfb-btn-cancel {
      background: transparent;
      color: #7A8C82;
      border-color: #DDD8CC;
    }
    .pfb-btn-cancel:hover { color: #2C3A32; border-color: #2C3A32; }
    .pfb-btn-submit {
      background: #3e5a42;
      color: #fff;
      border-color: #3e5a42;
    }
    .pfb-btn-submit:hover { background: #4a6b4f; border-color: #4a6b4f; }
    .pfb-btn-submit:disabled {
      background: #B5B0A0;
      border-color: #B5B0A0;
      cursor: not-allowed;
      opacity: 0.6;
    }

    /* ─── Spinner ─── */
    .pfb-spinner {
      display: inline-block;
      width: 12px; height: 12px;
      border: 2px solid rgba(255,255,255,0.4);
      border-top-color: #fff;
      border-radius: 50%;
      animation: pfb-spin 0.7s linear infinite;
      margin-right: 6px;
      vertical-align: middle;
    }
    @keyframes pfb-spin { to { transform: rotate(360deg); } }

    /* ─── Thanks screen ─── */
    .pfb-thanks {
      padding: 40px 24px;
      text-align: center;
      display: none;
    }
    .pfb-thanks.show { display: block; }
    .pfb-thanks-check {
      width: 56px; height: 56px;
      border-radius: 50%;
      background: #3e5a42;
      color: #fff;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 16px;
      font-size: 28px;
    }
    .pfb-thanks-title {
      font-family: 'Cormorant Garamond', Georgia, serif;
      font-size: 22px;
      color: #3e5a42;
      margin-bottom: 10px;
    }
    .pfb-thanks-msg {
      font-size: 13px;
      color: #2C3A32;
      line-height: 1.6;
      max-width: 340px;
      margin: 0 auto 22px;
    }
    .pfb-thanks-close {
      padding: 9px 28px;
      background: #3e5a42;
      color: #fff;
      border: none;
      border-radius: 4px;
      font-family: inherit;
      font-size: 11px;
      font-weight: 500;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      cursor: pointer;
    }
    .pfb-thanks-close:hover { background: #4a6b4f; }

    /* ─── Mobile adjustments ─── */
    @media (max-width: 700px) {
      .pfb-modal { max-height: 96vh; border-radius: 8px 8px 0 0; align-self: flex-end; }
      .pfb-overlay { padding: 0; align-items: flex-end; }
      .pfb-modal-header { padding: 14px 16px; }
      .pfb-modal-body { padding: 16px; }
      .pfb-modal-footer { padding: 12px 16px; }
      .pfb-option { padding: 8px 10px; font-size: 11px; }
      .pfb-btn { padding: 9px 14px; font-size: 10px; letter-spacing: 0.1em; }
      /* Mobile tab: compact, no text */
      .pfb-tab {
        width: 6px;
        min-height: 60px;
        font-size: 0;       /* hides text */
        padding: 0;
        writing-mode: horizontal-tb;
      }
      .pfb-tab:hover { width: 10px; }
    }
  `;

  // ──────────────────────────────────────────────────────────────────
  // HELPERS
  // ──────────────────────────────────────────────────────────────────
  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c];
    });
  }

  function detectMobile() {
    return window.matchMedia('(max-width: ' + MOBILE_BREAKPOINT + 'px)').matches;
  }

  function getViewportSize() {
    return window.innerWidth + 'x' + window.innerHeight;
  }

  function isAdminRole(role) {
    const r = (role || '').toLowerCase();
    return r === 'admin' || r === 'super_admin';
  }

  // ──────────────────────────────────────────────────────────────────
  // SUPABASE INIT
  // ──────────────────────────────────────────────────────────────────
  async function initSupabase() {
    if (!window.supabase || !window.supabase.createClient) {
      console.warn('[FeedbackWidget] supabase-js not loaded, widget will not render');
      return false;
    }
    _supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

    const { data: { session }, error } = await _supabase.auth.getSession();
    if (error || !session) {
      console.log('[FeedbackWidget] No active session, widget will not render');
      return false;
    }
    _session = session;

    // Load dealer row for name + role
    const { data: row, error: rowErr } = await _supabase
      .from('dealers')
      .select('id, company_name, role, is_active')
      .eq('id', session.user.id)
      .single();

    if (rowErr || !row) {
      console.warn('[FeedbackWidget] Could not load dealer row:', rowErr);
      return false;
    }
    if (!row.is_active) {
      console.log('[FeedbackWidget] User is not active, widget will not render');
      return false;
    }
    _dealerRow = row;
    return true;
  }

  // ──────────────────────────────────────────────────────────────────
  // RENDER
  // ──────────────────────────────────────────────────────────────────
  function mount() {
    _isMobile = detectMobile();

    _host = document.createElement('div');
    _host.id = 'pcd-feedback-widget-host';
    document.body.appendChild(_host);
    _shadow = _host.attachShadow({ mode: 'closed' });

    const styleEl = document.createElement('style');
    styleEl.textContent = CSS;
    _shadow.appendChild(styleEl);

    renderTab();
    renderModal();

    console.log('[FeedbackWidget] Mounted v1.2 — user:', _dealerRow.company_name,
                '· role:', _dealerRow.role,
                '· mobile:', _isMobile);
  }

  /**
   * Renders the persistent tab on the left edge of the viewport.
   * Tab is always visible; clicking it opens the modal directly.
   * - Desktop: 24px wide with vertical "Feedback" text
   * - Mobile:  6px wide with no text (CSS @media handles it)
   */
  function renderTab() {
    const tab = document.createElement('button');
    tab.className = 'pfb-tab';
    tab.type = 'button';
    tab.setAttribute('aria-label', 'Send feedback');
    tab.title = 'Send feedback';
    tab.textContent = 'Feedback';  // hidden via font-size:0 on mobile
    tab.addEventListener('click', openModal);
    _shadow.appendChild(tab);
  }

  function renderModal() {
    const overlay = document.createElement('div');
    overlay.className = 'pfb-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');

    overlay.innerHTML = `
      <div class="pfb-modal">
        <div class="pfb-modal-header">
          <span class="pfb-modal-title">Send Feedback</span>
          <button class="pfb-modal-close" type="button" aria-label="Close">×</button>
        </div>

        <div class="pfb-modal-body" data-screen="form">
          <div class="pfb-field">
            <label class="pfb-label">
              How was your experience?
              <span class="pfb-optional">(optional)</span>
            </label>
            <div class="pfb-options pfb-sentiment-options">
              ${SENTIMENTS.map(function (s) {
                return '<button type="button" class="pfb-option pfb-sentiment" data-value="' + esc(s.value) + '">' +
                  '<span class="pfb-option-icon">' + s.icon + '</span>' +
                  '<span>' + esc(s.label) + '</span>' +
                '</button>';
              }).join('')}
            </div>
          </div>

          <div class="pfb-field">
            <label class="pfb-label">
              What's this about?
              <span class="pfb-optional">(optional)</span>
            </label>
            <div class="pfb-options pfb-category-options">
              ${CATEGORIES.map(function (c) {
                return '<button type="button" class="pfb-option pfb-category" data-value="' + esc(c.value) + '">' +
                  '<span class="pfb-option-icon">' + c.icon + '</span>' +
                  '<span>' + esc(c.label) + '</span>' +
                '</button>';
              }).join('')}
            </div>
          </div>

          <div class="pfb-field">
            <label class="pfb-label" for="pfb-message">
              Tell us more
              <span class="pfb-required">*</span>
            </label>
            <div class="pfb-textarea-wrap">
              <textarea id="pfb-message" class="pfb-textarea" rows="4"
                placeholder="What's on your mind? The more specific, the better."
                maxlength="${MESSAGE_MAX}"></textarea>
              <div class="pfb-counter">0 / ${MESSAGE_MAX}</div>
            </div>
          </div>
        </div>

        <div class="pfb-thanks" data-screen="thanks">
          <div class="pfb-thanks-check">✓</div>
          <div class="pfb-thanks-title">Thanks for your feedback!</div>
          <div class="pfb-thanks-msg">We read every submission and use it to improve the portal.</div>
          <button type="button" class="pfb-thanks-close">Close</button>
        </div>

        <div class="pfb-error" id="pfb-error"></div>

        <div class="pfb-modal-footer" data-screen="form">
          <button type="button" class="pfb-btn pfb-btn-cancel" id="pfb-cancel">Cancel</button>
          <button type="button" class="pfb-btn pfb-btn-submit" id="pfb-submit" disabled>Send</button>
        </div>
      </div>
    `;

    _shadow.appendChild(overlay);

    // Wire events
    overlay.querySelector('.pfb-modal-close').addEventListener('click', closeModal);
    overlay.querySelector('#pfb-cancel').addEventListener('click', closeModal);
    overlay.querySelector('#pfb-submit').addEventListener('click', submitFeedback);
    overlay.querySelector('.pfb-thanks-close').addEventListener('click', closeModal);

    // Sentiment selection
    overlay.querySelectorAll('.pfb-sentiment').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const val = btn.getAttribute('data-value');
        if (_selectedSentiment === val) {
          // Toggle off
          _selectedSentiment = null;
          btn.classList.remove('selected');
        } else {
          _selectedSentiment = val;
          overlay.querySelectorAll('.pfb-sentiment').forEach(function (b) { b.classList.remove('selected'); });
          btn.classList.add('selected');
        }
      });
    });

    // Category selection
    overlay.querySelectorAll('.pfb-category').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const val = btn.getAttribute('data-value');
        if (_selectedCategory === val) {
          _selectedCategory = null;
          btn.classList.remove('selected');
        } else {
          _selectedCategory = val;
          overlay.querySelectorAll('.pfb-category').forEach(function (b) { b.classList.remove('selected'); });
          btn.classList.add('selected');
        }
      });
    });

    // Textarea
    const textarea = overlay.querySelector('#pfb-message');
    const counter  = overlay.querySelector('.pfb-counter');
    const submitBtn = overlay.querySelector('#pfb-submit');

    textarea.addEventListener('input', function () {
      const len = textarea.value.length;
      counter.textContent = len + ' / ' + MESSAGE_MAX;
      counter.classList.remove('warn', 'error');
      if (len >= MESSAGE_MAX) counter.classList.add('error');
      else if (len >= MESSAGE_MAX - 100) counter.classList.add('warn');
      submitBtn.disabled = (len === 0 || len > MESSAGE_MAX);
    });

    // Close on overlay click (outside modal)
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closeModal();
    });

    // Esc to close
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        const isShown = overlay.classList.contains('show');
        if (isShown) closeModal();
      }
    });
  }

  // ──────────────────────────────────────────────────────────────────
  // MODAL OPEN / CLOSE
  // ──────────────────────────────────────────────────────────────────
  function openModal() {
    const overlay = _shadow.querySelector('.pfb-overlay');
    if (!overlay) return;

    resetForm();
    showFormScreen();
    overlay.classList.add('show');

    // Focus textarea after a tick
    setTimeout(function () {
      const ta = _shadow.querySelector('#pfb-message');
      if (ta) ta.focus();
    }, 50);
  }

  function closeModal() {
    const overlay = _shadow.querySelector('.pfb-overlay');
    if (!overlay) return;
    overlay.classList.remove('show');
  }

  function showFormScreen() {
    const body   = _shadow.querySelector('.pfb-modal-body');
    const thanks = _shadow.querySelector('.pfb-thanks');
    const footer = _shadow.querySelector('.pfb-modal-footer');
    if (body)   body.style.display   = '';
    if (thanks) thanks.classList.remove('show');
    if (footer) footer.style.display = '';
  }

  function showThanksScreen() {
    const body   = _shadow.querySelector('.pfb-modal-body');
    const thanks = _shadow.querySelector('.pfb-thanks');
    const footer = _shadow.querySelector('.pfb-modal-footer');
    if (body)   body.style.display   = 'none';
    if (thanks) thanks.classList.add('show');
    if (footer) footer.style.display = 'none';
  }

  function resetForm() {
    _selectedSentiment = null;
    _selectedCategory  = null;
    _shadow.querySelectorAll('.pfb-option').forEach(function (b) { b.classList.remove('selected'); });
    const ta = _shadow.querySelector('#pfb-message');
    if (ta) ta.value = '';
    const counter = _shadow.querySelector('.pfb-counter');
    if (counter) {
      counter.textContent = '0 / ' + MESSAGE_MAX;
      counter.classList.remove('warn', 'error');
    }
    const submit = _shadow.querySelector('#pfb-submit');
    if (submit) submit.disabled = true;
    hideError();
  }

  function showError(msg) {
    const el = _shadow.querySelector('#pfb-error');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
  }
  function hideError() {
    const el = _shadow.querySelector('#pfb-error');
    if (!el) return;
    el.classList.remove('show');
    el.textContent = '';
  }

  // ──────────────────────────────────────────────────────────────────
  // SUBMIT
  // ──────────────────────────────────────────────────────────────────
  async function submitFeedback() {
    hideError();

    const ta = _shadow.querySelector('#pfb-message');
    const message = (ta.value || '').trim();
    if (!message) {
      showError('Please write a message before sending.');
      return;
    }
    if (message.length > MESSAGE_MAX) {
      showError('Message is too long. Please shorten it.');
      return;
    }

    const submitBtn = _shadow.querySelector('#pfb-submit');
    const cancelBtn = _shadow.querySelector('#pfb-cancel');
    const originalLabel = submitBtn.innerHTML;
    submitBtn.disabled = true;
    cancelBtn.disabled = true;
    submitBtn.innerHTML = '<span class="pfb-spinner"></span>Sending...';

    const payload = {
      dealer_id:         _session.user.id,
      dealer_name:       _dealerRow.company_name || null,
      submitted_by_role: isAdminRole(_dealerRow.role) ? (_dealerRow.role || 'admin') : 'dealer',
      sentiment:         _selectedSentiment,
      category:          _selectedCategory,
      message:           message,
      page_url:          window.location.href.substring(0, 1000),  // safety cap
      user_agent:        navigator.userAgent.substring(0, 500),
      viewport_size:     getViewportSize(),
    };

    try {
      const { error } = await _supabase.from('portal_feedback').insert(payload);

      if (error) {
        console.error('[FeedbackWidget] Insert error:', error);

        // Map DB errors to user-friendly messages
        const errMsg = (error.message || '').toLowerCase();
        if (errMsg.includes('rate limit')) {
          showError("You've sent a lot of feedback recently — thanks! Please wait a bit before sending more.");
        } else if (errMsg.includes('jwt') || errMsg.includes('expired') || error.code === 'PGRST301') {
          showError('Your session expired. Please log in again.');
        } else if (errMsg.includes('message_length') || errMsg.includes('check constraint')) {
          showError("Message must be 1-2000 characters.");
        } else {
          showError('Something went wrong. Please try again or contact support.');
        }

        // Restore button state
        submitBtn.disabled = false;
        cancelBtn.disabled = false;
        submitBtn.innerHTML = originalLabel;
        return;
      }

      // Success
      console.log('[FeedbackWidget] Feedback submitted successfully');
      showThanksScreen();

    } catch (err) {
      console.error('[FeedbackWidget] Unexpected error:', err);
      const isNetworkErr = err && (err.message || '').toLowerCase().includes('fetch');
      showError(isNetworkErr
        ? "Couldn't send. Please check your connection and try again."
        : 'Something went wrong. Please try again.');

      submitBtn.disabled = false;
      cancelBtn.disabled = false;
      submitBtn.innerHTML = originalLabel;
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // BOOT
  // ──────────────────────────────────────────────────────────────────
  async function boot() {
    // Wait for DOM ready
    if (document.readyState === 'loading') {
      await new Promise(function (r) { document.addEventListener('DOMContentLoaded', r); });
    }
    const ok = await initSupabase();
    if (!ok) return;
    mount();
  }

  boot();

})();
