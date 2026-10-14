/** 사용자 액션의 명칭, 변경 필드 순서와 저장용 변경 내역. */
const ActivityAudit = {
  ACTIONS: {
    apiUpdateReservation: '예약 정보 변경', apiUpdateReservationStatus: '예약 상태 변경', apiUpdateDepositStatus: '예약금 상태 변경',
    apiMarkReservationAsRead: '예약 읽음', apiUpdateReservationMessageSentAt: '알림톡 발송 완료',
    apiSendTemplatedMail: '메일 발송', apiInitializeMailThread: '예약 메일 초기화', apiCorrectEmailAndInitializeThread: '예약 이메일 변경',
    apiCreateManualDuplicateGroup: '중복 예약 그룹 생성', apiClearDuplicateGroup: '중복 일괄 해제',
    apiExcludeReservationFromGroup: '중복 해제', apiSendDuplicateConfirmationMail: '중복 확인 메일 발송'
  },
  FIELDS: {
    reservation: { customer_name:'고객명', email:'이메일', phone_number:'연락처', branch_id:'지점', reservation_date:'방문 일시', pax:'인원',
      status:'예약 상태', deposit_status:'예약금 상태', deposit_amount:'예약금', notes:'고객 메모', internal_notes:'관리자 메모', private_notes:'비공개 메모',
      is_read:'읽음 상태', message_sent_at:'발송 시각', email_thread_id:'메일 스레드' },
    user: {user_name:'사용자명',user_email:'이메일',role:'권한',branch_ids:'허용 지점',enabled:'활성 여부'},
    branch: {branch_name_ko:'지점명 (한글)',branch_name_en:'지점명 (영문)',calendar_id:'캘린더',address:'주소',google_map_link:'구글맵 링크',enabled:'활성 여부'},
    mail_template: {template_name:'템플릿 이름',body_html:'메일 본문',enabled:'활성 여부'},
    slot: {slot:'슬롯 수',enabled:'활성 여부',reason:'사유'},
    duplicate_group: {status:'중복 상태',reservation_ids:'예약 구성'}
  },
  shouldRecord(apiName) {
    return Boolean(this.ACTIONS[apiName]) || /^(apiSaveSystemSettings|apiDeleteSystemData):/.test(apiName);
  },
  rows(type) {
    if (type === 'reservation') return Util.getSheetDataAsObjects(Config.SHEET_NAMES.RESERVATION);
    if (type === 'user') return UserService.getAllUsers();
    if (type === 'duplicate_group') return DuplicateGroupService.getAllGroups();
    const names = {branch:'BRANCH',mail_template:'MAIL_TEMPLATE',slot_batch:'SLOT_DEFAULT',slot_override:'SLOT_OVERRIDE',slot_override_batch:'SLOT_OVERRIDE'};
    return Util.getSheetDataAsObjects(Config.SHEET_NAMES[names[type]]);
  },
  capture(apiName, params, result = {}) {
    const p = params || {}, data = p.data || p;
    let type = apiName.split(':')[1] || 'reservation';
    let id = p.targetReservationId || p.reservationId || p.id || data.id || result.id;
    if (['apiCreateManualDuplicateGroup','apiClearDuplicateGroup','apiSendDuplicateConfirmationMail'].includes(apiName)) {
      type = 'duplicate_group'; id = p.groupId || result.group_id || result.groupId;
    }
    if (apiName === 'apiExcludeReservationFromGroup') { type = 'duplicate_group'; id = p.groupId; }
    const rows = this.rows(type);
    let selected = rows.filter(row => String(row.id || row.group_id) === String(id));
    if (type.startsWith('slot_')) {
      const masters = data.payload ? Object.keys(data.payload) : [String(data.slot_master_id)];
      selected = rows.filter(row => row.branch_id === data.branch_id && masters.includes(String(row.slot_master_id))
        && (type === 'slot_batch' || Util.formatDate(row.date, 'date') === data.date));
    }
    return JSON.parse(JSON.stringify({type,id,rows:selected}));
  },
  diff(before, after) {
    if (!before || !after) return [];
    const type = after.type.startsWith('slot_') ? 'slot' : after.type;
    const fields = this.FIELDS[type] || {};
    const key = row => type === 'slot' ? String(row.slot_master_id) : String(row.id || row.group_id);
    const previous = new Map(before.rows.map(row => [key(row),row]));
    const next = new Map(after.rows.map(row => [key(row),row]));
    const changes = [];
    for (const id of new Set([...previous.keys(),...next.keys()])) {
      const old = previous.get(id) || {}, current = next.get(id) || {};
      for (const field of Object.keys(fields)) {
        let a = old[field] == null ? '' : old[field], b = current[field] == null ? '' : current[field];
        if (field === 'branch_ids' || field === 'reservation_ids') {
          const normalize = value => (Array.isArray(value) ? value : String(value).split(',')).map(String).filter(Boolean).sort();
          a = normalize(a); b = normalize(b);
        }
        if (JSON.stringify(a) === JSON.stringify(b)) continue;
        const change = {key:field,field:fields[field],before:a,after:b};
        if (type === 'slot') { change.slot_master_id = current.slot_master_id || old.slot_master_id; change.date = current.date || old.date || ''; }
        changes.push(change);
      }
    }
    return changes;
  },
  member(id) {
    const row = ReservationService.getReservationById(id) || {};
    return {id:String(id),name:row.customer_name || '예약',email:row.email || ''};
  },
  memberText(member) { return member.id + ' - ' + member.name + (member.email ? ' (' + member.email + ')' : ''); },
  entries(apiName, params, before, result) {
    const p = params || {}, data = p.data || p;
    if (apiName === 'apiSendTemplatedMail') {
      const member = this.member(p.reservationId);
      const template = this.rows('mail_template').find(row => row.id === p.templateId);
      return [{label:'예약',value:member.name + ' (' + member.id + ')'},
        {label:'템플릿',value:(template?.template_name || '메일 템플릿') + ' (' + p.templateId + ')'}];
    }
    if (['apiCreateManualDuplicateGroup','apiClearDuplicateGroup','apiSendDuplicateConfirmationMail'].includes(apiName)) {
      const ids = apiName === 'apiSendDuplicateConfirmationMail' ? [p.targetReservationId] : p.reservationIds || before?.rows[0]?.reservation_ids || [];
      return ids.filter(Boolean).map(id => ({label:apiName === 'apiSendDuplicateConfirmationMail' ? '발송 예약' : '예약',value:this.memberText(this.member(id))}));
    }
    if (apiName === 'apiExcludeReservationFromGroup') return [{label:'해제 예약',value:this.memberText(this.member(p.reservationId))}];
    if (apiName === 'apiInitializeMailThread') return [{label:'처리',value:'예약 확인 메일 발송 및 새 스레드 연결'}];
    return [];
  },
  details(apiName, params, before, result = {}) {
    let after = null;
    try { after = this.capture(apiName,params,result); } catch (err) { console.warn('[ActivityAudit] 변경 후 조회 실패: ' + err.message); }
    let changes = this.diff(before,after);
    if (result.activityChanges && (before?.type === 'reservation' || !before)) {
      const fields = this.FIELDS.reservation;
      const map = new Map(result.activityChanges.map(change => [change.field,change]));
      changes = Object.keys(fields).filter(key => map.has(key)).map(key => ({key,field:fields[key],before:map.get(key).before ?? '',after:map.get(key).after ?? ''}));
    }
    let entries = [];
    try { entries = this.entries(apiName,params,before,result); } catch (err) { console.warn('[ActivityAudit] 내용 조회 실패: ' + err.message); }
    return {changes,entries};
  }
};
