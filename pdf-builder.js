// ============================================================
// ProCraft Dealer Portal - Shared PDF Builder
// ============================================================
// 所有 PDF 生成邏輯集中在這個檔案。
// 使用方式（在 HTML 裡）：
//   <script src="pdf-builder.js"></script>
// 然後就可以呼叫 ProCraftPDF.buildPackingListPdf(...) 等函式。
// ============================================================

(function (global) {
  'use strict';

  // ----------------------------------------
  // 常數
  // ----------------------------------------
  const TYPE_ORDER = ['BASE', 'WALL', 'TALL', 'ACCESSORIES', 'MODIFICATION'];

  // PDF 顏色（RGB 陣列，給 jsPDF 用）
  const COLORS = {
    darkGreen: [14, 31, 22],
    muted:     [122, 140, 130],
    border:    [221, 216, 204],
    gold:      [201, 168, 76],
    white:     [255, 255, 255],
  };

  // PDF 版面常數
  const LAYOUT = {
    pageW:    210,   // A4 寬度（mm）
    pageH:    297,   // A4 高度（mm）
    margin:   14,
    headerH:  32,    // header 區塊高度
  };

  // ----------------------------------------
  // Internal Helpers
  // ----------------------------------------

  /**
   * 把 type 字串轉成排序用的數字（BASE=0、WALL=1、TALL=2...）
   * 不認識的 type 排到最後（99）
   */
  function _typeRank(type) {
    const idx = TYPE_ORDER.indexOf((type || '').toUpperCase());
    return idx === -1 ? 99 : idx;
  }

  /**
   * 把 items 依 style 群組、組內依 type 排序
   *
   * @param {Array} items - 必須有 style_name (或 style_code) + sku_type 欄位
   * @returns {Object} - { styleName: [item, item, ...] }
   */
  function _groupAndSort(items) {
    const grouped = {};
    items.forEach(item => {
      const styleKey = item.style_name || item.style_code || '—';
      if (!grouped[styleKey]) grouped[styleKey] = [];
      grouped[styleKey].push(item);
    });
    Object.keys(grouped).forEach(style => {
      grouped[style].sort((a, b) => {
        const aType = a.sku_type || a.skuType;
        const bType = b.sku_type || b.skuType;
        return _typeRank(aType) - _typeRank(bType);
      });
    });
    return grouped;
  }

  /**
   * 計算 assemble fee 依 type 分類的小計
   * 只算 assemble_status === 'Assembled' 且有 assemble_fee 的 item
   *
   * @returns {Object} - { BASE: { qty, total }, WALL: { qty, total }, ... }
   */
  function _calcAsmByType(items) {
    const byType = {};
    items.forEach(item => {
      // 處理兩種來源的欄位差異（step3 用 type、quote-detail 用 assemble_status）
      const status = item.assemble_status || item.type;
      if ((status || '').toLowerCase() !== 'assembled' || !item.assemble_fee) return;

      const t = (item.sku_type || item.skuType || 'OTHER').toUpperCase();
      if (!byType[t]) byType[t] = { qty: 0, total: 0 };
      byType[t].qty   += item.quantity;
      byType[t].total += parseFloat(item.assemble_fee) * item.quantity;
    });
    return byType;
  }

  /**
   * 載入圖片並轉成 base64 dataURL（給 jsPDF.addImage 用）
   *
   * @param {string} url - 圖片網址（必須允許 CORS）
   * @returns {Promise<string>} - base64 PNG dataURL
   */
  function _loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width  = img.width;
        canvas.height = img.height;
        canvas.getContext('2d').drawImage(img, 0, 0);
        resolve(canvas.toDataURL('image/png'));
      };
      img.onerror = reject;
      img.src = url;
    });
  }

  // ----------------------------------------
  // 對外暴露
  // ----------------------------------------
  global.ProCraftPDF = {
    // 常數
    _TYPE_ORDER: TYPE_ORDER,
    _COLORS:     COLORS,
    _LAYOUT:     LAYOUT,

    // Helpers
    _typeRank:      _typeRank,
    _groupAndSort:  _groupAndSort,
    _calcAsmByType: _calcAsmByType,
    _loadImage:     _loadImage,

    // 後續步驟會繼續加：
    // buildPackingListPdf: ...
    // buildInvoicePdf:     ...
    // buildDraftQuotePdf:  ...
    // getPdfFilename:      ...
  };

})(window);
