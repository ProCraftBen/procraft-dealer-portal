// =====================================================================
// config.js  |  ProCraft Dealer Portal —— Supabase 環境設定(單一真相來源)
// ---------------------------------------------------------------------
// 依「網址 hostname」自動判斷連 production 還是 staging。
// 只有正式自訂網域 = production;其餘任何網址(含 staging 的 github.io)一律 staging。
// → 這樣就算 staging 網址被誰看到、亂點,也只碰得到 staging 假資料,絕不會誤動正式 DB。
//
// 載入時機(重要):必須在 supabase CDN 之後、任何 createClient / component 之前。
// 每頁已把 <script src="config.js"> 插在 supabase CDN 那行的正下方,順序正確。
// =====================================================================
(function () {
  var PROD_HOST = 'dc-portal.procraftcabinetry.com';
  var isProd = (window.location.hostname === PROD_HOST);

  window.SB_ENV = isProd ? 'production' : 'staging';

  window.SB_URL = isProd
    ? 'https://acwgemgpnusworpxxoai.supabase.co'    // production
    : 'https://jkcbusliyrxbgebdrybl.supabase.co';   // staging

  window.SB_KEY = isProd
    ? 'sb_publishable_GYx1PEpxNJ9dj5V3WYpPWQ_8YfB0w8M'   // production anon (publishable)
    : 'sb_publishable_ja9UXeBpInmYzENNq67yRg_K2Jj8ol_';  // staging anon (publishable)

  // CB-43 付款流程:dealer 選 Card/ACH 後前端 POST 到此 webhook,由 n8n 建 QuickBooks Invoice。
  // 環境感知:staging 接 QuickBooks Sandbox、production 接正式 QuickBooks,避免 staging 打到正式金流。
  // ⚠️ path 差異:production = payment-request-prod / staging = payment-request(1-A-2-B 為避開
  //    n8n 同 instance path 衝突所做的變更)。兩者同 instance,只靠 path 區分,勿混用。
  window.N8N_PAYMENT_WEBHOOK = isProd
    ? 'https://benprocraftdc.app.n8n.cloud/webhook/payment-request-prod' // production
    : 'https://benprocraftdc.app.n8n.cloud/webhook/payment-request'; // staging

  // ===================================================================
  // CB-42 | Google reCAPTCHA v3
  // -------------------------------------------------------------------
  // 用途:Intuit / QuickBooks Payments 上架合規要求(CB-43 promote 前置)。
  //       目前僅套用於 login.html(login + forgot password 兩個 action)。
  //
  // Site key 是「公開」憑證,Google 設計上就會出現在前端原始碼,放這裡沒有問題。
  // ⚠️ Secret key 絕不可出現在此檔案、任何前端檔案、或 GitHub。
  //    Secret key 只存放於 Supabase Edge Function Secrets(兩環境各設一次):
  //      staging    → jkcbusliyrxbgebdrybl → Settings → Edge Functions → Secrets
  //      production → acwgemgpnusworpxxoai → 同上
  //
  // 單一 key 涵蓋兩環境(不做 isProd 分支)。已在 Google reCAPTCHA Admin
  // 註冊的 domain:
  //      dc-portal.procraftcabinetry.com   (production)
  //      procraftben.github.io             (staging)
  //      localhost / 127.0.0.1             (本地測試)
  // ⚠️ 未列於上述清單的網域會取不到 token,前端會走 fail-open 並留下
  //    console.error log。新增環境時必須同步更新 Google 端 domain 清單。
  // ===================================================================
  window.RECAPTCHA_SITE_KEY = '6LegwV8tAAAAAI4E-3mfZB1sWJqC2TKturwiYTRg';

  // -------------------------------------------------------------------
  // Kill switch —— 平常必須維持 true。
  //
  // 設為 false 會「完全跳過」reCAPTCHA 驗證,登入流程回到 CB-42 之前的
  // 狀態。這代表暫時脫離 Intuit 合規要求,僅限以下兩種情況使用:
  //
  //   1. 緊急:reCAPTCHA 大量誤擋真人,導致 dealer 無法登入
  //            (先關閉恢復服務,再調整 verify-recaptcha 的 threshold)
  //   2. Debug:本地開發或排錯時暫時關閉
  //
  // ⚠️ 使用規則:
  //    · 關閉後必須立即開 ticket 追蹤,並記錄關閉原因與時間
  //    · 修復後必須改回 true 並重新部署
  //    · production 不得長期維持 false
  //
  // 注意:這是前端旗標,不影響 verify-recaptcha Edge Function 本身。
  //       Edge Function 仍然存在且可被呼叫,只是前端不再呼叫它。
  // -------------------------------------------------------------------
  window.RECAPTCHA_ENABLED = true;

  // 方便在 Console 一眼確認現在連哪個環境
  console.log('[config] SB_ENV =', window.SB_ENV, '| SB_URL =', window.SB_URL, '| N8N_PAYMENT_WEBHOOK =', window.N8N_PAYMENT_WEBHOOK);
  console.log('[config] RECAPTCHA_ENABLED =', window.RECAPTCHA_ENABLED, '| SITE_KEY =', window.RECAPTCHA_SITE_KEY ? window.RECAPTCHA_SITE_KEY.slice(0, 12) + '…' : '(missing)');
})();
