function testAddUser() {
  let userData = {
    id: 'jongno_manager',
    username: '종로점 관리자',
    password: 'jongno',
    role: 'manager',
    enabled: true,
  };

  result = addUser(userData);
  console.log('result: ', result);
}


function testGetDropdownData() {
  const dropdownData = getDropdownData();
  console.log('dropdownData:', dropdownData);
}

function testGetPivotedSlotData() {
  const pivotedSlotData = getPivotedSlotData();
  console.log('pivotedSlotData:', pivotedSlotData);
}

function testGetBranchTable() {
  const branchTable = getSheetData(SHEET_NAMES.BRANCH, true);

  console.log(branchTable);
}

function testFindEmail() {
  const mailThreadId = '19a8b37b8584cbd2';
  const thread = GmailApp.getThreadById(mailThreadId);
  if (!thread) {
    console.log("해당 스레드를 찾을 수 없음");
    return;
  }

  // 스레드 내 모든 메시지 가져오기
  const messages = thread.getMessages();
  messages.forEach((msg, index) => {
    console.log(`--- Message ${index + 1} ---`);
    console.log("From: " + msg.getFrom());
    console.log("To: " + msg.getTo());
    console.log("Reply-To: " + msg.getReplyTo());
    console.log("Subject: " + msg.getSubject());
    console.log("Date: " + msg.getDate());
    console.log("Body: " + msg.getPlainBody().substring(0, 100)); // 일부만 출력
  });
}

function getUuids(count = 13) {
  for (let i = 0; i < count; i++) {
    console.log(Utilities.getUuid());
  }
}

function doPostTest() {
  let event = {
    postData: {
      contents: ''
    }
  };
  event.postData.contents = JSON.stringify({
    reservation_id: '156da8ba-277b-445f-a6a0-8c9836df3e9d',
  });

  doPost(event);
}

function getSignatureHtmlTest() {
  const html = new GmailService().getSignatureHtml();
  console.log(html);
}

function updateReservationStatusTest(id = '3980bbea-820b-4ae3-9742-9056aca9fcca', newStatus = false) {
  const result = updateReservationStatus(id, newStatus);

  console.log('result:');
  console.log(result);
}