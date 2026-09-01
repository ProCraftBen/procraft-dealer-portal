-- ════════════════════════════════════════════════════════════════════════
-- CB-85  record_page_view() 函式 + 權限 + 斷言
--
-- 環境: STAGING
-- 日期: 2026-08-31
-- 單元: 2-2(共 5 單元)。前置:單元 2-1 的 public.page_views 必須已存在。
--
-- 拍板依據:
--   B-1 = B  正規化【全部】在 DB 端,前端只送原始值、零邏輯。
--            理由:三份前端複製正是 F-35 / F-71 / F-118 的根因結構,
--            且失效模式是靜默的 —— 漏掉一個參數,uuid 就從那條路徑
--            寫進 DB,要到查資料時才發現。
--   B-2 = A  同源判斷所需的 origin 由前端送 p_origin,DB 不存設定。
--            p_origin 是【環境事實】不是邏輯(讀 window.location.origin
--            是屬性存取,不是判斷),且偽造它兩個方向都不會讓 uuid 通過:
--              偽造成寬鬆 -> 外部 referrer 被當同源 -> 取末段丟掉 query
--              偽造成嚴格 -> 內部 referrer 只存 origin
--            它只影響【分類精度】,不影響 Q-5xQ-6 的核心約束。
--
-- 🔴 本函式為 best-effort,與 CB-83 的 record_login_event【完全相反】。
--    差異細節見 COMMENT P-1。
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

SELECT _ops.assert_env('staging');

-- ══ 0. 前置檢查 ════════════════════════════════════════════════════════
DO $cb85pre$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'page_views'
  ) THEN
    RAISE EXCEPTION
      'CB-85 前置失敗:public.page_views 不存在。請先執行單元 2-1。';
  END IF;
END
$cb85pre$;

-- ══ 1. 函式 ════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.record_page_view(
  p_pathname text,
  p_search   text DEFAULT NULL,
  p_referrer text DEFAULT NULL,
  p_origin   text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_uid         uuid    := auth.uid();
  v_same_origin boolean := false;
  v_ref_path    text;
  v_paths       text[];
  v_codes       text[]  := ARRAY[NULL, NULL]::text[];
  v_seg         text;
  v_page        text;
  v_referrer    text;
  v_context     uuid;
  v_q           text;
  v_key         text;
  v_val         text;
  i             int;
BEGIN

  -- ── (1) 身分 ──────────────────────────────────────────────────────
  -- 🔴 靜默 RETURN,【不】RAISE EXCEPTION。
  --    record_login_event 在此處是 RAISE EXCEPTION ... 42501(CB-83);
  --    本函式相反,理由見 COMMENT P-1。
  -- 🔴 dealer_id 由 auth.uid() 取得,不是參數 —— 前端無法偽造歸屬。
  IF v_uid IS NULL THEN
    RETURN;
  END IF;

  -- ── (2) 同源判斷(B-2 = A)────────────────────────────────────────
  -- 🔴 用 left()/substr() 逐字比對,【不用】LIKE:
  --    LIKE 會把 p_origin 裡的 % 與 _ 當成萬用字元,而 p_origin 來自
  --    前端。逐字比對沒有逸出問題。
  -- 🔴 前綴相符後【必須】再確認下一個字元是 '/' 或字串已結束,否則
  --    https://dc-portal.procraft….com.evil.com/quotes.html 會被誤判為
  --    同源,進而存成內部頁面代號 "quotes" —— 那是 F-25 同名不同義,
  --    且存進去之後事後救不回來。
  IF p_referrer IS NOT NULL AND p_referrer <> ''
     AND p_origin IS NOT NULL AND p_origin <> ''
     AND left(p_referrer, length(p_origin)) = p_origin
     AND ( length(p_referrer) = length(p_origin)
           OR substr(p_referrer, length(p_origin) + 1, 1) = '/' )
  THEN
    v_same_origin := true;
    v_ref_path    := substr(p_referrer, length(p_origin) + 1);
  END IF;

  -- ── (3) 🔴 頁面代號正規化 —— 【單一程式路徑】────────────────────
  -- Stage 1 §4 組 1 的結構性保證:page 與(同源的)referrer 走【同一段】
  -- 程式碼,不是「兩份逐字相同」。兩者不可能分岔,不需要同步警語,
  -- 也不會有「漏改一份」的失效模式。
  --
  -- 🔴 刻意【不】另建一支 helper 函式:那會在 public schema 新增一個
  --    票面範圍外的物件(範圍授權例外 ④)。改以陣列迴圈達成同一效果。
  --
  -- D-1 形狀守衛(正向識別,F-35):確認 v_seg 【是】一個合法的頁面代號
  -- 形狀,而非排除已知壞值。新頁面的檔名天然滿足,自動涵蓋;不合形狀者
  -- 一律成為 NULL,不會寫入奇怪的值。
  v_paths := ARRAY[p_pathname, v_ref_path];

  FOR i IN 1..2 LOOP
    v_seg := v_paths[i];
    IF v_seg IS NOT NULL THEN
      v_seg := regexp_replace(v_seg, '[?#].*$', '');  -- 去 query / hash
      v_seg := regexp_replace(v_seg, '^.*/', '');     -- 取末段
      v_seg := lower(v_seg);
      v_seg := regexp_replace(v_seg, '\.html?$', ''); -- 去 .htm / .html
      IF v_seg ~ '^[a-z0-9-]{1,64}$' THEN
        v_codes[i] := v_seg;
      END IF;
    END IF;
  END LOOP;

  -- ── (4) page:不合形狀即靜默放棄整筆 ──────────────────────────────
  v_page := v_codes[1];
  IF v_page IS NULL THEN
    RETURN;
  END IF;

  -- ── (5) referrer ──────────────────────────────────────────────────
  -- 同源 -> 頁面代號(與 page 同一段程式碼,見 (3))
  -- 跨源 -> 【只存 origin】,scheme://host[:port],上限 200 字元
  -- 直接輸入 / 書籤 / 無法解析 -> NULL
  -- 🔴 絕不存原始 referrer:document.referrer 在同源導覽會回完整 URL
  --    含 query string,原樣存會讓 quote uuid 從 referrer 後門回到 DB,
  --    架空 context_id 的白名單邊界,而且不報錯。
  IF p_referrer IS NULL OR p_referrer = '' THEN
    v_referrer := NULL;
  ELSIF v_same_origin THEN
    v_referrer := v_codes[2];
  ELSE
    v_referrer := left(
      substring(p_referrer from '^[a-zA-Z][a-zA-Z0-9+.-]*://[^/?#]+'), 200);
  END IF;

  -- ── (6) context_id:白名單抽取(Q-5 = C)─────────────────────────
  -- 🔴 白名單是【單一真相】,只存在於本函式。日後新增需記錄的參數,
  --    改這一處即可,前端不含任何白名單邏輯(B-1 = B 的目的)。
  -- 固定順序,首個能通過 uuid 形狀檢查者即採用並中止 ——
  -- 順序固定是為了讓 ?draft=X&id=Y 這種情況有確定行為,不是任意的。
  -- 🔴 先做形狀檢查再 cast,【不】用 exception 兜:靠 EXCEPTION 接住
  --    cast 失敗會與 (9) 的 best-effort handler 混在一起,讓「參數不合法」
  --    與「真的出錯」無法區分。
  v_q := regexp_replace(coalesce(p_search, ''), '^\?', '');
  IF v_q <> '' THEN
    FOREACH v_key IN ARRAY ARRAY['draft', 'id', 'quote_id', 'payment_id'] LOOP
      v_val := substring(v_q from '(?:^|&)' || v_key || '=([^&]*)');
      IF v_val ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN
        v_context := v_val::uuid;
        EXIT;
      END IF;
    END LOOP;
  END IF;

  -- ── (7) 寫入 ──────────────────────────────────────────────────────
  -- 🔴 viewed_at 不在欄位清單:由表的 DEFAULT now() 產生,函式不接受
  --    時間參數 —— 前端無法回填或竄改時間。
  -- 🔴 【不查 dealers、不做快照】(Q-7 = A),與 record_login_event 每次
  --    SELECT ... INTO 四欄相反。理由見表 COMMENT P-3。
  -- 🔴 【無 ON CONFLICT】:每次頁面載入都要記一列,重整五次就是五列
  --    (Q-9 = A)。record_login_event 的 ON CONFLICT DO NOTHING 是為了
  --    「一次登入僅一列」,本票需求相反,不可順手對齊。
  INSERT INTO public.page_views (dealer_id, page, context_id, referrer)
  VALUES (v_uid, v_page, v_context, v_referrer);

-- ── (8) 🔴 best-effort:EXCEPTION handler ────────────────────────────
-- 刻意存在,與 record_login_event(CB-83 T-7 刻意不加)相反。
-- RAISE WARNING 後正常返回:對呼叫端仍是 best-effort(不拋錯、不阻擋),
-- 但失敗會留在 Postgres log,不會靜默壞掉數月。
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'CB-85 record_page_view 失敗(best-effort,已忽略):% %',
    SQLSTATE, SQLERRM;
  RETURN;

END
$fn$;

-- ══ 2. 權限 ════════════════════════════════════════════════════════════
-- 🔴 REVOKE FROM PUBLIC 是必要的,不是縱深:PostgreSQL 對新建函式【預設】
--    授予 PUBLIC EXECUTE。只 GRANT 給 authenticated 而不 REVOKE PUBLIC,
--    等於 anon 也能呼叫。
-- ⚠️ service_role 不動:它已 rolbypassrls = true(Stage 0 V-6),
--    額外 REVOKE 屬票面範圍外的改動。
REVOKE ALL ON FUNCTION public.record_page_view(text, text, text, text)
  FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.record_page_view(text, text, text, text)
  TO authenticated;

-- ══ 3. 🔴 斷言 ═════════════════════════════════════════════════════════
DO $cb85fnperm$
DECLARE
  v_sig text := 'public.record_page_view(text, text, text, text)';
  v_def text;
BEGIN

  -- (a) 🔴 正向識別(F-35):函式數量必須【就是】1。
  --     只檢查「該有的有沒有」是負向排除 —— 日後有人建一支同名但簽章
  --     不同的重載,原寫法會靜默通過,而 PostgREST 選到哪一支不可預期。
  IF (
    SELECT count(*) FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'record_page_view'
  ) <> 1 THEN
    RAISE EXCEPTION 'CB-85 斷言失敗:record_page_view 的數量不為 1(重載?)。';
  END IF;

  -- (b) SECURITY DEFINER + search_path(DOC-1 §9 合規)
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'record_page_view'
      AND p.prosecdef IS TRUE
      AND p.proconfig @> ARRAY['search_path=public, pg_temp']
  ) THEN
    RAISE EXCEPTION
      'CB-85 斷言失敗:record_page_view 非 SECURITY DEFINER 或缺 search_path。';
  END IF;

  -- (c) EXECUTE 權限
  IF NOT has_function_privilege('authenticated', v_sig, 'EXECUTE') THEN
    RAISE EXCEPTION 'CB-85 斷言失敗:authenticated 缺 EXECUTE。';
  END IF;
  IF has_function_privilege('anon', v_sig, 'EXECUTE') THEN
    RAISE EXCEPTION 'CB-85 斷言失敗:anon 不應持有 EXECUTE。';
  END IF;

  -- (d) 🔴 EXCEPTION handler 必須存在。
  --     把 P-1 的口頭約定變成【可執行的檢查】:任何重新套用本檔卻拿掉
  --     handler 的版本,會在此中止而不是靜默上線。
  --     ⚠️ 本斷言只在 migration 執行當下生效,不保護日後直接 ALTER 的改動 ——
  --        那一層的保護在 navigator.js 的註解與本函式的 COMMENT P-1。
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'record_page_view';

  IF v_def !~* 'EXCEPTION[[:space:]]+WHEN[[:space:]]+OTHERS' THEN
    RAISE EXCEPTION
      'CB-85 斷言失敗:record_page_view 缺 EXCEPTION WHEN OTHERS(見 P-1)。';
  END IF;

  RAISE NOTICE 'CB-85: 函式斷言全部通過。';

END
$cb85fnperm$;

-- ══ 4. COMMENT ═════════════════════════════════════════════════════════
COMMENT ON FUNCTION public.record_page_view(text, text, text, text) IS
'CB-85 頁面瀏覽記錄寫入。由前端 navigator.js(及 quick-start / resources 兩頁的
inline 呼叫)於每次頁面載入時 fire-and-forget 呼叫。

參數皆為【原始值】,前端不做任何處理(B-1 = B):
  p_pathname  window.location.pathname
  p_search    window.location.search(可含 ?,函式會去掉)
  p_referrer  document.referrer
  p_origin    window.location.origin —— 僅供同源判斷,【不入庫】(B-2 = A)

🔴 (P-1) 本函式為 best-effort,與 record_login_event(CB-83)【完全相反】,
  不可「順手對齊」。三處差異:
    身分缺失   本函式靜默 RETURN     / CB-83 RAISE EXCEPTION 42501
    重複寫入   本函式每次都寫一列    / CB-83 ON CONFLICT DO NOTHING
    例外處理   本函式有 WHEN OTHERS  / CB-83 刻意沒有(T-7)
  ⚠️ 但要注意 EXCEPTION 區塊的【真正理由】,以免被錯誤的理由說服而拿掉:
     它【不是】為了防止頁面白畫面 —— 那一層在前端。PostgREST 的 RPC 失敗
     回的是 error 物件,不是拋出的 JS 例外,DB 這裡拋錯【不會】讓頁面白掉。
     真正會白掉的是「有人把前端呼叫改成被 await 且無 try/catch」或「把它
     搬進 init() 的渲染關鍵路徑」—— 那個保護寫在 navigator.js 的函式上方,
     因為會改壞它的人是在看 JS,不是在看 \d+。
  本區塊的實際理由有三:
    (1) 每次頁面載入都失敗的 RPC 會在 Network panel 與 Supabase log 灌出
        紅色錯誤,淹掉真正的訊號。稀疏事件失敗刺眼是好事,密集事件不是。
    (2) 日後若有人從 trigger 或其他 SQL 內呼叫本函式,RAISE 會中止母交易。
    (3) 縱深:前端那層若被改壞,這層還在。
  RAISE WARNING 而非完全靜默,是為了讓失敗仍留在 Postgres log ——
  best-effort 不等於無聲無息壞掉數月。

🔴 (P-6) context_id 白名單 —— 【單一真相,只在本函式】:
    draft > id > quote_id > payment_id
  固定順序,首個通過 uuid 形狀檢查者即採用並中止。順序固定是為了讓
  ?draft=X&id=Y 這種情況有【確定】行為。
  ⚠️ 白名單【以外】的參數一律丟棄,這是設計不是遺漏。已知會被丟棄的:
       adminDraft(值為 1,非 uuid)、redirect、error
  日後若需要記錄新的參數,【只改本函式一處】;前端不含任何白名單邏輯,
  也不需要跟著改 —— 這正是 B-1 = B 的目的。

📌 (P-7) referrer 與 page 的值域【不對稱】,查詢時需注意:
  page     永遠不會是 index / login / reset-password(那三頁不記錄)
  referrer 【可能】是 index 或 login —— 使用者從登入頁進到 dashboard 時,
           referrer 會是 login,即使 login 自己沒有任何一列。
  這是預期行為,不是資料不一致。

🔴 (P-8) 正規化為【單一程式路徑】:page 與同源 referrer 走同一段迴圈,
  不是兩份逐字相同的程式碼。兩者不可能分岔 —— 這是 Q-5xQ-6 同向約束
  (uuid 不可從 referrer 後門回到 DB)的結構性保證,不是靠紀律維持。
  ⚠️ 若日後有人把其中一條路徑拆出去單獨處理,該保證即失效。';

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- 驗證 X1~X3(COMMIT 後另跑,唯讀)
-- 🔴 環境自我標示用 _ops.environment;每段強制 ORDER BY。
-- ════════════════════════════════════════════════════════════════════════
-- SELECT (SELECT name FROM _ops.environment) AS env, 'X1' AS x,
--        p.proname, p.prosecdef, p.proconfig,
--        pg_get_function_identity_arguments(p.oid) AS args
-- FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
-- WHERE n.nspname = 'public' AND p.proname = 'record_page_view'
-- ORDER BY p.proname;
--
-- SELECT (SELECT name FROM _ops.environment) AS env, 'X2' AS x,
--        r.rolname,
--        has_function_privilege(
--          r.rolname,
--          'public.record_page_view(text, text, text, text)', 'EXECUTE')::text
--          AS can_execute
-- FROM pg_roles r
-- WHERE r.rolname IN ('anon', 'authenticated', 'service_role')
-- ORDER BY r.rolname;
--   期望:anon = false,authenticated = true。
--
-- SELECT (SELECT name FROM _ops.environment) AS env, 'X3' AS x,
--        p.proname, p.prosecdef,
--        (p.proconfig IS NOT NULL)::text AS has_search_path
-- FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
-- WHERE p.prosecdef IS TRUE AND n.nspname = 'public'
-- ORDER BY p.proname;
--   期望:總數 14 支,不合規 2 支
--         (generate_po_number / check_portal_feedback_rate_limit,F-139)。
--   🔴 列清單,不報比值(DOC-1 §9 新寫法)。

-- ════════════════════════════════════════════════════════════════════════
-- ROLLBACK
-- ════════════════════════════════════════════════════════════════════════
-- DROP FUNCTION IF EXISTS public.record_page_view(text, text, text, text);
--   🔴 此檔的 ROLLBACK 必須【先於】單元 2-1 的 DROP TABLE 執行,
--      否則會留下一支指向不存在資料表的函式。
