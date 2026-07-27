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
      const targetMessage = messages[0];
      const lastMsg = messages[messages.length - 1];

      const quoteHtml =
        '<div class="gmail_quote">' +
          '<div dir="ltr" class="gmail_attr">On ' + lastMsg.getDate() + ', ' + lastMsg.getFrom() + ' wrote:<br></div>' +
          '<blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">' +
            lastMsg.getBody() +
          '</blockquote>' +
        '</div>';

      let templateHtml = MailTemplateService.getTemplateHtmlById(templateId);

      if (!templateHtml || templateHtml.trim() === '') {
        console.log(`[Gmail] 템플릿(${templateId}) 내용이 비어있어 발송 중단.`);
        return Util.createResponse(false, null, 'Template is empty');
      }

      templateHtml = this.replacePlaceholders(templateHtml, data);
      templateHtml = this._encodeEmojisToEntities(templateHtml);
      
      const htmlBody = 
        '<!DOCTYPE html>' +
        '<html>' +
        '<head>' +
          '<meta http-equiv="Content-Type" content="text/html; charset=utf-8">' +
            '<style>' +
              'body { font-family: sans-serif; line-height: 1.2; margin: 0; padding: 0; }' +
              'div, p { margin: 0; padding: 0; }' +
            '</style>' +
        '</head>' +
        '<body>' +
          '<div>' + templateHtml + '</div>' +
          '<br clear="all">' +
          '<div>' + quoteHtml + '</div>' +
        '</body>' +
        '</html>';

      const isDummyThread = targetMessage.getFrom().indexOf(this.SYSTEM_EMAIL_ADDRESS) !== -1;

      if (isDummyThread) {
        targetMessage.replyAll('', {
          htmlBody: htmlBody
        });
      } else {
        targetMessage.reply('', {
          htmlBody: htmlBody
        });
      }
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
    const keys = [
      'customer_name',
      'branch_name_en',
      'pax',
      'notes',
      'deposit_amount',
    ];
    keys.forEach(key => {
      // [[key]] 패턴 사용
      // 특수문자 이스케이프: [ -> \\[, ] -> \\]
      const regex = new RegExp('\\[\\[' + key + '\\]\\]', 'g');
      let replaceValue = data[key] || '';
      
      // deposit_amount는 콤마(,) 포맷팅 처리
      if (key === 'deposit_amount' && typeof data[key] === 'number') {
        replaceValue = data[key].toLocaleString();
      } else if (key === 'deposit_amount' && !isNaN(Number(data[key])) && data[key]) {
        replaceValue = Number(data[key]).toLocaleString();
      }
      
      result = result.replace(regex, replaceValue);
    });

    // 날짜 포맷팅 특수 처리 (Dec 3)
    if (data.reservation_date) {
      const dateObj = new Date(data.reservation_date);
      const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      const dateStr = `${monthNames[dateObj.getMonth()]} ${dateObj.getDate()}`;

      result = result.replace(/\[\[reservation_date\]\]/g, dateStr);
      result = result.replace(/\[\[reservation_time\]\]/g, Util.formatDate(dateObj, 'time'));
    }

    // DEPOSIT_URL 치환
    const depositAmountKey = Number(data.deposit_amount);
    const depositUrl = (depositAmountKey && !isNaN(depositAmountKey)) ? (Config.DEPOSIT_URLS[depositAmountKey] ?? '') : '';
    result = result.replace(/\[\[deposit_url\]\]/g, depositUrl);

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

      const labelNames = Object.values(this.RESERVATION_LABELS);
      if (labelNames.includes(labelName)) {
        labelNames.forEach(targetLabel => this._removeLabel(threadId, targetLabel));
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

      const labelNames = Object.values(this.DEPOSIT_LABELS);
      if (labelNames.includes(labelName)) {
        labelNames.forEach(targetLabel => this._removeLabel(threadId, targetLabel));
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

      const labelNames = Object.values(this.DEPOSIT_LABELS);
      labelNames.forEach(targetLabel => this._removeLabel(threadId, targetLabel));
      
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
  },

  /**
   * [추가] 신규 스레드 생성을 위한 Elfsight 더미 메일 발송
   * - 예약 확정 메일을 보내기 위해 시스템(Admin) 자신에게 이메일을 발송하여 스레드를 생성합니다.
   * - 고객 이메일을 Reply-To로 지정하여 이 스레드에 답장 시 고객에게 전송되도록 합니다.
   */
  createDummyElfsightThread(data) {
    try {
      const branchName = data.branch_name_en || 'Wangbijib Branch';
      const dateObj = new Date(data.reservation_date);
      const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
      const month = monthNames[dateObj.getMonth()];
      const day = dateObj.getDate();
      const year = dateObj.getFullYear();
      let hours = dateObj.getHours();
      const minutes = (dateObj.getMinutes() + '').padStart(2, '0');
      const ampm = hours >= 12 ? 'PM' : 'AM';
      hours = hours % 12 || 12;
      const timeStr = `${hours}:${minutes} ${ampm}`;
      const dateStr = `${month} ${day}, ${year}`;
      
      const subject = `New Booking: ${branchName} on ${dateStr} at ${timeStr} - ${data.customer_name}`;
      
      const htmlBody = `
        <div style="font-family: sans-serif; line-height: 1.5; color: #333;">
          <h2 style="color: #000; margin-bottom: 5px;">You have a new booking at Wangbijib</h2>
          <p style="margin-top: 0; margin-bottom: 20px;">We are pleased to inform you that a new booking has been made.<br>
          Google Map: <a href="https://maps.app.goo.gl/9zqTx8u2ueY4ARwE7">https://maps.app.goo.gl/9zqTx8u2ueY4ARwE7</a></p>
          
          <h3 style="color: #000; margin-bottom: 5px;">Booking details</h3>
          <p style="margin-top: 0; margin-bottom: 20px;"><strong>What:</strong> ${branchName}<br>
          <strong>When:</strong> ${month} ${day}, ${timeStr}</p>
          
          <h3 style="color: #000; margin-bottom: 5px;">Client information</h3>
          <p style="margin-top: 0; margin-bottom: 20px;"><strong>Name:</strong> ${data.customer_name}<br>
          <strong>Email:</strong> <a href="mailto:${data.email}">${data.email}</a><br>
          <strong>Phone:</strong> ${data.phone_number || ''}<br>
          <strong>Notes:</strong> ${data.notes || ''}<br>
          <strong>Number of Guest (Pax):</strong> ${data.pax}</p>
          
          <p style="margin-bottom: 20px;"><strong>I understand that I have to arrive within 10 minutes of my reserved start time, and that arriving later may result in cancellation of my reservation.</strong><br>
          Yes</p>
          
          <p style="color: #666; font-size: 0.9em; margin-bottom: 20px;">Please make sure to review the booking details and prepare accordingly. If you have any questions or need to make changes to the booking, please contact the client directly at the provided contact information.</p>
          
          <p style="color: #d9534f; font-weight: bold; margin-top: 20px;">
            &#128591; Please note that if you do not arrive within 10 minutes of your reservation start time, your reservation may be automatically cancelled.
          </p>
        </div>
      `;

      // 고객에게 직접 발송하여 Inbox에 스레드를 생성 (Admin 참조)
      const draft = GmailApp.createDraft(data.email, subject, '', { 
        htmlBody: htmlBody,
        cc: this.SYSTEM_EMAIL_ADDRESS
      });
      const message = draft.send();
      return message.getThread().getId();
    } catch (e) {
      console.log(`[GmailService] createDummyElfsightThread Error: ${e.message}`);
      throw e;
    }
  },

  /**
   * [Async Helper] 메일 발송 직후 분리된 API 호출을 통해 지연 후 라벨 추가
   */
  addLabelsAfterDelay(threadId, pax) {
    // Gmail API가 스레드를 완전히 인덱싱할 시간을 확보 (1.5초 대기)
    Utilities.sleep(1500);
    try {
      this.updateReservationLabel(threadId, this.RESERVATION_LABELS.PENDING);
      if (parseInt(pax, 10) >= 9) {
        this.updateDepositLabel(threadId, this.DEPOSIT_LABELS.PENDING);
      }
    } catch (e) {
      console.warn(`[GmailService] 라벨 추가 실패 (threadId: ${threadId}): ${e.message}`);
    }
  }
};