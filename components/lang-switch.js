/* ──────────────────────────────────────────────────────────────────────
 * ProCraft Dealer Portal — Language Switch (CB-62, v2)
 *
 * 可複用的語言切換鈕。Stage B 各頁一律引用本檔,不各自實作。
 *
 * 【v2 變更(CB-62 B3)】
 *   1. 對外提供 pcMountLangSwitch(container) —— 供 navigator.js 在【非同步
 *      渲染完成後】主動掛載。導覽列要先取得 session 與 role 才畫得出來,
 *      屆時 DOMContentLoaded 早就過了,自動掛載那條路徑來不及。
 *   2. 支援多實例 —— 桌機導覽列與手機選單各一個,狀態同步更新。
 *   3. 保留 v1 的自動掛載:找得到 #pcd-lang-switch 就掛。向下相容,
 *      B1/B2 各頁在移除掛載點之前照常運作。
 *
 * 【頁面接法|兩種】
 *   A. 自動(v1 作法):版面放 <div id="pcd-lang-switch"></div>
 *   B. 主動(v2,navigator 用):window.pcMountLangSwitch(element, { inline: true })
 *   兩種都要在 i18n.js 之後載入本檔。本檔自帶樣式,各頁不必複製 CSS。
 *
 * 【🔴 加語言只改一個地方】
 *   下方 LANGS 陣列加一筆即可。同時記得:
 *     · components/i18n.js 的 SUPPORTED 白名單加同一個 code
 *     · 新增 i18n/<code>.json
 *   三處齊了就完成。詳見 i18n/README.md(DOC-1)§5。
 *
 * 【零 innerHTML】
 *   全程 createElement / textContent,與 i18n.js 同一原則(Q-2 通則)。
 *
 * 【fail-silent + admin 閘門】
 *   i18n.js 未載入(admin 頁)→ 靜默不渲染。切換鈕沒有框架可切,畫出來
 *   只會誤導。這沿用 B1「以 i18n.js 是否載入為開關」的機制,admin 頁
 *   不需要任何旗標或黑名單。
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

  var MOUNT_ID = 'pcd-lang-switch';
  var STYLE_ID = 'pcd-lang-switch-style';
  var ARIA_KEY = 'common.lang.switch_aria';

  // ═══════════════════════════════════════════════════════════════════
  // 樣式(自行注入,只注入一次)
  // ═══════════════════════════════════════════════════════════════════
  // 所有 var() 都給第二參數當保險 —— 某頁若沒定義 brand token 也不會變透明。

  var CSS = [
    '.pcd-lang{',
    '  display:flex;align-items:center;justify-content:flex-end;',
    '  gap:2px;margin:0 -8px 18px 0;',
    '}',
    // v2:在導覽列內使用時不需要外距,由 navigator 傳 inline 加此修飾類別。
    '.pcd-lang.pcd-lang--inline{margin:0;}',
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
  // 渲染(v2:多實例)
  // ═══════════════════════════════════════════════════════════════════
  // 每個 instance = { wrap, buttons }。語言變更時全部同步。

  var instances = [];

  function syncOne(inst) {
    var lang = window.pcGetLang();
    for (var i = 0; i < inst.buttons.length; i++) {
      var b  = inst.buttons[i];
      var on = (b.getAttribute('data-lang') === lang);
      b.classList.toggle('pcd-lang-btn--on', on);
      // aria-current 讓螢幕閱讀器知道哪個是目前語言;非當前項移除屬性而非設 false。
      if (on) { b.setAttribute('aria-current', 'true'); }
      else    { b.removeAttribute('aria-current'); }
      b.disabled = on;
    }
    // 查無 key 時 pcT 回 null → 用英文保底,絕不寫入 "null"
    inst.wrap.setAttribute('aria-label', window.pcT(ARIA_KEY) || 'Language');
  }

  function syncAll() {
    for (var i = 0; i < instances.length; i++) syncOne(instances[i]);
  }

  function onClick(e) {
    var lang = e.currentTarget.getAttribute('data-lang');
    if (!lang || lang === window.pcGetLang()) return;
    // pcSetLang 內部會重新水合並發出 pc:i18n-changed,狀態同步交給監聽器。
    window.pcSetLang(lang);
  }

  function build(mount, inline) {
    var wrap = document.createElement('div');
    wrap.className = 'pcd-lang' + (inline ? ' pcd-lang--inline' : '');
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', 'Language');   // 語言檔到位後由 syncOne 覆寫

    var buttons = [];
    for (var i = 0; i < LANGS.length; i++) {
      if (i > 0) {
        var sep = document.createElement('span');
        sep.className = 'pcd-lang-sep';
        sep.setAttribute('aria-hidden', 'true');
        wrap.appendChild(sep);
      }
      var b = document.createElement('button');
      b.type = 'button';                 // 沒有這行,頁面若有 <form> 會誤觸送出
      b.className = 'pcd-lang-btn';
      b.setAttribute('data-lang', LANGS[i].code);
      b.textContent = LANGS[i].label;
      b.addEventListener('click', onClick);
      wrap.appendChild(b);
      buttons.push(b);
    }

    mount.appendChild(wrap);
    var inst = { wrap: wrap, buttons: buttons };
    instances.push(inst);
    syncOne(inst);
    return wrap;
  }

  // ═══════════════════════════════════════════════════════════════════
  // 對外掛載函式(v2)
  // ═══════════════════════════════════════════════════════════════════

  /**
   * 把切換鈕掛進指定容器。
   *
   * @param  {Element} container 掛載目標
   * @param  {Object}  [opts]    { inline: true } 去掉外距,供導覽列內使用
   * @return {Element|null}      建立的元素;未渲染時回 null
   *
   * 未渲染的情況(皆為刻意,靜默處理):
   *   · i18n.js 未載入 → admin 頁,不應出現切換鈕
   *   · container 不存在
   *   · 該 container 已有內容(冪等,避免重複掛載)
   */
  function pcMountLangSwitch(container, opts) {
    if (typeof window.pcSetLang !== 'function' || typeof window.pcGetLang !== 'function') return null;
    if (!container || typeof container.appendChild !== 'function') return null;
    if (container.firstChild) return null;
    injectStyle();
    return build(container, !!(opts && opts.inline));
  }

  window.pcMountLangSwitch = pcMountLangSwitch;

  // ═══════════════════════════════════════════════════════════════════
  // 自動掛載(v1 行為,向下相容)
  // ═══════════════════════════════════════════════════════════════════

  function autoMount() {
    // i18n.js 未載入 → 靜默退出(admin 頁)。v2 之後「沒有切換鈕」在 admin
    // 頁是正常狀態而非設定錯誤,故不再記 console.error。
    if (typeof window.pcSetLang !== 'function') return;
    var mount = document.getElementById(MOUNT_ID);
    if (mount) pcMountLangSwitch(mount);
  }

  function init() {
    autoMount();
    // 語言變更(不論由哪個實例或其他途徑觸發)一律同步所有實例的視覺狀態。
    document.addEventListener('pc:i18n-changed', syncAll);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
