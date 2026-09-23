/**
 * [DuplicateGroupService] 중복 예약 그룹 관리 및 비즈니스 로직 (Singleton)
 * - 구글 시트(duplicate_group)를 DB로 사용 (1 row = 1 reservation)
 * - group_id 채번 규칙: [가장 빠른 예약일시 YYYYMMDD]_[순번 01, 02...]
 * - 스키마 정의는 MigrationService.SCHEMA에서 중앙 관리
 */
const DuplicateGroupService = {
  /**
   * duplicate_group 시트 반환
   */
  _getSheet() {
    const ss = Util.getSpreadsheet();
    return ss.getSheetByName(Config.SHEET_NAMES.DUPLICATE_GROUP);
  },

  /**
   * [Helper] YYYYMMDD_01 형식의 group_id 생성
   * @param {string|Date} dateHint - 기준 날짜 (예약일시 또는 오늘)
   * @returns {string} 예: '20260922_01'
   */
  _generateGroupId(dateHint) {
    const sheet = this._getSheet();
    let ymd = '';

    if (dateHint) {
      const d = new Date(dateHint);
      if (!isNaN(d.getTime())) {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        ymd = `${y}${m}${day}`;
      }
    }

    if (!ymd) {
      const now = new Date();
      const y = now.getFullYear();
      const m = String(now.getMonth() + 1).padStart(2, '0');
      const day = String(now.getDate()).padStart(2, '0');
      ymd = `${y}${m}${day}`;
    }

    if (!sheet) {
      return `${ymd}_01`;
    }

    // 시트에서 기존 group_id들을 조회하여 해당 날짜의 최대 순번 찾기
    const data = sheet.getDataRange().getValues();
    if (data.length <= 1) return `${ymd}_01`;

    const headers = data[0];
    const grpIdx = headers.indexOf('group_id');
    if (grpIdx === -1) return `${ymd}_01`;

    let maxSeq = 0;
    const prefix = `${ymd}_`;

    for (let i = 1; i < data.length; i++) {
      const gid = String(data[i][grpIdx] || '').trim();
      if (gid.startsWith(prefix)) {
        const seqPart = gid.substring(prefix.length);
        const seqNum = parseInt(seqPart, 10);
        if (!isNaN(seqNum) && seqNum > maxSeq) {
          maxSeq = seqNum;
        }
      }
    }

    const nextSeq = String(maxSeq + 1).padStart(2, '0');
    return `${ymd}_${nextSeq}`;
  },

  /**
   * [Read] 모든 중복 그룹 데이터 조회 (group_id 기준 집계)
   * @returns {Array<Object>}
   */
  getAllGroups() {
    try {
      const sheet = this._getSheet();
      if (!sheet) {
        console.log(`[DuplicateGroupService] '${Config.SHEET_NAMES.DUPLICATE_GROUP}' 시트가 아직 생성되지 않았습니다.`);
        return [];
      }

      const rows = Util.getSheetDataAsObjects(Config.SHEET_NAMES.DUPLICATE_GROUP);
      if (!rows || rows.length === 0) return [];

      const groupMap = {};

      rows.forEach(r => {
        const gid = r.group_id;
        if (!gid) return;

        if (!groupMap[gid]) {
          groupMap[gid] = {
            id: gid,
            group_id: gid,
            reservation_ids: [],
            parsed_ids: [],
            group_type: r.group_type || Config.DUPLICATE_GROUP_TYPE.AUTO,
            status: r.status || Config.DUPLICATE_GROUP_STATUS.ACTIVE,
            created_at: r.created_at || null,
            updated_at: r.updated_at || null,
            mail_sent_at: r.mail_sent_at || null
          };
        } else if (r.mail_sent_at && !groupMap[gid].mail_sent_at) {
          groupMap[gid].mail_sent_at = r.mail_sent_at;
        }

        if (r.reservation_id) {
          const resId = String(r.reservation_id).trim();
          if (resId && !groupMap[gid].reservation_ids.includes(resId)) {
            groupMap[gid].reservation_ids.push(resId);
            groupMap[gid].parsed_ids.push(resId);
          }
        }
      });

      return Object.values(groupMap);
    } catch (e) {
      console.log(`[DuplicateGroupService] getAllGroups Error: ${e.message}`);
      return [];
    }
  },

  /**
   * [Create/Update] 중복 그룹 저장 (1행당 1개 예약씩 저장)
   * @param {Object} groupData
   */
  saveGroup(groupData) {
    try {
      const sheet = this._getSheet();
      if (!sheet) {
        throw new Error(`'${Config.SHEET_NAMES.DUPLICATE_GROUP}' 시트가 존재하지 않습니다. 먼저 runSchemaMigration을 실행해 주세요.`);
      }

      const allData = sheet.getDataRange().getValues();
      const headers = allData[0];
      const grpIdx = headers.indexOf('group_id');
      const mailSentAtIdx = headers.indexOf('mail_sent_at');
      const createdAtIdx = headers.indexOf('created_at');
      const now = new Date();

      if (grpIdx === -1) throw new Error('group_id 컬럼을 찾을 수 없습니다.');

      // 예약 ID 목록 정규화
      let resIds = [];
      if (Array.isArray(groupData.reservation_ids)) {
        resIds = groupData.reservation_ids;
      } else if (typeof groupData.reservation_ids === 'string') {
        resIds = groupData.reservation_ids.split(',').map(s => s.trim()).filter(Boolean);
      }

      // group_id 결정
      let targetGroupId = groupData.group_id || groupData.id;
      if (!targetGroupId) {
        targetGroupId = this._generateGroupId(groupData.earliest_date);
      }

      // 기존 해당 group_id의 행이 있다면 메타데이터(mail_sent_at, created_at) 보존 및 삭제 준비
      let rowIndicesToDelete = [];
      let existingMailSentAt = '';
      let existingCreatedAt = null;

      for (let i = 1; i < allData.length; i++) {
        if (allData[i][grpIdx] === targetGroupId) {
          rowIndicesToDelete.push(i + 1);
          if (!existingMailSentAt && mailSentAtIdx !== -1 && allData[i][mailSentAtIdx]) {
            existingMailSentAt = allData[i][mailSentAtIdx];
          }
          if (!existingCreatedAt && createdAtIdx !== -1 && allData[i][createdAtIdx]) {
            existingCreatedAt = allData[i][createdAtIdx];
          }
        }
      }

      // 역순으로 기존 행 삭제
      for (let k = rowIndicesToDelete.length - 1; k >= 0; k--) {
        sheet.deleteRow(rowIndicesToDelete[k]);
      }

      // 신규 행들 생성 (1개 예약당 1개 행)
      const groupType = groupData.group_type || Config.DUPLICATE_GROUP_TYPE.AUTO;
      const status = groupData.status || Config.DUPLICATE_GROUP_STATUS.ACTIVE;

      const newRows = resIds.map((resId, idx) => {
        const rowId = `dg_${now.getTime()}_${idx + 1}`;
        return headers.map(header => {
          switch (header) {
            case 'id':
              return rowId;
            case 'group_id':
              return targetGroupId;
            case 'reservation_id':
              return resId;
            case 'group_type':
              return groupType;
            case 'status':
              return status;
            case 'mail_sent_at':
              return groupData.mail_sent_at || existingMailSentAt || '';
            case 'created_at':
              return groupData.created_at || existingCreatedAt || now;
            case 'updated_at':
              return now;
            default:
              return groupData[header] || '';
          }
        });
      });

      if (newRows.length > 0) {
        const startRow = sheet.getLastRow() + 1;
        sheet.getRange(startRow, 1, newRows.length, headers.length).setValues(newRows);
        console.log(`[DuplicateGroupService] 그룹 저장 완료: ${targetGroupId} (${newRows.length}개 예약 행)`);
      }

      return Util.createResponse(true, { group_id: targetGroupId, id: targetGroupId }, '그룹 저장 완료');
    } catch (e) {
      console.log(`[DuplicateGroupService] saveGroup Error: ${e.message}`);
      return Util.createResponse(false, null, e.message);
    }
  },

  /**
   * [Action] 수동 중복 그룹 생성
   * @param {Array<string>} reservationIds
   * @param {string|Date} earliestDate
   */
  createManualGroup(reservationIds, earliestDate = null) {
    if (!reservationIds || reservationIds.length < 2) {
      return Util.createResponse(false, null, '최소 2건 이상의 예약을 선택해야 중복 그룹으로 묶을 수 있습니다.');
    }

    const groupId = this._generateGroupId(earliestDate);

    return this.saveGroup({
      group_id: groupId,
      id: groupId,
      reservation_ids: reservationIds,
      group_type: Config.DUPLICATE_GROUP_TYPE.MANUAL,
      status: Config.DUPLICATE_GROUP_STATUS.ACTIVE,
      earliest_date: earliestDate
    });
  },

  /**
   * [Action] 중복 아님 처리 (알림 및 중복 그룹에서 제외)
   * @param {string} groupId - 기존 그룹 ID (없을 경우 신규 채번)
   * @param {Array<string>} reservationIds - 묶여 있던 예약 ID들
   * @param {string|Date} earliestDate - 기준 일자
   */
  clearGroup(groupId, reservationIds = [], earliestDate = null) {
    const targetGid = groupId || this._generateGroupId(earliestDate);
    return this.saveGroup({
      group_id: targetGid,
      id: targetGid,
      reservation_ids: reservationIds,
      status: Config.DUPLICATE_GROUP_STATUS.CLEARED,
      earliest_date: earliestDate
    });
  },

  /**
   * [Action] 수동 그룹 해제 (삭제)
   * @param {string} groupId
   */
  removeManualGroup(groupId) {
    try {
      const sheet = this._getSheet();
      if (!sheet) {
        throw new Error(`'${Config.SHEET_NAMES.DUPLICATE_GROUP}' 시트가 존재하지 않습니다.`);
      }

      const allData = sheet.getDataRange().getValues();
      const grpIdx = allData[0].indexOf('group_id');
      if (grpIdx === -1) throw new Error('group_id 컬럼 없음');

      const rowsToDelete = [];
      for (let i = 1; i < allData.length; i++) {
        if (allData[i][grpIdx] === groupId) {
          rowsToDelete.push(i + 1);
        }
      }

      if (rowsToDelete.length === 0) {
        return Util.createResponse(false, null, '해당 그룹을 찾을 수 없습니다.');
      }

      // 역순 삭제
      for (let k = rowsToDelete.length - 1; k >= 0; k--) {
        sheet.deleteRow(rowsToDelete[k]);
      }

      console.log(`[DuplicateGroupService] 수동 그룹 삭제 완료: ${groupId} (${rowsToDelete.length}행 삭제)`);
      return Util.createResponse(true, null, '수동 그룹이 해제되었습니다.');
    } catch (e) {
      console.log(`[DuplicateGroupService] removeManualGroup Error: ${e.message}`);
      return Util.createResponse(false, null, e.message);
    }
  },

  /**
   * [Action] 특정 중복 그룹에서 단일 예약 제외
   * @param {string} groupId
   * @param {string} reservationId
   */
  excludeReservationFromGroup(groupId, reservationId) {
    try {
      const sheet = this._getSheet();
      if (!sheet) {
        throw new Error(`'${Config.SHEET_NAMES.DUPLICATE_GROUP}' 시트가 존재하지 않습니다.`);
      }

      const allData = sheet.getDataRange().getValues();
      if (allData.length <= 1) {
        return Util.createResponse(true, null, '제외 완료');
      }

      const grpIdx = allData[0].indexOf('group_id');
      const resIdx = allData[0].indexOf('reservation_id');
      if (grpIdx === -1 || resIdx === -1) {
        throw new Error('group_id 또는 reservation_id 컬럼을 찾을 수 없습니다.');
      }

      const rowsToDelete = [];
      let remainingGroupRowsCount = 0;

      for (let i = 1; i < allData.length; i++) {
        const gid = String(allData[i][grpIdx]).trim();
        const rid = String(allData[i][resIdx]).trim();
        if (gid === String(groupId).trim()) {
          if (rid === String(reservationId).trim()) {
            rowsToDelete.push(i + 1);
          } else {
            remainingGroupRowsCount++;
          }
        }
      }

      // 해당 예약 행 삭제 (역순)
      for (let k = rowsToDelete.length - 1; k >= 0; k--) {
        sheet.deleteRow(rowsToDelete[k]);
      }

      // 그룹 내 남은 예약이 1건 이하인 경우, 그룹 해제(삭제)하여 단독 예약 중복 고아 방지
      if (remainingGroupRowsCount <= 1) {
        const freshData = sheet.getDataRange().getValues();
        const orphanRows = [];
        for (let i = 1; i < freshData.length; i++) {
          if (String(freshData[i][grpIdx]).trim() === String(groupId).trim()) {
            orphanRows.push(i + 1);
          }
        }
        for (let k = orphanRows.length - 1; k >= 0; k--) {
          sheet.deleteRow(orphanRows[k]);
        }
      }

      // 제외된 예약은 개별 CLEARED로 기록하여 향후 자동 배치 재묶임 방지
      this.saveGroup({
        group_id: `cleared_${reservationId}`,
        id: `cleared_${reservationId}`,
        reservation_ids: [reservationId],
        group_type: Config.DUPLICATE_GROUP_TYPE.AUTO,
        status: Config.DUPLICATE_GROUP_STATUS.CLEARED
      });

      console.log(`[DuplicateGroupService] 그룹(${groupId})에서 예약(${reservationId}) 제외 완료`);
      return Util.createResponse(true, { groupId: groupId, reservationId: reservationId }, '중복 그룹에서 제외되었습니다.');
    } catch (e) {
      console.log(`[DuplicateGroupService] excludeReservationFromGroup Error: ${e.message}`);
      return Util.createResponse(false, null, e.message);
    }
  },

  /**
   * [Action] 중복 안내 메일 발송 일시 기록
   * @param {string} groupId
   * @param {Array<string>} reservationIds
   */
  markDuplicateMailSent(groupId, reservationIds = []) {
    try {
      const sheet = this._getSheet();
      if (!sheet) {
        throw new Error(`'${Config.SHEET_NAMES.DUPLICATE_GROUP}' 시트가 존재하지 않습니다.`);
      }

      const allData = sheet.getDataRange().getValues();
      const now = new Date();
      const nowIso = now.toISOString();

      if (allData.length <= 1) {
        const saveRes = this.saveGroup({
          group_id: groupId,
          id: groupId,
          reservation_ids: reservationIds,
          group_type: Config.DUPLICATE_GROUP_TYPE.AUTO,
          status: Config.DUPLICATE_GROUP_STATUS.ACTIVE,
          mail_sent_at: now
        });
        if (saveRes && saveRes.success) {
          saveRes.data = { ...saveRes.data, mail_sent_at: nowIso };
        }
        return saveRes;
      }

      const headers = allData[0];
      const grpIdx = headers.indexOf('group_id');
      const mailSentIdx = headers.indexOf('mail_sent_at');
      const updatedIdx = headers.indexOf('updated_at');

      if (grpIdx === -1 || mailSentIdx === -1) {
        throw new Error('group_id 또는 mail_sent_at 컬럼을 찾을 수 없습니다.');
      }

      const matchedRows = [];
      for (let i = 1; i < allData.length; i++) {
        if (allData[i][grpIdx] === groupId) {
          matchedRows.push(i + 1);
        }
      }

      if (matchedRows.length === 0) {
        const saveRes = this.saveGroup({
          group_id: groupId,
          id: groupId,
          reservation_ids: reservationIds,
          group_type: Config.DUPLICATE_GROUP_TYPE.AUTO,
          status: Config.DUPLICATE_GROUP_STATUS.ACTIVE,
          mail_sent_at: now
        });
        if (saveRes && saveRes.success) {
          saveRes.data = { ...saveRes.data, mail_sent_at: nowIso };
        }
        return saveRes;
      }

      matchedRows.forEach(rowNum => {
        sheet.getRange(rowNum, mailSentIdx + 1).setValue(now);
        if (updatedIdx !== -1) {
          sheet.getRange(rowNum, updatedIdx + 1).setValue(now);
        }
      });

      console.log(`[DuplicateGroupService] 메일 발송 일시 기록 완료: ${groupId} (${matchedRows.length}행)`);
      return Util.createResponse(true, { group_id: groupId, mail_sent_at: nowIso }, '중복 안내 메일 발송 일시가 기록되었습니다.');
    } catch (e) {
      console.log(`[DuplicateGroupService] markDuplicateMailSent Error: ${e.message}`);
      return Util.createResponse(false, null, e.message);
    }
  },

  /**
   * [Match Logic] 두 예약 간 중복 조건 판별
   * @param {Object} a
   * @param {Object} b
   * @returns {{ isDuplicate: boolean, reasons: Array<string> }}
   */
  isDuplicate(a, b) {
    const reasons = [];
    const emailA = String(a.email || '').trim().toLowerCase();
    const emailB = String(b.email || '').trim().toLowerCase();
    const normA = Util.getNormalizedEmail(a.email);
    const normB = Util.getNormalizedEmail(b.email);

    if (emailA && emailB) {
      if (emailA === emailB) {
        reasons.push('동일 이메일');
      } else if (normA && normB && normA === normB) {
        reasons.push(`이메일 오타 유사 (${normA})`);
      }
    }

    const nameA = String(a.customer_name || '').trim().toLowerCase();
    const nameB = String(b.customer_name || '').trim().toLowerCase();
    if (nameA && nameB && nameA.length >= 2 && nameA === nameB) {
      reasons.push('동일 고객명');
    }

    const phoneA = String(a.phone_number || '').replace(/\D/g, '');
    const phoneB = String(b.phone_number || '').replace(/\D/g, '');
    if (phoneA && phoneB && phoneA.length >= 8 && phoneA === phoneB) {
      reasons.push('동일 전화번호');
    }

    return {
      isDuplicate: reasons.length > 0,
      reasons: reasons
    };
  },

  /**
   * [Batch] 신규 예약 유입 시 오늘 이후 활성 예약 풀과 중복 감지 및 시트 연결
   * @param {Object} newRes
   */
  linkDuplicateIfAny(newRes) {
    try {
      if (!newRes || !newRes.id || !newRes.reservation_date) return null;
      if (newRes.status !== Config.RESERVATION_STATUS.PENDING && newRes.status !== Config.RESERVATION_STATUS.CONFIRM) {
        return null;
      }

      const todayStartMs = new Date().setHours(0, 0, 0, 0);
      const resTime = new Date(newRes.reservation_date).getTime();
      if (isNaN(resTime) || resTime < todayStartMs) return null;

      // 1. 기존 중복 그룹 시트에서 해제/제외된 목록 및 활성 그룹 맵 조회
      const existingGroups = Util.getSheetDataAsObjects(Config.SHEET_NAMES.DUPLICATE_GROUP);
      const clearedPairs = new Set();
      const clearedSingleIds = new Set();
      const activeResToGroupMap = {};

      existingGroups.forEach(g => {
        const resId = String(g.reservation_id || '').trim();
        const gid = String(g.group_id || '').trim();
        if (g.status === Config.DUPLICATE_GROUP_STATUS.CLEARED) {
          clearedSingleIds.add(resId);
        } else if (g.status === Config.DUPLICATE_GROUP_STATUS.ACTIVE && resId && gid) {
          activeResToGroupMap[resId] = gid;
        }
      });

      if (clearedSingleIds.has(newRes.id)) return null;

      // 2. reservation 시트에서 오늘 이후 활성 예약들만 필터링
      const allReservations = Util.getSheetDataAsObjects(Config.SHEET_NAMES.RESERVATION);
      const candidates = allReservations.filter(r => {
        if (r.id === newRes.id) return false;
        if (r.status !== Config.RESERVATION_STATUS.PENDING && r.status !== Config.RESERVATION_STATUS.CONFIRM) return false;
        if (clearedSingleIds.has(r.id)) return false;
        const t = new Date(r.reservation_date).getTime();
        return !isNaN(t) && t >= todayStartMs;
      });

      const matchingCandidates = [];
      candidates.forEach(c => {
        const pairKey = newRes.id < c.id ? `${newRes.id}_${c.id}` : `${c.id}_${newRes.id}`;
        if (clearedPairs.has(pairKey)) return;

        const match = this.isDuplicate(newRes, c);
        if (match.isDuplicate) {
          matchingCandidates.push(c);
        }
      });

      if (matchingCandidates.length === 0) return null;

      // 3. 매칭된 기존 예약들 중 이미 활성 그룹에 속한 건이 있는지 확인
      let targetGroupId = null;
      for (let i = 0; i < matchingCandidates.length; i++) {
        const gid = activeResToGroupMap[matchingCandidates[i].id];
        if (gid) {
          targetGroupId = gid;
          break;
        }
      }

      const sheet = this._getSheet();
      if (!sheet) return null;
      const headers = sheet.getDataRange().getValues()[0];
      const now = new Date();

      if (targetGroupId) {
        // 기존 그룹에 신규 예약 추가 (1행 append)
        const rowId = `dg_${now.getTime()}_1`;
        const newRow = headers.map(header => {
          switch (header) {
            case 'id': return rowId;
            case 'group_id': return targetGroupId;
            case 'reservation_id': return newRes.id;
            case 'group_type': return Config.DUPLICATE_GROUP_TYPE.AUTO;
            case 'status': return Config.DUPLICATE_GROUP_STATUS.ACTIVE;
            case 'created_at': return now;
            case 'updated_at': return now;
            default: return '';
          }
        });
        sheet.appendRow(newRow);
        console.log(`[DuplicateGroupService] 기존 중복 그룹(${targetGroupId})에 신규 예약(${newRes.id}) 추가 완료`);
        return targetGroupId;
      } else {
        // 신규 중복 그룹 생성
        const allMemberIds = [newRes.id, ...matchingCandidates.map(c => c.id)];
        const earliestTime = Math.min(resTime, ...matchingCandidates.map(c => new Date(c.reservation_date).getTime() || resTime));
        const res = this.saveGroup({
          reservation_ids: allMemberIds,
          group_type: Config.DUPLICATE_GROUP_TYPE.AUTO,
          status: Config.DUPLICATE_GROUP_STATUS.ACTIVE,
          earliest_date: new Date(earliestTime)
        });
        console.log(`[DuplicateGroupService] 신규 중복 그룹 생성 완료: ${res.data?.group_id} (${allMemberIds.length}건)`);
        return res.data?.group_id;
      }
    } catch (e) {
      console.log(`[DuplicateGroupService] linkDuplicateIfAny Error: ${e.message}`);
      return null;
    }
  },

  /**
   * [Cancellation Sync] 예약이 취소(cancel)되었을 때 duplicate_group 시트 정리
   * @param {string} reservationId
   */
  handleReservationCancelled(reservationId) {
    try {
      if (!reservationId) return;
      const sheet = this._getSheet();
      if (!sheet) return;

      const allData = sheet.getDataRange().getValues();
      if (allData.length <= 1) return;

      const headers = allData[0];
      const grpIdx = headers.indexOf('group_id');
      const resIdx = headers.indexOf('reservation_id');
      if (grpIdx === -1 || resIdx === -1) return;

      // 1. 해당 예약이 속한 행 찾기
      const affectedGroupIds = new Set();
      const rowsToDelete = [];

      for (let i = 1; i < allData.length; i++) {
        if (String(allData[i][resIdx]).trim() === String(reservationId).trim()) {
          rowsToDelete.push(i + 1);
          const gid = allData[i][grpIdx];
          if (gid) affectedGroupIds.add(gid);
        }
      }

      if (rowsToDelete.length === 0) return;

      // 취소된 예약 행 삭제 (역순)
      for (let k = rowsToDelete.length - 1; k >= 0; k--) {
        sheet.deleteRow(rowsToDelete[k]);
      }
      console.log(`[DuplicateGroupService] 취소 예약 행 삭제: ${reservationId} (${rowsToDelete.length}행)`);

      // 2. 영향을 받은 그룹들 중 남은 행이 1건 이하인 경우 잔여 행 정리 (고아 그룹 방지)
      const freshData = sheet.getDataRange().getValues();
      const groupCountMap = {};
      for (let i = 1; i < freshData.length; i++) {
        const gid = freshData[i][grpIdx];
        if (gid && affectedGroupIds.has(gid)) {
          groupCountMap[gid] = (groupCountMap[gid] || 0) + 1;
        }
      }

      const orphanRowsToDelete = [];
      for (let i = 1; i < freshData.length; i++) {
        const gid = freshData[i][grpIdx];
        if (gid && affectedGroupIds.has(gid) && groupCountMap[gid] <= 1) {
          orphanRowsToDelete.push(i + 1);
        }
      }

      for (let k = orphanRowsToDelete.length - 1; k >= 0; k--) {
        sheet.deleteRow(orphanRowsToDelete[k]);
      }
      if (orphanRowsToDelete.length > 0) {
        console.log(`[DuplicateGroupService] 1건 이하 고아 그룹 행 정리: ${orphanRowsToDelete.length}행 삭제`);
      }
    } catch (e) {
      console.log(`[DuplicateGroupService] handleReservationCancelled Error: ${e.message}`);
    }
  },

  /**
   * [Backfill] 오늘 이후 예약 대상 중복 그룹 1회 일괄 검출 및 duplicate_group 시트 적재
   */
  backfillFutureDuplicateGroups() {
    try {
      const todayStartMs = new Date().setHours(0, 0, 0, 0);
      const allReservations = Util.getSheetDataAsObjects(Config.SHEET_NAMES.RESERVATION);

      // 오늘 이후 비취소(pending, confirm) 예약 대상
      const candidates = allReservations.filter(r => {
        if (r.status !== Config.RESERVATION_STATUS.PENDING && r.status !== Config.RESERVATION_STATUS.CONFIRM) return false;
        const t = new Date(r.reservation_date).getTime();
        return !isNaN(t) && t >= todayStartMs;
      });

      console.log(`[Backfill] 오늘 이후 중복 검사 대상 예약 수: ${candidates.length}건`);

      // 기존 시트 데이터
      const existingGroups = Util.getSheetDataAsObjects(Config.SHEET_NAMES.DUPLICATE_GROUP);
      const clearedSingleIds = new Set();
      const clearedPairs = new Set();
      const manualGroupResIds = new Set();
      const existingGroupResMap = {}; // resId -> groupId

      existingGroups.forEach(g => {
        const resId = String(g.reservation_id || '').trim();
        const gid = String(g.group_id || '').trim();
        if (g.status === Config.DUPLICATE_GROUP_STATUS.CLEARED) {
          clearedSingleIds.add(resId);
        } else if (g.status === Config.DUPLICATE_GROUP_STATUS.ACTIVE) {
          if (g.group_type === Config.DUPLICATE_GROUP_TYPE.MANUAL) {
            manualGroupResIds.add(resId);
          } else if (resId && gid) {
            existingGroupResMap[resId] = gid;
          }
        }
      });

      // 수동 그룹 또는 개별 중복아님 처리된 예약 제외
      const validCandidates = candidates.filter(r => !clearedSingleIds.has(r.id) && !manualGroupResIds.has(r.id));

      // Union-Find 클러스터링
      const parent = {};
      const find = (i) => {
        if (parent[i] === undefined) parent[i] = i;
        if (parent[i] === i) return i;
        return parent[i] = find(parent[i]);
      };
      const union = (i, j) => {
        const rootI = find(i);
        const rootJ = find(j);
        if (rootI !== rootJ) parent[rootI] = rootJ;
      };

      for (let i = 0; i < validCandidates.length; i++) {
        for (let j = i + 1; j < validCandidates.length; j++) {
          const a = validCandidates[i];
          const b = validCandidates[j];
          const pairKey = a.id < b.id ? `${a.id}_${b.id}` : `${b.id}_${a.id}`;
          if (clearedPairs.has(pairKey)) continue;

          if (this.isDuplicate(a, b).isDuplicate) {
            union(a.id, b.id);
          }
        }
      }

      const clusters = {};
      validCandidates.forEach(c => {
        const root = find(c.id);
        if (!clusters[root]) clusters[root] = [];
        clusters[root].push(c);
      });

      const clusterList = Object.values(clusters).filter(c => c.length >= 2);
      clusterList.sort((c1, c2) => {
        const t1 = Math.min(...c1.map(r => new Date(r.reservation_date).getTime() || 0));
        const t2 = Math.min(...c2.map(r => new Date(r.reservation_date).getTime() || 0));
        return t1 - t2;
      });

      let createdCount = 0;
      let updatedCount = 0;

      clusterList.forEach(cluster => {
        const memberIds = cluster.map(r => r.id);
        const earliestTime = Math.min(...cluster.map(r => new Date(r.reservation_date).getTime() || 0));
        
        // 이미 시트에 저장된 group_id가 있는지 확인
        let existingGroupId = null;
        for (let i = 0; i < memberIds.length; i++) {
          if (existingGroupResMap[memberIds[i]]) {
            existingGroupId = existingGroupResMap[memberIds[i]];
            break;
          }
        }

        const res = this.saveGroup({
          group_id: existingGroupId || null,
          reservation_ids: memberIds,
          group_type: Config.DUPLICATE_GROUP_TYPE.AUTO,
          status: Config.DUPLICATE_GROUP_STATUS.ACTIVE,
          earliest_date: new Date(earliestTime)
        });

        if (res.success) {
          if (existingGroupId) updatedCount++;
          else createdCount++;
        }
      });

      console.log(`[Backfill] 완료: 신규 생성 ${createdCount}개 그룹, 기존 갱신 ${updatedCount}개 그룹`);
      return Util.createResponse(true, {
        totalClusters: clusterList.length,
        createdGroups: createdCount,
        updatedGroups: updatedCount
      }, `오늘 이후 중복 그룹 백필 완료 (신규 ${createdCount}건, 갱신 ${updatedCount}건)`);
    } catch (e) {
      console.log(`[Backfill] Error: ${e.message}`);
      return Util.createResponse(false, null, e.message);
    }
  }
};


