/**
 * MF03 — Pure Yes/No Toggle  (E4.1: factory pattern)
 * ============================================================
 * Modification 元件:純開關 toggle,無 dropdown/input/cost 分支
 * 業務範例:Roll Out Tray、Matching Interior、Prep For Glass、Soft Close
 *
 * E4.1 變更:
 *   ❌ 舊:window.MF.MF03.render(container, mf_params, value)  (單例)
 *   ✅ 新:const inst = window.MF.MF03.create(container, mf_params, value)
 *           inst.getValue() / inst.validate() / inst.calculateCost() / inst.destroy()
 *
 * 同一頁面可建立多個獨立實例,state 不共享。
 *
 * 介面:
 *   create(container, mf_params, current_value) → instance
 *
 *   instance:
 *     getValue()       → boolean
 *     validate()       → { valid, errors }
 *     calculateCost()  → number
 *     destroy()        → void  (移除事件監聽,清空 container)
 *
 * mf_params 結構:
 *   { toggle_label: string, _base_cost?: number }
 *
 * current_value 結構:
 *   true  → toggle 是開啟狀態
 *   false → toggle 是關閉狀態
 *   null  → 初次渲染預設關閉
 *
 * 共通規則 1:toggle = false 時不寫 row(由主頁面在 save 時過濾)
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
   * Factory:建立一個 MF03 實例
   * @param {HTMLElement} container
   * @param {Object} mf_params - { toggle_label, _base_cost? }
   * @param {boolean|null} current_value
   * @returns {Object} instance with { getValue, validate, calculateCost, destroy }
   */
  function create(container, mf_params, current_value) {
    // 每次 create 都是獨立 closure,state 不會跟其他實例共享
    const state = {
      container: container,
      mf_params: mf_params || {},
      current_value: current_value === true,
      cost: 0,
      checkbox: null  // 保留 ref 以便 destroy() 移除 listener
    };

    // base cost 從 mf_params._base_cost 讀(主頁面要把 modification.cost 設進去)
    if (typeof state.mf_params._base_cost === 'number') {
      state.cost = state.mf_params._base_cost;
    }

    function render() {
      const label = escapeHTML(state.mf_params.toggle_label || 'Enable');

      // 顯示用 cost,$0 不顯示金額(避免 UI 雜亂)
      const costDisplay = state.cost > 0
        ? `<span style="margin-left:8px;color:#666;font-size:13px;">+$${state.cost.toFixed(2)}</span>`
        : '';

      container.innerHTML = `
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
            ${state.current_value ? 'checked' : ''}
            style="
              margin-right:8px;
              width:18px;
              height:18px;
              cursor:pointer;
              accent-color:#3e5a42;
            "
          />
          <span>${label}</span>
          ${costDisplay}
        </label>
      `;

      state.checkbox = container.querySelector('input[type="checkbox"]');
      state.checkbox.addEventListener('change', onToggle);
    }

    function onToggle(e) {
      state.current_value = e.target.checked;

      state.container.dispatchEvent(new CustomEvent('mf-change', {
        bubbles: true,
        detail: {
          mf_code: 'MF03',
          value: state.current_value,
          cost: calculateCost()
        }
      }));
    }

    function getValue() {
      return state.current_value;
    }

    function validate() {
      return { valid: true, errors: [] };
    }

    function calculateCost() {
      return state.current_value ? state.cost : 0;
    }

    function destroy() {
      if (state.checkbox) {
        state.checkbox.removeEventListener('change', onToggle);
      }
      if (state.container) {
        state.container.innerHTML = '';
      }
      state.container = null;
      state.checkbox = null;
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
  window.MF.MF03 = {
    create: create
  };
})();
