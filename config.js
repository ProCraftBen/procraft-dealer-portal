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
  // ⚠️ 目前為 PLACEHOLDER,n8n workflow 建立後(CB-43 後續工作單)回填真值。
  window.N8N_PAYMENT_WEBHOOK = isProd
    ? 'https://n8n.example.com/webhook/PLACEHOLDER_PROD_PAYMENT'      // production
    : 'https://n8n.example.com/webhook/PLACEHOLDER_STAGING_PAYMENT'; // staging

  // 方便在 Console 一眼確認現在連哪個環境
  console.log('[config] SB_ENV =', window.SB_ENV, '| SB_URL =', window.SB_URL, '| N8N_PAYMENT_WEBHOOK =', window.N8N_PAYMENT_WEBHOOK);
})();
