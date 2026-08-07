/* ──────────────────────────────────────────────────────────────────────
 * ProCraft Dealer Portal — Login i18n Bridge (CB-62 Stage A, v cb62)
 *
 * 只給 login.html 用。其他頁面【不要】載入本檔。
 *
 * ═══ 這支存在的理由 ═══════════════════════════════════════════════════
 * login.html 的 inline <script>(L315-718)裝著 auth、密碼重設、CB-53
 * redirect、CB-42 reCAPTCHA 的全部邏輯。那一段是【凍結】的 —— 每次交付
 * 都以 sha256 佐證 byte-identical(比照 F-20 做法)。
 *
 * 但有 11 條使用者看得到的訊息就寫死在那段凍結區裡面。與其去改它,本檔
 * 改成【在文字被寫進 DOM 之後才攔下來換掉】:對三個顯示節點掛
 * MutationObserver,比對英文原文 → 換成當前語言。
 *
 * 這是 CB-62 Stage 0 的 Q-1,PM 拍板採 B 案。選它而不是直接改 auth script,
 * 是為了讓那個凍結是【真的】凍結,不是「只改字串應該沒差」的自我豁免。
 *
 * 可行的前提在 Stage 1 驗證過:那段程式碼裡【每一條】使用者可見文字
 * 都是走 textContent 寫入的,全段無 innerHTML、無其他路徑。共 5 個寫入點。
 * ═══════════════════════════════════════════════════════════════════════
 *
 * 【監看的三個節點】
 *   #errorMsg  ← showError()
 *   #infoMsg   ← showInfo()
 *   #loginBtn  ← setBusy() 以及兩處直接指派
 *
 * 【🔴 逐字耦合|改 login.html 訊息的人請讀這段】
 * 下方 MAP 對照的是【英文原文的完整字面】。若你改了 login.html 裡那些
 * 訊息的英文,【必須在同一次改動裡同步更新 MAP,並更新 DOC-1 §7 的表】。
 *
 * 沒更新會怎樣:Bridge 認不出那條字串 →【不覆寫】→ 使用者看到英文。
 * 不會當機、不會破版(fail-safe 是刻意設計的),但西語使用者會靜默失去
 * 那條訊息。唯一的訊號是 console 那行 warn。
 *
 * 比對是【逐字且嚴格】的。多一個空格、刪節號換成 …、email 寫成 e-mail,
 * 全都算不命中。
 *
 * 【凍結若解除】
 *   本檔就不需要了。把那 11 條字面直接改成 pcT() 呼叫,然後刪掉本檔。
 *   但在 byte-identical 要求還在的期間,不要這樣做。
 *
 * 【載入位置|必須在 auth script 之後】
 *   <script src="components/login-i18n-bridge.js?v=cb62"></script>
 *   放在 login.html 那段 inline </script> 的【後面】。
 *   auth script 載入當下只註冊事件與非同步 session 檢查,任何訊息寫入都
 *   發生在本檔就位之後,所以順序是安全的。
 *
 * 【lang = en 時完全 no-op】
 *   英文模式下翻譯結果等於原字面,本檔一個字都不會寫。英文使用者零風險。
 * ────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  if (window.__pcdLoginI18nBridgeLoaded) return;
  window.__pcdLoginI18nBridgeLoaded = true;

  // ═══════════════════════════════════════════════════════════════════
  // 🔴 反查表 —— 英文原文 → i18n key
  // -------------------------------------------------------------------
  // 行號對應 login.html @ sha256
  //   0e3fded73e430c83f89149381586ceff6d72f13ade1f43a4efd6b8ecd2c4570a
  // 動到這張表就要同步更新 i18n/README.md(DOC-1)§7。
  // ═══════════════════════════════════════════════════════════════════

  var MAP = {
    // ── 按鈕忙碌狀態 ──
    'Verifying...':   'login.busy.verifying',    // L621, L694
    'Signing in...':  'login.busy.signing_in',   // L631
    'Sending...':     'login.busy.sending',      // L703
    'Sign In':        'login.btn.sign_in',       // L544, L658, L715(setBusy 還原值)

    // ── 錯誤訊息 ──
    'Please enter your email and password.':
      'login.err.missing_credentials',                                            // L616
    'Verification failed. Please refresh the page and try again.':
      'login.err.verification_failed',                                            // L627, L699
    'Invalid email or password. Please try again.':
      'login.err.invalid_credentials',                                            // L636
    'Your account has been deactivated. Please contact ProCraft DC.':
      'login.err.account_deactivated',                                            // L648
    'Something went wrong. Please try again.':
      'login.err.unexpected',                                                     // L656, L713
    'Please enter your email address first.':
      'login.err.email_required',                                                 // L689

    // ── 提示訊息 ──
    'If this email is registered, a reset link has been sent. Please check your inbox.':
      'login.info.reset_sent'                                                     // L709
  };

  var NODE_IDS = ['errorMsg', 'infoMsg', 'loginBtn'];

  var nodes    = [];
  var warned   = {};   // 同一條未知字面只警告一次,避免洗版

  function has(o, k) {
    return !!o && Object.prototype.hasOwnProperty.call(o, k);
  }

  // ═══════════════════════════════════════════════════════════════════
  // 寫入
  // ═══════════════════════════════════════════════════════════════════

  // el.__pcBridgeKey  記住這個節點目前顯示的是哪個 key(語言切換時要重繪)
  // el.__pcBridgeWrote 記住本檔最後寫進去的字串(防止自己觸發自己)

  function render(el, key) {
    // pcT 查無時回 null。保險起見再擋一次 —— 絕不寫入 null、絕不清空。
    var out = window.pcT(key);
    if (out === null || out === undefined) return;
    if (el.textContent === out) return;

    el.__pcBridgeWrote = out;
    el.textContent = out;
  }

  function handle(el) {
    var text = el.textContent;
    if (!text) return;                        // clearMessages() 只移除 class,不會清空,但仍防一手

    // (1) 這是本檔自己剛寫進去的 → 忽略,否則會自我觸發並誤報未知字面
    if (el.__pcBridgeWrote === text) return;

    // (2) 這是 i18n.js 水合 data-i18n 寫進去的 → 記下 key 就好,不重複處理。
    //     #loginBtn 帶 data-i18n="login.btn.sign_in",初次水合會走到這裡。
    var declared = el.getAttribute('data-i18n');
    if (declared && text === window.pcT(declared)) {
      el.__pcBridgeKey = declared;
      return;
    }

    // (3) 反查表
    if (!has(MAP, text)) {
      if (!warned[text]) {
        warned[text] = true;
        console.warn(
          '[CB-62] login-i18n-bridge: unmapped string, left in English. ' +
          'If this text was edited in login.html, update MAP in this file and DOC-1 §7. → ' +
          JSON.stringify(text)
        );
      }
      return;                                 // 🔴 認不出就不覆寫(fail-safe)
    }

    var key = MAP[text];
    el.__pcBridgeKey = key;
    render(el, key);
  }

  // ═══════════════════════════════════════════════════════════════════
  // 啟動
  // ═══════════════════════════════════════════════════════════════════

  function init() {
    if (typeof window.pcT !== 'function') {
      console.error('[CB-62] login-i18n-bridge: components/i18n.js must be loaded first — bridge inactive.');
      return;
    }

    for (var i = 0; i < NODE_IDS.length; i++) {
      var el = document.getElementById(NODE_IDS[i]);
      if (el) nodes.push(el);
    }
    if (!nodes.length) return;                // fail-silent:不是 login 頁

    var observer = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        // characterData 的 target 是 text node,要往上取回元素
        var t = records[i].target;
        var el = (t.nodeType === 3) ? t.parentNode : t;
        if (el && nodes.indexOf(el) !== -1) handle(el);
      }
    });

    for (var j = 0; j < nodes.length; j++) {
      observer.observe(nodes[j], {
        childList:     true,   // textContent 寫進空元素 → 新增 text node
        characterData: true,   // textContent 覆寫既有 text node
        subtree:       true
      });
      // 開始監看前先處理一次現況(例如 setBusy 已經跑過)
      handle(nodes[j]);
    }

    // 語言切換:i18n.js 會先水合 data-i18n,再發出本事件。因此本檔在這裡
    // 重繪,會蓋回節點【當下真正該顯示的那條訊息】——
    // 例如按鈕正顯示「Verificando...」時切語言,不會被 hydrate 重置成 Sign In。
    document.addEventListener('pc:i18n-changed', function () {
      for (var k = 0; k < nodes.length; k++) {
        if (nodes[k].__pcBridgeKey) render(nodes[k], nodes[k].__pcBridgeKey);
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
