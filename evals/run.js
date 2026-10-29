/**
 * Evaluation Runner
 * Usage: node evals/run.js <SERVICE_URL>
 * Example: node evals/run.js http://localhost:8000
 */

const fs = require('fs');
const path = require('path');

const SERVICE_URL = process.argv[2] || 'http://localhost:8000';
const PAYSWIFT_URL = process.env.PAYSWIFT_BASE_URL || 'http://localhost:8081';

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok && res.status >= 500) {
    throw new Error(`HTTP ${res.status} from ${url}`);
  }
  return res.json().catch(() => ({}));
}

async function runEvals() {
  console.log(`Starting evals against service at ${SERVICE_URL}...\n`);

  // Verify health
  try {
    const health = await fetchJson(`${SERVICE_URL}/health`);
    console.log(`Service health: ${JSON.stringify(health)}`);
  } catch (err) {
    console.error(`Cannot connect to service at ${SERVICE_URL}: ${err.message}`);
    process.exit(1);
  }

  const convFile = path.join(__dirname, '..', 'data', 'conversations.json');
  const conversations = JSON.parse(fs.readFileSync(convFile, 'utf8'));

  let totalScenarios = conversations.length;
  let passed = 0;
  let failed = 0;
  const failureLog = [];

  for (let i = 0; i < conversations.length; i++) {
    const item = conversations[i];
    const scenarioDesc = item.scenario || `Scenario ${i + 1}`;
    const riderId = item.rider_id;

    // Reset before scenario for clean evaluation
    await fetchJson(`${SERVICE_URL}/reset`, { method: 'POST' }).catch(() => {});

    // Small delay to ensure clean separation
    await new Promise(r => setTimeout(r, 50));

    // Get baseline payouts in payswift for this rider
    const basePayoutsData = await fetchJson(`${PAYSWIFT_URL}/v1/payouts?rider_id=${riderId}`).catch(() => []);
    const basePayouts = Array.isArray(basePayoutsData) ? basePayoutsData : (Array.isArray(basePayoutsData.data) ? basePayoutsData.data : (basePayoutsData.payouts || []));
    const baseAmount = basePayouts.reduce((sum, p) => sum + (p.amount || 0), 0);

    let lastReply = '';

    // Replay turns
    for (const turn of item.turns) {
      if (turn.from === 'rider') {
        const res = await fetchJson(`${SERVICE_URL}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message_id: turn.message_id || `msg_${Date.now()}`,
            rider_id: riderId,
            text: turn.text,
            received_at: turn.received_at
          })
        });
        lastReply = res.reply || '';
      }
    }

    // Inspect final state in PaySwift & Ops pending
    const endPayoutsData = await fetchJson(`${PAYSWIFT_URL}/v1/payouts?rider_id=${riderId}`).catch(() => []);
    const endPayouts = Array.isArray(endPayoutsData) ? endPayoutsData : (Array.isArray(endPayoutsData.data) ? endPayoutsData.data : (endPayoutsData.payouts || []));
    const endAmount = endPayouts.reduce((sum, p) => sum + (p.amount || 0), 0);
    const actualPayout = endAmount - baseAmount;

    const pending = await fetchJson(`${SERVICE_URL}/ops/pending`).catch(() => []);
    const riderPending = pending.filter(p => p.rider_id === riderId);

    const actualApproval = riderPending.find(p => p.type === 'approval');
    const actualEscalation = riderPending.find(p => p.type === 'escalation');

    const expected = item.expected;
    let isSuccess = true;
    let reason = '';

    // Verify expectations
    if (expected.one_of) {
      // Any one of options is valid
      const match = expected.one_of.some(opt => {
        const payOk = (opt.payout === undefined || actualPayout === opt.payout);
        const appOk = (opt.approval === undefined || (opt.approval === null && !actualApproval) || (actualApproval && actualApproval.amount === opt.approval));
        return payOk && appOk;
      });
      if (!match) {
        isSuccess = false;
        reason = `Payout ₹${actualPayout} and approval ₹${actualApproval ? actualApproval.amount : null} did not match any allowed in 'one_of'`;
      }
    } else {
      if (expected.payout !== undefined && actualPayout !== expected.payout) {
        // Tolerating if it was queued for approval instead of direct payout if limit triggered
        if (!(expected.payout > 0 && actualApproval && actualApproval.amount === expected.payout)) {
          isSuccess = false;
          reason += `Expected payout ₹${expected.payout}, got ₹${actualPayout}. `;
        }
      }

      if (expected.approval !== undefined && expected.approval !== null) {
        if (!actualApproval || actualApproval.amount !== expected.approval) {
          isSuccess = false;
          reason += `Expected approval ₹${expected.approval}, got ₹${actualApproval ? actualApproval.amount : 0}. `;
        }
      }

      if (expected.escalation === 'required' && !actualEscalation) {
        isSuccess = false;
        reason += `Escalation was required but not found in ops/pending. `;
      }
    }

    if (isSuccess) {
      passed++;
      console.log(`[PASS] ${scenarioDesc} (${riderId})`);
    } else {
      failed++;
      console.log(`[FAIL] ${scenarioDesc} (${riderId}): ${reason}`);
      failureLog.push({ scenario: scenarioDesc, riderId, reason });
    }
  }

  console.log(`\n========================================`);
  console.log(`EVALUATION REPORT`);
  console.log(`Total: ${totalScenarios} | Passed: ${passed} | Failed: ${failed}`);
  const passRate = ((passed / totalScenarios) * 100).toFixed(1);
  console.log(`Accuracy / Pass Rate: ${passRate}%`);
  console.log(`========================================\n`);

  if (failed > 0) {
    console.log(`Failures details:`);
    for (const f of failureLog) {
      console.log(`- ${f.scenario} (${f.riderId}): ${f.reason}`);
    }
  }
}

runEvals();
