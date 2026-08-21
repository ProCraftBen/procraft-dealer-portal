-- ============================================================================
-- CB-77  狀態變更時間戳自動記錄
-- ----------------------------------------------------------------------------
-- 環境:PRODUCTION (acwgemgpnusworpxxoai)
-- 日期:2026-08-21
-- 範圍:純 DB 改動。零前端修改、不動既有欄位、不動 F2 或任何既有 trigger、
--       不動 RLS policy、不回填既有訂單。
--
-- 交付:quotes.status_history (jsonb)
--       public.record_status_history()            — trigger 函式
--       trg_record_status_history_on_insert       — BEFORE INSERT
--       trg_record_status_history                 — BEFORE UPDATE (WHEN status 變更)
--
-- ----------------------------------------------------------------------------
-- 🔴 執行方式:四段,【依序】貼入 Supabase SQL Editor。
--      Segment 1  → Segment 2 → Segment 3 → Segment 3b → Segment 4
--
--    Segment 3 為【唯一原子單元】,必須整段一次執行。
--    Segment 1、2、3b 單獨失敗皆無害,全段冪等,可安全重跑。
--
--    Segment 3 會主動檢查 Segment 1、2 的前置條件,
--    順序不依賴人記得 —— 漏跑會 RAISE EXCEPTION 而非靜默通過。
-- ----------------------------------------------------------------------------
-- 🔴 本檔為 PRODUCTION 版,由 STAGING 版逐字複製、僅將 7 處可執行的
--    _ops.assert_env('staging') 換成 _ops.assert_env('production') 產生。
--    其餘一字不改。兩檔的差異應【只有】這 7 行。
-- ============================================================================


-- ============================================================================
-- Segment 1 / 4   欄位
-- ----------------------------------------------------------------------------
-- ADD COLUMN ... DEFAULT NULL 為 metadata-only,不重寫表。
-- ============================================================================

SELECT _ops.assert_env('production');

ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS status_history jsonb DEFAULT NULL;

COMMENT ON COLUMN public.quotes.status_history IS
$doc$CB-77 狀態變更歷程。由 trigger 自動維護,非人工欄位。

格式:jsonb 陣列,依發生順序 append,保序(分析請用 WITH ORDINALITY)。
  [{"s": 狀態值, "at": UTC ISO8601, "by": auth.uid() 或 null, "r": 呼叫者角色}, ...]

  "at" 固定為 UTC,格式 YYYY-MM-DDTHH24:MI:SS.ffffffZ。
       以 to_char(... AT TIME ZONE 'UTC', ...) 產生,不受 session
       TimeZone / DateStyle 影響 —— 否則前端、n8n、SQL Editor 寫入的
       時戳會混雜不同 offset,耗時計算失真(CB-77 T-12)。
  "by" auth.uid();service_role / n8n / SQL Editor 取不到時為 null。
  "r"  coalesce(auth.role(), current_user::text)。
       🔴 不可改用 current_user 單獨判斷 —— submit_purchase_order 為
          SECURITY DEFINER,會把 dealer 送單全部誤記為 postgres(CB-77 B-3)。

🔴 NULL 與非 NULL 語意不同,不可混用(CB-77 Q-3):
     NULL   = CB-77 上線前建立的舊單,【無追蹤資料】
     非 NULL = 自建單起完整可信的歷程

🔴 分析查詢一律加 WHERE status_history IS NOT NULL。
   舊單【不得】視為耗時 0 —— 那是「不知道」,不是「沒花時間」。

⚠️ 寫入權威性的邊界(誠實記載,勿高估):
   狀態【有】變更時 → BEFORE trigger 覆寫本欄,客戶端送什麼都不採信。
   狀態【未】變更時 → WHEN 子句不成立,trigger 不觸發,
                      持有該列 UPDATE 權限者可直接寫入本欄。
   目前僅 admin 與「自己 Draft/Returned 單」的 dealer 具此權限。
   本欄為分析用途、非財務欄位,現階段接受此邊界(CB-77 F-89)。

與 fulfillment_date 的關係(CB-77 D-1):
  fulfillment_date          = admin 選定的業務出貨日 (date)
  本欄 Order Completed 的 at = 系統標記完成的時刻 (timestamptz)
  兩者語意獨立、可能不一致,不可互相替代。本 trigger 不讀不寫該欄。$doc$;


-- ============================================================================
-- Segment 2 / 4   trigger 函式
-- ----------------------------------------------------------------------------
-- SECURITY INVOKER(預設)—— 只操作 NEW/OLD,不跨權限讀寫,
--   不需 DEFINER → DOC-1 §9 稽核基線維持 6/8,不新增缺口。
-- SET search_path = '' —— 與 F2 (enforce_dealer_quote_transition) 同慣例。
--   本函式不查任何表;所用函式非 pg_catalog 內建即已全限定(auth.*)。
--   auth.uid()/auth.role() 的 proconfig 為 null 會繼承 '',但兩者僅用
--   current_setting/nullif/coalesce,不觸及任何表 → 無 F-56 式風險。
--   實證:F2 已在 production 以 search_path='' 呼叫 auth.uid() 正常運作。
-- 無 EXCEPTION 區塊 —— fail-closed。本函式無獨立失敗模式:
--   賦值與主 UPDATE 是同一次 tuple 寫入,沒有可以單獨失敗的第二道操作。
--   加了 EXCEPTION 反而會把「欄位不存在」這類部署錯誤變成靜默漏記。
-- ============================================================================

SELECT _ops.assert_env('production');

CREATE OR REPLACE FUNCTION public.record_status_history()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $fn$
DECLARE
  v_event jsonb;
BEGIN
  v_event := jsonb_build_object(
    's',  NEW.status,
    'at', to_char(clock_timestamp() AT TIME ZONE 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'by', auth.uid(),
    'r',  coalesce(auth.role(), current_user::text)
  );

  IF TG_OP = 'INSERT' THEN
    NEW.status_history := jsonb_build_array(v_event);
  ELSE
    NEW.status_history := coalesce(OLD.status_history, '[]'::jsonb) || v_event;
  END IF;

  RETURN NEW;
END
$fn$;

COMMENT ON FUNCTION public.record_status_history() IS
$doc$CB-77 狀態變更記錄。由 quotes 上的兩支 BEFORE trigger 共用,
以 TG_OP 分支 —— 單一真相來源,兩條路徑的元素格式不可能分歧。

時戳用 clock_timestamp() 而非 now():now() 回傳交易開始時刻,
同一交易內兩次狀態變更會拿到完全相同的時戳,排序失真。$doc$;

-- trigger 函式的 EXECUTE 權限僅在 CREATE TRIGGER 時檢查,
-- trigger 觸發時不檢查 → REVOKE 不影響運作,但可防外部直接呼叫。
REVOKE ALL ON FUNCTION public.record_status_history() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_status_history() FROM anon, authenticated;


-- ============================================================================
-- Segment 3 / 4   🔴 原子單元 —— 必須整段一次執行
-- ----------------------------------------------------------------------------
-- 🔴 assert_env 以 PERFORM 置於 DO 區塊【第一行】,確保環境守衛與
--    CREATE TRIGGER 位於同一 statement。寫成區塊外的獨立 SELECT 即
--    失去此保證(Supabase SQL Editor 走連線池 —— CB-71 教訓)。
--
-- 🔴 為何兩個 CREATE TRIGGER 必須同生共死:
--    若 INSERT trigger 成功而 UPDATE trigger 失敗,新單會寫入
--    【非 NULL 但不完整】的 status_history —— 直接摧毀 Q-3 的語意契約
--    (非 NULL = 完整可信)。分析時該批單會被誤判為「建單後從未變更」,
--    錯得安靜且無跡可循。這是本票唯一有害的部分套用情境。
-- ============================================================================

DO $cb77$
BEGIN
  PERFORM _ops.assert_env('production');

  -- ── 前置條件 ①:Segment 1 的欄位 ────────────────────────────────────
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.quotes'::regclass
      AND attname  = 'status_history'
      AND attnum > 0 AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION
      'ABORT: public.quotes.status_history 不存在 → Segment 1 未執行或失敗。'
      ' 未建立任何 trigger,無任何改動。';
  END IF;

  -- ── 前置條件 ②:Segment 2 的函式 ────────────────────────────────────
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'record_status_history'
      AND p.prorettype = 'pg_catalog.trigger'::regtype
  ) THEN
    RAISE EXCEPTION
      'ABORT: public.record_status_history() 不存在 → Segment 2 未執行或失敗。'
      ' 未建立任何 trigger,無任何改動。';
  END IF;

  -- ── 冪等:先移除舊版(若有)──────────────────────────────────────────
  DROP TRIGGER IF EXISTS trg_record_status_history_on_insert ON public.quotes;
  DROP TRIGGER IF EXISTS trg_record_status_history            ON public.quotes;

  -- ── ① BEFORE INSERT:記錄初始狀態(CB-77 Q-2)────────────────────────
  --    無 WHEN 子句 —— 保證新單的 status_history 恆為非 NULL。
  --    quotes 無其他 INSERT trigger,本 trigger 名稱不構成順序依賴。
  CREATE TRIGGER trg_record_status_history_on_insert
    BEFORE INSERT ON public.quotes
    FOR EACH ROW
    EXECUTE FUNCTION public.record_status_history();

  -- ── ② BEFORE UPDATE:僅在 status 實際改變時記錄(CB-77 T-3)──────────
  --    WHEN 子句寫在 CREATE TRIGGER 而非函式體內:條件不成立時
  --    PostgreSQL 根本不呼叫函式 → 改金額/備註的 UPDATE 成本為零。
  --    🔴 本 trigger 的【名稱】是功能不變量,詳見 COMMENT ON TRIGGER。
  CREATE TRIGGER trg_record_status_history
    BEFORE UPDATE ON public.quotes
    FOR EACH ROW
    WHEN (OLD.status IS DISTINCT FROM NEW.status)
    EXECUTE FUNCTION public.record_status_history();

  RAISE NOTICE 'CB-77 Segment 3 完成:兩個 trigger 均已建立。';
END
$cb77$;


-- ============================================================================
-- Segment 3b / 4   文件(零行為影響,不綁入原子單元 —— CB-77 Q-7 = B)
-- ============================================================================

COMMENT ON TRIGGER trg_record_status_history ON public.quotes IS
$doc$CB-77 狀態變更記錄 — status 變更時 append 一筆。

🔴 本 trigger 的【名稱】是功能不變量,不可更名。

PostgreSQL 對同一 timing(BEFORE UPDATE)的多個 row trigger,
依【trigger 名稱字母序】執行,無任何語法層宣告可指定順序。

本表另有 trg_enforce_dealer_quote_transition(F2),其 Case 2
(dealer 推進 Pending -> Payment Processing)會比對
(to_jsonb(OLD) - 'status') 與 (to_jsonb(NEW) - 'status'),
凍結 status 以外的所有欄位 —— 包含本 trigger 寫入的 status_history。

若本 trigger 更名為字母序早於 trg_enforce_dealer_quote_transition 的名稱:
  (1) dealer 付款推進將被 F2 以 42501 拒絕 -> 付款流程全掛;
  (2) 更隱蔽的是,F2 拒絕的那次變更本 trigger 已寫入陣列。
      若改以其他方式繞過 (1),陣列會多出一筆【從未發生的轉移】,
      分析資料錯誤且無跡可循。

'trg_record_status_history' > 'trg_enforce_dealer_quote_transition'
('r' > 'e'),故本 trigger 必在 F2 之後執行,取得 F2 放行後的最終值。

⚠️ 此結論的前提:F2 存在、為 BEFORE UPDATE FOR EACH ROW、
   且 tgenabled = 'O'。前提若變動,本結論即失效,須重新驗證。
   (2026-08-21 已查證 staging 與 production 兩環境皆成立;
    兩環境 F2 剝除註解後的可執行碼 md5 相同)

⚠️ 為何不能與 INSERT 合併為一支 BEFORE INSERT OR UPDATE trigger:
   本 trigger 的 WHEN 子句需引用 OLD,而 OLD 在 INSERT 的
   WHEN 子句中不存在,語法即錯。故必為兩支。

⚠️ 為何是 BEFORE 而非 AFTER:AFTER trigger 拿不到可寫的 NEW,
   必須另發一道 UPDATE 寫回同列。該道 UPDATE 會再次經過 F2,
   此時 OLD.status = 'Payment Processing' 落入 F2 Case 3 而被拒絕
   -> AFTER 方案在本表功能上不可行,非僅效能較差。$doc$;

COMMENT ON TRIGGER trg_record_status_history_on_insert ON public.quotes IS
$doc$CB-77 狀態變更記錄 — 建單時的初始狀態(Q-2)。

與 trg_record_status_history 共用 public.record_status_history(),
以 TG_OP 分支。共用單一函式是為了讓兩條路徑的元素格式不可能分歧。

無 WHEN 子句 —— 即使 NEW.status 為 NULL 也記錄,以保證
【新單的 status_history 恆為非 NULL】。這是 Q-3 語意契約的基礎:
  NULL = CB-77 上線前的舊單;非 NULL = 完整可信的歷程。
記錄 "s": null 是陳述事實,非編造。

quotes 表無其他 INSERT trigger,故本 trigger 的名稱【不】構成
順序依賴(與 UPDATE 側不同)。$doc$;


-- ============================================================================
-- Segment 4 / 4   schema reload + 驗證
-- ============================================================================

NOTIFY pgrst, 'reload schema';


-- ── 硬斷言:失敗即 RAISE EXCEPTION,不可只回報 ──────────────────────────
DO $verify$
DECLARE
  v_ins_en  "char";
  v_upd_en  "char";
  v_f2_en   "char";
  v_between int;
BEGIN
  PERFORM _ops.assert_env('production');

  SELECT tgenabled INTO v_ins_en FROM pg_catalog.pg_trigger
   WHERE tgrelid = 'public.quotes'::regclass
     AND tgname  = 'trg_record_status_history_on_insert';
  SELECT tgenabled INTO v_upd_en FROM pg_catalog.pg_trigger
   WHERE tgrelid = 'public.quotes'::regclass
     AND tgname  = 'trg_record_status_history';
  SELECT tgenabled INTO v_f2_en  FROM pg_catalog.pg_trigger
   WHERE tgrelid = 'public.quotes'::regclass
     AND tgname  = 'trg_enforce_dealer_quote_transition';

  -- 🔴 斷言 (1):兩個 trigger 皆存在 —— 明確擋住「只有 INSERT trigger」
  IF v_ins_en IS NULL AND v_upd_en IS NULL THEN
    RAISE EXCEPTION
      'ASSERT FAIL (1): 兩個 trigger 皆不存在 -> Segment 3 未執行。';
  ELSIF v_upd_en IS NULL THEN
    RAISE EXCEPTION
      'ASSERT FAIL (1) 🔴 危險狀態:只有 INSERT trigger,UPDATE trigger 缺失。'
      ' 新單會寫入【非 NULL 但不完整】的 status_history,摧毀 Q-3 語意契約。'
      ' 請【立即】執行 ROLLBACK R-1,勿讓此狀態存續。';
  ELSIF v_ins_en IS NULL THEN
    RAISE EXCEPTION
      'ASSERT FAIL (1): 只有 UPDATE trigger,INSERT trigger 缺失。'
      ' 新單的初始狀態不會被記錄(違反 Q-2)。請重跑 Segment 3。';
  END IF;

  -- 🔴 斷言 (2):執行順序 —— record 必須排在 enforce 之後
  --    以 COLLATE "C" 比對:trigger 觸發順序依名稱位元序,與 DB 預設
  --    collation 未必相同。本案名稱純 ASCII 兩者一致,明示 COLLATE "C"
  --    可防未來出現非 ASCII trigger 名稱時的誤判。
  IF v_f2_en IS NULL THEN
    RAISE EXCEPTION
      'ASSERT FAIL (2): trg_enforce_dealer_quote_transition 不存在 -> '
      'COMMENT 所載的順序前提已失效,須重新設計 CB-77。';
  END IF;

  IF NOT (('trg_enforce_dealer_quote_transition' COLLATE "C")
        < ('trg_record_status_history'            COLLATE "C")) THEN
    RAISE EXCEPTION
      'ASSERT FAIL (2): trigger 名稱順序錯誤 -> F2 的整列凍結會擋下 dealer 付款。';
  END IF;

  -- 🔴 斷言 (3):三支 trigger 皆為啟用狀態
  IF v_ins_en <> 'O' OR v_upd_en <> 'O' OR v_f2_en <> 'O' THEN
    RAISE EXCEPTION
      'ASSERT FAIL (3): tgenabled 非 O(insert=%, update=%, F2=%)。'
      ' trigger 被停用時狀態變更會【靜默漏記】。', v_ins_en, v_upd_en, v_f2_en;
  END IF;

  -- ⚠️ 資訊性:是否有第三支 BEFORE UPDATE trigger 插在 F2 與本 trigger 之間
  SELECT count(*) INTO v_between FROM pg_catalog.pg_trigger t
   WHERE t.tgrelid = 'public.quotes'::regclass AND NOT t.tgisinternal
     AND (t.tgtype & 2) > 0 AND (t.tgtype & 16) > 0
     AND (t.tgname COLLATE "C") > ('trg_enforce_dealer_quote_transition' COLLATE "C")
     AND (t.tgname COLLATE "C") < ('trg_record_status_history'            COLLATE "C");
  IF v_between > 0 THEN
    RAISE WARNING
      'CB-77:有 % 支 trigger 排在 F2 與記錄 trigger 之間,請確認其行為。', v_between;
  END IF;

  RAISE NOTICE 'CB-77 驗證通過:斷言 (1)(2)(3) 全數成立。';
END
$verify$;


-- ── 人眼複核 A:trigger 清單與觸發順序 ──────────────────────────────────
WITH guard AS MATERIALIZED (SELECT _ops.assert_env('production') AS ok)
SELECT current_database() AS db,
       (SELECT name        FROM _ops.environment) AS env_name,
       (SELECT project_ref FROM _ops.environment) AS project_ref,
       t.tgname,
       CASE WHEN (t.tgtype & 2) > 0 THEN 'BEFORE' ELSE 'AFTER' END AS timing,
       (t.tgtype & 4)  > 0 AS on_insert,
       (t.tgtype & 16) > 0 AS on_update,
       t.tgenabled,
       obj_description(t.oid, 'pg_trigger') IS NOT NULL AS has_comment,
       pg_get_triggerdef(t.oid) AS def
FROM pg_trigger t CROSS JOIN guard
WHERE t.tgrelid = 'public.quotes'::regclass AND NOT t.tgisinternal
ORDER BY t.tgname COLLATE "C";
-- 預期 3 列,依序:
--   trg_enforce_dealer_quote_transition  BEFORE  f / t  O
--   trg_record_status_history            BEFORE  f / t  O  has_comment = t
--   trg_record_status_history_on_insert  BEFORE  t / f  O  has_comment = t


-- ── 人眼複核 B:函式屬性(DOC-1 §9 稽核基線不得惡化)────────────────────
WITH guard AS MATERIALIZED (SELECT _ops.assert_env('production') AS ok)
SELECT current_database() AS db, p.proname,
       p.prosecdef AS is_definer,   -- 預期 false
       p.proconfig                  -- 預期 {"search_path="}
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
CROSS JOIN guard
WHERE n.nspname = 'public' AND p.proname = 'record_status_history';


-- ── 人眼複核 C:欄位存在、既有訂單未被回填 ──────────────────────────────
WITH guard AS MATERIALIZED (SELECT _ops.assert_env('production') AS ok)
SELECT current_database() AS db,
       count(*)                         AS total,
       count(status_history)            AS non_null,    -- 預期 0(migration 後、測試前)
       count(*) - count(status_history) AS null_legacy  -- 預期 = total
FROM public.quotes CROSS JOIN guard;


-- ============================================================================
-- ROLLBACK  R-CB77
-- ----------------------------------------------------------------------------
-- ⚠️ R-1 與 R-2/R-3 刻意分離:
--    只跑 R-1 即可【完全停止】新資料寫入,且不損失已收集的歷程。
--    欄位保留不影響任何既有功能(無任何前端讀寫它)。
--    R-3 不可逆 —— 會永久刪除已收集的所有歷程資料。
-- ============================================================================
-- ── R-1  止血(必要時單獨執行即可)──────────────────────────────────────
-- DO $rb$
-- BEGIN
--   PERFORM _ops.assert_env('production');
--   DROP TRIGGER IF EXISTS trg_record_status_history_on_insert ON public.quotes;
--   DROP TRIGGER IF EXISTS trg_record_status_history            ON public.quotes;
--   RAISE NOTICE 'CB-77 R-1:兩個 trigger 已移除。';
-- END
-- $rb$;
--
-- ── R-2  移除函式(選用)────────────────────────────────────────────────
-- SELECT _ops.assert_env('production');
-- DROP FUNCTION IF EXISTS public.record_status_history();
--
-- ── R-3  移除欄位(選用)🔴 不可逆,會永久刪除已收集的歷程 ───────────────
-- SELECT _ops.assert_env('production');
-- ALTER TABLE public.quotes DROP COLUMN IF EXISTS status_history;
-- NOTIFY pgrst, 'reload schema';
-- ============================================================================
