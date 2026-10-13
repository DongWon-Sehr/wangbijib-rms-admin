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

function setupBrowserAuth({ callback = null, oauthState = null } = {}) {
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
    alert: message => errors.push(message),
    setInterval: () => 1,
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
              queueMicrotask(() => response instanceof Error ? failure(response) : success(response));
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
    state, savedToken, localValues, sessionValues, calls, responses, errors,
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
      assert.equal(browser.calls.find(call => call.name === 'apiCheckSession').args[0], browser.savedToken);
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
  assert.equal(browser.calls.find(call => call.name === 'apiCheckSession').args[0], token);
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
  assert.equal(browser.calls.find(call => call.name === 'apiLogout').args[0], browser.savedToken);
});
