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
 * F-BINDING-GROUP (2026-05-18):
 *   • 新增 optional mf_params:
 *       _binding_group: string   綁定群組名(例如 "GLASS")
 *       _binding_role: 'primary' | 'dependent'
 *   • broadcast 的 mf-change event detail 多帶 _binding_group +
 *     _binding_role,讓協調者(new-quote-modifications.html)能依此判斷。
 *
 *   • 新增 2 個 instance method,供協調者操控 dependent 元件:
 *       setEnabled(bool)            程式化勾起/取消,不重複 broadcast
 *       setLocked(bool, reason?)    鎖住 UI:checkbox disabled,
 *                                   灰底,label 旁顯示 reason
 *
 *   業務範例:
 *     dealer 在 MF02 Glass 勾起 → 協調者收到 mf-change(detail 含
 *     _binding_group: "GLASS", _binding_role: "primary")
 *       → 找同 group 的 dependent (MF03 Prep For Glass) instance
 *       → 呼叫 setEnabled(true) + setLocked(true, "Required with Glass")
 *     dealer 取消 Glass → 解鎖 (setLocked(false)),但不自動取消
 *     Prep For Glass(dealer 自己可以決定是否取消)。
 *
 * F-QTY-SELECTOR (2026-06-02):
 *   • 新增 optional mf_params.qty_selector,存在時在 toggle 勾起後
 *     顯示數量加減 UI(C 方案:[-] N [+]);不存在則維持純 toggle,
 *     完全向後相容。
 *
 *       qty_selector: {
 *         min: number,        // 預設 1
 *         max: number,        // 預設 = min
 *         default: number,    // clamp 進 [min,max]
 *         label: string       // 預設 "Quantity"
 *       }
 *
 *   • 中間數字為 readonly,只能靠 [-] / [+] 改。[-] 到 min、[+] 到 max
 *     時 disabled(灰化);locked 時兩顆皆 disabled。
 *   • 取消勾後再勾起 → qty 重設為 default(不記憶上次)。
 *   • calculateCost() 維持 flat(不乘 qty);qty 的 ×N(mapping SKU
 *     材料費)由主頁面 bundle 邏輯處理。
 *   • getValue() ↔ create() 對稱:getValue 回 { enabled, qty },
 *     resume 時主頁面把這個物件原樣丟回 create 的 current_value 即可
 *     完整還原勾選狀態 + 數量。
 *
 * 介面:
 *   create(container, mf_params, current_value) → instance
 *
 *   instance:
 *     getValue()             → boolean | { enabled, qty }   (F-QTY-SELECTOR)
 *     validate()             → { valid, errors }
 *     calculateCost()        → number
 *     setEnabled(bool)       → void  (F-BINDING-GROUP)
 *     setLocked(bool, msg?)  → void  (F-BINDING-GROUP)
 *     destroy()              → void
 *
 * mf_params 結構:
 *   {
 *     toggle_label: string,
 *     _base_cost?: number,
 *     _binding_group?: string,   // F-BINDING-GROUP
 *     _binding_role?: string,    // F-BINDING-GROUP: 'primary' | 'dependent'
 *     qty_selector?: {           // F-QTY-SELECTOR
 *       min: number, max: number, default: number, label: string
 *     },
 *   }
 *
 * current_value 結構:
 *   無 qty_selector(純 toggle):
 *     true  → toggle 開啟
 *     false → toggle 關閉
 *     null  → 初次渲染預設關閉
 *   有 qty_selector(F-QTY-SELECTOR,resume 還原):
 *     { enabled: bool, qty: number } → 還原勾選 + 數量(qty clamp 進 min/max)
 *     boolean / null 仍可接受(此時 qty 用 default)
 *
 * 共通規則 1:toggle = false 時不寫 row(由主頁面在 save 時過濾)
 *
 * 對外通知:
 *   container.dispatchEvent(new CustomEvent('mf-change', {
 *     detail: {
 *       mf_code, value, cost,
 *       qty?,                              // F-QTY-SELECTOR(有 qty_selector 時)
 *       _binding_group?, _binding_role?    // F-BINDING-GROUP
 *     }
 *   }))
 * ============================================================
 */
(function () {
  'use strict';

  /**
   * Factory:建立一個 MF03 實例
   * @param {HTMLElement} container
   * @param {Object} mf_params - { toggle_label, _base_cost?, qty_selector? }
   * @param {boolean|null|{enabled:boolean,qty:number}} current_value
   * @returns {Object} instance with { getValue, validate, calculateCost, setEnabled, setLocked, destroy }
   */
  function create(container, mf_params, current_value) {
    // ──────────────────────────────────────────────────────────
    // current_value 可為 boolean(純 toggle)或 { enabled, qty }(qty_selector
    // resume 還原)。先拆出初始勾選狀態 + 可能的還原數量。
    // ──────────────────────────────────────────────────────────
    let initEnabled = false;
    let initQtyFromValue = null;
    if (current_value === true) {
      initEnabled = true;
    } else if (current_value && typeof current_value === 'object') {
      initEnabled = current_value.enabled === true;
      if (typeof current_value.qty === 'number' && isFinite(current_value.qty)) {
        initQtyFromValue = Math.floor(current_value.qty);
      }
    }

    // 每次 create 都是獨立 closure,state 不會跟其他實例共享
    const state = {
      container: container,
      mf_params: mf_params || {},
      current_value: initEnabled,
      cost: 0,
      checkbox: null,        // 保留 ref 以便 destroy() 移除 listener
      // F-QTY-SELECTOR: 數量狀態
      hasQty: false,         // qty_selector 是否存在且有效
      qtyConf: null,         // { min, max, default, label }
      qty: 1,                // 目前數量
      minusBtn: null,        // 保留 ref 以便 destroy() 移除 listener
      plusBtn: null,
      // F-BINDING-GROUP: lock state
      locked: false,
      lockReason: null,
    };

    // base cost 從 mf_params._base_cost 讀(主頁面要把 modification.cost 設進去)
    if (typeof state.mf_params._base_cost === 'number') {
      state.cost = state.mf_params._base_cost;
    }

    // ──────────────────────────────────────────────────────────
    // F-QTY-SELECTOR: 解析 qty_selector(沒有 / 非物件 → 維持純 toggle)
    //   還原優先序:current_value.qty(resume) > qty_selector.default
    // ──────────────────────────────────────────────────────────
    (function parseQtySelector() {
      const qs = state.mf_params.qty_selector;
      if (!qs || typeof qs !== 'object') return;

      const min = (typeof qs.min === 'number' && isFinite(qs.min)) ? Math.floor(qs.min) : 1;
      let max = (typeof qs.max === 'number' && isFinite(qs.max)) ? Math.floor(qs.max) : min;
      if (max < min) max = min;
      let def = (typeof qs.default === 'number' && isFinite(qs.default)) ? Math.floor(qs.default) : min;
      def = clamp(def, min, max);
      const label = (typeof qs.label === 'string' && qs.label) ? qs.label : 'Quantity';

      state.hasQty = true;
      state.qtyConf = { min: min, max: max, default: def, label: label };
      // resume:current_value 帶了 qty 就還原(clamp),否則用 default
      state.qty = (initQtyFromValue !== null) ? clamp(initQtyFromValue, min, max) : def;
    })();

    function render() {
      const label = escapeHTML(state.mf_params.toggle_label || 'Enable');

      // 顯示用 cost,$0 不顯示金額(避免 UI 雜亂)
      const costDisplay = state.cost > 0
        ? `<span style="margin-left:8px;color:#666;font-size:13px;">+$${state.cost.toFixed(2)}</span>`
        : '';

      // F-BINDING-GROUP: 鎖定時的視覺差異
      const isLocked = state.locked;
      const labelCursor = isLocked ? 'not-allowed' : 'pointer';
      const labelOpacity = isLocked ? '0.7' : '1';
      const checkboxCursor = isLocked ? 'not-allowed' : 'pointer';

      const lockedReasonHTML = (isLocked && state.lockReason)
        ? `<span style="margin-left:8px;color:#8B6914;font-size:11px;font-style:italic;font-weight:500;">${escapeHTML(state.lockReason)}</span>`
        : '';

      // ────────────────────────────────────────────────────────
      // F-QTY-SELECTOR: 勾起且有 qty_selector 時才顯示數量列
      //   - 縮排對齊 checkbox 右側(18px + 8px = 26px)
      //   - [-] 到 min / [+] 到 max / locked → disabled 灰化
      //   - 中間數字 readonly,只能靠 +/- 改
      // ────────────────────────────────────────────────────────
      let qtyRowHTML = '';
      if (state.hasQty && state.current_value) {
        const qLabel = escapeHTML(state.qtyConf.label);
        const minusDisabled = isLocked || state.qty <= state.qtyConf.min;
        const plusDisabled  = isLocked || state.qty >= state.qtyConf.max;

        qtyRowHTML = `
          <div style="
            display:flex;
            align-items:center;
            margin-top:6px;
            margin-left:26px;
            font-family:'DM Sans',sans-serif;
            font-size:14px;
            color:#333;
          ">
            <span style="margin-right:10px;">${qLabel}:</span>
            <button type="button" data-qty-act="minus" ${minusDisabled ? 'disabled' : ''}
              style="${qtyBtnStyle(minusDisabled)}">&minus;</button>
            <span style="
              min-width:34px;
              text-align:center;
              font-size:14px;
              font-weight:600;
              color:#333;
              padding:0 4px;
            ">${state.qty}</span>
            <button type="button" data-qty-act="plus" ${plusDisabled ? 'disabled' : ''}
              style="${qtyBtnStyle(plusDisabled)}">+</button>
          </div>
        `;
      }

      container.innerHTML = `
        <label style="
          display:inline-flex;
          align-items:center;
          cursor:${labelCursor};
          user-select:none;
          font-family:'DM Sans',sans-serif;
          font-size:14px;
          color:#333;
          padding:6px 0;
          opacity:${labelOpacity};
        ">
          <input type="checkbox"
            ${state.current_value ? 'checked' : ''}
            ${isLocked ? 'disabled' : ''}
            style="
              margin-right:8px;
              width:18px;
              height:18px;
              cursor:${checkboxCursor};
              accent-color:#3e5a42;
            "
          />
          <span>${label}</span>
          ${costDisplay}
          ${lockedReasonHTML}
        </label>
        ${qtyRowHTML}
      `;

      state.checkbox = container.querySelector('input[type="checkbox"]');
      state.checkbox.addEventListener('change', onToggle);

      // F-QTY-SELECTOR: 綁定 +/- listener(只有數量列存在時才有按鈕)
      state.minusBtn = null;
      state.plusBtn = null;
      if (state.hasQty && state.current_value) {
        state.minusBtn = container.querySelector('button[data-qty-act="minus"]');
        state.plusBtn  = container.querySelector('button[data-qty-act="plus"]');
        if (state.minusBtn) state.minusBtn.addEventListener('click', onMinus);
        if (state.plusBtn)  state.plusBtn.addEventListener('click', onPlus);
      }
    }

    function onToggle(e) {
      // F-BINDING-GROUP: 鎖定時防呆 — 雖然 disabled 已經擋住,但保險再驗一次
      if (state.locked) {
        e.preventDefault();
        e.target.checked = state.current_value;
        return;
      }

      state.current_value = e.target.checked;

      // F-QTY-SELECTOR: 取消勾 → qty 重設為 default(不記憶上次選的);
      //                 有 qty_selector 時需 re-render 以顯示/隱藏數量列。
      //                 無 qty_selector 的路徑維持原本行為(不 re-render)。
      if (state.hasQty) {
        if (!state.current_value) {
          state.qty = state.qtyConf.default;
        }
        render();
      }

      broadcast();
    }

    // ──────────────────────────────────────────────────────────
    // F-QTY-SELECTOR: 數量 −/+(clamp 進 [min,max],之後 re-render + broadcast)
    // ──────────────────────────────────────────────────────────
    function onMinus() {
      if (!state.hasQty || state.locked) return;
      const min = state.qtyConf.min;
      if (state.qty > min) {
        state.qty = clamp(state.qty - 1, min, state.qtyConf.max);
        render();
        broadcast();
      }
    }

    function onPlus() {
      if (!state.hasQty || state.locked) return;
      const max = state.qtyConf.max;
      if (state.qty < max) {
        state.qty = clamp(state.qty + 1, state.qtyConf.min, max);
        render();
        broadcast();
      }
    }

    // ──────────────────────────────────────────────────────────
    // F-BINDING-GROUP: broadcast 時帶上 binding info(只在 mf_params
    // 有設 _binding_group 時才帶)
    // F-QTY-SELECTOR: 有 qty_selector 時 detail 多帶 qty
    // ──────────────────────────────────────────────────────────
    function broadcast() {
      const detail = {
        mf_code: 'MF03',
        value: state.current_value,
        cost: calculateCost()
      };

      // F-QTY-SELECTOR: 有 qty_selector 時帶 qty
      if (state.hasQty) {
        detail.qty = state.qty;
      }

      // F-BINDING-GROUP: 把 binding info 附加到 event detail
      const bindingGroup = state.mf_params._binding_group;
      const bindingRole  = state.mf_params._binding_role;
      if (typeof bindingGroup === 'string' && bindingGroup) {
        detail._binding_group = bindingGroup;
        detail._binding_role  = (typeof bindingRole === 'string' && bindingRole) ? bindingRole : null;
      }

      state.container.dispatchEvent(new CustomEvent('mf-change', {
        bubbles: true,
        detail: detail
      }));
    }

    function getValue() {
      // F-QTY-SELECTOR: 有 qty_selector → 回 object;沒有 → 回 boolean(向後相容)
      if (state.hasQty) {
        return { enabled: state.current_value, qty: state.qty };
      }
      return state.current_value;
    }

    function validate() {
      return { valid: true, errors: [] };
    }

    function calculateCost() {
      // 維持 flat:qty 的 ×N(mapping SKU 材料費)由主頁面 bundle 邏輯處理,
      // MF03 自身 _base_cost 視為固定 modification 費,不隨 qty 變動。
      return state.current_value ? state.cost : 0;
    }

    // ──────────────────────────────────────────────────────────
    // F-BINDING-GROUP: 程式化勾起/取消。
    //   不 broadcast 會導致 liveValues 不更新,所以仍 broadcast。
    //   協調者用 same group + same role 判斷不重複處理,避免迴圈。
    // ──────────────────────────────────────────────────────────
    function setEnabled(bool) {
      const newVal = !!bool;
      if (newVal === state.current_value) return;  // no-op

      state.current_value = newVal;
      render();
      broadcast();  // 更新 liveValues + 觸發 running total 重算
    }

    // ──────────────────────────────────────────────────────────
    // F-BINDING-GROUP: 鎖定 / 解鎖 UI。
    //
    // @param {boolean} bool    true = 鎖住, false = 解鎖
    // @param {string} [reason] 鎖定時顯示在 label 旁的原因
    // ──────────────────────────────────────────────────────────
    function setLocked(bool, reason) {
      const newLocked = !!bool;
      const newReason = (typeof reason === 'string' && reason) ? reason : null;

      if (newLocked === state.locked && newReason === state.lockReason) {
        return;  // no-op
      }

      state.locked = newLocked;
      state.lockReason = newReason;
      render();  // 重繪 UI 顯示鎖定狀態
    }

    function destroy() {
      if (state.checkbox) {
        state.checkbox.removeEventListener('change', onToggle);
      }
      // F-QTY-SELECTOR: 清 +/- listener
      if (state.minusBtn) {
        state.minusBtn.removeEventListener('click', onMinus);
      }
      if (state.plusBtn) {
        state.plusBtn.removeEventListener('click', onPlus);
      }
      if (state.container) {
        state.container.innerHTML = '';
      }
      state.container = null;
      state.checkbox = null;
      state.minusBtn = null;
      state.plusBtn = null;
    }

    // 初次渲染
    render();

    // 回傳 instance API
    return {
      getValue:       getValue,
      validate:       validate,
      calculateCost:  calculateCost,
      setEnabled:     setEnabled,    // F-BINDING-GROUP
      setLocked:      setLocked,     // F-BINDING-GROUP
      destroy:        destroy
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

  /**
   * F-QTY-SELECTOR: clamp 到 [min,max]
   */
  function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
  }

  /**
   * F-QTY-SELECTOR: 數量按鈕樣式(disabled 時灰化,enabled 用品牌綠 #3e5a42)
   */
  function qtyBtnStyle(disabled) {
    const base = 'width:28px;height:28px;padding:0;border-radius:4px;'
      + 'font-size:18px;font-weight:600;line-height:1;'
      + 'display:inline-flex;align-items:center;justify-content:center;margin:0 2px;';
    return disabled
      ? base + 'border:1px solid #ccc;background:#f3f3f3;color:#bbb;cursor:not-allowed;'
      : base + 'border:1px solid #3e5a42;background:#fff;color:#3e5a42;cursor:pointer;';
  }

  // 全域註冊(只暴露 create)
  window.MF = window.MF || {};
  window.MF.MF03 = {
    create: create
  };
})();
