-- ============================================================================
-- CB-87  Save Profile 自動觸發 Locator 同步 — DB trigger + pg_net
-- 環境:PRODUCTION (acwgemgpnusworpxxoai)
-- 日期:2026-08-30
-- ----------------------------------------------------------------------------
-- 🔴 一次貼一段、單獨執行。段落標示【原子單元】者必須整段一次執行。
--
-- 🔴 Supabase SQL Editor 走連線池,BEGIN; ... COMMIT; 不保證同一條連線。
--    需原子性者一律把 PERFORM _ops.assert_env(...) 置於 DO 區塊【第一行】,
--    確保守衛與被守衛的 DDL 同屬一個 statement。(CB-71 教訓)
--
-- ----------------------------------------------------------------------------
-- 🔴 本檔由 __STAGING.sql 產生,promote 轉換【已完成】:
--
--    ① 可執行的環境守衛 5 處,全數為 _ops.assert_env('production'):
--         Segment 1 / 2 / 3 / 5 / 6
--       (Segment 4 為 CREATE OR REPLACE FUNCTION,無守衛 —— 見該段說明)
--
--    ② 種子 URL 1 處:
--         staging     .../webhook/dealer-page-update-staging
--         production  .../webhook/dealer-page-update-production
--
--    ③ URL 尾綴斷言 3 處,'-staging' → '-production':
--         Segment 2(部署期)、Segment 6 斷言 5(驗證期)、ROLLBACK 註解 1 處
--
-- 🔴 驗算方式(不可用「全文搜尋 staging 應為零命中」):
--    本檔說明註解仍會提到 staging —— 例如上方的兩環境 URL 對照。
--    正確的驗算是【只看可執行的守衛與字串常數】:
--      · _ops.assert_env( 出現 5 處,且【全部】為 'production'
--      · 'dealer-page-update-' 出現 1 處,且為 '-production'
--      · LIKE '%-staging' 應為【零】命中(註解除外)
--
-- ----------------------------------------------------------------------------
-- 🔴 上線前置(不在本檔範圍,由業主於 n8n 完成並確認):
--      workflow  dealer-page-update-production
--        · HTTP Method  = POST      ← 🔴 預設為 GET,不改則第一次觸發即 404
--        · Respond      = Immediately
--        · 狀態          = Active
--    2026-08-31 staging 實測:Method 為 GET 時 POST 一律回 404,且
--    本票 best-effort 不阻塞存檔 → 該失敗【完全靜默】,
--    症狀只會是「locator 不更新」,而第一個受影響的是真實 dealer。
--
-- ----------------------------------------------------------------------------
-- 段落:
--   1  CREATE EXTENSION pg_net                        【原子單元】
--   2  _ops.integration_endpoint + 種子 + 部署期斷言   【原子單元】
--   2b COMMENT ON TABLE(零行為影響)
--   3  dealers.locator_sync_queued_at                 【原子單元】
--   3b COMMENT ON COLUMN(零行為影響)
--   4  public.notify_locator_sync() + REVOKE
--   5  trg_notify_locator_sync_on_update              【原子單元】
--   5b COMMENT ON TRIGGER(零行為影響)
--   6  驗證硬斷言 ×5 + 人眼複核 A / B / C
--   R  ROLLBACK(全部註解掉)
--
-- ----------------------------------------------------------------------------
-- 🔴 本票的失效模式【全部】是靜默的(best-effort,不阻塞 dealer 存檔)。
--    設計上的封閉:
--     (1) 版本裝錯      → Segment 1 後置斷言:非 0.20.x 即 ABORT
--     (2) URL 指向錯環境 → Segment 2 / 6 的尾綴正向斷言
--     (3) URL 為 test 路徑 → 同上,/webhook-test/ 即 ABORT
--     (4) trigger 建成 BEFORE 或含 INSERT → Segment 6 斷言 1 逐位驗 tgtype
--     (5) 函式誤建為 INVOKER → 讀不到 _ops 會靜默失敗 → Segment 5 前置條件驗 prosecdef
--     (6) 執行期失敗     → 對帳 SQL(見 Segment 6 之後)一句查出
-- ============================================================================


-- ============================================================================
-- Segment 1 / 6   CREATE EXTENSION pg_net   🔴 原子單元 —— 單向門
-- ----------------------------------------------------------------------------
-- 🔴 ALTER EXTENSION 只能升不能降。執行本段之前,Dashboard 的 extension
--    開關【不得碰】—— Dashboard 會裝預設版且不留 repo 紀錄。
--
-- 🔴 Q-13 = A:刻意【不指定 VERSION】。
--    2026-08-30 於 staging 實測(PROBE,已完整回滾):
--      requested 0.19.7 -> installed 0.20.3
--      requested 0.20.0 -> installed 0.20.3
--      requested 0.20.3 -> installed 0.20.3
--    Supabase 攔截 CREATE EXTENSION,VERSION 子句【被忽略且不報錯】。
--    寫上 VERSION 只會製造「已指定版本」的假象,比不寫更危險。
--
-- ⚠️ 因此兩環境必然分岔:staging 0.20.3 / production 0.20.0(F-136)。
--    可接受的依據【不是】「patch 版應該沒差」,而是原始碼實證:
--      sql/pg_net--0.19.7--0.20.0.sql  ->  -- no SQL changes in 0.20.0
--      sql/pg_net--0.20.0--0.20.1.sql  ->  -- no SQL changes in 0.20.1
--      sql/pg_net--0.20.1--0.20.2.sql  ->  -- no SQL changes in 0.20.2
--      sql/pg_net--0.20.2--0.20.3.sql  ->  -- no SQL changes in 0.20.3
--    本票只接觸 SQL 介面,該介面兩版逐字相同。
--    🔴 未涵蓋:C 背景 worker 的重試 / 連線 / timeout 邊界行為。
--
-- ⚠️ 副作用(F-140,P2):安裝後 net schema 對 anon / authenticated 開放
--    USAGE,net._http_response 與 net.http_request_queue 對 PUBLIC 全權限。
--    net 不在 PostgREST 暴露清單故目前不可利用,但 postgres 非該 schema
--    擁有者,【無權收緊】。🔴 因此:不得將 net 加入暴露清單,
--    不得在 public 建立可執行動態 SQL 的 SECURITY INVOKER 函式。
-- ============================================================================

DO $cb87_ext$
DECLARE
  v_ver text;
BEGIN
  PERFORM _ops.assert_env('production');

  -- 🔴 刻意不用 CREATE EXTENSION IF NOT EXISTS:若已存在且版本不同,
  --    IF NOT EXISTS 會【靜默跳過】,而後續所有段落照常成功。
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'pg_net') THEN
    SELECT extversion INTO v_ver
      FROM pg_catalog.pg_extension WHERE extname = 'pg_net';
    RAISE EXCEPTION
      'ABORT: pg_net 已安裝(版本 %)。CB-87 於 2026-08-30 實查兩環境皆未安裝。'
      ' 停下回報 PM,未做任何改動。', v_ver;
  END IF;

  EXECUTE 'CREATE EXTENSION pg_net';

  SELECT extversion INTO v_ver
    FROM pg_catalog.pg_extension WHERE extname = 'pg_net';

  IF v_ver IS NULL THEN
    RAISE EXCEPTION 'ABORT: CREATE EXTENSION 執行後查無 pg_net。';
  END IF;

  -- 🔴 正向識別(F-35):斷言「必須是 0.20.x」,不寫成「不得是某某版」。
  --    未來平台跳到 0.21 / 1.0 時,正向寫法會失敗並要求人工確認;
  --    負向寫法會靜默放行一個介面可能已改的版本。
  IF left(v_ver, 5) IS DISTINCT FROM '0.20.' THEN
    RAISE EXCEPTION
      'ABORT: 安裝版本為 %,非 0.20.x 系列。CB-87 的設計以 0.20.x 的 SQL 介面為準'
      '(net.http_post 五參數簽章、net._http_response)。未確認相容前不繼續。', v_ver;
  END IF;

  RAISE NOTICE 'CB-87 Segment 1 完成:pg_net % 已安裝(Q-13 = A,版本由平台決定)。', v_ver;
END
$cb87_ext$;


-- ============================================================================
-- Segment 2 / 6   _ops.integration_endpoint   🔴 原子單元
-- ----------------------------------------------------------------------------
-- 🔴 Q-2:刻意不放 public.settings。2026-08-30 實查兩環境 policy:
--      admin_read_settings  SELECT  USING is_admin()   —— 無 key 白名單
--    → 任何 admin 角色可經 PostgREST 讀出整張 settings,包含本 URL。
--      而 n8n webhook 無驗證,取得 URL 即可觸發 flow(F-137)。
--      super_admin_update_settings 更可改寫任意 key
--    → 把 dealer 資料導向任意端點。
--    _ops 實查為 {postgres=UC/postgres} —— anon / authenticated /
--    service_role 一項權限都沒有,且不在 PostgREST 暴露清單。
--    (同 CB-43 M0 對 _ops.environment 的判準。)
-- ============================================================================

DO $cb87_ep$
DECLARE
  c_name text := 'locator_sync';
  c_url  text := 'https://benprocraftdc.app.n8n.cloud/webhook/dealer-page-update-production';
  v_url  text;
  v_cnt  int;
BEGIN
  PERFORM _ops.assert_env('production');

  CREATE TABLE IF NOT EXISTS _ops.integration_endpoint (
    name             text        PRIMARY KEY,
    url              text        NOT NULL,
    last_queued_at   timestamptz,
    last_request_id  bigint,
    updated_at       timestamptz NOT NULL DEFAULT now()
  );

  -- CB-82 教訓:新物件先 REVOKE 再考慮 GRANT。
  -- 本表【不 GRANT 給任何人】—— 唯一存取者是 Segment 4 的
  -- SECURITY DEFINER 函式,它以表擁有者身分執行。
  REVOKE ALL ON TABLE _ops.integration_endpoint FROM PUBLIC;
  REVOKE ALL ON TABLE _ops.integration_endpoint FROM anon, authenticated;

  -- ── Q-11:trim-then-null ───────────────────────────────────────────────
  --    CB-84 教訓:payment_notify_email 在 staging 就是空字串。
  --    2026-08-30 實查 settings 仍有 3 個 key 為空字串 → 非假想情境。
  v_url := nullif(btrim(c_url), '');

  IF v_url IS NULL THEN
    RAISE EXCEPTION 'ABORT: url 為空或全為空白。CB-87 Q-11:設定遺漏必須在部署當下失敗。';
  END IF;

  -- ── Q-19:必須是常駐 webhook,不是編輯器的 test 路徑 ────────────────────
  --    /webhook-test/ 僅在 n8n 編輯器按下 Listen 後的單次呼叫有效。
  --    誤存 test 路徑 → 平時呼叫 404 → 而本票 best-effort 不阻塞存檔
  --    → 【完全靜默】,只會看到 locator 不更新卻查不出原因。
  IF v_url NOT LIKE '%/webhook/%' THEN
    RAISE EXCEPTION 'ABORT: url 未含 /webhook/ 區段 → %', v_url;
  END IF;

  IF v_url LIKE '%/webhook-test/%' THEN
    RAISE EXCEPTION 'ABORT: url 為 n8n 的 test 路徑 → %', v_url;
  END IF;

  -- ── Q-9 / Q-18:環境尾綴正向斷言 ───────────────────────────────────────
  --    🔴 正向識別(F-35):斷言「必須以 -production 結尾」,
  --       【不】寫成「不得含 -staging」。
  --    🔴 更不可寫成「不得含 -prod」—— '-production' 本身就包含
  --       '-prod' 這個子字串,那道斷言會把正確的值判成錯誤。
  --    本票採 -staging / -production 雙側顯式命名,刻意偏離 payment 的
  --    「無後綴 = staging」慣例:預設值出錯是靜默的(staging 推上
  --    production locator 不會報錯),顯式標示出錯是 404。
  --    payment 那組維持現狀不動(範圍紀律)。
  IF v_url NOT LIKE '%-production' THEN
    RAISE EXCEPTION 'ABORT: url 未以 -production 結尾 → %', v_url;
  END IF;

  INSERT INTO _ops.integration_endpoint (name, url)
  VALUES (c_name, v_url)
  ON CONFLICT (name) DO UPDATE
    SET url = EXCLUDED.url, updated_at = now();

  SELECT count(*) INTO v_cnt
    FROM _ops.integration_endpoint
   WHERE name = c_name AND url = v_url;

  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'ABORT: 種子資料寫入後複核失敗(count = %)。', v_cnt;
  END IF;

  RAISE NOTICE 'CB-87 Segment 2 完成:_ops.integration_endpoint 已就緒,% 已設定。', c_name;
END
$cb87_ep$;


-- ============================================================================
-- Segment 2b / 6   文件(零行為影響,不綁入原子單元)
-- ============================================================================

COMMENT ON TABLE _ops.integration_endpoint IS
$doc$CB-87 外部整合 endpoint 設定。兩環境【程式碼逐字相同,差異只在本表資料】。

刻意不放 public.settings(CB-87 Q-2,2026-08-30 實查):
  admin_read_settings  SELECT  USING is_admin()   —— 無 key 白名單
  → 任何 admin 角色可經 PostgREST 讀出整張 settings,包含本 URL。
  而 n8n webhook 無驗證,取得 URL 即可觸發 flow(F-137)。
  super_admin 更可 UPDATE 任意 key → 改寫 URL 即把 dealer 資料導向任意端點。
_ops 不在 PostgREST 暴露清單(預設只有 public / graphql_public),
本表無法經 API 讀取或寫入,任何角色都不行。
(同 CB-43 M0 對 _ops.environment 的同一判準。)

last_queued_at 為【全域】抑制判斷來源(Q-8,60 秒窗)。
  🔴 不可改用 dealers.locator_sync_queued_at 判斷 —— 那是逐列的,
     兩個 dealer 在 60 秒內各自存檔時各自為 NULL,抑制會在最需要它的
     場景失效,且完全靜默。$doc$;


-- ============================================================================
-- Segment 3 / 6   dealers.locator_sync_queued_at   🔴 原子單元
-- ----------------------------------------------------------------------------
-- 無 NOT NULL、無 DEFAULT、無 CHECK → 無 CB-76 的「有欄位無約束」陷阱,
-- 故 ADD COLUMN IF NOT EXISTS 安全(同 CB-81 Segment 1 判準)。
-- ============================================================================

DO $cb87_col$
BEGIN
  PERFORM _ops.assert_env('production');

  ALTER TABLE public.dealers ADD COLUMN IF NOT EXISTS locator_sync_queued_at timestamptz;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
     WHERE a.attrelid = 'public.dealers'::regclass
       AND a.attname = 'locator_sync_queued_at'
       AND NOT a.attisdropped
       AND pg_catalog.format_type(a.atttypid, a.atttypmod) = 'timestamp with time zone'
  ) THEN
    RAISE EXCEPTION 'ABORT: locator_sync_queued_at 未建立或型別不符。';
  END IF;

  RAISE NOTICE 'CB-87 Segment 3 完成:dealers.locator_sync_queued_at 已就緒。';
END
$cb87_col$;


-- ============================================================================
-- Segment 3b / 6   文件(零行為影響)
-- ============================================================================

COMMENT ON COLUMN public.dealers.locator_sync_queued_at IS
$doc$CB-87 本列的變更最後一次促成 locator 同步請求【送出】的時點。

🔴 語意界線 —— 本欄【不】代表 locator 已更新:
  · pg_net 為非同步,trigger 送出後即返回
  · n8n webhook 設為 Respond Immediately,200 只代表「n8n 收到了」
  · 完成與否的權威紀錄在 n8n flow 末端的 Append row in sheet
    (有列 = 整條 flow 跑完,沒列 = 中途失敗)

🔴 因此本欄【絕不可】改名為 locator_synced_at 或任何宣稱「已同步」的名稱。
   具體會說謊的情境:dealer 由 is_active=true 改 false 時本 trigger 會觸發、
   n8n 會跑完,但 WP 端只 upsert 不刪(F-131)—— 該 dealer 仍留在 locator 上。
   此時「已送出」為真,「已同步」為假。命名必須守住這個差別。

🔴 n8n flow 為【全量快照】(一次推送全部 dealer,不帶 dealer_id),
   故「哪一筆沒同步」不是有意義的問題,只有「最後一次推送有沒有成功」。
   全域狀態在 _ops.integration_endpoint。本欄僅供追溯「是誰的變更引發的」。

6 小時內可經 net._http_response 查得 HTTP 結果(pg_net.ttl 預設值);
逾時後該紀錄由 pg_net 自行清除,屆時只能查 n8n / Google Sheet。$doc$;


-- ============================================================================
-- Segment 4 / 6   trigger 函式
-- ----------------------------------------------------------------------------
-- ⚠️ 本段【無環境守衛】,與 CB-81 / CB-76 / CB-77 Segment 2 同一取捨:
--    此時尚無任何 trigger 引用本函式,建在錯誤環境只會留下一個不會被
--    觸發的孤兒函式,無行為影響。真正需要原子守衛的是 Segment 5。
--
-- 🔴 SECURITY DEFINER —— 與 CB-81 的 copy_business_address_on_insert()
--    不可類比。後者只讀 NEW 的同一列欄位、不查任何表,故 INVOKER 即可。
--    本函式必須讀 _ops.integration_endpoint,而 _ops 的 ACL 實查為
--    {postgres=UC/postgres} —— authenticated 連 schema USAGE 都沒有。
--    誤建為 INVOKER 會使查詢失敗,而本票 best-effort 不阻塞存檔
--    → 靜默失效。故 Segment 5 的前置條件會驗 prosecdef。
--    🔴 DOC-1 §9 稽核基線:12/10 → 13/11。
--
-- 🔴 SET search_path = public, pg_temp —— 函式體引用 _ops.* 與 net.*,
--    兩者皆【完整 schema 限定】,不依賴 search_path。
-- ============================================================================

CREATE OR REPLACE FUNCTION public.notify_locator_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_url        text;
  v_last       timestamptz;
  v_request_id bigint;
BEGIN
  -- ── ① 遞迴守衛(主防線)───────────────────────────────────────────────
  --    本函式尾端會 UPDATE 同一列以寫入 locator_sync_queued_at,
  --    那會再次觸發本 trigger。depth > 1 即返回。
  --    🔴 縱深:locator_sync_queued_at【不在】下方 22 欄清單內,
  --       故即使本守衛被移除,② 也會擋下。兩道都要留 ——
  --       單靠 ② 太脆弱:日後若有人把狀態欄加進清單,遞迴會無限。
  IF pg_trigger_depth() > 1 THEN
    RETURN NULL;
  END IF;

  -- ── ② 觸發條件:22 欄正向列舉(Q-1 / Q-6)──────────────────────────────
  --    來源:n8n flow 的 select= 20 欄(扣除不可變的 id)
  --          + Query Parameters 的 filter 欄位 role / is_active
  --    🔴 權威是 n8n 實際讀取的欄位,【不是】public.dealer_locations view
  --       —— 該 view 兩環境定義已分岔(F-132),可信度已打折。
  --    🔴 展開寫法,每行同時出現 OLD.x 與 NEW.x —— 錯位在 review 中可見。
  --       不用 ROW(...) IS DISTINCT FROM ROW(...):兩側清單錯位一格
  --       不會報錯,而且【永遠不會報錯】,只會讓某兩欄互相比較,
  --       產生偶發的漏觸發與誤觸發。(同 CB-81 Q-20 判準)
  --    🔴 正向列舉,非「排除內部欄位」—— 日後 dealers 新增欄位時
  --       預設【不】觸發,需人為加入。(F-35)
  --    images / business_hours 為 jsonb(2026-08-30 實查):jsonb 儲存時
  --       已正規化鍵序與重複鍵,IS DISTINCT FROM 語意精確。
  --       2026-08-31 staging 實測:鍵序顛倒重寫【不】觸發(V-4a)。
  --       陣列元素順序【有意義】—— dealer 換封面照即真實變更,應觸發。
  IF OLD.company_name               IS DISTINCT FROM NEW.company_name
  OR OLD.slug                       IS DISTINCT FROM NEW.slug
  OR OLD.heading                    IS DISTINCT FROM NEW.heading
  OR OLD.description                IS DISTINCT FROM NEW.description
  OR OLD.website                    IS DISTINCT FROM NEW.website
  OR OLD.images                     IS DISTINCT FROM NEW.images
  OR OLD.business_hours             IS DISTINCT FROM NEW.business_hours
  OR OLD.business_email             IS DISTINCT FROM NEW.business_email
  OR OLD.business_phone             IS DISTINCT FROM NEW.business_phone
  OR OLD.google_my_business_url     IS DISTINCT FROM NEW.google_my_business_url
  OR OLD.business_address_line1     IS DISTINCT FROM NEW.business_address_line1
  OR OLD.business_address_line2     IS DISTINCT FROM NEW.business_address_line2
  OR OLD.business_city              IS DISTINCT FROM NEW.business_city
  OR OLD.business_state             IS DISTINCT FROM NEW.business_state
  OR OLD.business_zip_code          IS DISTINCT FROM NEW.business_zip_code
  OR OLD.business_address_formatted IS DISTINCT FROM NEW.business_address_formatted
  OR OLD.business_lat               IS DISTINCT FROM NEW.business_lat
  OR OLD.business_lng               IS DISTINCT FROM NEW.business_lng
  OR OLD.role                       IS DISTINCT FROM NEW.role
  OR OLD.is_active                  IS DISTINCT FROM NEW.is_active
  OR OLD.account_type               IS DISTINCT FROM NEW.account_type
  OR OLD.profile_completed          IS DISTINCT FROM NEW.profile_completed
  THEN

    -- ── ③ 取 endpoint(Q-2 / Q-11)──────────────────────────────────────
    --    FOR UPDATE:序列化抑制判斷。兩個 dealer 同時存檔時,
    --    若無此鎖,兩者都會讀到舊的 last_queued_at 而雙雙送出。
    SELECT nullif(btrim(e.url), ''), e.last_queued_at
      INTO v_url, v_last
      FROM _ops.integration_endpoint e
     WHERE e.name = 'locator_sync'
       FOR UPDATE;

    -- ── ④ URL 缺漏 → 靜靜返回(best-effort,不阻塞 dealer 存檔)────────
    --    設定遺漏應在【部署當下】由 Segment 2 的硬斷言擋下,不留到 runtime。
    --    此處僅為最後的不阻塞保證。
    IF v_url IS NULL THEN
      RETURN NULL;
    END IF;

    -- ── ⑤ 60 秒抑制(Q-8)──────────────────────────────────────────────
    --    🔴 讀【全域】的 _ops.last_queued_at,不可改讀
    --       dealers.locator_sync_queued_at —— 後者是逐列的,兩個 dealer
    --       在 60 秒內各自存檔時各自為 NULL,抑制會在最需要它的場景失效。
    --    n8n flow 為全量快照,被合併掉的那次會被下一次完整涵蓋 → 無代價。
    IF v_last IS NOT NULL AND v_last > now() - interval '60 seconds' THEN
      RETURN NULL;
    END IF;

    -- ── ⑥ 送出(Q-5 = A)───────────────────────────────────────────────
    --    timeout_milliseconds 走預設 5000 —— 兩個 webhook 皆為
    --    Respond Immediately,n8n 收下即回應。
    --    body 僅供 n8n 端追溯,flow 不讀取(全量快照不需 dealer_id)。
    v_request_id := net.http_post(
      url  := v_url,
      body := jsonb_build_object(
                'source',      'cb-87',
                'reason',      'dealer_update',
                'dealer_id',   NEW.id,
                'queued_at',   now()
              )
    );

    -- ── ⑦ 全域狀態 ────────────────────────────────────────────────────
    UPDATE _ops.integration_endpoint
       SET last_queued_at  = now(),
           last_request_id = v_request_id,
           updated_at      = now()
     WHERE name = 'locator_sync';

    -- ── ⑧ 逐列狀態(會再次觸發本 trigger,由 ① 擋下)───────────────────
    UPDATE public.dealers
       SET locator_sync_queued_at = now()
     WHERE id = NEW.id;

  END IF;

  RETURN NULL;
END
$fn$;

-- trigger 函式的 EXECUTE 權限僅在 CREATE TRIGGER 時檢查,
-- trigger 觸發時不檢查 → REVOKE 不影響運作。縱深防禦。
REVOKE ALL ON FUNCTION public.notify_locator_sync() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.notify_locator_sync() FROM anon, authenticated;


-- ============================================================================
-- Segment 5 / 6   trigger   🔴 原子單元 —— 必須整段一次執行
-- ----------------------------------------------------------------------------
-- 🔴 AFTER UPDATE,不是 BEFORE:
--    · 確保 F-101(預留的 BEFORE UPDATE 守衛)對 NEW 的修改都已完成才比較
--    · tx rollback 時 pg_net 的 queue insert 一併 rollback
--      → 不會為一筆沒存進去的變更送出請求
--
-- 位元序:'c' trg_copy_business_address_on_insert (CB-81, BEFORE INSERT)
--         'g' trg_guard_dealer_columns_on_update  (F-101 預留, BEFORE UPDATE)
--         'n' trg_notify_locator_sync_on_update   (CB-87, AFTER UPDATE)
--    三者無同 timing 同 event 重疊 → dealers 的順序不變量【仍未生效】。
--    🔴 日後若把本 trigger 改為 BEFORE,該不變量會立刻生效,須重新盤點。
--
-- 不加 WHEN 子句:加了就得寫成負向形式,與 F-35 衝突;判斷全留在函式體內。
-- ============================================================================

DO $cb87_trg$
DECLARE
  v_missing text;
BEGIN
  PERFORM _ops.assert_env('production');

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'pg_net') THEN
    RAISE EXCEPTION 'ABORT: pg_net 未安裝 → Segment 1 未執行。未建立 trigger。';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM _ops.integration_endpoint
     WHERE name = 'locator_sync' AND btrim(url) <> ''
  ) THEN
    RAISE EXCEPTION 'ABORT: _ops.integration_endpoint 無 locator_sync 或 url 為空 → Segment 2 未執行。';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
     WHERE a.attrelid = 'public.dealers'::regclass
       AND a.attname = 'locator_sync_queued_at' AND NOT a.attisdropped
  ) THEN
    RAISE EXCEPTION 'ABORT: dealers.locator_sync_queued_at 不存在 → Segment 3 未執行。';
  END IF;

  -- 🔴 連 SECURITY DEFINER 與 search_path 一併驗 —— 誤建為 INVOKER 時
  --    函式讀不到 _ops 會靜默失敗(_ops 僅 postgres 有 USAGE)。
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'notify_locator_sync'
     AND p.prorettype = 'pg_catalog.trigger'::regtype
     AND p.prosecdef
     AND p.proconfig::text LIKE '%search_path=public, pg_temp%'
  ) THEN
    RAISE EXCEPTION 'ABORT: notify_locator_sync() 不存在,或非 SECURITY DEFINER,或缺 search_path → Segment 4 未執行或有誤。';
  END IF;

  -- 🔴 22 欄必須全數存在 —— 少一欄,函式編譯期不報錯,執行時才爆,
  --    而那時第一個受影響的是正在存檔的 dealer。
  SELECT string_agg(c.col, ', ' ORDER BY c.col) INTO v_missing
    FROM unnest(ARRAY[
      'company_name','slug','heading','description','website','images','business_hours',
      'business_email','business_phone','google_my_business_url',
      'business_address_line1','business_address_line2','business_city','business_state',
      'business_zip_code','business_address_formatted','business_lat','business_lng',
      'role','is_active','account_type','profile_completed'
    ]) AS c(col)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = 'public.dealers'::regclass
        AND a.attname = c.col AND a.attnum > 0 AND NOT a.attisdropped
   );

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'ABORT: dealers 缺少觸發清單欄位:%', v_missing;
  END IF;

  DROP TRIGGER IF EXISTS trg_notify_locator_sync_on_update ON public.dealers;

  CREATE TRIGGER trg_notify_locator_sync_on_update
    AFTER UPDATE ON public.dealers
    FOR EACH ROW
    EXECUTE FUNCTION public.notify_locator_sync();

  RAISE NOTICE 'CB-87 Segment 5 完成:trigger 已建立。';
END
$cb87_trg$;


-- ============================================================================
-- Segment 5b / 6   文件(零行為影響)
-- ============================================================================

COMMENT ON TRIGGER trg_notify_locator_sync_on_update ON public.dealers IS
$doc$CB-87 dealer 對外資料變動時,自動通知 n8n 重新推送 Dealer Locator。

🔴 AFTER UPDATE,不是 BEFORE:
   · 確保 F-101(預留的 BEFORE UPDATE 守衛)對 NEW 的修改都已完成才做比較
   · tx rollback 時 pg_net 的 queue insert 一併 rollback
     → 不會為一筆沒存進去的變更送出請求

🔴 不掛 INSERT:admin 建立 dealer 時 profile_completed = false,
   不在 n8n 的快照範圍內。上架必經 dealer 首次存檔(UPDATE)。

🔴 不掛 DELETE:WP 端只 upsert 不刪(F-131),通知了也不會下架。
   對帳刪除是 F-131 的範圍,不在本票。

位元序:'c' trg_copy_business_address_on_insert (CB-81, BEFORE INSERT)
        'g' trg_guard_dealer_columns_on_update  (F-101 預留, BEFORE UPDATE)
        'n' trg_notify_locator_sync_on_update   (CB-87, AFTER UPDATE)
   三者無同 timing 同 event 重疊 → dealers 的順序不變量【仍未生效】。
   🔴 日後若有人把本 trigger 改為 BEFORE,該不變量會立刻生效,須重新盤點。

🔴 失敗策略為 best-effort:同步失敗【不得】阻塞 dealer 存檔。
   與 CB-83 的 fail-closed 相反,刻意如此 —— 對齊 CB-85 的同類判斷
   (頁面瀏覽記錄失敗不該擋住頁面渲染)。
   代價是失敗會安靜,故必須有可查詢的紀錄:見 dealers.locator_sync_queued_at
   與 _ops.integration_endpoint 的 COMMENT。$doc$;


-- ============================================================================
-- Segment 6 / 6   驗證硬斷言 ×5
-- ============================================================================

DO $cb87_verify$
DECLARE
  v_n int;
BEGIN
  PERFORM _ops.assert_env('production');

  -- ── 斷言 1:trigger 為 AFTER / ROW / 僅 UPDATE / 已啟用 ────────────────
  --    🔴 逐位驗證,不只查 tgname:誤建為 BEFORE 會在 F-101 的守衛之前
  --       送出 webhook;誤含 INSERT 會讓 admin 建 dealer 時就打 n8n。
  --       兩者都不會報錯。預期 tgtype = 17(ROW=1 + UPDATE=16,BEFORE 位為 0)。
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_class     c ON c.oid = t.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_catalog.pg_proc      p ON p.oid = t.tgfoid
     WHERE NOT t.tgisinternal
       AND n.nspname = 'public' AND c.relname = 'dealers'
       AND t.tgname = 'trg_notify_locator_sync_on_update'
       AND (t.tgtype & 2)  = 0
       AND (t.tgtype & 64) = 0
       AND (t.tgtype & 1)  > 0
       AND (t.tgtype & 16) > 0
       AND (t.tgtype & 4)  = 0
       AND (t.tgtype & 8)  = 0
       AND t.tgenabled = 'O'
       AND p.proname = 'notify_locator_sync'
  ) THEN
    RAISE EXCEPTION '斷言 1 失敗:trigger 不存在,或非 AFTER/ROW/UPDATE-only,或未啟用,或指向錯誤函式。';
  END IF;

  -- ── 斷言 2:dealers 恰有 2 支 trigger ─────────────────────────────────
  SELECT count(*) INTO v_n
    FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_class     c ON c.oid = t.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE NOT t.tgisinternal AND n.nspname = 'public' AND c.relname = 'dealers';

  IF v_n <> 2 THEN
    RAISE EXCEPTION '斷言 2 失敗:dealers 應有 2 支 trigger,實為 %。', v_n;
  END IF;

  -- ── 斷言 3:REVOKE 生效 ───────────────────────────────────────────────
  IF has_function_privilege('anon', 'public.notify_locator_sync()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.notify_locator_sync()', 'EXECUTE') THEN
    RAISE EXCEPTION '斷言 3 失敗:anon / authenticated 仍可 EXECUTE notify_locator_sync()。';
  END IF;

  -- ── 斷言 4:_ops 未對外開放(Q-2 的全部依據)──────────────────────────
  IF has_schema_privilege('anon', '_ops', 'USAGE')
     OR has_schema_privilege('authenticated', '_ops', 'USAGE')
     OR has_schema_privilege('service_role', '_ops', 'USAGE') THEN
    RAISE EXCEPTION '斷言 4 失敗:_ops schema 對 anon / authenticated / service_role 開放。';
  END IF;

  -- ── 斷言 5:URL 方向與路徑(Q-9 / Q-19 的執行期複驗)───────────────────
  IF EXISTS (
    SELECT 1 FROM _ops.integration_endpoint
     WHERE name = 'locator_sync'
       AND (url LIKE '%/webhook-test/%' OR url NOT LIKE '%-production')
  ) THEN
    RAISE EXCEPTION '斷言 5 失敗:locator_sync 的 url 指向 test 路徑或非 -production 尾綴。';
  END IF;

  RAISE NOTICE 'CB-87 Segment 6 完成:五項硬斷言全數通過。';
END
$cb87_verify$;


-- ============================================================================
-- 人眼複核 A   dealers trigger 全貌
-- ----------------------------------------------------------------------------
-- 預期 2 列,依名稱位元序:
--   trg_copy_business_address_on_insert  tgtype=7   BEFORE INSERT  prosecdef=false
--   trg_notify_locator_sync_on_update    tgtype=17  AFTER  UPDATE  prosecdef=true
-- 🔴 V-8:本查詢在兩環境的輸出必須逐欄相同。
-- ============================================================================

SELECT (SELECT name FROM _ops.environment) AS env,
       t.tgname, t.tgtype,
       CASE WHEN (t.tgtype & 2) > 0 THEN 'BEFORE' ELSE 'AFTER' END AS timing,
       concat_ws(',',
         CASE WHEN (t.tgtype &  4) > 0 THEN 'INSERT' END,
         CASE WHEN (t.tgtype &  8) > 0 THEN 'DELETE' END,
         CASE WHEN (t.tgtype & 16) > 0 THEN 'UPDATE' END) AS events,
       p.proname, p.prosecdef, p.proconfig::text, t.tgenabled
  FROM pg_catalog.pg_trigger t
  JOIN pg_catalog.pg_class     c ON c.oid = t.tgrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_catalog.pg_proc      p ON p.oid = t.tgfoid
 WHERE NOT t.tgisinternal AND n.nspname = 'public' AND c.relname = 'dealers'
 ORDER BY t.tgname;


-- ============================================================================
-- 人眼複核 B   DOC-1 §9 基線
-- ----------------------------------------------------------------------------
-- 預期 13 / 11(部署前實測 12 / 10,本票 +1 / +1)。
-- ⚠️ 缺 search_path 的兩支為 check_portal_feedback_rate_limit 與
--    generate_po_number(F-139,P2)—— 既有債,本票不修。
-- ============================================================================

SELECT (SELECT name FROM _ops.environment) AS env,
       count(*) AS secdef_total,
       count(*) FILTER (WHERE p.proconfig::text LIKE '%search_path%') AS with_search_path
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.prosecdef;


-- ============================================================================
-- 人眼複核 C   尚未誤觸發
-- ----------------------------------------------------------------------------
-- 🔴 部署直後預期:last_queued_at 為 NULL、dealers_with_queued_at = 0。
--    若非 0,代表 Segment 5 建立後有東西動過 dealers —— 需先弄清楚是什麼。
-- ============================================================================

SELECT (SELECT name FROM _ops.environment) AS env,
       name, url, last_queued_at, last_request_id
  FROM _ops.integration_endpoint;

SELECT (SELECT name FROM _ops.environment) AS env,
       count(*) AS dealers_with_queued_at
  FROM public.dealers WHERE locator_sync_queued_at IS NOT NULL;


-- ============================================================================
-- 對帳查詢(營運用,非 migration 的一部分)
-- ----------------------------------------------------------------------------
-- 業主的「一句 SQL 查最後一次推送成不成功」:
--   status_code = 200                     → n8n 已收下
--   status_code 為其他值 / error_msg 有值  → 送出失敗
--   responded_at 為 NULL 且 last_queued_at 在 6 小時內  → 尚在佇列或剛送出
--   responded_at 為 NULL 且 last_queued_at 超過 6 小時  → 紀錄已依 pg_net.ttl
--                                                        清除,改查 n8n Sheet
-- 🔴 200 只證明「n8n 收到了」。整條 flow 有沒有跑完,權威在 Append row in sheet。
-- ============================================================================

-- SELECT (SELECT name FROM _ops.environment) AS env,
--        e.name, e.last_queued_at, e.last_request_id,
--        r.status_code, r.error_msg, r.created AS responded_at
--   FROM _ops.integration_endpoint e
--   LEFT JOIN net._http_response r ON r.id = e.last_request_id
--  WHERE e.name = 'locator_sync';


-- ============================================================================
-- R   ROLLBACK   🔴 全部註解掉。需要時解開,依【反向順序】執行。
-- ----------------------------------------------------------------------------
-- 🔴 守衛字面已改為 'production' —— 回滾時若還寫著 'staging',
--    解開註解就會被 assert_env 擋下,而那正是最不該卡住的時刻。(CB-76 先例)
--
-- 🔴 R-1 單獨執行即可停止同步(最小回滾)。dealer 存檔行為完全不受影響,
--    只是回到「業主手動去 n8n 點執行」的 CB-87 之前狀態。
--    R-2 之後才是真正的移除,通常不需要。
--
-- ⚠️ R-5(DROP EXTENSION pg_net)為【最後手段】:
--    會連帶刪除 net schema 與 net._http_response 的全部歷史。
--    且重裝時裝到的仍是平台預設版,不可逆的部分無法藉此還原。
-- ============================================================================

-- R-1  停止觸發(最小回滾)
-- DO $r1$
-- BEGIN
--   PERFORM _ops.assert_env('production');
--   DROP TRIGGER IF EXISTS trg_notify_locator_sync_on_update ON public.dealers;
--   RAISE NOTICE 'R-1 完成:trigger 已移除,同步停止。';
-- END
-- $r1$;

-- R-2  移除函式
-- DO $r2$
-- BEGIN
--   PERFORM _ops.assert_env('production');
--   DROP FUNCTION IF EXISTS public.notify_locator_sync();
--   RAISE NOTICE 'R-2 完成。';
-- END
-- $r2$;

-- R-3  移除欄位
-- DO $r3$
-- BEGIN
--   PERFORM _ops.assert_env('production');
--   ALTER TABLE public.dealers DROP COLUMN IF EXISTS locator_sync_queued_at;
--   RAISE NOTICE 'R-3 完成。';
-- END
-- $r3$;

-- R-4  移除 endpoint 設定
--      ⚠️ 只刪本票那一列,不 DROP TABLE —— 日後其他整合可能已在用本表。
-- DO $r4$
-- BEGIN
--   PERFORM _ops.assert_env('production');
--   DELETE FROM _ops.integration_endpoint
--    WHERE name = 'locator_sync' AND url LIKE '%-production';
--   RAISE NOTICE 'R-4 完成。';
-- END
-- $r4$;

-- R-5  移除 extension(最後手段,見上方警告)
-- DO $r5$
-- BEGIN
--   PERFORM _ops.assert_env('production');
--   DROP EXTENSION IF EXISTS pg_net;
--   RAISE NOTICE 'R-5 完成:net schema 與全部 HTTP 歷史已刪除。';
-- END
-- $r5$;
