/**
 * [WebApi] 웹앱 진입점 및 API 라우팅 (Entry Point)
 */

function doGet(e) {
  try {
    console.log("▶ [doGet] 웹앱 로딩 시작");
    const webAppUrl = ScriptApp.getService().getUrl();
    const template = HtmlService.createTemplateFromFile('index');
    template.BASE_WEBAPP_URL = webAppUrl;
    template.APP_VERSION = Config.APP_VERSION;
    template.APP_LOGO = _getLogoDataUri();
    let oauthResult = null;
    if (e && e.parameter && (e.parameter.code || e.parameter.error)) {
      try {
        if (e.parameter.error) throw new Error('Google 로그인이 취소되었거나 거부되었습니다.');
        oauthResult = UserService.completeGoogleLogin(e.parameter.code, e.parameter.state, webAppUrl);
      } catch (authErr) {
        oauthResult = { error: authErr.message, state: e.parameter.state || '' };
      }
    }
    template.OAUTH_RESULT_JSON = JSON.stringify(oauthResult).replace(/</g, '\\u003c');

    return template.evaluate()
      .setTitle('왕비집 예약관리 시스템 v' + Config.APP_VERSION)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1.0, user-scalable=no')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  } catch (err) {
    return HtmlService.createHtmlOutput(`<h3>System Error</h3><p>${err.message}</p>`);
  }
}

function doPost(e) {
  try {
    // 1. 카카오가 보낸 데이터 파싱
    const postData = JSON.parse(e.postData.contents);
    console.log("[Webhook] 수신 데이터: " + JSON.stringify(postData));

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
      
      console.log(`[Webhook] 예약(${reservationId}) 전송일시 업데이트 완료: ${now}`);
      _recordActivity('webhookMessageSentAt', { user_email: '', user_name: 'SYSTEM' }, { id: reservationId }, true);
    }

    // 4. 응답
    return ContentService.createTextOutput(JSON.stringify({ success: true }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    console.log("[Webhook Error] " + err.message);
    return ContentService.createTextOutput(JSON.stringify({ success: false }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function apiBeginGoogleLogin() {
  return _executeApi('apiBeginGoogleLogin', () => UserService.beginGoogleLogin(ScriptApp.getService().getUrl()));
}

function apiLogout(token) {
  return _executeApi('apiLogout', () => UserService.logout(token));
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

// Drive의 BI 로고를 data URI로 반환 (실패 시 빈 문자열 → 프론트는 왕관 아이콘 폴백)
function _getLogoDataUri() {
  // 파일 ID를 키에 포함해 로고 교체 시 캐시가 자동 무효화되도록 함
  const CACHE_KEY = 'APP_LOGO_' + Config.LOGO_FILE_ID;
  try {
    const cache = CacheService.getScriptCache();
    const cached = cache.get(CACHE_KEY);
    if (cached) return cached;

    const blob = DriveApp.getFileById(Config.LOGO_FILE_ID).getBlob();
    const dataUri = 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes());
    if (dataUri.length < 90 * 1024) cache.put(CACHE_KEY, dataUri, 21600); // CacheService 100KB 제한 고려
    return dataUri;
  } catch (e) {
    console.warn('[doGet] 로고 로드 실패: ' + e.message);
    return '';
  }
}

/**
 * [Wrapper] API 실행 및 에러 핸들링 래퍼
 * - [v2.0] params 인자 추가로 요청 데이터 로깅 지원
 */
function _executeApi(apiName, action, params = null, actor = null) {
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

  console.log(`▶ [API Start] ${apiName} | Params: ${paramLog}`);

  try {
    const result = action();
    const duration = new Date().getTime() - startTime;
    console.log(`✅ [API End] ${apiName} (${duration}ms)`);
    
    const response = result && typeof result.success === 'boolean' ? result : Util.createResponse(true, result);
    if (actor) _recordActivity(apiName, actor, params, response.success, response.success ? response.data : null);
    return response;
  } catch (err) {
    const duration = new Date().getTime() - startTime;
    console.log(`🔥 [API Error] ${apiName} (${duration}ms) | Params: ${paramLog} | Error: ${err.message}`);
    if (err.stack) console.log(err.stack);

    if (actor) _recordActivity(apiName, actor, params, false);

    return Util.createResponse(false, null, err.message);
  }
}

function _recordActivity(apiName, actor, params, success, resultData = null) {
  try {
    ActivityLogService.record(apiName, actor, params, success, resultData);
  } catch (err) {
    // 작업 자체는 이미 끝났을 수 있으므로 중복 실행을 유도하는 실패 응답을 반환하지 않는다.
    console.error('[ActivityLog] 기록 실패: ' + err.message);
  }
}

// ==========================================
// 4. API Endpoints (Granular Data Fetching)
// ==========================================

function apiCheckSession(token) {
  return _executeApi('apiCheckSession', () => UserService.checkSession(token));
}

// [Legacy] 기존 통합 로딩 함수
function apiLoadInitialData(token) {
  const auth = UserService.checkSession(token);
  if (!auth.success) return auth;
  return _executeApi('apiLoadInitialData', () => {
    const session = UserService.checkSession(token);
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
      mailTemplates: MailTemplateService.getAllTemplates(),
      duplicateGroups: DuplicateGroupService.getAllGroups()
    };
  });
}

/**
 * [Data] 지점 목록 조회
 */
function apiGetBranches(token) {
  const auth = UserService.checkSession(token);
  if (!auth.success) return auth;
  return _executeApi('apiGetBranches', () => {
    const session = UserService.checkSession(token);
    if (!session.success) throw new Error(session.message);
    return BranchService.getAllBranches();
  });
}

/**
 * [Data] 예약 목록 조회
 */
function apiGetReservations(token) {
  const auth = UserService.checkSession(token);
  if (!auth.success) return auth;
  return _executeApi('apiGetReservations', () => {
    const session = UserService.checkSession(token);
    if (!session.success) throw new Error(session.message);
    return ReservationService.getAllReservations(session.data);
  });
}

/**
 * [Data] 사용자 목록 조회 (Admin Only)
 */
function apiGetUsers(token) {
  const auth = UserService.checkSession(token);
  if (!auth.success) return auth;
  return _executeApi('apiGetUsers', () => {
    const session = UserService.checkSession(token);
    if (!session.success) throw new Error(session.message);
    if (session.data.role !== Config.USER_ROLES.ADMIN) return [];
    return UserService.getAllUsers();
  });
}

function apiGetActivityLogs(token) {
  const auth = UserService.checkSession(token);
  if (!auth.success) return auth;
  if (auth.data.role !== Config.USER_ROLES.ADMIN) return Util.createResponse(false, null, '관리자 권한이 필요합니다.');
  return _executeApi('apiGetActivityLogs', () => ActivityLogService.getRecentLogs(200));
}

/**
 * [Data] 슬롯 마스터 조회
 */
function apiGetSlotMasters(token) {
  const auth = UserService.checkSession(token);
  if (!auth.success) return auth;
  return _executeApi('apiGetSlotMasters', () => {
    UserService.checkSession(token);
    return Util.getSheetDataAsObjects(Config.SHEET_NAMES.SLOT_MASTER);
  });
}

/**
 * [Data] 슬롯 기본 설정 조회
 */
function apiGetSlotDefaults(token) {
  const auth = UserService.checkSession(token);
  if (!auth.success) return auth;
  return _executeApi('apiGetSlotDefaults', () => {
    UserService.checkSession(token);
    return Util.getSheetDataAsObjects(Config.SHEET_NAMES.SLOT_DEFAULT);
  });
}

/**
 * [Data] 슬롯 오버라이드 조회
 */
function apiGetSlotOverrides(token) {
  const auth = UserService.checkSession(token);
  if (!auth.success) return auth;
  return _executeApi('apiGetSlotOverrides', () => {
    UserService.checkSession(token);
    return Util.getSheetDataAsObjects(Config.SHEET_NAMES.SLOT_OVERRIDE);
  });
}

/**
 * [Data] 메일 템플릿 목록 조회
 */
function apiGetMailTemplates(token) {
  const auth = UserService.checkSession(token);
  if (!auth.success) return auth;
  return _executeApi('apiGetMailTemplates', () => {
    UserService.checkSession(token);
    return MailTemplateService.getAllTemplates();
  });
}


// ==========================================
// 5. Mutation API Endpoints
// ==========================================

function apiUpdateReservation(token, data) {
  const auth = UserService.checkSession(token);
  if (!auth.success) return auth;
  // [Modified] id와 나머지 데이터를 분리하여 서비스 호출
  return _executeApi('apiUpdateReservation', () => {
    const { id, ...updateData } = data;
    if (!id) throw new Error("Reservation ID is missing");
    return ReservationService.updateReservation(id, updateData);
  }, data, auth.data);
}

function apiUpdateReservationMessageSentAt(token, id) {
  const auth = UserService.checkSession(token);
  if (!auth.success) return auth;
  // [Modified] id와 나머지 데이터를 분리하여 서비스 호출
  return _executeApi('apiUpdateReservationMessageSentAt', () => {
    return ReservationService.updateMessageSentAt(id);
  }, { id }, auth.data);
}

function apiUpdateReservationStatus(token, id, status) {
  const auth = UserService.checkSession(token);
  if (!auth.success) return auth;
  return _executeApi('apiUpdateReservationStatus', () => ReservationService.updateReservationStatus(id, status), { id, status }, auth.data);
}

function apiUpdateDepositStatus(token, id, status) {
  const auth = UserService.checkSession(token);
  if (!auth.success) return auth;
  return _executeApi('apiUpdateDepositStatus', () => ReservationService.updateDepositStatus(id, status), { id, status }, auth.data);
}

/**
 * [NEW] 예약 상세 모달에서 템플릿 기반 메일 발송
 */
function apiSendTemplatedMail(token, payload) {
  const auth = UserService.checkSession(token);
  if (!auth.success) return auth;
  return _executeApi('apiSendTemplatedMail', () => {
    const { threadId, templateId, data, altBranchId } = payload;

    data.reservation_time = Util.formatDate(data.reservation_date, 'time');

    // 대체 지점 안내: 클라이언트는 alt_branch_id만 전달, 지점 정보 조회 및 예약어 주입은 서버에서 수행
    // 조회 실패 또는 필수 정보(영문명/주소/구글맵 링크) 누락 시 발송을 중단하고 실패 응답 반환
    if (altBranchId) {
      const altBranch = BranchService.getBranchById(altBranchId);
      if (!altBranch) {
        return Util.createResponse(false, null, '대체 지점 정보를 찾을 수 없어 발송을 취소했습니다.');
      }
      const missing = [];
      if (!altBranch.branch_name_en) missing.push('영문 지점명');
      if (!altBranch.address) missing.push('주소');
      if (!altBranch.google_map_link) missing.push('구글맵 링크');
      if (missing.length > 0) {
        return Util.createResponse(false, null, '대체 지점의 필수 정보(' + missing.join(', ') + ')가 비어 있어 발송을 취소했습니다. 지점 관리에서 정보를 입력한 후 다시 시도해주세요.');
      }
      data.alt_branch_name_en = altBranch.branch_name_en;
      data.alt_branch_address = altBranch.address;
      data.alt_branch_google_link = altBranch.google_map_link;
    }

    return GmailService.replyToThreadWithTemplate(threadId, templateId, data);
  }, payload, auth.data);
}

/**
 * [NEW] 예약 확정 이메일 더미 발송 (Elfsight 누락 대비) 및 스레드 초기화
 */
function apiInitializeMailThread(token, payload) {
  const auth = UserService.checkSession(token);
  if (!auth.success) return auth;
  return _executeApi('apiInitializeMailThread', () => {
    const { reservationId, data } = payload;
    
    // 1. 고객에게 직접 더미 메일(예약 확정 내역) 발송 및 스레드 생성
    const threadId = GmailService.createDummyElfsightThread(data);
    
    // 2. 시트에 스레드 ID 및 이메일 저장 (이메일이 모달에서 수정된 경우 동기화)
    const updateFields = { email_thread_id: threadId };
    if (data && data.email) {
      updateFields.email = data.email;
    }
    ReservationService.updateReservation(reservationId, updateFields);
    
    return { threadId: threadId, email: data ? data.email : undefined };
  }, payload, auth.data);
}

/**
 * [NEW] 이메일 주소 선변경 + 신규 스레드 예약확인 메일 발송 (순서 보장 단일 트랜잭션)
 */
function apiCorrectEmailAndInitializeThread(token, payload) {
  const auth = UserService.checkSession(token);
  if (!auth.success) return auth;
  return _executeApi('apiCorrectEmailAndInitializeThread', () => {
    const { reservationId, newEmail, data } = payload;
    if (!reservationId || !newEmail) throw new Error('예약 ID 또는 새로운 이메일 주소가 누락되었습니다.');

    // [STEP 1] 시트 DB의 이메일 주소를 먼저 수정하여 저장
    const updateRes = ReservationService.updateReservation(reservationId, { email: newEmail });
    if (!updateRes.success) {
      throw new Error('이메일 주소 저장 실패: ' + updateRes.message);
    }
    console.log(`[EmailCorrection] 예약(${reservationId}) 이메일 주소 선변경 완료: ${newEmail}`);

    // [STEP 2] 변경된 새 주소로 예약 확인서 메일 발송 및 스레드 생성
    const sendData = {
      ...data,
      email: newEmail,
      isCorrectedResend: true
    };
    const threadId = GmailService.createDummyElfsightThread(sendData);
    console.log(`[EmailCorrection] 예약확인 메일 발송 완료: threadId=${threadId}`);

    // [STEP 3] 발송된 신규 threadId를 시트 DB에 저장
    ReservationService.updateReservation(reservationId, { email_thread_id: threadId });

    return { threadId: threadId, email: newEmail };
  }, payload, auth.data);
}

/**
 * [Async Helper] 백그라운드 라벨 추가 (클라이언트 응답 지연 방지)
 */
function apiAddLabelsToThread(token, payload) {
  const auth = UserService.checkSession(token);
  if (!auth.success) return auth;
  return _executeApi('apiAddLabelsToThread', () => {
    let { threadId, pax, status, deposit_status, reservationId } = payload;
    if (reservationId && (!status || !deposit_status)) {
      try {
        const res = ReservationService.getReservationById(reservationId);
        if (res) {
          status = status || res.status;
          deposit_status = deposit_status || res.deposit_status;
          pax = pax !== undefined ? pax : res.pax;
        }
      } catch (e) {
        console.warn(`[apiAddLabelsToThread] reservation fetch error: ${e.message}`);
      }
    }
    GmailService.addLabelsAfterDelay(threadId, pax, status, deposit_status);
    return true;
  }, payload, auth.data);
}

/**
 * [NEW] 예약 읽음 처리
 */
function apiMarkReservationAsRead(token, id) {
  const auth = UserService.checkSession(token);
  if (!auth.success) return auth;
  return _executeApi('apiMarkReservationAsRead', () => {
    return ReservationService.markAsRead(id);
  }, { id }, auth.data);
}

function apiSaveSystemSettings(token, type, data) {
  const auth = UserService.checkSession(token);
  if (!auth.success) return auth;
  if (type === 'user' && auth.data.role !== Config.USER_ROLES.ADMIN) return Util.createResponse(false, null, '관리자 권한이 필요합니다.');
  // [Param Log] {type, data} 객체 전달
  return _executeApi(`apiSaveSystemSettings:${type}`, () => {
    const session = UserService.checkSession(token);
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
  }, { type, data }, auth.data);
}

function apiDeleteSystemData(token, type, id) {
  const auth = UserService.checkSession(token);
  if (!auth.success) return auth;
  if (type === 'user' && auth.data.role !== Config.USER_ROLES.ADMIN) return Util.createResponse(false, null, '관리자 권한이 필요합니다.');
  return _executeApi(`apiDeleteSystemData:${type}`, () => {
    const session = UserService.checkSession(token);
    if (!session.success) throw new Error("Unauthorized");

    switch (type) {
      case 'user':
        return UserService.deleteUser(id); // Soft Delete
      case 'mail_template':
        return MailTemplateService.deleteTemplate(id); // Hard Delete
      default:
        return Util.createResponse(false, null, "Unsupported delete type");
    }
  }, { type, id }, auth.data);
}

// ==========================================
// 6. Duplicate Group & Migration API Endpoints
// ==========================================

function apiGetDuplicateGroups(token) {
  const auth = UserService.checkSession(token);
  if (!auth.success) return auth;
  return _executeApi('apiGetDuplicateGroups', () => {
    UserService.checkSession(token);
    return DuplicateGroupService.getAllGroups();
  });
}

function apiCreateManualDuplicateGroup(token, params) {
  const auth = UserService.checkSession(token);
  if (!auth.success) return auth;
  return _executeApi('apiCreateManualDuplicateGroup', () => {
    UserService.checkSession(token);
    return DuplicateGroupService.createManualGroup(params.reservationIds, params.earliestDate);
  }, params, auth.data);
}

function apiClearDuplicateGroup(token, params) {
  const auth = UserService.checkSession(token);
  if (!auth.success) return auth;
  return _executeApi('apiClearDuplicateGroup', () => {
    UserService.checkSession(token);
    return DuplicateGroupService.clearGroup(params.groupId, params.reservationIds, params.earliestDate);
  }, params, auth.data);
}

function apiRemoveManualDuplicateGroup(token, params) {
  const auth = UserService.checkSession(token);
  if (!auth.success) return auth;
  return _executeApi('apiRemoveManualDuplicateGroup', () => {
    UserService.checkSession(token);
    return DuplicateGroupService.removeManualGroup(params.groupId);
  }, params, auth.data);
}

function apiExcludeReservationFromGroup(token, params) {
  const auth = UserService.checkSession(token);
  if (!auth.success) return auth;
  return _executeApi('apiExcludeReservationFromGroup', () => {
    UserService.checkSession(token);
    return DuplicateGroupService.excludeReservationFromGroup(params.groupId, params.reservationId);
  }, params, auth.data);
}

function apiMarkDuplicateMailSent(token, params) {
  const auth = UserService.checkSession(token);
  if (!auth.success) return auth;
  return _executeApi('apiMarkDuplicateMailSent', () => {
    UserService.checkSession(token);
    return DuplicateGroupService.markDuplicateMailSent(params.groupId, params.reservationIds);
  }, params, auth.data);
}

function apiSendDuplicateConfirmationMail(token, params) {
  const auth = UserService.checkSession(token);
  if (!auth.success) return auth;
  return _executeApi('apiSendDuplicateConfirmationMail', () => {
    UserService.checkSession(token);
    const { groupId, threadId, customerName, duplicateReservations, reservationIds } = params;
    if (!threadId) {
      throw new Error('이메일 스레드 ID가 없어 발송할 수 없습니다.');
    }

    const mailRes = GmailService.sendDuplicateConfirmationMail({
      threadId: threadId,
      customerName: customerName,
      duplicateReservations: duplicateReservations || []
    });

    if (!mailRes.success) {
      return mailRes;
    }

    let mailSentAt = new Date().toISOString();
    if (groupId) {
      const markRes = DuplicateGroupService.markDuplicateMailSent(groupId, reservationIds || []);
      if (markRes && markRes.data && markRes.data.mail_sent_at) {
        const val = markRes.data.mail_sent_at;
        mailSentAt = (val instanceof Date) ? val.toISOString() : String(val);
      }
    }

    return Util.createResponse(true, { threadId: threadId, mail_sent_at: mailSentAt }, '중복 확인 메일이 발송되었습니다.');
  }, params, auth.data);
}

function apiRunSchemaMigration(token) {
  const auth = UserService.checkSession(token);
  if (!auth.success) return auth;
  return _executeApi('apiRunSchemaMigration', () => {
    const session = UserService.checkSession(token);
    if (!session.success) throw new Error(session.message);
    if (session.data.role !== Config.USER_ROLES.ADMIN) throw new Error('관리자 권한이 필요합니다.');
    return MigrationService.setup();
  }, null, auth.data);
}

function apiBackfillDuplicateGroups(token) {
  const auth = UserService.checkSession(token);
  if (!auth.success) return auth;
  return _executeApi('apiBackfillDuplicateGroups', () => {
    const session = UserService.checkSession(token);
    if (!session.success) throw new Error(session.message);
    if (session.data.role !== Config.USER_ROLES.ADMIN) throw new Error('관리자 권한이 필요합니다.');
    return MigrationService.backfillFutureDuplicateGroups();
  }, null, auth.data);
}

function apiGetBouncedEmails(token) {
  const auth = UserService.checkSession(token);
  if (!auth.success) return auth;
  return _executeApi('apiGetBouncedEmails', () => {
    UserService.checkSession(token);
    return GmailService.getBouncedEmailDetails();
  });
}
