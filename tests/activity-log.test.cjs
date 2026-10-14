const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function setup(role = 'admin') {
  const sheets = new Map();
  const createSheet = name => {
    const rows = [];
    const sheet = {
      appendRow: row => { rows.push(row); return sheet; },
      setFrozenRows: () => {},
      getLastRow: () => rows.length,
      getDataRange: () => ({ getValues: () => rows }),
      getLastColumn: () => rows[0].length,
      getRange: (row, column, count, width) => ({
        getValues: () => rows.slice(row - 1, row - 1 + count).map(values => values.slice(column - 1, width ? column - 1 + width : undefined)),
        setValues: values => { values.forEach((cells, index) => cells.forEach((cell, offset) => { rows[row - 1 + index][column - 1 + offset] = cell; })); }
      })
    };
    sheets.set(name, sheet);
    return sheet;
  };
  const spreadsheet = {
    getSheetByName: name => sheets.get(name),
    insertSheet: createSheet
  };
  const actor = { user_email: 'manager@example.com', user_name: '김매니저', role };
  const context = {
    console,
    Date,
    Config: { SHEET_NAMES: { ACTIVITY_LOG: 'activity_log' }, USER_ROLES: { ADMIN: 'admin' } },
    Util: {
      getSpreadsheet: () => spreadsheet,
      getSheetDataAsObjects: name => { const sheet = sheets.get(name); if (!sheet) return []; const rows = sheet.getDataRange().getValues(); return rows.slice(1).map(row => Object.fromEntries(rows[0].map((key,index) => [key,row[index]]))); },
      createResponse: (success, data = null, message = '') => ({ success, data, message })
    },
    UserService: { checkSession: () => ({ success: true, data: actor }) },
    ReservationService: { getReservationById: () => ({ customer_name: '홍길동' }) },
    SlotService: { getSlotTime: () => '18:00' },
    Utilities: {
      getUuid: () => 'log-id',
      formatDate: date => new Date(date.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)
    },
    LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
    SpreadsheetApp: { flush: () => {} }
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('src/ActivityLogService.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('src/ActivityAudit.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('src/WebApi.js', 'utf8'), context);
  return { context, sheets };
}

test('mutation records authenticated actor and readable fields without raw request data', () => {
  const { context, sheets } = setup();
  context.payload = { id: 'reservation-1', customer_name: '홍길동', status: 'confirm', private_notes: '비밀 메모 본문', access_token: 'secret' };
  vm.runInContext('_executeApi("apiUpdateReservation", () => ({success:true}), payload, UserService.checkSession().data)', context);
  const rows = sheets.get('activity_log').getRange(1, 1, 2).getValues();
  assert.equal(rows[1][2], 'manager@example.com');
  assert.equal(rows[1][3], '김매니저');
  assert.equal(rows[1][4], '예약 정보 변경');
  assert.equal(rows[1][5], 'reservation');
  assert.equal(rows[1][6], 'reservation-1');
  assert.equal(rows[1][7], '홍길동');
  assert.deepEqual(JSON.parse(rows[1][8]).changes, []);
  assert.doesNotMatch(rows[1].join(' '), /비밀 메모 본문|secret|access_token/);
  assert.equal(rows[1][9], '완료');
});

test('generated user and group IDs appear in the activity target', () => {
  const { context, sheets } = setup();
  vm.runInContext('_executeApi("apiSaveSystemSettings:user", () => ({success:true, data:{id:"user-1"}}), {data:{user_name:"김사용자"}}, UserService.checkSession().data)', context);
  vm.runInContext('_executeApi("apiCreateManualDuplicateGroup", () => ({success:true, data:{group_id:"group-1"}}), {reservationIds:["r1","r2"]}, UserService.checkSession().data)', context);
  const rows = sheets.get('activity_log').getRange(2, 1, 2).getValues();
  assert.equal(rows[0][7], '김사용자');
  assert.equal(rows[1][7], '중복 예약 그룹');
  assert.deepEqual(rows.map(row => [row[5], row[6]]), [['user', 'user-1'], ['duplicate_group', 'group-1']]);
});

test('mail uses reservation ID and single slot uses branch ID with slot details', () => {
  const { context, sheets } = setup();
  vm.runInContext('_executeApi("apiSendTemplatedMail", () => ({success:true}), {reservationId:"reservation-2", threadId:"thread-1", data:{customer_name:"이손님"}}, UserService.checkSession().data)', context);
  vm.runInContext('_executeApi("apiSaveSystemSettings:slot_override", () => ({success:true}), {data:{branch_id:"branch-1", slot_master_id:"slot-2", date:"2026-10-13"}}, UserService.checkSession().data)', context);
  const rows = sheets.get('activity_log').getRange(2, 1, 2).getValues();
  assert.equal(rows[0][7], '이손님');
  assert.equal(rows[1][7], '지점');
  assert.ok(Array.isArray(JSON.parse(rows[1][8]).changes));
  assert.deepEqual(rows.map(row => [row[5], row[6]]), [['reservation', 'reservation-2'], ['branch', 'branch-1']]);
});

test('settings use each record ID and batch changes use the branch ID', () => {
  const { context, sheets } = setup();
  vm.runInContext('_executeApi("apiSaveSystemSettings:mail_template", () => ({success:true, data:{id:"template-1"}}), {data:{template_name:"안내"}}, UserService.checkSession().data)', context);
  vm.runInContext('_executeApi("apiSaveSystemSettings:slot_override", () => ({success:true, data:{id:"override-1"}}), {data:{branch_id:"branch-1", slot_master_id:"slot-2"}}, UserService.checkSession().data)', context);
  vm.runInContext('_executeApi("apiSaveSystemSettings:slot_batch", () => ({success:true}), {data:{branch_id:"branch-1", payload:{"slot-2":{slot:3}}}}, UserService.checkSession().data)', context);
  vm.runInContext('_executeApi("apiDeleteSystemData:user", () => ({success:true}), {id:"user-1"}, UserService.checkSession().data)', context);
  const rows = sheets.get('activity_log').getRange(2, 1, 4).getValues();
  assert.deepEqual(rows.map(row => [row[5], row[6]]), [
    ['mail_template', 'template-1'], ['branch', 'branch-1'], ['branch', 'branch-1'], ['user', 'user-1']
  ]);
  assert.ok(Array.isArray(JSON.parse(rows[1][8]).changes));
});

test('external webhook updates the reservation without a user activity log', () => {
  const { context, sheets } = setup();
  context.ContentService = {
    MimeType: { JSON: 'json' },
    createTextOutput: text => ({ text, setMimeType() { return this; } })
  };
  context.ReservationService.updateReservation = () => ({ success: true });
  const response = vm.runInContext('doPost({postData:{contents:JSON.stringify({reservation_id:"r1"})}})', context);
  assert.match(response.text, /"success":true/);
  assert.equal(sheets.has('activity_log'),false);
});

test('manual Kakao completion is recorded with an explicit action and reservation ID', () => {
  const { context, sheets } = setup();
  context.ReservationService.updateMessageSentAt = () => ({ success: true });
  const response = vm.runInContext('apiUpdateReservationMessageSentAt("token", "r1")', context);
  assert.equal(response.success, true);
  const row = sheets.get('activity_log').getRange(2, 1, 1).getValues()[0];
  assert.equal(row[4], '알림톡 발송 완료');
  assert.deepEqual([row[5], row[6]], ['reservation', 'r1']);
  assert.equal(row[9], '완료');
});

test('every authenticated web mutation passes its actor to the activity recorder', () => {
  const source = fs.readFileSync('src/WebApi.js', 'utf8');
  const methods = [...source.matchAll(/^function (api\w+)\(/gm)].map(match => ({ name: match[1], start: match.index }));
  const reads = new Set([
    'apiBeginGoogleLogin', 'apiLogout', 'apiCheckSession', 'apiLoadInitialData',
    'apiGetBranches', 'apiGetReservations', 'apiGetUsers', 'apiGetActivityLogs',
    'apiGetSlotMasters', 'apiGetSlotDefaults', 'apiGetSlotOverrides',
    'apiGetMailTemplates', 'apiGetDuplicateGroups', 'apiGetBouncedEmails'
  ]);
  const expected = [
    'apiUpdateReservation', 'apiUpdateReservationMessageSentAt', 'apiUpdateReservationStatus',
    'apiUpdateDepositStatus', 'apiSendTemplatedMail', 'apiInitializeMailThread',
    'apiCorrectEmailAndInitializeThread', 'apiAddLabelsToThread', 'apiMarkReservationAsRead',
    'apiSaveSystemSettings', 'apiDeleteSystemData', 'apiCreateManualDuplicateGroup',
    'apiClearDuplicateGroup', 'apiExcludeReservationFromGroup',
    'apiMarkDuplicateMailSent', 'apiSendDuplicateConfirmationMail', 'apiRunSchemaMigration',
    'apiBackfillDuplicateGroups'
  ];
  const mutations = methods.filter(method => !reads.has(method.name));
  assert.deepEqual(mutations.map(method => method.name).sort(), expected.sort());
  for (const method of mutations) {
    const next = methods.find(entry => entry.start > method.start);
    const body = source.slice(method.start, next ? next.start : undefined);
    assert.match(body, /_executeApi\(/, method.name + ' must use the activity wrapper');
    assert.match(body, /auth\.data\);/, method.name + ' must pass the authenticated actor');
  }
});

test('existing activity sheet gains ordered target columns before the next record', () => {
  const { context, sheets } = setup();
  const sheet = sheets.get('activity_log') || context.Util.getSpreadsheet().insertSheet('activity_log');
  sheet.appendRow(['id', 'timestamp', 'actor_email', 'actor_name', 'action', 'target', 'details', 'status']);
  sheet.appendRow(['old-log', new Date('2026-10-01'), 'old@example.com', '기존 사용자', '기존 작업', 'old-target', '기존 내용', '완료']);
  vm.runInContext('_executeApi("apiUpdateReservationStatus", () => ({success:true}), {id:"r1", status:"confirm"}, UserService.checkSession().data)', context);
  const rows = sheet.getRange(1, 1, 3).getValues();
  assert.deepEqual(rows[0], ['id', 'timestamp', 'actor_email', 'actor_name', 'action', 'target_type', 'target_id', 'target', 'details', 'status']);
  assert.deepEqual(rows[1].slice(5), ['', '', 'old-target', '기존 내용', '완료']);
  assert.deepEqual([...rows[2].slice(5, 7)], ['reservation', 'r1']);
  assert.equal(vm.runInContext('ActivityLogService.getLogs().rows[1].target_id', context), 'r1');
});

test('schema migration reorders existing activity columns without changing records', () => {
  const { context } = setup();
  const sheet = context.Util.getSpreadsheet().insertSheet('activity_log');
  sheet.appendRow(['id', 'timestamp', 'actor_email', 'actor_name', 'action', 'target', 'details', 'status', 'target_type', 'target_id']);
  sheet.appendRow(['log-1', new Date('2026-10-01'), 'admin@example.com', '관리자', '예약 수정', 'r1 (홍길동)', '고객명', '완료', 'reservation', 'r1']);
  vm.runInContext(fs.readFileSync('src/MigrationService.js', 'utf8'), context);
  const result = vm.runInContext('MigrationService._ensureTable(Util.getSpreadsheet(), "activity_log", MigrationService.SCHEMA.activity_log)', context);
  const rows = sheet.getRange(1, 1, 2).getValues();
  assert.match(result, /열순서/);
  assert.deepEqual(rows[0], ['id', 'timestamp', 'actor_email', 'actor_name', 'action', 'target_type', 'target_id', 'target', 'details', 'status']);
  assert.deepEqual(rows[1].slice(5), ['reservation', 'r1', 'r1 (홍길동)', '고객명', '완료']);
});

test('failed mutation is recorded and activity list is admin only', () => {
  const env = setup('manager');
  vm.runInContext('_executeApi("apiUpdateDepositStatus", () => ({success:false, message:"실패"}), {id:"r1", status:"refund"}, UserService.checkSession().data)', env.context);
  assert.equal(env.sheets.get('activity_log').getRange(2, 1, 1).getValues()[0][9], '실패');
  assert.equal(vm.runInContext('apiGetActivityLogs("token").success', env.context), false);
  env.context.UserService.checkSession = () => ({ success: true, data: { role: 'admin' } });
  const result = vm.runInContext('apiGetActivityLogs("token", {startDate:"2026-10-01",endDate:"2026-10-14"})', env.context);
  assert.equal(result.success, true);
  assert.equal(result.data.rows.length, 1);
});

test('activity initial request returns every row regardless of filters and pagination', () => {
  const { context } = setup();
  const sheet = context.Util.getSpreadsheet().insertSheet('activity_log');
  sheet.appendRow(['id', 'timestamp', 'actor_email', 'actor_name', 'action', 'target_type', 'target_id', 'target', 'details', 'status']);
  for (let index = 0; index < 115; index++) {
    sheet.appendRow(['log-' + index, new Date(Date.UTC(2026, 9, 8, 1, index)), 'admin@example.com', '관리자',
      '예약 변경', index % 2 ? 'reservation' : 'branch', 'target-' + index, '대상 ' + index, '', index % 3 ? '완료' : '실패']);
  }
  const result = vm.runInContext('apiGetActivityLogs("token", {startDate:"2026-10-09",endDate:"2026-10-09",query:"missing",offset:50,status:"실패"})', context);
  assert.equal(result.success, true);
  assert.equal(result.data.rows.length, 115);
  assert.deepEqual([...result.data.targetTypes], ['branch', 'reservation']);
  assert.equal(typeof result.data.rows[0].timestamp, 'string');
});

test('duplicate mail records the group ID and recipient reservation in content', () => {
  const { context, sheets } = setup();
  context.GmailService = { sendDuplicateConfirmationMail: () => ({ success: true }) };
  context.DuplicateGroupService = { markDuplicateMailSent: () => ({ success: true }) };
  const result = vm.runInContext('apiSendDuplicateConfirmationMail("token", {groupId:"20261014_01",targetReservationId:"r2",threadId:"thread-2",customerName:"이손님",reservationIds:["r1","r2"]})', context);
  assert.equal(result.success, true);
  const row = sheets.get('activity_log').getRange(2, 1, 1).getValues()[0];
  assert.deepEqual([...row.slice(5, 8)], ['duplicate_group', '20261014_01', '중복 예약 그룹']);
});

test('reservation changes persist structured before and after values without cutting JSON', () => {
  const { context, sheets } = setup();
  context.changeResult = { activityChanges: [
    {field:'customer_name',before:'이전 이름',after:'새 이름'},
    {field:'status',before:'pending',after:'confirm'},
    {field:'private_notes',before:'기존 메모',after:'메모'.repeat(1000)},
    {field:'access_token',before:'secret',after:'secret-2'}
  ] };
  vm.runInContext('_executeApi("apiUpdateReservation", () => ({success:true,data:changeResult}), {id:"r1",customer_name:"새 이름"}, UserService.checkSession().data)', context);
  const details = sheets.get('activity_log').getRange(2, 1, 1).getValues()[0][8];
  const parsed = JSON.parse(details);
  assert.equal(parsed.changes.length, 3);
  assert.deepEqual(parsed.changes[0], {key:'customer_name', field:'고객명', before:'이전 이름', after:'새 이름' });
  assert.deepEqual(parsed.changes[1], {key:'status',field:'예약 상태', before:'pending', after:'confirm' });
  assert.equal(parsed.changes[2].after.length, 1501);
  assert.doesNotMatch(details, /secret|access_token/);
});

test('client filters and sorts cached logs without issuing requests', () => {
  const source = fs.readFileSync('src/JavaScript.html', 'utf8');
  const block = source.slice(source.indexOf('      const activityEntityName ='), source.indexOf('      const toggleActivitySort'));
  const context = {
    computed: callback => ({ get value() { return callback(); } }),
    activityLogs: { value: [
      {id:'old',timestamp:'2026-10-01T00:00:00Z',status:'완료',target_type:'reservation',target_id:'r0'},
      {id:'a',timestamp:'2026-10-13T15:00:00Z',status:'완료',target_type:'reservation',target_id:'r10',target:'r10 (홍길동)'},
      {id:'b',timestamp:'2026-10-14T14:59:59Z',status:'실패',target_type:'branch',target_id:'branch-1'},
      {id:'outside',timestamp:'2026-10-14T15:00:00Z',status:'완료',target_type:'reservation',target_id:'r20'}
    ] },
    branches:{value:[]}, users:{value:[]}, mailTemplates:{value:[]}, reservations:{value:[]}, slotMasters:{value:[]}, duplicateGroupsData:{value:[]}, activityTargetTypeLabels:{},
    activityDateStart:{value:'2026-10-14'}, activityDateEnd:{value:'2026-10-14'},
    activitySearch:{value:''}, activityStatus:{value:'all'}, activityTargetType:{value:'all'},
    activitySortKey:{value:'timestamp'}, activitySortDirection:{value:'desc'}
  };
  vm.createContext(context);
  vm.runInContext(block, context);
  const ids = () => [...vm.runInContext('filteredActivityLogs.value', context)].map(log => log.id);
  assert.deepEqual(ids(), ['b','a']);
  context.activityStatus.value = '완료';
  context.activitySearch.value = '홍길동';
  assert.deepEqual(ids(), ['a']);
  assert.equal(vm.runInContext('activityTarget(activityLogs.value[1])',context),'홍길동');
  context.activitySearch.value = '';
  context.activityStatus.value = 'all';
  context.activityTargetType.value = 'branch';
  assert.deepEqual(ids(), ['b']);
  context.activityTargetType.value = 'all';
  context.activitySortDirection.value = 'asc';
  assert.deepEqual(ids(), ['a','b']);
  assert.doesNotMatch(source, /activityQueryOptions|loadMoreActivityLogs|activityFilterTimer/);
});

test('existing schema migration includes activity_log', () => {
  const context = {
    console,
    Util: { getSpreadsheet: () => ({}) },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('src/MigrationService.js', 'utf8'), context);
  vm.runInContext('var captured = []; MigrationService._ensureTable = (spreadsheet, name, columns) => { captured.push({ name, columns }); return "checked"; };', context);
  const result = vm.runInContext('MigrationService.setup()', context);
  assert.equal(result.success, true);
  const activity = context.captured.find(entry => entry.name === 'activity_log');
  assert.ok(activity);
  assert.deepEqual([...activity.columns].map(column => column.name), [
    'id', 'timestamp', 'actor_email', 'actor_name', 'action', 'target_type', 'target_id', 'target', 'details', 'status'
  ]);
});

test('editor migration runners use the current account and do not write activity logs', () => {
  let activeEmail = 'owner@example.com';
  let activityWrites = 0;
  const context = {
    console,
    ActivityLogService: { record: () => { activityWrites++; } },
    Session: {
      getActiveUser: () => ({ getEmail: () => activeEmail }),
      getEffectiveUser: () => ({ getEmail: () => 'owner@example.com' })
    },
    Logger: { log: () => {} }
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('src/MigrationService.js', 'utf8'), context);
  vm.runInContext('MigrationService.setup = () => ({ success: true, results: ["checked"] });', context);
  vm.runInContext('MigrationService.backfillFutureDuplicateGroups = () => ({ success: true, count: 1 });', context);
  const result = vm.runInContext('runSchemaMigration()', context);
  assert.equal(result.success, true);
  assert.equal(vm.runInContext('runDuplicateBackfill().count', context), 1);
  assert.equal(activityWrites, 0);
  activeEmail = 'other@example.com';
  assert.throws(() => vm.runInContext('runSchemaMigration()', context), /Apps Script 에디터/);
  assert.throws(() => vm.runInContext('runDuplicateBackfill()', context), /Apps Script 에디터/);
  activeEmail = '';
  assert.throws(() => vm.runInContext('runSchemaMigration()', context), /Apps Script 에디터/);
  assert.throws(() => vm.runInContext('runDuplicateBackfill()', context), /Apps Script 에디터/);
});

test('schema migration API requires an admin session', () => {
  const env = setup('manager');
  let runs = 0;
  env.context.MigrationService = { setup: () => { runs++; return { success: true, results: [] }; } };
  assert.equal(vm.runInContext('apiRunSchemaMigration("token").success', env.context), false);
  assert.equal(runs, 0);
  env.context.UserService.checkSession = () => ({ success: true, data: { role: 'admin', user_email: 'admin@example.com', user_name: '관리자' } });
  const response = vm.runInContext('apiRunSchemaMigration("token")', env.context);
  assert.equal(response.success, true);
  assert.equal(Array.isArray(response.results), true);
  assert.equal(runs, 1);
  assert.equal(env.sheets.has('activity_log'),false);
});

test('reservation update audits only actual normalized changes, including cleared notes', () => {
  const { context } = setup();
  vm.runInContext(fs.readFileSync('src/ReservationService.js', 'utf8'), context);
  const rows = [
    ['id','customer_name','pax','private_notes','reservation_date'],
    ['r1','홍길동',2,'기존 메모',new Date('2026-10-14T09:00:00Z')]
  ];
  context.Util.getSpreadsheet = () => ({getSheetByName: () => ({
    getDataRange: () => ({getValues: () => rows}),
    getRange: row => ({setValues: values => { rows[row - 1] = values[0]; }})
  })});
  context.Util.collapseBlankLines = value => value.replace(/\n{2,}/g, '\n');
  vm.runInContext('ReservationService.syncCalendarAndSlot = () => {};',context);
  const result = vm.runInContext('ReservationService.updateReservation("r1", {customer_name:"홍길동",pax:"3",private_notes:"",visit_date:"2026-10-14",visit_time:"19:00",unknown:"ignored"})',context);
  assert.equal(result.success,true);
  const changes = JSON.parse(JSON.stringify(result.data.activityChanges));
  assert.deepEqual(changes.map(change => change.field),['pax','private_notes','reservation_date']);
  assert.deepEqual(changes[0],{field:'pax',before:2,after:3});
  assert.deepEqual(changes[1],{field:'private_notes',before:'기존 메모',after:''});
  assert.equal(changes[2].before,'2026-10-14T09:00:00.000Z');
  assert.equal(changes[2].after,rows[1][4].toISOString());
  assert.equal(vm.runInContext('ReservationService.updateReservation("r1", {pax:"3",private_notes:""}).data.activityChanges.length',context),0);
});


test('mutation response returns the persisted log with a serializable timestamp', () => {
  const { context, sheets } = setup();
  const response = vm.runInContext('_executeApi("apiUpdateReservationStatus", () => ({success:true}), {id:"r1",status:"confirm"}, UserService.checkSession().data)',context);
  assert.equal(response.activityLog.id,'log-id');
  assert.equal(response.activityLog.target_id,'r1');
  assert.equal(response.activityLog.status,'완료');
  assert.equal(typeof response.activityLog.timestamp,'string');
  assert.equal(response.activityLog.id,sheets.get('activity_log').getRange(2,1,1).getValues()[0][0]);
});


test('deposit amount and status changes are both persisted and displayed in the change grid', () => {
  const { context, sheets } = setup();
  context.Config.SHEET_NAMES.RESERVATION = 'reservation';
  vm.runInContext(fs.readFileSync('src/ReservationService.js','utf8'),context);
  vm.runInContext('ReservationService.getReservationById = () => ({customer_name:"홍길동"});',context);
  const sheet = context.Util.getSpreadsheet().insertSheet('reservation');
  sheet.appendRow(['id','customer_name','deposit_amount','deposit_status']);
  sheet.appendRow(['r1','홍길동',100,'pending']);
  const response = vm.runInContext('apiUpdateReservation("token",{id:"r1",deposit_amount:200,deposit_status:"confirm"})',context);
  assert.equal(response.success,true);
  const changes = JSON.parse(response.activityLog.details).changes;
  assert.deepEqual(changes,[
    {key:'deposit_status',field:'예약금 상태',before:'pending',after:'confirm'},
    {key:'deposit_amount',field:'예약금',before:100,after:200}
  ]);
  const inline = vm.runInContext('apiUpdateDepositStatus("token","r1","refund")',context);
  assert.equal(inline.success,true);
  assert.deepEqual(JSON.parse(inline.activityLog.details).changes,[{key:'deposit_status',field:'예약금 상태',before:'confirm',after:'refund'}]);
  const persisted = sheets.get('activity_log').getRange(2,1,2).getValues();
  assert.deepEqual(JSON.parse(persisted[0][8]).changes,changes);
  assert.equal(JSON.parse(persisted[1][8]).changes[0].after,'refund');
});


test('reservation targets store name and email, preferring request email over lookup', () => {
  const { context } = setup();
  context.ReservationService.getReservationById = () => ({customer_name:'홍길동',email:'old@example.com'});
  const run = expression => vm.runInContext(expression,context).activityLog.target;
  assert.equal(run('_executeApi("apiUpdateReservationStatus", () => ({success:true}), {id:"r1",status:"confirm"}, UserService.checkSession().data)'), '홍길동 (old@example.com)');
  assert.equal(run('_executeApi("apiUpdateReservation", () => ({success:true}), {id:"r1",customer_name:"김손님",email:"new@example.com"}, UserService.checkSession().data)'), '김손님 (new@example.com)');
  assert.equal(run('_executeApi("apiCorrectEmailAndInitializeThread", () => ({success:true}), {reservationId:"r1",newEmail:"corrected@example.com"}, UserService.checkSession().data)'), '홍길동 (corrected@example.com)');
  assert.equal(run('_executeApi("apiUpdateReservation", () => ({success:true}), {id:"r1",customer_name:"김손님",email:""}, UserService.checkSession().data)'), '김손님');
});


test('persisted log JSON keeps deposit status directly before amount regardless of request order', () => {
  const {context,sheets} = setup();
  context.resultData = {activityChanges:[
    {field:'deposit_amount',before:100,after:200},
    {field:'private_notes',before:'기존',after:'수정'},
    {field:'status',before:'pending',after:'confirm'},
    {field:'deposit_status',before:'pending',after:'confirm'},
    {field:'customer_name',before:'이전 이름',after:'새 이름'}
  ]};
  const response = vm.runInContext('_executeApi("apiUpdateReservation", () => ({success:true,data:resultData}), {id:"r1"}, UserService.checkSession().data)',context);
  const persisted = sheets.get('activity_log').getRange(2,1,1).getValues()[0][8];
  assert.equal(persisted,response.activityLog.details);
  assert.deepEqual(JSON.parse(persisted).changes.map(change => change.field),['고객명','예약 상태','예약금 상태','예약금','비공개 메모']);
});

test('email correction restores persisted email and thread when confirmation sending fails', () => {
  const {context,sheets} = setup();
  context.Config.SHEET_NAMES.RESERVATION = 'reservation';
  vm.runInContext(fs.readFileSync('src/ReservationService.js','utf8'),context);
  const sheet = context.Util.getSpreadsheet().insertSheet('reservation');
  sheet.appendRow(['id','customer_name','email','email_thread_id']);
  sheet.appendRow(['r1','홍길동','old@example.com','old-thread']);
  context.GmailService = {createDummyElfsightThread:() => {throw new Error('메일 전송 실패');}};
  const response = vm.runInContext('apiCorrectEmailAndInitializeThread("token", {reservationId:"r1",newEmail:"new@example.com",data:{customer_name:"홍길동"}})',context);
  assert.equal(response.success,false);
  const stored = sheet.getDataRange().getValues()[1];
  assert.equal(stored[2],'old@example.com');
  assert.equal(stored[3],'old-thread');
  assert.equal(response.activityLog.action,'예약 이메일 변경');
  assert.equal(response.activityLog.status,'실패');
  assert.deepEqual(JSON.parse(response.activityLog.details).changes,[]);
});

test('authenticated background helpers perform work without activity rows', () => {
  const {context,sheets} = setup();
  let labels = 0;
  context.GmailService = {addLabelsAfterDelay:() => {labels++;}};
  context.DuplicateGroupService = {markDuplicateMailSent:() => ({success:true})};
  assert.equal(vm.runInContext('apiAddLabelsToThread("token",{reservationId:"r1",threadId:"t1",status:"confirm",deposit_status:"confirm"}).success',context),true);
  assert.equal(vm.runInContext('apiMarkDuplicateMailSent("token",{groupId:"g1",reservationIds:["r1"]}).success',context),true);
  assert.equal(labels,1);
  assert.equal(sheets.has('activity_log'),false);
});
