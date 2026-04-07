/**
 * [CalendarService] 구글 캘린더 연동 관리 (Singleton)
 */
const CalendarService = {
  // 위젯(Elfsight) 연동용 원본 캘린더 ID (하드코딩 or 스크립트 속성)
  SOURCE_CALENDAR_ID: "wangbijib@gmail.com", 

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
      Logger.log(`[Calendar] Create Error: ${e.message}`);
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
      Logger.log(`[Calendar] Update Error: ${e.message}`);
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
      Logger.log(`[Calendar] Delete Error: ${e.message}`);
    }
  },

  /**
   * [Target] 특정 시간대 이벤트 개수 조회 (슬롯 카운팅용)
   * - 정확히 해당 시간에 시작하는 이벤트만 카운트
   */
  getEventCount(calendarId, dateObj) {
    try {
      if (!calendarId) return 0;
      const cal = CalendarApp.getCalendarById(calendarId);
      if (!cal) return 0;

      const startTime = new Date(dateObj);
      const endTime = new Date(startTime.getTime() + 1000); // 1초 간격 조회

      const events = cal.getEvents(startTime, endTime);
      return events.length;
    } catch (e) {
      Logger.log(`[Calendar] Count Error: ${e.message}`);
      return 0;
    }
  },

  /**
   * [Source] 블로킹 이벤트 생성 (슬롯 마감)
   * - 제목이 지점명(영문)인 이벤트를 생성하여 위젯에서 예약 불가하게 만듦
   */
  createSourceBlockingEvent(branchNameEn, dateObj) {
    try {
      const cal = CalendarApp.getCalendarById(this.SOURCE_CALENDAR_ID);
      if (!cal) return;

      const startTime = new Date(dateObj);
      const endTime = new Date(startTime.getTime() + 30 * 60 * 1000); // 30분 블로킹

      // 이미 블로킹 이벤트가 있는지 확인 (중복 방지)
      const events = cal.getEvents(startTime, endTime);
      const exists = events.some(e => e.getTitle().includes(branchNameEn));

      if (!exists) {
        cal.createEvent(branchNameEn, startTime, endTime, { description: 'System Auto-Blocked' });
        Logger.log(`[Calendar] Blocked: ${branchNameEn} at ${startTime}`);
      }
    } catch (e) {
      Logger.log(`[Calendar] Block Error: ${e.message}`);
    }
  },

  /**
   * [Source] 블로킹 이벤트 삭제 (슬롯 오픈)
   */
  deleteSourceBlockingEvent(branchNameEn, dateObj) {
    try {
      const cal = CalendarApp.getCalendarById(this.SOURCE_CALENDAR_ID);
      if (!cal) return;

      const startTime = new Date(dateObj);
      const endTime = new Date(startTime.getTime() + 30 * 60 * 1000);

      const events = cal.getEvents(startTime, endTime);
      const target = events.find(e => e.getTitle().includes(branchNameEn));

      if (target) {
        target.deleteEvent();
        Logger.log(`[Calendar] Unblocked: ${branchNameEn} at ${startTime}`);
      }
    } catch (e) {
      Logger.log(`[Calendar] Unblock Error: ${e.message}`);
    }
  }
};