const crypto = require("crypto");

function hashText(text) {
  return crypto
    .createHash("sha256")
    .update(text || "", "utf8")
    .digest("hex");
}

function splitSentences(text) {
  if (!text) return [];
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return [];
  const matches = cleaned.match(/[^.!?]+[.!?]?/g) || [];
  return matches.map((s) => s.trim()).filter(Boolean);
}

function slugify(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function normalizeWhitespace(text) {
  return (text || "").replace(/\s+/g, " ").trim();
}

module.exports = {
  hashText,
  splitSentences,
  slugify,
  normalizeWhitespace,
};
