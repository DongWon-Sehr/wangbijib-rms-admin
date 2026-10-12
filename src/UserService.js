/**
 * [UserService] 사용자 인증 및 권한 관리 (Singleton)
 * - v1.4: 비밀번호 인증 제거 -> 구글 세션 인증으로 변경
 */
const UserService = {
  /**
   * [Auth] 현재 접속한 구글 계정의 세션 유효성 검사
   * - Session.getActiveUser().getEmail() 사용
   * - user 시트에 등록된 이메일인지 확인
   * - enabled 상태 확인
   */
  checkSession(clientEmail) {
    try {
      // 1순위: Session.getActiveUser().getEmail() (소유자 계정 및 동일 Workspace 도메인 자동 감지)
      let email = Session.getActiveUser().getEmail();

      // 2순위: UserProperties에 저장된 로그인 세션 확인
      if (!email) {
        try {
          email = PropertiesService.getUserProperties().getProperty('LOGIN_EMAIL');
        } catch (propErr) {
          console.warn('[UserService] UserProperties 조회 실패:', propErr.message);
        }
      }

      // 3순위: 클라이언트 로컬스토리지 보조 세션 이메일
      if (!email && clientEmail && typeof clientEmail === 'string') {
        email = clientEmail.trim();
      }

      if (!email) {
        return Util.createResponse(false, { needLogin: true }, '로그인이 필요합니다.');
      }

      // 모든 사용자 로드 (ORM 방식)
      const users = Util.getSheetDataAsObjects(Config.SHEET_NAMES.USER);
      
      // 이메일 대소문자 무시 비교
      const user = users.find(u => String(u.user_email).toLowerCase() === email.toLowerCase());

      if (!user) {
        // 등록되지 않은 사용자 -> 세션 삭제 후 안내
        try { PropertiesService.getUserProperties().deleteProperty('LOGIN_EMAIL'); } catch (_) {}
        return Util.createResponse(false, { email: email, notRegistered: true }, `등록되지 않은 사용자입니다. (${email})`);
      }

      if (!user.enabled) {
        return Util.createResponse(false, { email: email, disabled: true }, '비활성화된 계정입니다. 관리자에게 문의하세요.');
      }

      // 세션 유지 보장
      try {
        PropertiesService.getUserProperties().setProperty('LOGIN_EMAIL', user.user_email);
      } catch (_) {}

      // 권한 조회
      let allowedBranchIds = [];
      if (user.role === Config.USER_ROLES.ADMIN) {
        allowedBranchIds = ['all']; // Admin은 프리패스
      } else {
        allowedBranchIds = this.fetchUserPermissions(user.id);
      }

      // 클라이언트에 내려줄 사용자 정보
      const userInfo = {
        id: user.id,
        user_email: user.user_email,
        user_name: user.user_name,
        role: user.role,
        allowedBranchIds: allowedBranchIds
      };

      return Util.createResponse(true, userInfo);

    } catch (e) {
      console.log(`[UserService] Session Check Error: ${e.message}`);
      return Util.createResponse(false, null, `인증 오류: ${e.message}`);
    }
  },

  /**
   * [Auth] 이메일 기반 간이 로그인 (UserProperties 세션 저장)
   */
  login(email) {
    try {
      if (!email || typeof email !== 'string') {
        return Util.createResponse(false, null, '이메일을 입력해 주세요.');
      }

      const targetEmail = email.trim().toLowerCase();
      const users = Util.getSheetDataAsObjects(Config.SHEET_NAMES.USER);
      const user = users.find(u => String(u.user_email).toLowerCase() === targetEmail);

      if (!user) {
        return Util.createResponse(false, null, `등록되지 않은 계정입니다: ${email}`);
      }

      if (!user.enabled) {
        return Util.createResponse(false, null, '비활성화된 계정입니다. 관리자에게 문의하세요.');
      }

      // UserProperties에 세션 저장
      try {
        PropertiesService.getUserProperties().setProperty('LOGIN_EMAIL', user.user_email);
      } catch (e) {
        console.warn('[UserService] 세션 저장 실패:', e.message);
      }

      let allowedBranchIds = [];
      if (user.role === Config.USER_ROLES.ADMIN) {
        allowedBranchIds = ['all'];
      } else {
        allowedBranchIds = this.fetchUserPermissions(user.id);
      }

      const userInfo = {
        id: user.id,
        user_email: user.user_email,
        user_name: user.user_name,
        role: user.role,
        allowedBranchIds: allowedBranchIds
      };

      return Util.createResponse(true, userInfo);
    } catch (e) {
      console.log(`[UserService] Login Error: ${e.message}`);
      return Util.createResponse(false, null, `로그인 실패: ${e.message}`);
    }
  },

  /**
   * [Auth] Google OAuth2 Access Token 기반 정식 구글 로그인 검증
   */
  loginWithGoogle(accessToken) {
    try {
      if (!accessToken || typeof accessToken !== 'string') {
        return Util.createResponse(false, null, '유효한 Google 인증 토큰이 전달되지 않았습니다.');
      }

      // Google OAuth2 UserInfo 엔드포인트 호출
      const userInfoUrl = 'https://www.googleapis.com/oauth2/v3/userinfo';
      const response = UrlFetchApp.fetch(userInfoUrl, {
        headers: {
          'Authorization': 'Bearer ' + accessToken.trim()
        },
        muteHttpExceptions: true
      });

      const responseCode = response.getResponseCode();
      if (responseCode !== 200) {
        console.warn(`[UserService] Google UserInfo 조회 실패 (${responseCode}):`, response.getContentText());
        return Util.createResponse(false, null, 'Google 계정 정보 검증에 실패했습니다. (만료되었거나 유효하지 않은 토큰)');
      }

      const profile = JSON.parse(response.getContentText());
      const email = profile.email;

      if (!email) {
        return Util.createResponse(false, null, 'Google 계정에서 이메일 정보를 확인할 수 없습니다.');
      }

      // user 시트에서 등록 사용자 확인
      const users = Util.getSheetDataAsObjects(Config.SHEET_NAMES.USER);
      const user = users.find(u => String(u.user_email).toLowerCase() === email.toLowerCase());

      if (!user) {
        return Util.createResponse(false, null, `등록되지 않은 Google 계정입니다: ${email}\n관리자에게 계정 등록을 요청해 주세요.`);
      }

      if (!user.enabled) {
        return Util.createResponse(false, null, '비활성화된 계정입니다. 관리자에게 문의하세요.');
      }

      // UserProperties에 세션 저장 (Google 공식 인증 통과)
      try {
        PropertiesService.getUserProperties().setProperty('LOGIN_EMAIL', user.user_email);
      } catch (e) {
        console.warn('[UserService] 세션 저장 실패:', e.message);
      }

      let allowedBranchIds = [];
      if (user.role === Config.USER_ROLES.ADMIN) {
        allowedBranchIds = ['all'];
      } else {
        allowedBranchIds = this.fetchUserPermissions(user.id);
      }

      const userInfo = {
        id: user.id,
        user_email: user.user_email,
        user_name: user.user_name || profile.name || '',
        role: user.role,
        allowedBranchIds: allowedBranchIds,
        picture: profile.picture || ''
      };

      return Util.createResponse(true, userInfo);
    } catch (e) {
      console.log(`[UserService] Google Login Error: ${e.message}`);
      return Util.createResponse(false, null, `구글 로그인 처리 중 오류 발생: ${e.message}`);
    }
  },

  /**
   * [Auth] 세션 로그아웃
   */
  logout() {
    try {
      PropertiesService.getUserProperties().deleteProperty('LOGIN_EMAIL');
      return Util.createResponse(true, null, '로그아웃 되었습니다.');
    } catch (e) {
      return Util.createResponse(false, null, e.message);
    }
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
    return Util.getSheetDataAsObjects(Config.SHEET_NAMES.USER);
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

      return Util.createResponse(true, newUserObj);

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