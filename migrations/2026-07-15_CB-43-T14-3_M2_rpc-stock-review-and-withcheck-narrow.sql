-- ============================================================================
-- CB-43 T14-3 — M2 (v2): submit_purchase_order 改寫 + WITH CHECK 收斂
--                        【v2 新增:環境 GUARD】
-- ----------------------------------------------------------------------------
-- Repo : ProCraftBen/procraft-dealer-portal-staging  (branch: main)
-- Path : migrations/2026-07-15_CB-43-T14-3_M2_rpc-stock-review-and-withcheck-narrow.sql
--
-- 【v2 變更理由 — 事故記錄 2026-07-16】
--   v1 被誤貼到 production(acwgemgpnusworpxxoai)執行。
--   Supabase SQL Editor 兩個 project 介面完全相同,只有網址列 ref 不同;
--   v1 僅在【註解】提醒核對 ref —— 註解擋不住任何人。
--
--   影響:production 的 RPC 與 dealer RLS 被改動數十分鐘,期間 production 前端
--        仍是舊版 = 破窗(新單進 Stock Review 但無 badge/無 Edit/無 Pay Now;
--        dealer 重送丟 42501)。
--   實際損害:0 筆訂單(窗口內無 dealer 活動)。已由 R-M2-PROD 完整還原。
--   結論:ref 提醒必須從「註解」升級為「會中止執行的 guard」。
--
-- ============================================================================
-- 【promote 到 production 時必須改寫本 guard,不要直接刪掉】
--   下方兩道指紋是【現階段】辨識 staging 用的:
--     ① quotes 筆數 >= 10          (staging 24 / production 2)
--     ② quotes 有 CHECK constraint  (T14-1 已上 staging;production 尚未 promote)
--   promote 時兩者都會失效或反轉。屆時請改為驗證 production 的指紋,
--   或至少保留一個 RAISE NOTICE 人工確認點。
-- ============================================================================


BEGIN;

-- ┌────────────────────────────────────────────────────────────────────────┐
-- │ 環境 GUARD — 跑錯 project 直接中止;transaction 回滾,不會改到任何東西  │
-- └────────────────────────────────────────────────────────────────────────┘
DO $guard$
DECLARE
  v_quotes int;
  v_checks int;
BEGIN
  SELECT count(*) INTO v_quotes FROM public.quotes;

  SELECT count(*) INTO v_checks
  FROM pg_constraint
  WHERE conrelid = 'public.quotes'::regclass AND contype = 'c';

  IF v_quotes < 10 THEN
    RAISE EXCEPTION
      'ABORT: quotes 只有 % 筆 → 這不是 staging(staging 應有 20+ 筆)。M2 未執行,無任何改動。',
      v_quotes;
  END IF;

  IF v_checks = 0 THEN
    RAISE EXCEPTION
      'ABORT: quotes 無 CHECK constraint → T14-1 未上線,這不是 staging。M2 未執行,無任何改動。';
  END IF;

  RAISE NOTICE '環境 guard 通過:quotes % 筆、CHECK constraint % 個 → 判定 staging,繼續執行 M2。',
    v_quotes, v_checks;
END
$guard$;


-- ── ① RPC:'Pending' → 'Stock Review' ────────────────────────────────────────
--   只改一個字串,其餘逐字保留 pg_get_functiondef 原文。
--   不動 po_number 產號邏輯、不動 LOCK TABLE、不加 status guard。
--
--   ⚠️ 刻意【不加】SECURITY DEFINER。
--      本函式無 ownership 檢查(UPDATE ... WHERE id = p_quote_id),
--      靠 RLS 擋住「dealer 傳別人的 quote_id」。加 SECURITY DEFINER 會繞過 RLS
--      → dealer 可 submit 別人的單 = 新的安全洞。
--      正解是「SECURITY DEFINER + RPC 內自建 ownership 檢查」,屬設計題。
--      → 另開票 (F1 / Q6-A)。動這支 RPC 的人請先讀完 F1。
CREATE OR REPLACE FUNCTION public.submit_purchase_order(p_quote_id uuid)
 RETURNS text
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_po_number text;
  v_next_seq INT;
BEGIN
  LOCK TABLE quotes IN SHARE ROW EXCLUSIVE MODE;
  SELECT COALESCE(MAX(
    CAST(SUBSTRING(po_number FROM '^PDC(\d+)$') AS INT)
  ), 9000) + 1
  INTO v_next_seq
  FROM quotes
  WHERE po_number ~ '^PDC\d{5}$';
  v_po_number := 'PDC' || LPAD(v_next_seq::TEXT, 5, '0');
  UPDATE quotes
  SET po_number = v_po_number,
      status = 'Stock Review'          -- CB-43 T14-3: was 'Pending'
  WHERE id = p_quote_id;
  RETURN v_po_number;
END;
$function$;


-- ── ② WITH CHECK 收斂:移除 'Pending'(Q5-A)────────────────────────────────
--   已逐條核對:T14-3 後【無任何 dealer 路徑會寫 'Pending'】
--     - RPC (Draft→Submit / A-mode)   → 'Stock Review'
--     - 前端分支 1 (resubmit)          → 'Stock Review'
--     - 前端分支 2 (admin-edit)        → admin 身分,走 admin_update_all_quotes
--     - payment.html                   → 'Payment Processing',走
--                                        dealer_advance_quote_to_payment_processing
--     - Stock Review → Pending (放行)  → admin 身分,走 admin_update_all_quotes
--
--   ⚠️ 已知未解 (F2,另開票):本 policy 與 dealer_advance_quote_to_payment_processing
--      皆為 PERMISSIVE → OR 疊加 → 有效 WITH CHECK 仍含 'Payment Processing'
--      → dealer 仍可把自己的 Draft 直接推到 'Payment Processing'(需手工 API call)。
--      Q5-A 只堵一半。全解需合併 policy 或改 RESTRICTIVE。
--
--   交易(N2):DROP 成功但 CREATE 失敗會使 policy 消失 → RLS deny by default
--            → dealer 連 Draft 都存不了,【且是靜默的】。故全程包 transaction。
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
    AND status = ANY (ARRAY['Draft'::text, 'Stock Review'::text, 'Returned'::text])
  );

COMMIT;


-- ============================================================================
-- 驗證(執行後跑)
-- ============================================================================
-- SELECT
--   (SELECT count(*) FROM pg_policies WHERE tablename='quotes'
--      AND policyname='dealer_advance_quote_to_payment_processing') AS a1_policy_應為1,
--   (SELECT count(*) FROM quotes) AS total_quotes_應為24,
--   (SELECT pg_get_functiondef(oid) LIKE '%Stock Review%' FROM pg_proc
--      WHERE proname='submit_purchase_order') AS rpc_has_stock_review_應為true,
--   (SELECT pg_get_functiondef(oid) ILIKE '%SECURITY DEFINER%' FROM pg_proc
--      WHERE proname='submit_purchase_order') AS rpc_has_definer_應為false,
--   (SELECT with_check FROM pg_policies WHERE tablename='quotes'
--      AND policyname='dealer_update_own_quotes_when_editable') AS dealer_with_check;
--
-- 預期 dealer_with_check:
--   ((dealer_id = auth.uid()) AND (status = ANY (ARRAY['Draft'::text,
--     'Stock Review'::text, 'Returned'::text])))


-- ============================================================================
-- 窗口稽核 — P6 後必跑(找出 P3→P6 之間繞過 Stock Review 的單)
-- ----------------------------------------------------------------------------
-- ⚠️ 不可使用 quotes.updated_at 判斷:quotes 表【無任何 trigger】(A4 已證實),
--    前端也從未寫入 updated_at → 該欄位不被維護 → 用它篩選會回 0 rows
--    →「一個永遠通過的安全檢查」比沒有檢查更危險。
--
-- 改用 P3 基準快照比對(時間戳無關,亦不受 F1 撞號影響)。
--
-- ── 步驟 1:P3【提交前端之前】立刻建立基準快照 ──
--    放 _ops schema:PostgREST 預設只暴露 public / graphql_public → _ops 不會被 API 讀到。
-- CREATE SCHEMA IF NOT EXISTS _ops;
-- DROP TABLE IF EXISTS _ops.t143_baseline;
-- CREATE TABLE _ops.t143_baseline AS SELECT id, status FROM public.quotes;
--
-- ── 步驟 2:P6 之後稽核 ──
--    涵蓋三個狀態,因為窗口內的單可能【已經被付掉】:
--      Pending            = 還沒付,可攔
--      Payment Processing = dealer 已送出付款  ← 最該抓的一批
--      Order Processing   = 已付款完成         ← 最該抓的一批
-- SELECT q.id, q.po_number, q.dealer_id, q.job_name, q.grand_total,
--        b.status AS status_at_p3, q.status AS status_now
-- FROM public.quotes q
-- LEFT JOIN _ops.t143_baseline b ON b.id = q.id
-- WHERE q.status IN ('Pending', 'Payment Processing', 'Order Processing')
--   AND (b.id IS NULL OR b.status IN ('Draft', 'Returned'))
-- ORDER BY q.po_number;
--
--   判讀:
--     b.id IS NULL          → 窗口內【新建】的單(A-mode 直接 submit)
--     b.status = 'Draft'    → 窗口內從草稿送出 → 繞過了 Stock Review
--     b.status = 'Returned' → 理論上不該出現(resubmit 走新前端已寫 Stock Review);
--                             若出現代表前端未生效 → 立即查 P4
--     回 0 rows             → 窗口內無單送出
--   → 命中的單【全部需要 admin 人工確認庫存】,它們未經 Stock Review 把關。
--
-- ── 步驟 3:稽核完成後清理 ──
-- DROP TABLE IF EXISTS _ops.t143_baseline;


-- ============================================================================
-- ROLLBACK  R-M2  — 退回「M1 超集」狀態(安全中繼,新舊前端皆可運作)
-- ----------------------------------------------------------------------------
-- 執行後:RPC 寫 'Pending'、WITH CHECK 同時含 Pending 與 Stock Review
--   → 【新前端】寫 Stock Review → 過;【舊前端】寫 Pending → 過
--   → 此刻可從容 revert 前端,不必搶時間。
--
-- 完整回滾順序:  ① R-M2(本段)  →  ② revert 前端 5 檔  →  ③ R-M1
--
-- ⚠️ R-M2 【刻意不含】環境 guard:回滾是止血動作,任何環境跑它都只會退回舊行為
--    (更安全),不該因 guard 判斷失誤而擋住緊急還原。
-- ============================================================================
-- BEGIN;
--
-- CREATE OR REPLACE FUNCTION public.submit_purchase_order(p_quote_id uuid)
--  RETURNS text
--  LANGUAGE plpgsql
-- AS $function$
-- DECLARE
--   v_po_number text;
--   v_next_seq INT;
-- BEGIN
--   LOCK TABLE quotes IN SHARE ROW EXCLUSIVE MODE;
--   SELECT COALESCE(MAX(
--     CAST(SUBSTRING(po_number FROM '^PDC(\d+)$') AS INT)
--   ), 9000) + 1
--   INTO v_next_seq
--   FROM quotes
--   WHERE po_number ~ '^PDC\d{5}$';
--   v_po_number := 'PDC' || LPAD(v_next_seq::TEXT, 5, '0');
--   UPDATE quotes
--   SET po_number = v_po_number,
--       status = 'Pending'
--   WHERE id = p_quote_id;
--   RETURN v_po_number;
-- END;
-- $function$;
--
-- DROP POLICY IF EXISTS dealer_update_own_quotes_when_editable ON public.quotes;
-- CREATE POLICY dealer_update_own_quotes_when_editable
--   ON public.quotes AS PERMISSIVE FOR UPDATE TO authenticated
--   USING (
--     dealer_id = auth.uid()
--     AND status = ANY (ARRAY['Draft'::text, 'Returned'::text])
--   )
--   WITH CHECK (
--     dealer_id = auth.uid()
--     AND status = ANY (ARRAY['Draft'::text, 'Stock Review'::text, 'Pending'::text, 'Returned'::text])
--   );
--
-- COMMIT;
--
-- ⚠️ R-M2 後若仍有單卡在 'Stock Review':不會變孤兒。
--    T14-2 的放行按鈕【不在本張 revert 範圍】→ admin 仍可放行成 Pending。
-- ============================================================================


-- ============================================================================
-- 【R-M2-PROD】production 誤觸時的完整還原(R-M2 + R-M1 併為一段)
-- ----------------------------------------------------------------------------
-- 2026-07-16 事故實際使用過此段,已驗證有效。
-- 直接把 production 還原到 T14-3 動工前:WITH CHECK 回原始三值(非超集)。
-- ============================================================================
-- BEGIN;
--
-- CREATE OR REPLACE FUNCTION public.submit_purchase_order(p_quote_id uuid)
--  RETURNS text
--  LANGUAGE plpgsql
-- AS $function$
-- DECLARE
--   v_po_number text;
--   v_next_seq INT;
-- BEGIN
--   LOCK TABLE quotes IN SHARE ROW EXCLUSIVE MODE;
--   SELECT COALESCE(MAX(
--     CAST(SUBSTRING(po_number FROM '^PDC(\d+)$') AS INT)
--   ), 9000) + 1
--   INTO v_next_seq
--   FROM quotes
--   WHERE po_number ~ '^PDC\d{5}$';
--   v_po_number := 'PDC' || LPAD(v_next_seq::TEXT, 5, '0');
--   UPDATE quotes
--   SET po_number = v_po_number,
--       status = 'Pending'
--   WHERE id = p_quote_id;
--   RETURN v_po_number;
-- END;
-- $function$;
--
-- DROP POLICY IF EXISTS dealer_update_own_quotes_when_editable ON public.quotes;
-- CREATE POLICY dealer_update_own_quotes_when_editable
--   ON public.quotes AS PERMISSIVE FOR UPDATE TO authenticated
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
--
-- 還原後應檢查:SELECT id, po_number, status FROM quotes WHERE status = 'Stock Review';
--   → 有筆數才需 UPDATE ... SET status='Pending'。2026-07-16 事故時為 0 筆。
-- ============================================================================
