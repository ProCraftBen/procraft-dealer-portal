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
  // PDF 區塊繪製函式
  // ----------------------------------------

  /**
   * 畫 PDF 頂部 header（每一頁都會用，包含跨頁時）
   *
   * @param {Object} doc - jsPDF 實例
   * @param {Object} context - { logoImg, poNumber, jobName, date }
   *   - logoImg: base64 dataURL 或 null（null 時用文字 fallback）
   *   - poNumber: 字串，PO# 或 'Draft' 或 '—'
   *   - jobName: 字串
   *   - date: Date 物件
   */
  function _drawHeader(doc, context) {
    const { pageW, margin, headerH } = LAYOUT;
    const { logoImg, poNumber, jobName, date } = context;

    // 白底 + 底線
    doc.setFillColor(...COLORS.white);
    doc.rect(0, 0, pageW, headerH, 'F');
    doc.setDrawColor(...COLORS.border);
    doc.setLineWidth(0.5);
    doc.line(0, headerH, pageW, headerH);

    // Logo（左上）
    if (logoImg) {
      doc.addImage(logoImg, 'PNG', margin, 3, 44, 26);
    } else {
      doc.setTextColor(...COLORS.darkGreen);
      doc.setFontSize(11);
      doc.setFont('helvetica', 'bold');
      doc.text('ProCraft DC', margin, 15);
    }

    // 公司資訊（中間）
    const infoX = margin + 48;
    let infoY = 7;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7);
    doc.setTextColor(...COLORS.darkGreen);
    doc.text('ProCraft Cabinetry DC LLC', infoX, infoY);
    infoY += 3.8;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.5);
    doc.setTextColor(40, 40, 40);
    [
      '6750 Santa Barbara Court Suite B',
      'Elkridge, MD 21075',
      'Phone: 410-863-9800',
      'Email: sales@procraftdc.com',
    ].forEach(line => {
      doc.text(line, infoX, infoY);
      infoY += 3.5;
    });

    // PO# / 日期 / 工作名（右上）
    const dateStr = date.toLocaleDateString('en-US', {
      month: 'long', day: 'numeric', year: 'numeric',
    });
    doc.setTextColor(...COLORS.muted);
    doc.setFontSize(7);
    doc.setFont('helvetica', 'normal');
    doc.text(`PO# ${poNumber || '—'}`, pageW - margin, 9, { align: 'right' });
    doc.text(dateStr, pageW - margin, 15, { align: 'right' });

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7);
    doc.setTextColor(40, 40, 40);
    doc.text(jobName || '—', pageW - margin, 21, { align: 'right' });
  }

  
  /**
   * 畫 BILL TO / SHIP TO 兩欄地址區塊
   *
   * @param {Object} doc - jsPDF 實例
   * @param {Object} context - { dealer, shippingAddress, startY }
   *   - dealer: { company_name, address_line1, address_line2, city, state, zip_code }
   *   - shippingAddress: 同 dealer 結構，或 null（null 時 ship-to 用 dealer 的地址）
   *   - startY: 開始畫的 Y 座標
   * @returns {number} 畫完之後的 Y 座標（含 separator line）
   */
  function _drawBillShipBlock(doc, context) {
    const { pageW, margin } = LAYOUT;
    const { dealer, shippingAddress, startY } = context;

    const billX = margin;
    const shipX = pageW - margin;
    let addrY = startY + 4;

    // 標題
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(...COLORS.muted);
    doc.text('BILL TO', billX, addrY);
    doc.text('SHIP TO', shipX, addrY, { align: 'right' });
    addrY += 5;

    // Bill 內容
    const billLines = [
      dealer?.company_name || '—',
      dealer?.address_line1 || '',
      dealer?.address_line2 || '',
      `${dealer?.city || ''}, ${dealer?.state || ''} ${dealer?.zip_code || ''}`,
    ].filter(l => l.trim());

    // Ship 內容（fallback 到 dealer 地址）
    const shipName = shippingAddress
      ? shippingAddress.recipient_name
      : dealer?.company_name;

    const shipLines = [
      shipName || '—',
      shippingAddress ? shippingAddress.address_line   : (dealer?.address_line1 || ''),
      shippingAddress ? (shippingAddress.address_line2 || '') : (dealer?.address_line2 || ''),
      shippingAddress
        ? `${shippingAddress.city}, ${shippingAddress.state} ${shippingAddress.zip_code}`
        : `${dealer?.city || ''}, ${dealer?.state || ''} ${dealer?.zip_code || ''}`,
    ].filter(l => l.trim());

    // 兩欄並排
    const maxLines = Math.max(billLines.length, shipLines.length);
    for (let i = 0; i < maxLines; i++) {
      doc.setFont('helvetica', i === 0 ? 'bold' : 'normal');
      doc.setFontSize(7.5);
      doc.setTextColor(40, 40, 40);
      if (billLines[i]) doc.text(billLines[i], billX, addrY);
      if (shipLines[i]) doc.text(shipLines[i], shipX, addrY, { align: 'right' });
      addrY += 4.5;
    }

    // Separator line
    addrY += 3;
    doc.setDrawColor(...COLORS.border);
    doc.setLineWidth(0.3);
    doc.line(margin, addrY, pageW - margin, addrY);
    addrY += 4;

    return addrY;
  }

  /**
   * 畫底部深綠色 footer bar
   * 注意：呼叫前應該先 doc.setPage() 到目標頁
   */
  function _drawFooterBar(doc) {
    const { pageW } = LAYOUT;
    doc.setFillColor(...COLORS.darkGreen);
    doc.rect(0, 287, pageW, 10, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(7);
    doc.setFont('helvetica', 'normal');
    doc.text(
      'ProCraft Cabinetry DC  ·  dc.procraftcabinetry.com',
      pageW / 2,
      293,
      { align: 'center' }
    );
  }

  /**
   * 在所有頁面加「Page X / Y」(右上角)
   * 應該在 PDF 內容全部畫完之後呼叫
   */
  function _addPageNumbers(doc) {
    const { pageW, margin } = LAYOUT;
    const totalPages = doc.getNumberOfPages();
    for (let p = 1; p <= totalPages; p++) {
      doc.setPage(p);
      doc.setFontSize(7);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(...COLORS.muted);
      doc.text(
        `Page ${p} / ${totalPages}`,
        pageW - margin,
        27,
        { align: 'right' }
      );
    }
    doc.setPage(totalPages);  // 留在最後一頁，方便繼續畫
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

    // Drawing blocks
    _drawHeader:        _drawHeader,
    _drawBillShipBlock: _drawBillShipBlock,
    _drawFooterBar:     _drawFooterBar,
    _addPageNumbers:    _addPageNumbers,

    // 後續步驟會繼續加：
  };

})(window);
