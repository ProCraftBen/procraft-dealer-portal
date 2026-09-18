/* ──────────────────────────────────────────────────────────────────────
 * ProCraft Dealer Portal — Account Type Badge (CB-97 U1, v1.0)
 *
 * dealers.account_type 的【顯示名 map 與 badge 渲染】的唯一真相來源。
 * 由 admin-dealers.html 與 admin-quotes.html 共用。
 *
 * ── 為何抽成共用模組(CB-97 Q-5 = A,PM 核准範圍擴張)────────────────
 *   CB-76 在 admin-dealers.html 內建了這份 map。CB-97 要在 admin-quotes.html
 *   顯示同一組 badge —— 若貼第二份副本,就會在【同一張票裡】一邊登記
 *   F-211「EMAIL_SUPPRESSED_ACCOUNT_TYPES 五份副本無同步機制」,一邊製造
 *   新的副本。且 CB-95 L-1 才剛定下「新增共用 helper 的複製前須查份數管制」。
 *   目前這份 map 只有一份 —— 這是抽出的最好時機,變成兩份之後就難了。
 *
 * ── 🔴 CSS 也在本檔內(CB-97 Stage 1 實查修正)────────────────────────
 *   原本判斷「樣式必然變成第二份副本」是錯的。實查:14 支 component 中有
 *   10 支自行注入 <style>(order-complete.js 以 STYLE_ID 常數做重複注入
 *   守衛,且該檔已同時被 quote-detail.html 與 admin-quotes.html 載入)。
 *   沿用同一慣例 → map 與樣式一起是單一真相,兩頁零 markup、零 CSS。
 *
 * ── 🔴 本檔的邊界:只管 badge,【不管】停信 ───────────────────────────
 *   EMAIL_SUPPRESSED_ACCOUNT_TYPES(四支 Edge Function 各一份 + 
 *   admin-dealers.html 一份 = 五份)刻意【不】併入本檔。
 *   兩者都以 account_type 為鍵,但用途無關:
 *     本檔      = 這個類型在畫面上長什麼樣
 *     停信陣列  = 這個類型收不收信
 *   併進來會讓人誤以為 F-211 的五份副本問題已經解決 —— 它沒有。
 *   🔴 請勿為了「account_type 相關的東西放一起」把那個陣列搬進來。
 *   (CB-97 Stage 1 決議互斥檢查 M-4)
 *
 * ── 🔴 正向識別(F-35)—— 沿用 CB-76 原語意,一字未改 ──────────────────
 *   以例外類型查表【命中】才渲染,【不】寫 account_type !== 'dealer'。
 *   負向判斷在值意外為 null / 空字串 / 未來新增第六種類別時,會渲染出一個
 *   沒有樣式與文案的 badge,或反過來把該顯示的漏掉,而且不報錯。
 *   'dealer' 刻意不在表中 → 自然不顯示。
 *   查無對應 → 以 acct-unknown 印出【DB 原值】,壞掉看得見。
 *
 * ── CB-97 新增 'project' ─────────────────────────────────────────────
 *   行為與 location 相同(停所有 email)。配色須與既有四色明確分離:
 *     internal_account #4B5563 灰   location #0F766E 藍綠
 *     trial            #C2410C 橘   unknown  #C0392B 紅
 *   → project 取 #4338CA 靛,與上列皆無相鄰風險。
 *
 * ── 呼叫契約 ──────────────────────────────────────────────────────────
 *   window.ProCraftAccountType.render(accountType)
 *     → 回傳 HTML 字串。badge 在【下方】(margin-top),供 admin-dealers
 *       的 company/contact 之後使用 —— 與 CB-76 原輸出【逐字相同】。
 *
 *   window.ProCraftAccountType.render(accountType, { lead: true })
 *     → badge 在【上方】(margin-bottom),獨立一行。目前無呼叫端,保留備用。
 *
 *   window.ProCraftAccountType.render(accountType, { inline: true })
 *     → 不含外層 <div>,badge 與後續文字【同一行】,供 admin-quotes 的
 *       Dealer 格首使用(CB-97 Q-4 = A,位置細化)。
 *     🔴 選 inline 而非 lead 的理由:非 dealer 類型佔 14%,若每一列都多
 *        一行,是用 100% 的版面高度換 14% 的資訊。inline 只在 badge 存在
 *        時佔用水平空間,不存在時完全不影響版面。
 *     ⚠️ 代價:公司名過長時 badge 會把名字擠到換行,該列反而更高。
 *        那是例外中的例外(14% × 長名),優於現在的一律加高。
 *
 *   🔴 lead 以【額外 class】實作,不改動 .badge-acct 基礎樣式 ——
 *      改基礎樣式會讓 admin-dealers 的既有版面跟著位移,而本票對該檔的
 *      授權範圍是「只抽 map,不重構其他部分」。
 *
 * ── 🔴 資料來源(CB-97 Stage 1 決議互斥檢查 M-1)───────────────────────
 *   admin-quotes.html 呼叫本函式時,account_type 必須取自 allDealers[
 *   q.dealer_id],【永遠不可】取自 q.dealers —— 後者是 Account Type
 *   篩選啟用時才掛上的條件式 embed,未篩選時不存在。
 *   誤用的症狀是「未篩選時 badge 全部消失」,而且不報錯。
 * ────────────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  // 🔴 重複載入守衛。兩頁各自 <script> 掛載,若日後有第三頁同時經由
  //    其他 component 間接載入,重複定義會靜默覆寫。先佔先贏。
  if (window.ProCraftAccountType) return;

  var STYLE_ID = 'pcat-styles';

  // ── 顯示名 map ────────────────────────────────────────────────────
  //   🔴 key 為 DB 的 canonical 值(小寫底線,CB-76 Q-1 = A),
  //      value 為顯示名。兩者可分離 —— DB 值不得為了顯示而改動。
  //   🔴 'dealer' 刻意不在表中(佔全表 87.6%,顯示等於雜訊)。
  //      ⚠️ CB-76 原註解寫「近 100%」;CB-97 實查 production 為 120/137
  //         = 87.6%,例外率 12.4%。結論不變(badge 仍勝過整欄),
  //         但原本的理由已不精確,故一併更正。
  var BADGE = {
    internal_account: 'Internal Account',
    location:         'Location',
    project:          'Project',      // CB-97
    trial:            'Trial'
  };

  // ── 樣式注入 ──────────────────────────────────────────────────────
  //   數值逐字複製自 admin-dealers.html 的既有 .badge-acct 區塊,
  //   未做任何「順手優化」—— U2 移除該頁本地 CSS 後,輸出必須維持不變。
  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = [
      '.badge-acct { display: inline-block; margin-top: 3px; padding: 2px 8px;',
      '  border-radius: 2px; font-size: 10px; font-weight: 500; letter-spacing: 0.04em; }',
      /* 🔴 lead:badge 在上方時把 margin 翻面。只加不改,
            未帶此 class 的既有呼叫端輸出完全不變。 */
      '.badge-acct.acct-lead { margin-top: 0; margin-bottom: 3px; }',
      /* 🔴 inline:同一行使用,清掉 margin-top 並在右側留間隔。
         只加不改,未帶此 class 的既有呼叫端輸出完全不變。 */
      '.badge-acct.acct-inline { margin: 0 6px 0 0; }',
      '.badge-acct.acct-internal_account { background: rgba(107,114,128,0.12); color: #4B5563; }',
      /* Location 用藍綠(#0F766E,沿用 send-followup-email 的 BRAND.completed),
         與 trial 的橘色明確分開 —— 兩者原本都是暖色,並排時難以分辨。
         語意:Location = 資訊性/內部工具;Trial = 暫時性/需注意。 */
      '.badge-acct.acct-location         { background: rgba(15,118,110,0.12);  color: #0F766E; }',
      /* CB-97:Project 行為同 Location(停所有 email),但【配色刻意不同】——
         兩者是不同的帳號類別,顏色相同會讓人以為是同一種,
         而 badge 存在的全部理由就是讓人一眼分辨。 */
      '.badge-acct.acct-project          { background: rgba(67,56,202,0.12);   color: #4338CA; }',
      '.badge-acct.acct-trial            { background: rgba(224,123,57,0.14);  color: #C2410C; }',
      '.badge-acct.acct-unknown          { background: rgba(192,57,43,0.12);   color: #C0392B; }'
    ].join('\n');
    document.head.appendChild(el);
  }

  // ── 渲染 ──────────────────────────────────────────────────────────
  function render(accountType, opts) {
    ensureStyles();

    // 'dealer' → 不顯示。這是唯一以相等比對提前退出的情況,
    // 與下方的查表【不衝突】:它排除的是「正常」,查表命中的是「例外」。
    if (accountType === 'dealer') return '';

    var inline = !!(opts && opts.inline);
    var lead   = !!(opts && opts.lead);
    // 🔴 inline 優先:兩者同時給時 lead 的上下 margin 沒有意義(同一行內
    //    沒有上下)。不報錯、不拋例外 —— 這是呼叫端的筆誤,不是資料問題,
    //    而讓 badge 消失或整頁壞掉都比靜默忽略更糟。
    var extra  = inline ? ' acct-inline' : (lead ? ' acct-lead' : '');
    var open   = inline ? '' : '<div>';
    var close  = inline ? '' : '</div>';

    var label = BADGE[accountType];
    if (label) {
      return open + '<span class="badge-acct acct-' + accountType + extra + '">'
           + label + '</span>' + close;
    }

    // 未知值(含 null / '')—— 不靜默略過,印出來讓人看到資料有問題。
    // 🔴 剝除法沿用 CB-76 原碼,未改為 escapeHtml:
    //    本函式不依賴任何外部 helper(escapeHtml 受份數管制,CB-95 L-1),
    //    且此路徑的值域受 dealers_account_type_check 約束,不是自由文字。
    var raw = (accountType === null || accountType === undefined || accountType === '')
      ? '(none)' : String(accountType);
    return open + '<span class="badge-acct acct-unknown' + extra + '">&#9888; '
         + raw.replace(/[<>&"]/g, '') + '</span>' + close;
  }

  window.ProCraftAccountType = {
    BADGE:        BADGE,
    render:       render,
    ensureStyles: ensureStyles
  };
})();
