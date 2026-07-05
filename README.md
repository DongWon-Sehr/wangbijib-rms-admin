# 왕비집 예약관리 시스템 어드민 (wangbijib-rms-admin)

Google Workspace 플랫폼을 활용하여 왕비집 전 지점의 예약을 효율적으로 모니터링하고, 예약금 상태 및 예약 슬롯을 최적화하여 매출 관리를 돕는 백오피스 관리자 웹 애플리케이션입니다.

---

## 🛠️ 기술 스택 (Technology Stack)

- **Frontend:** Vue.js 3 (Composition API, CDN), Tailwind CSS (CDN), Phosphor Icons
- **Backend:** Google Apps Script (GAS)
- **Database:** Google Sheets
- **Libraries:** Summernote Lite (WYSIWYG 메일 템플릿 에디터), Kakao JS SDK (알림톡 연동)
- **Integration:** Google Calendar API, Gmail API

---

## 🌟 핵심 기능 (Key Features)

1. **예약 통합 리스트:**
   - 지점, 상태(대기/확정/취소), 예약금 여부에 대한 다중 복합 필터 및 정렬 기능.
   - 모바일 환경 최적화를 위한 터치 기반 **당겨서 새로고침(Pull-to-Refresh)** 및 인라인 예약 상태/예약금 상태 즉시 변경.
2. **실시간 동적 알림 (GNB Bell UI):**
   - 별도 DB 구축 없이 프론트엔드가 실시간 계산하여 알려주는 미결 상태 알림. 동일 예약 건에 대한 알림은 하나로 통합되고 다중 뱃지 형태로 노출됩니다.
    - **`[임박]`** (빨간 뱃지, 1분마다 자동 갱신): 예약 대기 상태(`pending`)인 예약건 중 현재 시각 기준 **6시간 이내** 방문이 임박한 예약.
    - **`[예약대기]`** (노란 뱃지): 미래 방문건 중 확정 대기 중인 예약.
    - **`[예약금대기]`** (주황 뱃지): 미래 방문건 중 예약금 입금 대기 중인 예약.
    - **`[환불필요]`** (파란 뱃지): 방문 예정 시각이 지났으나 예약금이 완료(확정) 상태인 예약.
    - 알림 카드 클릭 시 해당 예약 상세 모달을 즉시 팝업하여 편리한 후속 액션 연동.
3. **지점별 슬롯 마스터/오버라이드 관리:**
   - 특정 지점의 날짜별 슬롯을 일괄 제어(Batch API) 및 개별 재정의(ON/OFF) 기능.
   - 대량의 이벤트가 캘린더에 동기화되는 속도 향상을 위해 **Google Calendar Batch API** 및 백그라운드 지연 처리 큐 아키텍처 탑재.
4. **WYSIWYG 메일 템플릿 에디터:**
   - Summernote를 활용해 HTML 메일을 편집하고 예약 데이터 치환자Badge(`[[customer_name]]` 등)를 자동 태깅하여 고객에게 안내 메일 즉각 답장 발송.
5. **구글 캘린더 및 Gmail 라벨 연동:**
   - 예약 확정/취소 시 캘린더 이벤트 자동 등록/삭제 및 Gmail 스레드에 관련 지점 및 예약 진행 단계 라벨 실시간 자동 동기화.

---

## 🚀 배포 가이드 (Deployment via clasp)

본 프로젝트는 Google Apps Script로 작성되었으며, `clasp` 도구를 사용하여 배포합니다.

### 1. clasp 설치 및 로그인
```bash
# 글로벌 clasp 설치
npm install -g @google/clasp

# Google 계정 권한 인증 (웹 브라우저를 통한 인증 완료 필요)
clasp login
```

### 2. Code Push (업로드)
프로젝트 루트 폴더에는 `.clasp.json` 설정 파일이 존재합니다.
```bash
# 로컬 수정 코드를 Google Apps Script 프로젝트로 업로드 (배포)
clasp push

# 업로드 상태 유지하며 실시간 변경사항 감지 후 업로드
clasp push --watch
```

### 3. 배포(Deploy) 관리
구글 Apps Script 콘솔 또는 clasp CLI를 통해 웹 앱을 새 버전으로 배포하고 최신 URL을 배포 설정을 통해 갱신합니다.