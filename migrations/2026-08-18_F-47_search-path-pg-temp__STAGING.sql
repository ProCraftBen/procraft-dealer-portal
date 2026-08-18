BEGIN;

SELECT _ops.assert_env('staging');

-- ══════════════════════════════════════════════════════════════════════
-- F-47: get_modification_rules_by_codes 缺 pg_temp
--
-- 現況: SET search_path TO 'public'  (proconfig = ["search_path=public"])
-- 目標: search_path = public, pg_temp
--
-- 理由: 該函式為 SECURITY DEFINER 且為 dealer 可呼叫的 RLS 繞道通道
--       (new-quote-modifications.html L3746,取 dealer 在 RLS 下看不到的
--       admin-only rules)。search_path 未明列 pg_temp 時,relation 查找
--       仍隱式優先搜臨時 schema,函式體裸名引用 modification_assignments
--       可被劫持,進而控制 cost / mf_params / allowed_roles / tax_status。
--
--       現行 REST 介面無任意 SQL 入口,不可即時利用,屬縱深防禦缺口。
--
-- 範圍: 僅加 search_path。函式體零改動,不使用 CREATE OR REPLACE。
--       (F-55 記錄的兩環境註解/空白差異會原樣保留,本票不處理)
--
-- 閘門: Stage 0 已逐行確認函式體無 public 以外 schema 的裸名引用。
--       唯一 relation = modification_assignments (public)
--       其餘 unnest / string_to_array / trim / UPPER 皆 pg_catalog
--
-- 基線: ALTER 前 get_modification_rules_by_codes(
--         ARRAY['MF07'], 'framed', '', '', '', NULL) 回傳 1 列
--
-- 相關: F-55、F-56 (P0)、F-57、F-58
-- ══════════════════════════════════════════════════════════════════════

ALTER FUNCTION public.get_modification_rules_by_codes(
  p_mf_codes text[], p_door text, p_type text,
  p_category text, p_subcategory text, p_sku_code text
) SET search_path = public, pg_temp;

COMMIT;
