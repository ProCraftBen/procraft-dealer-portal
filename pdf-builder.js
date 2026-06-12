// ============================================================
// ProCraft Dealer Portal - Shared PDF Builder
// ============================================================
// 所有 PDF 生成邏輯集中在這個檔案。
// 使用方式（在 HTML 裡）：
//   <script src="pdf-builder.js"></script>
// 然後就可以呼叫 ProCraftPDF.buildPackingListPdf(...) 等函式。
// ============================================================
//
// F4.2 changes (2026-05-11):
//   • sub_groups support — items are expanded to N rows per sub-group,
//     using sub.qty (not item.quantity) for each row.
//   • Mods inline in Description column (NO fees in Description; fees
//     go in dedicated "Mod Fee" column for invoice/draft-quote modes).
//   • Notes table (MF06, MF07, long-value mods) rendered below items,
//     before totals. Description column shows [See note №N below].
//   • Packing List: mods shown in Description WITHOUT fees + Notes
//     table at bottom (workers must read notes clearly).
//   • Invoice / Draft Quote: 11-column layout (added Mod Fee col),
//     mods inline in Description, Notes table below.
//   • Totals: Modifications row inserted between Subtotal and Asm Fee.
//   • Tax base = SKU + TAXABLE mods only (reads m.tax_status from
//     snapshot written by step2.5 handleMfSave). Tax row in PDF
//     does NOT disclose taxable base breakdown (per Ben's Q3 choice).
//   • Markup applies only to Unit Price; Mods and Assembly never marked up.
//   • Mod Fee column displays UN-marked-up cost.
//
// Notes table whitelist + fallback (mirrors step3):
//   MF_USE_NOTES_TABLE = ['MF06', 'MF07']
//   NOTES_TABLE_FALLBACK_LENGTH = 40
//
// F-CUSTOM (Phase 6, 2026-05-14):
//   • TYPE_ORDER now includes 'OTHER' between ACCESSORIES and MODIFICATION
//     so Custom Other items sort consistently with step3 / quote-detail.
//   • All three PDFs (packing-list / invoice / draft-quote) suffix the SKU
//     cell with " [CUSTOM]" for rows where item.is_custom === true.
//   • [CUSTOM] tag appears only on the first sub-row of split items.
//
// F-HIDDEN-MODS (2026-05-18):
//   • _isHiddenMod() filters mods that are recorded in DB but should NOT
//     appear in PDF output. Currently filters MF01 value='none' (No Skin).
//
// F-LINE-TOTAL-INCLUDES-ASM (2026-05-21):
//   • PDF table "Total" column now INCLUDES asmFeeTotal:
//       lineTotal = skuLineTotal + modFeeTotal + asmFeeTotal
//     Matches the updated formula in step3.html. Bottom totals-section still
//     independently sums each subtotal, so no double-counting at grand total.
//
// F-COL-ABBREVIATIONS (2026-05-21):
//   • Type column shortened to 3-letter uppercase (BAS/WAL/TAL/ACC/OTH/MOD)
//     and Asm Status to ASM/RTA. Underlying DB fields unchanged.
//   • TYPE_SHORT_MAP / STATUS_SHORT_MAP centralise lookups for mirroring
//     across step3.html and quote-detail.html.
//
// F-PROMOTIONS (2026-05-21):  [legacy 命名,實際邏輯已由 CB-13 取代,見下]
//   • (歷史)曾讀 quoteData._promo 顯示折扣。CB-13 後 PDF 改為自算,
//     不再讀 _promo。此段保留僅為歷史紀錄。
//
// CB-11 / CB-12 / CB-13 (P1):
//   • 改動 7: DOOR & FRAME SKU 加註「Hinge not included」。
//   • 改動 8: MF03 Matching Interior(no→Wood Interior / yes→Matching Interior)。
//   • 改動 9: Kit Promo 20%(LSW/LSG/LSA + tag==='Kit'),PDF 自算。
//
// CB-13-FIX (2026-06-10): Invoice 折扣 bug 修復。
//   • tag 比對更正為 'Kit'(大寫,與 DB / step3 / quote-detail / email 一致)。
//     原本寫死小寫 'kit',永遠 match 不到 → Invoice 不顯示折扣。
//   • Invoice 與 Draft 的折扣套用「按身分拆開」,不再靠 markupPercent 當開關:
//       - Invoice    → applyPromo = true (一律套 Kit Promo,tax/grand 折後)
//       - Draft Quote→ applyPromo = false(一律不套,subtotal/tax/grand 全折前)
//     新增 applyPromo 旗標貫穿 _drawItemTable / _finalizeWithTotals /
//     _calcKitPromoDiscount。markupPercent 只影響 Unit Price 顯示,與折扣脫鉤。
//
// P2 LAYOUT (改動 10-17):
//   • 改動 10: PO# 字體 = Invoice 標題(16pt),三種 PDF。
//   • 改動 11: Header logo + Bill/Ship 放大 1.5x;維持兩列堆疊,header 加高
//     (headerH 36→52),三種 PDF。
//   • 改動 12 / 16: SKU 欄拓寬(Invoice / Packing List)。
//   • 改動 13: Invoice/Draft 總計區 — Assemble Fee 併入 Subtotal(標籤維持
//     "Subtotal"),不再有獨立 Assemble Fee 行。
//   • 改動 14: Invoice/Draft — 移除 Assemble Fee 的 by-type 細項。
//   • 改動 15: Packing List — T&C 右側顯示 "Assembled Items" 數量 summary
//     (即 Invoice 移除 asm 細項的同一位置)。
//   • 改動 17: Items 表格 body/head/divider 字體 7→10.5(1.5x),欄寬重配。
//     Totals / Notes / T&C / 頁尾 維持原大小。
// ============================================================

(function (global) {
  'use strict';

  // ----------------------------------------
  // 常數
  // ----------------------------------------
  const TYPE_ORDER = ['BASE', 'WALL', 'TALL', 'ACCESSORIES', 'OTHER', 'MODIFICATION'];

  // F-COL-ABBREVIATIONS (2026-05-21)
  const TYPE_SHORT_MAP = {
    'BASE':         'BAS',
    'WALL':         'WAL',
    'TALL':         'TAL',
    'ACCESSORIES':  'ACC',
    'OTHER':        'OTH',
    'MODIFICATION': 'MOD',
  };
  const STATUS_SHORT_MAP = {
    'ASSEMBLED': 'ASM',
    'RTA':       'RTA',
  };

  function _shortType(t) {
    if (!t) return '—';
    const key = String(t).toUpperCase();
    return TYPE_SHORT_MAP[key] || key.slice(0, 3);
  }

  function _shortStatus(s) {
    if (!s) return '—';
    const key = String(s).toUpperCase();
    return STATUS_SHORT_MAP[key] || key.slice(0, 3);
  }

  const COLORS = {
    darkGreen: [14, 31, 22],
    muted:     [122, 140, 130],
    border:    [221, 216, 204],
    gold:      [201, 168, 76],
    white:     [255, 255, 255],
    pending:   [224, 123, 57],
    note:      [224, 123, 57],
    modText:   [62, 90, 66],
    discount:  [192, 57, 43],   // red for discount values
  };

  // 改動 11: headerH 36 → 52(header 區塊放大,上方更醒目)
  const LAYOUT = {
    pageW:    210,
    pageH:    297,
    margin:   14,
    headerH:  52,
  };

  const MF_USE_NOTES_TABLE = ['MF06', 'MF07'];
  const NOTES_TABLE_FALLBACK_LENGTH = 40;
  const CUSTOM_SUFFIX = ' [CUSTOM]';

  // ----------------------------------------
  // Internal Helpers
  // ----------------------------------------

  function _typeRank(type) {
    const idx = TYPE_ORDER.indexOf((type || '').toUpperCase());
    return idx === -1 ? 99 : idx;
  }

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

// ─────────────────────────────────────────────────────────────────────────
  // CB-22 (2026-06-11): Order List type-group 排序 — 業務指定固定順序。
  //   廢棄 CB-7 的（BASE 最前 / ACCESSORIES 最後 / 中間字母序）。
  //   依 construction 走固定清單；不在清單的 type → OTHER，放最後。
  //   組內維持 style_code 字母序 stable sort。空 group 仍只在有 item 時才 push。
  //   constructionType 由 caller 經 quoteData.construction_type 傳入
  //   （pdf-builder 無 door_styles，無法自行反查）。缺值 → 預設 framed。
  //   ⚠ 與 new-quote-step3.html / quote-detail.html 邏輯同步。
  // ─────────────────────────────────────────────────────────────────────────
  const FRAMED_TYPE_ORDER    = ['BASE', 'WALL', 'TALL', 'DOOR & FRAME', 'BOX', 'ROLL OUT TRAY', 'ACCESSORIES'];
  const FRAMELESS_TYPE_ORDER = ['BASE', 'VANITY', 'WALL', 'TALL', 'MBOX', 'ROLL OUT TRAY', 'PANELS', 'MOLDINGS'];
  const OTHER_GROUP_LABEL    = 'OTHER';

  function _getTypeOrder(constructionType) {
    return (String(constructionType || '').toLowerCase() === 'frameless')
      ? FRAMELESS_TYPE_ORDER
      : FRAMED_TYPE_ORDER;   // 預設 framed
  }

  function _groupByTypeOrdered(items, constructionType) {
    const order    = _getTypeOrder(constructionType).map(function (t) { return t.toUpperCase(); });
    const orderSet = new Set(order);

    const buckets = {};
    (items || []).forEach(function (item) {
      let t = (item.sku_type || item.skuType || OTHER_GROUP_LABEL).toUpperCase();
      if (!orderSet.has(t)) t = OTHER_GROUP_LABEL;   // 不在清單 → 併入 OTHER
      if (!buckets[t]) buckets[t] = [];
      buckets[t].push(item);
    });

    Object.keys(buckets).forEach(function (t) {
      buckets[t].sort(function (a, b) {
        const sa = String(a.style_code || '').toUpperCase();
        const sb = String(b.style_code || '').toUpperCase();
        if (sa < sb) return -1; if (sa > sb) return 1; return 0;
      });
    });

    const result = [];
    order.forEach(function (t) {
      if (buckets[t] && buckets[t].length) result.push({ type: t, items: buckets[t] });
    });
    if (buckets[OTHER_GROUP_LABEL] && buckets[OTHER_GROUP_LABEL].length) {
      result.push({ type: OTHER_GROUP_LABEL, items: buckets[OTHER_GROUP_LABEL] });
    }
    return result;
  }

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

  // 改動 15: 統計 Assembled 類型數量(不需 assemble_fee),給 Packing List summary 用。
  //   只算 assemble_status === 'Assembled'(大小寫不敏感),RTA / Unassembled 不算。
  function _calcAssembledQtyByType(items) {
    const byType = {};
    (items || []).forEach(function (item) {
      const status = item.assemble_status || item.type || '';
      if (String(status).toLowerCase() !== 'assembled') return;
      const t = (item.sku_type || item.skuType || 'OTHER').toUpperCase();
      byType[t] = (byType[t] || 0) + (parseInt(item.quantity, 10) || 0);
    });
    return byType;
  }

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

  function _getNormalizedSubGroups(item) {
    if (Array.isArray(item.sub_groups) && item.sub_groups.length) {
      return item.sub_groups;
    }
    const assembleStatus = item.assemble_status || item.type;
    const legacyStatus = item.modification_status
      || (assembleStatus === 'RTA' ? 'skipped' : 'unprocessed');
    const legacyMods = Array.isArray(item.modifications) ? item.modifications : [];
    return [{
      sub_index:           1,
      qty:                 item.quantity,
      modifications:       legacyMods,
      modification_status: legacyStatus,
    }];
  }

  function _calcPerSubModCost(sub) {
      const mods = Array.isArray(sub.modifications) ? sub.modifications : [];
      return mods.reduce(function (s, m) {
        const c  = parseFloat(m && m.cost);
        const mt = parseFloat(m && m.material_cost);   // CB-6: 補材料(per-unit)
        return s + (isNaN(c) ? 0 : c) + (isNaN(mt) ? 0 : mt);
      }, 0);
    }

  function _calcPerSubTaxableModCost(sub) {
      const mods = Array.isArray(sub.modifications) ? sub.modifications : [];
      return mods.reduce(function (s, m) {
        if (!m || m.tax_status !== true) return s;
        const c  = parseFloat(m.cost);
        const mt = parseFloat(m.material_cost);   // CB-6: 課稅 mod 才把材料計入稅基
        return s + (isNaN(c) ? 0 : c) + (isNaN(mt) ? 0 : mt);
      }, 0);
    }

  function _calcTotalModsCost(items) {
    let total = 0;
    items.forEach(function (item) {
      const subs = _getNormalizedSubGroups(item);
      subs.forEach(function (sub) {
        const perSub = _calcPerSubModCost(sub);
        const qty    = parseInt(sub.qty, 10) || 0;
        total += perSub * qty;
      });
    });
    return total;
  }

  function _calcTaxableModsCost(items) {
    let total = 0;
    items.forEach(function (item) {
      const subs = _getNormalizedSubGroups(item);
      subs.forEach(function (sub) {
        const perSub = _calcPerSubTaxableModCost(sub);
        const qty    = parseInt(sub.qty, 10) || 0;
        total += perSub * qty;
      });
    });
    return total;
  }

  
  // ─────────────────────────────────────────────────────────────────────────
  // CB-13 (改動 9) + CB-13-FIX (2026-06-10): Kit Promo 20% — PDF 自算。
  //   逐 SKU 判斷:style_code ∈ {LSW,LSG,LSA} 且 tag === 'Kit'(大寫精確比對,
  //   與 DB / step3 / quote-detail / email 一致)。
  //   折扣「是否套用」由 applyPromo 旗標決定(Invoice=true / Draft=false),
  //   不再用 markupPercent 當開關 —— Draft 一律不折,Invoice 一律折。
  const KIT_PROMO_STYLES = ['LSW', 'LSG', 'LSA'];
  const KIT_PROMO_RATE   = 0.20;

  function _isKitPromoItem(item) {
    if (!item) return false;
    const style = String(item.style_code || '').toUpperCase();
    if (KIT_PROMO_STYLES.indexOf(style) === -1) return false;
    return item.tag === 'Kit';
  }

  function _calcKitPromoDiscount(items, applyPromo) {
    if (!applyPromo) return { amount: 0, matchedCount: 0 };
    let amount = 0;
    let matchedCount = 0;
    (items || []).forEach(function (item) {
      if (!_isKitPromoItem(item)) return;
      const unit = parseFloat(item.unit_price) || 0;
      const qty  = parseInt(item.quantity, 10) || 0;
      amount += unit * qty * KIT_PROMO_RATE;
      matchedCount += 1;
    });
    return { amount: amount, matchedCount: matchedCount };
  }

  function _formatModValue(v) {
    if (v == null) return '';
    if (typeof v === 'string')  return v;
    if (typeof v === 'number')  return String(v);
    if (typeof v === 'boolean') return v ? 'Yes' : 'No';
    if (typeof v === 'object') {
      // F-QTY-SELECTOR: MF03 toggle-with-qty 的 value { enabled, qty }
      if ('enabled' in v && !('value' in v) && !('selected' in v) && !('label' in v)) {
        if (v.enabled !== true) return '';
        return (typeof v.qty === 'number') ? ('Qty ' + v.qty) : 'Yes';
      }
      const parts = [];
      if ('selected' in v && v.selected) parts.push(String(v.selected));
      else if ('label' in v && v.label)  parts.push(String(v.label));
      else if ('value' in v && v.value != null) parts.push(String(v.value));

      if ('description' in v && v.description) parts.push(String(v.description));
      else if ('note' in v && v.note)          parts.push(String(v.note));

      if (parts.length) return parts.join(' — ');
      try { return JSON.stringify(v); } catch (e) { return ''; }
    }
    return String(v);
  }

  function _shouldUseNotesTable(mod) {
    if (!mod) return false;
    const code = (mod.mf_code || '').toUpperCase();
    if (MF_USE_NOTES_TABLE.indexOf(code) !== -1) return true;
    const valStr = _formatModValue(mod.value);
    if (valStr && valStr.length > NOTES_TABLE_FALLBACK_LENGTH) return true;
    return false;
  }

  function _isHiddenMod(mod) {
    if (!mod) return false;
    if (mod.mf_code === 'MF01' && mod.value === 'none') return true;
    return false;
  }

  function _isPendingShipping(quoteData) {
    if (!quoteData) return false;
    if (quoteData._isPendingShipping === true) return true;
    if (quoteData.logistic_type !== 'shipping') return false;
    return (quoteData.shipping_cost === null || quoteData.shipping_cost === undefined);
  }

  // ----------------------------------------
  // PDF 區塊繪製函式
  // ----------------------------------------

  // 改動 10 + 11: Header 區塊放大。
  //   - logo 放大(44×26 → 60×36)
  //   - 公司資訊字體 1.5x(7→10.5 / 6.5→10),行距加大
  //   - documentTitle 維持 16
  //   - PO# 放大到 = documentTitle(16)
  //   - date / jobName 1.5x(7→10.5)
  function _drawHeader(doc, context) {
    const { pageW, margin, headerH } = LAYOUT;
    const { logoImg, poNumber, numberLabel, jobName, date, documentTitle } = context;

    doc.setFillColor(...COLORS.white);
    doc.rect(0, 0, pageW, headerH, 'F');
    doc.setDrawColor(...COLORS.border);
    doc.setLineWidth(0.5);
    doc.line(0, headerH, pageW, headerH);

    if (logoImg) {
      doc.addImage(logoImg, 'PNG', margin, 6, 60, 36);
    } else {
      doc.setTextColor(...COLORS.darkGreen);
      doc.setFontSize(16);
      doc.setFont('helvetica', 'bold');
      doc.text('ProCraft DC', margin, 22);
    }

    const infoX = margin + 66;
    let infoY = 11;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10.5);
    doc.setTextColor(...COLORS.darkGreen);
    doc.text('ProCraft Cabinetry DC LLC', infoX, infoY);
    infoY += 5.5;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(40, 40, 40);
    [
      '6750 Santa Barbara Court Suite B',
      'Elkridge, MD 21075',
      'Phone: 410-863-9800',
      'Email: sales@procraftdc.com',
    ].forEach(line => {
      doc.text(line, infoX, infoY);
      infoY += 5;
    });

    if (documentTitle) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(16);
      doc.setTextColor(...COLORS.darkGreen);
      doc.text(documentTitle, pageW - margin, 13, { align: 'right' });
    }

    const dateStr = date.toLocaleDateString('en-US', {
      month: 'long', day: 'numeric', year: 'numeric',
    });

    // 改動 10: PO# 字體 = documentTitle(16)
    doc.setTextColor(...COLORS.muted);
    doc.setFontSize(16);
    doc.setFont('helvetica', 'normal');
    doc.text(`${numberLabel || 'PO#'} ${poNumber || '—'}`, pageW - margin, 25, { align: 'right' });

    // date / jobName 1.5x(7→10.5)
    doc.setFontSize(10.5);
    doc.text(dateStr, pageW - margin, 33, { align: 'right' });

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10.5);
    doc.setTextColor(40, 40, 40);
    doc.text(jobName || '—', pageW - margin, 41, { align: 'right' });
  }

  // 改動 11: Bill To / Ship To 區塊字體 1.5x(7.5→11),行距加大。
  function _drawBillShipBlock(doc, context) {
    const { pageW, margin } = LAYOUT;
    const { dealer, shippingAddress, startY } = context;

    const billX = margin;
    const shipX = pageW - margin;
    let addrY = startY + 6;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(...COLORS.muted);
    doc.text('BILL TO', billX, addrY);
    doc.text('SHIP TO', shipX, addrY, { align: 'right' });
    addrY += 7;

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
      doc.setFontSize(11);
      doc.setTextColor(40, 40, 40);
      if (billLines[i]) doc.text(billLines[i], billX, addrY);
      if (shipLines[i]) doc.text(shipLines[i], shipX, addrY, { align: 'right' });
      addrY += 6.5;
    }

    addrY += 3;
    doc.setDrawColor(...COLORS.border);
    doc.setLineWidth(0.3);
    doc.line(margin, addrY, pageW - margin, addrY);
    addrY += 4;

    return addrY;
  }

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

  function _addPageNumbers(doc) {
    const { pageW, margin, headerH } = LAYOUT;
    const totalPages = doc.getNumberOfPages();
    for (let p = 1; p <= totalPages; p++) {
      doc.setPage(p);
      doc.setFontSize(7);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(...COLORS.muted);
      doc.text(
        `Page ${p} / ${totalPages}`,
        pageW - margin,
        headerH - 3,
        { align: 'right' }
      );
    }
    doc.setPage(totalPages);
  }

  // ----------------------------------------
  // F4.2: Items 表格繪製
  // ----------------------------------------

  // CB-7: 只回「mod 文字」放進 SKU 欄(skuDesc 改放 Description 欄)。
  // showPrices=false（Packing List）→ 材料子行只顯示數量,不印 $。
  function _buildModsText(ctx) {
    const { sub, item, totalSubs, notesIndex, notesCollector, showPrices, mappingCollector } = ctx;
    const rawMods     = Array.isArray(sub.modifications) ? sub.modifications : [];
    const visibleMods = rawMods.filter(function (m) { return !_isHiddenMod(m); });
    const status = sub.modification_status || 'unprocessed';
    const lines  = [];

    if (!visibleMods.length) {
      if (rawMods.length > 0) return '';
      if (status === 'skipped' || status === 'configured') return '';
      return '⚠ Modifications pending';
    }

    visibleMods.forEach(function (m) {
      const label = m.display_label || m.mf_code || 'Modification';
      if (_shouldUseNotesTable(m)) {
        notesIndex.counter += 1;
        const noteNum = notesIndex.counter;
        notesCollector.push({
          num: noteNum, skuCode: item.sku_code,
          subIndex: sub.sub_index || 1, subTotal: totalSubs,
          mfCode: m.mf_code || '', label: label,
          content: _formatModValue(m.value) || '(no detail)',
        });
        lines.push(`! See Note No.${noteNum} — ${label}`);
      } else {
        // 改動 8 (CB-12): MF03 Matching Interior 特例
        //   value==='no'  → 顯示 no_label(Wood Interior)
        //   value!=='no'  → 顯示 display_label(Matching Interior)
        //   只輸出單一 label,不接 value,也無 mapping 子行
        if ((m.mf_code || '').toUpperCase() === 'MF03' && typeof m.value === 'string') {
          const mf03Label = (m.value === 'no')
            ? (m.no_label || 'Wood Interior')
            : (m.display_label || 'Matching Interior');
          lines.push(`• ${mf03Label}`);
          return;
        }
        const value = _formatModValue(m.value);
        lines.push(`• ${label}${value ? ': ' + value : ''}`);
        // CB-6 材料子行:N × MappingSKU (有價才加 $)
        const mq = parseInt(m.mapping_qty, 10) || 0;
                if (m.mapping_sku && mq > 0) {
                  const subQty = parseInt(sub.qty, 10) || 0;
                  const n = mq * subQty;
                  let mapLine;
                  if (showPrices) {
                    const mc = parseFloat(m.material_cost);
                    const matTotal = (isNaN(mc) ? 0 : mc) * subQty;
                    mapLine = `   ${n} × ${m.mapping_sku}: $${matTotal.toFixed(2)}`;
                  } else {
                    mapLine = `   ${n} × ${m.mapping_sku}`;
                  }
                  lines.push(mapLine);
                  if (mappingCollector) mappingCollector.push(mapLine);
                }
      }
    });

    return lines.join('\n');
  }

  function _drawItemTable(doc, context) {
      const { margin, headerH } = LAYOUT;
      const {
              items, mode, startY,
              markupPercent = 0,
              applyPromo = false,          // CB-13-FIX: Invoice=true / Draft=false
              constructionType = 'framed', // CB-22: Order List 排序依據(caller 帶入)
              headerContext,
            } = context;
        
            const isPacking  = (mode === 'packing-list');
            const showPrices = !isPacking;
            const colCount   = isPacking ? 6 : 10;
            const bodyFs     = isPacking ? 11 : 9;
        
            const groups = _groupByTypeOrdered(items, constructionType);
  
      const head = isPacking
        ? [['#', 'Type', 'SKU', 'Description', 'Qty', 'Assembled?']]
        : [['#', 'Type', 'SKU', 'Description', 'Qty', 'Assembled?',
            'Unit Price', 'Mod Fee', 'Asm Fee', 'Total']];
  
      const body = [];
      let itemNum = 0;
      const notes = [];
      const notesIndex = { counter: 0 };
  
      groups.forEach(function (group) {
        // CB-7: 橫跨全部欄的 type divider(改動 17: 字體 7→10.5)
        body.push([{
          content: '========== ' + group.type + ' ==========',
          colSpan: colCount,
          styles: {
            halign: 'center', fontStyle: 'bold', fontSize: bodyFs,
            fillColor: [235, 240, 236], textColor: COLORS.modText,
          },
        }]);
  
        group.items.forEach(function (item) {
          const subs = _getNormalizedSubGroups(item);
          const isSplit = subs.length > 1;
          const isCustom = !!item.is_custom;
          const assembleStatus = item.assemble_status || item.type || '';
          const skuDesc = item.sku_desc || '';
          const markedUnitPrice = item.unit_price * (1 + markupPercent);
          const _noPrefixType = (item.sku_type || item.skuType || '').toUpperCase();
          const _skipStylePrefix = (_noPrefixType === 'BOX' || _noPrefixType === 'ROLL OUT TRAY');
          const skuPrefix = (item.style_code && !_skipStylePrefix) ? item.style_code + '-' : '';
          // CB-13 (改動 9) + CB-13-FIX: 享 Kit Promo 的 line,Total 欄用折後 SKU 單價;
          //   Unit Price 欄仍顯示原價(markedUnitPrice)。
          //   折扣只在 applyPromo=true(Invoice)套用;Draft 一律不折。
          const effUnitPrice = (applyPromo && _isKitPromoItem(item))
            ? markedUnitPrice * (1 - KIT_PROMO_RATE)
            : markedUnitPrice;
  
          subs.forEach(function (sub, subIdx) {
            itemNum++;
            const numCell = String(itemNum);
            const isFirstSub = subIdx === 0;
            const subQty = parseInt(sub.qty, 10) || 0;
            // CB-9: Tag 只在主行顯示,子項留空(僅 invoice / draft-quote 用)
            const tagCell = isFirstSub ? (item.tag || '') : '';
  
            const customSuffix = (isCustom && isFirstSub) ? CUSTOM_SUFFIX : '';
            const subLabelLine = isSplit ? `\nSub ${subIdx + 1} of ${subs.length}` : '';
  
            // 改動 7 (CB-11): DOOR & FRAME 門板 SKU 加註「Hinge not included」
            //   依 item.sku_type === 'DOOR & FRAME' 判斷(只 framed 有此 type)
            //   只在主行(isFirstSub)顯示,排在 mod 子項之前
            const isDoorFrame =
              (item.sku_type || item.skuType || '').toUpperCase() === 'DOOR & FRAME';
            const hingeLine = (isDoorFrame && isFirstSub) ? '• Hinge not included' : '';

            const mappingLines = [];
                        const modsText = _buildModsText({
                          sub: sub, item: item, totalSubs: subs.length,
                          notesIndex: notesIndex, notesCollector: notes,
                          showPrices: showPrices,
                          mappingCollector: mappingLines,
                        });
                        const extraLines = [hingeLine, modsText].filter(Boolean).join('\n');
                        const skuCellText = `${skuPrefix}${item.sku_code}${customSuffix}${subLabelLine}`
                          + (extraLines ? `\n${extraLines}` : '');
                        const skuCell = mappingLines.length
                          ? { content: skuCellText, _mappingLines: mappingLines }
                          : skuCellText;
  
            const assembledCell = isFirstSub ? (assembleStatus === 'RTA' ? 'No' : 'Yes') : '';
  
            if (isPacking) {
              body.push([numCell, tagCell, skuCell, skuDesc, subQty, assembledCell]);
            } else {
              const perSubModCost = _calcPerSubModCost(sub);
              const modFeeTotal   = perSubModCost * subQty;
              const asmFeeTotal   = (item.assemble_fee || 0) * subQty;
              const lineTotal     = (effUnitPrice * subQty) + modFeeTotal + asmFeeTotal;
            body.push([
                numCell, tagCell, skuCell, skuDesc, subQty, assembledCell,
                `$${markedUnitPrice.toFixed(2)}`,
                modFeeTotal > 0 ? `+$${modFeeTotal.toFixed(2)}` : '—',
                asmFeeTotal > 0 ? `+$${asmFeeTotal.toFixed(2)}` : '—',
                `$${lineTotal.toFixed(2)}`,
              ]);
            }
          });
        });
      });
  
      // 改動 12 / 16 / 17: 欄寬重配(SKU 拓寬;配合 10.5pt 字體)
      const columnStyles = isPacking
        ? {
            0: { cellWidth: 10 },                          // #
            1: { cellWidth: 14, overflow: 'linebreak' },   // Tag
            2: { cellWidth: 60, overflow: 'linebreak' },   // SKU (改動16: 32→60 拓寬)
            3: { cellWidth: 58, overflow: 'linebreak' },   // Description (擠 88→58)
            4: { halign: 'right', cellWidth: 14 },         // Qty
            5: { cellWidth: 24 },                          // Assembled?
          }
        
        : {
            0: { cellWidth: 8 },                                     // #
            1: { cellWidth: 12, overflow: 'linebreak' },             // Tag
            2: { cellWidth: 46, overflow: 'linebreak' },             // SKU (改動12: 24→46 拓寬)
            3: { cellWidth: 22, overflow: 'linebreak' },             // Description (擠 41→22)
            4: { halign: 'right', cellWidth: 10 },                   // Qty
            5: { cellWidth: 18 },                                    // Assembled?
            6: { halign: 'right', cellWidth: 18 },                   // Unit Price
            7: { halign: 'right', cellWidth: 14 },                   // Mod Fee
            8: { halign: 'right', cellWidth: 14 },                   // Asm Fee
            9: { halign: 'right', fontStyle: 'bold', cellWidth: 18 },// Total
          };
  
const onDrawPage = (data) => {
        if (data.pageNumber > 1 && headerContext) _drawHeader(doc, headerContext);
      };

      // 本次改動: Bundle mapping SKU 行黑底白字。
      //   SKU 欄(col index 2)那格是多行文字;把 _mappingLines 收集到的 mapping 行
      //   在 didDrawCell 內覆蓋黑底白字。垂直位置用該格實際 fontSize 推算
      //   (所以 Packing 11pt / Invoice·Draft 9pt 都能對齊)。
      //   ⚠ 若部署後黑條上下沒對準那一行,調 ROW_TUNE(mm,正值往下)。
      const onDrawMappingHighlight = (data) => {
        if (data.section !== 'body') return;
        if (!data.column || data.column.index !== 2) return;
        const raw = data.cell.raw;
        const mapLines = raw && raw._mappingLines;
        if (!mapLines || !mapLines.length) return;

        const cell = data.cell;
        const fs   = cell.styles.fontSize;
        const lineHeight = fs * doc.getLineHeightFactor() / doc.internal.scaleFactor;
        const pad     = cell.styles.cellPadding;
        const padTop  = (typeof pad === 'number') ? pad : ((pad && pad.top)  || 0);
        const padLeft = (typeof pad === 'number') ? pad : ((pad && pad.left) || 0);
        const ROW_TUNE = 0;   // ← 微調用:整條黑底+白字一起上下移(mm,正=往下)

        const textLines = cell.text || [];
        textLines.forEach((lineStr, idx) => {
          const norm = String(lineStr).trim();
          const hit  = mapLines.some((ml) => String(ml).trim() === norm);
          if (!hit) return;
          const top = cell.y + padTop + idx * lineHeight + ROW_TUNE;
          doc.setFillColor(0, 0, 0);
          doc.rect(cell.x, top, cell.width, lineHeight, 'F');
          doc.setTextColor(255, 255, 255);
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(fs);
          doc.text(String(lineStr), cell.x + padLeft, top + lineHeight * 0.78);
        });
      };

      // 改動 17: 表身 / 表頭字體 7→10.5
      doc.autoTable({
        startY: startY,
        head: head,
        body: body,
        margin: { left: margin, right: margin, top: headerH + 4 },
        styles: { fontSize: bodyFs, cellPadding: 2, textColor: [30, 30, 30], overflow: 'linebreak', valign: 'top' },
        headStyles: { fillColor: COLORS.darkGreen, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: bodyFs },
        columnStyles: columnStyles,
        alternateRowStyles: { fillColor: [250, 248, 244] },
        didDrawPage: onDrawPage,
        didDrawCell: onDrawMappingHighlight,
      });
  
      return { tableEndY: doc.lastAutoTable.finalY, notes: notes };
    }

  // ----------------------------------------
  // CB-9 後續: Estimated Lead Time（items 表格下方、靠左）
  //   字串由 caller 透過 quoteData.estimated_lead_time 帶入(pdf-builder 無 door_styles)。
  //   無值則不印,回傳原 y。
  // ----------------------------------------
  function _drawLeadTime(doc, context) {
    const { margin, headerH } = LAYOUT;
    const { leadTime, startY, headerContext } = context;
    if (!leadTime) return startY;

    let y = startY + 6;
    if (y > 275) {
      doc.addPage();
      if (headerContext) _drawHeader(doc, headerContext);
      y = headerH + 8;
    }

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(...COLORS.muted);
    doc.text('ESTIMATED LEAD TIME', margin, y);

    const labelW = doc.getTextWidth('ESTIMATED LEAD TIME');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(...COLORS.modText);
    doc.text(String(leadTime), margin + labelW + 4, y);

    return y;
  }
  

  // ----------------------------------------
  // F4.2: Notes Table
  // ----------------------------------------

  function _drawNotesTable(doc, context) {
    const { margin, pageW, headerH } = LAYOUT;
    const { notes, startY, headerContext } = context;

    if (!notes || !notes.length) return startY;

    let y = startY + 6;

    if (y + 30 > 275) {
      doc.addPage();
      _drawHeader(doc, headerContext);
      y = headerH + 8;
    }

    doc.setFillColor(255, 247, 235);
    doc.setDrawColor(...COLORS.note);
    doc.setLineWidth(0.3);
    doc.rect(margin, y - 4, pageW - margin * 2, 8, 'FD');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(...COLORS.note);
    doc.text('MODIFICATION NOTES & CUSTOM DETAILS', margin + 3, y + 1);

    y += 7;

    const body = notes.map(function (n) {
      const subSuffix = (n.subTotal > 1) ? ` (Sub ${n.subIndex}/${n.subTotal})` : '';
      const modCell = n.mfCode ? `${n.label}\n(${n.mfCode})` : n.label;
      return [
        `No.${n.num}`,
        `${n.skuCode}${subSuffix}`,
        modCell,
        n.content,
      ];
    });

    doc.autoTable({
      startY: y,
      head: [['No.', 'Item', 'Modification', 'Detail / Note']],
      body: body,
      margin: { left: margin, right: margin, top: headerH + 4 },
      styles: {
        fontSize: 7,
        cellPadding: 2.5,
        textColor: [30, 30, 30],
        overflow: 'linebreak',
        valign: 'top',
      },
      headStyles: {
        fillColor: [255, 235, 215],
        textColor: COLORS.note,
        fontStyle: 'bold',
        fontSize: 7,
      },
      columnStyles: {
        0: { cellWidth: 14, fontStyle: 'bold', textColor: COLORS.note },
        1: { cellWidth: 38, fontStyle: 'bold', textColor: COLORS.darkGreen },
        2: { cellWidth: 40 },
        3: { cellWidth: 90, overflow: 'linebreak' },
      },
      alternateRowStyles: { fillColor: [253, 248, 240] },
      didDrawPage: (data) => {
        if (data.pageNumber > 1 && headerContext) {
          _drawHeader(doc, headerContext);
        }
      },
    });

    return doc.lastAutoTable.finalY;
  }

  // ----------------------------------------
  // 改動 15: Packing List 右側 Assembled 數量 summary
  //   位置對應 Invoice 移除 Asm Fee 細項的同一塊(T&C 右側)。
  // ----------------------------------------
  function _drawAssembledSummary(doc, context) {
    const { pageW, margin } = LAYOUT;
    const { byType, startY } = context;
    const x = pageW - margin - 70;
    let y = startY;

    const keys = Object.keys(byType || {});
    if (!keys.length) return y;

    // 依 TYPE_ORDER 排序,其餘類型(如 VANITY)接在後面字母序
    const ordered = keys.slice().sort(function (a, b) {
      const ia = TYPE_ORDER.indexOf(a); const ib = TYPE_ORDER.indexOf(b);
      const ra = ia === -1 ? 99 : ia;   const rb = ib === -1 ? 99 : ib;
      if (ra !== rb) return ra - rb;
      return a < b ? -1 : (a > b ? 1 : 0);
    });

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(...COLORS.darkGreen);
    doc.text('Assembled Items:', x, y);
    y += 6;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(11);
    doc.setTextColor(40, 40, 40);
    ordered.forEach(function (t) {
      doc.text(`  ${t} × ${byType[t]}`, x, y);
      y += 4.5;
    });

    return y;
  }

  // ----------------------------------------
  // Totals 區塊
  // ----------------------------------------

  /**
   * Totals layout (Invoice / Draft Quote):
   *   Subtotal              $X       (PRE-discount, 改動 13: 已含 Assemble Fee)
   *   Discount             -$Y       (only when totals.promoDiscount > 0)
   *     N eligible lines
   *   Modifications        +$Z       (only when > 0)
   *   Shipping              $S
   *   Tax                   $T
   *   ────────────────
   *   Order Total           $G
   *
   * 改動 13: Assemble Fee 併入 Subtotal,不再有獨立 Assemble Fee 行。
   * 改動 14: 移除 by-type Assemble Fee 細項。
   *
   * CB-13-FIX: Discount 行只在 Invoice(applyPromo=true 且有符合 SKU)出現;
   *   Draft 因 _finalizeWithTotals 傳 applyPromo=false → promoDiscount=0 → 不顯示。
   */
  function _drawTotals(doc, context) {
    const { pageW, margin } = LAYOUT;
    const {
      totals,
      taxExempt = false,
      freeShipping = false,
      pendingShipping = false,
      showPrices = true,
      startY,
    } = context;

    const totalsX = pageW - margin - 70;
    const valX    = pageW - margin;
    let y = startY;

    // ── Subtotal (PRE-discount, 改動 13: 含 Assemble Fee) ──
    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...COLORS.muted);
    doc.text('Subtotal', totalsX, y);
    doc.setTextColor(40, 40, 40);
    doc.text(
      showPrices ? `$${(totals.subtotal + totals.assembleTotal).toFixed(2)}` : '—',
      valX, y, { align: 'right' }
    );
    y += 6;

    // ── CB-13: Discount row ──
    if (showPrices && totals.promoDiscount > 0) {
      doc.setFontSize(8);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(...COLORS.discount);
      const label = totals.promoLabel || 'Discount';
      const maxLabelChars = 40;
      const displayLabel = label.length > maxLabelChars
        ? label.slice(0, maxLabelChars - 1) + '…'
        : label;
      doc.text(displayLabel, totalsX, y);
      // ASCII '-$'(非 U+2212),jsPDF WinAnsi 才能正確渲染。
      doc.text(`-$${totals.promoDiscount.toFixed(2)}`, valX, y, { align: 'right' });
      if (totals.promoMatchedCount > 0) {
        y += 3.3;
        doc.setFontSize(6);
        doc.setTextColor(...COLORS.discount);
        const subText = `${totals.promoMatchedCount} eligible line${totals.promoMatchedCount === 1 ? '' : 's'}`;
        doc.text(subText, totalsX, y);
        y += 3;
      } else {
        y += 6;
      }
      doc.setFontSize(8);
    }

    // ── Modifications ──
    if (showPrices && totals.modsTotal > 0) {
      doc.setFontSize(8);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(...COLORS.muted);
      doc.text('Modifications', totalsX, y);
      doc.setTextColor(140, 100, 20);
      doc.text(`+$${totals.modsTotal.toFixed(2)}`, valX, y, { align: 'right' });
      y += 6;
    }

    // ── (改動 13/14: Assemble Fee 行 + by-type 細項已移除,併入 Subtotal) ──

    // ── Shipping ──
    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...COLORS.muted);
    doc.text('Shipping', totalsX, y);

    if (!showPrices) {
      doc.setTextColor(40, 40, 40);
      doc.text('—', valX, y, { align: 'right' });
    } else if (pendingShipping) {
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

    // 雙編號制: Draft Quote 顯 Draft ID (D);Invoice / Packing List 顯 PO# (P)。
    const isDraftQuote = (documentTitle === 'DRAFT QUOTE');
    const headerContext = {
      logoImg,
      poNumber:      isDraftQuote
                       ? (quoteData.draft_number || '—')
                       : (quoteData.po_number || '—'),
      numberLabel:   isDraftQuote ? 'Draft ID' : 'PO#',
      jobName:       quoteData.job_name  || '—',
      date,
      documentTitle: documentTitle,
    };
    _drawHeader(doc, headerContext);

    let y = LAYOUT.headerH + 10;
    y = _drawBillShipBlock(doc, {
      dealer,
      shippingAddress,
      startY: y - 4,
    });

    // F-CUSTOM (Phase 6): debug log for custom item count
    if (Array.isArray(quoteData.items)) {
      const customCount = quoteData.items.filter(i => i.is_custom).length;
      if (customCount > 0) {
        console.log('[F-CUSTOM] ' + documentTitle + ' PDF: ' + customCount + ' custom item(s)');
      }
    }
    // CB-13 (改動 9) + CB-13-FIX: debug log for Kit Promo (PDF self-calc)
    //   折扣只在 Invoice 套用;Draft 一律不折;Packing List 無金額不顯示。
    if (documentTitle === 'INVOICE') {
      const _kitDbg = _calcKitPromoDiscount(quoteData.items, true);
      if (_kitDbg.amount > 0) {
        console.log('[CB-13] INVOICE PDF: Kit Promo -$'
          + _kitDbg.amount.toFixed(2) + ' across ' + _kitDbg.matchedCount + ' line(s)');
      } else {
        console.log('[CB-13] INVOICE PDF: Kit Promo not applicable (no eligible line)');
      }
    } else if (documentTitle === 'DRAFT QUOTE') {
      console.log('[CB-13] DRAFT QUOTE PDF: Kit Promo not applied (draft never discounts)');
    }
    return { doc, logoImg, y, headerContext };
  }

  /**
   * F4.2 + CB-13 + CB-13-FIX: Finalize with totals.
   *
   * CB-13 (改動 9): Kit Promo 折扣由 PDF 自算 _calcKitPromoDiscount(items,
   * applyPromo),不讀 quoteData._promo。
   *
   * CB-13-FIX (2026-06-10): 折扣是否套用由 applyPromo 旗標決定,與 markup 脫鉤。
   *   - Invoice    : applyPromo = true  → 套折扣
   *   - Draft Quote: applyPromo = false → 不套折扣(promoDiscount=0)
   *
   * 套折扣時(promoDiscount > 0):
   *   - taxBase     = (markedSubtotal - promoDiscount) + taxableModsTotal
   *   - billingBase = (markedSubtotal - promoDiscount) + modsTotal
   *   - grand       = billingBase + assembly + shipping + tax
   *   Subtotal 行仍顯示折扣前金額,折扣獨立一行。
   * 不套折扣時(Draft 或無符合 SKU):promoDiscount=0,subtotal/tax/grand 全用折前。
   *
   * 改動 13: Subtotal 顯示值已在 _drawTotals 內併入 assembleTotal;grand 計算不變。
   */
  function _finalizeWithTotals(args) {
    const {
      doc, quoteData, items, headerContext, tableEndY, notes,
      showPrices, markupPercent = 0,
      applyPromo = false,          // CB-13-FIX: Invoice=true / Draft=false
    } = args;
    const { pageW, margin } = LAYOUT;

    const markedSubtotal = items.reduce(
      (s, i) => s + i.unit_price * (1 + markupPercent) * i.quantity, 0
    );

    const assembleTotal = items.reduce(
      (s, i) => s + (i.assemble_fee || 0) * i.quantity, 0
    );

    let modsTotal;
    if (typeof quoteData.modifications_total === 'number') {
      modsTotal = quoteData.modifications_total;
    } else if (typeof quoteData.modifications_total === 'string') {
      modsTotal = parseFloat(quoteData.modifications_total) || 0;
    } else {
      modsTotal = _calcTotalModsCost(items);
    }

    let taxableModsTotal;
    if (typeof quoteData.modifications_total_taxable === 'number') {
      taxableModsTotal = quoteData.modifications_total_taxable;
    } else if (typeof quoteData.modifications_total_taxable === 'string') {
      taxableModsTotal = parseFloat(quoteData.modifications_total_taxable) || 0;
    } else {
      taxableModsTotal = _calcTaxableModsCost(items);
    }

    // ── CB-13 (改動 9) + CB-13-FIX: Kit Promo 20% — PDF 自算,applyPromo 控制套用 ──
    const kitPromo          = _calcKitPromoDiscount(items, applyPromo);
    const promoDiscount     = kitPromo.amount;
    const promoLabel        = promoDiscount > 0 ? 'Discount (Kit Promo 20%)' : '';
    const promoMatchedCount = kitPromo.matchedCount;

    const logisticType    = quoteData.logistic_type || 'pickup';
    const deliveryFee     = parseFloat(quoteData.delivery_fee || 0);
    const pendingShipping = _isPendingShipping(quoteData);

    // ── Shipping resolution — uses POST-discount billing base ──
    //   Draft(applyPromo=false): promoDiscount=0 → billingBase 即折前,符合 Draft 用原價。
    const billingBase = (markedSubtotal - promoDiscount) + modsTotal;
    let shipping;
    if (pendingShipping) {
      shipping = 0;
    } else if (quoteData.shipping_cost !== null && quoteData.shipping_cost !== undefined) {
      shipping = parseFloat(quoteData.shipping_cost) || 0;
    } else {
      // shipping_cost 為 null 且非 pending → 只可能是 delivery 的防呆 fallback。
      // 新規格 (2026-06): 'shipping' 一律 null → 必為 pending(上面第一分支),
      // 不會進到這裡,故移除已廢棄的 shipping 級距自算(15%/12%/10%)。
      shipping = (logisticType === 'delivery') ? deliveryFee : 0;
    }

    // ── Tax base = (SKU - promo) + TAXABLE mods ──
    //   Draft(promoDiscount=0): tax 用折前,符合 Draft 規則。
    const taxRate   = quoteData._taxRate || 0;
    const taxExempt = !!quoteData._taxExempt;
    const taxBase   = (markedSubtotal - promoDiscount) + taxableModsTotal;
    const tax       = taxExempt ? 0 : taxBase * taxRate;

    // ── Grand total = billing base + assembly + shipping + tax ──
    const grand = billingBase + assembleTotal + (pendingShipping ? 0 : shipping) + tax;

    const totals = {
      subtotal:          markedSubtotal,     // PRE-discount(顯示時併入 assembleTotal,見 _drawTotals)
      promoDiscount:     promoDiscount,
      promoLabel:        promoLabel,
      promoMatchedCount: promoMatchedCount,
      modsTotal:         modsTotal,
      assembleTotal:     assembleTotal,
      shipping:          shipping,
      tax:               tax,
      grand:             grand,
    };

    // CB-9 後續: Estimated Lead Time 印在 items 表格下方(Notes 之前)
    const yLead = _drawLeadTime(doc, {
      leadTime:      quoteData.estimated_lead_time,
      startY:        tableEndY,
      headerContext: headerContext,
    });

    let yAfterNotes = yLead;
    if (notes && notes.length) {
      yAfterNotes = _drawNotesTable(doc, {
        notes:         notes,
        startY:        yLead,
        headerContext: headerContext,
      });
    }

    let y = yAfterNotes + 8;
    const TC_BLOCK_H = 7 * 6 + 16;
    // 改動 13/14 後 totals 少了 Assemble Fee 行 + 細項,所以高度需求變小
    const PROMO_H    = promoDiscount > 0 ? 9 : 0;
    const TOTALS_H   = 45 + (modsTotal > 0 ? 6 : 0) + PROMO_H;
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

    _drawTermsAndConditions(doc, { startY: y });

    const freeShipping = !pendingShipping && shipping === 0 && markedSubtotal > 0;
    _drawTotals(doc, {
      totals, taxExempt, freeShipping,
      pendingShipping,
      showPrices, startY: y,
    });

    _drawFooterBar(doc);
    _addPageNumbers(doc);
  }

  /**
   * F4.2: Packing List finalize — Notes table + T&C, no totals.
   * 改動 15: T&C 變窄,右側加 Assembled 數量 summary。
   */
  function _finalizePackingListWithTcAndNotes(args) {
    const { doc, quoteData, headerContext, tableEndY, notes } = args;
    const { pageW, margin } = LAYOUT;

    // CB-9 後續: Estimated Lead Time 印在 items 表格下方(Notes 之前)
    const yLead = _drawLeadTime(doc, {
      leadTime:      quoteData.estimated_lead_time,
      startY:        tableEndY,
      headerContext: headerContext,
    });

    let yAfterNotes = yLead;
    if (notes && notes.length) {
      yAfterNotes = _drawNotesTable(doc, {
        notes:         notes,
        startY:        yLead,
        headerContext: headerContext,
      });
    }

    let y = yAfterNotes + 8;
    // 改動 15: T&C 變窄(maxWidth 105)會多折行,預留高一點
    const TC_BLOCK_H = 7 * 8 + 16;
    const NEEDED     = TC_BLOCK_H + 20;

    if (y + NEEDED > 275) {
      doc.addPage();
      _drawHeader(doc, headerContext);
      y = LAYOUT.headerH + 8;
    }

    doc.setDrawColor(...COLORS.border);
    doc.setLineWidth(0.3);
    doc.line(margin, y, pageW - margin, y);
    y += 6;

    // 改動 15: 左 T&C(變窄) + 右 Assembled summary
    _drawTermsAndConditions(doc, { startY: y, maxWidth: 105 });
    _drawAssembledSummary(doc, {
      byType: _calcAssembledQtyByType(quoteData.items),
      startY: y,
    });

    _drawFooterBar(doc);
    _addPageNumbers(doc);
  }

  /**
   * 建立 Packing List PDF（無價，給工廠用）
   * CB-13 (改動 9): 無價格欄、無總計區,折扣不顯示(工廠文件)。
   * 改動 15: 底部右側顯示 Assembled 數量 summary。
   */
  async function buildPackingListPdf(quoteData, dealer, shippingAddress, options = {}) {
    const { doc, y, headerContext } = await _initDocAndDrawTop(
      quoteData, dealer, shippingAddress, options,
      'PACKING LIST'
    );

  const { tableEndY, notes } = _drawItemTable(doc, {
        items:            quoteData.items,
        mode:             'packing-list',
        startY:           y,
        markupPercent:    0,
        applyPromo:       false,        // Packing List 無金額,折扣不適用
        constructionType: quoteData.construction_type,   // CB-22
        headerContext:    headerContext,
      });

    _finalizePackingListWithTcAndNotes({ doc, quoteData, headerContext, tableEndY, notes });

    return doc;
  }

  /**
   * 建立 Invoice PDF（含價，給 dealer / 客戶用）
   * CB-13 (改動 9) + CB-13-FIX: PDF 自算 Kit Promo 折扣(LSW/LSG/LSA + tag==='Kit'),
   *   不讀 _promo。Invoice 一律套折扣(applyPromo=true),tax/grand 折後。
   * 改動 13/14: Assemble Fee 併入 Subtotal,無獨立 Asm Fee 行與細項。
   */
  async function buildInvoicePdf(quoteData, dealer, shippingAddress, options = {}) {
    const { markupPercent = 0 } = options;
    const { doc, y, headerContext } = await _initDocAndDrawTop(
      quoteData, dealer, shippingAddress, options,
      'INVOICE'
    );

    const { tableEndY, notes } = _drawItemTable(doc, {
          items:            quoteData.items,
          mode:             'invoice',
          startY:           y,
          markupPercent:    markupPercent,
          applyPromo:       true,         // CB-13-FIX: Invoice 一律套 Kit Promo
          constructionType: quoteData.construction_type,   // CB-22
          headerContext:    headerContext,
        });

    _finalizeWithTotals({
      doc, quoteData, items: quoteData.items,
      headerContext, tableEndY, notes,
      showPrices: true, markupPercent,
      applyPromo: true,            // CB-13-FIX
    });

    return doc;
  }

  /**
   * 建立 Draft Quote PDF（Step 3 預覽用）
   * CB-13 (改動 9) + CB-13-FIX: Draft 一律不套 Kit Promo(applyPromo=false),
   *   不論 markup 多少 —— subtotal / tax / grand 全用折前(原價),不顯示 Discount 行。
   * 改動 13/14: 與 Invoice 同步 — Assemble Fee 併入 Subtotal,無細項。
   */
  async function buildDraftQuotePdf(quoteData, dealer, shippingAddress, options = {}) {
    const { markupPercent = 0 } = options;
    const { doc, y, headerContext } = await _initDocAndDrawTop(
      quoteData, dealer, shippingAddress, options,
      'DRAFT QUOTE'
    );

  const { tableEndY, notes } = _drawItemTable(doc, {
        items:            quoteData.items,
        mode:             'draft-quote',
        startY:           y,
        markupPercent:    markupPercent,
        applyPromo:       false,        // CB-13-FIX: Draft 一律不折
        constructionType: quoteData.construction_type,   // CB-22
        headerContext:    headerContext,
      });

    _finalizeWithTotals({
      doc, quoteData, items: quoteData.items,
      headerContext, tableEndY, notes,
      showPrices: true, markupPercent,
      applyPromo: false,           // CB-13-FIX: Draft 一律不折
    });

    return doc;
  }

  // ============================================================
  // Filename 工具
  // ============================================================

  function _getNYDateString() {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York',
      year:  'numeric',
      month: '2-digit',
      day:   '2-digit',
    });
    return fmt.format(new Date()).replace(/-/g, '');
  }

  function getPdfFilename(type, options = {}) {
    const { poNumber, dealerUid, revisionNumber = 1 } = options;
    const versionSuffix = revisionNumber > 1 ? ` - v${revisionNumber}` : '';

    if (type === 'packing-list') {
      return `ProCraft DC - Packing List - ${poNumber || 'Quote'}${versionSuffix}.pdf`;
    }
    if (type === 'invoice') {
      return `ProCraft DC - Invoice - ${poNumber || 'Quote'}${versionSuffix}.pdf`;
    }
    if (type === 'draft-quote') {
      return `ProCraft DC - Draft Quote - ${dealerUid || 'Dealer'} - ${_getNYDateString()}.pdf`;
    }

    return 'quote.pdf';
  }

  // ----------------------------------------
  // 對外暴露
  // ----------------------------------------
  global.ProCraftPDF = {
    _TYPE_ORDER:       TYPE_ORDER,
    _TYPE_SHORT_MAP:   TYPE_SHORT_MAP,
    _STATUS_SHORT_MAP: STATUS_SHORT_MAP,
    _shortType:        _shortType,
    _shortStatus:      _shortStatus,
    _COLORS:     COLORS,
    _LAYOUT:     LAYOUT,
    _MF_USE_NOTES_TABLE:           MF_USE_NOTES_TABLE,
    _NOTES_TABLE_FALLBACK_LENGTH:  NOTES_TABLE_FALLBACK_LENGTH,
    _CUSTOM_SUFFIX:                CUSTOM_SUFFIX,

    _typeRank:                _typeRank,
    _groupAndSort:            _groupAndSort,
    _calcAsmByType:           _calcAsmByType,
    _calcAssembledQtyByType:  _calcAssembledQtyByType,           // 改動 15
    _loadImage:               _loadImage,
    _isPendingShipping:       _isPendingShipping,
    _isHiddenMod:             _isHiddenMod,
    _calcKitPromoDiscount:    _calcKitPromoDiscount,             // CB-13 (改動 9) / CB-13-FIX
    _isKitPromoItem:          _isKitPromoItem,                   // CB-13 (改動 9) / CB-13-FIX
    _getNormalizedSubGroups:  _getNormalizedSubGroups,
    _calcPerSubModCost:       _calcPerSubModCost,
    _calcPerSubTaxableModCost: _calcPerSubTaxableModCost,
    _calcTotalModsCost:       _calcTotalModsCost,
    _calcTaxableModsCost:     _calcTaxableModsCost,
    _formatModValue:          _formatModValue,
    _shouldUseNotesTable:     _shouldUseNotesTable,
    _buildModsText:           _buildModsText,

    _drawHeader:             _drawHeader,
    _drawBillShipBlock:      _drawBillShipBlock,
    _drawFooterBar:          _drawFooterBar,
    _addPageNumbers:         _addPageNumbers,
    _drawItemTable:          _drawItemTable,
    _drawNotesTable:         _drawNotesTable,
    _drawAssembledSummary:   _drawAssembledSummary,              // 改動 15
    _drawTotals:             _drawTotals,
    _drawTermsAndConditions: _drawTermsAndConditions,

    buildPackingListPdf: buildPackingListPdf,
    buildInvoicePdf:     buildInvoicePdf,
    buildDraftQuotePdf:  buildDraftQuotePdf,
    getPdfFilename:      getPdfFilename,
  };

})(window);
