-- ════════════════════════════════════════════════════════════════════════
-- CB-60a  Stage 4  DB 物件 —— PRODUCTION
--
-- 環境: PRODUCTION
-- 日期: 2026-09-03
--
-- 內容:staging 的 T-1 / 2-1 / 2-2 三個單元合併為一支。
--   1. public.status_rank(public.quotes)   computed column(非 SECDEF)
--   2. public.get_quote_stats()            統計 RPC(SECURITY DEFINER)
--
-- 🔴 合併為單一檔案是刻意的:production 目前【一個都沒有】,三者是同一個
--    邏輯單元,而前端在 promote 後會同時需要兩者。分三次執行會出現
--    「函式 A 有、函式 B 沒有」的中間狀態 —— 那個狀態下前端整頁載不出來。
--    staging 之所以分三次,是因為 status_rank 當時是【待實測】的候選方案。
--    實測已通過(2026-09-03),production 不需要重走那個過程。
--
-- 🔴 執行順序:本檔【必須先於】admin-quotes.html 的 promote。
--    前端會呼叫 get_quote_stats() 並以 status_rank 排序;DB 沒有這兩者時,
--    PostgREST 對未知排序欄位回 42703,清單完全載不出來。
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

SELECT _ops.assert_env('production');

-- ══ 0. 前置檢查 ════════════════════════════════════════════════════════
-- 🔴 正向識別(F-35):逐項確認前提,而不是「有問題再說」。
DO $cb60a_p_pre$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'quotes'
  ) THEN
    RAISE EXCEPTION 'CB-60a 前置失敗:public.quotes 不存在。';
  END IF;

  -- computed column 與同名實體欄位並存時行為未定義,且不報錯。
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'quotes'
      AND column_name = 'status_rank'
  ) THEN
    RAISE EXCEPTION 'CB-60a 前置失敗:quotes 已有實體欄位 status_rank。';
  END IF;

  -- 授權判斷選錯重載對象不會報錯。
  IF (
    SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'is_admin'
  ) <> 1 THEN
    RAISE EXCEPTION 'CB-60a 前置失敗:public.is_admin 的數量不為 1。';
  END IF;
END
$cb60a_p_pre$;

-- ══ 1. status_rank ═════════════════════════════════════════════════════
-- 🔴 刻意【非】SECURITY DEFINER、刻意【不設】search_path:
--    只把 text 映射成 int,不讀資料表、不做授權判斷,沒有提權需求。
--    且 SET search_path 會阻止 SQL 函式 inline,而 inline 與否是
--    「PostgREST 能否用它排序」的可能變因 —— staging 實測時即以此形狀通過。
CREATE OR REPLACE FUNCTION public.status_rank(public.quotes)
RETURNS int
LANGUAGE sql
IMMUTABLE
AS $fn_rank$
  SELECT CASE $1.status
           WHEN 'Draft'              THEN 1
           WHEN 'Returned'           THEN 2
           WHEN 'Stock Review'       THEN 3
           WHEN 'Pending'            THEN 4
           WHEN 'Payment Processing' THEN 5
           WHEN 'Order Processing'   THEN 6
           WHEN 'Order Completed'    THEN 7
           WHEN 'Closed'             THEN 8
           WHEN 'Cancelled'          THEN 9
           ELSE 99
         END
$fn_rank$;

REVOKE ALL ON FUNCTION public.status_rank(public.quotes) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.status_rank(public.quotes) TO authenticated;

COMMENT ON FUNCTION public.status_rank(public.quotes) IS
'CB-60a PostgREST computed column —— 供 admin-quotes.html 依【流程順序】
排序報價清單。2026-09-03 於 staging 實測通過後 promote。

🔴 (S-1) 使用本欄位排序時,【永遠】必須在後面接 id 作為 tiebreaker:
     .order(''status_rank'').order(''id'')
   單獨用 status_rank 排序再配 .range() 分頁,會【跳號且重複】。
   staging 實測(90 筆、每頁 25 筆):第 1、2 頁之間有 4 張報價單各出現兩次,
   另有 4 張從頭到尾不會出現。
   ⚠️ 當時 HTTP 回應是 200、error 為 null、每頁剛好 25 筆 —— 畫面完全正常。
      此失效【不報錯】,只能靠翻頁收集 id 後比對聯集與交集才看得出來。
   📌 這不是 status_rank 的缺陷,是「非唯一排序鍵 + 分頁」的必然結果。

📌 (S-2) 已實測通過的行為(2026-09-03,staging):
     未知排序欄位回 42703(故「沒報錯」在此環境是有意義的訊號)、
     可 .order()、可與 .range() 併用、可與 id 組成多欄排序;
     四頁全掃、升冪與降冪雙向,90 筆全部唯一、無重複、無遺漏。
   ⚠️ 結論綁定當時的 PostgREST 版本。升級後若排序異常,重跑同一組探測,
      不要以「之前可以」推論。

🔴 (S-3) 刻意非 SECURITY DEFINER、刻意不設 search_path(理由見 migration 檔頭)。
   因此【不在】DOC-1 §9 的 SECURITY DEFINER 清單內 —— 這是設計不是遺漏。

📌 (S-4) 排序值來源:admin-quotes.html 的 filterStatus 選項順序。
   一律使用 DB canonical value,非顯示名 ——
   Returned 顯示為 Revising、Pending 顯示為 Waiting for Payment。(顯示 ≠ 值)

📌 (S-5) ELSE 99 涵蓋 NULL 與未列舉值,故本函式【永不回傳 NULL】,
   排序不受 PostgREST 的 nullsfirst / nullslast 預設影響。
   新增的第 10 種 status 會整群落在最末 —— 看得見的異常,而非靜默混入。
   ⚠️ 新增 status 時必須同步更新本函式,否則新狀態全部並列 rank 99。';

-- ══ 2. get_quote_stats ═════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.get_quote_stats()
RETURNS TABLE (
  total_count               bigint,
  draft_count               bigint,
  returned_count            bigint,
  stock_review_count        bigint,
  pending_count             bigint,
  payment_processing_count  bigint,
  order_processing_count    bigint,
  order_completed_count     bigint,
  closed_count              bigint,
  cancelled_count           bigint,
  null_status_count         bigint,
  other_status_count        bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn_stats$
BEGIN

  -- 🔴 這一段是本函式存在的【全部理由】。非 admin 拿到 42501,而不是一組 0。
  --    直接對 quotes 下 count:'exact' 時,policy 擋住會回 200 / count 0 /
  --    error null —— 與「真的一張單都沒有」在應用層【無法區分】。
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'CB-60a: authentication required for get_quote_stats().'
      USING ERRCODE = '42501';
  END IF;

  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'CB-60a: admin privilege required for get_quote_stats().'
      USING ERRCODE = '42501';
  END IF;

  -- 🔴 單次掃描,九個 FILTER 共用同一份 snapshot。
  --    九支獨立查詢會各自看到不同時點的資料,加總對不上而不報錯。
  RETURN QUERY
  SELECT
    count(*)                                                AS total_count,
    count(*) FILTER (WHERE q.status = 'Draft')              AS draft_count,
    count(*) FILTER (WHERE q.status = 'Returned')           AS returned_count,
    count(*) FILTER (WHERE q.status = 'Stock Review')       AS stock_review_count,
    count(*) FILTER (WHERE q.status = 'Pending')            AS pending_count,
    count(*) FILTER (WHERE q.status = 'Payment Processing') AS payment_processing_count,
    count(*) FILTER (WHERE q.status = 'Order Processing')   AS order_processing_count,
    count(*) FILTER (WHERE q.status = 'Order Completed')    AS order_completed_count,
    count(*) FILTER (WHERE q.status = 'Closed')             AS closed_count,
    count(*) FILTER (WHERE q.status = 'Cancelled')          AS cancelled_count,
    count(*) FILTER (WHERE q.status IS NULL)                AS null_status_count,
    count(*) FILTER (
      WHERE q.status IS NOT NULL
        AND q.status NOT IN ('Draft', 'Returned', 'Stock Review', 'Pending',
                             'Payment Processing', 'Order Processing',
                             'Order Completed', 'Closed', 'Cancelled')
    )                                                       AS other_status_count
  FROM public.quotes q;

-- 🔴 刻意【沒有】EXCEPTION WHEN OTHERS —— 與 CB-85 record_page_view 相反。理由見 COMMENT P-1。

END
$fn_stats$;

REVOKE ALL ON FUNCTION public.get_quote_stats() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_quote_stats() TO authenticated;

COMMENT ON FUNCTION public.get_quote_stats() IS
'CB-60a admin 報價統計。由 admin-quotes.html 於每次 loadQuotes() 呼叫,
回傳【單一列】:total + 九個 status 計數 + null_status_count + other_status_count。

🔴 (P-1) 本函式為 fail-loud,與 CB-85 record_page_view(best-effort)【完全相反】,
  不可「順手對齊」。三處差異:
    身分缺失   本函式 RAISE 42501            / CB-85 靜默 RETURN
    授權缺失   本函式 RAISE 42501            / CB-85 不做授權判斷
    例外處理   本函式刻意【沒有】WHEN OTHERS / CB-85 有(且該有)
  理由:本函式的回傳值會直接變成 admin 畫面上的數字。被吞掉的錯誤會讓前端
  收到空結果而非 error,而空結果與「真的 0 張」同形 —— 那正好倒退回本函式
  要解決的 CB-82 缺陷二。
  ⚠️ CB-85 的 best-effort 是對的,因為它寫的是分析資料,失敗不影響使用者看到
     的內容;本函式相反。差異在【失敗的後果】,不在風格。

🔴 (P-2) 全表統計,【不接受任何篩選參數】(Q-26 = A)。
  接受篩選參數等於讓篩選邏輯出現第二份(SQL 一份、JS 一份),含 ilike 淨化與
  跳脫要在 SQL 重寫 —— F-118 同族的結構性風險,且失效是靜默的。
  ⚠️ 因此 admin 套用篩選時,上方 stat 卡【不會】跟著變;#statsScope 標籤固定
     顯示 All quotes。此行為改變已由 PM 授權並知會業主。
  📌 日後若真要「篩選結果統計」,正確做法是讓列表查詢與統計走同一支 RPC,
     而不是給本函式加參數。

🔴 (P-3) other_status_count 是正向識別(F-35),不是防禦性冗餘。
  新增第 10 種 status 時,九張卡加總會 ≠ total,而本欄位主動指出差額落點。
  ⚠️ 它填補了作廢的不變式「SUM(9) + NULL == total」留下的空缺 ——
     那個式子是恆真式(policy 一擋全回 0,0+0==0 永遠成立)。
     本欄位配合上面的 42501 才是真的檢查:授權失敗走 error 分支,
     不會偽裝成一組相加正確的 0。

📌 (P-4) 九個 FILTER 共用單次掃描的同一份 snapshot。

📌 (P-5) status 一律 DB canonical value,非顯示名。';

-- ══ 3. 斷言 ════════════════════════════════════════════════════════════
DO $cb60a_p_assert$
DECLARE
  v_def text;
BEGIN

  -- (a) 兩支函式各自【就是】一支(重載會讓 PostgREST 選錯,且不報錯)
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'status_rank') <> 1 THEN
    RAISE EXCEPTION 'CB-60a 斷言失敗:status_rank 的數量不為 1。';
  END IF;

  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'get_quote_stats') <> 1 THEN
    RAISE EXCEPTION 'CB-60a 斷言失敗:get_quote_stats 的數量不為 1。';
  END IF;

  -- (b) status_rank 必須【不是】SECDEF、必須 IMMUTABLE、必須無 search_path
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'status_rank'
      AND p.prosecdef IS FALSE AND p.provolatile = 'i' AND p.proconfig IS NULL
  ) THEN
    RAISE EXCEPTION 'CB-60a 斷言失敗:status_rank 屬性不符(應為 非SECDEF/IMMUTABLE/無search_path)。';
  END IF;

  -- (c) get_quote_stats 必須是 SECDEF 且有 search_path(DOC-1 §9 合規)
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'get_quote_stats'
      AND p.prosecdef IS TRUE
      AND p.proconfig @> ARRAY['search_path=public, pg_temp']
  ) THEN
    RAISE EXCEPTION 'CB-60a 斷言失敗:get_quote_stats 非 SECDEF 或缺 search_path。';
  END IF;

  -- (d) 權限
  IF NOT has_function_privilege('authenticated', 'public.get_quote_stats()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_quote_stats()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.status_rank(public.quotes)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.status_rank(public.quotes)', 'EXECUTE') THEN
    RAISE EXCEPTION 'CB-60a 斷言失敗:EXECUTE 權限不符(authenticated 應有、anon 應無)。';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'get_quote_stats';

  -- (e) 42501 授權分支必須存在。把口頭約定變成可執行的檢查 ——
  --     拿掉授權分支的版本症狀正好是「看起來都正常」。
  IF v_def NOT LIKE '%42501%' THEN
    RAISE EXCEPTION 'CB-60a 斷言失敗:get_quote_stats 缺 42501 授權分支。';
  END IF;

  -- (f) 必須【沒有】EXCEPTION WHEN OTHERS。
  --     🔴 比對前先剝掉 SQL 行註解:函式體內就有一行說明「刻意沒有
  --        EXCEPTION WHEN OTHERS」的註解,不剝掉會比對到自己的說明文字
  --        而誤判(2026-09-02 於 staging 實際踩到)。
  IF regexp_replace(v_def, '--[^\n]*', '', 'g')
       ~* 'EXCEPTION[[:space:]]+WHEN[[:space:]]+OTHERS' THEN
    RAISE EXCEPTION 'CB-60a 斷言失敗:get_quote_stats 不應有 EXCEPTION WHEN OTHERS。';
  END IF;

  RAISE NOTICE 'CB-60a PRODUCTION: 斷言全部通過。';

END
$cb60a_p_assert$;

COMMIT;

-- ══ 4. PostgREST schema cache 重載 ══════════════════════════════════════
-- 🔴 必須執行。沒有它,前端呼叫會因「函式不在 schema cache」而失敗,
--    而那個症狀看起來像「函式沒建起來」—— 用錯誤的理由懷疑正確的東西。
NOTIFY pgrst, 'reload schema';

-- ════════════════════════════════════════════════════════════════════════
-- 驗證 X1~X3(COMMIT 後另跑,唯讀,一次一段)
-- ════════════════════════════════════════════════════════════════════════
-- X1 兩支函式的結構
-- SELECT (SELECT name FROM _ops.environment) AS env, p.proname, p.prosecdef,
--        p.provolatile, p.proconfig,
--        pg_get_function_identity_arguments(p.oid) AS args
-- FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
-- WHERE n.nspname = 'public' AND p.proname IN ('status_rank','get_quote_stats')
-- ORDER BY p.proname;
--   期望:status_rank  f / i / NULL / "public.quotes"
--         get_quote_stats  t / v / {search_path=public, pg_temp} / (空)
--
-- X2 權限
-- SELECT (SELECT name FROM _ops.environment) AS env, r.rolname,
--        has_function_privilege(r.rolname,'public.get_quote_stats()','EXECUTE')            AS stats_exec,
--        has_function_privilege(r.rolname,'public.status_rank(public.quotes)','EXECUTE')   AS rank_exec
-- FROM pg_roles r WHERE r.rolname IN ('anon','authenticated','service_role')
-- ORDER BY r.rolname;
--   🔴 anon 兩欄皆須為 false。
--
-- X3 DOC-1 §9 SECURITY DEFINER 清單(列清單,不報比值)
-- SELECT (SELECT name FROM _ops.environment) AS env, p.proname,
--        (p.proconfig IS NOT NULL) AS has_search_path
-- FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
-- WHERE p.prosecdef IS TRUE AND n.nspname = 'public'
-- ORDER BY p.proname;
--   期望:清單中多出 get_quote_stats(has_search_path = true);
--         已知不合規者維持 generate_po_number / check_portal_feedback_rate_limit(F-139 P1)。
--   ⚠️ status_rank 不應出現在此清單 —— 它刻意不是 SECURITY DEFINER。

-- ════════════════════════════════════════════════════════════════════════
-- ROLLBACK
-- ════════════════════════════════════════════════════════════════════════
-- 🔴 前端若已 promote,移除函式會讓 admin-quotes 整頁載不出來
--    (status_rank 不存在 -> PostgREST 回 42703)。
--    要 rollback 必須【先】把前端退回舊版,再執行以下:
-- DROP FUNCTION IF EXISTS public.get_quote_stats();
-- DROP FUNCTION IF EXISTS public.status_rank(public.quotes);
-- NOTIFY pgrst, 'reload schema';
