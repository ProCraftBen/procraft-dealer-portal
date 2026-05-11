/**
 * MF01 — Skin Dropdown  (E4.1: factory pattern; F6: No Skin option)
 * ============================================================
 * Modification 元件:四選一 dropdown(No Skin / Left / Right / Both),Both 倍率 ×2
 * 業務範例:Attach Per Skin (Standard Cabinet / Tall Cabinet)
 *
 * 結構上 = MF05 (pure dropdown) + multiplier 倍率邏輯
 *
 * F6 變更 (2026/5/11):
 *   ✅ 新增第四個選項 "No Skin" (value: "none", cost: 0)
 *   ✅ "No Skin" 設為預設值 (open modal 即為 "none")
 *   ✅ validate(): "none" 視為合法選擇 (不再 require 主動選擇)
 *   ✅ calculateCost(): "none" 永遠回傳 0
 *   ✅ 移除原本的 -- Please select -- placeholder
 *
 * 業務語意:
 *   "none"       → dealer 主動決定不貼 skin (寫入 modifications array)
 *   "left/right" → 單側貼,base_cost * 1
 *   "both"       → 兩側貼,base_cost * 2 (預設)
 *
 *   "none" 與 modal Skip 的差別:
 *     "none" = dealer 進入 modal 並決定不貼 (modification_status: configured)
 *     Skip   = dealer 完全跳過該 SKU (modification_status: skipped, modifications: [])
 *
 * E4.1 變更:
 *   ❌ 舊:window.MF.MF01.render(container, mf_params, value)  (單例)
 *   ✅ 新:const inst = window.MF.MF01.create(container, mf_params, value)
 *           inst.getValue() / inst.validate() / inst.calculateCost() / inst.destroy()
 *
 * 同一頁面可建立多個獨立實例,state 不共享。
 *
 * 介面:
 *   create(container, mf_params, current_value) → instance
 *
 *   instance:
 *     getValue()       → "none" | "left" | "right" | "both"
 *     validate()       → { valid, errors }
 *     calculateCost()  → number
 *     destroy()        → void
 *
 * mf_params 結構:
 *   {
 *     option_left_label: string,    // "Skin Left"
 *     option_right_label: string,   // "Skin Right"
 *     option_both_label: string,    // "Both Sides"
 *     multiplier_left: number,      // 預設 1
 *     multiplier_right: number,     // 預設 1
 *     multiplier_both: number,      // 預設 2
 *     _base_cost: number,           // 主頁面注入的 base cost
 *     _display_label?: string       // 顯示在 dropdown 上方的標題(主頁面注入)
 *   }
 *   (No Skin label 為前端 hardcode,不從 mf_params 讀)
 *
 * current_value 結構:
 *   "none" | "left" | "right" | "both" → 已選擇的選項代碼
 *   null / undefined / 其他 → 預設為 "none"
 *
 * 對外通知:
 *   container.dispatchEvent(new CustomEvent('mf-change', {
 *     detail: { mf_code, value, cost }
 *   }))
 *   value 是 "none" / "left" / "right" / "both"
 * ============================================================
 */
(function () {
  'use strict';

  // F6: 內部選項代碼,加入 "none"
  const OPTION_CODES = ['none', 'left', 'right', 'both'];

  // F6: No Skin 顯示文字 (前端 hardcode)
  const NO_SKIN_LABEL = 'No Skin';

  // 預設 multiplier
  const DEFAULT_MULTIPLIER_LEFT = 1;
  const DEFAULT_MULTIPLIER_RIGHT = 1;
  const DEFAULT_MULTIPLIER_BOTH = 2;

  /**
   * Factory:建立一個 MF01 實例
   * @param {HTMLElement} container
   * @param {Object} mf_params
   * @param {string|null} current_value - "none" | "left" | "right" | "both" | null
   * @returns {Object} instance
   */
  function create(container, mf_params, current_value) {
    // 每次 create 都是獨立 closure
    const state = {
      container: container,
      mf_params: mf_params || {},
      current_value: 'none', // F6: 預設 No Skin
      cost: 0,
      select: null
    };

    // F6: 解析 current_value
    //   有效 value 直接使用;null/undefined/無效值都 fallback 到 "none"
    if (typeof current_value === 'string' && OPTION_CODES.includes(current_value)) {
      state.current_value = current_value;
    }
    // 否則維持預設 "none"

    // base cost 由主頁面注入
    state.cost = (typeof state.mf_params._base_cost === 'number') ? state.mf_params._base_cost : 0;

    function drawUI() {
      // 重繪前先解綁舊 listener(避免 memory leak)
      if (state.select) {
        state.select.removeEventListener('change', onChange);
      }

      const params = state.mf_params;
      const leftLabel = escapeHTML(params.option_left_label || 'Skin Left');
      const rightLabel = escapeHTML(params.option_right_label || 'Skin Right');
      const bothLabel = escapeHTML(params.option_both_label || 'Both Sides');

      // 計算當前 cost(顯示在 header 上方)
      const currentCost = calculateCost();
      const costDisplay = currentCost > 0
        ? `<span style="margin-left:8px;color:#666;font-size:13px;">+$${currentCost.toFixed(2)}</span>`
        : (state.cost > 0
            ? `<span style="margin-left:8px;color:#666;font-size:13px;">from +$${state.cost.toFixed(2)}</span>`
            : '');

      // 計算每個選項的 cost
      const multLeft = (typeof params.multiplier_left === 'number') ? params.multiplier_left : DEFAULT_MULTIPLIER_LEFT;
      const multRight = (typeof params.multiplier_right === 'number') ? params.multiplier_right : DEFAULT_MULTIPLIER_RIGHT;
      const multBoth = (typeof params.multiplier_both === 'number') ? params.multiplier_both : DEFAULT_MULTIPLIER_BOTH;

      const costLeft = state.cost * multLeft;
      const costRight = state.cost * multRight;
      const costBoth = state.cost * multBoth;

      // F6: No Skin 選項 (預設,放第一個,永遠 cost=0)
      const optionNoneHTML = `
        <option value="none" ${state.current_value === 'none' ? 'selected' : ''}>
          ${NO_SKIN_LABEL}
        </option>
      `;

      const optionLeftHTML = `
        <option value="left" ${state.current_value === 'left' ? 'selected' : ''}>
          ${leftLabel}${state.cost > 0 ? ` ($${costLeft.toFixed(2)})` : ''}
        </option>
      `;

      const optionRightHTML = `
        <option value="right" ${state.current_value === 'right' ? 'selected' : ''}>
          ${rightLabel}${state.cost > 0 ? ` ($${costRight.toFixed(2)})` : ''}
        </option>
      `;

      const optionBothHTML = `
        <option value="both" ${state.current_value === 'both' ? 'selected' : ''}>
          ${bothLabel}${state.cost > 0 ? ` ($${costBoth.toFixed(2)})` : ''}
        </option>
      `;

      // dropdown 上方的 header label(主頁面注入 _display_label)
      const headerLabel = escapeHTML(params._display_label || 'Skin');

      state.container.innerHTML = `
        <div style="font-family:'DM Sans',sans-serif;color:#333;">
          <div style="
            font-size:14px;
            font-weight:500;
            margin-bottom:6px;
          ">
            ${headerLabel}${costDisplay}
          </div>

          <select
            data-mf="MF01"
            style="
              width:100%;
              padding:10px;
              font-family:inherit;
              font-size:14px;
              color:#333;
              background:#fff;
              border:1px solid #c5a059;
              border-radius:4px;
              cursor:pointer;
              outline:none;
              appearance:menulist;
            "
            onfocus="this.style.borderColor='#3e5a42'"
            onblur="this.style.borderColor='#c5a059'"
          >
            ${optionNoneHTML}
            ${optionLeftHTML}
            ${optionRightHTML}
            ${optionBothHTML}
          </select>
        </div>
      `;

      state.select = state.container.querySelector('select[data-mf="MF01"]');
      state.select.addEventListener('change', onChange);
    }

    function onChange(e) {
      const value = e.target.value;
      // F6: 不再可能是空字串 (placeholder 已移除),但保留 fallback 安全網
      state.current_value = OPTION_CODES.includes(value) ? value : 'none';

      // 重繪 UI(因為上方 cost 標示要更新)
      drawUI();

      state.container.dispatchEvent(new CustomEvent('mf-change', {
        bubbles: true,
        detail: {
          mf_code: 'MF01',
          value: state.current_value,
          cost: calculateCost()
        }
      }));
    }

    function getValue() {
      return state.current_value;
    }

    // F6: "none" 視為合法,validate 永遠通過
    //   (原本要求 dealer 主動選擇,現在 No Skin 是預設合法選項)
    function validate() {
      const errors = [];

      if (!OPTION_CODES.includes(state.current_value)) {
        errors.push(`Invalid skin selection: "${state.current_value}".`);
      }

      return {
        valid: errors.length === 0,
        errors: errors
      };
    }

    function calculateCost() {
      // F6: "none" 永遠 cost=0
      if (state.current_value === 'none') return 0;

      const params = state.mf_params;
      let multiplier;

      switch (state.current_value) {
        case 'left':
          multiplier = (typeof params.multiplier_left === 'number') ? params.multiplier_left : DEFAULT_MULTIPLIER_LEFT;
          break;
        case 'right':
          multiplier = (typeof params.multiplier_right === 'number') ? params.multiplier_right : DEFAULT_MULTIPLIER_RIGHT;
          break;
        case 'both':
          multiplier = (typeof params.multiplier_both === 'number') ? params.multiplier_both : DEFAULT_MULTIPLIER_BOTH;
          break;
        default:
          return 0;
      }

      return state.cost * multiplier;
    }

    function destroy() {
      if (state.select) {
        state.select.removeEventListener('change', onChange);
      }
      if (state.container) {
        state.container.innerHTML = '';
      }
      state.container = null;
      state.select = null;
    }

    // 初次渲染
    drawUI();

    // 回傳 instance API
    return {
      getValue: getValue,
      validate: validate,
      calculateCost: calculateCost,
      destroy: destroy
    };
  }

  /**
   * HTML escape 工具
   */
  function escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }

  // 全域註冊(只暴露 create)
  window.MF = window.MF || {};
  window.MF.MF01 = {
    create: create
  };
})();
