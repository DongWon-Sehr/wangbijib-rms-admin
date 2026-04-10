/**
 * [GmailService] 메일 발송 및 템플릿 관리 (Singleton)
 * - v1.4: 파일 기반 -> 시트 기반(MailTemplateService)으로 변경
 */
const GmailService = {
  // 라벨 상수
  LABELS: {
    PENDING: '매장/예약/대기',
    CONFIRM: '매장/예약/완료',
    CANCEL: '매장/예약/취소',
    DEPOSIT_PENDING: '매장/예약/예약금 대기',
    DEPOSIT_CONFIRM: '매장/예약/예약금 입금',
    DEPOSIT_REFUND: '매장/예약/예약금 환불',
  },
  RESERVATION_LABELS: {
    PENDING: '매장/예약/대기',
    CONFIRM: '매장/예약/완료',
    CANCEL: '매장/예약/취소',
  },
  DEPOSIT_LABELS: {
    PENDING: '매장/예약/예약금 대기',
    CONFIRM: '매장/예약/예약금 입금',
    REFUND: '매장/예약/예약금 환불',
  },
  SYSTEM_EMAIL_ADDRESS: 'wangbijib@gmail.com',

  /**
   * 4바이트 이모지를 HTML 엔티티로 변환하는 유틸리티
   * (인코딩 문제로 인한 이모지 깨짐을 원천 봉쇄함)
   */
  _encodeEmojisToEntities(text) {
    if (!text) return '';
    return text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, function(match) {
      var high = match.charCodeAt(0);
      var low = match.charCodeAt(1);
      var code = (high - 0xD800) * 0x400 + (low - 0xDC00) + 0x10000;
      return "&#" + code + ";";
    });
  },

  /**
   * 스레드에 템플릿 기반 답장 보내기
   * * @param {string} threadId - Gmail 스레드 ID
   * @param {string} templateId - 템플릿 ID (Config.MAIL_TEMPLATES)
   * @param {Object} data - 치환할 데이터 객체
   */
  replyToThreadWithTemplate(threadId, templateId, data) {
    try {
      if (!threadId) throw new Error('Thread ID is missing');

      const thread = this.getThreadById(threadId);
      if (!thread) throw new Error('Thread not found');

      const messages = thread.getMessages();
      let targetMessage = messages[0]; // 기본값: 첫 메시지

      // 뒤에서부터 탐색하여 '내'가 보내지 않은(즉, 고객이 보낸) 가장 최신 메시지를 찾습니다.
      for (let i = messages.length - 1; i >= 0; i--) {
        // from에 내 이메일이 포함되지 않은 경우 -> 고객 메시지로 간주
        if (messages[i].getFrom().indexOf(this.SYSTEM_EMAIL_ADDRESS) === -1) {
          targetMessage = messages[i];
          break;
        }
      }

      const lastMsg = messages[messages.length - 1]; // 스레드의 마지막 메일

      // Gmail 스타일의 인용구 HTML 생성
      const quoteHtml =
        '<div class="gmail_quote">' +
          '<div dir="ltr" class="gmail_attr">On ' + lastMsg.getDate() + ', ' + lastMsg.getFrom() + ' wrote:<br></div>' +
          '<blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">' +
            lastMsg.getBody() +
          '</blockquote>' +
        '</div>';

      // 1. 템플릿 로드 (DB에서 조회)
      let templateHtml = MailTemplateService.getTemplateHtmlById(templateId);

      // 빈 내용 체크 (발송 중단)
      if (!templateHtml || templateHtml.trim() === '') {
        console.log(`[Gmail] 템플릿(${templateId}) 내용이 비어있어 발송 중단.`);
        return Util.createResponse(false, null, 'Template is empty');
      }

      // 2. 예약어 치환
      templateHtml = this.replacePlaceholders(templateHtml, data);
      templateHtml = this._encodeEmojisToEntities(templateHtml);
      
      const htmlBody = 
        '<!DOCTYPE html>' +
        '<html>' +
        '<head>' +
          '<meta http-equiv="Content-Type" content="text/html; charset=utf-8">' +
            '<style>' +
              'body { font-family: sans-serif; line-height: 1.2; margin: 0; padding: 0; }' + // line-height 조절
              'div, p { margin: 0; padding: 0; }' + // div와 p의 기본 여백 제거
            '</style>' +
        '</head>' +
        '<body>' +
          '<div>' + templateHtml + '</div>' + // 내 답장 내용
          '<br clear="all">' +                // 줄바꿈 및 클리어
          '<div>' + quoteHtml + '</div>' +     // 인용구 (이전 메일)
        '</body>' +
        '</html>';

      // 4. 답장 발송
      targetMessage.reply('', { htmlBody: htmlBody });
      console.log(`[Gmail] Sent reply to ${threadId} using ${templateId}`);

      return Util.createResponse(true);

    } catch (e) {
      console.log(`[Gmail] Reply Error: ${e.message}`);
      return Util.createResponse(false, null, e.message);
    }
  },

  /**
   * 예약어 치환 헬퍼 (대괄호 [[ ]] 지원)
   */
  replacePlaceholders(html, data) {
    let result = html;

    // 기본 키워드 치환
    const keys = ['customer_name', 'branch_name_en', 'pax', 'notes', 'deposit_amount'];
    keys.forEach(key => {
      // [[key]] 패턴 사용
      // 특수문자 이스케이프: [ -> \\[, ] -> \\]
      const regex = new RegExp('\\[\\[' + key + '\\]\\]', 'g');
      result = result.replace(regex, data[key] || '');
    });

    // 날짜 포맷팅 특수 처리 (Dec 3)
    if (data.reservation_date) {
      const dateObj = new Date(data.reservation_date);
      const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      const dateStr = `${monthNames[dateObj.getMonth()]} ${dateObj.getDate()}`;

      result = result.replace(/\[\[reservation_date\]\]/g, dateStr);
      result = result.replace(/\[\[reservation_time\]\]/g, Util.formatDate(dateObj, 'time'));
    }

    return result;
  },

  /**
   * [추가] ID로 Gmail 스레드 객체 찾기
   * @param {string} threadId - Gmail 스레드 ID
   * @returns {GmailThread|null} 찾은 스레드 객체 또는 null
   */
  getThreadById(threadId) {
    if (!threadId) return null;
    try {
      return GmailApp.getThreadById(threadId);
    } catch (e) {
      console.log(`[GmailService] 스레드 찾기 실패 (ID: ${threadId}): ${e.message}`);
      return null;
    }
  },

  /**
   * [추가] 특정 스레드에 라벨 추가 (라벨이 없으면 자동 생성)
   * @param {string} threadId - 대상 스레드 ID
   * @param {string} labelName - 추가할 라벨 이름
   */
  _addLabel(threadId, labelName) {
    try {
      const thread = this.getThreadById(threadId);
      if (!thread) {
        throw new Error(`스레드를 찾을 수 없습니다. (ID: ${threadId})`);
      }

      // 라벨 객체 가져오기 (없으면 null 반환)
      let label = GmailApp.getUserLabelByName(labelName);

      // 라벨이 없으면 새로 생성
      if (!label) {
        console.log(`[GmailService] '${labelName}' 라벨이 없어 새로 생성합니다.`);
        label = GmailApp.createLabel(labelName);
      }

      thread.addLabel(label);
      console.log(`[GmailService] 라벨 추가 성공: ${labelName} -> ${threadId}`);
      return true;

    } catch (e) {
      console.log(`[GmailService] 라벨 추가 실패: ${e.message}`);
      return false;
    }
  },

  /**
   * [추가] 특정 스레드에서 라벨 삭제
   * @param {string} threadId - 대상 스레드 ID
   * @param {string} labelName - 삭제할 라벨 이름
   * 
   */
  _removeLabel(threadId, labelName) {
    try {
      const thread = this.getThreadById(threadId);
      if (!thread) {
        throw new Error(`스레드를 찾을 수 없습니다. (ID: ${threadId})`);
      }

      const label = GmailApp.getUserLabelByName(labelName);

      // 라벨이 존재할 때만 삭제 시도
      if (label) {
        thread.removeLabel(label);
        console.log(`[GmailService] 라벨 삭제 성공: ${labelName} -> ${threadId}`);
      } else {
        console.log(`[GmailService] 삭제할 라벨이 존재하지 않습니다: ${labelName}`);
      }
      return true;

    } catch (e) {
      console.log(`[GmailService] 라벨 삭제 실패: ${e.message}`);
      return false;
    }
  },

  updateReservationLabel(threadId, labelName) {
    try {
      const thread = this.getThreadById(threadId);
      if (!thread) {
        throw new Error(`스레드를 찾을 수 없습니다. (ID: ${threadId})`);
      }

      const lableNames = Object.values(this.RESERVATION_LABELS);
      if (lableNames.includes(labelName)) {
        lableNames.forEach(targetLabel => this._removeLabel(threadId, targetLabel));
      }

      this._addLabel(threadId, labelName);
      thread.markRead();
      return true;
    } catch (e) {
      console.log(`[GmailService] 라벨 변경 실패: ${e.message}`);
      return false;
    }
  },

  updateDepositLabel(threadId, labelName) {
    try {
      const thread = this.getThreadById(threadId);
      if (!thread) {
        throw new Error(`스레드를 찾을 수 없습니다. (ID: ${threadId})`);
      }

      const lableNames = Object.values(this.DEPOSIT_LABELS);
      if (lableNames.includes(labelName)) {
        lableNames.forEach(targetLabel => this._removeLabel(threadId, targetLabel));
      }

      this._addLabel(threadId, labelName);
      thread.markRead();

      return true;
    } catch (e) {
      console.log(`[GmailService] 라벨 변경 실패: ${e.message}`);
      return false;
    }
  },

  deleteDepositLabel(threadId) {
    try {
      const thread = this.getThreadById(threadId);
      if (!thread) {
        throw new Error(`스레드를 찾을 수 없습니다. (ID: ${threadId})`);
      }

      const lableNames = Object.values(this.DEPOSIT_LABELS);
      lableNames.forEach(targetLabel => this._removeLabel(threadId, targetLabel));
      
      thread.markRead();

      return true;
    } catch (e) {
      console.log(`[GmailService] 라벨 변경 실패: ${e.message}`);
      return false;
    }
  },

  /**
   * [v1.4 New] 이메일 스레드 찾기
   */
  findThreadId(data) {
    try {
      const { branchName, customerName, email, pax, phoneNumber, startDate, notes, bookingRequestDate } = data;

      const formattedDateForSubject = this._formatDateForGmailSubjectQuery(startDate);
      const formattedDateForBody = this._formatDateForGmailBodyQuery(startDate);

      const searchStart = new Date(bookingRequestDate.getTime() - 2 * 24 * 60 * 60 * 1000);
      const searchEnd = new Date(bookingRequestDate.getTime() + 2 * 24 * 60 * 60 * 1000);
      const formattedSearchStart = this._formatDateForGmailReceivedQuery(searchStart);
      const formattedSearchEnd = this._formatDateForGmailReceivedQuery(searchEnd);

      const queryParts = [
        'from:notifications@forms.elfsightmail.com',
        `subject:("${branchName}" "${formattedDateForSubject}")`,
        `replyto:${email}`,
        `after:${formattedSearchStart}`,
        `before:${formattedSearchEnd}`,
        `": ${customerName}"`,
        `": ${email}"`,
        `": ${phoneNumber}"`,
        `": ${pax}"`,
      ];

      if (notes && notes.trim() !== "") {
        queryParts.push(`"Notes: ${notes.trim()}"`);
      }

      const query = queryParts.join(' ');
      console.log(`[Gmail] Searching Thread: ${query}`);

      const threads = GmailApp.search(query);
      const SEARCH_WINDOW_MINUTES = 5;

      const filteredThreads = threads.filter(thread => {
        return thread.getMessages().some(msg => {
          const receivedTime = msg.getDate().getTime();
          return receivedTime >= bookingRequestDate.getTime() - SEARCH_WINDOW_MINUTES * 60 * 1000
            && receivedTime <= bookingRequestDate.getTime() + SEARCH_WINDOW_MINUTES * 60 * 1000;
        });
      });

      if (filteredThreads.length > 0) {
        return filteredThreads[0].getId();
      }
      return null;

    } catch (e) {
      console.log(`[Gmail] Find Thread Error: ${e.message}`);
      return null;
    }
  },

  // --- Helper Functions ---
  _formatDateForGmailSubjectQuery(date) {
    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    let hours = date.getHours();
    const minutes = (date.getMinutes() + '').padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12 || 12;
    return `${monthNames[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()} at ${hours}:${minutes} ${ampm}`;
  },

  _formatDateForGmailBodyQuery(date) {
    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    let hours = date.getHours();
    const minutes = (date.getMinutes() + '').padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12 || 12;
    return `${monthNames[date.getMonth()]} ${date.getDate()}, ${hours}:${minutes} ${ampm}`;
  },

  _formatDateForGmailReceivedQuery(date) {
    const yyyy = date.getFullYear();
    const mm = ('0' + (date.getMonth() + 1)).slice(-2);
    const dd = ('0' + date.getDate()).slice(-2);
    return `${yyyy}/${mm}/${dd}`;
  }
};