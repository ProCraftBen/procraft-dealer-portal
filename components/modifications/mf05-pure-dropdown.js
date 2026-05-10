/**
 * MF05 — Pure Dropdown  (E4.1: factory pattern)
 * ============================================================
 * Modification 元件:必選下拉選單,無 toggle,無預設值
 * 業務範例:Hinge Side(Left / Right)
 *
 * E4.1 變更:
 *   ❌ 舊:window.MF.MF05.render(container, mf_params, value)  (單例)
 *   ✅ 新:const inst = window.MF.MF05.create(container, mf_params, value)
 *           inst.getValue() / inst.validate() / inst.calculateCost() / inst.destroy()
 *
 * 同一頁面可建立多個獨立實例,state 不共享。
 *
 * 介面:
 *   create(container, mf_params, current_value) → instance
 *
 *   instance:
 *     getValue()       → string | null
 *     validate()       → { valid, errors }
 *     calculateCost()  → number
 *     destroy()        → void
 *
 * mf_params 結構:
 *   {
 *     dropdown_label: string,       // 顯示在 dropdown 上方的 label
 *     options: string[],            // 選項列表(例如 ["Left", "Right"])
 *     _base_cost?: number           // base cost(由主頁面注入)
 *   }
 *
 * current_value 結構:
 *   string  → 已選擇的選項字串(必須在 options 中)
 *   null    → 未選擇(預設)
 *
 * 規格議題 3:強制主動選擇,不設預設值
 * 共通規則:未選擇時 validate 失敗,主頁面該擋 save
 *
 * 對外通知:
 *   container.dispatchEvent(new CustomEvent('mf-change', {
 *     detail: { mf_code, value, cost }
 *   }))
 * ============================================================
 */
(function () {
  'use strict';

  /**
   * Factory:建立一個 MF05 實例
   * @param {HTMLElement} container
   * @param {Object} mf_params - { dropdown_label, options, _base_cost? }
   * @param {string|null} current_value
   * @returns {Object} instance
   */
  function create(container, mf_params, current_value) {
    // 每次 create 都是獨立 closure
    const state = {
      container: container,
      mf_params: mf_params || {},
      current_value: (typeof current_value === 'string' && current_value !== '')
        ? current_value
        : null,
      cost: 0,
      select: null  // 保留 ref 以便 destroy
    };

    // base cost 由主頁面注入
    state.cost = (typeof state.mf_params._base_cost === 'number')
      ? state.mf_params._base_cost
      : 0;

    function render() {
      const label = escapeHTML(state.mf_params.dropdown_label || 'Please select');
      const options = Array.isArray(state.mf_params.options) ? state.mf_params.options : [];

      // 顯示用 cost,$0 不顯示金額
      const costDisplay = state.cost > 0
        ? `<span style="margin-left:8px;color:#666;font-size:13px;">+$${state.cost.toFixed(2)}</span>`
        : '';

      // 第一個永遠是「-- Please select --」(value="",代表未選)
      const placeholderOption = `
        <option value="" ${state.current_value === null ? 'selected' : ''} disabled>
          -- Please select --
        </option>
      `;

      const optionsHTML = options.map(opt => {
        const optStr = String(opt);
        const safeOpt = escapeHTML(optStr);
        const selected = (state.current_value === optStr) ? 'selected' : '';
        return `<option value="${safeOpt}" ${selected}>${safeOpt}</option>`;
      }).join('');

      container.innerHTML = `
        <div style="font-family:'DM Sans',sans-serif;color:#333;">
          <div style="
            font-size:14px;
            font-weight:500;
            margin-bottom:6px;
          ">
            ${label}${costDisplay}
          </div>

          <select
            data-mf="MF05"
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
            ${optionsHTML}
          </select>
        </div>
      `;

      state.select = container.querySelector('select[data-mf="MF05"]');
      state.select.addEventListener('change', onChange);
    }

    function onChange(e) {
      const value = e.target.value;
      state.current_value = (value === '') ? null : value;

      state.container.dispatchEvent(new CustomEvent('mf-change', {
        bubbles: true,
        detail: {
          mf_code: 'MF05',
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
      const options = Array.isArray(state.mf_params.options) ? state.mf_params.options : [];

      if (state.current_value === null) {
        errors.push('Please select an option.');
      } else if (!options.includes(state.current_value)) {
        errors.push(`Invalid selection: "${state.current_value}".`);
      }

      return {
        valid: errors.length === 0,
        errors: errors
      };
    }

    function calculateCost() {
      return (state.current_value === null) ? 0 : state.cost;
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
    render();

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
  window.MF.MF05 = {
    create: create
  };
})();
