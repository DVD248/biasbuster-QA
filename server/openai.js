const OPENAI_URL = "https://api.openai.com/v1/responses";
const DEFAULT_MODEL = "gpt-5-mini";
const { parseRubricHierarchy, extractKeywords } = require("./rubric");

const ISSUE_ENUM = ["vagueness", "missing_action", "not_rubric_linked"];
const COVERAGE_ENUM = ["addressed", "partial", "missing"];

function clampText(text, maxLength) {
  const normalized = (text || "").trim();
  if (normalized.length <= maxLength) return normalized;
  return normalized.slice(0, maxLength).trim() + "…";
}

function buildSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["rubric", "category_reviews", "improved_feedback_draft", "checklist_summary"],
    properties: {
      checklist_summary: { type: "string" },
      improved_feedback_draft: { type: "string" },
      rubric: {
        type: "object",
        additionalProperties: false,
        required: ["categories"],
        properties: {
          categories: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "title", "description", "subcriteria"],
              properties: {
                id: { type: "string" },
                title: { type: "string" },
                description: { type: "string" },
                subcriteria: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["id", "title", "description"],
                    properties: {
                      id: { type: "string" },
                      title: { type: "string" },
                      description: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      category_reviews: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "category_id",
            "coverage_status",
            "subcriteria_reviews",
            "marker_feedback_assessment",
            "issues",
            "linked_feedback_snippets",
            "ai_feedback",
          ],
          properties: {
            category_id: { type: "string" },
            coverage_status: { type: "string", enum: COVERAGE_ENUM },
            subcriteria_reviews: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["subcriterion_id", "coverage_status"],
                properties: {
                  subcriterion_id: { type: "string" },
                  coverage_status: { type: "string", enum: COVERAGE_ENUM },
                },
              },
            },
            marker_feedback_assessment: { type: "string" },
            issues: {
              type: "array",
              items: { type: "string", enum: ISSUE_ENUM },
            },
            linked_feedback_snippets: {
              type: "array",
              items: { type: "string" },
            },
            ai_feedback: {
              type: "object",
              additionalProperties: false,
              required: ["text", "rationale", "evidence_quote"],
              properties: {
                text: { type: "string" },
                rationale: { type: "string" },
                evidence_quote: { type: "string" },
              },
            },
          },
        },
      },
    },
  };
}

function buildFastSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["checklist_summary", "category_reviews"],
    properties: {
      checklist_summary: { type: "string" },
      category_reviews: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "category_id",
            "coverage_status",
            "issues",
            "marker_feedback_assessment",
            "ai_feedback",
          ],
          properties: {
            category_id: { type: "string" },
            coverage_status: { type: "string", enum: COVERAGE_ENUM },
            issues: {
              type: "array",
              items: { type: "string", enum: ISSUE_ENUM },
            },
            marker_feedback_assessment: { type: "string" },
            ai_feedback: {
              type: "object",
              additionalProperties: false,
              required: ["text", "evidence_quote"],
              properties: {
                text: { type: "string" },
                evidence_quote: { type: "string" },
              },
            },
          },
        },
      },
    },
  };
}

function buildInstructions(extraInstructions) {
  const base = [
    "You are an assistant that evaluates the quality of feedback for university markers.",
    "Do not assign grades or predict grades.",
    "Do not provide numeric scores or marks of any kind.",
    "Return only JSON that matches the provided schema.",
    "If a rubric structure JSON is provided, use it exactly (ids, titles, subcriteria) and do not add or remove categories.",
    "If no rubric structure is provided, infer 4-7 high-level categories and 2-6 subcriteria each based on the rubric text.",
    "If the rubric includes explicit Criterion headings, preserve those headings as the category titles and do not merge them.",
    "Use short, stable IDs for categories and subcriteria (e.g., 'cat-1', 'cat-2', 'sub-1').",
    "Keep category and subcriteria descriptions short (<= 120 characters) or empty when not needed.",
    "Coverage status: use 'addressed' only if the draft feedback is specific, evidence-linked, and includes an actionable improvement step for the category. If the draft feedback is vague or lacks action, use 'partial'. If the category is not mentioned, use 'missing'.",
    "For each category, provide subcriteria_reviews for every subcriterion_id with its own coverage_status.",
    "Issues: use 'not_rubric_linked' if missing, 'vagueness' for unclear or generic feedback, and 'missing_action' when improvement steps are absent.",
    "Linked feedback snippets: extract 1-3 short snippets from the marker's draft feedback that show why you marked it addressed or partial. If none, return an empty array.",
    "Marker_feedback_assessment: one sentence describing why the current draft feedback is sufficient or insufficient for this category.",
    "AI feedback: write 3-5 sentences that the marker could paste directly into final feedback. It must be specific, actionable, tied to the rubric, and written in a supportive professional tone. Avoid meta phrasing like 'add' or 'provide feedback'.",
    "Write the AI feedback as two short paragraphs: first paragraph = what is working + evidence; second paragraph = improvement + how to improve + why it matters.",
    "Name concrete methods, sections, or variables from the submission when available; if not available, describe the exact missing element needed.",
    "Keep it professional, student-facing, and ready to paste without edits.",
    "If coverage is missing or partial, include: what is missing, why it matters for the criterion, and one concrete improvement step. Reference the student's submission directly.",
    "Where possible, align the AI feedback with the marker's existing draft tone and avoid contradicting linked feedback snippets.",
    "Avoid repeating generic sentences across categories. Each category should reference different evidence or aspects of the submission.",
    "You will receive evidence candidates grouped by category. Use those quotes and paragraph tags like [P3] when writing feedback.",
    "Evidence quote: if evidence is enabled, include a short 2-3 line excerpt from the submission (max 320 chars) that supports the AI feedback. If you cannot find evidence, return an empty string and set coverage_status to 'missing' with issues including 'not_rubric_linked'.",
    "Each category_review.category_id must match a rubric.categories[].id.",
    "Checklist summary: write a short sentence summarizing overall coverage (e.g., '3/5 categories clearly addressed; 1 partial, 1 missing.').",
    "Improved_feedback_draft should combine the marker's draft feedback with the AI category feedback into a clean, ready-to-send draft in <= 900 characters.",
  ];

  if (extraInstructions) {
    const extras = Array.isArray(extraInstructions)
      ? extraInstructions
      : [extraInstructions];
    extras
      .map((item) => (item || "").trim())
      .filter(Boolean)
      .forEach((item) => base.push(item));
  }

  return base.join(" ");
}

function buildFastInstructions(extraInstructions) {
  const base = [
    "You are an assistant that evaluates feedback quality for university markers.",
    "Do not assign grades or predict grades.",
    "Return only JSON that matches the provided schema.",
    "Use the provided rubric structure JSON exactly for category_id values.",
    "You will receive evidence candidates grouped by category. Use those quotes and paragraph tags like [P3].",
    "Coverage status: use 'addressed' only if the draft feedback is specific, evidence-linked, and includes an actionable improvement step for the category. If vague or missing action, use 'partial'. If not mentioned, use 'missing'.",
    "Issues: use 'not_rubric_linked' if missing, 'vagueness' for unclear or generic feedback, and 'missing_action' when improvement steps are absent.",
    "Marker_feedback_assessment: one sentence describing why the current draft feedback is sufficient or insufficient for this category.",
    "AI feedback: write 1 compact sentence (max 32 words) that includes what is working, evidence, and the next improvement step.",
    "If evidence is missing for a category, leave evidence_quote empty and set coverage_status to 'missing' with issues including 'not_rubric_linked'.",
  ];

  if (extraInstructions) {
    const extras = Array.isArray(extraInstructions)
      ? extraInstructions
      : [extraInstructions];
    extras
      .map((item) => (item || "").trim())
      .filter(Boolean)
      .forEach((item) => base.push(item));
  }

  return base.join(" ");
}

function buildTextFastInstructions(extraInstructions) {
  const base = [
    "You are an assistant that drafts student-ready feedback for university markers.",
    "Do not assign grades or predict grades.",
    "Use the provided rubric structure JSON exactly for category ids.",
    "You will receive evidence candidates grouped by category. Use those quotes and paragraph tags like [P3] when possible.",
    "Output format (plain text): one line per category in the form 'cat-1: <sentence>'.",
    "Each sentence must include: what is working, evidence (if available), and one improvement action.",
    "Keep each line under 28 words. No extra commentary.",
  ];

  if (extraInstructions) {
    const extras = Array.isArray(extraInstructions)
      ? extraInstructions
      : [extraInstructions];
    extras
      .map((item) => (item || "").trim())
      .filter(Boolean)
      .forEach((item) => base.push(item));
  }

  return base.join(" ");
}

function buildTextQualityInstructions(extraInstructions) {
  const base = [
    "You are an assistant that evaluates feedback quality for university markers.",
    "Do not assign grades or predict grades.",
    "Use the provided rubric structure JSON exactly for category ids and titles.",
    "You may receive a submission digest derived from the full submission plus evidence candidates by category.",
    "Use the evidence candidates first; consult the digest only when it is present and needed for context.",
    "Output format (plain text) for each category block:",
    "[cat-id] Category Title",
    "Coverage: addressed|partial|missing",
    "Issues: comma-separated list from [vagueness, missing_action, not_rubric_linked] or 'none'",
    "MarkerAssessment: one short sentence describing sufficiency of the draft feedback for this category.",
    "Feedback:",
    "4-5 sentences total (single paragraph): what is working + evidence, then improvement + how to improve + why it matters.",
    "Keep the Feedback paragraph under 90 words.",
    "Evidence: \"short quote\" [P#] (optional, omit if not available).",
    "End each category block with a line containing only ---",
    "Use specific, student-facing wording; avoid meta phrases like 'add' or 'provide feedback'.",
    "Do not embed evidence quotes inside the Feedback paragraphs; keep them only on the Evidence line.",
    "If evidence candidates are provided for a category, choose one and include it verbatim in the Evidence line.",
    "Avoid placeholder/template phrasing (e.g., 'Clarify X', 'Add a short example'). Write direct, student-ready feedback.",
    "Your feedback should be detailed enough that if the marker pastes it into their draft, the scan would mark the category addressed.",
    "Mention at least one subcriterion phrase from the rubric for each category.",
    "Include the category title phrase verbatim at least once in each feedback block.",
  ];

  if (extraInstructions) {
    const extras = Array.isArray(extraInstructions)
      ? extraInstructions
      : [extraInstructions];
    extras
      .map((item) => (item || "").trim())
      .filter(Boolean)
      .forEach((item) => base.push(item));
  }

  return base.join(" ");
}

function buildCategorySchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["coverage_status", "issues", "marker_feedback_assessment", "ai_feedback"],
    properties: {
      coverage_status: { type: "string", enum: COVERAGE_ENUM },
      issues: {
        type: "array",
        items: { type: "string", enum: ISSUE_ENUM },
      },
      marker_feedback_assessment: { type: "string" },
      ai_feedback: {
        type: "object",
        additionalProperties: false,
        required: ["text", "evidence_quote"],
        properties: {
          text: { type: "string" },
          evidence_quote: { type: "string" },
        },
      },
    },
  };
}

function buildCategoryInstructions(extraInstructions) {
  const base = [
    "You are an assistant that drafts student-ready feedback for university markers.",
    "Do not assign grades or predict grades.",
    "Output format (plain text):",
    "Coverage: addressed|partial|missing",
    "Issues: comma-separated list from [vagueness, missing_action, not_rubric_linked] or 'none'",
    "Assessment: one short sentence on the draft feedback sufficiency.",
    "Feedback: 4-5 sentences (single paragraph), under 90 words.",
    "Evidence: \"short quote\" [P#] (optional, omit if not available).",
    "Feedback must be written directly to the student about their report; do not mention the draft, marker, rubric, or assessment process.",
    "Do not include evidence quotes inside the Feedback text; keep quotes only on the Evidence line.",
    "Coverage status: use 'addressed' only if the draft feedback is specific, evidence-linked, and includes an actionable improvement step. If vague or missing action, use 'partial'. If not mentioned, use 'missing'.",
    "Issues: use 'not_rubric_linked' if missing, 'vagueness' for unclear or generic feedback, and 'missing_action' when improvement steps are absent.",
    "Marker_feedback_assessment: one short sentence describing why the current draft feedback is sufficient or insufficient for this category.",
    "AI feedback: include what is working + evidence, then improvement + how to improve + why it matters.",
    "Include the category title phrase verbatim at least once and mention at least one subcriterion phrase.",
    "If evidence candidates are provided, include one verbatim in evidence_quote; do not invent evidence.",
    "If evidence is weak or unrelated, say so explicitly and state what evidence or analysis should be added.",
    "Do not start the feedback with template verbs like 'Clarify' or 'Add'.",
    "Avoid placeholder/template phrasing like 'Clarify X'. Write direct, student-ready feedback.",
    "Do not refer to 'comments' or 'remarks'; address the student directly about their report.",
  ];

  if (extraInstructions) {
    const extras = Array.isArray(extraInstructions)
      ? extraInstructions
      : [extraInstructions];
    extras
      .map((item) => (item || "").trim())
      .filter(Boolean)
      .forEach((item) => base.push(item));
  }

  return base.join(" ");
}

function isLowQualityFeedback(text) {
  const normalized = (text || "").toLowerCase();
  if (!normalized) return true;
  if (normalized.length < 140) return true;
  const badPhrases = [
    "clarify",
    "add a short",
    "explicit improvement step",
    "provide feedback",
    "specific example",
    "draft feedback",
    "marker",
    "rubric",
  ];
  return badPhrases.some((phrase) => normalized.includes(phrase));
}

function parseCategoryOutput(text) {
  const lines = (text || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  let coverage = "missing";
  let issues = [];
  let assessment = "";
  let feedbackLines = [];
  let evidence = "";
  let inFeedback = false;

  lines.forEach((line) => {
    if (/^coverage:/i.test(line)) {
      coverage = line.split(":").slice(1).join(":").trim().toLowerCase();
      inFeedback = false;
      return;
    }
    if (/^issues:/i.test(line)) {
      const raw = line.split(":").slice(1).join(":").trim();
      issues =
        !raw || raw.toLowerCase() === "none"
          ? []
          : raw.split(",").map((item) => item.trim()).filter(Boolean);
      inFeedback = false;
      return;
    }
    if (/^assessment:/i.test(line)) {
      assessment = line.split(":").slice(1).join(":").trim();
      inFeedback = false;
      return;
    }
    if (/^feedback:/i.test(line)) {
      inFeedback = true;
      const rest = line.split(":").slice(1).join(":").trim();
      if (rest) feedbackLines.push(rest);
      return;
    }
    if (/^evidence:/i.test(line)) {
      evidence = line.split(":").slice(1).join(":").trim();
      inFeedback = false;
      return;
    }
    if (inFeedback) {
      feedbackLines.push(line);
    }
  });

  const feedback = feedbackLines.join(" ").replace(/\s+/g, " ").trim();

  return {
    coverage_status: COVERAGE_ENUM.includes(coverage) ? coverage : "missing",
    issues,
    marker_feedback_assessment: assessment,
    ai_feedback: {
      text: feedback,
      evidence_quote: evidence,
    },
  };
}

const SPEED_CONFIG = {
  maxSubmissionChars: 200000,
  maxParagraphs: 40,
  maxParagraphLength: 300,
  maxDigestParagraphs: 40,
  maxDigestSentenceLength: 180,
  maxOutputTokens: 2400,
};

const STOPWORDS = new Set([
  "about",
  "above",
  "across",
  "after",
  "again",
  "against",
  "all",
  "also",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "because",
  "been",
  "before",
  "being",
  "below",
  "between",
  "both",
  "but",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "doing",
  "down",
  "during",
  "each",
  "few",
  "for",
  "from",
  "further",
  "had",
  "has",
  "have",
  "having",
  "how",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "just",
  "more",
  "most",
  "no",
  "not",
  "of",
  "on",
  "once",
  "only",
  "or",
  "other",
  "our",
  "out",
  "over",
  "own",
  "same",
  "should",
  "so",
  "some",
  "such",
  "than",
  "that",
  "the",
  "their",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "through",
  "to",
  "too",
  "under",
  "until",
  "up",
  "very",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "who",
  "why",
  "will",
  "with",
  "within",
  "without",
  "you",
  "your",
]);

const PRIORITY_TERMS = [
  "figure",
  "table",
  "recommendation",
  "options",
  "conclusion",
  "abstract",
  "introduction",
  "limitations",
  "assumptions",
];

function extractKeywordsFromRubric(rubricText) {
  const text = (rubricText || "").toLowerCase();
  if (!text) return [];
  const words = text
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 4 && !STOPWORDS.has(word));

  const counts = new Map();
  words.forEach((word) => {
    counts.set(word, (counts.get(word) || 0) + 1);
  });

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 24)
    .map(([word]) => word);
}

function scoreParagraph(text, keywords) {
  if (!text || !keywords.length) return 0;
  const lower = text.toLowerCase();
  let score = 0;
  keywords.forEach((keyword) => {
    if (lower.includes(keyword)) score += 1;
  });
  return score;
}

function getParagraphs(submissionText) {
  return (submissionText || "")
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n/)
    .map((para) => para.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function buildEvidenceMap(submissionText, rubricText, config) {
  const paragraphs = getParagraphs(submissionText);
  if (!paragraphs.length) return "(none)";

  const rubricStructure = parseRubricHierarchy(rubricText || "");
  const categories = rubricStructure?.categories || [];
  if (!categories.length) return "(none)";

  const maxPerCategory = config?.maxEvidencePerCategory || 2;
  const maxExcerpt = config?.maxParagraphLength || 220;
  const priorityHits = new Set();
  paragraphs.forEach((para, index) => {
    const lower = para.toLowerCase();
    if (PRIORITY_TERMS.some((term) => lower.includes(term))) {
      priorityHits.add(index);
    }
  });

  const evidenceLines = [];
  categories.forEach((category) => {
    const categoryKeywords = new Set(extractKeywords(category));
    (category.subcriteria || []).forEach((sub) => {
      extractKeywords(sub).forEach((keyword) => categoryKeywords.add(keyword));
    });
    const keywords = Array.from(categoryKeywords);

    const scored = paragraphs.map((para, index) => ({
      index,
      para,
      score: scoreParagraph(para, keywords),
      priority: priorityHits.has(index),
    }));

    const top = scored
      .filter((item) => item.score > 0 || item.priority)
      .sort((a, b) => {
        if (b.priority !== a.priority) return b.priority - a.priority;
        return b.score - a.score;
      })
      .slice(0, maxPerCategory);

    const fallback = scored.slice(0, maxPerCategory);
    const selected = top.length ? top : fallback;

    evidenceLines.push(`[${category.id}] ${category.title}:`);
    selected.forEach((item) => {
      const trimmed =
        item.para.length > maxExcerpt
          ? `${item.para.slice(0, maxExcerpt).trim()}…`
          : item.para;
      evidenceLines.push(`- [P${item.index + 1}] ${trimmed}`);
    });
  });

  return evidenceLines.join("\n");
}

function buildEvidenceByCategory(submissionText, rubricText, rubricStructure, config) {
  const paragraphs = getParagraphs(submissionText);
  if (!paragraphs.length) return new Map();

  const structure =
    rubricStructure && rubricStructure.categories?.length
      ? rubricStructure
      : parseRubricHierarchy(rubricText || "");
  const categories = structure?.categories || [];
  if (!categories.length) return new Map();

  const maxPerCategory = config?.maxEvidencePerCategory || 1;
  const maxExcerpt = config?.maxParagraphLength || 200;
  const priorityHits = new Set();
  paragraphs.forEach((para, index) => {
    const lower = para.toLowerCase();
    if (PRIORITY_TERMS.some((term) => lower.includes(term))) {
      priorityHits.add(index);
    }
  });

  const byCategory = new Map();

  categories.forEach((category) => {
    const categoryKeywords = new Set(extractKeywords(category));
    (category.subcriteria || []).forEach((sub) => {
      extractKeywords(sub).forEach((keyword) => categoryKeywords.add(keyword));
    });
    const keywords = Array.from(categoryKeywords);

    const scored = paragraphs.map((para, index) => ({
      index,
      para,
      score: scoreParagraph(para, keywords),
      priority: priorityHits.has(index),
    }));

    const top = scored
      .filter((item) => item.score > 0 || item.priority)
      .sort((a, b) => {
        if (b.priority !== a.priority) return b.priority - a.priority;
        return b.score - a.score;
      })
      .slice(0, maxPerCategory);

    const fallback = scored.slice(0, maxPerCategory);
    const selected = top.length ? top : fallback;

    const quotes = selected.map((item) => {
      const trimmed =
        item.para.length > maxExcerpt
          ? `${item.para.slice(0, maxExcerpt).trim()}…`
          : item.para;
      return `[P${item.index + 1}] ${trimmed}`;
    });

    byCategory.set(category.id, quotes);
  });

  return byCategory;
}

function buildSubmissionMap(submissionText, config, rubricText) {
  const text = (submissionText || "").trim();
  if (!text) return "(none)";

  const maxParagraphs = config?.maxParagraphs || 40;
  const maxParagraphLength = config?.maxParagraphLength || 280;
  const keywords = extractKeywordsFromRubric(rubricText);

  const paragraphs = text
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n/)
    .map((para) => para.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const scored = paragraphs.map((para, index) => {
    const score = scoreParagraph(para, keywords);
    const lower = para.toLowerCase();
    const priorityHit = PRIORITY_TERMS.some((term) => lower.includes(term));
    return { index, para, score, priorityHit };
  });

  const keep = new Set();
  const firstCount = Math.min(2, scored.length);
  const lastCount = Math.min(2, scored.length);
  for (let i = 0; i < firstCount; i += 1) keep.add(scored[i].index);
  for (let i = 0; i < lastCount; i += 1) {
    keep.add(scored[scored.length - 1 - i].index);
  }

  scored
    .filter((item) => item.priorityHit)
    .forEach((item) => keep.add(item.index));

  const ranked = scored
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxParagraphs);

  ranked.forEach((item) => keep.add(item.index));

  const selected = scored
    .filter((item) => keep.has(item.index))
    .sort((a, b) => a.index - b.index)
    .slice(0, maxParagraphs);

  const fallback = paragraphs
    .slice(0, maxParagraphs)
    .map((para, index) => ({ para, index }));

  const chosen = selected.length ? selected : fallback;

  const limited = chosen.map((item, localIndex) => {
    const para = item.para;
    const trimmed =
      para.length > maxParagraphLength
        ? `${para.slice(0, maxParagraphLength).trim()}…`
        : para;
    const originalIndex = item.index ?? localIndex;
    return `[P${originalIndex + 1}] ${trimmed}`;
  });

  return limited.join("\n");
}

function buildSubmissionDigest(submissionText, config) {
  const paragraphs = getParagraphs(submissionText);
  if (!paragraphs.length) return "(none)";
  const maxParagraphs = config?.maxDigestParagraphs || 40;
  const maxSentenceLength = config?.maxDigestSentenceLength || 180;

  const digest = paragraphs.slice(0, maxParagraphs).map((para, index) => {
    const sentences = para.split(/(?<=[.!?])\s+/).filter(Boolean);
    const first = sentences[0] || para;
    const last = sentences.length > 1 ? sentences[sentences.length - 1] : "";
    const combined = last && last !== first ? `${first} ${last}` : first;
    const trimmed =
      combined.length > maxSentenceLength
        ? `${combined.slice(0, maxSentenceLength).trim()}…`
        : combined;
    return `[P${index + 1}] ${trimmed}`;
  });

  return digest.join("\n");
}

function buildUserInput({
  rubricText,
  submissionText,
  feedbackText,
  evidenceEnabled,
  rubricStructure,
  speedConfig,
}) {
  const hasStructure = Boolean(rubricStructure && rubricStructure.categories?.length);
  const rubricJson = hasStructure
    ? `\n\nRubric structure (JSON):\n${JSON.stringify(rubricStructure)}`
    : "";
  const rubricExcerpt = hasStructure
    ? "(omitted - structure provided)"
    : clampText(rubricText, 8000);
  const evidenceMap = evidenceEnabled
    ? buildEvidenceMap(submissionText, rubricText, speedConfig)
    : "(evidence disabled)";
  const submissionDigest = speedConfig?.omitDigest
    ? "(omitted - evidence map only)"
    : buildSubmissionMap(submissionText, speedConfig, rubricText);

  return [
    hasStructure ? "Rubric excerpt (structure provided):" : "Rubric (raw text):",
    rubricExcerpt || "(none)",
    rubricJson,
    "",
    "Submission digest (80/20 selection from full submission):",
    submissionDigest,
    "",
    "Evidence candidates (by category):",
    evidenceMap,
    "",
    "Draft feedback:",
    feedbackText || "(none)",
    "",
    `Evidence enabled: ${evidenceEnabled ? "yes" : "no"}.`,
  ].join("\n");
}

function extractOutputText(responseJson) {
  if (!responseJson) return "";

  if (typeof responseJson.output_text === "string" && responseJson.output_text.trim()) {
    return responseJson.output_text.trim();
  }

  if (typeof responseJson.output === "string" && responseJson.output.trim()) {
    return responseJson.output.trim();
  }

  if (responseJson.output && Array.isArray(responseJson.output.content)) {
    responseJson = { output: [responseJson.output] };
  }

  if (!Array.isArray(responseJson.output)) return "";
  let text = "";
  responseJson.output.forEach((item) => {
    if (!item || !Array.isArray(item.content)) return;
    item.content.forEach((contentItem) => {
      if (contentItem.type === "output_json" && contentItem.json) {
        text += JSON.stringify(contentItem.json);
      } else if (contentItem.type === "output_json" && contentItem.delta) {
        text += contentItem.delta;
      } else if (contentItem.type === "output_text" && contentItem.text) {
        text += contentItem.text;
      } else if (contentItem.type === "text" && contentItem.text) {
        text += contentItem.text;
      } else if (contentItem.type === "refusal" && contentItem.refusal) {
        text += contentItem.refusal;
      }
    });
  });
  return text.trim();
}

async function streamInChunks(text, onDelta, options = {}) {
  if (!text || typeof onDelta !== "function") return;
  const chunkSize = options.chunkSize || 160;
  const delayMs = options.delayMs || 12;
  for (let i = 0; i < text.length; i += chunkSize) {
    onDelta(text.slice(i, i + chunkSize));
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

function sanitizeAnalysis(result) {
  if (!result || !result.rubric || !Array.isArray(result.rubric.categories)) {
    return null;
  }

  const categories = result.rubric.categories.map((category, index) => ({
    id: (category.id || `cat-${index + 1}`).toString(),
    title: (category.title || "").toString(),
    description: (category.description || "").toString(),
    subcriteria: Array.isArray(category.subcriteria)
      ? category.subcriteria.map((sub, subIndex) => ({
          id: (sub.id || `sub-${index + 1}-${subIndex + 1}`).toString(),
          title: (sub.title || "").toString(),
          description: (sub.description || "").toString(),
        }))
      : [],
  }));

  const reviews = Array.isArray(result.category_reviews)
    ? result.category_reviews.map((review) => ({
        category_id: (review.category_id || "").toString(),
        coverage_status: COVERAGE_ENUM.includes(review.coverage_status)
          ? review.coverage_status
          : "missing",
        subcriteria_reviews: Array.isArray(review.subcriteria_reviews)
          ? review.subcriteria_reviews.map((sub) => ({
              subcriterion_id: (sub.subcriterion_id || "").toString(),
              coverage_status: COVERAGE_ENUM.includes(sub.coverage_status)
                ? sub.coverage_status
                : "missing",
            }))
          : [],
        issues: Array.isArray(review.issues)
          ? review.issues.filter((issue) => ISSUE_ENUM.includes(issue))
          : [],
        linked_feedback_snippets: Array.isArray(review.linked_feedback_snippets)
          ? review.linked_feedback_snippets
              .map((snippet) => (snippet || "").trim())
              .filter(Boolean)
          : [],
        marker_feedback_assessment: (review.marker_feedback_assessment || "").trim(),
        ai_feedback: {
          text: (review.ai_feedback?.text || "").trim(),
          rationale: (review.ai_feedback?.rationale || "").trim(),
          evidence_quote: clampText(review.ai_feedback?.evidence_quote || "", 320),
        },
      }))
    : [];

  return {
    checklist_summary: (result.checklist_summary || "").toString(),
    improved_feedback_draft: (result.improved_feedback_draft || "").toString(),
    rubric: { categories },
    category_reviews: reviews,
  };
}

async function analyzeCategoryWithOpenAI({
  category,
  feedbackText,
  evidenceCandidates,
  apiKey,
  extraInstructions,
}) {
  if (!apiKey) {
    throw new Error("Missing OpenAI API key.");
  }

  const subcriteriaText = (category.subcriteria || [])
    .map((sub) => `- ${sub.title}`)
    .join("\n") || "(none)";
  const evidenceText = (evidenceCandidates || []).length
    ? evidenceCandidates.map((item) => `- ${item}`).join("\n")
    : "(none)";

  const input = [
    `Category title: ${category.title || "(untitled)"}`,
    `Subcriteria:\n${subcriteriaText}`,
    `Draft feedback:\n${clampText(feedbackText, 2400) || "(none)"}`,
    `Evidence candidates:\n${evidenceText}`,
  ].join("\n\n");

  const body = {
    model: DEFAULT_MODEL,
    instructions: buildCategoryInstructions(extraInstructions),
    input,
    text: { verbosity: "low" },
    reasoning: { effort: "minimal" },
    max_output_tokens: 220,
    store: false,
  };

  const response = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API error: ${response.status} ${errorText}`);
  }

  const json = await response.json();
  const outputText = extractOutputText(json);

  if (!outputText) {
    throw new Error("OpenAI response contained no output text.");
  }
  return parseCategoryOutput(outputText);
}

async function analyzeWithOpenAIParallel({
  rubricText,
  feedbackText,
  submissionText,
  evidenceEnabled,
  rubricStructure,
  apiKey,
  extraInstructions,
  onCategory,
}) {
  if (!apiKey) {
    throw new Error("Missing OpenAI API key.");
  }

  const categories =
    rubricStructure && rubricStructure.categories?.length
      ? rubricStructure.categories
      : parseRubricHierarchy(rubricText || "").categories || [];

  const evidenceByCategory = evidenceEnabled
    ? buildEvidenceByCategory(
        submissionText,
        rubricText,
        rubricStructure,
        { maxEvidencePerCategory: 1, maxParagraphLength: 200 }
      )
    : new Map();

  const runCategory = async (category) => {
    const evidenceCandidates = evidenceByCategory.get(category.id) || [];
    let result = await analyzeCategoryWithOpenAI({
      category,
      feedbackText,
      evidenceCandidates,
      apiKey,
      extraInstructions,
    });

    if (isLowQualityFeedback(result?.ai_feedback?.text)) {
      const retryExtras = [
        "Rewrite with concrete, student-specific detail tied to the evidence candidates. Avoid template phrases.",
      ];
      const mergedExtras = Array.isArray(extraInstructions)
        ? [...extraInstructions, ...retryExtras]
        : extraInstructions
        ? [extraInstructions, ...retryExtras]
        : retryExtras;
      result = await analyzeCategoryWithOpenAI({
        category,
        feedbackText,
        evidenceCandidates,
        apiKey,
        extraInstructions: mergedExtras,
      });
    }

    if (evidenceCandidates.length) {
      const evidence = (result?.ai_feedback?.evidence_quote || "").trim();
      if (!evidence || !evidence.includes("[P")) {
        result.ai_feedback = {
          ...(result.ai_feedback || {}),
          evidence_quote: evidenceCandidates[0],
        };
      }
    }

    return result;
  };

  const tasks = categories.map((category) =>
    runCategory(category)
      .then((result) => {
        if (onCategory) onCategory(category, result, null);
        return { category, result };
      })
      .catch((error) => {
        if (onCategory) onCategory(category, null, error);
        return { category, error };
      })
  );

  const categoryResults = await Promise.all(tasks);

  return {
    categories,
    category_results: categoryResults,
  };
}

async function analyzeWithOpenAI({
  rubricText,
  feedbackText,
  submissionText,
  evidenceEnabled,
  rubricStructure,
  apiKey,
  extraInstructions,
}) {
  if (!apiKey) {
    throw new Error("Missing OpenAI API key.");
  }

  const speedConfig = SPEED_CONFIG;

  const body = {
    model: DEFAULT_MODEL,
    instructions: buildInstructions(extraInstructions),
    input: buildUserInput({
      rubricText: clampText(rubricText, 8000),
      submissionText: clampText(
        submissionText,
        speedConfig.maxSubmissionChars
      ),
      feedbackText: clampText(feedbackText, 6000),
      evidenceEnabled,
      rubricStructure,
      speedConfig,
    }),
    text: {
      format: {
        type: "json_schema",
        name: "feedback_quality_report",
        strict: true,
        schema: buildSchema(),
      },
      verbosity: "low",
    },
    reasoning: { effort: "minimal" },
    max_output_tokens: speedConfig.maxOutputTokens,
    store: false,
  };

  const response = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API error: ${response.status} ${errorText}`);
  }

  const json = await response.json();
  const outputText = extractOutputText(json);

  if (!outputText) {
    if (process.env.DEBUG_OPENAI_OUTPUT) {
      const fs = require("fs");
      fs.writeFileSync(
        "/tmp/openai_response.json",
        JSON.stringify(json, null, 2).slice(0, 20000)
      );
    }
    throw new Error("OpenAI response contained no output text.");
  }

  let parsed;
  try {
    parsed = JSON.parse(outputText);
  } catch (error) {
    const start = outputText.indexOf("{");
    const end = outputText.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      try {
        parsed = JSON.parse(outputText.slice(start, end + 1));
      } catch (innerError) {
        if (process.env.DEBUG_OPENAI_OUTPUT) {
          const fs = require("fs");
          fs.writeFileSync(
            "/tmp/openai_output.txt",
            outputText.slice(0, 20000)
          );
        }
        throw new Error("OpenAI response was not valid JSON.");
      }
    } else {
      if (process.env.DEBUG_OPENAI_OUTPUT) {
        const fs = require("fs");
        fs.writeFileSync("/tmp/openai_output.txt", outputText.slice(0, 20000));
      }
      throw new Error("OpenAI response was not valid JSON.");
    }
  }

  const sanitized = sanitizeAnalysis(parsed);
  if (!sanitized) {
    throw new Error("OpenAI response schema validation failed.");
  }

  return sanitized;
}

async function analyzeWithOpenAIFast({
  rubricText,
  feedbackText,
  submissionText,
  evidenceEnabled,
  rubricStructure,
  apiKey,
  extraInstructions,
}) {
  if (!apiKey) {
    throw new Error("Missing OpenAI API key.");
  }

  const speedConfig = {
    ...SPEED_CONFIG,
    maxSubmissionChars: 9000,
    maxParagraphs: 12,
    maxParagraphLength: 200,
    maxOutputTokens: 600,
    maxEvidencePerCategory: 1,
  };

  const body = {
    model: DEFAULT_MODEL,
    instructions: buildFastInstructions(extraInstructions),
    input: buildUserInput({
      rubricText: clampText(rubricText, 8000),
      submissionText: clampText(
        submissionText,
        speedConfig.maxSubmissionChars
      ),
      feedbackText: clampText(feedbackText, 5000),
      evidenceEnabled,
      rubricStructure,
      speedConfig,
    }),
    text: {
      format: {
        type: "json_schema",
        name: "feedback_quality_fast",
        strict: true,
        schema: buildFastSchema(),
      },
      verbosity: "low",
    },
    reasoning: { effort: "minimal" },
    max_output_tokens: speedConfig.maxOutputTokens,
    store: false,
  };

  const response = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API error: ${response.status} ${errorText}`);
  }

  const json = await response.json();
  const outputText = extractOutputText(json);

  if (!outputText) {
    throw new Error("OpenAI response contained no output text.");
  }

  let parsed;
  try {
    parsed = JSON.parse(outputText);
  } catch (error) {
    const start = outputText.indexOf("{");
    const end = outputText.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      parsed = JSON.parse(outputText.slice(start, end + 1));
    } else {
      throw new Error("OpenAI response was not valid JSON.");
    }
  }

  return parsed;
}

async function analyzeWithOpenAITextFast({
  rubricText,
  feedbackText,
  submissionText,
  evidenceEnabled,
  rubricStructure,
  apiKey,
  extraInstructions,
}) {
  if (!apiKey) {
    throw new Error("Missing OpenAI API key.");
  }

  const speedConfig = {
    ...SPEED_CONFIG,
    maxSubmissionChars: 7000,
    maxParagraphs: 10,
    maxParagraphLength: 180,
    maxOutputTokens: 260,
    maxEvidencePerCategory: 1,
  };

  const body = {
    model: DEFAULT_MODEL,
    instructions: buildTextFastInstructions(extraInstructions),
    input: buildUserInput({
      rubricText: clampText(rubricText, 8000),
      submissionText: clampText(
        submissionText,
        speedConfig.maxSubmissionChars
      ),
      feedbackText: clampText(feedbackText, 4000),
      evidenceEnabled,
      rubricStructure,
      speedConfig,
    }),
    text: { verbosity: "low" },
    reasoning: { effort: "minimal" },
    max_output_tokens: speedConfig.maxOutputTokens,
    store: false,
  };

  const response = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API error: ${response.status} ${errorText}`);
  }

  const json = await response.json();
  const outputText = extractOutputText(json);

  if (!outputText) {
    throw new Error("OpenAI response contained no output text.");
  }

  if (onDelta && deltaCount === 0 && outputText) {
    await streamInChunks(outputText, onDelta, { chunkSize: 160, delayMs: 8 });
  }

  return outputText;
}

async function analyzeWithOpenAITextFastStream({
  rubricText,
  feedbackText,
  submissionText,
  evidenceEnabled,
  rubricStructure,
  apiKey,
  extraInstructions,
  onDelta,
}) {
  if (!apiKey) {
    throw new Error("Missing OpenAI API key.");
  }

  const speedConfig = {
    ...SPEED_CONFIG,
    maxSubmissionChars: 7000,
    maxParagraphs: 10,
    maxParagraphLength: 180,
    maxOutputTokens: 260,
    maxEvidencePerCategory: 1,
  };

  const body = {
    model: DEFAULT_MODEL,
    instructions: buildTextFastInstructions(extraInstructions),
    input: buildUserInput({
      rubricText: clampText(rubricText, 8000),
      submissionText: clampText(
        submissionText,
        speedConfig.maxSubmissionChars
      ),
      feedbackText: clampText(feedbackText, 4000),
      evidenceEnabled,
      rubricStructure,
      speedConfig,
    }),
    text: { verbosity: "low" },
    reasoning: { effort: "minimal" },
    max_output_tokens: speedConfig.maxOutputTokens,
    store: false,
    stream: true,
  };

  const response = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API error: ${response.status} ${errorText}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let outputText = "";
  let latestResponse = null;
  let latestItemOutput = "";
  let deltaCount = 0;

  const handleEvent = (event) => {
    if (!event || !event.type) return;
    if (event.type === "response.output_text.delta" && event.delta) {
      outputText += event.delta;
      if (onDelta) {
        deltaCount += 1;
        onDelta(event.delta);
      }
    }
    if (event.type === "response.output_text.done" && event.text) {
      outputText = event.text;
      if (onDelta && deltaCount === 0) {
        deltaCount += 1;
        onDelta(event.text);
      }
    }
    if (event.type === "response.output_json.delta" && event.delta) {
      outputText += event.delta;
      if (onDelta) {
        deltaCount += 1;
        onDelta(event.delta);
      }
    }
    if (event.type === "response.output_item.added" && event.item) {
      const itemText = extractOutputText({ output: [event.item] });
      if (itemText) {
        latestItemOutput = itemText;
      }
    }
    if (event.type === "response.output_item.done" && event.item) {
      const itemText = extractOutputText({ output: [event.item] });
      if (itemText) {
        latestItemOutput = itemText;
      }
    }
    if (
      event.type === "response.completed" ||
      event.type === "response.done"
    ) {
      if (event.response) {
        latestResponse = event.response;
      }
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let index;
    while ((index = buffer.indexOf("\n\n")) !== -1) {
      const chunk = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const lines = chunk.split("\n").filter(Boolean);
      const dataLines = [];
      lines.forEach((line) => {
        if (line.startsWith("data:")) {
          dataLines.push(line.replace(/^data:\\s?/, ""));
        }
      });
      if (!dataLines.length) continue;
      const data = dataLines.join("\n").trim();
      if (data === "[DONE]") continue;
      try {
        const event = JSON.parse(data);
        handleEvent(event);
      } catch (error) {
        // ignore
      }
    }
  }

  if (!outputText && latestResponse) {
    outputText = extractOutputText(latestResponse);
  }
  if (!outputText && latestItemOutput) {
    outputText = latestItemOutput;
  }

  if (!outputText) {
    throw new Error("OpenAI response contained no output text.");
  }

  return outputText;
}

async function analyzeWithOpenAITextQualityStream({
  rubricText,
  feedbackText,
  submissionText,
  evidenceEnabled,
  rubricStructure,
  apiKey,
  extraInstructions,
  onDelta,
}) {
  if (!apiKey) {
    throw new Error("Missing OpenAI API key.");
  }

  const speedConfig = {
    ...SPEED_CONFIG,
    maxSubmissionChars: 200000,
    maxParagraphs: 12,
    maxParagraphLength: 200,
    maxOutputTokens: 650,
    maxEvidencePerCategory: 1,
    omitDigest: true,
  };

  const body = {
    model: DEFAULT_MODEL,
    instructions: buildTextQualityInstructions(extraInstructions),
    input: buildUserInput({
      rubricText: clampText(rubricText, 8000),
      submissionText: clampText(
        submissionText,
        speedConfig.maxSubmissionChars
      ),
      feedbackText: clampText(feedbackText, 6000),
      evidenceEnabled,
      rubricStructure,
      speedConfig,
    }),
    text: { verbosity: "low" },
    reasoning: { effort: "minimal" },
    max_output_tokens: speedConfig.maxOutputTokens,
    store: false,
    stream: true,
  };

  const response = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API error: ${response.status} ${errorText}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let outputText = "";
  let latestResponse = null;
  let latestItemOutput = "";
  let deltaCount = 0;

  const handleEvent = (event) => {
    if (!event || !event.type) return;
    if (event.type === "response.output_text.delta" && event.delta) {
      outputText += event.delta;
      if (onDelta) {
        deltaCount += 1;
        onDelta(event.delta);
      }
    }
    if (event.type === "response.output_text.done" && event.text) {
      outputText = event.text;
      if (onDelta && deltaCount === 0) {
        deltaCount += 1;
        onDelta(event.text);
      }
    }
    if (event.type === "response.output_json.delta" && event.delta) {
      outputText += event.delta;
      if (onDelta) {
        deltaCount += 1;
        onDelta(event.delta);
      }
    }
    if (event.type === "response.output_item.added" && event.item) {
      const itemText = extractOutputText({ output: [event.item] });
      if (itemText) {
        latestItemOutput = itemText;
      }
    }
    if (event.type === "response.output_item.done" && event.item) {
      const itemText = extractOutputText({ output: [event.item] });
      if (itemText) {
        latestItemOutput = itemText;
      }
    }
    if (
      event.type === "response.completed" ||
      event.type === "response.done"
    ) {
      if (event.response) {
        latestResponse = event.response;
      }
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let index;
    while ((index = buffer.indexOf("\n\n")) !== -1) {
      const chunk = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const lines = chunk.split("\n").filter(Boolean);
      const dataLines = [];
      lines.forEach((line) => {
        if (line.startsWith("data:")) {
          dataLines.push(line.replace(/^data:\\s?/, ""));
        }
      });
      if (!dataLines.length) continue;
      const data = dataLines.join("\n").trim();
      if (data === "[DONE]") continue;
      try {
        const event = JSON.parse(data);
        handleEvent(event);
      } catch (error) {
        // ignore
      }
    }
  }

  if (!outputText && latestResponse) {
    outputText = extractOutputText(latestResponse);
  }
  if (!outputText && latestItemOutput) {
    outputText = latestItemOutput;
  }

  if (!outputText) {
    const fallbackBody = { ...body, stream: false };
    const fallbackResponse = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(fallbackBody),
    });

    if (fallbackResponse.ok) {
      const json = await fallbackResponse.json();
      const fallbackText = extractOutputText(json);
      if (fallbackText) {
        if (onDelta) {
          deltaCount += 1;
          onDelta(fallbackText);
        }
        return fallbackText;
      }
    }
  }

  if (!outputText) {
    throw new Error("OpenAI response contained no output text.");
  }

  if (onDelta && deltaCount === 0 && outputText) {
    await streamInChunks(outputText, onDelta, { chunkSize: 180, delayMs: 10 });
  }

  return outputText;
}

async function analyzeWithOpenAIStream({
  rubricText,
  feedbackText,
  submissionText,
  evidenceEnabled,
  rubricStructure,
  apiKey,
  onDelta,
  extraInstructions,
  signal,
}) {
  if (!apiKey) {
    throw new Error("Missing OpenAI API key.");
  }

  const speedConfig = SPEED_CONFIG;

  const body = {
    model: DEFAULT_MODEL,
    instructions: buildInstructions(extraInstructions),
    input: buildUserInput({
      rubricText: clampText(rubricText, 8000),
      submissionText: clampText(
        submissionText,
        speedConfig.maxSubmissionChars
      ),
      feedbackText: clampText(feedbackText, 6000),
      evidenceEnabled,
      rubricStructure,
      speedConfig,
    }),
    text: {
      format: {
        type: "json_schema",
        name: "feedback_quality_report",
        strict: true,
        schema: buildSchema(),
      },
      verbosity: "low",
    },
    reasoning: { effort: "minimal" },
    max_output_tokens: speedConfig.maxOutputTokens,
    store: false,
    stream: true,
    stream_options: { include_obfuscation: false },
  };

  const response = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API error: ${response.status} ${errorText}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let outputText = "";
  let latestResponse = null;
  let latestItemOutput = "";

  const handleEvent = (event) => {
    if (!event || !event.type) return;
    if (event.type === "response.output_text.delta") {
      if (event.delta) {
        outputText += event.delta;
        if (onDelta) onDelta(event.delta);
      }
    }
    if (event.type === "response.output_json.delta") {
      if (event.delta) {
        outputText += event.delta;
        if (onDelta) onDelta(event.delta);
      }
    }
    if (event.type === "response.output_text.done" && event.text) {
      outputText = event.text;
      if (onDelta) onDelta(event.text);
    }
    if (event.type === "response.output_json.done") {
      if (event.json) {
        const jsonText = JSON.stringify(event.json);
        outputText = jsonText;
        if (onDelta) onDelta(jsonText);
      } else if (event.text) {
        outputText = event.text;
        if (onDelta) onDelta(event.text);
      }
    }
    if (event.type === "response.output_item.added" && event.item) {
      const itemText = extractOutputText({ output: [event.item] });
      if (itemText) {
        latestItemOutput = itemText;
      }
    }
    if (event.type === "response.output_item.done" && event.item) {
      const itemText = extractOutputText({ output: [event.item] });
      if (itemText) {
        latestItemOutput = itemText;
      }
    }
    if (
      event.type === "response.completed" ||
      event.type === "response.done"
    ) {
      if (event.response) {
        latestResponse = event.response;
      }
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let index;
    while ((index = buffer.indexOf("\n\n")) !== -1) {
      const chunk = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const lines = chunk.split("\n").filter(Boolean);
      let dataLines = [];
      lines.forEach((line) => {
        if (line.startsWith("data:")) {
          dataLines.push(line.replace(/^data:\\s?/, ""));
        }
      });
      if (!dataLines.length) continue;
      const data = dataLines.join("\n").trim();
      if (data === "[DONE]") continue;
      try {
        const event = JSON.parse(data);
        handleEvent(event);
      } catch (error) {
        // Ignore malformed chunks
      }
    }
  }

  if (!outputText && latestResponse) {
    outputText = extractOutputText(latestResponse);
  }

  if (!outputText && latestItemOutput) {
    outputText = latestItemOutput;
  }

  if (!outputText) {
    if (process.env.DEBUG_OPENAI_OUTPUT) {
      const fs = require("fs");
      fs.writeFileSync(
        "/tmp/openai_stream_empty.txt",
        JSON.stringify(
          {
            message: "Empty output text after streaming.",
            latestResponse: latestResponse ? true : false,
            latestItemOutput: latestItemOutput ? true : false,
          },
          null,
          2
        )
      );
    }
    throw new Error("OpenAI response contained no output text.");
  }

  let parsed;
  try {
    parsed = JSON.parse(outputText);
  } catch (error) {
    const start = outputText.indexOf("{");
    const end = outputText.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      try {
        parsed = JSON.parse(outputText.slice(start, end + 1));
      } catch (innerError) {
        if (process.env.DEBUG_OPENAI_OUTPUT) {
          const fs = require("fs");
          fs.writeFileSync(
            "/tmp/openai_output.txt",
            outputText.slice(0, 20000)
          );
        }
        throw new Error("OpenAI response was not valid JSON.");
      }
    } else {
      if (process.env.DEBUG_OPENAI_OUTPUT) {
        const fs = require("fs");
        fs.writeFileSync("/tmp/openai_output.txt", outputText.slice(0, 20000));
      }
      throw new Error("OpenAI response was not valid JSON.");
    }
  }

  const sanitized = sanitizeAnalysis(parsed);
  if (!sanitized) {
    throw new Error("OpenAI response schema validation failed.");
  }

  return { sanitized, rawText: outputText };
}

async function streamPreviewDraft({
  rubricText,
  feedbackText,
  submissionText,
  evidenceEnabled,
  apiKey,
  onDelta,
  signal,
}) {
  if (!apiKey) {
    throw new Error("Missing OpenAI API key.");
  }

  const speedConfig = {
    ...SPEED_CONFIG,
    maxSubmissionChars: 4000,
    maxParagraphs: 8,
    maxParagraphLength: 200,
    maxOutputTokens: 240,
  };

  const hasSubmission = Boolean((submissionText || "").trim());
  const instructions = [
    "You are an assistant that drafts student-ready feedback for university markers.",
    "Do not assign grades or predict grades.",
    "Use the rubric categories as headings.",
    "Preview mode: write 1 sentence per category (max 25 words each).",
    "Include one concrete improvement action in the sentence.",
    hasSubmission
      ? "If evidence is available, include a short quote with [P#] in the sentence."
      : "If submission evidence is not provided, add '(Evidence pending)' at the end of the sentence.",
    "Keep the tone supportive and professional.",
    "Avoid meta phrases like 'add' or 'provide feedback'.",
    "Keep total output under 160 words.",
  ].join(" ");

  const body = {
    model: DEFAULT_MODEL,
    instructions,
    input: buildUserInput({
      rubricText: clampText(rubricText, 8000),
      submissionText: clampText(
        submissionText,
        speedConfig.maxSubmissionChars
      ),
      feedbackText: clampText(feedbackText, 2000),
      evidenceEnabled,
      rubricStructure: null,
      speedConfig,
    }),
    text: { verbosity: "low" },
    reasoning: { effort: "minimal" },
    max_output_tokens: speedConfig.maxOutputTokens,
    store: false,
    stream: true,
  };

  const response = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API error: ${response.status} ${errorText}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let outputText = "";
  let latestResponse = null;
  let latestItemOutput = "";

  const handleEvent = (event) => {
    if (!event || !event.type) return;
    if (event.type === "response.output_text.delta" && event.delta) {
      outputText += event.delta;
      if (onDelta) onDelta(event.delta);
    }
    if (event.type === "response.output_text.done" && event.text) {
      outputText = event.text;
      if (onDelta) onDelta(event.text);
    }
    if (event.type === "response.output_json.delta" && event.delta) {
      outputText += event.delta;
      if (onDelta) onDelta(event.delta);
    }
    if (event.type === "response.output_item.added" && event.item) {
      const itemText = extractOutputText({ output: [event.item] });
      if (itemText) {
        latestItemOutput = itemText;
      }
    }
    if (event.type === "response.output_item.done" && event.item) {
      const itemText = extractOutputText({ output: [event.item] });
      if (itemText) {
        latestItemOutput = itemText;
      }
    }
    if (
      event.type === "response.completed" ||
      event.type === "response.done"
    ) {
      if (event.response) {
        latestResponse = event.response;
      }
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let index;
    while ((index = buffer.indexOf("\n\n")) !== -1) {
      const chunk = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const lines = chunk.split("\n").filter(Boolean);
      let dataLines = [];
      lines.forEach((line) => {
        if (line.startsWith("data:")) {
          dataLines.push(line.replace(/^data:\\s?/, ""));
        }
      });
      if (!dataLines.length) continue;
      const data = dataLines.join("\n").trim();
      if (data === "[DONE]") continue;
      try {
        const event = JSON.parse(data);
        handleEvent(event);
      } catch (error) {
        // Ignore malformed chunks
      }
    }
  }

  if (!outputText && latestResponse) {
    outputText = extractOutputText(latestResponse);
  }
  if (!outputText && latestItemOutput) {
    outputText = latestItemOutput;
  }

  if (!outputText) {
    // Fallback to non-streaming preview if streaming yields no text.
    const fallbackBody = { ...body, stream: false };
    const fallbackResponse = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(fallbackBody),
      signal,
    });

    if (fallbackResponse.ok) {
      const json = await fallbackResponse.json();
      const fallbackText = extractOutputText(json);
      if (fallbackText) return fallbackText;
    }
  }

  return outputText;
}

module.exports = {
  analyzeWithOpenAI,
  analyzeWithOpenAIFast,
  analyzeWithOpenAITextFast,
  analyzeWithOpenAITextFastStream,
  analyzeWithOpenAITextQualityStream,
  analyzeWithOpenAIParallel,
  analyzeWithOpenAIStream,
  streamPreviewDraft,
};
