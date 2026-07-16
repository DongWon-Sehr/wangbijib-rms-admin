/* ==========================================================================
   WANGBIJIB RESERVATION MANAGEMENT SCRIPT (Full Integrated Rule-Based Version)
   1. Max Pax Validation (Branch Specific)
   2. Group Reservation Modal (9+ Pax)
   3. Branch Disabler (Main Store)
   4. Auto-expand About Section
   5. Rule-based Time Slot Management (Break Time & Opening Hours)
   ========================================================================== */

const STORE_CONFIGS = {
  'Wangbijib Jongno Branch': {
    maxPax: 64,
    disabled: false,
    rules: [
      {
        days: [1, 2, 3, 4, 5], // 평일만 적용
        start: "14:00", end: "16:59",
        action: 'disable', label: '(Break Time)'
      },
      {
        days: [0, 6], // 주말 적용
        start: "00:00", end: "16:59",
        action: 'hide', label: ''
      }
    ]
  },
  'Wangbijib City Hall Branch': {
    maxPax: 75,
    disabled: false,
    rules: [
      {
        days: [0, 1, 2, 3, 4, 5, 6], // 전요일 적용
        start: "14:00", end: "16:59",
        action: 'disable', label: '(Break Time)'
      }
    ]
  },
  'Hansik Wangbijib Euljiro Branch': { maxPax: 60, disabled: false, rules: [] },
  'Wangbijib Myeongdong Yukho Branch': { maxPax: 50, disabled: false, rules: [] },
  'Wangbijib Myeongdong 2nd Branch': { maxPax: 40, disabled: false, rules: [] },
  'Wangbijib Myeongdong Center Branch': { maxPax: 38, disabled: false, rules: [] },
  'Hansik Wangbijib Myeongdong Branch': { maxPax: 20, disabled: false, rules: [] },
  'Wangbijib Myeongdong Main Store Branch': { maxPax: 0, disabled: true, rules: [] }
};

/* --- Utility Functions --- */
const getCurrentStoreName = () => {
  const container = document.querySelector('.es-content-container');
  if (!container) return "";
  const branchLine = container.innerText.split('\n').find(line => line.includes('Branch'));
  return branchLine ? branchLine.trim() : "";
};

const convertTo24H = (timeStr) => {
  if (!timeStr) return "";
  const match = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!match) return "";
  let [, hours, minutes, modifier] = match;
  hours = parseInt(hours, 10);
  if (modifier.toUpperCase() === 'PM' && hours < 12) hours += 12;
  if (modifier.toUpperCase() === 'AM' && hours === 12) hours = 0;
  return `${hours.toString().padStart(2, '0')}:${minutes}`;
};

/* =========================
   [기능 5] 규칙 기반 시간대 슬롯 관리 (Break Time & Opening Hours)
   ========================= */
const setupTimeSlotDisabler = () => {
  const storeName = getCurrentStoreName();
  const config = STORE_CONFIGS[storeName];
  if (!config || !config.rules) return;

  const selectedDayEl = document.querySelector('.es-datetime-picker-button-selected.es-days-carousel-day');
  if (!selectedDayEl) return;

  const weekdayText = selectedDayEl.querySelector('.es-days-carousel-weekday').textContent.trim();
  const dayMap = { 'Sun': 0, 'Mon': 1, 'Tue': 2, 'Wed': 3, 'Thu': 4, 'Fri': 5, 'Sat': 6, 'Today': new Date().getDay() };
  const currentDay = dayMap[weekdayText];

  const timeButtons = document.querySelectorAll('.es-time-slot-picker-time-container');

  timeButtons.forEach(btn => {
    const timeTextEl = btn.querySelector('.es-time-slot-picker-time');
    if (!timeTextEl) return;

    const rawTime = timeTextEl.textContent.split('\n')[0].trim();
    const timeValue = convertTo24H(rawTime);
    let state = { hide: false, disable: false, label: '' };

    config.rules.forEach(rule => {
      if (rule.days.includes(currentDay) && timeValue >= rule.start && timeValue <= rule.end) {
        if (rule.action === 'hide') state.hide = true;
        if (rule.action === 'disable') {
          state.disable = true;
          state.label = rule.label;
        }
      }
    });

    if (state.hide) {
      btn.style.setProperty('display', 'none', 'important');
    } else {
      btn.style.setProperty('display', 'flex', 'important');
      if (state.disable) {
        btn.style.opacity = '0.5';
        btn.style.pointerEvents = 'none';
        if (!timeTextEl.innerHTML.includes(state.label)) {
          timeTextEl.innerHTML = `${rawTime}<br><span style="font-size:10px; color:#ff4d4f; font-weight:bold;">${state.label}</span>`;
        }
      } else {
        btn.style.opacity = '1';
        btn.style.pointerEvents = 'auto';
        if (timeTextEl.innerHTML !== rawTime) timeTextEl.innerHTML = rawTime;
      }
    }
  });

  // 빈 카테고리 그룹 숨기기
  document.querySelectorAll('.es-time-slot-picker-group').forEach(group => {
    const hasVisible = Array.from(group.querySelectorAll('.es-time-slot-picker-time-container'))
                            .some(btn => btn.style.display !== 'none');
    group.style.setProperty('display', hasVisible ? 'block' : 'none', 'important');
  });
};

/* =========================
   [기능 3] 특정 지점 예약 버튼 비활성화
   ========================= */
const setupBranchDisabler = () => {
  document.querySelectorAll('[class*="service-card"]').forEach(card => {
    const storeName = Object.keys(STORE_CONFIGS).find(name => card.textContent.includes(name));
    if (storeName && STORE_CONFIGS[storeName].disabled) {
      const bookBtn = card.querySelector('button');
      if (bookBtn && !bookBtn.disabled) {
        bookBtn.disabled = true;
        bookBtn.style.setProperty('opacity', '0.5', 'important');
        bookBtn.style.setProperty('pointer-events', 'none', 'important');
        const textEl = bookBtn.querySelector('[class*="ButtonBase__Ellipsis"]') || bookBtn;
        if (textEl) textEl.textContent = 'Not Available';
      }
    }
  });
};

/* =========================
   [기능 1] 인원수 제한 검증 로직
   ========================= */
const REQUIRED_FIELDS = [
  { key: 'name', selector: 'input#name, input[aria-label^="Name"]' },
  { key: 'email', selector: 'input#email, input[type="email"]' },
  { key: 'phone', selector: 'input#phone, input[type="tel"]' },
  { key: 'pax', selector: 'input[aria-label*="Pax"]' }
];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const getRequiredInput = (key) => {
  const field = REQUIRED_FIELDS.find(f => f.key === key);
  return field ? document.querySelector(field.selector) : null;
};

// Elfsight ProgressiveMask는 "입력된 숫자 + 남은 자리 placeholder 숫자"를 함께 보여준다.
// 따라서 mask의 숫자 개수와 입력값의 숫자 개수가 같으면(남은 자리 0개) 완성이다.
// 완성 시 mask가 제거되는 국가(US)도 있어, mask가 없으면 국가코드 뒤 번호 유무로 본다.
// 해시 클래스(jVTOVe 등)엔 의존하지 않고 숫자 개수만 비교한다.
const isPhoneComplete = (phoneInput) => {
  const value = (phoneInput.value || '').trim();
  if (value === '') return false;

  const wrapper = phoneInput.closest('.es-fields-phone') || phoneInput.parentElement;
  const mask = wrapper?.querySelector('[class*="Mask"]');

  if (mask) {
    const maskDigits = mask.textContent.replace(/\D/g, '').length;
    const valueDigits = value.replace(/\D/g, '').length;
    return valueDigits === maskDigits;
  }

  return /\s\d/.test(value);
};

const applyValidation = () => {
  const confirmBtn = Array.from(document.querySelectorAll('button'))
    .find(btn => btn.textContent.trim().toLowerCase().includes('confirm booking'));
  if (!confirmBtn) return;

  const storeName = getCurrentStoreName();
  const maxPax = STORE_CONFIGS[storeName]?.maxPax || 20;

  const nameInput = getRequiredInput('name');
  const emailInput = getRequiredInput('email');
  const phoneInput = getRequiredInput('phone');
  const paxInput = getRequiredInput('pax');

  // --- Pax 상세 검증 (에러 문구 노출) ---
  let paxValid = false;
  let paxMessage = '';
  if (paxInput) {
    const val = paxInput.value.trim();
    if (val === '') {
      paxValid = false; // 미입력도 예약 불가 (단, 에러문구는 표시하지 않음)
    } else {
      const num = Number(val);
      if (!Number.isInteger(num)) {
        paxMessage = '⚠️ Please enter a valid number.';
      } else if (num <= 0) {
        paxMessage = '⚠️ Must be greater than 0.';
      } else if (num > maxPax) {
        paxMessage = `⚠️ Maximum capacity exceeded (Max ${maxPax} for this branch).`;
      } else {
        paxValid = true;
      }
    }

    let errorMsg = document.getElementById('pax-max-error');
    if (!errorMsg) {
      errorMsg = document.createElement('div');
      errorMsg.id = 'pax-max-error';
      errorMsg.style.cssText = 'color: #ff4d4f; font-size: 13px; margin-top: 4px; font-weight: bold; display: none;';
      paxInput.parentElement.appendChild(errorMsg);
    }
    if (paxMessage) {
      errorMsg.innerText = paxMessage;
      errorMsg.style.display = 'block';
      paxInput.style.setProperty('border', '2px solid #ff4d4f', 'important');
    } else {
      errorMsg.style.display = 'none';
      paxInput.style.border = '';
    }
  }

  // --- Name / Email / Phone 필수값 검증 (버튼 게이팅) ---
  const nameValid = !!nameInput && nameInput.value.trim() !== '';
  const emailValid = !!emailInput && EMAIL_RE.test(emailInput.value.trim());
  const phoneValid = !!phoneInput && isPhoneComplete(phoneInput);

  const allValid = paxValid && nameValid && emailValid && phoneValid;

  if (allValid) {
    confirmBtn.disabled = false;
    confirmBtn.style.opacity = '1';
    confirmBtn.style.pointerEvents = 'auto';
  } else {
    confirmBtn.disabled = true;
    confirmBtn.style.setProperty('opacity', '0.5', 'important');
    confirmBtn.style.setProperty('pointer-events', 'none', 'important');
  }
};

const setupValidation = () => {
  REQUIRED_FIELDS.forEach(({ key }) => {
    const input = getRequiredInput(key);
    if (input && !input.dataset.vAlidatorAttached) {
      input.dataset.vAlidatorAttached = 'true';
      input.addEventListener('input', applyValidation);
    }
  });

  applyValidation();
};

/* =========================
   [기능 4] 소개멘트 자동 펼치기 (Read More 클릭)
   ========================= */
const autoExpandAbout = () => {
  const readMoreBtn = Array.from(document.querySelectorAll('.es-text-shortener-control'))
    .find(btn => btn.textContent.trim().toLowerCase() === 'read more');
  if (readMoreBtn) readMoreBtn.click();
};

/* =========================
   [기능 2] 9인 이상 보증금 안내 모달
   ========================= */
(function() {
  let bypassNextClick = false;

  if (!document.getElementById("pax-modal-style")) {
    const style = document.createElement("style");
    style.id = "pax-modal-style";
    style.innerHTML = `
      .pax-modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.55); display: flex; align-items: center; justify-content: center; padding: 24px; z-index: 2147483647; animation: paxFadeIn 0.2s ease-out; }
      .pax-modal { background: #fff; width: 100%; max-width: 640px; border-radius: 18px; padding: 36px; box-shadow: 0 25px 70px rgba(0,0,0,0.25); }
      .pax-modal h3 { margin: 0 0 16px 0; font-size: 22px; font-weight: 600; }
      .pax-modal p { margin: 0 0 28px 0; font-size: 16px; line-height: 1.65; color: #333; }
      .pax-deposit-notice { margin: 14px 0; font-size: 16px; font-weight: 500; color: #333; }
      .pax-deposit-notice strong { color: #c62828; font-weight: 700; }
      .pax-modal-buttons { display: flex; justify-content: flex-end; gap: 14px; }
      .pax-btn { padding: 12px 22px; border-radius: 12px; border: none; cursor: pointer; font-size: 14px; font-weight: 500; }
      .pax-btn-cancel { background: #e9e9e9; }
      .pax-btn-confirm { background: rgb(255, 120, 0); color: #fff; }
      @keyframes paxFadeIn { from { opacity: 0; } to { opacity: 1; } }
      @media (max-width: 480px) { .pax-modal-buttons { flex-direction: column; } .pax-btn { width: 100%; } }
    `;
    document.head.appendChild(style);
  }

  function showModal(onConfirm) {
    if (document.querySelector(".pax-modal-overlay")) return;
    const overlay = document.createElement("div");
    overlay.className = "pax-modal-overlay";
    overlay.innerHTML = `
      <div class="pax-modal">
        <h3>Notice</h3>
        <p>Reservations for 9 or more guests <strong>REQUIRE A DEPOSIT</strong>.</p>
        <div class="pax-deposit-notice">Your reservation is <strong>NOT CONFIRMED</strong> until we receive your deposit.</div>
        <p>Please complete the deposit payment via the follow-up email to finalize your booking.</p>
        <div class="pax-modal-buttons">
          <button type="button" class="pax-btn pax-btn-cancel">Cancel</button>
          <button type="button" class="pax-btn pax-btn-confirm">Proceed</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.querySelector(".pax-btn-cancel").onclick = () => overlay.remove();
    overlay.querySelector(".pax-btn-confirm").onclick = () => {
      overlay.remove();
      bypassNextClick = true;
      onConfirm();
    };
  }

  document.addEventListener("click", function(e) {
    const button = e.target.closest("button");
    if (!button || button.closest(".pax-modal-overlay") || bypassNextClick) {
      if (bypassNextClick) bypassNextClick = false;
      return;
    }
    if (!button.textContent.toLowerCase().includes('confirm booking')) return;

    const paxInput = document.querySelector('input[aria-label*="Pax"]');
    if (!paxInput) return;
    const pax = parseInt(paxInput.value, 10);
    if (pax >= 9) {
      e.preventDefault();
      e.stopImmediatePropagation();
      showModal(() => button.click());
    }
  }, true);
})();

/* =========================
   실행 및 옵저버 설정
   ========================= */
const observer = new MutationObserver(() => {
  setupValidation();
  setupBranchDisabler();
  autoExpandAbout();
  setupTimeSlotDisabler();
});

observer.observe(document.body, { childList: true, subtree: true });

// 초기 로드 시 실행
setupValidation();
setupBranchDisabler();
autoExpandAbout();
setupTimeSlotDisabler();

console.log("[WANGBIJIB SCRIPT] All systems loaded (Rule-based + Restored UX)");
