-- ============================================================================
-- F1 — submit_purchase_order:修復 PO 號跨 dealer 撞號 + 自建 ownership 檢查
-- ============================================================================
-- 環境      : STAGING  (jkcbusliyrxbgebdrybl)
-- 日期      : 2026-07-16
-- 可重跑    : 是(CREATE OR REPLACE,無副作用)
-- 前端影響  : 無(純 DB)
--
-- 【變更】
--  1. SECURITY INVOKER → SECURITY DEFINER
--     → 內部 SELECT MAX(po_number) 不再被 dealer_select_own_quotes 限縮
--     → 前提已查證:quotes.relforcerowsecurity=false 且 fn owner = table owner = postgres
--  2. 新增 ownership 檢查(置於 LOCK 之前,fail fast — Q3-A)
--     → 補回 DEFINER 繞過 RLS 後失去的防護
--  3. SET search_path = public, pg_temp
--     → pg_temp 明確擺最後(不寫會被隱含擺最前 = 劫持破口)
--     ⚠️ 不可改成 '':is_admin() 是 DEFINER 但 proconfig=null 且內部 dealers 未 qualify
--        → 會繼承 '' 後 42P01 → admin 呼叫全爆(CB-32 / CB-36)。見 F1-followup-1。
--  4. body 全面 schema-qualify(縱深防禦,不依賴 search_path)
--
-- 【刻意不動】
--  - LOCK TABLE ... IN SHARE ROW EXCLUSIVE MODE
--  - 產號邏輯 / regex / COALESCE 9000 / LPAD
--  - RETURNS text
--  - status = 'Stock Review'   ← 本環境現值。⚠️ production 版為 'Pending',切勿互貼
--  - 無 status guard            ← Q1-A,列 F1-followup-3
--
-- 【行為變更對照】
--  dealer 自己的單      : 號錯(撞號) → 號正確
--  dealer 傳別人的單    : RLS 靜默擋(回傳號但 0 rows updated) → RAISE 42501(loud)
--  admin / super_admin  : 正常 → is_admin() 放行(不變)
--  匿名(auth.uid()=NULL): — → RAISE 42501
--  quote 不存在         : 靜默回傳號但沒改到 → RAISE P0002(loud)
-- ============================================================================

BEGIN;

SELECT _ops.assert_env('staging');

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
  -- SECURITY DEFINER 已繞過 RLS,以下 SELECT 看得到全表 →
  -- NOT FOUND 代表 quote 真的不存在,而非被 RLS 濾掉。
  SELECT dealer_id INTO v_dealer_id
  FROM public.quotes
  WHERE id = p_quote_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'submit_purchase_order: quote not found (id=%)', p_quote_id
      USING ERRCODE = 'P0002';
  END IF;

  v_caller := auth.uid();

  -- admin / super_admin 一律放行(CB-32 admin 代 submit、CB-36 internal draft)
  IF NOT public.is_admin() THEN
    -- dealer 必須是該單的擁有者。
    -- v_caller IS NULL(匿名)或 dealer_id IS NULL 皆走 IS DISTINCT FROM → 拒絕(fail closed,Q5-A)
    IF v_caller IS NULL OR v_dealer_id IS DISTINCT FROM v_caller THEN
      RAISE EXCEPTION
        'submit_purchase_order: permission denied — quote % does not belong to caller %',
        p_quote_id, v_caller
        USING ERRCODE = '42501';
    END IF;
  END IF;
  -- ── ownership 檢查結束 ─────────────────────────────────────────

  -- 以下維持 F1 前的原邏輯,僅補 schema-qualify
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
      status = 'Stock Review'          -- ⚠️ STAGING 值(CB-43 T14-3)。production 為 'Pending'
  WHERE id = p_quote_id;

  RETURN v_po_number;
END;
$function$;

COMMIT;


-- ============================================================================
-- 驗證(COMMIT 後另跑)
-- ============================================================================
-- 期待:prosecdef = true, proconfig = {search_path=public\, pg_temp}, fn_owner = postgres
--
-- SELECT p.oid::regprocedure, p.prosecdef, p.proconfig,
--        pg_get_userbyid(p.proowner) AS fn_owner
-- FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
-- WHERE n.nspname='public' AND p.proname='submit_purchase_order';
--
-- ⚠️ fn_owner 必須仍是 postgres。若變成別的 role → DEFINER 繞不過 RLS,修法失效,立即 rollback。


-- ============================================================================
-- ROLLBACK(還原至 F1 前的 STAGING 版本;刻意不含 assert_env — 止血不該被擋)
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
      status = 'Stock Review'          -- CB-43 T14-3: was 'Pending'
  WHERE id = p_quote_id;
  RETURN v_po_number;
END;
$function$;

-- CREATE OR REPLACE 未指定的屬性會回預設值(SECURITY INVOKER、proconfig 清空),
-- 但明確 RESET 一次以防萬一:
ALTER FUNCTION public.submit_purchase_order(uuid) RESET ALL;

COMMIT;

-- rollback 驗證:期待 prosecdef = false, proconfig = null
-- SELECT prosecdef, proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
-- WHERE n.nspname='public' AND p.proname='submit_purchase_order';
*/
