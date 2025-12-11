class GmailService {
  constructor() {
    this.LABEL_RESERVATION_PENDING = '매장/예약/대기';
    this.LABEL_RESERVATION_CONFIRM = '매장/예약/완료';
    this.LABEL_RESERVATION_CANCEL = '매장/예약/취소';
  }

  findBookingMail(
    branchName,
    customerName,
    customerEmailAddress,
    numberOfPeople,
    startDate,
    notes,
    bookingRequestDate
  ) {
    // "November 18, 8:30 PM" 포맷 만들기
    const formattedDateForSubject = formatDateForGmailSubjectQuery(startDate);
    const formattedDateForBody = formatDateForGmailBodyQuery(startDate);

    const searchStart = new Date(bookingRequestDate.getTime() - 2 * 24 * 60 * 60 * 1000); // D-2
    const searchEnd = new Date(bookingRequestDate.getTime() + 2 * 24 * 60 * 60 * 1000); // D+2
    const formattedSearchStart = formatDateForGmailReceivedQuery(searchStart);
    const formattedSearchEnd = formatDateForGmailReceivedQuery(searchEnd);

    // Gmail 검색 쿼리 배열에 필수 조건 추가
    const queryParts = [
      'from:notifications@forms.elfsightmail.com',
      `subject:("${branchName}" "${formattedDateForSubject}")`,
      `replyto:${customerEmailAddress}`,
      `after:${formattedSearchStart}`,
      `before:${formattedSearchEnd}`,
      `"Name: ${customerName}"`,
      `"Email: ${customerEmailAddress}"`,
      `"Number of People: ${numberOfPeople}"`,
      `"${formattedDateForBody}"`
    ];

    // Notes 값이 있으면 포함
    if (notes && notes.trim() !== "") {
      queryParts.push(`"Notes: ${notes.trim()}"`);
    }

    // 쿼리 완성
    const query = queryParts.join(' ');
    Logger.log("QUERY: " + query);

    // Gmail 검색
    const threads = GmailApp.search(query);

    const SEARCH_WINDOW_MINUTES = 5;
    const filteredThreads = threads.filter(thread => {
      return thread.getMessages().some(msg => {
        const receivedTime = msg.getDate().getTime();
        return receivedTime >= bookingRequestDate.getTime() - SEARCH_WINDOW_MINUTES * 60 * 1000
          && receivedTime <= bookingRequestDate.getTime() + SEARCH_WINDOW_MINUTES * 60 * 1000;
      });
    });

    return threads;
  }

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
      Logger.log(`[GmailService] 스레드 찾기 실패 (ID: ${threadId}): ${e.message}`);
      return null;
    }
  }

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
        Logger.log(`[GmailService] '${labelName}' 라벨이 없어 새로 생성합니다.`);
        label = GmailApp.createLabel(labelName);
      }

      thread.addLabel(label);
      Logger.log(`[GmailService] 라벨 추가 성공: ${labelName} -> ${threadId}`);
      return true;

    } catch (e) {
      Logger.log(`[GmailService] 라벨 추가 실패: ${e.message}`);
      return false;
    }
  }

  /**
   * [추가] 특정 스레드에서 라벨 삭제
   * @param {string} threadId - 대상 스레드 ID
   * @param {string} labelName - 삭제할 라벨 이름
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
        Logger.log(`[GmailService] 라벨 삭제 성공: ${labelName} -> ${threadId}`);
      } else {
        Logger.log(`[GmailService] 삭제할 라벨이 존재하지 않습니다: ${labelName}`);
      }
      return true;

    } catch (e) {
      Logger.log(`[GmailService] 라벨 삭제 실패: ${e.message}`);
      return false;
    }
  }

  setConfirmLabel(threadId) {
    try {
      const thread = this.getThreadById(threadId);
      if (!thread) {
        throw new Error(`스레드를 찾을 수 없습니다. (ID: ${threadId})`);
      }

      thread.markRead();

      this._removeLabel(threadId, this.LABEL_RESERVATION_PENDING);
      this._removeLabel(threadId, this.LABEL_RESERVATION_CANCEL);
      this._addLabel(threadId, this.LABEL_RESERVATION_CONFIRM);

      return true;
    } catch (e) {
      Logger.log(`[GmailService] 라벨 변경 실패: ${e.message}`);
      return false;
    }
  }

  setCancelLabel(threadId) {
    Logger.log(`[GmailService] setCancelLabel - ${threadId}`);
    try {
      const thread = this.getThreadById(threadId);
      if (!thread) {
        throw new Error(`스레드를 찾을 수 없습니다. (ID: ${threadId})`);
      }

      thread.markRead();

      this._removeLabel(threadId, this.LABEL_RESERVATION_PENDING);
      this._removeLabel(threadId, this.LABEL_RESERVATION_CONFIRM);
      this._addLabel(threadId, this.LABEL_RESERVATION_CANCEL);
      
      return true;
    } catch (e) {
      Logger.log(`[GmailService] 라벨 변경 실패: ${e.message}`);
      return false;
    }
  }

  getSignatureHtml() {
    return HtmlService.createTemplateFromFile('email-signature').evaluate().getContent();
  }

  replyToThreadWithSignature(threadId, body) {
    try {
      const thread = this.getThreadById(threadId);
      if (!thread) throw new Error("스레드를 찾을 수 없습니다.");

      const signature = this.getSignatureHtml();
      thread.reply(body, { htmlBody: body + signature });

      Logger.log(`[GmailService] 스레드 ${threadId}에 답장 완료`);
      return true;
    } catch (e) {
      Logger.log(`[GmailService] 답장 실패: ${e.message}`);
      return false;
    }
  }
}