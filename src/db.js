const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { parse } = require('csv-parse/sync');

const dbPath = process.env.SQLITE_PATH || path.join(__dirname, '..', 'quickdrop.db');
const db = new Database(dbPath);

// Enable WAL mode
db.pragma('journal_mode = WAL');

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS riders (
      rider_id TEXT PRIMARY KEY,
      name TEXT,
      city TEXT,
      joined_on TEXT
    );

    CREATE TABLE IF NOT EXISTS trips (
      trip_id TEXT PRIMARY KEY,
      rider_id TEXT,
      started_at TEXT,
      status TEXT,
      distance_km REAL,
      surge_multiplier REAL,
      date_ist TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_trips_rider_date ON trips(rider_id, date_ist);

    CREATE TABLE IF NOT EXISTS payout_lines (
      line_id TEXT PRIMARY KEY,
      payout_date TEXT,
      rider_id TEXT,
      line_type TEXT,
      trip_id TEXT,
      amount REAL
    );

    CREATE INDEX IF NOT EXISTS idx_payouts_rider_date ON payout_lines(rider_id, payout_date);

    CREATE TABLE IF NOT EXISTS traces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rider_id TEXT NOT NULL,
      at TEXT NOT NULL,
      type TEXT NOT NULL, -- message_in, tool_call, decision, reply, error
      name TEXT,
      input TEXT,
      output TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_traces_rider ON traces(rider_id);

    CREATE TABLE IF NOT EXISTS ops_pending (
      id TEXT PRIMARY KEY,
      rider_id TEXT NOT NULL,
      type TEXT NOT NULL, -- approval, escalation
      amount REAL,
      reason TEXT NOT NULL,
      status TEXT DEFAULT 'pending', -- pending, approved, rejected
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS processed_messages (
      message_id TEXT PRIMARY KEY,
      rider_id TEXT NOT NULL,
      reply TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversation_state (
      rider_id TEXT PRIMARY KEY,
      messages TEXT, -- JSON array of turns
      updated_at TEXT
    );
  `);
}

function loadCSVs(force = false) {
  const count = db.prepare('SELECT count(*) as c FROM riders').get().c;
  if (count > 0 && !force) {
    return;
  }

  console.log('Loading CSV data into SQLite...');
  const dataDir = path.join(__dirname, '..', 'data');

  // Load riders
  const ridersContent = fs.readFileSync(path.join(dataDir, 'riders.csv'), 'utf8');
  const riders = parse(ridersContent, { columns: true, skip_empty_lines: true });
  const insertRider = db.prepare('INSERT OR REPLACE INTO riders (rider_id, name, city, joined_on) VALUES (?, ?, ?, ?)');
  const insertRidersTx = db.transaction((rows) => {
    for (const r of rows) insertRider.run(r.rider_id, r.name, r.city, r.joined_on);
  });
  insertRidersTx(riders);

  // Load trips
  const tripsContent = fs.readFileSync(path.join(dataDir, 'trips.csv'), 'utf8');
  const trips = parse(tripsContent, { columns: true, skip_empty_lines: true });
  const insertTrip = db.prepare(`
    INSERT OR REPLACE INTO trips (trip_id, rider_id, started_at, status, distance_km, surge_multiplier, date_ist)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertTripsTx = db.transaction((rows) => {
    for (const t of rows) {
      // Calculate IST date from started_at ISO
      const d = new Date(t.started_at);
      // IST is UTC + 5:30 = 330 mins
      const istDate = new Date(d.getTime() + (330 * 60 * 1000)).toISOString().split('T')[0];
      insertTrip.run(
        t.trip_id,
        t.rider_id,
        t.started_at,
        t.status,
        parseFloat(t.distance_km || 0),
        parseFloat(t.surge_multiplier || 1.0),
        istDate
      );
    }
  });
  insertTripsTx(trips);

  // Load payout lines
  const payoutsContent = fs.readFileSync(path.join(dataDir, 'payout_lines.csv'), 'utf8');
  const payouts = parse(payoutsContent, { columns: true, skip_empty_lines: true });
  const insertPayout = db.prepare(`
    INSERT OR REPLACE INTO payout_lines (line_id, payout_date, rider_id, line_type, trip_id, amount)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertPayoutsTx = db.transaction((rows) => {
    for (const p of rows) {
      insertPayout.run(
        p.line_id,
        p.payout_date,
        p.rider_id,
        p.line_type,
        p.trip_id || null,
        parseFloat(p.amount || 0)
      );
    }
  });
  insertPayoutsTx(payouts);

  console.log(`Loaded ${riders.length} riders, ${trips.length} trips, ${payouts.length} payout lines.`);
}

function resetDatabase() {
  db.exec(`
    DELETE FROM traces;
    DELETE FROM ops_pending;
    DELETE FROM processed_messages;
    DELETE FROM conversation_state;
  `);
}

module.exports = {
  db,
  initSchema,
  loadCSVs,
  resetDatabase
};
