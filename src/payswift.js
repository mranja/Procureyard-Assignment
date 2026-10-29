/**
 * PaySwift Client & Reconciliation
 * Connects to PaySwift sandbox at PAYSWIFT_BASE_URL (port 8081).
 */

const PAYSWIFT_BASE_URL = process.env.PAYSWIFT_BASE_URL || 'http://localhost:8081';

async function listPayouts(riderId) {
  try {
    const url = riderId 
      ? `${PAYSWIFT_BASE_URL}/v1/payouts?rider_id=${encodeURIComponent(riderId)}`
      : `${PAYSWIFT_BASE_URL}/v1/payouts`;
    
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`PaySwift listPayouts failed with status ${res.status}`);
      return [];
    }
    const data = await res.json();
    return Array.isArray(data) ? data : (data.payouts || []);
  } catch (err) {
    console.error('Error connecting to PaySwift:', err.message);
    return [];
  }
}

async function disbursePayout(riderId, amount, reference = '', idempotencyKey = null) {
  try {
    const headers = {
      'Content-Type': 'application/json'
    };
    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey;
    }

    const res = await fetch(`${PAYSWIFT_BASE_URL}/v1/payouts`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        rider_id: riderId,
        amount: Math.round(amount),
        reference: reference || `Dispute payout for ${riderId}`
      })
    });

    const data = await res.json().catch(() => ({}));
    if (res.status === 201) {
      return { success: true, payout_id: data.payout_id, status: data.status, amount };
    } else {
      return { success: false, status: res.status, error: data.error || 'Payment failed' };
    }
  } catch (err) {
    console.error('PaySwift disburse error:', err.message);
    return { success: false, error: err.message };
  }
}

module.exports = {
  listPayouts,
  disbursePayout
};
