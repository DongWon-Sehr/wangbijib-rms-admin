/**
 * [MailTemplateService] 메일 템플릿 관리 (Singleton)
 * - 구글 시트(mail_template)를 DB로 사용
 */
const MailTemplateService = {
  /**
   * [Read] 템플릿 ID로 HTML 본문 조회
   * @param {string} id - mail_template.id 값
   * @returns {string} HTML Content
   */
  getTemplateHtmlById(id) {
    const templates = Util.getSheetDataAsObjects(Config.SHEET_NAMES.MAIL_TEMPLATE);
    const target = templates.find(t => t.id === id && t.enabled === true);
    
    // DB에 없거나 비활성화된 경우 빈 문자열 반환 (발송 중단 트리거)
    return target ? target.body_html : '';
  },

  /**
   * [Read] 모든 템플릿 목록 조회 (설정 화면용)
   */
  getAllTemplates() {
    return Util.getSheetDataAsObjects(Config.SHEET_NAMES.MAIL_TEMPLATE);
  },

  /**
   * [Create] 새 템플릿 생성 (미리 구현)
   */
  createTemplate(data) {
    try {
      const sheet = Util.getSpreadsheet().getSheetByName(Config.SHEET_NAMES.MAIL_TEMPLATE);
      const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
      const now = new Date();

      const newObj = {
        id: Util.getUuid(),
        template_name: data.template_name, // UNIQUE KEY
        body_html: data.body_html,
        enabled: true,
        created_at: now,
        updated_at: now,
      };

      const newRow = Util.convertObjectToRow(newObj, headers);
      sheet.appendRow(newRow);
      
      return Util.createResponse(true, newObj);
    } catch (e) {
      return Util.createResponse(false, null, e.message);
    }
  },

  /**
   * [Update] 템플릿 내용 수정 (ID 기반)
   * - 제목, 본문, 활성상태 업데이트
   * @param {string} id - 템플릿 ID
   * @param {object} data - { template_name, body_html }
   */
  updateTemplate(id, data) {
    try {
      const sheet = Util.getSpreadsheet().getSheetByName(Config.SHEET_NAMES.MAIL_TEMPLATE);
      const allData = sheet.getDataRange().getValues();
      const headers = allData[0];
      
      const idIdx = headers.indexOf('id');
      const templateNameIdx = headers.indexOf('template_name');
      const bodyIdx = headers.indexOf('body_html');
      const updateIdx = headers.indexOf('updated_at');

      if (idIdx === -1) return Util.createResponse(false, null, 'ID Column not found');

      for (let i = 1; i < allData.length; i++) {
        if (allData[i][idIdx] === id) {
          const row = i + 1;
          // 값이 있는 경우에만 업데이트 (Partial Update)
          if (data.template_name !== undefined) sheet.getRange(row, templateNameIdx + 1).setValue(data.template_name);
          if (data.body_html !== undefined) sheet.getRange(row, bodyIdx + 1).setValue(data.body_html);
          
          sheet.getRange(row, updateIdx + 1).setValue(new Date());
          
          return Util.createResponse(true);
        }
      }
      return Util.createResponse(false, null, 'Template not found');
    } catch (e) {
      return Util.createResponse(false, null, e.message);
    }
  },

  /**
   * [Delete] 템플릿 삭제 (미리 구현)
   */
  deleteTemplate(id) {
    try {
      const sheet = Util.getSpreadsheet().getSheetByName(Config.SHEET_NAMES.MAIL_TEMPLATE);
      const data = sheet.getDataRange().getValues();
      const idIdx = data[0].indexOf('id');

      if (idIdx === -1) return Util.createResponse(false, null, 'ID Column not found');

      for (let i = 1; i < data.length; i++) {
        if (data[i][idIdx] === id) {
          sheet.deleteRow(i + 1);
          return Util.createResponse(true);
        }
      }
      return Util.createResponse(false, null, 'Template not found');
    } catch (e) {
      return Util.createResponse(false, null, e.message);
    }
  }
};