/* ──────────────────────────────────────────────────────────────────────
 * ProCraft Dealer Portal — Price Mask (CB-98 U1, v1.0)
 *
 * trial 帳號的【金額顯示遮罩】的唯一真相來源。
 * 由 new-quote / step2 / modifications / step3 / quote-detail / quotes /
 * payment 七頁,以及 mf01~mf05 五支 modification 元件共用。
 *
 * ── 業務背景(不可壓縮)────────────────────────────────────────────────
 *   trial 帳號讓潛在客戶試用 portal,而那些人【尚未簽約】。
 *   業主 2026-09-14:「顯示 —,我不漏原價。因為他還沒有跟我們簽合約,
 *   如果我直接露底價,就會提供機會讓他們有機會去比價。」
 *   📌 這是商業判斷,不是技術偏好。「技術上更簡單」不構成推翻理由。
 *
 *   為何是 '—' 而非 '$0.00':沿用 CB-75 Q-2 先例(asm_fee = 0 顯示 '—')。
 *   '$0' 是一個具體數字,會讓潛在客戶以為免費或系統壞掉;'—' 表達的是
 *   「不顯示」。
 *
 *   已知並接受的代價:本檔是【顯示層】方案,計算照跑,值仍在前端記憶體,
 *   F12 看得到。業主已知悉並接受 —— 潛在客戶要懂得開 DevTools 才看得到,
 *   已不是「不小心看到」的層級。
 *   (B 案「不計算」排除理由:改動大,且可能踩到 CB-70 的 CHECK
 *    subtotal + 三個調整項 >= 0)
 *
 * ── 🔴 受份數管制的共用 helper(CB-95 L-1 / CB-98 M-3)─────────────────
 *   本檔明文登記為【受份數管制】的共用 helper。
 *   🔴 禁止複製本檔的任何函式到頁面內。需要新的呼叫端時,載入本檔。
 *   已知的同族管制清單(複製前先查這張表):
 *     round2()                        金額運算,toPrecision(15) 實作
 *     escapeHtml()                    HTML 逸出
 *     formatModValue()                modification 值格式化
 *     EMAIL_SUPPRESSED_ACCOUNT_TYPES  停信類型(F-211,現有五份副本)
 *     CB-36 規則
 *     ProCraftPriceMask               ← 本檔
 *   ⚠️ 反例就在眼前:F-221 登記的 fmt() 已是 4 份逐字副本 + 3 個變體 +
 *      約 50 處 inline,是第六個同族問題。本檔不要變成第七個。
 *
 * ── 🔴 本檔的邊界:【不】併入 components/account-type.js(M-4)──────────
 *   account-type.js 檔頭明文界定「只管 badge」(CB-97 M-4),並明確拒收
 *   EMAIL_SUPPRESSED_ACCOUNT_TYPES。本檔同理【不】併入該檔。
 *   三者都以 account_type 為鍵,但用途無關:
 *     account-type.js = 這個類型在畫面上長什麼樣
 *     停信陣列        = 這個類型收不收信
 *     本檔            = 這個類型看不看得到金額
 *   併進去會讓人誤以為 account_type 邏輯已經收斂 —— 它沒有,F-211 的五份
 *   副本問題仍然存在。
 *   🔴 請勿為了「account_type 相關的東西放一起」把本檔搬進去。
 *
 * ── 🔴 判斷對象是 viewer(登入者),不是單主(CB-98 Q-1 = A)─────────────
 *   遮罩依【誰在看】決定,不依【這張單屬於誰】。
 *   ⚠️ 絕對不可改用 new-quote-step3.html 的 isTrialDealer() —— 那支函式
 *      回答的是另一個問題(單主是不是 trial)。admin 編輯 trial 的單時,
 *      單主是 trial 但 viewer 是 admin,金額【必須正常顯示】。
 *      (F-188:「有現成先例」不等於「那個先例有效」。本票已踩過一次。)
 *   S-4 實查:staging 與 production 兩環境皆無 admin x trial 交集,
 *   Q-1 選 A 的前提成立。
 *
 * ── 🔴 fail-closed(CB-98 Q-2 = B)───────────────────────────────────
 *   讀不到 viewer 身分 → 隱藏。
 *   本票是純顯示層,【無 DB 兜底】—— fail-open 的意義就是「讀不到就露價」。
 *
 *   🔴 同一檔(new-quote-step3.html)內會同時存在兩套相反的失敗策略,
 *      那是【設計,不是遺漏】(CB-98 M-2):
 *        CB-76 isTrialDealer()  fail-open  ← 有 DB trigger 兜底
 *        本檔   isHidden()       fail-closed ← 無任何兜底
 *      ⚠️ 禁止「順手對齊」成同一種(F-66 §8)。看到不一致請先讀這段。
 *
 * ── 🔴 F-35 正向識別 ─────────────────────────────────────────────────
 *   兩條讓 _hidden 成立的路徑【都是正向確認】:
 *     ① 確認「無法確認 viewer 身分」
 *     ② 確認「account_type 等於 trial」
 *   全程不寫 account_type !== 'dealer'。
 *   意義:未來新增第六種 account_type 時,它會落入【顯示】而不是自動落入
 *   隱藏 —— 新類型該不該遮,是一個要有人決定的問題,不該由否定式默默代答。
 *
 * ── 🔴 零額外查詢 ────────────────────────────────────────────────────
 *   本檔【不】自行查 DB。由各頁在【既有的】viewer select 清單加上
 *   account_type 後,把整列餵進 setViewer()。
 *   某頁漏加 → typeof undefined 命中 → 該頁【全體 dealer】看到 '—'。
 *   🔴 這是刻意的可見失敗:症狀明顯、可逆、當場被抓到,
 *      優於靜默露價(症狀是沒有症狀)。
 *
 * ── 🔴 不做模組缺席防護(CB-98 Q-11 = A)──────────────────────────────
 *   呼叫端【不】寫 if (window.ProCraftPriceMask) —— 本檔缺席時就讓它拋
 *   TypeError,頁面當場壞掉。
 *   加了防護的效果正是「promote 漏檔 → 靜默露價」。代價不對稱:
 *     不防護  失敗 → 頁面壞掉 → 當場被 Stage 3 抓到
 *     有防護  失敗 → 頁面正常 → 價格露出去 → 沒人知道
 *   CB-96 已做過同一選擇(「載到舊版 builder 時拒絕產出」)。
 *
 *   🔴 因此 promote 順序不可顛倒(M-13):
 *        ① components/price-mask.js   先
 *        ② 其餘七頁 + mf01~mf05        後
 *      ⚠️ 回滾方向相反:先回滾頁面,再回滾 component。
 *      📌 與 F-174 的 date-utils.js 同型:
 *         工具存在但無人使用 = 無害;頁面存在但工具缺席 = 頁面壞掉。
 *
 * ── 🔴 本檔受 ?v= 版本管理(F-168)───────────────────────────────────
 *   首次上線即帶 ?v=cb98:
 *     <script src="components/price-mask.js?v=cb98"></script>
 *   🔴 日後任何改動都必須同步 bump 全部呼叫端的 ?v=。
 *   理由:pdf-builder.js 無 ?v=,導致 promote 漏推與瀏覽器快取分不出來
 *   (F-168)。本檔是硬依賴,分不出來的代價更高。
 *
 *   🔴 <script> 位置:必須在 mf01~mf05 【之前】。
 *      那五支元件在自己的 IIFE 內取用 window.ProCraftPriceMask。
 *
 * ── 對外契約 ──────────────────────────────────────────────────────────
 *   window.ProCraftPriceMask.setViewer(meRow)
 *     各頁在【既有的】viewer 查詢回傳後立即呼叫。同步,無回傳。
 *
 *   window.ProCraftPriceMask.isHidden()   → boolean
 *     供 PDF 守衛與條件渲染使用(例如 free_over_12k 整行不渲染)。
 *
 *   window.ProCraftPriceMask.mask(str)    → string
 *     隱藏時回 '—',否則原字串原樣回傳。絕大多數呼叫端用這支。
 *     用法:在字串【組好之後】包一層,不碰 toFixed 本身。
 *
 *   window.ProCraftPriceMask.maskKey(hiddenKey, hiddenFallback, normalStr, params)
 *     整句須換文案的場合。隱藏時回 i18n 取字結果,否則回 normalStr。
 *     ⚠️ params 為【可選第四參數】,供隱藏文案自身需要代入時使用
 *        (例:nqm.toast.configured 的隱藏版仍要報 {sku})。
 *        核准契約為三參數;第四參數純新增,三參數呼叫行為完全不變。
 *
 * ── 🔴 mask() 與 maskKey() 的分工(M-9)───────────────────────────────
 *   mask() 在【金額被 i18n 模板包住】時不適用:
 *     'An assembly fee of ${fee} per unit will apply.'
 *   把 {fee} 換成 '—' 會產出 "$—" —— '$' 留在模板裡,遮了等於沒遮。
 *   這類位置一律走 maskKey() 整句換文案。
 *   🔴 已知走 maskKey() 的位置(請勿誤以為是漏改):
 *     new-quote-modifications.html  原生 confirm()  組裝費提示
 *     new-quote-modifications.html  toast           nqm.toast.configured
 *     new-quote.html                配送距離下拉四個 option
 *     new-quote.html                nq1.distance.previous
 *   (step3 的 nq3.ship.free_over_12k 兩者皆不用 —— 以 isHidden() 判斷後
 *    【整行不渲染】。理由見 Q-10:免運門檻與 FREE 標籤同性質,只遮一邊會
 *    出現「看不到門檻、卻看得到已達標」的矛盾畫面。)
 *
 * ── 🔴 絕對不可包裝的位置 ────────────────────────────────────────────
 *   以下 toFixed(2) 的產物【直接寫入 DB】,不是顯示。包裝會寫壞儲存值:
 *     new-quote-step3.html  4168-4187   saveDraft payload
 *     new-quote-step3.html  4483-4493   resubmit payload
 *     quote-detail.html     3658-3659   buildQuoteDataForPdf
 *   (行號為 commit c970c95c;實查判準是「該 toFixed 的結果是否被指派給
 *    payload 物件的欄位」,不是行號本身。)
 *
 * ── 🔴 i18n 相依 ─────────────────────────────────────────────────────
 *   實查:pcTxt() 在本 repo 有 16 份,【全部是各檔案的區域函式】,不是全域。
 *   本檔自成 IIFE,看不到其中任何一份 → maskKey() 直接呼叫 i18n.js 真正
 *   匯出的 window.pcT,並內含與各頁 pcTxt 逐字相同的 fallback 邏輯。
 *   沿用 account-type.js 檔頭「本檔不依賴任何外部 helper」的先例。
 *   (pcTxt 的 16 份副本問題 → 已登記 F-225,本票不修。)
 * ────────────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  // 🔴 重複載入守衛。七頁各自 <script> 掛載;日後若有第八頁經由其他
  //    component 間接載入,重複定義會【靜默覆寫】已設定好的 viewer 狀態,
  //    把 _resolved 打回 false。先佔先贏。
  if (window.ProCraftPriceMask) return;

  // ── 隱藏時顯示的字元 ──────────────────────────────────────────────
  //   🔴 全形破折號 U+2014,與 CB-75 Q-2 的 asm_fee = 0 顯示【逐字相同】。
  //      若改成 '-' 或 '--',trial 的畫面會與既有的「無此項」視覺不一致,
  //      使用者會以為是兩種不同狀態。
  var HIDDEN_STR = '—';

  // ── 狀態 ──────────────────────────────────────────────────────────
  //   🔴 載入初值即 fail-closed:_resolved = false 時 _hidden 必須為 true。
  //      理由:setViewer() 之前若有任何渲染搶先跑,預設值就是唯一防線。
  //      把初值寫成 false 會讓「查詢還沒回來就先畫一次」直接露價。
  var _resolved = false;
  var _hidden   = true;

  /**
   * 由各頁在既有 viewer 查詢回傳後立即呼叫。
   *
   * @param {object|null|undefined} meRow  dealers 表的 viewer 列。
   *        必須含 account_type 欄 —— 各頁需在【既有的】select 清單加上它,
   *        本檔不自行查 DB。
   */
  function setViewer(meRow) {
    _resolved = true;

    // ① 正向確認「無法確認 viewer 身分」→ 隱藏。
    //    涵蓋兩種情形,兩種都是 Q-2 fail-closed 的範圍:
    //      · meRow 為 null / undefined   → 查詢出錯或回傳空值
    //      · account_type 屬性不存在      → 該頁 select 漏加欄位
    //
    //    🔴 CB-98 Q-13 待拍板:DB 該欄為 NULL 時,typeof 為 'object' 不是
    //       'undefined',會落到下方 ② 的相等比對 → false → 【顯示】。
    //       本版完全照 Stage 1 核准內容實作,未擴大判斷 ——
    //       擴大屬「改變失敗策略」,是四類例外之一。
    //       若 Q-13 裁定擴大,改法為下一行加上 || meRow.account_type == null
    //       (寬鬆相等,同時涵蓋 null 與 undefined)。
    if (!meRow || typeof meRow.account_type === 'undefined') {
      _hidden = true;
      return;
    }

    // ② 正向確認「等於 trial」→ 隱藏;其餘一律顯示。
    //    🔴 不寫 !== 'dealer'。未來第六種 account_type 會落入【顯示】,
    //       而不是被否定式默默遮掉。見檔頭 F-35 段。
    _hidden = (meRow.account_type === 'trial');
  }

  /**
   * 目前是否應遮蔽金額。
   * 🔴 setViewer() 尚未被呼叫時回傳 true(fail-closed)。
   * @returns {boolean}
   */
  function isHidden() {
    return _hidden;
  }

  /**
   * 絕大多數呼叫端使用。隱藏時回 '—',否則原字串原樣回傳。
   *
   * 🔴 用法是在字串【組好之後】包一層,不碰 toFixed 本身:
   *      PriceMask.mask('$' + total.toFixed(2))          ✅
   *      '$' + PriceMask.mask(total.toFixed(2))          ❌ 產出 "$—"
   *
   * @param {string} str
   * @returns {string}
   */
  function mask(str) {
    return _hidden ? HIDDEN_STR : str;
  }

  /**
   * 整句須換文案的場合(金額被 i18n 模板包住,mask() 不適用)。
   *
   * @param {string} hiddenKey       隱藏時使用的 i18n key
   * @param {string} hiddenFallback  該 key 的英文 fallback
   * @param {string} normalStr       未隱藏時原樣回傳的字串(呼叫端自行組好)
   * @param {object} [params]        可選。隱藏文案自身的代入參數,例 { sku: 'B12' }
   * @returns {string}
   */
  function maskKey(hiddenKey, hiddenFallback, normalStr, params) {
    if (!_hidden) return normalStr;
    return txt(hiddenKey, hiddenFallback, params);
  }

  // ── 內部:i18n 取字 ───────────────────────────────────────────────
  //   與各頁 pcTxt() 的實作【逐字相同】,包含「參數代入一律用函式形式的
  //   replace,避免 $& / $' 被當成特殊樣式」這一點。
  //   🔴 那個 $ 陷阱在本檔特別致命:本檔處理的就是金額字串。
  //   i18n.js 未載入或字典未就緒時回傳英文 fallback。
  function txt(key, fallback, params) {
    if (typeof window.pcT === 'function') {
      var s = window.pcT(key, params || null, fallback);
      if (s) return s;
    }
    return String(fallback).replace(/\{(\w+)\}/g, function (whole, name) {
      return (params && params[name] != null) ? String(params[name]) : whole;
    });
  }

  window.ProCraftPriceMask = {
    HIDDEN_STR: HIDDEN_STR,
    setViewer:  setViewer,
    isHidden:   isHidden,
    mask:       mask,
    maskKey:    maskKey
  };
})();
