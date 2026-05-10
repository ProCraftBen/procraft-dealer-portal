/**
 * MF01 — Skin Dropdown  (E4.1: factory pattern)
 * ============================================================
 * Modification 元件:三選一 dropdown(Left/Right/Both),Both 倍率 ×2
 * 業務範例:Attach Per Skin (Standard Cabinet / Tall Cabinet)
 *
 * 結構上 = MF05 (pure dropdown) + multiplier 倍率邏輯
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
 *     getValue()       → "left" | "right" | "both" | null
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
 *
 * current_value 結構:
 *   "left" | "right" | "both" → 已選擇的選項代碼
 *   null → 未選擇(預設)
 *
 * 規格議題 3:強制主動選擇,不設預設值
 * 共通規則:未選擇時 validate 失敗
 *
 * 對外通知:
 *   container.dispatchEvent(new CustomEvent('mf-change', {
 *     detail: { mf_code, value, cost }
 *   }))
 *   value 是 "left" / "right" / "both" / null
 * ============================================================
 */
(function () {
  'use strict';

  // 內部選項代碼(穩定,不隨 label 變動)
  const OPTION_CODES = ['left', 'right', 'both'];

  // 預設 multiplier
  const DEFAULT_MULTIPLIER_LEFT = 1;
  const DEFAULT_MULTIPLIER_RIGHT = 1;
  const DEFAULT_MULTIPLIER_BOTH = 2;

  /**
   * Factory:建立一個 MF01 實例
   * @param {HTMLElement} container
   * @param {Object} mf_params
   * @param {string|null} current_value - "left" | "right" | "both" | null
   * @returns {Object} instance
   */
  function create(container, mf_params, current_value) {
    // 每次 create 都是獨立 closure
    const state = {
      container: container,
      mf_params: mf_params || {},
      current_value: null,
      cost: 0,
      select: null
    };

    // 解析 current_value
    if (typeof current_value === 'string' && OPTION_CODES.includes(current_value)) {
      state.current_value = current_value;
    }

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

      // 組 dropdown options
      const placeholderOption = `
        <option value="" ${state.current_value === null ? 'selected' : ''} disabled>
          -- Please select --
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
            ${placeholderOption}
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
      state.current_value = (value === '') ? null : value;

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

    function validate() {
      const errors = [];

      if (state.current_value === null) {
        errors.push('Please select a skin option.');
      } else if (!OPTION_CODES.includes(state.current_value)) {
        errors.push(`Invalid skin selection: "${state.current_value}".`);
      }

      return {
        valid: errors.length === 0,
        errors: errors
      };
    }

    function calculateCost() {
      if (state.current_value === null) return 0;

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
