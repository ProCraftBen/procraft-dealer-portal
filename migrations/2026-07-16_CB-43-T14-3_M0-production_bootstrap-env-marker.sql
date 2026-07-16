-- ============================================================================
-- CB-43 T14-3 — M0-production: bootstrap 永久環境標記
-- ----------------------------------------------------------------------------
-- Repo : ProCraftBen/procraft-dealer-portal-staging  (branch: main)
-- Path : migrations/2026-07-16_CB-43-T14-3_M0-production_bootstrap-env-marker.sql
--
-- 【只在 production 跑】acwgemgpnusworpxxoai
-- 【對應檔】M0-staging 只在 staging 跑。兩支互斥,貼錯的那支會自己 ABORT。
--
-- ⚠️ 這支【現在就要跑】,不是等到 promote。理由見下方「時效性」。
--    它不改變 production 的任何行為 —— 只新增一個不對外暴露的維運物件。
--
-- ============================================================================
-- 【為什麼要有這支 — 讀完再跑】
--
-- 2026-07-16 事故:CB-43 T14-3 的 M2 v1 被誤貼到【本 project】執行。
--   影響:RPC 與 dealer RLS 被改動數十分鐘,期間 production 前端仍是舊版 = 破窗
--        (新單進 Stock Review 但無 badge/無 Edit/無 Pay Now;dealer 重送丟 42501)。
--   實際損害:0 筆訂單(窗口內無 dealer 活動)。已由 R-M2-PROD 完整還原。
--   當時的防護:M2 v1 檔頭的一行註解「⚠️ 執行前務必核對 project ref」。
--   → 註解擋不住任何人。而且【驗證輸出也看不出來自哪個 project】,
--     M2 的驗證逐項核對全過 —— 錯的不是輸出,是輸出的來源。
--
-- 【時效性 — 為什麼是現在,不是 promote 前】
--
-- 事後補的 guard 用了兩道啟發式指紋(quotes 筆數、有無 CHECK constraint)。
-- 那兩道指紋是【消耗品】:
--   - production 的 quotes 會隨業務長大 → 指紋①失效
--   - CB-43 promote 後 production 也會有 T14-1 的 CHECK constraint → 指紋②失效
--   → promote 那天,兩道指紋都會對 production 放行 → guard 形同虛設,
--     而 promote 那天正是兩個 SQL Editor 分頁最容易搞混的一天。
--
-- 所以:趁指紋還準 → 用它 bootstrap 永久標記 → 之後所有 migration 只讀永久標記。
-- 反過來(promote 前才想 bootstrap)已經來不及 ——
-- 那時沒有任何可靠的東西能回答「我現在連的是哪個 project」。
--
-- ============================================================================
-- 【為什麼放 _ops 而不是 settings】(Q10-B;偏離 PM 原案)
--   ① settings 的 RLS 沒有 key 白名單 → 任何 super_admin 可經 API
--      upsert({key:'environment', value:'staging'}) 到 production
--      → 安全錨點被它要保護的對象改得動 = 壞設計。
--   ② settings 是產品設定表(有 UI、有人維護)→ 塞基礎設施標記是分類錯誤。
--   ③ _ops 不在 PostgREST 暴露清單 → 這張表無法經由 API 讀寫,任何角色都不行。
--   ④ _ops schema 本來就要建(窗口稽核 baseline 快照要用)→ 成本為零。
--   詳見 M0-staging 檔頭。
-- ============================================================================


BEGIN;

-- ┌────────────────────────────────────────────────────────────────────────┐
-- │ GUARD — 雙指紋【必須一致】;不一致即 ABORT(不知道自己在哪 → 不猜)     │
-- └────────────────────────────────────────────────────────────────────────┘
DO $guard$
DECLARE
  v_quotes     int;
  v_checks     int;
  v_is_staging boolean;
  v_is_prod    boolean;
BEGIN
  SELECT count(*) INTO v_quotes FROM public.quotes;

  SELECT count(*) INTO v_checks
  FROM pg_constraint
  WHERE conrelid = 'public.quotes'::regclass AND contype = 'c';

  v_is_staging := (v_quotes >= 10) AND (v_checks >  0);
  v_is_prod    := (v_quotes <  10) AND (v_checks =  0);

  IF v_is_staging THEN
    RAISE EXCEPTION
      'ABORT: 雙指紋判定為 staging(quotes=% 筆、CHECK constraint=% 個)。這支是 M0-production,請改跑 M0-staging。未執行,無任何改動。',
      v_quotes, v_checks;
  END IF;

  -- 兩個指紋打架時,唯一誠實的行為是拒絕動作。
  -- 指紋的用途是「確定我在哪」,不是「猜我在哪」。
  IF NOT v_is_prod THEN
    RAISE EXCEPTION
      'ABORT: 雙指紋不一致(quotes=% 筆、CHECK constraint=% 個)→ 無法確定所在環境。未執行,無任何改動。請人工查證後再處理。',
      v_quotes, v_checks;
  END IF;

  RAISE NOTICE '雙指紋一致 → 判定 production(quotes=% 筆、CHECK constraint=% 個)。繼續 bootstrap。',
    v_quotes, v_checks;
END
$guard$;


-- ── _ops schema:不對外暴露的維運空間 ────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS _ops;

REVOKE ALL ON SCHEMA _ops FROM PUBLIC;
REVOKE ALL ON SCHEMA _ops FROM anon, authenticated;


-- ── 環境標記:單列表(結構上只能有一列)──────────────────────────────────────
CREATE TABLE IF NOT EXISTS _ops.environment (
  id          boolean     PRIMARY KEY DEFAULT true CHECK (id),
  name        text        NOT NULL CHECK (name IN ('staging', 'production')),
  project_ref text        NOT NULL,
  seeded_at   timestamptz NOT NULL DEFAULT now(),
  note        text
);

REVOKE ALL ON _ops.environment FROM PUBLIC;
REVOKE ALL ON _ops.environment FROM anon, authenticated;


INSERT INTO _ops.environment (id, name, project_ref, note)
VALUES (true, 'production', 'acwgemgpnusworpxxoai', 'CB-43 T14-3 M0 bootstrap (2026-07-16 事故後)')
ON CONFLICT (id) DO UPDATE
  SET name        = EXCLUDED.name,
      project_ref = EXCLUDED.project_ref,
      seeded_at   = now(),
      note        = EXCLUDED.note;


-- ── 給後續所有 migration 用的 guard helper ──────────────────────────────────
--   用法(放在 migration 的 BEGIN 之後第一行):
--     SELECT _ops.assert_env('production');
--   promote 時只需把參數從 'staging' 改成 'production' —— PM 要的「只改期望值」。
CREATE OR REPLACE FUNCTION _ops.assert_env(p_expected text)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_actual text;
  v_ref    text;
BEGIN
  SELECT name, project_ref INTO v_actual, v_ref FROM _ops.environment;

  IF v_actual IS NULL THEN
    RAISE EXCEPTION
      'ABORT: _ops.environment 未 seed → 無法判定環境。請先跑對應的 M0。未執行,無任何改動。';
  END IF;

  IF v_actual IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION
      'ABORT: 預期環境 = %,實際環境 = %(project_ref=%)。migration 未執行,無任何改動。',
      p_expected, v_actual, v_ref;
  END IF;

  RAISE NOTICE '環境驗證通過:%(project_ref=%)', v_actual, v_ref;
END
$$;

REVOKE ALL ON FUNCTION _ops.assert_env(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION _ops.assert_env(text) FROM anon, authenticated;

COMMIT;


-- ============================================================================
-- 驗證(執行後跑)
-- ============================================================================
-- SELECT * FROM _ops.environment;
--   → 預期:true | production | acwgemgpnusworpxxoai | <now> | CB-43 T14-3 M0 bootstrap...
--
-- SELECT _ops.assert_env('production');  -- 應通過,印 NOTICE
-- SELECT _ops.assert_env('staging');     -- 應 ABORT(刻意的自我測試)
--
-- ⚠️ 這是【最重要的一次驗證】:如果它印出 'staging',代表你把 M0-staging
--    貼到 production 了(理論上 guard 會擋,但仍請親眼確認)。
--
-- 【額外確認 — production 已從 2026-07-16 事故完整還原】
-- SELECT
--   (SELECT pg_get_functiondef(oid) LIKE '%Stock Review%' FROM pg_proc
--      WHERE proname='submit_purchase_order')          AS rpc_has_stock_review_應為false,
--   (SELECT with_check FROM pg_policies WHERE tablename='quotes'
--      AND policyname='dealer_update_own_quotes_when_editable') AS dealer_with_check_應為原始三值,
--   (SELECT count(*) FROM quotes WHERE status='Stock Review') AS stock_review_單_應為0;


-- ============================================================================
-- ROLLBACK  R-M0
-- ----------------------------------------------------------------------------
-- ⚠️ 幾乎不會需要。這支不改任何既有行為,只新增一個不對外暴露的維運物件。
--    移除它反而會讓後續 migration 的 assert_env() 失去依據。
-- ============================================================================
-- BEGIN;
-- DROP FUNCTION IF EXISTS _ops.assert_env(text);
-- DROP TABLE IF EXISTS _ops.environment;
-- -- DROP SCHEMA IF EXISTS _ops;
-- COMMIT;
-- ============================================================================
