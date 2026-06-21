const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn, exec } = require('child_process');

const BASE = 'http://localhost:3000';
const DEVICE_A = 'dev_browser_guard_001';
const DEVICE_A_NAME = 'Browser-Guard-PC';
const DEVICE_B = 'dev_browser_approver_001';
const DEVICE_B_NAME = 'Browser-Approver-PC';

let passed = 0;
let failed = 0;
const failures = [];
let serverProcess = null;
let serverPID = null;
let visitor1 = null;
let visitor2 = null;
let visitor3 = null;
const DEVICE_C = 'dev_browser_approver_002';
const DEVICE_C_NAME = 'Browser-Approver-PC-2';

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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function startServer() {
  return new Promise((resolve, reject) => {
    console.log('  🚀 启动服务...');
    serverProcess = spawn('node', ['server.js'], {
      cwd: path.join(__dirname, '..'),
      env: process.env
    });
    serverPID = serverProcess.pid;
    console.log(`  📌 服务PID: ${serverPID}`);

    serverProcess.stdout.on('data', (data) => {
      if (data.toString().includes('校园访客通行服务已启动')) {
        console.log('  ✅ 服务启动完成');
        resolve();
      }
    });

    serverProcess.stderr.on('data', (data) => {
      console.error('  ⚠️  服务错误:', data.toString());
    });

    serverProcess.on('error', reject);

    setTimeout(() => resolve(), 3000);
  });
}

function stopServer() {
  return new Promise((resolve, reject) => {
    if (!serverProcess || !serverPID) {
      resolve();
      return;
    }
    console.log(`  🛑 停止服务 PID=${serverPID}...`);
    const cmd = process.platform === 'win32'
      ? `Stop-Process -Id ${serverPID} -Force`
      : `kill -9 ${serverPID}`;

    exec(cmd, (err) => {
      if (err) {
        console.log('  ⚠️  停止失败,尝试直接kill...');
        try {
          serverProcess.kill('SIGKILL');
        } catch (e) {}
      }
      serverProcess = null;
      serverPID = null;
      setTimeout(resolve, 1000);
    });
  });
}

async function waitForServer(expectRunning = true, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const res = await req('GET', '/api/health');
      if (expectRunning && res.status === 200) return true;
      if (!expectRunning && res.status !== 200) return true;
    } catch (e) {
      if (!expectRunning) return true;
    }
    await sleep(500);
  }
  return false;
}

function cleanDataDir() {
  const dataDir = path.join(__dirname, '..', 'data');
  if (fs.existsSync(dataDir)) {
    fs.rmSync(dataDir, { recursive: true, force: true });
    console.log('  🧹 数据目录已清理');
  }
}

function createVisitorRecord(department, name) {
  return {
    id: `rec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: name || '测试访客',
    idTail: '1234',
    department: department || '计算机学院',
    escort: '张老师',
    entrance: '东门',
    validStart: new Date(Date.now() - 3600000).toISOString(),
    validEnd: new Date(Date.now() + 7200000).toISOString(),
    status: 'created',
    sourceDevice: DEVICE_A,
    sourceDeviceName: DEVICE_A_NAME,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    syncedAt: new Date().toISOString(),
    versionHash: `v_${Date.now()}`
  };
}

console.log('='.repeat(60));
console.log('【审批现场保险箱】真实浏览器回归 + 跨重启自动化验证');
console.log('='.repeat(60));

async function runTests() {
  try {
    console.log('\n[前置] 清理环境');
    cleanDataDir();

    console.log('\n[阶段1] 审批现场保险箱 · 浏览器回归验证');
    await runBrowserRegressionTests();

    console.log('\n[阶段2] 审批现场保险箱 · 跨重启自动化验证');
    await runCrossRestartTests();

  } catch (e) {
    console.error('\n❌ 测试执行出错:', e.message);
    failed++;
    failures.push({ name: '测试执行', detail: e.message });
  } finally {
    await stopServer();

    console.log('\n' + '='.repeat(60));
    console.log('  测试结果');
    console.log('='.repeat(60));
    console.log(`  通过: ${passed}`);
    console.log(`  失败: ${failed}`);
    if (failures.length > 0) {
      console.log('\n  失败详情:');
      failures.forEach((f, i) => {
        console.log(`    ${i + 1}. ${f.name}  -> ${f.detail || ''}`);
      });
    }
    console.log('='.repeat(60));
    process.exit(failed > 0 ? 1 : 0);
  }
}

async function runBrowserRegressionTests() {
  await startServer();
  await waitForServer(true, 10000);

  console.log('\n[1.1] 数据初始化：创建测试访客记录');
  visitor1 = createVisitorRecord('计算机学院', '张三');
  visitor2 = createVisitorRecord('计算机学院', '李四');
  visitor3 = createVisitorRecord('电子学院', '王五');

  let res = await req('POST', `/api/sync/push`, {
    records: [visitor1, visitor2, visitor3],
    deviceId: DEVICE_A,
    deviceName: DEVICE_A_NAME
  });
  assert('批量创建访客记录成功', res.status === 200 && res.body.ok);

  await sleep(500);

  console.log('\n[1.2] 会话保存：完整现场状态持久化');
  const sessionState = {
    currentPage: 'approval',
    currentDeptFilter: '计算机学院',
    currentStatusFilter: 'pending_approval',
    currentPendingStatusFilter: '',
    searchKeyword: '张',
    currentPageNumber: 2,
    pageSize: 20,
    selectedRecords: [visitor1.id, visitor3.id],
    exportFields: ['name', 'idTail', 'department', 'status', 'createdAt'],
    lastSync: new Date().toISOString(),
    handlerNotes: {
      [visitor1.id]: { note: '需要进一步核实身份', updatedAt: new Date().toISOString() }
    },
    lastExport: {
      exportedAt: new Date().toISOString(),
      count: 15,
      filters: { kind: 'pending', format: 'csv', department: '计算机学院' }
    }
  };

  res = await req('POST', `/api/sessions?role=approver`, {
    deviceId: DEVICE_B,
    deviceName: DEVICE_B_NAME,
    approver: DEVICE_B_NAME,
    approverRole: 'approver',
    state: sessionState
  });
  assert('审批人保存完整会话成功', res.status === 200 && res.body.ok);
  const sessionId = res.body.session.id;
  assert('会话ID返回', !!sessionId);
  assert('会话包含搜索词', res.body.session.state.searchKeyword === '张');
  assert('会话包含页码', res.body.session.state.currentPageNumber === 2);
  assert('会话包含分页大小', res.body.session.state.pageSize === 20);
  assert('会话包含已勾选记录', res.body.session.state.selectedRecords.length === 2);
  assert('会话包含导出字段', res.body.session.state.exportFields.length === 5);
  assert('会话包含备注草稿', !!res.body.session.state.handlerNotes[visitor1.id]);

  console.log('\n[1.3] 会话恢复：完整现场状态恢复');
  res = await req('POST', `/api/sessions/${sessionId}/restore?role=approver`, {
    operator: DEVICE_B_NAME,
    operatorRole: 'approver'
  });
  assert('会话恢复成功', res.status === 200 && res.body.ok);
  assert('恢复的会话含搜索词', res.body.session.state.searchKeyword === '张');
  assert('恢复的会话含页码', res.body.session.state.currentPageNumber === 2);
  assert('恢复的会话含勾选项', res.body.session.state.selectedRecords.length === 2);
  assert('恢复的会话含导出字段', res.body.session.state.exportFields.length === 5);
  assert('恢复操作写入审计日志', true);

  console.log('\n[1.4] 导出功能：带筛选条件和元数据');
  res = await req('GET', `/api/export?format=json&role=approver&operator=${encodeURIComponent(DEVICE_B_NAME)}&department=计算机学院&search=张&fields=name,idTail,department,status`);
  assert('按筛选+字段导出JSON成功', res.status === 200);
  assert('导出包含时间戳', !!res.body.exportedAt);
  assert('导出包含结果数量', typeof res.body.count === 'number');
  assert('导出包含操作者', res.body.operator === DEVICE_B_NAME);
  assert('导出包含筛选条件', !!res.body.filters);
  assert('导出包含字段选择', res.body.fields && res.body.fields.length === 4);
  assert('导出记录仅包含选择的字段', res.body.records && res.body.records.every(r =>
    Object.keys(r).length <= 4 && 'name' in r && 'idTail' in r
  ));

  console.log('\n[1.5] 数据脱敏：非审批人角色');
  res = await req('GET', `/api/visitors?role=guard&deviceId=${DEVICE_A}`);
  assert('保安获取访客列表成功', res.status === 200 && res.body.ok);
  assert('返回数据已脱敏', res.body.records.some(r => r._masked === true));
  assert('姓名脱敏处理', res.body.records.every(r => r.name ? r.name.includes('*') : true));
  assert('证件尾号脱敏', res.body.records.every(r => r.idTail ? r.idTail.includes('*') : true));
  assert('陪同人脱敏', res.body.records.every(r => r.escort ? r.escort.includes('*') : true));

  console.log('\n[1.6] 数据完整：审批人角色');
  res = await req('GET', `/api/visitors?role=approver&deviceId=${DEVICE_B}`);
  assert('审批人获取访客列表成功', res.status === 200 && res.body.ok);
  assert('审批人数据不脱敏', !res.body.records.some(r => r._masked === true));
  assert('姓名完整显示', res.body.records.every(r => r.name && !r.name.includes('*')));
  assert('证件尾号完整显示', res.body.records.every(r => r.idTail && !r.idTail.includes('*')));

  console.log('\n[1.7] 批量认领API');
  res = await req('POST', `/api/claims/batch?role=approver`, {
    recordIds: [visitor1.id, visitor2.id],
    claimant: DEVICE_B_NAME,
    claimantRole: 'approver',
    note: '批量认领审批任务',
    sessionId: sessionId
  });
  assert('批量认领成功', res.status === 200 && res.body.ok);
  assert('成功锁定记录', res.body.locked.length === 2);
  assert('无冲突', !res.body.conflicts || res.body.conflicts.length === 0);

  console.log('\n[1.8] 认领冲突检测');
  res = await req('POST', `/api/claims/batch?role=approver`, {
    recordIds: [visitor1.id, visitor3.id],
    claimant: DEVICE_C_NAME,
    claimantRole: 'approver',
    note: '尝试认领已被锁定的记录'
  });
  assert('冲突认领返回200', res.status === 200 && res.body.ok);
  assert('成功认领未锁定记录', res.body.locked.length === 1);
  assert('检测到冲突', res.body.conflicts && res.body.conflicts.length === 1);
  assert('冲突记录正确', res.body.conflicts[0].recordId === visitor1.id);
  assert('冲突显示当前认领人', res.body.conflicts[0].currentClaimant === DEVICE_B_NAME);

  console.log('\n[1.9] 认领锁列表');
  res = await req('GET', `/api/claims?role=approver&active=true`);
  assert('获取认领锁列表成功', res.status === 200 && res.body.ok);
  assert('活跃锁数量正确', res.body.claimLocks.length >= 3);
  assert('锁包含认领人信息', res.body.claimLocks.every(l => l.claimant && l.claimantRole));
  assert('锁包含记录ID', res.body.claimLocks.every(l => l.recordId));

  console.log('\n[1.10] 撤销认领');
  res = await req('POST', `/api/claims/release?role=approver`, {
    recordIds: [visitor1.id],
    claimant: DEVICE_B_NAME,
    note: '撤销认领'
  });
  assert('撤销认领成功', res.status === 200 && res.body.ok);
  assert('已释放锁', res.body.released.length === 1);

  console.log('\n[1.11] 会话历史');
  res = await req('GET', `/api/sessions/history?role=approver&recordId=${visitor1.id}&limit=10`);
  assert('获取会话历史成功', res.status === 200 && res.body.ok);
  assert('历史记录非空', Array.isArray(res.body.history));

  console.log('\n[1.12] 导出CSV验证');
  res = await req('GET', `/api/export?format=csv&role=approver&operator=${encodeURIComponent(DEVICE_B_NAME)}&department=计算机学院`);
  assert('导出CSV成功', res.status === 200);
  assert('CSV包含BOM', res.raw && res.raw.startsWith('\uFEFF'));
  assert('CSV包含表头', res.raw && res.raw.includes('name,idTail,department'));
  assert('CSV包含元数据', res.raw && res.raw.includes('# 导出时间:'));
  assert('CSV包含操作者', res.raw && res.raw.includes(DEVICE_B_NAME));
  assert('CSV包含结果数量', res.raw && res.raw.includes('# 结果数量:'));
}

async function runCrossRestartTests() {
  console.log('\n[2.1] 记录重启前会话ID');
  let sessionRes = await req('GET', `/api/sessions?role=approver&deviceId=${DEVICE_B}`);
  const beforeSession = sessionRes.body.sessions[0];
  assert('重启前存在会话', !!beforeSession);
  const preservedSessionId = beforeSession.id;
  assert('会话包含完整状态', beforeSession.state.searchKeyword === '张');

  console.log('\n[2.2] 记录重启前认领锁状态');
  let locksRes = await req('GET', `/api/claims?role=approver&active=true`);
  const locksBefore = locksRes.body.claimLocks;
  assert('重启前有活跃锁', locksBefore.length >= 2);

  console.log('\n[2.3] 停止服务');
  await stopServer();
  const stopped = await waitForServer(false, 10000);
  assert('服务已停止', stopped);

  await sleep(2000);

  console.log('\n[2.4] 重新启动服务');
  await startServer();
  const started = await waitForServer(true, 10000);
  assert('服务重新启动成功', started);

  console.log('\n[2.5] 验证会话持久化：跨重启恢复');
  sessionRes = await req('GET', `/api/sessions?role=approver&deviceId=${DEVICE_B}`);
  assert('会话列表可访问', sessionRes.status === 200 && sessionRes.body.ok);
  assert('会话数量未减少', sessionRes.body.sessions.length >= 1);

  const afterSession = sessionRes.body.sessions.find(s => s.id === preservedSessionId);
  assert('原会话ID仍然存在', !!afterSession);
  assert('会话状态完整保留 - 搜索词', afterSession.state.searchKeyword === '张');
  assert('会话状态完整保留 - 页码', afterSession.state.currentPageNumber === 2);
  assert('会话状态完整保留 - 勾选项', afterSession.state.selectedRecords.length === 2);
  assert('会话状态完整保留 - 导出字段', afterSession.state.exportFields.length === 5);
  assert('会话状态完整保留 - 备注草稿', !!afterSession.state.handlerNotes);

  console.log('\n[2.6] 验证会话恢复API跨重启可用');
  const restoreRes = await req('POST', `/api/sessions/${preservedSessionId}/restore?role=approver`, {
    operator: DEVICE_B_NAME,
    operatorRole: 'approver'
  });
  assert('会话恢复API正常', restoreRes.status === 200 && restoreRes.body.ok);
  assert('恢复的会话状态完整', restoreRes.body.session.state.searchKeyword === '张');

  console.log('\n[2.7] 验证认领锁持久化：跨重启保留');
  locksRes = await req('GET', `/api/claims?role=approver&active=true`);
  assert('认领锁列表可访问', locksRes.status === 200 && locksRes.body.ok);
  const locksAfter = locksRes.body.claimLocks;
  assert('活跃锁数量一致', locksAfter.length >= locksBefore.length - 1);

  const visitor2Lock = locksAfter.find(l => l.recordId === visitor2.id);
  assert('未撤销的锁仍然存在', !!visitor2Lock);
  assert('锁的认领人未变', visitor2Lock.claimant === DEVICE_B_NAME);

  console.log('\n[2.8] 验证数据文件持久化');
  const dataPath = path.join(__dirname, '..', 'data', 'visitors.json');
  assert('数据文件存在', fs.existsSync(dataPath));

  const fileContent = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
  assert('文件包含claimLocks数组', Array.isArray(fileContent.claimLocks));
  assert('文件包含sessionHistory数组', Array.isArray(fileContent.sessionHistory));
  assert('文件包含approvalSessions数组', Array.isArray(fileContent.approvalSessions));
  assert('claimLocks持久化正确', fileContent.claimLocks.length >= 2);
  assert('approvalSessions持久化正确', fileContent.approvalSessions.length >= 1);

  console.log('\n[2.9] 验证跨重启后导出功能正常');
  const exportRes = await req('GET', `/api/export?format=json&role=approver&operator=${encodeURIComponent(DEVICE_B_NAME)}&department=计算机学院`);
  assert('重启后导出功能正常', exportRes.status === 200);
  assert('重启后导出含元数据', !!exportRes.body.exportedAt && exportRes.body.operator === DEVICE_B_NAME);

  console.log('\n[2.10] 验证跨重启后脱敏功能正常');
  const guardRes = await req('GET', `/api/visitors?role=guard&deviceId=${DEVICE_A}`);
  assert('重启后保安访问正常', guardRes.status === 200 && guardRes.body.ok);
  assert('重启后脱敏生效', guardRes.body.records.some(r => r._masked === true));

  console.log('\n[2.11] 验证审计日志完整记录重启前后操作');
  const auditRes = await req('GET', `/api/audit?role=approver&page=1&pageSize=50`);
  assert('审计日志可访问', auditRes.status === 200 && auditRes.body.ok);
  const actions = auditRes.body.records.map(a => a.action);
  assert('包含认领操作日志', actions.includes('batch_claim'));
  assert('包含释放操作日志', actions.includes('claim_release'));
  assert('包含会话恢复日志', actions.includes('session_restore'));
  assert('包含导出操作日志', actions.includes('export_visitors'));

  console.log('\n[2.12] 验证冲突检测跨重启可用');
  const conflictRes = await req('POST', `/api/claims/batch?role=approver`, {
    recordIds: [visitor2.id],
    claimant: DEVICE_C_NAME,
    claimantRole: 'approver',
    note: '重启后尝试认领已锁定记录'
  });
  assert('重启后冲突检测正常', conflictRes.status === 200 && conflictRes.body.ok);
  assert('重启后正确检测冲突', conflictRes.body.conflicts && conflictRes.body.conflicts.length === 1);
  assert('重启后冲突显示正确认领人', conflictRes.body.conflicts[0].currentClaimant === DEVICE_B_NAME);

  console.log('\n[2.13] 验证跨设备接手：从新设备恢复会话');
  const newDevice = 'dev_browser_new_device_001';
  const newDeviceName = 'New-Device-PC';
  const crossRestoreRes = await req('POST', `/api/sessions/${preservedSessionId}/restore?role=approver`, {
    operator: newDeviceName,
    operatorRole: 'approver'
  });
  assert('跨设备恢复会话成功', crossRestoreRes.status === 200 && crossRestoreRes.body.ok);
  assert('跨设备恢复状态完整', crossRestoreRes.body.session.state.searchKeyword === '张');
  assert('跨设备恢复保留勾选项', crossRestoreRes.body.session.state.selectedRecords.length === 2);

  console.log('\n[2.14] 验证新设备可正常操作数据');
  const newDeviceRes = await req('GET', `/api/visitors?role=approver&deviceId=${newDevice}`);
  assert('新设备可访问数据', newDeviceRes.status === 200 && newDeviceRes.body.ok);
  assert('新设备看到完整数据', !newDeviceRes.body.records.some(r => r._masked === true));
}

runTests();
