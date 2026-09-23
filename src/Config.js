/**
 * [Config] 전역 설정 및 상수 관리 (Singleton)
 */
const Config = {
  // 0. App Version (배포 시 여기를 직접 올림 — UI/탭 타이틀에 자동 반영)
  APP_VERSION: '2.1.4',

  // 0-1. BI 로고 (스크립트 소유 계정 Drive 파일)
  LOGO_FILE_ID: '1Ni3HhXrloRWe_idt2XeroEvcS--n6BK9',

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
    MAIL_TEMPLATE: 'mail_template',  // 메일 템플릿 관리
    DUPLICATE_GROUP: 'duplicate_group', // 중복 예약 그룹 관리 시트
  },

  // 3. Deposit Policy
  DEPOSIT: {
    THRESHOLD_PAX: 9,     // 예약금이 적용되는 최소 인원 (9인 이상)
    BASE_AMOUNT: 100,  // 기본 예약금 (100 달러)
    UNIT_PAX: 10,         // 증액 단위 인원 (10명 단위)
    UNIT_AMOUNT: 100   // 증액 단위 금액 (100 달러)
  },

  // 3-1. Deposit URLs
  DEPOSIT_URLS: {
    100: 'https://www.wangbijib-restaurant.com/deposit/p/group-10',
    200: 'https://www.wangbijib-restaurant.com/deposit/p/group-20',
    300: 'https://www.wangbijib-restaurant.com/deposit/p/group-30',
    400: 'https://www.wangbijib-restaurant.com/deposit/p/group-40',
    500: 'https://www.wangbijib-restaurant.com/deposit/p/group-50',
    600: 'https://www.wangbijib-restaurant.com/deposit/p/group-60',
    700: 'https://www.wangbijib-restaurant.com/deposit/p/group-70',
  },

  // 4. Enums & Constants
  RESERVATION_STATUS: {
    PENDING: 'pending',
    CONFIRM: 'confirm',
    CANCEL: 'cancel'
  },

  DEPOSIT_STATUS: {
    NA: 'n/a',          // 해당 없음 (9인 미만)
    PENDING: 'pending', // 입금 대기 (9인 이상 초기 상태)
    CONFIRM: 'confirm', // 입금 확인
    REFUND: 'refund'    // 환불
  },

  DUPLICATE_GROUP_STATUS: {
    ACTIVE: 'active',   // 중복 의심 상태
    CLEARED: 'cleared'  // 중복 아님 처리 완료
  },

  DUPLICATE_GROUP_TYPE: {
    AUTO: 'auto',       // 자동 감지 그룹
    MANUAL: 'manual'    // 수동 묶음 그룹
  },

  // 4-1. 대표적 이메일 도메인 오타 사전 매핑
  EMAIL_TYPO_MAP: {
    'gmial.com': 'gmail.com',
    'gmai.com': 'gmail.com',
    'gamil.com': 'gmail.com',
    'gmaill.com': 'gmail.com',
    'gmaik.com': 'gmail.com',
    'gimal.com': 'gmail.com',
    'gmail.con': 'gmail.com',
    'naver.con': 'naver.com',
    'nver.com': 'naver.com',
    'nave.com': 'naver.com',
    'navar.com': 'naver.com',
    'naver.cm': 'naver.com',
    'hanmial.net': 'hanmail.net',
    'hanmail.com': 'hanmail.net',
    'hanmail.con': 'hanmail.net',
    'daun.net': 'daum.net',
    'daum.com': 'daum.net',
    'daum.con': 'daum.net',
    'hotmial.com': 'hotmail.com',
    'hotmai.com': 'hotmail.com',
    'hotmaill.com': 'hotmail.com',
    'homail.com': 'hotmail.com',
    'icould.com': 'icloud.com',
    'iclod.com': 'icloud.com',
    'iclud.com': 'icloud.com',
    'outlok.com': 'outlook.com',
    'yahoo.con': 'yahoo.com',
    'yaho.com': 'yahoo.com'
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