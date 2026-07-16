-- ============================================================================
-- CB-43 T14-3 — M1 (v2): dealer UPDATE policy 的 WITH CHECK 擴為「超集」
--                        【v2 新增:環境 GUARD + 順序 GUARD】
-- ----------------------------------------------------------------------------
-- Repo : ProCraftBen/procraft-dealer-portal-staging  (branch: main)
-- Path : migrations/2026-07-15_CB-43-T14-3_M1_rls-withcheck-superset.sql
--
-- 【v2 變更理由】
--   ① 環境 guard —— 與 M2 v2 同一理由(2026-07-16 事故:M2 v1 被誤貼到 production)。
--      M1 同樣是 DROP+CREATE POLICY,一樣會跑錯 project。註解擋不住任何人。
--
--   ② 順序 guard —— v1 的【隱藏陷阱】,事故後才發現:
--      M1 把 WITH CHECK 設成【超集】(含 'Pending');M2 之後會把它收斂(移除 'Pending')。
--      → M2 跑完之後若有人重跑 M1(例如為了「確認 M1 有沒有跑」),
--        WITH CHECK 會被打回超集 → 'Pending' 回來 → Q5-A 堵住的後門【靜默重開】
--        (dealer 可把自己的 Draft 直接 UPDATE 成 'Pending' → 繞過 Stock Review
--         → 無 po_number → Pay Now 直接出現)。
--      → 沒有任何錯誤訊息,冪等性在這裡反而是陷阱:
--        M1 單獨看是冪等的,但它與 M2 有【順序依賴】,而檔案本身不知道。
--      → 故加入:偵測到 M2 已套用即 ABORT。
--
-- ============================================================================
-- 【promote 到 production 時必須改寫環境 guard,不可直接刪】
--   下方環境指紋是【現階段】辨識 staging 用的:
--     ① quotes 筆數 >= 10          (staging 24 / production 2)
--     ② quotes 有 CHECK constraint  (T14-1 已上 staging;production 尚未 promote)
--   promote 時兩者都會對 production 放行 → guard 形同虛設,
--   而那天正是兩個 SQL Editor 分頁最容易搞混的一天。
--
--   PM 已定 production 前必做:改用 settings 表的 environment 標記
--   (每個 project 一列 'staging' / 'production'),guard 改讀它 → 明確、不漂移。
-- ============================================================================
--
-- 【目的】安全中繼。加入 'Stock Review',同時【保留】'Pending'。
--   此狀態對【新舊前端都安全】:
--     - 舊前端寫 'Pending'      → WITH CHECK 仍含 Pending      → 過
--     - 新前端寫 'Stock Review' → WITH CHECK 已含 Stock Review → 過
--   因此 M1 可【單獨上線】,不需前端配合,零破窗。
--
-- 【執行時機】前端 5 檔 deploy 之【前】(部署時序 P1)。
-- 【下一步】  前端 deploy 並驗證通過後,執行 M2。
--
-- 【不動 USING】維持 ('Draft','Returned')。
--   dealer 不該能編輯 Stock Review 單(T14-3 的核心目的),USING 就是那道邊界。
--   Q5-A 只收斂 WITH CHECK,不放寬 USING。
--
-- 【交易】(N2) DROP 成功但 CREATE 失敗 → policy 消失 → RLS deny by default
--   → dealer 連 Draft 都存不了,【且是靜默的】(RLS 擋下回 0 rows 無 error,
--     dealer 只會覺得「存草稿沒反應」)。故全程包 transaction。
--   ※ PM 已立為通用原則:所有 DROP+CREATE POLICY 的 migration 一律包 BEGIN/COMMIT。
--
-- 【原始定義(改動前,供比對)】
--   policyname : dealer_update_own_quotes_when_editable
--   permissive : PERMISSIVE      cmd: UPDATE      roles: {authenticated}
--   USING      : (dealer_id = auth.uid()) AND (status = ANY (ARRAY['Draft','Returned']))
--   WITH CHECK : (dealer_id = auth.uid()) AND (status = ANY (ARRAY['Draft','Pending','Returned']))
-- ============================================================================


BEGIN;

-- ┌────────────────────────────────────────────────────────────────────────┐
-- │ GUARD — 環境判定 + 順序判定;任一不符即中止,transaction 回滾,零改動   │
-- └────────────────────────────────────────────────────────────────────────┘
DO $guard$
DECLARE
  v_quotes int;
  v_checks int;
  v_m2_done boolean;
BEGIN
  -- ── ① 環境指紋 ──
  SELECT count(*) INTO v_quotes FROM public.quotes;

  SELECT count(*) INTO v_checks
  FROM pg_constraint
  WHERE conrelid = 'public.quotes'::regclass AND contype = 'c';

  IF v_quotes < 10 THEN
    RAISE EXCEPTION
      'ABORT: quotes 只有 % 筆 → 這不是 staging(staging 應有 20+ 筆)。M1 未執行,無任何改動。',
      v_quotes;
  END IF;

  IF v_checks = 0 THEN
    RAISE EXCEPTION
      'ABORT: quotes 無 CHECK constraint → T14-1 未上線,這不是 staging。M1 未執行,無任何改動。';
  END IF;

  -- ── ② 順序指紋:M2 已套用就不准跑 M1 ──
  SELECT pg_get_functiondef(oid) LIKE '%Stock Review%'
  INTO v_m2_done
  FROM pg_proc WHERE proname = 'submit_purchase_order';

  IF v_m2_done THEN
    RAISE EXCEPTION
      'ABORT: 偵測到 M2 已套用(RPC 已寫 Stock Review)。此時重跑 M1 會把 WITH CHECK 打回超集 → ''Pending'' 復活 → Q5-A 堵住的後門靜默重開。M1 未執行,無任何改動。';
  END IF;

  RAISE NOTICE '環境 guard 通過:quotes % 筆、CHECK constraint % 個 → 判定 staging。順序 guard 通過:M2 尚未套用。繼續執行 M1。',
    v_quotes, v_checks;
END
$guard$;


DROP POLICY IF EXISTS dealer_update_own_quotes_when_editable ON public.quotes;

CREATE POLICY dealer_update_own_quotes_when_editable
  ON public.quotes
  AS PERMISSIVE
  FOR UPDATE
  TO authenticated
  USING (
    dealer_id = auth.uid()
    AND status = ANY (ARRAY['Draft'::text, 'Returned'::text])
  )
  WITH CHECK (
    dealer_id = auth.uid()
    AND status = ANY (ARRAY['Draft'::text, 'Stock Review'::text, 'Pending'::text, 'Returned'::text])
  );

COMMIT;


-- ============================================================================
-- 驗證(執行後跑;預期 with_check 含 Stock Review【且仍含】Pending)
-- ============================================================================
-- SELECT policyname, permissive, cmd, roles, qual, with_check
-- FROM pg_policies
-- WHERE tablename = 'quotes'
--   AND policyname = 'dealer_update_own_quotes_when_editable';
--
-- 預期 with_check:
--   ((dealer_id = auth.uid()) AND (status = ANY (ARRAY['Draft'::text,
--     'Stock Review'::text, 'Pending'::text, 'Returned'::text])))
--
-- 冒煙測試(P2):M1 單獨上線【不應改變任何行為】
--   → dealer 開新報價 → Submit         → 仍應進 'Pending'
--   → dealer 對 Returned 單重送        → 仍應進 'Pending'
--   → 兩條都測(USING 判定的舊列不同:Draft vs Returned)
--   → 異常則跑 R-M1 並停止


-- ============================================================================
-- ROLLBACK  R-M1  — 退回原始定義
-- ----------------------------------------------------------------------------
-- ⚠️ 前提:必須【先】執行 R-M2,且前端 5 檔已 revert 完成。
--    若前端仍是新版(會寫 'Stock Review'),跑 R-M1 會讓 dealer submit / resubmit
--    全部丟 42501 new row violates row-level security policy。
--
-- 完整回滾順序:  ① R-M2  →  ② revert 前端 5 檔  →  ③ R-M1(本段)
--
-- ⚠️ R-M1 【刻意不含】guard:回滾是止血動作,任何環境跑它都只會退回舊行為
--    (更安全),不該因 guard 判斷失誤而擋住緊急還原。
-- ============================================================================
-- BEGIN;
--
-- DROP POLICY IF EXISTS dealer_update_own_quotes_when_editable ON public.quotes;
--
-- CREATE POLICY dealer_update_own_quotes_when_editable
--   ON public.quotes
--   AS PERMISSIVE
--   FOR UPDATE
--   TO authenticated
--   USING (
--     dealer_id = auth.uid()
--     AND status = ANY (ARRAY['Draft'::text, 'Returned'::text])
--   )
--   WITH CHECK (
--     dealer_id = auth.uid()
--     AND status = ANY (ARRAY['Draft'::text, 'Pending'::text, 'Returned'::text])
--   );
--
-- COMMIT;
-- ============================================================================
