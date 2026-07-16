-- ============================================================================
-- F1 — submit_purchase_order:修復 PO 號跨 dealer 撞號 + 自建 ownership 檢查
-- ============================================================================
-- 環境      : PRODUCTION  (acwgemgpnusworpxxoai)
-- 日期      : 2026-07-16
-- 可重跑    : 是(CREATE OR REPLACE,無副作用)
-- 前端影響  : 無(純 DB)
-- 前置條件  : 必須先在 STAGING 驗證通過
--
-- 【變更】
--  1. SECURITY INVOKER → SECURITY DEFINER
--     → 內部 SELECT MAX(po_number) 不再被 dealer_select_own_quotes 限縮
--     → 前提已查證:quotes.relforcerowsecurity=false 且 fn owner = table owner = postgres
--  2. 新增 ownership 檢查(置於 LOCK 之前,fail fast — Q3-A)
--  3. SET search_path = public, pg_temp
--     ⚠️ 不可改成 '':is_admin() 是 DEFINER 但 proconfig=null 且內部 dealers 未 qualify
--        → 會繼承 '' 後 42P01 → admin 呼叫全爆。見 F1-followup-1。
--  4. body 全面 schema-qualify(縱深防禦)
--
-- 【刻意不動】
--  - LOCK TABLE / 產號邏輯 / regex / RETURNS text
--  - status = 'Pending'   ← 🔴 本環境現值。CB-43 尚未 promote,前端無 Stock Review 的
--                            badge / Edit / Pay Now。若誤貼 staging 版寫入 'Stock Review'
--                            → 前端破窗(= 2026-07-16 事故重演)。
--  - 無 status guard      ← Q1-A,列 F1-followup-3
--
-- 【急迫性】production quotes 已由 2 筆 → 3 筆,有活動中。
--   目前 po_number 無 unique → 撞號為靜默資料損壞,無錯誤無日誌。
--   下一個 dealer 的第一張單即會中。
-- ============================================================================

BEGIN;

SELECT _ops.assert_env('production');

CREATE OR REPLACE FUNCTION public.submit_purchase_order(p_quote_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_po_number text;
  v_next_seq  INT;
  v_dealer_id uuid;
  v_caller    uuid;
BEGIN
  -- ── F1 新增:ownership 檢查(必須在 LOCK 之前)──────────────────
  SELECT dealer_id INTO v_dealer_id
  FROM public.quotes
  WHERE id = p_quote_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'submit_purchase_order: quote not found (id=%)', p_quote_id
      USING ERRCODE = 'P0002';
  END IF;

  v_caller := auth.uid();

  IF NOT public.is_admin() THEN
    IF v_caller IS NULL OR v_dealer_id IS DISTINCT FROM v_caller THEN
      RAISE EXCEPTION
        'submit_purchase_order: permission denied — quote % does not belong to caller %',
        p_quote_id, v_caller
        USING ERRCODE = '42501';
    END IF;
  END IF;
  -- ── ownership 檢查結束 ─────────────────────────────────────────

  LOCK TABLE public.quotes IN SHARE ROW EXCLUSIVE MODE;

  SELECT COALESCE(MAX(
    CAST(SUBSTRING(po_number FROM '^PDC(\d+)$') AS INT)
  ), 9000) + 1
  INTO v_next_seq
  FROM public.quotes
  WHERE po_number ~ '^PDC\d{5}$';

  v_po_number := 'PDC' || LPAD(v_next_seq::TEXT, 5, '0');

  UPDATE public.quotes
  SET po_number = v_po_number,
      status = 'Pending'               -- 🔴 PRODUCTION 值。切勿改成 'Stock Review'
  WHERE id = p_quote_id;

  RETURN v_po_number;
END;
$function$;

COMMIT;


-- ============================================================================
-- 驗證(COMMIT 後另跑)
-- ============================================================================
-- 期待:prosecdef = true, proconfig = {search_path=public\, pg_temp}, fn_owner = postgres
-- 🔴 並確認 def 內 status 仍為 'Pending'
--
-- SELECT p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS fn_owner,
--        pg_get_functiondef(p.oid) AS def
-- FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
-- WHERE n.nspname='public' AND p.proname='submit_purchase_order';


-- ============================================================================
-- ROLLBACK(還原至 F1 前的 PRODUCTION 版本;刻意不含 assert_env)
-- ============================================================================
/*
BEGIN;

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
      status = 'Pending'
  WHERE id = p_quote_id;
  RETURN v_po_number;
END;
$function$;

ALTER FUNCTION public.submit_purchase_order(uuid) RESET ALL;

COMMIT;
*/
