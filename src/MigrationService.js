/**
 * [MigrationService] 데이터베이스(시트) 스키마 점검 및 마이그레이션 관리 (Singleton)
 * - jsog 패턴 기반: SCHEMA 내 name 및 type('TEXT', 'DATE_TIME', 'DATE', 'BOOLEAN', 'DOUBLE', 'CURRENCY') 정의
 * - Sheets Advanced API를 활용한 Native Table 생성 및 기존 시트 누락 컬럼 자동 추가
 * - 수동 실행 전용 (runSchemaMigration() 함수를 통해 관리자가 수동 실행)
 */
const MigrationService = {
  SCHEMA: {
    user: [
      { name: 'id', type: 'TEXT' },
      { name: 'user_email', type: 'TEXT' },
      { name: 'user_name', type: 'TEXT' },
      { name: 'role', type: 'TEXT' },
      { name: 'enabled', type: 'BOOLEAN' },
      { name: 'created_at', type: 'DATE_TIME' },
      { name: 'updated_at', type: 'DATE_TIME' }
    ],
    reservation: [
      { name: 'id', type: 'TEXT' },
      { name: 'response_id', type: 'TEXT' },
      { name: 'booking_request_date', type: 'DATE_TIME' },
      { name: 'branch_id', type: 'TEXT' },
      { name: 'reservation_date', type: 'DATE_TIME' },
      { name: 'customer_name', type: 'TEXT' },
      { name: 'pax', type: 'DOUBLE' },
      { name: 'notes', type: 'TEXT' },
      { name: 'phone_number', type: 'TEXT' },
      { name: 'email', type: 'TEXT' },
      { name: 'email_thread_id', type: 'TEXT' },
      { name: 'calendar_id', type: 'TEXT' },
      { name: 'event_id', type: 'TEXT' },
      { name: 'status', type: 'TEXT' },
      { name: 'is_read', type: 'BOOLEAN' },
      { name: 'message_sent_at', type: 'DATE_TIME' },
      { name: 'internal_notes', type: 'TEXT' },
      { name: 'private_notes', type: 'TEXT' },
      { name: 'deposit_status', type: 'TEXT' },
      { name: 'deposit_amount', type: 'CURRENCY' },
      { name: 'deposit_paid_at', type: 'DATE_TIME' },
      { name: 'deposit_refund_at', type: 'DATE_TIME' },
      { name: 'created_at', type: 'DATE_TIME' },
      { name: 'updated_at', type: 'DATE_TIME' }
    ],
    branch: [
      { name: 'id', type: 'TEXT' },
      { name: 'branch_name_en', type: 'TEXT' },
      { name: 'branch_name_ko', type: 'TEXT' },
      { name: 'address', type: 'TEXT' },
      { name: 'google_map_link', type: 'TEXT' },
      { name: 'enabled', type: 'BOOLEAN' },
      { name: 'calendar_id', type: 'TEXT' },
      { name: 'created_at', type: 'DATE_TIME' },
      { name: 'updated_at', type: 'DATE_TIME' }
    ],
    user_branch_permission: [
      { name: 'id', type: 'TEXT' },
      { name: 'user_id', type: 'TEXT' },
      { name: 'branch_id', type: 'TEXT' },
      { name: 'enabled', type: 'BOOLEAN' },
      { name: 'created_at', type: 'DATE_TIME' },
      { name: 'updated_at', type: 'DATE_TIME' }
    ],
    slot_master: [
      { name: 'id', type: 'TEXT' },
      { name: 'time', type: 'TIME' },
      { name: 'slot', type: 'DOUBLE' },
      { name: 'enabled', type: 'BOOLEAN' },
      { name: 'created_at', type: 'DATE_TIME' },
      { name: 'updated_at', type: 'DATE_TIME' }
    ],
    slot_default: [
      { name: 'id', type: 'TEXT' },
      { name: 'branch_id', type: 'TEXT' },
      { name: 'slot_master_id', type: 'TEXT' },
      { name: 'slot', type: 'DOUBLE' },
      { name: 'enabled', type: 'BOOLEAN' },
      { name: 'created_at', type: 'DATE_TIME' },
      { name: 'updated_at', type: 'DATE_TIME' }
    ],
    slot_override: [
      { name: 'id', type: 'TEXT' },
      { name: 'branch_id', type: 'TEXT' },
      { name: 'slot_master_id', type: 'TEXT' },
      { name: 'date', type: 'DATE' },
      { name: 'slot', type: 'DOUBLE' },
      { name: 'reason', type: 'TEXT' },
      { name: 'enabled', type: 'BOOLEAN' },
      { name: 'created_at', type: 'DATE_TIME' },
      { name: 'updated_at', type: 'DATE_TIME' }
    ],
    mail_template: [
      { name: 'id', type: 'TEXT' },
      { name: 'template_name', type: 'TEXT' },
      { name: 'body_html', type: 'TEXT' },
      { name: 'enabled', type: 'BOOLEAN' },
      { name: 'created_at', type: 'DATE_TIME' },
      { name: 'updated_at', type: 'DATE_TIME' }
    ],
    duplicate_group: [
      { name: 'id', type: 'TEXT' },
      { name: 'group_id', type: 'TEXT' },
      { name: 'reservation_id', type: 'TEXT' },
      { name: 'group_type', type: 'TEXT' },
      { name: 'status', type: 'TEXT' },
      { name: 'mail_sent_at', type: 'DATE_TIME' },
      { name: 'created_at', type: 'DATE_TIME' },
      { name: 'updated_at', type: 'DATE_TIME' }
    ]
  },

  /**
   * 시트 및 필수 컬럼 일괄 점검 & 마이그레이션 실행
   * @returns {Object} { success: boolean, results: Array<string> }
   */
  setup() {
    const ss = Util.getSpreadsheet();
    const results = [];
    console.log('🚀 [MigrationService] 스키마 마이그레이션 시작...');

    for (const [sheetName, columnsConfig] of Object.entries(this.SCHEMA)) {
      const logMsg = this._ensureTable(ss, sheetName, columnsConfig);
      if (logMsg) results.push(logMsg);
    }

    console.log('✨ [MigrationService] 스키마 마이그레이션 완료.');
    return { success: true, results: results };
  },

  /**
   * 신규 시트인 경우 생성 및 Native Table 변환, 기존 시트인 경우 누락 컬럼 추가
   */
  _ensureTable(ss, sheetName, columnsConfig) {
    let sheet = ss.getSheetByName(sheetName);
    const requiredColumnNames = columnsConfig.map(col => col.name);

    if (!sheet) {
      console.log(`[Migration] Creating new sheet: '${sheetName}'`);
      sheet = ss.insertSheet(sheetName);
      sheet.appendRow(requiredColumnNames);

      const sheetId = sheet.getSheetId();
      const maxRows = sheet.getMaxRows();

      const columnProperties = columnsConfig.map((col, index) => {
        return {
          columnIndex: index,
          columnName: col.name,
          columnType: col.type
        };
      });

      const resource = {
        requests: [
          {
            addTable: {
              table: {
                name: sheetName,
                range: {
                  sheetId: sheetId,
                  startRowIndex: 0,
                  endRowIndex: maxRows,
                  startColumnIndex: 0,
                  endColumnIndex: columnsConfig.length
                },
                columnProperties: columnProperties
              }
            }
          }
        ]
      };

      try {
        Sheets.Spreadsheets.batchUpdate(resource, ss.getId());
        console.log(`[Migration] Successfully converted '${sheetName}' into a Native Table.`);
      } catch (e) {
        console.error(`[Migration] Error creating Native Table for '${sheetName}': ${e.message}`);
      }

      try {
        sheet.setFrozenRows(1);
        const headerRange = sheet.getRange(1, 1, 1, columnsConfig.length);
        headerRange.setFontWeight('bold');
        headerRange.setBackground('#f3f3f3');

        const currentMaxRows = sheet.getMaxRows();
        if (currentMaxRows > 1) {
          sheet.getRange(2, 1, currentMaxRows - 1, sheet.getLastColumn()).clear();
          if (currentMaxRows > 2) {
            sheet.deleteRows(3, currentMaxRows - 2);
          }
        }
      } catch (cleanupError) {
        console.warn(`[Migration] Warning cleaning rows for '${sheetName}': ${cleanupError.message}`);
      }

      return `[생성] '${sheetName}' 시트 생성 완료 (${columnsConfig.length}개 컬럼)`;
    }

    const lastCol = sheet.getLastColumn();
    if (lastCol === 0) {
      console.log(`[Migration] Sheet '${sheetName}' is empty. Appending headers.`);
      sheet.appendRow(requiredColumnNames);
      sheet.setFrozenRows(1);
      const headerRange = sheet.getRange(1, 1, 1, requiredColumnNames.length);
      headerRange.setFontWeight('bold').setBackground('#f3f3f3');
      return `[초기화] '${sheetName}' 헤더 추가 완료`;
    }

    const headerRange = sheet.getRange(1, 1, 1, lastCol);
    const existingColumns = headerRange.getValues()[0];
    const missingColumns = requiredColumnNames.filter(col => !existingColumns.includes(col));

    if (missingColumns.length > 0) {
      console.log(`[Migration] Appending new columns to existing sheet '${sheetName}': ${missingColumns.join(', ')}`);
      const startCol = existingColumns.length + 1;
      const targetRange = sheet.getRange(1, startCol, 1, missingColumns.length);
      targetRange.setValues([missingColumns]);
      targetRange.setFontWeight('bold').setBackground('#f3f3f3');
      return `[컬럼추가] '${sheetName}' 누락 컬럼 추가: ${missingColumns.join(', ')}`;
    } else {
      console.log(`[Migration] Skipped '${sheetName}': All required columns already exist.`);
      return `[유지] '${sheetName}' 최신 상태`;
    }
  },

  /**
   * [Backfill] 오늘 이후 예약 대상 중복 그룹 1회 일괄 검사 및 duplicate_group 시트 적재
   */
  backfillFutureDuplicateGroups() {
    return DuplicateGroupService.backfillFutureDuplicateGroups();
  }
};

/**
 * [수동 실행용] Apps Script 에디터 드롭다운에서 직접 선택하여 실행할 수 있는 탑레벨 함수
 */
function runSchemaMigration() {
  const result = MigrationService.setup();
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/**
 * [수동 실행용] 오늘 이후 중복 예약 백필 실행
 */
function runDuplicateBackfill() {
  const result = MigrationService.backfillFutureDuplicateGroups();
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}
