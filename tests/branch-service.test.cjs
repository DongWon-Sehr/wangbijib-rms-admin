const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function setup(role = 'admin') {
  const rows = [['id', 'branch_name_en', 'branch_name_ko', 'address', 'google_map_link', 'enabled', 'calendar_id', 'created_at', 'updated_at']];
  let releases = 0;
  let writes = 0;
  const sheet = {
    getDataRange: () => ({ getValues: () => rows }),
    appendRow: row => rows.push(row),
    getRange: row => ({ setValues: values => { rows[row - 1] = values[0]; } })
  };
  const context = {
    console: { log() {}, error() {}, warn() {} },
    Config: { SHEET_NAMES: { BRANCH: 'branch' }, USER_ROLES: { ADMIN: 'admin' } },
    Util: {
      getSpreadsheet: () => ({ getSheetByName: () => sheet }),
      getSheetDataAsObjects: () => rows.slice(1).map(row => Object.fromEntries(rows[0].map((key,index) => [key,row[index]]))), getUuid: () => 'branch-new',
      createResponse: (success, data = null, message = '') => ({ success, data, message })
    },
    UserService: { checkSession: () => ({ success: true, data: { role } }) },
    ActivityLogService: { record: () => { writes++; return { id: 'log-new' }; } },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() { releases++; } }) },
    SpreadsheetApp: { flush() {} }
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('src/BranchService.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('src/ActivityAudit.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('src/WebApi.js', 'utf8'), context);
  context.input = { branch_name_ko: ' 신규점 ', branch_name_en: ' New Branch ', calendar_id: ' new-calendar ', address: ' 서울 ', google_map_link: '' };
  return { context, rows, releases: () => releases, writes: () => writes };
}

test('admin creates a branch with generated ID, trimmed fields and serializable response', () => {
  const env = setup();
  const result = vm.runInContext('apiSaveSystemSettings("token", "branch", input)', env.context);
  assert.equal(result.success, true);
  assert.equal(result.data.id, 'branch-new');
  assert.equal(result.data.branch_name_ko, '신규점');
  assert.equal(result.data.enabled, true);
  assert.equal(typeof result.data.created_at, 'string');
  assert.equal(env.rows.length, 2);
  assert.equal(env.rows[1][6], 'new-calendar');
  assert.equal(env.releases(), 1);
  assert.equal(env.writes(), 1);
});

test('branch creation rejects missing required fields and duplicate matching keys', () => {
  const env = setup();
  env.context.input.calendar_id = '';
  assert.equal(vm.runInContext('apiSaveSystemSettings("token", "branch", input).success', env.context), false);
  assert.equal(env.rows.length, 1);
  env.context.input.calendar_id = 'new-calendar';
  assert.equal(vm.runInContext('apiSaveSystemSettings("token", "branch", input).success', env.context), true);
  env.context.input.branch_name_en = 'NEW BRANCH';
  env.context.input.calendar_id = 'other-calendar';
  assert.match(vm.runInContext('apiSaveSystemSettings("token", "branch", input).message', env.context), /영문 지점명/);
  env.context.input.branch_name_en = 'Other Branch';
  env.context.input.calendar_id = 'new-calendar';
  assert.match(vm.runInContext('apiSaveSystemSettings("token", "branch", input).message', env.context), /캘린더 ID/);
  assert.equal(env.rows.length, 2);
  assert.equal(env.releases(), 3);
});

test('non-admin cannot register a branch and existing branch edit retains its ID', () => {
  const manager = setup('manager');
  assert.equal(vm.runInContext('apiSaveSystemSettings("token", "branch", input).success', manager.context), false);
  assert.equal(manager.rows.length, 1);
  assert.equal(manager.writes(), 0);
  const env = setup();
  vm.runInContext('apiSaveSystemSettings("token", "branch", input)', env.context);
  env.context.input.id = 'branch-new';
  env.context.input.branch_name_ko = '수정점';
  assert.equal(vm.runInContext('apiSaveSystemSettings("token", "branch", input).success', env.context), true);
  assert.equal(env.rows.length, 2);
  assert.equal(env.rows[1][0], 'branch-new');
  assert.equal(env.rows[1][2], '수정점');
});
