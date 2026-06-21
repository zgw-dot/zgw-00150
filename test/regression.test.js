const http = require('http');
const path = require('path');
const fs = require('fs');

const BASE = 'http://localhost:3000';
const DEVICE_A = 'dev_test_guard_001';
const DEVICE_A_NAME = 'Guard-PC';
const DEVICE_B = 'dev_test_approver_001';
const DEVICE_B_NAME = 'Approver-PC';

let passed = 0;
let failed = 0;
const failures = [];

function assert(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    failures.push({ name, detail });
    console.log(`  ❌ ${name}  ${detail ? '-> ' + detail : ''}`);
  }
}

function req(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, BASE);
    const opts = {
      method,
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      headers: { 'Content-Type': 'application/json' }
    };
    const reqObj = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try {
          const parsed = data ? JSON.parse(data) : {};
          resolve({ status: res.statusCode, body: parsed, headers: res.headers });
        } catch (e) {
          resolve({ status: res.statusCode, raw: data, headers: res.headers });
        }
      });
    });
    reqObj.on('error', reject);
    if (body) reqObj.write(JSON.stringify(body));
    reqObj.end();
  });
}

const RUN_TAG = Math.random().toString(36).slice(2, 6);

function makeVisitorRecord(override) {
  const id = 'v_t' + RUN_TAG + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 4);
  const now = Date.now() + Math.floor(Math.random() * 86400_000);
  const start = new Date(now + 3600_000).toISOString();
  const end = new Date(now + 3 * 3600_000).toISOString();
  const rnd = Math.floor(Math.random() * 9000 + 1000);
  return Object.assign({
    id,
    name: '访客' + RUN_TAG + rnd,
    idTail: String(rnd),
    department: '计算机学院',
    escort: '张老师',
    entrance: '东门',
    validStart: start,
    validEnd: end,
    status: 'pending_sync',
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString()
  }, override || {});
}

async function runAll() {
  console.log('\n=== 校园访客通行系统 · 自动化回归测试 ===\n');

  // ---------- Health ----------
  console.log('[0] 健康检查');
  try {
    const r = await req('GET', '/api/health');
    assert('服务正常响应', r.status === 200 && r.body.ok);
  } catch (e) {
    assert('服务可访问', false, e.message);
    return;
  }

  // ---------- 主链路：登记 → 同步 → 人工处理 → 审批完成 ----------
  console.log('\n[1] 主链路：登记→同步→审批完成');
  let mainVisitor = makeVisitorRecord({ name: RUN_TAG + '-主链路-赵六', idTail: RUN_TAG + '7777', department: '教务处' });
  let pushRes = await req('POST', '/api/sync/push', {
    records: [mainVisitor],
    deviceId: DEVICE_A,
    deviceName: DEVICE_A_NAME,
    operator: DEVICE_A_NAME,
    operatorRole: 'guard'
  });
  assert('同步推送成功', pushRes.status === 200 && pushRes.body.ok, `status=${pushRes.status}`);
  assert('新记录状态为 created', pushRes.body.results[0].status === 'created', `got=${pushRes.body.results[0].status}`);
  const mainId = pushRes.body.results[0].id;

  let getRes = await req('GET', '/api/visitors/' + mainId);
  assert('记录可查询', getRes.status === 200 && getRes.body.ok);
  assert('状态转换为待审批', getRes.body.record.status === 'pending_approval', `got=${getRes.body.record.status}`);
  assert('来源设备记录正确', getRes.body.record.sourceDevice === DEVICE_A, `got=${getRes.body.record.sourceDevice}`);
  assert('来源设备名记录正确', getRes.body.record.sourceDeviceName === DEVICE_A_NAME);
  assert('同步时间存在', !!getRes.body.record.syncedAt);

  // 审批通过
  let approveRes = await req('PATCH', '/api/visitors/' + mainId, {
    status: 'approved',
    approver: DEVICE_B_NAME,
    approverRole: 'approver',
    operator: DEVICE_B_NAME
  });
  assert('审批放行成功', approveRes.status === 200 && approveRes.body.ok);
  assert('审批后状态为已放行', approveRes.body.record.status === 'approved');
  assert('审批人已记录', approveRes.body.record.approver === DEVICE_B_NAME);

  // 验证从待处理队列移除
  let pendingRes = await req('GET', '/api/pending');
  assert('已放行记录不在待处理队列',
    !pendingRes.body.pending.some(p => p.recordId === mainId));

  // ---------- 失败链路：越权操作被拒 ----------
  console.log('\n[2] 失败链路：越权操作被拒');
  let guardVisitor = makeVisitorRecord({ name: RUN_TAG + '-越权测试-钱七', idTail: RUN_TAG + '6666' });
  let push2 = await req('POST', '/api/sync/push', {
    records: [guardVisitor],
    deviceId: DEVICE_A,
    deviceName: DEVICE_A_NAME,
    operator: DEVICE_A_NAME,
    operatorRole: 'guard'
  });
  const guardId = push2.body.results[0].id;

  let guardApprove = await req('PATCH', '/api/visitors/' + guardId, {
    status: 'approved',
    approver: DEVICE_A_NAME,
    approverRole: 'guard',
    operator: DEVICE_A_NAME
  });
  assert('保安无权放行（403）', guardApprove.status === 403, `got=${guardApprove.status}`);
  assert('返回错误信息', guardApprove.body.error && guardApprove.body.error.includes('保安'));

  let guardVisitor2 = makeVisitorRecord({ name: RUN_TAG + '-越权测试-孙八', idTail: RUN_TAG + '5555' });
  let push3 = await req('POST', '/api/sync/push', {
    records: [guardVisitor2],
    deviceId: DEVICE_A,
    deviceName: DEVICE_A_NAME,
    operator: DEVICE_A_NAME,
    operatorRole: 'guard'
  });
  const guardId2 = push3.body.results[0].id;

  // 先把它变成 approved 状态（模拟已放行）
  await req('PATCH', '/api/visitors/' + guardId2, {
    status: 'approved',
    approver: DEVICE_B_NAME,
    approverRole: 'approver',
    operator: DEVICE_B_NAME
  });
  // 保安尝试撤销已放行的
  let revokeByGuard = await req('PATCH', '/api/visitors/' + guardId2, {
    status: 'revoked',
    approverRole: 'guard',
    operator: DEVICE_A_NAME
  });
  assert('保安不能撤销已放行记录（403）', revokeByGuard.status === 403, `got=${revokeByGuard.status}`);

  // 越权操作有审计日志
  let auditRes = await req('GET', '/api/audit?role=approver');
  const denyLogs = auditRes.body.records.filter(a => a.action === 'permission_denied');
  assert('越权操作写入审计日志', denyLogs.length >= 2, `count=${denyLogs.length}`);

  // ---------- 失败链路：重复数据不直接放行 ----------
  console.log('\n[3] 失败链路：重复/冲突数据不静默覆盖');
  let dupVisitor1 = makeVisitorRecord({ name: RUN_TAG + '-重复测试-周九', idTail: RUN_TAG + '4444', department: '学生处' });
  let pushDup1 = await req('POST', '/api/sync/push', {
    records: [dupVisitor1],
    deviceId: DEVICE_A,
    deviceName: DEVICE_A_NAME,
    operator: DEVICE_A_NAME,
    operatorRole: 'guard'
  });
  assert('第一条记录创建成功', pushDup1.body.results[0].status === 'created');
  const dupId1 = pushDup1.body.results[0].id;

  let dupVisitor2 = makeVisitorRecord({
    name: RUN_TAG + '-重复测试-周九',
    idTail: RUN_TAG + '4444',
    department: '学生处',
    validStart: dupVisitor1.validStart,
    validEnd: dupVisitor1.validEnd,
    id: 'v_test_dup_' + Date.now().toString(36)
  });
  let pushDup2 = await req('POST', '/api/sync/push', {
    records: [dupVisitor2],
    deviceId: DEVICE_B,
    deviceName: DEVICE_B_NAME,
    operator: DEVICE_B_NAME,
    operatorRole: 'guard'
  });
  assert('重复记录不直接创建（转人工）',
    pushDup2.body.results[0].status === 'overlap_conflict',
    `got=${pushDup2.body.results[0].status}`);
  assert('返回冲突原因', !!pushDup2.body.results[0].conflict && !!pushDup2.body.results[0].conflict.reason);
  const dupId2 = pushDup2.body.results[0].id;

  let dup2Get = await req('GET', '/api/visitors/' + dupId2);
  assert('重复记录状态为待人工处理', dup2Get.body.record.status === 'pending_manual',
    `got=${dup2Get.body.record.status}`);

  let pending2 = await req('GET', '/api/pending');
  const dupPending = pending2.body.pending.find(p => p.recordId === dupId2);
  assert('重复记录进入待处理中心', !!dupPending);
  assert('待处理记录含冲突类型', dupPending.conflictType === 'overlap_conflict');
  assert('待处理记录含来源设备', dupPending.sourceDevice === DEVICE_B);
  assert('待处理记录含最近同步时间', !!dupPending.lastSyncedAt);

  // 重复记录不能直接审批
  let dupApprove = await req('PATCH', '/api/visitors/' + dupId2, {
    status: 'approved',
    approver: DEVICE_B_NAME,
    approverRole: 'approver',
    operator: DEVICE_B_NAME
  });
  assert('待人工处理记录不能直接审批（400）', dupApprove.status === 400, `got=${dupApprove.status}`);

  // ---------- 人工处理链路 ----------
  console.log('\n[4] 人工处理：认领、改资料、重新提交、放行');
  // 认领
  let claimRes = await req('POST', `/api/pending/${dupId2}/resolve`, {
    action: 'claim',
    handler: DEVICE_B_NAME,
    handlerRole: 'approver',
    note: '我来处理这个重复登记'
  });
  assert('认领成功', claimRes.status === 200 && claimRes.body.ok);
  assert('认领后状态为 processing', claimRes.body.pending.status === 'processing',
    `got=${claimRes.body.pending && claimRes.body.pending.status}`);
  assert('认领后处理人正确', claimRes.body.pending.currentHandler === DEVICE_B_NAME);

  // 修改资料并重新提交
  const newEnd = new Date(new Date(dupVisitor2.validEnd).getTime() + 2 * 3600_000).toISOString();
  let resubmitRes = await req('POST', `/api/pending/${dupId2}/resolve`, {
    action: 'edit_and_resubmit',
    handler: DEVICE_B_NAME,
    handlerRole: 'approver',
    note: '调整结束时间避开重叠，重新提交审批',
    resolutionData: {
      validEnd: newEnd,
      escort: '刘老师（人工复核补录）'
    }
  });
  assert('重新提交成功', resubmitRes.status === 200 && resubmitRes.body.ok);
  assert('重新提交后状态为待审批', resubmitRes.body.record.status === 'pending_approval',
    `got=${resubmitRes.body.record.status}`);
  assert('资料修改已生效', resubmitRes.body.record.validEnd === newEnd);

  // 放行（现在可以审批了）
  let approveAfter = await req('PATCH', '/api/visitors/' + dupId2, {
    status: 'approved',
    approver: DEVICE_B_NAME,
    approverRole: 'approver',
    operator: DEVICE_B_NAME
  });
  assert('人工处理后可正常放行', approveAfter.status === 200 && approveAfter.body.ok,
    `status=${approveAfter.status}`);
  assert('最终状态为已放行', approveAfter.body.record.status === 'approved');

  let pendingFinal = await req('GET', '/api/pending');
  assert('处理完的记录已移出待处理中心',
    !pendingFinal.body.pending.some(p => p.recordId === dupId2));

  // ---------- 审批变更转人工 ----------
  console.log('\n[5] 审批人变更/资料补录转人工处理');
  let changeVisitor = makeVisitorRecord({ name: RUN_TAG + '-变更测试-吴十', idTail: RUN_TAG + '3333' });
  let pushChange = await req('POST', '/api/sync/push', {
    records: [changeVisitor],
    deviceId: DEVICE_A,
    deviceName: DEVICE_A_NAME
  });
  const changeId = pushChange.body.results[0].id;

  // 先审批通过
  await req('PATCH', '/api/visitors/' + changeId, {
    status: 'approved',
    approver: '审批人甲',
    approverRole: 'approver',
    operator: '审批人甲'
  });

  // 另一台设备离线修改后重新同步
  let changedRecord = { ...changeVisitor, id: changeId, approver: '审批人乙', status: 'approved', escort: '陪同人修改', updatedAt: new Date().toISOString() };
  let pushChange2 = await req('POST', '/api/sync/push', {
    records: [changedRecord],
    deviceId: DEVICE_B,
    deviceName: DEVICE_B_NAME
  });
  assert('审批人变更转人工处理', pushChange2.body.results[0].status === 'pending_manual',
    `got=${pushChange2.body.results[0].status}`);

  // ---------- 时段无效转人工 ----------
  console.log('\n[6] 时段无效转入人工处理');
  let invalidVisitor = makeVisitorRecord({
    name: RUN_TAG + '-无效时段-郑十一', idTail: RUN_TAG + '2222',
    validStart: new Date(Date.now() + 7200_000).toISOString(),
    validEnd: new Date(Date.now() + 3600_000).toISOString()
  });
  let pushInvalid = await req('POST', '/api/sync/push', {
    records: [invalidVisitor],
    deviceId: DEVICE_A,
    deviceName: DEVICE_A_NAME
  });
  assert('无效时段返回 invalid_time', pushInvalid.body.results[0].status === 'invalid_time',
    `got=${pushInvalid.body.results[0].status}`);
  const invalidId = pushInvalid.body.results[0].id;
  let pendingInvalid = await req('GET', '/api/pending');
  assert('无效时段进入待处理中心',
    pendingInvalid.body.pending.some(p => p.recordId === invalidId && p.conflictType === 'invalid_time'));

  // 驳回人工处理
  let rejectManual = await req('POST', `/api/pending/${invalidId}/resolve`, {
    action: 'reject_manual',
    handler: DEVICE_B_NAME,
    handlerRole: 'approver',
    note: '时段设置错误，予以驳回'
  });
  assert('人工驳回成功', rejectManual.status === 200 && rejectManual.body.ok);
  assert('驳回后状态为 rejected', rejectManual.body.record.status === 'rejected');

  // ---------- 筛选与导出 ----------
  console.log('\n[7] 审批页筛选（部门/状态）');
  let listAll = await req('GET', '/api/visitors');
  assert('访客列表可获取', listAll.status === 200 && listAll.body.ok);

  let listCS = await req('GET', '/api/visitors?department=计算机学院&status=pending_approval');
  assert('按部门+状态筛选返回结果', listCS.status === 200);
  assert('筛选结果全部匹配部门',
    listCS.body.records.every(r => r.department === '计算机学院'),
    `非预期: ${JSON.stringify(listCS.body.records.map(r => r.department))}`);
  assert('筛选结果全部匹配状态',
    listCS.body.records.every(r => r.status === 'pending_approval'));

  console.log('\n[8] 审计日志与导出（CSV/JSON）');
  // 确保有足够审计记录
  let audit = await req('GET', '/api/audit?role=approver');
  assert('审计日志可获取', audit.status === 200 && audit.body.ok);
  assert('包含审批放行日志', audit.body.records.some(a => a.action === 'approved'));
  assert('包含驳回日志', audit.body.records.some(a => a.action === 'rejected'));
  assert('包含撤销尝试被拒日志', audit.body.records.some(a => a.action === 'permission_denied'));

  let auditCSV = await req('GET', '/api/audit?format=csv&role=approver');
  assert('审计 CSV 可导出（含BOM）',
    auditCSV.status === 200 && (auditCSV.headers['content-type'] || '').includes('text/csv'));

  let auditJSON = await req('GET', '/api/audit?format=json&role=approver');
  assert('审计 JSON 可导出',
    auditJSON.status === 200 && (auditJSON.headers['content-type'] || '').includes('application/json'));
  assert('审计 JSON 包含 count 字段', typeof auditJSON.body.count === 'number');

  let visitorCSV = await req('GET', '/api/export?format=csv');
  assert('访客 CSV 可导出', visitorCSV.status === 200 && (visitorCSV.headers['content-type'] || '').includes('text/csv'));

  let visitorJSON = await req('GET', '/api/export?format=json');
  assert('访客 JSON 可导出', visitorJSON.status === 200 && (visitorJSON.headers['content-type'] || '').includes('application/json'));
  assert('访客 JSON 带 statusLabel 中文字段',
    visitorJSON.body.records.length === 0 || visitorJSON.body.records[0].statusLabel);

  // ---------- 数据持久化（验证已写入文件） ----------
  console.log('\n[9] 数据持久化（文件写入验证）');
  const DATA_FILE = path.join(__dirname, '..', 'data', 'visitors.json');
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    const data = JSON.parse(raw);
    assert('visitors 数组持久化', Array.isArray(data.visitors) && data.visitors.length > 0);
    assert('pendingQueue 数组持久化', Array.isArray(data.pendingQueue));
    assert('auditLog 数组持久化', Array.isArray(data.auditLog) && data.auditLog.length > 0);
    assert('syncLog 数组持久化', Array.isArray(data.syncLog));
    assert('主链路记录写入文件', data.visitors.some(v => v.id === mainId));
    assert('审计日志写入文件', data.auditLog.length >= audit.body.count,
      `file=${data.auditLog.length} api=${audit.body.count}`);
  } catch (e) {
    assert('数据文件可读可解析', false, e.message);
  }

  // ---------- 撤销功能 ----------
  console.log('\n[10] 撤销功能验证');
  let revokeVisitor = makeVisitorRecord({ name: RUN_TAG + '-撤销测试-冯十二', idTail: RUN_TAG + '1111' });
  let pushR = await req('POST', '/api/sync/push', {
    records: [revokeVisitor],
    deviceId: DEVICE_A,
    deviceName: DEVICE_A_NAME
  });
  const revokeId = pushR.body.results[0].id;

  // 审批人先放行
  await req('PATCH', '/api/visitors/' + revokeId, {
    status: 'approved', approver: DEVICE_B_NAME, approverRole: 'approver', operator: DEVICE_B_NAME
  });

  // 审批人撤销
  let revokeByApprover = await req('PATCH', '/api/visitors/' + revokeId, {
    status: 'revoked', approverRole: 'approver', operator: DEVICE_B_NAME
  });
  assert('审批人可以撤销已放行', revokeByApprover.status === 200 && revokeByApprover.body.ok);
  assert('撤销后状态为 revoked', revokeByApprover.body.record.status === 'revoked');

  let auditRevoke = await req('GET', '/api/audit?role=approver');
  assert('撤销操作写入审计', auditRevoke.body.records.some(a => a.action === 'revoked' && a.recordId === revokeId));

  // ---------- [新增] 版本哈希冲突检测接口 ----------
  console.log('\n[11] 版本哈希与冲突检测接口');
  let versions = await req('GET', '/api/visitors/versions');
  assert('版本接口正常返回', versions.status === 200 && versions.body.ok);
  assert('包含 visitors 版本数组', Array.isArray(versions.body.visitors));
  assert('包含 pending 版本数组', Array.isArray(versions.body.pending));
  assert('包含 serverTime 服务端时间戳', !!versions.body.serverTime);
  assert('主链路记录有版本哈希', versions.body.visitors.some(v => v.id === mainId && !!v.hash && v.hash.length === 16));
  assert('版本信息含 updatedAt/syncedAt/status',
    versions.body.visitors.every(v => v.id && v.updatedAt && v.status));

  // ---------- [新增] 权限边界：保安角色接口越权 ----------
  console.log('\n[12] 权限边界：保安接口越权防护');
  let guardAudit = await req('GET', '/api/audit?role=guard');
  assert('保安访问审计接口返回 403', guardAudit.status === 403, `got=${guardAudit.status}`);
  assert('403 返回含错误提示', guardAudit.body && guardAudit.body.error && guardAudit.body.error.includes('审批人'));

  let guardAuditCSV = await req('GET', '/api/audit?format=csv&role=guard');
  assert('保安导出审计 CSV 被拒（403）', guardAuditCSV.status === 403);

  let guardAuditJSON = await req('GET', '/api/audit?format=json&role=guard');
  assert('保安导出审计 JSON 被拒（403）', guardAuditJSON.status === 403);

  let guardPendingExport = await req('GET', '/api/export/pending?format=json&role=guard');
  assert('保安导出待处理队列被拒（403）', guardPendingExport.status === 403, `got=${guardPendingExport.status}`);

  let guardRejectStatus = await req('GET', '/api/export?format=json&role=guard&status=rejected');
  assert('保安导出 rejected 状态被拒（403）', guardRejectStatus.status === 403, `got=${guardRejectStatus.status}`);

  let guardApproved = await req('GET', '/api/export?format=json&role=guard&status=approved');
  assert('保安可以导出 approved 状态（200）', guardApproved.status === 200, `got=${guardApproved.status}`);

  // ---------- [新增] 导出筛选与审批页面对齐 ----------
  console.log('\n[13] 导出筛选与页面对齐：部门/状态');
  let visitorDeptOnly = await req('GET', '/api/export?format=json&department=教务处');
  assert('按部门导出结果匹配',
    visitorDeptOnly.body.records.every(r => r.department === '教务处'));

  let visitorStatusOnly = await req('GET', '/api/export?format=json&status=approved');
  assert('按状态导出结果匹配',
    visitorStatusOnly.body.records.every(r => r.status === 'approved'));

  let visitorBoth = await req('GET', '/api/export?format=json&department=计算机学院&status=pending_approval');
  assert('部门+状态同时筛选均匹配',
    visitorBoth.body.records.every(r => r.department === '计算机学院' && r.status === 'pending_approval'),
    `实际=${JSON.stringify(visitorBoth.body.records.map(r => ({d:r.department,s:r.status})))}`);

  let auditByDept = await req('GET', '/api/audit?format=json&department=教务处&role=approver');
  assert('审计按部门筛选返回 JSON 正常',
    auditByDept.status === 200 && Array.isArray(auditByDept.body.records));

  // CSV 同样带筛选
  let visitorDeptCSV = await req('GET', '/api/export?format=csv&department=教务处');
  assert('访客 CSV 按部门导出成功',
    visitorDeptCSV.status === 200 && (visitorDeptCSV.headers['content-type'] || '').includes('text/csv'));

  // ---------- [新增] 待处理队列导出 ----------
  console.log('\n[14] 待处理中心导出接口（审批人权限）');
  let pendingJSON = await req('GET', '/api/export/pending?format=json&role=approver');
  assert('待处理 JSON 导出成功', pendingJSON.status === 200, `got=${pendingJSON.status}`);
  assert('待处理 JSON 含 count/records/exportedAt',
    typeof pendingJSON.body.count === 'number' && Array.isArray(pendingJSON.body.records));

  if (pendingJSON.body.records.length > 0) {
    const pr = pendingJSON.body.records[0];
    assert('待处理记录含冲突类型标签', !!pr.conflictTypeLabel);
    assert('待处理记录含访客姓名/部门', !!pr.recordName && !!pr.recordDepartment);
    assert('待处理记录含来源设备/处理人', 'sourceDeviceName' in pr && 'currentHandler' in pr);
  }

  let pendingCSV = await req('GET', '/api/export/pending?format=csv&role=approver');
  assert('待处理 CSV 导出成功',
    pendingCSV.status === 200 && (pendingCSV.headers['content-type'] || '').includes('text/csv'));

  let pendingByType = await req('GET', '/api/export/pending?format=json&role=approver&conflictType=overlap_conflict');
  assert('待处理按冲突类型导出筛选生效',
    pendingByType.body.records.every(r => r.conflictType === 'overlap_conflict' || r.conflictType === undefined));

  // ---------- [新增] /api/pending 接口扩展筛选 ----------
  console.log('\n[15] 待处理列表接口扩展筛选');
  let pendingWithDept = await req('GET', '/api/pending?department=学生处');
  assert('待处理支持按部门筛选',
    pendingWithDept.body.pending.every(p => !p.recordDepartment || p.recordDepartment === '学生处'));

  let pendingByConflict = await req('GET', '/api/pending?conflictType=overlap_conflict');
  assert('待处理支持按冲突类型筛选',
    pendingByConflict.body.pending.every(p => p.conflictType === 'overlap_conflict'));

  let pendingGuardView = await req('GET', '/api/pending?role=guard&deviceId=' + DEVICE_A);
  assert('保安视角待处理只返回有权限条目',
    pendingGuardView.body.pending.every(p =>
      p.sourceDevice === DEVICE_A ||
      ['overlap_conflict', 'invalid_time'].includes(p.conflictType)));

  // ---------- [新增] 访客列表按角色隔离 ----------
  console.log('\n[16] 访客列表按角色隔离');
  let guardList = await req('GET', '/api/visitors?role=guard&deviceId=' + DEVICE_A);
  assert('保安访问列表接口过滤有效',
    guardList.body.records.every(r =>
      ['pending_sync', 'pending_approval', 'approved'].includes(r.status) ||
      r.sourceDevice === DEVICE_A));

  // ---------- [新增] 审批交接与恢复中心：会话 API ----------
  console.log('\n[17] 审批交接与恢复中心：会话保存/读取/删除');
  const testSessionState = {
    currentPage: 'approval',
    currentDeptFilter: '计算机学院',
    currentStatusFilter: 'pending_approval',
    lastSync: new Date().toISOString(),
    sourceDevice: DEVICE_B,
    handlerNotes: { 'test_record_001': { note: '这条需要复核', updatedAt: new Date().toISOString() } },
    lastExport: { filters: { kind: 'visitors', format: 'csv', department: '计算机学院' }, exportedAt: new Date().toISOString() }
  };

  let guardSessionSave = await req('POST', '/api/sessions?role=guard', {
    deviceId: DEVICE_A,
    deviceName: DEVICE_A_NAME,
    approver: DEVICE_A_NAME,
    approverRole: 'guard',
    state: testSessionState
  });
  assert('保安无法保存审批会话（403）', guardSessionSave.status === 403, `got=${guardSessionSave.status}`);

  let saveResSess = await req('POST', '/api/sessions?role=approver', {
    deviceId: DEVICE_B,
    deviceName: DEVICE_B_NAME,
    approver: DEVICE_B_NAME,
    approverRole: 'approver',
    state: testSessionState
  });
  assert('审批人保存会话成功', saveResSess.status === 200 && saveResSess.body.ok, `status=${saveResSess.status}`);
  assert('返回会话含 id', !!saveResSess.body.session && !!saveResSess.body.session.id);
  assert('返回会话含 state 对象', !!saveResSess.body.session && !!saveResSess.body.session.state);
  assert('会话 state 保留筛选条件', saveResSess.body.session.state.currentDeptFilter === '计算机学院');
  assert('会话 state 保留备注草稿',
    saveResSess.body.session.state.handlerNotes &&
    saveResSess.body.session.state.handlerNotes['test_record_001']);

  const sessionId = saveResSess.body.session.id;

  let guardListSessions = await req('GET', '/api/sessions?role=guard');
  assert('保安无法列出审批会话（403）', guardListSessions.status === 403);

  let listResSess = await req('GET', '/api/sessions?role=approver&approver=' + encodeURIComponent(DEVICE_B_NAME));
  assert('审批人可列出会话', listResSess.status === 200 && listResSess.body.ok);
  assert('会话列表至少包含刚才保存的一条', listResSess.body.sessions.length >= 1);
  assert('列表中的会话按 updatedAt 倒序',
    listResSess.body.sessions.length < 2 ||
    new Date(listResSess.body.sessions[0].updatedAt) >= new Date(listResSess.body.sessions[1].updatedAt));

  let guardGetSession = await req('GET', '/api/sessions/' + sessionId + '?role=guard');
  assert('保安无法读取单条会话（403）', guardGetSession.status === 403);

  let getResSess = await req('GET', '/api/sessions/' + sessionId + '?role=approver');
  assert('审批人可读取单条会话', getResSess.status === 200 && getResSess.body.ok);
  assert('单条会话 state 完整保留', getResSess.body.session.state.currentStatusFilter === 'pending_approval');
  assert('单条会话最近导出摘要保留',
    getResSess.body.session.state.lastExport && getResSess.body.session.state.lastExport.filters);

  // 覆盖保存（同一审批人 + 同一设备）
  const updatedState = { ...testSessionState, currentStatusFilter: 'pending_manual', currentDeptFilter: '教务处' };
  let saveResSess2 = await req('POST', '/api/sessions?role=approver', {
    deviceId: DEVICE_B,
    deviceName: DEVICE_B_NAME,
    approver: DEVICE_B_NAME,
    approverRole: 'approver',
    state: updatedState
  });
  assert('覆盖同审批人同设备会话成功', saveResSess2.status === 200 && saveResSess2.body.ok);
  let listResSess2 = await req('GET', '/api/sessions?role=approver&approver=' + encodeURIComponent(DEVICE_B_NAME));
  assert('覆盖后设备+审批人维度会话数不重复累加',
    listResSess2.body.sessions.filter(s => s.deviceId === DEVICE_B && s.approver === DEVICE_B_NAME).length === 1);
  assert('覆盖后最新会话状态已更新',
    listResSess2.body.sessions[0].state.currentStatusFilter === 'pending_manual');

  // 删除会话
  let guardDeleteSession = await req('DELETE', '/api/sessions/' + sessionId + '?role=guard');
  assert('保安无法删除审批会话（403）', guardDeleteSession.status === 403);

  let delResSess = await req('DELETE', '/api/sessions/' + sessionId + '?role=approver&approver=' + encodeURIComponent(DEVICE_B_NAME));
  assert('审批人删除会话成功', delResSess.status === 200 && delResSess.body.ok);

  let getAfterDel = await req('GET', '/api/sessions/' + sessionId + '?role=approver');
  assert('删除后会话不再可读取（404）', getAfterDel.status === 404);

  // ---------- [新增] 会话持久化（服务重启后仍在） ----------
  console.log('\n[18] 会话持久化：写入数据文件可恢复');
  const persistentState = {
    currentPage: 'handover',
    currentDeptFilter: '教务处',
    currentStatusFilter: 'pending_manual',
    lastSync: new Date().toISOString(),
    handlerNotes: { 'persist_test_001': { note: '服务重启后也要能恢复这条备注' } },
    openManualRecordId: 'persist_test_001'
  };
  let persistSave = await req('POST', '/api/sessions?role=approver', {
    deviceId: DEVICE_B,
    deviceName: DEVICE_B_NAME,
    approver: DEVICE_B_NAME,
    approverRole: 'approver',
    state: persistentState
  });
  assert('持久化会话保存成功', persistSave.status === 200 && persistSave.body.ok);
  const persistSessionId = persistSave.body.session.id;

  const DATA_FILE_SESS = path.join(__dirname, '..', 'data', 'visitors.json');
  try {
    const rawSess = fs.readFileSync(DATA_FILE_SESS, 'utf-8');
    const dataSess = JSON.parse(rawSess);
    assert('approvalSessions 数组持久化', Array.isArray(dataSess.approvalSessions));
    assert('保存的会话已写入文件', dataSess.approvalSessions.some(s => s.id === persistSessionId));
    const fileSession = dataSess.approvalSessions.find(s => s.id === persistSessionId);
    assert('文件中会话 state 含备注草稿',
      fileSession.state && fileSession.state.handlerNotes &&
      fileSession.state.handlerNotes['persist_test_001']);
    assert('文件中会话 state 含页签和筛选',
      fileSession.state.currentPage === 'handover' &&
      fileSession.state.currentDeptFilter === '教务处');
  } catch (e) {
    assert('会话数据文件可读可解析', false, e.message);
  }

  // ---------- [新增] 审计权限边界：无角色/匿名用户被拒 ----------
  console.log('\n[19] 审计权限边界：无角色/匿名被拒');
  let anonAudit = await req('GET', '/api/audit');
  assert('无 role 参数访问审计被拒（403）', anonAudit.status === 403);
  let anonAuditCSV = await req('GET', '/api/audit?format=csv');
  assert('无角色导出审计 CSV 被拒（403）', anonAuditCSV.status === 403);
  let anonAuditJSON = await req('GET', '/api/audit?format=json');
  assert('无角色导出审计 JSON 被拒（403）', anonAuditJSON.status === 403);

  let anonPendingExport = await req('GET', '/api/export/pending?format=json');
  assert('无角色导出待处理被拒（403）', anonPendingExport.status === 403);

  // ---------- [新增] 跨设备交接回归 ----------
  console.log('\n[20] 跨设备交接回归：列表可见 vs 直接恢复');

  const DEVICE_C = 'dev_test_approver_002';
  const DEVICE_C_NAME = 'Approver-PC-2';

  const crossState = {
    currentPage: 'approval',
    currentDeptFilter: '教务处',
    currentStatusFilter: 'pending_approval',
    lastSync: new Date().toISOString(),
    sourceDevice: DEVICE_B,
    handlerNotes: { 'cross_test_001': { note: '跨设备交接备注', updatedAt: new Date().toISOString() } }
  };

  let crossSave = await req('POST', '/api/sessions?role=approver', {
    deviceId: DEVICE_B,
    deviceName: DEVICE_B_NAME,
    approver: DEVICE_B_NAME,
    approverRole: 'approver',
    state: crossState
  });
  assert('跨设备：设备B保存会话成功', crossSave.status === 200 && crossSave.body.ok);
  const crossSessionId = crossSave.body.session.id;
  assert('跨设备：返回会话ID', !!crossSessionId);

  // 同机刷新：同设备同审批人查询可见
  let sameDeviceList = await req('GET', '/api/sessions?role=approver&approver=' + encodeURIComponent(DEVICE_B_NAME) + '&deviceId=' + DEVICE_B);
  assert('同机刷新：同设备查询列表可见', sameDeviceList.body.sessions.some(s => s.id === crossSessionId));
  assert('同机刷新：同设备查询可恢复（restore API）', (await req('POST', '/api/sessions/' + crossSessionId + '/restore?role=approver', {
    operator: DEVICE_B_NAME,
    operatorRole: 'approver'
  })).status === 200);

  // 换设备不带 handover：列表查不到（这就是原来漏掉的 bug）
  let diffDeviceNoHandover = await req('GET', '/api/sessions?role=approver&approver=' + encodeURIComponent(DEVICE_B_NAME) + '&deviceId=' + DEVICE_C);
  assert('跨设备不带handover：旧会话不在列表', !diffDeviceNoHandover.body.sessions.some(s => s.id === crossSessionId),
    'deviceId=DEVICE_C过滤掉了DEVICE_B的会话，这才是交接页看不到旧快照的根因');

  // 换设备带 handover=true：列表能看到旧会话
  let diffDeviceHandover = await req('GET', '/api/sessions?role=approver&approver=' + encodeURIComponent(DEVICE_B_NAME) + '&deviceId=' + DEVICE_C + '&handover=true');
  assert('跨设备带handover：旧会话出现在列表', diffDeviceHandover.body.sessions.some(s => s.id === crossSessionId),
    'handover=true跳过deviceId过滤，同审批人跨设备可见');
  assert('跨设备带handover：会话状态完整', diffDeviceHandover.body.sessions.find(s => s.id === crossSessionId).state.currentDeptFilter === '教务处');

  // 换设备从列表恢复旧会话
  let crossRestore = await req('POST', '/api/sessions/' + crossSessionId + '/restore?role=approver', {
    operator: DEVICE_C_NAME,
    operatorRole: 'approver'
  });
  assert('跨设备恢复旧会话成功', crossRestore.status === 200 && crossRestore.body.ok);
  assert('跨设备恢复后状态完整', crossRestore.body.session.state.currentDeptFilter === '教务处');
  assert('跨设备恢复后备注完整', crossRestore.body.session.state.handlerNotes && crossRestore.body.session.state.handlerNotes['cross_test_001']);

  // 明确区分"列表可见"和"知道sessionId就能恢复"不是一回事
  // 场景：不带handover的列表查询看不到，但直接用sessionId调restore仍然能恢复
  let listNotVisible = await req('GET', '/api/sessions?role=approver&approver=' + encodeURIComponent(DEVICE_B_NAME) + '&deviceId=' + DEVICE_C);
  assert('区分：列表不可见（不带handover）', !listNotVisible.body.sessions.some(s => s.id === crossSessionId));

  let restoreStillWorks = await req('POST', '/api/sessions/' + crossSessionId + '/restore?role=approver', {
    operator: DEVICE_C_NAME,
    operatorRole: 'approver'
  });
  assert('区分：sessionId直接恢复仍可成功', restoreStillWorks.status === 200 && restoreStillWorks.body.ok);
  assert('区分：列表可见≠可恢复是两回事', !listNotVisible.body.sessions.some(s => s.id === crossSessionId) && restoreStillWorks.body.ok,
    '列表查不到≠不能恢复，但交接页必须先在列表里看到才能点恢复，所以handover参数是刚需');

  // 验证handover不影响同设备查询
  let sameDeviceHandover = await req('GET', '/api/sessions?role=approver&approver=' + encodeURIComponent(DEVICE_B_NAME) + '&deviceId=' + DEVICE_B + '&handover=true');
  assert('handover不影响同设备查询', sameDeviceHandover.body.sessions.some(s => s.id === crossSessionId));

  // 清理跨设备会话
  await req('DELETE', '/api/sessions/' + crossSessionId + '?role=approver&approver=' + encodeURIComponent(DEVICE_B_NAME));

  // ---------- Summary ----------
  console.log('\n==================== 测试结果 ====================');
  console.log(`  通过: ${passed}`);
  console.log(`  失败: ${failed}`);
  if (failures.length > 0) {
    console.log('\n  失败详情:');
    failures.forEach((f, i) => console.log(`    ${i + 1}. ${f.name}${f.detail ? '  → ' + f.detail : ''}`));
  }
  console.log('==================================================\n');
  console.log('[浏览器回归验证步骤提示]');
  console.log('  【审批交接与恢复中心 · 浏览器回归】');
  console.log('  1) 启动服务后访问 http://localhost:3000');
  console.log('  2) 选择审批人角色，进入审批页');
  console.log('  3) 设置部门=计算机学院 + 状态=待审批，在任意待处理记录点击【人工处理】');
  console.log('  4) 在备注框输入一段处理说明，等待出现「已自动保存到本地，刷新后可恢复」提示');
  console.log('  5) 手动执行浏览器刷新（F5 / Ctrl+R）');
  console.log('  6) 验证：页面仍停留在审批人视角、筛选条件保留、弹窗询问是否继续处理、备注内容自动恢复');
  console.log('  7) 进入【交接】页签（审批人专属导航），确认看到当前状态诊断卡（页签/筛选/队列/备注/设备等）');
  console.log('  8) 点击「💾 保存当前会话」，提示保存成功后，会话卡片出现在下方列表');
  console.log('  9) 在导出页随便导出一条访客 CSV，再回到【交接】页，确认「最近导出」信息已更新到诊断卡和会话快照');
  console.log('  10) 在【交接】页切换部门/状态筛选，等待 2 秒后点「🔄 刷新会话列表」，确认会话已自动覆盖保存（最新筛选已更新）');
  console.log('  11) 点会话卡片的「恢复此会话」，确认筛选、备注、导出摘要全部恢复');
  console.log('  12) 【服务重启验证】保持浏览器页面打开，在终端重启 node server.js');
  console.log('  13) 服务起来后，回到浏览器刷新，进入【交接】页，点「🔄 刷新会话列表」，验证：刚才的会话仍存在，可再次恢复');
  console.log('  14) 验证保安角色：切换为保安，底部导航不应出现【交接】页签');
  console.log('  15) 导出权限验证：不登录或切换保安，尝试访问 /api/audit?format=csv 应返回 403');
  console.log('==================================================\n');

  process.exit(failed > 0 ? 1 : 0);
}

runAll().catch(e => {
  console.error('测试执行失败:', e.stack || e.message);
  process.exit(2);
});
