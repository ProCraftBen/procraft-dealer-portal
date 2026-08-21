-- ============================================================================
-- CB-74 M2 — get_assigned_sales_name()  [PRODUCTION]
-- 2026-08-21
--
-- 🔴 本檔與 2026-08-20_CB-74_sales-name-rpc__STAGING.sql 的差異【只有】
--    assert_env 的環境字串與本註解區塊。函式本體、GRANT/REVOKE、search_path
--    完全相同 —— 兩檔若在其他地方分岔,即為錯誤。
--
-- 目的:PDF / 畫面表頭顯示 dealer 對應的業務姓名(CB-38 assigned_sales_id)。
--
-- 🔴 為什麼需要 SECURITY DEFINER(不是直接查 dealers):
--   dealers 的 SELECT policy 聯集為 `id = auth.uid() OR is_admin()`。
--   sales 姓名位於 role=admin 的【另一列】,dealer 身分讀取結果為 NULL 且
--   【不報錯】。dealer 端會產生四種文件中的四種(step3 downloadPDF、
--   step3 submit 的 Packing List + Invoice、quote-detail 的 Invoice/Receipt),
--   走原路等於整個需求對 dealer 全面失效 —— 靜默印 —,無錯誤可查。
--
-- 🔴 回傳面最小化:本函式繞過 RLS,故只回傳 contact_name 單一 text,
--   不回傳整列由前端取用。多層定價欄位(stock_multiplier /
--   non_stock_multiplier / frameless_multiplier / tax_rate)絕不隨之外流。
--
-- 🔴 auth.uid() 與 public.is_admin() 必須寫完整 schema 前綴:
--   search_path 已鎖為 public, pg_temp,不含 auth schema。漏前綴會在執行期
--   拋 42883。
--
-- 🔴 search_path 合規(F-47 / F-56 同款)。DOC-1 §9 稽核基線 6/8。
--
-- ⚠ production 的 dealers 母體遠大於 staging(staging 僅 7 列、orphan 0)。
--   套用後【必須】以 production 實際帳號重跑 T1–T4 雙向授權測試,不可沿用
--   staging 的結果 —— 兩環境的 dealers.id / auth.users.id 同源性是各自的
--   應用層慣例,無 FK 保證(F-30)。
--
-- NULL 的三種來源(前端一律顯示 '—',CB-74 Q-1):
--   ① assigned_sales_id IS NULL —— 未指派,production 確定存在此類 dealer
--      (F-30 為此新增了 Unassigned 篩選選項)
--   ② 呼叫者既非本人也非 admin —— 不應發生
--   ③ assigned_sales_id 指向已刪除帳號 —— FK 為 ON DELETE SET NULL,
--      實際會先變成 ①
-- ============================================================================

BEGIN;

SELECT _ops.assert_env('production');

CREATE OR REPLACE FUNCTION public.get_assigned_sales_name(p_dealer_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT s.contact_name
  FROM public.dealers AS d
  JOIN public.dealers AS s ON s.id = d.assigned_sales_id
  WHERE d.id = p_dealer_id
    AND (p_dealer_id = auth.uid() OR public.is_admin());
$fn$;

COMMENT ON FUNCTION public.get_assigned_sales_name(uuid) IS
  'CB-74: returns the contact_name of the dealer''s assigned sales rep. '
  'SECURITY DEFINER with minimal return surface (single text column). '
  'Authorization mirrors the dealers SELECT policies: own row or is_admin().';

-- CREATE OR REPLACE 會把 EXECUTE 預設授予 PUBLIC,必須事後收回。
REVOKE ALL ON FUNCTION public.get_assigned_sales_name(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_assigned_sales_name(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_assigned_sales_name(uuid) TO authenticated;

COMMIT;
