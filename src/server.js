/**
 * Main Web Server
 * Exposes required ports and interfaces:
 * - GET /health
 * - POST /messages
 * - GET /trace/{rider_id}
 * - GET /ops/pending
 * - GET /ops (Ops Review UI dashboard)
 * - POST /ops/decision (approve / reject pending requests)
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { initSchema, loadCSVs, resetDatabase, db } = require('./db');
const { getTraces } = require('./tracer');
const { handleRiderMessage } = require('./agent');
const { disbursePayout } = require('./payswift');

const app = express();
const PORT = process.env.PORT || 8000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

// 2. POST /messages (Rider WhatsApp webhook)
app.post('/messages', async (req, res) => {
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

// 3. GET /trace/:rider_id
app.get('/trace/:rider_id', (req, res) => {
  const { rider_id } = req.params;
  const traces = getTraces(rider_id);
  res.json(traces);
});

// 4. GET /ops/pending
app.get('/ops/pending', (req, res) => {
  const rows = db.prepare("SELECT id, rider_id, type, amount, reason, created_at FROM ops_pending WHERE status = 'pending' ORDER BY created_at DESC").all();
  res.json(rows);
});

// 5. POST /ops/decision (Approve or Reject pending dispute)
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

// 6. Ops Dashboard UI
app.get('/ops', (req, res) => {
  const pending = db.prepare('SELECT * FROM ops_pending ORDER BY created_at DESC').all();
  const riders = db.prepare('SELECT DISTINCT rider_id FROM traces ORDER BY id DESC LIMIT 50').all();

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
