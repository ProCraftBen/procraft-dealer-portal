/**
 * MF04 — Yes/No Toggle + Number Input  (E4.1: factory pattern)
 * ============================================================
 * Modification 元件:可選 toggle,啟用後輸入數字規格
 * 業務範例:Increase Depth、Reduce Depth
 *
 * E4.1 變更:
 *   ❌ 舊:window.MF.MF04.render(container, mf_params, value)  (單例)
 *   ✅ 新:const inst = window.MF.MF04.create(container, mf_params, value)
 *           inst.getValue() / inst.validate() / inst.calculateCost() / inst.destroy()
 *
 * 同一頁面可建立多個獨立實例,state 不共享。
 *
 * 介面:
 *   create(container, mf_params, current_value) → instance
 *
 *   instance:
 *     getValue()       → { enabled, value }
 *     validate()       → { valid, errors }
 *     calculateCost()  → number
 *     destroy()        → void
 *
 * mf_params 結構:
 *   {
 *     toggle_label: string,       // toggle 文字
 *     input_label: string,        // number input 上方 label("Increase to" / "Reduce to")
 *     unit: string,               // 單位文字("inches")
 *     min_value: number,          // 最小值(預設 1)
 *     max_value: number,          // 最大值(規格議題 2:必填)
 *     step: number,               // step(預設 1)
 *     direction: "increase"|"reduce", // UI 顯示用,不影響 cost
 *     _base_cost: number          // 主頁面注入的 base cost
 *   }
 *
 * current_value 結構:
 *   { enabled: boolean, value: number|null }
 *   null → 等同 { enabled: false, value: null }
 *
 * 共通規則 1:toggle = false 時不寫 row
 *
 * 對外通知:
 *   container.dispatchEvent(new CustomEvent('mf-change', {
 *     detail: { mf_code, value, cost }
 *   }))
 *   value 是 { enabled, value } 物件
 * ============================================================
 */
(function () {
  'use strict';

  // 預設值
  const DEFAULT_MIN = 1;
  const DEFAULT_MAX = 99;
  const DEFAULT_STEP = 1;

  /**
   * Factory:建立一個 MF04 實例
   * @param {HTMLElement} container
   * @param {Object} mf_params
   * @param {Object|null} current_value - { enabled, value } or null
   * @returns {Object} instance
   */
  function create(container, mf_params, current_value) {
    // 每次 create 都是獨立 closure
    const state = {
      container: container,
      mf_params: mf_params || {},
      enabled: false,
      value: null,
      cost: 0,
      toggleEl: null,
      inputEl: null
    };

    // 解析 current_value
    if (current_value && typeof current_value === 'object') {
      state.enabled = current_value.enabled === true;
      state.value = (typeof current_value.value === 'number') ? current_value.value : null;
    }

    // base cost 由主頁面注入
    state.cost = (typeof state.mf_params._base_cost === 'number') ? state.mf_params._base_cost : 0;

    function drawUI() {
      // 重繪前先解綁舊 listener(避免 memory leak)
      if (state.toggleEl) {
        state.toggleEl.removeEventListener('change', onToggle);
      }
      if (state.inputEl) {
        state.inputEl.removeEventListener('input', onInput);
      }

      const params = state.mf_params;
      const toggleLabel = escapeHTML(params.toggle_label || 'Enable');
      const inputLabel = escapeHTML(params.input_label || 'Value');
      const unit = escapeHTML(params.unit || '');
      const minValue = (typeof params.min_value === 'number') ? params.min_value : DEFAULT_MIN;
      const maxValue = (typeof params.max_value === 'number') ? params.max_value : DEFAULT_MAX;
      const step = (typeof params.step === 'number') ? params.step : DEFAULT_STEP;

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
            data-mf-toggle="MF04"
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

      // number input 區(只有 enabled 時顯示)
      const inputValueAttr = (state.value !== null) ? `value="${state.value}"` : '';
      const inputHTML = state.enabled ? `
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
          ">${inputLabel}:</label>

          <div style="display:flex;align-items:center;gap:8px;">
            <input type="number"
              data-mf-input="MF04"
              ${inputValueAttr}
              min="${minValue}"
              max="${maxValue}"
              step="${step}"
              placeholder="—"
              style="
                width:90px;
                padding:8px;
                font-family:inherit;
                font-size:14px;
                color:#333;
                background:#fff;
                border:1px solid #c5a059;
                border-radius:4px;
                outline:none;
                text-align:center;
              "
              onfocus="this.style.borderColor='#3e5a42'"
              onblur="this.style.borderColor='#c5a059'"
            />
            <span style="font-size:13px;color:#666;">${unit}</span>
          </div>

          <div style="
            margin-top:6px;
            font-size:11px;
            color:#888;
          ">
            Range: ${minValue} – ${maxValue}
          </div>
        </div>
      ` : '';

      state.container.innerHTML = toggleHTML + inputHTML;

      // 綁定事件 + 保留 ref
      state.toggleEl = state.container.querySelector('input[data-mf-toggle="MF04"]');
      state.toggleEl.addEventListener('change', onToggle);

      if (state.enabled) {
        state.inputEl = state.container.querySelector('input[data-mf-input="MF04"]');
        state.inputEl.addEventListener('input', onInput);
      } else {
        state.inputEl = null;
      }
    }

    function onToggle(e) {
      state.enabled = e.target.checked;

      // toggle 關掉時清空 value(避免 stale data 殘留)
      if (!state.enabled) {
        state.value = null;
      }

      // 重繪 UI(顯示/隱藏 number input)
      drawUI();

      broadcast();
    }

    function onInput(e) {
      const raw = e.target.value;

      if (raw === '') {
        state.value = null;
      } else {
        const parsed = parseFloat(raw);
        state.value = isNaN(parsed) ? null : parsed;
      }

      // 不重繪,維持輸入焦點
      broadcast();
    }

    function broadcast() {
      state.container.dispatchEvent(new CustomEvent('mf-change', {
        bubbles: true,
        detail: {
          mf_code: 'MF04',
          value: getValue(),
          cost: calculateCost()
        }
      }));
    }

    function getValue() {
      return {
        enabled: state.enabled,
        value: state.enabled ? state.value : null
      };
    }

    function validate() {
      const errors = [];

      if (!state.enabled) {
        return { valid: true, errors: [] };
      }

      const params = state.mf_params;
      const minValue = (typeof params.min_value === 'number') ? params.min_value : DEFAULT_MIN;
      const maxValue = (typeof params.max_value === 'number') ? params.max_value : DEFAULT_MAX;

      if (state.value === null || isNaN(state.value)) {
        errors.push('Please enter a value.');
      } else {
        if (state.value < minValue) {
          errors.push(`Value must be at least ${minValue}.`);
        }
        if (state.value > maxValue) {
          errors.push(`Value must not exceed ${maxValue}.`);
        }
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
      if (state.inputEl) {
        state.inputEl.removeEventListener('input', onInput);
      }
      if (state.container) {
        state.container.innerHTML = '';
      }
      state.container = null;
      state.toggleEl = null;
      state.inputEl = null;
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
  window.MF.MF04 = {
    create: create
  };
})();
