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
  var CONTEXT_KEY = 'cvp_approval_context';
  var HANDLER_NOTES_KEY = 'cvp_handler_notes';
  var EXPORT_RESULT_KEY = 'cvp_last_export';
  var VERSION_CACHE_KEY = 'cvp_versions';
  var SESSIONS_KEY = 'cvp_sessions';
  var SEARCH_KEY = 'cvp_search_keyword';
  var PAGE_KEY = 'cvp_current_page';
  var PAGE_SIZE_KEY = 'cvp_page_size';
  var SELECTED_KEY = 'cvp_selected_records';
  var EXPORT_FIELDS_KEY = 'cvp_export_fields';
  var CLAIM_LOCKS_KEY = 'cvp_claim_locks';
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

  function getContext() { return loadJSON(CONTEXT_KEY, {}); }
  function saveContext(ctx) {
    var current = getContext();
    saveJSON(CONTEXT_KEY, Object.assign({}, current, ctx, { savedAt: nowISO() }));
  }
  function clearContext() { localStorage.removeItem(CONTEXT_KEY); }

  function getHandlerNotes() { return loadJSON(HANDLER_NOTES_KEY, {}); }
  function saveHandlerNote(recordId, note) {
    var notes = getHandlerNotes();
    notes[recordId] = { note: note, updatedAt: nowISO(), by: deviceName };
    saveJSON(HANDLER_NOTES_KEY, notes);
  }
  function getHandlerNote(recordId) {
    var notes = getHandlerNotes();
    return notes[recordId] ? notes[recordId].note : '';
  }

  function getExportResult() { return loadJSON(EXPORT_RESULT_KEY, null); }
  function saveExportResult(result) {
    saveJSON(EXPORT_RESULT_KEY, Object.assign({}, result, { exportedAt: nowISO() }));
    triggerAutoSave();
  }

  function getLocalVersions() { return loadJSON(VERSION_CACHE_KEY, { visitors: [], pending: [] }); }
  function saveLocalVersions(versions) { saveJSON(VERSION_CACHE_KEY, versions); }

  function getSessionsCache() { return loadJSON(SESSIONS_KEY, []); }
  function saveSessionsCache(sessions) { saveJSON(SESSIONS_KEY, sessions); }
  function getSearchKeyword() { return localStorage.getItem(SEARCH_KEY) || ''; }
  function setSearchKeyword(k) { localStorage.setItem(SEARCH_KEY, k || ''); }
  function getCurrentPage() { return parseInt(localStorage.getItem(PAGE_KEY) || '1', 10); }
  function setCurrentPage(p) { localStorage.setItem(PAGE_KEY, String(p || 1)); }
  function getPageSize() { return parseInt(localStorage.getItem(PAGE_SIZE_KEY) || '20', 10); }
  function setPageSize(s) { localStorage.setItem(PAGE_SIZE_KEY, String(s || 20)); }
  function getSelectedRecords() { return loadJSON(SELECTED_KEY, []); }
  function saveSelectedRecords(ids) { saveJSON(SELECTED_KEY, ids || []); }
  function toggleSelectedRecord(id) {
    var selected = getSelectedRecords();
    var idx = selected.indexOf(id);
    if (idx >= 0) selected.splice(idx, 1);
    else selected.push(id);
    saveSelectedRecords(selected);
    return selected;
  }
  function clearSelectedRecords() { saveSelectedRecords([]); }
  function getExportFields() { return loadJSON(EXPORT_FIELDS_KEY, null); }
  function saveExportFields(fields) { saveJSON(EXPORT_FIELDS_KEY, fields); }
  function getClaimLocks() { return loadJSON(CLAIM_LOCKS_KEY, []); }
  function saveClaimLocks(locks) { saveJSON(CLAIM_LOCKS_KEY, locks); }

  function fetchSessionsFromServer() {
    if (!isOnline() || getRole() !== 'approver') return Promise.resolve([]);
    return fetchJSON('/api/sessions?role=approver&approver=' + encodeURIComponent(deviceName) + '&deviceId=' + encodeURIComponent(deviceId) + '&handover=true', { method: 'GET' })
      .then(function (res) {
        if (res && res.ok) {
          saveSessionsCache(res.sessions || []);
          return res.sessions || [];
        }
        return [];
      }).catch(function () { return getSessionsCache(); });
  }

  function saveSessionToServer() {
    if (!isOnline() || getRole() !== 'approver') return Promise.resolve(null);
    var state = {
      currentPage: currentPage,
      currentFilter: currentFilter,
      currentDeptFilter: currentDeptFilter,
      currentStatusFilter: currentStatusFilter,
      currentPendingStatusFilter: currentPendingStatusFilter,
      searchKeyword: getSearchKeyword(),
      pageNumber: getCurrentPage(),
      pageSize: getPageSize(),
      selectedRecords: getSelectedRecords(),
      exportFields: getExportFields(),
      lastSync: getLastSync(),
      sourceDevice: deviceId,
      sourceDeviceName: deviceName,
      handlerNotes: getHandlerNotes(),
      lastExport: getExportResult(),
      openManualRecordId: getContext().openManualRecordId || null,
      savedAt: nowISO()
    };
    return fetchJSON('/api/sessions?role=approver', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: deviceId,
        deviceName: deviceName,
        approver: deviceName,
        approverRole: 'approver',
        state: state
      })
    }).then(function (res) {
      if (res && res.ok) return res.session;
      return null;
    }).catch(function () { return null; });
  }

  function deleteSessionFromServer(sessionId) {
    if (!isOnline() || getRole() !== 'approver') return Promise.resolve(false);
    return fetchJSON('/api/sessions/' + sessionId + '?role=approver&approver=' + encodeURIComponent(deviceName), {
      method: 'DELETE'
    }).then(function (res) {
      return res && res.ok;
    }).catch(function () { return false; });
  }

  function restoreContextFromCache() {
    var ctx = getContext();
    if (!ctx || !ctx.role) return false;
    if (ctx.role !== getRole()) return false;
    if (ctx.currentPage) currentPage = ctx.currentPage;
    if (ctx.currentFilter !== undefined) currentFilter = ctx.currentFilter;
    if (ctx.currentDeptFilter !== undefined) currentDeptFilter = ctx.currentDeptFilter;
    if (ctx.currentStatusFilter !== undefined) currentStatusFilter = ctx.currentStatusFilter;
    if (ctx.currentPendingStatusFilter !== undefined) currentPendingStatusFilter = ctx.currentPendingStatusFilter;
    return true;
  }

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
    return fetchJSON('/api/audit?role=' + encodeURIComponent(getRole() || 'guard'), { method: 'GET' }).then(function (res) {
      if (res && res.ok) saveAudit(res.records || []);
    }).catch(function () {});
  }

  function fetchVersionsFromServer() {
    return fetchJSON('/api/visitors/versions', { method: 'GET' }).then(function (res) {
      if (res && res.ok) return res;
      return null;
    }).catch(function () { return null; });
  }

  function detectConflicts(serverVersions) {
    if (!serverVersions) return { visitors: [], pending: [] };
    var localRecords = getRecords();
    var localMap = {};
    localRecords.forEach(function (r) {
      localMap[r.id] = {
        status: r.status,
        updatedAt: r.updatedAt || r.createdAt,
        syncedAt: r.syncedAt,
        approver: r.approver
      };
    });

    var visitorConflicts = [];
    (serverVersions.visitors || []).forEach(function (sv) {
      var local = localMap[sv.id];
      if (!local) return;
      var localUpdated = new Date(local.updatedAt).getTime();
      var serverUpdated = new Date(sv.updatedAt).getTime();
      var serverNewer = serverUpdated > localUpdated;
      var statusDiff = local.status !== sv.status;
      if (statusDiff && serverNewer) {
        visitorConflicts.push({
          id: sv.id,
          localStatus: local.status,
          serverStatus: sv.status,
          localUpdatedAt: local.updatedAt,
          serverUpdatedAt: sv.updatedAt,
          type: 'status_conflict'
        });
      } else if (serverNewer && sv.syncedAt && (!local.syncedAt || new Date(sv.syncedAt).getTime() > new Date(local.syncedAt).getTime())) {
        visitorConflicts.push({
          id: sv.id,
          localStatus: local.status,
          serverStatus: sv.status,
          localUpdatedAt: local.updatedAt,
          serverUpdatedAt: sv.updatedAt,
          type: 'data_update'
        });
      }
    });

    var localPending = getPending();
    var pendingMap = {};
    localPending.forEach(function (p) {
      pendingMap[p.recordId] = {
        status: p.status,
        currentHandler: p.currentHandler,
        handlerNote: p.handlerNote
      };
    });

    var pendingConflicts = [];
    (serverVersions.pending || []).forEach(function (sp) {
      var local = pendingMap[sp.recordId];
      if (!local) return;
      if (sp.currentHandler !== local.currentHandler && sp.currentHandler && sp.currentHandler !== deviceName) {
        pendingConflicts.push({
          recordId: sp.recordId,
          localHandler: local.currentHandler,
          serverHandler: sp.currentHandler,
          type: 'handler_taken',
          detail: '任务已被 ' + sp.currentHandler + ' 认领'
        });
      }
    });

    return { visitors: visitorConflicts, pending: pendingConflicts };
  }

  function showConflictAlert(conflicts) {
    if (!conflicts || (conflicts.visitors.length === 0 && conflicts.pending.length === 0)) return;
    var total = conflicts.visitors.length + conflicts.pending.length;
    var msg = '检测到 ' + total + ' 项与服务器状态不一致：\n\n';
    conflicts.visitors.slice(0, 3).forEach(function (c) {
      msg += '• 记录 ' + c.id.slice(0, 10) + '... 状态变化：' +
        (STATUS_MAP[c.localStatus] || c.localStatus) + ' → ' +
        (STATUS_MAP[c.serverStatus] || c.serverStatus) + '\n';
    });
    conflicts.pending.slice(0, 3).forEach(function (c) {
      msg += '• 待处理 ' + c.recordId.slice(0, 10) + '...：' + c.detail + '\n';
    });
    if (total > 6) msg += '\n... 及其他 ' + (total - 6) + ' 项';
    msg += '\n\n建议：点击「确认」后将从服务器拉取最新数据，未提交的备注会保留在本地。';
    if (confirm(msg)) {
      pullSync();
    }
  }

  function fullSync() {
    if (!isOnline()) {
      toast('当前离线，无法同步', 'error');
      return Promise.resolve();
    }
    var pendingConflicts = null;
    return fetchVersionsFromServer().then(function (v) {
      if (v) {
        pendingConflicts = detectConflicts(v);
        saveLocalVersions({ visitors: v.visitors, pending: v.pending, serverTime: v.serverTime });
      }
      return pushSync();
    }).then(function () {
      return pullSync();
    }).then(function () {
      if (pendingConflicts && (pendingConflicts.visitors.length > 0 || pendingConflicts.pending.length > 0)) {
        showConflictAlert(pendingConflicts);
      } else {
        toast('同步完成', 'success');
      }
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

    var diagnosisHtml = '';
    if (rec.status === 'pending_approval' || rec.status === 'pending_manual' || pending) {
      var syncVal = rec.syncedAt || (pending && pending.lastSyncedAt);
      var devVal = devName || (pending && pending.sourceDeviceName) || devId || '-';
      var handlerVal = (pending && pending.currentHandler) || '-';
      var conflictVal = pending && pending.conflictReason ? pending.conflictReason : (rec.status === 'pending_approval' ? '等待审批人确认' : '-');
      diagnosisHtml = '<div class="diagnosis-grid">' +
        '<div class="diag-item"><span class="diag-label">最近同步</span><span class="diag-value">' + (syncVal ? formatDT(syncVal) : '-') + '</span></div>' +
        '<div class="diag-item"><span class="diag-label">来源设备</span><span class="diag-value">' + escapeHtml(devVal) + '</span></div>' +
        '<div class="diag-item"><span class="diag-label">当前处理人</span><span class="diag-value">' + escapeHtml(handlerVal) + '</span></div>' +
        '<div class="diag-item diag-full"><span class="diag-label">冲突原因</span><span class="diag-value reason-inline">' + escapeHtml(conflictVal) + '</span></div>' +
        '</div>';
    }

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
      diagnosisHtml +
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
    var selected = getSelectedRecords();
    var searchKeyword = getSearchKeyword();
    var currentPageNum = getCurrentPage();
    var pageSize = getPageSize();
    var claimLocks = getClaimLocks();

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
    if (searchKeyword) {
      var s = searchKeyword.toLowerCase();
      displayRecords = displayRecords.filter(function (r) {
        return (r.name && r.name.toLowerCase().includes(s)) ||
          (r.idTail && r.idTail.toLowerCase().includes(s)) ||
          (r.department && r.department.toLowerCase().includes(s)) ||
          (r.escort && r.escort.toLowerCase().includes(s));
      });
    }
    displayRecords.sort(function (a, b) {
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    var total = displayRecords.length;
    var totalPages = Math.max(1, Math.ceil(total / pageSize));
    if (currentPageNum > totalPages) {
      setCurrentPage(totalPages);
      currentPageNum = totalPages;
    }
    var startIdx = (currentPageNum - 1) * pageSize;
    var paginatedRecords = displayRecords.slice(startIdx, startIdx + pageSize);

    var selectAllChecked = paginatedRecords.length > 0 &&
      paginatedRecords.every(function (r) { return selected.includes(r.id); });
    var selectAllIndeterminate = !selectAllChecked &&
      paginatedRecords.some(function (r) { return selected.includes(r.id); });

    var cards = '';
    if (paginatedRecords.length === 0) {
      cards = '<div class="empty-state"><div class="emoji">✅</div><p>暂无匹配记录</p></div>';
    } else {
      paginatedRecords.forEach(function (r) {
        var lock = claimLocks.find(function (l) { return l.recordId === r.id && l.active; });
        var isLocked = lock && lock.claimant !== deviceName;
        var lockTag = '';
        if (lock) {
          if (lock.claimant === deviceName) {
            lockTag = ' <span class="lock-tag mine">🔒 我已认领</span>';
          } else {
            lockTag = ' <span class="lock-tag">🔒 ' + escapeHtml(lock.claimant) + ' 认领中</span>';
          }
        }
        var isChecked = selected.includes(r.id);
        cards += '<div class="card approval-card' + (isLocked ? ' locked' : '') + '">' +
          '<div class="card-header">' +
          '<label class="select-checkbox">' +
          '<input type="checkbox" class="record-checkbox" data-id="' + r.id + '" ' +
          (isChecked ? 'checked' : '') + (isLocked ? 'disabled' : '') + ' />' +
          '<span></span>' +
          '</label>' +
          '<span class="card-title">' + escapeHtml(r.name) + '</span>' +
          '<span class="status-badge ' + ('status-' + r.status) + '">' +
          (STATUS_MAP[r.status] || r.status) + '</span>' +
          '</div>' +
          '<div class="card-body">' +
          '<p><strong>证件尾号：</strong>' + escapeHtml(r.idTail) + '</p>' +
          '<p><strong>来访部门：</strong>' + escapeHtml(r.department) + '</p>' +
          '<p><strong>有效时段：</strong>' + formatDT(r.validStart) + ' ~ ' + formatDT(r.validEnd) + '</p>' +
          (r.escort ? '<p><strong>陪同人：</strong>' + escapeHtml(r.escort) + '</p>' : '') +
          '<p><strong>入口：</strong>' + escapeHtml(r.entrance) + '</p>' +
          lockTag +
          (r.approver ? '<p><strong>审批人：</strong>' + escapeHtml(r.approver) + '</p>' : '') +
          '</div>' +
          '<div class="card-footer">' +
          (r.status === 'pending_approval' && getRole() === 'approver' && !isLocked
            ? '<button class="small-btn success" data-action="approve" data-id="' + r.id + '">放行</button>' +
              '<button class="small-btn danger" data-action="reject" data-id="' + r.id + '">拒绝</button>'
            : '') +
          (r.status === 'pending_manual' && getRole() && !isLocked
            ? '<button class="small-btn primary" data-action="open-manual" data-id="' + r.id + '">人工处理</button>'
            : '') +
          (isLocked && lock.claimant === deviceName
            ? '<button class="small-btn" data-action="release-single" data-id="' + r.id + '">撤销认领</button>'
            : '') +
          (r.status === 'pending_approval' && !isLocked
            ? '<button class="small-btn" data-action="claim-single" data-id="' + r.id + '">认领</button>'
            : '') +
          '</div>' +
          '</div>';
      });
    }

    var paginationHtml = '';
    if (total > pageSize) {
      paginationHtml = '<div class="pagination">' +
        '<button class="page-btn" data-action="page-prev" ' + (currentPageNum <= 1 ? 'disabled' : '') + '>上一页</button>' +
        '<span class="page-info">第 ' + currentPageNum + ' / ' + totalPages + ' 页，共 ' + total + ' 条</span>' +
        '<button class="page-btn" data-action="page-next" ' + (currentPageNum >= totalPages ? 'disabled' : '') + '>下一页</button>' +
        '</div>';
    }

    var batchBar = '';
    if (getRole() === 'approver') {
      batchBar = '<div class="batch-bar">' +
        '<label class="select-all">' +
        '<input type="checkbox" id="select-all" ' +
        (selectAllChecked ? 'checked' : '') +
        (selectAllIndeterminate ? 'data-indeterminate="true"' : '') + ' />' +
        '<span>全选本页</span>' +
        '</label>' +
        '<span class="selected-count">已选 ' + selected.length + ' 条</span>' +
        '<div class="batch-actions">' +
        '<button class="small-btn primary" data-action="batch-claim" ' + (selected.length === 0 ? 'disabled' : '') + '>批量认领</button>' +
        '<button class="small-btn" data-action="batch-release" ' + (selected.length === 0 ? 'disabled' : '') + '>撤销认领</button>' +
        '<button class="small-btn" data-action="clear-selection" ' + (selected.length === 0 ? 'disabled' : '') + '>清空选择</button>' +
        '</div>' +
        '</div>';
    }

    return '<div class="content">' +
      renderSyncBar() +
      '<div class="section-title">审批管理</div>' +
      '<div class="search-bar">' +
      '<input type="text" class="form-input" id="search-input" placeholder="🔍 搜索姓名/尾号/部门/陪同人" value="' + escapeHtml(searchKeyword) + '" />' +
      '</div>' +
      '<div class="filter-bar">' +
      '<select class="form-select" id="dept-filter" data-action="dept-filter">' + deptOptions + '</select>' +
      '<select class="form-select" id="status-filter" data-action="status-filter">' + statusOptions + '</select>' +
      '<select class="form-select" id="page-size" data-action="page-size">' +
      '<option value="10"' + (pageSize === 10 ? ' selected' : '') + '>10条/页</option>' +
      '<option value="20"' + (pageSize === 20 ? ' selected' : '') + '>20条/页</option>' +
      '<option value="50"' + (pageSize === 50 ? ' selected' : '') + '>50条/页</option>' +
      '</select>' +
      '</div>' +
      batchBar +
      '<div class="stat-grid">' +
      '<div class="stat-card"><div class="stat-num">' + pending.length + '</div><div class="stat-label">待审批</div></div>' +
      '<div class="stat-card warning"><div class="stat-num">' + manual.length + '</div><div class="stat-label">待人工</div></div>' +
      '<div class="stat-card"><div class="stat-num">' + records.filter(function (r) { return r.status === 'approved'; }).length + '</div><div class="stat-label">已放行</div></div>' +
      '<div class="stat-card"><div class="stat-num">' + records.filter(function (r) { return r.status === 'rejected'; }).length + '</div><div class="stat-label">已拒绝</div></div>' +
      '</div>' +
      cards +
      paginationHtml +
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
    var lastExport = getExportResult();
    var exportFields = getExportFields();
    var currentDept = currentDeptFilter || '';
    var currentStatus = currentStatusFilter || '';
    var searchKw = getSearchKeyword();

    var allFields = [
      { key: 'name', label: '姓名' },
      { key: 'idTail', label: '证件尾号' },
      { key: 'department', label: '部门' },
      { key: 'escort', label: '陪同人' },
      { key: 'entrance', label: '入口' },
      { key: 'validStart', label: '开始时间' },
      { key: 'validEnd', label: '结束时间' },
      { key: 'status', label: '状态' },
      { key: 'statusLabel', label: '状态中文' },
      { key: 'approver', label: '审批人' },
      { key: 'approverRole', label: '审批人角色' },
      { key: 'rejectNote', label: '拒绝原因' },
      { key: 'createdAt', label: '创建时间' },
      { key: 'updatedAt', label: '更新时间' },
      { key: 'syncedAt', label: '同步时间' },
      { key: 'sourceDevice', label: '来源设备ID' },
      { key: 'sourceDeviceName', label: '来源设备名' }
    ];

    var fieldCheckboxes = allFields.map(function (f) {
      var checked = !exportFields || exportFields.indexOf(f.key) >= 0;
      return '<label class="field-option">' +
        '<input type="checkbox" class="export-field-checkbox" data-field="' + f.key + '" ' +
        (checked ? 'checked' : '') + ' />' +
        '<span>' + f.label + '</span>' +
        '</label>';
    }).join('');

    var lastExportHtml = '';
    if (lastExport && lastExport.exportedAt) {
      var diff = Date.now() - new Date(lastExport.exportedAt).getTime();
      var label;
      if (diff < 60000) label = '刚刚';
      else if (diff < 3600000) label = Math.floor(diff / 60000) + ' 分钟前';
      else label = formatDT(lastExport.exportedAt);
      var kindLabel = lastExport.filters && lastExport.filters.kind ? (lastExport.filters.kind === 'audit' ? '审计' : lastExport.filters.kind === 'pending' ? '待处理' : '访客') : '';
      var fmtLabel = lastExport.filters && lastExport.filters.format ? lastExport.filters.format.toUpperCase() : '';
      var deptLabel = lastExport.filters && lastExport.filters.department ? '·部门:' + lastExport.filters.department : '';
      var statusLabel = lastExport.filters && lastExport.filters.status ? '·状态:' + (STATUS_MAP[lastExport.filters.status] || lastExport.filters.status) : '';
      lastExportHtml = '<div class="last-export-box">' +
        '<div class="last-export-title">📦 最近导出 <span class="last-export-time">' + label + '</span></div>' +
        '<div class="last-export-detail">' + kindLabel + ' ' + fmtLabel + ' ' + deptLabel + ' ' + statusLabel + '</div>' +
        (lastExport.offlineCount ? '<div class="last-export-detail">共 ' + lastExport.offlineCount + ' 条（离线模式）</div>' : '') +
        '</div>';
    }

    var filterSummary = '<div class="filter-summary">' +
      '<div class="summary-item"><span class="summary-label">当前筛选：</span>' +
      '<span class="summary-value">部门=' + (currentDept || '全部') +
      ' · 状态=' + (currentStatus ? (STATUS_MAP[currentStatus] || currentStatus) : '全部') +
      (searchKw ? ' · 搜索=' + searchKw : '') + '</span></div>' +
      '<div class="summary-item"><span class="summary-label">结果数量：</span>' +
      '<span class="summary-value">' + total + ' 条（导出将应用当前筛选）</span></div>' +
      '</div>';

    return '<div class="content">' +
      '<div class="section-title">数据导出</div>' +
      lastExportHtml +
      '<div class="stat-grid">' +
      '<div class="stat-card"><div class="stat-num">' + total + '</div><div class="stat-label">总记录</div></div>' +
      '<div class="stat-card"><div class="stat-num">' + getQueue().length + '</div><div class="stat-label">待同步</div></div>' +
      '<div class="stat-card warning"><div class="stat-num">' + getPending().filter(function (p) { return p.status !== 'done'; }).length + '</div><div class="stat-label">待人工</div></div>' +
      '<div class="stat-card"><div class="stat-num">' + getAudit().length + '</div><div class="stat-label">审计数</div></div>' +
      '</div>' +
      '<p style="font-size:13px;color:var(--gray-500);margin-bottom:14px;">上次同步: ' + (lastSync ? formatDT(lastSync) : '从未同步') + '</p>' +
      filterSummary +
      '<div class="section-title">导出字段选择（留空=全部）</div>' +
      '<div class="field-selector">' + fieldCheckboxes + '</div>' +
      '<div class="tool-bar">' +
      '<button class="tool-btn" data-action="save-export-fields">💾 保存字段选择</button>' +
      '<button class="tool-btn" data-action="reset-export-fields">↺ 重置为全部</button>' +
      '</div>' +
      '<div class="divider"></div>' +
      '<div class="section-title">访客数据（与审批页筛选对齐）</div>' +
      '<div class="tool-bar">' +
      '<button class="tool-btn" data-action="export-csv">📄 访客 CSV</button>' +
      '<button class="tool-btn" data-action="export-json">📋 访客 JSON</button>' +
      '</div>' +
      '<div class="divider"></div>' +
      '<div class="section-title">待处理中心（仅审批人可导出）</div>' +
      '<div class="tool-bar">' +
      '<button class="tool-btn" data-action="export-pending-csv">📄 待处理 CSV</button>' +
      '<button class="tool-btn" data-action="export-pending-json">📋 待处理 JSON</button>' +
      '</div>' +
      '<div class="divider"></div>' +
      '<div class="section-title">审计日志（仅审批人可导出）</div>' +
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

  function renderHandoverCenter() {
    var sessions = getSessionsCache();
    var pending = getPending();
    var records = getRecords();
    var notes = getHandlerNotes();
    var lastSync = getLastSync();
    var lastExport = getExportResult();
    var notesCount = Object.keys(notes).length;
    var activeNotes = Object.values(notes).filter(function (n) { return n && n.note && n.note.trim(); }).length;

    var pageLabel = {
      register: '访客登记', records: '记录列表', approval: '审批工作台',
      pending: '待处理中心', audit: '审计日志', conflicts: '本机冲突',
      export: '数据导出', handover: '交接恢复中心'
    }[currentPage] || currentPage;

    var searchKw = getSearchKeyword();
    var curPage = getCurrentPage();
    var pageSize = getPageSize();
    var selectedRecords = getSelectedRecords();
    var exportFields = getExportFields();
    var claimLocks = getClaimLocks();
    var activeClaimLocks = claimLocks.filter(function (l) { return l.active; }).length;
    var myClaimLocks = claimLocks.filter(function (l) { return l.active && l.claimant === deviceName; }).length;

    var stateHtml = '<div class="diagnosis-grid" style="margin-bottom:14px;">' +
      '<div class="diag-item"><span class="diag-label">当前页签</span><span class="diag-value">' + escapeHtml(pageLabel) + '</span></div>' +
      '<div class="diag-item"><span class="diag-label">最近同步</span><span class="diag-value">' + (lastSync ? formatDT(lastSync) : '未同步') + '</span></div>' +
      '<div class="diag-item"><span class="diag-label">部门筛选</span><span class="diag-value">' + escapeHtml(currentDeptFilter || '全部') + '</span></div>' +
      '<div class="diag-item"><span class="diag-label">状态筛选</span><span class="diag-value">' + escapeHtml(currentStatusFilter ? (STATUS_MAP[currentStatusFilter] || currentStatusFilter) : '全部') + '</span></div>' +
      '<div class="diag-item"><span class="diag-label">搜索词</span><span class="diag-value">' + (searchKw ? escapeHtml(searchKw) : '无') + '</span></div>' +
      '<div class="diag-item"><span class="diag-label">分页</span><span class="diag-value">第 ' + curPage + ' 页 / ' + pageSize + ' 条/页</span></div>' +
      '<div class="diag-item"><span class="diag-label">已勾选</span><span class="diag-value">' + selectedRecords.length + ' 条</span></div>' +
      '<div class="diag-item"><span class="diag-label">导出字段</span><span class="diag-value">' + (exportFields && exportFields.length > 0 ? exportFields.length + ' 个已选' : '全部字段') + '</span></div>' +
      '<div class="diag-item"><span class="diag-label">待处理队列</span><span class="diag-value">' + pending.filter(function (p) { return p.status !== 'done'; }).length + ' 条</span></div>' +
      '<div class="diag-item"><span class="diag-label">备注草稿</span><span class="diag-value">' + activeNotes + ' 条</span></div>' +
      '<div class="diag-item"><span class="diag-label">认领锁</span><span class="diag-value">' + myClaimLocks + ' 个我认领 / 共 ' + activeClaimLocks + ' 个</span></div>' +
      '<div class="diag-item diag-full"><span class="diag-label">来源设备</span><span class="diag-value">' + escapeHtml(deviceName) + ' (' + deviceId.slice(-8) + ')</span></div>';

    if (lastExport && lastExport.exportedAt) {
      var kindLabel = lastExport.filters && lastExport.filters.kind ? (lastExport.filters.kind === 'audit' ? '审计' : lastExport.filters.kind === 'pending' ? '待处理' : '访客') : '';
      var fmtLabel = lastExport.filters && lastExport.filters.format ? lastExport.filters.format.toUpperCase() : '';
      var exportCount = lastExport.count ? lastExport.count + ' 条' : '';
      stateHtml += '<div class="diag-item diag-full"><span class="diag-label">最近导出</span><span class="diag-value">' +
        escapeHtml(kindLabel + ' ' + fmtLabel + ' ' + exportCount + ' · ' + formatDT(lastExport.exportedAt)) + '</span></div>';
    }
    stateHtml += '</div>';

    var sessionsHtml = '';
    if (sessions.length === 0) {
      sessionsHtml = '<div class="empty-state"><div class="emoji">💾</div><p>暂无服务端会话快照</p><p style="font-size:12px;color:var(--gray-500);margin-top:4px;">点击下方「保存当前会话」创建可恢复快照</p></div>';
    } else {
      sessions.forEach(function (s) {
        var st = s.state || {};
        var ageMs = Date.now() - new Date(s.updatedAt).getTime();
        var ageLabel = ageMs < 60000 ? '刚刚' : ageMs < 3600000 ? Math.floor(ageMs / 60000) + ' 分钟前' : ageMs < 86400000 ? Math.floor(ageMs / 3600000) + ' 小时前' : formatDT(s.updatedAt);
        var sPage = st.currentPage ? ({ register: '登记', records: '记录', approval: '审批', pending: '待处理', audit: '审计', conflicts: '冲突', export: '导出', handover: '交接' }[st.currentPage] || st.currentPage) : '-';
        var sDept = st.currentDeptFilter || '全部';
        var sStatus = st.currentStatusFilter ? (STATUS_MAP[st.currentStatusFilter] || st.currentStatusFilter) : '全部';
        var sSearch = st.searchKeyword || '-';
        var sPageNum = st.currentPageNumber || 1;
        var sPageSize = st.pageSize || 20;
        var sSelected = st.selectedRecords ? st.selectedRecords.length : 0;
        var sExportFields = st.exportFields ? st.exportFields.length + ' 个已选' : '全部';
        var sExport = '';
        if (st.lastExport && st.lastExport.exportedAt) {
          var ek = st.lastExport.filters && st.lastExport.filters.kind;
          var ef = st.lastExport.filters && st.lastExport.filters.format;
          var ec = st.lastExport.count ? st.lastExport.count + ' 条' : '';
          sExport = ' · 最近导出:' + (ek || '') + (ef ? (' ' + ef.toUpperCase()) : '') + (ec ? (' ' + ec) : '');
        }
        sessionsHtml += '<div class="card session-card">' +
          '<div class="card-header">' +
          '<span class="card-title" style="font-size:14px;">💾 会话快照</span>' +
          '<span class="meta-tag">' + escapeHtml(ageLabel) + '</span>' +
          '</div>' +
          '<div class="card-body">' +
          '<p><strong>设备：</strong>' + escapeHtml(s.deviceName || s.deviceId || '-') + '</p>' +
          '<p><strong>页签：</strong>' + escapeHtml(sPage) + ' · <strong>部门：</strong>' + escapeHtml(sDept) + ' · <strong>状态：</strong>' + escapeHtml(sStatus) + '</p>' +
          '<p><strong>搜索：</strong>' + escapeHtml(sSearch) + ' · <strong>分页：</strong>第 ' + sPageNum + ' 页 / ' + sPageSize + ' 条' + '</p>' +
          '<p><strong>已勾选：</strong>' + sSelected + ' 条 · <strong>导出字段：</strong>' + sExportFields + '</p>' +
          '<p><strong>最近同步：</strong>' + (st.lastSync ? formatDT(st.lastSync) : '-') + escapeHtml(sExport) + '</p>' +
          '<p style="font-size:12px;color:var(--gray-500);margin-top:6px;">ID: ' + escapeHtml(s.id.slice(-12)) + '</p>' +
          '</div>' +
          '<div class="card-footer">' +
          '<button class="small-btn primary" data-action="restore-session" data-sid="' + s.id + '">恢复此会话</button>' +
          '<button class="small-btn danger" data-action="delete-session" data-sid="' + s.id + '">删除</button>' +
          '</div>' +
          '</div>';
      });
    }

    return '<div class="content">' +
      renderSyncBar() +
      '<div class="section-title">审批交接与恢复中心</div>' +
      stateHtml +
      '<div class="tool-bar">' +
      '<button class="tool-btn" data-action="save-session-now">💾 保存当前会话</button>' +
      '<button class="tool-btn" data-action="refresh-sessions">🔄 刷新会话列表</button>' +
      '</div>' +
      '<div class="divider"></div>' +
      '<div class="section-title">可恢复会话（服务端持久化）</div>' +
      sessionsHtml +
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
      tabs.push({ key: 'handover', label: '交接' });
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

    if (role) {
      saveContext({
        role: role,
        currentPage: currentPage,
        currentFilter: currentFilter,
        currentDeptFilter: currentDeptFilter,
        currentStatusFilter: currentStatusFilter,
        currentPendingStatusFilter: currentPendingStatusFilter
      });
      triggerAutoSave();
    }

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
        case 'handover':
          body = renderHandoverCenter();
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

    var cachedNote = getHandlerNote(recordId);
    var pendingNote = (p && p.handlerNote) ? p.handlerNote : '';
    var combinedNote = cachedNote || pendingNote;

    var modal = document.createElement('div');
    modal.className = 'modal-backdrop';
    modal.innerHTML = '<div class="modal">' +
      '<div class="modal-title">' + escapeHtml(rec.name) + ' · ' + typeLabel + '</div>' +
      '<div class="diagnosis-grid" style="margin-bottom:12px;">' +
      '<div class="diag-item"><span class="diag-label">最近同步</span><span class="diag-value">' + formatDT((p && p.lastSyncedAt) || rec.syncedAt) + '</span></div>' +
      '<div class="diag-item"><span class="diag-label">来源设备</span><span class="diag-value">' + escapeHtml((p && p.sourceDeviceName) || rec.sourceDeviceName || rec.deviceName || '-') + '</span></div>' +
      '<div class="diag-item"><span class="diag-label">当前处理人</span><span class="diag-value">' + escapeHtml((p && p.currentHandler) || '-') + '</span></div>' +
      '<div class="diag-item diag-full"><span class="diag-label">冲突原因</span><span class="diag-value reason-inline">' + escapeHtml((p && p.conflictReason) || '需人工复核处理') + '</span></div>' +
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
      '<textarea class="form-textarea" id="m-note" rows="3" placeholder="请填写处理说明">' + escapeHtml(combinedNote || '') + '</textarea>' +
      '<div class="field-hint" id="note-saved-hint"></div>' +
      '</div>' +
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

    saveContext({ openManualRecordId: recordId });

    var noteEl = document.getElementById('m-note');
    if (noteEl) {
      var saveTimer = null;
      noteEl.addEventListener('input', function () {
        saveHandlerNote(recordId, this.value);
        var hint = document.getElementById('note-saved-hint');
        if (hint) hint.textContent = '✓ 已自动保存到本地，刷新后可恢复';
        triggerAutoSave();
        clearTimeout(saveTimer);
        saveTimer = setTimeout(function () {
          if (hint) hint.textContent = '';
        }, 2000);
      });
    }
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

  function restoreSessionFromState(state) {
    if (!state) return false;
    if (state.currentPage) currentPage = state.currentPage;
    if (state.currentFilter !== undefined) currentFilter = state.currentFilter;
    if (state.currentDeptFilter !== undefined) currentDeptFilter = state.currentDeptFilter;
    if (state.currentStatusFilter !== undefined) currentStatusFilter = state.currentStatusFilter;
    if (state.currentPendingStatusFilter !== undefined) currentPendingStatusFilter = state.currentPendingStatusFilter;
    if (state.searchKeyword !== undefined) setSearchKeyword(state.searchKeyword);
    if (state.pageNumber) setCurrentPage(state.pageNumber);
    if (state.pageSize) setPageSize(state.pageSize);
    if (state.selectedRecords && Array.isArray(state.selectedRecords)) {
      saveSelectedRecords(state.selectedRecords);
    }
    if (state.exportFields) saveExportFields(state.exportFields);
    if (state.lastSync) setLastSync(state.lastSync);
    if (state.handlerNotes && typeof state.handlerNotes === 'object') {
      saveJSON(HANDLER_NOTES_KEY, state.handlerNotes);
    }
    if (state.lastExport) saveExportResult(state.lastExport);
    if (state.openManualRecordId) {
      saveContext({ openManualRecordId: state.openManualRecordId });
    }
    return true;
  }

  function batchClaimRecords(recordIds, note) {
    if (!isOnline() || getRole() !== 'approver') {
      toast('请保持在线并以审批人身份操作', 'error');
      return Promise.reject();
    }
    var sessions = getSessionsCache();
    var currentSession = sessions.find(s => s.approver === deviceName && s.deviceId === deviceId);
    return fetchJSON('/api/claims/batch?role=approver', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recordIds: recordIds,
        claimant: deviceName,
        claimantRole: 'approver',
        sessionId: currentSession ? currentSession.id : '',
        note: note || ''
      })
    });
  }

  function batchReleaseClaims(recordIds, note) {
    if (!isOnline() || getRole() !== 'approver') {
      toast('请保持在线并以审批人身份操作', 'error');
      return Promise.reject();
    }
    return fetchJSON('/api/claims/release?role=approver', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recordIds: recordIds,
        claimant: deviceName,
        note: note || ''
      })
    });
  }

  function fetchClaimLocksFromServer() {
    if (!isOnline() || getRole() !== 'approver') return Promise.resolve([]);
    return fetchJSON('/api/claims?role=approver&active=true', { method: 'GET' })
      .then(function (res) {
        if (res && res.ok) {
          saveClaimLocks(res.claimLocks || []);
          return res.claimLocks || [];
        }
        return [];
      }).catch(function () { return getClaimLocks(); });
  }

  function restoreSessionFromServer(sessionId) {
    if (!isOnline() || getRole() !== 'approver') return Promise.reject();
    return fetchJSON('/api/sessions/' + sessionId + '/restore?role=approver', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operator: deviceName,
        operatorRole: 'approver'
      })
    });
  }

  var sessionAutoSaveTimer = null;
  function triggerAutoSave() {
    if (getRole() !== 'approver') return;
    if (sessionAutoSaveTimer) clearTimeout(sessionAutoSaveTimer);
    sessionAutoSaveTimer = setTimeout(function () {
      saveSessionToServer().catch(function () {});
    }, 2000);
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
          triggerAutoSave();
          render();
          break;
        case 'nav':
          currentPage = target.getAttribute('data-page');
          if (currentPage === 'records') {
            currentFilter = '';
          }
          if (currentPage === 'approval') {
            if (isOnline()) pullSync().catch(function () {});
          } else if (currentPage === 'audit') {
            if (isOnline()) fetchAuditFromServer().then(render).catch(render);
          } else if (currentPage === 'pending') {
            if (isOnline()) fetchPendingFromServer().then(render).catch(render);
          } else if (currentPage === 'handover') {
            if (isOnline()) fetchSessionsFromServer().then(render).catch(render);
          }
          triggerAutoSave();
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
            saveHandlerNote(mid, '');
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
            saveHandlerNote(mid, '');
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
            saveHandlerNote(mid, '');
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
            saveHandlerNote(mid, '');
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
        case 'export-pending-csv':
          if (getRole() !== 'approver') { toast('仅审批人可导出待处理队列', 'error'); break; }
          exportData('csv', 'pending');
          break;
        case 'export-pending-json':
          if (getRole() !== 'approver') { toast('仅审批人可导出待处理队列', 'error'); break; }
          exportData('json', 'pending');
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
        case 'save-session-now':
          saveSessionToServer().then(function (s) {
            if (s) {
              toast('会话已保存到服务端', 'success');
              return fetchSessionsFromServer();
            } else {
              toast('保存失败，请检查网络', 'error');
            }
          }).then(function () { render(); }).catch(function () { toast('保存失败', 'error'); });
          break;
        case 'refresh-sessions':
          if (isOnline()) {
            fetchSessionsFromServer().then(function () { toast('会话列表已更新', 'success'); render(); }).catch(function () { toast('刷新失败', 'error'); });
          } else { toast('当前离线', 'error'); }
          break;
        case 'restore-session':
          var sid = target.getAttribute('data-sid');
          var sessions = getSessionsCache();
          var sess = sessions.find(function (s) { return s.id === sid; });
          if (!sess) { toast('会话不存在', 'error'); break; }
          if (confirm('确认恢复此会话？\n\n页签、筛选、备注、导出摘要等将全部恢复到当时状态。\n保存时间：' + formatDT(sess.updatedAt))) {
            restoreSessionFromServer(sid).then(function (res) {
              if (res && res.ok) {
                restoreSessionFromState(res.session.state);
                triggerAutoSave();
                toast('会话已恢复，正在刷新数据...', 'success');
                return Promise.all([pullSync(), fetchClaimLocksFromServer()]);
              } else {
                throw new Error('恢复失败');
              }
            }).then(function () {
              render();
            }).catch(function () {
              restoreSessionFromState(sess.state);
              triggerAutoSave();
              render();
            });
          }
          break;
        case 'record-checkbox':
          var recId = target.getAttribute('data-id');
          if (target.disabled) break;
          toggleSelectedRecord(recId);
          triggerAutoSave();
          render();
          break;
        case 'select-all':
          var records = getRecords();
          var searchKw = getSearchKeyword();
          var deptF = currentDeptFilter;
          var statusF = currentStatusFilter;
          var pageNum = getCurrentPage();
          var pSize = getPageSize();
          var filtered = records.filter(function (r) {
            if (statusF) return r.status === statusF;
            return r.status === 'pending_approval' || r.status === 'pending_manual';
          });
          if (deptF) filtered = filtered.filter(function (r) { return r.department === deptF; });
          if (searchKw) {
            var s = searchKw.toLowerCase();
            filtered = filtered.filter(function (r) {
              return (r.name && r.name.toLowerCase().includes(s)) ||
                (r.idTail && r.idTail.toLowerCase().includes(s)) ||
                (r.department && r.department.toLowerCase().includes(s)) ||
                (r.escort && r.escort.toLowerCase().includes(s));
            });
          }
          filtered.sort(function (a, b) {
            return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
          });
          var claimLocks = getClaimLocks();
          filtered = filtered.filter(function (r) {
            var lock = claimLocks.find(function (l) { return l.recordId === r.id && l.active; });
            return !lock || lock.claimant === deviceName;
          });
          var start = (pageNum - 1) * pSize;
          var pageRecords = filtered.slice(start, start + pSize);
          var pageIds = pageRecords.map(function (r) { return r.id; });
          var currentSelected = getSelectedRecords();
          var allSelected = pageIds.length > 0 &&
            pageIds.every(function (id) { return currentSelected.includes(id); });
          var newSelected;
          if (allSelected) {
            newSelected = currentSelected.filter(function (id) { return !pageIds.includes(id); });
          } else {
            newSelected = Array.from(new Set(currentSelected.concat(pageIds)));
          }
          saveSelectedRecords(newSelected);
          triggerAutoSave();
          render();
          break;
        case 'search-input':
          break;
        case 'page-prev':
          var cp = getCurrentPage();
          if (cp > 1) {
            setCurrentPage(cp - 1);
            triggerAutoSave();
            render();
          }
          break;
        case 'page-next':
          var cp2 = getCurrentPage();
          setCurrentPage(cp2 + 1);
          triggerAutoSave();
          render();
          break;
        case 'page-size':
          break;
        case 'batch-claim':
          var selectedIds = getSelectedRecords();
          if (selectedIds.length === 0) { toast('请先选择要认领的记录', 'error'); break; }
          var note = prompt('请输入认领备注（可选）：', '批量认领审批任务');
          if (note === null) break;
          batchClaimRecords(selectedIds, note).then(function (res) {
            if (res && res.ok) {
              if (res.conflicts && res.conflicts.length > 0) {
                var conflictMsgs = res.conflicts.map(function (c) {
                  return '• ' + c.recordId.slice(0, 12) + '... 已被 ' + c.currentClaimant + ' 认领';
                }).join('\n');
                toast('成功认领 ' + res.locked.length + ' 条\n冲突 ' + res.conflicts.length + ' 条：\n' + conflictMsgs, 'error');
              } else {
                toast(res.message || '批量认领成功', 'success');
              }
              clearSelectedRecords();
              return Promise.all([pullSync(), fetchClaimLocksFromServer()]);
            } else {
              throw new Error(res && res.error ? res.error : '认领失败');
            }
          }).then(function () {
            render();
          }).catch(function (e) {
            toast(e.message || '认领失败', 'error');
          });
          break;
        case 'batch-release':
          var selectedIds2 = getSelectedRecords();
          if (selectedIds2.length === 0) { toast('请先选择要撤销的记录', 'error'); break; }
          if (confirm('确认撤销选中 ' + selectedIds2.length + ' 条记录的认领？')) {
            batchReleaseClaims(selectedIds2).then(function (res) {
              if (res && res.ok) {
                toast(res.message || '撤销成功', 'success');
                clearSelectedRecords();
                return Promise.all([pullSync(), fetchClaimLocksFromServer()]);
              } else {
                throw new Error(res && res.error ? res.error : '撤销失败');
              }
            }).then(function () {
              render();
            }).catch(function (e) {
              toast(e.message || '撤销失败', 'error');
            });
          }
          break;
        case 'clear-selection':
          clearSelectedRecords();
          triggerAutoSave();
          render();
          break;
        case 'claim-single':
          var singleId = target.getAttribute('data-id');
          batchClaimRecords([singleId], '单独认领').then(function (res) {
            if (res && res.ok) {
              if (res.conflicts && res.conflicts.length > 0) {
                var c = res.conflicts[0];
                toast('该记录已被 ' + c.currentClaimant + ' 认领', 'error');
              } else {
                toast('认领成功', 'success');
              }
              return Promise.all([pullSync(), fetchClaimLocksFromServer()]);
            }
          }).then(function () {
            render();
          }).catch(function (e) {
            toast(e.message || '认领失败', 'error');
          });
          break;
        case 'release-single':
          var releaseId = target.getAttribute('data-id');
          if (confirm('确认撤销该记录的认领？')) {
            batchReleaseClaims([releaseId]).then(function (res) {
              if (res && res.ok) {
                toast('已撤销认领', 'success');
                return Promise.all([pullSync(), fetchClaimLocksFromServer()]);
              }
            }).then(function () {
              render();
            }).catch(function (e) {
              toast(e.message || '撤销失败', 'error');
            });
          }
          break;
        case 'save-export-fields':
          var checkedFields = [];
          document.querySelectorAll('.export-field-checkbox:checked').forEach(function (cb) {
            checkedFields.push(cb.getAttribute('data-field'));
          });
          if (checkedFields.length === 0) {
            toast('请至少选择一个字段', 'error');
            break;
          }
          saveExportFields(checkedFields);
          triggerAutoSave();
          toast('字段选择已保存', 'success');
          break;
        case 'reset-export-fields':
          saveExportFields(null);
          triggerAutoSave();
          toast('已重置为全部字段', 'success');
          render();
          break;
        case 'delete-session':
          var delSid = target.getAttribute('data-sid');
          if (confirm('确认删除此会话快照？此操作不可恢复。')) {
            deleteSessionFromServer(delSid).then(function (ok) {
              if (ok) {
                toast('已删除', 'success');
                return fetchSessionsFromServer();
              } else {
                toast('删除失败', 'error');
              }
            }).then(function () { render(); }).catch(function () { render(); });
          }
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
        triggerAutoSave();
        render();
      });
    }
    var statusFilter = document.getElementById('status-filter');
    if (statusFilter) {
      statusFilter.addEventListener('change', function () {
        currentStatusFilter = this.value;
        triggerAutoSave();
        render();
      });
    }
    var pendingStatusFilter = document.getElementById('pending-status-filter');
    if (pendingStatusFilter) {
      pendingStatusFilter.addEventListener('change', function () {
        currentPendingStatusFilter = this.value;
        triggerAutoSave();
        render();
      });
    }

    var searchInput = document.getElementById('search-input');
    if (searchInput) {
      var searchTimer = null;
      searchInput.addEventListener('input', function () {
        var self = this;
        clearTimeout(searchTimer);
        searchTimer = setTimeout(function () {
          setSearchKeyword(self.value);
          setCurrentPage(1);
          triggerAutoSave();
          render();
        }, 300);
      });
    }

    var pageSizeSelect = document.getElementById('page-size');
    if (pageSizeSelect) {
      pageSizeSelect.addEventListener('change', function () {
        setPageSize(parseInt(this.value, 10));
        setCurrentPage(1);
        triggerAutoSave();
        render();
      });
    }

    var selectAllCheckbox = document.getElementById('select-all');
    if (selectAllCheckbox) {
      if (selectAllCheckbox.getAttribute('data-indeterminate') === 'true') {
        selectAllCheckbox.indeterminate = true;
      }
    }

    var recordCheckboxes = document.querySelectorAll('.record-checkbox');
    recordCheckboxes.forEach(function (cb) {
      cb.addEventListener('change', function (e) {
        e.stopPropagation();
        var recId = this.getAttribute('data-id');
        if (!this.disabled) {
          toggleSelectedRecord(recId);
          triggerAutoSave();
          render();
        }
      });
    });

    var selectAllEl = document.getElementById('select-all');
    if (selectAllEl) {
      selectAllEl.addEventListener('change', function () {
        var records = getRecords();
        var searchKw = getSearchKeyword();
        var deptF = currentDeptFilter;
        var statusF = currentStatusFilter;
        var pageNum = getCurrentPage();
        var pSize = getPageSize();
        var filtered = records.filter(function (r) {
          if (statusF) return r.status === statusF;
          return r.status === 'pending_approval' || r.status === 'pending_manual';
        });
        if (deptF) filtered = filtered.filter(function (r) { return r.department === deptF; });
        if (searchKw) {
          var s = searchKw.toLowerCase();
          filtered = filtered.filter(function (r) {
            return (r.name && r.name.toLowerCase().includes(s)) ||
              (r.idTail && r.idTail.toLowerCase().includes(s)) ||
              (r.department && r.department.toLowerCase().includes(s)) ||
              (r.escort && r.escort.toLowerCase().includes(s));
          });
        }
        filtered.sort(function (a, b) {
          return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        });
        var claimLocks = getClaimLocks();
        filtered = filtered.filter(function (r) {
          var lock = claimLocks.find(function (l) { return l.recordId === r.id && l.active; });
          return !lock || lock.claimant === deviceName;
        });
        var start = (pageNum - 1) * pSize;
        var pageRecords = filtered.slice(start, start + pSize);
        var pageIds = pageRecords.map(function (r) { return r.id; });
        var currentSelected = getSelectedRecords();
        var newSelected;
        if (this.checked) {
          newSelected = Array.from(new Set(currentSelected.concat(pageIds)));
        } else {
          newSelected = currentSelected.filter(function (id) { return !pageIds.includes(id); });
        }
        saveSelectedRecords(newSelected);
        triggerAutoSave();
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
    var exportFields = getExportFields();
    var filters = {
      format: format,
      kind: kind,
      department: currentDeptFilter || '',
      status: currentStatusFilter || '',
      pendingStatus: currentPendingStatusFilter || '',
      search: getSearchKeyword() || '',
      fields: exportFields
    };
    if (kind === 'audit') {
      query = '/api/audit?format=' + format;
      query += '&role=' + encodeURIComponent(getRole() || 'guard');
      query += '&operator=' + encodeURIComponent(deviceName);
      if (currentDeptFilter) query += '&department=' + encodeURIComponent(currentDeptFilter);
    } else if (kind === 'pending') {
      query = '/api/export/pending?format=' + format;
      query += '&role=' + encodeURIComponent(getRole() || 'guard');
      query += '&operator=' + encodeURIComponent(deviceName);
      if (currentDeptFilter) query += '&department=' + encodeURIComponent(currentDeptFilter);
      if (currentPendingStatusFilter) query += '&status=' + encodeURIComponent(currentPendingStatusFilter);
      if (exportFields && exportFields.length > 0) {
        query += '&fields=' + encodeURIComponent(exportFields.join(','));
      }
    } else {
      query = '/api/export?format=' + format;
      query += '&role=' + encodeURIComponent(getRole() || 'guard');
      query += '&deviceId=' + encodeURIComponent(deviceId);
      query += '&operator=' + encodeURIComponent(deviceName);
      if (currentDeptFilter) query += '&department=' + encodeURIComponent(currentDeptFilter);
      if (currentStatusFilter) query += '&status=' + encodeURIComponent(currentStatusFilter);
      if (getSearchKeyword()) query += '&search=' + encodeURIComponent(getSearchKeyword());
      if (exportFields && exportFields.length > 0) {
        query += '&fields=' + encodeURIComponent(exportFields.join(','));
      }
    }

    if (isOnline()) {
      saveExportResult({
        filters: filters,
        queryUrl: query,
        triggeredAt: nowISO()
      });
      window.open(query, '_blank');
      toast((kind === 'audit' ? '审计' : kind === 'pending' ? '待处理' : '访客') + ' ' + format.toUpperCase() + ' 导出中', 'success');
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
        saveExportResult({ filters: filters, offlineCount: audit.length, triggeredAt: nowISO() });
        toast('审计 ' + format.toUpperCase() + ' 已导出', 'success');
      } else {
        var records = getRecords();
        if (records.length === 0) { toast('无数据可导出', 'error'); return; }
        var filteredExportRecords = records.slice();
        if (currentDeptFilter) filteredExportRecords = filteredExportRecords.filter(function (r) { return r.department === currentDeptFilter; });
        if (currentStatusFilter) filteredExportRecords = filteredExportRecords.filter(function (r) { return r.status === currentStatusFilter; });
        if (format === 'csv') {
          var headers = ['id', 'name', 'idTail', 'department', 'escort', 'entrance', 'validStart', 'validEnd', 'status', 'approver', 'rejectNote', 'createdAt', 'updatedAt', 'syncedAt', 'sourceDevice', 'sourceDeviceName'];
          var csv = [headers.join(',')].concat(
            filteredExportRecords.map(function (r) {
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
          downloadFile(JSON.stringify({ exportedAt: nowISO(), count: filteredExportRecords.length, records: filteredExportRecords }, null, 2),
            'visitors.json', 'application/json');
        }
        saveExportResult({ filters: filters, offlineCount: filteredExportRecords.length, triggeredAt: nowISO() });
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

  (function bootstrap() {
    var role = getRole();
    if (role) {
      var restored = restoreContextFromCache();
      if (restored) {
        var ctx = getContext();
        if (ctx && ctx.savedAt) {
          var diffMs = Date.now() - new Date(ctx.savedAt).getTime();
          if (diffMs < 30 * 60 * 1000) {
            console.log('[上下文已恢复] 保存于 ' + formatDT(ctx.savedAt));
          } else {
            console.log('[上下文已过期（超过30分钟）] 使用默认页面');
            currentPage = role === 'guard' ? 'register' : 'approval';
            currentFilter = '';
            currentDeptFilter = '';
            currentStatusFilter = '';
            currentPendingStatusFilter = '';
          }
        }
      }
    }
    render();
    var ctx = getContext();
    if (ctx && ctx.openManualRecordId && role) {
      setTimeout(function () {
        var rec = getRecords().find(function (r) { return r.id === ctx.openManualRecordId; });
        if (rec && (rec.status === 'pending_manual' || rec.status === 'pending_approval')) {
          if (confirm('检测到您之前正在处理一条记录，是否继续？\n\n备注内容已自动恢复。')) {
            openManualModal(ctx.openManualRecordId);
          } else {
            saveContext({ openManualRecordId: null });
          }
        }
      }, 300);
    }
    if (isOnline() && role) {
      var serverSessionPromise = role === 'approver' ? fetchSessionsFromServer() : Promise.resolve([]);
      var claimLocksPromise = role === 'approver' ? fetchClaimLocksFromServer() : Promise.resolve([]);
      Promise.all([
        fetchVersionsFromServer(),
        pullSync(),
        serverSessionPromise,
        claimLocksPromise
      ]).then(function (results) {
        var v = results[0];
        var sessions = results[2] || [];
        if (v) {
          var conflicts = detectConflicts(v);
          saveLocalVersions({ visitors: v.visitors, pending: v.pending, serverTime: v.serverTime });
          if (conflicts.visitors.length > 0 || conflicts.pending.length > 0) {
            setTimeout(function () { showConflictAlert(conflicts); }, 500);
          }
        }
        if (sessions && sessions.length > 0 && role === 'approver') {
          var newest = sessions[0];
          if (newest && newest.state && newest.updatedAt) {
            var age = Date.now() - new Date(newest.updatedAt).getTime();
            if (age < 60 * 60 * 1000) {
              var stPage = newest.state.currentPage || '审批';
              var stDept = newest.state.currentDeptFilter || '全部';
              var stStatus = newest.state.currentStatusFilter ? (STATUS_MAP[newest.state.currentStatusFilter] || newest.state.currentStatusFilter) : '全部';
              console.log('[服务端会话可用] 更新于 ' + formatDT(newest.updatedAt));
            }
          }
        }
        render();
      }).catch(function () {
        render();
      });
    }
  })();
})();