-- ============================================================================
-- CB-43 T14-3 — M0-staging: bootstrap 永久環境標記
-- ----------------------------------------------------------------------------
-- Repo : ProCraftBen/procraft-dealer-portal-staging  (branch: main)
-- Path : migrations/2026-07-16_CB-43-T14-3_M0-staging_bootstrap-env-marker.sql
--
-- 【只在 staging 跑】jkcbusliyrxbgebdrybl
-- 【對應檔】M0-production 只在 production 跑。兩支互斥,貼錯的那支會自己 ABORT。
--
-- ============================================================================
-- 【為什麼要有這支 — 讀完再跑】
--
-- 2026-07-16 事故:M2 v1 被誤貼到 production 執行。v1 對此的防護是「檔頭一行註解」
--   -- ⚠️ 執行前務必核對 SQL Editor 網址列的 project ref
-- 註解擋不住任何人。Supabase 兩個 project 的 SQL Editor 介面完全相同,
-- 而【驗證輸出也看不出來自哪個 project】—— 這是事故當下最難察覺的一點:
-- M2 的驗證輸出逐項核對全過,錯的不是輸出,是輸出的來源。
--
-- 事後補的 guard 用了兩道【啟發式指紋】:
--   ① quotes 筆數 >= 10          (當時 staging 24 / production 2)
--   ② quotes 有 CHECK constraint  (T14-1 已上 staging;production 尚未 promote)
--
-- 【那兩道指紋是消耗品】:
--   - production 的 quotes 會隨業務長大 → 指紋①失效
--   - T14-1 promote 上去後 production 也會有 CHECK constraint → 指紋②失效
--   → promote 那天,兩道指紋都會對 production 放行,guard 形同虛設。
--   → 而 promote 那天,正是兩個 SQL Editor 分頁最容易搞混的一天。
--
-- 【所以順序必須是】:
--   趁指紋還準 → 用它 bootstrap 永久標記 → 之後所有 migration 只讀永久標記。
--   反過來(promote 前才想 bootstrap)已經來不及 ——
--   那時沒有任何可靠的東西能回答「我現在連的是哪個 project」。
--
-- ============================================================================
-- 【為什麼放 _ops 而不是 settings】(Q10-B;偏離 PM 原案,理由如下)
--
-- PM 原案是 settings 表加一列 environment。查證後改用 _ops:
--
--   ① settings 的 RLS 沒有 key 白名單:
--        super_admin_write_settings   INSERT  WITH CHECK: is_super_admin()
--        super_admin_update_settings  UPDATE  USING: is_super_admin()  (WITH CHECK null → 沿用)
--      → 任何 super_admin 拿 JWT + anon key 就能
--        supabase.from('settings').upsert({key:'environment', value:'staging'}) 到 production
--      → 安全錨點被它要保護的對象改得動 = 壞設計。
--      (admin-accounts.html 只寫表單那幾個 key,但 UI 不是安全邊界,policy 才是。)
--
--   ② settings 是【產品設定表】(rta_adder / portal_name / admin_email …),有 UI、有人維護。
--      塞一個基礎設施標記進去是分類錯誤,遲早有人問「這什麼?」然後刪掉。
--
--   ③ _ops 不在 PostgREST 的暴露清單(預設只有 public / graphql_public)
--      → 這張表【無法經由 API 讀取或寫入】,任何角色都不行。
--
--   ④ _ops schema 本來就要建 —— 窗口稽核的 baseline 快照要用(見 M2 v2)。成本為零。
--
-- 若 PM 仍堅持 settings:把下方 CREATE SCHEMA/TABLE/INSERT 換成
--   INSERT INTO settings (key, value) VALUES ('environment','staging')
--   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
-- 並把 _ops.assert_env() 改讀 settings。約三行。
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

  IF v_is_prod THEN
    RAISE EXCEPTION
      'ABORT: 雙指紋判定為 production(quotes=% 筆、CHECK constraint=% 個)。這支是 M0-staging,請改跑 M0-production。未執行,無任何改動。',
      v_quotes, v_checks;
  END IF;

  -- 兩個指紋打架時,唯一誠實的行為是拒絕動作。
  -- 指紋的用途是「確定我在哪」,不是「猜我在哪」。
  IF NOT v_is_staging THEN
    RAISE EXCEPTION
      'ABORT: 雙指紋不一致(quotes=% 筆、CHECK constraint=% 個)→ 無法確定所在環境。未執行,無任何改動。請人工查證後再處理。',
      v_quotes, v_checks;
  END IF;

  RAISE NOTICE '雙指紋一致 → 判定 staging(quotes=% 筆、CHECK constraint=% 個)。繼續 bootstrap。',
    v_quotes, v_checks;
END
$guard$;


-- ── _ops schema:不對外暴露的維運空間 ────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS _ops;

-- 明確收回 API 角色的權限(PostgREST 本來就不暴露 _ops,這是第二道)
REVOKE ALL ON SCHEMA _ops FROM PUBLIC;
REVOKE ALL ON SCHEMA _ops FROM anon, authenticated;


-- ── 環境標記:單列表 ────────────────────────────────────────────────────────
--   id boolean PRIMARY KEY DEFAULT true CHECK (id)
--   → 這張表【結構上只能有一列】(id 只能是 true,且是 PK)
--   → 不可能出現「兩個環境標記」這種曖昧狀態
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
VALUES (true, 'staging', 'jkcbusliyrxbgebdrybl', 'CB-43 T14-3 M0 bootstrap (2026-07-16 事故後)')
ON CONFLICT (id) DO UPDATE
  SET name        = EXCLUDED.name,
      project_ref = EXCLUDED.project_ref,
      seeded_at   = now(),
      note        = EXCLUDED.note;


-- ── 給後續所有 migration 用的 guard helper ──────────────────────────────────
--   用法(放在 migration 的 BEGIN 之後第一行):
--     SELECT _ops.assert_env('staging');
--   promote 時只需把參數改成 'production' —— 這就是 PM 要的「只改期望值」。
--
--   SECURITY INVOKER(預設):SQL Editor 以 postgres 執行,讀得到 _ops;
--   anon/authenticated 連 schema 都進不來 → 不需要 DEFINER。
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
--   → 預期:true | staging | jkcbusliyrxbgebdrybl | <now> | CB-43 T14-3 M0 bootstrap...
--
-- SELECT _ops.assert_env('staging');     -- 應通過,印 NOTICE
-- SELECT _ops.assert_env('production');  -- 應 ABORT(這是刻意的自我測試)
--
-- 確認 API 碰不到(選做,需 anon key):
--   GET /rest/v1/environment  → 應 404 / 不存在(_ops 不在 PostgREST 暴露清單)


-- ============================================================================
-- ROLLBACK  R-M0
-- ----------------------------------------------------------------------------
-- ⚠️ 幾乎不會需要。這支不改任何既有行為,只新增一個不對外暴露的維運物件。
--    移除它反而會讓後續 migration 的 assert_env() 失去依據。
-- ============================================================================
-- BEGIN;
-- DROP FUNCTION IF EXISTS _ops.assert_env(text);
-- DROP TABLE IF EXISTS _ops.environment;
-- -- DROP SCHEMA IF EXISTS _ops;   -- 僅在確定 _ops 無其他用途(如窗口稽核 baseline)時才刪
-- COMMIT;
-- ============================================================================
