/**
 * 날짜/시간 포맷팅 헬퍼 (Date 객체 및 String 모두 지원)
 * @param {string|Date} value - ISO 8601 문자열 또는 Date 객체
 * @param {'datetime' | 'date' | 'time'} [type='datetime'] - 포맷 타입
 * @returns {string} - 'yyyy-mm-dd hh:ii:ss' or 'yyyy-mm-dd' or 'hh:ii'
 */
function formatDate(value, type = 'datetime') {
  if (!value) return '';

  try {
    // 1. [수정] 입력값이 '문자열'일 때만 특수 예외 처리 ('11:30' 같은 텍스트)
    if (typeof value === 'string') {
      if (type === 'time' && value.includes(':') && !value.includes('T')) {
        return value; 
      }
    }

    // 2. Date 객체 변환 (이미 Date면 그대로, 문자열이면 파싱)
    const date = new Date(value);
    
    // 유효성 검사
    if (isNaN(date.getTime())) {
      // 문자열인데 파싱 실패했다면 원본 반환 (혹시 모를 텍스트 데이터)
      return typeof value === 'string' ? value : 'Invalid Date';
    }

    // 3. 포맷팅 (KST 기준 아님, Apps Script는 기본적으로 스크립트 설정 타임존을 따름)
    // 시트에서 가져온 Date 객체는 이미 타임존이 보정된 상태일 확률이 높음.
    
    const year = date.getFullYear();
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');
    
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    const seconds = date.getSeconds().toString().padStart(2, '0');

    if (type === 'time') {
      return `${hours}:${minutes}`;
    }

    if (type === 'date') {
      return `${year}-${month}-${day}`;
    }

    // datetime
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;

  } catch (e) {
    Logger.log(`formatDate Error: ${e.message}`);
    return value; // 변환 실패 시 원본 반환
  }
}

/**
 * (SERVER) Include other HTML/CSS files if needed.
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function findBookingMail(
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

// "November 18, 8:30 PM" 형태 포맷 함수
function formatDateForGmailSubjectQuery(date) {
  const monthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];

  const year = date.getFullYear();
  const month = monthNames[date.getMonth()];
  const day = date.getDate();

  let hours = date.getHours();
  const minutes = (date.getMinutes() + '').padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;

  return `${month} ${day}, ${year} at ${hours}:${minutes} ${ampm}`;
}

function formatDateForGmailBodyQuery(date) {
  const monthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];

  const month = monthNames[date.getMonth()];
  const day = date.getDate();

  let hours = date.getHours();
  const minutes = (date.getMinutes() + '').padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;

  return `${month} ${day}, ${hours}:${minutes} ${ampm}`;
}

function formatDateForGmailReceivedQuery(date) {
  const yyyy = date.getFullYear();
  const mm = ('0' + (date.getMonth() + 1)).slice(-2);
  const dd = ('0' + date.getDate()).slice(-2);
  return `${yyyy}/${mm}/${dd}`;
}

function removeColumns(data, columnsToRemove) {
  if (!data || data.length === 0) return [];

  const headers = data[0];
  const indicesToRemove = headers
    .map((h, i) => columnsToRemove.includes(h) ? i : -1)
    .filter(i => i !== -1);

  if (indicesToRemove.length === 0) return data;

  return data.map(row => row.filter((_, index) => !indicesToRemove.includes(index)));
}

function getBranchInfo(branchName, lang = 'en') {
  const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SHEET_NAMES.BRANCH);
  if (!sheet) {
    throw new Error(`'${SHEET_NAMES.BRANCH}' 시트를 찾을 수 없습니다.`);
  }

  if (sheet.getLastRow() === 0) {
    return []; // 빈 시트
  }

  const range = sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn());
  let values = range.getValues();
  values.shift(); // 1행(헤더) 제거

  const branchIdColIdx = 0; // 'id' (A열)
  const calendarIdColIdx = 5;
  const branchNameEnColIdx = 1; // 'branch_name_en' (B열)
  const branchNameKoColIdx = 2; // 'branch_name_ko' (C열)
  const branchNameColIdx = lang === 'en' ? branchNameEnColIdx : branchNameKoColIdx;

  let branchId = null;
  let calendarId = null;
  let branchNameKo = null;

  for (const row of values) {
    if (row[branchNameColIdx] === branchName) {
      branchId = row[branchIdColIdx];
      calendarId = row[calendarIdColIdx];
      branchNameKo = row[branchNameKoColIdx];
      break;
    }
  }

  let branchInfo = null;
  if (branchId && calendarId && branchNameKo && branchName) {
    branchInfo = {
      branchId: branchId,
      calendarId: calendarId,
      branchNameKo: branchNameKo,
      branchNameEn: branchName,
    }
  }

  return branchInfo;
}

function toQueryString(obj) {
  return Object.keys(obj)
    .filter(k => obj[k] !== null && obj[k] !== undefined)
    .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(obj[k]))
    .join('&');
}

function extractQueryParam(url, key) {
  if (!url) return null;
  const regex = new RegExp('[?&]' + key + '=([^&#]*)');
  const match = url.match(regex);
  return match ? decodeURIComponent(match[1]) : null;
}