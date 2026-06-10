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
 * F-BINDING-GROUP (2026-05-18,2026-06-10 改規格):
 *   • 新增 optional mf_params:
 *       _binding_group: string   綁定群組名(例如 "GLASS")
 *       _binding_role: 'primary' | 'dependent'
 *   • broadcast 的 mf-change event detail 多帶 _binding_group +
 *     _binding_role,讓協調者(new-quote-modifications.html)能依此判斷。
 *
 *   ⚠ 規格更新(2026-06-10):GLASS 群組的角色與行為如下——
 *       primary   = MF03「Prep For Glass」(純 toggle,永遠顯示)
 *       dependent = MF02「Glass」+ MF03「Matching Interior」(required 模式)
 *     行為(由協調者驅動,本元件只提供 reset()):
 *       - primary 沒勾 → 協調者把 dependent 的整個 row 隱藏,並呼叫
 *         dependent 的 reset() 清空值。
 *       - primary 勾起 → 協調者顯示 dependent 的 row,dealer 自由勾/選,
 *         **不自動勾、不鎖**。
 *     (舊註解曾寫「Glass 勾 → Prep For Glass 自動勾 + 鎖住」,且把 Glass
 *      當 primary —— 該設計已廢棄,不再適用。)
 *
 *   • 新增 instance method 供協調者操控 dependent:
 *       reset()                     程式化重置值(依模式回初始)+ 重繪,
 *                                   不 broadcast(liveValues 由協調者重算)。
 *   • 保留(但新規格協調者不再呼叫)的 method:
 *       setEnabled(bool)            程式化勾起/取消,不重複 broadcast
 *       setLocked(bool, reason?)    鎖住 UI:checkbox disabled,灰底,
 *                                   label 旁顯示 reason
 *     兩者仍可用(向後相容),只是新的 GLASS 規格不靠它們達成聯動。
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
 * CB-12 — REQUIRED YES/NO 模式 (2026-06-04):
 *   • 新增 optional mf_params.required,為 true 時啟用「必選 Yes/No」
 *     模式:取代單一 checkbox,改成兩顆 radio(Yes / No),初始都不選。
 *     業務範例:Matching Interior(WALL/TALL 共 22 筆)。
 *   • 觸發後完全走獨立 render/handler 路徑(renderRequired / onRadioChange),
 *     不碰純 toggle 與 qty_selector 的程式碼。
 *   • 優先序:required > qty_selector(資料上不會同時出現,防禦性處理)。
 *   • 兩顆 radio 共用「每 instance 唯一」的 name,避免同頁多實例互相干擾。
 *   • getValue() → 'yes' | 'no' | null(null = 還沒選,會被 validate() 擋)。
 *   • validate() → required 且 choice 為 null 時回 invalid,錯誤訊息用
 *     mf_params._display_label || toggle_label 當顯示名。
 *   • calculateCost() → Yes = _base_cost,No / 未選 = 0。
 *   • broadcast 只在 dealer 點選 radio 時觸發(初次 render 不發),
 *     所以主頁面不會收到 null。detail.value = 'yes' | 'no'。
 *   • resume:current_value 接受字串 'yes' / 'no' 還原選擇。
 *
 * 介面:
 *   create(container, mf_params, current_value) → instance
 *
 *   instance:
 *     getValue()             → boolean | { enabled, qty } | 'yes'|'no'|null
 *     validate()             → { valid, errors }
 *     calculateCost()        → number
 *     reset()                → void  (F-BINDING-GROUP;依模式回初始值)
 *     setEnabled(bool)       → void  (F-BINDING-GROUP;required 模式為 no-op)
 *     setLocked(bool, msg?)  → void  (F-BINDING-GROUP)
 *     destroy()              → void
 *
 * mf_params 結構:
 *   {
 *     toggle_label: string,
 *     _base_cost?: number,
 *     _display_label?: string,   // CB-12: required 模式錯誤訊息用(選填)
 *     required?: boolean,        // CB-12: true → Required Yes/No 模式
 *     no_label?: string,         // CB-12: 主頁面 / step3 用,本元件不消費
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
 *   有 required(CB-12,resume 還原):
 *     'yes' / 'no' → 還原已選的 radio
 *     其他(含 null)→ 初次渲染,兩顆 radio 都不選
 *
 * 共通規則 1:toggle = false 時不寫 row(由主頁面在 save 時過濾)
 *   ⚠ CB-12 例外:required 模式不管選 Yes / No 都要寫 row(由主頁面處理),
 *     才有資料給 step3 顯示 Wood Interior。
 *
 * 對外通知:
 *   container.dispatchEvent(new CustomEvent('mf-change', {
 *     detail: {
 *       mf_code, value, cost,
 *       qty?,                              // F-QTY-SELECTOR(有 qty_selector 時)
 *       _binding_group?, _binding_role?    // F-BINDING-GROUP
 *     }
 *   }))
 *   CB-12:required 模式 value = 'yes' | 'no'(不帶 qty)
 * ============================================================
 */
(function () {
  'use strict';

  // CB-12: module 層 counter,給 required 模式產生每 instance 唯一的 radio name
  let _mf03Uid = 0;

  /**
   * Factory:建立一個 MF03 實例
   * @param {HTMLElement} container
   * @param {Object} mf_params - { toggle_label, _base_cost?, required?, qty_selector? }
   * @param {boolean|null|string|{enabled:boolean,qty:number}} current_value
   * @returns {Object} instance with { getValue, validate, calculateCost, reset, setEnabled, setLocked, destroy }
   */
  function create(container, mf_params, current_value) {
    // ──────────────────────────────────────────────────────────
    // current_value 可為 boolean(純 toggle)、{ enabled, qty }(qty_selector
    // resume)、或字串 'yes'/'no'(CB-12 required resume)。
    // 先拆出 toggle/qty 初始狀態;required 的 choice 另外解析(見下方)。
    // 註:字串 current_value 不會誤觸這裡 —— 'yes' !== true 且 typeof 非 object,
    //     所以 initEnabled 維持 false,無汙染。
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
      // CB-12: required Yes/No 模式狀態
      isRequired: false,     // mf_params.required === true 時啟用
      choice: null,          // 'yes' | 'no' | null(null = 還沒選)
      radioName: '',         // 每 instance 唯一的 radio group name
      radioInputs: [],       // 保留 ref 以便 destroy() 移除 listener
    };

    // base cost 從 mf_params._base_cost 讀(主頁面要把 modification.cost 設進去)
    if (typeof state.mf_params._base_cost === 'number') {
      state.cost = state.mf_params._base_cost;
    }

    // ──────────────────────────────────────────────────────────
    // CB-12: 解析 required 模式(優先序高於 qty_selector)。
    //   啟用後產生唯一 radio name,並從字串 current_value 還原已選 radio。
    // ──────────────────────────────────────────────────────────
    state.isRequired = (state.mf_params.required === true);
    if (state.isRequired) {
      state.radioName = 'mf03-req-' + (++_mf03Uid);
      if (current_value === 'yes' || current_value === 'no') {
        state.choice = current_value;
      }
    }

    // ──────────────────────────────────────────────────────────
    // F-QTY-SELECTOR: 解析 qty_selector(沒有 / 非物件 → 維持純 toggle)
    //   還原優先序:current_value.qty(resume) > qty_selector.default
    //   CB-12:required 模式優先,直接跳過 qty_selector 解析。
    // ──────────────────────────────────────────────────────────
    (function parseQtySelector() {
      if (state.isRequired) return;  // CB-12: required > qty_selector

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
      // CB-12: required 模式走完全獨立的 render 路徑,早退避免碰到下方
      //        純 toggle / qty_selector 的程式碼。
      if (state.isRequired) {
        renderRequired();
        return;
      }

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

      // CB-12: 非 required 模式不會用到 radio,清掉 ref 保持一致
      state.radioInputs = [];
    }

    // ──────────────────────────────────────────────────────────
    // CB-12: required Yes/No 模式 render。
    //   - label + 紅色粗體 (Required) 標示
    //   - 兩顆 radio 共用 state.radioName(唯一),初始都不選
    //   - cost>0 比照 toggle 顯示 +$cost
    //   - locked 時 radio disabled + 灰化 + 顯示 reason(防禦性,
    //     Matching Interior 不在 binding group,實際不會被鎖)
    // ──────────────────────────────────────────────────────────
    function renderRequired() {
      const label = escapeHTML(state.mf_params.toggle_label || 'Enable');
      const isLocked = state.locked;

      const costDisplay = state.cost > 0
        ? `<span style="margin-left:8px;color:#666;font-size:13px;">+$${state.cost.toFixed(2)}</span>`
        : '';

      const lockedReasonHTML = (isLocked && state.lockReason)
        ? `<span style="margin-left:8px;color:#8B6914;font-size:11px;font-style:italic;font-weight:500;">${escapeHTML(state.lockReason)}</span>`
        : '';

      const yesChecked = state.choice === 'yes' ? 'checked' : '';
      const noChecked  = state.choice === 'no'  ? 'checked' : '';
      const radioDisabled = isLocked ? 'disabled' : '';
      const radioCursor = isLocked ? 'not-allowed' : 'pointer';
      const groupOpacity = isLocked ? '0.7' : '1';

      const radioStyle = `margin-right:6px;width:16px;height:16px;cursor:${radioCursor};accent-color:#3e5a42;`;
      const optLabelStyle = `display:inline-flex;align-items:center;cursor:${radioCursor};user-select:none;`;

      container.innerHTML = `
        <div style="
          font-family:'DM Sans',sans-serif;
          font-size:14px;
          color:#333;
          padding:6px 0;
          opacity:${groupOpacity};
        ">
          <div style="display:flex;align-items:center;margin-bottom:6px;">
            <span>${label}</span>
            <span style="margin-left:8px;color:#c0392b;font-size:12px;font-weight:700;">(Required)</span>
            ${costDisplay}
            ${lockedReasonHTML}
          </div>
          <div style="display:flex;align-items:center;gap:20px;margin-left:2px;">
            <label style="${optLabelStyle}">
              <input type="radio" name="${state.radioName}" value="yes" ${yesChecked} ${radioDisabled}
                style="${radioStyle}" />
              <span>Yes</span>
            </label>
            <label style="${optLabelStyle}">
              <input type="radio" name="${state.radioName}" value="no" ${noChecked} ${radioDisabled}
                style="${radioStyle}" />
              <span>No</span>
            </label>
          </div>
        </div>
      `;

      // 綁定兩顆 radio 的 change listener
      state.radioInputs = Array.prototype.slice.call(
        container.querySelectorAll('input[type="radio"]')
      );
      state.radioInputs.forEach(function (r) {
        r.addEventListener('change', onRadioChange);
      });

      // required 模式不用 checkbox / qty 按鈕,清 ref
      state.checkbox = null;
      state.minusBtn = null;
      state.plusBtn = null;
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
    // CB-12: required radio 選擇 handler。
    //   選 Yes/No → 更新 choice + broadcast(只在這裡發,初次 render 不發,
    //   所以主頁面不會收到 null)。radio 的 checked 由瀏覽器原生維持,
    //   不需 re-render(cost 顯示固定不隨選擇變)。
    // ──────────────────────────────────────────────────────────
    function onRadioChange(e) {
      if (state.locked) {
        e.preventDefault();
        return;
      }
      const v = e.target.value;
      if (v === 'yes' || v === 'no') {
        state.choice = v;
        broadcast();
      }
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
    // CB-12: required 模式 value = choice('yes'|'no'),不帶 qty
    // ──────────────────────────────────────────────────────────
    function broadcast() {
      const detail = {
        mf_code: 'MF03',
        value: state.isRequired ? state.choice : state.current_value,
        cost: calculateCost()
      };

      // F-QTY-SELECTOR: 有 qty_selector 時帶 qty(required 模式不帶)
      if (!state.isRequired && state.hasQty) {
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
      // CB-12: required → 回 'yes' | 'no' | null(優先於 qty / boolean)
      if (state.isRequired) {
        return state.choice;
      }
      // F-QTY-SELECTOR: 有 qty_selector → 回 object;沒有 → 回 boolean(向後相容)
      if (state.hasQty) {
        return { enabled: state.current_value, qty: state.qty };
      }
      return state.current_value;
    }

    function validate() {
      // CB-12: required 且還沒選 → invalid。顯示名優先用 _display_label。
      if (state.isRequired && state.choice === null) {
        const lbl = state.mf_params._display_label
          || state.mf_params.toggle_label
          || 'this option';
        return { valid: false, errors: ['Please select Yes or No for ' + lbl] };
      }
      return { valid: true, errors: [] };
    }

    function calculateCost() {
      // CB-12: required → Yes = _base_cost,No / 未選 = 0
      if (state.isRequired) {
        return state.choice === 'yes' ? state.cost : 0;
      }
      // 維持 flat:qty 的 ×N(mapping SKU 材料費)由主頁面 bundle 邏輯處理,
      // MF03 自身 _base_cost 視為固定 modification 費,不隨 qty 變動。
      return state.current_value ? state.cost : 0;
    }

    // ──────────────────────────────────────────────────────────
    // F-BINDING-GROUP (2026-06-10 新規格): 程式化重置(供協調者用)。
    //   primary(Prep For Glass)取消勾時,協調者把此 dependent 的整個
    //   row 隱藏,並呼叫 reset() 把值清回初始,確保:
    //     1. 下次 primary 再勾起、row 重新顯示時,值是空的(不是上次選的)。
    //     2. save 時 getValue() 回初始值(required→null、toggle→false),
    //        被主頁面 shouldKeepModification 濾掉,不寫入 stale row。
    //   依模式重置,共用現有 render() 重繪分流(完全不碰三模式邏輯):
    //     • required(CB-12)→ choice=null(兩顆 radio 都不選)
    //     • qty_selector(F-QTY-SELECTOR)→ current_value=false,qty 回 default
    //     • 純 toggle → current_value=false
    //   一併清掉 lock 狀態(防禦性:新規格不再鎖,但避免殘留)。
    //   不 broadcast —— liveValues 由協調者在呼叫 reset() 後自行重算,
    //   避免事件迴圈。
    // ──────────────────────────────────────────────────────────
    function reset() {
      if (state.isRequired) {
        state.choice = null;
      } else {
        state.current_value = false;
        if (state.hasQty) {
          state.qty = state.qtyConf.default;
        }
      }
      state.locked = false;
      state.lockReason = null;
      render();
    }

    // ──────────────────────────────────────────────────────────
    // F-BINDING-GROUP: 程式化勾起/取消。
    //   不 broadcast 會導致 liveValues 不更新,所以仍 broadcast。
    //   協調者用 same group + same role 判斷不重複處理,避免迴圈。
    //   CB-12:required 模式為 no-op(enabled 對 tri-state radio 沒意義)。
    //   ⚠ 2026-06-10 新規格:GLASS 群組不再透過此 method 聯動(改用
    //     reset() + 協調者控制 row 顯示)。保留此 method 僅為向後相容。
    // ──────────────────────────────────────────────────────────
    function setEnabled(bool) {
      if (state.isRequired) return;  // CB-12: required 模式不適用 setEnabled

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
    //
    // ⚠ 2026-06-10 新規格:GLASS 群組不再鎖 dependent。保留此 method
    //   僅為向後相容,新流程不會呼叫到。
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
      // CB-12: 清 radio listener
      if (state.radioInputs && state.radioInputs.length) {
        state.radioInputs.forEach(function (r) {
          r.removeEventListener('change', onRadioChange);
        });
      }
      if (state.container) {
        state.container.innerHTML = '';
      }
      state.container = null;
      state.checkbox = null;
      state.minusBtn = null;
      state.plusBtn = null;
      state.radioInputs = [];
    }

    // 初次渲染
    render();

    // 回傳 instance API
    return {
      getValue:       getValue,
      validate:       validate,
      calculateCost:  calculateCost,
      reset:          reset,         // F-BINDING-GROUP (2026-06-10)
      setEnabled:     setEnabled,    // F-BINDING-GROUP(保留,新規格未使用)
      setLocked:      setLocked,     // F-BINDING-GROUP(保留,新規格未使用)
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
