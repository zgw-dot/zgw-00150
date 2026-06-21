const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = 3000;
const DATA_FILE = path.join(__dirname, 'data', 'visitors.json');

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function ensureDataDir() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ visitors: [], syncLog: [] }, null, 2));
  }
}

function readData() {
  ensureDataDir();
  const raw = fs.readFileSync(DATA_FILE, 'utf-8');
  return JSON.parse(raw || '{"visitors":[],"syncLog":[]}');
}

function writeData(data) {
  ensureDataDir();
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function generateId() {
  return 'v_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex');
}

function hasOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.post('/api/sync/push', (req, res) => {
  try {
    const { records, deviceId, deviceName, forceOverwrite } = req.body;
    const data = readData();
    const results = [];

    for (const rec of records) {
      let status = 'merged';
      let conflict = null;
      const existing = data.visitors.find(v => v.id === rec.id);

      if (existing) {
        if (forceOverwrite) {
          data.visitors = data.visitors.map(v =>
            v.id === rec.id
              ? { ...v, ...rec, syncedAt: new Date().toISOString(), sourceDevice: deviceId, sourceDeviceName: deviceName }
              : v
          );
          status = 'force_updated';
        } else {
          const serverUpdated = new Date(existing.updatedAt || existing.createdAt).getTime();
          const clientUpdated = new Date(rec.updatedAt || rec.createdAt).getTime();

          if (existing.status !== rec.status || existing.approver !== rec.approver || existing.rejectNote !== rec.rejectNote) {
            if (serverUpdated > clientUpdated && existing.status !== 'pending_sync' && rec.status === 'pending_sync') {
              status = 'server_wins';
            } else if (serverUpdated !== clientUpdated) {
              status = 'conflict';
              conflict = { server: existing, client: rec };
            } else {
              data.visitors = data.visitors.map(v =>
                v.id === rec.id
                  ? { ...v, ...rec, syncedAt: new Date().toISOString() }
                  : v
              );
              status = 'updated';
            }
          } else {
            data.visitors = data.visitors.map(v =>
              v.id === rec.id
                ? { ...v, ...rec, syncedAt: new Date().toISOString() }
                : v
            );
            status = 'updated';
          }
        }
      } else {
        const overlap = data.visitors.some(v =>
          v.name === rec.name &&
          v.idTail === rec.idTail &&
          v.status !== 'rejected' &&
          v.status !== 'revoked' &&
          v.status !== 'expired' &&
          hasOverlap(
            new Date(rec.validStart).getTime(),
            new Date(rec.validEnd).getTime(),
            new Date(v.validStart).getTime(),
            new Date(v.validEnd).getTime()
          )
        );

        if (overlap && !forceOverwrite) {
          const conflictingRecord = data.visitors.find(v =>
            v.name === rec.name &&
            v.idTail === rec.idTail &&
            v.status !== 'rejected' &&
            v.status !== 'revoked' &&
            v.status !== 'expired' &&
            hasOverlap(
              new Date(rec.validStart).getTime(),
              new Date(rec.validEnd).getTime(),
              new Date(v.validStart).getTime(),
              new Date(v.validEnd).getTime()
            )
          );
          status = 'overlap_conflict';
          conflict = { reason: '同一访客同一时段已存在登记', server: conflictingRecord };
        } else {
          const toSave = {
            ...rec,
            id: rec.id || generateId(),
            syncedAt: new Date().toISOString(),
            sourceDevice: deviceId,
            sourceDeviceName: deviceName
          };
          data.visitors.push(toSave);
          status = 'created';
        }
      }

      results.push({ id: rec.id, status, conflict });
      data.syncLog.push({
        time: new Date().toISOString(),
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
  const { department, status } = req.query;
  let list = data.visitors;
  if (department) list = list.filter(v => v.department === department);
  if (status) list = list.filter(v => v.status === status);
  res.json({ ok: true, records: list });
});

app.get('/api/visitors/:id', (req, res) => {
  const data = readData();
  const v = data.visitors.find(x => x.id === req.params.id);
  if (!v) return res.status(404).json({ ok: false, error: 'not found' });
  res.json({ ok: true, record: v });
});

app.patch('/api/visitors/:id', (req, res) => {
  try {
    const { status, approver, approverRole, note } = req.body;
    const data = readData();
    const idx = data.visitors.findIndex(x => x.id === req.params.id);
    if (idx < 0) return res.status(404).json({ ok: false, error: 'not found' });

    if (status && ['approved', 'rejected'].includes(status)) {
      if (approverRole === 'guard') {
        return res.status(403).json({ ok: false, error: '保安无审批权限' });
      }
    }

    if (status === 'revoked') {
      const currentStatus = data.visitors[idx].status;
      if (approverRole === 'guard' && currentStatus !== 'pending_sync') {
        return res.status(403).json({ ok: false, error: '保安只能撤销待同步记录' });
      }
    }

    data.visitors[idx] = {
      ...data.visitors[idx],
      ...(status ? { status } : {}),
      ...(approver ? { approver } : {}),
      ...(approverRole ? { approverRole } : {}),
      ...(note ? { rejectNote: note } : {}),
      updatedAt: new Date().toISOString(),
      syncedAt: new Date().toISOString()
    };
    writeData(data);
    res.json({ ok: true, record: data.visitors[idx] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/export', (req, res) => {
  const data = readData();
  const { format = 'json' } = req.query;
  const records = data.visitors;

  if (format === 'csv') {
    const headers = ['id', 'name', 'idTail', 'department', 'escort', 'entrance', 'validStart', 'validEnd', 'status', 'approver', 'rejectNote', 'createdAt', 'updatedAt', 'sourceDevice', 'sourceDeviceName'];
    const csv = [headers.join(',')].concat(
      records.map(r => headers.map(h => {
        let v = r[h] || '';
        if (typeof v === 'string' && (v.includes(',') || v.includes('"') || v.includes('\n'))) {
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
    res.json({ exportedAt: new Date().toISOString(), records });
  }
});

app.get('/api/departments', (req, res) => {
  const data = readData();
  const depts = Array.from(new Set(data.visitors.map(v => v.department).filter(Boolean)));
  const defaults = ['校长办公室', '教务处', '学生处', '后勤处', '保卫处', '计算机学院', '文学院', '理学院', '工学院'];
  res.json({ ok: true, departments: Array.from(new Set([...defaults, ...depts])) });
});

ensureDataDir();
app.listen(PORT, '0.0.0.0', () => {
  console.log(`校园访客通行服务已启动: http://localhost:${PORT}`);
  console.log(`局域网访问: http://<你的IP>:${PORT}`);
});
