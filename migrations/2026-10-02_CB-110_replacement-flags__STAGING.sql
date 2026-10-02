-- ============================================================================
-- CB-110  Replacement — Unit 9 (phase 2): get_replacement_flags()
-- 環境: STAGING (jkcbusliyrxbgebdrybl)
-- 日期: 2026-10-02
-- 前置: Unit 1、2 已執行
-- ----------------------------------------------------------------------------
-- 🔴 整檔是【一個】DO 區塊 = 原子單元。第一行 PERFORM _ops.assert_env('staging')。
-- 🔴 本檔為【來源檔】。__PRODUCTION.sql 只改 1 處:
--      可執行守衛 _ops.assert_env('staging') → ('production')
-- 🔴 不碰任何 CB-93 物件(Q-1)。對應 get_store_credit_flags(),見 F-366。
-- 用途:admin-quotes.html 清單的 X 標示(第二階段 R1 / P-6)。
-- ============================================================================

DO $cb110u9$
BEGIN
  PERFORM _ops.assert_env('staging');

  -- 授權出口(CB-82 缺陷二):非 admin【拋錯】(42501),不回空集合 ——
  --   在純 PostgREST + RLS 下,「被擋」與「沒資料」同形。
  -- 前端以 count:'exact' 比對筆數與列數,偵測 max-rows 截斷(同 return)。
  -- 只回有 replacement 的單(GROUP BY),作廢與有效分開計數;
  --   前端只在 active_count > 0 時顯示 X(全部作廢 = 不顯示)。
  CREATE FUNCTION public.get_replacement_flags()
  RETURNS TABLE(quote_id uuid, active_count integer, voided_count integer)
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $fn$
  BEGIN
    IF NOT public.is_admin() THEN
      RAISE EXCEPTION 'get_replacement_flags: admin role required'
        USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
      SELECT r.quote_id,
             count(*) FILTER (WHERE r.voided_at IS NULL)::integer,
             count(*) FILTER (WHERE r.voided_at IS NOT NULL)::integer
      FROM public.quote_replacements r
      GROUP BY r.quote_id
      ORDER BY r.quote_id;
  END
  $fn$;

  REVOKE ALL ON FUNCTION public.get_replacement_flags() FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.get_replacement_flags() TO authenticated;

  COMMENT ON FUNCTION public.get_replacement_flags() IS
    'CB-110 phase 2. Parallel to get_store_credit_flags (CB-93); see F-366. '
    'Admin only; raises 42501 otherwise (never an empty set). Drives the X flag on admin-quotes.';

  RAISE NOTICE 'CB-110 Unit 9 完成:get_replacement_flags()。';
END
$cb110u9$;
