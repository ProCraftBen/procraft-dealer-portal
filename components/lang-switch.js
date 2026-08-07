/* ──────────────────────────────────────────────────────────────────────
 * ProCraft Dealer Portal — Language Switch (CB-62 Stage A, v cb62)
 *
 * 可複用的語言切換鈕。Stage B 各頁一律引用本檔,不各自實作。
 *
 * 【頁面接法|兩件事】
 *   1. 版面裡放一個掛載點:  <div id="pcd-lang-switch"></div>
 *   2. 在 i18n.js 之後載入:  <script src="components/lang-switch.js?v=cb62">
 *   本檔自帶樣式(自行注入 <style>),各頁【不必】複製任何 CSS。
 *
 * 【🔴 加語言只改一個地方】
 *   下方 LANGS 陣列加一筆即可。同時記得:
 *     · components/i18n.js 的 SUPPORTED 白名單加同一個 code
 *     · 新增 i18n/<code>.json
 *   三處齊了就完成,本檔其餘部分不動。詳見 i18n/README.md(DOC-1)§5。
 *
 * 【零 innerHTML】
 *   全程 createElement / textContent,與 i18n.js 同一原則(Q-2 通則)。
 *
 * 【fail-silent】
 *   找不到掛載點、或 i18n.js 未載入 → 靜默不做事,不拋錯、不留半截 DOM。
 *   對齊 navigator.js headless 模式的慣例:元件不寫自己不擁有的容器。
 *
 * 【樣式取向】
 *   刻意做成極簡文字切換(EN | ES),沿用既有 brand token,與 .field label
 *   同一調性(11px / uppercase / letter-spacing)。不引入新的視覺語彙,
 *   以免動到 F-20 剛做完的登入頁門面。
 * ────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  if (window.__pcdLangSwitchLoaded) return;
  window.__pcdLangSwitchLoaded = true;

  // 🔴 加語言改這裡(label 是語言的自稱,永遠不進語言檔、永遠不翻譯)
  var LANGS = [
    { code: 'en', label: 'EN' },
    { code: 'es', label: 'ES' }
  ];

  var MOUNT_ID  = 'pcd-lang-switch';
  var STYLE_ID  = 'pcd-lang-switch-style';
  var ARIA_KEY  = 'common.lang.switch_aria';

  // ═══════════════════════════════════════════════════════════════════
  // 樣式(自行注入,只注入一次)
  // ═══════════════════════════════════════════════════════════════════
  // 所有 var() 都給第二參數當保險 —— 某頁若沒定義 brand token 也不會變透明。

  var CSS = [
    '.pcd-lang{',
    '  display:flex;align-items:center;justify-content:flex-end;',
    '  gap:2px;margin:0 -8px 18px 0;',
    '}',
    '.pcd-lang-btn{',
    '  background:none;border:none;cursor:pointer;',
    '  font-family:inherit;font-size:11px;font-weight:500;',
    '  letter-spacing:0.16em;text-transform:uppercase;',
    '  color:var(--muted,#7A8C82);',
    '  padding:6px 8px;line-height:1;border-radius:3px;',
    '  transition:color 0.2s;',
    '}',
    '.pcd-lang-btn:hover{color:var(--gold,#C9A84C);}',
    '.pcd-lang-btn:focus-visible{',
    '  outline:2px solid var(--gold,#C9A84C);outline-offset:2px;',
    '}',
    '.pcd-lang-btn--on{color:var(--gold,#C9A84C);font-weight:600;cursor:default;}',
    '.pcd-lang-sep{',
    '  width:1px;height:11px;flex:0 0 auto;',
    '  background:var(--border,#DDD8CC);',
    '}',
    '@media (prefers-reduced-motion: reduce){',
    '  .pcd-lang-btn{transition:none;}',
    '}'
  ].join('\n');

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  // ═══════════════════════════════════════════════════════════════════
  // 渲染
  // ═══════════════════════════════════════════════════════════════════

  var wrap = null;
  var buttons = [];

  function syncState() {
    var lang = window.pcGetLang();
    for (var i = 0; i < buttons.length; i++) {
      var b  = buttons[i];
      var on = (b.getAttribute('data-lang') === lang);
      b.classList.toggle('pcd-lang-btn--on', on);
      // aria-current 讓螢幕閱讀器知道哪個是目前語言;非當前項移除屬性而非設 false。
      if (on) { b.setAttribute('aria-current', 'true'); }
      else    { b.removeAttribute('aria-current'); }
      b.disabled = on;
    }
    if (wrap) {
      // 查無 key 時 pcT 回 null → 用英文保底,絕不寫入 "null"
      wrap.setAttribute('aria-label', window.pcT(ARIA_KEY) || 'Language');
    }
  }

  function build(mount) {
    wrap = document.createElement('div');
    wrap.className = 'pcd-lang';
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', 'Language');   // 先給英文,語言檔到位後由 syncState 覆寫

    for (var i = 0; i < LANGS.length; i++) {
      if (i > 0) {
        var sep = document.createElement('span');
        sep.className = 'pcd-lang-sep';
        sep.setAttribute('aria-hidden', 'true');
        wrap.appendChild(sep);
      }

      var b = document.createElement('button');
      b.type = 'button';                 // 沒有這行,Stage B 若有 <form> 會誤觸送出
      b.className = 'pcd-lang-btn';
      b.setAttribute('data-lang', LANGS[i].code);
      b.textContent = LANGS[i].label;
      b.addEventListener('click', onClick);
      wrap.appendChild(b);
      buttons.push(b);
    }

    mount.appendChild(wrap);
    syncState();
  }

  function onClick(e) {
    var lang = e.currentTarget.getAttribute('data-lang');
    if (!lang || lang === window.pcGetLang()) return;
    // pcSetLang 內部會重新水合並發出 pc:i18n-changed,狀態同步交給下面的監聽器。
    window.pcSetLang(lang);
  }

  // ═══════════════════════════════════════════════════════════════════
  // 啟動
  // ═══════════════════════════════════════════════════════════════════

  function init() {
    // i18n.js 未載入 → 靜默退出。切換鈕沒有框架可切,渲染出來只會誤導。
    if (typeof window.pcSetLang !== 'function' || typeof window.pcGetLang !== 'function') {
      console.error('[CB-62] lang-switch: components/i18n.js must be loaded first — switch not rendered.');
      return;
    }

    var mount = document.getElementById(MOUNT_ID);
    if (!mount) return;                  // fail-silent:本頁不要切換鈕
    if (mount.firstChild) return;        // 已渲染過(冪等)

    injectStyle();
    build(mount);

    // 語言變更(不論由本元件或其他途徑觸發)一律重新同步視覺狀態。
    document.addEventListener('pc:i18n-changed', syncState);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
