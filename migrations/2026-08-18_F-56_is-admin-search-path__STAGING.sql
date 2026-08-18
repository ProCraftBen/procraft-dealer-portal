BEGIN;

SELECT _ops.assert_env('staging');

-- ══════════════════════════════════════════════════════════════════════
-- F-56 (P0): is_admin / is_super_admin 缺 search_path
--
-- 現況: proconfig = null —— 連 public 都未固定
-- 目標: search_path = public, pg_temp
--
-- 理由: 兩支皆 SECURITY DEFINER,函式體裸名引用 dealers,解析完全依賴
--       呼叫端 search_path,可被劫持回傳任意值。
--       依賴面 27 條 policy / 14 張表(含 storage.objects),為授權模型
--       的根 —— 失效非單一功能故障,而是「誰是 admin」本身不可信。
--
--       較 F-47 嚴重:F-47 已固定 public,劫持面僅 pg_temp;
--       本票兩支完全未設,劫持不限臨時 schema。
--
-- 範圍: 僅加 search_path。函式體零改動,不使用 CREATE OR REPLACE。
--
-- 閘門: Stage 0 已逐行確認兩支函式體引用:
--         dealers    -> public,裸名        -> 可解析
--         auth.uid() -> auth,已 qualified  -> 不受 search_path 影響
--
-- 基線 (2026-08-18 staging, ALTER 前):
--   角色         is_admin / is_super_admin
--   admin        true  / false
--   dealer       false / false
--   super_admin  true  / true
--
--   樣本            admin  dealer  super_admin
--   payments          71      3        71
--   ddr                4      -         -
--   settings           -      -        13
--   quotes             -      4         -
--   mod_assignments  124    122       124
--   checks            31      3        31
--
-- 相關: F-47(同型,已完成)、F-57、F-59(本票風險放大器)
-- ══════════════════════════════════════════════════════════════════════

ALTER FUNCTION public.is_admin()       SET search_path = public, pg_temp;
ALTER FUNCTION public.is_super_admin() SET search_path = public, pg_temp;

COMMIT;
