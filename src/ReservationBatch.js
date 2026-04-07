/**
 * [ReservationBatch] 1분 주기 트리거 (Entry Point)
 * - 신규 예약 감지 -> DB 이관 -> 캘린더 생성 -> 메일 발송
 * - 예약금 정책(9인 이상) 자동 적용
 */
function processPendingReservation() {
  Logger.log(`[Batch] Start processing...`);
  
  const ss = Util.getSpreadsheet();
  const resSheet = ss.getSheetByName(Config.SHEET_NAMES.RAW_REQUEST); // Responses
  const dbSheet = ss.getSheetByName(Config.SHEET_NAMES.RESERVATION); // reservation

  if (!resSheet || !dbSheet) {
    Logger.log('[Batch] Sheet not found.');
    return;
  }

  // 데이터 로드 (속도를 위해 전체 로드 후 메모리 처리)
  const dataRange = resSheet.getDataRange();
  const values = dataRange.getValues();
  // const headers = values[0]; // 헤더는 참고용

  // Responses 시트의 컬럼 인덱스 (0-based)
  // A=0(Branch), C=2(Start), D=3(End), F=5(Name), G=6(Email), H=7(Notes), I=8(Pax), K=10(ReqDate), L=11(ID)
  const IDX = {
    BRANCH: 0,
    START: 1,
    END: 2,
    NAME: 4,
    EMAIL: 5,
    PHONE: 6,
    NOTES: 7,
    PAX: 8,
    REQ_DATE: 10,
    RES_ID: 11
  };
  
  let processedCount = 0;

  // 1행은 헤더이므로 1부터 시작
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const responseId = row[IDX.RES_ID]; 
    const branchName = row[IDX.BRANCH];

    // [조건] Response ID가 없고 지점명이 있는 경우 = 신규 예약
    if (!responseId && branchName) {
      const rowIndex = i + 1; // 실제 시트 행 번호 (1-based)
      try {
        processSingleReservation(row, rowIndex, resSheet, dbSheet, IDX);
        processedCount++;
      } catch (e) {
        Logger.log(`[Batch] Error at row ${rowIndex}: ${e.message}`);
      }
    }
  }

  if (processedCount > 0) {
    Logger.log(`[Batch] Processed ${processedCount} reservations.`);
  }
}

/**
 * 단일 예약 건 처리 로직
 */
function processSingleReservation(row, rowIndex, resSheet, dbSheet, idx) {
  // 1. 데이터 파싱
  const rawData = {
    branchName: row[idx.BRANCH],
    startDate: row[idx.START],
    endDate: row[idx.END],
    customerName: row[idx.NAME],
    email: row[idx.EMAIL],
    phoneNumber: row[idx.PHONE],
    notes: row[idx.NOTES] || '',
    pax: Number(row[idx.PAX]),
    bookingRequestDate: row[idx.REQ_DATE]
  };

  // 필수 값 검증
  if (!rawData.branchName || !rawData.startDate || !rawData.customerName) {
    Logger.log(`[Batch] Missing required fields at row ${rowIndex}`);
    return;
  }

  // 'Group Reservation' 지점명은 무시 (기존 로직 유지)
  if (rawData.branchName === 'Group Reservation') {
    Logger.log(`[Batch] Skip 'Group Reservation' at row ${rowIndex}`);
    return; 
  }

  // 2. 지점 정보 조회 (BranchService)
  // Responses 시트의 지점명은 영문(branch_name_en)이라고 가정
  const branches = BranchService.getAllBranches();
  const branchInfo = branches.find(b => b.branch_name_en === rawData.branchName);
  
  if (!branchInfo) {
    throw new Error(`Branch not found: ${rawData.branchName}`);
  }

  // 3. UUID 생성 및 Responses 시트 마킹 (중복 방지)
  const newResponseId = Util.getUuid();
  // L열(12번째)에 ID 기록
  resSheet.getRange(rowIndex, idx.RES_ID + 1).setValue(newResponseId);

  // 4. 예약금 정책 적용 (v1.4 핵심)
  let depositStatus = Config.DEPOSIT_STATUS.NA;
  let depositAmount = 0;

  let maxPaxOverError = false;
  if (rawData.pax >= Config.DEPOSIT.THRESHOLD_PAX) {
    depositStatus = Config.DEPOSIT_STATUS.PENDING;
    
    // 금액 계산: 9~20명=$100, 21~30명=$200 ...
    if (rawData.pax <= 19) {
      depositAmount = Config.DEPOSIT.BASE_AMOUNT;
    } else {
      const extraPax = rawData.pax - 19;
      // 1~10명 초과 -> 1단위, 11~20명 초과 -> 2단위
      const extraUnits = Math.ceil(extraPax / Config.DEPOSIT.UNIT_PAX);
      depositAmount = Config.DEPOSIT.BASE_AMOUNT + (extraUnits * Config.DEPOSIT.UNIT_AMOUNT);
    }

    if (rawData.pax > 60) {
      maxPaxOverError = true;
    }
  }

  // 5. 이메일 스레드 찾기 (GmailService)
  const threadId = GmailService.findThreadId({
    branchName: rawData.branchName,
    customerName: rawData.customerName,
    email: rawData.email,
    pax: row[idx.PAX],
    phoneNumber: row[idx.PHONE],
    startDate: new Date(rawData.startDate),
    notes: rawData.notes,
    bookingRequestDate: new Date(rawData.bookingRequestDate)
  });

  // 6. DB(reservation) 적재용 객체 생성
  const now = new Date();
  const reservationDate = new Date(rawData.startDate);
  const requestDate = new Date(rawData.bookingRequestDate);

  const reservationObj = {
    id: Util.getUuid(),
    response_id: newResponseId,
    booking_request_date: requestDate,
    branch_id: branchInfo.id,
    reservation_date: reservationDate,
    customer_name: rawData.customerName,
    pax: rawData.pax,
    notes: rawData.notes,
    phone_number: "'" + rawData.phoneNumber,
    email: rawData.email,
    email_thread_id: threadId || '',
    calendar_id: branchInfo.calendar_id,
    event_id: '', // 캘린더 생성 후 업데이트
    enabled: true,
    is_read: false,
    
    // v1.4 신규 컬럼
    internal_notes: '',
    deposit_status: depositStatus,
    deposit_amount: depositAmount,
    deposit_paid_at: '',
    deposit_refund_at: '',
    
    created_at: now,
    updated_at: now
  };

  // 7. 캘린더 이벤트 생성 (Target Calendar)
  // 이벤트 설명에 필요한 정보 구성
  const title = `${rawData.customerName} (${rawData.pax})`;
  const desc = `\n이름: ${rawData.customerName}\n인원: ${rawData.pax}\n노트: ${rawData.notes}\n이메일: ${rawData.email}`;
  
  const eventId = CalendarService.createEvent(branchInfo.calendar_id, title, reservationDate, desc);
  
  if (eventId) {
    reservationObj.event_id = eventId;
  }

  // 8. 시트에 저장 (Util Helper 사용)
  const dbHeaders = dbSheet.getRange(1, 1, 1, dbSheet.getLastColumn()).getValues()[0];
  const dbRow = Util.convertObjectToRow(reservationObj, dbHeaders);
  dbSheet.appendRow(dbRow);

  // 9. 슬롯 동기화 (Source Calendar) - 마감 여부 체크
  SlotService.syncSourceSlot(branchInfo.id, reservationDate);

  // 10. 자동 메일 발송 (조건부)
  if (threadId && depositStatus === Config.DEPOSIT_STATUS.PENDING) {
    // 템플릿용 데이터
    const mailData = {
      customer_name: rawData.customerName,
      branch_name_en: rawData.branchName, 
      reservation_date: reservationDate,
      reservation_time: Util.formatDate(reservationDate, 'time'),
      pax: rawData.pax,
      notes: rawData.notes,
      deposit_amount: depositAmount
    };

    if (maxPaxOverError === false) {
      // 예약금 대기 안내 메일 발송
      const mailResult = GmailService.replyToThreadWithTemplate(
        threadId, 
        Config.MAIL_TEMPLATES.DEPOSIT_PENDING, 
        mailData
      );

      if (mailResult.success) {
        Logger.log(`[Batch] Deposit mail sent to ${rawData.customerName}`);
        GmailService.updateDepositLabel(threadId, GmailService.DEPOSIT_LABELS.PENDING);
      } else {
        // 템플릿 비어있음 등으로 발송 안됨
        Logger.log(`[Batch] Mail send skipped: ${mailResult.message}`);
      }
    } else {
      // 템플릿 비어있음 등으로 발송 안됨
      Logger.log(`[Batch] Mail send skipped: maxPaxOverError`);
    }
  }
  
  if (threadId) {
    // 예약 대기 라벨 처리 (선택사항)
    GmailService.updateDepositLabel(threadId, GmailService.RESERVATION_LABELS.PENDING);
  }
}