/**
 * [트리거 설정 가이드]
 * 1. Apps Script 편집기 좌측 '트리거(시계 아이콘)' 클릭
 * 2. '+ 트리거 추가' 클릭
 * 3. 실행할 함수: processPendingReservation
 * 4. 이벤트 소스: 시간 기반
 * 5. 이벤트 유형: 분 단위 타이머
 * 6. 분 간격: 1분마다 (사용자 요청사항)
 */
function processPendingReservation() {
  Logger.log(`[TimeDriven] 신규 예약 스캔 시작...`);
  
  // 1. 시트 및 범위 설정
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const responseSheet = ss.getSheetByName(SHEET_NAMES.RAW_REQUEST);

  // 데이터가 있는지 확인 (헤더 제외)
  const lastRow = responseSheet.getLastRow();
  if (lastRow < 2) {
    Logger.log(`[TimeDriven] 처리할 데이터가 없어 종료합니다.`);
    return;
  }

  // 2. 데이터 전체 로드 (속도 최적화)
  // A열(지점명) ~ L열(Response ID)까지 가져옴
  // L열이 12번째 컬럼임
  const range = responseSheet.getRange(2, 1, lastRow - 1, 12);
  const values = range.getValues();

  let processedCount = 0;

  // 3. 행 순회
  for (let i = 0; i < values.length; i++) {
    const rowData = values[i];
    
    // 인덱스: 0(A, Branch), 11(L, Response ID)
    const branchName = rowData[0];
    const responseId = rowData[11];

    // L열(Response ID)이 비어있고, A열(지점명)이 있는 경우 신규 예약으로 판단
    if (!responseId && branchName) {
      const currentRow = i + 2; // 실제 시트 행 번호

      Logger.log(`[TimeDriven] ${currentRow}행 신규 예약 발견. 처리 시작...`);
      try {
        // 처리 함수 호출
        processNewReservation(currentRow);
        processedCount++;
      } catch (err) {
        Logger.log(`[TimeDriven] ${currentRow}행 처리 중 오류 발생: ${err.message}`);
        // 오류 발생 시에도 로그만 남기고 다음 행 진행 (배치 중단 방지)
      }
    }
  }

  if (processedCount > 0) {
    Logger.log(`[TimeDriven] 총 ${processedCount}건의 신규 예약 처리를 완료했습니다.`);
  }
}

function processNewReservation(currentRow) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const responseSheet = ss.getSheetByName(SHEET_NAMES.RAW_REQUEST);
  const reservationSheet = ss.getSheetByName(SHEET_NAMES.RESERVATION); // 웹앱 연동용 시트

  // --- 1. Responses 시트 데이터 읽기 ---
  // (컬럼 위치는 상수 파일에 정의되어 있다고 가정, 없다면 직접 숫자로 지정 필요)
  const branchName = responseSheet.getRange(BRANCH_NAME_COLUMN + currentRow).getValue();
  const reservationStartDate = responseSheet.getRange(START_DATE_COLUMN + currentRow).getValue();
  const reservationEndDate = responseSheet.getRange(END_DATE_COLUMN + currentRow).getValue();
  const customerName = responseSheet.getRange(CUSTOMER_NAME_COLUMN + currentRow).getValue();
  const customerEmailAddress = responseSheet.getRange(CUSTOMER_EMAIL_ADDRESS_COLUMN + currentRow).getValue();
  const customerNotes = responseSheet.getRange(CUSTOMER_NOTES_COLUMN + currentRow).getValue() || '';
  const numberOfPeople = responseSheet.getRange(NUMBER_OF_PEOPLE_COLUMN + currentRow).getValue();
  const bookingRequestDate = responseSheet.getRange(BOOKING_REQUEST_DATE_COLUMN + currentRow).getValue();
  
  // 필수 값 검증
  if (!branchName || !reservationStartDate || !reservationEndDate || !customerName || !customerEmailAddress || !numberOfPeople) {
    Logger.log(`[processNewReservation] ${currentRow}행 필수 정보 누락.`);
    return;
  }

  if (branchName === 'Group Reservation') {
    Logger.log(`[processNewReservation] ${currentRow}행 그룹 예약은 건너뜁니다.`);
    return;
  }

  // 지점 정보 조회
  const branchInfo = getBranchInfo(branchName, 'en');
  if (!branchInfo) {
    throw new Error(`브랜치 정보 조회 실패: ${branchName}`);
  }

  // --- 2. UUID 생성 및 Responses 시트 업데이트 (중복 방지용 선처리) ---
  // L열에 UUID를 먼저 박아넣어서, 다음 배치 때 중복 처리되지 않도록 함
  const newResponseId = Utilities.getUuid();
  responseSheet.getRange(RESPONSE_ID_COLUMN + currentRow).setValue(newResponseId);

  // 데이터 복사 및 형변환
  const copiedStartDate = new Date(reservationStartDate);
  const copiedEndDate = new Date(reservationEndDate);
  const copiedBookingRequestDate = new Date(bookingRequestDate);
  const copiedNumberOfPeople = Number(numberOfPeople);

  // --- 3. 캘린더 처리 로직 (원본 확인 -> 대상 생성 -> 슬롯 체크) ---
  
  // A. 원본 캘린더 확인
  let originEvent = null;
  try {
    const sourceCal = CalendarApp.getCalendarById(SOURCE_CALENDAR_ID);
    if (sourceCal) {
      const events = sourceCal.getEvents(copiedStartDate, copiedEndDate);
      const targetCandidates = events.filter(event => {
        const desc = event.getDescription() || '';
        return event.getTitle() === branchName &&
               desc.includes(customerName) &&
               desc.includes(customerEmailAddress);
      });
      if (targetCandidates.length > 0) originEvent = targetCandidates[0];
    }
  } catch (e) {
    Logger.log(`[Calendar] 원본 캘린더 확인 중 오류 (무시하고 진행): ${e.message}`);
  }

  // B. 대상 캘린더(지점)에 이벤트 생성
  let newEventId = '';
  let targetCalenderId = branchInfo.calendarId;
  let targetCal = null;

  try {
    targetCal = CalendarApp.getCalendarById(targetCalenderId);
    if (!targetCal) throw new Error(`대상 캘린더 없음: ${targetCalenderId}`);

    const newTitle = `${customerName} (${copiedNumberOfPeople})`;
    let newDescription = `이름: ${customerName}\n인원: ${copiedNumberOfPeople}\n노트: ${customerNotes}\n이메일: ${customerEmailAddress}\n지점: ${branchInfo.branchNameKo}\n방문일: ${Utilities.formatDate(copiedStartDate, "Asia/Seoul", "MM/dd HH:mm")}`;
    
    const newEvent = targetCal.createEvent(newTitle, copiedStartDate, copiedEndDate, { description: newDescription });
    
    // 알림 설정 (원본 알림이 있으면 복사, 없으면 기본 30분)
    if (originEvent) {
      originEvent.getPopupReminders().forEach(min => newEvent.addPopupReminder(min));
    } else {
      newEvent.addPopupReminder(30);
    }
    
    newEventId = newEvent.getId();
    Logger.log(`[Calendar] 대상 캘린더 이벤트 생성 완료: ${newEventId}`);

  } catch (e) {
    throw new Error(`대상 캘린더 이벤트 생성 실패: ${e.message}`);
  }

  // C. 슬롯 체크 및 원본 정리
  try {
    const resService = new ReservationService();
    const maxTimeSlot = resService.getMaxTimeSlot(branchName, copiedStartDate);
    const currentTimeSlot = resService.getCurrentTimeSlot(branchName, copiedStartDate, targetCal);
    
    // 슬롯 여유가 있으면 원본 삭제 (없으면 냅둠 - 중복 방지 로직 등은 별도 고려)
    if (maxTimeSlot !== -1 && currentTimeSlot !== -1 && currentTimeSlot < maxTimeSlot) {
      if (originEvent) {
        originEvent.deleteEvent();
        Logger.log(`[Calendar] 슬롯 여유로 원본 이벤트 삭제함`);
      }
    }
  } catch (e) {
    Logger.log(`[Slot] 슬롯 체크 중 오류 (무시): ${e.message}`);
  }

  // --- 4. 메일 스레드 ID 찾기 ---
  let mailThreadId = '';
  try {
    const mailThreads = new GmailService().findBookingMail(branchName, customerName, customerEmailAddress, numberOfPeople, copiedStartDate, customerNotes, copiedBookingRequestDate);
    if (mailThreads && mailThreads.length > 0) {
      mailThreadId = mailThreads[0].getId();
    }
  } catch (e) {
    Logger.log(`[Mail] 메일 스레드 찾기 실패: ${e.message}`);
  }

  // --- 5. Reservation 시트(웹앱 DB)에 데이터 적재 ---
  // 요구사항 컬럼 순서:
  // id, response_id, booking_request_date, branch_id, reservation_date, name, number_of_people, notes, email_address, email_thread_id, calendar_id, event_id, enabled, message_sent_at, created_at, updated_at
  
  const now = new Date();
  const reservationRow = [
    Utilities.getUuid(),          // id (Reservation PK)
    newResponseId,                // response_id (FK from Responses L column)
    copiedBookingRequestDate,     // booking_request_date
    branchInfo.branchId,          // branch_id (지점 UUID)
    copiedStartDate,              // reservation_date
    customerName,                 // name
    copiedNumberOfPeople,         // number_of_people
    customerNotes,                // notes
    customerEmailAddress,         // email_address
    mailThreadId,                 // email_thread_id
    targetCalenderId,             // calendar_id
    newEventId,                   // event_id
    true,                         // enabled
    false,                        // is_read
    '',                           // message_sent_at
    now,                          // created_at
    now                           // updated_at
  ];

  reservationSheet.appendRow(reservationRow);
  
  // --- 6. Responses 시트 상태 업데이트 (선택사항) ---
  // L열은 이미 채웠으므로, 만약 별도의 Status 컬럼(M열 등)을 쓴다면 여기서 업데이트
  // responseSheet.getRange(STATUS_COLUMN + currentRow).setValue("SUCCESS");
  
  Logger.log(`[processNewReservation] ${currentRow}행 처리 완료.`);
}