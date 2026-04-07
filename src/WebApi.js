/**
 * [WebApi] 웹앱 진입점 및 API 라우팅 (Entry Point)
 */

function doGet(e) {
  try {
    console.log("▶ [doGet] 웹앱 로딩 시작");
    const webAppUrl = ScriptApp.getService().getUrl();
    const template = HtmlService.createTemplateFromFile('index');
    template.BASE_WEBAPP_URL = webAppUrl;

    return template.evaluate()
      .setTitle('왕비집 예약관리 시스템 v2.0')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  } catch (err) {
    return HtmlService.createHtmlOutput(`<h3>System Error</h3><p>${err.message}</p>`);
  }
}

function doPost(e) {
  try {
    // 1. 카카오가 보낸 데이터 파싱
    const postData = JSON.parse(e.postData.contents);
    Logger.log("[Webhook] 수신 데이터: " + JSON.stringify(postData));

    // 2. reservation_id 확인
    const reservationId = postData.reservation_id;

    if (reservationId) {
      // 3. 전송 시간 업데이트 (변경된 시그니처 사용: id, data)
      const now = new Date();
      const updateData = {
        message_sent_at: now
      };
      
      const result = ReservationService.updateReservation(reservationId, updateData);
      
      if (!result.success) {
        throw new Error(`업데이트 실패: ${result.message}`);
      }
      
      Logger.log(`[Webhook] 예약(${reservationId}) 전송일시 업데이트 완료: ${now}`);
    }

    // 4. 응답
    return ContentService.createTextOutput(JSON.stringify({ success: true }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    Logger.log("[Webhook Error] " + err.message);
    return ContentService.createTextOutput(JSON.stringify({ success: false }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function apiLoginWithGoogle(idToken) {
  const payload = Util.verifyGoogleIdToken(idToken);

  if (!payload || !payload.email) {
    return Util.createResponse(false, null, '로그인 실패');
  }

  // ✔ 여기서 이메일로 사용자 조회
  const user = getUserByEmail(payload.email);
  if (!user) {
    return Util.createResponse(false, null, '접근 권한 없음');
  }

  // ✔ 세션 저장
  PropertiesService.getUserProperties().setProperty(
    'LOGIN_EMAIL',
    payload.email
  );

  return Util.createResponse(true, user);
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/**
 * [Wrapper] API 실행 및 에러 핸들링 래퍼
 * - [v2.0] params 인자 추가로 요청 데이터 로깅 지원
 */
function _executeApi(apiName, action, params = null) {
  const startTime = new Date().getTime();
  
  // 파라미터 로깅
  let paramLog = 'None';
  try {
    if (params) {
      paramLog = JSON.stringify(params);
    }
  } catch (e) {
    paramLog = 'Stringify Error';
  }

  Logger.log(`▶ [API Start] ${apiName} | Params: ${paramLog}`);

  try {
    const result = action();
    const duration = new Date().getTime() - startTime;
    Logger.log(`✅ [API End] ${apiName} (${duration}ms)`);
    
    if (result && typeof result.success === 'boolean') {
      return result;
    }
    return Util.createResponse(true, result);
  } catch (err) {
    const duration = new Date().getTime() - startTime;
    Logger.log(`🔥 [API Error] ${apiName} (${duration}ms) | Params: ${paramLog} | Error: ${err.message}`);
    if (err.stack) Logger.log(err.stack);

    return Util.createResponse(false, null, err.message);
  }
}

// ==========================================
// 4. API Endpoints (Granular Data Fetching)
// ==========================================

function apiCheckSession() {
  return _executeApi('apiCheckSession', () => UserService.checkSession());
}

// [Legacy] 기존 통합 로딩 함수
function apiLoadInitialData() {
  return _executeApi('apiLoadInitialData', () => {
    const session = UserService.checkSession();
    if (!session.success) throw new Error(session.message);
    const userInfo = session.data;

    return {
      user: userInfo,
      branches: BranchService.getAllBranches(),
      reservations: ReservationService.getAllReservations(userInfo),
      users: (userInfo.role === Config.USER_ROLES.ADMIN) ? UserService.getAllUsers() : [],
      slotMasters: Util.getSheetDataAsObjects(Config.SHEET_NAMES.SLOT_MASTER),
      slotDefaults: Util.getSheetDataAsObjects(Config.SHEET_NAMES.SLOT_DEFAULT),
      slotOverrides: Util.getSheetDataAsObjects(Config.SHEET_NAMES.SLOT_OVERRIDE),
      mailTemplates: MailTemplateService.getAllTemplates()
    };
  });
}

/**
 * [Data] 지점 목록 조회
 */
function apiGetBranches() {
  return _executeApi('apiGetBranches', () => {
    const session = UserService.checkSession();
    if (!session.success) throw new Error(session.message);
    return BranchService.getAllBranches();
  });
}

/**
 * [Data] 예약 목록 조회
 */
function apiGetReservations() {
  return _executeApi('apiGetReservations', () => {
    const session = UserService.checkSession();
    if (!session.success) throw new Error(session.message);
    return ReservationService.getAllReservations(session.data);
  });
}

/**
 * [Data] 사용자 목록 조회 (Admin Only)
 */
function apiGetUsers() {
  return _executeApi('apiGetUsers', () => {
    const session = UserService.checkSession();
    if (!session.success) throw new Error(session.message);
    if (session.data.role !== Config.USER_ROLES.ADMIN) return [];
    return UserService.getAllUsers();
  });
}

/**
 * [Data] 슬롯 마스터 조회
 */
function apiGetSlotMasters() {
  return _executeApi('apiGetSlotMasters', () => {
    UserService.checkSession();
    return Util.getSheetDataAsObjects(Config.SHEET_NAMES.SLOT_MASTER);
  });
}

/**
 * [Data] 슬롯 기본 설정 조회
 */
function apiGetSlotDefaults() {
  return _executeApi('apiGetSlotDefaults', () => {
    UserService.checkSession();
    return Util.getSheetDataAsObjects(Config.SHEET_NAMES.SLOT_DEFAULT);
  });
}

/**
 * [Data] 슬롯 오버라이드 조회
 */
function apiGetSlotOverrides() {
  return _executeApi('apiGetSlotOverrides', () => {
    UserService.checkSession();
    return Util.getSheetDataAsObjects(Config.SHEET_NAMES.SLOT_OVERRIDE);
  });
}

/**
 * [Data] 메일 템플릿 목록 조회
 */
function apiGetMailTemplates() {
  return _executeApi('apiGetMailTemplates', () => {
    UserService.checkSession();
    return MailTemplateService.getAllTemplates();
  });
}


// ==========================================
// 5. Mutation API Endpoints
// ==========================================

function apiUpdateReservation(data) {
  // [Modified] id와 나머지 데이터를 분리하여 서비스 호출
  return _executeApi('apiUpdateReservation', () => {
    const { id, ...updateData } = data;
    if (!id) throw new Error("Reservation ID is missing");
    return ReservationService.updateReservation(id, updateData);
  }, data);
}

function apiUpdateReservationMessageSentAt(id) {
  // [Modified] id와 나머지 데이터를 분리하여 서비스 호출
  return _executeApi('apiUpdateReservationMessageSentAt', () => {
    return ReservationService.updateMessageSentAt(id);
  }, id);
}

function apiUpdateReservationStatus(id, status) {
  return _executeApi('apiUpdateReservationStatus', () => ReservationService.updateReservationStatus(id, status), { id, status });
}

function apiUpdateDepositStatus(id, status) {
  return _executeApi('apiUpdateDepositStatus', () => ReservationService.updateDepositStatus(id, status), { id, status });
}

/**
 * [NEW] 예약 상세 모달에서 템플릿 기반 메일 발송
 */
function apiSendTemplatedMail(payload) {
  return _executeApi('apiSendTemplatedMail', () => {
    const { threadId, templateId, data } = payload;

    data.reservation_time = Util.formatDate(data.reservation_date, 'time');

    return GmailService.replyToThreadWithTemplate(threadId, templateId, data);
  }, payload);
}

/**
 * [NEW] 예약 읽음 처리
 */
function apiMarkReservationAsRead(id) {
  return _executeApi('apiMarkReservationAsRead', () => {
    return ReservationService.markAsRead(id);
  }, { id });
}

function apiSaveSystemSettings(type, data) {
  // [Param Log] {type, data} 객체 전달
  return _executeApi(`apiSaveSystemSettings:${type}`, () => {
    const session = UserService.checkSession();
    if (!session.success) throw new Error("Unauthorized");

    switch (type) {
      case 'user':
        return data.id ? UserService.updateUser(data.id, data) : UserService.createUser(data);
      case 'branch':
        return BranchService.updateBranch(data.id, data);
      case 'mail_template':
        // [FIX] ID 유무에 따라 생성/수정 분기 및 전체 데이터 전달
        return data.id ? MailTemplateService.updateTemplate(data.id, data) : MailTemplateService.createTemplate(data);
      case 'slot_override':
        // 단건 수정 (기존)
        return SlotService.updateSlotOverride(data);
      case 'slot_batch':
        // 기본 슬롯 일괄 설정 (기존)
        return SlotService.updateDefaultSlotsBatch(data.branch_id, data.payload);
      case 'slot_override_batch':
        // [NEW] 커스텀 슬롯 일괄 설정 (신규 최적화 로직)
        // param: { branch_id, date, payload: { masterId: {slot, enabled} } }
        return SlotService.updateOverrideSlotsBatch(data.branch_id, data.date, data.payload);
      default:
        throw new Error(`Unknown setting type: ${type}`);
    }
  }, { type, data });
}

function apiDeleteSystemData(type, id) {
  return _executeApi(`apiDeleteSystemData:${type}`, () => {
    const session = UserService.checkSession();
    if (!session.success) throw new Error("Unauthorized");

    switch (type) {
      case 'user':
        return UserService.deleteUser(id); // Soft Delete
      case 'mail_template':
        return MailTemplateService.deleteTemplate(id); // Hard Delete
      default:
        return Util.createResponse(false, null, "Unsupported delete type");
    }
  }, { type, id });
}