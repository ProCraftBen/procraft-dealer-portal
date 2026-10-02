-- ============================================================================
-- CB-110  Replacement — Unit 2: RPCs
--   create_replacement / get_quote_item_replacement_summary /
--   get_quote_replacement_count / void_replacement
-- 環境: STAGING (jkcbusliyrxbgebdrybl)
-- 日期: 2026-10-02
-- 前置: Unit 1(2026-10-02_CB-110_replacement-schema__STAGING.sql)已執行
-- ----------------------------------------------------------------------------
-- 🔴 整檔是【一個】DO 區塊 = 原子單元。第一行 PERFORM _ops.assert_env('staging')。
-- 🔴 本檔為【來源檔】。__PRODUCTION.sql 只改 1 處:
--      可執行守衛 _ops.assert_env('staging') → ('production')
--    驗算:_ops.assert_env( 在可執行碼中恰出現 1 次。
-- 🔴 不碰任何 CB-93 / CB-96 物件(Q-1)。
-- 🔴 四支皆 SECURITY DEFINER + SET search_path = public, pg_temp(DOC-1)。
--    權限:REVOKE ALL FROM PUBLIC, anon, authenticated → GRANT EXECUTE TO authenticated。
-- 🔴 F-101:四支的 admin 判斷都走 is_admin(),而 dealers.role 目前可被本人改寫。
--    曝險與 return 相同,非本票新增,不在本票處理。
-- ============================================================================

DO $cb110u2$
BEGIN
  PERFORM _ops.assert_env('staging');

  -- ══════════════════════════════════════════════════════════════════════
  -- 1. create_replacement — 對應 create_store_credit(CB-93),見 F-366
  -- ══════════════════════════════════════════════════════════════════════
  -- p_lines:jsonb 陣列,每個元素為下列兩種之一(正向識別,其餘 kind 一律拋錯):
  --   {"line_kind":"quote_item", "quote_item_id":"<uuid>", "quantity":<int>}
  --   {"line_kind":"manual",     "description":"<text>",   "quantity":<int>}
  -- 🔴 只讀上列鍵。前端送來的任何其他鍵(包括誤送的金額)一律不讀、不存。
  -- 🔴 品項欄位與 mods 一律由本函式從 quote_items 重新快照 ——
  --    前端送不進描述或 mods,也就無法讓 memo 與原單不一致。
  -- 🔴 mods 經 replacement_mods_snapshot() 白名單投影(S1-D5);
  --    即使這裡漏呼叫,明細表的 quote_replacement_lines_mods_whitelisted CHECK 也會擋下。
  CREATE FUNCTION public.create_replacement(
    p_quote_id uuid,
    p_reason   text,
    p_lines    jsonb
  )
  RETURNS TABLE(memo_id uuid, memo_number text)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $fn$
  DECLARE
    v_uid        uuid := auth.uid();
    v_role       text;
    v_name       text;
    v_status     text;
    v_po_number  text;
    v_seq        integer;
    v_memo_no    text;
    v_memo_id    uuid;
    v_elem       jsonb;
    v_kind       text;
    v_qty_json   jsonb;
    v_qty        integer;
    v_desc       text;
    v_item       record;
    v_line_no    integer := 0;
  BEGIN
    -- ══ 授權 ══════════════════════════════════════════════════════════
    IF NOT public.is_admin() THEN
      RAISE EXCEPTION 'create_replacement: admin role required'
        USING ERRCODE = '42501';
    END IF;

    IF v_uid IS NULL THEN
      RAISE EXCEPTION 'create_replacement: no authenticated user (auth.uid() is null)'
        USING ERRCODE = '42501';
    END IF;

    -- 姓名取值規則與 create_store_credit 一致:contact_name 優先,退回 company_name。
    SELECT d.role,
           COALESCE(NULLIF(btrim(d.contact_name), ''), NULLIF(btrim(d.company_name), ''))
      INTO v_role, v_name
    FROM public.dealers d WHERE d.id = v_uid;

    IF v_role IS NULL THEN
      RAISE EXCEPTION 'create_replacement: caller % has no dealers row', v_uid
        USING ERRCODE = '42501';
    END IF;

    IF v_name IS NULL THEN
      RAISE EXCEPTION
        'create_replacement: caller % has no contact_name or company_name', v_uid
        USING ERRCODE = '23514';
    END IF;

    -- ══ 鎖定原單 ══════════════════════════════════════════════════════
    -- 🔴 S1-D4 / DOC-1 F-364:取號(MAX+1)與 INSERT 在同一交易,且持有母體列行鎖。
    -- 🔴 S1-D2:同一張單的 return 與 replacement 建立動作都先鎖這一列,
    --    在這一層就已序列化,不會交錯去取 quote_items 的品項鎖。
    SELECT q.status, q.po_number
      INTO v_status, v_po_number
    FROM public.quotes q
    WHERE q.id = p_quote_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'create_replacement: quote % not found', p_quote_id
        USING ERRCODE = '23503';
    END IF;

    -- 🔴 Q-3 正向識別。IS NOT TRUE 而非 NOT IN:status 為 NULL 時不放行(F-369)。
    IF (v_status IN ('Order Processing', 'Order Completed')) IS NOT TRUE THEN
      RAISE EXCEPTION
        'create_replacement: quote status must be Order Processing or Order Completed (got %)',
        COALESCE(v_status, '(null)')
        USING ERRCODE = '23514';
    END IF;

    -- ══ 參數驗證 ══════════════════════════════════════════════════════
    -- Q-8:reason 必填。
    IF p_reason IS NULL OR btrim(p_reason) = '' THEN
      RAISE EXCEPTION 'create_replacement: reason is required'
        USING ERRCODE = '23514';
    END IF;

    -- Q-5:只要求非空陣列,【不】要求至少一個品項行 —— 純 manual 合法(S1-D7)。
    IF p_lines IS NULL OR jsonb_typeof(p_lines) IS DISTINCT FROM 'array'
       OR jsonb_array_length(p_lines) = 0 THEN
      RAISE EXCEPTION 'create_replacement: p_lines must be a non-empty jsonb array'
        USING ERRCODE = '23514';
    END IF;

    -- ══ 取號並寫入表頭 ════════════════════════════════════════════════
    -- 已作廢者仍佔號,故不加 voided_at 條件。整個 RPC 是一個交易,
    -- 後面任何一行驗證失敗都會連表頭一起回滾。
    SELECT COALESCE(max(r.seq), 0) + 1 INTO v_seq
    FROM public.quote_replacements r
    WHERE r.quote_id = p_quote_id;

    v_memo_no := v_po_number || '-X' || v_seq::text;

    INSERT INTO public.quote_replacements (
      quote_id, seq, memo_number, reason,
      created_by, created_by_role, created_by_name
    ) VALUES (
      p_quote_id, v_seq, v_memo_no, btrim(p_reason),
      v_uid, v_role, v_name
    )
    RETURNING id INTO v_memo_id;

    -- ══ 逐行寫入明細 ══════════════════════════════════════════════════
    FOR v_elem IN SELECT e FROM jsonb_array_elements(p_lines) AS t(e) LOOP
      v_line_no := v_line_no + 1;

      IF jsonb_typeof(v_elem) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'create_replacement: line % is not an object', v_line_no
          USING ERRCODE = '23514';
      END IF;

      v_kind     := v_elem ->> 'line_kind';
      v_qty_json := v_elem -> 'quantity';

      -- 數量必須是 JSON 數字且為正整數。字串 "2"、2.5、0、負數一律拒絕,
      -- 錯誤訊息指出是哪一行 —— 不讓 ::integer 拋出看不出位置的轉型錯誤。
      IF jsonb_typeof(v_qty_json) IS DISTINCT FROM 'number'
         OR (v_qty_json #>> '{}')::numeric <> trunc((v_qty_json #>> '{}')::numeric)
         OR (v_qty_json #>> '{}')::numeric <= 0 THEN
        RAISE EXCEPTION 'create_replacement: line % quantity must be a positive whole number (got %)',
          v_line_no, COALESCE(v_qty_json::text, '(missing)')
          USING ERRCODE = '23514';
      END IF;
      v_qty := (v_qty_json #>> '{}')::integer;

      IF v_kind = 'quote_item' THEN

        SELECT qi.id, qi.quote_id, qi.sku_code, qi.style_code, qi.style_name,
               qi.sku_desc, qi.sku_type, qi.assemble_status, qi.sub_index,
               qi.is_custom, qi.modifications
          INTO v_item
        FROM public.quote_items qi
        WHERE qi.id = NULLIF(v_elem ->> 'quote_item_id', '')::uuid;

        IF NOT FOUND THEN
          RAISE EXCEPTION 'create_replacement: line % references unknown quote_item %',
            v_line_no, COALESCE(v_elem ->> 'quote_item_id', '(missing)')
            USING ERRCODE = '23503';
        END IF;

        IF v_item.quote_id IS DISTINCT FROM p_quote_id THEN
          RAISE EXCEPTION
            'create_replacement: line % item % does not belong to quote %',
            v_line_no, v_item.id, p_quote_id
            USING ERRCODE = '23514';
        END IF;

        -- 上限由 trg_replacement_line_limit 在 quote_items 行鎖下檢查(S1-D1 / S1-D2)。
        INSERT INTO public.quote_replacement_lines (
          memo_id, line_no, line_kind, quote_item_id,
          sku_code, style_code, style_name, sku_desc, sku_type,
          assemble_status, sub_index, is_custom, modifications,
          description, quantity
        ) VALUES (
          v_memo_id, v_line_no, 'quote_item', v_item.id,
          v_item.sku_code, v_item.style_code, v_item.style_name, v_item.sku_desc, v_item.sku_type,
          v_item.assemble_status, v_item.sub_index, v_item.is_custom,
          public.replacement_mods_snapshot(v_item.modifications),
          NULL, v_qty
        );

      ELSIF v_kind = 'manual' THEN

        v_desc := btrim(COALESCE(v_elem ->> 'description', ''));
        IF v_desc = '' THEN
          RAISE EXCEPTION 'create_replacement: manual line % requires a description', v_line_no
            USING ERRCODE = '23514';
        END IF;

        INSERT INTO public.quote_replacement_lines (
          memo_id, line_no, line_kind, description, quantity
        ) VALUES (
          v_memo_id, v_line_no, 'manual', v_desc, v_qty
        );

      ELSE
        RAISE EXCEPTION 'create_replacement: line % has unknown line_kind %',
          v_line_no, COALESCE(v_kind, '(null)')
          USING ERRCODE = '23514';
      END IF;

    END LOOP;

    RETURN QUERY SELECT v_memo_id, v_memo_no;
  END
  $fn$;

  -- ══════════════════════════════════════════════════════════════════════
  -- 2. get_quote_item_replacement_summary — 對應 get_quote_item_credit_summary
  -- ══════════════════════════════════════════════════════════════════════
  -- admin-replacement.html 的【唯一】資料來源(比照 return 的單一來源設計)。
  -- 🔴 不回傳任何價格欄位(拍板 #6)。mods 經白名單投影後才回傳。
  -- 🔴 單不存在 / 無權限 / 狀態不符一律【拋錯】,所以回空集合只可能是
  --    「這張單真的沒有品項」—— 表單頁據此顯示空狀態而非 fatal(S1-D7)。
  -- 🔴 available_quantity 照實回傳,【可為負】(L-1 Q-2 × Q-4 邊界):
  --    例 原單 5、已換 4、之後退 5(return 不扣已換量,S1-D1)→ 5 − 5 − 4 = −4。
  --    不夾成 0 —— 夾了就掩蓋「已換量超過持有量」這個事實。
  CREATE FUNCTION public.get_quote_item_replacement_summary(p_quote_id uuid)
  RETURNS TABLE(
    quote_item_id      uuid,
    sku_code           text,
    style_code         text,
    style_name         text,
    sku_desc           text,
    sku_type           text,
    assemble_status    text,
    sub_index          integer,
    is_custom          boolean,
    modifications      jsonb,
    ordered_quantity   integer,
    returned_quantity  integer,
    replaced_quantity  integer,
    available_quantity integer
  )
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $fn$
  DECLARE
    v_status text;
  BEGIN
    IF p_quote_id IS NULL THEN
      RAISE EXCEPTION 'get_quote_item_replacement_summary: p_quote_id is required'
        USING ERRCODE = '23514';
    END IF;

    IF NOT public.is_admin() THEN
      RAISE EXCEPTION 'get_quote_item_replacement_summary: admin role required'
        USING ERRCODE = '42501';
    END IF;

    SELECT q.status INTO v_status FROM public.quotes q WHERE q.id = p_quote_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'get_quote_item_replacement_summary: quote % not found', p_quote_id
        USING ERRCODE = '23503';
    END IF;

    -- 與 create_replacement / trg_replacement_insert 同一條(Q-3)。此處為唯讀預先告知。
    IF (v_status IN ('Order Processing', 'Order Completed')) IS NOT TRUE THEN
      RAISE EXCEPTION
        'get_quote_item_replacement_summary: quote status must be Order Processing or Order Completed (got %)',
        COALESCE(v_status, '(null)')
        USING ERRCODE = '23514';
    END IF;

    -- 🔴 下面兩段 SUM 必須與 enforce_replacement_line_limit 的算式【逐字一致】,
    --    否則表單顯示「可換 3」而 trigger 認為 0,送出才被擋。
    --    已退量那段同時必須與 return 自己的 enforce_store_credit_line_limit 一致(F-366)。
    RETURN QUERY
      SELECT
        qi.id,
        qi.sku_code,
        qi.style_code,
        qi.style_name,
        qi.sku_desc,
        qi.sku_type,
        qi.assemble_status,
        qi.sub_index,
        qi.is_custom,
        public.replacement_mods_snapshot(qi.modifications),
        qi.quantity,
        COALESCE(rt.qty, 0)::integer,
        COALESCE(rp.qty, 0)::integer,
        (qi.quantity - COALESCE(rt.qty, 0) - COALESCE(rp.qty, 0))::integer
      FROM public.quote_items qi
      LEFT JOIN LATERAL (
        SELECT SUM(l.quantity) AS qty
        FROM public.quote_store_credit_lines l
        JOIN public.quote_store_credits m ON m.id = l.memo_id
        WHERE l.quote_item_id = qi.id
          AND l.line_kind = 'quote_item'
          AND m.voided_at IS NULL
      ) rt ON TRUE
      LEFT JOIN LATERAL (
        SELECT SUM(l.quantity) AS qty
        FROM public.quote_replacement_lines l
        JOIN public.quote_replacements m ON m.id = l.memo_id
        WHERE l.quote_item_id = qi.id
          AND l.line_kind = 'quote_item'
          AND m.voided_at IS NULL
      ) rp ON TRUE
      WHERE qi.quote_id = p_quote_id
      -- 排序與 get_quote_item_credit_summary 相同:無排序時每次重整順序可能不同。
      ORDER BY qi.style_code NULLS FIRST, qi.sku_code, qi.assemble_status,
               qi.sub_index, qi.id;
  END
  $fn$;

  -- ══════════════════════════════════════════════════════════════════════
  -- 3. get_quote_replacement_count — 對應 get_quote_store_credit_count
  -- ══════════════════════════════════════════════════════════════════════
  -- 授權出口(CB-82 缺陷二):純 PostgREST + RLS 下「被 policy 擋」與「沒資料」同形。
  -- 本函式繞過 RLS 取真實筆數,呼叫者非 admin 且非單主時【拋錯】而不是回 0。
  -- 前端拿這個數字與 RLS 實際讀到的列數比對,不一致即降級。
  CREATE FUNCTION public.get_quote_replacement_count(p_quote_id uuid)
  RETURNS TABLE(active_count integer, voided_count integer)
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $fn$
  DECLARE
    v_ok boolean;
  BEGIN
    IF p_quote_id IS NULL THEN
      RAISE EXCEPTION 'get_quote_replacement_count: p_quote_id is required'
        USING ERRCODE = '23514';
    END IF;

    v_ok := public.is_admin()
         OR EXISTS (SELECT 1 FROM public.quotes q
                    WHERE q.id = p_quote_id AND q.dealer_id = auth.uid());

    IF v_ok IS NOT TRUE THEN
      RAISE EXCEPTION 'get_quote_replacement_count: not authorized for quote %', p_quote_id
        USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
      SELECT count(*) FILTER (WHERE r.voided_at IS NULL)::integer,
             count(*) FILTER (WHERE r.voided_at IS NOT NULL)::integer
      FROM public.quote_replacements r
      WHERE r.quote_id = p_quote_id;
  END
  $fn$;

  -- ══════════════════════════════════════════════════════════════════════
  -- 4. void_replacement — 對應 void_store_credit(Q-4 / S1-D9)
  -- ══════════════════════════════════════════════════════════════════════
  -- 🔴 不限狀態:作廢是更正紀錄,單後來進 Closed 也應能作廢開錯的 memo。
  -- 🔴 WHERE 帶 voided_at IS NULL,再以 ROW_COUNT 判斷(DOC-1)——
  --    UPDATE 0 列在 PostgREST 是 200 + 空回應,與成功無法區分。
  CREATE FUNCTION public.void_replacement(p_memo_id uuid, p_void_reason text)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $fn$
  DECLARE
    v_uid uuid := auth.uid();
    v_n   integer;
  BEGIN
    IF NOT public.is_admin() THEN
      RAISE EXCEPTION 'void_replacement: admin role required'
        USING ERRCODE = '42501';
    END IF;

    IF v_uid IS NULL THEN
      RAISE EXCEPTION 'void_replacement: no authenticated user (auth.uid() is null)'
        USING ERRCODE = '42501';
    END IF;

    IF p_void_reason IS NULL OR btrim(p_void_reason) = '' THEN
      RAISE EXCEPTION 'void_replacement: void_reason is required'
        USING ERRCODE = '23514';
    END IF;

    UPDATE public.quote_replacements
       SET voided_at   = now(),
           voided_by   = v_uid,
           void_reason = btrim(p_void_reason)
     WHERE id = p_memo_id
       AND voided_at IS NULL;

    GET DIAGNOSTICS v_n = ROW_COUNT;

    IF v_n <> 1 THEN
      RAISE EXCEPTION
        'void_replacement: replacement % not found or already voided', p_memo_id
        USING ERRCODE = '23514';
    END IF;
  END
  $fn$;

  -- ══════════════════════════════════════════════════════════════════════
  -- 5. 權限
  -- ══════════════════════════════════════════════════════════════════════
  REVOKE ALL ON FUNCTION public.create_replacement(uuid, text, jsonb)          FROM PUBLIC, anon, authenticated;
  REVOKE ALL ON FUNCTION public.get_quote_item_replacement_summary(uuid)       FROM PUBLIC, anon, authenticated;
  REVOKE ALL ON FUNCTION public.get_quote_replacement_count(uuid)              FROM PUBLIC, anon, authenticated;
  REVOKE ALL ON FUNCTION public.void_replacement(uuid, text)                   FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.create_replacement(uuid, text, jsonb)       TO authenticated;
  GRANT EXECUTE ON FUNCTION public.get_quote_item_replacement_summary(uuid)    TO authenticated;
  GRANT EXECUTE ON FUNCTION public.get_quote_replacement_count(uuid)           TO authenticated;
  GRANT EXECUTE ON FUNCTION public.void_replacement(uuid, text)                TO authenticated;

  -- ══════════════════════════════════════════════════════════════════════
  -- 6. COMMENT(交叉指向 return 對應物件)
  -- ══════════════════════════════════════════════════════════════════════
  COMMENT ON FUNCTION public.create_replacement(uuid, text, jsonb) IS
    'CB-110. Parallel to create_store_credit (CB-93); see F-366. No money in or out. '
    'Snapshots item fields and whitelisted mods from quote_items. Numbering <PO>-X<seq> under quotes row lock (DOC-1 F-364).';
  COMMENT ON FUNCTION public.get_quote_item_replacement_summary(uuid) IS
    'CB-110. Parallel to get_quote_item_credit_summary (CB-93); see F-366. No prices. '
    'available = ordered - returned - replaced, may be negative by design. SUM logic must match enforce_replacement_line_limit.';
  COMMENT ON FUNCTION public.get_quote_replacement_count(uuid) IS
    'CB-110. Parallel to get_quote_store_credit_count (CB-93); see F-366. Raises instead of returning 0 when unauthorized.';
  COMMENT ON FUNCTION public.void_replacement(uuid, text) IS
    'CB-110. Parallel to void_store_credit (CB-93); see F-366. Not status-gated by design (S1-D9).';

  RAISE NOTICE 'CB-110 Unit 2 完成:4 支 RPC。';
END
$cb110u2$;
