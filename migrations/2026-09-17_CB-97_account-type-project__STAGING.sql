-- ============================================================================
-- CB-97  Account Type 篩選 —— dealers.account_type 新增 'project'
-- 環境:STAGING (jkcbusliyrxbgebdrybl)
-- 日期:2026-09-17
-- ----------------------------------------------------------------------------
-- 🔴 一次貼一段、單獨執行。段落標示【原子單元】者必須整段一次執行。
--
-- 🔴 為何【不】編輯 CB-76 的 migration 原檔(CB-76 Q-13 原則,本票沿用):
--    2026-08-22_CB-76_account-type-and-trial-guard__STAGING.sql 的 Segment 1
--    寫著四值 CHECK,Segment 4 的 ASSERT 2 亦硬編碼比對四值。
--    「檔案內容 = 實際執行內容」是重建歷史時唯一可信的依據 ——
--    改那個檔會讓 2026-08-22 當天實際跑了什麼變成不可考。
--    ⚠️ 已知代價:CB-76 該檔【不可再重跑】—— 重跑會在 ASSERT 2 失敗
--       (屆時約束已含五值,而它期待四值)。這是預期的,不是缺陷。
--
-- promote 至 production:全檔共【5 處】_ops.assert_env('staging') 字面,
--    全部改為 'production',其餘一字不改。內訳:
--      可執行 4 處 — Segment 1 / Segment 2 斷言表 / Segment 2 約束定義原文
--                    / Segment 3 人眼複核
--      ROLLBACK 註解內 1 處 — R-1
--    ⚠️ 本行上方那句「全檔共 N 處」不計入 —— 它是說明,不是守衛。
--       以 Ctrl+F 搜 assert_env('staging') 會命中 6 次,第 1 次是這段註解。
--    🔴 ROLLBACK 那 1 處也要改:回滾 production 時若守衛還寫著 'staging',
--       解開註解就會被 assert_env 擋下,而那正是最不該卡住的時刻。
--
-- 🔴 部署順序(CB-97 Stage 1 拍板,不可調換):
--      U4(本檔)→ U5(五處 EF 常數)→ U1 ✅ → U2 → U3 → Q-8 測試帳號
--    本檔先行的理由:create-dealer 的 VALID_ACCOUNT_TYPES 與本 CHECK
--    是兩道各自獨立的關卡,兩道都放行才建得出 project 帳號。
--    ⚠️ 但【只做本檔】不會讓任何 project 帳號被建立 —— 前端尚無該選項,
--       EF 仍會以 VALID_ACCOUNT_TYPES 擋下。本檔單獨上線為零行為變更。
--
-- 段落:
--   1  DROP + ADD CHECK 約束(四值 → 五值)   【原子單元】
--   2  驗證(回傳結果集 —— 不用 RAISE NOTICE)
--   3  人眼複核:account_type × role 分佈
--   R  ROLLBACK(全部註解掉)
-- ============================================================================


-- ============================================================================
-- Segment 1 / 3   CHECK 約束 四值 → 五值   【原子單元 —— 必須整段一次執行】
-- ----------------------------------------------------------------------------
-- 🔴 DROP 與 ADD 必須在【同一個 DO 區塊】內:
--    DO 區塊是單一 statement,故具真正的原子性。
--    拆成兩條 ALTER 分別執行,中間會出現「欄位無任何 CHECK」的空窗 ——
--    Supabase SQL Editor 走連線池,兩次往返不保證同一條連線,
--    BEGIN; ... COMMIT; 在此不可靠(CB-71 教訓 / CB-76 已採同一做法)。
--    🔴 若 ADD 失敗,整個 DO 回滾,舊的四值約束原封不動留著 ——
--       這正是要的:失敗時保護不消失。
--
-- 🔴 冪等性以【約束定義是否已含 'project'】判斷,不以【約束是否存在】判斷。
--    後者會在重跑時直接跳過,讓舊的四值約束原樣留下並回報「已完成」——
--    「看起來成功但什麼都沒改」,正是本專案一路在防的形狀。
--
-- 🔴 DROP 之前先正向確認舊約束涵蓋 CB-76 的四值(前置條件 ②)。
--    若有人已手動改過這條約束,盲目 DROP + ADD 會把那次改動無聲抹掉。
--    不認識的定義 → 中止,讓人先去看清楚。
--
-- ⚠️ ALTER TABLE ADD CONSTRAINT 取 ACCESS EXCLUSIVE 鎖並驗證全表。
--    production 的 dealers 為 146 列,耗時可忽略。
-- ============================================================================

DO $cb97_check$
DECLARE
  v_def  text;
  v_bad  integer;
BEGIN
  PERFORM _ops.assert_env('staging');

  -- ── 前置條件 ①:欄位存在且為 NOT NULL ────────────────────────────────
  --   CB-76 的 block_trial_status_change() 以 v_account_type IS NULL 判定
  --   「查無列」。本欄若變成可為 NULL,該判斷會把「有列但值為 NULL」
  --   誤報成 FK 失效。本票不動該函式,但它的前提必須仍然成立。
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.dealers'::regclass
      AND attname  = 'account_type'
      AND attnotnull
      AND attnum > 0 AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION
      'ABORT: public.dealers.account_type 不存在或非 NOT NULL。'
      ' CB-76 Segment 1 的狀態已不成立 —— 未做任何改動。';
  END IF;

  SELECT pg_catalog.pg_get_constraintdef(oid) INTO v_def
  FROM pg_catalog.pg_constraint
  WHERE conrelid = 'public.dealers'::regclass
    AND conname  = 'dealers_account_type_check';

  -- ── 冪等:已含 project 即結束 ─────────────────────────────────────────
  IF v_def IS NOT NULL AND v_def LIKE '%project%' THEN
    RAISE EXCEPTION
      'ALREADY DONE: dealers_account_type_check 已涵蓋 project,未做任何改動。'
      ' 🟢 這【不是】錯誤 —— 以 EXCEPTION 而非 NOTICE 回報,是因為 NOTICE'
      ' 在 Supabase SQL Editor 可能不顯示,而「什麼都沒發生」與「已完成」'
      ' 在畫面上同形。請直接執行 Segment 2 驗證。實際定義 = %', v_def;
  END IF;

  -- ── 前置條件 ②:舊約束必須是 CB-76 那一條(正向認人)──────────────────
  IF v_def IS NULL THEN
    RAISE EXCEPTION
      'ABORT: dealers_account_type_check 不存在。本票的前提是 CB-76 已上線'
      ' 的四值約束;約束不在,代表狀態與預期不符 —— 未做任何改動。';
  END IF;
  IF v_def NOT LIKE '%dealer%'
     OR v_def NOT LIKE '%internal_account%'
     OR v_def NOT LIKE '%location%'
     OR v_def NOT LIKE '%trial%' THEN
    RAISE EXCEPTION
      'ABORT: 現有約束未涵蓋 CB-76 的四值,本票不認識它。'
      ' 盲目 DROP + ADD 會抹掉某次未記錄的改動 —— 未做任何改動。實際定義 = %',
      v_def;
  END IF;

  -- ── 前置條件 ③:現有資料必須全數落在新五值內 ──────────────────────────
  --   🔴 正向列舉(F-35),不寫 NOT IN。
  --   若有列落在五值之外,ADD CONSTRAINT 會失敗並回傳一個泛用的
  --   23514 訊息,看不出是哪一列。先查清楚再說。
  SELECT count(*) INTO v_bad
  FROM public.dealers
  WHERE account_type IS DISTINCT FROM 'dealer'
    AND account_type IS DISTINCT FROM 'internal_account'
    AND account_type IS DISTINCT FROM 'location'
    AND account_type IS DISTINCT FROM 'project'
    AND account_type IS DISTINCT FROM 'trial';
  IF v_bad > 0 THEN
    RAISE EXCEPTION
      'ABORT: 有 % 列的 account_type 不在新的五值之內,ADD CONSTRAINT 必定失敗。'
      ' 先執行 Segment 3 人眼複核查明是哪些列 —— 未做任何改動。', v_bad;
  END IF;

  -- ── 執行:DROP 後立即 ADD,同一 statement 內 ──────────────────────────
  ALTER TABLE public.dealers
    DROP CONSTRAINT dealers_account_type_check;

  ALTER TABLE public.dealers
    ADD CONSTRAINT dealers_account_type_check
    CHECK (account_type IN ('dealer', 'internal_account', 'location', 'project', 'trial'));
END
$cb97_check$;


-- ── 文件更新(零行為影響,可與 Segment 1 分開執行)────────────────────────
-- 🔴 COMMENT ON 是【整體覆寫】,無法「追加」。以下 CB-76 原文為程式化逐字
--    複製,僅新增 project 段落與 CB-97 註記。🔴 不編輯 CB-76 的 migration 檔。
COMMENT ON COLUMN public.dealers.account_type IS
$doc$CB-76 Dealer 帳號類別。role 的子分類,不取代 role。

  dealer            預設。行為無變化。
  internal_account  純標記,未來串聯匯出用。行為無變化。
  location          🔴 停用所有 email(含內部信)。暫時性決定 —— 現階段
                    Location 僅為公司內部用 portal 處理訂單的工具,
                    訂單由內部同仁直接處理,不依賴通知觸發。
  project           🔴 CB-97 新增。行為與 location 相同 —— 停用所有 email。
                    兩者是不同的帳號類別,故 badge 配色刻意不同;
                    但停信行為一致,五處常數一律兩值並列。
  trial             🔴 只允許 status = 'Draft'。供潛在客戶操作 portal
                    評估易用性;若能送出即產生真實 PO 號碼,而 PO 走
                    MAX()+1 而非 SEQUENCE(F-28),一旦與真實訂單交錯
                    即為不可逆污染。

🔴 顯示名與本欄的值可分離:前端以正向 map 轉換,查無即印 DB 原值
   (壞掉看得見)。DB 的 canonical 值不得為了顯示而改動。
   📌 CB-97 起,該 map 位於 components/account-type.js(單一真相),
      不再各頁自持。

🔴 Location / Project 停信為【可逆判斷】:四支 Edge Function 以常數陣列
   EMAIL_SUPPRESSED_ACCOUNT_TYPES 驅動早退,寄信程式碼一行未刪。
   未來開放時,從陣列移除該值即恢復。
   📌 恢復時必須一併確認 send-payment-email 的 E1a「New Payment Submitted」
      與 create-dealer 的 welcome 信,否則客戶付款後無人開立 invoice、
      且新帳號無從取得初始密碼(隨機密碼僅存在於 welcome 信的 HTML,
      console.log 不含)。

🔴 CB-97 實查補記 —— 本欄的值共有【五處】程式碼副本,不是四處:
     ① send-quote-email      EMAIL_SUPPRESSED_ACCOUNT_TYPES
     ② send-payment-email    EMAIL_SUPPRESSED_ACCOUNT_TYPES
     ③ send-followup-email   EMAIL_SUPPRESSED_ACCOUNT_TYPES
     ④ create-dealer         EMAIL_SUPPRESSED_ACCOUNT_TYPES
     ⑤ create-dealer         VALID_ACCOUNT_TYPES  ← 服務端值域驗證,易漏
   另有 admin-dealers.html 的 EMAIL_SUPPRESSED_ACCOUNT_TYPES_UI(只決定
   toast 說什麼,不決定寄不寄)。⚠️ send-change-request 刻意【沒有】停信
   判斷,且刻意不 select account_type —— 勿「順手對齊」加上去(F-66 §8)。
   份數無同步機制,登記為 F-211。$doc$;


-- ============================================================================
-- Segment 2 / 3   驗證   🔴 回傳結果集,不用 RAISE NOTICE
-- ----------------------------------------------------------------------------
-- 🔴 F-187 / CB-93 U-1:RAISE NOTICE 在 Supabase SQL Editor 可能不顯示,
--    「成功」若只由 NOTICE 承載,看起來與「什麼都沒跑」完全一樣。
--    成功路徑必須有列可看。
-- 🔴 result 欄以正向列舉判定:expected 與 actual 相等才 PASS,
--    不寫「不等於就 FAIL」—— NULL 在後者會落進 PASS。
-- ⚠️ 四列必須【全部】PASS。任一 FAIL 即執行 R-1 回滾後重跑 Segment 1。
-- ============================================================================

WITH guard AS MATERIALIZED (SELECT _ops.assert_env('staging') AS ok),
chk AS (
  SELECT pg_catalog.pg_get_constraintdef(c.oid) AS def
  FROM pg_catalog.pg_constraint c
  CROSS JOIN guard
  WHERE c.conrelid = 'public.dealers'::regclass
    AND c.conname  = 'dealers_account_type_check'
),
col AS (
  SELECT count(*) AS n
  FROM pg_catalog.pg_attribute a
  LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE a.attrelid = 'public.dealers'::regclass
    AND a.attname  = 'account_type'
    AND a.attnotnull
    AND pg_catalog.pg_get_expr(d.adbin, d.adrelid) = '''dealer''::text'
),
trg AS (
  SELECT count(*) AS n
  FROM pg_catalog.pg_trigger
  WHERE tgrelid = 'public.quotes'::regclass
    AND NOT tgisinternal
    AND tgenabled = 'O'
    AND tgname IN ('trg_block_trial_status_change', 'trg_block_trial_status_on_insert')
)
SELECT * FROM (
  SELECT 1 AS seq,
         (SELECT name FROM _ops.environment)        AS env_name,
         'A1 約束涵蓋五值'                          AS check_name,
         'true'                                     AS expected,
         (CASE WHEN (SELECT def FROM chk) LIKE '%dealer%'
                AND (SELECT def FROM chk) LIKE '%internal_account%'
                AND (SELECT def FROM chk) LIKE '%location%'
                AND (SELECT def FROM chk) LIKE '%project%'
                AND (SELECT def FROM chk) LIKE '%trial%'
               THEN 'true' ELSE 'false' END)        AS actual
  UNION ALL
  SELECT 2,
         (SELECT name FROM _ops.environment),
         'A2 欄位 NOT NULL + default dealer',
         '1',
         (SELECT n::text FROM col)
  UNION ALL
  SELECT 3,
         (SELECT name FROM _ops.environment),
         'A3 CB-76 兩支 trial trigger 仍啟用',
         '2',
         (SELECT n::text FROM trg)
  UNION ALL
  SELECT 4,
         (SELECT name FROM _ops.environment),
         'A4 現有資料全數落在五值內',
         '0',
         (SELECT count(*)::text FROM public.dealers
          WHERE account_type IS DISTINCT FROM 'dealer'
            AND account_type IS DISTINCT FROM 'internal_account'
            AND account_type IS DISTINCT FROM 'location'
            AND account_type IS DISTINCT FROM 'project'
            AND account_type IS DISTINCT FROM 'trial')
) t
CROSS JOIN guard
ORDER BY seq;


-- ── 約束定義原文(人眼複核用,與上表分開)────────────────────────────────
WITH guard AS MATERIALIZED (SELECT _ops.assert_env('staging') AS ok)
SELECT (SELECT name FROM _ops.environment)          AS env_name,
       c.conname                                    AS constraint_name,
       pg_catalog.pg_get_constraintdef(c.oid)       AS definition
FROM pg_catalog.pg_constraint c
CROSS JOIN guard
WHERE c.conrelid = 'public.dealers'::regclass
  AND c.conname  = 'dealers_account_type_check'
ORDER BY c.conname;


-- ============================================================================
-- Segment 3 / 3   人眼複核:account_type × role 分佈
-- ----------------------------------------------------------------------------
-- 🔴 跨環境查詢必須 ORDER BY —— 沒有它,兩環境的輸出順序可能不同,
--    肉眼比對會看到不存在的差異(DOC-1 既有規則)。
-- 📌 CB-97 Stage 0 基線:
--      staging     dealer/dealer 3 · dealer/location 1 · admin/dealer 1
--                  · super_admin/dealer 2
--      production  dealer/dealer 120 · dealer/internal_account 7
--                  · dealer/location 9 · dealer/trial 1
--                  · admin/internal_account 7 · super_admin/internal_account 2
--    本段執行後應與上列一致(project 為 0 列,尚未建立任何帳號)。
-- ============================================================================

WITH guard AS MATERIALIZED (SELECT _ops.assert_env('staging') AS ok)
SELECT (SELECT name FROM _ops.environment)          AS env_name,
       d.role,
       d.account_type,
       count(*)                                     AS n
FROM public.dealers d
CROSS JOIN guard
GROUP BY d.role, d.account_type
ORDER BY d.role, d.account_type;


-- ============================================================================
-- Segment R   ROLLBACK   🔴 全部註解掉,需要時才解開
-- ----------------------------------------------------------------------------
-- 🟢 本票的回滾不損任何資料 —— project 尚無任何帳號使用。
-- 🔴 但若已建立 project 帳號,回滾【會失敗】(ADD CONSTRAINT 驗證不過),
--    那是刻意的:先把那些帳號改成別的類型,再回滾。
--    絕不改成「先 DROP 再不 ADD」—— 那會讓欄位失去所有約束。
-- ⚠️ 回滾後必須一併回退 U5 的五處 EF 常數與 U2/U3 的前端,
--    否則 UI 仍提供 project 選項而 DB 拒收 → 存檔撞 23514。
-- ============================================================================

-- DO $cb97_rb1$
-- BEGIN
--   PERFORM _ops.assert_env('staging');
--
--   ALTER TABLE public.dealers
--     DROP CONSTRAINT dealers_account_type_check;
--
--   ALTER TABLE public.dealers
--     ADD CONSTRAINT dealers_account_type_check
--     CHECK (account_type IN ('dealer', 'internal_account', 'location', 'trial'));
-- END
-- $cb97_rb1$;

-- ── R-2  還原 COMMENT(選用,僅在完整回滾時)─────────────────────────────
--   請自 migrations/2026-08-22_CB-76_account-type-and-trial-guard__STAGING.sql
--   複製其 COMMENT ON COLUMN 區段原文重跑。🔴 該檔本身不得修改。
