(function () {
  'use strict';

  var DEVICE_KEY = 'cvp_device';
  var QUEUE_KEY = 'cvp_queue';
  var RECORDS_KEY = 'cvp_records';
  var CONFLICTS_KEY = 'cvp_conflicts';
  var PENDING_KEY = 'cvp_pending';
  var AUDIT_KEY = 'cvp_audit';
  var LAST_SYNC_KEY = 'cvp_lastSync';
  var ROLE_KEY = 'cvp_role';
  var DEPARTMENTS = [
    '校长办公室', '教务处', '学生处', '后勤处', '保卫处',
    '计算机学院', '文学院', '理学院', '工学院'
  ];
  var ENTRANCES = ['东门', '西门', '南门', '北门', '行政楼入口'];
  var STATUS_MAP = {
    pending_sync: '待同步',
    pending_approval: '待审批',
    pending_manual: '待人工处理',
    approved: '已放行',
    rejected: '已拒绝',
    revoked: '已撤销',
    expired: '已过期'
  };
  var CONFLICT_TYPE_LABEL = {
    overlap_conflict: '时段重叠',
    invalid_time: '时段无效',
    status_change: '状态变更冲突',
    approver_change: '审批人变更',
    data_update: '资料修改需复核',
    unknown: '未知冲突',
    resubmitted: '重新提交待审批'
  };

  function getDeviceId() {
    var stored = localStorage.getItem(DEVICE_KEY);
    if (stored) return stored;
    var id = 'dev_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    localStorage.setItem(DEVICE_KEY, id);
    return id;
  }

  function getDeviceName() {
    var ua = navigator.userAgent;
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/iPad/.test(ua)) return 'iPad';
    if (/Android/.test(ua)) return 'Android';
    return 'PC';
  }

  var deviceId = getDeviceId();
  var deviceName = getDeviceName();

  function loadJSON(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function saveJSON(key, data) {
    localStorage.setItem(key, JSON.stringify(data));
  }

  function getQueue() { return loadJSON(QUEUE_KEY, []); }
  function saveQueue(q) { saveJSON(QUEUE_KEY, q); }
  function getRecords() { return loadJSON(RECORDS_KEY, []); }
  function saveRecords(r) { saveJSON(RECORDS_KEY, r); }
  function getConflicts() { return loadJSON(CONFLICTS_KEY, []); }
  function saveConflicts(c) { saveJSON(CONFLICTS_KEY, c); }
  function getPending() { return loadJSON(PENDING_KEY, []); }
  function savePending(p) { saveJSON(PENDING_KEY, p); }
  function getAudit() { return loadJSON(AUDIT_KEY, []); }
  function saveAudit(a) { saveJSON(AUDIT_KEY, a); }
  function getLastSync() { return localStorage.getItem(LAST_SYNC_KEY) || null; }
  function setLastSync(t) { localStorage.setItem(LAST_SYNC_KEY, t); }
  function getRole() { return localStorage.getItem(ROLE_KEY) || ''; }
  function setRole(r) { localStorage.setItem(ROLE_KEY, r); }

  function generateId() {
    return 'v_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  function isOnline() {
    return navigator.onLine;
  }

  function formatDT(iso) {
    if (!iso) return '-';
    var d = new Date(iso);
    var pad = function (n) { return n < 10 ? '0' + n : n; };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function nowISO() {
    return new Date().toISOString();
  }

  function hasOverlap(aStart, aEnd, bStart, bEnd) {
    return new Date(aStart).getTime() < new Date(bEnd).getTime() &&
      new Date(bStart).getTime() < new Date(aEnd).getTime();
  }

  function isExpired(rec) {
    if (!rec.validEnd) return false;
    if (['rejected', 'revoked', 'expired', 'pending_manual'].includes(rec.status)) return false;
    return new Date(rec.validEnd).getTime() < Date.now();
  }

  function toast(msg, type) {
    var existing = document.querySelector('.toast');
    if (existing) existing.remove();
    var el = document.createElement('div');
    el.className = 'toast' + (type ? ' ' + type : '');
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function () { if (el.parentNode) el.remove(); }, 2800);
  }

  function escapeHtml(s) {
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function checkExpiredRecords() {
    var records = getRecords();
    var changed = false;
    records.forEach(function (r) {
      if (isExpired(r) && r.status !== 'expired') {
        r.status = 'expired';
        r.updatedAt = nowISO();
        changed = true;
      }
    });
    if (changed) saveRecords(records);
  }

  function fetchJSON(url, opts) {
    return fetch(url, opts).then(function (r) {
      if (!r.ok) return r.json().then(function (e) { throw new Error(e.error || '请求失败'); });
      return r.json();
    });
  }

  function pushSync() {
    var queue = getQueue();
    if (queue.length === 0) return Promise.resolve({ ok: true, results: [] });
    var records = getRecords();
    var toPush = queue.map(function (id) {
      return records.find(function (r) { return r.id === id; });
    }).filter(Boolean);

    if (toPush.length === 0) {
      saveQueue([]);
      return Promise.resolve({ ok: true, results: [] });
    }

    return fetchJSON('/api/sync/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        records: toPush,
        deviceId: deviceId,
        deviceName: deviceName,
        operator: deviceName,
        operatorRole: getRole() || 'guard'
      })
    }).then(function (res) {
      var results = res.results || [];
      var newConflicts = getConflicts();
      var newQueue = [];
      var recordsNow = getRecords();

      results.forEach(function (r) {
        if (r.status === 'conflict' || r.status === 'overlap_conflict' || r.status === 'invalid_time' || r.status === 'pending_manual') {
          newConflicts.push({
            id: r.id,
            type: r.status,
            local: toPush.find(function (t) { return t.id === r.id; }),
            server: r.conflict ? r.conflict.server : null,
            reason: r.conflict ? r.conflict.reason : null,
            conflictType: r.conflict ? r.conflict.type : r.status,
            resolved: false,
            createdAt: nowISO()
          });
        } else if (r.status === 'server_wins') {
          var idx = recordsNow.findIndex(function (v) { return v.id === r.id; });
          if (idx >= 0) recordsNow[idx].status = 'pending_approval';
        } else {
          var idx2 = recordsNow.findIndex(function (v) { return v.id === r.id; });
          if (idx2 >= 0) {
            recordsNow[idx2].syncedAt = nowISO();
            if (recordsNow[idx2].status === 'pending_sync') {
              recordsNow[idx2].status = 'pending_approval';
            }
            if (r.status === 'pending_manual') {
              recordsNow[idx2].status = 'pending_manual';
            }
          }
        }
      });

      var conflictIds = newConflicts.map(function (c) { return c.id; });
      queue.forEach(function (id) {
        if (!conflictIds.includes(id)) {
          var rec = recordsNow.find(function (v) { return v.id === id; });
          if (rec && rec.status === 'pending_sync') {
            newQueue.push(id);
          }
        }
      });

      saveQueue(newQueue);
      saveRecords(recordsNow);
      saveConflicts(newConflicts);
      setLastSync(nowISO());
      return res;
    });
  }

  function pullSync() {
    var since = getLastSync();
    return fetchJSON('/api/sync/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ since: since })
    }).then(function (res) {
      var records = getRecords();
      var serverRecords = res.records || [];

      serverRecords.forEach(function (sr) {
        var localIdx = records.findIndex(function (r) { return r.id === sr.id; });
        if (localIdx < 0) {
          records.push(sr);
        } else {
          var local = records[localIdx];
          var localUpdated = new Date(local.updatedAt || local.createdAt).getTime();
          var serverUpdated = new Date(sr.updatedAt || sr.createdAt).getTime();

          if (local.status === 'pending_sync') {
            if (sr.status !== 'pending_sync') {
              records[localIdx] = sr;
            }
          } else if (serverUpdated > localUpdated) {
            records[localIdx] = sr;
          }
        }
      });

      saveRecords(records);
      setLastSync(res.serverTime);
      return Promise.all([fetchPendingFromServer(), fetchAuditFromServer()]).then(function () {
        return res;
      });
    });
  }

  function fetchPendingFromServer() {
    return fetchJSON('/api/pending', { method: 'GET' }).then(function (res) {
      if (res && res.ok) savePending(res.pending || []);
    }).catch(function () {});
  }

  function fetchAuditFromServer() {
    return fetchJSON('/api/audit', { method: 'GET' }).then(function (res) {
      if (res && res.ok) saveAudit(res.records || []);
    }).catch(function () {});
  }

  function fullSync() {
    if (!isOnline()) {
      toast('当前离线，无法同步', 'error');
      return Promise.resolve();
    }
    return pushSync().then(function () {
      return pullSync();
    }).then(function () {
      toast('同步完成', 'success');
      render();
    }).catch(function (e) {
      toast('同步失败: ' + e.message, 'error');
    });
  }

  function renderHeader(role) {
    var online = isOnline();
    var roleName = role === 'guard' ? '保安' : role === 'approver' ? '审批人' : '未选择';
    var nextRole = role === 'guard' ? 'approver' : 'guard';
    var nextName = role === 'guard' ? '审批人' : '保安';
    var pending = getPending().filter(function (p) { return p.status !== 'done'; }).length;
    var pendingBadge = pending > 0 ? ' <span class="pending-badge">' + pending + '</span>' : '';

    return '<div class="header">' +
      '<h1>校园临时访客通行' + pendingBadge + '</h1>' +
      '<div class="header-sub">' +
      '<span class="net-status"><span class="net-dot' + (online ? '' : ' offline') + '"></span> ' + (online ? '在线' : '离线') + '</span>' +
      '<span>' + roleName + ' | ' + deviceName + '</span>' +
      (role ? '<button class="role-switch" data-action="switch-role">切换为' + nextName + '</button>' : '') +
      '</div></div>';
  }

  function renderSyncBar() {
    var queue = getQueue();
    var conflicts = getConflicts().filter(function (c) { return !c.resolved; });
    var pending = getPending().filter(function (p) { return p.status === 'pending' || p.status === 'processing'; });
    var html = '';

    if (queue.length > 0) {
      html += '<div class="sync-bar"><span>待同步记录</span><span><span class="pending-count">' + queue.length + '</span> 条</span></div>';
    }
    if (conflicts.length > 0) {
      html += '<div class="conflict-bar"><span>本机待处理冲突</span><span><span class="count">' + conflicts.length + '</span> 条</span></div>';
    }
    if (pending.length > 0) {
      html += '<div class="manual-bar"><span>待人工处理中心</span><span><span class="count">' + pending.length + '</span> 条</span></div>';
    }
    return html;
  }

  function renderStatGrid(records) {
    var counts = {};
    Object.keys(STATUS_MAP).forEach(function (k) { counts[k] = 0; });
    records.forEach(function (r) { counts[r.status] = (counts[r.status] || 0) + 1; });
    var pending = getPending().filter(function (p) { return p.status === 'pending' || p.status === 'processing'; }).length;

    return '<div class="stat-grid">' +
      '<div class="stat-card"><div class="stat-num">' + (counts.pending_sync || 0) + '</div><div class="stat-label">待同步</div></div>' +
      '<div class="stat-card"><div class="stat-num">' + (counts.pending_approval || 0) + '</div><div class="stat-label">待审批</div></div>' +
      '<div class="stat-card warning"><div class="stat-num">' + (pending || counts.pending_manual || 0) + '</div><div class="stat-label">待人工</div></div>' +
      '<div class="stat-card"><div class="stat-num">' + (counts.approved || 0) + '</div><div class="stat-label">已放行</div></div>';
  }

  function renderCard(rec, showActions) {
    var statusClass = 'status-' + rec.status;
    var statusText = STATUS_MAP[rec.status] || rec.status;
    var devName = rec.sourceDeviceName || rec.deviceName;
    var devId = rec.sourceDevice || rec.deviceId;
    var deviceTag = devName ? ' <span class="device-tag">来源 ' + escapeHtml(devName) + '</span>' : '';
    var localDevice = devId === deviceId ? ' <span class="device-tag local">本机</span>' : '';
    var syncTime = rec.syncedAt ? ' <span class="meta-tag">同步:' + formatDT(rec.syncedAt) + '</span>' : '';
    var pending = getPending().find(function (p) { return p.recordId === rec.id; });
    var handlerTag = pending && pending.currentHandler ? ' <span class="handler-tag">处理人:' + escapeHtml(pending.currentHandler) + '</span>' : '';

    var html = '<div class="card">' +
      '<div class="card-header">' +
      '<span class="card-title">' + escapeHtml(rec.name) + '</span>' +
      '<span class="status-badge ' + statusClass + '">' + statusText + '</span>' +
      '</div>' +
      '<div class="card-body">' +
      '<p><strong>证件尾号：</strong>' + escapeHtml(rec.idTail) + '</p>' +
      '<p><strong>来访部门：</strong>' + escapeHtml(rec.department) + '</p>' +
      '<p><strong>有效时段：</strong>' + formatDT(rec.validStart) + ' ~ ' + formatDT(rec.validEnd) + '</p>' +
      (rec.escort ? '<p><strong>陪同人：</strong>' + escapeHtml(rec.escort) + '</p>' : '') +
      '<p><strong>入口：</strong>' + escapeHtml(rec.entrance) + '</p>' +
      deviceTag + localDevice + handlerTag + syncTime +
      (pending && pending.conflictReason ? '<p class="reason-text"><strong>冲突原因：</strong>' + escapeHtml(pending.conflictReason) + '</p>' : '') +
      (rec.rejectNote ? '<p><strong>拒绝原因：</strong>' + escapeHtml(rec.rejectNote) + '</p>' : '') +
      (rec.approver ? '<p><strong>审批人：</strong>' + escapeHtml(rec.approver) + '</p>' : '') +
      '</div>';

    if (showActions) {
      html += '<div class="card-footer">';
      if (rec.status === 'pending_approval' && getRole() === 'approver') {
        html += '<button class="small-btn success" data-action="approve" data-id="' + rec.id + '">放行</button>';
        html += '<button class="small-btn danger" data-action="reject" data-id="' + rec.id + '">拒绝</button>';
      }
      if (rec.status === 'pending_manual' && getRole()) {
        html += '<button class="small-btn primary" data-action="open-manual" data-id="' + rec.id + '">人工处理</button>';
      }
      if (['pending_sync', 'pending_approval', 'approved'].includes(rec.status)) {
        var canRevoke = getRole() === 'approver' || (getRole() === 'guard' && rec.status === 'pending_sync');
        if (canRevoke) {
          html += '<button class="small-btn" data-action="revoke" data-id="' + rec.id + '">撤销</button>';
        }
      }
      if (pending) {
        html += '<button class="small-btn" data-action="view-history" data-id="' + rec.id + '">处理历史</button>';
      }
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  function renderRoleSelect() {
    var html = '<div class="content">' +
      '<div class="section-title">请选择角色</div>' +
      '<div class="role-select">' +
      '<div class="role-option" data-action="select-guard">' +
      '<span class="role-emoji">🛡️</span>' +
      '<span class="role-name">保安</span>' +
      '<span class="role-desc">登记访客信息 · 处理待人工</span>' +
      '</div>' +
      '<div class="role-option" data-action="select-approver">' +
      '<span class="role-emoji">📋</span>' +
      '<span class="role-name">审批人</span>' +
      '<span class="role-desc">审批通行 · 审计日志</span>' +
      '</div></div></div>';
    return html;
  }

  function renderGuardForm() {
    var now = new Date();
    var pad = function (n) { return n < 10 ? '0' + n : n; };
    var defaultStart = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) + 'T' + pad(now.getHours()) + ':' + pad(now.getMinutes());
    var endDt = new Date(now.getTime() + 4 * 3600000);
    var defaultEnd = endDt.getFullYear() + '-' + pad(endDt.getMonth() + 1) + '-' + pad(endDt.getDate()) + 'T' + pad(endDt.getHours()) + ':' + pad(endDt.getMinutes());

    var deptOptions = DEPARTMENTS.map(function (d) {
      return '<option value="' + d + '">' + d + '</option>';
    }).join('');

    var entranceTags = ENTRANCES.map(function (e) {
      return '<span class="entrance-tag" data-action="select-entrance" data-value="' + e + '">' + e + '</span>';
    }).join('');

    return '<div class="content">' +
      renderSyncBar() +
      '<div class="section-title">访客登记</div>' +
      '<form id="register-form">' +
      '<div class="form-group">' +
      '<label class="form-label">访客姓名<span class="req">*</span></label>' +
      '<input class="form-input" name="name" required placeholder="请输入访客姓名" autocomplete="off" />' +
      '<div class="field-error" id="err-name"></div>' +
      '</div>' +
      '<div class="form-group">' +
      '<label class="form-label">证件尾号<span class="req">*</span></label>' +
      '<input class="form-input" name="idTail" required placeholder="如：4位尾号" maxlength="6" autocomplete="off" />' +
      '<div class="field-hint">输入证件最后几位数字</div>' +
      '<div class="field-error" id="err-idTail"></div>' +
      '</div>' +
      '<div class="form-group">' +
      '<label class="form-label">来访部门<span class="req">*</span></label>' +
      '<select class="form-select" name="department" required>' +
      '<option value="">请选择部门</option>' + deptOptions +
      '</select>' +
      '<div class="field-error" id="err-department"></div>' +
      '</div>' +
      '<div class="form-group">' +
      '<label class="form-label">有效时段<span class="req">*</span></label>' +
      '<div class="form-row">' +
      '<input class="form-input" type="datetime-local" name="validStart" required value="' + defaultStart + '" />' +
      '<input class="form-input" type="datetime-local" name="validEnd" required value="' + defaultEnd + '" />' +
      '</div>' +
      '<div class="field-hint">开始时间 ~ 结束时间</div>' +
      '<div class="field-error" id="err-validTime"></div>' +
      '</div>' +
      '<div class="form-group">' +
      '<label class="form-label">陪同人</label>' +
      '<input class="form-input" name="escort" placeholder="选填" autocomplete="off" />' +
      '</div>' +
      '<div class="form-group">' +
      '<label class="form-label">入口<span class="req">*</span></label>' +
      '<div class="entrance-tags" id="entrance-tags">' + entranceTags + '</div>' +
      '<input type="hidden" name="entrance" id="entrance-input" />' +
      '<div class="field-error" id="err-entrance"></div>' +
      '</div>' +
      '<div style="margin-top:18px">' +
      '<button type="submit" class="btn btn-primary">提交登记</button>' +
      '</div>' +
      '</form></div>';
  }

  function renderRecordList(filter) {
    var records = getRecords();
    checkExpiredRecords();
    records = getRecords();

    var tabs = Object.keys(STATUS_MAP).map(function (k) {
      var count = records.filter(function (r) { return r.status === k; }).length;
      return '<button class="tab' + (filter === k ? ' active' : '') + '" data-action="filter" data-status="' + k + '">' +
        STATUS_MAP[k] + (count > 0 ? '(' + count + ')' : '') + '</button>';
    }).join('');

    var filtered = filter ? records.filter(function (r) { return r.status === filter; }) : records;
    filtered.sort(function (a, b) {
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    var cards = '';
    if (filtered.length === 0) {
      cards = '<div class="empty-state"><div class="emoji">📭</div><p>暂无记录</p></div>';
    } else {
      filtered.forEach(function (r) {
        cards += renderCard(r, true);
      });
    }

    return '<div class="content">' +
      renderSyncBar() +
      '<div class="tabs">' + tabs + '</div>' +
      cards +
      '</div>';
  }

  function renderApprovalPage(deptFilter, statusFilter) {
    var records = getRecords();
    checkExpiredRecords();
    records = getRecords();

    var pending = records.filter(function (r) { return r.status === 'pending_approval'; });
    var manual = records.filter(function (r) { return r.status === 'pending_manual'; });

    var allDepts = DEPARTMENTS.slice();
    records.forEach(function (r) {
      if (r.department && !allDepts.includes(r.department)) allDepts.push(r.department);
    });

    var deptOptions = '<option value="">全部部门</option>' + allDepts.map(function (d) {
      return '<option value="' + d + '"' + (deptFilter === d ? ' selected' : '') + '>' + d + '</option>';
    }).join('');

    var statuses = ['', 'pending_approval', 'pending_manual', 'approved', 'rejected', 'revoked'];
    var statusLabels = { '': '全部状态', pending_approval: '待审批', pending_manual: '待人工', approved: '已放行', rejected: '已拒绝', revoked: '已撤销' };
    var statusOptions = statuses.map(function (s) {
      return '<option value="' + s + '"' + (statusFilter === s ? ' selected' : '') + '>' + statusLabels[s] + '</option>';
    }).join('');

    var displayRecords = records.filter(function (r) {
      if (statusFilter) return r.status === statusFilter;
      return r.status === 'pending_approval' || r.status === 'pending_manual';
    });
    if (deptFilter) displayRecords = displayRecords.filter(function (r) { return r.department === deptFilter; });
    displayRecords.sort(function (a, b) {
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    var cards = '';
    if (displayRecords.length === 0) {
      cards = '<div class="empty-state"><div class="emoji">✅</div><p>暂无匹配记录</p></div>';
    } else {
      displayRecords.forEach(function (r) {
        cards += renderCard(r, true);
      });
    }

    return '<div class="content">' +
      renderSyncBar() +
      '<div class="section-title">审批管理</div>' +
      '<div class="filter-bar">' +
      '<select class="form-select" id="dept-filter" data-action="dept-filter">' + deptOptions + '</select>' +
      '<select class="form-select" id="status-filter" data-action="status-filter">' + statusOptions + '</select>' +
      '</div>' +
      '<div class="stat-grid">' +
      '<div class="stat-card"><div class="stat-num">' + pending.length + '</div><div class="stat-label">待审批</div></div>' +
      '<div class="stat-card warning"><div class="stat-num">' + manual.length + '</div><div class="stat-label">待人工</div></div>' +
      '<div class="stat-card"><div class="stat-num">' + records.filter(function (r) { return r.status === 'approved'; }).length + '</div><div class="stat-label">已放行</div></div>' +
      '<div class="stat-card"><div class="stat-num">' + records.filter(function (r) { return r.status === 'rejected'; }).length + '</div><div class="stat-label">已拒绝</div></div>' +
      '</div>' +
      cards +
      '</div>';
  }

  function renderPendingCenter(statusFilter) {
    var pending = getPending();
    var records = getRecords();

    var statuses = ['', 'pending', 'processing', 'done'];
    var statusLabels = { '': '全部', pending: '待认领', processing: '处理中', done: '已完成' };
    var statusOptions = statuses.map(function (s) {
      return '<option value="' + s + '"' + (statusFilter === s ? ' selected' : '') + '>' + statusLabels[s] + '</option>';
    }).join('');

    var displayList = statusFilter ? pending.filter(function (p) { return p.status === statusFilter; }) : pending;
    displayList = displayList.filter(function (p) { return p.status !== 'done'; });
    displayList.sort(function (a, b) {
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    var counts = { total: pending.filter(function (p) { return p.status !== 'done'; }).length, pending: pending.filter(function (p) { return p.status === 'pending'; }).length, processing: pending.filter(function (p) { return p.status === 'processing'; }).length };

    var html = '<div class="content">' +
      renderSyncBar() +
      '<div class="section-title">待处理中心</div>' +
      '<div class="filter-bar">' +
      '<select class="form-select" id="pending-status-filter" data-action="pending-status-filter">' + statusOptions + '</select>' +
      '</div>' +
      '<div class="stat-grid">' +
      '<div class="stat-card warning"><div class="stat-num">' + counts.total + '</div><div class="stat-label">总待处理</div></div>' +
      '<div class="stat-card"><div class="stat-num">' + counts.pending + '</div><div class="stat-label">待认领</div></div>' +
      '<div class="stat-card"><div class="stat-num">' + counts.processing + '</div><div class="stat-label">处理中</div></div>' +
      '</div>';

    if (displayList.length === 0) {
      html += '<div class="empty-state"><div class="emoji">🎉</div><p>暂无待处理任务</p></div>';
    } else {
      displayList.forEach(function (p) {
        var rec = p.currentRecord || records.find(function (r) { return r.id === p.recordId; }) || p.recordSnapshot;
        if (!rec) return;
        var statusBadge = p.status === 'processing' ? '<span class="status-badge status-pending_approval">处理中</span>' : '<span class="status-badge status-pending_sync">待认领</span>';
        var typeLabel = CONFLICT_TYPE_LABEL[p.conflictType] || p.conflictType;
        var claimed = p.status === 'processing' ? ' <span class="handler-tag">认领人:' + escapeHtml(p.currentHandler || '-') + '</span>' : '';

        html += '<div class="card">' +
          '<div class="card-header">' +
          '<span class="card-title">' + escapeHtml(rec.name || '未命名') + ' <span class="meta-tag">' + typeLabel + '</span></span>' +
          statusBadge +
          '</div>' +
          '<div class="card-body">' +
          '<p><strong>证件尾号：</strong>' + escapeHtml(rec.idTail || '-') + '</p>' +
          '<p><strong>部门：</strong>' + escapeHtml(rec.department || '-') + '</p>' +
          '<p><strong>时段：</strong>' + formatDT(rec.validStart) + ' ~ ' + formatDT(rec.validEnd) + '</p>' +
          '<p><strong>来源设备：</strong>' + escapeHtml(p.sourceDeviceName || rec.sourceDeviceName || '-') + '</p>' +
          '<p><strong>最近同步：</strong>' + formatDT(p.lastSyncedAt || rec.syncedAt) + '</p>' +
          claimed +
          (p.conflictReason ? '<p class="reason-text"><strong>冲突原因：</strong>' + escapeHtml(p.conflictReason) + '</p>' : '') +
          (p.handlerNote ? '<p class="note-text"><strong>处理备注：</strong>' + escapeHtml(p.handlerNote) + '</p>' : '') +
          '</div>' +
          '<div class="card-footer">' +
          '<button class="small-btn primary" data-action="open-manual-detail" data-pid="' + p.recordId + '">查看并处理</button>' +
          '</div>' +
          '</div>';
      });
    }

    html += '</div>';
    return html;
  }

  function renderAuditPage() {
    var audit = getAudit().slice();
    audit.sort(function (a, b) { return new Date(b.time).getTime() - new Date(a.time).getTime(); });

    var html = '<div class="content">' +
      '<div class="section-title">审计日志</div>' +
      '<div class="stat-grid">' +
      '<div class="stat-card"><div class="stat-num">' + audit.length + '</div><div class="stat-label">总日志</div></div>' +
      '<div class="stat-card"><div class="stat-num">' + audit.filter(function (a) { return a.action === 'approved'; }).length + '</div><div class="stat-label">放行</div></div>' +
      '<div class="stat-card"><div class="stat-num">' + audit.filter(function (a) { return a.action === 'rejected'; }).length + '</div><div class="stat-label">驳回</div></div>' +
      '<div class="stat-card"><div class="stat-num">' + audit.filter(function (a) { return a.action === 'revoked'; }).length + '</div><div class="stat-label">撤销</div></div>' +
      '</div>' +
      '<div class="tool-bar">' +
      '<button class="tool-btn" data-action="refresh-audit">🔄 刷新</button>' +
      '<button class="tool-btn" data-action="export-audit-csv">📄 导出 CSV</button>' +
      '<button class="tool-btn" data-action="export-audit-json">📋 导出 JSON</button>' +
      '</div>';

    if (audit.length === 0) {
      html += '<div class="empty-state"><div class="emoji">📜</div><p>暂无审计记录</p></div>';
    } else {
      var display = audit.slice(0, 100);
      display.forEach(function (a) {
        var actionBadge = a.action === 'approved' ? 'status-approved' :
          a.action === 'rejected' ? 'status-rejected' :
          a.action === 'revoked' ? 'status-revoked' :
          a.action === 'permission_denied' ? 'status-rejected' :
          'status-pending_approval';
        var actionLabel = {
          approved: '放行', rejected: '驳回', revoked: '撤销',
          sync_create: '创建登记', sync_update: '同步更新', sync_to_manual: '转人工',
          manual_resubmit: '重新提交', pending_claim: '认领任务', pending_release: '释放任务',
          permission_denied: '权限被拒', mark_duplicate: '标记重复',
          sync_invalid_time: '时段无效', sync_overlap_new: '时段重叠'
        }[a.action] || a.action;
        html += '<div class="card audit-card">' +
          '<div class="card-header">' +
          '<span class="card-title" style="font-size:13px;">' + formatDT(a.time) + '</span>' +
          '<span class="status-badge ' + actionBadge + '">' + actionLabel + '</span>' +
          '</div>' +
          '<div class="card-body">' +
          '<p><strong>操作人：</strong>' + escapeHtml(a.operator || '-') + ' (' + escapeHtml(a.operatorRole || '-') + ')</p>' +
          (a.recordId ? '<p><strong>记录ID：</strong>' + escapeHtml(a.recordId.slice(0, 16)) + '...</p>' : '') +
          (a.note ? '<p><strong>说明：</strong>' + escapeHtml(a.note) + '</p>' : '') +
          '</div>' +
          '</div>';
      });
      if (audit.length > 100) {
        html += '<p style="text-align:center;color:var(--gray-500);font-size:12px;padding:10px;">仅展示最近 100 条，完整数据请导出查看</p>';
      }
    }

    html += '</div>';
    return html;
  }

  function renderConflictPage() {
    var conflicts = getConflicts().filter(function (c) { return !c.resolved; });

    if (conflicts.length === 0) {
      return '<div class="content">' +
        '<div class="section-title">本机冲突</div>' +
        '<div class="empty-state"><div class="emoji">🤝</div><p>无待处理冲突（请前往【待处理中心】查看服务端冲突）</p></div>' +
        '</div>';
    }

    var html = '<div class="content"><div class="section-title">本机冲突</div>';

    conflicts.forEach(function (c) {
      html += '<div class="card">';
      html += '<div class="card-header"><span class="card-title">冲突 #' + c.id.slice(0, 12) + '</span>';
      var typeLabel = CONFLICT_TYPE_LABEL[c.conflictType || c.type] || '数据冲突';
      html += '<span class="status-badge status-rejected">' + typeLabel + '</span></div>';

      if (c.reason) {
        html += '<div class="card-body"><p class="reason-text"><strong>' + escapeHtml(c.reason) + '</strong></p></div>';
      }

      if (c.local) {
        var localDevName = c.local.sourceDeviceName || c.local.deviceName;
        html += '<div class="conflict-section local"><h4>本机数据' + (localDevName ? ' (来自 ' + escapeHtml(localDevName) + ')' : '') + '</h4>';
        html += '<p>姓名: ' + escapeHtml(c.local.name) + '</p>';
        html += '<p>证件尾号: ' + escapeHtml(c.local.idTail) + '</p>';
        html += '<p>部门: ' + escapeHtml(c.local.department) + '</p>';
        html += '<p>时段: ' + formatDT(c.local.validStart) + ' ~ ' + formatDT(c.local.validEnd) + '</p>';
        html += '<p>入口: ' + escapeHtml(c.local.entrance) + '</p>';
        html += '</div>';
      }

      if (c.server) {
        var serverDevName = c.server.sourceDeviceName || c.server.deviceName;
        html += '<div class="conflict-section server"><h4>服务器数据' + (serverDevName ? ' (来自 ' + escapeHtml(serverDevName) + ')' : '') + '</h4>';
        html += '<p>姓名: ' + escapeHtml(c.server.name) + '</p>';
        html += '<p>证件尾号: ' + escapeHtml(c.server.idTail) + '</p>';
        html += '<p>部门: ' + escapeHtml(c.server.department) + '</p>';
        html += '<p>时段: ' + formatDT(c.server.validStart) + ' ~ ' + formatDT(c.server.validEnd) + '</p>';
        html += '<p>入口: ' + escapeHtml(c.server.entrance) + '</p>';
        html += '</div>';
      }

      html += '<div class="btn-group">';
      html += '<button class="btn btn-primary" data-action="resolve-local" data-cid="' + c.id + '">保留本机</button>';
      html += '<button class="btn btn-secondary" data-action="resolve-server" data-cid="' + c.id + '">保留服务器</button>';
      html += '</div>';
      html += '</div>';
    });

    html += '</div>';
    return html;
  }

  function renderExportPage() {
    var records = getRecords();
    var total = records.length;
    var lastSync = getLastSync();

    return '<div class="content">' +
      '<div class="section-title">数据导出</div>' +
      '<div class="stat-grid">' +
      '<div class="stat-card"><div class="stat-num">' + total + '</div><div class="stat-label">总记录</div></div>' +
      '<div class="stat-card"><div class="stat-num">' + getQueue().length + '</div><div class="stat-label">待同步</div></div>' +
      '<div class="stat-card warning"><div class="stat-num">' + getPending().filter(function (p) { return p.status !== 'done'; }).length + '</div><div class="stat-label">待人工</div></div>' +
      '<div class="stat-card"><div class="stat-num">' + getAudit().length + '</div><div class="stat-label">审计数</div></div>' +
      '</div>' +
      '<p style="font-size:13px;color:var(--gray-500);margin-bottom:14px;">上次同步: ' + (lastSync ? formatDT(lastSync) : '从未同步') + '</p>' +
      '<div class="section-title">访客数据</div>' +
      '<div class="tool-bar">' +
      '<button class="tool-btn" data-action="export-csv">📄 访客 CSV</button>' +
      '<button class="tool-btn" data-action="export-json">📋 访客 JSON</button>' +
      '</div>' +
      '<div class="divider"></div>' +
      '<div class="section-title">审计日志</div>' +
      '<div class="tool-bar">' +
      '<button class="tool-btn" data-action="export-audit-csv">📄 审计 CSV</button>' +
      '<button class="tool-btn" data-action="export-audit-json">📋 审计 JSON</button>' +
      '</div>' +
      '<div class="divider"></div>' +
      '<div class="section-title">数据管理</div>' +
      '<div class="tool-bar">' +
      '<button class="tool-btn" data-action="sync-now">🔄 立即同步</button>' +
      '<button class="tool-btn" data-action="refresh-pending">📥 拉取待处理</button>' +
      '<button class="tool-btn" data-action="refresh-audit">📥 拉取审计</button>' +
      '<button class="tool-btn" data-action="clear-expired">🗑️ 清除过期</button>' +
      '</div>' +
      '</div>';
  }

  function renderNav(role, page) {
    if (!role) return '';
    var tabs = [];
    if (role === 'guard') {
      tabs.push({ key: 'register', label: '登记' });
      tabs.push({ key: 'pending', label: '待处理' });
      tabs.push({ key: 'records', label: '记录' });
    } else {
      tabs.push({ key: 'approval', label: '审批' });
      tabs.push({ key: 'pending', label: '待处理' });
      tabs.push({ key: 'records', label: '记录' });
      tabs.push({ key: 'audit', label: '审计' });
    }
    tabs.push({ key: 'conflicts', label: '冲突' });
    tabs.push({ key: 'export', label: '导出' });

    var pendingCount = getPending().filter(function (p) { return p.status !== 'done'; }).length;
    var html = '<div style="position:fixed;bottom:0;left:0;right:0;background:#fff;border-top:1px solid var(--gray-200);display:flex;max-width:480px;margin:0 auto;z-index:100;">';
    tabs.forEach(function (t) {
      var badge = (t.key === 'pending' && pendingCount > 0) ? '<span class="nav-badge">' + pendingCount + '</span>' : '';
      html += '<button style="flex:1;padding:10px 0;border:none;background:' + (page === t.key ? '#eff6ff' : '#fff') +
        ';color:' + (page === t.key ? 'var(--primary)' : 'var(--gray-500)') +
        ';font-size:12px;cursor:pointer;font-family:inherit;position:relative;" data-action="nav" data-page="' + t.key + '">' +
        t.label + badge + '</button>';
    });
    html += '</div>';
    return html;
  }

  var currentPage = 'register';
  var currentFilter = '';
  var currentDeptFilter = '';
  var currentStatusFilter = '';
  var currentPendingStatusFilter = '';

  function render() {
    checkExpiredRecords();
    var role = getRole();
    var app = document.getElementById('app');

    var body = '';
    if (!role) {
      body = renderRoleSelect();
    } else {
      switch (currentPage) {
        case 'register':
          body = renderGuardForm();
          break;
        case 'records':
          body = renderRecordList(currentFilter);
          break;
        case 'approval':
          body = renderApprovalPage(currentDeptFilter, currentStatusFilter);
          break;
        case 'pending':
          body = renderPendingCenter(currentPendingStatusFilter);
          break;
        case 'audit':
          body = renderAuditPage();
          break;
        case 'conflicts':
          body = renderConflictPage();
          break;
        case 'export':
          body = renderExportPage();
          break;
        default:
          body = renderGuardForm();
      }
    }

    app.innerHTML = renderHeader(role) + body + renderNav(role, currentPage);
    bindEvents();
  }

  function openManualModal(recordId) {
    var records = getRecords();
    var pending = getPending();
    var rec = records.find(function (r) { return r.id === recordId; });
    var p = pending.find(function (x) { return x.recordId === recordId; });
    if (!rec) { toast('记录不存在', 'error'); return; }

    var typeLabel = CONFLICT_TYPE_LABEL[p ? p.conflictType : 'unknown'] || '待人工处理';
    var isClaimed = p && p.status === 'processing';
    var isMine = p && p.currentHandler === deviceName;
    var historyHtml = '';
    if (p && p.processingHistory && p.processingHistory.length) {
      historyHtml = '<div class="section-title" style="margin-top:12px;">处理历史</div>' +
        p.processingHistory.map(function (h) {
          return '<div class="history-item">' +
            '<span class="history-time">' + formatDT(h.time) + '</span>' +
            '<span class="history-by">' + escapeHtml(h.by) + '</span>' +
            '<span class="history-action">' + escapeHtml(h.detail || h.action) + '</span>' +
            '</div>';
        }).join('');
    }

    var pad = function (n) { return n < 10 ? '0' + n : n; };
    var toLocal = function (iso) {
      if (!iso) return '';
      var d = new Date(iso);
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    };

    var allDepts = DEPARTMENTS.slice();
    records.forEach(function (r) { if (r.department && !allDepts.includes(r.department)) allDepts.push(r.department); });
    var deptOptions = allDepts.map(function (d) {
      return '<option value="' + d + '"' + (rec.department === d ? ' selected' : '') + '>' + d + '</option>';
    }).join('');

    var entranceOptions = ENTRANCES.map(function (e) {
      return '<option value="' + e + '"' + (rec.entrance === e ? ' selected' : '') + '>' + e + '</option>';
    }).join('');

    var claimBtn = '';
    if (!isClaimed) {
      claimBtn = '<button class="btn btn-secondary" data-action="claim-manual" data-mid="' + recordId + '">我来认领处理</button>';
    } else if (isMine) {
      claimBtn = '<button class="btn btn-secondary" data-action="release-manual" data-mid="' + recordId + '">释放任务</button>';
    } else {
      claimBtn = '<button class="btn btn-secondary" disabled>处理中: ' + escapeHtml(p.currentHandler) + '</button>';
    }

    var modal = document.createElement('div');
    modal.className = 'modal-backdrop';
    modal.innerHTML = '<div class="modal">' +
      '<div class="modal-title">' + escapeHtml(rec.name) + ' · ' + typeLabel + '</div>' +
      '<div class="form-group">' +
      '<label class="form-label">冲突原因</label>' +
      '<div class="reason-box">' + escapeHtml((p && p.conflictReason) || '需人工复核处理') + '</div>' +
      '</div>' +
      '<div class="form-group">' +
      '<label class="form-label">来源设备 / 最近同步</label>' +
      '<div>' + escapeHtml((p && p.sourceDeviceName) || rec.sourceDeviceName || rec.deviceName || '-') + ' · ' + formatDT((p && p.lastSyncedAt) || rec.syncedAt) + '</div>' +
      '</div>' +
      '<div class="divider"></div>' +
      '<div class="section-title" style="margin:0 0 10px;">编辑资料</div>' +
      '<div class="form-group"><label class="form-label">部门</label>' +
      '<select class="form-select" id="m-department">' + deptOptions + '</select></div>' +
      '<div class="form-group"><label class="form-label">陪同人</label>' +
      '<input class="form-input" id="m-escort" value="' + escapeHtml(rec.escort || '') + '" /></div>' +
      '<div class="form-group"><label class="form-label">入口</label>' +
      '<select class="form-select" id="m-entrance">' + entranceOptions + '</select></div>' +
      '<div class="form-group"><label class="form-label">有效时段</label><div class="form-row">' +
      '<input class="form-input" type="datetime-local" id="m-start" value="' + toLocal(rec.validStart) + '" />' +
      '<input class="form-input" type="datetime-local" id="m-end" value="' + toLocal(rec.validEnd) + '" />' +
      '</div></div>' +
      '<div class="form-group"><label class="form-label">处理备注<span class="req">*</span></label>' +
      '<textarea class="form-textarea" id="m-note" rows="3" placeholder="请填写处理说明"></textarea></div>' +
      historyHtml +
      '<div class="btn-group">' + claimBtn + '</div>' +
      '<div class="btn-group" style="margin-top:12px;">' +
      '<button class="btn btn-success" data-action="manual-approve" data-mid="' + recordId + '">复核通过 · 放行</button>' +
      '<button class="btn btn-primary" data-action="manual-resubmit" data-mid="' + recordId + '">修改后重提</button>' +
      '</div>' +
      '<div class="btn-group">' +
      '<button class="btn btn-danger" data-action="manual-reject" data-mid="' + recordId + '">驳回</button>' +
      '<button class="btn btn-secondary" data-action="manual-dup" data-mid="' + recordId + '">标记重复</button>' +
      '<button class="btn btn-outline" data-action="close-modal">关闭</button>' +
      '</div></div>';
    document.body.appendChild(modal);
  }

  function openHistoryModal(recordId) {
    var pending = getPending();
    var p = pending.find(function (x) { return x.recordId === recordId; });
    if (!p || !p.processingHistory || p.processingHistory.length === 0) {
      toast('暂无处理历史', 'info'); return;
    }
    var historyHtml = p.processingHistory.map(function (h) {
      return '<div class="history-item">' +
        '<span class="history-time">' + formatDT(h.time) + '</span>' +
        '<span class="history-by">' + escapeHtml(h.by) + '</span>' +
        '<span class="history-action">' + escapeHtml(h.detail || h.action) + '</span>' +
        '</div>';
    }).join('');
    var modal = document.createElement('div');
    modal.className = 'modal-backdrop';
    modal.innerHTML = '<div class="modal">' +
      '<div class="modal-title">处理历史</div>' +
      historyHtml +
      '<div class="btn-group" style="margin-top:14px;">' +
      '<button class="btn btn-outline" data-action="close-modal">关闭</button>' +
      '</div></div>';
    document.body.appendChild(modal);
  }

  function doManualAction(recordId, action, extraNote, data) {
    if (!isOnline()) { toast('请保持在线再处理', 'error'); return Promise.reject(); }
    var note = extraNote;
    if (!note) {
      var noteEl = document.getElementById('m-note');
      note = noteEl ? noteEl.value.trim() : '';
    }
    var payload = {
      action: action,
      handler: deviceName,
      handlerRole: getRole() || 'guard',
      note: note
    };
    if (data) payload.resolutionData = data;
    return fetchJSON('/api/pending/' + recordId + '/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  }

  function collectManualData() {
    return {
      department: document.getElementById('m-department').value,
      escort: document.getElementById('m-escort').value.trim(),
      entrance: document.getElementById('m-entrance').value,
      validStart: new Date(document.getElementById('m-start').value).toISOString(),
      validEnd: new Date(document.getElementById('m-end').value).toISOString()
    };
  }

  function bindEvents() {
    var app = document.getElementById('app');

    app.addEventListener('click', function (e) {
      var target = e.target.closest('[data-action]');
      if (!target) return;
      var action = target.getAttribute('data-action');
      var mid = target.getAttribute('data-mid') || target.getAttribute('data-id') || target.getAttribute('data-pid');

      switch (action) {
        case 'select-guard':
          setRole('guard');
          currentPage = 'register';
          render();
          break;
        case 'select-approver':
          setRole('approver');
          currentPage = 'approval';
          if (isOnline()) {
            pullSync().catch(function () {});
          }
          render();
          break;
        case 'switch-role':
          var cur = getRole();
          setRole(cur === 'guard' ? 'approver' : 'guard');
          currentPage = getRole() === 'guard' ? 'register' : 'approval';
          currentFilter = '';
          currentDeptFilter = '';
          currentStatusFilter = '';
          currentPendingStatusFilter = '';
          if (isOnline()) pullSync().catch(function () {});
          render();
          break;
        case 'select-entrance':
          var val = target.getAttribute('data-value');
          document.querySelectorAll('.entrance-tag').forEach(function (t) { t.classList.remove('selected'); });
          target.classList.add('selected');
          var inp = document.getElementById('entrance-input');
          if (inp) inp.value = val;
          break;
        case 'filter':
          currentFilter = target.getAttribute('data-status');
          render();
          break;
        case 'nav':
          currentPage = target.getAttribute('data-page');
          currentFilter = '';
          if (currentPage === 'approval') {
            if (isOnline()) pullSync().catch(function () {});
          } else if (currentPage === 'audit') {
            if (isOnline()) fetchAuditFromServer().then(render).catch(render);
          } else if (currentPage === 'pending') {
            if (isOnline()) fetchPendingFromServer().then(render).catch(render);
          }
          render();
          break;
        case 'approve':
          approveRecord(target.getAttribute('data-id'));
          break;
        case 'reject':
          showRejectModal(target.getAttribute('data-id'));
          break;
        case 'revoke':
          revokeRecord(target.getAttribute('data-id'));
          break;
        case 'open-manual':
        case 'open-manual-detail':
          openManualModal(mid);
          break;
        case 'view-history':
          openHistoryModal(target.getAttribute('data-id'));
          break;
        case 'claim-manual':
          doManualAction(mid, 'claim').then(function () {
            toast('已认领', 'success');
            return Promise.all([pullSync(), fetchPendingFromServer()]);
          }).then(function () {
            var modal = document.querySelector('.modal-backdrop');
            if (modal) modal.remove();
            openManualModal(mid);
          }).catch(function (e) { toast(e.message, 'error'); });
          break;
        case 'release-manual':
          doManualAction(mid, 'release').then(function () {
            toast('已释放', 'success');
            return Promise.all([pullSync(), fetchPendingFromServer()]);
          }).then(function () {
            var modal = document.querySelector('.modal-backdrop');
            if (modal) modal.remove();
            openManualModal(mid);
          }).catch(function (e) { toast(e.message, 'error'); });
          break;
        case 'manual-approve':
          if (getRole() !== 'approver') { toast('仅审批人可放行', 'error'); return; }
          doManualAction(mid, 'approve_manual').then(function () {
            toast('已放行', 'success');
            return pullSync();
          }).then(function () {
            var modal = document.querySelector('.modal-backdrop');
            if (modal) modal.remove();
            render();
          }).catch(function (e) { toast(e.message, 'error'); });
          break;
        case 'manual-reject':
          if (getRole() !== 'approver') { toast('仅审批人可驳回', 'error'); return; }
          doManualAction(mid, 'reject_manual').then(function () {
            toast('已驳回', 'success');
            return pullSync();
          }).then(function () {
            var modal = document.querySelector('.modal-backdrop');
            if (modal) modal.remove();
            render();
          }).catch(function (e) { toast(e.message, 'error'); });
          break;
        case 'manual-resubmit':
          var data = collectManualData();
          doManualAction(mid, 'edit_and_resubmit', '', data).then(function () {
            toast('资料已更新，重新进入审批', 'success');
            return pullSync();
          }).then(function () {
            var modal = document.querySelector('.modal-backdrop');
            if (modal) modal.remove();
            render();
          }).catch(function (e) { toast(e.message, 'error'); });
          break;
        case 'manual-dup':
          doManualAction(mid, 'mark_duplicate').then(function () {
            toast('已标记为重复并驳回', 'success');
            return pullSync();
          }).then(function () {
            var modal = document.querySelector('.modal-backdrop');
            if (modal) modal.remove();
            render();
          }).catch(function (e) { toast(e.message, 'error'); });
          break;
        case 'resolve-local':
          resolveConflict(target.getAttribute('data-cid'), 'local');
          break;
        case 'resolve-server':
          resolveConflict(target.getAttribute('data-cid'), 'server');
          break;
        case 'export-csv':
          exportData('csv', 'visitors');
          break;
        case 'export-json':
          exportData('json', 'visitors');
          break;
        case 'export-audit-csv':
          exportData('csv', 'audit');
          break;
        case 'export-audit-json':
          exportData('json', 'audit');
          break;
        case 'sync-now':
          fullSync();
          break;
        case 'refresh-pending':
          if (isOnline()) {
            fetchPendingFromServer().then(function () { toast('待处理已更新', 'success'); render(); }).catch(function () {});
          } else {
            toast('当前离线', 'error');
          }
          break;
        case 'refresh-audit':
          if (isOnline()) {
            fetchAuditFromServer().then(function () { toast('审计已更新', 'success'); render(); }).catch(function () {});
          } else {
            toast('当前离线', 'error');
          }
          break;
        case 'clear-expired':
          clearExpired();
          break;
        case 'close-modal':
          var modal = document.querySelector('.modal-backdrop');
          if (modal) modal.remove();
          break;
        case 'submit-reject':
          submitReject();
          break;
      }
    });

    var deptFilter = document.getElementById('dept-filter');
    if (deptFilter) {
      deptFilter.addEventListener('change', function () {
        currentDeptFilter = this.value;
        render();
      });
    }
    var statusFilter = document.getElementById('status-filter');
    if (statusFilter) {
      statusFilter.addEventListener('change', function () {
        currentStatusFilter = this.value;
        render();
      });
    }
    var pendingStatusFilter = document.getElementById('pending-status-filter');
    if (pendingStatusFilter) {
      pendingStatusFilter.addEventListener('change', function () {
        currentPendingStatusFilter = this.value;
        render();
      });
    }

    var form = document.getElementById('register-form');
    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        submitRegister(form);
      });
    }
  }

  function validateRegister(data) {
    var errors = {};
    if (!data.name || !data.name.trim()) errors.name = '请输入访客姓名';
    if (!data.idTail || !data.idTail.trim()) errors.idTail = '请输入证件尾号';
    if (!data.department) errors.department = '请选择来访部门';
    if (!data.entrance) errors.entrance = '请选择入口';
    if (!data.validStart || !data.validEnd) {
      errors.validTime = '请选择有效时段';
    } else {
      var start = new Date(data.validStart).getTime();
      var end = new Date(data.validEnd).getTime();
      if (end <= start) {
        errors.validTime = '结束时间必须晚于开始时间';
      }
    }
    return errors;
  }

  function submitRegister(form) {
    var fd = new FormData(form);
    var data = {
      name: fd.get('name'),
      idTail: fd.get('idTail'),
      department: fd.get('department'),
      validStart: fd.get('validStart') ? new Date(fd.get('validStart')).toISOString() : '',
      validEnd: fd.get('validEnd') ? new Date(fd.get('validEnd')).toISOString() : '',
      escort: fd.get('escort') || '',
      entrance: document.getElementById('entrance-input') ? document.getElementById('entrance-input').value : ''
    };

    var errors = validateRegister(data);
    document.querySelectorAll('.field-error').forEach(function (el) { el.textContent = ''; });
    document.querySelectorAll('.form-input.error, .form-select.error').forEach(function (el) { el.classList.remove('error'); });

    if (Object.keys(errors).length > 0) {
      Object.keys(errors).forEach(function (key) {
        var errEl = document.getElementById('err-' + key);
        if (errEl) errEl.textContent = errors[key];
        var input = form.querySelector('[name="' + key + '"]');
        if (input) input.classList.add('error');
      });
      return;
    }

    var records = getRecords();
    var isDuplicate = records.some(function (r) {
      return r.name === data.name &&
        r.idTail === data.idTail &&
        !['rejected', 'revoked', 'expired'].includes(r.status) &&
        hasOverlap(data.validStart, data.validEnd, r.validStart, r.validEnd);
    });

    if (isDuplicate) {
      toast('同一访客同一时段已有登记，将进入待人工复核', 'error');
    }

    var id = generateId();
    var now = nowISO();
    var record = {
      id: id,
      name: data.name.trim(),
      idTail: data.idTail.trim(),
      department: data.department,
      validStart: data.validStart,
      validEnd: data.validEnd,
      escort: data.escort.trim(),
      entrance: data.entrance,
      status: 'pending_sync',
      deviceId: deviceId,
      deviceName: deviceName,
      sourceDevice: deviceId,
      sourceDeviceName: deviceName,
      createdAt: now,
      updatedAt: now
    };

    records.push(record);
    saveRecords(records);

    var queue = getQueue();
    queue.push(id);
    saveQueue(queue);

    toast('登记成功' + (isOnline() ? '' : '（离线保存）'), 'success');

    if (isOnline()) {
      fullSync();
    } else {
      render();
    }
  }

  function approveRecord(id) {
    if (getRole() !== 'approver') {
      toast('保安无审批权限', 'error');
      return;
    }

    var records = getRecords();
    var idx = records.findIndex(function (r) { return r.id === id; });
    if (idx < 0) return;

    var rec = records[idx];
    if (rec.status === 'pending_manual') {
      toast('该记录需先完成人工处理', 'error');
      return;
    }

    records[idx].status = 'approved';
    records[idx].approver = deviceName;
    records[idx].approverRole = getRole();
    records[idx].updatedAt = nowISO();
    saveRecords(records);

    if (isOnline()) {
      fetchJSON('/api/visitors/' + id, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'approved', approver: deviceName, approverRole: 'approver', operator: deviceName })
      }).then(function () {
        return Promise.all([pullSync(), fetchAuditFromServer()]);
      }).then(function () {
        toast('已放行', 'success');
        render();
      }).catch(function (e) {
        toast('服务器更新失败，本地已放行: ' + e.message, 'error');
        render();
      });
    } else {
      var queue = getQueue();
      if (!queue.includes(id)) queue.push(id);
      saveQueue(queue);
      toast('已放行（离线保存）', 'success');
      render();
    }
  }

  function showRejectModal(id) {
    if (getRole() !== 'approver') {
      toast('保安无审批权限', 'error');
      return;
    }

    var modal = document.createElement('div');
    modal.className = 'modal-backdrop';
    modal.innerHTML = '<div class="modal">' +
      '<div class="modal-title">拒绝通行</div>' +
      '<div class="form-group">' +
      '<label class="form-label">拒绝原因</label>' +
      '<textarea class="form-textarea" id="reject-note" rows="3" placeholder="请输入拒绝原因"></textarea>' +
      '</div>' +
      '<div class="btn-group">' +
      '<button class="btn btn-danger" data-action="submit-reject" data-rid="' + id + '">确认拒绝</button>' +
      '<button class="btn btn-secondary" data-action="close-modal">取消</button>' +
      '</div></div>';
    document.body.appendChild(modal);
  }

  function submitReject() {
    var btn = document.querySelector('[data-action="submit-reject"]');
    if (!btn) return;
    var id = btn.getAttribute('data-rid');
    var note = document.getElementById('reject-note');
    var noteText = note ? note.value.trim() : '';

    var records = getRecords();
    var idx = records.findIndex(function (r) { return r.id === id; });
    if (idx < 0) return;

    records[idx].status = 'rejected';
    records[idx].approver = deviceName;
    records[idx].approverRole = getRole();
    records[idx].rejectNote = noteText;
    records[idx].updatedAt = nowISO();
    saveRecords(records);

    var modal = document.querySelector('.modal-backdrop');
    if (modal) modal.remove();

    if (isOnline()) {
      fetchJSON('/api/visitors/' + id, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'rejected', approver: deviceName, approverRole: 'approver', note: noteText, operator: deviceName })
      }).then(function () {
        return Promise.all([pullSync(), fetchAuditFromServer()]);
      }).then(function () {
        toast('已拒绝', 'success');
        render();
      }).catch(function () {
        toast('服务器更新失败，本地已拒绝', 'error');
        render();
      });
    } else {
      var queue = getQueue();
      if (!queue.includes(id)) queue.push(id);
      saveQueue(queue);
      toast('已拒绝（离线保存）', 'success');
      render();
    }
  }

  function revokeRecord(id) {
    var records = getRecords();
    var idx = records.findIndex(function (r) { return r.id === id; });
    if (idx < 0) return;

    var rec = records[idx];
    if (getRole() === 'guard' && rec.status !== 'pending_sync') {
      toast('保安只能撤销待同步记录', 'error');
      return;
    }

    records[idx].status = 'revoked';
    records[idx].updatedAt = nowISO();
    saveRecords(records);

    if (isOnline()) {
      fetchJSON('/api/visitors/' + id, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'revoked', approverRole: getRole(), operator: deviceName })
      }).then(function () {
        return Promise.all([pullSync(), fetchAuditFromServer()]);
      }).then(function () {
        toast('已撤销', 'success');
        render();
      }).catch(function (e) {
        toast('服务器更新失败，本地已撤销: ' + e.message, 'error');
        render();
      });
    } else {
      var queue = getQueue();
      if (!queue.includes(id)) queue.push(id);
      saveQueue(queue);
      toast('已撤销（离线保存）', 'success');
      render();
    }
  }

  function resolveConflict(conflictId, choice) {
    var conflicts = getConflicts();
    var cidx = conflicts.findIndex(function (c) { return c.id === conflictId; });
    if (cidx < 0) return;

    var c = conflicts[cidx];
    var records = getRecords();

    if (choice === 'local' && c.local) {
      var localIdx = records.findIndex(function (r) { return r.id === c.id; });
      if (localIdx >= 0) {
        records[localIdx].status = 'pending_approval';
        records[localIdx].updatedAt = nowISO();
      }
      if (isOnline()) {
        fetchJSON('/api/sync/push', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            records: [c.local],
            deviceId: deviceId,
            deviceName: deviceName,
            forceOverwrite: true,
            operator: deviceName,
            operatorRole: getRole() || 'guard'
          })
        }).then(function () {
          return pullSync();
        }).catch(function () { });
      }
    } else if (choice === 'server' && c.server) {
      var serverIdx = records.findIndex(function (r) { return r.id === c.id; });
      if (serverIdx >= 0) {
        records[serverIdx] = Object.assign({}, c.server, { updatedAt: nowISO() });
      } else {
        records.push(c.server);
      }
    }

    conflicts[cidx].resolved = true;
    conflicts[cidx].resolvedAt = nowISO();
    conflicts[cidx].resolution = choice;

    saveRecords(records);
    saveConflicts(conflicts);

    var queue = getQueue();
    var newQueue = queue.filter(function (qid) { return qid !== conflictId; });
    saveQueue(newQueue);

    toast('冲突已解决', 'success');
    render();
  }

  function exportData(format, kind) {
    var query = '';
    if (kind === 'audit') {
      query = '/api/audit?format=' + format;
    } else {
      query = '/api/export?format=' + format;
      if (currentDeptFilter) query += '&department=' + encodeURIComponent(currentDeptFilter);
      if (currentStatusFilter) query += '&status=' + encodeURIComponent(currentStatusFilter);
    }

    if (isOnline()) {
      window.open(query, '_blank');
      toast((kind === 'audit' ? '审计' : '访客') + ' ' + format.toUpperCase() + ' 导出中', 'success');
    } else {
      if (kind === 'audit') {
        var audit = getAudit();
        if (audit.length === 0) { toast('无审计数据可导出', 'error'); return; }
        if (format === 'csv') {
          var aheaders = ['id', 'time', 'action', 'recordId', 'operator', 'operatorRole', 'note'];
          var acsv = [aheaders.join(',')].concat(
            audit.map(function (r) {
              return aheaders.map(function (h) {
                var v = String(r[h] || '');
                if (v.includes(',') || v.includes('"') || v.includes('\n')) {
                  v = '"' + v.replace(/"/g, '""') + '"';
                }
                return v;
              }).join(',');
            })
          ).join('\n');
          downloadFile('\uFEFF' + acsv, 'audit_log.csv', 'text/csv;charset=utf-8');
        } else {
          downloadFile(JSON.stringify({ exportedAt: nowISO(), count: audit.length, records: audit }, null, 2),
            'audit_log.json', 'application/json');
        }
        toast('审计 ' + format.toUpperCase() + ' 已导出', 'success');
      } else {
        var records = getRecords();
        if (records.length === 0) { toast('无数据可导出', 'error'); return; }
        if (format === 'csv') {
          var headers = ['id', 'name', 'idTail', 'department', 'escort', 'entrance', 'validStart', 'validEnd', 'status', 'approver', 'rejectNote', 'createdAt', 'updatedAt', 'syncedAt', 'sourceDevice', 'sourceDeviceName'];
          var csv = [headers.join(',')].concat(
            records.map(function (r) {
              return headers.map(function (h) {
                var v;
                if (h === 'sourceDevice') {
                  v = r.sourceDevice || r.deviceId || '';
                } else if (h === 'sourceDeviceName') {
                  v = r.sourceDeviceName || r.deviceName || '';
                } else if (h === 'syncedAt') {
                  v = r.syncedAt || '';
                } else {
                  v = r[h] || '';
                }
                v = String(v);
                if (v.includes(',') || v.includes('"') || v.includes('\n')) {
                  v = '"' + v.replace(/"/g, '""') + '"';
                }
                return v;
              }).join(',');
            })
          ).join('\n');
          downloadFile('\uFEFF' + csv, 'visitors.csv', 'text/csv;charset=utf-8');
        } else {
          downloadFile(JSON.stringify({ exportedAt: nowISO(), count: records.length, records: records }, null, 2),
            'visitors.json', 'application/json');
        }
        toast('访客 ' + format.toUpperCase() + ' 已导出', 'success');
      }
    }
  }

  function downloadFile(content, filename, mimeType) {
    var blob = new Blob([content], { type: mimeType });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
  }

  function clearExpired() {
    var records = getRecords();
    var before = records.length;
    var remaining = records.filter(function (r) { return r.status !== 'expired'; });
    saveRecords(remaining);
    var removed = before - remaining.length;
    toast('已清除 ' + removed + ' 条过期记录', 'success');
    render();
  }

  window.addEventListener('online', function () {
    toast('网络已恢复，开始同步', 'success');
    fullSync();
  });

  window.addEventListener('offline', function () {
    toast('网络已断开，进入离线模式', 'error');
    render();
  });

  if (getRole() && isOnline()) {
    checkExpiredRecords();
  }

  render();

  if (isOnline() && getRole()) {
    pullSync().then(function () {
      render();
    }).catch(function () { });
  }
})();