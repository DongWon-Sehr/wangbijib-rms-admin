// --- 1. 전역 설정 ---
const SPREADSHEET_ID = SpreadsheetApp.getActiveSpreadsheet().getId();

const SHEET_NAMES = {
  // 예약 관리
  RAW_REQUEST: 'Responses',
  RESERVATION: 'reservation',

  // 시스템 설정
  USER: 'user',
  BRANCH: 'branch',
  USER_PERMISSION: 'user_branch_permission',
  SLOT_MASTER: 'slot_master',
  SLOT_DEFAULT: 'slot_default',
  SLOT_OVERRIDE: 'slot_override'
};

const BRANCH_NAME_COLUMN = "A";
const START_DATE_COLUMN = "C";
const END_DATE_COLUMN = "D";
const CUSTOMER_NAME_COLUMN = "F";
const CUSTOMER_EMAIL_ADDRESS_COLUMN = "G";
const CUSTOMER_NOTES_COLUMN = "H";
const NUMBER_OF_PEOPLE_COLUMN = "I";
const BOOKING_REQUEST_DATE_COLUMN = "K";
const RESPONSE_ID_COLUMN = "L";
const STATUS_COLUMN = "T";
const CALENDAR_ID_COLUMN = "U";
const EVENT_ID_COLUMN = "V";
const EMAIL_THREAD_ID_COLUMN = "W";
