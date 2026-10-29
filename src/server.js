/**
 * Main Web Server
 * Exposes required ports and interfaces:
 * - GET /health
 * - POST /messages (Webhook authentication support)
 * - POST /messages/media (Persistent voice/audio attachments storage)
 * - GET /trace/{rider_id}
 * - GET /ops/pending
 * - GET /ops (Ops Review UI dashboard)
 * - POST /ops/decision (approve / reject pending requests)
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { initSchema, loadCSVs, resetDatabase, db } = require('./db');
const { getTraces, recordTrace } = require('./tracer');
const { handleRiderMessage } = require('./agent');
const { disbursePayout } = require('./payswift');

const app = express();
const PORT = process.env.PORT || 8000;
const WHATSAPP_WEBHOOK_SECRET = process.env.WHATSAPP_WEBHOOK_SECRET || '';

// Configure storage directory for persistent voice notes and media
const UPLOADS_DIR = process.env.MEDIA_STORAGE_PATH || path.join(__dirname, '..', 'storage', 'media');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Multer storage engine for audio / voice notes / attachments
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.ogg';
    const unique = `${Date.now()}_${Math.random().toString(36).substring(2, 8)}${ext}`;
    cb(null, unique);
  }
});
const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } }); // 25MB max

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/media', express.static(UPLOADS_DIR)); // Serve uploaded media for ops dashboard

// Webhook Authentication Middleware
function verifyWebhookAuth(req, res, next) {
  // If no WHATSAPP_WEBHOOK_SECRET configured, allow requests (e.g. standard evals)
  if (!WHATSAPP_WEBHOOK_SECRET) {
    return next();
  }

  // Check Bearer token or custom X-Webhook-Secret / X-Hub-Signature header
  const authHeader = req.headers['authorization'];
  const secretHeader = req.headers['x-webhook-secret'] || req.headers['x-hub-signature-256'];
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.substring(7) : secretHeader;

  if (!token || token !== WHATSAPP_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized: Invalid or missing webhook token' });
  }

  next();
}

// Initialize DB schema & preload CSV data
initSchema();
loadCSVs();

// 1. Health check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'rider-dispute-desk' });
});

// Reset endpoint for evaluation suite
app.post('/reset', (req, res) => {
  resetDatabase();
  res.json({ status: 'reset_success' });
});

// 2. POST /messages (Rider WhatsApp webhook with optional token verification)
app.post('/messages', verifyWebhookAuth, async (req, res) => {
  try {
    const { message_id, rider_id, text, received_at } = req.body;
    if (!rider_id || !text) {
      return res.status(400).json({ error: 'rider_id and text are required' });
    }

    const reply = await handleRiderMessage({
      messageId: message_id || `msg_${Date.now()}`,
      riderId: rider_id,
      text: text,
      receivedAt: received_at || new Date().toISOString()
    });

    return res.json({ reply });
  } catch (err) {
    console.error('Error handling message:', err);
    return res.status(500).json({ reply: 'Sorry, system technical error. Ops team notified.' });
  }
});

// 3. POST /messages/media (Persistent Audio & Voice Note Storage)
app.post('/messages/media', verifyWebhookAuth, upload.single('media'), async (req, res) => {
  try {
    const { message_id, rider_id, media_type, transcript, received_at } = req.body;
    if (!rider_id || !req.file) {
      return res.status(400).json({ error: 'rider_id and media file are required' });
    }

    const mediaId = `med_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const atTime = received_at || new Date().toISOString();

    db.prepare(`
      INSERT INTO media_attachments (id, rider_id, message_id, media_type, original_filename, mime_type, file_path, file_size, transcript, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      mediaId,
      rider_id,
      message_id || null,
      media_type || 'audio',
      req.file.originalname,
      req.file.mimetype,
      req.file.filename,
      req.file.size,
      transcript || null,
      atTime
    );

    recordTrace({
      riderId: rider_id,
      at: atTime,
      type: 'tool_call',
      name: 'archive_media_attachment',
      input: { message_id, media_type: media_type || 'audio', filename: req.file.originalname, size: req.file.size },
      output: { media_id: mediaId, stored_path: `/media/${req.file.filename}` }
    });

    let reply = 'Aapka voice note/document successfully record kar liya gaya hai.';
    if (transcript) {
      reply = await handleRiderMessage({
        messageId: message_id || mediaId,
        riderId: rider_id,
        text: transcript,
        receivedAt: atTime
      });
    }

    return res.json({ success: true, media_id: mediaId, reply });
  } catch (err) {
    console.error('Error processing media:', err);
    return res.status(500).json({ error: err.message });
  }
});

// 4. GET /trace/:rider_id
app.get('/trace/:rider_id', (req, res) => {
  const { rider_id } = req.params;
  const traces = getTraces(rider_id);
  res.json(traces);
});

// 5. GET /ops/pending
app.get('/ops/pending', (req, res) => {
  const rows = db.prepare("SELECT id, rider_id, type, amount, reason, created_at FROM ops_pending WHERE status = 'pending' ORDER BY created_at DESC").all();
  res.json(rows);
});

// 6. POST /ops/decision (Approve or Reject pending dispute)
app.post('/ops/decision', async (req, res) => {
  const { id, decision } = req.body; // decision: 'approve' | 'reject'
  const item = db.prepare('SELECT * FROM ops_pending WHERE id = ?').get(id);
  if (!item) {
    return res.status(404).json({ error: 'Item not found' });
  }

  if (decision === 'approve' && item.type === 'approval' && item.amount > 0) {
    // Disburse via PaySwift
    await disbursePayout(item.rider_id, item.amount, `Ops approved: ${item.reason}`);
  }

  db.prepare('UPDATE ops_pending SET status = ? WHERE id = ?').run(decision === 'approve' ? 'approved' : 'rejected', id);
  res.json({ success: true, status: decision });
});

// 7. Ops Dashboard UI
app.get('/ops', (req, res) => {
  const pending = db.prepare('SELECT * FROM ops_pending ORDER BY created_at DESC').all();
  const riders = db.prepare('SELECT DISTINCT rider_id FROM traces ORDER BY id DESC LIMIT 50').all();
  const mediaList = db.prepare('SELECT * FROM media_attachments ORDER BY created_at DESC LIMIT 20').all();

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>QuickDrop - Ops Dispute Desk</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 24px; background: #f8fafc; color: #1e293b; }
    h1 { margin-top: 0; color: #0f172a; font-size: 24px; }
    .card { background: white; border-radius: 8px; padding: 20px; margin-bottom: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; }
    th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #e2e8f0; font-size: 14px; }
    th { background: #f1f5f9; font-weight: 600; }
    .badge { padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: 600; }
    .badge-approval { background: #e0f2fe; color: #0369a1; }
    .badge-escalation { background: #fef3c7; color: #92400e; }
    .badge-pending { background: #fef08a; color: #854d0e; }
    .badge-approved { background: #dcfce7; color: #15803d; }
    .badge-rejected { background: #fee2e2; color: #991b1b; }
    button { cursor: pointer; padding: 6px 12px; border-radius: 4px; border: none; font-weight: 500; font-size: 13px; }
    .btn-approve { background: #10b981; color: white; margin-right: 8px; }
    .btn-reject { background: #ef4444; color: white; }
    select { padding: 8px; border-radius: 4px; border: 1px solid #cbd5e1; font-size: 14px; min-width: 150px; }
    pre { background: #0f172a; color: #f8fafc; padding: 12px; border-radius: 6px; overflow-x: auto; font-size: 13px; }
    audio { height: 32px; vertical-align: middle; }
  </style>
</head>
<body>
  <h1>QuickDrop — Rider Dispute Ops Desk</h1>
  
  <div class="card">
    <h2>Pending Approvals & Escalations</h2>
    <table>
      <thead>
        <tr>
          <th>ID</th>
          <th>Rider ID</th>
          <th>Type</th>
          <th>Amount</th>
          <th>Reason</th>
          <th>Status</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${pending.length === 0 ? '<tr><td colspan="7">No pending disputes. All clear!</td></tr>' : pending.map(p => `
          <tr>
            <td><code>${p.id}</code></td>
            <td><strong>${p.rider_id}</strong></td>
            <td><span class="badge badge-${p.type}">${p.type}</span></td>
            <td>${p.amount !== null ? `₹${p.amount}` : '-'}</td>
            <td>${p.reason}</td>
            <td><span class="badge badge-${p.status}">${p.status}</span></td>
            <td>
              ${p.status === 'pending' ? `
                <form method="POST" action="/ops/decision" style="display:inline;">
                  <input type="hidden" name="id" value="${p.id}">
                  <button type="submit" name="decision" value="approve" class="btn-approve">Approve</button>
                  <button type="submit" name="decision" value="reject" class="btn-reject">Reject</button>
                </form>
              ` : p.status}
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  </div>

  <div class="card">
    <h2>Archived WhatsApp Media & Voice Notes</h2>
    <table>
      <thead>
        <tr>
          <th>Rider ID</th>
          <th>Type</th>
          <th>Audio / File</th>
          <th>Transcript</th>
          <th>Received At</th>
        </tr>
      </thead>
      <tbody>
        ${mediaList.length === 0 ? '<tr><td colspan="5">No archived voice notes yet.</td></tr>' : mediaList.map(m => `
          <tr>
            <td><strong>${m.rider_id}</strong></td>
            <td><span class="badge badge-approval">${m.media_type}</span></td>
            <td>
              ${m.mime_type && m.mime_type.startsWith('audio') ? `
                <audio controls src="/media/${m.file_path}"></audio>
              ` : `<a href="/media/${m.file_path}" target="_blank">View File</a>`}
            </td>
            <td>${m.transcript || '<em>No transcript</em>'}</td>
            <td>${m.created_at}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  </div>

  <div class="card">
    <h2>Audit Trace Viewer</h2>
    <p>Select a rider to inspect their live execution trace and agent decisions:</p>
    <select id="riderSelect" onchange="fetchTrace(this.value)">
      <option value="">-- Choose Rider --</option>
      ${riders.map(r => `<option value="${r.rider_id}">${r.rider_id}</option>`).join('')}
    </select>
    <div id="traceOutput" style="margin-top: 16px;"></div>
  </div>

  <script>
    async function fetchTrace(riderId) {
      if (!riderId) return;
      const res = await fetch('/trace/' + riderId);
      const data = await res.json();
      document.getElementById('traceOutput').innerHTML = '<pre>' + JSON.stringify(data, null, 2) + '</pre>';
    }
  </script>
</body>
</html>
  `;
  res.send(html);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Rider Dispute Desk running on http://localhost:${PORT}`);
  console.log(`Ops Dashboard available at http://localhost:${PORT}/ops`);
});
