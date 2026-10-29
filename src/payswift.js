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
    if (Array.isArray(data)) return data;
    if (Array.isArray(data.data)) return data.data;
    if (Array.isArray(data.payouts)) return data.payouts;
    return [];
  } catch (err) {
    console.error('Error connecting to PaySwift:', err.message);
    return [];
  }
}

async function disbursePayout(riderId, amount, reference = '', idempotencyKey = null) {
  const headers = {
    'Content-Type': 'application/json'
  };
  if (idempotencyKey) {
    headers['Idempotency-Key'] = idempotencyKey;
  }

  // PaySwift sandbox has chaos mode enabled (occasional 503 / 429), retry up to 5 times
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
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
      } else if (res.status === 503 || res.status === 429 || res.status >= 500) {
        // Wait 100ms before retrying chaos response
        await new Promise(r => setTimeout(r, 100));
        continue;
      } else {
        return { success: false, status: res.status, error: data.error || 'Payment failed' };
      }
    } catch (err) {
      if (attempt === 5) {
        return { success: false, error: err.message };
      }
      await new Promise(r => setTimeout(r, 100));
    }
  }

  return { success: false, error: 'Max retries exceeded' };
}

module.exports = {
  listPayouts,
  disbursePayout
};
