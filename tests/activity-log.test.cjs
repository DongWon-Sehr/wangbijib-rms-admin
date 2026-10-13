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
      getRange: (row, column, count) => ({ getValues: () => rows.slice(row - 1, row - 1 + count) })
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
    Utilities: { getUuid: () => 'log-id' },
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
  assert.equal(rows[1][5], '홍길동');
  assert.match(rows[1][6], /예약 상태/);
  assert.doesNotMatch(rows[1].join(' '), /비밀 메모 본문|secret|access_token/);
  assert.equal(rows[1][7], '완료');
});

test('failed mutation is recorded and activity list is admin only', () => {
  const env = setup('manager');
  vm.runInContext('_executeApi("apiUpdateDepositStatus", () => ({success:false, message:"실패"}), {id:"r1", status:"refund"}, UserService.checkSession().data)', env.context);
  assert.equal(env.sheets.get('activity_log').getRange(2, 1, 1).getValues()[0][7], '실패');
  assert.equal(vm.runInContext('apiGetActivityLogs("token").success', env.context), false);
  env.context.UserService.checkSession = () => ({ success: true, data: { role: 'admin' } });
  const result = vm.runInContext('apiGetActivityLogs("token")', env.context);
  assert.equal(result.success, true);
  assert.equal(result.data.length, 1);
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
    'id', 'timestamp', 'actor_email', 'actor_name', 'action', 'target', 'details', 'status'
  ]);
});

test('editor schema migration runner uses the current account and rejects web-app identities', () => {
  let activeEmail = 'owner@example.com';
  const context = {
    console,
    Session: {
      getActiveUser: () => ({ getEmail: () => activeEmail }),
      getEffectiveUser: () => ({ getEmail: () => 'owner@example.com' })
    },
    Logger: { log: () => {} }
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('src/MigrationService.js', 'utf8'), context);
  vm.runInContext('MigrationService.setup = () => ({ success: true, results: ["checked"] });', context);
  const result = vm.runInContext('runSchemaMigration()', context);
  assert.equal(result.success, true);
  activeEmail = 'other@example.com';
  assert.throws(() => vm.runInContext('runSchemaMigration()', context), /Apps Script 에디터/);
  activeEmail = '';
  assert.throws(() => vm.runInContext('runSchemaMigration()', context), /Apps Script 에디터/);
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
  assert.equal(Array.isArray(response.data.results), true);
  assert.equal(runs, 1);
});
