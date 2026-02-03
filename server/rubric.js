const { slugify } = require("./utils");

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "your",
  "their",
  "they",
  "them",
  "you",
  "are",
  "was",
  "were",
  "has",
  "have",
  "had",
  "not",
  "but",
  "can",
  "could",
  "should",
  "would",
  "will",
  "may",
  "might",
  "more",
  "less",
  "than",
  "about",
  "over",
  "under",
  "between",
  "while",
  "where",
  "when",
  "what",
  "which",
  "who",
  "how",
  "use",
  "using",
  "used",
  "via",
  "within",
  "overall",
  "criteria",
  "criterion",
]);

function cleanLine(line) {
  if (!line) return "";
  return line
    .replace(/^\s*(?:-|\*|•|\d+[\.)])\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseRubric(text) {
  const lines = (text || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const criteria = [];
  lines.forEach((line, index) => {
    let cleaned = cleanLine(line);
    if (cleaned.includes("|")) {
      const cells = cleaned
        .split("|")
        .map((cell) => cell.trim())
        .filter(Boolean);
      if (cells.length > 1) {
        if (/criteria|criterion/i.test(cells[0])) {
          return;
        }
        cleaned = cells[0];
      }
    }
    if (!cleaned) return;

    let title = cleaned;
    let description = "";
    const colonIndex = cleaned.indexOf(":");
    if (colonIndex !== -1 && colonIndex < 80) {
      title = cleaned.slice(0, colonIndex).trim();
      description = cleaned.slice(colonIndex + 1).trim();
    }

    const idBase = slugify(title).slice(0, 24) || `criterion-${index + 1}`;
    const id = `c${index + 1}-${idBase}`;
    criteria.push({ id, title, description });
  });

  if (criteria.length === 0 && text && text.trim()) {
    criteria.push({
      id: "c1-rubric",
      title: text.trim().slice(0, 80),
      description: "",
    });
  }

  return criteria;
}

function parseRubricHierarchy(text) {
  const lines = (text || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim());

  const categories = [];
  let current = null;

  const headerRegex = /^criterion\s*(\d+)\s*[:\-]\s*(.+?)(?:\(([^)]+)\))?$/i;

  lines.forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line) return;

    const headerMatch = line.match(headerRegex);
    if (headerMatch) {
      const title = cleanLine(headerMatch[2] || "") || `Criterion ${headerMatch[1]}`;
      const weight = headerMatch[3] ? headerMatch[3].trim() : "";
      const description = weight ? `Weight: ${weight}` : "";
      const id = `cat-${categories.length + 1}`;
      current = { id, title, description, subcriteria: [] };
      categories.push(current);
      return;
    }

    if (!current) return;
    let cleaned = cleanLine(line);
    if (!cleaned) return;
    if (cleaned.includes("|")) {
      const cells = cleaned
        .split("|")
        .map((cell) => cell.trim())
        .filter(Boolean);
      if (cells.length > 1) {
        if (/criteria|criterion/i.test(cells[0])) {
          return;
        }
        cleaned = cells[0];
      }
    }
    if (!cleaned) return;
    current.subcriteria.push({
      id: `sub-${current.id}-${current.subcriteria.length + 1}`,
      title: cleaned,
      description: "",
    });
  });

  if (categories.length > 0) {
    return { categories, source: "explicit" };
  }

  const flatCriteria = parseRubric(text);
  return {
    categories: flatCriteria.map((criterion, index) => ({
      id: `cat-${index + 1}`,
      title: criterion.title,
      description: criterion.description || "",
      subcriteria: [],
    })),
    source: "flat",
  };
}

function tokenize(text) {
  return (text || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((token) => token.length > 2 && !STOPWORDS.has(token));
}

function extractKeywords(criterion) {
  const tokens = new Set([
    ...tokenize(criterion.title),
    ...tokenize(criterion.description),
  ]);
  return Array.from(tokens);
}

module.exports = {
  parseRubric,
  parseRubricHierarchy,
  extractKeywords,
};
