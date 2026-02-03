const path = require("path");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");

async function extractTextFromFile(file) {
  if (!file) return "";
  const ext = path.extname(file.originalname || "").toLowerCase();
  const mime = (file.mimetype || "").toLowerCase();

  if (ext === ".pdf" || mime.includes("pdf")) {
    const originalWarn = console.warn;
    const originalStderrWrite = process.stderr.write;
    const originalStdoutWrite = process.stdout.write;
    console.warn = (...args) => {
      if (typeof args[0] === "string" && args[0].startsWith("Warning: TT:")) {
        return;
      }
      originalWarn(...args);
    };
    process.stderr.write = (chunk, encoding, callback) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (text.includes("Warning: TT:")) {
        if (typeof callback === "function") callback();
        return true;
      }
      return originalStderrWrite.call(process.stderr, chunk, encoding, callback);
    };
    process.stdout.write = (chunk, encoding, callback) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (text.includes("Warning: TT:")) {
        if (typeof callback === "function") callback();
        return true;
      }
      return originalStdoutWrite.call(process.stdout, chunk, encoding, callback);
    };
    try {
      const data = await pdfParse(file.buffer);
      return data.text || "";
    } finally {
      console.warn = originalWarn;
      process.stderr.write = originalStderrWrite;
      process.stdout.write = originalStdoutWrite;
    }
  }

  if (
    ext === ".docx" ||
    mime.includes("wordprocessingml") ||
    mime.includes("msword")
  ) {
    const result = await mammoth.extractRawText({ buffer: file.buffer });
    return result.value || "";
  }

  return file.buffer.toString("utf8");
}

module.exports = {
  extractTextFromFile,
};
