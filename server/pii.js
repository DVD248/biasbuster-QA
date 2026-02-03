const EMAIL_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE_REGEX = /\b(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)|\d{2,4})[\s.-]?\d{3,4}[\s.-]?\d{3,4}\b/g;
const STUDENT_ID_REGEX = /\b\d{7,12}\b/g;
const ID_LABEL_REGEX = /(student\s*(?:id|number)|id\s*number)\s*[:#]?\s*[A-Za-z0-9-]+/gi;
const NAME_LABEL_REGEX = /\bname\s*[:#]\s*[A-Za-z ,.'-]{2,}/gi;

function redactPII(text) {
  if (!text) return "";
  let redacted = text;
  redacted = redacted.replace(EMAIL_REGEX, "[REDACTED_EMAIL]");
  redacted = redacted.replace(PHONE_REGEX, "[REDACTED_PHONE]");
  redacted = redacted.replace(ID_LABEL_REGEX, (match) => {
    const prefix = match.split(/[:#]/)[0] || "ID";
    return `${prefix}: [REDACTED_ID]`;
  });
  redacted = redacted.replace(NAME_LABEL_REGEX, "Name: [REDACTED_NAME]");
  redacted = redacted.replace(STUDENT_ID_REGEX, "[REDACTED_ID]");
  return redacted;
}

module.exports = {
  redactPII,
};
