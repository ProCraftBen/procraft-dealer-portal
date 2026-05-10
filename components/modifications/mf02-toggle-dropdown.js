/**
 * MF02 — Yes/No Toggle + Dropdown  (E4.1: factory pattern)
 * ============================================================
 * Modification 元件:可選 toggle,啟用後從 dropdown 選一個選項
 * 業務範例:Glass (Single Door / Double Door)
 *
 * 結構上 = MF03 (toggle) + MF05 (dropdown) 的組合體
 *
 * E4.1 變更:
 *   ❌ 舊:window.MF.MF02.render(container, mf_params, value)  (單例)
 *   ✅ 新:const inst = window.MF.MF02.create(container, mf_params, value)
 *           inst.getValue() / inst.validate() / inst.calculateCost() / inst.destroy()
 *
 * 同一頁面可建立多個獨立實例,state 不共享。
 *
 * 介面:
 *   create(container, mf_params, current_value) → instance
 *
 *   instance:
 *     getValue()       → { enabled, selected }
 *     validate()       → { valid, errors }
 *     calculateCost()  → number
 *     destroy()        → void
 *
 * mf_params 結構:
 *   {
 *     toggle_label: string,         // toggle 旁邊文字
 *     dropdown_label: string,       // dropdown 上方 label
 *     dropdown_options: string[],   // 選項列表(注意是 dropdown_options 不是 options)
 *     _base_cost: number            // 主頁面注入的 base cost
 *   }
 *
 * current_value 結構:
 *   { enabled: boolean, selected: string|null }
 *   null → 等同 { enabled: false, selected: null }
 *
 * 規格議題 1 已決議:dropdown 不同選項不收不同價,統一 base cost
 * 共通規則 1:toggle = false 時不寫 row
 *
 * 對外通知:
 *   container.dispatchEvent(new CustomEvent('mf-change', {
 *     detail: { mf_code, value, cost }
 *   }))
 *   value 是 { enabled, selected } 物件
 * ============================================================
 */
(function () {
  'use strict';

  /**
   * Factory:建立一個 MF02 實例
   * @param {HTMLElement} container
   * @param {Object} mf_params
   * @param {Object|null} current_value - { enabled, selected } or null
   * @returns {Object} instance
   */
  function create(container, mf_params, current_value) {
    // 每次 create 都是獨立 closure
    const state = {
      container: container,
      mf_params: mf_params || {},
      enabled: false,
      selected: null,
      cost: 0,
      toggleEl: null,
      dropdownEl: null
    };

    // 解析 current_value
    if (current_value && typeof current_value === 'object') {
      state.enabled = current_value.enabled === true;
      state.selected = (typeof current_value.selected === 'string' && current_value.selected !== '')
        ? current_value.selected
        : null;
    }

    // base cost 由主頁面注入
    state.cost = (typeof state.mf_params._base_cost === 'number') ? state.mf_params._base_cost : 0;

    function drawUI() {
      // 重繪前先解綁舊 listener(避免 memory leak)
      if (state.toggleEl) {
        state.toggleEl.removeEventListener('change', onToggle);
      }
      if (state.dropdownEl) {
        state.dropdownEl.removeEventListener('change', onDropdownChange);
      }

      const params = state.mf_params;
      const toggleLabel = escapeHTML(params.toggle_label || 'Enable');
      const dropdownLabel = escapeHTML(params.dropdown_label || 'Please select');
      const options = Array.isArray(params.dropdown_options) ? params.dropdown_options : [];

      // 顯示用 cost
      const costDisplay = state.cost > 0
        ? `<span style="margin-left:8px;color:#666;font-size:13px;">+$${state.cost.toFixed(2)}</span>`
        : '';

      // toggle 區
      const toggleHTML = `
        <label style="
          display:inline-flex;
          align-items:center;
          cursor:pointer;
          user-select:none;
          font-family:'DM Sans',sans-serif;
          font-size:14px;
          color:#333;
          padding:6px 0;
        ">
          <input type="checkbox"
            data-mf-toggle="MF02"
            ${state.enabled ? 'checked' : ''}
            style="
              margin-right:8px;
              width:18px;
              height:18px;
              cursor:pointer;
              accent-color:#3e5a42;
            "
          />
          <span>${toggleLabel}</span>
          ${costDisplay}
        </label>
      `;

      // dropdown 區(只有 enabled 時顯示)
      let dropdownHTML = '';
      if (state.enabled) {
        // 第一個永遠是 placeholder「-- Please select --」
        const placeholderOption = `
          <option value="" ${state.selected === null ? 'selected' : ''} disabled>
            -- Please select --
          </option>
        `;

        const optionsHTML = options.map(opt => {
          const optStr = String(opt);
          const safeOpt = escapeHTML(optStr);
          const selected = (state.selected === optStr) ? 'selected' : '';
          return `<option value="${safeOpt}" ${selected}>${safeOpt}</option>`;
        }).join('');

        dropdownHTML = `
          <div style="
            margin-top:10px;
            margin-left:26px;
            padding:10px 12px;
            background:#fff;
            border:1px solid #e0d9c8;
            border-radius:4px;
            font-family:'DM Sans',sans-serif;
          ">
            <label style="
              display:block;
              font-size:13px;
              color:#555;
              margin-bottom:6px;
            ">${dropdownLabel}:</label>

            <select
              data-mf-dropdown="MF02"
              style="
                width:100%;
                padding:8px;
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
      }

      state.container.innerHTML = toggleHTML + dropdownHTML;

      // 綁定事件 + 保留 ref
      state.toggleEl = state.container.querySelector('input[data-mf-toggle="MF02"]');
      state.toggleEl.addEventListener('change', onToggle);

      if (state.enabled) {
        state.dropdownEl = state.container.querySelector('select[data-mf-dropdown="MF02"]');
        state.dropdownEl.addEventListener('change', onDropdownChange);
      } else {
        state.dropdownEl = null;
      }
    }

    function onToggle(e) {
      state.enabled = e.target.checked;

      // toggle 關掉時清空 selected(避免 stale data)
      if (!state.enabled) {
        state.selected = null;
      }

      // 重繪 UI(顯示/隱藏 dropdown)
      drawUI();

      broadcast();
    }

    function onDropdownChange(e) {
      const value = e.target.value;
      state.selected = (value === '') ? null : value;

      // 不重繪,維持 dropdown UX
      broadcast();
    }

    function broadcast() {
      state.container.dispatchEvent(new CustomEvent('mf-change', {
        bubbles: true,
        detail: {
          mf_code: 'MF02',
          value: getValue(),
          cost: calculateCost()
        }
      }));
    }

    function getValue() {
      return {
        enabled: state.enabled,
        selected: state.enabled ? state.selected : null
      };
    }

    function validate() {
      const errors = [];

      if (!state.enabled) {
        return { valid: true, errors: [] };
      }

      const options = Array.isArray(state.mf_params.dropdown_options)
        ? state.mf_params.dropdown_options
        : [];

      if (state.selected === null) {
        errors.push('Please select an option.');
      } else if (!options.includes(state.selected)) {
        errors.push(`Invalid selection: "${state.selected}".`);
      }

      return {
        valid: errors.length === 0,
        errors: errors
      };
    }

    function calculateCost() {
      return state.enabled ? state.cost : 0;
    }

    function destroy() {
      if (state.toggleEl) {
        state.toggleEl.removeEventListener('change', onToggle);
      }
      if (state.dropdownEl) {
        state.dropdownEl.removeEventListener('change', onDropdownChange);
      }
      if (state.container) {
        state.container.innerHTML = '';
      }
      state.container = null;
      state.toggleEl = null;
      state.dropdownEl = null;
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
  window.MF.MF02 = {
    create: create
  };
})();
