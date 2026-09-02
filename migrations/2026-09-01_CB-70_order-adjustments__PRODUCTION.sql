-- ════════════════════════════════════════════════════════════════════════
-- CB-70  Order-Level Adjustments — quotes 三個調整欄位 + 四條 CHECK
--
-- 環境: PRODUCTION
-- 日期: 2026-09-01
-- 前置: Stage 0 診斷完成 (S-1 ~ S-7 雙環境)
--
-- 本檔建立:
--   1. public.quotes 三個欄位
--        account_credit_amount   / manager_discount_amount / handling_fee_amount
--   2. 四條具名 CHECK 約束 (三條單欄正負 + 一條合計非負)
--   3. 三則 COMMENT ON COLUMN
--
-- 🔴 本檔【不含】任何 trigger、function、RLS 變更 —— quotes 的 RLS 與
--    trigger 現況已於 Stage 0 S-3 / S-6 / S-7 完整查證,本票不動既有物件。
--
-- 🔴 欄位層級保護【不存在也不建立】:
--    S-3 證實 dealer_update_own_quotes_when_editable 的 WITH CHECK 只查
--    dealer_id + status;S-7 證實 enforce_dealer_quote_transition 的 Case 1
--    (Draft/Returned) 對非 status 欄位完全放行。故 dealer 可經 REST 直接
--    寫入本檔三欄 —— 與 grand_total 現況完全相同,本票不擴大既有攻擊面。
--    (登記為 F-148,同 F-101 之於 dealers。本檔刻意不修。)
--
-- 🔴 本檔四條 CHECK 是這三欄【唯一】的 DB 層保護。Q-9 = C:
--    前端先攔並給人話訊息,CHECK 為最終防線,正常路徑永不觸及。
--
-- 相關: CB-47 (discount_total 先例)、CB-45 (一分容差斷言)、
--       F-117 (NULL 讓比對靜默失效)、CB-83 F-a (_ops.environment)
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

SELECT _ops.assert_env('production');

DO $cb70$
BEGIN

  -- ══ 1. 欄位 ══════════════════════════════════════════════════════════
  --
  -- 🔴 型別 numeric(10,2) 的依據 (Q-1):
  --    S-2 實查 quotes 的七個金額欄位,呈現兩套先例 ——
  --      subtotal / shipping_cost / tax_amount / grand_total /
  --      delivery_fee / assemble_total  ... numeric(10,2), NULLABLE
  --      discount_total (CB-47,最新)      ... numeric 無精度, NOT NULL DEFAULT 0
  --    本檔取【精度用多數派、nullability 用最新先例】的交集。
  --    numeric(10,2) 上限 99,999,999.99,遠超本系統任何可能金額。
  --    (discount_total 的無精度是既有不一致,登記 F-149,本檔不修。)
  --
  -- 🔴 numeric(10,2) 會在賦值時【靜默】四捨五入至 2 位小數。
  --    這與其餘六個金額欄位的既有行為完全相同,且前端一律以 round2()
  --    產生 2 位小數值後才送出,不存在分岔。⚠️ 但若日後有人繞過 round2
  --    直接送 3 位小數,DB 不會報錯,只會悄悄變成 2 位 —— 這是本欄位型別
  --    的已知靜默正規化,不是本票新增的風險,但值得知道。
  --
  -- 🔴 NOT NULL DEFAULT 0 的依據 (Q-10):
  --    本票三欄的「未填」與「填 0」語意完全相同,不需要 CB-77 Q-3 那種
  --    「NULL = 上線前舊單」的二分語意。DEFAULT 0 使既有訂單的
  --    live grand 零變動 (加 0),符合已拍板「不改既有訂單金額」。
  --    PostgreSQL 11+ 對常數 DEFAULT 的 ADD COLUMN 為 metadata-only,
  --    不重寫資料表;兩環境合計 157 列,成本可忽略。
  --
  -- 🔴 NOT NULL 是刻意的 fail-loud:
  --    若前端 hydration (Q-11 = A) 失效而送出 NULL,DB 會直接報錯,
  --    而不是靜默寫入一個空值。這正是本票最怕的失效模式的護欄 ——
  --    「admin 給的錢消失了,兩邊都不知道」。
  --
  -- 🔴 正負號存在資料裡,不靠欄位語意判斷 (Q-2 = 存負值):
  --    Account Credit 與 Manager Discount 一律存負值,所見即所存。
  --    前端 grand 公式因此一律用加號,不需要「這欄該加還是該減」的判斷 ——
  --    那會多一層可能出錯的地方。
  ALTER TABLE public.quotes
    ADD COLUMN IF NOT EXISTS account_credit_amount   numeric(10,2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS manager_discount_amount numeric(10,2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS handling_fee_amount     numeric(10,2) NOT NULL DEFAULT 0;

  RAISE NOTICE 'CB-70: 欄位段完成 (account_credit_amount / manager_discount_amount / handling_fee_amount)。';

  -- ══ 2. CHECK 約束 ════════════════════════════════════════════════════
  --
  -- 命名沿用既有 chk_quotes_discount_total_nonneg 的
  --   chk_<table>_<column>_<rule> 慣例 (S-4 實證)。
  --
  -- 🔴 建立時機安全性 (S-1 實證):
  --    staging 85 列 / production 72 列,subtotal 零 NULL 零負,
  --    最小值分別為 96.00 / 23.75;三個新欄位因 DEFAULT 0 全為 0.00。
  --    四條約束對既有列全數成立 → 不需要 NOT VALID,不需要分批,
  --    不需要回填。ADD CONSTRAINT 的全表掃描在此資料量下可忽略。
  --
  -- 🔴 冪等:CHECK 約束沒有 ADD CONSTRAINT IF NOT EXISTS 語法,
  --    故逐條查 pg_constraint。⚠️ 刻意不用 DROP CONSTRAINT IF EXISTS
  --    再重建 —— 那會在重跑時短暫讓約束消失,若同時有寫入即為空窗。

  -- ── 2-1  Account Credit 僅負 ──────────────────────────────────────────
  --   <= 0 而非 < 0:0 是合法值 (= 未使用),NOT NULL DEFAULT 0 的所有既有
  --   列都是 0。若寫 < 0,ADD CONSTRAINT 當場就會失敗。
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.quotes'::regclass
      AND conname  = 'chk_quotes_account_credit_nonpos'
  ) THEN
    ALTER TABLE public.quotes
      ADD CONSTRAINT chk_quotes_account_credit_nonpos
      CHECK (account_credit_amount <= 0);
    RAISE NOTICE 'CB-70: chk_quotes_account_credit_nonpos 已建立。';
  ELSE
    RAISE NOTICE 'CB-70: chk_quotes_account_credit_nonpos 已存在,略過。';
  END IF;

  -- ── 2-2  Manager Discount 僅負 ────────────────────────────────────────
  --   🔴 與 2-1 的系統行為【完全相同】,差別純粹在語意 (業主原話:
  --      「它的系統運作相同,但是我們讀到語意會差很多」)。
  --      這正是本票不做原因下拉選單的理由 —— 欄位名本身就是分類。
  --   ⚠️ 日後若有人發現兩條約束一模一樣而想合併成一條、或把兩欄併成
  --      「一欄金額 + 一欄類型」—— 不可以。合併會摧毀「欄位名即語意」
  --      這個設計的全部價值,並且逼出一個原因欄位。
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.quotes'::regclass
      AND conname  = 'chk_quotes_manager_discount_nonpos'
  ) THEN
    ALTER TABLE public.quotes
      ADD CONSTRAINT chk_quotes_manager_discount_nonpos
      CHECK (manager_discount_amount <= 0);
    RAISE NOTICE 'CB-70: chk_quotes_manager_discount_nonpos 已建立。';
  ELSE
    RAISE NOTICE 'CB-70: chk_quotes_manager_discount_nonpos 已存在,略過。';
  END IF;

  -- ── 2-3  Handling Fee 僅正 ────────────────────────────────────────────
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.quotes'::regclass
      AND conname  = 'chk_quotes_handling_fee_nonneg'
  ) THEN
    ALTER TABLE public.quotes
      ADD CONSTRAINT chk_quotes_handling_fee_nonneg
      CHECK (handling_fee_amount >= 0);
    RAISE NOTICE 'CB-70: chk_quotes_handling_fee_nonneg 已建立。';
  ELSE
    RAISE NOTICE 'CB-70: chk_quotes_handling_fee_nonneg 已存在,略過。';
  END IF;

  -- ── 2-4  🔴 合計非負 ──────────────────────────────────────────────────
  --
  -- 這是四層防呆中【最重要】的一層:單看每一欄都合法,但加起來可能是負的。
  -- 負的調整後小計會造成:稅變負、grand_total 錯誤、PDF 顯示異常。
  --
  -- 🔴 coalesce(subtotal, 0) 不是防禦性冗餘,是必要的:
  --    subtotal 為 NULLABLE (S-2 實證)。NULL 參與算術的結果是 NULL,
  --    而 CHECK 對 NULL 的判定是【通過】。若不加 coalesce,一張
  --    subtotal IS NULL 的單可以塞進任何負數,本約束完全不作用 ——
  --    而且不會報錯,是靜默失效。
  --    📌 與 F-117 (quotes.status 可為 NULL,= ANY 不擋 NULL) 同族:
  --       NULL 讓比對靜默失效。
  --    現況兩環境 subtotal 零 NULL,但約束不能建立在「目前剛好沒有」之上。
  --
  -- 🔴 三個新欄位不加 coalesce,理由是它們為 NOT NULL。
  --    ⚠️ 若日後有人放寬其中任一欄為 NULLABLE,【必須同時】把該欄包進
  --       coalesce,否則本約束會在那一刻靜默失效。
  --
  -- 🔴 本約束刻意【不含】mods / assemble / shipping / tax:
  --    已拍板的稅基為 subtotal + taxableMods + 三項,但 mods 不是 quotes
  --    的欄位 (存於 quote_items),CHECK 無法跨表。本約束守的是
  --    「subtotal 這一層不會被三項打成負數」,是保守下界而非完整稅基 ——
  --    真正的稅基永遠 >= 本式,故本式成立即稅基必然非負。
  --    ⚠️ 這是刻意的保守,不是遺漏。跨表檢查需要 trigger,成本與本票
  --       的風險不成比例。
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.quotes'::regclass
      AND conname  = 'chk_quotes_adjusted_subtotal_nonneg'
  ) THEN
    ALTER TABLE public.quotes
      ADD CONSTRAINT chk_quotes_adjusted_subtotal_nonneg
      CHECK (
        coalesce(subtotal, 0)
        + account_credit_amount
        + manager_discount_amount
        + handling_fee_amount
        >= 0
      );
    RAISE NOTICE 'CB-70: chk_quotes_adjusted_subtotal_nonneg 已建立。';
  ELSE
    RAISE NOTICE 'CB-70: chk_quotes_adjusted_subtotal_nonneg 已存在,略過。';
  END IF;

  RAISE NOTICE 'CB-70: 約束段完成 (4 條)。';

END
$cb70$;

-- ══ 3. COMMENT ═════════════════════════════════════════════════════════
-- 🔴 置於 DO 區塊外,沿用 CB-82 的既有形態。COMMENT 為冪等操作
--    (重複執行即覆寫),不需要存在性判斷。

COMMENT ON COLUMN public.quotes.account_credit_amount IS
  'CB-70 訂單層級調整:客戶在 ProCraft 累積的餘額(可能是先前超收),類似回饋。'
  '🔴 恆為負值或 0(所見即所存,前端不做正負轉換)。'
  '🔴 系統【不追蹤餘額】—— 累計金額由業主自行於系統外計算,本欄只記錄本張單用掉多少。'
  '🔴 與 manager_discount_amount 的系統行為完全相同,差別純粹在語意 —— '
  '欄位名本身就是分類,故本票刻意不做原因下拉選單。勿合併兩欄。'
  '進稅基。不進 billingBase(運費級距不受影響)。super_admin/admin 才可填寫;'
  'dealer 唯讀可見,PDF 亦顯示(Draft Quote 除外,見 pdf-builder _hideCredit)。';

COMMENT ON COLUMN public.quotes.manager_discount_amount IS
  'CB-70 訂單層級調整:一般性折讓。'
  '🔴 恆為負值或 0。'
  '🔴 與 account_credit_amount 的系統行為完全相同,差別純粹在語意。勿合併兩欄。'
  '🔴 與 CB-47 personal discount(discount_total)為【疊加】關係:'
  '先套 personal discount 得 subtotal,最後才套本欄 —— 兩者不是同一層,勿混用。'
  '進稅基。不進 billingBase。super_admin/admin 才可填寫;dealer 唯讀可見。';

COMMENT ON COLUMN public.quotes.handling_fee_amount IS
  'CB-70 訂單層級調整:處理費。'
  '🔴 恆為正值或 0。'
  '🔴 進稅基 —— 已拍板「三者全部進稅基,含 Handling Fee」,不是漏掉。'
  '不進 billingBase(運費為手動輸入,無級距重算問題)。'
  'super_admin/admin 才可填寫;dealer 唯讀可見,PDF 顯示(Draft Quote 亦顯示 —— '
  '與另兩欄不同,因本欄是 dealer 實付成本而非 ProCraft 對 dealer 的讓利)。';

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- 驗證(COMMIT 後另跑,唯讀)
--
-- 🔴 環境自我標示一律用 (SELECT name FROM _ops.environment),
--    【不用】current_database() —— CB-83 F-a:兩個 Supabase 專案的資料庫名
--    皆為 'postgres',current_database() 無法區分環境。
--    (CB-82 等較早的 migration 仍用 current_database(),那是舊寫法,勿沿用。)
-- 🔴 跨環境比對用,全部帶 ORDER BY(CB-85:無排序造成假差異)。
-- ════════════════════════════════════════════════════════════════════════
-- -- V1 欄位定義
-- SELECT (SELECT name FROM _ops.environment) AS env, 'V1' AS v,
--        column_name, data_type, numeric_precision, numeric_scale,
--        is_nullable, column_default
-- FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'quotes'
--   AND column_name IN ('account_credit_amount','manager_discount_amount','handling_fee_amount')
-- ORDER BY column_name;
--
-- -- V2 四條約束
-- SELECT (SELECT name FROM _ops.environment) AS env, 'V2' AS v,
--        conname, pg_get_constraintdef(oid) AS definition, convalidated
-- FROM pg_constraint
-- WHERE conrelid = 'public.quotes'::regclass AND contype = 'c'
-- ORDER BY conname;
--
-- -- V3 既有列全數為 0(舊單金額零變動的實證)
-- SELECT (SELECT name FROM _ops.environment) AS env, 'V3' AS v,
--        count(*) AS total,
--        count(*) FILTER (WHERE account_credit_amount   <> 0) AS credit_nonzero,
--        count(*) FILTER (WHERE manager_discount_amount <> 0) AS mgrdisc_nonzero,
--        count(*) FILTER (WHERE handling_fee_amount     <> 0) AS handling_nonzero
-- FROM public.quotes;
--
-- -- V4 grand 殘差回歸基線(對照 Stage 0 的 S-5;此時應與 S-5 結果完全相同)
-- SELECT (SELECT name FROM _ops.environment) AS env, 'V4' AS v,
--        q.status, count(*) AS cnt,
--        count(*) FILTER (
--          WHERE round(coalesce(q.grand_total,0) - coalesce(q.subtotal,0)
--                      - coalesce(q.assemble_total,0) - coalesce(q.shipping_cost,0)
--                      - coalesce(q.tax_amount,0), 2) < 0
--        ) AS residual_negative
-- FROM public.quotes q
-- GROUP BY q.status
-- ORDER BY q.status;
--
-- -- V5 三則 COMMENT 已寫入
-- SELECT (SELECT name FROM _ops.environment) AS env, 'V5' AS v,
--        a.attname, col_description(a.attrelid, a.attnum) AS comment
-- FROM pg_attribute a
-- WHERE a.attrelid = 'public.quotes'::regclass
--   AND a.attname IN ('account_credit_amount','manager_discount_amount','handling_fee_amount')
-- ORDER BY a.attname;

-- ════════════════════════════════════════════════════════════════════════
-- 約束實測(COMMIT 後另跑;刻意寫成會失敗的形式,用來確認 fail-loud)
-- 🔴 每一條都必須【報錯】才算通過。若任何一條成功執行,該層防呆是失效的。
-- 🔴 全部包在 BEGIN/ROLLBACK 內,不留痕跡。請逐條單獨執行。
-- ════════════════════════════════════════════════════════════════════════
-- -- T1 Account Credit 填正數 → 應違反 chk_quotes_account_credit_nonpos
-- -- BEGIN; UPDATE public.quotes SET account_credit_amount = 1
-- --        WHERE id = (SELECT id FROM public.quotes ORDER BY created_at LIMIT 1); ROLLBACK;
--
-- -- T2 Manager Discount 填正數 → 應違反 chk_quotes_manager_discount_nonpos
-- -- BEGIN; UPDATE public.quotes SET manager_discount_amount = 1
-- --        WHERE id = (SELECT id FROM public.quotes ORDER BY created_at LIMIT 1); ROLLBACK;
--
-- -- T3 Handling Fee 填負數 → 應違反 chk_quotes_handling_fee_nonneg
-- -- BEGIN; UPDATE public.quotes SET handling_fee_amount = -1
-- --        WHERE id = (SELECT id FROM public.quotes ORDER BY created_at LIMIT 1); ROLLBACK;
--
-- -- T4 🔴 逐欄合法但合計為負 → 應違反 chk_quotes_adjusted_subtotal_nonneg
-- --    這是四條裡最關鍵的一條:T1~T3 全過但 T4 失效 = 防呆只擋得住手滑,
-- --    擋不住真正會出事的情況。
-- -- BEGIN; UPDATE public.quotes
-- --        SET account_credit_amount = -999999, manager_discount_amount = -1
-- --        WHERE id = (SELECT id FROM public.quotes ORDER BY created_at LIMIT 1); ROLLBACK;
--
-- -- T5 合計恰為 0 → 應【成功】(邊界值,證明約束不是過度嚴格)
-- -- BEGIN; UPDATE public.quotes
-- --        SET account_credit_amount = -subtotal
-- --        WHERE id = (SELECT id FROM public.quotes WHERE subtotal IS NOT NULL
-- --                    ORDER BY created_at LIMIT 1); ROLLBACK;

-- ════════════════════════════════════════════════════════════════════════
-- ROLLBACK(刻意不含 assert_env —— 沿用 F1 慣例)
-- ⚠️ 前端若已上線,回滾 DB 會讓四條寫入路徑撞 "column does not exist"。
--    回滾順序必須是【先退前端、再退 DB】。
-- ════════════════════════════════════════════════════════════════════════
-- ALTER TABLE public.quotes DROP CONSTRAINT IF EXISTS chk_quotes_adjusted_subtotal_nonneg;
-- ALTER TABLE public.quotes DROP CONSTRAINT IF EXISTS chk_quotes_handling_fee_nonneg;
-- ALTER TABLE public.quotes DROP CONSTRAINT IF EXISTS chk_quotes_manager_discount_nonpos;
-- ALTER TABLE public.quotes DROP CONSTRAINT IF EXISTS chk_quotes_account_credit_nonpos;
-- ALTER TABLE public.quotes DROP COLUMN IF EXISTS handling_fee_amount;
-- ALTER TABLE public.quotes DROP COLUMN IF EXISTS manager_discount_amount;
-- ALTER TABLE public.quotes DROP COLUMN IF EXISTS account_credit_amount;
--   ⚠️ 三欄的資料無法復原。回滾前先確認無任何單已填入非 0 值
--      (可跑上方 V3 確認)。
