-- ============================================================================
-- CB-74 M1 — get_assigned_sales_name()  [STAGING]
-- 2026-08-20
--
-- 目的:PDF / 畫面表頭顯示 dealer 對應的業務姓名(CB-38 assigned_sales_id)。
--
-- 🔴 為什麼需要 SECURITY DEFINER(不是直接查 dealers):
--   dealers 的三條 SELECT policy 聯集後等於 `id = auth.uid() OR is_admin()`。
--   sales 姓名位於 role=admin 的【另一列】,dealer 身分讀取結果為 NULL 且
--   【不報錯】。而 dealer 端會產生四種文件中的四種(step3 downloadPDF、
--   step3 submit 的 Packing List + Invoice、quote-detail 的 Invoice/Receipt),
--   走原路等於整個需求對 dealer 全面失效 —— 靜默印 —,無錯誤可查。
--
-- 🔴 回傳面最小化(PM Q-4 硬性要求 2):
--   本函式繞過 RLS,故只回傳 contact_name 單一 text,不回傳整列由前端取用。
--   多層定價欄位(stock_multiplier / non_stock_multiplier / frameless_multiplier
--   / tax_rate)絕不隨之外流 —— 這正是 B2(放寬 RLS)被否決的原因。
--
-- 🔴 授權判斷式與既有 policy 完全同源,不引入新假設:
--     policy  : id = auth.uid() OR is_admin()
--     本函式  : p_dealer_id = auth.uid() OR public.is_admin()
--   staging 實測 dealers 7 列、orphan_no_auth_user = 0(dealers.id 與
--   auth.users.id 同源)。⚠ 兩表之間無 FK(F-30 查證),此為應用層慣例而非
--   結構保證;若日後出現 orphan 列,該 dealer 連自己的 profile 都讀不到,
--   問題會先在登入 gate(new-quote-step3.html L2062)爆開,不在本函式。
--
-- 🔴 auth.uid() 必須寫完整 schema 前綴:
--   search_path 已鎖為 public, pg_temp,不含 auth schema。未加前綴會在執行期
--   拋 42883。public.is_admin() 同理。
--
-- 🔴 search_path 合規(F-47 / F-56 同款):
--   SET search_path = public, pg_temp。DOC-1 §9 稽核基線由 5/7 更新為 6/8。
--
-- NULL 的三種來源(前端一律顯示 '—',CB-74 Q-1):
--   ① assigned_sales_id IS NULL —— 未指派,預期情形
--   ② 呼叫者既非本人也非 admin —— 不應發生(dealer 恆帶自己的 id)
--   ③ assigned_sales_id 指向已刪除帳號 —— FK 為 ON DELETE SET NULL,實際
--      會先變成 ①
-- ============================================================================

BEGIN;

SELECT _ops.assert_env('staging');

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
