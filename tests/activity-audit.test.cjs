const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function setup() {
  const data = {reservation:[{id:'r1',customer_name:'홍길동',email:'old@example.com',email_thread_id:'old-thread',is_read:false}],user:[],branch:[],mail_template:[],slot_default:[],slot_override:[],duplicate_group:[]};
  const context = {
    console, Config:{SHEET_NAMES:{RESERVATION:'reservation',USER:'user',BRANCH:'branch',MAIL_TEMPLATE:'mail_template',SLOT_DEFAULT:'slot_default',SLOT_OVERRIDE:'slot_override'}},
    Util:{getSheetDataAsObjects:name => data[name] || [],formatDate:value => String(value).slice(0,10)},
    UserService:{getAllUsers:() => data.user},DuplicateGroupService:{getAllGroups:() => data.duplicate_group},
    ReservationService:{getReservationById:id => data.reservation.find(row => row.id === id)}
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('src/ActivityAudit.js','utf8'),context);
  const audit = vm.runInContext('ActivityAudit',context);
  return {data,audit};
}
const plain = value => JSON.parse(JSON.stringify(value));

test('user audit records actual permissions, role and activation with no request secrets', () => {
  const {data,audit} = setup();
  data.user = [{id:'u1',user_name:'기존',role:'manager',branch_ids:['b2','b1'],enabled:true}];
  const params = {data:{id:'u1',user_name:'수정',role:'admin',branch_ids:['b3'],enabled:false,access_token:'secret'}};
  const before = audit.capture('apiSaveSystemSettings:user',params);
  Object.assign(data.user[0],params.data);
  const details = plain(audit.details('apiSaveSystemSettings:user',params,before));
  assert.deepEqual(details.changes.map(row => row.key),['user_name','role','branch_ids','enabled']);
  assert.deepEqual(details.changes[2].before,['b1','b2']);
  assert.deepEqual(details.changes[2].after,['b3']);
  assert.equal(details.changes[3].before,true);
  assert.equal(details.changes[3].after,false);
  assert.doesNotMatch(JSON.stringify(details),/secret|access_token/);
});

test('template change and deletion retain prior content, branch captures only changed fields', () => {
  const {data,audit} = setup();
  data.mail_template = [{id:'t1',template_name:'안내',body_html:'<p>이전</p>',enabled:true}];
  const before = audit.capture('apiSaveSystemSettings:mail_template',{data:{id:'t1'}});
  data.mail_template[0].body_html = '<p>변경</p>';
  const edited = audit.details('apiSaveSystemSettings:mail_template',{data:{id:'t1'}},before);
  assert.deepEqual(plain(edited.changes),[{key:'body_html',field:'메일 본문',before:'<p>이전</p>',after:'<p>변경</p>'}]);
  const deleting = audit.capture('apiDeleteSystemData:mail_template',{id:'t1'});
  data.mail_template = [];
  const deleted = audit.details('apiDeleteSystemData:mail_template',{id:'t1'},deleting);
  assert.equal(deleted.changes.find(row => row.key === 'body_html').before,'<p>변경</p>');
  assert.equal(deleted.changes.find(row => row.key === 'body_html').after,'');
  data.branch = [{id:'b1',branch_name_ko:'명동',address:'이전 주소',enabled:true}];
  const branchBefore = audit.capture('apiSaveSystemSettings:branch',{data:{id:'b1'}});
  data.branch[0].address = '새 주소';
  assert.deepEqual(plain(audit.details('apiSaveSystemSettings:branch',{data:{id:'b1'}},branchBefore).changes),[{key:'address',field:'주소',before:'이전 주소',after:'새 주소'}]);
});

test('slot audit limits scope and records time context for individual changed values', () => {
  const {data,audit} = setup();
  data.slot_default = [{id:'d1',branch_id:'b1',slot_master_id:'s1',slot:4,enabled:true},{id:'d2',branch_id:'b2',slot_master_id:'s1',slot:8,enabled:true}];
  const params = {data:{branch_id:'b1',payload:{s1:{slot:2,enabled:false},s2:{slot:3,enabled:true}}}};
  const before = audit.capture('apiSaveSystemSettings:slot_batch',params);
  Object.assign(data.slot_default[0],{slot:2,enabled:false});
  data.slot_default.push({id:'d3',branch_id:'b1',slot_master_id:'s2',slot:3,enabled:true});
  const changes = plain(audit.details('apiSaveSystemSettings:slot_batch',params,before).changes);
  assert.equal(changes.length,4);
  assert.deepEqual(changes[0],{key:'slot',field:'슬롯 수',before:4,after:2,slot_master_id:'s1',date:''});
  assert.deepEqual(changes.map(row => row.slot_master_id),['s1','s1','s2','s2']);
  assert.equal(changes[2].before,'');
});

test('mail and duplicate log entries store the exact agreed identity format', () => {
  const {data,audit} = setup();
  data.mail_template = [{id:'t1',template_name:'예약 안내'}];
  assert.deepEqual(plain(audit.entries('apiSendTemplatedMail',{reservationId:'r1',templateId:'t1'},null,{})),[
    {label:'예약',value:'홍길동 (r1)'},{label:'템플릿',value:'예약 안내 (t1)'}
  ]);
  assert.deepEqual(plain(audit.entries('apiClearDuplicateGroup',{groupId:'g1',reservationIds:['r1']},null,{})),[{label:'예약',value:'r1 - 홍길동 (old@example.com)'}]);
  assert.deepEqual(plain(audit.entries('apiSendDuplicateConfirmationMail',{groupId:'g1',targetReservationId:'r1'},null,{})),[{label:'발송 예약',value:'r1 - 홍길동 (old@example.com)'}]);
});

test('automatic helpers and maintenance APIs do not create user action logs', () => {
  const {audit} = setup();
  for (const api of ['apiAddLabelsToThread','apiMarkDuplicateMailSent','webhookMessageSentAt','apiRunSchemaMigration','apiBackfillDuplicateGroups']) assert.equal(audit.shouldRecord(api),false);
  assert.equal(audit.shouldRecord('apiMarkReservationAsRead'),true);
  assert.equal(audit.shouldRecord('apiSaveSystemSettings:user'),true);
});
