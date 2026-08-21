-- ============================================================================
-- CB-77 Stage 4 ①  status_history 語意契約修正(Q-8)
-- ----------------------------------------------------------------------------
-- 環境:PRODUCTION (acwgemgpnusworpxxoai)
-- 日期:2026-08-21
--
-- 內容:僅更新 quotes.status_history 的 COMMENT ON COLUMN。
--       🟢 純文件,零行為影響。不動 trigger、不動函式、不動任何資料。
--
-- 背景:Stage 3 的 V-7 揭露 Q-3 拍板時的盲點 ——
--       舊單於 CB-77 上線後被改過一次狀態,會變成
--       「status_history 非 NULL,但歷程從中途才開始」的第三類。
--       原判準「非 NULL = 完整可信」不成立。
--
--       🔴 WHERE status_history IS NOT NULL 是錯誤的過濾條件:
--          它會把第三類當成完整歷程,總耗時嚴重偏短,
--          且結果看起來完全合理,無任何跡象顯示數字是錯的。
--
-- 🔴 本檔為 PRODUCTION 版,由 STAGING 版逐字複製,
--    僅將 3 處 _ops.assert_env('staging') 換成 _ops.assert_env('production')。
--    其餘一字不改。兩檔差異應【只有】這 3 行(加檔頭環境標示)。
-- ============================================================================

SELECT _ops.assert_env('production');

COMMENT ON COLUMN public.quotes.status_history IS
$doc$CB-77 狀態變更歷程。由 trigger 自動維護,非人工欄位。

格式:jsonb 陣列,依發生順序 append,保序(分析請用 WITH ORDINALITY)。
  [{"s": 狀態值, "at": UTC ISO8601, "by": auth.uid() 或 null, "r": 呼叫者角色}, ...]

  "at" 固定為 UTC,格式 YYYY-MM-DDTHH24:MI:SS.ffffffZ。
       以 to_char(... AT TIME ZONE 'UTC', ...) 產生,不受 session
       TimeZone / DateStyle 影響 —— 否則前端、n8n、SQL Editor 寫入的
       時戳會混雜不同 offset,耗時計算失真(CB-77 T-12)。
  "by" auth.uid();service_role / n8n / SQL Editor 取不到時為 null。
  "r"  coalesce(auth.role(), current_user::text)。
       🔴 不可改用 current_user 單獨判斷 —— submit_purchase_order 為
          SECURITY DEFINER,會把 dealer 送單全部誤記為 postgres(CB-77 B-3)。

════════════════════════════════════════════════════════════════════════
🔴 完整性分類(CB-77 Q-8。取代 Q-3 原本的「NULL / 非 NULL」二分法)
════════════════════════════════════════════════════════════════════════
  A. status_history IS NULL
       CB-77 上線前建立的舊單,且上線後未被動過。無任何追蹤資料。

  B. 第一筆的 at 貼合 created_at(±5 秒)
       CB-77 上線後【建立】的新單。歷程自建單起完整可信。
       判準原理:只有 INSERT trigger 寫的第一筆,時間才會貼合 created_at。

  C. 其餘(非 NULL,但第一筆的 at 遠晚於 created_at)
       CB-77 上線前的舊單,上線後才被接手記錄。
       🔴 陣列【缺少】上線前的所有歷程,且缺口大小不可知。

  判定查詢:
    CASE
      WHEN status_history IS NULL THEN 'A'
      WHEN (status_history -> 0 ->> 'at')::timestamptz - created_at
           BETWEEN interval '-5 seconds' AND interval '5 seconds' THEN 'B'
      ELSE 'C'
    END

────────────────────────────────────────────────────────────────────────
🔴 分析規則 —— 這三行比查詢本身重要。
   查詢寫錯會報錯;用錯資料範圍不會報錯,只會給出看似合理的錯數字。
────────────────────────────────────────────────────────────────────────
  總耗時(建單 → 完成)  →  只能用 B 類
  單一區間耗時           →  B + C(前提:該兩個狀態皆在陣列內)
  進入某狀態的次數       →  只能用 B 類(C 類會少算,且少算多少不可知)

  🔴 WHERE status_history IS NOT NULL 是【錯誤】的過濾條件 ——
     它等同於 B + C,會把 C 類當成完整歷程使用。
════════════════════════════════════════════════════════════════════════

⚠️ 寫入權威性的邊界(誠實記載,勿高估 —— CB-77 F-89):
   狀態【有】變更時 → BEFORE trigger 覆寫本欄,客戶端送什麼都不採信。
   狀態【未】變更時 → WHEN 子句不成立,trigger 不觸發,
                      持有該列 UPDATE 權限者可直接寫入本欄。
   目前僅 admin 與「自己 Draft/Returned 單」的 dealer 具此權限。
   本欄為分析用途、非財務欄位,現階段接受此邊界。

🔴 架構原則(CB-77 Stage 3 拍板):
   quotes 的 status 更新在任何情況下都【不得停用 trigger】。
   本 trigger 漏記無法事後補回,且會產生「非 NULL 但缺一段」的資料,
   與 C 類混淆後無從辨識。
   批次更新若因效能需要停用 trigger(session_replication_role /
   ALTER TABLE DISABLE TRIGGER),須改用其他方案並先經 PM 裁示。

與 fulfillment_date 的關係(CB-77 D-1):
  fulfillment_date          = admin 選定的業務出貨日 (date)
  本欄 Order Completed 的 at = 系統標記完成的時刻 (timestamptz)
  兩者語意獨立、可能不一致,不可互相替代。本 trigger 不讀不寫該欄。$doc$;


-- ============================================================================
-- 驗證(執行後跑)
-- ============================================================================
WITH guard AS MATERIALIZED (SELECT _ops.assert_env('production') AS ok)
SELECT current_database() AS db,
       (SELECT name FROM _ops.environment) AS env_name,
       col_description('public.quotes'::regclass,
         (SELECT attnum FROM pg_attribute
           WHERE attrelid = 'public.quotes'::regclass
             AND attname = 'status_history')) ILIKE '%完整性分類%' AS has_abc_section,
       length(col_description('public.quotes'::regclass,
         (SELECT attnum FROM pg_attribute
           WHERE attrelid = 'public.quotes'::regclass
             AND attname = 'status_history'))) AS comment_len
FROM guard;
-- ✅ 預期:has_abc_section = true


-- ── A/B/C 現況分佈(順便確認判準在本環境的實際結果)────────────────────
WITH guard AS MATERIALIZED (SELECT _ops.assert_env('production') AS ok),
cls AS (
  SELECT CASE
           WHEN q.status_history IS NULL THEN 'A. 無追蹤資料'
           WHEN (q.status_history -> 0 ->> 'at')::timestamptz - q.created_at
                BETWEEN interval '-5 seconds' AND interval '5 seconds'
             THEN 'B. 歷程完整'
           ELSE 'C. 中途才開始記錄'
         END AS completeness
  FROM public.quotes q
)
SELECT current_database() AS db, completeness, count(*) AS n
FROM cls CROSS JOIN guard
GROUP BY 1, 2 ORDER BY 2;


-- ============================================================================
-- ROLLBACK
-- ----------------------------------------------------------------------------
-- ⚠️ 本檔只改註解。回滾 = 貼回 CB-77 主 migration 的 COMMENT ON COLUMN 原文。
--    但原文已知【語意有誤】(二分法),回滾無實益。不提供回滾腳本。
-- ============================================================================
