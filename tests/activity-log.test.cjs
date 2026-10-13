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
    Config: { SHEET_NAMES: { ACTIVITY_LOG: 'activity_log' }, USER_ROLES: { ADMIN: 'admin' } },
    Util: {
      getSpreadsheet: () => spreadsheet,
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
  assert.equal(rows[1][4], '예약 정보 수정');
  assert.equal(rows[1][5], 'reservation');
  assert.equal(rows[1][6], 'reservation-1');
  assert.equal(rows[1][7], 'reservation-1 (홍길동)');
  assert.match(rows[1][8], /예약 상태/);
  assert.doesNotMatch(rows[1].join(' '), /비밀 메모 본문|secret|access_token/);
  assert.equal(rows[1][9], '완료');
});

test('generated user and group IDs appear in the activity target', () => {
  const { context, sheets } = setup();
  vm.runInContext('_executeApi("apiSaveSystemSettings:user", () => ({success:true, data:{id:"user-1"}}), {data:{user_name:"김사용자"}}, UserService.checkSession().data)', context);
  vm.runInContext('_executeApi("apiCreateManualDuplicateGroup", () => ({success:true, data:{group_id:"group-1"}}), {reservationIds:["r1","r2"]}, UserService.checkSession().data)', context);
  const rows = sheets.get('activity_log').getRange(2, 1, 2).getValues();
  assert.equal(rows[0][7], 'user-1 (김사용자)');
  assert.equal(rows[1][7], 'group-1');
  assert.deepEqual(rows.map(row => [row[5], row[6]]), [['user', 'user-1'], ['duplicate_group', 'group-1']]);
});

test('mail uses reservation ID and single slot uses branch ID with slot details', () => {
  const { context, sheets } = setup();
  vm.runInContext('_executeApi("apiSendTemplatedMail", () => ({success:true}), {reservationId:"reservation-2", threadId:"thread-1", data:{customer_name:"이손님"}}, UserService.checkSession().data)', context);
  vm.runInContext('_executeApi("apiSaveSystemSettings:slot_override", () => ({success:true}), {data:{branch_id:"branch-1", slot_master_id:"slot-2", date:"2026-10-13"}}, UserService.checkSession().data)', context);
  const rows = sheets.get('activity_log').getRange(2, 1, 2).getValues();
  assert.equal(rows[0][7], 'reservation-2 (이손님)');
  assert.equal(rows[1][7], 'branch-1');
  assert.match(rows[1][8], /슬롯 ID slot-2 \(18:00\)/);
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
  assert.match(rows[1][8], /슬롯 ID slot-2 \(18:00\)/);
});

test('a successful external webhook update records its source and reservation ID', () => {
  const { context, sheets } = setup();
  context.ContentService = {
    MimeType: { JSON: 'json' },
    createTextOutput: text => ({ text, setMimeType() { return this; } })
  };
  context.ReservationService.updateReservation = () => ({ success: true });
  const response = vm.runInContext('doPost({postData:{contents:JSON.stringify({reservation_id:"r1"})}})', context);
  assert.match(response.text, /"success":true/);
  const row = sheets.get('activity_log').getRange(2, 1, 1).getValues()[0];
  assert.equal(row[3], 'SYSTEM');
  assert.equal(row[4], '알림톡 발송 시각 갱신');
  assert.deepEqual([row[5], row[6]], ['reservation', 'r1']);
});

test('manual Kakao completion is recorded with an explicit action and reservation ID', () => {
  const { context, sheets } = setup();
  context.ReservationService.updateMessageSentAt = () => ({ success: true });
  const response = vm.runInContext('apiUpdateReservationMessageSentAt("token", "r1")', context);
  assert.equal(response.success, true);
  const row = sheets.get('activity_log').getRange(2, 1, 1).getValues()[0];
  assert.equal(row[4], '알림톡 발송 완료 처리');
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
    'apiClearDuplicateGroup', 'apiRemoveManualDuplicateGroup', 'apiExcludeReservationFromGroup',
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
  assert.equal(vm.runInContext('ActivityLogService.getLogsPage({startDate:"2026-10-01",endDate:"2026-10-14"}).rows[0].target_id', context), 'r1');
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

test('activity pages search the full date range and sort before pagination', () => {
  const { context, sheets } = setup();
  const sheet = context.Util.getSpreadsheet().insertSheet('activity_log');
  sheet.appendRow(['id', 'timestamp', 'actor_email', 'actor_name', 'action', 'target_type', 'target_id', 'target', 'details', 'status']);
  for (let index = 0; index < 115; index++) {
    sheet.appendRow(['log-' + index, new Date(Date.UTC(2026, 9, 8, 1, index)), 'admin@example.com', '관리자',
      index % 2 ? '예약 변경' : '지점 변경', index % 2 ? 'reservation' : 'branch', 'target-' + index,
      '대상 ' + index, '', index % 3 ? '완료' : '실패']);
  }
  const options = { startDate: '2026-10-08', endDate: '2026-10-08', sortKey: 'timestamp', sortDirection: 'desc' };
  context.options = options;
  const first = vm.runInContext('apiGetActivityLogs("token", options)', context).data;
  assert.equal(first.rows.length, 50);
  assert.equal(first.nextOffset, 50);
  assert.equal(first.rows[0].id, 'log-114');
  sheet.appendRow(['new-log', new Date(Date.UTC(2026, 9, 8, 3)), 'admin@example.com', '관리자',
    '새 작업', 'reservation', 'new-target', '새 대상', '', '완료']);
  options.offset = first.nextOffset;
  options.snapshotLastRow = first.snapshotLastRow;
  const second = vm.runInContext('apiGetActivityLogs("token", options)', context).data;
  assert.equal(second.rows.length, 50);
  assert.equal(second.rows[0].id, 'log-64');
  options.offset = second.nextOffset;
  const third = vm.runInContext('apiGetActivityLogs("token", options)', context).data;
  assert.equal(third.rows.length, 15);
  assert.equal(third.nextOffset, null);
  options.offset = 0;
  options.targetType = 'reservation';
  options.status = '실패';
  options.query = 'target-9';
  options.sortKey = 'target_id';
  options.sortDirection = 'asc';
  const filtered = vm.runInContext('apiGetActivityLogs("token", options)', context).data;
  assert.deepEqual([...filtered.rows].map(row => row.target_id), ['target-9', 'target-93', 'target-99']);
  assert.deepEqual([...filtered.targetTypes], ['branch', 'reservation']);
  assert.equal(vm.runInContext('apiGetActivityLogs("token", {startDate:"2026-10-09",endDate:"2026-10-09"})', context).data.rows.length, 0);
  assert.equal(vm.runInContext('apiGetActivityLogs("token", {startDate:"2026-10-09",endDate:"2026-10-08"})', context).success, false);
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
  const rows = env.sheets.get('activity_log').getRange(2, 1, 2).getValues();
  assert.equal(rows[1][2], 'admin@example.com');
  assert.equal(rows[1][4], '시트 구조 갱신');
  assert.equal(rows[1][9], '완료');
});
