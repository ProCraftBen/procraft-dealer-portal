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
 * 介面:
 *   create(container, mf_params, current_value) → instance
 *
 *   instance:
 *     getValue()             → boolean
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
 *   }
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
 *     detail: {
 *       mf_code, value, cost,
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
   * @param {Object} mf_params - { toggle_label, _base_cost? }
   * @param {boolean|null} current_value
   * @returns {Object} instance with { getValue, validate, calculateCost, setEnabled, setLocked, destroy }
   */
  function create(container, mf_params, current_value) {
    // 每次 create 都是獨立 closure,state 不會跟其他實例共享
    const state = {
      container: container,
      mf_params: mf_params || {},
      current_value: current_value === true,
      cost: 0,
      checkbox: null,        // 保留 ref 以便 destroy() 移除 listener
      // F-BINDING-GROUP: lock state
      locked: false,
      lockReason: null,
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

      // F-BINDING-GROUP: 鎖定時的視覺差異
      //   - label 整體變灰
      //   - checkbox disabled
      //   - cursor 改 not-allowed
      //   - label 旁顯示鎖定原因(例:"Required with Glass")
      const isLocked = state.locked;
      const labelCursor = isLocked ? 'not-allowed' : 'pointer';
      const labelOpacity = isLocked ? '0.7' : '1';
      const checkboxCursor = isLocked ? 'not-allowed' : 'pointer';

      const lockedReasonHTML = (isLocked && state.lockReason)
        ? `<span style="margin-left:8px;color:#8B6914;font-size:11px;font-style:italic;font-weight:500;">${escapeHTML(state.lockReason)}</span>`
        : '';

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
      `;

      state.checkbox = container.querySelector('input[type="checkbox"]');
      state.checkbox.addEventListener('change', onToggle);
    }

    function onToggle(e) {
      // F-BINDING-GROUP: 鎖定時防呆 — 雖然 disabled 已經擋住,但保險再驗一次
      if (state.locked) {
        e.preventDefault();
        e.target.checked = state.current_value;
        return;
      }

      state.current_value = e.target.checked;
      broadcast();
    }

    // ──────────────────────────────────────────────────────────
    // F-BINDING-GROUP: broadcast 時帶上 binding info(只在 mf_params
    // 有設 _binding_group 時才帶)
    // ──────────────────────────────────────────────────────────
    function broadcast() {
      const detail = {
        mf_code: 'MF03',
        value: state.current_value,
        cost: calculateCost()
      };

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
      return state.current_value;
    }

    function validate() {
      return { valid: true, errors: [] };
    }

    function calculateCost() {
      return state.current_value ? state.cost : 0;
    }

    // ──────────────────────────────────────────────────────────
    // F-BINDING-GROUP: 程式化勾起/取消,不重複觸發 broadcast。
    //
    // 用途:協調者偵測到 primary (MF02 Glass) 被勾起 →
    //       對 dependent (MF03 Prep For Glass) instance 呼叫
    //       setEnabled(true) 強制勾起。
    //
    // 注意:
    //   - 不 broadcast(避免協調者收到後再回頭呼叫自己 → 無限迴圈)
    //   - 但要呼叫 broadcast 以更新 liveValues!
    //
    // 解法:setEnabled 改變後 broadcast,但帶上一個 _programmatic
    //       flag,協調者收到後就知道不要再回呼。
    //   → 簡化版:不管 _programmatic flag,直接 broadcast,協調者
    //     用 same group + same role 就能判斷不要重複處理。
    //     因為 setEnabled 是協調者主動呼叫,不會在它的 dependent
    //     上反向呼叫(只有 primary 會觸發 dependent,反之不會)。
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
    // 用途:dependent 元件(MF03 Prep For Glass)在 primary
    //       (MF02 Glass) 勾起時被鎖住,dealer 不能取消。
    //
    // @param {boolean} bool    true = 鎖住, false = 解鎖
    // @param {string} [reason] 鎖定時顯示在 label 旁的原因
    //                          (例如 "Required with Glass")
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

  // 全域註冊(只暴露 create)
  window.MF = window.MF || {};
  window.MF.MF03 = {
    create: create
  };
})();
