/** Google OAuth 로그인과 서버 세션. Execute as Me 환경에서 UserProperties는 사용자별 저장소가 아니다. */
const UserService = {
  SESSION_SECONDS: 7 * 24 * 60 * 60,
  CACHE_SECONDS: 21600,
  STATE_SECONDS: 600,

  randomToken() {
    return Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  },

  sessionKey(token) {
    const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token);
    return 'WANG_RMS_AUTH_' + Utilities.base64EncodeWebSafe(digest).replace(/=+$/, '');
  },

  pruneExpiredSessions(properties) {
    const now = Date.now();
    const all = properties.getProperties();
    Object.keys(all).forEach(key => {
      if (!key.startsWith('WANG_RMS_AUTH_')) return;
      try {
        if (JSON.parse(all[key]).expiresAt > now) return;
      } catch (_) {}
      properties.deleteProperty(key);
    });
  },

  beginGoogleLogin(redirectUri) {
    const clientId = Config.GOOGLE_CLIENT_ID;
    if (!PropertiesService.getScriptProperties().getProperty('GOOGLE_OAUTH_CLIENT_SECRET')) {
      throw new Error('Script Properties에 GOOGLE_OAUTH_CLIENT_SECRET을 설정해 주세요.');
    }
    if (!clientId || !redirectUri || !/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(redirectUri)) {
      throw new Error('Google 로그인 설정을 확인해 주세요.');
    }
    const state = this.randomToken();
    CacheService.getScriptCache().put('oauth_state_' + state, '1', this.STATE_SECONDS);
    const params = {
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state: state,
      prompt: 'select_account'
    };
    const query = Object.keys(params).map(key => encodeURIComponent(key) + '=' + encodeURIComponent(params[key])).join('&');
    return { url: 'https://accounts.google.com/o/oauth2/v2/auth?' + query, state: state };
  },

  completeGoogleLogin(code, state, redirectUri) {
    if (!code || !state || !/^[a-f0-9]{64}$/.test(state)) throw new Error('잘못된 로그인 응답입니다.');
    const cache = CacheService.getScriptCache();
    const stateKey = 'oauth_state_' + state;
    if (cache.get(stateKey) !== '1') throw new Error('로그인 요청이 만료되었거나 유효하지 않습니다. 다시 시도해 주세요.');
    cache.remove(stateKey);
    const secret = PropertiesService.getScriptProperties().getProperty('GOOGLE_OAUTH_CLIENT_SECRET');
    if (!secret) throw new Error('Google OAuth client secret이 Script Properties에 설정되지 않았습니다.');
    const response = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
      method: 'post',
      payload: {
        code: code,
        client_id: Config.GOOGLE_CLIENT_ID,
        client_secret: secret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      },
      muteHttpExceptions: true
    });
    if (response.getResponseCode() !== 200) {
      console.warn('[OAuth] token exchange failed: ' + response.getResponseCode());
      throw new Error('Google 인증 코드 검증에 실패했습니다. OAuth 설정을 확인해 주세요.');
    }
    const tokens = JSON.parse(response.getContentText());
    if (!tokens.access_token) throw new Error('Google 인증 토큰이 없습니다.');
    const profileResponse = UrlFetchApp.fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: 'Bearer ' + tokens.access_token },
      muteHttpExceptions: true
    });
    if (profileResponse.getResponseCode() !== 200) throw new Error('Google 계정 확인에 실패했습니다.');
    const profile = JSON.parse(profileResponse.getContentText());
    if (!profile.email || profile.email_verified !== true) throw new Error('인증된 Google 이메일을 확인할 수 없습니다.');
    const user = this.findEnabledUser(profile.email);
    const sessionToken = this.randomToken();
    const sessionKey = this.sessionKey(sessionToken);
    const record = JSON.stringify({ email: String(user.user_email), expiresAt: Date.now() + this.SESSION_SECONDS * 1000 });
    const properties = PropertiesService.getScriptProperties();
    this.pruneExpiredSessions(properties);
    properties.setProperty(sessionKey, record);
    cache.put(sessionKey, record, this.CACHE_SECONDS);
    return { token: sessionToken, state: state };
  },

  findEnabledUser(email) {
    const users = Util.getSheetDataAsObjects(Config.SHEET_NAMES.USER);
    const user = users.find(u => String(u.user_email).toLowerCase() === String(email).toLowerCase());
    if (!user) throw new Error('등록되지 않은 Google 계정입니다: ' + email);
    if (user.enabled !== true) throw new Error('비활성화된 계정입니다. 관리자에게 문의하세요.');
    return user;
  },

  checkSession(token) {
    try {
      if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) {
        return Util.createResponse(false, { needLogin: true }, '로그인이 필요합니다.');
      }
      const cache = CacheService.getScriptCache();
      const properties = PropertiesService.getScriptProperties();
      const key = this.sessionKey(token);
      const cached = cache.get(key);
      const saved = cached || properties.getProperty(key);
      if (!saved) return Util.createResponse(false, { needLogin: true }, '로그인 세션이 만료되었습니다.');
      let record;
      try { record = JSON.parse(saved); } catch (_) { record = null; }
      if (!record || !record.email || !record.expiresAt || record.expiresAt <= Date.now()) {
        cache.remove(key);
        properties.deleteProperty(key);
        return Util.createResponse(false, { needLogin: true }, '로그인 세션이 만료되었습니다.');
      }
      if (!cached) {
        const remaining = Math.ceil((record.expiresAt - Date.now()) / 1000);
        cache.put(key, saved, Math.max(1, Math.min(this.CACHE_SECONDS, remaining)));
      }
      const user = this.findEnabledUser(record.email);
      const allowedBranchIds = user.role === Config.USER_ROLES.ADMIN ? ['all'] : this.fetchUserPermissions(user.id);
      return Util.createResponse(true, {
        id: user.id,
        user_email: user.user_email,
        user_name: user.user_name,
        role: user.role,
        allowedBranchIds: allowedBranchIds
      });
    } catch (e) {
      return Util.createResponse(false, { needLogin: true }, e.message);
    }
  },

  logout(token) {
    if (typeof token === 'string' && /^[a-f0-9]{64}$/.test(token)) {
      const key = this.sessionKey(token);
      CacheService.getScriptCache().remove(key);
      PropertiesService.getScriptProperties().deleteProperty(key);
    }
    return Util.createResponse(true, null, '로그아웃 되었습니다.');
  },

  /**
   * 특정 유저의 접근 허용 지점 ID 목록 조회
   */
  fetchUserPermissions(userId) {
    const perms = Util.getSheetDataAsObjects(Config.SHEET_NAMES.USER_PERMISSION);
    return perms
      .filter(p => p.user_id === userId && p.enabled === true)
      .map(p => p.branch_id);
  },

  /**
   * [Admin] 전체 사용자 목록 조회
   */
  getAllUsers() {
    const users = Util.getSheetDataAsObjects(Config.SHEET_NAMES.USER);
    const permissions = Util.getSheetDataAsObjects(Config.SHEET_NAMES.USER_PERMISSION);
    return users.map(user => ({
      ...user,
      branch_ids: permissions
        .filter(permission => permission.user_id === user.id && permission.enabled === true)
        .map(permission => permission.branch_id)
    }));
  },

  /**
   * [Admin] 사용자 생성
   */
  createUser(userData) {
    try {
      const sheet = Util.getSpreadsheet().getSheetByName(Config.SHEET_NAMES.USER);
      const users = Util.getSheetDataAsObjects(Config.SHEET_NAMES.USER);
      
      // 이메일 중복 체크
      if (users.some(u => String(u.user_email).toLowerCase() === String(userData.user_email).toLowerCase())) {
        return Util.createResponse(false, null, '이미 등록된 이메일입니다.');
      }

      const newUuid = Util.getUuid();
      const now = new Date();

      // 저장할 객체 구성
      const newUserObj = {
        id: newUuid,
        user_email: userData.user_email,
        user_name: userData.user_name,
        role: userData.role || Config.USER_ROLES.VIEWER,
        enabled: userData.enabled === undefined ? true : userData.enabled,
        created_at: now,
        updated_at: now
      };

      // 시트 헤더에 맞춰 배열로 변환
      const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
      const newRow = Util.convertObjectToRow(newUserObj, headers);
      
      sheet.appendRow(newRow);

      // 지점 권한 설정 (Admin이 아닌 경우)
      if (userData.role !== Config.USER_ROLES.ADMIN && userData.branch_ids) {
        this.updatePermissions(newUuid, userData.branch_ids);
      }

      return Util.createResponse(true, { ...newUserObj, created_at: now.toISOString(), updated_at: now.toISOString() });

    } catch (e) {
      return Util.createResponse(false, null, e.message);
    }
  },

  /**
   * [Admin] 사용자 수정
   */
  updateUser(id, userData) {
    try {
      const sheet = Util.getSpreadsheet().getSheetByName(Config.SHEET_NAMES.USER);
      const data = sheet.getDataRange().getValues();
      const headers = data[0];
      const idIndex = headers.indexOf('id');

      if (idIndex === -1) return Util.createResponse(false, null, 'ID 컬럼을 찾을 수 없습니다.');

      for (let i = 1; i < data.length; i++) {
        if (data[i][idIndex] === id) {
          // 업데이트할 행 찾음
          const row = data[i];
          
          // 필드별 업데이트 (헤더 인덱스 매핑)
          const updateField = (key, val) => {
            const idx = headers.indexOf(key);
            if (idx > -1 && val !== undefined) row[idx] = val;
          };

          updateField('user_email', userData.user_email);
          updateField('user_name', userData.user_name);
          updateField('role', userData.role);
          updateField('enabled', userData.enabled);
          updateField('updated_at', new Date());

          // 시트에 반영
          sheet.getRange(i + 1, 1, 1, row.length).setValues([row]);

          // 권한 업데이트
          if (userData.branch_ids) {
            this.updatePermissions(id, userData.branch_ids);
          }

          return Util.createResponse(true);
        }
      }
      return Util.createResponse(false, null, '사용자를 찾을 수 없습니다.');

    } catch (e) {
      return Util.createResponse(false, null, e.message);
    }
  },

  /**
   * [Admin] 사용자 삭제
   */
  deleteUser(id) {
    try {
      const sheet = Util.getSpreadsheet().getSheetByName(Config.SHEET_NAMES.USER);
      const data = sheet.getDataRange().getValues();
      const headers = data[0];
      const idIdx = headers.indexOf('id');
      const enabledIdx = headers.indexOf('enabled'); // Assuming 'enabled' column exists

      if (idIdx === -1 || enabledIdx === -1) {
          return Util.createResponse(false, null, 'Required columns not found');
      }

      for (let i = 1; i < data.length; i++) {
        if (data[i][idIdx] === id) {
          // Soft Delete: enabled = false
          sheet.getRange(i + 1, enabledIdx + 1).setValue(false);
          return Util.createResponse(true);
        }
      }
      return Util.createResponse(false, null, 'User not found');
    } catch(e) {
      return Util.createResponse(false, null, e.message);
    }
  },

  /**
   * (Internal) 사용자 지점 권한 갱신 (기존 삭제 후 재생성)
   */
  updatePermissions(userId, branchIds) {
    const sheet = Util.getSpreadsheet().getSheetByName(Config.SHEET_NAMES.USER_PERMISSION);
    const data = sheet.getDataRange().getValues();
    
    // 헤더만 있거나 데이터가 없는 경우 바로 추가
    if (data.length <= 1) {
       this.appendNewPermissions(userId, branchIds);
       return;
    }

    const headers = data[0];
    const userIdIdx = headers.indexOf('user_id');
    
    // 해당 유저가 '아닌' 데이터만 남김 (In-Memory Filtering)
    // 주의: 데이터가 많아지면 비효율적일 수 있으나, 권한 테이블은 작으므로 허용
    const rowsToKeep = data.slice(1).filter(row => row[userIdIdx] !== userId);

    // 시트 초기화 (헤더 제외)
    if (sheet.getLastRow() > 1) {
        sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).clearContent();
    }
    
    // 보존된 행들 다시 쓰기
    if (rowsToKeep.length > 0) {
      sheet.getRange(2, 1, rowsToKeep.length, rowsToKeep[0].length).setValues(rowsToKeep);
    }

    // 새 권한 추가
    this.appendNewPermissions(userId, branchIds);
  },

  appendNewPermissions(userId, branchIds) {
    if (!branchIds || branchIds.length === 0) return;
    
    const sheet = Util.getSpreadsheet().getSheetByName(Config.SHEET_NAMES.USER_PERMISSION);
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const now = new Date();
    
    const newRows = branchIds.map(bid => {
      const obj = {
        id: Util.getUuid(),
        user_id: userId,
        branch_id: bid,
        enabled: true,
        created_at: now,
        updated_at: now
      };
      return Util.convertObjectToRow(obj, headers);
    });
    
    sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, headers.length).setValues(newRows);
  }
};
