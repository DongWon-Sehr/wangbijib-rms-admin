class ReservationService {
  constructor() {
    this.ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    this.resSheet = this.ss.getSheetByName(SHEET_NAMES.RESERVATION);
    this.permSheet = this.ss.getSheetByName(SHEET_NAMES.USER_PERMISSION);
    this.branchSheet = this.ss.getSheetByName(SHEET_NAMES.BRANCH);

    this.slotMasterSheet = this.ss.getSheetByName(SHEET_NAMES.SLOT_MASTER);
    this.slotDefaultSheet = this.ss.getSheetByName(SHEET_NAMES.SLOT_DEFAULT);
    this.slotOverrideSheet = this.ss.getSheetByName(SHEET_NAMES.SLOT_OVERRIDE);

    this.calService = new CalendarService();
    this.slotService = new SlotService();
    this.branchService = new BranchService();

    this.headers = this.resSheet.getRange(1, 1, 1, this.resSheet.getLastColumn()).getValues()[0];
  }

  getReservation(id) {
    const rows = this.resSheet.getDataRange().getValues();
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === id) {
        const row = rows[i];
        const obj = {};

        // row → columnName: value 형태로 객체 변환
        this.headers.forEach((header, idx) => {
          obj[header] = row[idx];
        });

        return { row, obj };
      }
    }

    return null;
  }

  /**
   * [Read] 예약 목록 조회 (Web App용)
   */
  getReservations(startDate, endDate, searchMode, userInfo) {
    try {
      if (!this.resSheet) {
        Logger.log(`[Error] 'reservation' 시트를 찾을 수 없습니다. 시트 이름을 확인하세요.`);
        return []; // null 대신 빈 배열 리턴
      }

      const data = this.resSheet.getDataRange().getValues();
      if (data.length <= 1) {
        Logger.log(`[Info] 예약 데이터가 없습니다.`);
        return []; // null 대신 빈 배열 리턴
      }

      const rows = data.slice(1); // 헤더 제외

      // 1. 날짜 필터링
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);

      const startTime = start.getTime();
      const endTime = end.getTime();

      // 방문일(visit_date)은 E열 (Index 4)
      // 요청일(request_date)은 C열 (Index 2)
      const targetColIndex = (searchMode === 'request') ? 2 : 4;

      let filteredRows = rows.filter(row => {
        const visitDateVal = row[targetColIndex]; // E열: reservation_date (인덱스 4)
        if (!visitDateVal) return false;
        const rowTime = new Date(visitDateVal).getTime();
        return rowTime >= startTime && rowTime <= endTime;
      });

      if (!userInfo) {
        Logger.log('getReservations: userInfo 누락됨');
        return [];
      }

      // 2. 권한 필터링 (Manager)
      if (userInfo.role !== 'admin') {
        if (!this.permSheet) {
          Logger.log(`[Error] 권한 시트(user_branch_permission)가 없습니다.`);
          return [];
        }

        const permData = this.permSheet.getDataRange().getValues();
        const allowedBranchIds = permData
          .filter(p => p[1] === userInfo.id && p[3] === true)
          .map(p => p[2]);

        filteredRows = filteredRows.filter(row => allowedBranchIds.includes(row[3])); // D열: branch_id (인덱스 3)
      }

      // 3. 데이터 매핑
      return filteredRows.map((row, index) => ({
        id: row[0],
        branch_id: row[3],
        customer_name: row[5],
        visit_date: formatDate(row[4], 'date'),
        visit_time: formatDate(row[4], 'time'),
        pax: row[6],
        email: row[8],
        notes: row[7],
        status: Boolean(row[12]),
        request_date: formatDate(row[2], 'datetime'),
        message_sent_at: row[14] ? formatDate(row[14], 'datetime') : '',
        is_read: Boolean(row[13]),

        // UI에서 필요한 추가 정보
        row: index + 2,
        kakaoData: this.getKakaoMessageData(row[0]),
      }));

    } catch (e) {
      Logger.log(`[Critical Error] getReservations 실패: ${e.message}`);
      return [];
    }
  }

  getKakaoMessageData(id) {
    try {
      const reservation = this.getReservation(id);
      if (!reservation) { // 1행은 보통 헤더이므로 1 이하는 거부
        throw new Error(`예약정보(${id})를 찾을 수 없습니다.`);
      }

      const branchId = reservation.obj.branch_id;
      const branchInfo = this.branchService.getBranch(branchId);
      if (!branchInfo) {
        throw new Error(`지점정보(${branchId})를 찾을 수 없습니다.`);
      }
      const branchNameKo = branchInfo.obj.branch_name_ko;

      const isEnabled = Boolean(reservation.obj.enabled);
      const messageSentAt = reservation.obj.message_sent_at || '';

      const titleBranchName = branchNameKo.replace('왕비집', '').trim();

      let title;
      if (!isEnabled) {
        title = `🔴 [취소] ${titleBranchName} 예약알림`;
      } else if (messageSentAt) {
        title = `🟡 [변경] ${titleBranchName} 예약알림`;
      } else {
        title = `🟢 [신규] ${titleBranchName} 예약알림`;
      }

      let body = '';
      body += `- 방문일: ${Utilities.formatDate(reservation.obj.reservation_date, "Asia/Seoul", "MM/dd HH:mm")}\n`;
      body += `- 이름: ${reservation.obj.name}\n`;
      body += `- 인원: ${reservation.obj.number_of_people}\n`;
      body += reservation.obj.notes ? `- 노트: ${reservation.obj.notes}\n` : '';
      body += `- 이메일: ${reservation.obj.email_address}\n`;
      body += `\n- 예약ID: ${reservation.obj.id}\n`;

      const calendarId = reservation.obj.calendar_id;
      const eventId = reservation.obj.event_id;
      let link = '';
      if (!calendarId || !eventId) {
        // throw new Error(`calendarId, eventId 조회 실패`);
        Logger.log(`[getMessageData] calendarId, eventId 조회 실패`);
      } else {
        const eventIdPrefix = eventId.split('@')[0];
        const cid = Utilities.base64EncodeWebSafe(calendarId).replace(/=+$/, '');
        const combinedIdForEid = eventIdPrefix + " " + calendarId;
        const eid = Utilities.base64EncodeWebSafe(combinedIdForEid).replace(/=+$/, '');
        link = `https://calendar.google.com/calendar/u/0/r/month?cid=${cid}&eid=${eid}`;
      }

      // HTML로 전송할 데이터를 객체로 만듭니다.
      return {
        title: title,
        body: body,
        link: link,
      };
    } catch (e) {
      // 오류가 발생하면 HTML에 오류 메시지를 전송합니다.
      Logger.log('데이터 조회 오류: ' + e.message);
      throw new Error('데이터 조회 중 오류: ' + e.message);
    }
  }

  markAsRead(id) {
    const data = this.resSheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === id) { // UUID 일치
        const rowIndex = i + 1;
        // N열 (14번째 열) -> is_read = true
        this.resSheet.getRange(rowIndex, 14).setValue(true);
        return { success: true };
      }
    }
    return { success: false };
  }

  /**
   * [Update Status] 예약 상태 변경
   * @param {string} id - UUID
   * @param {boolean} isEnabled - true(예약) / false(취소)
   */
  updateStatus(id, isEnabled) {
    const boolStatus = (String(isEnabled) === 'true');

    const data = this.resSheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === id) {
        const rowIndex = i + 1;
        const rowData = data[i];

        // DB 업데이트
        this.resSheet.getRange(rowIndex, 13).setValue(boolStatus); // enabled
        this.resSheet.getRange(rowIndex, 17).setValue(new Date()); // updated_at

        // 캘린더 및 슬롯 처리
        const branchId = rowData[3];
        const reservationDate = new Date(rowData[4]); // Date Object
        const targetCalendarId = rowData[10];
        const eventId = rowData[11];

        if (boolStatus === false) {
          // [취소] -> Target 이벤트 삭제
          this.deleteTargetEvent(targetCalendarId, eventId);

          // [취소] -> 슬롯이 비었는지 확인하고 Source 이벤트 정리 (슬롯 OPEN 시도)
          this.syncSourceSlot(branchId, reservationDate);
        } else {
        }

        return { success: true, status: boolStatus };
      }
    }
    return { success: false, error: '예약을 찾을 수 없습니다.' };
  }

  updateMessageSentAt(id) {
    const data = this.resSheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === id) {
        const rowIndex = i + 1;

        // DB 업데이트
        this.resSheet.getRange(rowIndex, 15).setValue(new Date()); // message_sent_at

        return { success: true };
      }
    }
    return { success: false, error: '예약을 찾을 수 없습니다.' };
  }

  /**
   * [Update] 예약 정보 수정
   */
  updateReservation(data) {
    const rows = this.resSheet.getDataRange().getValues();
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === data.id) { // UUID 일치
        const rowIndex = i + 1;
        const currentRow = rows[i];

        const rawDbBookingRequestDate = new Date(currentRow[2]);
        const dbBookingRequestDate = new Date(rawDbBookingRequestDate);
        dbBookingRequestDate.setSeconds(0);
        dbBookingRequestDate.setMilliseconds(0);
        const dbBranchId = currentRow[3];      // D열
        const rawDbReservationDate = new Date(currentRow[4]);
        const dbReservationDate = new Date(rawDbReservationDate);
        dbReservationDate.setSeconds(0);
        dbReservationDate.setMilliseconds(0);
        const dbName = currentRow[5];          // F열
        const dbPax = Number(currentRow[6]);   // G열
        const dbNotes = currentRow[7];         // H열
        const dbEmail = currentRow[8];         // I열
        const dbEmailThreadId = currentRow[9]; // J열
        const dbCalendarId = currentRow[10];   // K열
        const dbEventId = currentRow[11];      // L열
        const dbStatus = Boolean(currentRow[12]); // M열 (Enabled)

        let newReservationDate = new Date(dbReservationDate);
        if (data.visit_date && data.visit_time) {
          const datePart = new Date(data.visit_date);
          const [hh, mm] = data.visit_time.split(':').map(Number);
          datePart.setHours(hh, mm, 0, 0);
          newReservationDate = datePart;
        }

        const newStatus = (String(data.status) === 'true');

        let isChanged = false;
        const changes = {};

        // 지점 변경 여부
        if (dbBranchId !== data.branch_id) {
          changes.branch = true;
          isChanged = true;
          this.resSheet.getRange(rowIndex, 4).setValue(data.branch_id);
        }

        // 시간 변경 여부
        if (dbReservationDate.getTime() !== newReservationDate.getTime()) {
          changes.time = true;
          isChanged = true;
          this.resSheet.getRange(rowIndex, 5).setValue(newReservationDate);
        }

        // 이름 변경
        if (dbName !== data.customer_name) {
          isChanged = true;
          this.resSheet.getRange(rowIndex, 6).setValue(data.customer_name);
        }

        // 인원 변경 (숫자 비교)
        if (dbPax !== Number(data.pax)) {
          isChanged = true;
          changes.content = true; // 내용 변경 (캘린더 업데이트용)
          this.resSheet.getRange(rowIndex, 7).setValue(data.pax);
        }

        // 비고 변경
        if (dbNotes !== data.notes) {
          isChanged = true;
          changes.content = true;
          this.resSheet.getRange(rowIndex, 8).setValue(data.notes);
        }

        // 이메일 변경
        if (dbEmail !== data.email) {
          isChanged = true;
          changes.content = true;
          this.resSheet.getRange(rowIndex, 9).setValue(data.email);
        }

        // 상태 변경
        if (dbStatus !== newStatus) {
          isChanged = true;
          // 상태 변경은 캘린더 취소/생성 로직과 연결될 수 있으나, 
          // 여기서는 값만 업데이트하고 아래 캘린더 로직에서 처리
          this.resSheet.getRange(rowIndex, 13).setValue(newStatus);

          if (newStatus) {
            new GmailService().setConfirmLabel(dbEmailThreadId);
          } else {
            new GmailService().setCancelLabel(dbEmailThreadId);
          }
        }

        if (!isChanged) {
          Logger.log(`[Update] 변경 사항 없음. ID: ${data.id}`);
          return { success: true, message: 'No changes detected' };
        }

        this.resSheet.getRange(rowIndex, 17).setValue(new Date());

        if (dbStatus === true && newStatus === false) {
          this.deleteTargetEvent(dbCalendarId, dbEventId);
          this.syncSourceSlot(dbBranchId, dbReservationDate); // 기존 시간 슬롯 오픈
        }

        if (newStatus === true) {
          const title = this.getTargetEventTitle(data.customer_name, data.pax);

          const branchNameKo = this.getBranchNameById(dbBranchId, 'ko')
          const desc = this.getTargetEventDescription(
            data.customer_name,
            data.pax,
            data.notes,
            data.email,
            branchNameKo,
            newReservationDate,
            dbBookingRequestDate
          );

          if (newStatus === true) {
            // [Case A] 지점 변경 (이동)
            if (changes.branch) {
              // 기존 삭제
              this.calService.deleteEvent(dbCalendarId, dbEventId);
              this.syncSourceSlot(dbBranchId, dbReservationDate);

              // 신규 생성
              const newTargetCalId = this.getCalendarIdByBranchId(data.branch_id);
              const newEventId = this.calService.createEvent(newTargetCalId, title, newReservationDate, desc);

              // DB ID 업데이트
              if (newTargetCalId && newEventId) {
                this.resSheet.getRange(rowIndex, 11).setValue(newTargetCalId);
                this.resSheet.getRange(rowIndex, 12).setValue(newEventId);
              }

              this.syncSourceSlot(data.branch_id, newReservationDate); // 신규 지점/시간 슬롯 체크
            }

            // [Case B] 시간만 변경 (이동) - 지점은 그대로
            else if (changes.time) {
              // 시간 변경: 기존 수정
              this.calService.updateEvent(dbCalendarId, dbEventId, title, newReservationDate, desc);

              // 슬롯 체크: 구 시간 & 신 시간 모두
              this.syncSourceSlot(dbBranchId, dbReservationDate); // 구 시간
              this.syncSourceSlot(dbBranchId, newReservationDate); // 신 시간
            }

            // [Case C] 단순 내용 변경 (이름, 인원 등)
            else if (changes.content) {
              // 내용 변경: 기존 수정
              this.calService.updateEvent(dbCalendarId, dbEventId, title, newReservationDate, desc);
            }
          }
        }
        
        return { success: true };
      }
    }
    return { success: false, error: '해당 예약을 찾을 수 없습니다.' };
  }

  updateReservationStatus(id, newStatus) {
    newStatus = (String(newStatus) === 'true');
    const rows = this.resSheet.getDataRange().getValues();
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === id) { // UUID 일치
        const rowIndex = i + 1;
        const currentRow = rows[i];

        const rawDbBookingRequestDate = new Date(currentRow[2]);
        const dbBookingRequestDate = new Date(rawDbBookingRequestDate);
        dbBookingRequestDate.setSeconds(0);
        dbBookingRequestDate.setMilliseconds(0);

        const dbBranchId = currentRow[3];      // D열

        const rawDbReservationDate = new Date(currentRow[4]);
        const dbReservationDate = new Date(rawDbReservationDate);
        dbReservationDate.setSeconds(0);
        dbReservationDate.setMilliseconds(0);

        const dbName = currentRow[5];          // F열
        const dbPax = Number(currentRow[6]);   // G열
        const dbNotes = currentRow[7];         // H열
        const dbEmail = currentRow[8];         // I열
        const dbEmailThreadId = currentRow[9]; // J열
        const dbCalendarId = currentRow[10];   // K열
        const dbEventId = currentRow[11];      // L열

        this.resSheet.getRange(rowIndex, 13).setValue(newStatus);
        this.resSheet.getRange(rowIndex, 17).setValue(new Date());

        if (newStatus === false) {
          this.deleteTargetEvent(dbCalendarId, dbEventId);
          this.syncSourceSlot(dbBranchId, dbReservationDate); // 기존 시간 슬롯 오픈
        } else {
          const title = this.getTargetEventTitle(dbName, dbPax);

          const branchNameKo = this.getBranchNameById(dbBranchId, 'ko')
          const desc = this.getTargetEventDescription(
            dbName,
            dbPax,
            dbNotes,
            dbEmail,
            branchNameKo,
            dbReservationDate,
            dbBookingRequestDate
          );

          // 기존 삭제
          if (dbCalendarId && dbEventId) {
            this.calService.deleteEvent(dbCalendarId, dbEventId);
          }

          // 신규 생성
          const newTargetCalId = this.getCalendarIdByBranchId(dbBranchId);
          const newEventId = this.calService.createEvent(newTargetCalId, title, dbReservationDate, desc);

          // DB ID 업데이트
          if (newTargetCalId && newEventId) {
            this.resSheet.getRange(rowIndex, 11).setValue(newTargetCalId);
            this.resSheet.getRange(rowIndex, 12).setValue(newEventId);
          }

          this.syncSourceSlot(dbBranchId, dbReservationDate); // 신규 지점/시간 슬롯 체크
        }

        if (newStatus === true) {
          new GmailService().setConfirmLabel(dbEmailThreadId);
        } else {
          new GmailService().setCancelLabel(dbEmailThreadId);
        }

        return { success: true };
      }
    }
  }

  getTargetEventTitle(customerName, pax) {
    return `${customerName} (${pax})`;
  }

  getTargetEventDescription(
    customerName,
    pax,
    customerNotes,
    customerEmailAddress,
    branchNameKo,
    reservationDate,
    bookingRequestDate
  ) {
    let newDescription = '';
    newDescription += `이름: ${customerName}\n`;
    newDescription += `인원: ${pax}\n`;
    newDescription += `노트: ${customerNotes}\n`;
    newDescription += `이메일: ${customerEmailAddress}\n`;
    newDescription += `지점: ${branchNameKo}\n`;
    newDescription += `방문일: ${Utilities.formatDate(reservationDate, "Asia/Seoul", "MM/dd HH:mm")}\n`;
    newDescription += `예약요청일: ${Utilities.formatDate(bookingRequestDate, "Asia/Seoul", "MM/dd")}\n`;

    return newDescription;
  }

  syncSourceSlot(branchId, dateObj) {
    try {
      // 1. 정보 조회
      const branchNameEn = this.getBranchNameById(branchId, 'en');
      const targetCalId = this.getCalendarIdByBranchId(branchId);

      // 2. 슬롯 계산
      const maxSlot = this.slotService.getMaxTimeSlot(branchId, dateObj);
      const currentSlot = this.calService.getEventCount(targetCalId, dateObj);

      Logger.log(`[SyncSource] ${branchNameEn} ${dateObj} | 현재: ${currentSlot} / 최대: ${maxSlot}`);

      // 3. 정책 적용
      if (maxSlot !== -1 && currentSlot < maxSlot) {
        // [여유 있음] -> Source 캘린더에 "블로킹 이벤트"가 있다면 삭제해서 위젯을 열어야 함
        Logger.log(`[SyncSource] 여유 있음 -> Source 이벤트 삭제 시도`);
        this.calService.deleteSourceEventIfExists(branchNameEn, dateObj);
      } else {
        // [꽉 찼음] -> Source 캘린더 이벤트가 없다면 생성해서 블로킹 해야 함
        Logger.log(`[SyncSource] 꽉 찼음 -> Source 이벤트 생성 시도`);
        this.calService.addSourceEventIfNotExists(branchNameEn, dateObj);
      }
    } catch (e) {
      Logger.log(`[SyncSource] 오류: ${e.message}`);
    }
  }

  createTargetEvent(calId, data, dateObj) {
    const title = `${data.customer_name} (${data.pax}명)`;
    const desc = `이름: ${data.customer_name}\n인원: ${data.pax}\n메모: ${data.notes}\n이메일: ${data.email}`;
    return this.calService.createEvent(calId, title, dateObj, desc);
  }

  modifyTargetEvent(calId, eventId, data, dateObj) {
    const title = `${data.customer_name} (${data.pax}명)`;
    const desc = `이름: ${data.customer_name}\n인원: ${data.pax}\n메모: ${data.notes}\n이메일: ${data.email}`;
    this.calService.updateEvent(calId, eventId, title, dateObj, desc);
  }

  deleteTargetEvent(calId, eventId) {
    this.calService.deleteEvent(calId, eventId);
  }

  // --- Branch Info ---
  getCalendarIdByBranchId(branchId) {
    const data = this.branchSheet.getDataRange().getValues();
    // ⚠️ [확인 필요] Branch 시트의 calendar_id 컬럼 인덱스 (예: 5번 F열)
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === branchId) return data[i][5];
    }
    return null;
  }

  getBranchNameById(branchId, lang = 'en') {
    const data = this.branchSheet.getDataRange().getValues();
    const colIdx = lang === 'en' ? 1 : 2
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === branchId) return data[i][colIdx];
    }
    return '';
  }

  /**
   * (Helper) 슬롯 가용성 체크
   * @returns {boolean} 예약 가능 여부
   */
  checkAvailability(branchId, calendarId, dateObj) {
    const max = this.slotService.getMaxTimeSlot(branchId, dateObj);
    const current = this.calService.getEventCount(calendarId, dateObj);

    if (max === -1) return false; // 설정 오류
    return current < max;
  }
}