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
  let auditRes = await req('GET', '/api/audit');
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
  let audit = await req('GET', '/api/audit');
  assert('审计日志可获取', audit.status === 200 && audit.body.ok);
  assert('包含审批放行日志', audit.body.records.some(a => a.action === 'approved'));
  assert('包含驳回日志', audit.body.records.some(a => a.action === 'rejected'));
  assert('包含撤销尝试被拒日志', audit.body.records.some(a => a.action === 'permission_denied'));

  let auditCSV = await req('GET', '/api/audit?format=csv');
  assert('审计 CSV 可导出（含BOM）',
    auditCSV.status === 200 && (auditCSV.headers['content-type'] || '').includes('text/csv'));

  let auditJSON = await req('GET', '/api/audit?format=json');
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
    assert('审计日志写入文件', data.auditLog.length === audit.body.count,
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

  let auditRevoke = await req('GET', '/api/audit');
  assert('撤销操作写入审计', auditRevoke.body.records.some(a => a.action === 'revoked' && a.recordId === revokeId));

  // ---------- Summary ----------
  console.log('\n==================== 测试结果 ====================');
  console.log(`  通过: ${passed}`);
  console.log(`  失败: ${failed}`);
  if (failures.length > 0) {
    console.log('\n  失败详情:');
    failures.forEach((f, i) => console.log(`    ${i + 1}. ${f.name}${f.detail ? '  → ' + f.detail : ''}`));
  }
  console.log('==================================================\n');

  process.exit(failed > 0 ? 1 : 0);
}

runAll().catch(e => {
  console.error('测试执行失败:', e.stack || e.message);
  process.exit(2);
});
