/**
 * [Util] 시스템 전반에서 사용되는 유틸리티 함수 모음 (Singleton)
 */
const Util = {
  /**
   * 스프레드시트 객체 반환
   */
  getSpreadsheet() {
    return SpreadsheetApp.openById(Config.SPREADSHEET_ID);
  },

  /**
   * [Core] 표준 API 응답 객체 생성
   * 프론트엔드로 데이터를 반환할 때 반드시 이 형식을 사용합니다.
   * * @param {boolean} success - 성공 여부
   * @param {any} data - 반환할 데이터 (객체, 배열 등)
   * @param {string} message - 실패 시 에러 메시지, 성공 시 안내 메시지
   * @returns {Object} { success, data, message }
   */
  createResponse(success, data = null, message = '') {
    return {
      success: success == true ? true : false,
      data: data,
      message: message
    };
  },

  /**
   * [Core] 시트 데이터를 헤더명(Key) 기반의 객체 배열로 변환 (ORM 역할)
   * - 빈 시트이거나 헤더만 있는 경우 빈 배열 반환
   * - Date 객체는 JSON 직렬화를 위해 ISO String으로 변환
   * * @param {string} sheetName - 시트 이름 (Config.SHEET_NAMES 참조)
   * @returns {Array<Object>} 객체 배열 [ { id: '...', name: '...' }, ... ]
   */
  getSheetDataAsObjects(sheetName) {
    const ss = this.getSpreadsheet();
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet) {
      console.log(`[Util] 시트를 찾을 수 없음: ${sheetName}`);
      return [];
    }

    const range = sheet.getDataRange();
    const values = range.getValues();

    // 데이터가 없거나 헤더만 있는 경우
    if (values.length <= 1) return [];

    const headers = values[0];
    const rows = values.slice(1);

    return rows.map(row => {
      const obj = {};
      headers.forEach((header, index) => {
        let val = row[index];
        
        // Date 객체는 ISO 문자열로 변환 (프론트엔드 전송용)
        if (val instanceof Date) {
          // 유효한 날짜인지 확인
          if (!isNaN(val.getTime())) {
            val = val.toISOString();
          } else {
            val = '';
          }
        }
        
        obj[header] = val;
      });
      return obj;
    });
  },

  /**
   * UUID 생성
   */
  getUuid() {
    return Utilities.getUuid();
  },

  /**
   * 날짜 포맷팅 헬퍼
   * @param {Date|string} value - Date 객체 또는 날짜 문자열
   * @param {string} type - 'datetime' | 'date' | 'time'
   * @returns {string} 포맷팅된 문자열
   */
  formatDate(value, type = 'datetime') {
    if (!value) return '';
    
    try {
      // 이미 HH:mm 형식의 문자열인 경우 그대로 반환
      if (typeof value === 'string' && type === 'time' && value.includes(':') && !value.includes('T')) {
        return value;
      }

      const date = new Date(value);
      if (isNaN(date.getTime())) return typeof value === 'string' ? value : '';

      const y = date.getFullYear();
      const m = String(date.getMonth() + 1).padStart(2, '0');
      const d = String(date.getDate()).padStart(2, '0');
      const hh = String(date.getHours()).padStart(2, '0');
      const mm = String(date.getMinutes()).padStart(2, '0');
      const ss = String(date.getSeconds()).padStart(2, '0');

      if (type === 'date') return `${y}-${m}-${d}`;
      if (type === 'time') return `${hh}:${mm}`;
      
      // default: datetime
      return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
    } catch (e) {
      console.log(`[Util] Date Parsing Error: ${e.message}`);
      return String(value);
    }
  },

  /**
   * 객체 데이터를 시트 행(Row) 배열로 변환
   * (데이터 추가/수정 시 사용)
   * * @param {Object} obj - 저장할 데이터 객체
   * @param {Array<string>} headers - 시트 헤더 배열
   * @returns {Array} 시트에 저장할 1차원 배열
   */
  convertObjectToRow(obj, headers) {
    return headers.map(header => {
      let val = obj[header];
      if (val === undefined || val === null) return "";
      
      // ISO String 날짜를 다시 Date 객체로 변환하여 시트에 저장 (선택 사항)
      // Apps Script는 Date 객체를 넣으면 시트 서식에 맞게 잘 들어감
      if (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(val)) {
        const d = new Date(val);
        if (!isNaN(d.getTime())) return d;
      }
      
      return val;
    });
  },

  verifyGoogleIdToken(idToken) {
    const res = UrlFetchApp.fetch(
      'https://oauth2.googleapis.com/tokeninfo?id_token=' + idToken
    );
    return JSON.parse(res.getContentText());
  }
};