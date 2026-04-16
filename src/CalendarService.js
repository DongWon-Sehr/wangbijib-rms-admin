/**
 * [CalendarService] 구글 캘린더 연동 관리 (Singleton)
 */
const CalendarService = {
  // 위젯(Elfsight) 연동용 원본 캘린더 ID (하드코딩 or 스크립트 속성)
  SOURCE_CALENDAR_ID: "wangbijib@gmail.com", 

  /**
   * [최적화] 특정 기간의 모든 이벤트를 조회하여 반환
   * - Google Calendar Event 객체를 순수 JS 객체로 매핑하여 V8 엔진 브릿지 병목 제거
   */
  getEventsInRange(calendarId, startDate, endDate) {
    try {
      if (!calendarId) return [];
      const cal = CalendarApp.getCalendarById(calendarId);
      if (!cal) return [];
      const events = cal.getEvents(startDate, endDate);
      
      // 순수 JS 객체 배열로 변환하여 리턴 (속도 최적화 핵심)
      return events.map(e => ({
        event: e, // 원본 객체 (삭제/수정용)
        title: e.getTitle(),
        startTimeMs: e.getStartTime().getTime(),
        endTimeMs: e.getEndTime().getTime()
      }));
    } catch (e) {
      console.log(`[Calendar] Bulk Get Error: ${e.message}`);
      return [];
    }
  },

  /**
   * [Target] 이벤트 생성
   */
  createEvent(calendarId, title, startTime, description) {
    if (!calendarId) return null;
    try {
      const cal = CalendarApp.getCalendarById(calendarId);
      if (!cal) throw new Error(`Calendar not found: ${calendarId}`);

      const endTime = new Date(startTime);
      endTime.setMinutes(endTime.getMinutes() + 60); // 기본 1시간 예약

      const event = cal.createEvent(title, startTime, endTime, { description: description });
      event.addPopupReminder(30); // 30분 전 알림

      return event.getId();
    } catch (e) {
      console.log(`[Calendar] Create Error: ${e.message}`);
      return null;
    }
  },

  /**
   * [Target] 이벤트 수정
   */
  updateEvent(calendarId, eventId, title, startTime, description) {
    if (!calendarId || !eventId) return;
    try {
      const cal = CalendarApp.getCalendarById(calendarId);
      const event = cal.getEventById(eventId);
      if (event) {
        const endTime = new Date(startTime);
        endTime.setMinutes(endTime.getMinutes() + 60);

        event.setTitle(title);
        event.setDescription(description);
        event.setTime(startTime, endTime);
      }
    } catch (e) {
      console.log(`[Calendar] Update Error: ${e.message}`);
    }
  },

  /**
   * [Target] 이벤트 삭제
   */
  deleteEvent(calendarId, eventId) {
    if (!calendarId || !eventId) return;
    try {
      const cal = CalendarApp.getCalendarById(calendarId);
      const event = cal.getEventById(eventId);
      if (event) {
        event.deleteEvent();
      }
    } catch (e) {
      console.log(`[Calendar] Delete Error: ${e.message}`);
    }
  },

  /**
   * [Target] 특정 시간대 이벤트 개수 조회 (슬롯 카운팅용)
   * - 정확히 해당 시간에 시작하는 이벤트만 카운트
   * @param {string} calendarId - 캘린더 ID
   * @param {Date} dateObj - 대상 날짜 및 시간
   * @param {Array} cachedEvents - (Optional) 캐시된 이벤트 목록 (getEventsInRange로 생성된 순수 객체 배열)
   */
  getEventCount(calendarId, dateObj, cachedEvents = null) {
    try {
      const startTime = new Date(dateObj);
      const endTime = new Date(startTime.getTime() + 1000); // 1초 간격 조회
      const startTimeMs = startTime.getTime();
      const endTimeMs = endTime.getTime();

      let events;
      if (Array.isArray(cachedEvents)) {
        // 매핑된 순수 객체를 사용하여 초고속 필터링
        events = cachedEvents.filter(e => {
          return e.startTimeMs < endTimeMs && e.endTimeMs > startTimeMs;
        });
      } else {
        // 기존 로직 (API 호출)
        if (!calendarId) return 0;
        const cal = CalendarApp.getCalendarById(calendarId);
        if (!cal) return 0;
        events = cal.getEvents(startTime, endTime);
      }
      return events.length;
    } catch (e) {
      console.log(`[Calendar] Count Error: ${e.message}`);
      return 0;
    }
  },

  /**
   * [Source] 블로킹 이벤트 생성 (슬롯 마감)
   * - 제목이 지점명(영문)인 이벤트를 생성하여 위젯에서 예약 불가하게 만듦
   * @param {string} branchNameEn - 지점 영문명
   * @param {Date} dateObj - 대상 날짜 및 시간
   * @param {Array} cachedEvents - (Optional) 캐시된 이벤트 목록 (getEventsInRange로 생성된 순수 객체 배열)
   */
  createSourceBlockingEvent(branchNameEn, dateObj, cachedEvents = null) {
    try {
      const startTime = new Date(dateObj);
      const endTime = new Date(startTime.getTime() + 30 * 60 * 1000); // 30분 블로킹
      const startTimeMs = startTime.getTime();
      const endTimeMs = endTime.getTime();

      let exists = false;
      if (Array.isArray(cachedEvents)) {
        // 매핑된 순수 객체를 사용하여 초고속 검사
        exists = cachedEvents.some(e => {
          return e.startTimeMs < endTimeMs && e.endTimeMs > startTimeMs && e.title.includes(branchNameEn);
        });
      } else {
        // 기존 로직 (API 호출)
        const cal = CalendarApp.getCalendarById(this.SOURCE_CALENDAR_ID);
        if (!cal) return;
        const events = cal.getEvents(startTime, endTime);
        exists = events.some(e => e.getTitle().includes(branchNameEn));
      }

      if (!exists) {
        const cal = CalendarApp.getCalendarById(this.SOURCE_CALENDAR_ID);
        if (cal) {
          cal.createEvent(branchNameEn, startTime, endTime, { description: 'System Auto-Blocked' });
          console.log(`[Calendar] Blocked: ${branchNameEn} at ${startTime}`);
          
          // 방금 생성한 이벤트도 캐시에 반영 (동일 실행 컨텍스트 내 정합성 유지)
          if (Array.isArray(cachedEvents)) {
             cachedEvents.push({
               event: null, // 당장 지울 일은 없으므로 임시 더미 객체
               title: branchNameEn,
               startTimeMs: startTimeMs,
               endTimeMs: endTimeMs
             });
          }
        }
      }
    } catch (e) {
      console.log(`[Calendar] Block Error: ${e.message}`);
    }
  },

  /**
   * [Source Batch] 블로킹 이벤트 생성 요청 객체 반환 (슬롯 마감)
   * @param {string} branchNameEn - 지점 영문명
   * @param {Date} dateObj - 대상 날짜 및 시간
   * @param {Array} cachedEvents - (Optional) 캐시된 이벤트 목록 (getEventsInRange로 생성된 순수 객체 배열)
   * @returns {Object|null} - Batch API용 요청 객체 (또는 이미 존재하면 null)
   */
  createSourceBlockingEventRequest(branchNameEn, dateObj, cachedEvents = null) {
    try {
      const startTime = new Date(dateObj);
      const endTime = new Date(startTime.getTime() + 30 * 60 * 1000); // 30분 블로킹
      const startTimeMs = startTime.getTime();
      const endTimeMs = endTime.getTime();

      let exists = false;
      if (Array.isArray(cachedEvents)) {
        exists = cachedEvents.some(e => {
          return e.startTimeMs < endTimeMs && e.endTimeMs > startTimeMs && e.title.includes(branchNameEn);
        });
      } else {
        const cal = CalendarApp.getCalendarById(this.SOURCE_CALENDAR_ID);
        if (!cal) return null;
        const events = cal.getEvents(startTime, endTime);
        exists = events.some(e => e.getTitle().includes(branchNameEn));
      }

      if (!exists) {
        const tz = Session.getScriptTimeZone();
        const request = {
          method: 'POST',
          url: `/calendar/v3/calendars/${encodeURIComponent(this.SOURCE_CALENDAR_ID)}/events`,
          body: {
            summary: branchNameEn,
            description: 'System Auto-Blocked',
            start: { dateTime: Utilities.formatDate(startTime, tz, "yyyy-MM-dd'T'HH:mm:ssXXX") },
            end: { dateTime: Utilities.formatDate(endTime, tz, "yyyy-MM-dd'T'HH:mm:ssXXX") }
          }
        };

        if (Array.isArray(cachedEvents)) {
           cachedEvents.push({
             event: null, 
             title: branchNameEn,
             startTimeMs: startTimeMs,
             endTimeMs: endTimeMs
           });
        }
        return request;
      }
      return null;
    } catch (e) {
      console.log(`[Calendar] Block Request Error: ${e.message}`);
      return null;
    }
  },

  /**
   * [Source] 블로킹 이벤트 삭제 (슬롯 오픈)
   * @param {string} branchNameEn - 지점 영문명
   * @param {Date} dateObj - 대상 날짜 및 시간
   * @param {Array} cachedEvents - (Optional) 캐시된 이벤트 목록 (getEventsInRange로 생성된 순수 객체 배열)
   */
  deleteSourceBlockingEvent(branchNameEn, dateObj, cachedEvents = null) {
    try {
      const startTime = new Date(dateObj);
      const endTime = new Date(startTime.getTime() + 30 * 60 * 1000);
      const startTimeMs = startTime.getTime();
      const endTimeMs = endTime.getTime();

      let target = null;
      let targetIndex = -1;
      
      if (Array.isArray(cachedEvents)) {
        // 매핑된 순수 객체를 사용하여 초고속 검사
        targetIndex = cachedEvents.findIndex(e => {
          return e.startTimeMs < endTimeMs && e.endTimeMs > startTimeMs && e.title.includes(branchNameEn);
        });
        
        if (targetIndex !== -1) {
            target = cachedEvents[targetIndex];
        }
      } else {
        // 기존 로직 (API 호출)
        const cal = CalendarApp.getCalendarById(this.SOURCE_CALENDAR_ID);
        if (!cal) return;
        const events = cal.getEvents(startTime, endTime);
        target = events.find(e => e.getTitle().includes(branchNameEn));
      }

      if (target) {
        if (Array.isArray(cachedEvents)) {
            // 캐시 모드일 경우: 원본 객체로 삭제 호출 후 캐시 배열에서도 제거
            if (target.event) target.event.deleteEvent();
            cachedEvents.splice(targetIndex, 1);
        } else {
            // 기존 로직
            target.deleteEvent();
        }
        console.log(`[Calendar] Unblocked: ${branchNameEn} at ${startTime}`);
      }
    } catch (e) {
      console.log(`[Calendar] Unblock Error: ${e.message}`);
    }
  },

  /**
   * [Source Batch] 블로킹 이벤트 삭제 요청 객체 반환 (슬롯 오픈)
   * @param {string} branchNameEn - 지점 영문명
   * @param {Date} dateObj - 대상 날짜 및 시간
   * @param {Array} cachedEvents - (Optional) 캐시된 이벤트 목록 (getEventsInRange로 생성된 순수 객체 배열)
   * @returns {Object|null} - Batch API용 요청 객체 (또는 삭제할 대상이 없으면 null)
   */
  deleteSourceBlockingEventRequest(branchNameEn, dateObj, cachedEvents = null) {
    try {
      const startTime = new Date(dateObj);
      const endTime = new Date(startTime.getTime() + 30 * 60 * 1000);
      const startTimeMs = startTime.getTime();
      const endTimeMs = endTime.getTime();

      let target = null;
      let targetIndex = -1;
      
      if (Array.isArray(cachedEvents)) {
        targetIndex = cachedEvents.findIndex(e => {
          return e.startTimeMs < endTimeMs && e.endTimeMs > startTimeMs && e.title.includes(branchNameEn);
        });
        if (targetIndex !== -1) {
            target = cachedEvents[targetIndex];
        }
      } else {
        const cal = CalendarApp.getCalendarById(this.SOURCE_CALENDAR_ID);
        if (!cal) return null;
        const events = cal.getEvents(startTime, endTime);
        target = events.find(e => e.getTitle().includes(branchNameEn));
      }

      if (target && target.event) {
        let eventId = target.event.getId();
        if (eventId.includes('@')) {
          eventId = eventId.split('@')[0];
        }
        const request = {
          method: 'DELETE',
          url: `/calendar/v3/calendars/${encodeURIComponent(this.SOURCE_CALENDAR_ID)}/events/${eventId}`,
          body: null
        };
        
        if (Array.isArray(cachedEvents)) {
           cachedEvents.splice(targetIndex, 1);
        }
        return request;
      }
      return null;
    } catch (e) {
      console.log(`[Calendar] Unblock Request Error: ${e.message}`);
      return null;
    }
  },

  /**
   * [Batch API] 다수의 구글 캘린더 일괄 처리 (Advanced Google Services 필요)
   * - Calendar.Events.insert, Calendar.Events.remove 등의 요청을 배열로 받아
   *   multipart/mixed 형식의 페이로드로 묶어 UrlFetchApp 으로 전송.
   * - 한 번에 최대 50개의 요청을 묶어서 전송 가능.
   * 
   * @param {Array} requests - [{ method: 'POST|DELETE', url: '/calendar/v3/calendars/...', body: {...} }, ...]
   */
  executeBatchRequests(requests) {
    if (!requests || requests.length === 0) return;

    // 최대 50개 단위로 청크 처리
    const chunkSize = 50;
    for (let i = 0; i < requests.length; i += chunkSize) {
      const chunk = requests.slice(i, i + chunkSize);
      this._sendBatchChunk(chunk);
      
      // 구글 캘린더 Batch API 호출 제한 방지를 위해 0.5초(500ms) 대기
      if (i + chunkSize < requests.length) {
        Utilities.sleep(500); 
      }
    }
  },

  /**
   * [Batch API Helper] 50개 이하의 청크를 실제 구글 엔드포인트로 전송
   */
  _sendBatchChunk(chunk) {
    try {
      const boundary = 'batch_calendar_boundary_' + Util.getUuid().replace(/-/g, '');
      let payload = '';

      chunk.forEach((req, index) => {
        payload += '--' + boundary + '\r\n';
        payload += 'Content-Type: application/http\r\n';
        payload += 'Content-ID: req' + index + '\r\n\r\n';
        
        payload += req.method + ' ' + req.url + '\r\n';
        
        if (req.body) {
          payload += 'Content-Type: application/json\r\n\r\n';
          payload += JSON.stringify(req.body) + '\r\n\r\n';
        } else {
          payload += '\r\n\r\n';
        }
      });

      payload += '--' + boundary + '--';

      const token = ScriptApp.getOAuthToken();
      const options = {
        method: 'post',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'multipart/mixed; boundary=' + boundary
        },
        payload: payload,
        muteHttpExceptions: true
      };

      const res = UrlFetchApp.fetch('https://www.googleapis.com/batch/calendar/v3', options);
      
      if (res.getResponseCode() >= 400) {
         console.log(`[CalendarService] _sendBatchChunk HTTP Error: ${res.getResponseCode()} / ${res.getContentText()}`);
      }
    } catch(e) {
      console.log(`[CalendarService] _sendBatchChunk Runtime Error: ${e.message}`);
    }
  }
};