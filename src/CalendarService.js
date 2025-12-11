class CalendarService {
  constructor() {
    this.SOURCE_CALENDAR_ID = "wangbijib@gmail.com";
  }

  /**
   * [Create] 이벤트 생성
   */
  createEvent(calendarId, title, startTime, description) {
    if (!calendarId) return null;
    try {
      const cal = CalendarApp.getCalendarById(calendarId);
      if (!cal) throw new Error(`캘린더(${calendarId})를 찾을 수 없습니다.`);

      const endTime = new Date(startTime);
      endTime.setMinutes(endTime.getMinutes() + 60); // 기본 1시간

      const event = cal.createEvent(title, startTime, endTime, { description: description });
      event.addPopupReminder(30);

      return event.getId();
    } catch (e) {
      Logger.log(`[CalendarService] 생성 실패: ${e.message}`);
      return null;
    }
  }

  /**
   * [Update] 이벤트 수정
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
      Logger.log(`[CalendarService] 수정 실패: ${e.message}`);
    }
  }

  /**
   * [Delete] 이벤트 삭제
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
      Logger.log(`[CalendarService] 삭제 실패: ${e.message}`);
    }
  }

  /**
   * [Count] 특정 시간대 이벤트 개수 조회 (슬롯 체크용)
   */
  getEventCount(calendarId, dateObj) {
    try {
      if (!calendarId) return 0;
      const cal = CalendarApp.getCalendarById(calendarId);
      if (!cal) return 0;

      const startTime = new Date(dateObj);
      // 1초 뒤까지만 검색 (정확히 해당 시간에 시작하는 이벤트만 카운트)
      const endTime = new Date(startTime.getTime() + 1000);

      const events = cal.getEvents(startTime, endTime);
      return events.length;
    } catch (e) {
      Logger.log(`[CalendarService] 카운트 실패: ${e.message}`);
      return 0;
    }
  }

  /**
   * [Source] 원본 캘린더(위젯) 이벤트 삭제 (슬롯 오픈용)
   */
  deleteSourceEventIfExists(branchNameEn, dateObj) {
    try {
      const sourceCal = CalendarApp.getCalendarById(this.SOURCE_CALENDAR_ID);
      if (!sourceCal) return;

      const startTime = new Date(dateObj);
      const endTime = new Date(startTime.getTime() + 30 * 60 * 1000); // 30분 범위

      const events = sourceCal.getEvents(startTime, endTime);
      // 제목에 지점명이 포함된 이벤트 찾기
      const targetEvent = events.find(e => e.getTitle().includes(branchNameEn));

      if (targetEvent) {
        targetEvent.deleteEvent();
        Logger.log(`[CalendarService] Source 이벤트 삭제됨: ${branchNameEn}`);
      }
    } catch (e) {
      Logger.log(`[CalendarService] Source 삭제 실패: ${e.message}`);
    }
  }

  addSourceEventIfNotExists(branchNameEn, dateObj) {
    try {
      const sourceCal = CalendarApp.getCalendarById(this.SOURCE_CALENDAR_ID);
      if (!sourceCal) return;

      const startTime = new Date(dateObj);
      const endTime = new Date(startTime.getTime() + 30 * 60 * 1000); // 30분 범위

      const events = sourceCal.getEvents(startTime, endTime);
      // 제목에 지점명이 포함된 이벤트 찾기
      const targetEvent = events.find(e => e.getTitle().includes(branchNameEn));

      if (!targetEvent) {
        const title = branchNameEn;
        const description = 'System auto-generated event.';
        const event = sourceCal.createEvent(title, startTime, endTime, { description: description });
        Logger.log(`[CalendarService] Source 이벤트 추가됨: ${branchNameEn}`);
      }
    } catch (e) {
      Logger.log(`[CalendarService] Source 삭제 실패: ${e.message}`);
    }
  }
}