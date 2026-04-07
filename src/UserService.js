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
  checkSession() {
    try {
      const email = Session.getActiveUser().getEmail();
      if (!email) {
        return Util.createResponse(false, null, '구글 계정 정보를 가져올 수 없습니다.');
      }

      // 모든 사용자 로드 (ORM 방식)
      const users = Util.getSheetDataAsObjects(Config.SHEET_NAMES.USER);
      
      // 이메일 대소문자 무시 비교
      const user = users.find(u => String(u.user_email).toLowerCase() === email.toLowerCase());

      if (!user) {
        // 등록되지 않은 사용자
        return Util.createResponse(false, { email: email }, `등록되지 않은 사용자입니다. (${email})`);
      }

      if (!user.enabled) {
        return Util.createResponse(false, { email: email }, '비활성화된 계정입니다. 관리자에게 문의하세요.');
      }

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
      Logger.log(`[UserService] Session Check Error: ${e.message}`);
      return Util.createResponse(false, null, `인증 오류: ${e.message}`);
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