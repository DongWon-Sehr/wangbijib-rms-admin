/**
 * 인증된 사용자의 데이터 변경 작업만 사람이 읽을 수 있는 항목으로 기록한다.
 * - 스키마는 MigrationService.SCHEMA.activity_log에서 중앙 관리하며 시트 생성·컬럼 추가는 runSchemaMigration으로 수행한다.
 */
const ActivityLogService = {
  columns() {
    return MigrationService.SCHEMA.activity_log.map(column => column.name);
  },

  safeCell(value, limit = 300) {
    const text = String(value == null ? '' : value).slice(0, limit);
    return /^[=+@-]/.test(text) ? "'" + text : text;
  },

  target(id, name, fallback) {
    if (id) return String(id) + (name && String(name) !== String(id) ? ' (' + name + ')' : '');
    return name || fallback;
  },

  reservationTarget(id, name, email) {
    if (!id) return '예약';
    if (!name || email === undefined) {
      try {
        const reservation = ReservationService.getReservationById(id);
        if (reservation) {
          if (!name) name = reservation.customer_name;
          if (email === undefined) email = reservation.email;
        }
      } catch (err) {
        console.warn('[ActivityLog] 예약명 조회 실패: ' + err.message);
      }
    }
    return (name || '예약') + (email ? ' (' + email + ')' : '');
  },

  describe(apiName, params, resultData, before) {
    const p = params || {}, data = p.data || p, result = resultData || {};
    let action = ActivityAudit.ACTIONS[apiName];
    let type = 'reservation', id = p.targetReservationId || p.reservationId || p.id || data.id;
    if (apiName.startsWith('apiSaveSystemSettings:') || apiName.startsWith('apiDeleteSystemData:')) {
      const setting = apiName.split(':')[1];
      type = setting.startsWith('slot_') ? 'branch' : setting;
      id = setting.startsWith('slot_') ? data.branch_id : data.id || p.id || result.id;
      const names = {user:data.id ? '사용자 정보 변경':'사용자 등록',branch:data.id ? '지점 정보 변경':'지점 등록',
        mail_template:data.id ? '메일 템플릿 변경':'메일 템플릿 생성',slot_override:'개별 슬롯 변경',slot_batch:'기본 슬롯 일괄 변경',slot_override_batch:'커스텀 슬롯 일괄 변경'};
      action = apiName.startsWith('apiDelete') ? setting === 'user' ? '사용자 비활성화' : '메일 템플릿 삭제' : names[setting];
    }
    if (['apiCreateManualDuplicateGroup','apiClearDuplicateGroup','apiSendDuplicateConfirmationMail'].includes(apiName)) {
      type = 'duplicate_group'; id = p.groupId || result.group_id || result.groupId;
    }
    if (apiName === 'apiExcludeReservationFromGroup') {type = 'reservation'; id = p.reservationId;}
    let target = type === 'reservation' ? this.reservationTarget(id,data.customer_name || data.customerName,p.newEmail !== undefined ? p.newEmail : data.email) : '';
    const old = before?.rows[0] || {};
    if (type === 'user') target = data.user_name || data.user_email || old.user_name || old.user_email || '사용자';
    if (type === 'branch') target = data.branch_name_ko || old.branch_name_ko || '지점';
    if (type === 'mail_template') target = data.template_name || old.template_name || '메일 템플릿';
    if (type === 'duplicate_group') target = '중복 예약 그룹';
    const details = ActivityAudit.details(apiName,p,before,result);
    // 셀 한도 내에서 JSON 구조를 보존하고 긴 본문에 생략 표시를 남긴다.
    const shorten = value => typeof value === 'string' && value.length > 1500 ? value.slice(0,1500) + '…' : value;
    details.changes.forEach(change => {change.before = shorten(change.before); change.after = shorten(change.after);});
    while (JSON.stringify(details).length > 45000) {
      let reduced = false;
      details.changes.forEach(change => ['before','after'].forEach(key => {
        if (typeof change[key] === 'string' && change[key].length > 100) {change[key] = change[key].slice(0,Math.floor(change[key].length / 2)) + '…'; reduced = true;}
      }));
      if (!reduced) throw new Error('변경 내역이 로그 셀 한도를 초과했습니다.');
    }
    return [action,target,JSON.stringify(details),type,id];
  },

  record(apiName, actor, params, success, resultData, before = null) {
    if (!ActivityAudit.shouldRecord(apiName)) return null;
    const summary = this.describe(apiName, params, resultData, before);
    const sheetName = Config.SHEET_NAMES.ACTIVITY_LOG;
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      const sheet = Util.getSpreadsheet().getSheetByName(sheetName);
      if (!sheet) throw new Error(sheetName + ' 시트가 없습니다. runSchemaMigration을 먼저 실행하세요.');
      const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
      const values = {
        id: Utilities.getUuid(), timestamp: new Date(),
        actor_email: this.safeCell(actor.user_email), actor_name: this.safeCell(actor.user_name), ip: this.safeCell(actor.client_ip, 45),
        action: this.safeCell(summary[0]), target: this.safeCell(summary[1]),
        details: this.safeCell(summary[2], 45000), status: success ? '완료' : '실패',
        target_type: this.safeCell(summary[3]), target_id: this.safeCell(summary[4])
      };
      sheet.appendRow(Util.convertObjectToRow(values, headers));
      SpreadsheetApp.flush();
      return { ...values, timestamp: values.timestamp.toISOString() };
    } finally {
      lock.releaseLock();
    }
  },

  getLogs() {
    const sheet = Util.getSpreadsheet().getSheetByName(Config.SHEET_NAMES.ACTIVITY_LOG);
    if (!sheet || sheet.getLastRow() <= 1) return { rows: [], targetTypes: [] };
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const columns = this.columns();
    const indexes = Object.fromEntries(columns.map(key => [key, headers.indexOf(key)]));
    const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues();
    const rows = values.map(row => Object.fromEntries(columns.map(key => {
      const value = indexes[key] < 0 ? '' : row[indexes[key]];
      return [key, value instanceof Date ? value.toISOString() : value || ''];
    })));
    return { rows, targetTypes: [...new Set(rows.map(log => log.target_type || '__none__'))].sort() };
  }
};
