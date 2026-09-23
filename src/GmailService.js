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

  // 예약어 치환 특수 처리 대상 (일반 순회 치환에서 제외/가공되는 키)
  PLACEHOLDER_RULES: {
    DATE_FORMAT_KEYS: ['reservation_date', 'reservation_time'], // 날짜 포맷팅 블록에서 별도 치환
    COMMA_FORMAT_KEYS: ['deposit_amount'],                      // 천 단위 콤마 포맷 적용
  },

  /**
   * 예약어 치환 헬퍼 (대괄호 [[ ]] 지원)
   */
  replacePlaceholders(html, data) {
    let result = html;
    const rules = this.PLACEHOLDER_RULES;

    // 데이터 키 전체를 순회하며 [[key]] 치환 (신규 예약어 추가 시 별도 수정 불필요)
    Object.keys(data).forEach(key => {
      if (rules.DATE_FORMAT_KEYS.includes(key)) return;
      const regex = new RegExp('\\[\\[' + key + '\\]\\]', 'g');
      let replaceValue = data[key];
      if (replaceValue === null || replaceValue === undefined) replaceValue = '';

      if (rules.COMMA_FORMAT_KEYS.includes(key) && data[key] !== '' && !isNaN(Number(data[key]))) {
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

    // 중복 예약 목록 포맷팅 특수 처리
    if (data.duplicate_reservations && Array.isArray(data.duplicate_reservations)) {
      const listHtml = data.duplicate_reservations.map((item, idx) => {
        const branchStr = item.branch_name || item.branch_name_ko || item.branch_name_en || '';
        const timeStr = item.date_time || item.reservation_date || '';
        const paxStr = item.pax ? ` (${item.pax}명)` : '';
        return `• ${idx + 1}번: [${branchStr}] ${timeStr}${paxStr}`;
      }).join('<br>');
      result = result.replace(/\[\[duplicate_reservation_list\]\]/g, listHtml);
      result = result.replace(/\[\[duplicate_count\]\]/g, String(data.duplicate_reservations.length));
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
      
      const resendNoticeHtml = data.isCorrectedResend ? `
        <div style="background-color: #fdf8f4; border-left: 4px solid #c16e36; padding: 12px 16px; margin-bottom: 20px; border-radius: 4px; font-size: 13px; color: #555;">
          <strong style="color: #c16e36;">Notice:</strong> This booking confirmation has been resent to your updated email address (<strong>${data.email}</strong>) as the previous notification could not be delivered due to an email address issue.
        </div>
      ` : '';

      const htmlBody = `
        <div style="font-family: sans-serif; line-height: 1.5; color: #333;">
          ${resendNoticeHtml}
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
   * @param {string} threadId - Gmail 스레드 ID
   * @param {number|string} pax - 인원수
   * @param {string} [status='pending'] - 예약 상태 (confirm, cancel, pending)
   * @param {string} [depositStatus=null] - 예약금 상태 (confirm, pending, refund, n/a)
   */
  addLabelsAfterDelay(threadId, pax, status, depositStatus) {
    // Gmail API가 스레드를 완전히 인덱싱할 시간을 확보 (1.5초 대기)
    Utilities.sleep(1500);
    try {
      // 1. 예약 상태 라벨 매핑 및 부여
      let resLabel = this.RESERVATION_LABELS.PENDING;
      if (status === 'confirm') {
        resLabel = this.RESERVATION_LABELS.CONFIRM;
      } else if (status === 'cancel') {
        resLabel = this.RESERVATION_LABELS.CANCEL;
      }
      this.updateReservationLabel(threadId, resLabel);

      // 2. 예약금 상태 라벨 매핑 및 부여
      if (depositStatus === 'confirm') {
        this.updateDepositLabel(threadId, this.DEPOSIT_LABELS.CONFIRM);
      } else if (depositStatus === 'pending') {
        this.updateDepositLabel(threadId, this.DEPOSIT_LABELS.PENDING);
      } else if (depositStatus === 'refund') {
        this.updateDepositLabel(threadId, this.DEPOSIT_LABELS.REFUND);
      } else if (parseInt(pax, 10) >= 9 && (!depositStatus || depositStatus === 'n/a')) {
        this.updateDepositLabel(threadId, this.DEPOSIT_LABELS.PENDING);
      }
    } catch (e) {
      console.warn(`[GmailService] 라벨 추가 실패 (threadId: ${threadId}): ${e.message}`);
    }
  },

  /**
   * [추가] 반송(Bounce / Delivery Status Notification) 메일 일괄 수집
   * - Mailer-Daemon 또는 Delivery Status Notification 메일을 검색하여 반송된 수신자 주소 및 스레드 ID 추출
   * - CacheService(5분 캐시) 적용으로 API Quota 및 지연 방지
   * @returns {Array<{threadId: string, recipientEmail: string, subject: string, date: string}>}
   */
  getBouncedEmailDetails() {
    const cache = CacheService.getScriptCache();
    const CACHE_KEY = 'GMAIL_BOUNCED_EMAILS';
    const cached = cache.get(CACHE_KEY);
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch (e) {}
    }

    try {
      const query = '(from:mailer-daemon OR from:"Mail Delivery Subsystem" OR subject:"Delivery Status Notification" OR subject:"Address not found")';
      const threads = GmailApp.search(query, 0, 30);
      const bouncedMap = {};

      threads.forEach(thread => {
        const threadId = thread.getId();
        const messages = thread.getMessages();
        messages.forEach(msg => {
          const from = (msg.getFrom() || '').toLowerCase();
          const subject = msg.getSubject() || '';
          const body = msg.getPlainBody() || '';

          const isBounce = from.includes('mailer-daemon') ||
                           from.includes('mail delivery subsystem') ||
                           subject.includes('Delivery Status Notification') ||
                           subject.includes('Address not found') ||
                           body.includes('550 5.1.1') ||
                           body.includes('The email account that you tried to reach does not exist');

          if (isBounce) {
            let recipientEmail = '';
            const match = body.match(/<(?:mailto:)?([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})>/i) ||
                          body.match(/(?:to|address|recipient):\s*([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i) ||
                          body.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\s*(?:does not exist|was not found|could not be reached)/i);

            if (match) {
              recipientEmail = match[1].toLowerCase().trim();
            }

            const key = `${threadId}_${recipientEmail}`;
            if (!bouncedMap[key]) {
              bouncedMap[key] = {
                threadId: threadId,
                recipientEmail: recipientEmail,
                subject: subject,
                date: msg.getDate().toISOString()
              };
            }
          }
        });
      });

      const result = Object.values(bouncedMap);
      cache.put(CACHE_KEY, JSON.stringify(result), 300); // 5분 캐싱
      return result;
    } catch (e) {
      console.log(`[GmailService] getBouncedEmailDetails Error: ${e.message}`);
      return [];
    }
  },

  /**
   * [NEW] 중복 예약 확인 안내 메일 전송 (하드코딩 포맷, 기존 스레드 답장 전용)
   * @param {Object} params - { threadId, customerName, duplicateReservations }
   */
  sendDuplicateConfirmationMail(params) {
    try {
      const { threadId, customerName, duplicateReservations } = params;
      if (!threadId) {
        throw new Error('이메일 스레드 ID가 없어 발송할 수 없습니다.');
      }

      const thread = this.getThreadById(threadId);
      if (!thread) {
        throw new Error('해당 ID의 Gmail 스레드를 찾을 수 없습니다.');
      }

      const messages = thread.getMessages();
      if (!messages || messages.length === 0) {
        throw new Error('스레드에 메시지가 존재하지 않습니다.');
      }

      const targetMessage = messages[messages.length - 1]; // 최신 메시지에 회신

      // 예약 목록 HTML 포맷팅
      const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      const listItemsHtml = (duplicateReservations || []).map((item, idx) => {
        let dateStr = item.date_time || item.reservation_date || '';
        if (item.reservation_date) {
          const d = new Date(item.reservation_date);
          if (!isNaN(d.getTime())) {
            const m = monthNames[d.getMonth()];
            const day = d.getDate();
            const year = d.getFullYear();
            let h = d.getHours();
            const ampm = h >= 12 ? 'PM' : 'AM';
            const mPart = (d.getMinutes() + '').padStart(2, '0');
            h = h % 12 || 12;
            dateStr = `${m} ${day}, ${year} at ${h}:${mPart} ${ampm}`;
          }
        }
        const branchStr = item.branch_name_en || item.branch_name || 'Wangbijib';
        const paxStr = item.pax ? ` (${item.pax} Guests)` : '';

        return `
          <div style="padding: 10px 14px; margin-bottom: 8px; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 6px; font-size: 14px; color: #1a202c; line-height: 1.5;">
            <strong style="color: #c16e36;">• Booking ${idx + 1}:</strong>&nbsp;<strong>[${branchStr}]</strong>&nbsp;${dateStr}&nbsp;<span style="color: #4a5568; font-weight: 600; white-space: nowrap;">${paxStr}</span>
          </div>
        `;
      }).join('');

      let htmlBody = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta http-equiv="Content-Type" content="text/html; charset=utf-8">
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #2d3748; margin: 0; padding: 0; }
            p { margin: 0 0 14px 0; }
          </style>
        </head>
        <body>
          <div style="max-width: 680px; width: 100%; margin: 0; padding: 12px 0;">
            <p>Dear ${customerName || 'Guest'},</p>
            <p>Thank you for choosing Wangbijib!</p>
            <p>We noticed multiple bookings under your name. To help us prepare your table, please let us know which reservation you would like to keep:</p>
            
            <div style="background-color: #f7fafc; border: 1px solid #edf2f7; border-radius: 8px; padding: 12px; margin: 16px 0;">
              ${listItemsHtml}
            </div>

            <p>Please reply directly to this email with your preferred booking.</p>
            <p>We look forward to welcoming you! 🥩✨</p>
            <p style="margin-top: 20px; margin-bottom: 4px;">Warm regards,</p>
            <p style="margin-top: 0; margin-bottom: 20px; font-weight: bold;">Wangbijib Support Team</p>

            <div style="margin-top: 20px; padding-top: 16px; border-top: 1px solid #eeeeee;">
              <table cellpadding="0" cellspacing="0" border="0" style="font-family:Arial,sans-serif;font-size:14px;color:rgb(51,51,51);line-height:1.6"><tbody><tr><td style="padding-right:10px"><img width="96" height="96" src="https://ci3.googleusercontent.com/mail-sig/AIorK4ysRrpHmmhrL7g42rhItAWfq1q1X2xbWpKLEyxe8JeffSu7JxmeRpps2E3ILgKAL0LKMpbzyWgPHibZ" style="color:rgb(32,33,36);font-family:Arial,Helvetica,sans-serif;font-size:small" class="CToWUd" data-bit="iit"></td><td style="vertical-align:top"><span style="font-size:16px"><b>왕비집</b></span>&nbsp;<b>Wangbijib</b><br>🍖사대문 갈비명가&nbsp;Premium Galbi Restaurant in Seoul<br>🏆No.1 K-BBQ Restaurant<br>🎀Nominated for 2024 Blue Ribbon Survey (K-Cuisine Prize)&nbsp;<br></td></tr><tr><td colspan="2" style="padding-top:10px"><b>🛒&nbsp;Online Store&nbsp;</b>&nbsp; &nbsp;<a href="https://www.wangbijib.com/" target="_blank" data-saferedirecturl="https://www.google.com/url?q=https://www.wangbijib.com/&amp;source=gmail&amp;ust=1766063890290000&amp;usg=AOvVaw1ERpt2TdeaZzRGNUC9vDM4"><font color="#000000">왕비몰</font></a>&nbsp;(Available in Korea only)<br><b>📆&nbsp;Reservation&nbsp;</b>&nbsp; &nbsp;&nbsp;<a href="https://www.wangbijib-restaurant.com/" target="_blank" data-saferedirecturl="https://www.google.com/url?q=https://www.wangbijib-restaurant.com/&amp;source=gmail&amp;ust=1766063890290000&amp;usg=AOvVaw3jqeQIr13f8WkXbla6SuGm"><font color="#000000">Wangbijib-restaurant</font></a>&nbsp;<br>📸&nbsp;<b>Instagram</b>&nbsp;<font size="1">&nbsp;</font>&nbsp; &nbsp; &nbsp;&nbsp;<a href="https://www.instagram.com/wangbijib_official" target="_blank" data-saferedirecturl="https://www.google.com/url?q=https://www.instagram.com/wangbijib_official&amp;source=gmail&amp;ust=1766063890290000&amp;usg=AOvVaw3raEafsbvmCGmA6g5ivYp5"><font color="#000000">@wangbijib_official</font></a><br><b>💌&nbsp;E-mail</b>&nbsp;<font size="1">&nbsp;</font>&nbsp; &nbsp; &nbsp; &nbsp; &nbsp; &nbsp;&nbsp;<a href="mailto:wangbijib@gmail.com" style="color:rgb(51,51,51)" target="_blank">wangbijib@gmail.com</a><br>📞&nbsp;<b>Phone</b>&nbsp; &nbsp; &nbsp; &nbsp; &nbsp; &nbsp; &nbsp;+82) 070-4533-7028</td></tr></tbody></table>
            </div>
          </div>
        </body>
        </html>
      `;

      // 4바이트 이모지(🥩 등) 인코딩 깨짐 원천 방지
      htmlBody = this._encodeEmojisToEntities(htmlBody);

      const isDummyThread = targetMessage.getFrom().indexOf(this.SYSTEM_EMAIL_ADDRESS) !== -1;
      if (isDummyThread) {
        targetMessage.replyAll('', { htmlBody: htmlBody });
      } else {
        targetMessage.reply('', { htmlBody: htmlBody });
      }

      console.log(`[GmailService] 중복확인 메일 답장 발송 완료 (Thread: ${threadId})`);
      return Util.createResponse(true, { threadId: threadId }, '중복 확인 메일이 발송되었습니다.');
    } catch (e) {
      console.log(`[GmailService] sendDuplicateConfirmationMail Error: ${e.message}`);
      return Util.createResponse(false, null, e.message);
    }
  }
};