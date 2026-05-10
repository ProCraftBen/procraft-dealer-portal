/**
 * MF07 — SuperModification (Admin Only Text + Custom Cost) v2  (E4.1: factory pattern)
 * ============================================================
 * Modification 元件:admin 自訂收費備註(toggle + textarea + 自訂金額)
 * 業務範例:SuperModification(處理客製需求,沒預設模板的)
 *
 * v2 變更:加 toggle 啟用控制(跟 MF02 / MF04 一致)
 *
 * 結構上 = MF03 (toggle) + MF06 (textarea) + 自訂 cost input + warn UI
 *
 * E4.1 變更:
 *   ❌ 舊:window.MF.MF07.render(container, mf_params, value)  (單例)
 *   ✅ 新:const inst = window.MF.MF07.create(container, mf_params, value)
 *           inst.getValue() / inst.validate() / inst.calculateCost() / inst.destroy()
 *
 * 同一頁面可建立多個獨立實例,state 不共享。
 *
 * 介面:
 *   create(container, mf_params, current_value) → instance
 *
 *   instance:
 *     getValue()       → { enabled, description, cost }
 *     validate()       → { valid, errors }
 *     calculateCost()  → number
 *     destroy()        → void
 *
 * mf_params 結構:
 *   {
 *     toggle_label: string,         // toggle 旁邊文字(可選,有預設值)
 *     textarea_label: string,
 *     cost_label: string,
 *     placeholder: string,
 *     max_length: number,           // 預設 500
 *     min_cost: number,             // 預設 0
 *     max_cost: number,             // 預設 99999
 *     warn_threshold: number        // 預設 1000
 *   }
 *
 * current_value 結構:
 *   { enabled: boolean, description: string, cost: number }
 *   null → 等同 { enabled: false, description: '', cost: 0 }
 *
 * 規格議題 6 已決議:
 *   - warn_threshold $1000:超過顯示警示,不擋 save
 *   - max_cost $99,999:超過 HTML number input 直接擋
 *
 * 共通規則 1:toggle = false 時不寫 row
 *
 * Admin Only:
 *   元件預設「能看到的就是 admin」,不做 role 檢查
 *   UI 上會顯示「Admin Only」醒目標示
 *
 * 對外通知:
 *   container.dispatchEvent(new CustomEvent('mf-change', {
 *     detail: { mf_code, value, cost }
 *   }))
 *   value 是 { enabled, description, cost } 物件
 * ============================================================
 */
(function () {
  'use strict';

  // 預設值
  const DEFAULT_TOGGLE_LABEL = 'Add custom modification?';
  const DEFAULT_MAX_LENGTH = 500;
  const DEFAULT_MIN_COST = 0;
  const DEFAULT_MAX_COST = 99999;
  const DEFAULT_WARN_THRESHOLD = 1000;

  /**
   * Factory:建立一個 MF07 實例
   * @param {HTMLElement} container
   * @param {Object} mf_params
   * @param {Object|null} current_value - { enabled, description, cost } or null
   * @returns {Object} instance
   */
  function create(container, mf_params, current_value) {
    // 每次 create 都是獨立 closure
    const state = {
      container: container,
      mf_params: mf_params || {},
      enabled: false,
      description: '',
      cost: 0,
      max_length: DEFAULT_MAX_LENGTH,
      min_cost: DEFAULT_MIN_COST,
      max_cost: DEFAULT_MAX_COST,
      warn_threshold: DEFAULT_WARN_THRESHOLD,
      toggleEl: null,
      textareaEl: null,
      costEl: null
    };

    // 解析 current_value
    if (current_value && typeof current_value === 'object') {
      state.enabled = current_value.enabled === true;
      state.description = (typeof current_value.description === 'string') ? current_value.description : '';
      state.cost = (typeof current_value.cost === 'number') ? current_value.cost : 0;
    }

    // 設定上下限
    state.max_length = (typeof state.mf_params.max_length === 'number') ? state.mf_params.max_length : DEFAULT_MAX_LENGTH;
    state.min_cost = (typeof state.mf_params.min_cost === 'number') ? state.mf_params.min_cost : DEFAULT_MIN_COST;
    state.max_cost = (typeof state.mf_params.max_cost === 'number') ? state.mf_params.max_cost : DEFAULT_MAX_COST;
    state.warn_threshold = (typeof state.mf_params.warn_threshold === 'number') ? state.mf_params.warn_threshold : DEFAULT_WARN_THRESHOLD;

    function drawUI() {
      // 重繪前先解綁舊 listener
      if (state.toggleEl) {
        state.toggleEl.removeEventListener('change', onToggle);
      }
      if (state.textareaEl) {
        state.textareaEl.removeEventListener('input', onTextareaInput);
      }
      if (state.costEl) {
        state.costEl.removeEventListener('input', onCostInput);
      }

      const params = state.mf_params;
      const toggleLabel = escapeHTML(params.toggle_label || DEFAULT_TOGGLE_LABEL);
      const textareaLabel = escapeHTML(params.textarea_label || 'Description');
      const costLabel = escapeHTML(params.cost_label || 'Custom Cost');
      const placeholder = escapeHTML(params.placeholder || '');

      // Admin Only 醒目標示(永遠顯示)
      const adminBadge = `
        <div style="
          display:flex;
          align-items:center;
          justify-content:space-between;
          margin-bottom:10px;
          padding:6px 10px;
          background:#1b3022;
          color:#c5a059;
          border-radius:4px;
          font-size:12px;
          font-weight:500;
        ">
          <span>SuperModification</span>
          <span style="
            display:inline-flex;
            align-items:center;
            background:#c5a059;
            color:#1b3022;
            padding:2px 8px;
            border-radius:3px;
            font-size:11px;
            font-weight:600;
            letter-spacing:0.5px;
          ">⚠ ADMIN ONLY</span>
        </div>
      `;

      // Toggle 區
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
            data-mf-toggle="MF07"
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
        </label>
      `;

      // 內容區(只有 enabled 時顯示)
      let contentHTML = '';
      if (state.enabled) {
        const charCount = state.description.length;
        const showWarning = state.cost > state.warn_threshold;
        const warningHTML = showWarning ? `
          <div data-mf-warning="1" style="
            margin-top:6px;
            padding:6px 10px;
            background:#fff7e6;
            border:1px solid #f0b950;
            border-radius:4px;
            font-size:12px;
            color:#a06f00;
          ">
            ⚠ Cost exceeds typical $${state.warn_threshold.toFixed(2)} threshold. Please confirm before saving.
          </div>
        ` : '';

        contentHTML = `
          <div style="
            margin-top:10px;
            margin-left:26px;
            padding:12px;
            background:#fff;
            border:1px solid #e0d9c8;
            border-radius:4px;
            font-family:'DM Sans',sans-serif;
          ">
            <!-- Description Textarea -->
            <div style="margin-bottom:14px;">
              <div style="
                font-size:13px;
                color:#555;
                margin-bottom:6px;
              ">${textareaLabel}:</div>

              <textarea
                data-mf-textarea="MF07"
                placeholder="${placeholder}"
                maxlength="${state.max_length}"
                style="
                  width:100%;
                  min-height:70px;
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
              >${escapeHTML(state.description)}</textarea>

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

            <!-- Custom Cost Input -->
            <div data-mf-cost-block="1">
              <div style="
                font-size:13px;
                color:#555;
                margin-bottom:6px;
              ">${costLabel}:</div>

              <div style="display:flex;align-items:center;gap:6px;">
                <span style="
                  font-size:15px;
                  color:#555;
                  font-weight:500;
                ">$</span>
                <input type="number"
                  data-mf-cost="MF07"
                  value="${state.cost}"
                  min="${state.min_cost}"
                  max="${state.max_cost}"
                  step="0.01"
                  style="
                    width:140px;
                    padding:8px 10px;
                    font-family:inherit;
                    font-size:14px;
                    color:#333;
                    background:#fff;
                    border:1px solid #c5a059;
                    border-radius:4px;
                    outline:none;
                  "
                  onfocus="this.style.borderColor='#3e5a42'"
                  onblur="this.style.borderColor='#c5a059'"
                />
              </div>

              <div style="
                margin-top:4px;
                font-size:11px;
                color:#888;
              ">
                Range: $${state.min_cost.toFixed(2)} – $${state.max_cost.toFixed(2)}
              </div>

              ${warningHTML}
            </div>
          </div>
        `;
      }

      state.container.innerHTML = `
        <div style="font-family:'DM Sans',sans-serif;color:#333;">
          ${adminBadge}
          ${toggleHTML}
          ${contentHTML}
        </div>
      `;

      // 綁定事件 + 保留 ref
      state.toggleEl = state.container.querySelector('input[data-mf-toggle="MF07"]');
      state.toggleEl.addEventListener('change', onToggle);

      if (state.enabled) {
        state.textareaEl = state.container.querySelector('textarea[data-mf-textarea="MF07"]');
        state.costEl = state.container.querySelector('input[data-mf-cost="MF07"]');

        state.textareaEl.addEventListener('input', onTextareaInput);
        state.costEl.addEventListener('input', onCostInput);
      } else {
        state.textareaEl = null;
        state.costEl = null;
      }
    }

    function onToggle(e) {
      state.enabled = e.target.checked;

      // toggle 關掉時清空(避免 stale data)
      if (!state.enabled) {
        state.description = '';
        state.cost = 0;
      }

      // 重繪 UI
      drawUI();

      broadcast();
    }

    function onTextareaInput(e) {
      state.description = e.target.value;

      // 更新字元計數(差異更新,不重繪)
      const counter = state.container.querySelector('[data-mf-count]');
      if (counter) {
        counter.textContent = state.description.length;
      }

      broadcast();
    }

    function onCostInput(e) {
      const raw = e.target.value;

      if (raw === '') {
        state.cost = 0;
      } else {
        const parsed = parseFloat(raw);
        state.cost = isNaN(parsed) ? 0 : parsed;
      }

      // 警示 UI 差異更新(不重繪整個元件,維持輸入焦點)
      updateWarningUI();

      broadcast();
    }

    /**
     * 只更新警示 UI(避免重繪整個元件丟失輸入焦點)
     */
    function updateWarningUI() {
      const showWarning = state.cost > state.warn_threshold;
      const costBlock = state.container.querySelector('[data-mf-cost-block]');
      if (!costBlock) return;

      let warningEl = costBlock.querySelector('[data-mf-warning]');

      if (showWarning) {
        if (!warningEl) {
          warningEl = document.createElement('div');
          warningEl.setAttribute('data-mf-warning', '1');
          warningEl.style.cssText = 'margin-top:6px;padding:6px 10px;background:#fff7e6;border:1px solid #f0b950;border-radius:4px;font-size:12px;color:#a06f00;';
          costBlock.appendChild(warningEl);
        }
        warningEl.textContent = `⚠ Cost exceeds typical $${state.warn_threshold.toFixed(2)} threshold. Please confirm before saving.`;
      } else {
        if (warningEl) warningEl.remove();
      }
    }

    function broadcast() {
      state.container.dispatchEvent(new CustomEvent('mf-change', {
        bubbles: true,
        detail: {
          mf_code: 'MF07',
          value: getValue(),
          cost: calculateCost()
        }
      }));
    }

    function getValue() {
      return {
        enabled: state.enabled,
        description: state.enabled ? state.description : '',
        cost: state.enabled ? state.cost : 0
      };
    }

    function validate() {
      const errors = [];

      // toggle = false → 不啟用,直接 valid
      if (!state.enabled) {
        return { valid: true, errors: [] };
      }

      // description 必填
      if (state.description.length === 0) {
        errors.push('Please enter a description.');
      }

      // description 太長
      if (state.description.length > state.max_length) {
        errors.push(`Description exceeds maximum ${state.max_length} characters.`);
      }

      // cost 範圍檢查
      if (state.cost < state.min_cost) {
        errors.push(`Cost must be at least $${state.min_cost.toFixed(2)}.`);
      }
      if (state.cost > state.max_cost) {
        errors.push(`Cost must not exceed $${state.max_cost.toFixed(2)}.`);
      }

      // warn_threshold 不算 validation error,只是 UI 警示

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
      if (state.textareaEl) {
        state.textareaEl.removeEventListener('input', onTextareaInput);
      }
      if (state.costEl) {
        state.costEl.removeEventListener('input', onCostInput);
      }
      if (state.container) {
        state.container.innerHTML = '';
      }
      state.container = null;
      state.toggleEl = null;
      state.textareaEl = null;
      state.costEl = null;
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
  window.MF.MF07 = {
    create: create
  };
})();
