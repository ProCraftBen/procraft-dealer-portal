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
//     ⚠ CB-69 已改:mods 一律移至 SKU 下方縮排子列,見下方 CB-69 段。
//   • Packing List: mods shown WITHOUT fees (workers must read notes clearly).
//   • Invoice / Draft Quote: 11-column layout (added Mod Fee col).
//   • Totals: Modifications row inserted between Subtotal and Asm Fee.
//   • Tax base = SKU + TAXABLE mods only (reads m.tax_status from
//     snapshot written by step2.5 handleMfSave). Tax row in PDF
//     does NOT disclose taxable base breakdown (per Ben's Q3 choice).
//   • Markup applies only to Unit Price; Mods and Assembly never marked up.
//   • Mod Fee column displays UN-marked-up cost.
//
// CB-69 (2026-08-18) — PDF 版面重整。本段為現行行為的權威描述,
// 上方 F4.2 段落中與此衝突者一律以本段為準。
//   • F-40:訂單層級 note(quotes.notes)輸出至 PDF,位置在 Bill/Ship 下方、
//     item table 之前(PM Q-1=A:保證第 1 頁)。四種 PDF 皆輸出。
//     ⚠ 兩個 buildQuoteDataForPdf()(step3 / quote-detail)須各自傳入
//       quoteData.notes,否則本檔收不到值 —— 斷點在來源端,不在此。
//   • CB-69:mod 內容留在 SKU 欄內,接在 SKU code 下方換行(PM 定版:B 案)。
//     表格列結構不變 —— 不新增 colSpan 子列。相對改動前唯一的差異是:
//     自由文字類 mod 不再印 [See note No.N],改在同格直接印出全文。
//     ⚠ 曾短暫實作過「另起一列橫跨十欄」的 A 案,已回退。若日後又想改回,
//       請先讀下方欄寬那段 —— A 案會連動加粗範圍與三個金額欄的寬度來源。
//   • Notes table 因此不再被呼叫。_drawNotesTable() 本體保留不刪
//     (PM Q-3=A;清理另開 F-45)。_shouldUseNotesTable() 函式體零改動,
//     語意由「是否進 notes table」改為「是否套用 (no detail) 占位符」。
//   • F-43:Mod Fee 欄寬不足致金額折行(+$150.00 被折成 "+$150.0" / "0")。
//     Mod Fee 14→17.5mm,Asm Fee 14→16mm,Total 16→17.5mm(PM Q-5=B)。
//     B 案下 mod 仍在 SKU 欄,故 SKU 只能讓出 2mm;其餘來自 # 與 Asm? 兩欄
//     的過配。詳見 _drawItemTable 內 columnStyles 上方那段。
//   • F-31:item table 的 autoTable margin 原本未給 bottom,套用預設
//     40pt(14.11mm)→ 表格底線 282.9mm,而 totals / T&C / notes 三處
//     皆以 275mm 為換頁門檻。同一份 PDF 兩套底部基準,戳記(STAMP_Y=281)
//     因此落在 item table 作圖範圍內。修法為補 bottom: 22 對齊 275,
//     不搬動 STAMP_Y。
//   • PDF 不進 i18n(CB-62 Q-56):本檔新增文字一律英文硬編碼。
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
// CB-11 / CB-12 / CB-13 (P1):
//   • 改動 7: DOOR & FRAME SKU 加註「Hinge not included」。
//   • 改動 8: MF03 Matching Interior(no→Wood Interior / yes→Matching Interior)。
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
  };

  // 改動 11: headerH 36 → 52(header 區塊放大,上方更醒目)
  const LAYOUT = {
    pageW:    210,
    pageH:    297,
    margin:   10,
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
  // CB-27: Modifications 按 type 分組(方案 B 明細用)。
  //   ⚠ 三檔逐字同步:pdf-builder.js / new-quote-step3.html / quote-detail.html
  //   • parentPerSubModCost = Σ(cost + 非mapping material) —— 與 _drawItemTable
  //     的 Mod Fee 欄完全一致(mapping material 已搬去獨立 row,不算進來)。
  //   • modFee = parentPerSubModCost × subQty;只計 modFee > 0 的 sub(= 父 row
  //     Mod Fee > 0;mapping-only 的 sub Mod Fee=0 → 不計 ×N、不顯示)。
  //   • type 取父 row,順序走 CB-22 _getTypeOrder;不在清單 → OTHER(放最後)。
  //   回傳 { byType, ordered, modsDisplayTotal }。
  //   mappingMaterialTotal 由 caller 用 (原 modsTotal − modsDisplayTotal) 反推,
  //   保證 Subtotal+Modifications 兩顯示值之和不變。
  // ─────────────────────────────────────────────────────────────────────────
  function _calcModByType(items, constructionType) {
    const order   = _getTypeOrder(constructionType).map(function (t) { return t.toUpperCase(); });
    const byType  = {};
    let modsDisplayTotal = 0;
    (items || []).forEach(function (item) {
      const subs  = _getNormalizedSubGroups(item);
      let ptype = (item.sku_type || item.skuType || OTHER_GROUP_LABEL).toUpperCase();
      if (order.indexOf(ptype) === -1) ptype = OTHER_GROUP_LABEL;   // 不在清單 → OTHER
      subs.forEach(function (sub) {
        const subQty = parseInt(sub.qty, 10) || 0;
        const mods   = Array.isArray(sub.modifications) ? sub.modifications : [];
        let parentPerSubModCost = 0;
        mods.forEach(function (m) {
          const c  = parseFloat(m && m.cost);
          const mt = parseFloat(m && m.material_cost);
          const mq = parseInt(m && m.mapping_qty, 10) || 0;
          const hasMapping = !!(m && m.mapping_sku) && mq > 0;
          parentPerSubModCost += (isNaN(c) ? 0 : c);
          if (!hasMapping) parentPerSubModCost += (isNaN(mt) ? 0 : mt);
        });
        const modFee = parentPerSubModCost * subQty;
        if (modFee > 0) {
          if (!byType[ptype]) byType[ptype] = { qty: 0, modFee: 0 };
          byType[ptype].qty    += subQty;
          byType[ptype].modFee += modFee;
          modsDisplayTotal     += modFee;
        }
      });
    });
    const ordered = order.filter(function (t) { return byType[t]; });
    if (byType[OTHER_GROUP_LABEL]) ordered.push(OTHER_GROUP_LABEL);
    return { byType: byType, ordered: ordered, modsDisplayTotal: modsDisplayTotal };
  }

  function _formatModValue(v) {
    if (v == null) return '';
    if (typeof v === 'string')  return v;
    if (typeof v === 'number')  return String(v);
    if (typeof v === 'boolean') return v ? 'Yes' : 'No';
    if (typeof v === 'object') {
      // F-QTY-SELECTOR: MF03 toggle-with-qty 的 value { enabled, qty }
      //
      // 【守衛對象】僅 MF03(toggle-with-qty 形態),非通用物件處理。
      // 【假設形狀】{ enabled, qty } —— 判斷依據為 qty key 是否存在(正向判斷)。
      // 【變更連動】若 MF03 的 getValue() 結構變更
      //   (components/modifications/mf03-pure-toggle.js),此守衛須同步檢視。
      //
      // 【F-35 教訓|不可改回負向判斷】
      //   前一版條件為「有 enabled、且無 value/selected/label」,
      //   即以「排除其他元件的 key」定義。MF07 v3 移除 selected 後,
      //   四個條件全數通過,MF07 誤入本分支並回傳 'Yes',
      //   潛伏整個 MF07 生命週期至 F-35 才被發現。
      //   負向判斷的失效模式是「誤吃」→ 顯示錯值,肉眼不可辨。
      //   正向判斷的失效模式是「漏掉」→ 顯示 label 無值,肉眼可見。
      //   涉及形狀判斷時一律採正向。
      if ('enabled' in v && 'qty' in v) {
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
      // F-35 (D-4): 舊寫法為 JSON.stringify(v),回傳非空字串,
      //   使呼叫端的 `|| '(no detail)'` 永不觸發,並將 cost / taxable
      //   等內部欄位外洩至 dealer 可見的 Detail / Note 欄。
      //   改回 '' 後,既有占位符依原設計運作。
      return '';
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
    // CB-31 改動C:fallback 一併改 SO#(numberLabel 正常必有值,純防呆)
    doc.text(`${numberLabel || 'SO#'} ${poNumber || '—'}`, pageW - margin, 25, { align: 'right' });

    // date / jobName 1.5x(7→10.5)
    doc.setFontSize(10.5);
    doc.text(dateStr, pageW - margin, 33, { align: 'right' });

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10.5);
    doc.setTextColor(40, 40, 40);
    // CB-31 改動D:PDF Job Name 加前綴「Job Name: 」(空值顯示 Job Name: —)
    doc.text('Job Name: ' + (jobName || '—'), pageW - margin, 41, { align: 'right' });
  }

  // 改動 11: Bill To / Ship To 區塊字體 1.5x(7.5→11),行距加大。
  function _drawBillShipBlock(doc, context) {
    const { pageW, margin } = LAYOUT;
    const { dealer, shippingAddress, startY, leadTime, logisticType } = context;

    // ── Ship To 區塊(5 檔鏡像同一份 resolver)──
    const PROCRAFT_PICKUP_LINES = [
      'ProCraft Cabinetry DC LLC',
      '6750 Santa Barbara Court Suite B',
      'Elkridge, MD 21075',
      'Hours: Mon-Fri 8:00 AM - 4:30 PM',
    ];
    const resolveShipTo = function (lType, addr) {
      const t = String(lType || '').toLowerCase();
      if (t === 'pickup') {
        return { title: 'PICK UP LOCATION', lines: PROCRAFT_PICKUP_LINES.slice() };
      }
      const title = (t === 'delivery') ? 'DELIVERY TO' : 'SHIP TO';
      const a = addr || {};
      const cityLine = [
        [a.city, a.state].filter(Boolean).join(', '),
        a.zip_code
      ].filter(Boolean).join(' ');
      const lines = [a.recipient_name, a.address_line, a.address_line2, cityLine, a.phone]
        .filter(function (l) { return l && String(l).trim(); });
      return { title: title, lines: lines };
    };
    // delivery/shipping 正規化地址來源:有 shippingAddress 用它,否則 fallback dealer
    let _shipAddr = null;
    if (String(logisticType || '').toLowerCase() !== 'pickup') {
      _shipAddr = shippingAddress ? shippingAddress : {
        recipient_name: dealer?.company_name,
        address_line:   dealer?.address_line1 || '',
        address_line2:  dealer?.address_line2 || '',
        city:           dealer?.city || '',
        state:          dealer?.state || '',
        zip_code:       dealer?.zip_code || '',
        phone:          dealer?.phone || '',
      };
    }
    const _shipTo = resolveShipTo(logisticType, _shipAddr);

    const billX = margin;
    const shipX = pageW - margin;
    let addrY = startY + 6;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(...COLORS.muted);
    doc.text('BILL TO', billX, addrY);
    doc.text(_shipTo.title, shipX, addrY, { align: 'right' });
    addrY += 7;

    const billLines = [
      dealer?.company_name || '—',
      dealer?.address_line1 || '',
      dealer?.address_line2 || '',
      `${dealer?.city || ''}, ${dealer?.state || ''} ${dealer?.zip_code || ''}`,
    ].filter(l => l.trim());

    const shipLines = _shipTo.lines.length ? _shipTo.lines : ['—'];

    const maxLines = Math.max(billLines.length, shipLines.length);
    for (let i = 0; i < maxLines; i++) {
      doc.setFont('helvetica', i === 0 ? 'bold' : 'normal');
      doc.setFontSize(11);
      doc.setTextColor(40, 40, 40);
      if (billLines[i]) doc.text(billLines[i], billX, addrY);
    if (shipLines[i]) doc.text(shipLines[i], shipX, addrY, { align: 'right' });
      addrY += 6.5;
    }

    // CB-24: Estimated Lead Time —— 緊接 SHIP TO 下方,靠右對齊;無值則不印(沿用 CB-11 判斷)
    if (leadTime) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8);
      const ltVal  = String(leadTime);
      const ltValW = doc.getTextWidth(ltVal);
      doc.setTextColor(...COLORS.modText);
      doc.text(ltVal, shipX, addrY, { align: 'right' });
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7);
      doc.setTextColor(...COLORS.muted);
      doc.text('ESTIMATED LEAD TIME', shipX - ltValW - 2, addrY, { align: 'right' });
      addrY += 4;
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

  // ── CB-50: PDF Traceability Stamp helpers ──────────────────────
  function _roleDisplay(role) {
    const MAP = { super_admin: 'Super Admin', admin: 'Admin', dealer: 'Dealer' };
    return MAP[role] || role || '';
  }

  function _getNYStampTimestamp() {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
      hour12: false, timeZoneName: 'short',
    }).formatToParts(new Date());
    const p = {};
    parts.forEach(function (x) { p[x.type] = x.value; });
    const hh = p.hour === '24' ? '00' : p.hour;
    return `${p.year}-${p.month}-${p.day} ${hh}:${p.minute} ${p.timeZoneName}`;
  }

  function _drawStamp(doc, stamp) {
    if (!stamp || !stamp.mode) return;
    const ts = _getNYStampTimestamp();
    let text;
    if (stamp.mode === 'email') {
      text = `SYSTEM EMAIL COPY · ${ts}`;
    } else if (stamp.mode === 'download') {
      const u        = stamp.user || {};
      const company  = u.company_name || '—';
      const roleDisp = _roleDisplay(u.role);
      text = roleDisp
        ? `Downloaded by: ${company} (${roleDisp}) · ${ts}`
        : `Downloaded by: ${company} · ${ts}`;
    } else {
      return;
    }
    const { margin } = LAYOUT;
    const STAMP_Y = 281;
    const total = doc.getNumberOfPages();
    for (let p = 1; p <= total; p++) {
      doc.setPage(p);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(136, 136, 136);
      doc.text(text, margin, STAMP_Y, { align: 'left' });
    }
    doc.setPage(total);
  }

  // ----------------------------------------
  // F4.2: Items 表格繪製
  // ----------------------------------------

  // CB-7: 只回「mod 文字」放進 SKU 欄(skuDesc 改放 Description 欄)。
  //
  // CB-69:回傳位置不變(仍是 SKU 欄),變的是自由文字類 mod 的內容 ——
  //   由 [See note No.N] 占位改為直接印全文,見下方 _shouldUseNotesTable 分支。
  //
  // notesIndex / notesCollector 兩參數保留但不再寫入 —— 呼叫端仍傳,
  //   移除須連動 _drawItemTable 的回傳與兩支 _finalize*(),屬 F-45 範圍。
  //
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
        // CB-69:自由文字類(MF06 / MF07 / 逾 40 字)不再跨表對照,
        //   直接於 SKU 欄內印出全文,由 overflow:'linebreak' 自然換行。
        //   ⚠ 這是 B 案的必然代價:500 字會把該列拉高。欄寬若再縮,
        //     列高會再漲 —— 兩者的取捨見下方 columnStyles 上方那段。
        //   `|| '(no detail)'` 占位符原樣保留 —— 空 description 落庫防堵
        //   為 F-39,不在本票範圍,此處行為必須與改動前一致。
        lines.push(`• ${label}: ${_formatModValue(m.value) || '(no detail)'}`);
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
        // CB-25: 材料子行(N × MappingSKU)移除 — mapping 改由 _drawItemTable 拆成獨立 row。
      }
    });

    return lines.join('\n');
  }

  function _drawItemTable(doc, context) {
    const { margin, headerH } = LAYOUT;
    const {
      items, mode, startY,
      markupPercent = 0,
      constructionType = 'framed', // CB-22
      headerContext,
    } = context;

    const isPacking  = (mode === 'packing-list');
    const showPrices = !isPacking;
    const colCount   = isPacking ? 6 : 10;
    const bodyFs     = isPacking ? 11 : 9;
    const headFs     = isPacking ? bodyFs : 8;

    // CB-25 三層分組底色 + per-item 斑馬(列印取向;皆比 header[14,31,22] 淺)
    const C_SECTION = [62, 90, 66];     // Tier1 section divider(深綠,白字)
    const C_STYLE   = [216, 196, 133];  // Tier2 style divider(金褐)
    const C_TYPE    = [188, 208, 191];  // Tier3 type divider(中綠,比舊[235,240,236]深)
    const C_ZEBRA   = [220, 220, 214];  // 隔一個 item 上色(白 item 不上色)

    const head = isPacking
      ? [['#', 'Type', 'Qty', 'SKU', 'Description', 'Asm?']]
      : [['#', 'Type', 'Qty', 'SKU', 'Description', 'Asm?',
          'Unit Price', 'Mod Fee', 'Asm Fee', 'Total']];

    const body = [];
    const rowFills = [];        // 與 body 等長;per-item 斑馬底色([r,g,b] 或 null)
    let itemNum = 0;
    let itemColorIdx = 0;       // 每個 item +1,決定斑馬輪替
    const notes = [];
    const notesIndex = { counter: 0 };

    function pushDivider(text, fill, textColor) {
      body.push([{
        content: text, colSpan: colCount,
        styles: { halign: 'center', fontStyle: 'bold', fontSize: bodyFs,
                  fillColor: fill, textColor: textColor },
      }]);
      rowFills.push(null);     // divider 自帶底色,不參與斑馬
    }

    // Tier1: Assembled → Unassembled(Assembled 在上)
    const sections = [
      { label: 'ASSEMBLED',   items: (items || []).filter(function (it) { return (it.assemble_status || it.type) !== 'RTA'; }) },
      { label: 'UNASSEMBLED', items: (items || []).filter(function (it) { return (it.assemble_status || it.type) === 'RTA'; }) },
    ];

    sections.forEach(function (section) {
      if (!section.items.length) return;
      // CB-31 改動A:隱藏 Assembled/Unassembled divider（保留程式,日後移除註解即可 unhide）
      // pushDivider('========== ' + section.label + ' ==========', C_SECTION, [255, 255, 255]);

      // Tier2: style_code 字母序
      const byStyle = {};
      section.items.forEach(function (it) {
        const sk = String(it.style_code || '').toUpperCase();
        (byStyle[sk] || (byStyle[sk] = [])).push(it);
      });

      Object.keys(byStyle).sort().forEach(function (styleKey) {
        const styleItems = byStyle[styleKey];
        if (!styleItems.length) return;
        // CB-31 改動B:Door Style divider 顯示 style_name 全名,空值 fallback style_code
        pushDivider('========== ' + (styleItems[0].style_name || styleItems[0].style_code || '—') + ' ==========', C_SECTION, [255, 255, 255]);

        // Tier3: CB-22 type 分組
        _groupByTypeOrdered(styleItems, constructionType).forEach(function (group) {
          pushDivider('========== ' + group.type + ' ==========', C_SECTION, [255, 255, 255]);

          group.items.forEach(function (item) {
            const fill = (itemColorIdx % 2 === 1) ? C_ZEBRA : [255, 255, 255];   // CB-FIX: 白底改顯式白,壓過 autotable striped 預設(divider 仍推 null)
            itemColorIdx++;

            const subs = _getNormalizedSubGroups(item);
            const isSplit = subs.length > 1;
            const isCustom = !!item.is_custom;
            const assembleStatus = item.assemble_status || item.type || '';
            const skuDesc = item.sku_desc || '';
            // CB-47:品項單價一律顯示【原價 × markup】,不含折扣。
            //   揭露模式 → Subtotal 也顯示折前,兩者加總一致,折扣另列三行。
            //   隱藏模式(markup 預覽)→ 整份 PDF 當作沒有折扣,Subtotal 亦為折前。
            //   兩種模式下「品項加總 === Subtotal」皆成立,勿在此處扣折扣。
            const markedUnitPrice = item.unit_price * (1 + markupPercent);
            const _noPrefixType = (item.sku_type || item.skuType || '').toUpperCase();
            const _skipStylePrefix = (_noPrefixType === 'BOX' || _noPrefixType === 'ROLL OUT TRAY');
            const skuPrefix = (item.style_code && !_skipStylePrefix) ? item.style_code + '-' : '';

            subs.forEach(function (sub, subIdx) {
              itemNum++;
              const parentNum = itemNum;
              const isFirstSub = subIdx === 0;
              const subQty = parseInt(sub.qty, 10) || 0;
              const tagCell = item.tag || '';
              const customSuffix = (isCustom && isFirstSub) ? CUSTOM_SUFFIX : '';
              const subLabelLine = isSplit ? `\nSub ${subIdx + 1} of ${subs.length}` : '';

              const isDoorFrame = (item.sku_type || item.skuType || '').toUpperCase() === 'DOOR & FRAME';
              const hingeLine = (isDoorFrame && isFirstSub) ? '• Hinge not included' : '';
              const confirmLine = (item.needs_confirmation && isFirstSub) ? '• Need to check availability' : '';  // CB-29

              // CB-25: 父 row Mod Fee 只留未搬走成本(cost);mapping 的 material 搬到獨立 row
              const mods = Array.isArray(sub.modifications) ? sub.modifications : [];
              let parentPerSubModCost = 0;
              const mappingList = [];
              mods.forEach(function (m) {
                const c  = parseFloat(m && m.cost);
                const mt = parseFloat(m && m.material_cost);
                const mq = parseInt(m && m.mapping_qty, 10) || 0;
                const hasMapping = !!(m && m.mapping_sku) && mq > 0;
                parentPerSubModCost += (isNaN(c) ? 0 : c);
                if (hasMapping) {
                  const matPerSub = isNaN(mt) ? 0 : mt;
                  mappingList.push({
                    code:  m.mapping_sku,
                    type:  (m.mapping_type || ''),          // CB-25: caller 帶入(PDF 無 DB)
                    desc:  (m.mapping_description || ''),
                    tag:   (m.mapping_tag || ''),
                    qty:   mq * subQty,
                    unit:  matPerSub / mq,
                    total: matPerSub * subQty,
                  });
                } else {
                  parentPerSubModCost += (isNaN(mt) ? 0 : mt);  // 無 mapping 的 material 留父 row
                }
              });

              const modsText = _buildModsText({
                sub: sub, item: item, totalSubs: subs.length,
                notesIndex: notesIndex, notesCollector: notes,
                showPrices: showPrices,
              });
              // CB-69(B 案):mod / Hinge / Need-to-check 維持在 SKU 欄內,
              //   接在 SKU code 下方換行。表格列結構不變。
              const extraLines = [hingeLine, confirmLine, modsText].filter(Boolean).join('\n');
              const skuCellText = `${skuPrefix}${item.sku_code}${customSuffix}${subLabelLine}`
                + (extraLines ? `\n${extraLines}` : '');

              const assembledCell = (assembleStatus === 'RTA' ? 'No' : 'Yes');

              if (isPacking) {
                body.push([String(parentNum), tagCell, subQty, skuCellText, skuDesc, assembledCell]);
              } else {
                const modFeeTotal = parentPerSubModCost * subQty;
                const asmFeeTotal = (item.assemble_fee || 0) * subQty;
                // CB-25 改動 C:Total 折前(用 markedUnitPrice,不套促銷折扣)
                const lineTotal   = (markedUnitPrice * subQty) + modFeeTotal + asmFeeTotal;
                body.push([
                  String(parentNum), tagCell, subQty, skuCellText, skuDesc, assembledCell,
                  `$${markedUnitPrice.toFixed(2)}`,
                  modFeeTotal > 0 ? `+$${modFeeTotal.toFixed(2)}` : '—',
                  asmFeeTotal > 0 ? `+$${asmFeeTotal.toFixed(2)}` : '—',
                  `$${lineTotal.toFixed(2)}`,
                ]);
              }
              rowFills.push(fill);

            

              // CB-25: mapping SKU 獨立 row,緊跟父 row,同 item 同色
              mappingList.forEach(function (map, k) {
                const mt2 = (map.type || '').toUpperCase();
                const mapSkip = (mt2 === 'BOX' || mt2 === 'ROLL OUT TRAY');
                const mapPrefix = (item.style_code && !mapSkip) ? item.style_code + '-' : '';
                const mapSku = `${mapPrefix}${map.code}`;
                const mapNum = `${parentNum}.${k + 1}`;
                if (isPacking) {
                  body.push([mapNum, (map.tag || ''), map.qty, mapSku, (map.desc || ''), '—']);
                } else {
                  body.push([
                    mapNum, (map.tag || ''), map.qty, mapSku, (map.desc || ''), '—',
                    `$${map.unit.toFixed(2)}`, '—', '—', `$${map.total.toFixed(2)}`,
                  ]);
                }
                rowFills.push(fill);
              });
            });
          });
        });
      });
    });

    // ── 欄寬(CB-69 重配;取代 改動 12/16/17)────────────────────────────────
    //   預算 = pageW 210 − margin 10×2 = 190mm。超出會被 autotable 壓縮並印警告。
    //   B 案合計 188(Invoice)/ 188(Packing),各留 2mm 餘裕。
    //
    //   所需寬度 = 文字寬 + cellPadding×2(=4mm),於 jspdf 2.5.1 +
    //   autotable 3.8.2(與 CDN 同版)實測:
    //     +$999.99 → 15.74mm   +$9999.99 → 17.29mm   +$99999.99 → 18.84mm
    //     $9999.99 → 15.66mm   $99999.99 → 17.21mm   $999999.99 → 18.76mm
    //   F-43 原始現象:Mod Fee 14mm(內容區 10mm)→ +$150.00(11.74mm)
    //   被折成 ["+$150.0", "0"],快速閱讀會誤讀為 $150.0。
    //
    //   🔴 欄寬是零和,且 B 案下 SKU 欄還要裝 mod 文字,能讓的很有限。
    //      本次三個金額欄合計 +7mm,來源逐筆如下 —— 日後要再加寬任一欄,
    //      必須同樣寫清楚從哪裡拿:
    //        # 欄     12 → 11   (−1;實測最寬內容 "12.1" 只需 10.13mm)
    //        Asm? 欄  18 → 14   (−4;內容僅 Yes/No/—,表頭 "Asm?" 需 11.82mm)
    //        SKU 欄   52 → 50   (−2;再縮列高會明顯上升,見下)
    //        預算餘裕  188 → 190 (−2)
    //
    //   🔴 SKU 欄寬與列高是直接的取捨。實測同一筆(SKU + Sub + Hinge + 500 字 mod):
    //        SKU 50mm →  8 行,列高 33.2mm
    //        SKU 47mm → 10 行,列高 40.5mm
    //      每個帶 mod 的品項多 7mm,一張 15 項的單就多一頁。
    //      為了把 Mod Fee 撐到涵蓋 +$99,999.99 而縮 SKU,買到的是
    //      「單行改動費超過 $9,999.99」這種情形(MF07 warn_threshold 僅 1000),
    //      付出的卻是每一列都要付的列高。故取 17.5 而非 19。
    //
    //   涵蓋範圍:Mod Fee → +$9,999.99 / Asm Fee → +$999.99 / Total → $99,999.99
    //
    //   Packing List 無金額欄,不受 F-43 影響,欄寬原樣不動。
    const columnStyles = isPacking
      ? {
          0: { cellWidth: 10 },
          1: { cellWidth: 14, overflow: 'linebreak' },
          2: { halign: 'right', cellWidth: 14, fontStyle: 'bold' },   // F-31:只粗 Qty
          3: { cellWidth: 64, overflow: 'linebreak' },
          4: { cellWidth: 62, overflow: 'linebreak' },
          5: { cellWidth: 24 },
        }
      : {
          0: { cellWidth: 11 },                                        // 12→11
          1: { cellWidth: 12, overflow: 'linebreak' },
          2: { halign: 'right', cellWidth: 10, fontStyle: 'bold' },    // F-31:只粗 Qty
          3: { cellWidth: 50, overflow: 'linebreak' },                 // 52→50(仍裝 mod 文字,不加粗)
          4: { cellWidth: 24, overflow: 'linebreak' },
          5: { cellWidth: 14 },                                        // 18→14
          6: { halign: 'right', cellWidth: 16,   fontSize: 8 },
          7: { halign: 'right', cellWidth: 17.5, fontSize: 8 },        // F-43 主修:14→17.5
          8: { halign: 'right', cellWidth: 16,   fontSize: 8 },        // Q-5:14→16
          9: { halign: 'right', fontStyle: 'bold', cellWidth: 17.5, fontSize: 8 },  // Q-5:16→17.5(bold 為既有行為)
        };

    const onDrawPage = (data) => {
      if (data.pageNumber > 1 && headerContext) _drawHeader(doc, headerContext);
    };

    // CB-25: per-item 斑馬 — 依 body row index 從 rowFills 上色(取代 alternateRowStyles)
    const onParseCell = (data) => {
      if (data.section !== 'body') return;
      const f = rowFills[data.row.index];
      if (f) data.cell.styles.fillColor = f;
    };

    doc.autoTable({
      startY: startY,
      head: head,
      body: body,
      // 🔴 F-31:bottom 為新增,不可省略。
      //   autotable 3.8.2 對 margin 物件缺漏的邊套用預設 40pt = 14.11mm
      //   → 表格底線 297−14.11 = 282.9mm,而 totals / T&C / notes 三處
      //   一律以 275 為換頁門檻。實測滿版單最後一列底部達 282.31mm,
      //   直接被 STAMP_Y=281 的下載戳記蓋住。
      //   22 = 297 − 275,使四處共用同一條底線;戳記 281 落在 275 與
      //   頁尾條 287 之間的空帶。改此值前請先確認這三個數字的關係。
      margin: { left: margin, right: margin, top: headerH + 4, bottom: 22 },
      styles: { fontSize: bodyFs, cellPadding: 2, textColor: [30, 30, 30], overflow: 'linebreak', valign: 'top' },
      headStyles: { fillColor: COLORS.darkGreen, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: headFs },
      columnStyles: columnStyles,
      didParseCell: onParseCell,
      didDrawPage: onDrawPage,
    });

    return { tableEndY: doc.lastAutoTable.finalY, notes: notes };
  }

  // ----------------------------------------
  // F-40: 訂單層級 Note(quotes.notes)
  // ----------------------------------------
  //
  // 【為什麼在這裡,而不是表格下方】(PM Q-1=A)
  //   這是 dealer 填的特殊指示(交期 / 安裝 / 特殊處理),生產端以 PDF 為
  //   作業依據。放在 Bill/Ship 下方可保證落在第 1 頁;放在表格之後,長單時
  //   會被推到第 2、3 頁。系統收下了指示卻沒傳遞到,責任在系統側。
  //
  // 【為什麼用 autoTable 而不是 rect + text】
  //   quotes.notes 目前無 maxlength(前端補 maxlength 為 F-44),長度不可控。
  //   PM Q-2=A 裁示不截斷 —— 截斷生產指示的風險高於多印一頁。
  //   autoTable 自帶跨頁切割與換頁重畫 header,手刻 rect 做不到這件事。
  //
  // 【四種 PDF 皆輸出】Packing List 是生產端唯一會看的文件,更不能少。
  //
  // ⚠ quoteData.notes 由兩個 buildQuoteDataForPdf() 傳入。若 PDF 上沒出現,
  //   先查來源端有沒有帶這個 key,而不是查這支函式。
  function _drawOrderNote(doc, context) {
    const { margin, headerH } = LAYOUT;
    const { notes, startY, headerContext } = context;

    const text = (notes == null) ? '' : String(notes).trim();
    if (!text) return startY;   // 無 note → 版面與改動前完全一致

    doc.autoTable({
      startY: startY,
      head: [['ORDER NOTES']],   // PDF 不進 i18n(CB-62 Q-56):英文硬編碼
      body: [[text]],
      margin: { left: margin, right: margin, top: headerH + 4, bottom: 22 },
      styles: {
        fontSize: 9,
        cellPadding: 3,
        textColor: [30, 30, 30],
        overflow: 'linebreak',
        valign: 'top',
      },
      headStyles: {
        fillColor: [255, 235, 215],
        textColor: COLORS.note,
        fontStyle: 'bold',
        fontSize: 8,
      },
      bodyStyles: { fillColor: [255, 247, 235] },
      didDrawPage: (data) => {
        if (data.pageNumber > 1 && headerContext) _drawHeader(doc, headerContext);
      },
    });

    return doc.lastAutoTable.finalY + 4;
  }

  // ----------------------------------------
  // F4.2: Notes Table
  // ----------------------------------------
  //
  // ⚠ CB-69 起本函式已無呼叫端 —— mod 內容改由 _drawItemTable 的縮排子列
  //   呈現。函式本體依 PM Q-3=A 保留不刪,清理另開 F-45(CB-69 上線穩定後)。
  //   請勿因「看起來沒人用」而順手移除。
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
   *   Subtotal              $X       (改動 13: 已含 Assemble Fee)
   *   Modifications        +$Z       (only when > 0)
   *   Shipping              $S
   *   Tax                   $T
   *   ────────────────
   *   Order Total           $G
   *
   * 改動 13: Assemble Fee 併入 Subtotal,不再有獨立 Assemble Fee 行。
   * 改動 14: 移除 by-type Assemble Fee 細項。
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
      receipt = null,          // CB-45: 僅產 Receipt 時傳入;Invoice/Draft 為 null
    } = context;

    const totalsX = pageW - margin - 70;
    const valX    = pageW - margin;
    let y = startY;

    // ── Subtotal (CB-27: 純商品 = 父 SKU + mapping material) ──
    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...COLORS.muted);
    doc.text('Subtotal', totalsX, y);
    doc.setTextColor(40, 40, 40);
    // CB-47:有折扣時 Subtotal 顯示折【前】,折後另起一行(D10)。
    //   markup 隱藏模式(showDiscount=false)則直接顯示淨額,且品項單價亦為淨額,
    //   兩者加總一致 —— 交給終端客戶的文件不會對不起來。
    const _subNet   = totals.subtotal + totals.mappingMaterialTotal;
    const _subGross = (totals.subtotalGross == null ? totals.subtotal : totals.subtotalGross)
                      + totals.mappingMaterialTotal;
    doc.text(
      showPrices ? `$${(totals.showDiscount ? _subGross : _subNet).toFixed(2)}` : '—',
      valX, y, { align: 'right' }
    );
    y += 6;

    // ── CB-47: 折扣明細 + Total Discount + Subtotal After Discount ──
    if (showPrices && totals.showDiscount) {
      doc.setFontSize(7);
      (totals.appliedRules || []).forEach(function (r) {
        doc.setTextColor(...COLORS.muted);
        doc.text(String(r.rule_name || 'Discount'), totalsX + 4, y);
        doc.setTextColor(140, 100, 20);
        doc.text(`-$${Number(r.discount_total || 0).toFixed(2)}`, valX, y, { align: 'right' });
        y += 4;
      });
      doc.setFontSize(8);
      doc.setTextColor(...COLORS.muted);
      doc.text('Total Discount', totalsX, y);
      doc.setTextColor(140, 100, 20);
      doc.text(`-$${totals.discountTotal.toFixed(2)}`, valX, y, { align: 'right' });
      y += 6;
      doc.setTextColor(...COLORS.muted);
      doc.text('Subtotal After Discount', totalsX, y);
      doc.setTextColor(40, 40, 40);
      doc.text(`$${_subNet.toFixed(2)}`, valX, y, { align: 'right' });
      y += 6;
    }

    // ── Modifications (CB-27 改動 B: 按 type 分組明細 + Total) ──
    if (showPrices && totals.modsDisplayTotal > 0) {
      // 標題行(無金額)
      doc.setFontSize(8);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(...COLORS.muted);
      doc.text('Modifications', totalsX, y);
      y += 5;
      // 逐 type 明細(縮排)
      doc.setFontSize(7);
      (totals.modByTypeOrdered || []).forEach(function (t) {
        const row = totals.modByType[t];
        doc.setTextColor(...COLORS.muted);
        doc.text(`${_shortType(t)} ×${row.qty}`, totalsX + 4, y);
        doc.setTextColor(140, 100, 20);
        doc.text(`+$${row.modFee.toFixed(2)}`, valX, y, { align: 'right' });
        y += 4;
      });
      // Total 行
      doc.setTextColor(...COLORS.muted);
      doc.text('Total', totalsX + 4, y);
      doc.setTextColor(140, 100, 20);
      doc.text(`+$${totals.modsDisplayTotal.toFixed(2)}`, valX, y, { align: 'right' });
      y += 6;
      doc.setFontSize(8);
    }

    // ── Assemble Fee (CB-27 改動 A: 從 Subtotal 拆出,獨立一行;位置在 Mods 之後) ──
    if (showPrices && totals.assembleTotal > 0) {
      doc.setFontSize(8);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(...COLORS.muted);
      doc.text('Assemble Fee', totalsX, y);
      doc.setTextColor(140, 100, 20);
      doc.text(`+$${totals.assembleTotal.toFixed(2)}`, valX, y, { align: 'right' });
      y += 6;
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

    // ── CB-45 Receipt: Transaction Fee 明細行(Sales Tax 之後、Total 之前)──
    //   讀 payment 存值;費率入 label 括號、右值只留金額。Invoice/Draft/Packing 無 receipt → 不畫。
    if (receipt) {
      const _rPct    = (receipt.feePercentage == null) ? 0 : Number(receipt.feePercentage);
      const _rFeeAmt = Number(receipt.feeAmount || 0);
      doc.setFontSize(8);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(...COLORS.muted);
      doc.text(`Transaction Fee (${_rPct}%)`, totalsX, y);
      doc.setTextColor(40, 40, 40);
      doc.text(`$${_rFeeAmt.toFixed(2)}`, valX, y, { align: 'right' });
      y += 6;
    }

    doc.setDrawColor(...COLORS.border);
    doc.line(totalsX, y, valX, y);
    y += 5;

    // ── Order Total ──
    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...COLORS.darkGreen);
    doc.text(receipt ? 'Total' : 'Order Total', totalsX, y);
    doc.text(
      receipt
        ? `$${Number(receipt.totalPaid || 0).toFixed(2)}`
        : (showPrices ? `$${totals.grand.toFixed(2)}` : '—'),
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

    // ── CB-45 Receipt 專屬結尾 ──
    //   Total(= 貨款 grand + Transaction Fee = total_paid)已在上方 Order Total 行以 receipt
    //   label 顯示。此處續接 Paid / Balance Due,再放 Payment Method 與 PAID·付款時間。
    //   Invoice/Draft/Packing 無 receipt → 整段不執行,輸出與改動前 byte-identical。
    if (receipt) {
      const paid = Number(receipt.totalPaid || 0);

      // Paid(純文字,不 highlight)
      doc.setFontSize(10);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(...COLORS.darkGreen);
      doc.text('Paid', totalsX, y);
      doc.text(`$${paid.toFixed(2)}`, valX, y, { align: 'right' });
      y += 6;

      // Balance Due(= Total − Paid = 0;已付款憑證恆為 0)
      doc.setFontSize(8);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(...COLORS.muted);
      doc.text('Balance Due', totalsX, y);
      doc.setTextColor(40, 40, 40);
      doc.text('$0.00', valX, y, { align: 'right' });
      y += 8;

      doc.setDrawColor(...COLORS.border);
      doc.line(totalsX, y, valX, y);
      y += 5;

      // Payment Method
      const METHOD_LABEL = { card: 'Card', ach: 'ACH', check: 'Check', offline: 'Offline' };
      doc.setFontSize(8);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(...COLORS.muted);
      doc.text('Payment Method', totalsX, y);
      doc.setTextColor(40, 40, 40);
      doc.text(METHOD_LABEL[receipt.paymentMethod] || receipt.paymentMethod || '—', valX, y, { align: 'right' });
      y += 6;

      // PAID · 付款時間(NY 時區,對齊 pdf-builder 其他日期慣例)
      doc.setFontSize(9);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(...COLORS.darkGreen);
      const paidDateStr = receipt.confirmedAt
        ? new Date(receipt.confirmedAt).toLocaleString('en-US', {
            timeZone: 'America/New_York',
            year: 'numeric', month: 'short', day: 'numeric',
            hour: 'numeric', minute: '2-digit',
          })
        : '—';
      doc.text(`PAID · ${paidDateStr}`, valX, y, { align: 'right' });
      y += 5;
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
    doc.setFontSize(9);
    doc.setTextColor(...COLORS.darkGreen);
    doc.text('Terms & Conditions', x, y);
    y += 6;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(60, 60, 60);
    TERMS_AND_CONDITIONS.forEach((item, i) => {
      const lines = doc.splitTextToSize(`${i + 1}. ${item}`, maxWidth);
      doc.text(lines, x, y);
      y += lines.length * 5 + 1.5;
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
      // CB-31 改動C:PDF 顯示 SO#（賣方視角 Sales Order）;DB 欄位 po_number 不動,Draft Quote 仍顯 Draft ID
      numberLabel:   isDraftQuote ? 'Draft ID' : 'SO#',
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
      leadTime: quoteData.estimated_lead_time,   // CB-24: Lead Time 移到 SHIP TO 下方
      logisticType: quoteData.logistic_type,     // Ship To 新規格:pickup/delivery/shipping 切換
    });

    // F-40 (PM Q-1=A):訂單 note 置於 Bill/Ship 下方、item table 之前。
    //   無 note 時原樣回傳 y,版面與改動前一致。
    y = _drawOrderNote(doc, {
      notes:         quoteData.notes,
      startY:        y,
      headerContext: headerContext,
    });

    // F-CUSTOM (Phase 6): debug log for custom item count
    if (Array.isArray(quoteData.items)) {
      const customCount = quoteData.items.filter(i => i.is_custom).length;
      if (customCount > 0) {
        console.log('[F-CUSTOM] ' + documentTitle + ' PDF: ' + customCount + ' custom item(s)');
      }
    }
    return { doc, logoImg, y, headerContext };
  }

  /**
   * F4.2: Finalize with totals.
   *
   *   - taxBase     = markedSubtotal + taxableModsTotal
   *   - billingBase = markedSubtotal + modsTotal
   *   - grand       = billingBase + assembly + shipping + tax
   *
   * 改動 13: Subtotal 顯示值已在 _drawTotals 內併入 assembleTotal;grand 計算不變。
   */
  function _finalizeWithTotals(args) {
    const {
      doc, quoteData, items, headerContext, tableEndY, notes,
      showPrices, markupPercent = 0,
      // CB-47 (Q-A3):true = 整份 PDF【完全忽略折扣】——
      //   Subtotal / Tax / Order Total 全部以折【前】為基礎,且不畫折扣列。
      //   用於 markup 預覽的 Draft Quote:那是 dealer 交給終端客戶的報價,
      //   不能讓客戶看出 dealer 對 ProCraft 有進價折扣。
      //   ⚠️ 絕不可與 receipt 併用 —— 會使 live grand ≠ payments.base_amount,
      //      CB-45 對帳斷言必然 throw。下方已加硬性防護。
      hideDiscount = false,
      receipt = null,          // CB-45: Receipt 模式帶入;Invoice/Draft 為 null
    } = args;
    const { pageW, margin } = LAYOUT;

    // ── CB-47 (D13):折扣的唯一金額載體是 items[].discount_amount ──
    //   本檔【不讀規則、不重算匹配】,只把每 unit 折扣額扣掉。
    //   markedSubtotal 由 gross 減去折扣後即為淨額,taxBase / billingBase / grand
    //   因此全部自動正確,Receipt 的 CB-45 對帳斷言也自動通過。
    //   ⚠️ 勿改回只算 unit_price × qty —— 那會讓 PDF 金額高於 DB grand_total,
    //      Receipt 會直接 throw RECEIPT_RECONCILIATION_MISMATCH。
    const markedSubtotalGross = items.reduce(
      (s, i) => s + i.unit_price * (1 + markupPercent) * i.quantity, 0
    );
    // 硬性防護:Receipt 一律揭露折扣,否則對帳斷言必爆。
    const _hideDisc = hideDiscount && !receipt;
    if (hideDiscount && receipt) {
      console.warn('[CB-47] hideDiscount ignored for Receipt (would break CB-45 reconciliation)');
    }

    const discountLineTotal = _hideDisc ? 0 : items.reduce(
      (s, i) => s + Number(i.discount_amount || 0) * i.quantity, 0
    );
    const markedSubtotal = markedSubtotalGross - discountLineTotal;

    const _appliedRules  = Array.isArray(quoteData.applied_discount_rules)
                             ? quoteData.applied_discount_rules : [];
    const showDiscount   = discountLineTotal > 0.005;

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

    // ── CB-27: Modifications by-type 明細 + Subtotal/Mods 顯示分桶對齊 CB-25 ──
    //   只改「顯示」:把 mapping material 從 Modifications 搬到 Subtotal 顯示,
    //   兩顯示值之和 = 原(subtotal + modsTotal)不變 → tax/billing/grand 全不動。
    const modByType            = _calcModByType(items, quoteData.construction_type);
    const modsDisplayTotal     = modByType.modsDisplayTotal;            // 工本費 Σ(顯示用 Mods 總額)
    const mappingMaterialTotal = modsTotal - modsDisplayTotal;          // 併入 Subtotal 顯示

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

    // ── Shipping resolution — uses billing base ──
    const billingBase = markedSubtotal + modsTotal;
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

    // ── Tax base = SKU + TAXABLE mods ──
    const taxRate   = quoteData._taxRate || 0;
    const taxExempt = !!quoteData._taxExempt;
    const taxBase   = markedSubtotal + taxableModsTotal;
    const tax       = taxExempt ? 0 : taxBase * taxRate;

    // ── Grand total = billing base + assembly + shipping + tax ──
    const grand = billingBase + assembleTotal + (pendingShipping ? 0 : shipping) + tax;

    // ── CB-45 對帳斷言(裁決 Q2):Receipt 專用 ──
    //   Receipt 的 Order Total 走 live 重算 grand(明細五行也是 live),fee/total_paid 讀
    //   payment 列存值。正常流程金額付款後已凍結 → live grand == payment base_amount。
    //   萬一 admin 於付款後動過單(F2 只凍 dealer)導致不一致,fail-loud 擋下,絕不靜默
    //   出「Order Total 與 base+fee 對不上」的矛盾憑證。Invoice/Draft 無 receipt → 不觸發。
    // ── CB-45 Receipt reconciliation guard(整數分比較 + 容許 1 分進位差)──
    //   目的:攔截「付款後改單」等金額不一致情境,fail-loud 擋下,絕不靜默出矛盾憑證。
    //
    //   為何用整數分、且容許 1 分 —— 請勿改回 float > 0.01:
    //   (1) JS 浮點誤差:Math.abs(0.31 - 0.32) === 0.010000000000000009,
    //       用 float > 0.01 比較會在「剛好差 1 分」時 false positive(誤擋)。
    //   (2) Server 端 base_amount(WF1 寫入)與此處由品項即時重算是兩條計算路徑,
    //       稅金四捨五入順序不同 → 正常情況也可能差 1 分。
    //   惡意/誤改單的金額必為「元」級,1 分容差不影響保護力。
    //   對齊業界作法(Stripe / PayPal / QuickBooks 內部一律以 cents 計算)。
    if (receipt) {
      const _liveCents = Math.round(grand * 100);
      const _baseCents = Math.round(Number(receipt.baseAmount) * 100);
      const _diffCents = Math.abs(_liveCents - _baseCents);

      if (_diffCents > 1) {
        console.error('[CB-45] Receipt reconciliation FAILED', {
          liveGrand:         grand,
          paymentBaseAmount: receipt.baseAmount,
          diffCents:         _diffCents,
          poNumber:          quoteData.po_number || null,
        });
        throw new Error('RECEIPT_RECONCILIATION_MISMATCH');
      } else if (_diffCents === 1) {
        // 容差內但確有 1 分差 → 觀察用。若此 warn 變常態,代表 tax rounding 值得優化;
        // 若開始出現 2 分差(改走上方 error),則需 deep debug。
        console.warn('[CB-45] Receipt 1-cent rounding diff (within tolerance)', {
          liveGrand:         grand,
          paymentBaseAmount: receipt.baseAmount,
          poNumber:          quoteData.po_number || null,
        });
      }
    }

    const totals = {
      subtotal:          markedSubtotal,     // 顯示時併入 assembleTotal,見 _drawTotals
      modsTotal:         modsTotal,
      modsDisplayTotal:     modsDisplayTotal,      // CB-27: 顯示用 Mods 總額(工本費 Σ)
      modByType:            modByType.byType,       // CB-27: by-type 明細
      modByTypeOrdered:     modByType.ordered,      // CB-27: 顯示順序(CB-22)
      mappingMaterialTotal: mappingMaterialTotal,   // CB-27: 併入 Subtotal 顯示
      // ── CB-47 顯示用 ──
      subtotalGross:     markedSubtotalGross,
      discountTotal:     discountLineTotal,
      appliedRules:      _appliedRules,
      showDiscount:      showDiscount,
      assembleTotal:     assembleTotal,
      shipping:          shipping,
      tax:               tax,
      grand:             grand,
    };

    // CB-24: Lead Time 已移至 SHIP TO 下方(_drawBillShipBlock),此處不再繪製
    const yLead = tableEndY;

    let yAfterNotes = yLead;
    if (notes && notes.length) {
      yAfterNotes = _drawNotesTable(doc, {
        notes:         notes,
        startY:        yLead,
        headerContext: headerContext,
      });
    }

    let y = yAfterNotes + 8;
    const TC_BLOCK_H = 7 * 9 + 16;
    // CB-27: Modifications 變多行(標題 + N type + Total)、Assemble Fee 獨立一行
    const MODS_H     = modsDisplayTotal > 0 ? (5 + modByType.ordered.length * 4 + 6) : 0;
    const ASM_H      = assembleTotal > 0 ? 6 : 0;
    // CB-47:每 rule 一行 4mm + Total Discount 6mm + Subtotal After Discount 6mm
    const DISC_H     = showDiscount ? (_appliedRules.length * 4 + 12) : 0;
    const TOTALS_H   = 45 + MODS_H + ASM_H + DISC_H;
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
      receipt,               // CB-45: null 時 _drawTotals receipt 區塊不執行
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

    // CB-24: Lead Time 已移至 SHIP TO 下方(_drawBillShipBlock),此處不再繪製
    const yLead = tableEndY;

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
    const TC_BLOCK_H = 7 * 9 + 16;
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
        constructionType: quoteData.construction_type,   // CB-22
        headerContext:    headerContext,
      });

    _finalizePackingListWithTcAndNotes({ doc, quoteData, headerContext, tableEndY, notes });

    _drawStamp(doc, options.stamp);   // CB-50
    return doc;
  }

  /**
   * 建立 Invoice PDF（含價，給 dealer / 客戶用）
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
          constructionType: quoteData.construction_type,   // CB-22
          headerContext:    headerContext,
        });

    _finalizeWithTotals({
      doc, quoteData, items: quoteData.items,
      headerContext, tableEndY, notes,
      showPrices: true, markupPercent,
      hideDiscount: false,           // CB-47
    });

    _drawStamp(doc, options.stamp);   // CB-50
    return doc;
  }

  /**
   * 建立 Receipt PDF（CB-45：付款後已付款憑證）
   * 與 Invoice 同版型(item table mode='invoice'),差異全在 totals 區:
   * 標題 RECEIPT + Payment Method / Transaction Fee / Total Paid / PAID。
   * fee/total_paid 讀 options.receipt(payment 列存值,不現算);產生前於
   * _finalizeWithTotals 內做 live grand vs base_amount 對帳斷言(不一致 fail-loud)。
   */
  async function buildReceiptPdf(quoteData, dealer, shippingAddress, options = {}) {
    const { markupPercent = 0, receipt = null } = options;
    const { doc, y, headerContext } = await _initDocAndDrawTop(
      quoteData, dealer, shippingAddress, options,
      'RECEIPT'
    );

    const { tableEndY, notes } = _drawItemTable(doc, {
          items:            quoteData.items,
          mode:             'invoice',
          startY:           y,
          markupPercent:    markupPercent,
          constructionType: quoteData.construction_type,
          headerContext:    headerContext,
        });

    _finalizeWithTotals({
      doc, quoteData, items: quoteData.items,
      headerContext, tableEndY, notes,
      showPrices: true, markupPercent,
      hideDiscount: false,           // CB-47
      receipt,
    });

    _drawStamp(doc, options.stamp);   // CB-50
    return doc;
  }

  /**
   * 建立 Draft Quote PDF（Step 3 預覽用）
   * 改動 13/14: 與 Invoice 同步 — Assemble Fee 併入 Subtotal,無細項。
   */
  async function buildDraftQuotePdf(quoteData, dealer, shippingAddress, options = {}) {
    const { markupPercent = 0 } = options;
    // ── CB-47 (Q-A3) ──────────────────────────────────────────────────────
    //   Draft Quote 是 dealer 拿去給【終端客戶】看的報價文件,不是對帳單。
    //   若印出「Discount · LSW Framed 10%」等於把 dealer 對 ProCraft 的進價
    //   折扣攤給客戶,故整份 PDF【一律】忽略折扣 —— 含 markup 0% 的情況:
    //     品項單價、Subtotal、Tax、Order Total 全部以折【前】為基礎,不畫折扣列。
    //
    //   ⚠️ 因此 Draft Quote PDF 的 Order Total 會【高於】dealer 實付金額。
    //      這是刻意的:折後真實金額在 Step 3 畫面、quote-detail、Invoice、
    //      Receipt 與確認信都看得到,Draft Quote 唯一的用途是對外報價。
    //      Invoice / Receipt 為 ProCraft ↔ dealer 之間的憑證,一律揭露折扣。
    const _hideDiscount = true;
    const { doc, y, headerContext } = await _initDocAndDrawTop(
      quoteData, dealer, shippingAddress, options,
      'DRAFT QUOTE'
    );

  const { tableEndY, notes } = _drawItemTable(doc, {
        items:            quoteData.items,
        mode:             'draft-quote',
        startY:           y,
        markupPercent:    markupPercent,
        constructionType: quoteData.construction_type,   // CB-22
        headerContext:    headerContext,
      });

    _finalizeWithTotals({
      doc, quoteData, items: quoteData.items,
      headerContext, tableEndY, notes,
      showPrices: true, markupPercent,
      hideDiscount: _hideDiscount,         // CB-47 Q-A3
    });

    _drawStamp(doc, options.stamp);   // CB-50
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
    if (type === 'receipt') {
      return `ProCraft DC - Receipt - ${poNumber || 'Quote'}${versionSuffix}.pdf`;
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
    _drawStamp:              _drawStamp,
    _drawItemTable:          _drawItemTable,
    _drawOrderNote:          _drawOrderNote,                          // F-40
    _drawNotesTable:         _drawNotesTable,
    _drawAssembledSummary:   _drawAssembledSummary,              // 改動 15
    _drawTotals:             _drawTotals,
    _drawTermsAndConditions: _drawTermsAndConditions,

    buildPackingListPdf: buildPackingListPdf,
    buildInvoicePdf:     buildInvoicePdf,
    buildReceiptPdf:     buildReceiptPdf,
    buildDraftQuotePdf:  buildDraftQuotePdf,
    getPdfFilename:      getPdfFilename,
  };

})(window);
