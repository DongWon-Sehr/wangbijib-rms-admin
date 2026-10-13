/** 인증된 사용자의 데이터 변경 작업만 사람이 읽을 수 있는 항목으로 기록한다. */
const ActivityLogService = {
  HEADERS: ['id', 'timestamp', 'actor_email', 'actor_name', 'action', 'target_type', 'target_id', 'target', 'details', 'status'],

  safeCell(value) {
    const text = String(value == null ? '' : value).slice(0, 300);
    return /^[=+@-]/.test(text) ? "'" + text : text;
  },

  target(id, name, fallback) {
    if (id) return String(id) + (name && String(name) !== String(id) ? ' (' + name + ')' : '');
    return name || fallback;
  },

  reservationTarget(id, name) {
    if (!id) return '예약';
    if (!name) {
      try {
        const reservation = ReservationService.getReservationById(id);
        if (reservation) name = reservation.customer_name;
      } catch (err) {
        console.warn('[ActivityLog] 예약명 조회 실패: ' + err.message);
      }
    }
    return this.target(id, name, '예약');
  },

  describe(apiName, params, resultData) {
    const p = params || {};
    const data = p.data || p;
    const result = resultData || {};
    const reservationId = p.reservationId || p.id || data.reservationId || data.id;
    const reservation = () => this.reservationTarget(reservationId, data.customer_name || data.customerName);
    const status = { pending: '대기', confirm: '확정', cancel: '취소', refund: '환불', 'n/a': '해당 없음' };
    const changes = {
      customer_name: '고객명', email: '이메일', phone_number: '연락처', branch_id: '지점',
      reservation_date: '방문 일시', visit_date: '방문 날짜', visit_time: '방문 시간',
      pax: '인원', status: '예약 상태', deposit_status: '예약금 상태',
      deposit_amount: '예약금', notes: '고객 메모', internal_notes: '관리자 메모', private_notes: '비공개 메모'
    };
    const fields = Object.keys(data).filter(key => changes[key]).map(key => {
      if (key === 'status' || key === 'deposit_status') return changes[key] + ': ' + (status[data[key]] || data[key]);
      if (key === 'pax') return '인원: ' + data[key] + '명';
      if (key === 'deposit_amount') return '예약금: ' + data[key];
      return changes[key];
    });
    const labels = {
      apiUpdateReservationMessageSentAt: '알림톡 발송 완료 처리',
      webhookMessageSentAt: '알림톡 발송 시각 갱신',
      apiSendTemplatedMail: '안내 메일 발송',
      apiInitializeMailThread: '예약 확인 메일 발송',
      apiCorrectEmailAndInitializeThread: '이메일 수정 및 확인 메일 발송',
      apiAddLabelsToThread: '메일 라벨 동기화',
      apiMarkReservationAsRead: '예약 읽음 처리',
      apiCreateManualDuplicateGroup: '중복 예약 수동 묶기',
      apiClearDuplicateGroup: '중복 아님 처리',
      apiRemoveManualDuplicateGroup: '수동 묶음 해제',
      apiExcludeReservationFromGroup: '중복 묶음에서 예약 제외',
      apiMarkDuplicateMailSent: '중복 확인 메일 기록',
      apiSendDuplicateConfirmationMail: '중복 확인 메일 발송',
      apiRunSchemaMigration: '시트 구조 갱신',
      apiBackfillDuplicateGroups: '중복 예약 이력 보정'
    };
    if (apiName === 'apiUpdateReservation') return ['예약 정보 수정', reservation(), fields.join(', '), 'reservation', reservationId];
    if (apiName === 'apiUpdateReservationStatus') return ['예약 상태 변경', reservation(), status[p.status] || String(p.status || ''), 'reservation', reservationId];
    if (apiName === 'apiUpdateDepositStatus') return ['예약금 상태 변경', reservation(), status[p.status] || String(p.status || ''), 'reservation', reservationId];
    if (apiName.startsWith('apiSaveSystemSettings:')) {
      const type = apiName.split(':')[1];
      const actions = { user: '사용자 정보 저장', branch: '지점 정보 저장', mail_template: '메일 템플릿 저장', slot_override: '개별 슬롯 저장', slot_batch: '기본 슬롯 일괄 저장', slot_override_batch: '커스텀 슬롯 일괄 저장' };
      const id = data.id || result.id;
      const target = type === 'user' ? this.target(id, data.user_name || data.user_email, '사용자') :
        type === 'mail_template' ? this.target(id, data.template_name, '메일 템플릿') :
        type === 'branch' ? this.target(id || data.branch_id, data.branch_name_ko, '지점') :
        this.target(data.branch_id, data.branch_name_ko, '지점');
      const role = { admin: '관리자', manager: '매니저', viewer: '조회자' };
      let slotMaster = '';
      if (type === 'slot_override' && data.slot_master_id) {
        slotMaster = '슬롯 ID ' + data.slot_master_id;
        try {
          const time = SlotService.getSlotTime(data.slot_master_id);
          if (time) slotMaster += ' (' + time + ')';
        } catch (err) {
          console.warn('[ActivityLog] 슬롯 시간 조회 실패: ' + err.message);
        }
      }
      const details = type === 'user'
        ? [role[data.role] || '', data.enabled === false ? '비활성' : '', Array.isArray(data.branch_ids) ? '허용 지점 ' + data.branch_ids.length + '개' : ''].filter(Boolean).join(', ')
        : type.startsWith('slot_') ? [data.date, slotMaster, data.slot !== undefined ? '슬롯 ' + data.slot : '', data.payload ? Object.keys(data.payload).length + '개 시간대' : ''].filter(Boolean).join(', ') : '';
      const targetType = type.startsWith('slot_') ? 'branch' : type;
      const targetId = type.startsWith('slot_') ? data.branch_id : id || data.branch_id;
      return [actions[type] || '설정 저장', target || '설정', details, targetType, targetId];
    }
    if (apiName.startsWith('apiDeleteSystemData:')) {
      const type = apiName.split(':')[1];
      return [type === 'user' ? '사용자 비활성화' : '메일 템플릿 삭제', p.id || '대상', '', type, p.id];
    }
    const groupId = p.groupId || result.group_id || result.groupId;
    const target = apiName === 'apiSendTemplatedMail'
      ? p.reservationId ? reservation() : this.target(p.threadId, data.customer_name || data.customerName, '메일')
      : groupId ? this.target(groupId, '', '중복 그룹')
        : p.reservationId || p.id ? reservation()
          : p.threadId ? this.target(p.threadId, '', '메일') : '시스템';
    const targetType = groupId ? 'duplicate_group' : p.reservationId || p.id ? 'reservation' : p.threadId ? 'mail_thread' : '';
    const targetId = groupId || p.reservationId || p.id || p.threadId || '';
    return [labels[apiName] || '작업 처리', target, '', targetType, targetId];
  },

  ensureSheetLayout(sheet) {
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(this.HEADERS);
      sheet.setFrozenRows(1);
      return { headers: this.HEADERS, missing: this.HEADERS, reordered: false };
    }
    let headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const missing = this.HEADERS.filter(header => !headers.includes(header));
    if (missing.length) sheet.getRange(1, headers.length + 1, 1, missing.length).setValues([missing]);
    headers = headers.concat(missing);
    const ordered = this.HEADERS.concat(headers.filter(header => !this.HEADERS.includes(header)));
    const reordered = ordered.some((header, index) => header !== headers[index]);
    if (reordered) {
      const range = sheet.getRange(1, 1, sheet.getLastRow(), headers.length);
      const rows = range.getValues();
      range.setValues(rows.map(row => ordered.map(header => {
        const value = row[headers.indexOf(header)];
        return value === undefined ? '' : value;
      })));
      headers = ordered;
    }
    return { headers, missing, reordered };
  },

  record(apiName, actor, params, success, resultData) {
    const summary = this.describe(apiName, params, resultData);
    const sheetName = Config.SHEET_NAMES.ACTIVITY_LOG;
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      const spreadsheet = Util.getSpreadsheet();
      let sheet = spreadsheet.getSheetByName(sheetName);
      if (!sheet) sheet = spreadsheet.insertSheet(sheetName);
      const headers = this.ensureSheetLayout(sheet).headers;
      const values = {
        id: Utilities.getUuid(), timestamp: new Date(),
        actor_email: this.safeCell(actor.user_email), actor_name: this.safeCell(actor.user_name),
        action: this.safeCell(summary[0]), target: this.safeCell(summary[1]),
        details: this.safeCell(summary[2]), status: success ? '완료' : '실패',
        target_type: this.safeCell(summary[3]), target_id: this.safeCell(summary[4])
      };
      sheet.appendRow(headers.map(header => values[header] === undefined ? '' : values[header]));
      SpreadsheetApp.flush();
    } finally {
      lock.releaseLock();
    }
  },

  getLogsPage(options) {
    const opts = options || {};
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    if (!datePattern.test(opts.startDate || '') || !datePattern.test(opts.endDate || '')) throw new Error('조회 시작일과 종료일을 선택해 주세요.');
    const start = new Date(opts.startDate + 'T00:00:00+09:00');
    const end = new Date(opts.endDate + 'T00:00:00+09:00');
    if (isNaN(start.getTime()) || isNaN(end.getTime()) || start > end ||
        Utilities.formatDate(start, 'Asia/Seoul', 'yyyy-MM-dd') !== opts.startDate ||
        Utilities.formatDate(end, 'Asia/Seoul', 'yyyy-MM-dd') !== opts.endDate) throw new Error('조회 기간이 올바르지 않습니다.');
    const endExclusive = end.getTime() + 24 * 60 * 60 * 1000;
    const sortKeys = ['timestamp', 'action', 'target_id', 'status'];
    const sortKey = sortKeys.includes(opts.sortKey) ? opts.sortKey : 'timestamp';
    const direction = opts.sortDirection === 'asc' ? 1 : -1;
    const offset = Math.max(0, Math.floor(Number(opts.offset) || 0));
    const pageSize = 50;
    const query = String(opts.query || '').trim().toLocaleLowerCase();
    const status = String(opts.status || 'all');
    const targetType = String(opts.targetType || 'all');
    const sheet = Util.getSpreadsheet().getSheetByName(Config.SHEET_NAMES.ACTIVITY_LOG);
    if (!sheet || sheet.getLastRow() <= 1) return { rows: [], nextOffset: null, targetTypes: [] };
    const requestedLastRow = Math.floor(Number(opts.snapshotLastRow));
    const last = Number.isFinite(requestedLastRow) && requestedLastRow >= 2
      ? Math.min(requestedLastRow, sheet.getLastRow()) : sheet.getLastRow();
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const indexes = Object.fromEntries(this.HEADERS.map(key => [key, headers.indexOf(key)]));
    const values = sheet.getRange(2, 1, last - 1, headers.length).getValues();
    const targetTypes = new Set();
    const rows = [];
    values.forEach((row, index) => {
      const timestamp = row[indexes.timestamp];
      const time = timestamp instanceof Date ? timestamp.getTime() : new Date(timestamp).getTime();
      if (!Number.isFinite(time) || time < start.getTime() || time >= endExclusive) return;
      const log = Object.fromEntries(this.HEADERS.map(key => {
        const column = indexes[key];
        const value = column < 0 ? '' : row[column];
        return [key, value instanceof Date ? value.toISOString() : value || ''];
      }));
      targetTypes.add(String(log.target_type || '__none__'));
      if (targetType !== 'all' && (log.target_type || '__none__') !== targetType) return;
      if (status !== 'all' && log.status !== status) return;
      if (query && ![log.actor_name, log.actor_email, log.action, log.target_type, log.target_id, log.target, log.details]
        .some(value => String(value).toLocaleLowerCase().includes(query))) return;
      rows.push({ log, time, index });
    });
    rows.sort((a, b) => {
      const comparison = sortKey === 'timestamp' ? a.time - b.time
        : String(a.log[sortKey]).localeCompare(String(b.log[sortKey]), 'ko', { numeric: true });
      return comparison * direction || b.index - a.index;
    });
    return {
      rows: rows.slice(offset, offset + pageSize).map(item => item.log),
      nextOffset: offset + pageSize < rows.length ? offset + pageSize : null,
      snapshotLastRow: last,
      targetTypes: [...targetTypes].sort()
    };
  }
};
