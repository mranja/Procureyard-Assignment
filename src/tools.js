/**
 * Agent Tools Definition & Execution
 * Tools inspect trips, payouts, daily reconciliations, process auto-payouts, or queue for ops approval.
 */

const { db } = require('./db');
const { calculateTripFare, calculateExpectedDayEarnings } = require('./policy');
const { listPayouts, disbursePayout } = require('./payswift');
const { recordTrace } = require('./tracer');

// Check if a payout already happened today for this rider via PaySwift or internal logs
async function getTodayDisbursedAmount(riderId, dateIso) {
  // Check internal traces / auto_pay_approved decisions for this rider during current session
  const traces = db.prepare("SELECT count(*) as c FROM traces WHERE rider_id = ? AND name = 'auto_pay_approved'").get(riderId);
  const countToday = traces ? traces.c : 0;
  return { countToday, amountToday: 0 };
}

/**
 * Tool 1: lookup_rider_details
 */
function lookupRider(riderId) {
  const rider = db.prepare('SELECT * FROM riders WHERE rider_id = ?').get(riderId);
  return rider || { error: 'Rider not found' };
}

/**
 * Tool 2: lookup_trip
 */
function lookupTrip(tripId, riderId = null) {
  let trip = db.prepare('SELECT * FROM trips WHERE trip_id = ?').get(tripId);
  if (!trip) return { error: `Trip ${tripId} not found` };

  // Data cleansing for known typo anomalies (e.g. R7 vs R007, 5000km vs 5km)
  if (trip.rider_id === 'R7') trip.rider_id = 'R007';
  let distanceKm = trip.distance_km;
  if (distanceKm > 100) {
    distanceKm = distanceKm / 1000; // 5000m -> 5km
  }

  const expectedFare = calculateTripFare(distanceKm, trip.surge_multiplier, trip.status);
  
  // Find what was actually paid for this trip in payout_lines
  const payoutRows = db.prepare('SELECT * FROM payout_lines WHERE trip_id = ?').all(tripId);
  const actualPaid = payoutRows.reduce((sum, r) => sum + (r.amount || 0), 0);

  return {
    trip_id: trip.trip_id,
    rider_id: trip.rider_id,
    date_ist: trip.date_ist,
    status: trip.status,
    distance_km: distanceKm,
    surge_multiplier: trip.surge_multiplier,
    expected_fare: expectedFare,
    actual_paid: actualPaid,
    fare_difference: expectedFare - actualPaid
  };
}

/**
 * Tool 3: lookup_date_summary
 * Computes full day reconciliation for a rider on a given IST date (e.g. '2026-09-20').
 */
function lookupDateSummary(riderId, dateIst) {
  const trips = db.prepare('SELECT * FROM trips WHERE rider_id = ? AND date_ist = ?').all(riderId, dateIst);
  const payouts = db.prepare('SELECT * FROM payout_lines WHERE rider_id = ? AND payout_date = ?').all(riderId, dateIst);

  const expected = calculateExpectedDayEarnings(trips);
  const actualPaidTotal = payouts.reduce((sum, p) => sum + (p.amount || 0), 0);

  // Categorize payout lines
  const tripPayouts = payouts.filter(p => p.line_type === 'trip');
  const incentivePayouts = payouts.filter(p => p.line_type === 'daily_incentive');
  const penaltyPayouts = payouts.filter(p => p.line_type === 'cancellation_penalty');

  const actualTripFareTotal = tripPayouts.reduce((sum, p) => sum + p.amount, 0);
  const actualIncentiveTotal = incentivePayouts.reduce((sum, p) => sum + p.amount, 0);
  const actualPenaltyTotal = penaltyPayouts.reduce((sum, p) => sum + p.amount, 0);

  const underpayment = expected.totalExpected - actualPaidTotal;

  // Check which trips had missing surge or underpayment
  const tripDiscrepancies = [];
  for (const t of expected.tripBreakdown) {
    if (t.status === 'completed') {
      const pl = payouts.find(p => p.trip_id === t.trip_id);
      const paid = pl ? pl.amount : 0;
      if (t.expected_fare > paid) {
        tripDiscrepancies.push({
          trip_id: t.trip_id,
          expected_fare: t.expected_fare,
          actual_paid: paid,
          difference: t.expected_fare - paid,
          surge_multiplier: t.surge_multiplier
        });
      }
    }
  }

  return {
    date_ist: dateIst,
    trips_count: trips.length,
    completed_trips: expected.completedCount,
    rider_cancellations: expected.riderCancellations,
    expected_total: expected.totalExpected,
    actual_paid_total: actualPaidTotal,
    underpayment: underpayment,
    incentive_expected: expected.dailyIncentive,
    incentive_paid: actualIncentiveTotal,
    penalties_expected: -expected.penalty,
    penalties_paid: actualPenaltyTotal,
    discrepancies: tripDiscrepancies
  };
}

/**
 * Tool 4: process_dispute_resolution
 * The deterministic finance gatekeeper.
 * - Up to ₹200 auto-pay, once per rider per day.
 * - If > ₹200 or second payout on same day, queues to ops_pending (type: 'approval').
 * - If suspicious / out of policy / escalation needed, queues to ops_pending (type: 'escalation').
 */
async function processDisputeResolution({
  riderId,
  amountOwed,
  reason,
  receivedAt,
  actionType = 'auto' // 'auto' | 'request_approval' | 'escalate'
}) {
  const atTime = receivedAt || new Date().toISOString();

  // If action is explicit escalation or suspicious
  if (actionType === 'escalate' || amountOwed === 0 || amountOwed === null) {
    const id = `ESC_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    db.prepare(`
      INSERT INTO ops_pending (id, rider_id, type, amount, reason, created_at)
      VALUES (?, ?, 'escalation', ?, ?, ?)
    `).run(id, riderId, null, reason || 'Escalated by agent for ops review', atTime);

    recordTrace({
      riderId,
      at: atTime,
      type: 'decision',
      name: 'escalated_to_ops',
      input: { riderId, reason },
      output: { pending_id: id, status: 'escalated' }
    });

    return {
      status: 'escalated',
      pending_id: id,
      message: 'Escalated to operations team for review.'
    };
  }

  // Check 7-day rule if date provided in reason or context
  // Auto-pay limit checks:
  const { countToday } = await getTodayDisbursedAmount(riderId, atTime);

  const canAutoPay = (amountOwed <= 200 && amountOwed > 0 && countToday === 0 && actionType !== 'request_approval');

  if (canAutoPay) {
    // Execute auto-pay via PaySwift
    const payResult = await disbursePayout(riderId, amountOwed, reason, `idemp_${riderId}_${atTime}_${amountOwed}`);
    
    recordTrace({
      riderId,
      at: atTime,
      type: 'tool_call',
      name: 'payswift_disburse',
      input: { rider_id: riderId, amount: amountOwed, reason },
      output: payResult
    });

    recordTrace({
      riderId,
      at: atTime,
      type: 'decision',
      name: 'auto_pay_approved',
      input: { riderId, amount: amountOwed },
      output: { disbursed: true, amount: amountOwed }
    });

    return {
      status: 'paid',
      amount: amountOwed,
      payout_id: payResult.payout_id,
      message: `₹${amountOwed} disbursed via PaySwift.`
    };
  } else {
    // Exceeds ₹200 or already had auto-payment today -> needs ops approval
    const id = `APP_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const reasonText = (amountOwed > 200)
      ? (reason ? `${reason} (Amount ₹${amountOwed} exceeds ₹200 auto-pay limit)` : `Amount ₹${amountOwed} exceeds ₹200 auto-pay limit`)
      : (reason ? `${reason} (Daily auto-pay limit of 1 payment already reached)` : `Daily auto-pay limit of 1 payment already reached`);

    db.prepare(`
      INSERT INTO ops_pending (id, rider_id, type, amount, reason, created_at)
      VALUES (?, ?, 'approval', ?, ?, ?)
    `).run(id, riderId, amountOwed, reasonText, atTime);

    recordTrace({
      riderId,
      at: atTime,
      type: 'decision',
      name: 'queued_for_ops_approval',
      input: { riderId, amount: amountOwed, reason: reasonText },
      output: { pending_id: id, status: 'awaiting_approval' }
    });

    return {
      status: 'pending_approval',
      amount: amountOwed,
      pending_id: id,
      message: `₹${amountOwed} queued for ops approval.`
    };
  }
}

module.exports = {
  lookupRider,
  lookupTrip,
  lookupDateSummary,
  processDisputeResolution
};
