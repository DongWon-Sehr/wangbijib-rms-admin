/**
 * [ReservationService] 예약 정보 관리 및 비즈니스 로직 (Singleton)
 */
const ReservationService = {
  // ============================================================
  // 1. SCHEMA DEFINITION (컬럼명 및 타입 하드코딩)
  // ============================================================
  SCHEMA: {
    // 기본 정보
    'id': { type: 'string' },
    'response_id': { type: 'string' },
    'booking_request_date': { type: 'date' },
    'branch_id': { type: 'string' },
    'reservation_date': { type: 'date' },
    'customer_name': { type: 'string' },
    'pax': { type: 'number' },
    'notes': { type: 'string' },
    'phone_number': { type: 'string' },
    'email': { type: 'string' },
    'email_thread_id': { type: 'string' },
    
    // 연동 정보
    'calendar_id': { type: 'string' },
    'event_id': { type: 'string' },
    
    // 상태 정보
    'status': { type: 'string' },
    'is_read': { type: 'boolean' },
    'message_sent_at': { type: 'date' },
    
    // 관리자 및 예약금 정보 (v1.4)
    'internal_notes': { type: 'string' },
    'deposit_status': { type: 'string' },
    'deposit_amount': { type: 'number' },
    'deposit_paid_at': { type: 'date' },
    'deposit_refund_at': { type: 'date' },
    
    // 메타 정보
    'created_at': { type: 'date' },
    'updated_at': { type: 'date' }
  },

  DEPOSIT_STATUS: {
    NA: 'n/a',
    PENDING: 'pending',
    CONFIRM: 'confirm',
    REFUND: 'refund',
  },

  // ============================================================
  // 2. READ METHODS
  // ============================================================

  /**
   * [Read] 예약 목록 전체 조회
   */
  getAllReservations(userInfo) {
    try {
      const reservations = Util.getSheetDataAsObjects(Config.SHEET_NAMES.RESERVATION);
      
      if (!userInfo) return [];

      if (userInfo.role === Config.USER_ROLES.ADMIN) {
        return reservations;
      } else {
        const allowed = userInfo.allowedBranchIds || [];
        return reservations.filter(r => allowed.includes(r.branch_id));
      }
    } catch (e) {
      console.log(`[ReservationService] getAll Error: ${e.message}`);
      throw e;
    }
  },

  /**
   * [Read] 단일 예약 조회
   */
  getReservationById(id) {
    const reservations = Util.getSheetDataAsObjects(Config.SHEET_NAMES.RESERVATION);
    return reservations.find(r => r.id === id);
  },

  // ============================================================
  // 3. UPDATE METHODS
  // ============================================================

  /**
   * [Update] 예약 읽음 처리 (is_read 단독 업데이트)
   */
  markAsRead(id) {
    return this.updateCell(id, 'is_read', true);
  },

  /**
   * [Update] 예약 정보 수정 (Safe Partial Update)
   * - 스키마 기반 데이터 검증 및 타입 변환 적용
   */
  updateReservation(id, data) {
    try {
      if (!id) return Util.createResponse(false, null, 'Reservation ID is required');

      const sheet = Util.getSpreadsheet().getSheetByName(Config.SHEET_NAMES.RESERVATION);
      const allData = sheet.getDataRange().getValues();
      const headers = allData[0];
      const idIdx = headers.indexOf('id');

      if (idIdx === -1) throw new Error('ID Column not found');

      // 1. 대상 행 찾기
      let targetRowIndex = -1;
      let currentRow = [];
      for (let i = 1; i < allData.length; i++) {
        if (allData[i][idIdx] === id) {
          targetRowIndex = i + 1; // 1-based index
          currentRow = allData[i];
          break;
        }
      }

      if (targetRowIndex === -1) return Util.createResponse(false, null, 'Reservation not found');

      // 2. 가상 필드 처리 (visit_date + visit_time -> reservation_date)
      if (data.visit_date && data.visit_time) {
        const [y, m, d] = data.visit_date.split('-').map(Number);
        const [hh, mm] = data.visit_time.split(':').map(Number);
        // 입력 객체에 reservation_date를 직접 주입 (스키마 로직 활용을 위해)
        data['reservation_date'] = new Date(y, m - 1, d, hh, mm);
      }

      // 3. 스키마 기반 데이터 매핑 및 변경 감지
      let isChanged = false;
      const changes = {}; 
      const updatedRow = [...currentRow];

      // 입력 데이터의 모든 키 순회
      Object.keys(data).forEach(inputKey => {
        // [Changed] 별칭 매핑 로직 제거 (Input Key가 곧 DB Key)
        const dbKey = inputKey;

        // 스키마에 정의된 컬럼인지 확인
        const schemaDef = this.SCHEMA[dbKey];
        if (!schemaDef) return; // 스키마에 없는 키는 무시 (안전)

        // 시트 헤더 인덱스 확인
        const colIdx = headers.indexOf(dbKey);
        if (colIdx === -1) return;

        // 값 추출 및 undefined 체크
        const rawValue = data[inputKey];
        if (rawValue === undefined) return; // 값이 없으면 건너뜀 (기존 값 유지)

        // 타입 변환
        let safeValue = rawValue;
        if (schemaDef.type === 'number') {
          safeValue = Number(rawValue);
          if (isNaN(safeValue)) return; // 숫자가 아니면 스킵
        } else if (schemaDef.type === 'boolean') {
          safeValue = String(rawValue) === 'true' || rawValue === true;
        } else if (schemaDef.type === 'string') {
          safeValue = String(rawValue);
        } else if (schemaDef.type === 'date') {
          if (!(rawValue instanceof Date)) safeValue = new Date(rawValue);
          if (isNaN(safeValue.getTime())) return; // 유효하지 않은 날짜 스킵
        }

        // 값 변경 비교
        const currentVal = currentRow[colIdx];
        let isDiff = false;
        
        if (schemaDef.type === 'date') {
          // 날짜 비교
          const t1 = currentVal instanceof Date ? currentVal.getTime() : 0;
          const t2 = safeValue.getTime();
          if (Math.abs(t1 - t2) > 1000) isDiff = true; // 1초 이상 차이 시 변경으로 간주
        } else {
          // 일반 비교
          if (currentVal != safeValue) isDiff = true;
        }

        if (isDiff) {
          updatedRow[colIdx] = safeValue;
          isChanged = true;
          changes[dbKey] = true;
        }
      });

      if (!isChanged) {
        return Util.createResponse(true, null, 'No changes detected');
      }

      // 4. 메타데이터 업데이트
      const updatedAtIdx = headers.indexOf('updated_at');
      if (updatedAtIdx > -1) updatedRow[updatedAtIdx] = new Date();

      // 5. 저장
      sheet.getRange(targetRowIndex, 1, 1, updatedRow.length).setValues([updatedRow]);

      // 6. 동기화 로직 (주요 필드 변경 시)
      if (changes.branch_id || changes.reservation_date || changes.status || changes.pax || changes.customer_name) {
        this.syncCalendarAndSlot(currentRow, updatedRow, headers, changes);
      }

      return Util.createResponse(true);

    } catch (e) {
      console.log(`[ReservationService] Update Error: ${e.message}`);
      return Util.createResponse(false, null, e.message);
    }
  },

  /**
   * [Update] 상태만 빠르게 변경
   */
  updateReservationStatus(id, newStatus) {
    try {
      const validStatuses = Object.values(Config.RESERVATION_STATUS);
      if (!validStatuses.includes(newStatus)) {
        throw new Error(`newStatus (${newStatus}) is invalid`);
      }

      // update Google Sheet
      const reservationUpdate = this.updateReservation(id, { status: newStatus });
      if (!reservationUpdate.success) {
        throw new Error('Fail to update sheet');
      }

      const reservation = this.getReservationById(id);
      if (newStatus === Config.RESERVATION_STATUS.CANCEL) {
        // update Gmail Label
        const labelUpdate = GmailService.updateReservationLabel(reservation.email_thread_id, GmailService.RESERVATION_LABELS.CANCEL);
        if (!labelUpdate) {
          console.log(`[ReservationService] updateReservationStatus Warn: Reservation Label 업데이트 실패`);
        }
      } else if (newStatus === Config.RESERVATION_STATUS.CONFIRM) {
        const labelUpdate = GmailService.updateReservationLabel(reservation.email_thread_id, GmailService.RESERVATION_LABELS.CONFIRM);
        if (!labelUpdate) console.log(`[ReservationService] Warn: Reservation Label 업데이트 실패`);
      } else if (newStatus === Config.RESERVATION_STATUS.PENDING) {
        const labelUpdate = GmailService.updateReservationLabel(reservation.email_thread_id, GmailService.RESERVATION_LABELS.PENDING);
        if (!labelUpdate) console.log(`[ReservationService] Warn: Reservation Label 업데이트 실패`);
      }

      return Util.createResponse(true);
    } catch (e) {
      console.log(`[ReservationService] updateReservationStatus Error: ${e.message}`);
      return Util.createResponse(false, null, e.message);
    }
  },

  /**
   * [Update] 상태만 빠르게 변경
   */
  updateDepositStatus(id, newStatus) {
    try {
      const statusNames = Object.values(this.DEPOSIT_STATUS);
      if (!statusNames.includes(newStatus)) {
        throw new Error(`newStatus (${newStatus}) is invalid (must be one of ${"'" + Object.values(this.DEPOSIT_STATUS).join("', '") + "'"})`);
      }

      // update Google Sheet
      const reservationUpdate = this.updateReservation(id, { deposit_status : newStatus });
      if (!reservationUpdate.success) {
        throw new Error('Fail to update sheet');
      }

      const reservation = this.getReservationById(id);
      if (newStatus === this.DEPOSIT_STATUS.NA) {
        // update Gmail Label
        const labelUpdate = GmailService.deleteDepositLabel(reservation.email_thread_id);
        if (!labelUpdate) {
          console.log(`[ReservationService] updateDepositStatus Warn: Deposit Label 삭제 실패`);
        }
      } else if (newStatus === this.DEPOSIT_STATUS.PENDING) {
        const labelUpdate = GmailService.updateDepositLabel(reservation.email_thread_id, GmailService.DEPOSIT_LABELS.PENDING);
        if (!labelUpdate) {
          console.log(`[ReservationService] updateDepositStatus Warn: Deposit Label 업데이트 실패 (${GmailService.DEPOSIT_LABELS.PENDING})`);
        }
      } else if (newStatus === this.DEPOSIT_STATUS.CONFIRM) {
        const labelUpdate = GmailService.updateDepositLabel(reservation.email_thread_id, GmailService.DEPOSIT_LABELS.CONFIRM);
        if (!labelUpdate) {
          console.log(`[ReservationService] updateDepositStatus Warn: Deposit Label 업데이트 실패 (${GmailService.DEPOSIT_LABELS.CONFIRM})`);
        }
      } else if (newStatus === this.DEPOSIT_STATUS.REFUND) {
        const labelUpdate = GmailService.updateDepositLabel(reservation.email_thread_id, GmailService.DEPOSIT_LABELS.REFUND);
        if (!labelUpdate) {
          console.log(`[ReservationService] updateDepositStatus Warn: Deposit Label 업데이트 실패 (${GmailService.DEPOSIT_LABELS.REFUND})`);
        }
      }

      return Util.createResponse(true);
    } catch (e) {
      console.log(`[ReservationService] updateDepositStatus Error: ${e.message}`);
      return Util.createResponse(false, null, e.message);
    }
  },

  updateMessageSentAt(id) {
    try {
      // update Google Sheet
      const reservationUpdate = this.updateReservation(id, { message_sent_at: new Date(), status: Config.RESERVATION_STATUS.CONFIRM });
      if (!reservationUpdate.success) {
        throw new Error('Fail to update sheet');
      }

      // update Gmail Label
      const reservation = this.getReservationById(id);
      const labelUpdate = GmailService.updateReservationLabel(reservation.email_thread_id, GmailService.RESERVATION_LABELS.CONFIRM);
      if (!labelUpdate) {
        console.log(`[ReservationService] updateMessageSentAt Warn: Reservation Label 업데이트 실패`);
      }

      return Util.createResponse(true);
    } catch (e) {
      console.log(`[ReservationService] updateMessageSentAt Error: ${e.message}`);
      return Util.createResponse(false, null, e.message);
    }
  },

  /**
   * [Helper] 단일 셀 업데이트 (가볍게 처리)
   */
  updateCell(id, colName, value) {
    const sheet = Util.getSpreadsheet().getSheetByName(Config.SHEET_NAMES.RESERVATION);
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const idIdx = headers.indexOf('id');
    const colIdx = headers.indexOf(colName);

    if (idIdx === -1 || colIdx === -1) return Util.createResponse(false, null, 'Column not found');

    for (let i = 1; i < data.length; i++) {
      if (data[i][idIdx] === id) {
        sheet.getRange(i + 1, colIdx + 1).setValue(value);
        return Util.createResponse(true);
      }
    }
    return Util.createResponse(false, null, 'Not found');
  },

  /**
   * [Logic] 캘린더 및 슬롯 동기화
   */
  syncCalendarAndSlot(oldRow, newRow, headers, changes) {
    try {
      const getVal = (row, key) => row[headers.indexOf(key)];

      const oldBranchId = getVal(oldRow, 'branch_id');
      const newBranchId = getVal(newRow, 'branch_id');
      const oldDate = new Date(getVal(oldRow, 'reservation_date'));
      const newDate = new Date(getVal(newRow, 'reservation_date'));
      const status = getVal(newRow, 'status');
      
      const calendarId = getVal(newRow, 'calendar_id');
      const eventId = getVal(newRow, 'event_id');

      // 1. 취소됨
      if (status === Config.RESERVATION_STATUS.CANCEL) {
        if (eventId) CalendarService.deleteEvent(calendarId, eventId);
        SlotService.syncSourceSlot(oldBranchId, oldDate);
        return;
      }

      // 2. 지점/날짜 변경 (이동)
      if (changes.branch_id || changes.reservation_date) {
        if (eventId) CalendarService.deleteEvent(calendarId, eventId);
        SlotService.syncSourceSlot(oldBranchId, oldDate); // 구 슬롯 해제

        const targetCalId = BranchService.getCalendarId(newBranchId);
        const title = `${getVal(newRow, 'customer_name')} (${getVal(newRow, 'pax')})`;
        // [Changed] Use internal method _buildEventDesc
        const desc = this._buildEventDesc(newRow, headers);
        
        const newEventId = CalendarService.createEvent(targetCalId, title, newDate, desc);
        this.updateCell(getVal(newRow, 'id'), 'calendar_id', targetCalId);
        this.updateCell(getVal(newRow, 'id'), 'event_id', newEventId);

        SlotService.syncSourceSlot(newBranchId, newDate); // 신규 슬롯 반영
      } 
      // 3. 내용만 변경
      else if (changes.customer_name || changes.pax || changes.notes || changes.internal_notes) {
        const title = `${getVal(newRow, 'customer_name')} (${getVal(newRow, 'pax')})`;
        // [Changed] Use internal method _buildEventDesc
        const desc = this._buildEventDesc(newRow, headers);
        CalendarService.updateEvent(calendarId, eventId, title, newDate, desc);
      }

    } catch (e) {
      console.log(`[Sync] Fail: ${e.message}`);
    }
  },

  updateEventIdsInSheet(id, calId, evtId) {
    const sheet = Util.getSpreadsheet().getSheetByName(Config.SHEET_NAMES.RESERVATION);
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const idIdx = headers.indexOf('id');
    const calIdx = headers.indexOf('calendar_id');
    const evtIdx = headers.indexOf('event_id');

    for (let i = 1; i < data.length; i++) {
      if (data[i][idIdx] === id) {
        sheet.getRange(i + 1, calIdx + 1).setValue(calId);
        sheet.getRange(i + 1, evtIdx + 1).setValue(evtId);
        break;
      }
    }
  },

  // [Changed] Internal method convention
  _buildEventDesc(row, headers) {
      const _getVal = (key) => row[headers.indexOf(key)];
      return `\n이름: ${_getVal('customer_name')}\n인원: ${_getVal('pax')}\n노트: ${_getVal('notes')}\n관리자메모: ${_getVal('internal_notes')}`;
  }
};