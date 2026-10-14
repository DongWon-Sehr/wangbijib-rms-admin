/**
 * [BranchService] 지점 정보 관리 (Singleton)
 */
const BranchService = {
  /**
   * [Read] 모든 지점 목록 조회
   * - 활성화된 지점만 필터링하거나 전체 반환
   */
  getAllBranches() {
    return Util.getSheetDataAsObjects(Config.SHEET_NAMES.BRANCH);
  },

  /**
   * [Read] 특정 지점 정보 조회
   */
  getBranchById(branchId) {
    const branches = this.getAllBranches();
    return branches.find(b => b.id === branchId);
  },

  /**
   * [Helper] 지점 ID로 캘린더 ID 조회
   */
  getCalendarId(branchId) {
    const branch = this.getBranchById(branchId);
    return branch ? branch.calendar_id : null;
  },

  /**
   * [Helper] 지점명(영문) 조회 (위젯 원본 이벤트 매칭용)
   */
  getBranchNameEn(branchId) {
    const branch = this.getBranchById(branchId);
    return branch ? branch.branch_name_en : '';
  },

  /** [Admin] 신규 지점을 등록하고 서버 생성 ID를 반환한다. */
  createBranch(branchData) {
    let lock;
    let locked = false;
    try {
      const fields = ['branch_name_ko', 'branch_name_en', 'calendar_id', 'address', 'google_map_link'];
      const data = Object.fromEntries(fields.map(key => [key, String(branchData[key] || '').trim()]));
      if (!data.branch_name_ko || !data.branch_name_en || !data.calendar_id) {
        return Util.createResponse(false, null, '지점명(한글·영문)과 지점 캘린더 ID를 입력해 주세요.');
      }
      lock = LockService.getScriptLock();
      lock.waitLock(20000);
      locked = true;
      const sheet = Util.getSpreadsheet().getSheetByName(Config.SHEET_NAMES.BRANCH);
      if (!sheet) throw new Error('지점 시트를 찾을 수 없습니다.');
      const rows = sheet.getDataRange().getValues();
      const headers = rows[0];
      if (['id', 'branch_name_ko', 'branch_name_en', 'calendar_id', 'enabled'].some(key => !headers.includes(key))) {
        throw new Error('지점 시트에 필수 컬럼이 없습니다.');
      }
      const nameIndex = headers.indexOf('branch_name_en');
      const calendarIndex = headers.indexOf('calendar_id');
      if (rows.slice(1).some(row => String(row[nameIndex]).trim().toLowerCase() === data.branch_name_en.toLowerCase())) {
        throw new Error('이미 등록된 영문 지점명입니다.');
      }
      if (rows.slice(1).some(row => String(row[calendarIndex]).trim() === data.calendar_id)) {
        throw new Error('이미 등록된 지점 캘린더 ID입니다.');
      }
      const now = new Date();
      const branch = { ...data, id: Util.getUuid(), enabled: branchData.enabled !== false,
        created_at: now, updated_at: now };
      sheet.appendRow(headers.map(key => branch[key] === undefined ? '' : branch[key]));
      SpreadsheetApp.flush();
      return Util.createResponse(true, { ...branch, created_at: now.toISOString(), updated_at: now.toISOString() });
    } catch (err) {
      return Util.createResponse(false, null, err.message);
    } finally {
      if (locked) lock.releaseLock();
    }
  },

  /**
   * [Admin] 지점 정보 수정
   */
  updateBranch(id, branchData) {
    try {
      const sheet = Util.getSpreadsheet().getSheetByName(Config.SHEET_NAMES.BRANCH);
      const data = sheet.getDataRange().getValues();
      const headers = data[0];
      const idIdx = headers.indexOf('id');

      for (let i = 1; i < data.length; i++) {
        if (data[i][idIdx] === id) {
          const row = data[i];
          
          if (branchData.branch_name_ko) row[headers.indexOf('branch_name_ko')] = branchData.branch_name_ko;
          if (branchData.branch_name_en) row[headers.indexOf('branch_name_en')] = branchData.branch_name_en;
          if (branchData.address !== undefined && headers.indexOf('address') > -1) row[headers.indexOf('address')] = branchData.address;
          if (branchData.google_map_link !== undefined && headers.indexOf('google_map_link') > -1) row[headers.indexOf('google_map_link')] = branchData.google_map_link;
          if (branchData.calendar_id) row[headers.indexOf('calendar_id')] = branchData.calendar_id;
          if (branchData.enabled !== undefined) row[headers.indexOf('enabled')] = branchData.enabled;
          
          row[headers.indexOf('updated_at')] = new Date();

          sheet.getRange(i + 1, 1, 1, row.length).setValues([row]);
          return Util.createResponse(true);
        }
      }
      return Util.createResponse(false, null, 'Branch not found');
    } catch (e) {
      return Util.createResponse(false, null, e.message);
    }
  }
};