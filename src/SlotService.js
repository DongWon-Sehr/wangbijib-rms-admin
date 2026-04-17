/**
 * [SlotService] 슬롯 설정 및 관리 (Default / Override)
 */
const SlotService = {
  /**
   * [Core] 특정 지점, 특정 날짜/시간의 최대 수용 가능 인원(슬롯) 조회
   * 우선순위: Override(커스텀) > Default(기본) > Master(기본값 0)
   * @param {string} branchId - 지점 ID
   * @param {Date} dateObj - 대상 날짜 및 시간
   * @param {Array} overrideList - (Optional) 캐시된 오버라이드 슬롯 목록
   * @param {Array} defaultList - (Optional) 캐시된 기본 슬롯 목록
   * @param {Array} masterList - (Optional) 캐시된 마스터 슬롯 목록
   */
  getMaxSlot(branchId, dateObj, overrideList = null, defaultList = null, masterList = null) {
    try {
      const timeStr = Util.formatDate(dateObj, 'time'); // HH:mm
      const dateStr = Util.formatDate(dateObj, 'date'); // YYYY-MM-DD

      // 1. Master ID 찾기
      const masters = Array.isArray(masterList) ? masterList : Util.getSheetDataAsObjects(Config.SHEET_NAMES.SLOT_MASTER);
      const master = masters.find(m => Util.formatDate(m.time, 'time') === timeStr);
      if (!master) return 0; // 해당 시간대 마스터 없음

      const masterId = master.id;

      // 2. [1순위] Override 확인 (날짜별 특수 설정)
      const overrides = Array.isArray(overrideList) ? overrideList : Util.getSheetDataAsObjects(Config.SHEET_NAMES.SLOT_OVERRIDE);
      const targetOverride = overrides.find(o => 
        o.branch_id === branchId && 
        o.slot_master_id === masterId && 
        Util.formatDate(o.date, 'date') === dateStr &&
        (o.enabled === true || String(o.enabled) === 'true')
      );

      if (targetOverride) return Number(targetOverride.slot);

      // 3. [2순위] Default 확인 (지점별 기본 설정)
      const defaults = Array.isArray(defaultList) ? defaultList : Util.getSheetDataAsObjects(Config.SHEET_NAMES.SLOT_DEFAULT);
      const targetDefault = defaults.find(d => 
        d.branch_id === branchId && 
        d.slot_master_id === masterId &&
        (d.enabled === true || String(d.enabled) === 'true')
      );

      if (targetDefault) return Number(targetDefault.slot);

      return 0; // 설정 없으면 0
    } catch (e) {
      console.log(`[SlotService] MaxSlot Error: ${e.message}`);
      return 0;
    }
  },

  /**
   * [Core] 원본 캘린더 슬롯 동기화 (Slot Strategy)
   * @param {string} branchId - 지점 ID
   * @param {Date} dateObj - 대상 날짜 및 시간
   * @param {Array} overrideList - (Optional) 캐시된 오버라이드 슬롯 목록
   * @param {Array} defaultList - (Optional) 캐시된 기본 슬롯 목록
   * @param {Array} masterList - (Optional) 캐시된 마스터 슬롯 목록
   * @param {Array} targetEventsCache - (Optional) 캐시된 지점 캘린더 예약 이벤트 목록
   * @param {Array} sourceEventsCache - (Optional) 캐시된 소스 캘린더 블로킹 이벤트 목록
   * @param {boolean} returnLog - (Optional) 로그를 콘솔에 찍지 않고 문자열로 반환할지 여부
   * @param {Array} batchRequests - (Optional) Batch API 전송을 위해 요청을 모으는 배열
   */
  syncSourceSlot(
    branchId,
    dateObj,
    masterList = null,
    defaultList = null,
    overrideList = null,
    targetEventsCache = null,
    sourceEventsCache = null,
    batchRequests = null
  ) {
    try {
      const branchNameEn = BranchService.getBranchNameEn(branchId);
      const targetCalId = BranchService.getCalendarId(branchId);
      
      if (!branchNameEn || !targetCalId) return undefined;

      // 1. 최대 슬롯 조회
      const maxSlot = this.getMaxSlot(branchId, dateObj, overrideList, defaultList, masterList);

      // 2. 현재 예약 수 조회 (지점 캘린더 이벤트 기준)
      const currentCount = CalendarService.getEventCount(targetCalId, dateObj, targetEventsCache);

      const logMsg = `[SyncSlot] ${branchNameEn} ${dateObj} | Cur: ${currentCount} / Max: ${maxSlot}`;

      // 3. 정책 적용
      if (currentCount < maxSlot) {
        // 여유 있음 -> 블로킹 이벤트 삭제 (슬롯 오픈)
        if (batchRequests) {
           const req = CalendarService.deleteSourceBlockingEventRequest(branchNameEn, dateObj, sourceEventsCache);
           if (req) batchRequests.push(req);
        } else {
           CalendarService.deleteSourceBlockingEvent(branchNameEn, dateObj, sourceEventsCache);
        }
      } else {
        // 마감 -> 블로킹 이벤트 생성 (슬롯 닫기)
        if (batchRequests) {
           const req = CalendarService.createSourceBlockingEventRequest(branchNameEn, dateObj, sourceEventsCache);
           if (req) batchRequests.push(req);
        } else {
           CalendarService.createSourceBlockingEvent(branchNameEn, dateObj, sourceEventsCache);
        }
      }
      
      return logMsg;

    } catch (e) {
      const errMsg = `[SlotService] Sync Error: ${e.message}`;
      return errMsg;
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
          const newObj = {
            id: Util.getUuid(),
            branch_id: branchId,
            slot_master_id: masterId,
            date: targetDateObj,
            slot: slotVal,
            reason: "일괄 설정",
            enabled: enabledVal,
            created_at: new Date(),
            updated_at: new Date()
          };
          newRows.push(Util.convertObjectToRow(newObj, ovHeaders));
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

      // [Track 1] 기본 슬롯 변경 시 즉시(긴급) 백그라운드 동기화 큐에 추가 (병렬 처리)
      this.enqueueDefaultSlotSync(branchId, true);

      return Util.createResponse(true);
    } catch (e) {
      return Util.createResponse(false, null, e.message);
    }
  },

  /**
   * [Queue] 기본 슬롯 일괄 동기화 트리거 생성 (3초 뒤 실행)
   * @param {string} branchId - 지점 ID
   * @param {boolean} isUrgent - 긴급 모드 여부 (UI 수동 수정 시 true)
   */
  enqueueDefaultSlotSync(branchId, isUrgent = false) {
    try {
      const props = PropertiesService.getScriptProperties();
      
      // 1. 큐 설정 (일반/긴급 분리)
      const QUEUE_KEY = isUrgent ? 'SLOT_URGENT_QUEUE' : 'SLOT_SYNC_QUEUE';
      const HANDLER_NAME = isUrgent ? 'triggerUrgentSlotSync' : 'triggerBackgroundSlotSync';

      // 2. 큐 데이터 로드
      let queueStr = props.getProperty(QUEUE_KEY);
      let queue = [];
      if (queueStr) {
        try {
          queue = JSON.parse(queueStr);
        } catch (e) {
          queue = [];
        }
      }

      // 3. 큐에 작업 추가 (오늘부터 40일치)
      const now = new Date();
      now.setHours(0, 0, 0, 0);
      
      // 해당 지점의 기존 대기 작업이 있다면 덮어쓰기
      queue = queue.filter(q => q.branchId !== branchId);
      
      queue.push({
        branchId: branchId,
        startDateMs: now.getTime(),
        daysTotal: 40,
        daysProcessed: 0
      });

      props.setProperty(QUEUE_KEY, JSON.stringify(queue));

      // 4. 1회성 트리거 등록 (병렬 실행을 위해 핸들러별로 관리)
      const triggers = ScriptApp.getProjectTriggers();
      const hasTrigger = triggers.some(t => t.getHandlerFunction() === HANDLER_NAME);

      if (!hasTrigger) {
        ScriptApp.newTrigger(HANDLER_NAME)
          .timeBased()
          .after(3 * 1000) 
          .create();
        console.log(`[SlotService] Enqueued ${isUrgent ? 'URGENT' : 'Normal'} sync for branch ${branchId}`);
      }
    } catch (e) {
      console.log(`[SlotService] Enqueue Sync Error: ${e.message}`);
    }
  },

  /**
   * [Core] 오늘부터 n일간의 슬롯을 재계산하고 캘린더 동기화
   * - chunk 처리용으로 변경: 시작일부터 지정된 일수(days)만큼만 처리
   */
  syncFutureSlots(branchId, startDateMs, days = 1) {
    console.log(`[SlotService] Start chunk sync for branch: ${branchId} (${days} days)`);
    const logQueue = []; // 메모리에 로그 메시지를 모았다가 한 번에 출력
    try {
      // 최적화: 시트 조회를 반복문 바깥에서 단 3번만 수행하여 데이터를 메모리에 로드
      const slotsData = this.getAllSlotsData();
      const masters = slotsData.masters;
      
      // 활성화된 마스터만 필터링
      const activeMasters = masters.filter(m => m.enabled === true || String(m.enabled) === 'true');

      // 캘린더 일괄 조회 (Chunk 단위로 한 번에 가져와서 메모리에 캐싱)
      const targetCalId = BranchService.getCalendarId(branchId);
      const sourceCalId = CalendarService.SOURCE_CALENDAR_ID;
      
      const chunkStart = new Date(startDateMs);
      const chunkEnd = new Date(startDateMs + (days * 24 * 60 * 60 * 1000));
      
      const targetEventsCache = CalendarService.getEventsInRange(targetCalId, chunkStart, chunkEnd);
      const sourceEventsCache = CalendarService.getEventsInRange(sourceCalId, chunkStart, chunkEnd);

      const batchRequests = []; // 구글 캘린더 Batch API용 요청 배열

      // 지정된 시작일부터 days 만큼 처리
      for (let i = 0; i < days; i++) {
        const targetDate = new Date(startDateMs + (i * 24 * 60 * 60 * 1000));

        // 각 마스터 시간대별로 동기화 실행
        activeMasters.forEach(master => {
          const timeStr = Util.formatDate(master.time, 'time'); // HH:mm
          if (!timeStr) return;

          const [hh, mm] = timeStr.split(':').map(Number);
          
          // 동기화할 타겟 Date 객체 생성
          const syncDateObj = new Date(targetDate.getTime());
          syncDateObj.setHours(hh, mm, 0, 0);

          // 캐시된 배열들을 전달하여 구글 시트 및 캘린더 API 호출을 우회 (returnLog=true로 로그 메시지만 받아옴)
          // batchRequests 배열도 같이 전달하여 API 직접 호출 대신 Request Object 수집
          const resultMsg = 
            this.syncSourceSlot(
              branchId,
              syncDateObj,
              slotsData.masters,
              slotsData.defaults,
              slotsData.overrides,
              targetEventsCache,
              sourceEventsCache,
              batchRequests
            );
          if (resultMsg) logQueue.push(resultMsg);
        });
      }

      // 모아진 모든 삭제/생성 요청을 Batch API로 한 번에 전송 (타임아웃 방지)
      if (batchRequests.length > 0) {
        CalendarService.executeBatchRequests(batchRequests);
        logQueue.push(`[SlotService] Batch request sent: ${batchRequests.length} operations.`);
      } else {
        logQueue.push(`[SlotService] Batch request skip: 0 request.`);
      }

    } catch (e) {
      logQueue.push(`[SlotService] syncFutureSlots Error: ${e.message}`);
    } finally {
      // 모아둔 로그를 한 번에 출력 (API 호출 1번으로 압축)
      if (logQueue.length > 0) {
        console.log(logQueue.join('\n'));
      }
      console.log(`[SlotService] End chunk sync for branch: ${branchId}`);
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