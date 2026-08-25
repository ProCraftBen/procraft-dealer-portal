-- ============================================================================
-- CB-81  Dealer 對外聯絡資訊分家 — business_* 欄位 + 建立時自動複製地址
-- 環境:PRODUCTION (acwgemgpnusworpxxoai)
-- 日期:2026-08-24
-- ----------------------------------------------------------------------------
-- 🔴 一次貼一段、單獨執行。段落標示【原子單元】者必須整段一次執行。
--
-- 🔴 assert_env 的兩種形式(CB-71 教訓):
--    需原子性者 → PERFORM 置於 DO 區塊【第一行】,確保守衛與 DDL 同一 statement。
--    Supabase SQL Editor 走連線池,BEGIN; ... COMMIT; 不保證同一條連線,
--    守衛與被守衛的 DDL 若分屬兩次往返,守衛等於沒有。
--
-- ----------------------------------------------------------------------------
-- 🔴 本檔由 __STAGING.sql 產生,promote 轉換【已完成】:
--      ① Segment 6(staging 專用的 trigger 行為實測)已整段刪除 —— 116 行。
--         該段會 INSERT 一列測試 dealer 再刪除。production 不做
--         (CB-81 Q-21 = 做,但僅限 staging)。
--      ② 其餘 14 處環境守衛已全數為 _ops.assert_env('production'):
--           可執行  9 處 — Segment 1 / 2 / 3 / 4 / 5 / 人眼複核 A・B・C・D
--           ROLLBACK 註解內 4 處 — R-1 / R-2 / R-3 / R-4
--           下方本說明段落 1 處
--
-- 🔴 驗算方式(不可用「全文搜尋 staging 應為零命中」):
--    本檔的說明註解仍會提到 staging —— 例如人眼複核 C / D 的兩環境預期值對照。
--    正確的驗算是【只看可執行的守衛】:
--      全檔 _ops.assert_env( 出現 14 處,且【全部】為 'production'。
--      任何一處 'staging' 都代表漏改。
--
-- 🔴 為何轉換時「先刪 Segment 6、再改字面」的順序不可顛倒:
--    Segment 6 內含 1 處 assert_env('staging')。若先改字面,那道
--    「僅限 staging」的守衛會被一併改成「允許 production」——
--    方向完全相反,且不會報錯,而該段會 INSERT 測試資料。
--
-- 🔴 ROLLBACK 註解內那 4 處也已改為 'production':回滾時若守衛還寫著
--    'staging',解開註解就會被 assert_env 擋下,而那正是最不該卡住的時刻。
--    (CB-76 先例)
--
-- ----------------------------------------------------------------------------
-- 段落:
--   1  9 個 business_* 欄位                              【原子單元】
--   2  public.copy_business_address_on_insert() 函式
--   3  trg_copy_business_address_on_insert              【原子單元】
--   3b 文件(零行為影響)
--   4  backfill —— 8 段各自獨立,含 phone/email 前後比對 【原子單元】
--   5  驗證(硬斷言)+ 人眼複核 A / B / C / D
--   R  ROLLBACK(全部註解掉)
--   (Segment 6 為 staging 專用,本檔已刪除)
--
-- ----------------------------------------------------------------------------
-- 🔴 本票的失效模式【全部】是靜默的。設計上的四道封閉:
--   (1) 回填順序寫反       → Segment 4 採八段獨立 UPDATE,寫反即語意明顯錯誤
--   (2) 誤複製 email/phone → Segment 2 函式體【完全不出現】這兩個識別字;
--                            Segment 4 做前後 count 比對,動到即中止
--   (3) 複製失敗           → Segment 5 硬斷言 4:來源有值而目標為 NULL 的列 = 0
--   (4) 有地址但無座標     → 人眼複核 D:這份清單就是「仍會從地圖上消失的 dealer」
--
-- ⚠️ 註:(4) 刻意【不寫成硬斷言】。staging 預期非 0(Test Dealer seed 資料),
--    硬斷言會在 staging 誤爆;production 預期 0,若非 0 是需人工判讀的真實異常,
--    不是應該自動中止的錯誤。
-- ============================================================================


-- ============================================================================
-- Segment 1 / 6   9 個 business_* 欄位   【原子單元】
-- ----------------------------------------------------------------------------
-- 🔴 型別必須與現有欄位逐字相同:
--      business_lat / business_lng → numeric(10,7)
--      其餘 7 欄                   → text
--    寫成 numeric 或 double precision 都不會報錯,但會與 lat/lng 產生
--    精度不一致,而地圖座標的精度差異【看不出來】,只會讓圖釘偏移。
--
-- 本段採 ADD COLUMN IF NOT EXISTS 逐欄一行。
--    ⚠️ 與 CB-76 Segment 1 的做法【刻意不同】,理由:CB-76 的欄位伴隨一條
--       CHECK 約束,IF NOT EXISTS 會在欄位已存在時連帶跳過 CHECK,產生
--       「有欄位、無約束」的部分狀態。本票 9 欄【皆無伴隨約束】
--       (無 NOT NULL、無 DEFAULT、無 CHECK),故不存在該陷阱,
--       一行一欄是更不易漏欄的寫法。
--
-- 🔴 attnum 不得用於任何斷言:production 因歷史 DROP COLUMN 而序號跳號
--    (1–33、39–53),新欄位從 54 起編;staging 從 49 起編。兩環境永不對齊,
--    這是正常的。全檔一律以 attname 為準。
-- ============================================================================

DO $cb81_col$
BEGIN
  PERFORM _ops.assert_env('production');

  ALTER TABLE public.dealers ADD COLUMN IF NOT EXISTS business_email              text;
  ALTER TABLE public.dealers ADD COLUMN IF NOT EXISTS business_address_line1      text;
  ALTER TABLE public.dealers ADD COLUMN IF NOT EXISTS business_address_line2      text;
  ALTER TABLE public.dealers ADD COLUMN IF NOT EXISTS business_city               text;
  ALTER TABLE public.dealers ADD COLUMN IF NOT EXISTS business_state              text;
  ALTER TABLE public.dealers ADD COLUMN IF NOT EXISTS business_zip_code           text;
  ALTER TABLE public.dealers ADD COLUMN IF NOT EXISTS business_address_formatted  text;
  ALTER TABLE public.dealers ADD COLUMN IF NOT EXISTS business_lat                numeric(10,7);
  ALTER TABLE public.dealers ADD COLUMN IF NOT EXISTS business_lng                numeric(10,7);

  RAISE NOTICE 'CB-81 Segment 1 完成:9 個 business_* 欄位已就緒。';
END
$cb81_col$;


-- ============================================================================
-- Segment 2 / 6   trigger 函式
-- ----------------------------------------------------------------------------
-- 🔴 SECURITY INVOKER —— 與 CB-76 的 block_trial_status_change() 不可類比。
--    CB-76 那支必須 DEFINER,是因為它【要查 public.dealers】,而該表三條
--    SELECT policy 在 auth.uid() 為 NULL 時全數落空 → INVOKER 會靜默放行。
--    本函式只讀 NEW 的同一列欄位、【不查任何表】,故與 CB-77 的
--    record_status_history 同類:INVOKER 即可。
--    🔴 DOC-1 §9 稽核基線 7/9 【維持不變】—— 本函式不進 SECURITY DEFINER 清單。
--
-- 🔴 SET search_path = '' —— 函式體不引用任何表或函式,故不需要 public。
--    比照 CB-77。(需要查 public.dealers 的 CB-76 才用 public, pg_temp。)
--
-- ----------------------------------------------------------------------------
-- 🔴 Q-20 = B:展開寫法。為何不用 COALESCE 的一行式:
--
--    複製規則是「【目標】為 NULL 才填入【來源】」。COALESCE 形式
--      NEW.business_x := COALESCE(NEW.business_x, NEW.x);
--    若兩個參數順序寫反,規則就倒轉成「來源覆蓋目標」——
--    也就是【內部地址蓋掉 dealer 自設的對外地址】,本票明令禁止的那件事。
--
--    🔴 而傷害不會在第一次出現:
--      上線當天執行 → dealer 都還沒設對外地址 → 結果相同,測不出來
--      dealer 陸續設定對外地址
--      日後任何原因重跑 → 全部被內部地址覆蓋,無聲無息
--    寫反的代價是一顆【延遲引爆】的地雷。
--
--    IF ... IS NULL THEN ... 的展開形式把「誰是目標」寫成【結構】而非參數順序:
--    寫反會變成 IF NEW.address_line1 IS NULL THEN NEW.address_line1 := ...,
--    也就是「改內部地址」,在 code review 中一眼可見。
--    註解會被忽略,結構不會。(對齊 F-35 正向識別的同一精神)
--
-- ----------------------------------------------------------------------------
-- 🔴 「僅在目標為 NULL 才填」在 INSERT 情境的【真正語意】——不要寫錯註解:
--    INSERT 時 NEW.business_* 幾乎恆為 NULL,故此條件的實際作用【不是】
--    防止覆蓋既有值(那是 UPDATE 情境,而本 trigger 不掛 UPDATE),
--    而是【尊重呼叫端自帶的 business_* 值】。若未來 create-dealer 或某個
--    匯入腳本主動帶值,trigger 不搶。
--
-- 🔴 business_email 與 business_phone 【完全不出現在本函式中】。
--    這是刻意的,不是遺漏 —— 理由寫在 COMMENT ON TRIGGER。
--    不寫成「-- 這裡不複製 email」的註解形式,因為那會讓下一個人
--    以為只要拿掉註解就能加回去。
--
-- ⚠️ 本段的 assert_env 為區塊外的獨立 SELECT,不具原子性保證。
--    可接受的理由:此時尚無任何 trigger 引用本函式,建在錯誤環境
--    只會留下一個不會被觸發的孤兒函式,無行為影響。真正需要原子守衛的是
--    Segment 3 的 CREATE TRIGGER。(與 CB-76 / CB-77 Segment 2 同一取捨。)
-- ============================================================================

SELECT _ops.assert_env('production');

CREATE OR REPLACE FUNCTION public.copy_business_address_on_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
BEGIN
  -- ── 8 個地址欄,逐欄正向識別:目標為 NULL 才填 ──────────────────────────
  --    🔴 每一組的判斷對象與賦值對象【都是 business_ 側】。
  --       任何一組若寫成判斷 / 賦值內部欄位,就是「改內部地址」,語意明顯錯誤。

  IF NEW.business_address_line1 IS NULL THEN
    NEW.business_address_line1 := NEW.address_line1;
  END IF;

  IF NEW.business_address_line2 IS NULL THEN
    NEW.business_address_line2 := NEW.address_line2;
  END IF;

  IF NEW.business_city IS NULL THEN
    NEW.business_city := NEW.city;
  END IF;

  IF NEW.business_state IS NULL THEN
    NEW.business_state := NEW.state;
  END IF;

  IF NEW.business_zip_code IS NULL THEN
    NEW.business_zip_code := NEW.zip_code;
  END IF;

  IF NEW.business_address_formatted IS NULL THEN
    NEW.business_address_formatted := NEW.address_formatted;
  END IF;

  IF NEW.business_lat IS NULL THEN
    NEW.business_lat := NEW.lat;
  END IF;

  IF NEW.business_lng IS NULL THEN
    NEW.business_lng := NEW.lng;
  END IF;

  RETURN NEW;
END
$fn$;

COMMENT ON FUNCTION public.copy_business_address_on_insert() IS
$doc$CB-81 建立 dealer 時,將內部地址複製到對外(business_*)地址。

🔴 只複製【地址 8 欄】。business_email 與 business_phone
   【完全不出現在本函式中】,這是刻意的:

   business_email  — 業主拍板留空。空白時 locator 不顯示該欄位。
                     若複製,dealer 與 ProCraft 溝通用的內部信箱
                     會被公開在對消費者的網頁上。
   business_phone  — 業主拍板完全不動。2026-08-24 查證:
                     production 21 筆中僅 1 筆有值。業主知情此決定
                     代表 locator 上線時只有 1 個 dealer 顯示電話。
                     🔴 不得自行 backfill 或提出「順手補上」。

🔴 只掛 BEFORE INSERT,【不掛 UPDATE】。
   admin 日後修改內部地址時,business_* 不得跟著變 ——
   否則 dealer 自行設定的對外地址會被【靜默】覆蓋:
   dealer 不會收到通知,locator 上的地址會在他不知情的情況下變回內部地址。
   欄位分家的全部目的就是防止這件事。

🔴 為何是 SECURITY INVOKER,而 CB-76 的 block_trial_status_change() 是 DEFINER:
   後者必須查 public.dealers,而該表三條 SELECT policy 在 auth.uid() 為 NULL
   時全數落空 → INVOKER 會使子查詢回 NULL【且不報錯】→ 靜默放行。
   本函式只讀 NEW 的同一列欄位、不查任何表,故 INVOKER 即可,
   與 CB-77 的 record_status_history 同類。
   DOC-1 §9 稽核基線 7/9 維持不變。

🔴 不做 account_type 過濾(CB-81 Q-12):
   account_type 是【可變】欄位(admin 隨時可改),而本複製是【一次性】事件
   (僅 INSERT)。兩者時間軸錯配。若在此過濾:
     今天建立的 trial 帳號 → business_* 全空
     → 日後轉正為 dealer → 該 dealer 在 locator 上地址空白、地圖上不存在
     → 【沒有任何人會發現】。
   而 CB-76 的 trial 設計本身就保證「建立時 A 類、日後轉 B 類」會發生。
   過濾應發生在【讀取端】(locator / n8n 的 account_type=eq.dealer),
   不是寫入端 —— 寫入端過濾會讓資料帶著「當初是什麼類別」的隱形分歧。$doc$;

-- trigger 函式的 EXECUTE 權限僅在 CREATE TRIGGER 時檢查,
-- trigger 觸發時不檢查 → REVOKE 不影響運作。縱深防禦。
REVOKE ALL ON FUNCTION public.copy_business_address_on_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.copy_business_address_on_insert() FROM anon, authenticated;


-- ============================================================================
-- Segment 3 / 6   trigger   🔴 原子單元 —— 必須整段一次執行
-- ----------------------------------------------------------------------------
-- 🔴 本 trigger 是 public.dealers 這張表的【第一支】trigger
--    (2026-08-24 查證:staging 與 production 皆為 0 支)。
--
-- ⚠️ 因此本表目前【不存在】trigger 順序不變量。
--    但這是現況,不是永久性質 —— quotes 表的順序不變量(CB-76 / CB-77)
--    之所以存在,是因為同一 timing 掛了多支 row trigger,
--    PostgreSQL 依【名稱位元序】執行。
--    🔴 dealers 日後若出現同 timing 的第二支 trigger,該原則立刻重新適用,
--       屆時必須重新盤點順序。
--
-- 📌 F-101(dealers 欄位保護)預留:
--    F-101 將是 BEFORE UPDATE,本 trigger 是 BEFORE INSERT ——
--    兩者【永不同場競技】,位元序在功能上不相干。
--    (且 admin_insert_dealers policy 只允許 role='admin',
--     dealer 根本無 INSERT 權限 → F-101 不需要 INSERT 側。)
--    命名仍讓位元序天然正確作為防禦縱深:
--      trg_copy_business_address_on_insert  (CB-81, 'c')
--      trg_guard_dealer_columns_on_update   (F-101 預留, 'g')
--    'c' < 'g' —— 先填值,再檢查。
--
-- 不加 WHEN 子句:加了就得寫成負向形式,與正向識別(F-35)衝突。
--    判斷全部留在函式體內。(對齊 CB-76 INSERT 側的同一取捨。)
-- ============================================================================

DO $cb81_trg$
BEGIN
  PERFORM _ops.assert_env('production');

  -- ── 前置條件 ①:Segment 1 的 9 欄全部存在,且型別正確 ────────────────────
  --    型別錯誤(如 business_lat 建成 numeric 而非 numeric(10,7))不會報錯,
  --    只會讓座標精度與 lat/lng 不一致 —— 圖釘偏移,看不出來。
  IF (SELECT count(*)
        FROM pg_catalog.pg_attribute a
       WHERE a.attrelid = 'public.dealers'::regclass
         AND a.attnum > 0 AND NOT a.attisdropped
         AND ((a.attname IN ('business_email',
                             'business_address_line1',
                             'business_address_line2',
                             'business_city',
                             'business_state',
                             'business_zip_code',
                             'business_address_formatted')
               AND pg_catalog.format_type(a.atttypid, a.atttypmod) = 'text')
           OR (a.attname IN ('business_lat', 'business_lng')
               AND pg_catalog.format_type(a.atttypid, a.atttypmod) = 'numeric(10,7)'))
      ) <> 9 THEN
    RAISE EXCEPTION
      'ABORT: 9 個 business_* 欄位未全數存在或型別不符 → Segment 1 未執行或失敗。'
      ' 未建立 trigger,無任何改動。';
  END IF;

  -- ── 前置條件 ②:Segment 2 的函式,且必須是 SECURITY INVOKER ──────────────
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'copy_business_address_on_insert'
      AND p.prorettype = 'pg_catalog.trigger'::regtype
      AND NOT p.prosecdef
  ) THEN
    RAISE EXCEPTION
      'ABORT: public.copy_business_address_on_insert() 不存在,或誤建為'
      ' SECURITY DEFINER → Segment 2 未執行或失敗。未建立 trigger,無任何改動。';
  END IF;

  -- ── 冪等:先移除舊版(若有)────────────────────────────────────────────
  DROP TRIGGER IF EXISTS trg_copy_business_address_on_insert ON public.dealers;

  CREATE TRIGGER trg_copy_business_address_on_insert
    BEFORE INSERT ON public.dealers
    FOR EACH ROW
    EXECUTE FUNCTION public.copy_business_address_on_insert();

  RAISE NOTICE 'CB-81 Segment 3 完成:trigger 已建立(dealers 表第一支)。';
END
$cb81_trg$;


-- ============================================================================
-- Segment 3b / 6   文件(零行為影響,不綁入原子單元)
-- ============================================================================

COMMENT ON TRIGGER trg_copy_business_address_on_insert ON public.dealers IS
$doc$CB-81 建立 dealer 時複製地址至 business_*。dealers 表的第一支 trigger。

判斷邏輯全在 public.copy_business_address_on_insert() —— 詳見該函式的 COMMENT。

🔴 只掛 BEFORE INSERT。掛上 UPDATE 即為靜默覆蓋 dealer 自設的對外地址。

🔴 為何必須是 DB trigger,而非前端或 create-dealer Edge Function
   (CB-81 Stage 0 P0-2):
     前端           — 直接打 PostgREST 即可繞過 → 該 dealer 在 locator 上
                      地址空白【且不報錯】
     create-dealer  — 涵蓋 UI 路徑,直接 SQL 插入仍會漏
     DB trigger     — 全路徑涵蓋
   🔴 DB DEFAULT 做不到 —— DEFAULT 無法引用同一列的其他欄位。

⚠️ 順序不變量:本表目前僅此一支 trigger,故【不存在】順序問題。
   但 quotes 表的先例(CB-76 / CB-77)顯示:同一 timing 掛多支 row trigger 時,
   PostgreSQL 依名稱位元序執行,而該順序是【功能不變量】。
   🔴 dealers 日後若新增同 timing 的 trigger,必須重新盤點順序。
   F-101(欄位保護)為 BEFORE UPDATE,與本支不同 timing,不受此限。$doc$;

COMMENT ON COLUMN public.dealers.business_email IS
$doc$CB-81 對外 Email —— 顯示於 Dealer Locator 公開頁面。

🔴 建立時【不】自動複製,維持 NULL(業主拍板)。
   內部 email(dealers.email)是與 ProCraft 溝通用,複製即等於公開。
🔴 不 backfill。NULL 時 locator 不顯示該欄位(須確認為整欄不渲染,
   而非顯示空白列)。$doc$;

COMMENT ON COLUMN public.dealers.business_address_line1 IS
$doc$CB-81 對外地址 —— 顯示於 Dealer Locator 地圖與公開頁面。

⚠️ 與 dealers.address_line1 的分工(2026-08-24 實查):
   address_line1 【不是】「內部聯絡地址」,它是【帳單地址】——
   印在每一張 PO 與 PDF 上(pdf-builder.js),
   並作為開單時 Billing 面板的來源(new-quote.html)。
   business_address_line1 才是對外展示用。兩者用途不同,不可互相取代。

🔴 建立時自動複製自 address_line1,之後【永不同步】。
   dealer 於 dealer-profile.html 的 Dealer Locator Listing 區塊自行維護。$doc$;

COMMENT ON COLUMN public.dealers.business_lat IS
$doc$CB-81 對外地址緯度。型別與 dealers.lat 相同:numeric(10,7)。

🔴 NULL 時 locator 【不得】建立地圖圖釘,亦【不得】落到座標零點 ——
   (0,0) 會讓圖釘出現在幾內亞灣外海,且看起來「有資料」,
   不會被當成缺漏。典型的靜默失敗。

🔴 dealer 手動編輯地址文字而未從 Google 建議清單重新選取時,
   前端會清空本欄(CB-81 Q-15 = D),並擋下存檔(Q-23 = B)。
   理由:保留舊座標會讓圖釘穩穩插在【錯誤位置】,畫面完全正常,
   消費者導航到錯的地方 —— 比「消失」更糟。$doc$;

COMMENT ON COLUMN public.dealers.business_lng IS
$doc$CB-81 對外地址經度。型別與 dealers.lng 相同:numeric(10,7)。
其餘同 business_lat 的說明。$doc$;

COMMENT ON COLUMN public.dealers.business_address_line2 IS
$doc$CB-81 對外地址第二行(Suite / 樓層)。建立時自動複製,之後永不同步。$doc$;

COMMENT ON COLUMN public.dealers.business_city IS
$doc$CB-81 對外地址城市。建立時自動複製,之後永不同步。$doc$;

COMMENT ON COLUMN public.dealers.business_state IS
$doc$CB-81 對外地址州別。建立時自動複製,之後永不同步。$doc$;

COMMENT ON COLUMN public.dealers.business_zip_code IS
$doc$CB-81 對外地址郵遞區號。建立時自動複製,之後永不同步。$doc$;

COMMENT ON COLUMN public.dealers.business_address_formatted IS
$doc$CB-81 對外地址完整字串,來源為 Google Places 的 formatted_address。

📌 2026-08-24 查證:production 21 筆 address_formatted 中,20 筆帶 ", USA"
   (Google 回傳原樣),1 筆為人工填入的 trial 帳號。
   格式並非單一來源,locator 端顯示時不應假設固定結構。$doc$;


-- ============================================================================
-- Segment 4 / 6   backfill   🔴 原子單元 —— 必須整段一次執行
-- ----------------------------------------------------------------------------
-- 🔴 Q-20 = B:八段【各自獨立】的 UPDATE,每段自帶條件。
--    每一段的形態固定為:
--      UPDATE ... SET business_X = X WHERE business_X IS NULL AND X IS NOT NULL
--    SET 的左側恆為 business_ 側、右側恆為內部側;WHERE 判斷的也是 business_ 側。
--    🔴 若某一段寫反(SET address_x = business_address_x),那一段就變成
--       「拿空值去洗掉內部帳單地址」—— 而帳單地址印在每張 PDF 上。
--       獨立成段 + 條件外顯,使這種錯誤在閱讀時一眼可見。
--
-- 🔴 不過濾 account_type(Q-12)。理由見函式 COMMENT。
-- 🔴 完全不觸及 business_email 與 business_phone。
--    本段對這兩欄做【執行前後的 count 比對】,任一有變動即中止整段。
--    這是把「沒有動到」從承諾變成證明。
--
-- 冪等:WHERE business_X IS NULL 使重跑只影響尚未填值的列。
--    🔴 但這正是 Q-20 那顆延遲地雷的所在 —— 重跑本身是安全的,
--       前提是 SET 的方向正確。
-- ============================================================================

DO $cb81_backfill$
DECLARE
  v_phone_before  integer;
  v_phone_after   integer;
  v_email_before  integer;
  v_email_after   integer;
  v_n             integer;
  v_total         integer := 0;
BEGIN
  PERFORM _ops.assert_env('production');

  -- ── 前置條件:trigger 必須已存在且啟用 ──────────────────────────────────
  --   backfill 期間若有人新建 dealer,trigger 已在即不需二次回填。
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.dealers'::regclass
      AND NOT tgisinternal
      AND tgenabled = 'O'
      AND tgname = 'trg_copy_business_address_on_insert'
  ) THEN
    RAISE EXCEPTION
      'ABORT: trg_copy_business_address_on_insert 不存在或未啟用 →'
      ' Segment 3 未執行或失敗。未回填任何資料,無任何改動。';
  END IF;

  -- ── 執行前基準:business_phone / business_email 的非 NULL 列數 ───────────
  SELECT count(*) INTO v_phone_before
    FROM public.dealers WHERE business_phone IS NOT NULL;
  SELECT count(*) INTO v_email_before
    FROM public.dealers WHERE business_email IS NOT NULL;

  RAISE NOTICE 'CB-81 S4 基準:business_phone 非 NULL = % 列,business_email 非 NULL = % 列。',
    v_phone_before, v_email_before;

  -- ── ① address_line1 ─────────────────────────────────────────────────────
  UPDATE public.dealers
     SET business_address_line1 = address_line1
   WHERE business_address_line1 IS NULL
     AND address_line1 IS NOT NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;
  RAISE NOTICE 'CB-81 S4 ① business_address_line1:% 列。', v_n;

  -- ── ② address_line2 ─────────────────────────────────────────────────────
  UPDATE public.dealers
     SET business_address_line2 = address_line2
   WHERE business_address_line2 IS NULL
     AND address_line2 IS NOT NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;
  RAISE NOTICE 'CB-81 S4 ② business_address_line2:% 列。', v_n;

  -- ── ③ city ──────────────────────────────────────────────────────────────
  UPDATE public.dealers
     SET business_city = city
   WHERE business_city IS NULL
     AND city IS NOT NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;
  RAISE NOTICE 'CB-81 S4 ③ business_city:% 列。', v_n;

  -- ── ④ state ─────────────────────────────────────────────────────────────
  UPDATE public.dealers
     SET business_state = state
   WHERE business_state IS NULL
     AND state IS NOT NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;
  RAISE NOTICE 'CB-81 S4 ④ business_state:% 列。', v_n;

  -- ── ⑤ zip_code ──────────────────────────────────────────────────────────
  UPDATE public.dealers
     SET business_zip_code = zip_code
   WHERE business_zip_code IS NULL
     AND zip_code IS NOT NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;
  RAISE NOTICE 'CB-81 S4 ⑤ business_zip_code:% 列。', v_n;

  -- ── ⑥ address_formatted ─────────────────────────────────────────────────
  UPDATE public.dealers
     SET business_address_formatted = address_formatted
   WHERE business_address_formatted IS NULL
     AND address_formatted IS NOT NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;
  RAISE NOTICE 'CB-81 S4 ⑥ business_address_formatted:% 列。', v_n;

  -- ── ⑦ lat ───────────────────────────────────────────────────────────────
  UPDATE public.dealers
     SET business_lat = lat
   WHERE business_lat IS NULL
     AND lat IS NOT NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;
  RAISE NOTICE 'CB-81 S4 ⑦ business_lat:% 列。', v_n;

  -- ── ⑧ lng ───────────────────────────────────────────────────────────────
  UPDATE public.dealers
     SET business_lng = lng
   WHERE business_lng IS NULL
     AND lng IS NOT NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;
  RAISE NOTICE 'CB-81 S4 ⑧ business_lng:% 列。', v_n;

  -- ── 🔴 執行後比對:證明 phone / email 完全未被觸及 ───────────────────────
  SELECT count(*) INTO v_phone_after
    FROM public.dealers WHERE business_phone IS NOT NULL;
  SELECT count(*) INTO v_email_after
    FROM public.dealers WHERE business_email IS NOT NULL;

  IF v_phone_after <> v_phone_before THEN
    RAISE EXCEPTION
      'ABORT: business_phone 非 NULL 列數由 % 變為 % —— 本段不應觸及該欄。'
      ' 整段已回滾。', v_phone_before, v_phone_after;
  END IF;

  IF v_email_after <> v_email_before THEN
    RAISE EXCEPTION
      'ABORT: business_email 非 NULL 列數由 % 變為 % —— 本段不應觸及該欄。'
      ' 整段已回滾。', v_email_before, v_email_after;
  END IF;

  RAISE NOTICE 'CB-81 Segment 4 完成:八段合計 % 次欄位更新;'
    ' business_phone 與 business_email 均未變動(各 % / % 列)。',
    v_total, v_phone_after, v_email_after;
END
$cb81_backfill$;


-- ============================================================================
-- Segment 5 / 6   驗證
-- ----------------------------------------------------------------------------
-- 硬斷言:任一不成立即 RAISE EXCEPTION,不得僅回報。
-- ============================================================================

DO $cb81_verify$
DECLARE
  v_n      integer;
  v_config text[];
BEGIN
  PERFORM _ops.assert_env('production');

  -- (1) 9 欄存在且型別正確
  SELECT count(*) INTO v_n
  FROM pg_catalog.pg_attribute a
  WHERE a.attrelid = 'public.dealers'::regclass
    AND a.attnum > 0 AND NOT a.attisdropped
    AND ((a.attname IN ('business_email',
                        'business_address_line1',
                        'business_address_line2',
                        'business_city',
                        'business_state',
                        'business_zip_code',
                        'business_address_formatted')
          AND pg_catalog.format_type(a.atttypid, a.atttypmod) = 'text')
      OR (a.attname IN ('business_lat', 'business_lng')
          AND pg_catalog.format_type(a.atttypid, a.atttypmod) = 'numeric(10,7)'));
  IF v_n <> 9 THEN
    RAISE EXCEPTION
      'ASSERT 1 失敗:型別正確的 business_* 欄位數 = %(應為 9)。'
      ' 🔴 特別檢查 business_lat / business_lng 是否誤建為 numeric 而非 numeric(10,7)。', v_n;
  END IF;

  -- (2) trigger 存在、啟用、BEFORE、INSERT
  SELECT count(*) INTO v_n
  FROM pg_catalog.pg_trigger t
  WHERE t.tgrelid = 'public.dealers'::regclass
    AND NOT t.tgisinternal
    AND t.tgenabled = 'O'
    AND t.tgname = 'trg_copy_business_address_on_insert'
    AND (t.tgtype & 2) > 0     -- BEFORE
    AND (t.tgtype & 4) > 0;    -- INSERT
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'ASSERT 2 失敗:CB-81 trigger 不存在 / 未啟用 / 非 BEFORE INSERT。';
  END IF;

  -- (2b) 🔴 trigger 【不得】掛在 UPDATE 上
  SELECT count(*) INTO v_n
  FROM pg_catalog.pg_trigger t
  WHERE t.tgrelid = 'public.dealers'::regclass
    AND NOT t.tgisinternal
    AND t.tgname = 'trg_copy_business_address_on_insert'
    AND (t.tgtype & 16) > 0;   -- UPDATE
  IF v_n <> 0 THEN
    RAISE EXCEPTION
      'ASSERT 2b 失敗:CB-81 trigger 誤掛於 UPDATE。'
      ' 🔴 這會在 admin 每次修改內部地址時靜默覆蓋 dealer 自設的對外地址。'
      ' 請立即執行 ROLLBACK R-1 後重跑 Segment 3。';
  END IF;

  -- (3) 函式存在、非 SECURITY DEFINER、search_path 已設為空字串
  --   🔴 proconfig 的實際字面為 search_path=""(含雙引號)——
  --      SET search_path = '' 儲存時會把空字串加引號。
  --      不可比對 'search_path='(CB-76 的 'search_path=public, pg_temp'
  --      不帶引號是因為那不是空字串,兩者形式不同,不可直接套用)。
  SELECT p.proconfig INTO v_config
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'copy_business_address_on_insert'
    AND p.prorettype = 'pg_catalog.trigger'::regtype
    AND NOT p.prosecdef;
  IF v_config IS NULL OR NOT (v_config @> ARRAY['search_path=""']) THEN
    RAISE EXCEPTION
      'ASSERT 3 失敗:函式不存在 / 誤建為 SECURITY DEFINER / search_path 不符。'
      ' 實際 proconfig = %', v_config;
  END IF;

  -- (4) 🔴 複製完整性:來源有值而目標為 NULL 的列 = 0
  SELECT count(*) INTO v_n
  FROM public.dealers d
  WHERE (d.address_line1      IS NOT NULL AND d.business_address_line1      IS NULL)
     OR (d.address_line2      IS NOT NULL AND d.business_address_line2      IS NULL)
     OR (d.city               IS NOT NULL AND d.business_city               IS NULL)
     OR (d.state              IS NOT NULL AND d.business_state              IS NULL)
     OR (d.zip_code           IS NOT NULL AND d.business_zip_code           IS NULL)
     OR (d.address_formatted  IS NOT NULL AND d.business_address_formatted  IS NULL)
     OR (d.lat                IS NOT NULL AND d.business_lat                IS NULL)
     OR (d.lng                IS NOT NULL AND d.business_lng                IS NULL);
  IF v_n <> 0 THEN
    RAISE EXCEPTION
      'ASSERT 4 失敗:有 % 列的來源欄位有值但對應 business_* 仍為 NULL →'
      ' Segment 4 未執行或未涵蓋全部八欄。', v_n;
  END IF;

  -- (5) 🔴 business_email 全數為 NULL(證明沒有誤複製)
  SELECT count(*) INTO v_n
  FROM public.dealers WHERE business_email IS NOT NULL;
  IF v_n <> 0 THEN
    RAISE EXCEPTION
      'ASSERT 5 失敗:business_email 有 % 列非 NULL。'
      ' 🔴 本票明令該欄維持 NULL —— 內部 email 被複製即等於公開在對消費者的網頁上。', v_n;
  END IF;

  RAISE NOTICE 'CB-81 Segment 5:六項硬斷言全數通過。'
    ' 🔴 尚未結束 —— 請務必檢視人眼複核 D。';
END
$cb81_verify$;


-- ── 人眼複核 A:dealers 的 trigger 清單  🔴 預期【1 列】────────────────────
--   trg_copy_business_address_on_insert  BEFORE  t/f  O
--   📌 本表史上第一支 trigger。若出現第二支,順序不變量即重新適用(見 3b)。
WITH guard AS MATERIALIZED (SELECT _ops.assert_env('production') AS ok)
SELECT current_database()                         AS db,
       (SELECT name        FROM _ops.environment) AS env_name,
       t.tgname                                   AS trigger_name,
       CASE WHEN (t.tgtype & 2) > 0 THEN 'BEFORE' ELSE 'AFTER' END AS timing,
       (t.tgtype & 4)  > 0                        AS on_insert,
       (t.tgtype & 16) > 0                        AS on_update,
       t.tgenabled                                AS enabled,
       p.proname                                  AS function_name,
       p.prosecdef                                AS is_security_definer
FROM pg_catalog.pg_trigger t
CROSS JOIN guard
JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
WHERE t.tgrelid = 'public.dealers'::regclass
  AND NOT t.tgisinternal
ORDER BY t.tgname COLLATE "C";


-- ── 人眼複核 B:DOC-1 §9 稽核 —— 🔴 基線 7/9 【維持不變】────────────────────
--   本票的函式為 SECURITY INVOKER,不應出現在本清單中。
WITH guard AS MATERIALIZED (SELECT _ops.assert_env('production') AS ok)
SELECT current_database()                         AS db,
       (SELECT name        FROM _ops.environment) AS env_name,
       p.proname                                  AS function_name,
       p.prosecdef                                AS is_security_definer,
       p.proconfig                                AS proconfig
FROM pg_catalog.pg_proc p
CROSS JOIN guard
JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.prosecdef
ORDER BY p.proname;


-- ── 人眼複核 C:business_* 填充概況 ────────────────────────────────────────
--   🔴 has_biz_phone 預期:staging = 4,production = 1(業主知情決定,不 backfill)
--   🔴 has_biz_email 預期:兩環境皆 0
WITH guard AS MATERIALIZED (SELECT _ops.assert_env('production') AS ok)
SELECT current_database()                         AS db,
       (SELECT name        FROM _ops.environment) AS env_name,
       count(*)                                                                AS total,
       count(*) FILTER (WHERE d.business_address_line1     IS NOT NULL)        AS has_biz_line1,
       count(*) FILTER (WHERE d.business_city              IS NOT NULL)        AS has_biz_city,
       count(*) FILTER (WHERE d.business_state             IS NOT NULL)        AS has_biz_state,
       count(*) FILTER (WHERE d.business_zip_code          IS NOT NULL)        AS has_biz_zip,
       count(*) FILTER (WHERE d.business_address_formatted IS NOT NULL)        AS has_biz_formatted,
       count(*) FILTER (WHERE d.business_lat IS NOT NULL
                          AND d.business_lng IS NOT NULL)                      AS has_biz_latlng,
       count(*) FILTER (WHERE d.business_phone             IS NOT NULL)        AS has_biz_phone,
       count(*) FILTER (WHERE d.business_email             IS NOT NULL)        AS has_biz_email
FROM public.dealers d
CROSS JOIN guard;


-- ── 🔴 人眼複核 D:「誰會從地圖上消失」───────────────────────────────────────
--   有對外地址文字,但沒有對外座標的列。
--   🔴 這份清單就是 backfill 之後【仍不會出現在 Locator 地圖上】的 dealer。
--
--   預期列數:staging = 2(Test Dealer seed 資料,手填無座標)
--             production = 0(2026-08-24 查證 dealer_no_latlng = 0)
--
--   🔴 刻意不寫成硬斷言:staging 預期非 0,硬斷言會誤爆;
--      production 預期 0,若非 0 是需人工判讀的真實異常,不是應自動中止的錯誤。
--
--   🔴 若 production 出現非 0 列:不要直接補座標。先確認該 dealer 的地址
--      是否本來就無效,再決定是請 dealer 自行於 profile 頁重新選取,
--      還是由 admin 修正內部地址後手動處理。
WITH guard AS MATERIALIZED (SELECT _ops.assert_env('production') AS ok)
SELECT current_database()                         AS db,
       (SELECT name        FROM _ops.environment) AS env_name,
       d.id,
       d.company_name,
       d.account_type,
       d.business_address_line1,
       d.business_city,
       d.business_state,
       d.business_zip_code,
       (d.business_address_formatted IS NOT NULL) AS has_biz_formatted
FROM public.dealers d
CROSS JOIN guard
WHERE d.business_address_line1 IS NOT NULL
  AND d.business_address_line1 <> ''
  AND (d.business_lat IS NULL OR d.business_lng IS NULL)
ORDER BY d.company_name;


-- ============================================================================
-- Segment R   ROLLBACK   🔴 全部註解掉,需要時才逐段解開
-- ----------------------------------------------------------------------------
-- R-1 與 R-3 / R-4 刻意分離:止血不該需要破壞資料。
-- ============================================================================

-- ── R-1  止血:停止自動複製。🟢 不損任何資料,可獨立執行 ────────────────────
--   適用情境:trigger 誤掛 UPDATE(ASSERT 2b 失敗)、或複製行為不符預期。
-- DO $cb81_rb1$
-- BEGIN
--   PERFORM _ops.assert_env('production');
--   DROP TRIGGER IF EXISTS trg_copy_business_address_on_insert ON public.dealers;
--   RAISE NOTICE 'CB-81 R-1:trigger 已移除,自動複製已停止。';
-- END
-- $cb81_rb1$;

-- ── R-2  移除函式(選用,須先執行 R-1)────────────────────────────────────
-- DO $cb81_rb2$
-- BEGIN
--   PERFORM _ops.assert_env('production');
--   DROP FUNCTION IF EXISTS public.copy_business_address_on_insert();
--   RAISE NOTICE 'CB-81 R-2:函式已移除。';
-- END
-- $cb81_rb2$;

-- ── R-3  🔴 清空八個地址欄 —— 會刪除 dealer 已自行設定的對外地址 ────────────
--   🔴 執行前必須先跑人眼複核 C 並保留輸出。
--      若 dealer 已開始自行維護對外地址,這些資料【無法還原】。
--   🔴 刻意不碰 business_phone 與 business_email:本票從未寫入這兩欄,
--      回滾也不該清除它們(business_phone 在 production 有 1 筆既有值,
--      那是 CB-81 之前就存在的資料)。
-- DO $cb81_rb3$
-- BEGIN
--   PERFORM _ops.assert_env('production');
--   UPDATE public.dealers
--      SET business_address_line1     = NULL,
--          business_address_line2     = NULL,
--          business_city              = NULL,
--          business_state             = NULL,
--          business_zip_code          = NULL,
--          business_address_formatted = NULL,
--          business_lat               = NULL,
--          business_lng               = NULL;
--   RAISE NOTICE 'CB-81 R-3:八個地址欄已清空(business_phone / business_email 未動)。';
-- END
-- $cb81_rb3$;

-- ── R-4  🔴 移除 9 個欄位 —— 不可逆 ────────────────────────────────────────
--   🔴 執行前必須先跑人眼複核 C 並保留輸出。非到必要不要執行。
-- DO $cb81_rb4$
-- BEGIN
--   PERFORM _ops.assert_env('production');
--   ALTER TABLE public.dealers
--     DROP COLUMN IF EXISTS business_email,
--     DROP COLUMN IF EXISTS business_address_line1,
--     DROP COLUMN IF EXISTS business_address_line2,
--     DROP COLUMN IF EXISTS business_city,
--     DROP COLUMN IF EXISTS business_state,
--     DROP COLUMN IF EXISTS business_zip_code,
--     DROP COLUMN IF EXISTS business_address_formatted,
--     DROP COLUMN IF EXISTS business_lat,
--     DROP COLUMN IF EXISTS business_lng;
--   RAISE NOTICE 'CB-81 R-4:9 個欄位已移除(不可逆)。';
-- END
-- $cb81_rb4$;
