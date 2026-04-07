/**
 * [Config] 전역 설정 및 상수 관리 (Singleton)
 */
const Config = {
  // 1. Spreadsheet ID
  SPREADSHEET_ID: SpreadsheetApp.getActiveSpreadsheet().getId(),

  // 2. Sheet Names
  SHEET_NAMES: {
    RAW_REQUEST: 'Responses',       // 구글 설문지 응답 시트
    RESERVATION: 'reservation',     // 통합 예약 관리 시트
    USER: 'user',                   // 사용자 및 권한 관리
    BRANCH: 'branch',               // 지점 마스터
    USER_PERMISSION: 'user_branch_permission', // 사용자-지점 권한 매핑
    SLOT_MASTER: 'slot_master',     // 시간대 마스터
    SLOT_DEFAULT: 'slot_default',   // 지점별 기본 슬롯 설정
    SLOT_OVERRIDE: 'slot_override',  // 날짜별 슬롯 재정의 (커스텀 슬롯)
    MAIL_TEMPLATE: 'mail_template',  // 날짜별 슬롯 재정의 (커스텀 슬롯)
  },

  // 3. Deposit Policy
  DEPOSIT: {
    THRESHOLD_PAX: 9, // 예약금이 적용되는 최소 인원 (9인 이상)
    BASE_AMOUNT: 100, // 기본 예약금 ($100 USD)
    UNIT_PAX: 10,     // 증액 단위 인원 (10명 단위)
    UNIT_AMOUNT: 100  // 증액 단위 금액 ($100 USD)
  },

  // 4. Enums & Constants
  DEPOSIT_STATUS: {
    NA: 'n/a',          // 해당 없음 (9인 미만)
    PENDING: 'pending', // 입금 대기 (9인 이상 초기 상태)
    CONFIRM: 'confirm', // 입금 확인
    REFUND: 'refund'    // 환불
  },

  // 5. Roles
  USER_ROLES: {
    ADMIN: 'admin',     // 전체 관리자
    MANAGER: 'manager', // 지점 관리자
    VIEWER: 'viewer'    // 조회 전용
  },

  // 6. 메일 템플릿 id 매핑
  MAIL_TEMPLATES: {
    DEPOSIT_PENDING: '3ed5cdb9-b624-44e6-9e45-6a8c9188a1c4',
  }
};