/**
 * Audit Trace Recorder
 * GET /trace/{rider_id} returns an ordered list of steps.
 * Step shape:
 * {"at": "<ISO time>", "type": "message_in"|"tool_call"|"decision"|"reply"|"error", "name": "<name>", "input": {...}, "output": {...}}
 */

const { db } = require('./db');

function recordTrace({ riderId, at = null, type, name = '', input = null, output = null }) {
  const atTime = at || new Date().toISOString();
  const inputStr = input !== null && input !== undefined ? (typeof input === 'string' ? input : JSON.stringify(input)) : null;
  const outputStr = output !== null && output !== undefined ? (typeof output === 'string' ? output : JSON.stringify(output)) : null;

  db.prepare(`
    INSERT INTO traces (rider_id, at, type, name, input, output)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(riderId, atTime, type, name, inputStr, outputStr);
}

function getTraces(riderId) {
  const rows = db.prepare('SELECT at, type, name, input, output FROM traces WHERE rider_id = ? ORDER BY id ASC').all(riderId);
  return rows.map(r => {
    let parsedInput = null;
    let parsedOutput = null;

    if (r.input) {
      try { parsedInput = JSON.parse(r.input); } catch { parsedInput = r.input; }
    }
    if (r.output) {
      try { parsedOutput = JSON.parse(r.output); } catch { parsedOutput = r.output; }
    }

    return {
      at: r.at,
      type: r.type,
      name: r.name,
      input: parsedInput,
      output: parsedOutput
    };
  });
}

module.exports = {
  recordTrace,
  getTraces
};
