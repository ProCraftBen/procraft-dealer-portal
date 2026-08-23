-- ============================================================================
-- CB-76  Dealer Account Category — account_type 欄位 + Trial 狀態攔截
-- 環境:PRODUCTION (acwgemgpnusworpxxoai)
-- 日期:2026-08-22
-- ----------------------------------------------------------------------------
-- 🔴 一次貼一段、單獨執行。段落標示【原子單元】者必須整段一次執行。
--
-- 🔴 assert_env 的兩種形式(CB-71 教訓 / DOC-1 待補 ⑧):
--    需原子性者 → PERFORM 置於 DO 區塊【第一行】,確保守衛與 DDL 同一 statement。
--    Supabase SQL Editor 走連線池,BEGIN; ... COMMIT; 不保證同一條連線,
--    守衛與被守衛的 DDL 若分屬兩次往返,守衛等於沒有。
--
-- 🔴 本檔由 __STAGING.sql【機械式取代】產生:全檔 12 處 _ops.assert_env 的
--    參數由 'staging' 改為 'production',其餘一字不改。內訳:
--      可執行         7 處 — Segment 1 / 2 / 3 / 4斷言 / 人眼複核 A・B・C
--      ROLLBACK 註解內 4 處 — R-1 / R-2 / R-3 / R-4
--      本註解區塊內   1 處 — 即下一行的說明文字
--    ⚠️ __STAGING.sql 的對應標頭誤寫為「11 處」(漏算註解內那一處)。
--       該檔已執行,依「檔案 = 實際執行內容」原則不回頭修改;此處記錄差異。
--    🔴 ROLLBACK 那 4 處也要改:回滾 production 時若守衛還寫著 'staging',
--       解開註解就會被 assert_env 擋下,而那正是最不該卡住的時刻。
--
-- 段落:
--   1  dealers.account_type 欄位 + CHECK 約束        【原子單元】
--   2  public.block_trial_status_change() 函式
--   3  兩支 trigger                                   【原子單元 — 必須同生共死】
--   3b 文件(零行為影響)
--   4  驗證(硬斷言 + 人眼複核)
--   R  ROLLBACK(全部註解掉)
-- ============================================================================


-- ============================================================================
-- Segment 1 / 4   欄位 + CHECK 約束   【原子單元】
-- ----------------------------------------------------------------------------
-- 🔴 冪等性必須【分別】判斷欄位與約束,不可用 ADD COLUMN IF NOT EXISTS 一行帶過:
--    若欄位已存在,整條 ALTER 被跳過 → 連帶跳過 CHECK → 產生
--    「有欄位、無約束」的部分狀態,而那正是本段最需要避免的。
--
-- NOT NULL DEFAULT 在 PostgreSQL 11+ 為 metadata-only,不重寫表,
--    既有列直接取得預設值 —— 「回填」不需要獨立步驟。
--
-- 約束具名而非 inline:inline CHECK 的自動命名恰好也是
--    dealers_account_type_check,但那是巧合對上。日後本欄若再加第二條
--    CHECK,自動命名會變成 _check1,埋下不一致。(CB-76 Q-20 = A)
--
-- 值採小寫底線(CB-76 Q-1 = A):本表既有 role 為 dealer/admin/super_admin,
--    payments.status / payment_method / logistic_type 亦同。quotes.status 的
--    TitleCase 是【不能改】的歷史包袱,不是命名典範。
-- ============================================================================

DO $cb76_col$
BEGIN
  PERFORM _ops.assert_env('production');

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.dealers'::regclass
      AND attname  = 'account_type'
      AND attnum > 0 AND NOT attisdropped
  ) THEN
    ALTER TABLE public.dealers
      ADD COLUMN account_type text NOT NULL DEFAULT 'dealer';
    RAISE NOTICE 'CB-76 S1: 已新增 dealers.account_type。';
  ELSE
    RAISE NOTICE 'CB-76 S1: dealers.account_type 已存在,略過建欄。';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.dealers'::regclass
      AND conname  = 'dealers_account_type_check'
  ) THEN
    ALTER TABLE public.dealers
      ADD CONSTRAINT dealers_account_type_check
      CHECK (account_type IN ('dealer', 'internal_account', 'location', 'trial'));
    RAISE NOTICE 'CB-76 S1: 已新增 dealers_account_type_check。';
  ELSE
    RAISE NOTICE 'CB-76 S1: dealers_account_type_check 已存在,略過。';
  END IF;

  RAISE NOTICE 'CB-76 Segment 1 完成。';
END
$cb76_col$;


-- ============================================================================
-- Segment 2 / 4   trigger 函式
-- ----------------------------------------------------------------------------
-- 🔴 SECURITY DEFINER —— 與 F2 / CB-77 的 INVOKER 不可類比。
--    F2 (enforce_dealer_quote_transition) 與 CB-77 (record_status_history)
--    只讀 OLD/NEW、不查任何表,故 INVOKER + search_path='' 即可。
--    本函式必須查 public.dealers,而該表的三條 SELECT policy 皆要求
--    auth.uid() 有值或呼叫者為 admin:
--      "Dealers can read own data"  PUBLIC         USING (auth.uid() = id)
--      dealer_read_own_profile      authenticated  USING (id = auth.uid())
--      admin_select_all_dealers     authenticated  USING ((id = auth.uid()) OR is_admin())
--    → service_role / n8n / SQL Editor 下 auth.uid() 為 NULL,三條全數落空,
--      INVOKER 會使子查詢回 NULL【且不報錯】→ 靜默放行。這正是本票要防的
--      失效模式。(2026-08-21 已查證兩環境 policy 逐字相同。)
--    DOC-1 §9 稽核基線:6/8 → 7/9。
--
-- 🔴 SET search_path = public, pg_temp（DOC-1 §9 標準）。
--    不可用 '' —— 本函式要查 public.dealers。函式體仍全 schema-qualify
--    作為縱深防禦(比照 F1 submit_purchase_order)。
--
-- 🔴 正向識別(F-35):以 = 'trial' 命中、以 = ANY(ARRAY['Draft']) 放行,
--    而非 <> 'trial' / <> 'Draft'。差別在 NULL:
--      NEW.status 為 NULL 時,NULL <> 'Draft' → NULL → IF 不成立 → 放行(靜默);
--      NULL = ANY(ARRAY['Draft']) → NULL → IF 不成立 → 落到 RAISE(可見)。
--    同一個 NULL,兩種寫法方向相反。
--    這也同時吸收兩環境的目標狀態分歧:submit_purchase_order 在 staging
--    寫 'Stock Review'、production 寫 'Pending'。允許集合只列 'Draft',
--    不列舉要排除什麼 → 兩環境行為一致。
--
-- 🔴 拒絕形式必須是 RAISE EXCEPTION,不得改為「將 NEW.status 強制回寫為
--    'Draft' 後 RETURN NEW」—— 詳見 COMMENT ON TRIGGER 的第 2 條不變量。
--
-- ERRCODE 42501 (insufficient_privilege) → PostgREST 對應 HTTP 403,
--    與 F2 的拒絕同類,前端既有錯誤路徑不需新增分支。(CB-76 Q-23 = A)
--
-- ⚠️ 本段的 assert_env 為區塊外的獨立 SELECT,不具原子性保證。
--    可接受的理由:此時尚無任何 trigger 引用本函式,建在錯誤環境
--    只會留下一個不會被觸發的孤兒函式,無行為影響。真正需要原子守衛的是
--    Segment 3 的 CREATE TRIGGER。(與 CB-77 Segment 2 同一取捨。)
-- ============================================================================

SELECT _ops.assert_env('production');

CREATE OR REPLACE FUNCTION public.block_trial_status_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_account_type text;
BEGIN
  -- ── Q-22 ①:dealer_id 為 NULL ─────────────────────────────────────────
  --   quotes.dealer_id 為 nullable 且 FK 不約束 NULL,故此情況可能發生。
  --   兩環境現存 0 列、前端無路徑產生(resolveDealerId 查不到即 throw)。
  --   拒絕而非放行:無 dealer_id 即無從判斷 account_type,放行等同開一條
  --   「先建無主單、再推進狀態」的繞道。
  IF NEW.dealer_id IS NULL THEN
    RAISE EXCEPTION
      'CB-76: quote has no dealer_id — cannot determine account type.'
      USING ERRCODE = '42501';
  END IF;

  SELECT d.account_type INTO v_account_type
  FROM public.dealers d
  WHERE d.id = NEW.dealer_id;

  -- ── Q-22 ②:dealer_id 非 NULL 但查無列 ────────────────────────────────
  --   🔴 訊息刻意與 ① 分開:此情況代表 FK 失效或 account_type 為 NULL
  --      (該欄為 NOT NULL,故亦不應發生),是遠比「忘了填 dealer」嚴重的
  --      資料庫層故障。合併訊息會讓兩種處置完全不同的問題長得一樣。
  --   不用 IF NOT FOUND —— 那是隱含狀態,會被後續任何 SQL 覆寫;
  --   明確的 NULL 檢查才是正向識別(F-35)。
  IF v_account_type IS NULL THEN
    RAISE EXCEPTION
      'CB-76: dealer % not found (FK violated?) — refusing status change.',
      NEW.dealer_id
      USING ERRCODE = '42501';
  END IF;

  -- ── 正向識別:命中 trial 才進入攔截,其餘一律放行 ──────────────────────
  IF v_account_type = 'trial' THEN
    -- trial 的允許集合僅 {'Draft'}。陣列形式讓日後擴充只改字面值。
    IF NEW.status = ANY (ARRAY['Draft']) THEN
      RETURN NEW;
    END IF;

    -- 🔴 此字串與 i18n/en.json 的 nq3.err.trial_submit_blocked 逐字相同,
    --    以及 new-quote-step3.html 的 pcTxt fallback。三者是同一句話的
    --    三個副本,任一漂移都不會報錯,只會讓使用者在不同路徑看到不同說法。
    RAISE EXCEPTION
      'Trial accounts cannot submit orders. Contact ProCraft to activate your account.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END
$fn$;

COMMENT ON FUNCTION public.block_trial_status_change() IS
$doc$CB-76 Trial 帳號狀態攔截。由 quotes 上的兩支 BEFORE trigger 共用,
以【單一函式】服務 INSERT 與 UPDATE 兩條路徑 —— 兩條路徑的判斷不可能分歧。

🔴 判斷基準是 NEW.dealer_id(這張單屬於誰),【全程不引用 auth.uid()】。
   F2 (enforce_dealer_quote_transition) 首行為
     IF auth.uid() IS NULL OR auth.uid() <> OLD.dealer_id THEN RETURN NEW
   → 只約束 dealer,admin 天然不受管。
   本函式改以「單屬於誰」為軸,故 dealer 自送 / admin 代送 /
   SECURITY DEFINER RPC(submit_purchase_order)三條路徑一律攔下。
   業主拍板:admin 亦不可代 Trial 下單。

🔴 為何是 SECURITY DEFINER,而 F2 / CB-77 是 INVOKER:
   後兩者只讀 OLD/NEW、不查任何表。本函式必須查 public.dealers,
   而該表三條 SELECT policy 皆要求 auth.uid() 有值或呼叫者為 admin。
   service_role / n8n / SQL Editor 下 auth.uid() 為 NULL → 三條全數落空
   → INVOKER 會使子查詢回 NULL【且不報錯】→ 靜默放行。
   (2026-08-21 查證:staging 與 production 的 dealers policy 逐字相同。)

🔴 RLS 不可行,不只是「靜默」的品質問題:
   submit_purchase_order 為 SECURITY DEFINER,繞過 RLS,而它正是
   Draft→Submit 主路徑上寫 status 的那支 → RLS 在主路徑上根本沒有
   攔截機會。SECURITY DEFINER 不繞過 trigger,故 trigger 可行。$doc$;

-- trigger 函式的 EXECUTE 權限僅在 CREATE TRIGGER 時檢查,
-- trigger 觸發時不檢查 → REVOKE 不影響運作。
-- 🔴 本函式為 SECURITY DEFINER,縱深防禦的價值高於 CB-77 那支 INVOKER。
REVOKE ALL ON FUNCTION public.block_trial_status_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.block_trial_status_change() FROM anon, authenticated;


-- ============================================================================
-- Segment 3 / 4   兩支 trigger   🔴 原子單元 —— 必須整段一次執行
-- ----------------------------------------------------------------------------
-- 🔴 為何兩支必須同生共死:
--    若 UPDATE trigger 成功而 INSERT trigger 失敗,A-mode
--    (new-quote-step3.html 直接 INSERT 一列)即成為未受保護的缺口,
--    而且【沒有任何症狀】—— 它只在有人繞過前端時才顯現。
--    這是本票唯一有害的部分套用情境。
--
-- 🔴 為何必為兩支(不能合併成 BEFORE INSERT OR UPDATE):
--    UPDATE 側的 WHEN 需引用 OLD,而 OLD 在 INSERT 的 WHEN 子句中不存在,
--    語法即錯。與 CB-77 同一個約束。
--
-- UPDATE 側加 WHEN:不加的話,每一次改金額/備註的 UPDATE 都會付出一次
--    dealers 查詢。加了之後只有 status 真的變動才觸發。
-- INSERT 側不加 WHEN:INSERT 頻率低(每張單一次),且加 WHEN 就得寫成
--    負向形式(NEW.status IS DISTINCT FROM 'Draft'),與正向識別原則衝突。
--    判斷全部留在函式體內。
--
-- 🔴 命名是功能不變量 —— 詳見 COMMENT ON TRIGGER。
-- ============================================================================

DO $cb76_trg$
BEGIN
  PERFORM _ops.assert_env('production');

  -- ── 前置條件 ①:Segment 1 的欄位,且必須是 NOT NULL ──────────────────
  --   函式以 v_account_type IS NULL 判定「查無列」。若本欄可為 NULL,
  --   該判斷會把「有列但值為 NULL」誤報成 FK 失效。
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.dealers'::regclass
      AND attname  = 'account_type'
      AND attnotnull
      AND attnum > 0 AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION
      'ABORT: public.dealers.account_type 不存在或非 NOT NULL → Segment 1 未執行或失敗。'
      ' 未建立任何 trigger,無任何改動。';
  END IF;

  -- ── 前置條件 ②:Segment 2 的函式 ──────────────────────────────────────
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'block_trial_status_change'
      AND p.prorettype = 'pg_catalog.trigger'::regtype
      AND p.prosecdef
  ) THEN
    RAISE EXCEPTION
      'ABORT: public.block_trial_status_change() 不存在或非 SECURITY DEFINER'
      ' → Segment 2 未執行或失敗。未建立任何 trigger,無任何改動。';
  END IF;

  -- ── 前置條件 ③:位元序 —— 本 trigger 必須早於 F2 與 CB-77 記錄 trigger ──
  --   PostgreSQL 對同一 timing 的多個 row trigger 依【名稱位元序】執行。
  --   COLLATE "C" 明示位元序 —— DB 預設 collation 未必等同位元序。
  IF NOT (('trg_block_trial_status_change' COLLATE "C")
        < ('trg_enforce_dealer_quote_transition' COLLATE "C")) THEN
    RAISE EXCEPTION
      'ABORT: trial trigger 的名稱未早於 F2 → 執行順序前提失效。無任何改動。';
  END IF;

  IF NOT (('trg_block_trial_status_change' COLLATE "C")
        < ('trg_record_status_history' COLLATE "C")) THEN
    RAISE EXCEPTION
      'ABORT: trial trigger 的名稱未早於 CB-77 記錄 trigger → 無任何改動。';
  END IF;

  -- ── 前置條件 ④:F2 與 CB-77 三支既有 trigger 仍存在且啟用 ───────────────
  IF (SELECT count(*) FROM pg_catalog.pg_trigger
      WHERE tgrelid = 'public.quotes'::regclass
        AND NOT tgisinternal
        AND tgenabled = 'O'
        AND tgname IN ('trg_enforce_dealer_quote_transition',
                       'trg_record_status_history',
                       'trg_record_status_history_on_insert')) <> 3 THEN
    RAISE EXCEPTION
      'ABORT: F2 / CB-77 的三支既有 trigger 未全數存在且啟用 → 順序前提失效。無任何改動。';
  END IF;

  -- ── 冪等:先移除舊版(若有)────────────────────────────────────────────
  DROP TRIGGER IF EXISTS trg_block_trial_status_change   ON public.quotes;
  DROP TRIGGER IF EXISTS trg_block_trial_status_on_insert ON public.quotes;

  CREATE TRIGGER trg_block_trial_status_change
    BEFORE UPDATE ON public.quotes
    FOR EACH ROW
    WHEN (OLD.status IS DISTINCT FROM NEW.status)
    EXECUTE FUNCTION public.block_trial_status_change();

  CREATE TRIGGER trg_block_trial_status_on_insert
    BEFORE INSERT ON public.quotes
    FOR EACH ROW
    EXECUTE FUNCTION public.block_trial_status_change();

  RAISE NOTICE 'CB-76 Segment 3 完成:兩支 trigger 均已建立。';
END
$cb76_trg$;


-- ============================================================================
-- Segment 3b / 4   文件(零行為影響,不綁入原子單元)
-- ============================================================================

COMMENT ON COLUMN public.dealers.account_type IS
$doc$CB-76 Dealer 帳號類別。role 的子分類,不取代 role。

  dealer            預設。行為無變化。
  internal_account  純標記,未來串聯匯出用。行為無變化。
  location          🔴 停用所有 email(含內部信)。暫時性決定 —— 現階段
                    Location 僅為公司內部用 portal 處理訂單的工具,
                    訂單由內部同仁直接處理,不依賴通知觸發。
  trial             🔴 只允許 status = 'Draft'。供潛在客戶操作 portal
                    評估易用性;若能送出即產生真實 PO 號碼,而 PO 走
                    MAX()+1 而非 SEQUENCE(F-28),一旦與真實訂單交錯
                    即為不可逆污染。

🔴 顯示名與本欄的值可分離:前端以正向 map 轉換,查無即印 DB 原值
   (壞掉看得見)。DB 的 canonical 值不得為了顯示而改動。

🔴 Location 停信為【可逆判斷】:四支 Edge Function 以常數陣列
   EMAIL_SUPPRESSED_ACCOUNT_TYPES 驅動早退,寄信程式碼一行未刪。
   未來開放 Location portal 時,從陣列移除 'location' 即恢復。
   📌 恢復時必須一併確認 send-payment-email 的 E1a「New Payment Submitted」
      與 create-dealer 的 welcome 信,否則 location 客戶付款後無人開立
      invoice、且新帳號無從取得初始密碼(隨機密碼僅存在於 welcome 信
      的 HTML,console.log 不含)。$doc$;


COMMENT ON TRIGGER trg_block_trial_status_change ON public.quotes IS
$doc$CB-76 Trial 狀態攔截 — status 變更時檢查,非 'Draft' 即拒絕。

🔴 兩條不變量,任一失守 status_history 即可能出現從未發生的轉移:

  (1) 本 trigger 必須排在 trg_record_status_history 之前
      (COLLATE "C" 位元序 'b' < 'r')。

  (2) 🔴 本 trigger 的拒絕形式必須是 RAISE EXCEPTION,
      【不得】改為「將 NEW.status 強制回寫為 'Draft' 後 RETURN NEW」。

⚠️ 為何 (2) 才是第一道、(1) 只是防禦縱深:
   在 RAISE EXCEPTION 前提下,record_status_history 先跑【不會】產生
   幻影紀錄 —— 它只做 NEW.status_history := ... 的記憶體賦值,而 BEFORE
   ROW trigger 對 NEW 的修改要到該列實際寫入 tuple 時才落地;任一 BEFORE
   trigger 拋例外即中止整個 statement,該列從未寫入,賦值連同整次 UPDATE
   一併蒸發。
   真正會產生幻影紀錄的唯一實作,是「列仍被寫入」的那一種 —— 即狀態
   強制回寫。只寫 (1) 不寫 (2),下一個人會以為排序本身就足夠。

⚠️ 與 new-quote-step3.html 前端硬檔的分工(不可只留其一):
   只有本 trigger → submitQuote 分支 3 的順序是 UPDATE → quote_items
   DELETE → RPC,三者是三次獨立的 PostgREST 請求 = 三個 transaction;
   例外在 RPC 才拋出時,前兩次已 commit → 每次 trial 送出都留下一張沒有
   品項的空殼 draft。這不是機率問題,是必然。
   只有前端硬檔 → 可被 URL / DevTools 繞過。

⚠️ 此結論的前提:F2 與 CB-77 兩支 UPDATE trigger 存在、為 BEFORE
   FOR EACH ROW、且 tgenabled = 'O'。前提若變動,須重新驗證。
   (2026-08-22 已查證 staging 與 production 兩環境皆成立。)$doc$;


COMMENT ON TRIGGER trg_block_trial_status_on_insert ON public.quotes IS
$doc$CB-76 Trial 狀態攔截 — 建單時檢查(Q-5)。

與 trg_block_trial_status_change 共用 public.block_trial_status_change(),
單一函式服務兩條路徑 —— 判斷不可能分歧。

無 WHEN 子句 —— 判斷全部留在函式體內。加 WHEN 就得寫成負向形式
(NEW.status IS DISTINCT FROM 'Draft'),與正向識別原則(F-35)衝突。

⚠️ 為何 INSERT 側也必須攔:new-quote-step3.html 的 A-mode(未存草稿
   直接 Submit)是直接 INSERT 一列 status:'Draft'。若只掛 UPDATE,
   一支繞過前端、帶 status:'Stock Review' 的 INSERT 即可穿透,
   且【沒有任何症狀】。

🔴 關於 dealer_id IS NULL 被拒絕 —— 這是副作用,不是目的(CB-76 Q-24):
   本 trigger 的【目的】是攔截 trial 帳號的狀態推進。
   判斷 account_type 必須先能定位 dealers 列,無 dealer_id 即無從判斷;
   放行等同開一條「先建無主單、再推進狀態」的繞道,故拒絕。
   其效果是:今後任何 dealer_id IS NULL 的 quote 都無法被建立 ——
   等於在建單路徑上把 quotes.dealer_id 變成事實上的 NOT NULL,
   而這是對【所有 dealer】的行為改變,不只 trial。
   實務影響為零(2026-08-22 查證:兩環境 dealer_id IS NULL 皆 0 列;
   resolveDealerId() 查不到即 throw;baseFields 恆含 dealer_id)。

   🔴 這【不】代表 CB-76 對 quotes.dealer_id 的可空性有任何主張。
      若日後有業務需求要允許 dealer_id IS NULL 的 quote,本 trigger 是
      【必須一併重新設計】的對象,而不是一道應該被繞過的阻礙。
      相關債務見 F-100(建議對該欄補 NOT NULL)。$doc$;


-- ── Q-13:重寫 CB-77 的 COMMENT,追加 CB-76 兩支 trigger 的存在與位置 ────────
-- 🔴 COMMENT ON 是【整體覆寫】,無法「追加」。以下 CB-77 原文為程式化逐字
--    複製,未經人工轉錄。🔴 不編輯已 promote 的 CB-77 migration 檔本身。
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
   -> AFTER 方案在本表功能上不可行,非僅效能較差。

-- ── CB-76 追加(2026-08-22)────────────────────────────────────────────────
本表現有【五支】trigger,BEFORE 的位元序執行順序為:
  trg_block_trial_status_change        (CB-76, BEFORE UPDATE, WHEN status 變更)
  trg_enforce_dealer_quote_transition  (F2,    BEFORE UPDATE)
  trg_record_status_history            (CB-77, BEFORE UPDATE, WHEN status 變更)
  ── 以下為 INSERT 側,與上列不同事件,無先後關係 ──
  trg_block_trial_status_on_insert     (CB-76, BEFORE INSERT)
  trg_record_status_history_on_insert  (CB-77, BEFORE INSERT)

CB-76 的兩支刻意排在 F2 【之前】('b' < 'e' < 'r'),理由:
  (1) 不觸發 CB-77 Segment 4 針對「排在 F2 與本 trigger 之間」的 RAISE WARNING;
  (2) 錯誤訊息優先權 —— 先拋例外者勝出,trial 帳號取得的是可行動的訊息,
      而非 F2 的泛用 42501;
  (3) CB-76 的 trigger 不修改 NEW 任何欄位,故不會在 F2 Case 2 的整列凍結
      比對中製造差異。

📌 CB-77 Segment 4「人眼複核 A」原註記「預期 3 列」,CB-76 之後為【5 列】。
   依 CB-76 Q-13,不編輯已 promote 的 CB-77 migration 檔 ——
   「檔案內容 = 實際執行內容」是重建歷史時唯一可信的依據。$doc$;


-- ============================================================================
-- Segment 4 / 4   驗證
-- ----------------------------------------------------------------------------
-- 硬斷言:任一不成立即 RAISE EXCEPTION,不得僅回報。
-- ============================================================================

DO $cb76_verify$
DECLARE
  v_n      integer;
  v_def    text;
  v_config text[];
BEGIN
  PERFORM _ops.assert_env('production');

  -- (1) 欄位存在、NOT NULL、default = 'dealer'
  SELECT count(*) INTO v_n
  FROM pg_catalog.pg_attribute a
  LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE a.attrelid = 'public.dealers'::regclass
    AND a.attname  = 'account_type'
    AND a.attnotnull
    AND pg_catalog.pg_get_expr(d.adbin, d.adrelid) = '''dealer''::text';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'ASSERT 1 失敗:account_type 欄位不存在 / 非 NOT NULL / default 不符。';
  END IF;

  -- (2) CHECK 約束存在且涵蓋四值
  SELECT pg_catalog.pg_get_constraintdef(oid) INTO v_def
  FROM pg_catalog.pg_constraint
  WHERE conrelid = 'public.dealers'::regclass
    AND conname  = 'dealers_account_type_check';
  IF v_def IS NULL
     OR v_def NOT LIKE '%dealer%'
     OR v_def NOT LIKE '%internal_account%'
     OR v_def NOT LIKE '%location%'
     OR v_def NOT LIKE '%trial%' THEN
    RAISE EXCEPTION 'ASSERT 2 失敗:dealers_account_type_check 不存在或未涵蓋四值。實際 = %', v_def;
  END IF;

  -- (3) 函式存在、SECURITY DEFINER、search_path 正確
  SELECT p.proconfig INTO v_config
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'block_trial_status_change'
    AND p.prorettype = 'pg_catalog.trigger'::regtype
    AND p.prosecdef;
  IF v_config IS NULL OR NOT (v_config @> ARRAY['search_path=public, pg_temp']) THEN
    RAISE EXCEPTION
      'ASSERT 3 失敗:函式不存在 / 非 SECURITY DEFINER / search_path 不符。實際 proconfig = %', v_config;
  END IF;

  -- (4) 兩支 CB-76 trigger 皆存在且啟用
  SELECT count(*) INTO v_n
  FROM pg_catalog.pg_trigger
  WHERE tgrelid = 'public.quotes'::regclass
    AND NOT tgisinternal
    AND tgenabled = 'O'
    AND tgname IN ('trg_block_trial_status_change', 'trg_block_trial_status_on_insert');
  IF v_n <> 2 THEN
    RAISE EXCEPTION
      'ASSERT 4 失敗:CB-76 trigger 啟用數 = %(應為 2)。'
      ' 🔴 若為 1 = 危險的部分套用狀態(A-mode INSERT 或 UPDATE 其一未受保護),'
      ' 請立即執行 ROLLBACK R-1 後重跑 Segment 3。', v_n;
  END IF;

  -- (5)(6) 位元序
  IF NOT (('trg_block_trial_status_change' COLLATE "C")
        < ('trg_enforce_dealer_quote_transition' COLLATE "C")) THEN
    RAISE EXCEPTION 'ASSERT 5 失敗:trial trigger 未早於 F2。';
  END IF;
  IF NOT (('trg_block_trial_status_change' COLLATE "C")
        < ('trg_record_status_history' COLLATE "C")) THEN
    RAISE EXCEPTION 'ASSERT 6 失敗:trial trigger 未早於 CB-77 記錄 trigger。';
  END IF;

  -- (7) F2 與 CB-77 三支既有 trigger 未受影響
  SELECT count(*) INTO v_n
  FROM pg_catalog.pg_trigger
  WHERE tgrelid = 'public.quotes'::regclass
    AND NOT tgisinternal
    AND tgenabled = 'O'
    AND tgname IN ('trg_enforce_dealer_quote_transition',
                   'trg_record_status_history',
                   'trg_record_status_history_on_insert');
  IF v_n <> 3 THEN
    RAISE EXCEPTION 'ASSERT 7 失敗:F2 / CB-77 既有 trigger 啟用數 = %(應為 3)。', v_n;
  END IF;

  -- (8) 既有 dealers 列全部回填為 'dealer'
  SELECT count(*) INTO v_n
  FROM public.dealers
  WHERE account_type IS DISTINCT FROM 'dealer';
  IF v_n <> 0 THEN
    RAISE EXCEPTION
      'ASSERT 8 失敗:有 % 列的 account_type 非 dealer。首次上線時應為 0;'
      ' 若為重跑且已有分類資料,請人工確認後改以人眼複核 C 檢視。', v_n;
  END IF;

  RAISE NOTICE 'CB-76 Segment 4:八項硬斷言全數通過。';
END
$cb76_verify$;


-- ── 人眼複核 A:quotes 的 trigger 清單  🔴 預期【5 列】,順序如下 ────────────
--   trg_block_trial_status_change        BEFORE  f/t  O
--   trg_block_trial_status_on_insert     BEFORE  t/f  O
--   trg_enforce_dealer_quote_transition  BEFORE  f/t  O
--   trg_record_status_history            BEFORE  f/t  O
--   trg_record_status_history_on_insert  BEFORE  t/f  O
--   📌 CB-77 Segment 4 原註記「預期 3 列」,CB-76 之後為 5 列(Q-13)。
WITH guard AS MATERIALIZED (SELECT _ops.assert_env('production') AS ok)
SELECT current_database()                         AS db,
       (SELECT name        FROM _ops.environment) AS env_name,
       t.tgname                                   AS trigger_name,
       CASE WHEN (t.tgtype & 2) > 0 THEN 'BEFORE' ELSE 'AFTER' END AS timing,
       (t.tgtype & 4)  > 0                        AS on_insert,
       (t.tgtype & 16) > 0                        AS on_update,
       t.tgenabled                                AS enabled,
       p.proname                                  AS function_name
FROM pg_catalog.pg_trigger t
CROSS JOIN guard
JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
WHERE t.tgrelid = 'public.quotes'::regclass
  AND NOT t.tgisinternal
ORDER BY t.tgname COLLATE "C";


-- ── 人眼複核 B:DOC-1 §9 稽核 —— 基線 6/8 → 7/9 ─────────────────────────────
WITH guard AS MATERIALIZED (SELECT _ops.assert_env('production') AS ok)
SELECT current_database()                         AS db,
       (SELECT name        FROM _ops.environment) AS env_name,
       p.proname                                  AS function_name,
       p.prosecdef                                AS is_security_definer,
       p.proconfig                                AS proconfig
FROM pg_catalog.pg_proc p
CROSS JOIN guard
JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.prosecdef
ORDER BY p.proname;


-- ── 人眼複核 C:account_type 分佈 ──────────────────────────────────────────
WITH guard AS MATERIALIZED (SELECT _ops.assert_env('production') AS ok)
SELECT current_database()                         AS db,
       (SELECT name        FROM _ops.environment) AS env_name,
       d.account_type,
       count(*)                                   AS n
FROM public.dealers d
CROSS JOIN guard
GROUP BY ROLLUP (d.account_type)
ORDER BY d.account_type NULLS LAST;


-- ============================================================================
-- Segment R   ROLLBACK   🔴 全部註解掉,需要時才逐段解開
-- ----------------------------------------------------------------------------
-- R-1 與 R-2/R-3/R-4 刻意分離:止血不該需要破壞資料。
-- ============================================================================

-- ── R-1  止血:停止 trial 攔截。🟢 不損任何資料,可獨立執行 ─────────────────
--   適用情境:攔截誤傷正常 dealer、或 ASSERT 4 顯示只建了一支 trigger。
-- DO $cb76_rb1$
-- BEGIN
--   PERFORM _ops.assert_env('production');
--   DROP TRIGGER IF EXISTS trg_block_trial_status_change    ON public.quotes;
--   DROP TRIGGER IF EXISTS trg_block_trial_status_on_insert ON public.quotes;
--   RAISE NOTICE 'CB-76 R-1:兩支 trigger 已移除,攔截已停止。';
-- END
-- $cb76_rb1$;

-- ── R-2  移除函式(選用,須先執行 R-1)───────────────────────────────────
-- DO $cb76_rb2$
-- BEGIN
--   PERFORM _ops.assert_env('production');
--   DROP FUNCTION IF EXISTS public.block_trial_status_change();
--   RAISE NOTICE 'CB-76 R-2:函式已移除。';
-- END
-- $cb76_rb2$;

-- ── R-3  移除 CHECK 約束(選用)──────────────────────────────────────────
-- DO $cb76_rb3$
-- BEGIN
--   PERFORM _ops.assert_env('production');
--   ALTER TABLE public.dealers DROP CONSTRAINT IF EXISTS dealers_account_type_check;
--   RAISE NOTICE 'CB-76 R-3:CHECK 約束已移除。';
-- END
-- $cb76_rb3$;

-- ── R-4  🔴 移除欄位 —— 不可逆,會永久刪除所有 category 標記 ───────────────
--   🔴 執行前必須先跑人眼複核 C 並保留輸出。若已有 location / trial 帳號,
--      這些標記將無法還原。非到必要不要執行。
-- DO $cb76_rb4$
-- BEGIN
--   PERFORM _ops.assert_env('production');
--   ALTER TABLE public.dealers DROP COLUMN IF EXISTS account_type;
--   RAISE NOTICE 'CB-76 R-4:欄位已移除(不可逆)。';
-- END
-- $cb76_rb4$;

-- ── R-5  還原 CB-77 的 COMMENT(選用,僅在完整回滾時)────────────────────
--   Segment 3b 覆寫了 trg_record_status_history 的 COMMENT。若要還原,
--   請自 migrations/2026-08-21_CB-77_status-history-trigger__STAGING.sql
--   複製其 COMMENT ON TRIGGER 區段原文重跑。🔴 該檔本身不得修改。
