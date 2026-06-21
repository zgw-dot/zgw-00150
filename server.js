const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = 3000;
const DATA_FILE = path.join(__dirname, 'data', 'visitors.json');

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const STATUS_MAP = {
  pending_sync: '待同步',
  pending_approval: '待审批',
  pending_manual: '待人工处理',
  approved: '已放行',
  rejected: '已拒绝',
  revoked: '已撤销',
  expired: '已过期'
};

function requireApprover(req, res, next) {
  const role = req.query.role || req.headers['x-role'] || (req.body && req.body.operatorRole);
  if (role !== 'approver') {
    return res.status(403).json({ ok: false, error: '该功能仅审批人可访问' });
  }
  next();
}

function hashRecord(rec) {
  const str = JSON.stringify({
    id: rec.id,
    status: rec.status,
    approver: rec.approver,
    updatedAt: rec.updatedAt,
    syncedAt: rec.syncedAt
  });
  return crypto.createHash('sha1').update(str).digest('hex').slice(0, 16);
}

function ensureDataDir() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({
      visitors: [],
      syncLog: [],
      auditLog: [],
      pendingQueue: [],
      approvalSessions: []
    }, null, 2));
  }
}

function readData() {
  ensureDataDir();
  const raw = fs.readFileSync(DATA_FILE, 'utf-8');
  const data = JSON.parse(raw || '{}');
  if (!data.visitors) data.visitors = [];
  if (!data.syncLog) data.syncLog = [];
  if (!data.auditLog) data.auditLog = [];
  if (!data.pendingQueue) data.pendingQueue = [];
  if (!data.approvalSessions) data.approvalSessions = [];
  return data;
}

function writeData(data) {
  ensureDataDir();
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function generateId(prefix) {
  return (prefix || 'id_') + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex');
}

function hasOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

function isValidTimeRange(validStart, validEnd) {
  if (!validStart || !validEnd) return false;
  return new Date(validEnd).getTime() > new Date(validStart).getTime();
}

function addAuditLog(data, entry) {
  data.auditLog.push({
    id: generateId('audit_'),
    time: new Date().toISOString(),
    ...entry
  });
}

function addToPendingQueue(data, record, opts) {
  const now = new Date().toISOString();
  const pendingItem = {
    id: record.id,
    recordId: record.id,
    recordSnapshot: JSON.parse(JSON.stringify(record)),
    conflictType: opts.conflictType || 'unknown',
    conflictReason: opts.conflictReason || '',
    conflictDetail: opts.conflictDetail || null,
    sourceDevice: record.sourceDevice || record.deviceId || '',
    sourceDeviceName: record.sourceDeviceName || record.deviceName || '',
    currentHandler: opts.currentHandler || '',
    handlerNote: '',
    processingHistory: opts.processingHistory || [],
    status: 'pending',
    lastSyncedAt: record.syncedAt || now,
    createdAt: now,
    updatedAt: now
  };
  const existingIdx = data.pendingQueue.findIndex(p => p.recordId === record.id);
  if (existingIdx >= 0) {
    data.pendingQueue[existingIdx] = { ...data.pendingQueue[existingIdx], ...pendingItem, updatedAt: now };
  } else {
    data.pendingQueue.push(pendingItem);
  }
}

function removeFromPendingQueue(data, recordId) {
  data.pendingQueue = data.pendingQueue.filter(p => p.recordId !== recordId);
}

function findDuplicateOverlap(data, rec, excludeId) {
  return data.visitors.find(v => {
    if (v.id === excludeId) return false;
    if (['rejected', 'revoked', 'expired'].includes(v.status)) return false;
    return v.name === rec.name &&
      v.idTail === rec.idTail &&
      hasOverlap(
        new Date(rec.validStart).getTime(),
        new Date(rec.validEnd).getTime(),
        new Date(v.validStart).getTime(),
        new Date(v.validEnd).getTime()
      );
  });
}

function diffRecords(oldR, newR) {
  const changed = [];
  const fields = ['name', 'idTail', 'department', 'escort', 'entrance', 'validStart', 'validEnd', 'approver', 'approverRole', 'status'];
  fields.forEach(f => {
    if ((oldR[f] || '') !== (newR[f] || '')) {
      changed.push({ field: f, old: oldR[f], new: newR[f] });
    }
  });
  return changed;
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.post('/api/sync/push', (req, res) => {
  try {
    const { records, deviceId, deviceName, forceOverwrite, operator, operatorRole } = req.body;
    const data = readData();
    const results = [];
    const now = new Date().toISOString();

    for (const rec of records) {
      let status = 'merged';
      let conflict = null;
      const existing = data.visitors.find(v => v.id === rec.id);
      const operatorName = operator || deviceName;

      if (existing) {
        const newStatus = rec.status === 'pending_sync' ? 'pending_approval' : rec.status;
        const mergedRec = { ...rec, status: newStatus };

        if (!isValidTimeRange(rec.validStart, rec.validEnd)) {
          status = 'invalid_time';
          conflict = { reason: '结束时间必须晚于开始时间' };
          existing.status = 'pending_manual';
          existing.syncedAt = now;
          addToPendingQueue(data, existing, {
            conflictType: 'invalid_time',
            conflictReason: '结束时间必须晚于开始时间',
            currentHandler: ''
          });
          addAuditLog(data, {
            action: 'sync_invalid_time',
            recordId: rec.id,
            operator: operatorName,
            operatorRole: operatorRole || 'guard',
            detail: { deviceId, deviceName },
            note: '时段无效，转入待人工处理'
          });
        } else if (forceOverwrite) {
          data.visitors = data.visitors.map(v =>
            v.id === rec.id
              ? { ...v, ...mergedRec, syncedAt: now, sourceDevice: deviceId, sourceDeviceName: deviceName }
              : v
          );
          removeFromPendingQueue(data, rec.id);
          addAuditLog(data, {
            action: 'sync_force_overwrite',
            recordId: rec.id,
            operator: operatorName,
            operatorRole: operatorRole || 'guard',
            detail: { deviceId, deviceName },
            note: '强制覆盖同步'
          });
          status = 'force_updated';
        } else {
          const serverUpdated = new Date(existing.updatedAt || existing.createdAt).getTime();
          const clientUpdated = new Date(rec.updatedAt || rec.createdAt).getTime();
          const fieldChanges = diffRecords(existing, mergedRec);
          const hasStatusChange = existing.status !== (newStatus);
          const hasApproverChange = (existing.approver || '') !== (rec.approver || '');
          const hasFieldChanges = fieldChanges.some(c => ['name', 'idTail', 'department', 'escort', 'entrance', 'validStart', 'validEnd'].includes(c.field));

          let shouldManual = false;
          let conflictType = '';
          let conflictReason = '';
          let conflictDetail = {};

          if (hasStatusChange && existing.status !== 'pending_sync') {
            shouldManual = true;
            conflictType = 'status_change';
            conflictReason = `状态变更：${STATUS_MAP[existing.status]} → ${STATUS_MAP[newStatus]}`;
            conflictDetail = { oldStatus: existing.status, newStatus };
          } else if (hasApproverChange && existing.approver) {
            shouldManual = true;
            conflictType = 'approver_change';
            conflictReason = `审批人变更：${existing.approver} → ${rec.approver || '（空）'}`;
            conflictDetail = { oldApprover: existing.approver, newApprover: rec.approver };
          } else if (hasFieldChanges && existing.status !== 'pending_sync') {
            shouldManual = true;
            conflictType = 'data_update';
            conflictReason = '资料补录或修改，需人工复核';
            conflictDetail = { changes: fieldChanges };
          }

          if (shouldManual) {
            status = 'pending_manual';
            conflict = {
              reason: conflictReason,
              type: conflictType,
              detail: conflictDetail,
              server: existing,
              client: rec
            };
            const pendingRec = { ...existing, ...mergedRec, status: 'pending_manual' };
            data.visitors = data.visitors.map(v =>
              v.id === rec.id ? { ...v, ...pendingRec, syncedAt: now } : v
            );
            addToPendingQueue(data, pendingRec, {
              conflictType,
              conflictReason,
              conflictDetail,
              sourceDevice: deviceId,
              sourceDeviceName: deviceName,
              processingHistory: [{ time: now, action: 'sync_conflict', detail: conflictReason, by: operatorName }]
            });
            addAuditLog(data, {
              action: 'sync_to_manual',
              recordId: rec.id,
              operator: operatorName,
              operatorRole: operatorRole || 'guard',
              detail: { conflictType, conflictReason, conflictDetail },
              note: '同步检测到变更，转入待人工处理'
            });
          } else if (serverUpdated > clientUpdated && existing.status !== 'pending_sync' && rec.status === 'pending_sync') {
            status = 'server_wins';
          } else {
            data.visitors = data.visitors.map(v =>
              v.id === rec.id
                ? { ...v, ...mergedRec, syncedAt: now }
                : v
            );
            status = 'updated';
            addAuditLog(data, {
              action: 'sync_update',
              recordId: rec.id,
              operator: operatorName,
              operatorRole: operatorRole || 'guard',
              detail: { deviceId, deviceName },
              note: '同步更新记录'
            });
          }
        }
      } else {
        if (!isValidTimeRange(rec.validStart, rec.validEnd)) {
          status = 'invalid_time';
          conflict = { reason: '结束时间必须晚于开始时间' };
          const invalidRec = {
            ...rec,
            id: rec.id || generateId('v_'),
            status: 'pending_manual',
            syncedAt: now,
            sourceDevice: deviceId,
            sourceDeviceName: deviceName,
            createdAt: now,
            updatedAt: now
          };
          data.visitors.push(invalidRec);
          addToPendingQueue(data, invalidRec, {
            conflictType: 'invalid_time',
            conflictReason: '结束时间必须晚于开始时间',
            sourceDevice: deviceId,
            sourceDeviceName: deviceName
          });
          addAuditLog(data, {
            action: 'sync_invalid_new',
            recordId: invalidRec.id,
            operator: operator || deviceName,
            operatorRole: operatorRole || 'guard',
            detail: { deviceId, deviceName },
            note: '新记录时段无效，转入待人工处理'
          });
        } else {
          const overlap = findDuplicateOverlap(data, rec);
          if (overlap && !forceOverwrite) {
            status = 'overlap_conflict';
            conflict = { reason: '同一访客同一时段已存在登记', server: overlap };
            const pendingRec = {
              ...rec,
              id: rec.id || generateId('v_'),
              status: 'pending_manual',
              syncedAt: now,
              sourceDevice: deviceId,
              sourceDeviceName: deviceName,
              createdAt: now,
              updatedAt: now
            };
            data.visitors.push(pendingRec);
            addToPendingQueue(data, pendingRec, {
              conflictType: 'overlap_conflict',
              conflictReason: '同一访客同一时段已存在登记',
              conflictDetail: { existingRecordId: overlap.id },
              sourceDevice: deviceId,
              sourceDeviceName: deviceName
            });
            addAuditLog(data, {
              action: 'sync_overlap_new',
              recordId: pendingRec.id,
              operator: operator || deviceName,
              operatorRole: operatorRole || 'guard',
              detail: { deviceId, deviceName, existingRecordId: overlap.id },
              note: '新记录与现有记录时段重叠，转入待人工处理'
            });
          } else {
            const finalStatus = rec.status === 'pending_sync' ? 'pending_approval' : rec.status;
            const toSave = {
              ...rec,
              id: rec.id || generateId('v_'),
              status: finalStatus,
              syncedAt: now,
              sourceDevice: deviceId,
              sourceDeviceName: deviceName,
              createdAt: now,
              updatedAt: now
            };
            data.visitors.push(toSave);
            status = 'created';
            addAuditLog(data, {
              action: 'sync_create',
              recordId: toSave.id,
              operator: operator || deviceName,
              operatorRole: operatorRole || 'guard',
              detail: { deviceId, deviceName },
              note: '新建访客登记'
            });
          }
        }
      }

      results.push({ id: rec.id, status, conflict });
      data.syncLog.push({
        time: now,
        deviceId,
        deviceName,
        recordId: rec.id,
        action: status
      });
    }

    writeData(data);
    res.json({ ok: true, results });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/sync/pull', (req, res) => {
  try {
    const { since } = req.body;
    const data = readData();
    const sinceTime = since ? new Date(since).getTime() : 0;
    const updated = data.visitors.filter(v =>
      new Date(v.syncedAt || v.updatedAt || v.createdAt).getTime() >= sinceTime
    );
    res.json({ ok: true, records: updated, serverTime: new Date().toISOString() });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/visitors', (req, res) => {
  const data = readData();
  const { department, status, id, name, role, deviceId } = req.query;
  const effectiveRole = role || req.headers['x-role'];
  let list = data.visitors;
  if (effectiveRole === 'guard') {
    list = list.filter(v => ['pending_sync', 'pending_approval', 'approved'].includes(v.status) || v.sourceDevice === deviceId);
  }
  if (department) list = list.filter(v => v.department === department);
  if (status) list = list.filter(v => v.status === status);
  if (id) list = list.filter(v => v.id === id || (v.idTail && v.idTail.includes(id)));
  if (name) list = list.filter(v => v.name && v.name.includes(name));
  list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  res.json({ ok: true, records: list });
});

app.get('/api/visitors/versions', (req, res) => {
  const data = readData();
  const versions = data.visitors.map(v => ({
    id: v.id,
    status: v.status,
    updatedAt: v.updatedAt || v.createdAt,
    syncedAt: v.syncedAt,
    hash: hashRecord(v)
  }));
  const pendingVersions = data.pendingQueue.map(p => ({
    recordId: p.recordId,
    status: p.status,
    currentHandler: p.currentHandler,
    updatedAt: p.updatedAt,
    handlerNote: p.handlerNote
  }));
  res.json({
    ok: true,
    serverTime: new Date().toISOString(),
    visitors: versions,
    pending: pendingVersions,
    auditCount: data.auditLog.length
  });
});

app.get('/api/visitors/:id', (req, res) => {
  const data = readData();
  const v = data.visitors.find(x => x.id === req.params.id);
  if (!v) return res.status(404).json({ ok: false, error: 'not found' });
  const pending = data.pendingQueue.find(p => p.recordId === v.id);
  res.json({ ok: true, record: v, pending: pending || null });
});

app.patch('/api/visitors/:id', (req, res) => {
  try {
    const { status, approver, approverRole, note, operator } = req.body;
    const data = readData();
    const idx = data.visitors.findIndex(x => x.id === req.params.id);
    if (idx < 0) return res.status(404).json({ ok: false, error: 'not found' });

    const rec = data.visitors[idx];
    const operatorName = operator || approver || 'system';

    if (status && ['approved', 'rejected'].includes(status)) {
      if (approverRole === 'guard') {
        addAuditLog(data, {
          action: 'permission_denied',
          recordId: req.params.id,
          operator: operatorName,
          operatorRole: 'guard',
          detail: { attemptedAction: status },
          note: '保安尝试审批被拒'
        });
        writeData(data);
        return res.status(403).json({ ok: false, error: '保安无审批权限' });
      }
      if (rec.status === 'pending_manual') {
        addAuditLog(data, {
          action: 'permission_denied',
          recordId: req.params.id,
          operator: operatorName,
          operatorRole: approverRole || 'unknown',
          detail: { attemptedAction: status },
          note: '尝试审批待人工处理记录被拒'
        });
        writeData(data);
        return res.status(400).json({ ok: false, error: '该记录需先完成人工处理' });
      }
      if (!isValidTimeRange(rec.validStart, rec.validEnd) && status === 'approved') {
        addAuditLog(data, {
          action: 'invalid_approve',
          recordId: req.params.id,
          operator: operatorName,
          operatorRole: approverRole || 'approver',
          note: '时段无效无法放行'
        });
        writeData(data);
        return res.status(400).json({ ok: false, error: '时段无效，无法放行' });
      }
    }

    if (status === 'revoked') {
      const currentStatus = rec.status;
      if (approverRole === 'guard' && currentStatus !== 'pending_sync') {
        addAuditLog(data, {
          action: 'permission_denied',
          recordId: req.params.id,
          operator: operatorName,
          operatorRole: 'guard',
          detail: { currentStatus, attemptedAction: 'revoke' },
          note: '保安越权撤销被拒'
        });
        writeData(data);
        return res.status(403).json({ ok: false, error: '保安只能撤销待同步记录' });
      }
    }

    const oldStatus = rec.status;
    data.visitors[idx] = {
      ...rec,
      ...(status ? { status } : {}),
      ...(approver ? { approver } : {}),
      ...(approverRole ? { approverRole } : {}),
      ...(note && status === 'rejected' ? { rejectNote: note } : {}),
      updatedAt: new Date().toISOString(),
      syncedAt: new Date().toISOString()
    };

    if (status === 'approved' || status === 'rejected') {
      removeFromPendingQueue(data, req.params.id);
    }

    if (status) {
      addAuditLog(data, {
        action: status,
        recordId: req.params.id,
        operator: operatorName,
        operatorRole: approverRole || (status === 'revoked' ? 'guard' : 'approver'),
        detail: { oldStatus, newStatus: status },
        note: note || ''
      });
    }

    writeData(data);
    res.json({ ok: true, record: data.visitors[idx] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/pending', (req, res) => {
  const data = readData();
  const { status, sourceDevice, role, department, conflictType, deviceId } = req.query;
  const effectiveRole = role || req.headers['x-role'];
  let list = data.pendingQueue;
  if (effectiveRole === 'guard') {
    list = list.filter(p => p.sourceDevice === deviceId ||
      ['overlap_conflict', 'invalid_time'].includes(p.conflictType));
  }
  if (status) list = list.filter(p => p.status === status);
  if (sourceDevice) list = list.filter(p => p.sourceDevice === sourceDevice);
  if (conflictType) list = list.filter(p => p.conflictType === conflictType);
  list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const enriched = list.map(p => {
    const record = data.visitors.find(v => v.id === p.recordId);
    const enriched = { ...p, currentRecord: record || null };
    if (record) {
      enriched.recordDepartment = record.department;
      enriched.recordName = record.name;
      enriched.recordIdTail = record.idTail;
    }
    if (department) {
      if (enriched.recordDepartment !== department) return null;
    }
    return enriched;
  }).filter(Boolean);
  res.json({ ok: true, pending: enriched });
});

app.post('/api/pending/:recordId/resolve', (req, res) => {
  try {
    const { action, handler, handlerRole, note, resolutionData } = req.body;
    const data = readData();
    const now = new Date().toISOString();
    const pIdx = data.pendingQueue.findIndex(p => p.recordId === req.params.recordId);
    if (pIdx < 0) return res.status(404).json({ ok: false, error: '待处理记录不存在' });

    const pending = data.pendingQueue[pIdx];
    const rIdx = data.visitors.findIndex(v => v.id === req.params.recordId);
    if (rIdx < 0) return res.status(404).json({ ok: false, error: '访客记录不存在' });

    const record = data.visitors[rIdx];
    const historyEntry = {
      time: now,
      action,
      detail: note || '',
      by: handler || 'system'
    };
    pending.processingHistory = pending.processingHistory || [];
    pending.processingHistory.push(historyEntry);
    pending.updatedAt = now;
    pending.currentHandler = handler || '';
    pending.handlerNote = (pending.handlerNote || '') + (note ? (pending.handlerNote ? '\n' : '') + note : '');

    if (action === 'approve_manual') {
      if (!isValidTimeRange(record.validStart, record.validEnd)) {
        return res.status(400).json({ ok: false, error: '时段无效，无法放行' });
      }
      if (handlerRole !== 'approver') {
        return res.status(403).json({ ok: false, error: '仅审批人可放行' });
      }
      record.status = 'approved';
      record.approver = handler;
      record.approverRole = 'approver';
      record.updatedAt = now;
      record.syncedAt = now;
      data.visitors[rIdx] = record;
      removeFromPendingQueue(data, req.params.recordId);
      addAuditLog(data, {
        action: 'approved',
        recordId: req.params.recordId,
        operator: handler,
        operatorRole: 'approver',
        detail: { source: 'manual_resolution' },
        note: note || '人工处理后放行'
      });
    } else if (action === 'reject_manual') {
      if (handlerRole !== 'approver') {
        return res.status(403).json({ ok: false, error: '仅审批人可驳回' });
      }
      record.status = 'rejected';
      record.approver = handler;
      record.approverRole = 'approver';
      record.rejectNote = note || record.rejectNote || '';
      record.updatedAt = now;
      record.syncedAt = now;
      data.visitors[rIdx] = record;
      removeFromPendingQueue(data, req.params.recordId);
      addAuditLog(data, {
        action: 'rejected',
        recordId: req.params.recordId,
        operator: handler,
        operatorRole: 'approver',
        detail: { source: 'manual_resolution' },
        note: note || '人工处理后驳回'
      });
    } else if (action === 'edit_and_resubmit') {
      if (resolutionData) {
        Object.assign(record, resolutionData);
      }
      record.status = 'pending_approval';
      record.updatedAt = now;
      record.syncedAt = now;
      data.visitors[rIdx] = record;
      pending.conflictType = 'resubmitted';
      pending.conflictReason = (pending.conflictReason || '') + '\n[重新提交] ' + (note || '');
      addAuditLog(data, {
        action: 'manual_resubmit',
        recordId: req.params.recordId,
        operator: handler,
        operatorRole: handlerRole || 'guard',
        detail: { resolutionData: resolutionData || null },
        note: note || '资料修改后重新提交'
      });
      data.pendingQueue[pIdx] = pending;
    } else if (action === 'mark_duplicate') {
      record.status = 'rejected';
      record.rejectNote = (note || '重复登记已标记') + '（重复登记）';
      record.updatedAt = now;
      record.syncedAt = now;
      data.visitors[rIdx] = record;
      removeFromPendingQueue(data, req.params.recordId);
      addAuditLog(data, {
        action: 'mark_duplicate',
        recordId: req.params.recordId,
        operator: handler,
        operatorRole: handlerRole || 'approver',
        detail: resolutionData || {},
        note: note || '标记为重复登记并驳回'
      });
    } else if (action === 'claim') {
      pending.status = 'processing';
      pending.currentHandler = handler;
      data.pendingQueue[pIdx] = pending;
      addAuditLog(data, {
        action: 'pending_claim',
        recordId: req.params.recordId,
        operator: handler,
        operatorRole: handlerRole || 'guard',
        note: note || '认领待处理任务'
      });
    } else if (action === 'release') {
      pending.status = 'pending';
      pending.currentHandler = '';
      data.pendingQueue[pIdx] = pending;
      addAuditLog(data, {
        action: 'pending_release',
        recordId: req.params.recordId,
        operator: handler,
        operatorRole: handlerRole || 'guard',
        note: note || '释放待处理任务'
      });
    } else {
      data.pendingQueue[pIdx] = pending;
      addAuditLog(data, {
        action: 'pending_update',
        recordId: req.params.recordId,
        operator: handler,
        operatorRole: handlerRole || 'guard',
        detail: { action },
        note: note || '更新待处理记录'
      });
    }

    writeData(data);
    const updatedPending = data.pendingQueue.find(p => p.recordId === req.params.recordId);
    res.json({
      ok: true,
      record: data.visitors[rIdx],
      pending: updatedPending || null
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/audit', (req, res) => {
  const data = readData();
  const { recordId, action, operator, since, until, format, role, department, operatorRole } = req.query;
  const effectiveRole = role || req.headers['x-role'];
  if (effectiveRole !== 'approver') {
    return res.status(403).json({ ok: false, error: '审计日志仅审批人可查看' });
  }
  let list = data.auditLog.slice();
  list.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());

  if (recordId) list = list.filter(a => a.recordId === recordId);
  if (action) list = list.filter(a => a.action === action);
  if (operator) list = list.filter(a => a.operator && a.operator.includes(operator));
  if (operatorRole) list = list.filter(a => a.operatorRole === operatorRole);
  if (since) list = list.filter(a => new Date(a.time) >= new Date(since));
  if (until) list = list.filter(a => new Date(a.time) <= new Date(until));
  if (department) {
    const deptRecords = data.visitors.filter(v => v.department === department).map(v => v.id);
    list = list.filter(a => deptRecords.includes(a.recordId));
  }

  if (format === 'csv') {
    const headers = ['id', 'time', 'action', 'recordId', 'operator', 'operatorRole', 'note', 'detail'];
    const csv = [headers.join(',')].concat(
      list.map(r => headers.map(h => {
        let v;
        if (h === 'detail') {
          v = r.detail ? JSON.stringify(r.detail) : '';
        } else {
          v = r[h] || '';
        }
        v = String(v);
        if (v.includes(',') || v.includes('"') || v.includes('\n')) {
          v = '"' + v.replace(/"/g, '""') + '"';
        }
        return v;
      }).join(','))
    ).join('\n');
    res.header('Content-Type', 'text/csv; charset=utf-8');
    res.header('Content-Disposition', 'attachment; filename="audit_log.csv"');
    res.send('\uFEFF' + csv);
    return;
  }

  if (format === 'json') {
    res.header('Content-Type', 'application/json');
    res.header('Content-Disposition', 'attachment; filename="audit_log.json"');
    res.json({ exportedAt: new Date().toISOString(), count: list.length, records: list });
    return;
  }

  res.json({ ok: true, count: list.length, records: list });
});

app.get('/api/export', (req, res) => {
  const data = readData();
  const { format = 'json', department, status, role, deviceId } = req.query;
  const effectiveRole = role || req.headers['x-role'];
  if (effectiveRole === 'guard' && !['pending_sync', 'pending_approval', 'approved', ''].includes(status || '')) {
    return res.status(403).json({ ok: false, error: '保安仅可导出待同步/待审批/已放行记录' });
  }
  let records = data.visitors.slice();
  if (effectiveRole === 'guard') {
    records = records.filter(v => v.sourceDevice === deviceId ||
      ['pending_sync', 'pending_approval', 'approved'].includes(v.status));
  }
  if (department) records = records.filter(v => v.department === department);
  if (status) records = records.filter(v => v.status === status);
  records.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  if (format === 'csv') {
    const headers = ['id', 'name', 'idTail', 'department', 'escort', 'entrance', 'validStart', 'validEnd', 'status', 'statusLabel', 'approver', 'approverRole', 'rejectNote', 'createdAt', 'updatedAt', 'syncedAt', 'sourceDevice', 'sourceDeviceName'];
    const csv = [headers.join(',')].concat(
      records.map(r => headers.map(h => {
        let v;
        if (h === 'statusLabel') {
          v = STATUS_MAP[r.status] || r.status;
        } else if (h === 'sourceDevice') {
          v = r.sourceDevice || r.deviceId || '';
        } else if (h === 'sourceDeviceName') {
          v = r.sourceDeviceName || r.deviceName || '';
        } else {
          v = r[h] || '';
        }
        v = String(v);
        if (v.includes(',') || v.includes('"') || v.includes('\n')) {
          v = '"' + v.replace(/"/g, '""') + '"';
        }
        return v;
      }).join(','))
    ).join('\n');
    res.header('Content-Type', 'text/csv; charset=utf-8');
    res.header('Content-Disposition', 'attachment; filename="visitors.csv"');
    res.send('\uFEFF' + csv);
  } else {
    res.header('Content-Type', 'application/json');
    res.header('Content-Disposition', 'attachment; filename="visitors.json"');
    const exported = records.map(r => ({
      ...r,
      statusLabel: STATUS_MAP[r.status] || r.status,
      sourceDevice: r.sourceDevice || r.deviceId || '',
      sourceDeviceName: r.sourceDeviceName || r.deviceName || ''
    }));
    res.json({ exportedAt: new Date().toISOString(), count: exported.length, records: exported });
  }
});

app.get('/api/export/pending', (req, res) => {
  const data = readData();
  const { format = 'json', department, conflictType, sourceDevice, role } = req.query;
  const effectiveRole = role || req.headers['x-role'];
  if (effectiveRole !== 'approver') {
    return res.status(403).json({ ok: false, error: '待处理中心导出仅审批人可访问' });
  }
  let list = data.pendingQueue.slice();
  if (conflictType) list = list.filter(p => p.conflictType === conflictType);
  if (sourceDevice) list = list.filter(p => p.sourceDevice === sourceDevice);
  if (department) {
    const deptRecordIds = data.visitors.filter(v => v.department === department).map(v => v.id);
    list = list.filter(p => deptRecordIds.includes(p.recordId));
  }
  list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const enriched = list.map(p => {
    const record = data.visitors.find(v => v.id === p.recordId);
    return {
      ...p,
      recordName: record ? record.name : '',
      recordIdTail: record ? record.idTail : '',
      recordDepartment: record ? record.department : '',
      recordStatus: record ? record.status : '',
      conflictTypeLabel: {
        overlap_conflict: '时段重叠',
        invalid_time: '时段无效',
        status_change: '状态变更冲突',
        approver_change: '审批人变更',
        data_update: '资料修改需复核',
        unknown: '未知冲突',
        resubmitted: '重新提交待审批'
      }[p.conflictType] || p.conflictType
    };
  });

  if (format === 'csv') {
    const headers = ['recordId', 'recordName', 'recordIdTail', 'recordDepartment', 'conflictType', 'conflictTypeLabel', 'conflictReason', 'sourceDevice', 'sourceDeviceName', 'currentHandler', 'status', 'handlerNote', 'lastSyncedAt', 'createdAt', 'updatedAt'];
    const csv = [headers.join(',')].concat(
      enriched.map(p => headers.map(h => {
        let v = String(p[h] || '');
        if (v.includes(',') || v.includes('"') || v.includes('\n')) {
          v = '"' + v.replace(/"/g, '""') + '"';
        }
        return v;
      }).join(','))
    ).join('\n');
    res.header('Content-Type', 'text/csv; charset=utf-8');
    res.header('Content-Disposition', 'attachment; filename="pending_queue.csv"');
    res.send('\uFEFF' + csv);
  } else {
    res.header('Content-Type', 'application/json');
    res.header('Content-Disposition', 'attachment; filename="pending_queue.json"');
    res.json({ exportedAt: new Date().toISOString(), count: enriched.length, records: enriched });
  }
});

app.post('/api/sessions', requireApprover, (req, res) => {
  try {
    const data = readData();
    const { deviceId, deviceName, approver, approverRole, state } = req.body;
    if (!approver) {
      return res.status(400).json({ ok: false, error: '审批人信息必填' });
    }
    if (!state) {
      return res.status(400).json({ ok: false, error: '会话状态必填' });
    }
    const now = new Date().toISOString();
    const sessionId = generateId('sess_');
    const session = {
      id: sessionId,
      deviceId: deviceId || '',
      deviceName: deviceName || '',
      approver: approver,
      approverRole: approverRole || 'approver',
      state: state,
      createdAt: now,
      updatedAt: now
    };

    const existingIdx = data.approvalSessions.findIndex(s =>
      s.approver === approver && s.deviceId === (deviceId || '')
    );
    if (existingIdx >= 0) {
      session.id = data.approvalSessions[existingIdx].id;
      session.createdAt = data.approvalSessions[existingIdx].createdAt;
      data.approvalSessions[existingIdx] = session;
    } else {
      data.approvalSessions.push(session);
    }

    addAuditLog(data, {
      action: 'session_save',
      operator: approver,
      operatorRole: approverRole || 'approver',
      detail: { deviceId, deviceName, sessionId: session.id },
      note: '保存审批会话快照'
    });

    writeData(data);
    res.json({ ok: true, session });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/sessions', requireApprover, (req, res) => {
  try {
    const data = readData();
    const { approver, deviceId } = req.query;
    let list = data.approvalSessions.slice();
    if (approver) list = list.filter(s => s.approver === approver);
    if (deviceId) list = list.filter(s => s.deviceId === deviceId);
    list.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    res.json({ ok: true, sessions: list });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/sessions/:id', requireApprover, (req, res) => {
  try {
    const data = readData();
    const session = data.approvalSessions.find(s => s.id === req.params.id);
    if (!session) return res.status(404).json({ ok: false, error: '会话不存在' });
    res.json({ ok: true, session });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.delete('/api/sessions/:id', requireApprover, (req, res) => {
  try {
    const data = readData();
    const idx = data.approvalSessions.findIndex(s => s.id === req.params.id);
    if (idx < 0) return res.status(404).json({ ok: false, error: '会话不存在' });
    const removed = data.approvalSessions[idx];
    data.approvalSessions.splice(idx, 1);
    addAuditLog(data, {
      action: 'session_delete',
      operator: req.query.approver || removed.approver,
      operatorRole: 'approver',
      detail: { sessionId: req.params.id },
      note: '删除审批会话'
    });
    writeData(data);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/departments', (req, res) => {
  const data = readData();
  const depts = Array.from(new Set(data.visitors.map(v => v.department).filter(Boolean)));
  const defaults = ['校长办公室', '教务处', '学生处', '后勤处', '保卫处', '计算机学院', '文学院', '理学院', '工学院'];
  res.json({ ok: true, departments: Array.from(new Set([...defaults, ...depts])) });
});

app.get('/api/stats', (req, res) => {
  const data = readData();
  const now = Date.now();
  const stats = {
    total: data.visitors.length,
    byStatus: {},
    pendingCount: data.pendingQueue.length,
    auditCount: data.auditLog.length,
    todayCount: 0,
    approvedToday: 0
  };
  Object.keys(STATUS_MAP).forEach(k => { stats.byStatus[k] = 0; });
  data.visitors.forEach(v => {
    stats.byStatus[v.status] = (stats.byStatus[v.status] || 0) + 1;
    const created = new Date(v.createdAt).getTime();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    if (created >= todayStart.getTime()) {
      stats.todayCount++;
      if (v.status === 'approved') stats.approvedToday++;
    }
  });
  res.json({ ok: true, stats });
});

ensureDataDir();
app.listen(PORT, '0.0.0.0', () => {
  console.log(`校园访客通行服务已启动: http://localhost:${PORT}`);
  console.log(`局域网访问: http://<你的IP>:${PORT}`);
});
