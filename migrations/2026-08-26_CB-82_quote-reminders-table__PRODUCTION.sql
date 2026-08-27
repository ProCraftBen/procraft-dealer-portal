-- ════════════════════════════════════════════════════════════════════════
-- CB-82  訂單 Reminder 系統 — quote_reminders 表 + RLS
--
-- 🔴 【與 staging 的對應關係】(PM 拍板:合併版)
--    staging 分兩次執行:
--      2026-08-26_CB-82_quote-reminders-table__STAGING.sql   (建表,GRANT 有誤)
--      2026-08-26_CB-82.1_grant-fix__STAGING.sql             (GRANT 修正)
--    production 合併為本檔一次執行 —— 「檔案內容 = 實際執行內容」仍然成立,
--    且 authenticated 持有 TRUNCATE 的窗口在 production【根本不存在】。
--    不把 staging 的錯誤過程複製到 production。
--
-- 環境: PRODUCTION
-- 日期: 2026-08-26
-- 前置: G-1 已通過 (PostgreSQL 17.6, security_invoker 支援)
--
-- 本檔建立:
--   1. public.quote_reminders 表
--   2. 兩條具名 CHECK 約束
--   3. 兩個索引 (quote_id / status='marked' 部分索引)
--   4. ENABLE RLS + 三條 policy (SELECT / INSERT / UPDATE)
--   5. GRANT (刻意不含 DELETE)
--
-- 🔴 刻意【不建立】DELETE policy —— 見 §RLS 說明
-- 🔴 view 於單元 3 另檔建立,本檔不含
--
-- 相關: CB-76 (可重入形態)、F-56 (is_admin search_path)、F-30 (分頁 pattern)
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

SELECT _ops.assert_env('production');

DO $cb82$
BEGIN

  -- ══ 1. 表 ════════════════════════════════════════════════════════════
  -- 表名依據: 對齊 quote_items / quote_return_history 的「母表單數 + 語意
  --   複數」慣例。FK 指向 quotes,不指向任何 order 實體 —— 採 order_reminders
  --   會製造「表名說 order、FK 指 quotes」的同名不同義。
  --
  -- 🔴 quote_id 的 ON DELETE CASCADE 是必要而非偏好:
  --    quotes.html:770-783 的 dealer 刪 draft 是以【dealer 的 JWT】執行硬刪。
  --    若採 NO ACTION,dealer 會撞 FK violation,拿到一個他自己無法排除的
  --    錯誤。CASCADE 之所以能生效,是因為 PostgreSQL 的 referential
  --    integrity 動作繞過 RLS —— dealer 對本表零 policy 不影響 cascade。
  --    🔴 此為承重假設,G-2 必須實測 (F-19: 不拿文件當實測)。
  --
  -- 🔴 created_by 刻意【不建 FK】:
  --    (a) delete-dealer Edge Function (admin-dealers.html:2261 /
  --        admin-accounts.html:538) 刻意繞過 FK 阻擋。加 NO ACTION FK 會讓
  --        刪除 admin 帳號被本表擋下 —— 那是本票對既有功能造成的迴歸。
  --    (b) SET NULL 會抹掉 attribution,而「誰記的、可交接」正是本票的核心價值。
  --    顯示層沿用 admin-quotes.html:738 renderSalesCell() 的
  --    「uuid -> allDealers map,查無回 (unknown)」形態。
  --
  -- 🔴 欄位命名:
  --    reminder_date  不用 date         —— SQL 保留字
  --                   不用 created_date —— 與 created_at (Record Time) 語意撞車
  --    created_at     = Record Time (timestamptz,伺服器時間)
  --    solved_date    = Solved Date (date,client 端 todayLocalISO())
  --    兩者刻意不同型別,不是疏漏 —— 需求書分別寫的是 Time 與 Date,且
  --    order-complete.js:102-115 已定版:date 型別全程純字串,不經 Date
  --    物件往返,否則美東 20:00 後 UTC 已跨日會少一天。
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'quote_reminders'
  ) THEN
    CREATE TABLE public.quote_reminders (
      id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      quote_id      uuid        NOT NULL
                                REFERENCES public.quotes(id) ON DELETE CASCADE,
      type          text        NOT NULL,
      reminder_date date        NULL,
      subject       text        NOT NULL,
      description   text        NULL,
      status        text        NOT NULL DEFAULT 'marked',
      created_at    timestamptz NOT NULL DEFAULT now(),
      created_by    uuid        NOT NULL DEFAULT auth.uid(),
      solved_date   date        NULL
    );
    RAISE NOTICE 'CB-82: 已建立 public.quote_reminders。';
  ELSE
    RAISE NOTICE 'CB-82: public.quote_reminders 已存在,略過建表。';
  END IF;

  -- ══ 2. 具名 CHECK 約束 ═══════════════════════════════════════════════
  -- 🔴 具名而非 inline (CB-76 Q-20 定版):inline CHECK 的自動命名恰好也是
  --    quote_reminders_type_check,但那是巧合對上。日後本欄若再加第二條
  --    CHECK,自動命名會變成 _check1,埋下不一致。
  --
  -- 🔴 值採小寫 (P-1 = B):
  --    (a) CB-76 dealers_account_type_check 是最近一次新建列舉欄,選的是
  --        小寫底線 —— 現行方向。
  --    (b) 帶空格的值在 PostgREST query string 需編碼,而本票的 ! 標示查詢
  --        直接以 .eq('status','marked') 打到此欄。
  --    (c) quotes.status 的 TitleCase 帶空格是「不能改,不是典範」(CB-79 Q-1)。
  --    顯示層用 JS map,DB 值永不為顯示改動 (display != value)。
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.quote_reminders'::regclass
      AND conname  = 'quote_reminders_type_check'
  ) THEN
    ALTER TABLE public.quote_reminders
      ADD CONSTRAINT quote_reminders_type_check
      CHECK (type IN ('backorder', 'payment', 'other'));
    RAISE NOTICE 'CB-82: 已新增 quote_reminders_type_check。';
  ELSE
    RAISE NOTICE 'CB-82: quote_reminders_type_check 已存在,略過。';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.quote_reminders'::regclass
      AND conname  = 'quote_reminders_status_check'
  ) THEN
    ALTER TABLE public.quote_reminders
      ADD CONSTRAINT quote_reminders_status_check
      CHECK (status IN ('marked', 'solved'));
    RAISE NOTICE 'CB-82: 已新增 quote_reminders_status_check。';
  ELSE
    RAISE NOTICE 'CB-82: quote_reminders_status_check 已存在,略過。';
  END IF;

  RAISE NOTICE 'CB-82: 表與約束段完成。';

END
$cb82$;

-- ══ 3. 索引 ════════════════════════════════════════════════════════════
-- CREATE INDEX IF NOT EXISTS 本身冪等,不需包在 DO 內。
--
-- idx_quote_reminders_quote_id:
--   支援 FK cascade 與 quote-detail.html 依單號取 reminder 清單。
--   FK 不會自動建索引 —— 缺它時每次 quotes 刪除都要全表掃 quote_reminders。
--
-- idx_quote_reminders_marked (部分索引):
--   ! 標示查詢是本票唯一的熱路徑 (每次 admin-quotes.html init 各打一次)。
--   部分索引只收 status='marked' 的列,體積遠小於全欄索引。
--   🔴 solved 那支查詢刻意不建對應索引 —— 綠 ✓ 是次要資訊,且 solved 列
--      會隨時間累積成多數,部分索引在該側無優勢。
CREATE INDEX IF NOT EXISTS idx_quote_reminders_quote_id
  ON public.quote_reminders (quote_id);

CREATE INDEX IF NOT EXISTS idx_quote_reminders_marked
  ON public.quote_reminders (quote_id)
  WHERE status = 'marked';

-- ══ 4. RLS ═════════════════════════════════════════════════════════════
-- 🔴 ENABLE 必須在 policy 之前 —— 順序反了會有「policy 已存在但 RLS 未啟用」
--    的窗口,那個窗口內本表對所有 authenticated 使用者全開。
ALTER TABLE public.quote_reminders ENABLE ROW LEVEL SECURITY;

DO $cb82rls$
BEGIN

  -- is_admin() 基線 (Stage 0 兩環境實證):
  --   prosecdef = true, proconfig = {"search_path=public, pg_temp"}
  --   F-56 已修,staging 與 production 一致。

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'quote_reminders'
      AND policyname = 'admin_read_quote_reminders'
  ) THEN
    CREATE POLICY admin_read_quote_reminders
      ON public.quote_reminders
      FOR SELECT TO authenticated
      USING (public.is_admin());
    RAISE NOTICE 'CB-82: 已建立 admin_read_quote_reminders。';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'quote_reminders'
      AND policyname = 'admin_insert_quote_reminders'
  ) THEN
    CREATE POLICY admin_insert_quote_reminders
      ON public.quote_reminders
      FOR INSERT TO authenticated
      WITH CHECK (public.is_admin());
    RAISE NOTICE 'CB-82: 已建立 admin_insert_quote_reminders。';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'quote_reminders'
      AND policyname = 'admin_update_quote_reminders'
  ) THEN
    CREATE POLICY admin_update_quote_reminders
      ON public.quote_reminders
      FOR UPDATE TO authenticated
      USING (public.is_admin())
      WITH CHECK (public.is_admin());
    RAISE NOTICE 'CB-82: 已建立 admin_update_quote_reminders。';
  END IF;

  -- ══ 🔴 DELETE policy 刻意不存在 ═════════════════════════════════════
  --
  -- 「不可刪除」有兩層語意,由兩個不同機制承擔:
  --
  --   規則              範圍        實作層
  --   ────────────────  ──────────  ────────────────────────────────
  --   使用者不能刪      使用者      DB 層:無 DELETE policy,即使繞過
  --                                 UI 直接打 API 也刪不掉
  --   母體消失則連帶    系統行為    FK CASCADE:RI 動作繞過 RLS,
  --   消失                          不受本條缺席影響
  --
  -- 兩者不衝突,且此設計比「只藏按鈕」強得多 —— 藏按鈕擋不住任何人。
  --
  -- ⚠️ 日後若有人為了「讓 dealer 刪 draft 能順利 cascade」而想補一條 dealer
  --    DELETE policy —— 不需要,也不可以。cascade 本來就不看 policy。
  --    補了等於開一個真的能刪 reminder 的洞。
  -- ═══════════════════════════════════════════════════════════════════

  RAISE NOTICE 'CB-82: RLS 段完成。DELETE policy 刻意不存在。';

END
$cb82rls$;

-- ══ 5. GRANT ═══════════════════════════════════════════════════════════
-- 🔴🔴 這一段是 staging 犯過錯、production 一次做對的地方,務必逐字保留。
--
-- staging 原檔只寫了 GRANT、沒寫 REVOKE authenticated,結果 V5 驗證發現
-- authenticated 持有 DELETE / TRUNCATE / TRIGGER / REFERENCES ——
-- 因為 Supabase 的 ALTER DEFAULT PRIVILEGES 在 CREATE TABLE 當下就已授予
-- 全部權限,在既有的 ALL 上再 GRANT 一次等於什麼都沒做。
-- staging 事後以 CB-82.1 補救,但補救之前那段時間權限是全開的。
--
-- 🔴 為什麼 TRUNCATE 比 DELETE 嚴重:
--    DELETE 受 RLS 管轄 —— 本表無 DELETE policy,即使有 GRANT 也擋得住。
--    TRUNCATE【不受 RLS 管轄】,policy 對它完全無效,只看 GRANT。
--    (可達性上 PostgREST 無 TRUNCATE 端點,故屬縱深防禦缺口而非活洞,
--     但沒有理由留著。)
--
-- 🔴 原則(PM 已採納):新建物件的權限一律「先 REVOKE 再 GRANT」,
--    不可只 GRANT。
--
-- 🔴 刻意【不 GRANT DELETE】—— 與「無 DELETE policy」形成雙層。
--    即使日後有人誤加 DELETE policy,少了 GRANT 仍擋得住。
REVOKE ALL ON public.quote_reminders FROM anon;
REVOKE ALL ON public.quote_reminders FROM authenticated;

GRANT SELECT, INSERT, UPDATE ON public.quote_reminders TO authenticated;

-- ⚠️ service_role 與 postgres 保持不動 —— Edge Function 與後台作業依賴它們。

-- ══ 6. COMMENT ═════════════════════════════════════════════════════════
COMMENT ON TABLE public.quote_reminders IS
  'CB-82 訂單 Reminder。admin-only(dealer 零 policy)。'
  '🔴 不可刪除:無 DELETE policy 且無 DELETE GRANT。'
  '🔴 quote_id CASCADE:draft 被刪時連帶消失(RI 繞過 RLS)。'
  '🔴 created_by 無 FK:避免 delete-dealer Edge Function 被擋,顯示走 client map。'
  'type/status 採小寫(P-1=B),顯示層用 JS map。';

COMMENT ON COLUMN public.quote_reminders.reminder_date IS
  'reminder 自己的日期,非訂單開立時間。type 為 backorder/payment 時必填 —— '
  '🔴 僅前端驗證,刻意不做 DB CHECK 或 trigger(admin-only 內部工具,成本不成比例)。';

COMMENT ON COLUMN public.quote_reminders.created_by IS
  '建立 reminder 的帳戶,非訂單負責業務。'
  '🔴 與 admin-quotes.html 的 Sales 欄(dealers.assigned_sales_id)語意不同,'
  '故本表對外一律稱 Created By,不用 Sales(F-25 同名不同義)。';

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- 驗證(COMMIT 後另跑,唯讀)
-- ════════════════════════════════════════════════════════════════════════
-- SELECT current_database() AS db, 'V1' AS v, column_name, data_type, is_nullable, column_default
-- FROM information_schema.columns
-- WHERE table_schema='public' AND table_name='quote_reminders' ORDER BY ordinal_position;
--
-- SELECT current_database() AS db, 'V2' AS v, conname, pg_get_constraintdef(oid)
-- FROM pg_constraint WHERE conrelid='public.quote_reminders'::regclass;
--
-- SELECT current_database() AS db, 'V3' AS v, policyname, cmd, qual, with_check
-- FROM pg_policies WHERE schemaname='public' AND tablename='quote_reminders';
--
-- SELECT current_database() AS db, 'V4' AS v, relrowsecurity
-- FROM pg_class WHERE oid='public.quote_reminders'::regclass;
--
-- SELECT current_database() AS db, 'V5' AS v, grantee, privilege_type
-- FROM information_schema.role_table_grants
-- WHERE table_schema='public' AND table_name='quote_reminders' ORDER BY grantee, privilege_type;
--
-- SELECT current_database() AS db, 'V6' AS v, indexname, indexdef
-- FROM pg_indexes WHERE schemaname='public' AND tablename='quote_reminders';

-- ════════════════════════════════════════════════════════════════════════
-- ROLLBACK(刻意不含 assert_env —— 沿用 F1 慣例)
-- ════════════════════════════════════════════════════════════════════════
-- DROP TABLE IF EXISTS public.quote_reminders CASCADE;
--   ⚠️ CASCADE 會一併移除 quote_reminders_view(單元 3)。
--   ⚠️ 資料無法復原。回滾前先確認表內無正式資料。
