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
//     cell with " [CUSTOM]" for rows where item.is_custom === true. Plain
//     ASCII suffix is used because jsPDF AutoTable cells are plain text;
//     coloured/highlighted styling is not supported per-cell without
//     hacky workarounds.
//   • [CUSTOM] tag appears only on the first sub-row of split items to
//     avoid visual noise (consistent with step3 / quote-detail UI).
//   • MSRP is NOT shown in any PDF mode (already true before Phase 6),
//     so the "don't show MSRP for custom items" handover requirement is
//     auto-satisfied.
//
// F-HIDDEN-MODS (2026-05-18):
//   • _isHiddenMod() filters mods that are recorded in DB but should NOT
//     appear in PDF output. Currently filters MF01 value='none' (No Skin).
//   • _buildDescriptionCellText() applies this filter via .filter() BEFORE
//     processing mods. If all mods get filtered out, the cell is treated
//     same as "skipped + empty" (no clutter), matching step3 behavior.
//   • Mirror this in new-quote-step3.html and quote-detail.html.
//
// F-LINE-TOTAL-INCLUDES-ASM (2026-05-21):
//   • PDF table "Total" column now INCLUDES asmFeeTotal:
//       lineTotal = skuLineTotal + modFeeTotal + asmFeeTotal
//     Matches the updated formula in step3.html. The dealer-facing intuition
//     that "Total = sum of the row's $ columns" is now honoured.
//     Bottom totals-section still independently sums Subtotal / Modifications
//     / Assemble Fee / Shipping / Tax, so no double-counting at grand total.
//   • Mirror this change in quote-detail.html when next updated.
//
// F-COL-ABBREVIATIONS (2026-05-21):
//   • Type column values shortened to 3-letter uppercase (BAS / WAL / TAL /
//     ACC / OTH / MOD) and Asm Status to ASM / RTA. Reason: 7-/11-letter
//     values like "Assembled" / "ACCESSORIES" wrap to 2 lines and visually
//     misalign the row. Abbreviations are display-only — underlying DB
//     fields (item.sku_type / item.assemble_status) are unchanged.
//   • TYPE_SHORT_MAP and STATUS_SHORT_MAP centralise the lookups so future
//     additions only touch one place. step3.html and quote-detail.html
//     should mirror these maps for cross-surface consistency.
// ============================================================

(function (global) {
  'use strict';

  // ----------------------------------------
  // 常數
  // ----------------------------------------
  // F-CUSTOM (Phase 6): Added 'OTHER' between ACCESSORIES and MODIFICATION,
  // aligned with new-quote-step3.html and quote-detail.html.
  const TYPE_ORDER = ['BASE', 'WALL', 'TALL', 'ACCESSORIES', 'OTHER', 'MODIFICATION'];

  // F-COL-ABBREVIATIONS (2026-05-21): display-only shortenings to keep
  // table cells single-line. Underlying DB values stay full-length.
  // When adding a new sku_type, append both here and in TYPE_ORDER.
  const TYPE_SHORT_MAP = {
    'BASE':         'BAS',
    'WALL':         'WAL',
    'TALL':         'TAL',
    'ACCESSORIES':  'ACC',
    'OTHER':        'OTH',
    'MODIFICATION': 'MOD',
  };

  // F-COL-ABBREVIATIONS (2026-05-21): assemble_status shortenings.
  // RTA is already 3 letters; Assembled compresses to ASM to match width.
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

  // PDF 顏色（RGB 陣列，給 jsPDF 用）
  const COLORS = {
    darkGreen: [14, 31, 22],
    muted:     [122, 140, 130],
    border:    [221, 216, 204],
    gold:      [201, 168, 76],
    white:     [255, 255, 255],
    pending:   [224, 123, 57],   // C1: orange for pending shipping (matches UI #E07B39)
    note:      [224, 123, 57],   // F4.2: same orange for Note references
    modText:   [62, 90, 66],     // F4.2: green-dark for inline mod lines
  };

  // PDF 版面常數
  const LAYOUT = {
    pageW:    210,   // A4 寬度（mm）
    pageH:    297,   // A4 高度（mm）
    margin:   14,
    headerH:  36,    // header 區塊高度（為了大標題加高 4mm）
  };

  // F4.2: Notes table configuration (mirrors step3)
  const MF_USE_NOTES_TABLE = ['MF06', 'MF07'];
  const NOTES_TABLE_FALLBACK_LENGTH = 40;

  // F-CUSTOM (Phase 6): suffix appended to SKU cell for custom rows
  const CUSTOM_SUFFIX = ' [CUSTOM]';

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
  // F4.2: sub_groups normalization
  //
  // Returns the item's sub_groups array as-is if it exists and is non-empty,
  // otherwise constructs a single-sub fallback from legacy fields
  // (item.modifications + item.modification_status + item.quantity).
  // ─────────────────────────────────────────────────────────────────────────
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
      const c = parseFloat(m && m.cost);
      return s + (isNaN(c) ? 0 : c);
    }, 0);
  }

  function _calcPerSubTaxableModCost(sub) {
    const mods = Array.isArray(sub.modifications) ? sub.modifications : [];
    return mods.reduce(function (s, m) {
      if (!m || m.tax_status !== true) return s;
      const c = parseFloat(m.cost);
      return s + (isNaN(c) ? 0 : c);
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
  // F4.2: Format mod value (handles MF07 object, string, number, boolean)
  // ─────────────────────────────────────────────────────────────────────────
  function _formatModValue(v) {
    if (v == null) return '';
    if (typeof v === 'string')  return v;
    if (typeof v === 'number')  return String(v);
    if (typeof v === 'boolean') return v ? 'Yes' : 'No';
    if (typeof v === 'object') {
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

  // ─────────────────────────────────────────────────────────────────────────
  // F-HIDDEN-MODS (2026-05-18) — Display-layer filter for mods that should be
  // recorded in DB but NOT shown in PDF output.
  //
  // Currently filters:
  //   • MF01 value='none' (No Skin) — dealer actively chose "no skin", cost=0;
  //     showing "Skin: No Skin" in PDF description is noise.
  //
  // Mirror this function in new-quote-step3.html and quote-detail.html so all
  // surfaces apply the same filter. To add more cases, just extend this
  // function — callers (_buildDescriptionCellText) already use it.
  // ─────────────────────────────────────────────────────────────────────────
  function _isHiddenMod(mod) {
    if (!mod) return false;
    if (mod.mf_code === 'MF01' && mod.value === 'none') return true;
    return false;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // C1: Pending shipping detection
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

    // 文件類型大標題
    if (documentTitle) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(16);
      doc.setTextColor(...COLORS.darkGreen);
      doc.text(documentTitle, pageW - margin, 9, { align: 'right' });
    }

    // PO# / 日期 / 工作名
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
  // F4.2: Items 表格繪製 — sub_groups + Mods inline + Notes
  // ----------------------------------------

  /**
   * Build a Description cell string for a given sub.
   * For each mod:
   *   - If shouldUseNotesTable → render as "⚠ See Note №N — {label}"
   *     and push the full detail into notesCollector.
   *   - Else → render as "◆ {label}: {value}"
   *
   * F-HIDDEN-MODS (2026-05-18):
   *   Filter mods via _isHiddenMod() BEFORE the empty-check. If MF01 No Skin
   *   was the only mod, the visibleMods array becomes empty → same treatment
   *   as "skipped + empty" → no warning, no clutter. Matches step3 behavior.
   *
   * @param {Object} ctx
   * @param {Object} ctx.sub
   * @param {Object} ctx.item              parent item (for sku_code + sub_total)
   * @param {string} ctx.skuDesc           sku description (first line of cell)
   * @param {number} ctx.totalSubs         sub_groups.length for this item
   * @param {Object} ctx.notesIndex        { counter: number } shared counter
   * @param {Array}  ctx.notesCollector    output array of note objects
   * @returns {string}
   */
  function _buildDescriptionCellText(ctx) {
    const { sub, item, skuDesc, totalSubs, notesIndex, notesCollector } = ctx;
    const rawMods     = Array.isArray(sub.modifications) ? sub.modifications : [];
    const visibleMods = rawMods.filter(function (m) { return !_isHiddenMod(m); });  // F-HIDDEN-MODS
    const status = sub.modification_status || 'unprocessed';
    const lines  = [];

    // First line: sku_desc
    if (skuDesc) lines.push(skuDesc);

    // Empty mods handling (mirrors step3 B2 logic + F-HIDDEN-MODS route A)
    if (!visibleMods.length) {
      // F-HIDDEN-MODS: if all mods were hidden, same as skipped/configured + empty
      if (rawMods.length > 0) {
        return lines.join('\n');
      }
      // raw was already empty:
      // skipped / configured + empty → no clutter
      if (status === 'skipped' || status === 'configured') {
        return lines.join('\n');
      }
      // unprocessed + empty → real warning
      lines.push('⚠ Modifications pending');
      return lines.join('\n');
    }

    // Mods present — render each line
    visibleMods.forEach(function (m) {
      const label = m.display_label || m.mf_code || 'Modification';
      const useNotes = _shouldUseNotesTable(m);

      if (useNotes) {
        notesIndex.counter += 1;
        const noteNum = notesIndex.counter;
        notesCollector.push({
          num:        noteNum,
          skuCode:    item.sku_code,
          subIndex:   sub.sub_index || 1,
          subTotal:   totalSubs,
          mfCode:     m.mf_code || '',
          label:      label,
          content:    _formatModValue(m.value) || '(no detail)',
        });
        // Use plain ASCII markers (jsPDF default fonts may not render fancy glyphs)
        lines.push(`! See Note No.${noteNum} — ${label}`);
      } else {
        const value = _formatModValue(m.value);
        const valStr = value ? `: ${value}` : '';
        lines.push(`• ${label}${valStr}`);
      }
    });

    return lines.join('\n');
  }

  /**
   * 畫 items 表格（jsPDF AutoTable）— F4.2 multi-sub aware.
   *
   * mode 對應：
   *   'packing-list' = 7 欄（Item# / Door / SKU / Qty / Description / Type / AsmStatus）
   *   'invoice'      = 11 欄（含 Mod Fee col）
   *   'draft-quote'  = 11 欄（含 Mod Fee col, markup applies to unit price only）
   *
   * F-CUSTOM (Phase 6): SKU cell suffixed with " [CUSTOM]" when item.is_custom.
   * Suffix appears on the first sub-row only (mirrors step3 / quote-detail UI).
   *
   * F-COL-ABBREVIATIONS (2026-05-21): Type col uses 3-letter abbreviations
   * (BAS/WAL/TAL/ACC/OTH/MOD) and Asm Status col uses ASM/RTA. Prevents
   * 7-/11-character labels from line-wrapping in narrow columns.
   *
   * F-LINE-TOTAL-INCLUDES-ASM (2026-05-21): For invoice / draft-quote modes,
   * Total col is now Unit×Qty + Mod×Qty + Asm×Qty. Bottom totals-section
   * does NOT change — it independently sums each subtotal, so no double-count.
   *
   * Returns: { tableEndY, notes }  where notes is the collector for renderNotesTable.
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
      head = [['Item#', 'Door Style', 'SKU', 'Qty', 'Description', 'Type', 'Asm Status']];
    } else {
      // F4.2: invoice / draft-quote 改 11 欄，加 Mod Fee
      head = [['Item#', 'Door Style', 'Type', 'SKU', 'Description', 'Asm Status',
               'Qty', 'Unit Price', 'Mod Fee', 'Asm Fee', 'Total']];
    }

    // ── 組 table body ──
    const body = [];
    let itemNum = 0;
    let lastStyle = null;
    const notes = [];
    const notesIndex = { counter: 0 };

    Object.entries(grouped).forEach(([styleName, styleItems]) => {
      styleItems.forEach(item => {
        const subs = _getNormalizedSubGroups(item);
        const isSplit = subs.length > 1;
        const isCustom = !!item.is_custom;  // F-CUSTOM (Phase 6)
        // F-COL-ABBREVIATIONS: pre-compute shortened display strings;
        // raw item.sku_type / item.assemble_status untouched.
        const skuType        = item.sku_type || item.skuType || '';
        const skuTypeShort   = _shortType(skuType);
        const assembleStatus = item.assemble_status || item.type || '';
        const asmStatusShort = _shortStatus(assembleStatus);
        const skuDesc        = item.sku_desc || '';
        const markedUnitPrice = item.unit_price * (1 + markupPercent);

        subs.forEach((sub, subIdx) => {
          itemNum++;
          const isFirstSub = subIdx === 0;

          // Style col: show once per style (only on first sub of first item with new style)
          const showStyle = isFirstSub && (styleName !== lastStyle);
          if (isFirstSub) lastStyle = styleName;
          const styleCell = showStyle ? styleName : '';

          // SKU cell: code + [CUSTOM] suffix (first sub only) + Sub label when split
          // F-CUSTOM (Phase 6): plain-ASCII " [CUSTOM]" suffix marks custom rows
          const subQty = parseInt(sub.qty, 10) || 0;
          const customSuffix = (isCustom && isFirstSub) ? CUSTOM_SUFFIX : '';
          const subLabelLine = isSplit
            ? `\nSub ${subIdx + 1} of ${subs.length}`
            : '';
          const skuCell = `${item.sku_code}${customSuffix}${subLabelLine}`;

          // Description cell: sku_desc + mods (or note refs)
          const descCell = _buildDescriptionCellText({
            sub: sub,
            item: item,
            skuDesc: skuDesc,
            totalSubs: subs.length,
            notesIndex: notesIndex,
            notesCollector: notes,
          });

          if (mode === 'packing-list') {
            // 7 cols, no fees
            body.push([
              `#${itemNum}`,
              styleCell,
              skuCell,
              subQty,
              descCell,
              isFirstSub ? skuTypeShort   : '',  // F-COL-ABBREVIATIONS
              isFirstSub ? asmStatusShort : '',  // F-COL-ABBREVIATIONS
            ]);
          } else {
            // 11 cols, with Mod Fee column
            const perSubModCost = _calcPerSubModCost(sub);
            const modFeeTotal   = perSubModCost * subQty;  // F4.2 Confirm 4: NOT marked up
            const asmFeeTotal   = (item.assemble_fee || 0) * subQty;
            const skuLineTotal  = markedUnitPrice * subQty;
            // F-LINE-TOTAL-INCLUDES-ASM: Total now includes asmFeeTotal so it
            // matches the sum of the row's $ columns. Bottom totals-section
            // remains the source of truth for grand total.
            const lineTotal     = skuLineTotal + modFeeTotal + asmFeeTotal;

            body.push([
              `#${itemNum}`,
              styleCell,
              isFirstSub ? skuTypeShort   : '',  // F-COL-ABBREVIATIONS
              skuCell,
              descCell,
              isFirstSub ? asmStatusShort : '',  // F-COL-ABBREVIATIONS
              subQty,
              `$${markedUnitPrice.toFixed(2)}`,
              modFeeTotal > 0 ? `+$${modFeeTotal.toFixed(2)}` : '—',
              asmFeeTotal > 0 ? `+$${asmFeeTotal.toFixed(2)}` : '—',
              `$${lineTotal.toFixed(2)}`,
            ]);
          }
        });
      });
    });

    // ── 欄寬設定 ──
    // F-COL-ABBREVIATIONS: type/asm-status columns kept at current widths
    // (already conservative); the 3-letter abbreviations comfortably fit so
    // no width tuning is needed. If future labels exceed 3 letters, revisit.
    let columnStyles;
    if (mode === 'packing-list') {
      columnStyles = {
        0: { cellWidth: 11 },
        1: { cellWidth: 38 },
        2: { cellWidth: 24 },
        3: { halign: 'right', cellWidth: 11 },
        4: { cellWidth: 60, overflow: 'linebreak' },
        5: { cellWidth: 14 },
        6: { cellWidth: 22 },
      };
    } else {
      // 11 cols — tighter widths to fit Mod Fee
      columnStyles = {
        0: { cellWidth: 9 },
        1: { cellWidth: 22 },
        2: { cellWidth: 10 },
        3: { cellWidth: 16 },
        4: { cellWidth: 33, overflow: 'linebreak' },
        5: { cellWidth: 14 },
        6: { halign: 'right', cellWidth: 8 },
        7: { halign: 'right', cellWidth: 15 },
        8: { halign: 'right', cellWidth: 13 },
        9: { halign: 'right', cellWidth: 13 },
        10: { halign: 'right', fontStyle: 'bold', cellWidth: 19 },
      };
    }

    const onDrawPage = (data) => {
      if (data.pageNumber > 1 && headerContext) {
        _drawHeader(doc, headerContext);
      }
    };

    // didParseCell hook: colour note-reference lines & sub-continuation rows
    const didParseCell = function (data) {
      // Only style body cells
      if (data.section !== 'body') return;

      // Find which column index is "Description" depending on mode
      const descColIdx = (mode === 'packing-list') ? 4 : 4;

      if (data.column.index === descColIdx) {
        // Description col — keep default styling (mixed content);
        // jsPDF AutoTable doesn't support per-line colouring without breaking
        // into multiple cells, so we rely on the "! See Note No.N —" prefix
        // being visually distinct in plain text.
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
        valign:    'top',
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
      didParseCell: didParseCell,
    });

    return {
      tableEndY: doc.lastAutoTable.finalY,
      notes:     notes,
    };
  }

  // ----------------------------------------
  // F4.2: Notes Table (MF06 / MF07 / long-value mods)
  // ----------------------------------------

  /**
   * Draw the Notes Table below the items table.
   * Skipped if notes array is empty.
   *
   * @returns {number} ending Y position (or startY if nothing drawn)
   */
  function _drawNotesTable(doc, context) {
    const { margin, pageW, headerH } = LAYOUT;
    const { notes, startY, headerContext } = context;

    if (!notes || !notes.length) return startY;

    let y = startY + 6;

    // ── Title bar ──
    // Page break check before drawing
    if (y + 30 > 275) {
      doc.addPage();
      _drawHeader(doc, headerContext);
      y = headerH + 8;
    }

    doc.setFillColor(255, 247, 235);   // very light orange bg
    doc.setDrawColor(...COLORS.note);
    doc.setLineWidth(0.3);
    doc.rect(margin, y - 4, pageW - margin * 2, 8, 'FD');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(...COLORS.note);
    doc.text('MODIFICATION NOTES & CUSTOM DETAILS', margin + 3, y + 1);

    y += 7;

    // ── Notes table ──
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
   * F4.2: Totals now includes a Modifications row between Subtotal and Asm Fee.
   *
   * context.totals = {
   *   subtotal:      number,   // SKU subtotal (markup applied to unit_price)
   *   modsTotal:     number,   // F4.2: ALL mods (taxable + non-taxable), unmarked-up
   *   assembleTotal: number,
   *   shipping:      number,
   *   tax:           number,   // F4.2: tax = taxBase × taxRate (taxBase = SKU + taxableMods)
   *   grand:         number,   // F4.2: grand = SKU + ALL mods + assembly + shipping + tax
   * }
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

    // ── F4.2: Modifications (only if > 0) ──
    if (showPrices && totals.modsTotal > 0) {
      doc.setFontSize(8);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(...COLORS.muted);
      doc.text('Modifications', totalsX, y);
      doc.setTextColor(140, 100, 20);   // gold-ish to match step3 UI
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

      // F-COL-ABBREVIATIONS: use short codes for the by-type breakdown too,
      // so the right-side totals column stays narrow and aligned.
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

    // ── Tax (F4.2 Q3: do NOT disclose taxable base breakdown) ──
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

    // F-CUSTOM (Phase 6): debug log for custom item count in PDF
    if (Array.isArray(quoteData.items)) {
      const customCount = quoteData.items.filter(i => i.is_custom).length;
      if (customCount > 0) {
        console.log('[F-CUSTOM] ' + documentTitle + ' PDF: ' + customCount + ' custom item(s)');
      }
    }

    return { doc, logoImg, y, headerContext };
  }

  /**
   * F4.2: Finalize with totals — now factors in mods + taxable-only tax base.
   *
   * Reads from quoteData if provided:
   *   - modifications_total          (all mods, unmarked-up)
   *   - modifications_total_taxable  (taxable-only subset)
   * Falls back to recomputing from items[].sub_groups[].modifications.
   */
  function _finalizeWithTotals(args) {
    const {
      doc, quoteData, items, headerContext, tableEndY, notes,
      showPrices, markupPercent = 0,
    } = args;
    const { pageW, margin } = LAYOUT;

    // ── SKU subtotal (markup applied to unit_price) ──
    const markedSubtotal = items.reduce(
      (s, i) => s + i.unit_price * (1 + markupPercent) * i.quantity, 0
    );

    // ── Assembly total (no markup) ──
    const assembleTotal = items.reduce(
      (s, i) => s + (i.assemble_fee || 0) * i.quantity, 0
    );

    // ── F4.2: Mods totals (no markup; read from quoteData if available) ──
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

    const logisticType    = quoteData.logistic_type || 'pickup';
    const deliveryFee     = parseFloat(quoteData.delivery_fee || 0);
    const pendingShipping = _isPendingShipping(quoteData);

    // ── Shipping resolution (uses billingBase = SKU + ALL mods) ──
    const billingBase = markedSubtotal + modsTotal;
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

    // ── F4.2: Tax base = SKU + TAXABLE mods only ──
    const taxRate   = quoteData._taxRate || 0;
    const taxExempt = !!quoteData._taxExempt;
    const taxBase   = markedSubtotal + taxableModsTotal;
    const tax       = taxExempt ? 0 : taxBase * taxRate;

    // ── Grand total = billing base + assembly + shipping + tax ──
    const grand = billingBase + assembleTotal + (pendingShipping ? 0 : shipping) + tax;

    const totals = {
      subtotal:      markedSubtotal,
      modsTotal:     modsTotal,
      assembleTotal: assembleTotal,
      shipping:      shipping,
      tax:           tax,
      grand:         grand,
    };
    const asmByType = _calcAsmByType(items);

    // ── Notes table (between items and T&C / totals) ──
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
    const TOTALS_H   = (assembleTotal > 0 ? 60 : 45) + (modsTotal > 0 ? 6 : 0);
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
   */
  function _finalizePackingListWithTcAndNotes(args) {
    const { doc, headerContext, tableEndY, notes } = args;
    const { pageW, margin } = LAYOUT;

    // ── Notes table (between items and T&C) ──
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

    // 分隔線
    doc.setDrawColor(...COLORS.border);
    doc.setLineWidth(0.3);
    doc.line(margin, y, pageW - margin, y);
    y += 6;

    // T&C 比較寬（右邊沒東西）
    _drawTermsAndConditions(doc, { startY: y, maxWidth: 180 });

    _drawFooterBar(doc);
    _addPageNumbers(doc);
  }

  /**
   * 建立 Packing List PDF（無價，給工廠用）
   * F4.2: sub_groups support + mods (no fees) + Notes table at bottom
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

    _finalizePackingListWithTcAndNotes({ doc, headerContext, tableEndY, notes });

    return doc;
  }

  /**
   * 建立 Invoice PDF（含價，給 dealer / 客戶用）
   * F4.2: sub_groups + Mod Fee col + Notes table + Modifications subtotal
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
   * F4.2: same as Invoice but mode='draft-quote'.
   *   Q4: NO markup disclosure footer (dealer's choice — they print as-is).
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
    _TYPE_ORDER: TYPE_ORDER,
    _TYPE_SHORT_MAP:   TYPE_SHORT_MAP,    // F-COL-ABBREVIATIONS
    _STATUS_SHORT_MAP: STATUS_SHORT_MAP,  // F-COL-ABBREVIATIONS
    _shortType:        _shortType,        // F-COL-ABBREVIATIONS
    _shortStatus:      _shortStatus,      // F-COL-ABBREVIATIONS
    _COLORS:     COLORS,
    _LAYOUT:     LAYOUT,
    _MF_USE_NOTES_TABLE:           MF_USE_NOTES_TABLE,           // F4.2
    _NOTES_TABLE_FALLBACK_LENGTH:  NOTES_TABLE_FALLBACK_LENGTH,  // F4.2
    _CUSTOM_SUFFIX:                CUSTOM_SUFFIX,                // F-CUSTOM (Phase 6)

    _typeRank:                _typeRank,
    _groupAndSort:            _groupAndSort,
    _calcAsmByType:           _calcAsmByType,
    _loadImage:               _loadImage,
    _isPendingShipping:       _isPendingShipping,
    _isHiddenMod:             _isHiddenMod,                      // F-HIDDEN-MODS
    _getNormalizedSubGroups:  _getNormalizedSubGroups,           // F4.2
    _calcPerSubModCost:       _calcPerSubModCost,                // F4.2
    _calcPerSubTaxableModCost: _calcPerSubTaxableModCost,        // F4.2
    _calcTotalModsCost:       _calcTotalModsCost,                // F4.2
    _calcTaxableModsCost:     _calcTaxableModsCost,              // F4.2
    _formatModValue:          _formatModValue,                   // F4.2
    _shouldUseNotesTable:     _shouldUseNotesTable,              // F4.2
    _buildDescriptionCellText: _buildDescriptionCellText,        // F4.2

    _drawHeader:             _drawHeader,
    _drawBillShipBlock:      _drawBillShipBlock,
    _drawFooterBar:          _drawFooterBar,
    _addPageNumbers:         _addPageNumbers,
    _drawItemTable:          _drawItemTable,
    _drawNotesTable:         _drawNotesTable,                    // F4.2
    _drawTotals:             _drawTotals,
    _drawTermsAndConditions: _drawTermsAndConditions,

    buildPackingListPdf: buildPackingListPdf,
    buildInvoicePdf:     buildInvoicePdf,
    buildDraftQuotePdf:  buildDraftQuotePdf,
    getPdfFilename:      getPdfFilename,
  };

})(window);
