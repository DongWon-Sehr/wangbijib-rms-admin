const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');

function setup() {
  const entries = new Map();
  const properties = new Map([['GOOGLE_OAUTH_CLIENT_SECRET', 'test-secret']]);
  let profileEmail = 'admin@example.com';
  const calls = [];
  const users = [{ id: '1', user_email: 'admin@example.com', user_name: 'Admin', role: 'admin', enabled: true }];
  const context = {
    console,
    Config: { GOOGLE_CLIENT_ID: 'client-id', SHEET_NAMES: { USER: 'user' }, USER_ROLES: { ADMIN: 'admin' } },
    Util: {
      createResponse: (success, data = null, message = '') => ({ success, data, message }),
      getSheetDataAsObjects: () => users
    },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      DigestAlgorithm: { SHA_256: 'sha256' },
      computeDigest: (algorithm, value) => [...crypto.createHash(algorithm).update(value).digest()],
      base64EncodeWebSafe: digest => Buffer.from(digest).toString('base64url')
    },
    CacheService: { getScriptCache: () => ({
      put: (key, value) => entries.set(key, value),
      get: key => entries.get(key),
      remove: key => entries.delete(key)
    }) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: key => properties.get(key),
      setProperty: (key, value) => properties.set(key, value),
      deleteProperty: key => properties.delete(key),
      getProperties: () => Object.fromEntries(properties)
    }) },
    UrlFetchApp: { fetch: (url, options) => {
      calls.push({ url, options });
      return url.includes('/token')
        ? { getResponseCode: () => 200, getContentText: () => JSON.stringify({ access_token: 'google-access' }) }
        : { getResponseCode: () => 200, getContentText: () => JSON.stringify({ email: profileEmail, email_verified: true }) };
    } },
    ScriptApp: { getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/deployment/exec' }) },
    BranchService: { getAllBranches: () => ['secret branch'] },
    HtmlService: {},
    Cache: {},
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('src/UserService.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('src/ActivityAudit.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('src/WebApi.js', 'utf8'), context);
  return { context, entries, properties, calls, users, setProfileEmail: x => { profileEmail = x; } };
}

test('anonymous and email-shaped values cannot read protected API', () => {
  const { context } = setup();
  assert.equal(vm.runInContext('apiGetBranches()', context).success, false);
  assert.equal(vm.runInContext('apiGetBranches("admin@example.com")', context).success, false);
  assert.equal(vm.runInContext('apiUpdateReservation("admin@example.com", {id:"x"})', context).success, false);
});

test('admin user list includes saved branch permissions for edit checkboxes', () => {
  const { context } = setup();
  context.Config.SHEET_NAMES.USER_PERMISSION = 'user_branch_permission';
  vm.runInContext('UserService.checkSession = () => ({ success: true, data: { role: "admin" } });', context);
  context.Util.getSheetDataAsObjects = sheetName => sheetName === 'user'
    ? [{ id: 'manager-1', user_email: 'manager@example.com', role: 'manager' }]
    : [
        { user_id: 'manager-1', branch_id: 'branch-1', enabled: true },
        { user_id: 'manager-1', branch_id: 'branch-2', enabled: true },
        { user_id: 'manager-1', branch_id: 'branch-3', enabled: false },
        { user_id: 'manager-2', branch_id: 'branch-4', enabled: true }
      ];
  const result = vm.runInContext('apiGetUsers("token")', context);
  assert.equal(result.success, true);
  assert.deepEqual([...result.data[0].branch_ids], ['branch-1', 'branch-2']);
});

test('OAuth code exchange issues a session only for a verified registered user', () => {
  const { context, calls } = setup();
  const begin = vm.runInContext('UserService.beginGoogleLogin(ScriptApp.getService().getUrl())', context);
  assert.equal(new URL(begin.url).searchParams.get('redirect_uri'), 'https://script.google.com/macros/s/deployment/exec');
  context.state = begin.state;
  const session = vm.runInContext('UserService.completeGoogleLogin("code", state, ScriptApp.getService().getUrl())', context);
  context.sessionToken = session.token;
  assert.equal(vm.runInContext('apiGetBranches(sessionToken).success', context), true);
  assert.equal(calls[0].options.payload.client_secret, 'test-secret');
  assert.throws(() => vm.runInContext('UserService.completeGoogleLogin("code", state, ScriptApp.getService().getUrl())', context));
  vm.runInContext('apiLogout(sessionToken)', context);
  assert.equal(vm.runInContext('apiGetBranches(sessionToken).success', context), false);
});

test('unregistered or unverified Google accounts do not receive a session', () => {
  const env = setup();
  const begin = vm.runInContext('UserService.beginGoogleLogin(ScriptApp.getService().getUrl())', env.context);
  env.context.state = begin.state;
  env.setProfileEmail('outsider@example.com');
  assert.throws(() => vm.runInContext('UserService.completeGoogleLogin("code", state, ScriptApp.getService().getUrl())', env.context), /등록되지 않은/);
});

test('revoked or disabled users lose access to an existing session', () => {
  const env = setup();
  const begin = vm.runInContext('UserService.beginGoogleLogin(ScriptApp.getService().getUrl())', env.context);
  env.context.state = begin.state;
  const session = vm.runInContext('UserService.completeGoogleLogin("code", state, ScriptApp.getService().getUrl())', env.context);
  env.context.sessionToken = session.token;
  env.users[0].enabled = false;
  assert.equal(vm.runInContext('apiGetBranches(sessionToken).success', env.context), false);
});

test('session survives cache eviction, expires after seven days, and logout revokes it', () => {
  const env = setup();
  const begin = vm.runInContext('UserService.beginGoogleLogin(ScriptApp.getService().getUrl())', env.context);
  env.context.state = begin.state;
  const session = vm.runInContext('UserService.completeGoogleLogin("code", state, ScriptApp.getService().getUrl())', env.context);
  env.context.sessionToken = session.token;
  assert.equal([...env.properties.keys()].includes('WANG_RMS_AUTH_' + session.token), false);
  env.entries.clear();
  assert.equal(vm.runInContext('apiGetBranches(sessionToken).success', env.context), true);
  vm.runInContext('apiLogout(sessionToken)', env.context);
  assert.equal(vm.runInContext('apiGetBranches(sessionToken).success', env.context), false);

  const nextBegin = vm.runInContext('UserService.beginGoogleLogin(ScriptApp.getService().getUrl())', env.context);
  env.context.state = nextBegin.state;
  const nextSession = vm.runInContext('UserService.completeGoogleLogin("code", state, ScriptApp.getService().getUrl())', env.context);
  env.context.sessionToken = nextSession.token;
  const key = [...env.properties.keys()].find(key => key.startsWith('WANG_RMS_AUTH_'));
  const record = JSON.parse(env.properties.get(key));
  assert.equal(record.expiresAt - Date.now() > 6 * 24 * 60 * 60 * 1000, true);
  env.properties.set(key, JSON.stringify({ ...record, expiresAt: Date.now() - 1 }));
  env.entries.clear();
  assert.equal(vm.runInContext('apiGetBranches(sessionToken).success', env.context), false);
  assert.equal(env.properties.has(key), false);
});

test('all public data API entry points check the session', () => {
  const source = fs.readFileSync('src/WebApi.js', 'utf8');
  const matches = [...source.matchAll(/function (api\w+)\([^)]*\) \{([\s\S]*?)(?=\nfunction |$)/g)];
  for (const [, name, body] of matches) {
    if (['apiBeginGoogleLogin', 'apiCheckSession', 'apiLogout'].includes(name)) continue;
    assert.match(body.slice(0, 120), /UserService\.checkSession\(token\)/, name);
  }
});

function setupBrowserAuth({ callback = null, oauthState = null, clientIp = null } = {}) {
  const savedToken = 'a'.repeat(64);
  const localValues = new Map([
    ['WANG_RMS_SESSION_TOKEN', savedToken],
    ['WANG_RMS_SESSION_EMAIL', 'legacy@example.com'],
    ['other_app_key', 'keep']
  ]);
  const sessionValues = new Map([['other_app_key', 'keep']]);
  if (oauthState) sessionValues.set('WANG_RMS_OAUTH_STATE', oauthState);
  const storage = values => ({
    get length() { return values.size; },
    key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key)
  });
  const calls = [];
  const errors = [];
  const mounted = [];
  const intervals = [];
  const ipLookups = [];
  const responses = {
    apiCheckSession: { success: true, data: { role: 'admin', allowedBranchIds: ['all'] } },
    apiBeginGoogleLogin: { success: true, data: { state: 'new-state', url: 'https://accounts.google.com/login' } },
    apiGetActivityLogs: { success: true, data: { rows: [], nextOffset: null, targetTypes: [] } }
  };
  let state;
  const context = {
    console: { log() {}, warn() {}, error: error => errors.push(error) },
    localStorage: storage(localValues),
    sessionStorage: storage(sessionValues),
    navigator: { userAgent: 'iPhone', maxTouchPoints: 1 },
    document: { getElementById: () => ({ dataset: {} }), addEventListener() {} },
    window: { WANG_OAUTH_RESULT: callback, addEventListener() {} },
    ...(clientIp === null ? {} : { fetch: async () => { ipLookups.push(1); if (clientIp instanceof Error) throw clientIp; return { json: async () => ({ ip: clientIp }) }; } }),
    alert: message => errors.push(message),
    setInterval: (callback, duration) => { intervals.push({ callback, duration }); return intervals.length; },
    clearInterval() {},
    setTimeout: () => 1,
    clearTimeout() {},
    Vue: {
      ref: value => ({ value }),
      reactive: value => value,
      computed: getter => ({ get value() { return typeof getter === 'function' ? getter() : getter.get(); } }),
      watch() {},
      onMounted: hook => mounted.push(hook),
      onUnmounted() {},
      nextTick: callback => Promise.resolve().then(() => callback?.()),
      createApp: options => ({ directive() {}, mount: () => { state = options.setup(); } })
    },
    google: { script: {
      history: { replace() {} },
      get run() {
        let success;
        let failure;
        const runner = new Proxy({}, {
          get(_, name) {
            if (name === 'withSuccessHandler') return handler => { success = handler; return runner; };
            if (name === 'withFailureHandler') return handler => { failure = handler; return runner; };
            return (...args) => {
              calls.push({ name, args });
              const response = Object.hasOwn(responses, name) ? responses[name] : { success: true, data: [] };
              queueMicrotask(() => response instanceof Error ? failure(response) : response && typeof response.then === "function" ? response.then(success, failure) : success(response));
            };
          }
        });
        return runner;
      }
    } }
  };
  vm.createContext(context);
  const source = fs.readFileSync('src/javascript.html', 'utf8').replace(/^<script>\s*/, '').replace(/<\/script>\s*$/, '');
  vm.runInContext(source, context);
  return {
    state, savedToken, localValues, sessionValues, calls, responses, errors, intervals, ipLookups,
    async start() {
      mounted.forEach(hook => hook());
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(errors, []);
    }
  };
}

test('browser session survives failed initial checks while protected content stays hidden', async t => {
  for (const [name, response] of [
    ['RPC error', new Error('Temporary network failure')],
    ['empty response', null],
    ['expired or rejected session', { success: false, data: { needLogin: true }, message: '세션이 만료되었습니다.' }]
  ]) {
    await t.test(name, async () => {
      const browser = setupBrowserAuth();
      browser.responses.apiCheckSession = response;
      await browser.start();
      assert.equal(browser.localValues.get('WANG_RMS_SESSION_TOKEN'), browser.savedToken);
      assert.equal(browser.state.appState.value, 'login');
      assert.equal(browser.state.currentUser.value, null);
      assert.equal(browser.calls.some(call => call.name === 'apiLogout' || call.name === 'apiGetReservations'), false);
    });
  }
});

test('failed or mismatched OAuth callbacks preserve and verify the saved session', async t => {
  for (const callback of [
    { error: '이미 사용한 인증 코드입니다.', state: 'expected' },
    { token: 'b'.repeat(64), state: 'unexpected' }
  ]) {
    await t.test(callback.error ? 'OAuth error' : 'state mismatch', async () => {
      const browser = setupBrowserAuth({ callback, oauthState: 'expected' });
      await browser.start();
      assert.equal(browser.localValues.get('WANG_RMS_SESSION_TOKEN'), browser.savedToken);
      assert.equal(browser.calls.find(call => call.name === 'apiCheckSession').args[0].token, browser.savedToken);
      assert.equal(browser.sessionValues.has('WANG_RMS_OAUTH_STATE'), false);
      assert.equal(browser.state.appState.value, 'authorized');
    });
  }
});

test('valid OAuth callback replaces the saved token and checks the new session', async () => {
  const token = 'b'.repeat(64);
  const browser = setupBrowserAuth({ callback: { token, state: 'expected' }, oauthState: 'expected' });
  await browser.start();
  assert.equal(browser.localValues.get('WANG_RMS_SESSION_TOKEN'), token);
  assert.equal(browser.calls.find(call => call.name === 'apiCheckSession').args[0].token, token);
  assert.equal(browser.state.appState.value, 'authorized');
});

test('failed session check after saving a user returns to login without logging out', async () => {
  const browser = setupBrowserAuth();
  await browser.start();
  browser.responses.apiCheckSession = new Error('Temporary network failure');
  browser.state.activeSystemData.value = { type: 'user', mode: 'edit' };
  browser.state.localData.value = { id: 'user-1' };
  await browser.state.handleSystemSave();
  assert.equal(browser.localValues.get('WANG_RMS_SESSION_TOKEN'), browser.savedToken);
  assert.equal(browser.state.appState.value, 'login');
  assert.equal(browser.state.currentUser.value, null);
  assert.equal(browser.calls.some(call => call.name === 'apiLogout'), false);
});

test('explicit logout revokes the session and clears only the app browser storage', async () => {
  const browser = setupBrowserAuth();
  await browser.start();
  assert.equal(browser.localValues.has('WANG_RMS_SESSION_EMAIL'), true);
  await browser.state.handleLogout();
  assert.equal(browser.localValues.has('WANG_RMS_SESSION_TOKEN'), false);
  assert.equal(browser.localValues.has('WANG_RMS_SESSION_EMAIL'), false);
  assert.equal(browser.localValues.get('other_app_key'), 'keep');
  assert.equal(browser.sessionValues.get('other_app_key'), 'keep');
  assert.equal(browser.state.appState.value, 'login');
  assert.equal(browser.state.currentUser.value, null);
  assert.equal(browser.calls.find(call => call.name === 'apiLogout').args[0].token, browser.savedToken);
});


test('60-second sync refreshes reservation, settings, and logs in reactive memory', async () => {
  const browser = setupBrowserAuth();
  await browser.start();
  browser.state.reservations.value = [{id:'r1',is_read:true}];
  const datasets = {
    apiGetBranches: ['new-branch'], apiGetReservations: [{id:'r1',is_read:false}],
    apiGetSlotMasters:['new-master'], apiGetSlotDefaults:['new-default'], apiGetSlotOverrides:['new-override'],
    apiGetMailTemplates:['new-template'], apiGetDuplicateGroups:['new-group'], apiGetBouncedEmails:['new-bounce'],
    apiGetUsers:['new-user'], apiGetActivityLogs:{rows:[{id:'new-log'}],targetTypes:['reservation']}
  };
  for (const [name,data] of Object.entries(datasets)) browser.responses[name] = {success:true,data};
  browser.calls.length = 0;
  browser.state.syncCountdown.value = 1;
  await browser.intervals.find(interval => interval.duration === 1000).callback();
  assert.deepEqual(browser.calls.map(call => call.name).sort(),Object.keys(datasets).sort());
  for (const [stateKey,api] of Object.entries({branches:'apiGetBranches',slotMasters:'apiGetSlotMasters',slotDefaults:'apiGetSlotDefaults',slotOverrides:'apiGetSlotOverrides',mailTemplates:'apiGetMailTemplates',duplicateGroupsData:'apiGetDuplicateGroups',users:'apiGetUsers'})) {
    assert.deepEqual([...browser.state[stateKey].value],datasets[api]);
  }
  assert.equal(browser.state.reservations.value[0].is_read,true);
  assert.equal(browser.state.activityLogs.value[0].id,'new-log');
  assert.deepEqual([...browser.state.activityTargetTypes.value],['reservation']);
  assert.equal(browser.state.isSyncing.value,false);
  assert.equal(browser.state.isLoading.value,false);
  assert.equal(browser.state.syncCountdown.value,60);
});

test('background sync skips open settings and preserves cached data on fetch failure', async () => {
  const browser = setupBrowserAuth();
  await browser.start();
  const tick = browser.intervals.find(interval => interval.duration === 1000).callback;
  browser.calls.length = 0;
  browser.state.syncCountdown.value = 1;
  browser.state.modalState.system = true;
  await tick();
  assert.equal(browser.calls.length,0);
  assert.equal(browser.state.syncCountdown.value,1);
  browser.state.modalState.system = false;
  browser.state.branches.value = ['cached-branch'];
  browser.state.activityLogs.value = [{id:'cached-log'}];
  browser.responses.apiGetMailTemplates = new Error('network failure');
  await tick();
  assert.deepEqual([...browser.state.branches.value],['cached-branch']);
  assert.equal(browser.state.activityLogs.value[0].id,'cached-log');
  assert.equal(browser.state.isSyncing.value,false);
});

test('manager background sync omits administrator users and logs', async () => {
  const browser = setupBrowserAuth();
  browser.responses.apiCheckSession.data.role = 'manager';
  await browser.start();
  browser.calls.length = 0;
  browser.state.syncCountdown.value = 1;
  await browser.intervals.find(interval => interval.duration === 1000).callback();
  assert.equal(browser.calls.length,8);
  assert.equal(browser.calls.some(call => ['apiGetUsers','apiGetActivityLogs'].includes(call.name)),false);
});


function deferredResponse() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise,resolve};
}

test('settings and log memory update before acknowledgement and reconcile generated IDs', async () => {
  const browser = setupBrowserAuth();
  await browser.start();
  const deferred = deferredResponse();
  browser.responses.apiSaveSystemSettings = deferred.promise;
  const pending = browser.state.runGoogleScript('apiSaveSystemSettings','mail_template',{template_name:'새 안내',body_html:'내용'});
  assert.equal(browser.state.mailTemplates.value[0].template_name,'새 안내');
  const provisional = browser.state.activityLogs.value[0];
  assert.equal(provisional.action,'메일 템플릿 생성');
  assert.equal(provisional.status,'처리 중');
  deferred.resolve({success:true,data:{id:'template-created'},activityLog:{id:'server-log',target_type:'mail_template',target_id:'template-created',status:'완료'}});
  await pending;
  assert.equal(browser.state.mailTemplates.value[0].id,'template-created');
  assert.equal(browser.state.mailTemplates.value[0]._optimisticRequestId,undefined);
  assert.equal(browser.state.activityLogs.value.length,1);
  assert.equal(browser.state.activityLogs.value[0].id,'server-log');
  assert.equal(browser.state.activityLogs.value[0].status,'완료');
});

test('failed settings save restores the prior row and replaces the pending log with a failure', async () => {
  const browser = setupBrowserAuth();
  await browser.start();
  browser.state.branches.value = [{id:'b1',branch_name_ko:'기존 지점'}];
  const deferred = deferredResponse();
  browser.responses.apiSaveSystemSettings = deferred.promise;
  const pending = browser.state.runGoogleScript('apiSaveSystemSettings','branch',{id:'b1',branch_name_ko:'수정 지점'});
  assert.equal(browser.state.branches.value[0].branch_name_ko,'수정 지점');
  assert.equal(browser.state.activityLogs.value[0].status,'처리 중');
  deferred.resolve({success:false,message:'저장 실패',activityLog:{id:'failed-log',target_type:'branch',status:'실패'}});
  await assert.rejects(pending,/저장 실패/);
  assert.equal(browser.state.branches.value[0].branch_name_ko,'기존 지점');
  assert.equal(browser.state.activityLogs.value.length,1);
  assert.equal(browser.state.activityLogs.value[0].status,'실패');
});

test('failed optimistic template deletion restores the row and removes the provisional log on network failure', async () => {
  const browser = setupBrowserAuth();
  await browser.start();
  browser.state.mailTemplates.value = [{id:'t1',template_name:'기존 안내'}];
  const deferred = deferredResponse();
  browser.responses.apiDeleteSystemData = deferred.promise;
  const pending = browser.state.runGoogleScript('apiDeleteSystemData','mail_template','t1');
  assert.equal(browser.state.mailTemplates.value.length,0);
  assert.equal(browser.state.activityLogs.value[0].status,'처리 중');
  deferred.resolve(null);
  await assert.rejects(pending,/서버 응답/);
  assert.equal(browser.state.mailTemplates.value[0].id,'t1');
  assert.equal(browser.state.activityLogs.value.length,0);
});

test('in-flight periodic sync discards stale settings and logs after a mutation', async () => {
  const browser = setupBrowserAuth();
  await browser.start();
  browser.state.branches.value = [{id:'b1',branch_name_ko:'기존 지점'}];
  const deferred = deferredResponse();
  browser.responses.apiGetBranches = deferred.promise;
  browser.state.syncCountdown.value = 1;
  const tick = browser.intervals.find(interval => interval.duration === 1000).callback;
  const sync = tick();
  browser.responses.apiSaveSystemSettings = {success:true,activityLog:{id:'new-log',target_type:'branch',status:'완료'}};
  await browser.state.runGoogleScript('apiSaveSystemSettings','branch',{id:'b1',branch_name_ko:'수정 지점'});
  deferred.resolve({success:true,data:[{id:'b1',branch_name_ko:'오래된 지점'}]});
  await sync;
  assert.equal(browser.state.branches.value[0].branch_name_ko,'수정 지점');
  assert.equal(browser.state.activityLogs.value[0].id,'new-log');
  assert.equal(browser.state.isSyncing.value,false);
});


test('user settings optimistic update includes permissions and rollback on failure', async () => {
  const browser = setupBrowserAuth();
  await browser.start();
  browser.state.users.value = [{id:'u1',user_name:'기존 사용자',branch_ids:['b1'],enabled:true}];
  browser.state.activeSystemData.value = {type:'user',mode:'edit'};
  browser.state.localData.value = {id:'u1',user_name:'수정 사용자',enabled:false};
  browser.state.modalState.system = true;
  browser.state.userBranchIds.value = ['b2'];
  const deferred = deferredResponse();
  browser.responses.apiSaveSystemSettings = deferred.promise;
  const saving = browser.state.handleSystemSave();
  assert.equal(browser.state.users.value[0].user_name,'수정 사용자');
  assert.equal(browser.state.modalState.system,false);
  assert.equal(browser.state.isModalLoading.value,false);
  assert.deepEqual([...browser.state.users.value[0].branch_ids],['b2']);
  assert.equal(browser.state.users.value[0].enabled,false);
  assert.equal(browser.state.activityLogs.value[0].status,'처리 중');
  deferred.resolve({success:false,message:'저장 실패'});
  await saving;
  assert.equal(browser.state.users.value[0].user_name,'기존 사용자');
  assert.deepEqual([...browser.state.users.value[0].branch_ids],['b1']);
  assert.equal(browser.state.users.value[0].enabled,true);
  assert.equal(browser.state.activityLogs.value.length,0);
});

test('slot settings and activity log update immediately and rollback together', async () => {
  const browser = setupBrowserAuth();
  await browser.start();
  browser.state.slotDefaults.value = [{branch_id:'b1',slot_master_id:'s1',slot:5,enabled:true}];
  browser.state.activeSystemData.value = {type:'slot',mode:'batch',batchType:'default',data:{branch_id:'b1'}};
  browser.state.slotBatchPayload.masterSlots = [{id:'s1',slot:2,enabled:false}];
  const deferred = deferredResponse();
  browser.responses.apiSaveSystemSettings = deferred.promise;
  await browser.state.handleSystemSave();
  assert.equal(browser.state.slotDefaults.value[0].slot,2);
  assert.equal(browser.state.slotDefaults.value[0].enabled,false);
  assert.equal(browser.state.activityLogs.value[0].status,'처리 중');
  deferred.resolve({success:false,message:'저장 실패'});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(browser.state.slotDefaults.value[0].slot,5);
  assert.equal(browser.state.slotDefaults.value[0].enabled,true);
  assert.equal(browser.state.activityLogs.value.length,0);
});


test('activity UI resolves IDs to names while stored JSON and target ID stay unchanged', async () => {
  const browser = setupBrowserAuth();
  await browser.start();
  browser.state.branches.value = [{id:'b1',branch_name_ko:'명동점'},{id:'b2',branch_name_ko:'종로점'}];
  browser.state.users.value = [{id:'u1',user_name:'김매니저'}];
  browser.state.mailTemplates.value = [{id:'t1',template_name:'예약 안내'}];
  browser.state.reservations.value = [{id:'r1',customer_name:'홍길동',email_thread_id:'thread1'}];
  browser.state.slotMasters.value = [{id:'s1',time:'2026-10-14T09:00:00Z'}];
  browser.state.duplicateGroupsData.value = [{group_id:'20261014_01',reservation_ids:'r1'}];
  const log = {id:'log1',timestamp:'2026-10-14T00:00:00Z',status:'완료',target_type:'reservation',target_id:'r1',target:'홍길동',
    details:JSON.stringify({changes:[{field:'지점',before:'b1',after:'b2'},{field:'role',before:'manager',after:'admin'},{field:'notes',before:'b1',after:'b2'}]})};
  const original = log.details;
  const changes = browser.state.activityChanges(log);
  assert.equal(changes[0].before,'명동점');
  assert.equal(changes[0].after,'종로점');
  assert.equal(changes[1].field,'권한');
  assert.equal(changes[1].before,'매니저');
  assert.equal(changes[1].after,'관리자');
  assert.equal(changes[2].before,'b1'); // 자유 입력값은 식별자로 추측하지 않는다.
  assert.equal(log.details,original);
  assert.equal(log.target_id,'r1');
  for (const [type,id,name] of [['branch','b1','명동점'],['user','u1','김매니저'],['mail_template','t1','예약 안내'],['mail_thread','thread1','홍길동 메일'],['duplicate_group','20261014_01','홍길동 중복 예약']]) {
    assert.equal(browser.state.activityTarget({target_type:type,target_id:id,target:id}),name);
  }
  assert.equal(browser.state.activityTarget({target_type:'mail_template',target_id:'deleted',target:'deleted (기존 템플릿)'}),'기존 템플릿');
  assert.equal(browser.state.activityTarget({target_type:'branch',target_id:'deleted',target:'deleted'}),'지점 정보 없음');
  assert.equal(browser.state.activityDetails({details:'2026-10-14, 슬롯 ID s1 (18:00), 슬롯 3'}),'2026-10-14, 슬롯 시간 18:00, 슬롯 3');
  assert.equal(browser.state.activityDetails({details:'슬롯 ID s1'}),'슬롯 시간 18:00');
  browser.state.activityLogs.value = [log];
  browser.state.activityDateStart.value = '2026-10-14';
  browser.state.activityDateEnd.value = '2026-10-14';
  browser.state.activitySearch.value = '종로점';
  assert.equal(browser.state.filteredActivityLogs.value.length,1);
});


test('activity tab navigation uses cached logs and GNB manual refresh fetches all datasets', async () => {
  const browser = setupBrowserAuth();
  await browser.start();
  browser.state.activityLogs.value = [{id:'cached-log'}];
  browser.calls.length = 0;
  browser.state.setCurrentView('activity');
  browser.state.setCurrentView('list');
  browser.state.setCurrentViewAndCloseMenu('activity');
  assert.equal(browser.calls.length,0);
  assert.equal(browser.state.activityLogs.value[0].id,'cached-log');
  browser.responses.apiGetActivityLogs = {success:true,data:{rows:[{id:'refreshed-log'}],targetTypes:['reservation']}};
  await browser.state.handleManualRefresh();
  assert.equal(browser.calls.length,10);
  assert.equal(browser.state.activityLogs.value[0].id,'refreshed-log');
  assert.equal(browser.state.isSyncing.value,false);
  assert.doesNotMatch(fs.readFileSync('src/LayoutHeader.html','utf8'),/refreshActivityLogs/);
});


test('optimistic reservation log shows name and email before the server responds', async () => {
  const browser = setupBrowserAuth();
  await browser.start();
  browser.state.reservations.value = [{id:'r1',customer_name:'홍길동',email:'customer@example.com'}];
  const deferred = deferredResponse();
  browser.responses.apiUpdateReservationStatus = deferred.promise;
  const pending = browser.state.runGoogleScript('apiUpdateReservationStatus','r1','confirm');
  assert.equal(browser.state.activityLogs.value[0].target,'홍길동 (customer@example.com)');
  assert.equal(browser.state.activityTarget(browser.state.activityLogs.value[0]),'홍길동 (customer@example.com)');
  deferred.resolve({success:true});
  await pending;
});

test('new branch appears optimistically with a temporary ID, reconciles or rolls back', async () => {
  const browser = setupBrowserAuth();
  await browser.start();
  browser.state.activeSystemData.value = {type:'branch',mode:'create'};
  const branch = {branch_name_ko:'신규점',branch_name_en:'New Branch',calendar_id:'new-calendar',enabled:true};
  browser.state.localData.value = {...branch};
  const deferred = deferredResponse();
  browser.responses.apiSaveSystemSettings = deferred.promise;
  browser.responses.apiGetBranches = {success:true,data:[{...branch,id:'new-id'}]};
  browser.responses.apiGetActivityLogs = {success:true,data:{rows:[{id:'new-log',action:'지점 등록',target_type:'branch',target_id:'new-id'}],targetTypes:['branch']}};
  const saving = browser.state.handleSystemSave();
  assert.equal(browser.state.branches.value[0].branch_name_ko,'신규점');
  assert.match(browser.state.branches.value[0].id,/^optimistic-/);
  assert.equal(browser.state.activityLogs.value[0].action,'지점 등록');
  deferred.resolve({success:true,data:{...branch,id:'new-id'},activityLog:{id:'new-log',action:'지점 등록',target_type:'branch',target_id:'new-id'}});
  await saving;
  assert.equal(browser.state.branches.value[0].id,'new-id');
  assert.equal(browser.state.branchMapKo.value['new-id'],'신규점');
  assert.equal(browser.state.activityLogs.value[0].id,'new-log');
  browser.state.activeSystemData.value = {type:'branch',mode:'create'};
  browser.state.localData.value = {...branch,branch_name_ko:'실패점',branch_name_en:'Other',calendar_id:'other-calendar'};
  const failed = deferredResponse();
  browser.responses.apiSaveSystemSettings = failed.promise;
  const failing = browser.state.handleSystemSave();
  assert.equal(browser.state.branches.value.length,2);
  failed.resolve({success:false,message:'등록 실패'});
  await failing;
  assert.equal(browser.state.branches.value.length,1);
  assert.equal(browser.state.branches.value[0].id,'new-id');
});


test('user save closes immediately and acknowledgement avoids full reload or closing a newer modal', async () => {
  const browser = setupBrowserAuth();
  await browser.start();
  browser.state.users.value = [{id:'u1',user_name:'기존 사용자',branch_ids:['b1'],enabled:true}];
  browser.state.activeSystemData.value = {type:'user',mode:'edit'};
  browser.state.modalState.system = true;
  browser.state.localData.value = {id:'u1',user_name:'수정 사용자',enabled:true};
  browser.state.userBranchIds.value = ['b2'];
  browser.calls.length = 0;
  const deferred = deferredResponse();
  browser.responses.apiSaveSystemSettings = deferred.promise;
  const saving = browser.state.handleSystemSave();
  assert.equal(browser.state.modalState.system,false);
  assert.equal(browser.state.isModalLoading.value,false);
  assert.equal(browser.state.isLoading.value,false);
  assert.equal(browser.state.users.value[0].user_name,'수정 사용자');
  browser.state.activeSystemData.value = {type:'user',mode:'edit',data:{id:'u2'}};
  browser.state.modalState.system = true;
  deferred.resolve({success:true});
  await saving;
  assert.deepEqual(browser.calls.map(call => call.name),['apiSaveSystemSettings','apiCheckSession']);
  assert.equal(browser.state.users.value[0].user_name,'수정 사용자');
  assert.equal(browser.state.modalState.system,true);
  assert.equal(browser.state.activeSystemData.value.data.id,'u2');
});

test('manual and automatic duplicate groups share full and individual exclusion with rollback', async t => {
  for (const groupType of ['manual','auto']) {
    for (const individual of [false,true]) {
      await t.test(groupType + (individual ? ' individual' : ' full'), async () => {
        const browser = setupBrowserAuth();
        await browser.start();
        const reservations = ['r1','r2','r3'].map(id => ({id,customer_name:'홍길동',email:'same@example.com',status:'pending',reservation_date:'2026-10-20T09:00:00Z'}));
        browser.state.reservations.value = reservations;
        const group = {id:'g1',group_id:'g1',group_type:groupType,status:'active',reservation_ids:['r1','r2','r3'],parsed_ids:['r1','r2','r3']};
        browser.state.duplicateGroupsData.value = [group];
        const displayed = browser.state.duplicateGroups.value[0];
        assert.equal(displayed.reservations.length,3);
        const deferred = deferredResponse();
        const api = individual ? 'apiExcludeReservationFromGroup' : 'apiClearDuplicateGroup';
        browser.responses[api] = deferred.promise;
        const pending = individual ? browser.state.excludeSingleReservationFromGroup(reservations[2],displayed) : browser.state.clearDuplicateGroup(displayed);
        browser.state.handleAlertResult(true);
        await Promise.resolve();
        if (individual) {
          assert.deepEqual([...browser.state.duplicateGroups.value[0].reservations].map(res => res.id),['r1','r2']);
          assert.equal(browser.state.duplicateGroupsData.value.find(row => row.id === 'cleared_r3').status,'cleared');
        } else {
          assert.equal(browser.state.duplicateGroups.value.length,0);
          assert.equal(browser.state.duplicateGroupsData.value[0].status,'cleared');
        }
        assert.equal(browser.state.activityLogs.value.at(-1).action,individual ? '중복 해제' : '중복 일괄 해제');
        deferred.resolve({success:false,message:'제외 실패'});
        await pending;
        assert.equal(browser.state.duplicateGroups.value[0].reservations.length,3);
        assert.equal(browser.state.duplicateGroupsData.value.length,1);
        assert.equal(browser.state.duplicateGroupsData.value[0].group_type,groupType);
      });
    }
  }
});

test('read marking and email correction update immediately and restore values on RPC failure', async () => {
  const browser = setupBrowserAuth();
  await browser.start();
  const reservation = {id:'r1',customer_name:'홍길동',email:'old@example.com',email_thread_id:'old-thread',is_read:false};
  browser.state.reservations.value = [reservation];
  const read = deferredResponse();
  browser.responses.apiMarkReservationAsRead = read.promise;
  browser.state.markAsReadOnClick(reservation);
  assert.equal(reservation.is_read,true);
  assert.equal(JSON.parse(browser.state.activityLogs.value[0].details).changes[0].key,'is_read');
  read.resolve({success:false,message:'읽음 저장 실패'});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reservation.is_read,false);
  browser.state.bouncedEmailsData.value = [{threadId:'old-thread',recipientEmail:'old@example.com'},{recipientEmail:'another@example.com'}];
  const correcting = deferredResponse();
  browser.responses.apiCorrectEmailAndInitializeThread = correcting.promise;
  const pending = browser.state.runGoogleScript('apiCorrectEmailAndInitializeThread',{reservationId:'r1',newEmail:'new@example.com'});
  assert.equal(reservation.email,'new@example.com');
  assert.equal(reservation.mail_pending,true);
  assert.equal(browser.state.bouncedEmailsData.value.length,1);
  assert.equal(JSON.parse(browser.state.activityLogs.value.at(-1).details).changes[0].before,'old@example.com');
  correcting.resolve({success:false,message:'발송 실패'});
  await assert.rejects(pending,/발송 실패/);
  assert.equal(reservation.email,'old@example.com');
  assert.equal(reservation.email_thread_id,'old-thread');
  assert.equal(reservation.mail_pending,undefined);
  assert.equal(browser.state.bouncedEmailsData.value.length,2);
});

test('manual group creation is visible before acknowledgement and removes only its provisional group on failure', async () => {
  const browser = setupBrowserAuth();
  await browser.start();
  browser.state.reservations.value = ['r1','r2'].map(id => ({id,customer_name:'홍길동',email:'same@example.com',status:'pending',reservation_date:'2026-10-20T09:00:00Z'}));
  const deferred = deferredResponse();
  browser.responses.apiCreateManualDuplicateGroup = deferred.promise;
  const pending = browser.state.runGoogleScript('apiCreateManualDuplicateGroup',{reservationIds:['r1','r2']});
  assert.equal(browser.state.duplicateGroups.value[0].group_type,'manual');
  assert.equal(browser.state.duplicateGroups.value[0].reservations.length,2);
  assert.equal(browser.state.activityEntries(browser.state.activityLogs.value[0])[0].value,'r1 - 홍길동 (same@example.com)');
  browser.state.duplicateGroupsData.value.push({id:'other',group_id:'other',status:'active',group_type:'manual',reservation_ids:['r1','r2']});
  deferred.resolve({success:false,message:'생성 실패'});
  await assert.rejects(pending,/생성 실패/);
  assert.equal(browser.state.duplicateGroupsData.value.length,1);
  assert.equal(browser.state.duplicateGroupsData.value[0].id,'other');
});

test('duplicate confirmation mail uses group target and rolls back optimistic sent time', async () => {
  const browser = setupBrowserAuth();
  await browser.start();
  browser.state.reservations.value = [{id:'r1',customer_name:'홍길동',email:'customer@example.com'}];
  const group = {id:'g1',group_id:'g1',mail_sent_at:'2026-10-01T00:00:00Z'};
  browser.state.duplicateGroupsData.value = [group];
  const deferred = deferredResponse();
  browser.responses.apiSendDuplicateConfirmationMail = deferred.promise;
  const pending = browser.state.runGoogleScript('apiSendDuplicateConfirmationMail',{groupId:'g1',targetReservationId:'r1',threadId:'thread1'});
  const log = browser.state.activityLogs.value[0];
  assert.equal(log.target_id,'g1');
  assert.equal(log.target_type,'duplicate_group');
  assert.equal(browser.state.activityEntries(log)[0].value,'r1 - 홍길동 (customer@example.com)');
  assert.notEqual(group.mail_sent_at,'2026-10-01T00:00:00Z');
  deferred.resolve({success:false,message:'발송 실패'});
  await assert.rejects(pending,/발송 실패/);
  assert.equal(group.mail_sent_at,'2026-10-01T00:00:00Z');
});

test('branch and mail-template saves close their modal before server acknowledgement', async () => {
  const browser = setupBrowserAuth();
  await browser.start();
  browser.state.activeSystemData.value = {type:'branch',mode:'edit'};
  browser.state.modalState.system = true;
  browser.state.branches.value = [{id:'b1',branch_name_ko:'명동',branch_name_en:'Myeongdong',calendar_id:'calendar'}];
  browser.state.localData.value = {...browser.state.branches.value[0],branch_name_ko:'새 지점명'};
  const branch = deferredResponse();
  browser.responses.apiSaveSystemSettings = branch.promise;
  const saving = browser.state.handleSystemSave();
  assert.equal(browser.state.modalState.system,false);
  assert.equal(browser.state.branches.value[0].branch_name_ko,'새 지점명');
  assert.equal(browser.state.isModalLoading.value,false);
  branch.resolve({success:false,message:'저장 실패'});
  await saving;
  assert.equal(browser.state.branches.value[0].branch_name_ko,'명동');
  browser.state.activeSystemData.value = {type:'mail',mode:'edit'};
  browser.state.modalState.mail = true;
  browser.state.mailTemplates.value = [{id:'t1',template_name:'안내',body_html:'기존 본문'}];
  browser.state.localMailData.value = {id:'t1',template_name:'안내',body_html:'새 본문'};
  const template = deferredResponse();
  browser.responses.apiSaveSystemSettings = template.promise;
  const editing = browser.state.handleMailSave();
  assert.equal(browser.state.modalState.mail,false);
  assert.equal(browser.state.mailTemplates.value[0].body_html,'새 본문');
  template.resolve({success:false,message:'저장 실패'});
  await editing;
  assert.equal(browser.state.mailTemplates.value[0].body_html,'기존 본문');
});

test('session envelope carries the client IP into the actor and still validates the token', () => {
  const env = setup();
  const begin = vm.runInContext('UserService.beginGoogleLogin(ScriptApp.getService().getUrl())', env.context);
  env.context.state = begin.state;
  const session = vm.runInContext('UserService.completeGoogleLogin("code", state, ScriptApp.getService().getUrl())', env.context);
  env.context.envelope = { token: session.token, ip: '198.51.100.9' };
  const checked = vm.runInContext('UserService.checkSession(envelope)', env.context);
  assert.equal(checked.success, true);
  assert.equal(checked.data.client_ip, '198.51.100.9');
  assert.equal(vm.runInContext('UserService.checkSession(envelope.token).data.client_ip', env.context), '');
  assert.equal(vm.runInContext('apiGetBranches(envelope).success', env.context), true);
  assert.equal(vm.runInContext('UserService.checkSession({token:"not-a-token", ip:"1.1.1.1"}).success', env.context), false);
  assert.equal(vm.runInContext('UserService.checkSession({ip:"1.1.1.1"}).success', env.context), false);
  vm.runInContext('apiLogout(envelope)', env.context);
  assert.equal(vm.runInContext('apiGetBranches(envelope).success', env.context), false);
});

test('browser attaches the fetched IP to later calls and refreshes it on the 60-second sync', async () => {
  const browser = setupBrowserAuth({ clientIp: '203.0.113.7' });
  await browser.start();
  assert.deepEqual({ ...browser.calls.find(call => call.name === 'apiCheckSession').args[0] }, { token: browser.savedToken, ip: '' });
  assert.deepEqual({ ...browser.calls.find(call => call.name === 'apiGetBranches').args[0] }, { token: browser.savedToken, ip: '203.0.113.7' });
  assert.equal(browser.ipLookups.length, 1);
  browser.state.syncCountdown.value = 1;
  await browser.intervals.find(interval => interval.duration === 1000).callback();
  assert.equal(browser.ipLookups.length, 2);
  browser.state.activeSystemData.value = { type: 'user', mode: 'edit' };
  browser.state.localData.value = { id: 'user-1', user_name: '김사용자' };
  browser.state.currentUser.value.user_email = 'admin@example.com';
  browser.responses.apiSaveSystemSettings = new Promise(() => {});
  browser.state.handleSystemSave();
  assert.equal(browser.state.activityLogs.value.find(log => log._optimistic).ip, '203.0.113.7');
});

test('browser without fetch support sends an empty IP without errors', async () => {
  const browser = setupBrowserAuth();
  await browser.start();
  assert.deepEqual({ ...browser.calls.find(call => call.name === 'apiGetBranches').args[0] }, { token: browser.savedToken, ip: '' });
});

test('failed IP lookup keeps the request going with an empty IP and no error', async () => {
  const browser = setupBrowserAuth({ clientIp: new Error('blocked by client') });
  await browser.start();
  assert.deepEqual({ ...browser.calls.find(call => call.name === 'apiGetBranches').args[0] }, { token: browser.savedToken, ip: '' });
  assert.equal(browser.state.appState.value, 'authorized');
  assert.deepEqual(browser.errors, []);
});
