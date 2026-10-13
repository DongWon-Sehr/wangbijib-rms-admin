/** 인증된 사용자의 데이터 변경 작업만 사람이 읽을 수 있는 항목으로 기록한다. */
const ActivityLogService = {
  HEADERS: ['id', 'timestamp', 'actor_email', 'actor_name', 'action', 'target', 'details', 'status'],

  safeCell(value) {
    const text = String(value == null ? '' : value).slice(0, 300);
    return /^[=+@-]/.test(text) ? "'" + text : text;
  },

  reservationTarget(id, name) {
    if (name) return name;
    if (!id) return '예약';
    try {
      const reservation = ReservationService.getReservationById(id);
      if (reservation && reservation.customer_name) return reservation.customer_name;
    } catch (err) {
      console.warn('[ActivityLog] 예약명 조회 실패: ' + err.message);
    }
    return id;
  },

  describe(apiName, params) {
    const p = params || {};
    const data = p.data || p;
    const reservation = () => this.reservationTarget(data.reservationId || data.id || p.id, data.customer_name || data.customerName);
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
      apiUpdateReservationMessageSentAt: '알림톡 발송 기록',
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
    if (apiName === 'apiUpdateReservation') return ['예약 정보 수정', reservation(), fields.join(', ')];
    if (apiName === 'apiUpdateReservationStatus') return ['예약 상태 변경', reservation(), status[p.status] || String(p.status || '')];
    if (apiName === 'apiUpdateDepositStatus') return ['예약금 상태 변경', reservation(), status[p.status] || String(p.status || '')];
    if (apiName.startsWith('apiSaveSystemSettings:')) {
      const type = apiName.split(':')[1];
      const actions = { user: '사용자 정보 저장', branch: '지점 정보 저장', mail_template: '메일 템플릿 저장', slot_override: '개별 슬롯 저장', slot_batch: '기본 슬롯 일괄 저장', slot_override_batch: '커스텀 슬롯 일괄 저장' };
      const target = type === 'user' ? data.user_name || data.user_email :
        type === 'mail_template' ? data.template_name : data.branch_name_ko || data.branch_id || data.id;
      const role = { admin: '관리자', manager: '매니저', viewer: '조회자' };
      const details = type === 'user'
        ? [role[data.role] || '', data.enabled === false ? '비활성' : '', Array.isArray(data.branch_ids) ? '허용 지점 ' + data.branch_ids.length + '개' : ''].filter(Boolean).join(', ')
        : type.startsWith('slot_') ? [data.date, data.slot !== undefined ? '슬롯 ' + data.slot : '', data.payload ? Object.keys(data.payload).length + '개 시간대' : ''].filter(Boolean).join(', ') : '';
      return [actions[type] || '설정 저장', target || '설정', details];
    }
    if (apiName.startsWith('apiDeleteSystemData:')) {
      const type = apiName.split(':')[1];
      return [type === 'user' ? '사용자 비활성화' : '메일 템플릿 삭제', p.id || '대상', ''];
    }
    return [labels[apiName] || '작업 처리', reservation() === '예약' ? (p.groupId || p.id || '시스템') : reservation(), ''];
  },

  record(apiName, actor, params, success) {
    const summary = this.describe(apiName, params);
    const sheetName = Config.SHEET_NAMES.ACTIVITY_LOG;
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      const spreadsheet = Util.getSpreadsheet();
      let sheet = spreadsheet.getSheetByName(sheetName);
      if (!sheet) {
        sheet = spreadsheet.insertSheet(sheetName);
        sheet.appendRow(this.HEADERS);
        sheet.setFrozenRows(1);
      }
      sheet.appendRow([
        Utilities.getUuid(), new Date(), this.safeCell(actor.user_email), this.safeCell(actor.user_name),
        this.safeCell(summary[0]), this.safeCell(summary[1]), this.safeCell(summary[2]), success ? '완료' : '실패'
      ]);
      SpreadsheetApp.flush();
    } finally {
      lock.releaseLock();
    }
  },

  getRecentLogs(limit) {
    const sheet = Util.getSpreadsheet().getSheetByName(Config.SHEET_NAMES.ACTIVITY_LOG);
    if (!sheet || sheet.getLastRow() <= 1) return [];
    const last = sheet.getLastRow();
    const count = Math.min(Math.max(1, Number(limit) || 200), 500, last - 1);
    const rows = sheet.getRange(last - count + 1, 1, count, this.HEADERS.length).getValues();
    return rows.reverse().map(row => Object.fromEntries(this.HEADERS.map((key, index) => [
      key, row[index] instanceof Date ? row[index].toISOString() : row[index]
    ])));
  }
};
