function testAddUser() {
  let userData = {
    id: 'jongno_manager',
    username: '종로점 관리자',
    password: 'jongno',
    role: 'manager',
    enabled: true,
  };

  result = addUser(userData);
  console.log('result: ', result);
}


function testGetDropdownData() {
  const dropdownData = getDropdownData();
  console.log('dropdownData:', dropdownData);
}

function testGetPivotedSlotData() {
  const pivotedSlotData = getPivotedSlotData();
  console.log('pivotedSlotData:', pivotedSlotData);
}

function testGetBranchTable() {
  const branchTable = getSheetData(SHEET_NAMES.BRANCH, true);

  console.log(branchTable);
}

function testFindEmail() {
  const mailThreadId = '19a8b37b8584cbd2';
  const thread = GmailApp.getThreadById(mailThreadId);
  if (!thread) {
    console.log("해당 스레드를 찾을 수 없음");
    return;
  }

  // 스레드 내 모든 메시지 가져오기
  const messages = thread.getMessages();
  messages.forEach((msg, index) => {
    console.log(`--- Message ${index + 1} ---`);
    console.log("From: " + msg.getFrom());
    console.log("To: " + msg.getTo());
    console.log("Reply-To: " + msg.getReplyTo());
    console.log("Subject: " + msg.getSubject());
    console.log("Date: " + msg.getDate());
    console.log("Body: " + msg.getPlainBody().substring(0, 100)); // 일부만 출력
  });
}

function getUuids(count = 13) {
  for (let i = 0; i < count; i++) {
    console.log(Utilities.getUuid());
  }
}

function doPostTest() {
  let event = {
    postData: {
      contents: ''
    }
  };
  event.postData.contents = JSON.stringify({
    reservation_id: '156da8ba-277b-445f-a6a0-8c9836df3e9d',
  });

  doPost(event);
}

function getSignatureHtmlTest() {
  const html = new GmailService().getSignatureHtml();
  console.log(html);
}

function updateReservationStatusTest(id = '3980bbea-820b-4ae3-9742-9056aca9fcca', newStatus = false) {
  const result = updateReservationStatus(id, newStatus);

  console.log('result:');
  console.log(result);
}

function apiSendTestMail(templateName, testEmail) {
  return _executeApi('apiSendTestMail', () => {
    // 테스트용 더미 데이터
    const dummyData = {
      customer_name: '테스트고객',
      branch_name_en: 'Test Branch',
      reservation_date: new Date(),
      pax: 4,
      notes: '테스트 발송입니다.',
      deposit_amount: 100
    };
    
    // 현재 로그인한 유저에게 보냄 (GmailApp.sendEmail 사용 - 스레드 없음)
    const template = HtmlService.createTemplateFromFile(templateName);
    let body = template.evaluate().getContent();
    body = GmailService.replacePlaceholders(body, dummyData);
    
    GmailApp.sendEmail(testEmail, `[Test] ${templateName}`, '', { htmlBody: body });
    
    return "테스트 메일이 발송되었습니다.";
  });
}

/**
 * [Migration] DB 스키마(시트) 초기화 및 생성 스크립트
 * - 실행 방법: 에디터 상단 함수 선택에서 'runSchemaMigration' 선택 후 실행
 */
function runSchemaMigration() {
  const ss = SpreadsheetApp.openById(Config.SPREADSHEET_ID);
  
  // v1.4 전체 테이블 스키마 정의
  const schemas = [
    {
      name: Config.SHEET_NAMES.USER,
      headers: ['id', 'user_email', 'user_name', 'role', 'enabled', 'created_at', 'updated_at'],
      note: '사용자 정보 (이메일 인증 기반)'
    },
    {
      name: Config.SHEET_NAMES.RESERVATION,
      headers: [
        'id', 'response_id', 'booking_request_date', 'branch_id', 'reservation_date', 
        'customer_name', 'number_of_people', 'notes', 'email_address', 'email_thread_id', 
        'calendar_id', 'event_id', 'enabled', 'is_read', 'message_sent_at', 
        'internal_notes', 'deposit_status', 'deposit_amount', 'deposit_paid_at', 'deposit_refund_at',
        'created_at', 'updated_at'
      ],
      note: '예약 통합 데이터 (v1.4 컬럼 추가됨)'
    },
    {
      name: Config.SHEET_NAMES.BRANCH,
      headers: ['id', 'branch_name_en', 'branch_name_ko', 'location', 'enabled', 'calendar_id', 'created_at', 'updated_at'],
      note: '지점 마스터'
    },
    {
      name: Config.SHEET_NAMES.USER_PERMISSION,
      headers: ['id', 'user_id', 'branch_id', 'enabled', 'created_at', 'updated_at'],
      note: '사용자-지점 권한 매핑'
    },
    {
      name: Config.SHEET_NAMES.SLOT_MASTER,
      headers: ['id', 'time', 'slot', 'enabled', 'created_at', 'updated_at'],
      note: '시간대 마스터 (예: 11:00, 11:30...)'
    },
    {
      name: Config.SHEET_NAMES.SLOT_DEFAULT,
      headers: ['id', 'branch_id', 'slot_master_id', 'slot', 'enabled', 'created_at', 'updated_at'],
      note: '지점별 기본 슬롯 설정'
    },
    {
      name: Config.SHEET_NAMES.SLOT_OVERRIDE,
      headers: ['id', 'branch_id', 'slot_master_id', 'date', 'slot', 'reason', 'enabled', 'created_at', 'updated_at'],
      note: '날짜별 슬롯 커스텀 설정'
    },
    {
      name: Config.SHEET_NAMES.MAIL_TEMPLATE,
      headers: ['id', 'template_name', 'subject', 'body_html', 'updated_at'],
      note: '메일 템플릿 관리'
    }
  ];

  Logger.log('🚀 [Migration] 스키마 마이그레이션 시작...');

  schemas.forEach(schema => {
    let sheet = ss.getSheetByName(schema.name);
    
    if (!sheet) {
      // 1. 시트가 없으면 생성
      sheet = ss.insertSheet(schema.name);
      Logger.log(`✅ [Create] 시트 생성됨: ${schema.name}`);
      
      // 2. 헤더 추가
      sheet.appendRow(schema.headers);
      
      // 3. 헤더 스타일링 (고정, 굵게, 회색 배경)
      const headerRange = sheet.getRange(1, 1, 1, schema.headers.length);
      headerRange.setFontWeight('bold');
      headerRange.setBackground('#f3f3f3');
      sheet.setFrozenRows(1);
      
      // 4. (선택) ID 컬럼 숨김 처리 등은 필요 시 추가
      // if (schema.headers[0] === 'id') sheet.hideColumns(1);

    } else {
      // 시트가 이미 존재할 경우 (헤더 비교 등 고도화 가능하지만 일단 스킵)
      Logger.log(`ℹ️ [Skip] 이미 존재하는 시트: ${schema.name}`);
      
      // (옵션) 헤더가 비어있으면 채워넣기
      if (sheet.getLastRow() === 0) {
        sheet.appendRow(schema.headers);
        Logger.log(`   └─ 헤더가 비어있어 추가했습니다.`);
      }
    }
  });

  Logger.log('✨ [Migration] 마이그레이션 완료.');
}

/**
 * [Test] 초기 Admin 유저 강제 생성 (테스트용)
 * - 이 함수를 실행하면 현재 스크립트 실행 유저를 Admin으로 등록합니다.
 */
function seedInitialAdmin() {
  const ss = SpreadsheetApp.openById(Config.SPREADSHEET_ID);
  const userSheet = ss.getSheetByName(Config.SHEET_NAMES.USER);
  
  if (!userSheet) {
    Logger.log('User 시트가 없습니다. runSchemaMigration을 먼저 실행하세요.');
    return;
  }

  const email = Session.getActiveUser().getEmail();
  const data = userSheet.getDataRange().getValues();
  
  // 이미 존재하는지 확인
  for (let i = 1; i < data.length; i++) {
    if (data[i][1] === email) { // user_email is index 1
      Logger.log(`이미 등록된 관리자입니다: ${email}`);
      return;
    }
  }

  // Admin 추가
  const newRow = [
    Utilities.getUuid(), // id
    email,               // user_email
    'Super Admin',       // user_name
    'admin',             // role
    true,                // enabled
    new Date(),          // created_at
    new Date()           // updated_at
  ];
  
  userSheet.appendRow(newRow);
  Logger.log(`✅ 초기 관리자 생성 완료: ${email}`);
}

function testUpdateOverrideSlotsBatchMock() {
  // 1. 기존 함수 백업
  const originalGetSpreadsheet = Util.getSpreadsheet;
  const originalSync = SlotService.syncSourceSlot;
  
  try {
    // 2. 가짜(Mock) 스프레드시트 객체 생성
    const mockSheet = {
      getDataRange: () => ({ 
        // 빈 헤더만 있는 상태를 가정
        getValues: () => [['id', 'branch_id', 'slot_master_id', 'date', 'slot', 'reason', 'enabled', 'created_at', 'updated_at']] 
      }),
      getLastRow: () => 1,
      getRange: () => ({ 
        setValues: (vals) => console.log('[Mock] 시트에 여러 줄 추가/수정 시도:', vals), 
        setValue: (v) => console.log('[Mock] 시트 단일 값 수정 시도:', v) 
      }),
      deleteRow: (idx) => console.log('[Mock] 시트 행 삭제 시도:', idx)
    };
    
    // 3. 의존성 주입 (실제 시트 대신 가짜 시트 반환)
    Util.getSpreadsheet = () => ({
      getSheetByName: (name) => mockSheet
    });
    SlotService.syncSourceSlot = () => console.log('[Mock] 캘린더 동기화 호출됨');
    
    // 4. 일괄 업데이트 로직 테스트 실행
    console.log('--- 가짜(Mock) 환경에서 슬롯 일괄 업데이트 테스트 시작 ---');
    const result = SlotService.updateOverrideSlotsBatch('test-branch', '2026-04-07', {
      'master-1': { slot: 5, enabled: true },
      'master-2': { slot: 0, enabled: false }
    });
    
    console.log('--- 테스트 결과 ---');
    console.log(result); // 성공 여부와 생성/수정/삭제 개수 출력
  } finally {
    // 5. 원래 함수로 복구 (안전 장치)
    Util.getSpreadsheet = originalGetSpreadsheet;
    SlotService.syncSourceSlot = originalSync;
  }
}

/**
 * [Migration] 예약 시트의 enabled 컬럼 체크박스를 문자열(대기/확정/취소) 지원 형태로 변환
 */
function runEnabledColumnMigration() {
  Logger.log('🚀 [Migration] 예약 시트 enabled 컬럼 마이그레이션 시작...');
  const ss = SpreadsheetApp.openById(Config.SPREADSHEET_ID);
  const sheet = ss.getSheetByName(Config.SHEET_NAMES.RESERVATION);
  
  if (!sheet) {
    Logger.log('❌ 시트를 찾을 수 없습니다.');
    return;
  }

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const enabledColIdx = headers.indexOf('enabled') + 1; // 1-based index

  if (enabledColIdx === 0) {
    Logger.log('❌ enabled 컬럼을 찾을 수 없습니다.');
    return;
  }

  // 1. 기존 체크박스 데이터 유효성 검사 제거
  const columnRange = sheet.getRange(2, enabledColIdx, sheet.getMaxRows() - 1, 1);
  columnRange.clearDataValidations();
  
  // 2. 드롭다운(Data Validation) 규칙 새로 추가 (pending, true, false)
  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['pending', 'true', 'false'], true)
    .setAllowInvalid(false)
    .build();
    
  columnRange.setDataValidation(rule);

  Logger.log(`✅ [Migration] enabled 컬럼(열: ${enabledColIdx})을 문자열 드롭다운으로 변환 완료했습니다.`);
}
function runMailTemplateMigration() {
  const ss = SpreadsheetApp.openById(Config.SPREADSHEET_ID);
  
  const schema = {
    name: Config.SHEET_NAMES.MAIL_TEMPLATE,
    headers: ['id', 'template_name', 'subject', 'body_html', 'updated_at'],
    note: '메일 템플릿 관리'
  };

  Logger.log(`🚀 [Migration] ${schema.name} 시트 단독 마이그레이션 시작...`);

  let sheet = ss.getSheetByName(schema.name);
  
  if (!sheet) {
    // 1. 시트가 없으면 생성
    sheet = ss.insertSheet(schema.name);
    Logger.log(`✅ [Create] 시트 생성됨: ${schema.name}`);
    
    // 2. 헤더 추가
    sheet.appendRow(schema.headers);
    
    // 3. 헤더 스타일링
    const headerRange = sheet.getRange(1, 1, 1, schema.headers.length);
    headerRange.setFontWeight('bold');
    headerRange.setBackground('#f3f3f3');
    sheet.setFrozenRows(1);
  } else {
    Logger.log(`ℹ️ [Skip] 이미 존재하는 시트: ${schema.name}`);
    
    // (옵션) 헤더가 비어있으면 채워넣기
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(schema.headers);
      Logger.log(`   └─ 헤더가 비어있어 추가했습니다.`);
    }
  }

  Logger.log('✨ [Migration] 메일 템플릿 처리 완료.');
}

/**
 * [Test] 초기 Admin 유저 강제 생성 (테스트용)
 * - 이 함수를 실행하면 현재 스크립트 실행 유저를 Admin으로 등록합니다.
 */
function seedInitialAdmin() {
  const ss = SpreadsheetApp.openById(Config.SPREADSHEET_ID);
  const userSheet = ss.getSheetByName(Config.SHEET_NAMES.USER);
  
  if (!userSheet) {
    Logger.log('User 시트가 없습니다. runSchemaMigration을 먼저 실행하세요.');
    return;
  }

  const email = Session.getActiveUser().getEmail();
  const data = userSheet.getDataRange().getValues();
  
  // 이미 존재하는지 확인
  for (let i = 1; i < data.length; i++) {
    if (data[i][1] === email) { // user_email is index 1
      Logger.log(`이미 등록된 관리자입니다: ${email}`);
      return;
    }
  }

  // Admin 추가
  const newRow = [
    Utilities.getUuid(), // id
    email,               // user_email
    'Super Admin',       // user_name
    'admin',             // role
    true,                // enabled
    new Date(),          // created_at
    new Date()           // updated_at
  ];
  
  userSheet.appendRow(newRow);
  Logger.log(`✅ 초기 관리자 생성 완료: ${email}`);
}

function testUpdateOverrideSlotsBatchMock() {
  // 1. 기존 함수 백업
  const originalGetSpreadsheet = Util.getSpreadsheet;
  const originalSync = SlotService.syncSourceSlot;
  
  try {
    // 2. 가짜(Mock) 스프레드시트 객체 생성
    const mockSheet = {
      getDataRange: () => ({ 
        // 빈 헤더만 있는 상태를 가정
        getValues: () => [['id', 'branch_id', 'slot_master_id', 'date', 'slot', 'reason', 'enabled', 'created_at', 'updated_at']] 
      }),
      getLastRow: () => 1,
      getRange: () => ({ 
        setValues: (vals) => console.log('[Mock] 시트에 여러 줄 추가/수정 시도:', vals), 
        setValue: (v) => console.log('[Mock] 시트 단일 값 수정 시도:', v) 
      }),
      deleteRow: (idx) => console.log('[Mock] 시트 행 삭제 시도:', idx)
    };
    
    // 3. 의존성 주입 (실제 시트 대신 가짜 시트 반환)
    Util.getSpreadsheet = () => ({
      getSheetByName: (name) => mockSheet
    });
    SlotService.syncSourceSlot = () => console.log('[Mock] 캘린더 동기화 호출됨');
    
    // 4. 일괄 업데이트 로직 테스트 실행
    console.log('--- 가짜(Mock) 환경에서 슬롯 일괄 업데이트 테스트 시작 ---');
    const result = SlotService.updateOverrideSlotsBatch('test-branch', '2026-04-07', {
      'master-1': { slot: 5, enabled: true },
      'master-2': { slot: 0, enabled: false }
    });
    
    console.log('--- 테스트 결과 ---');
    console.log(result); // 성공 여부와 생성/수정/삭제 개수 출력
  } finally {
    // 5. 원래 함수로 복구 (안전 장치)
    Util.getSpreadsheet = originalGetSpreadsheet;
    SlotService.syncSourceSlot = originalSync;
  }
}