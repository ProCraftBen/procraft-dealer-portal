-- ============================================================================
-- CB-92 U-1  已付款單作廢改單(close_paid_order)
-- ----------------------------------------------------------------------------
-- 環境:PRODUCTION (acwgemgpnusworpxxoai)
-- 日期:2026-09-15
--
-- 內容:
--   ① quotes.close_reason_type 欄位 + 兩條 CHECK            (Q-1 / Q-2)
--   ② public.block_closed_quote_change() + trigger          (Q-5 / Q-15 / Q-18 / Q-19)
--   ③ public.close_paid_order() RPC                         (Q-6 B / Q-7 / Q-8 / Q-16)
--   ④ COMMENT:欄位 ×2(含 payments.cancellation_reason 代寫)、函式 ×2、trigger ×1
--
-- 執行方式(Supabase SQL Editor):
--   Segment 1 → Segment 2 → Segment 3,依序各自執行。
--   🔴 Segment 1 為【唯一原子單元】,必須整段一次執行。
--      開頭主動斷言所有前置條件,任一不符即 RAISE EXCEPTION,整段不生效。
--   Segment 3 為驗證,回傳結果集(不用 RAISE NOTICE —— SQL Editor 不顯示)。
--
-- promote 到 production:
--   全檔 'staging' 字面值共【4 處】(不含本說明),全部改為 'production',其餘一字不改:
--     Segment 1 開頭      SELECT _ops.assert_env(...)
--     Segment 1 DO 區塊內 PERFORM _ops.assert_env(...)
--     Segment 3 V-00      期望值
--     R-1(註解中)       PERFORM _ops.assert_env(...)
--   檔名 __STAGING 改為 __PRODUCTION。
--
-- 回滾:檔尾 R-1(預設註解,不會執行)。
-- ============================================================================


-- ============================================================================
-- Segment 1 / 3   🔴 原子單元 —— 必須整段一次執行
-- ============================================================================

SELECT _ops.assert_env('production');

DO $cb92$
DECLARE
  v_n int;
BEGIN
  PERFORM _ops.assert_env('production');

  -- ── 前置條件 ①:quotes 非內部 trigger 恰為 8 支,且名稱集合吻合 Stage 0 S-3 ──
  SELECT count(*) INTO v_n
  FROM pg_catalog.pg_trigger t
  WHERE t.tgrelid = 'public.quotes'::regclass AND NOT t.tgisinternal;
  IF v_n <> 8 THEN
    RAISE EXCEPTION 'CB-92 ABORT: quotes has % non-internal triggers, expected 8 (Stage 0 S-3).', v_n;
  END IF;

  SELECT count(*) INTO v_n
  FROM pg_catalog.pg_trigger t
  WHERE t.tgrelid = 'public.quotes'::regclass AND NOT t.tgisinternal
    AND t.tgenabled = 'O'
    AND t.tgname IN ('trg_block_trial_status_change', 'trg_block_trial_status_on_insert',
                     'trg_enforce_dealer_quote_transition', 'trg_record_account_event_del',
                     'trg_record_account_event_ins', 'trg_record_account_event_upd',
                     'trg_record_status_history', 'trg_record_status_history_on_insert');
  IF v_n <> 8 THEN
    RAISE EXCEPTION 'CB-92 ABORT: only % of the 8 expected quotes triggers exist and are enabled.', v_n;
  END IF;

  -- ── 前置條件 ②:本票物件皆尚未存在(防重跑) ─────────────────────────────
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
             WHERE a.attrelid = 'public.quotes'::regclass
               AND a.attname = 'close_reason_type' AND NOT a.attisdropped) THEN
    RAISE EXCEPTION 'CB-92 ABORT: public.quotes.close_reason_type already exists.';
  END IF;
  IF to_regprocedure('public.block_closed_quote_change()') IS NOT NULL THEN
    RAISE EXCEPTION 'CB-92 ABORT: public.block_closed_quote_change() already exists.';
  END IF;
  IF to_regprocedure('public.close_paid_order(uuid,uuid,text,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'CB-92 ABORT: public.close_paid_order(uuid,uuid,text,text) already exists.';
  END IF;

  -- ── 前置條件 ③:狀態值域含本票依賴的三個值(Stage 0 S-1) ───────────────
  SELECT count(*) INTO v_n
  FROM (VALUES ('Order Processing'), ('Order Completed'), ('Closed')) AS w(v)
  WHERE EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
                WHERE c.conrelid = 'public.quotes'::regclass
                  AND c.conname = 'quotes_status_check'
                  AND position(quote_literal(w.v) IN pg_catalog.pg_get_constraintdef(c.oid)) > 0);
  IF v_n <> 3 THEN
    RAISE EXCEPTION 'CB-92 ABORT: quotes_status_check does not contain all of Order Processing / Order Completed / Closed.';
  END IF;

  -- ── 前置條件 ④:依賴函式存在 ───────────────────────────────────────────
  IF to_regprocedure('public.is_super_admin()') IS NULL
     OR to_regprocedure('public.get_quote_store_credit_count(uuid)') IS NULL THEN
    RAISE EXCEPTION 'CB-92 ABORT: dependency is_super_admin() or get_quote_store_credit_count(uuid) is missing.';
  END IF;

  -- ── 前置條件 ⑤:payments.cancellation_reason 目前無 COMMENT(Payment PM 要求) ──
  --    代寫前斷言,不為 NULL 即中止 —— 不無聲覆蓋 payment 線的既有內容。
  IF pg_catalog.col_description('public.payments'::regclass,
       (SELECT a.attnum FROM pg_catalog.pg_attribute a
        WHERE a.attrelid = 'public.payments'::regclass
          AND a.attname = 'cancellation_reason' AND NOT a.attisdropped)) IS NOT NULL THEN
    RAISE EXCEPTION 'CB-92 ABORT: public.payments.cancellation_reason already has a COMMENT; refusing to overwrite.';
  END IF;


  -- ══════════════════════════════════════════════════════════════════════════
  -- ① 欄位 + CHECK
  -- ══════════════════════════════════════════════════════════════════════════
  ALTER TABLE public.quotes ADD COLUMN close_reason_type text;

  ALTER TABLE public.quotes ADD CONSTRAINT quotes_close_reason_type_check
    CHECK (close_reason_type IS NULL
           OR close_reason_type IN ('bulk_return', 'bulk_exchange', 'other'));

  -- 🔴 status 為 nullable:寫成 status = 'Closed' 時,status 為 NULL 會使整式為 NULL
  --    而被 CHECK 放行。明確要求 status IS NOT NULL(F-35 正向識別)。
  ALTER TABLE public.quotes ADD CONSTRAINT quotes_close_reason_type_status_check
    CHECK (close_reason_type IS NULL
           OR (status IS NOT NULL AND status = 'Closed'));


  -- ══════════════════════════════════════════════════════════════════════════
  -- ② trigger 函式 + trigger
  -- ══════════════════════════════════════════════════════════════════════════
  CREATE FUNCTION public.block_closed_quote_change()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = ''
  AS $fn$
  DECLARE
    -- 🔴 旗標名稱是契約:與 public.close_paid_order() 內的同名常數必須一致。
    c_flag CONSTANT text := 'procraft.cb92_close';
  BEGIN
    -- ── DELETE ──────────────────────────────────────────────────────────────
    IF TG_OP = 'DELETE' THEN
      IF OLD.status IS NOT DISTINCT FROM 'Closed' THEN
        RAISE EXCEPTION 'CB-92: quote % is Closed (terminal) and cannot be deleted.', OLD.id
          USING ERRCODE = '42501';
      END IF;
      -- 🔴 必須 RETURN OLD。DELETE 時 NEW 為 NULL,RETURN NEW 會使 PostgreSQL
      --    靜默略過刪除(0 列、不報錯)—— 所有 Draft 將無聲地刪不掉。
      RETURN OLD;
    END IF;

    IF TG_OP <> 'UPDATE' THEN
      RAISE EXCEPTION 'CB-92: block_closed_quote_change() fired for unexpected TG_OP %.', TG_OP;
    END IF;

    -- ── UPDATE:已 Closed 的單 ───────────────────────────────────────────────
    IF OLD.status IS NOT DISTINCT FROM 'Closed' THEN
      -- R-b:終態不可離開
      IF NEW.status IS DISTINCT FROM OLD.status THEN
        RAISE EXCEPTION 'CB-92: quote % is Closed (terminal); status change to % is not permitted.',
          OLD.id, NEW.status
          USING ERRCODE = '42501';
      END IF;
      -- R-c:分類凍結(Q-1 鑑別規則的保護)
      IF NEW.close_reason_type IS DISTINCT FROM OLD.close_reason_type THEN
        RAISE EXCEPTION 'CB-92: close_reason_type of Closed quote % is frozen.', OLD.id
          USING ERRCODE = '42501';
      END IF;
      RETURN NEW;
    END IF;

    -- ── UPDATE:尚未 Closed 的單(R-d)──────────────────────────────────────
    --    OP/OC → Closed 與 close_reason_type 寫入,必須【同時】發生,
    --    且必須由 close_paid_order() 在本交易設定旗標。
    IF (NEW.status IS NOT DISTINCT FROM 'Closed'
        AND OLD.status IN ('Order Processing', 'Order Completed'))
       OR NEW.close_reason_type IS NOT NULL THEN

      IF current_setting(c_flag, true) IS NOT DISTINCT FROM 'on'
         AND OLD.status IN ('Order Processing', 'Order Completed')
         AND NEW.status IS NOT DISTINCT FROM 'Closed'
         AND NEW.close_reason_type IS NOT NULL THEN
        RETURN NEW;
      END IF;

      RAISE EXCEPTION 'CB-92: voiding a paid order (% -> %, close_reason_type %) is only permitted via public.close_paid_order().',
        OLD.status, NEW.status, coalesce(NEW.close_reason_type, 'NULL')
        USING ERRCODE = '42501';
    END IF;

    -- 其餘 UPDATE 原樣放行,不修改 NEW。
    RETURN NEW;
  END
  $fn$;

  REVOKE ALL ON FUNCTION public.block_closed_quote_change() FROM PUBLIC, anon, authenticated, service_role;

  -- 🔴 無 WHEN 子句:同時涵蓋 DELETE 的 trigger,其 WHEN 不可引用 NEW,
  --    而 R-d 必須檢查 NEW(Q-19 = B)。判斷全部在函式內完成。
  -- 🔴 名稱是功能不變量,見 COMMENT ON TRIGGER。
  CREATE TRIGGER trg_block_closed_quote_change
    BEFORE UPDATE OR DELETE ON public.quotes
    FOR EACH ROW
    EXECUTE FUNCTION public.block_closed_quote_change();


  -- ══════════════════════════════════════════════════════════════════════════
  -- ③ RPC
  -- ══════════════════════════════════════════════════════════════════════════
  CREATE FUNCTION public.close_paid_order(
    p_quote_id          uuid,
    p_payment_id        uuid,
    p_close_reason_type text,
    p_reason            text
  )
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $fn$
  DECLARE
    -- 🔴 旗標名稱是契約:與 public.block_closed_quote_change() 內的同名常數必須一致。
    --    不一致的症狀是「本 RPC 被自己的 trigger 以 42501 擋下」—— 看起來像權限問題。
    c_flag CONSTANT text := 'procraft.cb92_close';

    v_uid           uuid := auth.uid();
    v_quote_id      uuid;
    v_quote_status  text;
    v_quote_po      text;
    v_active_sc     integer;
    v_confirmed_n   integer := 0;
    v_payment_id    uuid;
    v_total_paid    numeric;
    v_method        text;
    v_actor_name    text;
    v_type          text;
    v_reason_input  text;
    v_reason        text;
    v_cancelled_at  timestamptz := now();
    v_rows          integer;
    r               record;
  BEGIN
    -- ── ① 授權:DB 強制 super_admin(Q-6 B)─────────────────────────────────
    IF v_uid IS NULL OR public.is_super_admin() IS NOT TRUE THEN
      RAISE EXCEPTION 'CB-92: only super_admin can void a paid order.'
        USING ERRCODE = '42501';
    END IF;

    -- ── ② 輸入 ─────────────────────────────────────────────────────────────
    IF p_quote_id IS NULL OR p_payment_id IS NULL THEN
      RAISE EXCEPTION 'CB-92: p_quote_id and p_payment_id are required.'
        USING ERRCODE = '23514';
    END IF;

    v_type := p_close_reason_type;
    IF (v_type IN ('bulk_return', 'bulk_exchange', 'other')) IS NOT TRUE THEN
      RAISE EXCEPTION 'CB-92: close_reason_type must be bulk_return, bulk_exchange or other (got %).',
        coalesce(v_type, 'NULL')
        USING ERRCODE = '23514';
    END IF;

    -- 空白字元(含換行)壓成單一空格並去頭尾,使寫入的說明恆為單行。
    v_reason_input := btrim(regexp_replace(coalesce(p_reason, ''), '\s+', ' ', 'g'));
    IF v_reason_input = '' THEN
      RAISE EXCEPTION 'CB-92: a void reason is required.'
        USING ERRCODE = '23514';
    END IF;
    IF char_length(v_reason_input) > 500 THEN
      RAISE EXCEPTION 'CB-92: void reason is too long (% characters, max 500).', char_length(v_reason_input)
        USING ERRCODE = '23514';
    END IF;

    -- ── ③ 鎖單 + 前態守衛(正向列舉)──────────────────────────────────────
    --    鎖序:quotes 先、payments 後,與 admin-payments actConfirm() 寫序一致。
    SELECT q.id, q.status, q.po_number
      INTO v_quote_id, v_quote_status, v_quote_po
    FROM public.quotes q
    WHERE q.id = p_quote_id
    FOR UPDATE;

    IF v_quote_id IS NULL THEN
      RAISE EXCEPTION 'CB-92: quote % not found.', p_quote_id
        USING ERRCODE = 'P0002';
    END IF;

    IF (v_quote_status IN ('Order Processing', 'Order Completed')) IS NOT TRUE THEN
      RAISE EXCEPTION 'CB-92: quote % is %; only Order Processing or Order Completed can be voided.',
        coalesce(v_quote_po, p_quote_id::text), coalesce(v_quote_status, 'NULL')
        USING ERRCODE = '42501';
    END IF;

    -- ── ④ store credit 必須為 0(Q-8)─────────────────────────────────────
    SELECT sc.active_count INTO v_active_sc
    FROM public.get_quote_store_credit_count(p_quote_id) AS sc;

    IF (v_active_sc = 0) IS NOT TRUE THEN
      RAISE EXCEPTION 'CB-92: quote % has % active store credit(s); void them before closing the order.',
        coalesce(v_quote_po, p_quote_id::text), coalesce(v_active_sc::text, 'NULL')
        USING ERRCODE = '42501';
    END IF;

    -- ── ⑤ 前置斷言:confirmed 恰為 1 筆,且即畫面顯示的那筆(Q-7)────────
    --    逐列 FOR UPDATE 計數,鎖住所有 confirmed 列後才判斷。
    FOR r IN
      SELECT p.id, p.total_paid, p.payment_method
      FROM public.payments p
      WHERE p.quote_id = p_quote_id
        AND p.status = 'confirmed'
      ORDER BY p.id
      FOR UPDATE
    LOOP
      v_confirmed_n := v_confirmed_n + 1;
      v_payment_id  := r.id;
      v_total_paid  := r.total_paid;
      v_method      := r.payment_method;
    END LOOP;

    IF v_confirmed_n <> 1 THEN
      RAISE EXCEPTION 'CB-92: quote % has % confirmed payment(s); exactly 1 is required.',
        coalesce(v_quote_po, p_quote_id::text), v_confirmed_n
        USING ERRCODE = '42501';
    END IF;

    IF v_payment_id IS DISTINCT FROM p_payment_id THEN
      RAISE EXCEPTION 'CB-92: the confirmed payment on quote % is not the one shown on screen; reload and try again.',
        coalesce(v_quote_po, p_quote_id::text)
        USING ERRCODE = '40001';
    END IF;

    -- ── ⑥ 處理人 ───────────────────────────────────────────────────────────
    SELECT btrim(d.contact_name) INTO v_actor_name
    FROM public.dealers d
    WHERE d.id = v_uid;

    IF coalesce(v_actor_name, '') = '' THEN
      RAISE EXCEPTION 'CB-92: acting super_admin % has no contact_name.', v_uid
        USING ERRCODE = '23514';
    END IF;

    -- ── ⑦ 組合作廢說明(Q-16):自動帶入項一律取自 DB,不信 client ───────────
    v_reason := format(
      'CB-92 void | Type: %s | Received: $%s (%s) | Reason: %s | By: %s | Date: %s (America/New_York)',
      v_type,
      to_char(v_total_paid, 'FM999,999,999,990.00'),
      coalesce(v_method, 'not recorded'),
      v_reason_input,
      v_actor_name,
      to_char(v_cancelled_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD')
    );

    -- ── ⑧ 寫 quotes(quotes-first)────────────────────────────────────────
    --    🔴 旗標只在本交易有效(第三參數 true)。Supabase 連線池下若設為 session
    --       層級,旗標會殘留給下一個請求 —— 等於一條永久開啟的繞道。
    PERFORM set_config(c_flag, 'on', true);

    UPDATE public.quotes q
       SET status            = 'Closed',
           close_reason_type = v_type
     WHERE q.id = p_quote_id
       AND q.status IN ('Order Processing', 'Order Completed');
    GET DIAGNOSTICS v_rows = ROW_COUNT;

    -- 🔴 立即關閉,不讓後續任何語句帶著旗標。
    PERFORM set_config(c_flag, 'off', true);

    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'CB-92: quote update affected % row(s), expected 1.', v_rows
        USING ERRCODE = '40001';
    END IF;

    -- ── ⑨ 寫 payments:四欄齊寫(Payment PM 確認)─────────────────────────
    UPDATE public.payments p
       SET status              = 'cancelled',
           cancellation_reason = v_reason,
           cancelled_at        = v_cancelled_at,
           cancelled_by        = v_uid
     WHERE p.id = v_payment_id
       AND p.status = 'confirmed';
    GET DIAGNOSTICS v_rows = ROW_COUNT;

    -- 後置斷言(Q-7):≠ 1 即 RAISE,連同 ⑧ 整筆回滾,中間態不可能留下。
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'CB-92: payment update affected % row(s), expected 1.', v_rows
        USING ERRCODE = '40001';
    END IF;

    RETURN jsonb_build_object(
      'quote_id',            p_quote_id,
      'po_number',           v_quote_po,
      'payment_id',          v_payment_id,
      'close_reason_type',   v_type,
      'cancelled_at',        v_cancelled_at,
      'cancellation_reason', v_reason
    );
  END
  $fn$;

  REVOKE ALL ON FUNCTION public.close_paid_order(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;
  GRANT EXECUTE ON FUNCTION public.close_paid_order(uuid, uuid, text, text) TO authenticated;


  -- ══════════════════════════════════════════════════════════════════════════
  -- ④ COMMENT(契約文件,綁入原子單元 —— 物件存在則說明必存在)
  -- ══════════════════════════════════════════════════════════════════════════
  COMMENT ON COLUMN public.quotes.close_reason_type IS
$doc$CB-92 單子結束的分類(統計用)。值域以 CHECK 鎖三值,顯示名另行 map,DB 值不翻譯。
  bulk_return    整批退貨
  bulk_exchange  整批換貨
  other          其他

🔴 語意(Q-1):
  NULL      = 非 CB-92 路徑。status='Closed' 時代表「付款前關單」
              (admin-quotes confirmCloseQuote,自 Pending / Stock Review)。
  非 NULL   = 已付款後作廢(僅 public.close_paid_order() 能寫入)。
  CHECK quotes_close_reason_type_status_check:非 Closed 的單不得帶值。
  trigger trg_block_closed_quote_change:Closed 後本欄凍結;
    NULL → 非 NULL 只能與 OP/OC → Closed 同時發生且帶旗標。

🔴 與 public.payments.cancellation_reason 為同一次作廢的兩端,無 FK 關聯:
  close_reason_type    = 這張單為什麼結束(分類、統計)
  cancellation_reason  = 這筆錢為什麼作廢(自由文字、追溯)
  兩者語意須一致,例如 bulk_return 時說明文字應敘述退貨脈絡。

⚠️ 與既有欄位 quotes.close_reason(付款前關單的自由文字)名稱相近但用途不同,
   CB-92 不寫 close_reason(Q-3)。

🔴 n8n 付款自動化恢復前置條件(Payment PM 登記):
   Void Cleanup / Ghost 偵測等流程必須排除 CB-92 作廢的 payment 列,永久鑑別條件:
     payments p JOIN quotes q ON q.id = p.quote_id
     WHERE q.status = 'Closed' AND q.close_reason_type IS NOT NULL
   不可改用「有無 quickbooks_invoice_id」鑑別(staging 已有帶 invoice id 的 confirmed 列)。$doc$;

  COMMENT ON COLUMN public.payments.cancellation_reason IS
$doc$這筆 payment 為什麼作廢(自由文字、追溯用)。

CB-92 路徑(public.close_paid_order())寫入固定格式的單行文字:
  CB-92 void | Type: <close_reason_type> | Received: $<total_paid> (<payment_method>)
  | Reason: <操作者輸入> | By: <dealers.contact_name> | Date: <YYYY-MM-DD> (America/New_York)
  其中 Received / By / Date 由 RPC 從 DB 讀值,非 client 輸入。

🔴 與 public.quotes.close_reason_type 為同一次作廢的兩端,無 FK 關聯:
  cancellation_reason  = 這筆錢為什麼作廢(自由文字、追溯)
  close_reason_type    = 這張單為什麼結束(分類、統計)

非 CB-92 的作廢(admin-payments Cancel / Close Pending)亦使用本欄,格式不固定。
本 COMMENT 由 CB-92 migration 代寫(payment 線無 migration,Payment PM 同意)。$doc$;

  COMMENT ON FUNCTION public.block_closed_quote_change() IS
$doc$CB-92 Closed 終態鎖 + 已付款作廢的唯一入口守衛。掛於 trg_block_closed_quote_change。

拒絕規則(皆 ERRCODE 42501):
  R-a  DELETE 已 Closed 的單                       (Q-15:防 payments ON DELETE CASCADE 刪掉作廢紀錄)
  R-b  已 Closed 的單改 status                      (Q-5:終態不可逆)
  R-c  已 Closed 的單改 close_reason_type          (保護 Q-1 鑑別規則)
  R-d  OP/OC → Closed 或 close_reason_type 寫入,未同時滿足:
       旗標 = 'on'、OLD.status ∈ {OP, OC}、NEW.status = 'Closed'、NEW.close_reason_type 非 NULL
       (Q-19 B:admin 直打 PostgREST 無法繞過 RPC 製造「Closed 但 payment 仍 confirmed」)

🔴 旗標契約:current_setting('procraft.cb92_close', true) = 'on'
   由 public.close_paid_order() 以 set_config(..., 'on', true) 在交易內設定、寫完 quotes 立即設回 'off'。
   兩端名稱必須一致。改名的症狀是「close_paid_order() 被自己的 trigger 以 42501 擋下」——
   看起來像權限問題,實為命名失聯。
   判斷一律寫 = 'on':未設定時 current_setting 回 NULL,同連線交易結束後回空字串,皆不放行。
   service_role / SQL Editor 可自行 set_config 繞過 —— 屬刻意行為,非本鎖防範對象。

🔴 DELETE 分支必須 RETURN OLD。RETURN NEW(= NULL)會使刪除被靜默略過,
   所有 Draft 將刪不掉且不報錯(PostgREST 回 200 + 空陣列,與 RLS 擋下同形)。

不修改 NEW;放行時原樣回傳。不讀任何表。
不防 TRUNCATE(不經 row trigger)。$doc$;

  COMMENT ON FUNCTION public.close_paid_order(uuid, uuid, text, text) IS
$doc$CB-92 已付款單作廢改單。僅 super_admin(DB 以 is_super_admin() 強制)。

單一交易內依序:
  ① 授權  ② 輸入驗證  ③ 鎖 quote(FOR UPDATE)+ 前態守衛 IN ('Order Processing','Order Completed')
  ④ get_quote_store_credit_count().active_count 必須 = 0(Q-8)
  ⑤ confirmed payment 恰 1 筆且 id = p_payment_id(Q-7 前置斷言)
  ⑥ 處理人 contact_name  ⑦ 組合 cancellation_reason(金額 / method / 處理人 / 日期取自 DB)
  ⑧ UPDATE quotes → Closed + close_reason_type(ROW_COUNT = 1)
  ⑨ UPDATE payments → cancelled 四欄(ROW_COUNT = 1,Q-7 後置斷言)
任一步失敗即 RAISE,整筆回滾 —— 「quote 已 Closed 但 payment 仍 confirmed」的中間態不會經本函式產生。

🔴 旗標契約:⑧ 前以 set_config('procraft.cb92_close', 'on', true) 設定、⑧ 後立即設回 'off'。
   與 public.block_closed_quote_change() 的同名常數互為契約,改名即失聯
   (症狀:本函式被 trg_block_closed_quote_change 以 42501 擋下)。

SECURITY DEFINER + search_path = public, pg_temp;表與非 pg_catalog 函式一律 schema 限定。
auth.uid() 取自 JWT,不受 DEFINER 影響 —— status_history / account_events 記錄的是實際操作者。
不寄信(Q-11)。不寫 quotes.close_reason(Q-3)。$doc$;

  COMMENT ON TRIGGER trg_block_closed_quote_change ON public.quotes IS
$doc$CB-92 Closed 終態鎖。邏輯見 COMMENT ON FUNCTION public.block_closed_quote_change()。

🔴 本 trigger 的【名稱】是功能不變量,不可更名。
PostgreSQL 對同一 timing 的多個 row trigger 依名稱位元序(COLLATE "C")執行。
BEFORE UPDATE 順序(CB-92 上線時,共 4 支):
  1. trg_block_closed_quote_change        ← 本 trigger
  2. trg_block_trial_status_change
  3. trg_enforce_dealer_quote_transition  (F2)
  4. trg_record_status_history            (CB-77)
本 trigger 必須排在 F2 之前:
  - 不得落在 F2 與 trg_record_status_history 之間(CB-77 的順序不變量);
  - 違規時最先報錯,訊息最精確。
本 trigger 不修改 NEW,故 F2 Case 2 的整列凍結比對與 CB-77 的 WHEN 判斷皆不受影響。

無 WHEN 子句:同時涵蓋 DELETE 的 trigger,其 WHEN 不可引用 NEW,而 R-d 必須檢查 NEW。
每筆 quotes UPDATE / DELETE 都會呼叫函式;函式不讀表,成本極低。

BEFORE DELETE:quotes 上僅本支,無順序依賴。
名稱與 Q-5 最初拍板的 trg_block_closed_status_change 不同(Q-18):
本 trigger 亦擋 DELETE,原名會讓人低估它擋了什麼。$doc$;

END
$cb92$;


-- ============================================================================
-- Segment 2 / 3   PostgREST schema reload
-- ============================================================================

NOTIFY pgrst, 'reload schema';


-- ============================================================================
-- Segment 3 / 3   驗證 —— 回傳結果集;最後一列 V-ALL 須為 PASS
-- ============================================================================

WITH
trg AS (
  SELECT t.tgname, t.tgtype, t.tgenabled, t.tgqual, t.tgfoid
  FROM pg_catalog.pg_trigger t
  WHERE t.tgrelid = 'public.quotes'::regclass AND NOT t.tgisinternal
),
before_upd AS (
  SELECT string_agg(tgname, ',' ORDER BY (tgname COLLATE "C")) AS names, count(*) AS n
  FROM trg
  WHERE (tgtype & 2) = 2 AND (tgtype & 16) = 16
),
rpc AS (
  SELECT p.oid, p.prosecdef, p.proconfig, pg_catalog.pg_get_userbyid(p.proowner) AS owner,
         pg_catalog.format_type(p.prorettype, NULL) AS rettype
  FROM pg_catalog.pg_proc p
  WHERE p.oid = to_regprocedure('public.close_paid_order(uuid,uuid,text,text)')
),
tfn AS (
  SELECT p.oid, p.prosecdef, p.proconfig
  FROM pg_catalog.pg_proc p
  WHERE p.oid = to_regprocedure('public.block_closed_quote_change()')
),
checks(id, ok, detail) AS (
  SELECT 'V-00 env',
         (SELECT name FROM _ops.environment) = 'production',
         (SELECT name FROM _ops.environment)
  UNION ALL
  SELECT 'V-01 quotes trigger count = 9',
         (SELECT count(*) FROM trg) = 9,
         (SELECT count(*)::text FROM trg)
  UNION ALL
  SELECT 'V-02 trigger name set',
         (SELECT string_agg(tgname, ',' ORDER BY (tgname COLLATE "C")) FROM trg)
           = 'trg_block_closed_quote_change,trg_block_trial_status_change,trg_block_trial_status_on_insert,'
             'trg_enforce_dealer_quote_transition,trg_record_account_event_del,trg_record_account_event_ins,'
             'trg_record_account_event_upd,trg_record_status_history,trg_record_status_history_on_insert',
         (SELECT string_agg(tgname, ',' ORDER BY (tgname COLLATE "C")) FROM trg)
  UNION ALL
  SELECT 'V-03 BEFORE UPDATE order (4)',
         (SELECT names FROM before_upd)
           = 'trg_block_closed_quote_change,trg_block_trial_status_change,'
             'trg_enforce_dealer_quote_transition,trg_record_status_history',
         (SELECT names FROM before_upd)
  UNION ALL
  SELECT 'V-04 nothing between F2 and record_status_history',
         (SELECT count(*) FROM trg
          WHERE (tgtype & 2) = 2 AND (tgtype & 16) = 16
            AND (tgname COLLATE "C") > ('trg_enforce_dealer_quote_transition' COLLATE "C")
            AND (tgname COLLATE "C") < ('trg_record_status_history' COLLATE "C")) = 0,
         NULL
  UNION ALL
  SELECT 'V-05 all quotes triggers enabled',
         (SELECT count(*) FROM trg WHERE tgenabled <> 'O') = 0,
         (SELECT string_agg(tgname::text || '=' || tgenabled::text, ',') FROM trg WHERE tgenabled <> 'O')
  UNION ALL
  SELECT 'V-06 new trigger: BEFORE, ROW, UPDATE+DELETE, no INSERT, no WHEN',
         (SELECT (tgtype & 1) = 1 AND (tgtype & 2) = 2 AND (tgtype & 16) = 16 AND (tgtype & 8) = 8
                 AND (tgtype & 4) = 0 AND tgqual IS NULL
                 AND tgfoid = to_regprocedure('public.block_closed_quote_change()')
          FROM trg WHERE tgname = 'trg_block_closed_quote_change'),
         NULL
  UNION ALL
  SELECT 'V-07 column close_reason_type text nullable',
         (SELECT pg_catalog.format_type(a.atttypid, a.atttypmod) = 'text' AND NOT a.attnotnull
          FROM pg_catalog.pg_attribute a
          WHERE a.attrelid = 'public.quotes'::regclass AND a.attname = 'close_reason_type' AND NOT a.attisdropped),
         NULL
  UNION ALL
  SELECT 'V-08 CHECK value domain',
         (SELECT c.convalidated
                 AND position('bulk_return' IN pg_catalog.pg_get_constraintdef(c.oid)) > 0
                 AND position('bulk_exchange' IN pg_catalog.pg_get_constraintdef(c.oid)) > 0
                 AND position('other' IN pg_catalog.pg_get_constraintdef(c.oid)) > 0
          FROM pg_catalog.pg_constraint c
          WHERE c.conrelid = 'public.quotes'::regclass AND c.conname = 'quotes_close_reason_type_check'),
         (SELECT pg_catalog.pg_get_constraintdef(c.oid) FROM pg_catalog.pg_constraint c
          WHERE c.conrelid = 'public.quotes'::regclass AND c.conname = 'quotes_close_reason_type_check')
  UNION ALL
  SELECT 'V-09 CHECK status consistency',
         (SELECT c.convalidated
                 AND position('Closed' IN pg_catalog.pg_get_constraintdef(c.oid)) > 0
                 AND position('status IS NOT NULL' IN pg_catalog.pg_get_constraintdef(c.oid)) > 0
          FROM pg_catalog.pg_constraint c
          WHERE c.conrelid = 'public.quotes'::regclass AND c.conname = 'quotes_close_reason_type_status_check'),
         (SELECT pg_catalog.pg_get_constraintdef(c.oid) FROM pg_catalog.pg_constraint c
          WHERE c.conrelid = 'public.quotes'::regclass AND c.conname = 'quotes_close_reason_type_status_check')
  UNION ALL
  SELECT 'V-10 RPC: DEFINER, search_path, owner, jsonb',
         (SELECT prosecdef AND proconfig = ARRAY['search_path=public, pg_temp'] AND owner = 'postgres'
                 AND rettype = 'jsonb' FROM rpc),
         (SELECT owner || ' | ' || array_to_string(proconfig, ';') FROM rpc)
  UNION ALL
  SELECT 'V-11 RPC EXECUTE: authenticated only',
         (SELECT has_function_privilege('authenticated', oid, 'EXECUTE')
                 AND NOT has_function_privilege('anon', oid, 'EXECUTE')
                 AND NOT has_function_privilege('service_role', oid, 'EXECUTE')
                 AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p, aclexplode(p.proacl) x
                                 WHERE p.oid = rpc.oid AND x.grantee = 0)
          FROM rpc),
         NULL
  UNION ALL
  SELECT 'V-12 trigger fn: INVOKER, search_path empty, no EXECUTE grants',
         (SELECT NOT prosecdef AND proconfig = ARRAY['search_path=""']
                 AND NOT has_function_privilege('anon', oid, 'EXECUTE')
                 AND NOT has_function_privilege('authenticated', oid, 'EXECUTE')
                 AND NOT has_function_privilege('service_role', oid, 'EXECUTE')
          FROM tfn),
         (SELECT array_to_string(proconfig, ';') FROM tfn)
  UNION ALL
  SELECT 'V-13 COMMENT cross-references',
         coalesce(position('cancellation_reason' IN pg_catalog.col_description('public.quotes'::regclass,
                    (SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid = 'public.quotes'::regclass
                       AND attname = 'close_reason_type'))) > 0, false)
         AND coalesce(position('close_reason_type' IN pg_catalog.col_description('public.payments'::regclass,
                    (SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid = 'public.payments'::regclass
                       AND attname = 'cancellation_reason'))) > 0, false)
         AND coalesce(position('procraft.cb92_close' IN pg_catalog.obj_description(
                    to_regprocedure('public.block_closed_quote_change()'), 'pg_proc')) > 0, false)
         AND coalesce(position('procraft.cb92_close' IN pg_catalog.obj_description(
                    to_regprocedure('public.close_paid_order(uuid,uuid,text,text)'), 'pg_proc')) > 0, false)
         AND coalesce(position('名稱】是功能不變量' IN (SELECT pg_catalog.obj_description(t.oid, 'pg_trigger')
                    FROM pg_catalog.pg_trigger t
                    WHERE t.tgrelid = 'public.quotes'::regclass
                      AND t.tgname = 'trg_block_closed_quote_change')) > 0, false),
         NULL
  UNION ALL
  SELECT 'V-14 flag contract identical in both functions',
         position('''procraft.cb92_close''' IN pg_catalog.pg_get_functiondef(to_regprocedure('public.block_closed_quote_change()'))) > 0
         AND position('''procraft.cb92_close''' IN pg_catalog.pg_get_functiondef(to_regprocedure('public.close_paid_order(uuid,uuid,text,text)'))) > 0,
         NULL
  UNION ALL
  SELECT 'V-15 no existing rows carry close_reason_type',
         (SELECT count(*) FROM public.quotes WHERE close_reason_type IS NOT NULL) = 0,
         (SELECT count(*)::text FROM public.quotes WHERE close_reason_type IS NOT NULL)
)
SELECT id,
       CASE WHEN ok IS TRUE THEN 'PASS' ELSE 'FAIL' END AS verdict,
       detail
FROM checks
UNION ALL
SELECT 'V-ALL (16 checks)',
       CASE WHEN count(*) = 16 AND count(*) FILTER (WHERE ok IS TRUE) = 16 THEN 'PASS' ELSE 'FAIL' END,
       count(*) FILTER (WHERE ok IS TRUE)::text || ' / ' || count(*)::text
FROM checks
ORDER BY 1;


-- ============================================================================
-- R-1  回滾(預設註解。僅在 CB-92 尚未產生任何作廢資料時可用)
-- ============================================================================
-- DO $cb92_r1$
-- BEGIN
--   PERFORM _ops.assert_env('production');
--   IF (SELECT count(*) FROM public.quotes WHERE close_reason_type IS NOT NULL) > 0 THEN
--     RAISE EXCEPTION 'CB-92 R-1 ABORT: close_reason_type already has data; rollback would destroy the classification.';
--   END IF;
--   DROP TRIGGER trg_block_closed_quote_change ON public.quotes;
--   DROP FUNCTION public.block_closed_quote_change();
--   DROP FUNCTION public.close_paid_order(uuid, uuid, text, text);
--   ALTER TABLE public.quotes DROP CONSTRAINT quotes_close_reason_type_status_check;
--   ALTER TABLE public.quotes DROP CONSTRAINT quotes_close_reason_type_check;
--   ALTER TABLE public.quotes DROP COLUMN close_reason_type;
--   COMMENT ON COLUMN public.payments.cancellation_reason IS NULL;
-- END
-- $cb92_r1$;
-- NOTIFY pgrst, 'reload schema';
