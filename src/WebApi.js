/**
 * Wangbijib Reservation Admin Web App - Backend
 * ---------------------------------------------
 * 1. Serves the main web app (doGet)
 * 2. Handles reservation data (getReservations, updateReservation)
 * 3. Handles login (checkLogin)
 * 4. Handles admin settings (CRUD for master data)
 * 5. Handles pivot table for slot_default
 */

function doGet(e) {
  const template = HtmlService.createTemplateFromFile('index');
  template.pubUrl = ScriptApp.getService().getUrl();

  // 기본은 웹앱 메인
  return template.evaluate()
    .setTitle('왕비집 예약관리 시스템')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function doPost(e) {
  try {
    // 1. 카카오가 보낸 데이터 파싱
    const postData = JSON.parse(e.postData.contents);
    Logger.log("[Webhook] 수신 데이터: " + JSON.stringify(postData));

    // 2. 우리가 프론트에서 넘겨준 커스텀 파라미터 확인
    // (아래 프론트엔드 코드에서 reservation_id를 넘겨줄 예정)
    const reservationId = postData.reservation_id;

    if (reservationId) {
      const result = updateReservationMessageSentAt(reservationId);
      if (result.success !== true) {
        throw new Error(`에러 메세지: ${result?.error}`);
      }
    }

    // 4. 카카오에게 잘 받았다고 응답 (필수)
    return ContentService.createTextOutput(JSON.stringify({ success: true }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    Logger.log("[Webhook Error] " + err.message);
    // 에러 나도 카카오에게는 성공으로 응답해줘야 재발송 시도를 안 함
    return ContentService.createTextOutput(JSON.stringify({ success: false }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * (SERVER) ID/PW로 로그인을 확인하고, 해시/솔트 값을 비교합니다.
 * @param {string} id - 사용자가 입력한 로그인 ID
 * @param {string} password - 사용자가 입력한 비밀번호 (일반 텍스트)
 * @returns {Object} { success: boolean, user?: object, error?: string }
 */
function checkLogin(loginId, password) {
  return new UserService().login(loginId, password);
}

function apiGetCurrentUser() {
  const email = Session.getActiveUser().getEmail();
  Logger.log('email: ', email);
  return { success: true, data: { email: email } };
}

// --- 4. 데이터 조회 (공통) ---

/**
 * (SERVER) Admin 설정 탭의 모든 테이블 데이터를 가져옵니다.
 */
function loadAdminTableData(sheetName, userInfo) {
  if ([SHEET_NAMES.SLOT_MASTER, SHEET_NAMES.SLOT_DEFAULT, SHEET_NAMES.SLOT_OVERRIDE].includes(sheetName)) {
    return new SlotService().getSlotData(sheetName, userInfo);
  } else if (sheetName === SHEET_NAMES.BRANCH) {
    const data = getSheetData(sheetName, true);
    return removeColumns(data, ['created_at', 'updated_at', 'id']);
  } else if (sheetName === SHEET_NAMES.USER) {
    return new UserService().getAllUsers();
  } else {
    const data = getSheetData(sheetName);
    return removeColumns(data, ['created_at', 'updated_at']);
  }
}

/**
 * (SERVER) 지정된 시트의 모든 데이터를 가져옵니다. (헤더 포함)
 * Date 객체 직렬화 오류를 방지하기 위해 ISO 문자열로 변환합니다.
 */
function getSheetData(sheetName, getRichText = false) {
  try {
    const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(sheetName);
    if (!sheet) {
      throw new Error(`'${sheetName}' 시트를 찾을 수 없습니다.`);
    }
    if (sheet.getLastRow() === 0) {
      return []; // 빈 시트
    }

    let values;
    if (getRichText === true) {
      const response = Sheets.Spreadsheets.get(SPREADSHEET_ID, {
        ranges: [SHEET_NAMES.BRANCH],
        fields: "sheets(data(rowData(values(effectiveValue,chipRuns))))"
      });

      const sheetData = response.sheets[0].data[0];
      const rowData = sheetData.rowData || [];

      values = rowData.map(row => {
        if (!row.values) return [];

        return row.values.map(cell => {
          // 스마트 칩 링크 확인
          if (cell.chipRuns) {
            for (const run of cell.chipRuns) {
              if (run.chip?.richLinkProperties?.uri) {
                return run.chip.richLinkProperties.uri;
              }
            }
          }

          // 일반 데이터 타입별 파싱 (effectiveValue 사용)
          const value = cell.effectiveValue;

          if (!value) return ""; // 빈 셀

          // 값이 들어있는 키(Key)에 따라 리턴
          if (value.numberValue !== undefined) return value.numberValue; // 숫자 (Integer, Float, 날짜 시리얼)
          if (value.boolValue !== undefined) return value.boolValue;     // 불리언 (true/false)
          if (value.stringValue !== undefined) return value.stringValue; // 문자열
          if (value.errorValue !== undefined) return "#ERROR";           // 에러

          return "";
        });
      });
    } else {
      const range = sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn());
      values = range.getValues();
    }

    // 모든 Date 객체를 ISO 문자열로 변환합니다.
    const serializedValues = values.map(row =>
      row.map(cell =>
        (cell instanceof Date) ? cell.toISOString() : cell
      )
    );

    Logger.log(`서버측 getSheetData 성공 (직렬화 완료): ${sheetName}`);
    return serializedValues; // 직렬화된 값을 반환

  } catch (e) {
    Logger.log(e);
    throw new Error('데이터를 가져오는 중 오류 발생: ' + e.message);
  }
}

/**
 * (SERVER) Admin 모달의 드롭다운용 데이터를 가져옵니다.
 */
function getDropdownData(userInfo) {
  try {
    const usersData = getSheetData(SHEET_NAMES.USER);
    const branchesData = getSheetData(SHEET_NAMES.BRANCH);
    const slotsData = getSheetData(SHEET_NAMES.SLOT_MASTER);
    const permData = getSheetData(SHEET_NAMES.USER_PERMISSION);

    const permissions = (permData.length > 1)
      ? permData.slice(1).map(row => ({ user_id: row[1], branch_id: row[2] }))
      : [];

    let filteredBranchesData = [];

    if (userInfo && userInfo.role === 'admin') {
      filteredBranchesData = branchesData;
    } else if (userInfo) {
      const myAllowedBranchIds = permissions
        .filter(p => p.user_id === userInfo.id)
        .map(p => p.branch_id);

      // 헤더(0번 row)는 무조건 포함해야 함 (slice(1) 로직을 고려해 로직 분리)
      const header = branchesData[0];
      const body = branchesData.slice(1);

      const myBranches = body.filter(row => myAllowedBranchIds.includes(row[0])); // row[0] is id
      filteredBranchesData = [header, ...myBranches];
    } else {
      filteredBranchesData = branchesData; // 예외 케이스
    }

    const users = (usersData.length > 1) ? usersData.slice(1).map(row => ({ id: row[0], username: row[1] })) : []; // id, username
    const branches = (filteredBranchesData.length > 1) ? filteredBranchesData.slice(1).filter(branchInfo => branchInfo[4] === true).map(row => ({ id: row[0], name: row[2] })) : []; // id(0), branch_name_ko(2)
    const slots = (slotsData.length > 1) ? slotsData.slice(1).map(row => ({ id: row[0], time: formatDate(row[1], 'time') })) : []; // id, time


    return {
      users,
      branches,
      slots,
      permissions,
    };
  } catch (e) {
    Logger.log('getDropdownData 실패: ' + e.message);
    // ❗️ [중요] 이 에러를 클라이언트의 onFailure 핸들러로 전달합니다.
    throw new Error('드롭다운 데이터를 가져오는 중 오류 발생: ' + e.message);
  }
}

// --- 5. CRUD (Admin Settings) ---
// (USER, BRANCH)

/**
 * (SERVER) Admin 설정에서 레코드를 추가합니다.
 */
function addAdminRecord(sheetName, recordData) {
  try {
    if (sheetName === SHEET_NAMES.USER) {
      return new UserService().createUser(recordData);
    } else if (sheetName === SHEET_NAMES.SLOT_DEFAULT) {
      return new SlotService().createRecor
    } else {
      return new SlotService().createRecord(sheetName, recordData);
    }
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * (SERVER) Admin 설정에서 레코드를 수정합니다.
 */
function updateAdminRecord(sheetName, id, recordData) {
  try {
    if (sheetName === SHEET_NAMES.USER) {
      return new UserService().updateUser(id, recordData);
    } else {
      return new SlotService().updateRecord(sheetName, id, recordData);
    }
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function updateSlotDefaultBatch(branchId, slotsPayload) {
  try {
    return new SlotService().updateDefaultBatch(branchId, slotsPayload);

  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * (SERVER) Admin 설정에서 ID를 기준으로 레코드를 삭제합니다.
 * (주의: slot_default는 동작 방식이 다름)
 */
function deleteAdminRecord(sheetName, id) {
  try {
    if (sheetName === SHEET_NAMES.SLOT_DEFAULT) {
      return { success: false, error: '기본 슬롯은 이 방식으로 삭제할 수 없습니다.' };
    }

    return new SlotService().deleteRecord(sheetName, id);
  } catch (e) {
    Logger.log(e);
    return { success: false, error: e.message };
  }
}

// --- 8. 예약 관리 (Reservation) ---
/**
 * (SERVER) 예약 목록 조회
 * Service를 통해 날짜 범위와 사용자 권한에 맞는 예약을 조회합니다.
 * * @param {string} startDate - 조회 시작일 (YYYY-MM-DD)
 * @param {string} endDate - 조회 종료일 (YYYY-MM-DD)
 * @param {Object} userInfo - 현재 로그인한 유저 정보 {id, role, ...}
 */
function getReservations(startDate, endDate, searchMode, userInfo) {
  // 🚨 [디버깅 모드] 에러를 강제로 잡아서 로그를 찍습니다.
  try {
    Logger.log(`[API Start] getReservations 시작: ${startDate} ~ ${endDate}`);

    // 1. 전역 변수 확인 (이게 없으면 여기서 죽음)
    if (typeof SPREADSHEET_ID === 'undefined') throw new Error('SPREADSHEET_ID가 정의되지 않았습니다.');
    if (typeof SHEET_NAMES === 'undefined') throw new Error('SHEET_NAMES가 정의되지 않았습니다.');

    // 2. 서비스 생성 시도 (여기서 죽을 확률 90%)
    const service = new ReservationService();
    Logger.log('[API Progress] Service 생성 성공');

    // 3. 메서드 호출
    const result = service.getReservations(startDate, endDate, searchMode, userInfo);
    Logger.log(`[API Success] 데이터 ${result ? result.length : 0}건 반환`);

    return JSON.stringify(result);

  } catch (e) {
    // 💥 여기서 에러 정체가 드러납니다!
    Logger.log(`🔥 [치명적 오류] WebApi.getReservations 실패: ${e.message}`);
    Logger.log(`Stack Trace: ${e.stack}`);

    // 프론트엔드가 죽지 않도록 빈 배열을 줍니다.
    return [];
  }
}

/**
 * (SERVER) 예약 상태 변경
 * 프론트엔드에서 updateReservationStatus(id, newStatus) 형태로 호출합니다.
 * * @param {any} row - (Deprecated) 행 번호. Legacy 호환용이며 내부적으로 무시함.
 * @param {string} newStatus - 변경할 상태 ('예약', '취소' 등)
 * @param {string} id - 변경할 예약의 UUID
 */
function updateReservationStatus(reservationId, newStatus) {
  try {
    Logger.log(`[API] 예약 수정 요청: ${reservationId}, 상태:${newStatus}`);

    const result = new ReservationService().updateReservationStatus(reservationId, newStatus);

    Logger.log(`[API] 수정 결과: ${JSON.stringify(result)}`);
    return result;

  } catch (e) {
    Logger.log(`🔥 [Error] updateReservation 실패: ${e.message}`);
    return { success: false, error: e.message };
  }
}

function updateReservationMessageSentAt(reservationId) {
  try {
    const reservationService = new ReservationService();
    const reservation = reservationService.getReservation(reservationId);
    const dbMessageSentAt = reservation.obj.message_sent_at;

    if (!dbMessageSentAt) {
      new GmailService().setConfirmLabel(reservation.obj.email_thread_id);
    }

    return reservationService.updateMessageSentAt(reservationId);
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * (SERVER) 예약 정보 수정
 * * @param {Object} reservationData - 수정할 데이터 객체 { id, customer_name, pax, notes, email ... }
 */
function updateReservation(reservationData) {
  return new ReservationService().updateReservation(reservationData);
}

function markAsRead(id) {
  return new ReservationService().markAsRead(id);
}