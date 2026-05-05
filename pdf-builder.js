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
  // Items 表格繪製
  // ----------------------------------------

  /**
   * 畫 items 表格（jsPDF AutoTable）
   *
   * @param {Object} doc - jsPDF 實例
   * @param {Object} context - {
   *     items, mode, startY, markupPercent, headerContext
   *   }
   *   - items: 已 normalize 的 items 陣列（含 style_name, sku_code, sku_desc, sku_type,
   *            assemble_status, quantity, unit_price, assemble_fee 等欄位）
   *   - mode: 'packing-list-current' | 'invoice-current' |
   *           'packing-list' | 'invoice' | 'draft-quote'
   *   - startY: 表格開始的 Y 座標
   *   - markupPercent: 0 ~ 1 的小數（不是百分比；例：15% = 0.15），預設 0
   *   - headerContext: 跨頁時要傳給 _drawHeader 的 context
   *                    （logoImg, poNumber, jobName, date）
   */
  function _drawItemTable(doc, context) {
    const { margin, headerH } = LAYOUT;
    const {
      items,
      mode,
      startY,
      markupPercent = 0,
      headerContext,
    } = context;

    // ── Mode 設定表 ──
    const showPrices = ['invoice-current', 'invoice', 'draft-quote'].includes(mode);
    const useNewPackingOrder = (mode === 'packing-list');
    const groupStyleHeader = ['packing-list', 'invoice', 'draft-quote'].includes(mode);

    // ── 群組 + 排序 ──
    const grouped = _groupAndSort(items);

    // ── 組 table head（依 mode 決定欄位）──
    let head;
    if (mode === 'packing-list-current') {
      // step3 Document A 現狀：7 欄、舊順序
      head = [['Item#', 'Door Style', 'Type', 'SKU', 'Description', 'Assemble Status', 'Qty']];
    } else if (mode === 'packing-list') {
      // 第 8 步啟用：7 欄、新順序（Item 4 規格）
      head = [['Item#', 'Door Style', 'SKU', 'Qty', 'Description', 'Type', 'Assemble Status']];
    } else {
      // invoice-current / invoice / draft-quote：10 欄、舊順序
      head = [['Item#', 'Door Style', 'Type', 'SKU', 'Description', 'Assemble Status',
               'Qty', 'Unit Price', 'Asm Fee', 'Total']];
    }

    // ── 組 table body ──
    const body = [];
    let itemNum = 0;
    let lastStyle = null;

    Object.entries(grouped).forEach(([styleName, styleItems]) => {
      styleItems.forEach(item => {
        itemNum++;

        // 群組標題：群組模式下，同 style 第一行才顯示 style name
        let styleCell;
        if (groupStyleHeader) {
          styleCell = (styleName !== lastStyle) ? styleName : '';
          lastStyle = styleName;
        } else {
          styleCell = styleName;
        }

        const skuType        = item.sku_type || item.skuType || '—';
        const skuDesc        = item.sku_desc || '';
        const assembleStatus = item.assemble_status || item.type || '—';
        const qty            = item.quantity;
        const markedPrice    = item.unit_price * (1 + markupPercent);
        const lineTotal      = markedPrice * qty;
        const asmFeeStr      = (item.assemble_fee > 0)
          ? `$${(item.assemble_fee * qty).toFixed(2)}`
          : '—';

        if (mode === 'packing-list-current') {
          body.push([
            `#${itemNum}`, styleCell, skuType, item.sku_code,
            skuDesc, assembleStatus, qty,
          ]);
        } else if (mode === 'packing-list') {
          body.push([
            `#${itemNum}`, styleCell, item.sku_code, qty,
            skuDesc, skuType, assembleStatus,
          ]);
        } else {
          // invoice-current / invoice / draft-quote
          body.push([
            `#${itemNum}`, styleCell, skuType, item.sku_code,
            skuDesc, assembleStatus, qty,
            `$${markedPrice.toFixed(2)}`, asmFeeStr,
            `$${lineTotal.toFixed(2)}`,
          ]);
        }
      });
    });

    // ── 欄寬設定（跟原本 step3.html 一致）──
    let columnStyles;
    if (mode === 'packing-list-current') {
      // step3 Document A 現狀
      columnStyles = {
        0: { cellWidth: 11 },
        1: { cellWidth: 40 },
        2: { cellWidth: 16 },
        3: { cellWidth: 24 },
        4: { cellWidth: 60, overflow: 'linebreak' },
        5: { cellWidth: 22 },
        6: { halign: 'right', cellWidth: 9 },
      };
    } else if (mode === 'packing-list') {
      // 第 8 步啟用：新順序欄寬（Item# / Style / SKU / Qty / Desc / Type / Asm Status）
      columnStyles = {
        0: { cellWidth: 11 },
        1: { cellWidth: 40 },
        2: { cellWidth: 24 },
        3: { halign: 'right', cellWidth: 12 },
        4: { cellWidth: 57, overflow: 'linebreak' },
        5: { cellWidth: 16 },
        6: { cellWidth: 22 },
      };
    } else {
      // invoice-current / invoice / draft-quote（10 欄）
      columnStyles = {
        0: { cellWidth: 9 },
        1: { cellWidth: 24 },
        2: { cellWidth: 11 },
        3: { cellWidth: 14 },
        4: { cellWidth: 35, overflow: 'linebreak' },
        5: { cellWidth: 18 },
        6: { halign: 'right', cellWidth: 8 },
        7: { halign: 'right', cellWidth: 17 },
        8: { halign: 'right', cellWidth: 15 },
        9: { halign: 'right', fontStyle: 'bold', cellWidth: 18 },
      };
    }

    // ── 跨頁時，每頁重畫 header ──
    const onDrawPage = (data) => {
      if (data.pageNumber > 1 && headerContext) {
        _drawHeader(doc, headerContext);
      }
    };

    // ── 呼叫 jsPDF AutoTable ──
    doc.autoTable({
      startY: startY,
      head: head,
      body: body,
      margin: { left: margin, right: margin, top: headerH + 4 },
      styles: {
        fontSize:  7,
        cellPadding: 2,
        textColor: [30, 30, 30],
        overflow:  'linebreak',
      },
      headStyles: {
        fillColor: COLORS.darkGreen,
        textColor: [255, 255, 255],
        fontStyle: 'bold',
        fontSize:  7,
      },
      columnStyles: columnStyles,
      alternateRowStyles: { fillColor: [250, 248, 244] },
      didDrawPage: onDrawPage,
    });

    // 回傳表格結束的 Y 座標（後面要接 totals 用）
    return doc.lastAutoTable.finalY;
  }
  
  
  // ----------------------------------------
  // Totals 區塊
  // ----------------------------------------

  /**
   * 畫右下角總計區塊（Subtotal / Assemble Fee / Shipping / Tax / Order Total）
   *
   * @param {Object} doc - jsPDF 實例
   * @param {Object} context - {
   *     totals, asmByType, taxExempt, freeShipping,
   *     showPrices, startY, items
   *   }
   *   - totals: { subtotal, assembleTotal, shipping, tax, grand } - 已計算好的數字
   *   - asmByType: _calcAsmByType() 的結果（可能為空 {}）
   *   - taxExempt: boolean，true 時 Tax 顯示 'Exempt'
   *   - freeShipping: boolean，true 時 Shipping 顯示 'FREE'
   *   - showPrices: boolean，false 時所有金額顯示 '—'（Packing List 用）
   *   - startY: 開始畫的 Y 座標
   *   - items: 給 _calcAsmByType 用，如果 asmByType 沒提供就自己算
   * @returns {number} 畫完之後的 Y 座標
   */
  function _drawTotals(doc, context) {
    const { pageW, margin } = LAYOUT;
    const {
      totals,
      asmByType,
      taxExempt = false,
      freeShipping = false,
      showPrices = true,
      startY,
      items,
    } = context;

    // 如果沒給 asmByType 就自己算
    const byType = asmByType || (items ? _calcAsmByType(items) : {});

    const totalsX = pageW - margin - 70;
    const valX    = pageW - margin;
    let y = startY;

    // ── Subtotal ──
    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...COLORS.muted);
    doc.text('Subtotal', totalsX, y);
    doc.setTextColor(40, 40, 40);
    doc.text(
      showPrices ? `$${totals.subtotal.toFixed(2)}` : '—',
      valX, y, { align: 'right' }
    );
    y += 6;

    // ── Assemble Fee + breakdown ──
    if (totals.assembleTotal > 0) {
      doc.setFontSize(8);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(...COLORS.muted);
      doc.text('Assemble Fee', totalsX, y);
      if (showPrices) {
        doc.setTextColor(40, 40, 40);
        doc.text(`+$${totals.assembleTotal.toFixed(2)}`, valX, y, { align: 'right' });
      }
      y += 5;

      // Breakdown by type
      TYPE_ORDER.filter(t => byType[t]).forEach(t => {
        const row = byType[t];
        doc.setFontSize(6.5);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(...COLORS.muted);
        doc.text(`  ${t} ×${row.qty}`, totalsX, y);
        if (showPrices) {
          doc.setTextColor(140, 100, 20);  // 金棕色
          doc.text(`+$${row.total.toFixed(2)}`, valX, y, { align: 'right' });
        }
        y += 4;
      });
      y += 2;
    }

    // ── Shipping ──
    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...COLORS.muted);
    doc.text('Shipping', totalsX, y);
    doc.setTextColor(40, 40, 40);
    let shippingStr;
    if (!showPrices) shippingStr = '—';
    else if (freeShipping) shippingStr = 'FREE';
    else shippingStr = `$${totals.shipping.toFixed(2)}`;
    doc.text(shippingStr, valX, y, { align: 'right' });
    y += 6;

    // ── Tax ──
    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...COLORS.muted);
    doc.text('Tax', totalsX, y);
    doc.setTextColor(40, 40, 40);
    let taxStr;
    if (!showPrices) taxStr = '—';
    else if (taxExempt) taxStr = 'Exempt';
    else taxStr = `$${totals.tax.toFixed(2)}`;
    doc.text(taxStr, valX, y, { align: 'right' });
    y += 6;

    // ── Separator line ──
    doc.setDrawColor(...COLORS.border);
    doc.line(totalsX, y, valX, y);
    y += 5;

    // ── Order Total ──
    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...COLORS.darkGreen);
    doc.text('Order Total', totalsX, y);
    doc.text(
      showPrices ? `$${totals.grand.toFixed(2)}` : '—',
      valX, y, { align: 'right' }
    );

    return y;
  }


  // ----------------------------------------
  // Terms & Conditions
  // ----------------------------------------

  /**
   * T&C 條文（共用內容；如未來 PO 想改，改這個常數即可）
   */
  const TERMS_AND_CONDITIONS = [
    'Upon signing, customers accept responsibility for checking the quality of the products when picked up or delivered. Item damaged or missing must be reported within 24 hours of receiving listed items.',
    '25% restocking fee will be applied for returned or exchanged Flat-Pack items.',
    'There is NO return or exchange for any items assembled, painted, special ordered or final sale items.',
    'Returns must be made within 30 days of the date of purchase.',
    'Returns will be credited only upon warehouse inspection.',
    'After scheduled pickup date, a $30.00 storage fee will be applied per day.',
    'Change delivery date must 2 days before the initial delivery date.',
  ];

  /**
   * 畫左下角 Terms & Conditions 區塊
   *
   * @param {Object} doc - jsPDF 實例
   * @param {Object} context - { startY, maxWidth }
   *   - startY: 開始畫的 Y 座標
   *   - maxWidth: 文字寬度上限（預設 90mm，給左下角用）
   * @returns {number} 畫完之後的 Y 座標
   */
  function _drawTermsAndConditions(doc, context) {
    const { margin } = LAYOUT;
    const { startY, maxWidth = 90 } = context;
    const x = margin;
    let y = startY;

    // 標題
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6.5);
    doc.setTextColor(...COLORS.darkGreen);
    doc.text('Terms & Conditions', x, y);
    y += 5;

    // 條文
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6);
    doc.setTextColor(60, 60, 60);
    TERMS_AND_CONDITIONS.forEach((item, i) => {
      const lines = doc.splitTextToSize(`${i + 1}. ${item}`, maxWidth);
      doc.text(lines, x, y);
      y += lines.length * 4 + 1.5;
    });

    return y;
  }

  
  // ============================================================
  // 對外主函式
  // ============================================================
  // 這 4 個函式是 pdf-builder.js 的對外 API，由 HTML 直接呼叫。
  // 所有函式都接收一個統一格式的 quoteData 物件，呼叫端負責準備。
  //
  // quoteData 格式：
  // {
  //   po_number, job_name, status, revision_number, created_at,
  //   logistic_type, delivery_fee,
  //   subtotal, assemble_total, shipping_cost, tax_amount, grand_total,
  //   items: [
  //     { style_name, style_code, sku_code, sku_desc, sku_type,
  //       assemble_status, quantity, unit_price, msrp, assemble_fee }
  //   ]
  // }
  //
  // dealer 格式：dealers table row（含 company_name, address_line1...）
  // shippingAddress 格式：addresses table row 或 null
  // options:
  //   - markupPercent: 0~1 小數（只有 buildInvoicePdf / buildDraftQuotePdf 會用）
  //   - logoUrl: logo 圖片網址（預設用 ProCraft 公司 logo）
  // ============================================================

  const DEFAULT_LOGO_URL =
    'https://acwgemgpnusworpxxoai.supabase.co/storage/v1/object/public/assets/ProCraft-DC-Logo.png';

  /**
   * 內部用：建立 jsPDF 實例 + 載入 logo + 畫 header + Bill/Ship
   * 三個對外函式的共同前置動作
   *
   * @returns {Promise<{ doc, logoImg, y }>}
   */
  async function _initDocAndDrawTop(quoteData, dealer, shippingAddress, options) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

    // 載 logo（失敗時 logoImg 為 null，header 會 fallback 到文字）
    let logoImg = null;
    try {
      logoImg = await _loadImage(options.logoUrl || DEFAULT_LOGO_URL);
    } catch (e) {
      // logo 載入失敗，繼續（header 會 fallback）
    }

    // 決定日期：用 quoteData.created_at（若有），否則用今天
    const date = quoteData.created_at
      ? new Date(quoteData.created_at)
      : new Date();

    // 第 1 頁 header
    const headerContext = {
      logoImg,
      poNumber: quoteData.po_number || '—',
      jobName:  quoteData.job_name  || '—',
      date,
    };
    _drawHeader(doc, headerContext);

    // Bill / Ship
    let y = LAYOUT.headerH + 10;
    y = _drawBillShipBlock(doc, {
      dealer,
      shippingAddress,
      startY: y - 4,  // 補回 _drawBillShipBlock 內部的 +4 偏移
    });

    return { doc, logoImg, y, headerContext };
  }

  /**
   * 內部用：畫完 items table 後，處理 totals + T&C + footer + 頁碼
   *
   * @param {Object} args - { doc, quoteData, items, headerContext, tableEndY,
   *                          showPrices, markupPercent }
   */
  function _finalizeWithTotals(args) {
    const {
      doc, quoteData, items, headerContext, tableEndY,
      showPrices, markupPercent = 0,
    } = args;
    const { pageW, margin } = LAYOUT;

    // 計算 totals（依 markupPercent 套用）
    const markedSubtotal = items.reduce(
      (s, i) => s + i.unit_price * (1 + markupPercent) * i.quantity, 0
    );
    const assembleTotal = items.reduce(
      (s, i) => s + (i.assemble_fee || 0) * i.quantity, 0
    );

    // shipping 邏輯（跟 step3.html 一致）
    const logisticType = quoteData.logistic_type || 'pickup';
    const deliveryFee = parseFloat(quoteData.delivery_fee || 0);
    let shipping = 0;
    if (logisticType === 'delivery') {
      shipping = deliveryFee;
    } else if (logisticType === 'shipping') {
      if      (markedSubtotal <= 6000)  shipping = markedSubtotal * 0.15;
      else if (markedSubtotal <= 9000)  shipping = markedSubtotal * 0.12;
      else if (markedSubtotal <= 12000) shipping = markedSubtotal * 0.10;
    }

    // 注意：tax 用 quoteData 預先算好的（snapshot），或自己重算
    // 為了 markup 場景下計算一致，這裡用 markedSubtotal × taxRate
    const taxRate = quoteData._taxRate || 0;  // 由呼叫端塞進來
    const taxExempt = !!quoteData._taxExempt;
    const tax = taxExempt ? 0 : markedSubtotal * taxRate;
    const grand = markedSubtotal + assembleTotal + shipping + tax;

    const totals = {
      subtotal:      markedSubtotal,
      assembleTotal: assembleTotal,
      shipping:      shipping,
      tax:           tax,
      grand:         grand,
    };
    const asmByType = _calcAsmByType(items);

    // ── 預估空間，不夠就換頁 ──
    let y = tableEndY + 8;
    const TC_BLOCK_H = 7 * 6 + 16;
    const TOTALS_H   = assembleTotal > 0 ? 60 : 45;
    const NEEDED     = Math.max(TC_BLOCK_H, TOTALS_H) + 20;
    if (y + NEEDED > 275) {
      doc.addPage();
      _drawHeader(doc, headerContext);
      y = LAYOUT.headerH + 8;
    }

    // 分隔線
    doc.setDrawColor(...COLORS.border);
    doc.setLineWidth(0.3);
    doc.line(margin, y, pageW - margin, y);
    y += 6;

    // T&C（左側）
    _drawTermsAndConditions(doc, { startY: y });

    // Totals（右側，跟 T&C 同 y 起點）
    const freeShipping = shipping === 0 && markedSubtotal > 0;
    _drawTotals(doc, {
      totals, asmByType, taxExempt, freeShipping,
      showPrices, startY: y, items,
    });

    // Footer + 頁碼
    _drawFooterBar(doc);
    _addPageNumbers(doc);
  }

  /**
   * 建立 Packing List PDF（無價，給工廠用）
   *
   * @param {Object} quoteData
   * @param {Object} dealer
   * @param {Object|null} shippingAddress
   * @param {Object} options - { markupPercent (ignored), logoUrl }
   * @returns {Promise<jsPDF>}
   */
  async function buildPackingListPdf(quoteData, dealer, shippingAddress, options = {}) {
    const { doc, y, headerContext } = await _initDocAndDrawTop(
      quoteData, dealer, shippingAddress, options
    );

    // 畫 items 表格（current mode：7 欄、舊順序、不群組）
    const tableEndY = _drawItemTable(doc, {
      items:         quoteData.items,
      mode:          'packing-list-current',
      startY:        y,
      markupPercent: 0,
      headerContext: headerContext,
    });

    // Packing List 不含 totals / T&C（current 行為）
    // 但是 footer + 頁碼還是要
    _drawFooterBar(doc);
    _addPageNumbers(doc);

    return doc;
  }

  /**
   * 建立 Invoice PDF（含價，給 dealer / 客戶用）
   */
  async function buildInvoicePdf(quoteData, dealer, shippingAddress, options = {}) {
    const { markupPercent = 0 } = options;
    const { doc, y, headerContext } = await _initDocAndDrawTop(
      quoteData, dealer, shippingAddress, options
    );

    const tableEndY = _drawItemTable(doc, {
      items:         quoteData.items,
      mode:          'invoice-current',
      startY:        y,
      markupPercent: markupPercent,
      headerContext: headerContext,
    });

    _finalizeWithTotals({
      doc, quoteData, items: quoteData.items,
      headerContext, tableEndY,
      showPrices: true, markupPercent,
    });

    return doc;
  }

  /**
   * 建立 Draft Quote PDF（Step 3 預覽用、Quote Detail Draft 下載用）
   * 目前跟 Invoice 一樣，第 8 步會加上 DRAFT QUOTE 大標題
   */
  async function buildDraftQuotePdf(quoteData, dealer, shippingAddress, options = {}) {
    const { markupPercent = 0 } = options;
    const { doc, y, headerContext } = await _initDocAndDrawTop(
      quoteData, dealer, shippingAddress, options
    );

    const tableEndY = _drawItemTable(doc, {
      items:         quoteData.items,
      mode:          'invoice-current',  // 目前用 invoice-current；第 8 步改 draft-quote
      startY:        y,
      markupPercent: markupPercent,
      headerContext: headerContext,
    });

    _finalizeWithTotals({
      doc, quoteData, items: quoteData.items,
      headerContext, tableEndY,
      showPrices: true, markupPercent,
    });

    return doc;
  }

  // ============================================================
  // Filename 工具
  // ============================================================

  /**
   * 取得紐約時間的 YYYYMMDD 字串
   */
  function _getNYDateString() {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York',
      year:  'numeric',
      month: '2-digit',
      day:   '2-digit',
    });
    return fmt.format(new Date()).replace(/-/g, '');
  }

  /**
   * 統一管理 PDF filename 生成
   *
   * @param {string} type - 'packing-list' | 'invoice' | 'draft-quote'
   * @param {Object} options - { poNumber, dealerUid, revisionNumber }
   * @returns {string} filename
   *
   * 注意：目前回傳「current」行為的檔名（兼容現有寄信流程）。
   *      第 8 步會切換到新規則。
   */
  function getPdfFilename(type, options = {}) {
    const { poNumber, dealerUid, revisionNumber = 1 } = options;

    // === Current 行為（refactor 階段不改檔名）===
    if (type === 'packing-list') {
      return `${poNumber || 'Quote'}_List.pdf`;
    }
    if (type === 'invoice') {
      return `${poNumber || 'Quote'}_Details.pdf`;
    }
    if (type === 'draft-quote') {
      return `${poNumber || 'Draft'}_Details.pdf`;
    }

    // === 第 8 步啟用後的新規則（先寫好，目前不會走到）===
    // const versionSuffix = revisionNumber > 1 ? ` - v${revisionNumber}` : '';
    // if (type === 'packing-list') return `ProCraft DC - Packing List - ${poNumber}${versionSuffix}.pdf`;
    // if (type === 'invoice')      return `ProCraft DC - Invoice - ${poNumber}${versionSuffix}.pdf`;
    // if (type === 'draft-quote')  return `ProCraft DC - Draft Quote - ${dealerUid} - ${_getNYDateString()}.pdf`;

    return 'quote.pdf';
  }




  
  // ----------------------------------------
  // 對外暴露
  // ----------------------------------------
  global.ProCraftPDF = {
      // ─── 常數（debug 用）───
      _TYPE_ORDER: TYPE_ORDER,
      _COLORS:     COLORS,
      _LAYOUT:     LAYOUT,
  
      // ─── Internal Helpers（debug 用，畫底線開頭代表 internal）───
      _typeRank:      _typeRank,
      _groupAndSort:  _groupAndSort,
      _calcAsmByType: _calcAsmByType,
      _loadImage:     _loadImage,
  
      // ─── Internal Drawing Blocks（debug 用）───
      _drawHeader:             _drawHeader,
      _drawBillShipBlock:      _drawBillShipBlock,
      _drawFooterBar:          _drawFooterBar,
      _addPageNumbers:         _addPageNumbers,
      _drawItemTable:          _drawItemTable,
      _drawTotals:             _drawTotals,
      _drawTermsAndConditions: _drawTermsAndConditions,
  
      // ─── 對外主函式（HTML 用這些）───
      buildPackingListPdf: buildPackingListPdf,
      buildInvoicePdf:     buildInvoicePdf,
      buildDraftQuotePdf:  buildDraftQuotePdf,
      getPdfFilename:      getPdfFilename,
    };

})(window);
