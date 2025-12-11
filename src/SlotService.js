class SlotService {
  constructor() {
    this.ss = SpreadsheetApp.openById(SPREADSHEET_ID);

    this.permSheet = this.ss.getSheetByName(SHEET_NAMES.USER_PERMISSION);
    this.slotMasterSheet = this.ss.getSheetByName(SHEET_NAMES.SLOT_MASTER);
    this.slotOverrideSheet = this.ss.getSheetByName(SHEET_NAMES.SLOT_OVERRIDE);
    this.slotDefaultSheet = this.ss.getSheetByName(SHEET_NAMES.SLOT_DEFAULT);

    this.permHeaders = this.permSheet.getRange(1, 1, 1, this.permSheet.getLastColumn()).getValues()[0];
    this.slotMasterHeaders = this.slotMasterSheet.getRange(1, 1, 1, this.slotMasterSheet.getLastColumn()).getValues()[0];
    this.slotOverrideHeaders = this.slotOverrideSheet.getRange(1, 1, 1, this.slotOverrideSheet.getLastColumn()).getValues()[0];
    this.slotDefaultHeaders = this.slotDefaultSheet.getRange(1, 1, 1, this.slotDefaultSheet.getLastColumn()).getValues()[0];
  }

  _getData(sheetName, id) {
    let sheet;
    let headers;
    if (sheetName === SHEET_NAMES.USER_PERMISSION) {
      sheet = this.permSheet;
      headers = this.permHeaders;
    } else if (sheetName === SHEET_NAMES.SLOT_MASTER) {
      sheet = this.slotMasterSheet;
      headers = this.slotMasterHeaders;
    } else if (sheetName === SHEET_NAMES.SLOT_OVERRIDE) {
      sheet = this.slotOverrideSheet;
      headers = this.slotOverrideHeaders;
    } else if (sheetName === SHEET_NAMES.SLOT_DEFAULT) {
      sheet = this.slotDefaultSheet;
      headers = this.slotDefaultHeaders;
    }

    if (sheet && headers) {
      const rows = sheet.getDataRange().getValues();
      for (let i = 1; i < rows.length; i++) {
        if (rows[i][0] === id) {
          const row = rows[i];
          const obj = {};

          // row → columnName: value 형태로 객체 변환
          headers.forEach((header, idx) => {
            obj[header] = row[idx];
          });

          return { row, obj };
        }
      }
    }

    return null;
  }

  /**
   * [Main Router] 시트 이름에 따라 적절한 조회 메서드를 호출합니다.
   * @param {string} sheetName - 시트 이름
   * @param {Object} userInfo - 현재 로그인한 유저 정보 {id, role, ...}
   */
  getSlotData(sheetName, userInfo) {
    if (sheetName === 'slot_default') {
      // 1. 기본 슬롯 (피벗 테이블 + 권한 필터링)
      return this.getPivotedDefaultSlots(userInfo);
    } else if (sheetName === 'slot_override') {
      return this.getFilteredSheetData(sheetName, userInfo);
    } else {
      // 3. 마스터 슬롯 (공통 데이터, 필터링 불필요)
      return this.getSimpleSheetData(sheetName);
    }
  }

  /**
   * [Read - Pivot] slot_default 데이터를 피벗 테이블로 변환합니다.
   * (지점 권한 필터링 적용)
   */
  getPivotedDefaultSlots(userInfo) {
    try {
      // 1. 지점(Branch) 데이터 가져오기
      // getSheetData는 WebApi.gs 혹은 Util.gs에 정의된 전역 함수라고 가정
      const branchTable = getSheetData('branch');
      let branchesData = branchTable.slice(1); // 헤더 제외

      // 2. [핵심] 권한 필터링 (Admin이 아니면 내 지점만 남김)
      if (userInfo.role !== 'admin') {
        // id(0), user_id(1), branch_id(2), enabled(3)
        const permData = this.permSheet.getDataRange().getValues();

        // 내 user_id와 일치하고 enabled인 branch_id 목록 추출
        const allowedBranchIds = permData
          .filter(row => row[1] === userInfo.id && row[3] === true)
          .map(row => row[2]);

        // 지점 목록 필터링
        branchesData = branchesData.filter(branch => allowedBranchIds.includes(branch[0]));
      }

      // 3. 활성화된 지점만 2차 필터링 (enabled 컬럼은 인덱스 4라고 가정)
      branchesData = branchesData.filter(branchInfo => branchInfo[4] === true);

      // 4. 슬롯 마스터(Time) 정보 매핑
      const slotsData = getSheetData('slot_master').slice(1);
      const slotMasterMap = new Map();
      for (const slot of slotsData) {
        // id -> 'HH:mm'
        slotMasterMap.set(slot[0], formatDate(slot[1], 'time'));
      }

      // 5. 피벗 헤더 생성
      const headers = ['id', 'branch_name'];
      const timeHeaders = [];
      for (const [id, time] of slotMasterMap) {
        headers.push(time);
        timeHeaders.push({ id: id, time: time });
      }

      // 6. slot_default 데이터 매핑 (Lookup Map 생성)
      const defaultsData = getSheetData('slot_default').slice(1);
      const defaultMap = new Map();
      // slot_default: id(0), branch_id(1), slot_master_id(2), slot(3), enabled(4)
      for (const def of defaultsData) {
        const key = `${def[1]}_${def[2]}`; // "branchUUID_slotUUID"
        defaultMap.set(key, { slot: def[3], enabled: def[4] });
      }

      // 7. 피벗 행(Row) 데이터 생성
      const pivotRows = [];
      // branch: id(0), ..., branch_name_ko(2)
      for (const branch of branchesData) {
        const branchId = branch[0];
        const branchName = branch[2];

        const row = {
          id: branchId,
          branch_name: branchName,
          slots: {}
        };

        // 모든 시간대에 대해 slot 값 채우기
        for (const timeHeader of timeHeaders) {
          const key = `${branchId}_${timeHeader.id}`;
          const data = defaultMap.get(key);

          row.slots[timeHeader.time] = {
            slot_master_id: timeHeader.id,
            slot: data ? data.slot : 0,
            enabled: data ? data.enabled : false
          };
        }
        pivotRows.push(row);
      }

      return { success: true, headers: headers, rows: pivotRows, timeHeaders: timeHeaders };

    } catch (e) {
      Logger.log('getPivotedDefaultSlots 실패: ' + e.message);
      return { success: false, error: e.message };
    }
  }

  /**
   * [Read - Filtered] 일반 시트 데이터를 가져오되, 지점 권한으로 필터링합니다.
   * (주로 slot_override 용)
   */
  getFilteredSheetData(sheetName, userInfo) {
    try {
      const data = getSheetData(sheetName);
      if (data.length <= 1) return data; // 헤더만 있거나 비어있음

      const header = data[0];
      const body = data.slice(1);

      // Admin이면 전체 리턴
      if (userInfo.role === 'admin') return data;

      // Manager면 필터링
      const permData = this.permSheet.getDataRange().getValues();

      const allowedBranchIds = permData
        .filter(row => row[1] === userInfo.id && row[3] === true)
        .map(row => row[2]);

      // slot_override 구조: id(0), branch_id(1), ... 라고 가정
      // branch_id가 내 허용 목록에 있는 행만 필터링
      const filteredBody = body.filter(row => allowedBranchIds.includes(row[1]));

      return [header, ...filteredBody]; // 헤더 + 필터링된 데이터

    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * [Read - Simple] 단순 시트 데이터 조회
   */
  getSimpleSheetData(sheetName) {
    const data = getSheetData(sheetName);

    // 시스템 컬럼 제거
    return removeColumns(data, ['created_at', 'updated_at']);
  }

  /**
   * [Create] 레코드 추가 (slot_master, slot_override)
   */
  createRecord(sheetName, recordData) {
    try {
      const sheet = this.ss.getSheetByName(sheetName);
      const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];

      const newUuid = Utilities.getUuid();
      const now = new Date();

      const newRow = headers.map(header => {
        if (header === 'id') return newUuid;
        if (header === 'created_at' || header === 'updated_at') return now;

        if (header === 'date') {
          recordData[header] = new Date(recordData[header]);
        }

        // recordData에 값이 없으면 기본값 처리
        if (recordData[header] === undefined || recordData[header] === null) {
          if (header === 'enabled') return true;
          return "";
        }
        return recordData[header];
      });

      sheet.appendRow(newRow);

      if (sheetName === SHEET_NAMES.SLOT_OVERRIDE) {
        const slotMasterData = this._getData(SHEET_NAMES.SLOT_MASTER, recordData.slot_master_id);
        if (slotMasterData) {
          const mergedDateObj = new Date(recordData.date);
          const time = slotMasterData.obj.time;

          mergedDateObj.setHours(
            time.getHours(),
            time.getMinutes(),
            0,   // seconds = 00
            0    // milliseconds = 000
          );
          new ReservationService().syncSourceSlot(recordData.branch_id, mergedDateObj);
        }
      }

      // 직렬화 (Date -> String)
      const serializedRow = [newRow].map(row => row.map(cell => (cell instanceof Date) ? cell.toISOString() : cell));
      return { success: true, newRecord: serializedRow[0] };

    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * [Update] 레코드 수정 (slot_master, slot_override)
   */
  updateRecord(sheetName, id, recordData) {
    try {
      const sheet = this.ss.getSheetByName(sheetName);
      const data = sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn()).getValues();
      const headers = data[0];

      for (let i = 1; i < data.length; i++) {
        if (data[i][0] == id) { // UUID 일치 확인
          let dbDateObj;
          const updatedRow = headers.map((header, index) => {
            if (header === 'id') return data[i][index]; // ID 불변
            if (header === 'created_at') return data[i][index]; // 생성일 불변
            if (header === 'updated_at') return new Date(); // 수정일 갱신

            if (header === 'date') {
              recordData[header] = new Date(recordData[header]);
              dbDateObj = data[i][index];
            }

            if (recordData[header] === undefined) {
              // 체크박스(enabled)가 해제되어 넘어오지 않은 경우 처리
              if (header === 'enabled') return false;
              return data[i][index]; // 변경 없음
            }
            return recordData[header]; // 변경 값
          });

          sheet.getRange(i + 1, 1, 1, updatedRow.length).setValues([updatedRow]);

          if (sheetName === SHEET_NAMES.SLOT_OVERRIDE) {
            const slotMasterData = this._getData(SHEET_NAMES.SLOT_MASTER, recordData.slot_master_id);
            if (slotMasterData) {
              const mergedDateObj = new Date(recordData.date);
              const time = slotMasterData.obj.time;

              mergedDateObj.setHours(
                time.getHours(),
                time.getMinutes(),
                0,   // seconds = 00
                0    // milliseconds = 000
              );
              const reservationService = new ReservationService();
              
              reservationService.syncSourceSlot(recordData.branch_id, dbDateObj);
              reservationService.syncSourceSlot(recordData.branch_id, mergedDateObj);
            }
          }

          const serializedRow = [updatedRow].map(row => row.map(cell => (cell instanceof Date) ? cell.toISOString() : cell));

          return { success: true, updatedRecord: serializedRow[0] };
        }
      }
      return { success: false, error: `해당 ID를 찾을 수 없습니다. ${id}` };

    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
 * [Update] 레코드 수정 (slot_master, slot_override)
 */
  deleteRecord(sheetName, id) {
    try {
      const sheet = this.ss.getSheetByName(sheetName);
      const data = sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn()).getValues();
      const targetData = this._getData(sheetName, id);

      for (let i = 1; i < data.length; i++) {
        if (data[i][0] == id) { // UUID 일치 확인
          sheet.deleteRow(i + 1);

          if (sheetName === SHEET_NAMES.SLOT_OVERRIDE) {
            const slotMasterData = this._getData(SHEET_NAMES.SLOT_MASTER, targetData.obj.slot_master_id);
            if (slotMasterData) {
              const mergedDateObj = new Date(targetData.obj.date);
              const time = slotMasterData.obj.time;

              mergedDateObj.setHours(
                time.getHours(),
                time.getMinutes(),
                0,   // seconds = 00
                0    // milliseconds = 000
              );
              new ReservationService().syncSourceSlot(targetData.obj.branch_id, mergedDateObj);
            }
          }

          return { success: true };
        }
      }
      return { success: false, error: `해당 ID를 찾을 수 없습니다. ${id}` };

    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * [Update - Batch] 기본 슬롯 일괄 수정 (slot_default 전용)
   */
  updateDefaultBatch(branchId, slotsPayload) {
    try {
      const sheet = this.ss.getSheetByName('slot_default');
      const data = sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn()).getValues();
      const headers = data[0]; // id, branch_id, slot_master_id, slot, enabled ...

      // 1. 기존 데이터 매핑 (현재 지점의 데이터만)
      const existingRowMap = new Map(); // key: slot_master_id, value: rowIndex
      if (data.length > 1) {
        for (let i = 1; i < data.length; i++) {
          if (data[i][1] === branchId) { // branch_id 일치
            existingRowMap.set(data[i][2], i + 1); // slot_master_id -> row index
          }
        }
      }

      const rowsToAppend = [];
      const rangesToUpdate = [];
      const valuesToUpdate = [];
      const now = new Date();

      // 2. Payload 순회
      Object.entries(slotsPayload).forEach(([slotMasterId, values]) => {
        const { slot, enabled } = values;
        const rowIndex = existingRowMap.get(slotMasterId);

        if (rowIndex) {
          // --- 업데이트 ---
          // 전체 행을 다 가져와서 필요한 부분만 바꿈
          const currentRow = data[rowIndex - 1]; // data는 0-based array

          // 헤더 순서대로 값 매핑
          const updatedRow = headers.map((h, idx) => {
            if (h === 'slot') return slot;
            if (h === 'enabled') return enabled;
            if (h === 'updated_at') return now;
            return currentRow[idx];
          });

          rangesToUpdate.push(sheet.getRange(rowIndex, 1, 1, headers.length).getA1Notation());
          valuesToUpdate.push(updatedRow);

        } else {
          // --- 신규 추가 ---
          const newRow = headers.map(h => {
            if (h === 'id') return Utilities.getUuid();
            if (h === 'branch_id') return branchId;
            if (h === 'slot_master_id') return slotMasterId;
            if (h === 'slot') return slot;
            if (h === 'enabled') return enabled;
            if (h === 'created_at' || h === 'updated_at') return now;
            return "";
          });
          rowsToAppend.push(newRow);
        }
      });

      // 3. 시트 반영
      // 업데이트 (Batch)
      if (rangesToUpdate.length > 0) {
        const rangeList = sheet.getRangeList(rangesToUpdate);
        const ranges = rangeList.getRanges();
        for (let i = 0; i < ranges.length; i++) {
          ranges[i].setValues([valuesToUpdate[i]]);
        }
      }

      // 추가 (Batch)
      if (rowsToAppend.length > 0) {
        sheet.getRange(sheet.getLastRow() + 1, 1, rowsToAppend.length, headers.length).setValues(rowsToAppend);
      }

      return { success: true };

    } catch (e) {
      Logger.log('updateDefaultBatch 실패: ' + e.message);
      return { success: false, error: e.message };
    }
  }

  /**
   * [Core Logic] 특정 지점, 날짜, 시간의 최대 예약 가능 슬롯 수 조회
   * (우선순위: Override > Default > 0)
   */
  getMaxTimeSlot(branchId, dateObj) {
    try {
      // 1. 시간 문자열 추출 (HH:mm)
      const timeStr = Utilities.formatDate(dateObj, "Asia/Seoul", "HH:mm");
      const dateStr = Utilities.formatDate(dateObj, "Asia/Seoul", "yyyy-MM-dd");

      // 2. slot_master에서 해당 시간의 ID 찾기 (캐싱하면 더 좋음)
      const masterData = this.slotMasterSheet.getDataRange().getValues().slice(1);
      let slotMasterId = null;

      for (const row of masterData) {
        const mTime = formatDate(row[1], 'time'); // Util.gs 함수
        if (mTime === timeStr) {
          slotMasterId = row[0];
          break;
        }
      }

      if (!slotMasterId) {
        Logger.log(`[SlotService] 시간 설정 없음: ${timeStr}`);
        return -1;
      }

      // 3. [1순위] Override 시트 검색
      // 구조: id, branch_id, slot_master_id, date, slot, reason, enabled
      const overrideData = this.slotOverrideSheet.getDataRange().getValues().slice(1);
      for (const row of overrideData) {
        const rBranchId = row[1];
        const rMasterId = row[2];
        const rDate = formatDate(row[3], 'date');
        const rEnabled = Boolean(row[6]); // enabled

        if (
          rBranchId === branchId
          && rMasterId === slotMasterId
          && rDate === dateStr
          && rEnabled === true
        ) {
          return Number(row[4]);
        }
      }

      // 4. [2순위] Default 시트 검색
      // 구조: id, branch_id, slot_master_id, slot, enabled
      const defaultData = this.slotDefaultSheet.getDataRange().getValues().slice(1);
      for (const row of defaultData) {
        const rBranchId = row[1];
        const rMasterId = row[2];
        const rEnabled = row[4]; // enabled

        if (rBranchId === branchId && rMasterId === slotMasterId) {
          return rEnabled ? Number(row[3]) : 0;
        }
      }

      // 설정 없음
      return 0;

    } catch (e) {
      Logger.log(`[SlotService] MaxSlot 조회 오류: ${e.message}`);
      return -1;
    }
  }
}