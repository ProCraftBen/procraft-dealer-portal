-- ============================================================================
-- CB-110  Replacement — Unit 1: schema (tables, constraints, FKs, indexes,
--         mods whitelist helper, 4 triggers, RLS, grants, comments)
-- 環境: STAGING (jkcbusliyrxbgebdrybl)
-- 日期: 2026-10-02
-- ----------------------------------------------------------------------------
-- 🔴 整檔是【一個】DO 區塊 = 一個 statement = 原子單元。
--    第一行 PERFORM _ops.assert_env('staging')。守衛失敗 → 整段不執行。
--    任一 DDL 失敗 → 整段回滾,不留半套物件。
--    (SQL Editor 走連線池,BEGIN/COMMIT 不保證同連線 —— CB-71 教訓)
--
-- 🔴 本檔為【來源檔】。__PRODUCTION.sql 由本檔產生,轉換只改 1 處:
--      可執行守衛 _ops.assert_env('staging') → ('production')
--    驗算:_ops.assert_env( 在可執行碼中恰出現 1 次,值與檔名環境一致。
--
-- 🔴 本檔【不碰】任何 CB-93 / CB-96 物件(Q-1 = 路 B,return 零改動)。
--    新物件與 return 的對應關係見 F-366,也寫在各物件的 COMMENT 裡。
--
-- 🔴 本檔不含 RPC。RPC 在 Unit 2。本檔跑完、Unit 2 未跑之前:
--      authenticated 對兩表只有 SELECT、沒有任何寫入路徑 —— 無害的中間態。
-- ============================================================================

DO $cb110u1$
BEGIN
  PERFORM _ops.assert_env('staging');

  -- ══════════════════════════════════════════════════════════════════════
  -- 1. mods 白名單 helper(S1-D5 + PM 補充 A)
  -- ══════════════════════════════════════════════════════════════════════
  -- 🔴 正向白名單(F-35):只保留列出的鍵。日後 modifications 新增任何鍵,
  --    預設【不】進 replacement —— 失效模式是「少印一項」,不是「洩漏金額」。
  --
  -- 兩環境實測(2026-10-02,claude/CB-110-S2-pre-mods-scan.sql):
  --   元素層金額鍵 cost / material_cost / total_cost / mapping_asm_fee
  --   MF07 value.cost(另有 value.taxable)
  --   → 以上全部不在白名單內。
  --
  -- 元素層保留: mf_code、display_label、no_label —— 只收 string / null
  --             value —— string / number / boolean / null / object
  -- value 為 object 時只保留: enabled, qty, value, selected, label,
  --                           description, note —— 只收純量
  --   = pdf-builder _formatModValue() 讀取的鍵 + MF03 / MF04 實際形態。
  -- 🔴 no_label 必收:CB-12 特例 —— MF03 value='no' 時印 no_label
  --    (Wood Interior)而不是 display_label(Matching Interior)。
  --    漏掉它,replacement 會把 Wood Interior 印成 Matching Interior —— 正好換錯。
  --
  -- 形態處理(不假設 value 一定是 object):
  --   modifications 非陣列(含 NULL)  → NULL
  --   陣列元素非 object                → 丟棄
  --   value 為 array                    → 丟棄該鍵(現有資料無此形,formatter 也不處理)
  --   value 物件內的鍵值為 object/array → 丟棄該鍵(不遞迴保留任何巢狀)
  --
  -- 🔴 冪等:snapshot(snapshot(x)) = snapshot(x)。明細表的 CHECK 依賴此性質。
  CREATE FUNCTION public.replacement_mods_snapshot(p_mods jsonb)
  RETURNS jsonb
  LANGUAGE sql
  IMMUTABLE
  SET search_path = public, pg_temp
  AS $fn$
    SELECT CASE
      WHEN p_mods IS NULL OR jsonb_typeof(p_mods) IS DISTINCT FROM 'array' THEN NULL
      ELSE COALESCE((
        SELECT jsonb_agg(
                 (SELECT COALESCE(jsonb_object_agg(
                           k.key,
                           CASE
                             WHEN k.key = 'value' AND jsonb_typeof(k.value) = 'object' THEN
                               (SELECT COALESCE(jsonb_object_agg(v.key, v.value), '{}'::jsonb)
                                  FROM jsonb_each(k.value) AS v
                                 WHERE v.key IN ('enabled', 'qty', 'value', 'selected',
                                                 'label', 'description', 'note')
                                   AND jsonb_typeof(v.value) IN ('string', 'number',
                                                                 'boolean', 'null'))
                             ELSE k.value
                           END), '{}'::jsonb)
                    FROM jsonb_each(e.elem) AS k
                   WHERE (k.key IN ('mf_code', 'display_label', 'no_label')
                          AND jsonb_typeof(k.value) IN ('string', 'null'))
                      OR (k.key = 'value'
                          AND jsonb_typeof(k.value) IN ('string', 'number', 'boolean',
                                                        'null', 'object')))
                 ORDER BY e.ord)
          FROM jsonb_array_elements(p_mods) WITH ORDINALITY AS e(elem, ord)
         WHERE jsonb_typeof(e.elem) = 'object'
      ), '[]'::jsonb)
    END
  $fn$;

  -- ══════════════════════════════════════════════════════════════════════
  -- 2. 表頭 quote_replacements
  -- ══════════════════════════════════════════════════════════════════════
  -- 🔴 無任何金額欄位(拍板 #6)。對照 quote_store_credits:去掉
  --    merchandise_amount / restocking_fee / net_store_credit_amount 與其 CHECK。
  -- 🔴 FK RESTRICT(S1-D3):memo 是已發出的憑證。CASCADE 會讓刪單靜默抹掉憑證;
  --    RESTRICT 在正常流程永遠不觸發(只有 Draft 可刪,Draft 不可能有 replacement)。
  -- created_by 不設 FK —— 比照 return:開單者帳號被刪後憑證仍須存在,
  --    姓名由 created_by_name 快照承擔。
  CREATE TABLE public.quote_replacements (
    id               uuid        NOT NULL DEFAULT gen_random_uuid(),
    quote_id         uuid        NOT NULL,
    seq              integer     NOT NULL,
    memo_number      text        NOT NULL,
    reason           text        NOT NULL,
    created_by       uuid        NOT NULL,
    created_by_role  text        NOT NULL,
    created_by_name  text        NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    voided_at        timestamptz,
    voided_by        uuid,
    void_reason      text,
    CONSTRAINT quote_replacements_pkey PRIMARY KEY (id),
    CONSTRAINT quote_replacements_quote_id_fkey
      FOREIGN KEY (quote_id) REFERENCES public.quotes (id) ON DELETE RESTRICT,
    CONSTRAINT quote_replacements_seq_positive CHECK (seq > 0),
    CONSTRAINT quote_replacements_memo_number_nonblank CHECK (btrim(memo_number) <> ''),
    CONSTRAINT quote_replacements_reason_nonblank CHECK (btrim(reason) <> ''),
    CONSTRAINT quote_replacements_created_by_name_nonblank CHECK (btrim(created_by_name) <> ''),
    CONSTRAINT quote_replacements_role_check
      CHECK (created_by_role IN ('admin', 'super_admin')),
    CONSTRAINT quote_replacements_void_all_or_none CHECK (
      (voided_at IS NULL AND voided_by IS NULL AND void_reason IS NULL)
      OR
      (voided_at IS NOT NULL AND voided_by IS NOT NULL AND void_reason IS NOT NULL
       AND btrim(void_reason) <> '')
    )
  );

  -- (quote_id, seq) 唯一:取號以 quotes 行鎖序列化(DOC-1 F-364 例外形式),
  --   此索引是取號邏輯寫錯時的最後一道擋。也涵蓋 quote_id 前綴查詢。
  CREATE UNIQUE INDEX uq_quote_replacements_quote_seq
    ON public.quote_replacements (quote_id, seq);
  CREATE UNIQUE INDEX uq_quote_replacements_memo_number
    ON public.quote_replacements (memo_number);
  CREATE INDEX idx_quote_replacements_active
    ON public.quote_replacements (quote_id) WHERE voided_at IS NULL;

  -- ══════════════════════════════════════════════════════════════════════
  -- 3. 明細 quote_replacement_lines
  -- ══════════════════════════════════════════════════════════════════════
  -- 🔴 無 unit_price / discount_amount / credit_unit_amount / line_total。
  -- 🔴 line_kind 取名 'manual' 不取 'custom'(S1-D6):本表另有 is_custom 欄,
  --    指原單上 F-CUSTOM 的型錄外品項。'custom' 會與它同名不同義(F-25)。
  -- 🔴 形狀 CHECK 為正向:每一種 kind 都明列必須為空的欄位,
  --    比 return 的 kind_shape 嚴格(return 未限制 manual 行的 sku_code 等)。
  -- 🔴 modifications 的 CHECK 要求「等於自身的白名單投影」——
  --    即使繞過 RPC 直接 INSERT(service_role),也存不進任何白名單外的鍵。
  --    DB 層的最後一道防線,不依賴 RPC 有沒有呼叫 helper。
  CREATE TABLE public.quote_replacement_lines (
    id               uuid    NOT NULL DEFAULT gen_random_uuid(),
    memo_id          uuid    NOT NULL,
    line_no          integer NOT NULL,
    line_kind        text    NOT NULL,
    quote_item_id    uuid,
    sku_code         text,
    style_code       text,
    style_name       text,
    sku_desc         text,
    sku_type         text,
    assemble_status  text,
    sub_index        integer,
    is_custom        boolean,
    modifications    jsonb,
    description      text,
    quantity         integer NOT NULL,
    CONSTRAINT quote_replacement_lines_pkey PRIMARY KEY (id),
    CONSTRAINT quote_replacement_lines_memo_id_fkey
      FOREIGN KEY (memo_id) REFERENCES public.quote_replacements (id) ON DELETE RESTRICT,
    CONSTRAINT quote_replacement_lines_quote_item_id_fkey
      FOREIGN KEY (quote_item_id) REFERENCES public.quote_items (id) ON DELETE RESTRICT,
    CONSTRAINT quote_replacement_lines_line_no_positive CHECK (line_no > 0),
    CONSTRAINT quote_replacement_lines_qty_positive CHECK (quantity > 0),
    CONSTRAINT quote_replacement_lines_kind_check
      CHECK (line_kind IN ('quote_item', 'manual')),
    CONSTRAINT quote_replacement_lines_kind_shape CHECK (
      (line_kind = 'quote_item'
        AND quote_item_id IS NOT NULL
        AND sku_code IS NOT NULL
        AND description IS NULL)
      OR
      (line_kind = 'manual'
        AND quote_item_id IS NULL
        AND description IS NOT NULL AND btrim(description) <> ''
        AND sku_code IS NULL AND style_code IS NULL AND style_name IS NULL
        AND sku_desc IS NULL AND sku_type IS NULL AND assemble_status IS NULL
        AND sub_index IS NULL AND is_custom IS NULL AND modifications IS NULL)
    ),
    CONSTRAINT quote_replacement_lines_mods_whitelisted CHECK (
      modifications IS NULL
      OR modifications = public.replacement_mods_snapshot(modifications)
    )
  );

  CREATE UNIQUE INDEX uq_quote_replacement_lines_memo_line
    ON public.quote_replacement_lines (memo_id, line_no);
  CREATE INDEX idx_quote_replacement_lines_item
    ON public.quote_replacement_lines (quote_item_id) WHERE line_kind = 'quote_item';

  -- ══════════════════════════════════════════════════════════════════════
  -- 4. trigger:表頭 INSERT 守衛
  -- ══════════════════════════════════════════════════════════════════════
  CREATE FUNCTION public.enforce_replacement_insert()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $fn$
  DECLARE
    v_status    text;
    v_po_number text;
  BEGIN
    SELECT q.status, q.po_number
      INTO v_status, v_po_number
    FROM public.quotes q
    WHERE q.id = NEW.quote_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'CB-110: quote % not found', NEW.quote_id
        USING ERRCODE = '23503';
    END IF;

    -- 🔴 Q-3:僅 Order Processing / Order Completed。正向識別(F-35)。
    -- 🔴 寫成 (… IN …) IS NOT TRUE,【不】寫 NOT IN:quotes.status 可為 NULL,
    --    NULL NOT IN (…) 得 NULL,IF 會放行。IS NOT TRUE 只讓明確為真者通過。
    --    (return 的同位置守衛有此洞,已登記 F-369,本票不改 return。)
    IF (v_status IN ('Order Processing', 'Order Completed')) IS NOT TRUE THEN
      RAISE EXCEPTION
        'CB-110: replacement requires quote status Order Processing or Order Completed (got %)',
        COALESCE(v_status, '(null)')
        USING ERRCODE = '23514';
    END IF;

    IF v_po_number IS NULL OR btrim(v_po_number) = '' THEN
      RAISE EXCEPTION 'CB-110: quote % has no po_number', NEW.quote_id
        USING ERRCODE = '23514';
    END IF;

    -- 🔴 編號自洽(S1-D4):<PO>-X<seq>。擋的是 SQL Editor 手動寫入時編號與單號不符。
    IF NEW.memo_number IS DISTINCT FROM (v_po_number || '-X' || NEW.seq::text) THEN
      RAISE EXCEPTION 'CB-110: memo_number % does not match expected %',
        NEW.memo_number, v_po_number || '-X' || NEW.seq::text
        USING ERRCODE = '23514';
    END IF;

    IF NEW.voided_at IS NOT NULL THEN
      RAISE EXCEPTION 'CB-110: cannot insert an already-voided replacement'
        USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
  END
  $fn$;

  CREATE TRIGGER trg_replacement_insert
    BEFORE INSERT ON public.quote_replacements
    FOR EACH ROW EXECUTE FUNCTION public.enforce_replacement_insert();

  -- ══════════════════════════════════════════════════════════════════════
  -- 5. trigger:表頭不可改、不可刪(只允許作廢轉換)
  -- ══════════════════════════════════════════════════════════════════════
  -- to_jsonb 差集寫法:日後新增欄位自動受保護,不必逐欄列舉。
  CREATE FUNCTION public.enforce_replacement_immutable()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $fn$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'CB-110: replacement rows cannot be deleted (id %)', OLD.id
        USING ERRCODE = '42501';
    END IF;

    IF (to_jsonb(OLD) - 'voided_at' - 'voided_by' - 'void_reason')
       IS DISTINCT FROM
       (to_jsonb(NEW) - 'voided_at' - 'voided_by' - 'void_reason') THEN
      RAISE EXCEPTION
        'CB-110: replacement is immutable; only the void transition is allowed (id %)',
        OLD.id
        USING ERRCODE = '42501';
    END IF;

    IF OLD.voided_at IS NOT NULL THEN
      RAISE EXCEPTION 'CB-110: replacement % is already voided', OLD.id
        USING ERRCODE = '42501';
    END IF;

    IF NEW.voided_at IS NULL THEN
      RAISE EXCEPTION 'CB-110: the only permitted UPDATE is voiding (id %)', OLD.id
        USING ERRCODE = '42501';
    END IF;

    RETURN NEW;
  END
  $fn$;

  CREATE TRIGGER trg_replacement_immutable
    BEFORE UPDATE OR DELETE ON public.quote_replacements
    FOR EACH ROW EXECUTE FUNCTION public.enforce_replacement_immutable();

  -- ══════════════════════════════════════════════════════════════════════
  -- 6. trigger:明細凍結
  -- ══════════════════════════════════════════════════════════════════════
  CREATE FUNCTION public.enforce_replacement_line_frozen()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $fn$
  BEGIN
    RAISE EXCEPTION 'CB-110: replacement lines are immutable (% on id %)', TG_OP, OLD.id
      USING ERRCODE = '42501';
  END
  $fn$;

  CREATE TRIGGER trg_replacement_line_frozen
    BEFORE UPDATE OR DELETE ON public.quote_replacement_lines
    FOR EACH ROW EXECUTE FUNCTION public.enforce_replacement_line_frozen();

  -- ══════════════════════════════════════════════════════════════════════
  -- 7. trigger:數量上限(S1-D1 + S1-D2)
  -- ══════════════════════════════════════════════════════════════════════
  CREATE FUNCTION public.enforce_replacement_line_limit()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $fn$
  DECLARE
    v_memo_quote_id uuid;
    v_memo_voided   timestamptz;
    v_item_quote_id uuid;
    v_item_qty      integer;
    v_returned      integer;
    v_replaced      integer;
  BEGIN
    SELECT m.quote_id, m.voided_at
      INTO v_memo_quote_id, v_memo_voided
    FROM public.quote_replacements m
    WHERE m.id = NEW.memo_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'CB-110: replacement % not found', NEW.memo_id
        USING ERRCODE = '23503';
    END IF;

    IF v_memo_voided IS NOT NULL THEN
      RAISE EXCEPTION 'CB-110: cannot add lines to voided replacement %', NEW.memo_id
        USING ERRCODE = '23514';
    END IF;

    -- 🔴 正向識別(F-35):兩種 kind 都明列。manual 不綁品項、不計入上限(Q-5)。
    IF NEW.line_kind = 'manual' THEN
      RETURN NEW;
    ELSIF NEW.line_kind IS DISTINCT FROM 'quote_item' THEN
      RAISE EXCEPTION 'CB-110: unknown line_kind %', COALESCE(NEW.line_kind, '(null)')
        USING ERRCODE = '23514';
    END IF;

    -- 🔴 S1-D2 並行:鎖的是 quote_items 該列,與 return 的
    --    enforce_store_credit_line_limit 鎖【同一列】—— 兩者因此互相排隊。
    --    鎖本表沒有用:return 不會碰本表。
    --    取鎖之後才計算。plpgsql 在 READ COMMITTED 下每條語句取新快照,
    --    所以排隊後讀得到對方剛 commit 的列。
    --    這是行鎖,不是 UPDATE:quote_items 一個位元都不變(拍板 #7)。
    SELECT qi.quote_id, qi.quantity
      INTO v_item_quote_id, v_item_qty
    FROM public.quote_items qi
    WHERE qi.id = NEW.quote_item_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'CB-110: quote_item % not found', NEW.quote_item_id
        USING ERRCODE = '23503';
    END IF;

    -- 跨單防護。IS DISTINCT FROM 讓 quote_items.quote_id 為 NULL 時也判為不符。
    IF v_item_quote_id IS DISTINCT FROM v_memo_quote_id THEN
      RAISE EXCEPTION 'CB-110: quote_item % belongs to quote %, not %',
        NEW.quote_item_id, v_item_quote_id, v_memo_quote_id
        USING ERRCODE = '23514';
    END IF;

    -- 🔴 S1-D1 上限 = 原數量 − 已退(未作廢 return)− 已換(未作廢 replacement)。
    --    不對稱是刻意的,不是漏掉:
    --      return 減少客戶持有量 → replacement 必須扣已退量;
    --      replacement 不改變持有量(換 4 個後手上仍是 5 個)→ return 不扣已換量。
    --    所以 return 的 enforce_store_credit_line_limit【不讀】本表,這是對的。
    --
    -- 🔴 已退量的算式必須與 return 自己的 enforce_store_credit_line_limit
    --    逐字一致(line_kind = 'quote_item'、表頭 voided_at IS NULL)。
    --    return 改這個算式時,本處必須同步(F-366)。
    SELECT COALESCE(SUM(l.quantity), 0)
      INTO v_returned
    FROM public.quote_store_credit_lines l
    JOIN public.quote_store_credits m ON m.id = l.memo_id
    WHERE l.quote_item_id = NEW.quote_item_id
      AND l.line_kind = 'quote_item'
      AND m.voided_at IS NULL;

    SELECT COALESCE(SUM(l.quantity), 0)
      INTO v_replaced
    FROM public.quote_replacement_lines l
    JOIN public.quote_replacements m ON m.id = l.memo_id
    WHERE l.quote_item_id = NEW.quote_item_id
      AND l.line_kind = 'quote_item'
      AND m.voided_at IS NULL;

    IF v_returned + v_replaced + NEW.quantity > v_item_qty THEN
      RAISE EXCEPTION
        'CB-110: replacement quantity exceeds remaining for quote_item % (ordered %, returned %, already replaced %, requested %)',
        NEW.quote_item_id, v_item_qty, v_returned, v_replaced, NEW.quantity
        USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
  END
  $fn$;

  CREATE TRIGGER trg_replacement_line_limit
    BEFORE INSERT ON public.quote_replacement_lines
    FOR EACH ROW EXECUTE FUNCTION public.enforce_replacement_line_limit();

  -- ══════════════════════════════════════════════════════════════════════
  -- 8. RLS(比照 return:只有 SELECT policy,寫入只能經 SECURITY DEFINER RPC)
  -- ══════════════════════════════════════════════════════════════════════
  ALTER TABLE public.quote_replacements      ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.quote_replacement_lines ENABLE ROW LEVEL SECURITY;

  CREATE POLICY admin_select_replacements
    ON public.quote_replacements
    FOR SELECT TO authenticated
    USING (public.is_admin());

  CREATE POLICY dealer_select_own_replacements
    ON public.quote_replacements
    FOR SELECT TO authenticated
    USING (EXISTS (
      SELECT 1 FROM public.quotes q
      WHERE q.id = quote_replacements.quote_id
        AND q.dealer_id = auth.uid()
    ));

  CREATE POLICY admin_select_replacement_lines
    ON public.quote_replacement_lines
    FOR SELECT TO authenticated
    USING (public.is_admin());

  CREATE POLICY dealer_select_own_replacement_lines
    ON public.quote_replacement_lines
    FOR SELECT TO authenticated
    USING (EXISTS (
      SELECT 1
      FROM public.quote_replacements m
      JOIN public.quotes q ON q.id = m.quote_id
      WHERE m.id = quote_replacement_lines.memo_id
        AND q.dealer_id = auth.uid()
    ));

  -- ══════════════════════════════════════════════════════════════════════
  -- 9. 權限:REVOKE ALL 再 GRANT(DOC-1:ALTER DEFAULT PRIVILEGES 建立時已授權)
  -- ══════════════════════════════════════════════════════════════════════
  REVOKE ALL ON TABLE public.quote_replacements      FROM PUBLIC, anon, authenticated;
  REVOKE ALL ON TABLE public.quote_replacement_lines FROM PUBLIC, anon, authenticated;
  GRANT SELECT ON TABLE public.quote_replacements      TO authenticated;
  GRANT SELECT ON TABLE public.quote_replacement_lines TO authenticated;

  -- trigger 函式與 helper 不對外開放。
  -- (return 的 trigger 函式目前 anon 也有 EXECUTE,無實害,不順手改 —— Q-1。)
  REVOKE ALL ON FUNCTION public.replacement_mods_snapshot(jsonb)    FROM PUBLIC, anon, authenticated;
  REVOKE ALL ON FUNCTION public.enforce_replacement_insert()        FROM PUBLIC, anon, authenticated;
  REVOKE ALL ON FUNCTION public.enforce_replacement_immutable()     FROM PUBLIC, anon, authenticated;
  REVOKE ALL ON FUNCTION public.enforce_replacement_line_frozen()   FROM PUBLIC, anon, authenticated;
  REVOKE ALL ON FUNCTION public.enforce_replacement_line_limit()    FROM PUBLIC, anon, authenticated;

  -- ══════════════════════════════════════════════════════════════════════
  -- 10. COMMENT:交叉指向 return 對應物件(PM 指示,寫物件名不寫行號)
  -- ══════════════════════════════════════════════════════════════════════
  COMMENT ON TABLE public.quote_replacements IS
    'CB-110 replacement memo header. Parallel to quote_store_credits (CB-93 return); see F-366. '
    'No money columns by design (CB-110 #6). Number format <PO>-X<seq>. Immutable except void.';
  COMMENT ON TABLE public.quote_replacement_lines IS
    'CB-110 replacement memo lines. Parallel to quote_store_credit_lines (CB-93 return); see F-366. '
    'line_kind manual (not custom: avoids clash with is_custom). modifications is whitelisted, no money keys.';
  COMMENT ON FUNCTION public.replacement_mods_snapshot(jsonb) IS
    'CB-110 positive whitelist projection of quote_items.modifications. No CB-93 counterpart '
    '(return does not snapshot mods). Must stay idempotent: quote_replacement_lines_mods_whitelisted relies on it.';
  COMMENT ON FUNCTION public.enforce_replacement_insert() IS
    'CB-110. Parallel to enforce_store_credit_insert (CB-93); see F-366. Status guard uses IS NOT TRUE (F-369).';
  COMMENT ON FUNCTION public.enforce_replacement_immutable() IS
    'CB-110. Parallel to enforce_store_credit_immutable (CB-93); see F-366.';
  COMMENT ON FUNCTION public.enforce_replacement_line_frozen() IS
    'CB-110. Parallel to enforce_store_credit_line_frozen (CB-93); see F-366.';
  COMMENT ON FUNCTION public.enforce_replacement_line_limit() IS
    'CB-110. Parallel to enforce_store_credit_line_limit (CB-93); see F-366. '
    'Cap = ordered - returned - replaced; READS quote_store_credit_lines. Return does not read this table: '
    'asymmetry is intentional (return reduces holdings, replacement does not). Locks the same quote_items row as return.';

  RAISE NOTICE 'CB-110 Unit 1 完成:2 表、1 helper、4 trigger、4 policy。';
END
$cb110u1$;
