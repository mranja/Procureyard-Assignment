/**
 * Policy Calculator & Business Rules Engine
 * 
 * Rules from docs/policy.md:
 * - Every completed trip pays ₹25 base + ₹6 for each km after the first 2 km.
 *   If the trip had a surge multiplier, it applies to the whole trip fare (base + distance).
 *   Round each trip to the nearest rupee, 0.5 rounds up.
 * - Daily incentive of ₹150 for 12 or more trips in a day.
 * - ₹10 penalty for every trip the rider cancels. Customer cancellations earn nothing (₹0).
 * - "Day" means calendar day in IST.
 * - We only look at disputes for the last 7 days.
 */

function calculateTripFare(distanceKm, surgeMultiplier = 1.0, status = 'completed') {
  if (status !== 'completed') {
    return 0;
  }
  const base = 25;
  const extraKm = Math.max(0, distanceKm - 2);
  const distanceFare = extraKm * 6;
  const totalBeforeSurge = base + distanceFare;
  const withSurge = totalBeforeSurge * (surgeMultiplier || 1.0);
  
  // Round to nearest rupee, 0.5 rounds up
  return Math.floor(withSurge + 0.5);
}

function calculateExpectedDayEarnings(tripsOnDate) {
  let tripFares = 0;
  let completedCount = 0;
  let riderCancellations = 0;
  let customerCancellations = 0;

  const tripBreakdown = [];

  for (const t of tripsOnDate) {
    if (t.status === 'completed') {
      completedCount++;
      const fare = calculateTripFare(t.distance_km, t.surge_multiplier, t.status);
      tripFares += fare;
      tripBreakdown.push({
        trip_id: t.trip_id,
        distance_km: t.distance_km,
        surge_multiplier: t.surge_multiplier,
        expected_fare: fare,
        status: t.status
      });
    } else if (t.status === 'cancelled_by_rider') {
      riderCancellations++;
      tripBreakdown.push({
        trip_id: t.trip_id,
        status: t.status,
        penalty: 10
      });
    } else {
      customerCancellations++;
      tripBreakdown.push({
        trip_id: t.trip_id,
        status: t.status,
        penalty: 0
      });
    }
  }

  const dailyIncentive = completedCount >= 12 ? 150 : 0;
  const penalty = riderCancellations * 10;
  const totalExpected = tripFares + dailyIncentive - penalty;

  return {
    completedCount,
    riderCancellations,
    customerCancellations,
    tripFares,
    dailyIncentive,
    penalty,
    totalExpected,
    tripBreakdown
  };
}

module.exports = {
  calculateTripFare,
  calculateExpectedDayEarnings
};
