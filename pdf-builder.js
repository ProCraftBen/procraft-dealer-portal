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
    pending:   [224, 123, 57],   // C1: orange for pending shipping (matches UI #E07B39)
  };

  // PDF 版面常數
  const LAYOUT = {
    pageW:    210,   // A4 寬度（mm）
    pageH:    297,   // A4 高度（mm）
    margin:   14,
    headerH:  36,    // header 區塊高度（為了大標題加高 4mm）
  };

  // ----------------------------------------
  // Internal Helpers
  // ----------------------------------------

  /**
   * 把 type 字串轉成排序用的數字（BASE=0、WALL=1、TALL=2...）
   */
  function _typeRank(type) {
    const idx = TYPE_ORDER.indexOf((type || '').toUpperCase());
    return idx === -1 ? 99 : idx;
  }

  /**
   * 把 items 依 style 群組、組內依 type 排序
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
   */
  function _calcAsmByType(items) {
    const byType = {};
    items.forEach(item => {
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
   * 載入圖片並轉成 base64 dataURL
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

  // ─────────────────────────────────────────────────────────────────────────
  // C1: Pending shipping detection
  //
  // A quote has "pending shipping" when:
  //   - logistic_type === 'shipping' AND
  //   - shipping_cost is NULL/undefined (not yet confirmed by Sales)
  //
  // Caller may also explicitly pass quoteData._isPendingShipping = true
  // (Step 3 sets this when the upcoming write would put NULL into DB).
  // ─────────────────────────────────────────────────────────────────────────
  function _isPendingShipping(quoteData) {
    if (!quoteData) return false;
    if (quoteData._isPendingShipping === true) return true;
    if (quoteData.logistic_type !== 'shipping') return false;
    return (quoteData.shipping_cost === null || quoteData.shipping_cost === undefined);
  }

  // ----------------------------------------
  // PDF 區塊繪製函式
  // ----------------------------------------

  /**
   * 畫 PDF 頂部 header（每一頁都會用，包含跨頁時）
   * Item 5: 加上文件類型大標題（PACKING LIST / INVOICE / DRAFT QUOTE）
   *
   * @param {Object} doc - jsPDF 實例
   * @param {Object} context - { logoImg, poNumber, jobName, date, documentTitle }
   *   - documentTitle: 'PACKING LIST' | 'INVOICE' | 'DRAFT QUOTE' | null
   */
  function _drawHeader(doc, context) {
    const { pageW, margin, headerH } = LAYOUT;
    const { logoImg, poNumber, jobName, date, documentTitle } = context;

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

    // ── Item 5: 文件類型大標題（右上方，PO# 上面）──
    if (documentTitle) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(16);
      doc.setTextColor(...COLORS.darkGreen);
      doc.text(documentTitle, pageW - margin, 9, { align: 'right' });
    }

    // PO# / 日期 / 工作名（右上，往下挪）
    const dateStr = date.toLocaleDateString('en-US', {
      month: 'long', day: 'numeric', year: 'numeric',
    });
    doc.setTextColor(...COLORS.muted);
    doc.setFontSize(7);
    doc.setFont('helvetica', 'normal');
    doc.text(`PO# ${poNumber || '—'}`, pageW - margin, 16, { align: 'right' });
    doc.text(dateStr, pageW - margin, 22, { align: 'right' });

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7);
    doc.setTextColor(40, 40, 40);
    doc.text(jobName || '—', pageW - margin, 28, { align: 'right' });
  }

  /**
   * 畫 BILL TO / SHIP TO 兩欄地址區塊
   */
  function _drawBillShipBlock(doc, context) {
    const { pageW, margin } = LAYOUT;
    const { dealer, shippingAddress, startY } = context;

    const billX = margin;
    const shipX = pageW - margin;
    let addrY = startY + 4;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(...COLORS.muted);
    doc.text('BILL TO', billX, addrY);
    doc.text('SHIP TO', shipX, addrY, { align: 'right' });
    addrY += 5;

    const billLines = [
      dealer?.company_name || '—',
      dealer?.address_line1 || '',
      dealer?.address_line2 || '',
      `${dealer?.city || ''}, ${dealer?.state || ''} ${dealer?.zip_code || ''}`,
    ].filter(l => l.trim());

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

    const maxLines = Math.max(billLines.length, shipLines.length);
    for (let i = 0; i < maxLines; i++) {
      doc.setFont('helvetica', i === 0 ? 'bold' : 'normal');
      doc.setFontSize(7.5);
      doc.setTextColor(40, 40, 40);
      if (billLines[i]) doc.text(billLines[i], billX, addrY);
      if (shipLines[i]) doc.text(shipLines[i], shipX, addrY, { align: 'right' });
      addrY += 4.5;
    }

    addrY += 3;
    doc.setDrawColor(...COLORS.border);
    doc.setLineWidth(0.3);
    doc.line(margin, addrY, pageW - margin, addrY);
    addrY += 4;

    return addrY;
  }

  /**
   * 畫底部深綠色 footer bar
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
        32,
        { align: 'right' }
      );
    }
    doc.setPage(totalPages);
  }

  // ----------------------------------------
  // Items 表格繪製
  // ----------------------------------------

  /**
   * 畫 items 表格（jsPDF AutoTable）
   *
   * mode 對應：
   *   'packing-list' = Item 4 新欄位順序（7 欄、Style → SKU → Qty → Desc → Type → AsmStatus）
   *   'invoice'      = 10 欄、舊順序（含價）
   *   'draft-quote'  = 10 欄、舊順序（含價）
   *
   * Item 3：所有 mode 都套用「同 style 第一行才顯示 style 名稱」
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

    const grouped = _groupAndSort(items);

    // ── 組 table head（依 mode 決定欄位）──
    let head;
    if (mode === 'packing-list') {
      // Item 4: Packing List 新欄位順序
      head = [['Item#', 'Door Style', 'SKU', 'Qty', 'Description', 'Type', 'Assemble Status']];
    } else {
      // invoice / draft-quote：10 欄、舊順序
      head = [['Item#', 'Door Style', 'Type', 'SKU', 'Description', 'Assemble Status',
               'Qty', 'Unit Price', 'Asm Fee', 'Total']];
    }

    // ── 組 table body ──
    // Item 3：同 style 第一行才顯示 style name
    const body = [];
    let itemNum = 0;
    let lastStyle = null;

    Object.entries(grouped).forEach(([styleName, styleItems]) => {
      styleItems.forEach(item => {
        itemNum++;

        // Item 3: 群組標題只顯示一次
        const styleCell = (styleName !== lastStyle) ? styleName : '';
        lastStyle = styleName;

        const skuType        = item.sku_type || item.skuType || '—';
        const skuDesc        = item.sku_desc || '';
        const assembleStatus = item.assemble_status || item.type || '—';
        const qty            = item.quantity;
        const markedPrice    = item.unit_price * (1 + markupPercent);
        const lineTotal      = markedPrice * qty;
        const asmFeeStr      = (item.assemble_fee > 0)
          ? `$${(item.assemble_fee * qty).toFixed(2)}`
          : '—';

        if (mode === 'packing-list') {
          body.push([
            `#${itemNum}`, styleCell, item.sku_code, qty,
            skuDesc, skuType, assembleStatus,
          ]);
        } else {
          // invoice / draft-quote
          body.push([
            `#${itemNum}`, styleCell, skuType, item.sku_code,
            skuDesc, assembleStatus, qty,
            `$${markedPrice.toFixed(2)}`, asmFeeStr,
            `$${lineTotal.toFixed(2)}`,
          ]);
        }
      });
    });

    // ── 欄寬設定 ──
    let columnStyles;
    if (mode === 'packing-list') {
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

    const onDrawPage = (data) => {
      if (data.pageNumber > 1 && headerContext) {
        _drawHeader(doc, headerContext);
      }
    };

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

    return doc.lastAutoTable.finalY;
  }

  // ----------------------------------------
  // Totals 區塊
  // ----------------------------------------

  /**
   * 畫 Totals 區塊（右下角）
   *
   * C1 changes:
   *   - context.pendingShipping (boolean) — 若 true，Shipping 行顯示
   *     "Contact Sales Team" (橘色) 而非數字；grand total 已由 caller
   *     計算為「不含 shipping」。
   *   - 在 Order Total 下方多印一行 footnote 提示。
   */
  function _drawTotals(doc, context) {
    const { pageW, margin } = LAYOUT;
    const {
      totals,
      asmByType,
      taxExempt = false,
      freeShipping = false,
      pendingShipping = false,    // C1
      showPrices = true,
      startY,
      items,
    } = context;

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

    // ── Assemble Fee ──
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

      TYPE_ORDER.filter(t => byType[t]).forEach(t => {
        const row = byType[t];
        doc.setFontSize(6.5);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(...COLORS.muted);
        doc.text(`  ${t} ×${row.qty}`, totalsX, y);
        if (showPrices) {
          doc.setTextColor(140, 100, 20);
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

    if (!showPrices) {
      doc.setTextColor(40, 40, 40);
      doc.text('—', valX, y, { align: 'right' });
    } else if (pendingShipping) {
      // C1: pending → orange "Contact Sales Team"
      doc.setTextColor(...COLORS.pending);
      doc.setFont('helvetica', 'bold');
      doc.text('Contact Sales Team', valX, y, { align: 'right' });
      doc.setFont('helvetica', 'normal');
    } else if (freeShipping) {
      doc.setTextColor(40, 40, 40);
      doc.text('FREE', valX, y, { align: 'right' });
    } else {
      doc.setTextColor(40, 40, 40);
      doc.text(`$${totals.shipping.toFixed(2)}`, valX, y, { align: 'right' });
    }
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
    y += 5;

    // ── C1: pending-shipping footnote ──
    if (showPrices && pendingShipping) {
      doc.setFont('helvetica', 'italic');
      doc.setFontSize(6.5);
      doc.setTextColor(...COLORS.pending);
      doc.text(
        '* Shipping fee pending — final total will be confirmed by Sales',
        valX, y, { align: 'right' }
      );
      y += 4;
    }

    return y;
  }

  // ----------------------------------------
  // Terms & Conditions
  // ----------------------------------------

  const TERMS_AND_CONDITIONS = [
    'Upon signing, customers accept responsibility for checking the quality of the products when picked up or delivered. Item damaged or missing must be reported within 24 hours of receiving listed items.',
    '25% restocking fee will be applied for returned or exchanged Flat-Pack items.',
    'There is NO return or exchange for any items assembled, painted, special ordered or final sale items.',
    'Returns must be made within 30 days of the date of purchase.',
    'Returns will be credited only upon warehouse inspection.',
    'After scheduled pickup date, a $30.00 storage fee will be applied per day.',
    'Change delivery date must 2 days before the initial delivery date.',
  ];

  function _drawTermsAndConditions(doc, context) {
    const { margin } = LAYOUT;
    const { startY, maxWidth = 90 } = context;
    const x = margin;
    let y = startY;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6.5);
    doc.setTextColor(...COLORS.darkGreen);
    doc.text('Terms & Conditions', x, y);
    y += 5;

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

  const DEFAULT_LOGO_URL =
    'https://acwgemgpnusworpxxoai.supabase.co/storage/v1/object/public/assets/ProCraft-DC-Logo.png';

  /**
   * 建立 jsPDF 實例 + 載入 logo + 畫 header + Bill/Ship
   */
  async function _initDocAndDrawTop(quoteData, dealer, shippingAddress, options, documentTitle) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

    let logoImg = null;
    try {
      logoImg = await _loadImage(options.logoUrl || DEFAULT_LOGO_URL);
    } catch (e) {
      // logo 載入失敗，header 會 fallback 到文字
    }

    const date = quoteData.created_at
      ? new Date(quoteData.created_at)
      : new Date();

    const headerContext = {
      logoImg,
      poNumber:      quoteData.po_number || '—',
      jobName:       quoteData.job_name  || '—',
      date,
      documentTitle: documentTitle,    // Item 5
    };
    _drawHeader(doc, headerContext);

    // Bill / Ship
    let y = LAYOUT.headerH + 10;
    y = _drawBillShipBlock(doc, {
      dealer,
      shippingAddress,
      startY: y - 4,
    });

    return { doc, logoImg, y, headerContext };
  }

  /**
   * 內部用：畫完 items table 後，處理 totals + T&C + footer + 頁碼
   *
   * C1: shipping resolution priority:
   *   1) pending shipping (logistic=shipping && shipping_cost==null) → "Contact Sales Team",
   *      grand total excludes shipping
   *   2) explicit quoteData.shipping_cost (admin-set) → use as-is, no formula
   *   3) fallback formula on marked subtotal (legacy / preview path)
   */
  function _finalizeWithTotals(args) {
    const {
      doc, quoteData, items, headerContext, tableEndY,
      showPrices, markupPercent = 0,
    } = args;
    const { pageW, margin } = LAYOUT;

    const markedSubtotal = items.reduce(
      (s, i) => s + i.unit_price * (1 + markupPercent) * i.quantity, 0
    );
    const assembleTotal = items.reduce(
      (s, i) => s + (i.assemble_fee || 0) * i.quantity, 0
    );

    const logisticType    = quoteData.logistic_type || 'pickup';
    const deliveryFee     = parseFloat(quoteData.delivery_fee || 0);
    const pendingShipping = _isPendingShipping(quoteData);

    // ── C1: shipping resolution ──
    let shipping;
    if (pendingShipping) {
      shipping = 0;  // not added to grand total
    } else if (quoteData.shipping_cost !== null && quoteData.shipping_cost !== undefined) {
      // Use admin-confirmed / DB-stored value as-is (also covers pickup=0, delivery, computed shipping)
      shipping = parseFloat(quoteData.shipping_cost) || 0;
    } else {
      // No shipping_cost provided (legacy preview path) — fall back to formula
      shipping = 0;
      if (logisticType === 'delivery') {
        shipping = deliveryFee;
      } else if (logisticType === 'shipping') {
        if      (markedSubtotal <= 3000)  shipping = 0;  // would be NULL in new flow
        else if (markedSubtotal <= 6000)  shipping = markedSubtotal * 0.15;
        else if (markedSubtotal <= 9000)  shipping = markedSubtotal * 0.12;
        else if (markedSubtotal <= 12000) shipping = markedSubtotal * 0.10;
        else                              shipping = 0;
      }
    }

    const taxRate   = quoteData._taxRate || 0;
    const taxExempt = !!quoteData._taxExempt;
    const tax       = taxExempt ? 0 : markedSubtotal * taxRate;
    // C1: pending → exclude shipping from grand total
    const grand     = markedSubtotal + assembleTotal + (pendingShipping ? 0 : shipping) + tax;

    const totals = {
      subtotal:      markedSubtotal,
      assembleTotal: assembleTotal,
      shipping:      shipping,
      tax:           tax,
      grand:         grand,
    };
    const asmByType = _calcAsmByType(items);

    let y = tableEndY + 8;
    const TC_BLOCK_H = 7 * 6 + 16;
    const TOTALS_H   = assembleTotal > 0 ? 60 : 45;
    const NEEDED     = Math.max(TC_BLOCK_H, TOTALS_H) + 20;
    if (y + NEEDED > 275) {
      doc.addPage();
      _drawHeader(doc, headerContext);
      y = LAYOUT.headerH + 8;
    }

    doc.setDrawColor(...COLORS.border);
    doc.setLineWidth(0.3);
    doc.line(margin, y, pageW - margin, y);
    y += 6;

    // T&C（左側）
    _drawTermsAndConditions(doc, { startY: y });

    // Totals（右側）
    // C1: freeShipping only when explicitly $0 and not pending
    const freeShipping = !pendingShipping && shipping === 0 && markedSubtotal > 0;
    _drawTotals(doc, {
      totals, asmByType, taxExempt, freeShipping,
      pendingShipping,                  // C1
      showPrices, startY: y, items,
    });

    _drawFooterBar(doc);
    _addPageNumbers(doc);
  }

  /**
   * Item 6 (選項 C)：Packing List 加 T&C，但不加 Totals
   * 給 buildPackingListPdf 用
   */
  function _finalizePackingListWithTcOnly(args) {
    const { doc, headerContext, tableEndY } = args;
    const { pageW, margin } = LAYOUT;

    let y = tableEndY + 8;
    const TC_BLOCK_H = 7 * 6 + 16;
    const NEEDED     = TC_BLOCK_H + 20;

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

    // 只畫 T&C，左半邊（用比較寬的 maxWidth 因為右邊沒東西）
    _drawTermsAndConditions(doc, { startY: y, maxWidth: 180 });

    _drawFooterBar(doc);
    _addPageNumbers(doc);
  }

  /**
   * 建立 Packing List PDF（無價，給工廠用）
   * Items 4, 5, 6 已套用
   */
  async function buildPackingListPdf(quoteData, dealer, shippingAddress, options = {}) {
    const { doc, y, headerContext } = await _initDocAndDrawTop(
      quoteData, dealer, shippingAddress, options,
      'PACKING LIST'  // Item 5
    );

    const tableEndY = _drawItemTable(doc, {
      items:         quoteData.items,
      mode:          'packing-list',  // Item 4: 新欄位順序
      startY:        y,
      markupPercent: 0,
      headerContext: headerContext,
    });

    // Item 6 (選項 C)：加 T&C，不加 Totals
    _finalizePackingListWithTcOnly({ doc, headerContext, tableEndY });

    return doc;
  }

  /**
   * 建立 Invoice PDF（含價，給 dealer / 客戶用）
   */
  async function buildInvoicePdf(quoteData, dealer, shippingAddress, options = {}) {
    const { markupPercent = 0 } = options;
    const { doc, y, headerContext } = await _initDocAndDrawTop(
      quoteData, dealer, shippingAddress, options,
      'INVOICE'  // Item 5
    );

    const tableEndY = _drawItemTable(doc, {
      items:         quoteData.items,
      mode:          'invoice',  // 10 欄含價，啟用群組標題
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
   * 建立 Draft Quote PDF（Step 3 預覽用）
   */
  async function buildDraftQuotePdf(quoteData, dealer, shippingAddress, options = {}) {
    const { markupPercent = 0 } = options;
    const { doc, y, headerContext } = await _initDocAndDrawTop(
      quoteData, dealer, shippingAddress, options,
      'DRAFT QUOTE'  // Item 5
    );

    const tableEndY = _drawItemTable(doc, {
      items:         quoteData.items,
      mode:          'draft-quote',
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
   * 統一管理 PDF filename 生成（Items 1, 2 已套用新規則）
   *
   * @param {string} type - 'packing-list' | 'invoice' | 'draft-quote'
   * @param {Object} options - { poNumber, dealerUid, revisionNumber }
   *
   * 規則：
   *   - Packing List: ProCraft DC - Packing List - {PO#}{ - vN}.pdf
   *   - Invoice:      ProCraft DC - Invoice - {PO#}{ - vN}.pdf
   *   - Draft Quote:  ProCraft DC - Draft Quote - {dealerUid} - {YYYYMMDD}.pdf
   *   - v=1 不加後綴，v≥2 加 ` - v{N}`
   */
  function getPdfFilename(type, options = {}) {
    const { poNumber, dealerUid, revisionNumber = 1 } = options;
    const versionSuffix = revisionNumber > 1 ? ` - v${revisionNumber}` : '';

    if (type === 'packing-list') {
      // Item 2
      return `ProCraft DC - Packing List - ${poNumber || 'Quote'}${versionSuffix}.pdf`;
    }
    if (type === 'invoice') {
      // Item 2
      return `ProCraft DC - Invoice - ${poNumber || 'Quote'}${versionSuffix}.pdf`;
    }
    if (type === 'draft-quote') {
      // Item 1
      return `ProCraft DC - Draft Quote - ${dealerUid || 'Dealer'} - ${_getNYDateString()}.pdf`;
    }

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

    // ─── Internal Helpers ───
    _typeRank:          _typeRank,
    _groupAndSort:      _groupAndSort,
    _calcAsmByType:     _calcAsmByType,
    _loadImage:         _loadImage,
    _isPendingShipping: _isPendingShipping,   // C1

    // ─── Internal Drawing Blocks ───
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
