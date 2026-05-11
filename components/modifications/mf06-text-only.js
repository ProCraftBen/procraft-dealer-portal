/**
 * MF06 — Text Only  (E4.1: factory pattern)
 * ============================================================
 * Modification 元件:純文字輸入(textarea),無 cost 計算
 * 業務範例:Modification Note(dealer 自由備註)
 *
 * E4.1 變更:
 *   ❌ 舊:window.MF.MF06.render(container, mf_params, value)  (單例)
 *   ✅ 新:const inst = window.MF.MF06.create(container, mf_params, value)
 *           inst.getValue() / inst.validate() / inst.calculateCost() / inst.destroy()
 *
 * 同一頁面可建立多個獨立實例,state 不共享。
 *
 * 介面:
 *   create(container, mf_params, current_value) → instance
 *
 *   instance:
 *     getValue()       → string
 *     validate()       → { valid, errors }
 *     calculateCost()  → number  (永遠 0)
 *     destroy()        → void
 *
 * mf_params 結構:
 *   {
 *     textarea_label: string,       // 顯示在 textarea 上方的 label
 *     placeholder: string,          // textarea placeholder 文字
 *     max_length: number            // 字元上限(預設 500)
 *   }
 *
 * current_value 結構:
 *   string  → textarea 內的文字
 *   null    → 初次渲染預設空字串
 *
 * 共通規則 1:空字串時不寫 row(由主頁面在 save 時過濾)
 *
 * 對外通知:
 *   container.dispatchEvent(new CustomEvent('mf-change', {
 *     detail: { mf_code, value, cost }
 *   }))
 * ============================================================
 */
(function () {
  'use strict';

  // 預設 max_length(規格定稿:500)
  const DEFAULT_MAX_LENGTH = 500;

  /**
   * Factory:建立一個 MF06 實例
   * @param {HTMLElement} container
   * @param {Object} mf_params - { textarea_label, placeholder, max_length }
   * @param {string|null} current_value
   * @returns {Object} instance
   */
  function create(container, mf_params, current_value) {
    // 每次 create 都是獨立 closure
    const state = {
      container: container,
      mf_params: mf_params || {},
      current_value: (typeof current_value === 'string') ? current_value : '',
      max_length: DEFAULT_MAX_LENGTH,
      textarea: null  // 保留 ref 以便 destroy
    };

    state.max_length = (typeof state.mf_params.max_length === 'number')
      ? state.mf_params.max_length
      : DEFAULT_MAX_LENGTH;

    function render() {
      const label = escapeHTML(state.mf_params.textarea_label || 'Note');
      const placeholder = escapeHTML(state.mf_params.placeholder || '');
      const valueAttr = escapeHTML(state.current_value);
      const charCount = state.current_value.length;

      container.innerHTML = `
        <div style="font-family:'DM Sans',sans-serif;color:#333;">
          <div style="
            font-size:14px;
            font-weight:500;
            margin-bottom:6px;
          ">${label}</div>

          <textarea
            data-mf="MF06"
            placeholder="${placeholder}"
            maxlength="${state.max_length}"
            style="
              width:100%;
              min-height:80px;
              padding:10px;
              font-family:inherit;
              font-size:14px;
              color:#333;
              background:#fff;
              border:1px solid #c5a059;
              border-radius:4px;
              resize:vertical;
              box-sizing:border-box;
              outline:none;
            "
            onfocus="this.style.borderColor='#3e5a42'"
            onblur="this.style.borderColor='#c5a059'"
          >${valueAttr}</textarea>

          <div style="
            display:flex;
            justify-content:flex-end;
            margin-top:4px;
            font-size:12px;
            color:#888;
          ">
            <span data-mf-count>${charCount}</span> / ${state.max_length}
          </div>
        </div>
      `;

      state.textarea = container.querySelector('textarea[data-mf="MF06"]');
      state.textarea.addEventListener('input', onInput);
    }

    function onInput(e) {
      state.current_value = e.target.value;

      // 更新字元計數
      const counter = state.container.querySelector('[data-mf-count]');
      if (counter) {
        counter.textContent = state.current_value.length;
      }

      state.container.dispatchEvent(new CustomEvent('mf-change', {
        bubbles: true,
        detail: {
          mf_code: 'MF06',
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

      if (state.current_value.length > state.max_length) {
        errors.push(`Note exceeds maximum ${state.max_length} characters.`);
      }

      return {
        valid: errors.length === 0,
        errors: errors
      };
    }

    function calculateCost() {
      return 0;
    }

    function destroy() {
      if (state.textarea) {
        state.textarea.removeEventListener('input', onInput);
      }
      if (state.container) {
        state.container.innerHTML = '';
      }
      state.container = null;
      state.textarea = null;
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
  window.MF.MF06 = {
    create: create
  };
})();
