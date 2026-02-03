const fs = require("fs");
const path = require("path");

const AUDIT_PATH = path.join(__dirname, "..", "data", "audit_log.jsonl");

function writeEvent(event) {
  const payload = {
    timestamp: new Date().toISOString(),
    ...event,
  };
  fs.appendFileSync(AUDIT_PATH, `${JSON.stringify(payload)}\n`);
}

module.exports = {
  writeEvent,
};
