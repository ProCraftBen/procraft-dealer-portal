/* ──────────────────────────────────────────────────────────────────────
 * ProCraft Dealer Portal — Date / Time Zone Utilities (F-174, v1.0)
 *
 * 全站日期篩選與顯示的【單一】時區來源。
 * 由 admin-quotes.html 與 admin-reminders.html 共用。
 *
 * ── 為何存在(F-174 Stage 0)──────────────────────────────────────────
 *   created_at 為 timestamptz,DB 存 UTC。顯示層過去用 toLocaleDateString()
 *   走【瀏覽器本地】,篩選層則把使用者輸入的 "YYYY-MM-DD" 直接送給
 *   PostgREST 比對【UTC】—— 兩邊差四(冬季五)小時。美東 20:00 後建立的單,
 *   UTC 已跨日,選 9/8 找不到,要選 9/9 才找得到。
 *   production 實證:D00141/42/43/44 四張,ET 9/8 晚間,UTC 均為 9/9。
 *
 *   🔴 這是【靜默】失敗 —— 篩選少幾筆不會報錯,使用者只會覺得「那天沒單」。
 *
 * ── 為何抽成共用模組(F-35 根因結構)────────────────────────────────
 *   Stage 0 盤點發現 todayLocalISO() 在 order-complete.js 與
 *   admin-reminders.html 各寫一份(逐字相同),prettyDate/formatDateOnly
 *   邏輯複製四份,全樹沒有共用日期工具。知識靠註解在檔案之間傳遞。
 *   不建立單一來源,下一個頁面就會寫第五份。
 *
 * ── 硬規則(不可調換)────────────────────────────────────────────────
 *   ① 【禁止固定位移】。本檔不得出現 -4 / -5 / 3600000 之類的時差常數。
 *      EDT(UTC-4)與 EST(UTC-5)分界不同,寫死冬天必錯。一律以時區
 *      名稱 America/New_York 交給 Intl 解析。
 *
 *   ② 【起訖各自獨立換算】。區間終點必須由「日期 + 1 天」重新換算,
 *      絕不可由起點加固定時長推導。
 *      實證(F-174 S-6):2026-11-01 為【25 小時】,2027-03-14 為 23 小時。
 *      「起點 + 24h」在前者靜默丟掉最後一小時的單,在後者重複計算一小時。
 *
 *   ③ 【區間為半開】[start, end)。過去用 lte(to + 'T23:59:59') 會排除
 *      23:59:59.001–23:59:59.999。created_at 有微秒精度(實見 .135801),
 *      這是真實漏窗,不是理論問題。半開區間讓魔法字串連同問題一起消失。
 *
 * ── 設計前提(勿挪作他用)────────────────────────────────────────────
 *   本模組只換算【當地午夜】。美國 DST 的模糊時刻(重複的 01:00)與
 *   不存在時刻(跳過的 02:00)都不在午夜,因此日界換算不存在歧義,
 *   兩次收斂即足夠。若日後需要換算任意時刻,必須重新設計歧義處理,
 *   不得直接沿用 midnightUTCms()。
 *
 * ── 失敗行為 ───────────────────────────────────────────────────────
 *   輸入非法時回傳 null,【不】回傳猜測值。呼叫端必須明確處理 null ——
 *   靜默略過邊界會讓查詢範圍無聲擴大,那是本票要消滅的失敗模式本身。
 * ────────────────────────────────────────────────────────────────── */

/* ──────────────────────────────────────────────────────────────────────
 * CB-100 增補(2026-09-29)—— 新增 etYMD / shiftYMD 兩個對外函式
 *
 * 🔴 既有六個函式(TZ / etDayStartUTC / etDayEndExclusiveUTC / todayET /
 *    formatETDate / formatETDateTime)【一字未改】。本次為純新增匯出。
 *
 * ── 🔴 ?v= 刻意分歧,以及何時收斂 ────────────────────────────────────
 *   admin-quotes.html      ?v=f174
 *   admin-reminders.html   ?v=f174
 *   dealer-detail.html     ?v=cb100     ← 分歧在此
 *
 *   為何分歧:CB-100 需要本檔的兩個新函式,但 admin-quotes.html 同時在
 *   CB-103 的改動範圍內。兩張票同時動同一個檔案,promote 時的 SHA256
 *   逐檔比對會分不清差異來自哪一票 —— CB-99 正是為了避免這件事才把
 *   admin-quotes 排在後面。
 *   分歧之所以安全:既有六個函式未改,那兩頁用舊版或新版行為完全相同。
 *
 *   ⚠️ 這正是 F-208 的生成方式(i18n.js 現有 5 種 ?v= 散在 13 頁)。
 *      本次是【刻意】且【有收斂計畫】的分歧,不是疏漏。
 *
 *   收斂時機:CB-103 promote 之後。屆時 admin-quotes 不再被佔用,
 *   三頁一次統一到同一個 key。
 *   登記 F-318,與 F-208 交叉引用。
 *
 * ── 🔴 硬規則(不可協商)────────────────────────────────────────────
 *   一旦有人修改上列【六個既有函式中的任何一個】,三頁必須在同一次
 *   promote 中同時 bump 到同一個 ?v=。
 *   分歧【只適用於純新增匯出】—— 因為那種改動對舊呼叫端是無差異的。
 *   改了既有函式卻維持分歧,症狀是「同一個函式在不同頁面行為不同」,
 *   而且不報錯。
 * ────────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  var TZ = 'America/New_York';

  // ── 內部:取得某瞬時在 TZ 的日曆分量 ──────────────────────────────
  var _partsFmt = null;

  function partsInTZ(date) {
    if (!_partsFmt) {
      _partsFmt = new Intl.DateTimeFormat('en-US', {
        timeZone: TZ,
        hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      });
    }
    var out = {};
    var parts = _partsFmt.formatToParts(date);
    for (var i = 0; i < parts.length; i++) out[parts[i].type] = parts[i].value;
    return out;
  }

  /* 該瞬時在 TZ 的位移(毫秒)。
   * 🔴 hour 必須取 % 24 —— 部分引擎在 hour12:false 下把午夜輸出為 "24"
   *    而非 "00"。未正規化會讓日界整整位移一天,且【只在午夜觸發】,
   *    正是本模組唯一會用到的時刻。 */
  function offsetMs(date) {
    var p = partsInTZ(date);
    var hour = Number(p.hour) % 24;
    var wall = Date.UTC(
      Number(p.year), Number(p.month) - 1, Number(p.day),
      hour, Number(p.minute), Number(p.second)
    );
    return wall - Math.floor(date.getTime() / 1000) * 1000;
  }

  /* 給定 TZ 的日曆日,回傳該日 00:00 對應的 UTC 毫秒。
   * 先以位移猜一次,再用結果反查一次位移;若兩次不同(猜測落在
   * 分界另一側),以第二次結果重算。午夜情境下必然收斂。 */
  function midnightUTCms(y, m, d) {
    var guess = Date.UTC(y, m - 1, d, 0, 0, 0);
    var off1 = offsetMs(new Date(guess));
    var cand = guess - off1;
    var off2 = offsetMs(new Date(cand));
    if (off2 !== off1) cand = guess - off2;
    return cand;
  }

  /* "YYYY-MM-DD" → { y, m, d },非法回傳 null。
   * 🔴 正向確認(F-35):不只比對格式,還要求回寫後與輸入完全相同 ——
   *    這才能排除 2026-02-30 這類格式合法但日期不存在的輸入。
   *    用「不符合某某排除清單」的寫法會漏。 */
  var YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

  function parseYMD(ymd) {
    var mt = YMD_RE.exec(String(ymd == null ? '' : ymd));
    if (!mt) return null;
    var y = Number(mt[1]), m = Number(mt[2]), d = Number(mt[3]);
    var probe = new Date(Date.UTC(y, m - 1, d));
    if (probe.getUTCFullYear() !== y) return null;
    if (probe.getUTCMonth() !== m - 1) return null;
    if (probe.getUTCDate() !== d) return null;
    return { y: y, m: m, d: d };
  }

  /* 日曆加減。純 UTC 分量運算,不涉時區,因此不受 DST 影響 ——
   * 這正是「終點獨立換算」得以成立的原因:先在日曆上加一天,
   * 再把新日期交給 midnightUTCms(),而非在時間軸上加 24 小時。 */
  function addDaysYMD(p, n) {
    var t = new Date(Date.UTC(p.y, p.m - 1, p.d + n));
    return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
  }

  // ── 對外:區間邊界 ────────────────────────────────────────────────

  /* "2026-09-08" → "2026-09-08T04:00:00.000Z"(EDT)
   * "2026-11-15" → "2026-11-15T05:00:00.000Z"(EST)
   * 送 PostgREST 的 .gte()。非法輸入回 null。 */
  function etDayStartUTC(ymd) {
    var p = parseYMD(ymd);
    if (!p) return null;
    return new Date(midnightUTCms(p.y, p.m, p.d)).toISOString();
  }

  /* 區間終點,【排他】—— 送 PostgREST 的 .lt(),不是 .lte()。
   * "2026-11-01" → "2026-11-02T05:00:00.000Z"(該日 25 小時)
   * 非法輸入回 null。 */
  function etDayEndExclusiveUTC(ymd) {
    var p = parseYMD(ymd);
    if (!p) return null;
    var next = addDaysYMD(p, 1);
    return new Date(midnightUTCms(next.y, next.m, next.d)).toISOString();
  }

  /* 美東的今天,"YYYY-MM-DD"。
   * ⚠️ 本票(F-174)不使用,備供 F-176 取代 todayLocalISO() 的兩份複本。
   *    刻意不用 new Date().toISOString().split('T')[0] —— 那取的是 UTC
   *    日期,美東 20:00 後 UTC 已跨日,會寫成「明天」。 */
  function todayET() {
    var p = partsInTZ(new Date());
    return p.year + '-' + p.month + '-' + p.day;
  }

  // ── 對外:顯示 ────────────────────────────────────────────────────
  var _dateFmt = null;
  var _dateTimeFmt = null;

  /* timestamptz → "Sep 8, 2026"(美東)。 */
  function formatETDate(ts) {
    if (!ts) return '-';
    var d = new Date(ts);
    if (isNaN(d.getTime())) return '-';
    if (!_dateFmt) {
      _dateFmt = new Intl.DateTimeFormat('en-US', {
        timeZone: TZ, month: 'short', day: 'numeric', year: 'numeric'
      });
    }
    return _dateFmt.format(d);
  }

  /* timestamptz → "Sep 8, 2026, 8:48 PM EDT"(美東)。
   * 🔴 timeZoneName 不可省 —— 基準看得見,使用者才有機會發現不對。
   *    sc-builder(pdf-builder.js)已採同一作法。 */
  function formatETDateTime(ts) {
    if (!ts) return '-';
    var d = new Date(ts);
    if (isNaN(d.getTime())) return '-';
    if (!_dateTimeFmt) {
      _dateTimeFmt = new Intl.DateTimeFormat('en-US', {
        timeZone: TZ,
        month: 'short', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit',
        timeZoneName: 'short'
      });
    }
    return _dateTimeFmt.format(d);
  }

  // ── 對外:日曆運算(CB-100 新增)────────────────────────────────

  /* timestamptz → 該瞬時在美東的日曆日,"YYYY-MM-DD"。非法輸入回 null。
   *
   * 🔴 與 formatETDate() 的分工:後者回 "Sep 8, 2026",是【給人看的】,
   *    不可反解析。本函式回可比較、可運算的 YMD。
   * 🔴 走與 todayET() 【同一段】程式碼(partsInTZ),兩者不可能分岔。
   *    刻意不寫成 new Date(ts).toISOString().slice(0,10) —— 那取的是
   *    UTC 日期,美東 20:00 後已跨日,會回「明天」。 */
  function etYMD(ts) {
    if (!ts) return null;
    var d = new Date(ts);
    if (isNaN(d.getTime())) return null;
    var p = partsInTZ(d);
    return p.year + '-' + p.month + '-' + p.day;
  }

  /* "YYYY-MM-DD" 加減 n 個【日曆天】,回 "YYYY-MM-DD"。非法輸入回 null。
   *
   * 🔴 這是硬規則②(終點獨立換算)的對外入口。
   *    呼叫端【絕不可】自行以「起點 + n × 24h」推導 —— 2026-11-01 是
   *    25 小時、2027-03-14 是 23 小時,那種寫法會靜默算錯。
   * 🔴 本函式不含任何時區邏輯,純粹呼叫既有的 parseYMD 與 addDaysYMD
   *    (addDaysYMD 以 UTC 分量運算,不受 DST 影響)。零重寫。
   * 📌 刻意不直接匯出 addDaysYMD:它的介面是 { y, m, d } 物件,匯出會
   *    洩漏內部形狀,且呼叫端還需要 parseYMD 才能使用。本模組對外一律
   *    以 "YYYY-MM-DD" 字串為介面。 */
  function shiftYMD(ymd, n) {
    var p = parseYMD(ymd);
    if (!p) return null;
    if (typeof n !== 'number' || !isFinite(n)) return null;
    var t = addDaysYMD(p, n);
    return String(t.y).padStart(4, '0') + '-'
         + String(t.m).padStart(2, '0') + '-'
         + String(t.d).padStart(2, '0');
  }

  window.ProCraftDate = {
    TZ: TZ,
    etDayStartUTC: etDayStartUTC,
    etDayEndExclusiveUTC: etDayEndExclusiveUTC,
    todayET: todayET,
    formatETDate: formatETDate,
    formatETDateTime: formatETDateTime,
    // ── CB-100 新增 ──
    etYMD: etYMD,
    shiftYMD: shiftYMD
  };
})();
