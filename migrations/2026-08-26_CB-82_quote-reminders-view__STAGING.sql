-- ════════════════════════════════════════════════════════════════════════
-- CB-82  quote_reminders_view — Company / PO# 攤平
--
-- 環境: STAGING
-- 日期: 2026-08-26
-- 前置: G-1 通過 (PG 17.6, security_invoker 支援)
--       G-2 通過 (RI cascade 繞過 RLS 與 GRANT)
--       單元 1 + 1a 完成 (表 / 約束 / 索引 / policy / GRANT)
--
-- 目的 (P-2 = B):
--   Company 與 PO# 不在 quote_reminders 表內。若改用 PostgREST embedded
--   inner join (quotes!inner(...)),會在本票內開一個【未驗證的邊界】——
--   F-30 才在 Stage 3 捕獲三個此類缺陷,三者皆不產生錯誤訊息,而 embedded
--   join 對 count:'exact' 與 .range() 的行為本庫從未實測。
--   攤平為 view 後,篩選 / 分頁 / count / tiebreaker 全部回到 F-30 已驗證
--   的【單一 relation】形態,零新邊界。
--
-- 🔴 本 view 僅供【讀取】。所有寫入一律走 base table public.quote_reminders。
--    此規則由 GRANT 強制,非僅靠註解約定 —— 見 §GRANT。
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

SELECT _ops.assert_env('staging');

-- DROP + CREATE 而非 CREATE OR REPLACE:
--   OR REPLACE 要求欄位集合與順序完全一致,日後增欄會直接失敗且訊息隱晦。
--   DROP + CREATE 包在同一 transaction 內,無中間態。
DROP VIEW IF EXISTS public.quote_reminders_view;

CREATE VIEW public.quote_reminders_view
WITH (security_invoker = true)   -- 🔴 見下方 §security_invoker
AS
SELECT
  -- ── base table 全欄透傳 ──────────────────────────────────────────────
  r.id,
  r.quote_id,
  r.type,
  r.reminder_date,
  r.subject,
  r.description,
  r.status,
  r.created_at,
  r.created_by,
  r.solved_date,

  -- ── 攤平欄 ────────────────────────────────────────────────────────────
  q.po_number,
  q.draft_number,
  -- 雙編號制:Draft 無 po_number,已提交單兩者皆有。
  -- 攤成單欄讓 PO# 篩選成為單欄 ilike,落在 F-30 已驗證形態內。
  -- ⚠️ V7 確認兩欄皆 nullable → 本欄仍可能為 NULL。
  --    🔴 刻意不在此填 '—' —— display != value,顯示 fallback 屬前端職責。
  --    NULL 時 ilike 不命中,那是正確行為(該列本來就沒有編號可搜)。
  COALESCE(q.po_number, q.draft_number) AS display_number,
  q.status AS quote_status,
  d.company_name,
  d.contact_name

FROM public.quote_reminders r
-- 🔴 quotes 用 INNER:FK (ON DELETE CASCADE) 保證母體必存在。
--    r 存在則 q 必存在,INNER 不會漏列。
JOIN public.quotes q
  ON q.id = r.quote_id
-- 🔴 dealers 用 LEFT:V7 實證 quotes.dealer_id 為 nullable(現況 0 筆,
--    但依 schema 判定而非依現況資料 —— 基準線有保鮮期,CB-81)。
--    若誤用 INNER,一張 dealer_id IS NULL 的單會讓它的 reminder 從清單中
--    【無聲消失】—— 不報錯,只是不見了。那正是本票要防的靜默失敗。
LEFT JOIN public.dealers d
  ON d.id = q.dealer_id;

-- ══ security_invoker ═══════════════════════════════════════════════════
-- 🔴 未設(PG 預設 security_definer)時,view 以【建立者】權限執行 ——
--    quote_reminders 的 admin-only policy 會被完全繞過,dealer 將讀得到
--    全部 reminder 內容,直接違反「dealer 端不得出現任何 reminder 內容」。
--
-- 設為 true 後,三張來源表的 RLS 皆以呼叫者身分套用:
--   quote_reminders : is_admin() → dealer 得到 0 列
--                     → INNER JOIN 後整個 view 對 dealer 恆為空集合
--   quotes / dealers: 各自既有 policy
--
-- 🔴 G-3 必須實測,不得推論(F-19)。
-- ═══════════════════════════════════════════════════════════════════════

-- ══ GRANT ══════════════════════════════════════════════════════════════
-- 🔴 只授 SELECT。本 view 為 auto-updatable —— 不 REVOKE 就真的寫得進去,
--    而透過 view 寫入會繞過「唯一寫入出口」的設計,且語意不明
--    (寫進去的是 base table,但看起來像在寫 view)。
--    以權限強制,不靠註解約定。
--
-- ⚠️ 單元 1a 的教訓:Supabase 的 ALTER DEFAULT PRIVILEGES 會在物件建立當下
--    即授予 authenticated 全部權限。只 GRANT 不 REVOKE 等於沒做。
--    故此處先 REVOKE ALL,再精確授予。
REVOKE ALL ON public.quote_reminders_view FROM anon;
REVOKE ALL ON public.quote_reminders_view FROM authenticated;

GRANT SELECT ON public.quote_reminders_view TO authenticated;

COMMENT ON VIEW public.quote_reminders_view IS
  'CB-82 唯讀 view。攤平 Company / PO#,供 admin-reminders.html 的分頁與篩選使用。'
  '🔴 security_invoker=true —— 移除即等同對 dealer 開放全部 reminder。'
  '🔴 僅 GRANT SELECT:所有寫入一律走 base table public.quote_reminders。'
  '🔴 dealers 為 LEFT JOIN:quotes.dealer_id 可為 NULL,INNER 會讓該列無聲消失。';

COMMIT;
