/* ──────────────────────────────────────────────────────────────────────
 * ProCraft Dealer Portal — i18n Framework (CB-62 Stage A, v cb62)
 *
 * dealer 端介面文字的多語系框架。目前支援 en / es,未來加簡中只需新增
 * i18n/zh.json + 兩處白名單,本檔不動。
 *
 * ═══ 核心紅線:換文字,不換結構 ═════════════════════════════════════
 * 本檔一律只寫 textContent 或具名屬性,【全檔無 innerHTML】。
 * 需要行內標記(粗體 / 斜體 / 連結)的文案,一律【拆成多個 key,標記留在
 * HTML】—— 絕不新增會注入 HTML 的屬性。此為 Q-2 拍板的全站通則,理由是
 * 把 XSS 面壓到零。
 *   範例:login.brand.tagline_1 + login.brand.tagline_2 夾住一個 <em>。
 * ═══════════════════════════════════════════════════════════════════
 *
 * 【fallback 三層|不得顯示空白、不得顯示裸 key】
 *   當前語言 → en.json → 【不覆寫,保留 HTML 原文】
 *   第三層是關鍵:兩邊都查無 key 時本檔【什麼都不寫】,畫面留著 HTML 裡
 *   作者手寫的英文。因此:
 *     · 裸 key(login.title)不可能出現在畫面上
 *     · 空白標籤不可能出現在畫面上
 *     · 英文使用者零 FOUC —— 對他們而言水合是 no-op
 *     · 新語言可以只翻一半就上線,沒翻的地方顯示英文,不是破洞
 *
 * 【fail-open|對齊 CB-42 Q-1 政策】
 *   語言檔 404 / timeout / JSON 壞掉 → 本檔【不寫入任何文字】,
 *   console.error 留 audit log,PC_I18N_READY 照常 resolve(永不 reject)。
 *   頁面以 HTML 原生英文渲染,功能完全正常。
 *   理由:i18n 故障【絕不允許】造成 dealer 無法登入。
 *   localStorage 全程 try/catch,無痕模式退回記憶體變數,不拋錯。
 *
 * 【🔴 路徑|相對路徑,執行期推導,禁用絕對路徑】
 *   語言檔一律以 new URL(..., document.baseURI) 解析。
 *   【絕不可寫成 '/i18n/en.json'】—— 開頭那個斜線就是 bug。
 *   原因見 login.html 內 CB-53 / B-14 註記:本 app 不保證掛在網域根目錄,
 *   staging 曾掛子目錄,且 procraftben.github.io 是同帳號共享 origin。
 *   絕對路徑會對著 origin 根解析然後 404。
 *
 * 【🔴 快取|兩處 ?v= 必須同時 bump】
 *   (1) 各頁 HTML 的 <script src="components/i18n.js?v=cb62">
 *   (2) 本檔內的 PC_I18N_VER 常數(語言檔 fetch 用)
 *   只改其中一個的後果:瀏覽器還握著舊的 i18n.js(它的 src 沒變),
 *   永遠看不到新常數,於是一直去要舊的語言檔 URL ——【改動完全隱形,
 *   而且看起來一切正常】。這是 F-24 / B-7 那類最難查的 bug。
 *   規則:動到 i18n/ 底下任何檔案,兩處一起 bump,值保持一致。
 *
 * 【🔴 已知耦合|login.html】
 *   components/login-i18n-bridge.js 與 login.html auth script(L315-718,
 *   凍結、以 sha256 佐證 byte-identical)內的 11 條英文字面【逐字耦合】。
 *   要改 login.html 那些訊息的人,必須同步更新 Bridge 的反查表。
 *   完整清單與行號見 i18n/README.md(DOC-1)§7。
 *
 * 【載入時機】
 *   supabase CDN → config.js → status-label.js(有 quote status 的頁才要)
 *   → 本檔 → lang-switch.js → 頁面 inline script
 *   無 defer / async,同步依序執行,頁面 inline script 跑的時候
 *   window.pcT 必定就位。
 *
 * 【⚠️ 用 pcT,不要用 t】
 *   t 是單字元 global。頁面 inline script 若在頂層宣告 const t,該宣告會
 *   遮蔽別名,整頁 t() 全掛。此為 status-label.js 記載過的同型坑
 *   (statusLabel 碰撞差點讓五頁 JS 全死)。本檔包在 IIFE 內且只對 window
 *   賦值,碰撞【不會】造成 SyntaxError,最壞只是單頁失去翻譯。
 *   即便如此,Stage B 各頁一律呼叫 pcT()。t 只留給臨時片段用。
 * ────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  // 冪等防護(對齊 status-label.js / navigator.js 慣例)
  if (window.__pcdI18nLoaded) return;
  window.__pcdI18nLoaded = true;

  // ═══════════════════════════════════════════════════════════════════
  // 設定
  // ═══════════════════════════════════════════════════════════════════

  // 🔴 語言檔 fetch 的版本參數。改語言檔時必須連同各頁 HTML 的
  //    <script src="components/i18n.js?v=..."> 一起 bump,兩者保持一致。
  //
  // ⚠️ CB-84 促銷版例外:本次【只】bump 本常數,13 頁的 ?v= 一律未動
  //    (仍為 cb62c / cb79a / cb80)。理由:CB-84 新增的 20 個 key 只有
  //    dealer-profile.html 會用到,而該頁本來就在 promote 清單內;
  //    要 bump 13 頁就得連帶推 dashboard.html,那會把一筆與本票無關的
  //    promo 改動帶進 production。
  //    後果已知且有界:暖快取的頁面沿用舊的 i18n.js(PC_I18N_VER='cb81'),
  //    最多 10 分鐘後自癒(GitHub Pages max-age=600,CB-82 實測),
  //    期間西語使用者在新 modal 看到的是英文 fallback,不是壞掉的畫面。
  //    📌 README §4 已載明單獨 bump 本常數是「合法但部分生效」。
  var PC_I18N_VER = 'cb88';

  var BASE_LANG   = 'en';                 // fallback 基準,永遠載入
  var SUPPORTED   = ['en', 'es'];         // 加語言時在此加一筆
  var STORAGE_KEY = 'pc_lang';

  // 白名單存在的理由:localStorage 是使用者可手改的。若有人把 pc_lang 改成
  // 'xx',沒有白名單就會去 fetch 一個不存在的檔並 404。
  // ── 內建參數 ──
  // 每次 pcT() 都會自動供應,呼叫端不必傳。{year} 在 footer 版權宣告用得到,
  // 而 Stage B 每一頁的 footer 都需要它。
  function globalParams() {
    return { year: new Date().getFullYear() };
  }

  // ═══════════════════════════════════════════════════════════════════
  // 狀態
  // ═══════════════════════════════════════════════════════════════════

  var dicts      = {};          // { en: {...} | null, es: {...} | null }
  var attempted  = {};          // 已嘗試載入過的語言(含失敗),避免重複 fetch
  var current    = BASE_LANG;
  var isApplying = false;       // Bridge 靠這個分辨「這次寫入是本檔自己做的」
  var warnedKeys = {};          // 同一個缺失 key 只警告一次,避免洗版
  var memLang    = null;        // localStorage 不可用時的記憶體退路
  var loaded     = false;       // 字典是否已載入完畢(見 pcT 的 warn 條件)

  function has(obj, key) {
    return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
  }

  // ═══════════════════════════════════════════════════════════════════
  // localStorage(全程 try/catch,無痕模式不得拋錯)
  // ═══════════════════════════════════════════════════════════════════

  function readStore() {
    try {
      var v = window.localStorage.getItem(STORAGE_KEY);
      if (v) return v;
    } catch (e) { /* 停用 / 無痕 → 落回記憶體 */ }
    return memLang;
  }

  function writeStore(lang) {
    memLang = lang;
    try {
      window.localStorage.setItem(STORAGE_KEY, lang);
    } catch (e) {
      console.error('[CB-62] i18n: localStorage unavailable, language preference is session-only',
        String((e && e.message) || e));
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // 語言檔載入
  // ═══════════════════════════════════════════════════════════════════

  // 🔴 相對路徑 + document.baseURI。絕不可改成絕對路徑。
  function dictUrl(lang) {
    return new URL('i18n/' + lang + '.json?v=' + PC_I18N_VER, document.baseURI).href;
  }

  function loadDict(lang) {
    if (attempted[lang]) return Promise.resolve(!!dicts[lang]);
    attempted[lang] = true;

    var url = dictUrl(lang);

    return fetch(url, { credentials: 'same-origin' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (json) {
        if (!json || typeof json !== 'object' || Array.isArray(json)) {
          throw new Error('malformed_dictionary');
        }
        dicts[lang] = json;
        return true;
      })
      .catch(function (e) {
        // fail-open:留 log,不寫任何文字,頁面維持 HTML 原生英文。
        dicts[lang] = null;
        console.error('[CB-62] i18n language file failed to load — page stays in HTML-authored English', {
          lang:   lang,
          url:    url,
          reason: String((e && e.message) || e)
        });
        return false;
      });
  }

  // ═══════════════════════════════════════════════════════════════════
  // 查詢 + 參數代入
  // ═══════════════════════════════════════════════════════════════════

  // 三層 fallback 的前兩層。兩邊都沒有 → 回 null,由呼叫端決定不覆寫。
  function lookup(key) {
    if (has(dicts[current], key))   return dicts[current][key];
    if (has(dicts[BASE_LANG], key)) return dicts[BASE_LANG][key];
    return null;
  }

  // {name} 代入。缺參數時【原樣保留 {name}】,不輸出 undefined、不拋錯。
  function fill(str, params) {
    if (str.indexOf('{') === -1) return str;
    var merged = globalParams();
    if (params) {
      for (var k in params) {
        if (has(params, k)) merged[k] = params[k];
      }
    }
    return str.replace(/\{(\w+)\}/g, function (whole, name) {
      return (has(merged, name) && merged[name] != null) ? String(merged[name]) : whole;
    });
  }

  /**
   * 取翻譯字串。
   *
   * @param  {string} key       例:'login.title'
   * @param  {Object} [params]  例:{ status: 'Draft' }。{year} 為內建,不必傳。
   * @param  {string} [fallback] 兩本字典都查無時回傳這個(會做參數代入)。
   * @return {string|null}      查無且未給 fallback 時回傳 null。
   *
   * ⚠️ 回傳 null 是刻意的 —— 這是 fallback 第三層在函式層面的表現:
   *    「不知道要寫什麼就不要寫」。請【勿】寫成 el.textContent = pcT(k),
   *    那會在畫面印出 "null"。正確寫法是:
   *      el.textContent = pcT(k) || '原本的英文';
   *    或直接用第三個參數:pcT(k, null, '原本的英文')。
   */
  function pcT(key, params, fallback) {
    var s = lookup(key);
    if (s === null) {
      // 只在「字典確實載入成功、卻仍查不到」時才警告。兩種情況刻意不警告:
      //   · 字典還沒載完(元件初始化時就呼叫 pcT 是正常的)
      //   · 字典載入失敗(loadDict 已經 console.error 過,再逐 key 洗版沒有意義)
      // 這條很重要:login 頁的 Bridge 靠 console.warn 當作「反查表漏更新」的
      // 唯一訊號,假警告會把那個訊號淹掉。
      if (loaded && dicts[BASE_LANG] && !warnedKeys[key]) {
        warnedKeys[key] = true;
        console.warn('[CB-62] i18n key not found in "' + current + '" or "' + BASE_LANG + '": ' + key);
      }
      return (typeof fallback === 'string') ? fill(fallback, params) : null;
    }
    return fill(s, params);
  }

  // ═══════════════════════════════════════════════════════════════════
  // 水合(靜態 HTML)
  // ═══════════════════════════════════════════════════════════════════
  //
  //   <div  data-i18n="login.title">Sign In</div>
  //   <input data-i18n-placeholder="login.field.email_placeholder" />
  //   <div  data-i18n="quote.msg.updated" data-i18n-params='{"n":3}'>...</div>
  //
  // ⚠️ HTML 內【務必】照樣寫正確的英文原文。它是 fallback 第三層,也是英文
  //    使用者實際看到的東西(對他們而言水合是 no-op,零 FOUC)。
  //
  // 冪等,可重複呼叫。JS 動態產生的內容請直接呼叫 pcT(),本檔不掛
  // MutationObserver(login 頁那顆 observer 屬於 Bridge,職責不同)。

  // attribute 名 → 目標屬性。null 代表寫 textContent。
  var TARGETS = [
    ['data-i18n',            null],
    ['data-i18n-placeholder', 'placeholder'],
    ['data-i18n-title',       'title'],
    ['data-i18n-aria-label',  'aria-label']
  ];

  function readParams(el) {
    var raw = el.getAttribute('data-i18n-params');
    if (!raw) return null;
    try {
      var p = JSON.parse(raw);
      return (p && typeof p === 'object' && !Array.isArray(p)) ? p : null;
    } catch (e) {
      console.warn('[CB-62] i18n: malformed data-i18n-params, ignored', raw);
      return null;
    }
  }

  function hydrate(scope, attrName, targetAttr) {
    var nodes = scope.querySelectorAll('[' + attrName + ']');
    for (var i = 0; i < nodes.length; i++) {
      var el  = nodes[i];
      var key = el.getAttribute(attrName);
      if (!key) continue;

      var text = pcT(key, readParams(el));
      if (text === null) continue;          // 🔴 第三層:查無就不覆寫

      if (targetAttr === null) {
        if (el.textContent !== text) el.textContent = text;
      } else {
        if (el.getAttribute(targetAttr) !== text) el.setAttribute(targetAttr, text);
      }
    }
  }

  function pcApplyI18n(root) {
    var scope = root || document;
    if (!scope || typeof scope.querySelectorAll !== 'function') return;

    isApplying = true;                      // Bridge 讀這個旗標
    try {
      for (var i = 0; i < TARGETS.length; i++) {
        hydrate(scope, TARGETS[i][0], TARGETS[i][1]);
      }
    } finally {
      isApplying = false;                   // 例外也要復原,否則 Bridge 永久失效
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // 切換語言
  // ═══════════════════════════════════════════════════════════════════

  function emitChanged() {
    document.dispatchEvent(new CustomEvent('pc:i18n-changed', {
      detail: { lang: current }
    }));
  }

  /**
   * 切換語言:寫 localStorage → 設 documentElement.lang → 重新水合 → 發事件。
   * @return {Promise<boolean>} 語言是否為有效值。永不 reject。
   */
  function pcSetLang(lang) {
    if (SUPPORTED.indexOf(lang) === -1) {
      console.warn('[CB-62] i18n: unsupported language ignored: ' + lang);
      return Promise.resolve(false);
    }
    if (lang === current) return Promise.resolve(true);

    return loadDict(lang).then(function () {
      current = lang;
      writeStore(lang);
      // documentElement.lang 驅動 html[lang="es"] 的版面覆蓋(DOC-1 §8)。
      // 即使語言檔載入失敗也要設 —— 此時文字退回英文,但語言選擇仍成立。
      document.documentElement.setAttribute('lang', lang);
      pcApplyI18n(document);
      emitChanged();
      return true;
    });
  }


  /**
   * CB-62 Q-43:強制當前 session 使用指定語言,【不寫入 localStorage】。
   * 用於 dealer/admin 共用頁:admin 一律英文,但不得污染 dealer 的語言偏好
   * (共用電腦情境)。與 pcSetLang 的唯一差異就是不呼叫 writeStore()。
   * @return {Promise<boolean>} 語言是否為有效值。永不 reject。
   */
  function pcForceLang(lang) {
    if (SUPPORTED.indexOf(lang) === -1) {
      console.warn('[CB-62] i18n: unsupported language ignored: ' + lang);
      return Promise.resolve(false);
    }
    if (lang === current) {
      // 已是目標語言。仍補設 lang 屬性,確保 html[lang] 的版面覆蓋一致。
      document.documentElement.setAttribute('lang', lang);
      return Promise.resolve(true);
    }
    return loadDict(lang).then(function () {
      current = lang;
      document.documentElement.setAttribute('lang', lang);
      pcApplyI18n(document);
      emitChanged();
      return true;
    });
  }

  function pcGetLang() { return current; }

  // ═══════════════════════════════════════════════════════════════════
  // 對外掛載
  // ═══════════════════════════════════════════════════════════════════

  window.pcT          = pcT;
  window.t            = pcT;      // 便利別名。⚠️ 見檔頭警告,Stage B 請用 pcT。
  window.pcSetLang    = pcSetLang;
  window.pcForceLang  = pcForceLang;
  window.pcGetLang    = pcGetLang;
  window.pcApplyI18n  = pcApplyI18n;

  var PC_I18N = {};
  Object.defineProperty(PC_I18N, 'ver',        { get: function () { return PC_I18N_VER; } });
  Object.defineProperty(PC_I18N, 'lang',       { get: function () { return current; } });
  Object.defineProperty(PC_I18N, 'base',       { get: function () { return BASE_LANG; } });
  Object.defineProperty(PC_I18N, 'supported',  { get: function () { return SUPPORTED.slice(); } });
  Object.defineProperty(PC_I18N, 'isApplying', { get: function () { return isApplying; } });
  window.PC_I18N = PC_I18N;

  // ═══════════════════════════════════════════════════════════════════
  // 初始化
  // ═══════════════════════════════════════════════════════════════════

  var stored = readStore();
  current = (SUPPORTED.indexOf(stored) !== -1) ? stored : BASE_LANG;

  // 盡早設定,讓 html[lang="es"] 的 CSS 覆蓋在第一次繪製前就生效。
  document.documentElement.setAttribute('lang', current);

  function whenDomReady() {
    if (document.readyState !== 'loading') return Promise.resolve();
    return new Promise(function (resolve) {
      document.addEventListener('DOMContentLoaded', function () { resolve(); });
    });
  }

  // en 永遠載入(fallback 基準);當前語言非 en 時再載第二支。
  var jobs = [loadDict(BASE_LANG)];
  if (current !== BASE_LANG) jobs.push(loadDict(current));

  // 🔴 永不 reject:載入失敗已在 loadDict 內部吞掉並轉為 fail-open。
  //    PC_I18N_READY 只代表「載入流程已結束」,不代表「載入成功」。
  window.PC_I18N_READY = Promise.all(jobs)
    .then(function () { loaded = true; })
    .then(whenDomReady)
    .then(function () {
      pcApplyI18n(document);
      emitChanged();
      return current;
    })
    .catch(function (e) {
      console.error('[CB-62] i18n init failed — page stays in HTML-authored English',
        String((e && e.message) || e));
      return current;
    });
})();
