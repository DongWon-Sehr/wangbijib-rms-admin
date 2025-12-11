class UserService {
  constructor() {
    this.ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    this.userSheet = this.ss.getSheetByName('user');
    this.permSheet = this.ss.getSheetByName('user_branch_permission');
  }

  login(loginId, password) {
    try {
      if (!this.userSheet) {
        return { success: false, error: 'User 시트가 존재하지 않습니다.' };
      }

      const lastRow = this.userSheet.getLastRow();
      if (lastRow <= 1) {
        return { success: false, error: '로그인 ID 또는 비밀번호가 일치하지 않습니다.' };
      }

      // 헤더를 제외한 데이터 (A:I - 9열)
      const data = this.userSheet.getRange(2, 1, lastRow - 1, 9).getValues();

      for (const row of data) {
        const dbUuid = row[0];        // UUID (PK)
        const dbUserId = row[1];      // user_id (로그인용)
        const dbUserName = row[2];    // user_name (표시용)
        const dbUserPasswordHash = row[3];        // user_password
        const dbSalt = row[4];        // salt
        const dbRole = row[5];        // salt
        const isEnabled = row[6];     // enabled

        if (dbUserId === loginId) {
          // ID 일치. 비밀번호 검증
          if (!this.verifyPassword(password, dbSalt, dbUserPasswordHash)) {
            return { success: false, error: '로그인 ID 또는 비밀번호가 일치하지 않습니다.' };
          }

          if (!isEnabled) return { success: false, error: '비활성화된 계정입니다.' };

          let allowedBranchIds = [];

          if (dbRole === 'admin') {
            allowedBranchIds = ['all']; // Admin은 프리패스
          } else {
            allowedBranchIds = this.fetchUserPermissions(dbUuid);
          }

          return {
            success: true,
            user: {
              id: dbUuid,
              userId: dbUserId,
              userName: dbUserName,
              role: dbRole,
              allowedBranchIds: allowedBranchIds,
            }
          };
        }
      }

      // ID 없음
      return { success: false, error: '로그인 ID 또는 비밀번호가 일치하지 않습니다.' };

    } catch (e) {
      Logger.log(e);
      return { success: false, error: '로그인 중 오류 발생: ' + e.message };
    }
  }

  fetchUserPermissions(userUuid) {
    const data = this.permSheet.getRange(2, 1, this.permSheet.getLastRow() - 1, 4).getValues();
    // id(0), user_id(1), branch_id(2), enabled(3)

    return data
      .filter(row => row[1] === userUuid && row[3] === true) // user_id 일치 & enabled true
      .map(row => row[2]); // branch_id 반환
  }

  verifyPassword(password, salt, expectedHash) {
    const inputHash = this.hashPassword(password, salt);
    return inputHash === expectedHash;
  }

  hashPassword(password, salt) {
    const hash = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, password + salt, Utilities.Charset.UTF_8);
    return hash.map(byte => ('0' + (byte & 0xFF).toString(16)).slice(-2)).join('');
  }


  createUser(userData) {
    try {
      const headers = this.userSheet.getRange(1, 1, 1, this.userSheet.getLastColumn()).getValues()[0]; // 7열

      // user_id 중복 체크 (B열, index 1)
      const lastRow = this.userSheet.getLastRow();
      if (lastRow > 1) {
        const userIds = this.userSheet.getRange(2, 2, lastRow - 1, 1).getValues().flat();
        if (userIds.includes(userData.user_id)) {
          return { success: false, error: '이미 사용 중인 ID입니다.' };
        }
      }

      const newUuid = Utilities.getUuid();
      const salt = Utilities.getUuid();
      const userPasswordHash = this.hashPassword(userData.user_password, salt);
      const now = new Date();

      const newRow = [
        newUuid,              // id (PK)
        userData.user_id,     // user_id
        userData.user_name,   // user_name
        userPasswordHash,     // user_password
        salt,
        userData.role,
        userData.enabled,
        now,
        now,
      ];

      this.userSheet.appendRow(newRow);

      if (
        userData.role !== 'admin'
        && userData.branch_ids
        && userData.branch_ids.length > 0
      ) {
        this.updatePermissions(newUuid, userData.branch_ids);
      }

      const serializedRow = [newRow].map(row => row.map(cell => (cell instanceof Date) ? cell.toISOString() : cell));

      return { success: true, newRecord: serializedRow[0] };
    } catch (e) {
      Logger.log(e);
      return { success: false, error: e.message };
    }
  }

  updateUser(id, userData) {
    try {
      // user: id,  user_id,  user_name,  user_password_hash, salt, role, enabled,  created_at
      // 인덱스:  0,  1,        2,          3,                  4,    5,    6,        7
      const data = this.userSheet.getRange(1, 1, this.userSheet.getLastRow(), this.userSheet.getLastColumn()).getValues();

      for (let i = 1; i < data.length; i++) {
        if (data[i][0] === id) { // ID 일치
          let userPasswordHash = data[i][3];
          let salt = data[i][4];

          // 비밀번호 필드가 비어있지 않으면 (변경 의도)
          if (userData.user_password && userData.user_password.length > 0) {
            salt = Utilities.getUuid(); // 새 Salt
            userPasswordHash = this.hashPassword(userData.user_password, salt);
          }

          const updatedRow = [
            id, // ID 변경 안 함
            userData.user_id,
            userData.user_name,
            userPasswordHash, // 새 해시 또는 기존 해시
            salt, // 새 솔트 또는 기존 솔트
            userData.role,
            userData.enabled,
            data[i][7], // created_at 변경 안 함
            new Date(),
          ];

          this.userSheet.getRange(i + 1, 1, 1, updatedRow.length).setValues([updatedRow]);

          if (userData.branch_ids) {
            // Admin으로 변경된 경우 권한 데이터가 필요 없으므로 싹 지울 수도 있고, 
            // 정책에 따라 남겨둘 수도 있음. 여기선 일단 덮어쓰기 로직 수행.
            this.updatePermissions(id, userData.branch_ids);
          }

          const serializedRow = [updatedRow].map(row => row.map(cell => (cell instanceof Date) ? cell.toISOString() : cell));

          return { success: true, updatedRecord: serializedRow[0] };
        }
      }
      return { success: false, error: '해당 ID의 사용자를 찾을 수 없습니다.' };
    } catch (e) {
      Logger.log(e);
      return { success: false, error: e.message };
    }
  }

  updatePermissions(userId, branchIds) {
    // 1. 전체 데이터 가져오기 (헤더 포함)
    const range = this.permSheet.getDataRange();
    const allValues = range.getValues();

    // 헤더가 없거나 데이터가 없으면 헤더만 남기고 진행
    if (allValues.length <= 1) {
      // 기존 데이터가 없으므로 바로 추가 로직으로
      this.appendNewPermissions(userId, branchIds);
      return;
    }

    const header = allValues[0]; // 헤더 보관
    const body = allValues.slice(1); // 데이터 부분

    // 2. [메모리 연산] 해당 유저의 데이터만 '제외'하고 남김 (삭제 효과)
    // user_id는 1번 인덱스(B열)
    const remainingRows = body.filter(row => row[1] !== userId);

    // 3. [메모리 연산] 새로운 권한 데이터 생성
    const now = new Date();
    const newRows = branchIds.map(branchId => [
      Utilities.getUuid(), // id (UUID)
      userId,              // user_id
      branchId,            // branch_id
      true,                // enabled
      now,                 // created_at
      now                  // updated_at
    ]);

    // 4. 기존 데이터(남은 것) + 신규 데이터 합치기
    const finalRows = [...remainingRows, ...newRows];

    // 5. 시트에 반영 (기존 내용 지우고 덮어쓰기)
    // 헤더 다음 줄부터 끝까지 내용 삭제
    this.permSheet.getRange(2, 1, this.permSheet.getLastRow(), this.permSheet.getLastColumn()).clearContent();

    // 데이터가 있을 때만 setValues (빈 배열이면 에러남)
    if (finalRows.length > 0) {
      // 2행 1열부터 시작해서 데이터 크기만큼 범위 지정
      this.permSheet.getRange(2, 1, finalRows.length, finalRows[0].length).setValues(finalRows);
    }
  }

  appendNewPermissions(userId, branchIds) {
    if (!branchIds || branchIds.length === 0) return;
    const now = new Date();
    const newRows = branchIds.map(branchId => [
      Utilities.getUuid(), userId, branchId, true, now, now
    ]);
    this.permSheet.getRange(this.permSheet.getLastRow() + 1, 1, newRows.length, 6).setValues(newRows);
  }

  deleteUser(id) {
    try {
      // user: id,  user_id,  user_name,  user_password_hash, salt, role, enabled,  created_at
      // 인덱스:  0,  1,        2,          3,                  4,    5,    6,        7
      const data = this.userSheet.getRange(1, 1, this.userSheet.getLastRow(), this.userSheet.getLastColumn()).getValues();

      for (let i = 1; i < data.length; i++) {
        if (data[i][0] === id) { // ID 일치

          this.userSheet.deleteRow(i + 1);
          return { success: true, deletedId: id };
        }
      }
      return { success: false, error: '해당 ID의 사용자를 찾을 수 없습니다.' };
    } catch (e) {
      Logger.log(e);
      return { success: false, error: e.message };
    }
  }

  getAllUsers() {
    try {
      const data = this.userSheet.getRange(1, 1, this.userSheet.getLastRow(), this.userSheet.getLastColumn()).getValues();
      if (data.length === 0) return [];

      const headers = data[0];

      // 1. 제거할 컬럼명 정의
      const sensitiveColumns = ['user_password_hash', 'salt', 'created_at', 'updated_at'];

      // 2. 제거할 컬럼의 인덱스 찾기
      const indicesToRemove = headers
        .map((h, i) => sensitiveColumns.includes(h) ? i : -1)
        .filter(i => i !== -1);

      // 3. 데이터 필터링 (헤더 포함 전체 행)
      const safeData = data.map(row => {
        return row.filter((_, index) => !indicesToRemove.includes(index));
      });

      // 4. 직렬화 (Date -> String)
      const serializedData = safeData.map(row =>
        row.map(cell => (cell instanceof Date) ? cell.toISOString() : cell)
      );

      return serializedData;

    } catch (e) {
      Logger.log(e);
      throw new Error('사용자 목록 조회 중 오류: ' + e.message);
    }
  }
}