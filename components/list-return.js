/* ──────────────────────────────────────────────────────────────────────
 * ProCraft Dealer Portal — List Return Address (CB-103 U1, v1.0)
 *
 * 記錄「使用者上一次在看的清單 URL」與捲動位置,供單張頁的 Back 連結使用。
 * 使用者:admin-quotes.html、admin-payments.html、quotes.html(寫入)
 *         quote-detail.html、admin-payments.html 詳情檢視(讀取)
 *
 * ── 🔴 本檔不是清單狀態的來源(CB-103 Q-1 / S1-Q1 = A)────────────────
 *   清單狀態(篩選 / 排序 / 頁碼)的唯一事實來源是【各清單頁自己的 URL】。
 *   本檔只存「回哪個 URL」—— 它是一張書籤,不是狀態。
 *   PM4 當初排除 sessionStorage,排除的是「把狀態存在 sessionStorage」
 *   (不能分享、不能加書籤);本檔不違反那條。
 *   🔴 請勿在本檔加入任何篩選欄位的解析或驗證:每頁欄位不同,驗證屬於
 *      各清單頁;搬進來會變成「兩處都在驗證同一個 URL」。
 *
 * ── 🔴 fail-open(刻意與 DOC-1 fail-closed 相反)────────────────────────
 *   storage 不可用(無痕、停用、配額滿)或內容損毀時,一律回傳乾淨的清單 URL,
 *   即 CB-103 之前的行為。本檔失效的最壞結果是「回到今天的樣子」,
 *   沒有資料正確性或權限風險,因此不擋、不報錯給使用者,只 console.warn 一次。
 *   🔴 程式錯誤(傳入未知的頁面代號)則【拋出 TypeError】,沿用 CB-98
 *      price-mask「缺席即 TypeError」的先例:寫錯的呼叫端必須在開發時就爆。
 *
 * ── 🔴 本檔不顯示任何提示 ─────────────────────────────────────────────
 *   「URL 含無效值 → 一行提示」(CB-103 S1-Q7)由各清單頁負責。
 *   本檔被剔除的鍵名(見 FORBIDDEN_KEYS)是防護,不是使用者輸入錯誤,不提示。
 *
 * ── 剔除的鍵名 ────────────────────────────────────────────────────────
 *   FORBIDDEN_KEYS 與 CB-103 Stage 0 §0-8 禁用名單相同(CB-85 record_page_view
 *   的 context_id 白名單)。清單頁本來就不會寫這些鍵;在這裡再剔除一次,
 *   是防止回程連結被導向 admin-payments 的詳情路由(?payment_id=)。
 *   ⚠️ §0-8 是這份名單的單一事實來源;白名單日後增減,兩處須同步。
 *
 * ── 呼叫契約 ──────────────────────────────────────────────────────────
 *   var R = window.ProCraftListReturn;
 *   R.PAGES.ADMIN_QUOTES / ADMIN_PAYMENTS / QUOTES   頁面代號(= 檔名去 .html)
 *   R.save(page, search)        清單頁每次回寫自己的 URL 後呼叫
 *   R.saveScroll(page, search)  清單頁 pagehide 時呼叫(讀 window.scrollY)
 *   R.takeScroll(page, search)  清單頁第一次渲染後呼叫;search 相符才回傳 y,
 *                               取用即清除(重新整理不會一直跳回舊位置)
 *   R.href(page)                回傳 'admin-quotes.html?...' 或 'admin-quotes.html'
 *   R.last(allowedPages)        回傳 allowedPages 中最近造訪的那一個,否則 null
 *                               (CB-103 S1-Q2:admin 的 Back 依此決定回哪個清單)
 *
 *   🔴 pagehide 而非 unload / beforeunload:後兩者會讓頁面失去 bfcache 資格。
 * ────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var STORAGE_KEY = 'pcListReturn.v1';
  var MAX_SEARCH_LENGTH = 2000;
  var FORBIDDEN_KEYS = ['draft', 'id', 'quote_id', 'payment_id'];

  var PAGES = Object.freeze({
    ADMIN_QUOTES:   'admin-quotes',
    ADMIN_PAYMENTS: 'admin-payments',
    QUOTES:         'quotes'
  });
  var KNOWN = [PAGES.ADMIN_QUOTES, PAGES.ADMIN_PAYMENTS, PAGES.QUOTES];

  var warned = false;
  function warnOnce(msg, err) {
    if (warned) return;
    warned = true;
    console.warn('[CB-103] list-return: ' + msg + ' — Back links fall back to the plain list.', err || '');
  }

  function assertPage(page) {
    if (KNOWN.indexOf(page) === -1) {
      throw new TypeError('[CB-103] list-return: unknown list page "' + page + '"');
    }
  }

  // 以 URLSearchParams 重新序列化:只會產生 query string,不可能帶出路徑或其他網域。
  function normSearch(search) {
    if (typeof search !== 'string' || search === '' || search === '?') return '';
    var params;
    try {
      params = new URLSearchParams(search.charAt(0) === '?' ? search.slice(1) : search);
    } catch (e) {
      return '';
    }
    FORBIDDEN_KEYS.forEach(function (k) { params.delete(k); });
    var out = params.toString();
    if (out.length > MAX_SEARCH_LENGTH) {
      console.warn('[CB-103] list-return: search longer than ' + MAX_SEARCH_LENGTH + ' chars, not kept');
      return '';
    }
    return out ? '?' + out : '';
  }

  function isObj(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function read() {
    var raw;
    try {
      raw = window.sessionStorage.getItem(STORAGE_KEY);
    } catch (e) {
      warnOnce('sessionStorage unavailable', e);
      return { pages: {}, last: null };
    }
    if (!raw) return { pages: {}, last: null };
    try {
      var data = JSON.parse(raw);
      if (isObj(data) && isObj(data.pages)) {
        return { pages: data.pages, last: KNOWN.indexOf(data.last) !== -1 ? data.last : null };
      }
    } catch (e) { /* 損毀 → 視同空的 */ }
    warnOnce('stored value malformed, reset');
    return { pages: {}, last: null };
  }

  function write(data) {
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      warnOnce('sessionStorage write failed', e);
    }
  }

  function entryOf(data, page) {
    var e = data.pages[page];
    if (!isObj(e)) { e = {}; data.pages[page] = e; }
    return e;
  }

  function save(page, search) {
    assertPage(page);
    var data = read();
    entryOf(data, page).search = normSearch(search);
    data.last = page;
    write(data);
  }

  function saveScroll(page, search) {
    assertPage(page);
    var y = Math.max(0, Math.round(window.scrollY || window.pageYOffset || 0));
    var data = read();
    entryOf(data, page).scroll = { search: normSearch(search), y: y };
    data.last = page;
    write(data);
  }

  function takeScroll(page, search) {
    assertPage(page);
    var data = read();
    var e = data.pages[page];
    if (!isObj(e) || !isObj(e.scroll)) return null;
    var s = e.scroll;
    delete e.scroll;   // 相符與否都清除:條件不同時,舊的捲動位置沒有意義
    write(data);
    if (s.search !== normSearch(search)) return null;
    return (typeof s.y === 'number' && isFinite(s.y) && s.y >= 0) ? s.y : null;
  }

  function href(page) {
    assertPage(page);
    var e = read().pages[page];
    var search = isObj(e) ? normSearch(e.search) : '';
    return page + '.html' + search;
  }

  function last(allowedPages) {
    if (!Array.isArray(allowedPages)) {
      throw new TypeError('[CB-103] list-return: last() expects an array of pages');
    }
    allowedPages.forEach(assertPage);
    var l = read().last;
    return (l && allowedPages.indexOf(l) !== -1) ? l : null;
  }

  window.ProCraftListReturn = Object.freeze({
    PAGES: PAGES,
    save: save,
    saveScroll: saveScroll,
    takeScroll: takeScroll,
    href: href,
    last: last
  });
})();
