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
          if (branchData.location) row[headers.indexOf('location')] = branchData.location;
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