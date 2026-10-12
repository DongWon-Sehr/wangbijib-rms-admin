const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');

function setup() {
  const entries = new Map();
  let secret = 'test-secret';
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
    Utilities: { getUuid: () => crypto.randomUUID() },
    CacheService: { getScriptCache: () => ({
      put: (key, value) => entries.set(key, value),
      get: key => entries.get(key),
      remove: key => entries.delete(key)
    }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => secret }) },
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
  return { context, entries, calls, users, setSecret: x => { secret = x; }, setProfileEmail: x => { profileEmail = x; } };
}

test('anonymous and email-shaped values cannot read protected API', () => {
  const { context } = setup();
  assert.equal(vm.runInContext('apiGetBranches()', context).success, false);
  assert.equal(vm.runInContext('apiGetBranches("admin@example.com")', context).success, false);
  assert.equal(vm.runInContext('apiUpdateReservation("admin@example.com", {id:"x"})', context).success, false);
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

test('all public data API entry points check the session', () => {
  const source = fs.readFileSync('src/WebApi.js', 'utf8');
  const matches = [...source.matchAll(/function (api\w+)\([^)]*\) \{([\s\S]*?)(?=\nfunction |$)/g)];
  for (const [, name, body] of matches) {
    if (['apiBeginGoogleLogin', 'apiCheckSession', 'apiLogout'].includes(name)) continue;
    assert.match(body.slice(0, 120), /UserService\.checkSession\(token\)/, name);
  }
});
