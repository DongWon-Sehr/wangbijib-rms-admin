/**
 * [ReservationBatch] 1분 주기 트리거 (Entry Point)
 * - 신규 예약 감지 -> DB 이관 -> 캘린더 생성 -> 메일 발송
 * - 예약금 정책(9인 이상) 자동 적용
 */
function processPendingReservation() {
  console.log(`[Batch] Start processing...`);

  const ss = Util.getSpreadsheet();
  const resSheet = ss.getSheetByName(Config.SHEET_NAMES.RAW_REQUEST); // Responses
  const dbSheet = ss.getSheetByName(Config.SHEET_NAMES.RESERVATION); // reservation

  if (!resSheet || !dbSheet) {
    console.log('[Batch] Sheet not found.');
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
        console.log(`[Batch] Error at row ${rowIndex}: ${e.message}`);
      }
    }
  }

  if (processedCount > 0) {
    console.log(`[Batch] Processed ${processedCount} reservations.`);
  }

  // [Retry Logic] email_thread_id 누락 건 보정 시도
  repairMissingThreadIds();
}

/**
 * [Retry Logic] email_thread_id가 비어있는 최근 예약 건들을 찾아 재검색 및 보정
 */
function repairMissingThreadIds() {
  try {
    const reservations = Util.getSheetDataAsObjects(Config.SHEET_NAMES.RESERVATION);
    const now = new Date();
    const window = 24 * 60 * 60 * 1000; // 24시간 (ms)

    // 대상 필터링: ID 없고, 취소 안됐고, 생성된 지 24시간 이내인 건
    const targets = reservations.filter(r => {
      const createdAt = r.created_at ? new Date(r.created_at) : null;
      return !r.email_thread_id &&
        r.status !== Config.RESERVATION_STATUS.CANCEL &&
        createdAt && (now - createdAt < window);
    });

    if (targets.length === 0) return;

    console.log(`[Batch] Found ${targets.length} reservations with missing threadId. Attempting to repair...`);

    // 효율성을 위해 한 번에 최대 10건만 처리
    const limit = 10;
    const processList = targets.slice(0, limit);

    processList.forEach(res => {
      const foundId = GmailService.findThreadId({
        branchName: BranchService.getBranchNameEn(res.branch_id),
        customerName: res.customer_name,
        email: res.email,
        pax: res.pax,
        phoneNumber: res.phone_number,
        startDate: new Date(res.reservation_date),
        notes: res.notes,
        bookingRequestDate: new Date(res.booking_request_date)
      });

      if (foundId) {
        // 1. 시트 업데이트
        ReservationService.updateCell(res.id, 'email_thread_id', foundId);
        console.log(`[Batch] Repaired threadId for ${res.customer_name} (${res.id})`);

        // 2. 지메일 라벨 동기화 (발송 전이라도 라벨을 붙여둠)
        GmailService.updateReservationLabel(foundId, GmailService.RESERVATION_LABELS.PENDING);
      }
    });

  } catch (e) {
    console.log(`[Batch] repairMissingThreadIds Error: ${e.message}`);
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
    console.log(`[Batch] Missing required fields at row ${rowIndex}`);
    return;
  }

  // 'Group Reservation' 지점명은 무시 (기존 로직 유지)
  if (rawData.branchName === 'Group Reservation') {
    console.log(`[Batch] Skip 'Group Reservation' at row ${rowIndex}`);
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

    if (rawData.pax <= 19) {
      depositAmount = Config.DEPOSIT.BASE_AMOUNT;
    } else {
      const extraPax = rawData.pax - 19;
      // 1~10명 초과 -> 1단위, 11~20명 초과 -> 2단위
      const extraUnits = Math.ceil(extraPax / Config.DEPOSIT.UNIT_PAX);
      depositAmount = Config.DEPOSIT.BASE_AMOUNT + (extraUnits * Config.DEPOSIT.UNIT_AMOUNT);
    }

    // 59명 초과 시 에러 처리 (기존 60명에서 59명으로 기준 변경)
    if (rawData.pax > 59) {
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
    notes: "'" + rawData.notes,
    phone_number: "'" + rawData.phoneNumber,
    email: rawData.email,
    email_thread_id: threadId || '',
    calendar_id: branchInfo.calendar_id,
    event_id: '', // 캘린더 생성 후 업데이트
    internal_notes: '',
    is_read: false,
    deposit_status: depositStatus,
    deposit_amount: depositAmount,
    deposit_paid_at: '',
    deposit_refund_at: '',
    message_sent_at: '',
    status: Config.RESERVATION_STATUS.PENDING,
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
  const syncMsg = SlotService.syncSourceSlot(branchInfo.id, reservationDate);
  if (syncMsg) console.log(syncMsg);

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
        console.log(`[Batch] Deposit mail sent to ${rawData.customerName}`);
        GmailService.updateDepositLabel(threadId, GmailService.DEPOSIT_LABELS.PENDING);
      } else {
        // 템플릿 비어있음 등으로 발송 안됨
        console.log(`[Batch] Mail send skipped: ${mailResult.message}`);
      }
    } else {
      // 템플릿 비어있음 등으로 발송 안됨
      console.log(`[Batch] Mail send skipped: maxPaxOverError`);
    }
  }

  if (threadId) {
    // 예약 대기 라벨 처리 (선택사항)
    GmailService.updateDepositLabel(threadId, GmailService.RESERVATION_LABELS.PENDING);
  }
}

/**
 * [Trigger] 백그라운드 슬롯 동기화 큐 처리 (일반 - 이어달리기 방식)
 * - 3초마다 깨어나서 SLOT_SYNC_QUEUE에 있는 작업을 처리
 */
function triggerBackgroundSlotSync() {
  console.log('[Batch] triggerBackgroundSlotSync start');
  const lock = LockService.getScriptLock();
  const props = PropertiesService.getScriptProperties();
  const QUEUE_KEY = 'SLOT_SYNC_QUEUE';
  const HANDLER_NAME = 'triggerBackgroundSlotSync';

  try {
    // 1. Lock 획득 (최대 30초 대기)
    lock.waitLock(30000);

    const queueStr = props.getProperty(QUEUE_KEY);
    if (!queueStr) return;

    let queue = [];
    try {
      queue = JSON.parse(queueStr);
    } catch (e) {
      props.deleteProperty(QUEUE_KEY);
      return;
    }

    if (queue.length === 0) {
      props.deleteProperty(QUEUE_KEY);
      return;
    }

    // 2. 큐에서 작업 하나 꺼내기 (FIFO)
    const task = queue.shift();
    const daysRemaining = task.daysTotal - task.daysProcessed;

    if (daysRemaining > 0) {
      const dayWindow = 10;
      const daysToProcess = Math.min(dayWindow, daysRemaining);
      const startMs = task.startDateMs + (task.daysProcessed * 24 * 60 * 60 * 1000);

      // 동기화 실행 (Lock 해제 전 처리하여 안정성 확보 - syncFutureSlots 내부에서 API 호출)
      SlotService.syncFutureSlots(task.branchId, startMs, daysToProcess);

      task.daysProcessed += daysToProcess;
      if (task.daysProcessed < task.daysTotal) {
        queue.push(task);
      }
    }

    // 3. 남은 큐 저장 및 트리거 관리
    if (queue.length > 0) {
      props.setProperty(QUEUE_KEY, JSON.stringify(queue));

      // 기존 트리거 청소 후 다음 바통 터치
      const triggers = ScriptApp.getProjectTriggers();
      triggers.forEach(t => {
        if (t.getHandlerFunction() === HANDLER_NAME) ScriptApp.deleteTrigger(t);
      });

      ScriptApp.newTrigger(HANDLER_NAME).timeBased().after(3 * 1000).create();
    } else {
      props.deleteProperty(QUEUE_KEY);
      console.log(`[Batch] ${HANDLER_NAME} finished. Queue empty.`);
    }

  } catch (e) {
    console.log(`[Batch] ${HANDLER_NAME} error: ${e.message}`);
    // 에러 발생 시 큐를 삭제하지 않고 유지 (다음 트리거 혹은 배치에서 재시도)
  } finally {
    if (lock.hasLock()) lock.releaseLock();
  }
}

/**
 * [Trigger] 긴급 슬롯 동기화 큐 처리 (수동 요청용 - 병렬 실행)
 * - 사용자가 UI에서 설정을 바꿨을 때 SLOT_URGENT_QUEUE를 처리
 */
function triggerUrgentSlotSync() {
  console.log('[Batch] triggerUrgentSlotSync start');
  const lock = LockService.getScriptLock();
  const props = PropertiesService.getScriptProperties();
  const QUEUE_KEY = 'SLOT_URGENT_QUEUE';
  const HANDLER_NAME = 'triggerUrgentSlotSync';

  try {
    // 1. Lock 획득
    lock.waitLock(30000);

    const queueStr = props.getProperty(QUEUE_KEY);
    if (!queueStr) return;

    let queue = [];
    try {
      queue = JSON.parse(queueStr);
    } catch (e) {
      props.deleteProperty(QUEUE_KEY);
      return;
    }

    if (queue.length === 0) {
      props.deleteProperty(QUEUE_KEY);
      return;
    }

    // 2. 큐에서 작업 하나 꺼내기 (FIFO)
    const task = queue.shift();
    const daysRemaining = task.daysTotal - task.daysProcessed;

    if (daysRemaining > 0) {
      const dayWindow = 10;
      const daysToProcess = Math.min(dayWindow, daysRemaining);
      const startMs = task.startDateMs + (task.daysProcessed * 24 * 60 * 60 * 1000);

      SlotService.syncFutureSlots(task.branchId, startMs, daysToProcess);

      task.daysProcessed += daysToProcess;
      if (task.daysProcessed < task.daysTotal) {
        queue.push(task);
      }
    }

    // 3. 남은 큐 저장 및 트리거 관리
    if (queue.length > 0) {
      props.setProperty(QUEUE_KEY, JSON.stringify(queue));

      const triggers = ScriptApp.getProjectTriggers();
      triggers.forEach(t => {
        if (t.getHandlerFunction() === HANDLER_NAME) ScriptApp.deleteTrigger(t);
      });

      ScriptApp.newTrigger(HANDLER_NAME).timeBased().after(3 * 1000).create();
    } else {
      props.deleteProperty(QUEUE_KEY);
      console.log(`[Batch] ${HANDLER_NAME} finished. Queue empty.`);
    }

  } catch (e) {
    console.log(`[Batch] ${HANDLER_NAME} error: ${e.message}`);
  } finally {
    if (lock.hasLock()) lock.releaseLock();
  }
}

/**
 * [Batch] 매일 새벽에 실행되어 향후 40일간의 슬롯을 동기화 (Track 2)
 * - Time-driven trigger로 매일 새벽 실행
 * - 직접 처리하지 않고 큐에 넣어서 이어달리기 시작
 */
function processDailySlotSync() {
  console.log('[Batch] processDailySlotSync start');
  try {
    const branches = BranchService.getAllBranches();
    console.log(`[Batch] Found ${branches.length} total branches from sheet.`);
    
    const activeBranchIds = branches
      .filter(b => b.enabled === true || String(b.enabled) === 'true')
      .map(b => b.id);
    
    console.log(`[Batch] Active branches to process: ${activeBranchIds.length}`);

    // 활성화된 지점들을 큐에 한 번에 등록 (트리거 부하 최적화)
    if (activeBranchIds.length > 0) {
      SlotService.enqueueSlotSyncBatch(activeBranchIds);
    }

  } catch (e) {
    console.log(`[Batch] processDailySlotSync error: ${e.message}`);
  }
  console.log('[Batch] processDailySlotSync end');
}