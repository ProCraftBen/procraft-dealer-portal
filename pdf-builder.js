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
// F-PROMOTIONS (2026-05-21):
//   • Reads quoteData._promo (written by step3 buildQuoteDataForPdf) to
//     render a "Promo Discount" row in totals of Invoice and Draft Quote
//     PDFs (between Subtotal and Modifications, mirroring step3 UI layout).
//     Discount value rendered in red.
//   • Packing List PDF intentionally does NOT show promo info — it's for
//     warehouse / assembly workflow, not pricing.
//   • Tax base, billing base (shipping bracket), and grand total all factor
//     in the discount: (markedSubtotal - promoDiscount) feeds taxBase and
//     billingBase. The "Subtotal" row in PDF still shows PRE-discount value
//     so dealer reads "Subtotal $X → Promo -$Y → ... → Total $Z" in order.
//   • When _promo.suppressed_by_markup === true (set by step3 when markup>0
//     on the Draft Quote PDF), promo is treated as zero — no discount row,
//     no tax recalc. PDF reflects the marked-up price as the customer-facing
//     number, consistent with step3 markup-mode behavior.
//   • When quoteData._promo is absent (legacy quotes from before this feature
//     went live), behavior is fully backward compatible.
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
    discount:  [192, 57, 43],   // F-PROMOTIONS: red for discount values
  };

  const LAYOUT = {
    pageW:    210,
    pageH:    297,
    margin:   14,
    headerH:  36,
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

  // CB-7: type-group ordering（BASE 最前 → 中間字母序 → ACCESSORIES → OTHER）
  function _typeGroupTier(type) {
    const t = (type || 'OTHER').toUpperCase();
    if (t === 'BASE')        return 0;
    if (t === 'ACCESSORIES') return 2;
    if (t === 'OTHER')       return 3;
    return 1;
  }

  function _groupByTypeOrdered(items) {
    const buckets = {};
    (items || []).forEach(function (item) {
      const t = (item.sku_type || item.skuType || 'OTHER').toUpperCase();
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
    return Object.keys(buckets).sort(function (a, b) {
      const ta = _typeGroupTier(a), tb = _typeGroupTier(b);
      if (ta !== tb) return ta - tb;
      if (a < b) return -1; if (a > b) return 1; return 0;
    }).map(function (t) { return { type: t, items: buckets[t] }; });
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
  // F-PROMOTIONS (2026-05-21): Extract promo info from quoteData._promo.
  //
  // step3 buildQuoteDataForPdf writes _promo = { total_discount, label,
  // promo_id, matched_line_count, matched_subtotal, suppressed_by_markup }.
  // Returns null when:
  //   - quoteData._promo missing (legacy quote)
  //   - total_discount <= 0
  //   - suppressed_by_markup === true (markup mode overrides promo)
  // ─────────────────────────────────────────────────────────────────────────
  function _extractPromoInfo(quoteData) {
    if (!quoteData || !quoteData._promo) return null;
    const p = quoteData._promo;
    if (p.suppressed_by_markup === true) return null;
    const amount = parseFloat(p.total_discount);
    if (isNaN(amount) || amount <= 0) return null;
    return {
      amount:           amount,
      label:            String(p.label || 'Promo Discount'),
      id:               String(p.promo_id || ''),
      matchedCount:     parseInt(p.matched_line_count, 10) || 0,
      matchedSubtotal:  parseFloat(p.matched_subtotal) || 0,
    };
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

  function _drawHeader(doc, context) {
    const { pageW, margin, headerH } = LAYOUT;
    const { logoImg, poNumber, jobName, date, documentTitle } = context;

    doc.setFillColor(...COLORS.white);
    doc.rect(0, 0, pageW, headerH, 'F');
    doc.setDrawColor(...COLORS.border);
    doc.setLineWidth(0.5);
    doc.line(0, headerH, pageW, headerH);

    if (logoImg) {
      doc.addImage(logoImg, 'PNG', margin, 3, 44, 26);
    } else {
      doc.setTextColor(...COLORS.darkGreen);
      doc.setFontSize(11);
      doc.setFont('helvetica', 'bold');
      doc.text('ProCraft DC', margin, 15);
    }

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

    if (documentTitle) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(16);
      doc.setTextColor(...COLORS.darkGreen);
      doc.text(documentTitle, pageW - margin, 9, { align: 'right' });
    }

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
  // F4.2: Items 表格繪製
  // ----------------------------------------

  // CB-7: 只回「mod 文字」放進 SKU 欄(skuDesc 改放 Description 欄)。
  // showPrices=false（Packing List）→ 材料子行只顯示數量,不印 $。
  function _buildModsText(ctx) {
    const { sub, item, totalSubs, notesIndex, notesCollector, showPrices } = ctx;
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
        const value = _formatModValue(m.value);
        lines.push(`• ${label}${value ? ': ' + value : ''}`);
        // CB-6 材料子行:N × MappingSKU (有價才加 $)
        const mq = parseInt(m.mapping_qty, 10) || 0;
        if (m.mapping_sku && mq > 0) {
          const subQty = parseInt(sub.qty, 10) || 0;
          const n = mq * subQty;
          if (showPrices) {
            const mc = parseFloat(m.material_cost);
            const matTotal = (isNaN(mc) ? 0 : mc) * subQty;
            lines.push(`   ${n} × ${m.mapping_sku}: $${matTotal.toFixed(2)}`);
          } else {
            lines.push(`   ${n} × ${m.mapping_sku}`);
          }
        }
      }
    });

    return lines.join('\n');
  }

  function _drawItemTable(doc, context) {
      const { margin, headerH } = LAYOUT;
      const { items, mode, startY, markupPercent = 0, headerContext } = context;
  
      const isPacking  = (mode === 'packing-list');
      const showPrices = !isPacking;
      const colCount   = isPacking ? 6 : 10;
  
      const groups = _groupByTypeOrdered(items);
  
      const head = isPacking
        ? [['Item#', 'Tag', 'SKU', 'Description', 'Qty', 'Assembled?']]
        : [['Item#', 'Tag', 'SKU', 'Description', 'Qty', 'Assembled?',
            'Unit Price', 'Mod Fee', 'Asm Fee', 'Total']];
  
      const body = [];
      let itemNum = 0;
      const notes = [];
      const notesIndex = { counter: 0 };
  
      groups.forEach(function (group) {
        // CB-7: 橫跨全部欄的 type divider
        body.push([{
          content: '========== ' + group.type + ' ==========',
          colSpan: colCount,
          styles: {
            halign: 'center', fontStyle: 'bold', fontSize: 7,
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
          const skuPrefix = item.style_code ? item.style_code + '-' : '';
  
          subs.forEach(function (sub, subIdx) {
            itemNum++;
            const isFirstSub = subIdx === 0;
            const subQty = parseInt(sub.qty, 10) || 0;
            // CB-9: Tag 只在主行顯示,子項留空(僅 invoice / draft-quote 用)
            const tagCell = isFirstSub ? (item.tag || '') : '';
  
            const customSuffix = (isCustom && isFirstSub) ? CUSTOM_SUFFIX : '';
            const subLabelLine = isSplit ? `\nSub ${subIdx + 1} of ${subs.length}` : '';
  
            const modsText = _buildModsText({
              sub: sub, item: item, totalSubs: subs.length,
              notesIndex: notesIndex, notesCollector: notes,
              showPrices: showPrices,
            });
            const skuCell = `${skuPrefix}${item.sku_code}${customSuffix}${subLabelLine}`
              + (modsText ? `\n${modsText}` : '');
  
            const assembledCell = isFirstSub ? (assembleStatus === 'RTA' ? 'No' : 'Yes') : '';
  
            if (isPacking) {
              body.push([`#${itemNum}`, tagCell, skuCell, skuDesc, subQty, assembledCell]);
            } else {
              const perSubModCost = _calcPerSubModCost(sub);
              const modFeeTotal   = perSubModCost * subQty;
              const asmFeeTotal   = (item.assemble_fee || 0) * subQty;
              const lineTotal     = (markedUnitPrice * subQty) + modFeeTotal + asmFeeTotal;
              body.push([
                `#${itemNum}`, tagCell, skuCell, skuDesc, subQty, assembledCell,
                `$${markedUnitPrice.toFixed(2)}`,
                modFeeTotal > 0 ? `+$${modFeeTotal.toFixed(2)}` : '—',
                asmFeeTotal > 0 ? `+$${asmFeeTotal.toFixed(2)}` : '—',
                `$${lineTotal.toFixed(2)}`,
              ]);
            }
          });
        });
      });
  
      const columnStyles = isPacking
        ? {
            0: { cellWidth: 12 },                          // Item#
            1: { cellWidth: 16, overflow: 'linebreak' },   // CB-9: Tag
            2: { cellWidth: 64, overflow: 'linebreak' },   // SKU (was 75)
            3: { cellWidth: 55, overflow: 'linebreak' },   // Description (was 60)
            4: { halign: 'right', cellWidth: 13 },         // Qty
            5: { cellWidth: 22 },                          // Assembled?
          }
        : {
            0: { cellWidth: 9 },                                     // Item#
            1: { cellWidth: 14, overflow: 'linebreak' },             // CB-9: Tag
            2: { cellWidth: 42, overflow: 'linebreak' },             // SKU (was 50)
            3: { cellWidth: 28, overflow: 'linebreak' },             // Description (was 34)
            4: { halign: 'right', cellWidth: 9 },                    // Qty
            5: { cellWidth: 16 },                                    // Assembled?
            6: { halign: 'right', cellWidth: 16 },                   // Unit Price
            7: { halign: 'right', cellWidth: 13 },                   // Mod Fee
            8: { halign: 'right', cellWidth: 13 },                   // Asm Fee
            9: { halign: 'right', fontStyle: 'bold', cellWidth: 19 },// Total
          };
  
      const onDrawPage = (data) => {
        if (data.pageNumber > 1 && headerContext) _drawHeader(doc, headerContext);
      };
  
      doc.autoTable({
        startY: startY,
        head: head,
        body: body,
        margin: { left: margin, right: margin, top: headerH + 4 },
        styles: { fontSize: 7, cellPadding: 2, textColor: [30, 30, 30], overflow: 'linebreak', valign: 'top' },
        headStyles: { fillColor: COLORS.darkGreen, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 7 },
        columnStyles: columnStyles,
        alternateRowStyles: { fillColor: [250, 248, 244] },
        didDrawPage: onDrawPage,
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
  // Totals 區塊
  // ----------------------------------------

  /**
   * F4.2 + F-PROMOTIONS Totals layout:
   *   Subtotal              $X       (PRE-discount)
   *   Promo Discount       -$Y       (only when totals.promoDiscount > 0)
   *     N eligible lines
   *   Modifications        +$Z       (only when > 0)
   *   Assemble Fee         +$A       (only when > 0)
   *     BAS x2  / WAL x3  / etc.
   *   Shipping              $S
   *   Tax                   $T
   *   ────────────────
   *   Order Total           $G
   */
  function _drawTotals(doc, context) {
    const { pageW, margin } = LAYOUT;
    const {
      totals,
      asmByType,
      taxExempt = false,
      freeShipping = false,
      pendingShipping = false,
      showPrices = true,
      startY,
      items,
    } = context;

    const byType = asmByType || (items ? _calcAsmByType(items) : {});

    const totalsX = pageW - margin - 70;
    const valX    = pageW - margin;
    let y = startY;

    // ── Subtotal (PRE-discount) ──
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

    // ── F-PROMOTIONS: Promo Discount row ──
    if (showPrices && totals.promoDiscount > 0) {
      doc.setFontSize(8);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(...COLORS.discount);
      const label = totals.promoLabel || 'Promo Discount';
      // Truncate label if too long for the totals column (~70mm wide).
      // jsPDF doesn't auto-wrap small inline text without splitTextToSize;
      // an ellipsis keeps things tidy.
      const maxLabelChars = 40;
      const displayLabel = label.length > maxLabelChars
        ? label.slice(0, maxLabelChars - 1) + '…'
        : label;
      doc.text(displayLabel, totalsX, y);
      // NOTE: use ASCII '-$' not Unicode minus '−$' (U+2212). jsPDF default
      // Helvetica WinAnsi encoding doesn't render U+2212 cleanly — it shows
      // as a different glyph and the subsequent digits get visually spaced
      // out (e.g. "$ 1 1 0 . 0 0"). ASCII hyphen renders correctly.
      doc.text(`-$${totals.promoDiscount.toFixed(2)}`, valX, y, { align: 'right' });
      // Sublabel "N eligible lines" below
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

    // ── F4.2: Modifications ──
    if (showPrices && totals.modsTotal > 0) {
      doc.setFontSize(8);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(...COLORS.muted);
      doc.text('Modifications', totalsX, y);
      doc.setTextColor(140, 100, 20);
      doc.text(`+$${totals.modsTotal.toFixed(2)}`, valX, y, { align: 'right' });
      y += 6;
    }

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

      // F-COL-ABBREVIATIONS: use short codes for the by-type breakdown
      TYPE_ORDER.filter(t => byType[t]).forEach(t => {
        const row = byType[t];
        doc.setFontSize(6.5);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(...COLORS.muted);
        doc.text(`  ${_shortType(t)} x${row.qty}`, totalsX, y);
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

    const headerContext = {
      logoImg,
      poNumber:      quoteData.po_number || '—',
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
    // F-PROMOTIONS: debug log for promo presence
    const promoInfo = _extractPromoInfo(quoteData);
    if (promoInfo) {
      console.log('[F-PROMO] ' + documentTitle + ' PDF: ' + (promoInfo.id || '?')
        + ' applied, -$' + promoInfo.amount.toFixed(2)
        + ' across ' + promoInfo.matchedCount + ' line(s)');
    } else if (quoteData && quoteData._promo && quoteData._promo.suppressed_by_markup) {
      console.log('[F-PROMO] ' + documentTitle + ' PDF: promo suppressed by markup mode');
    }

    return { doc, logoImg, y, headerContext };
  }

  /**
   * F4.2 + F-PROMOTIONS: Finalize with totals.
   *
   * F-PROMOTIONS (2026-05-21): When _promo present and not suppressed:
   *   - taxBase     = (markedSubtotal - promoDiscount) + taxableModsTotal
   *   - billingBase = (markedSubtotal - promoDiscount) + modsTotal
   *   - grand       = billingBase + assembly + shipping + tax
   *   Subtotal row in PDF still shows PRE-discount markedSubtotal so dealer
   *   sees the original price before the deduction (as a separate row).
   */
  function _finalizeWithTotals(args) {
    const {
      doc, quoteData, items, headerContext, tableEndY, notes,
      showPrices, markupPercent = 0,
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

    // ── F-PROMOTIONS: discount info ──
    const promoInfo = _extractPromoInfo(quoteData);
    const promoDiscount     = promoInfo ? promoInfo.amount : 0;
    const promoLabel        = promoInfo ? promoInfo.label : '';
    const promoMatchedCount = promoInfo ? promoInfo.matchedCount : 0;

    const logisticType    = quoteData.logistic_type || 'pickup';
    const deliveryFee     = parseFloat(quoteData.delivery_fee || 0);
    const pendingShipping = _isPendingShipping(quoteData);

    // ── Shipping resolution — uses POST-discount billing base ──
    // F-PROMOTIONS: shipping bracket uses post-discount base to avoid dealers
    // hitting a higher shipping tier just because we hadn't deducted the promo.
    const billingBase = (markedSubtotal - promoDiscount) + modsTotal;
    let shipping;
    if (pendingShipping) {
      shipping = 0;
    } else if (quoteData.shipping_cost !== null && quoteData.shipping_cost !== undefined) {
      shipping = parseFloat(quoteData.shipping_cost) || 0;
    } else {
      shipping = 0;
      if (logisticType === 'delivery') {
        shipping = deliveryFee;
      } else if (logisticType === 'shipping') {
        if      (billingBase <= 3000)  shipping = 0;
        else if (billingBase <= 6000)  shipping = billingBase * 0.15;
        else if (billingBase <= 9000)  shipping = billingBase * 0.12;
        else if (billingBase <= 12000) shipping = billingBase * 0.10;
        else                            shipping = 0;
      }
    }

    // ── F4.2 + F-PROMOTIONS: Tax base = (SKU - promo) + TAXABLE mods ──
    const taxRate   = quoteData._taxRate || 0;
    const taxExempt = !!quoteData._taxExempt;
    const taxBase   = (markedSubtotal - promoDiscount) + taxableModsTotal;
    const tax       = taxExempt ? 0 : taxBase * taxRate;

    // ── Grand total = billing base + assembly + shipping + tax ──
    // billingBase already has promoDiscount subtracted.
    const grand = billingBase + assembleTotal + (pendingShipping ? 0 : shipping) + tax;

    const totals = {
      subtotal:          markedSubtotal,     // PRE-discount (shown on its own row)
      promoDiscount:     promoDiscount,
      promoLabel:        promoLabel,
      promoMatchedCount: promoMatchedCount,
      modsTotal:         modsTotal,
      assembleTotal:     assembleTotal,
      shipping:          shipping,
      tax:               tax,
      grand:             grand,
    };
    const asmByType = _calcAsmByType(items);

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
    // F-PROMOTIONS: account for extra discount row + sublabel height
    const PROMO_H    = promoDiscount > 0 ? 9 : 0;
    const TOTALS_H   = (assembleTotal > 0 ? 60 : 45) + (modsTotal > 0 ? 6 : 0) + PROMO_H;
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
      totals, asmByType, taxExempt, freeShipping,
      pendingShipping,
      showPrices, startY: y, items,
    });

    _drawFooterBar(doc);
    _addPageNumbers(doc);
  }

  /**
   * F4.2: Packing List finalize — Notes table + T&C, no totals.
   * F-PROMOTIONS: intentionally no discount info (warehouse workflow only).
   */
  function _finalizePackingListWithTcAndNotes(args) {
    const { doc, quoteData, headerContext, tableEndY, notes } = args;
    const { pageW, margin } = LAYOUT;

    let yAfterNotes = tableEndY;
    if (notes && notes.length) {
      yAfterNotes = _drawNotesTable(doc, {
        notes:         notes,
        startY:        tableEndY,
        headerContext: headerContext,
      });
    }

    let y = yAfterNotes + 8;
    const TC_BLOCK_H = 7 * 6 + 16;
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

    _drawTermsAndConditions(doc, { startY: y, maxWidth: 180 });

    _drawFooterBar(doc);
    _addPageNumbers(doc);
  }

  /**
   * 建立 Packing List PDF（無價，給工廠用）
   * F-PROMOTIONS: explicitly NOT showing promo info (warehouse-only doc).
   */
  async function buildPackingListPdf(quoteData, dealer, shippingAddress, options = {}) {
    const { doc, y, headerContext } = await _initDocAndDrawTop(
      quoteData, dealer, shippingAddress, options,
      'PACKING LIST'
    );

    const { tableEndY, notes } = _drawItemTable(doc, {
      items:         quoteData.items,
      mode:          'packing-list',
      startY:        y,
      markupPercent: 0,
      headerContext: headerContext,
    });

    _finalizePackingListWithTcAndNotes({ doc, quoteData, headerContext, tableEndY, notes });

    return doc;
  }

  /**
   * 建立 Invoice PDF（含價，給 dealer / 客戶用）
   * F-PROMOTIONS: Discount row added when _promo present and not markup'd.
   */
  async function buildInvoicePdf(quoteData, dealer, shippingAddress, options = {}) {
    const { markupPercent = 0 } = options;
    const { doc, y, headerContext } = await _initDocAndDrawTop(
      quoteData, dealer, shippingAddress, options,
      'INVOICE'
    );

    const { tableEndY, notes } = _drawItemTable(doc, {
      items:         quoteData.items,
      mode:          'invoice',
      startY:        y,
      markupPercent: markupPercent,
      headerContext: headerContext,
    });

    _finalizeWithTotals({
      doc, quoteData, items: quoteData.items,
      headerContext, tableEndY, notes,
      showPrices: true, markupPercent,
    });

    return doc;
  }

  /**
   * 建立 Draft Quote PDF（Step 3 預覽用）
   * F-PROMOTIONS: respects _promo.suppressed_by_markup — when dealer is
   * previewing with markup>0, promo discount is suppressed (set by step3
   * buildQuoteDataForPdf, this function just reads it).
   */
  async function buildDraftQuotePdf(quoteData, dealer, shippingAddress, options = {}) {
    const { markupPercent = 0 } = options;
    const { doc, y, headerContext } = await _initDocAndDrawTop(
      quoteData, dealer, shippingAddress, options,
      'DRAFT QUOTE'
    );

    const { tableEndY, notes } = _drawItemTable(doc, {
      items:         quoteData.items,
      mode:          'draft-quote',
      startY:        y,
      markupPercent: markupPercent,
      headerContext: headerContext,
    });

    _finalizeWithTotals({
      doc, quoteData, items: quoteData.items,
      headerContext, tableEndY, notes,
      showPrices: true, markupPercent,
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
    _loadImage:               _loadImage,
    _isPendingShipping:       _isPendingShipping,
    _isHiddenMod:             _isHiddenMod,
    _extractPromoInfo:        _extractPromoInfo,                 // F-PROMOTIONS
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
    _drawTotals:             _drawTotals,
    _drawTermsAndConditions: _drawTermsAndConditions,

    buildPackingListPdf: buildPackingListPdf,
    buildInvoicePdf:     buildInvoicePdf,
    buildDraftQuotePdf:  buildDraftQuotePdf,
    getPdfFilename:      getPdfFilename,
  };

})(window);
