/**
 * [SlotService] 슬롯 설정 및 관리 (Default / Override)
 */
const SlotService = {
  /**
   * [Core] 특정 지점, 특정 날짜/시간의 최대 수용 가능 인원(슬롯) 조회
   * 우선순위: Override(커스텀) > Default(기본) > Master(기본값 0)
   */
  getMaxSlot(branchId, dateObj) {
    try {
      const timeStr = Util.formatDate(dateObj, 'time'); // HH:mm
      const dateStr = Util.formatDate(dateObj, 'date'); // YYYY-MM-DD

      // 1. Master ID 찾기
      const masters = Util.getSheetDataAsObjects(Config.SHEET_NAMES.SLOT_MASTER);
      const master = masters.find(m => Util.formatDate(m.time, 'time') === timeStr);
      if (!master) return 0; // 해당 시간대 마스터 없음

      const masterId = master.id;

      // 2. [1순위] Override 확인 (날짜별 특수 설정)
      const overrides = Util.getSheetDataAsObjects(Config.SHEET_NAMES.SLOT_OVERRIDE);
      const targetOverride = overrides.find(o => 
        o.branch_id === branchId && 
        o.slot_master_id === masterId && 
        Util.formatDate(o.date, 'date') === dateStr &&
        o.enabled === true
      );

      if (targetOverride) return Number(targetOverride.slot);

      // 3. [2순위] Default 확인 (지점별 기본 설정)
      const defaults = Util.getSheetDataAsObjects(Config.SHEET_NAMES.SLOT_DEFAULT);
      const targetDefault = defaults.find(d => 
        d.branch_id === branchId && 
        d.slot_master_id === masterId &&
        d.enabled === true
      );

      if (targetDefault) return Number(targetDefault.slot);

      return 0; // 설정 없으면 0
    } catch (e) {
      Logger.log(`[SlotService] MaxSlot Error: ${e.message}`);
      return 0;
    }
  },

  /**
   * [Core] 원본 캘린더 슬롯 동기화 (Slot Strategy)
   */
  syncSourceSlot(branchId, dateObj) {
    try {
      const branchNameEn = BranchService.getBranchNameEn(branchId);
      const targetCalId = BranchService.getCalendarId(branchId);
      
      if (!branchNameEn || !targetCalId) return;

      // 1. 최대 슬롯 조회
      const maxSlot = this.getMaxSlot(branchId, dateObj);

      // 2. 현재 예약 수 조회 (지점 캘린더 이벤트 기준)
      const currentCount = CalendarService.getEventCount(targetCalId, dateObj);

      Logger.log(`[SyncSlot] ${branchNameEn} ${dateObj} | Cur: ${currentCount} / Max: ${maxSlot}`);

      // 3. 정책 적용
      if (currentCount < maxSlot) {
        // 여유 있음 -> 블로킹 이벤트 삭제 (슬롯 오픈)
        CalendarService.deleteSourceBlockingEvent(branchNameEn, dateObj);
      } else {
        // 마감 -> 블로킹 이벤트 생성 (슬롯 닫기)
        CalendarService.createSourceBlockingEvent(branchNameEn, dateObj);
      }

    } catch (e) {
      Logger.log(`[SlotService] Sync Error: ${e.message}`);
    }
  },

  /**
   * [Batch] 날짜별 커스텀 슬롯 일괄 설정 (Optimized Logic)
   * - 기본값과 동일하면 오버라이드 삭제 (데이터 최적화)
   * - 다르면 오버라이드 생성 또는 수정
   * - 유효하지 않은 값(음수 등)은 무시
   */
  updateOverrideSlotsBatch(branchId, dateStr, slotsPayload) {
    const ss = Util.getSpreadsheet();
    const overrideSheet = ss.getSheetByName(Config.SHEET_NAMES.SLOT_OVERRIDE);
    const defaultSheet = ss.getSheetByName(Config.SHEET_NAMES.SLOT_DEFAULT);
    
    // 1. 기본 슬롯 설정 로드 (비교 기준)
    const defaultData = defaultSheet.getDataRange().getValues();
    const defHeaders = defaultData[0];
    const defBranchIdx = defHeaders.indexOf('branch_id');
    const defMasterIdx = defHeaders.indexOf('slot_master_id');
    const defSlotIdx = defHeaders.indexOf('slot');
    const defEnabledIdx = defHeaders.indexOf('enabled');
    
    const defaultMap = {}; // masterId -> { slot, enabled }
    for (let i = 1; i < defaultData.length; i++) {
      if (defaultData[i][defBranchIdx] === branchId) {
        defaultMap[defaultData[i][defMasterIdx]] = {
          slot: Number(defaultData[i][defSlotIdx]),
          enabled: Boolean(defaultData[i][defEnabledIdx])
        };
      }
    }

    // 2. 기존 오버라이드 데이터 로드 (해당 날짜/지점)
    const ovData = overrideSheet.getDataRange().getValues();
    const ovHeaders = ovData[0];
    const ovIdIdx = ovHeaders.indexOf('id');
    const ovBranchIdx = ovHeaders.indexOf('branch_id');
    const ovMasterIdx = ovHeaders.indexOf('slot_master_id');
    const ovDateIdx = ovHeaders.indexOf('date');
    const ovSlotIdx = ovHeaders.indexOf('slot');
    const ovEnabledIdx = ovHeaders.indexOf('enabled');
    const ovReasonIdx = ovHeaders.indexOf('reason');
    const ovUpdatedIdx = ovHeaders.indexOf('updated_at');

    // 타겟 날짜 비교 객체
    const targetDateObj = new Date(dateStr);
    targetDateObj.setHours(0,0,0,0);

    // 기존 데이터 행 추적 (masterId -> rowIndex)
    const existingRows = {}; 
    for (let i = 1; i < ovData.length; i++) {
      const rowBranch = ovData[i][ovBranchIdx];
      const rowDate = new Date(ovData[i][ovDateIdx]);
      rowDate.setHours(0,0,0,0);

      if (rowBranch === branchId && rowDate.getTime() === targetDateObj.getTime()) {
        const masterId = ovData[i][ovMasterIdx];
        existingRows[masterId] = i + 1; // 1-based index
      }
    }

    // 3. 로직 수행 (Delete / Update / Insert 분류)
    const rowsToDelete = [];
    const updates = [];
    const newRows = [];
    const mastersToSync = []; // 변경된 슬롯은 동기화 필요

    Object.keys(slotsPayload).forEach(masterId => {
      const input = slotsPayload[masterId];
      const slotVal = Number(input.slot);
      const enabledVal = input.enabled === true || String(input.enabled) === 'true';

      // Validation: 0 이상 정수만 허용
      if (isNaN(slotVal) || slotVal < 0 || !Number.isInteger(slotVal)) {
        return; 
      }

      // 기본값 조회 (없으면 slot=0, enabled=true로 가정)
      const def = defaultMap[masterId];
      const defSlot = def ? def.slot : 0;
      const defEnabled = def ? (def.enabled === true || String(def.enabled) === 'true') : true;

      // 비교: 기본값과 같은가?
      const isSameAsDefault = (slotVal === defSlot && enabledVal === defEnabled);
      const existingRowIndex = existingRows[masterId];

      if (isSameAsDefault) {
        // 같으면 오버라이드 불필요 -> 기존 데이터 있으면 삭제
        if (existingRowIndex) {
          rowsToDelete.push(existingRowIndex);
          mastersToSync.push(masterId);
        }
      } else {
        // 다르면 저장 필요
        if (existingRowIndex) {
          // Update
          updates.push({
            rowIndex: existingRowIndex,
            slot: slotVal,
            enabled: enabledVal
          });
          mastersToSync.push(masterId);
        } else {
          // Insert
          newRows.push([
            Utilities.getUuid(), // id
            branchId,            // branch_id
            masterId,            // slot_master_id
            targetDateObj,       // date (Date Object)
            slotVal,             // slot
            "일괄 설정",          // reason
            enabledVal,          // enabled
            new Date(),          // created_at
            new Date()           // updated_at
          ]);
          mastersToSync.push(masterId);
        }
      }
    });

    // 4. 시트 반영
    
    // A. Update (기존 행 수정)
    updates.forEach(up => {
      overrideSheet.getRange(up.rowIndex, ovSlotIdx + 1).setValue(up.slot);
      overrideSheet.getRange(up.rowIndex, ovEnabledIdx + 1).setValue(up.enabled);
      overrideSheet.getRange(up.rowIndex, ovUpdatedIdx + 1).setValue(new Date());
    });

    // B. Delete (뒤에서부터 삭제하여 인덱스 보존)
    rowsToDelete.sort((a, b) => b - a);
    rowsToDelete.forEach(rowIndex => {
      overrideSheet.deleteRow(rowIndex);
    });

    // C. Insert (신규 추가)
    if (newRows.length > 0) {
      const startRow = overrideSheet.getLastRow() + 1;
      overrideSheet.getRange(startRow, 1, newRows.length, newRows[0].length).setValues(newRows);
    }

    // 5. 캘린더 동기화 트리거 (변경된 슬롯들에 대해)
    // GAS Time limit 고려하여 중요한 로직이지만, 너무 많으면 타임아웃 될 수 있음.
    // 여기서는 변경된 건에 대해서만 syncSourceSlot 호출
    mastersToSync.forEach(mId => {
       const timeStr = this.getSlotTime(mId);
       if (timeStr) {
           // dateStr(YYYY-MM-DD) + timeStr(HH:mm) -> Date Obj
           const [y, m, d] = dateStr.split('-').map(Number);
           const [hh, mm] = timeStr.split(':').map(Number);
           const syncDate = new Date(y, m - 1, d, hh, mm);
           this.syncSourceSlot(branchId, syncDate);
       }
    });

    return Util.createResponse(true, { 
      deleted: rowsToDelete.length, 
      updated: updates.length, 
      inserted: newRows.length 
    });
  },

  /**
   * [Admin] 단일 슬롯 오버라이드 생성/수정
   * - slotData: { id(optional), branch_id, slot_master_id, date, slot, reason, enabled }
   */
  updateSlotOverride(slotData) {
    try {
        const sheet = Util.getSpreadsheet().getSheetByName(Config.SHEET_NAMES.SLOT_OVERRIDE);
        const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
        const now = new Date();
        const dateStr = slotData.date; // YYYY-MM-DD

        let isUpdate = false;
        
        // 1. 기존 레코드 조회 및 업데이트
        if (slotData.id) {
            const data = sheet.getDataRange().getValues();
            const idIdx = headers.indexOf('id');
            
            for (let i = 1; i < data.length; i++) {
                if (data[i][idIdx] === slotData.id) {
                    const row = data[i];
                    
                    row[headers.indexOf('slot')] = Number(slotData.slot);
                    row[headers.indexOf('reason')] = slotData.reason;
                    row[headers.indexOf('enabled')] = slotData.enabled;
                    row[headers.indexOf('updated_at')] = now;
                    
                    sheet.getRange(i + 1, 1, 1, row.length).setValues([row]);
                    isUpdate = true;
                    break;
                }
            }
        }
        
        // 2. 신규 생성
        if (!isUpdate) {
            const newObj = {
                id: Util.getUuid(),
                branch_id: slotData.branch_id,
                slot_master_id: slotData.slot_master_id,
                date: dateStr, // string
                slot: Number(slotData.slot),
                reason: slotData.reason,
                enabled: slotData.enabled,
                created_at: now,
                updated_at: now
            };
            
            const newRow = Util.convertObjectToRow(newObj, headers);
            sheet.appendRow(newRow);
        }

        // 3. 슬롯 동기화 (오버라이드 날짜에 대해)
        const dateObj = new Date(dateStr + ' ' + this.getSlotTime(slotData.slot_master_id));
        this.syncSourceSlot(slotData.branch_id, dateObj);

        return Util.createResponse(true);

    } catch (e) {
        return Util.createResponse(false, null, e.message);
    }
  },

  /**
   * [Admin] 슬롯 기본 설정 일괄 수정 (Batch Update)
   */
  updateDefaultSlotsBatch(branchId, slotsPayload) {
    try {
      const ss = Util.getSpreadsheet();
      const sheet = ss.getSheetByName(Config.SHEET_NAMES.SLOT_DEFAULT);
      const data = sheet.getDataRange().getValues();
      const headers = data[0];
      const now = new Date();

      // 기존 데이터 맵핑 (branchId + slot_master_id -> row index)
      const rowMap = new Map();
      for (let i = 1; i < data.length; i++) {
        const rBranchId = data[i][headers.indexOf('branch_id')];
        const rMasterId = data[i][headers.indexOf('slot_master_id')];
        if (rBranchId === branchId) {
          rowMap.set(rMasterId, i + 1);
        }
      }

      const rowsToAdd = [];

      // Payload: { "master_uuid_1": { slot: 4, enabled: true }, ... }
      Object.entries(slotsPayload).forEach(([masterId, values]) => {
        const rowIndex = rowMap.get(masterId);
        
        if (rowIndex) {
          // Update
          const row = data[rowIndex - 1]; 
          row[headers.indexOf('slot')] = values.slot;
          row[headers.indexOf('enabled')] = values.enabled;
          row[headers.indexOf('updated_at')] = now;
          
          sheet.getRange(rowIndex, 1, 1, row.length).setValues([row]);
        } else {
          // Insert
          const newObj = {
            id: Util.getUuid(),
            branch_id: branchId,
            slot_master_id: masterId,
            slot: values.slot,
            enabled: values.enabled,
            created_at: now,
            updated_at: now
          };
          rowsToAdd.push(Util.convertObjectToRow(newObj, headers));
        }
      });

      if (rowsToAdd.length > 0) {
        sheet.getRange(sheet.getLastRow() + 1, 1, rowsToAdd.length, headers.length).setValues(rowsToAdd);
      }

      return Util.createResponse(true);
    } catch (e) {
      return Util.createResponse(false, null, e.message);
    }
  },

  /**
   * [Read] 모든 슬롯 데이터 로드 (초기 로딩 최적화용)
   */
  getAllSlotsData() {
    return {
      masters: Util.getSheetDataAsObjects(Config.SHEET_NAMES.SLOT_MASTER),
      defaults: Util.getSheetDataAsObjects(Config.SHEET_NAMES.SLOT_DEFAULT),
      overrides: Util.getSheetDataAsObjects(Config.SHEET_NAMES.SLOT_OVERRIDE)
    };
  },
  
  /**
   * [Helper] 마스터 ID로 시간대 문자열 조회
   */
  getSlotTime(masterId) {
      const masters = Util.getSheetDataAsObjects(Config.SHEET_NAMES.SLOT_MASTER);
      const master = masters.find(m => m.id === masterId);
      return master ? Util.formatDate(master.time, 'time') : null;
  }
};