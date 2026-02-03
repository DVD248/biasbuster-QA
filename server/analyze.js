const { parseRubric, parseRubricHierarchy, extractKeywords } = require("./rubric");
const { redactPII } = require("./pii");
const { splitSentences } = require("./utils");
const {
  analyzeWithOpenAI,
  analyzeWithOpenAIFast,
  analyzeWithOpenAITextFast,
  analyzeWithOpenAITextQualityStream,
  analyzeWithOpenAIParallel,
  analyzeWithOpenAIStream,
} = require("./openai");

const ANALYSIS_VERSION = "heuristic-v2";
const AI_ANALYSIS_VERSION = "openai-v2";
const AI_FAST_VERSION = "openai-fast-v1";
const AI_ULTRA_VERSION = "openai-ultra-v1";
const AI_TEXT_VERSION = "openai-text-v1";
const AI_PARALLEL_VERSION = "openai-parallel-v1";
const AI_MODE = process.env.AI_MODE || "parallel";

function parseTextFastOutput(text) {
  const lines = (text || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const map = new Map();
  lines.forEach((line) => {
    const match = line.match(/^([a-z0-9\\-]+)\\s*:\\s*(.+)$/i);
    if (!match) return;
    map.set(match[1], match[2].trim());
  });
  return map;
}

function parseTextQualityOutput(text) {
  const blocks = (text || "")
    .split(/\n(?=\[cat-)/i)
    .map((block) => block.trim())
    .filter(Boolean);

  const results = [];

  blocks.forEach((block) => {
    const lines = block.split("\n").map((line) => line.trim());
    const headerLine = lines[0] || "";
    const headerMatch = headerLine.match(/^\[(.+?)\]\s*(.*)$/);
    if (!headerMatch) return;
    const categoryId = headerMatch[1].trim();
    const categoryTitle = headerMatch[2].trim();

    let coverage = "missing";
    let issues = [];
    let markerAssessment = "";
    let feedbackLines = [];
    let evidenceQuote = "";
    let inFeedback = false;

    lines.slice(1).forEach((line) => {
      if (!line) return;
      if (/^coverage:/i.test(line)) {
        coverage = line.split(":").slice(1).join(":").trim().toLowerCase();
        return;
      }
      if (/^issues:/i.test(line)) {
        const raw = line.split(":").slice(1).join(":").trim();
        if (!raw || raw.toLowerCase() === "none") {
          issues = [];
        } else {
          issues = raw
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean);
        }
        return;
      }
      if (/^markerassessment:/i.test(line)) {
        markerAssessment = line.split(":").slice(1).join(":").trim();
        return;
      }
      if (/^feedback:/i.test(line)) {
        inFeedback = true;
        const rest = line.split(":").slice(1).join(":").trim();
        if (rest) feedbackLines.push(rest);
        return;
      }
      if (/^evidence:/i.test(line)) {
        inFeedback = false;
        evidenceQuote = line.split(":").slice(1).join(":").trim();
        return;
      }
      if (line === "---") {
        inFeedback = false;
        return;
      }
      if (inFeedback) {
        feedbackLines.push(line);
      }
    });

    results.push({
      category_id: categoryId,
      category_title: categoryTitle,
      coverage_status: ["addressed", "partial", "missing"].includes(coverage)
        ? coverage
        : "missing",
      issues,
      marker_feedback_assessment: markerAssessment,
      ai_feedback: {
        text: feedbackLines.join("\n").trim(),
        evidence_quote: evidenceQuote,
      },
    });
  });

  return results;
}

function extractEvidenceFromText(text) {
  if (!text) return "";
  const quoted =
    text.match(/“[^”]+”\s*\[P\d+\]/) ||
    text.match(/\"[^\"]+\"\s*\[P\d+\]/);
  if (quoted) return quoted[0];
  const bracket = text.match(/\[P\d+\][^\n]{0,220}/);
  return bracket ? bracket[0].trim() : "";
}

function buildSubcriteriaReviewsFromText(category, text, fallback = []) {
  const lower = normalizeText(text);
  if (!lower || !(category.subcriteria || []).length) {
    return Array.isArray(fallback) ? fallback : [];
  }
  return (category.subcriteria || []).map((sub) => {
    const tokens = extractKeywords(sub);
    const addressed = tokens.length
      ? tokens.some((token) => lower.includes(token))
      : false;
    return {
      subcriterion_id: sub.id,
      coverage_status: addressed ? "addressed" : "missing",
    };
  });
}

function isLowQualityDraft(text) {
  const normalized = (text || "").toLowerCase();
  if (!normalized) return true;
  if (normalized.length < 140) return true;
  const badPhrases = [
    "clarify",
    "add a short",
    "explicit improvement step",
    "provide feedback",
    "specific example",
  ];
  return badPhrases.some((phrase) => normalized.includes(phrase));
}

function buildLocalDraft(category, evidenceQuote) {
  const subcriteriaList = (category.subcriteria || [])
    .map((sub) => sub.title)
    .filter(Boolean)
    .slice(0, 2)
    .join(", ");
  const focus = subcriteriaList || category.title;
  const evidenceLine = evidenceQuote
    ? `In the submission, ${evidenceQuote} suggests relevant material, but it is not yet explicitly linked to ${focus}.`
    : `Identify a specific passage in the submission and link it explicitly to ${focus}.`;
  const improveLine = `Add one clear, actionable step: specify what to change, where to change it, and how that improves ${focus}.`;
  const whyLine = `This makes the feedback actionable and defensible for ${category.title}.`;
  return `${category.title}: ${evidenceLine} ${improveLine} ${whyLine}`.trim();
}

function sanitizeStudentFeedback(text) {
  let cleaned = (text || "").trim();
  if (!cleaned) return cleaned;
  const patterns = [
    /^(the|this)\s+(draft\s+)?feedback\s+(notes|says|mentions|is)\s*/i,
    /^your\s+(draft\s+)?feedback\s+(notes|says|mentions|is)\s*/i,
    /^the\s+draft\s+.*?is\s+/i,
  ];
  patterns.forEach((pattern) => {
    cleaned = cleaned.replace(pattern, "");
  });
  cleaned = cleaned.replace(/\bevidence:\s*["“][^"”]+["”]\s*\[P\d+\]/gi, "");
  cleaned = cleaned.replace(/\b(draft feedback|draft|rubric|subcriterion|marker)\b/gi, "report");
  cleaned = cleaned.replace(/\bfeedback\b/gi, "report");
  cleaned = cleaned.replace(/\bremarks?\b/gi, "explanations");
  cleaned = cleaned.replace(/\bcomments?\b/gi, "explanations");
  return cleaned.trim();
}

const VAGUE_PATTERNS = [
  /needs more depth/i,
  /more depth/i,
  /too vague/i,
  /unclear/i,
  /not clear/i,
  /needs more/i,
  /good work/i,
  /nice work/i,
  /expand/i,
  /insufficient/i,
  /limited/i,
  /could be better/i,
  /lacks detail/i,
  /reasonable understanding/i,
  /generally clear/i,
  /fine but/i,
  /could be developed/i,
  /could be expanded/i,
  /acceptable/i,
  /mostly okay/i,
  /some evaluation/i,
  /could be improved/i,
  /needs improvement/i,
];

const WEAKNESS_PATTERNS = [
  /needs/i,
  /lacks/i,
  /weak/i,
  /unclear/i,
  /insufficient/i,
  /limited/i,
  /missing/i,
  /could be developed/i,
  /could be expanded/i,
  /acceptable/i,
];

const ACTION_HINTS = [
  /should/i,
  /try/i,
  /consider/i,
  /add/i,
  /include/i,
  /explain/i,
  /revise/i,
  /support/i,
  /connect/i,
  /demonstrate/i,
  /clarify/i,
  /state/i,
  /compare/i,
  /justify/i,
  /deepen/i,
  /identify/i,
  /name/i,
  /expand/i,
  /provide/i,
  /link/i,
  /define/i,
  /describe/i,
  /outline/i,
];

function containsPattern(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function normalizeText(text) {
  return (text || "").toLowerCase();
}

function escapeRegex(text) {
  return (text || "").replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
}

function buildKeywordSet(category) {
  const keywords = new Set(extractKeywords(category));
  (category.subcriteria || []).forEach((sub) => {
    extractKeywords(sub).forEach((keyword) => keywords.add(keyword));
  });
  const titleTokens = normalizeText(category.title)
    .split(/[^a-z0-9]+/g)
    .filter((token) => token.length > 3);
  titleTokens.forEach((token) => keywords.add(token));
  return Array.from(keywords);
}

function extractCategorySection(feedbackText, category, categories) {
  const lines = (feedbackText || "").split(/\r?\n/);
  const title = category?.title ? escapeRegex(category.title) : "";
  if (!title) return "";
  const titleRegex = new RegExp(`^\\s*${title}\\s*[:\\-–—]`, "i");

  const headingRegexes = (categories || [])
    .map((cat) =>
      cat.title ? new RegExp(`^\\s*${escapeRegex(cat.title)}\\s*[:\\-–—]`, "i") : null
    )
    .filter(Boolean);

  let inSection = false;
  const buffer = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (titleRegex.test(trimmed)) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    if (headingRegexes.some((regex) => regex.test(trimmed))) {
      break;
    }
    if (trimmed) buffer.push(trimmed);
  }
  return buffer.join(" ").trim();
}

function findLinkedSnippets(feedbackText, category, maxSnippets = 3) {
  const rawText = feedbackText || "";
  const sentences = splitSentences(rawText);
  if (!sentences.length) return [];
  const keywords = buildKeywordSet(category);
  if (!keywords.length) return [];

  const scored = sentences
    .map((sentence) => {
      const lower = normalizeText(sentence);
      const score = keywords.reduce(
        (total, keyword) => (lower.includes(keyword) ? total + 1 : total),
        0
      );
      return { sentence: sentence.trim(), score, length: sentence.length };
    })
    .filter((item) => item.sentence);

  const matches = scored.filter((item) => item.score > 0);
  if (matches.length) {
    return matches
      .sort((a, b) => (b.score - a.score) || (b.length - a.length))
      .slice(0, maxSnippets)
      .map((item) => item.sentence);
  }

  const lines = rawText
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return [];
  const titleLower = normalizeText(category.title);
  const lineMatches = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const lower = normalizeText(line);
    if (!titleLower || !lower.includes(titleLower)) continue;
    lineMatches.push(line);
    if (lines[i + 1]) {
      lineMatches.push(lines[i + 1]);
    }
    if (lineMatches.length >= maxSnippets) break;
  }
  return lineMatches.slice(0, maxSnippets);
}

function attachLinkedSnippets(reviews, categories, feedbackText) {
  const categoryById = new Map(
    (categories || []).map((category) => [category.id, category])
  );
  return (reviews || []).map((review) => {
    if (review.linked_feedback_snippets?.length) return review;
    const category = categoryById.get(review.category_id);
    if (!category) return review;
    const snippets = findLinkedSnippets(feedbackText, category);
    if (!snippets.length) return review;
    return { ...review, linked_feedback_snippets: snippets };
  });
}

function applyExplicitFeedbackOverride(reviews, categories, feedbackText) {
  const categoryById = new Map(
    (categories || []).map((category) => [category.id, category])
  );

  return (reviews || []).map((review) => {
    const category = categoryById.get(review.category_id);
    if (!category) return review;
    const sectionText = extractCategorySection(feedbackText, category, categories);
    const hasSection = sectionText.length > 0;
    if (!hasSection) return review;

    const wordCount = sectionText.split(/\s+/).filter(Boolean).length;
    const hasAction = containsPattern(sectionText, ACTION_HINTS);

    if (wordCount < 25 || !hasAction) return review;

    return {
      ...review,
      coverage_status: "addressed",
      issues: [],
      marker_feedback_assessment:
        review.marker_feedback_assessment ||
        "Explicit category feedback provided in the draft.",
      subcriteria_reviews: (category.subcriteria || []).map((sub) => ({
        subcriterion_id: sub.id,
        coverage_status: "addressed",
      })),
    };
  });
}

function computeMinimumStandardFromReviews(reviews) {
  if (!Array.isArray(reviews) || !reviews.length) {
    return { met: false, label: "Some criteria missing explicit guidance" };
  }

  const anyNotAddressed = reviews.some((review) => review.coverage_status !== "addressed");
  const anyIssues = reviews.some((review) => Array.isArray(review.issues) && review.issues.length);

  const met = !anyNotAddressed && !anyIssues;
  return {
    met,
    label: met
      ? "Meets minimum feedback standard"
      : "Some criteria missing explicit guidance",
  };
}

function summarizeCoverage(reviews) {
  const total = reviews.length;
  const addressed = reviews.filter((review) => review.coverage_status === "addressed")
    .length;
  const partial = reviews.filter((review) => review.coverage_status === "partial").length;
  const missing = Math.max(total - addressed - partial, 0);
  return `${addressed}/${total} categories clearly addressed; ${partial} partial, ${missing} missing.`;
}

function buildImprovedDraft(feedbackText, reviews, titleById) {
  const base = (feedbackText || "").trim();
  const selected = (reviews || []).filter(
    (review) =>
      review.coverage_status !== "addressed" &&
      review.ai_feedback?.text &&
      review.ai_feedback.text.trim()
  );

  if (!selected.length) return base;

  return [
    base,
    "",
    "AI-assisted category feedback:",
    ...selected.map((review) => {
      const title = titleById.get(review.category_id) || review.category_id;
      return `${title}:\n${review.ai_feedback.text}`.trim();
    }),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildFallbackCategoryReview({
  criterion,
  matchingSentences,
  addressed,
  vagueDetected,
  missingActionDetected,
  subcriteriaReviews,
  evidenceQuote,
}) {
  const issues = [];

  if (!addressed) {
    issues.push("not_rubric_linked");
  }
  if (vagueDetected) {
    issues.push("vagueness");
  }
  if (missingActionDetected) {
    issues.push("missing_action");
  }

  let coverageStatus = "missing";
  if (addressed && (vagueDetected || missingActionDetected)) {
    coverageStatus = "partial";
  } else if (addressed) {
    coverageStatus = "addressed";
  }

  const subcriteriaTitles = (criterion.subcriteria || [])
    .map((sub) => sub.title)
    .filter(Boolean)
    .slice(0, 3)
    .join(", ");

  let suggestionText = `Your feedback on ${criterion.title} should reference specific evidence and include a clear next step.`;
  let rationale = "Specific, evidence-backed guidance is easier for students to apply.";

  if (coverageStatus === "addressed") {
    suggestionText = `You address ${criterion.title}, but strengthen it with a concrete example${subcriteriaTitles ? ` (e.g., ${subcriteriaTitles})` : ""} and one targeted improvement step.`;
    rationale = "Even strong feedback benefits from explicit evidence and a clear action.";
  } else if (coverageStatus === "partial") {
    suggestionText = `Clarify ${criterion.title} with a specific example from the work and an explicit improvement step${subcriteriaTitles ? ` tied to ${subcriteriaTitles}` : ""}.`;
    rationale = "Specific, actionable guidance makes the feedback easier to apply.";
  } else {
    suggestionText = `Add feedback on ${criterion.title} with one evidence example and one improvement step${subcriteriaTitles ? ` tied to ${subcriteriaTitles}` : ""}.`;
  }

  return {
    category_id: criterion.id,
    coverage_status: coverageStatus,
    subcriteria_reviews: subcriteriaReviews || [],
    marker_feedback_assessment: addressed
      ? "Draft feedback references this category but lacks specific, evidence-backed guidance."
      : "Draft feedback does not address this category yet.",
    issues,
    linked_feedback_snippets: matchingSentences.slice(0, 3),
    ai_feedback: {
      text: suggestionText,
      rationale,
      evidence_quote: evidenceQuote || "",
    },
  };
}

function buildRubricStructure({ rubricText, criteriaOverride }) {
  if (Array.isArray(criteriaOverride) && criteriaOverride.length) {
    return {
      categories: criteriaOverride.map((criterion, index) => ({
        id: criterion.id || `cat-${index + 1}`,
        title: criterion.title,
        description: criterion.description || "",
        subcriteria: [],
      })),
      source: "override",
    };
  }

  const hierarchy = parseRubricHierarchy(rubricText);
  if (hierarchy?.categories?.length) {
    return hierarchy;
  }

  const flatCriteria = parseRubric(rubricText);
  return {
    categories: flatCriteria.map((criterion, index) => ({
      id: criterion.id || `cat-${index + 1}`,
      title: criterion.title,
      description: criterion.description || "",
      subcriteria: [],
    })),
    source: "flat",
  };
}

function scoreParagraphForCategory(para, keywords) {
  if (!para || !keywords.length) return 0;
  const lower = normalizeText(para);
  let score = 0;
  keywords.forEach((keyword) => {
    if (lower.includes(keyword)) score += 1;
  });
  return score;
}

function pickEvidenceQuote(submissionText, category) {
  const paragraphs = (submissionText || "")
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n/)
    .map((para) => para.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (!paragraphs.length) return "";

  const keywords = buildKeywordSet(category);
  if (!keywords.length) return "";

  const scored = paragraphs.map((para, index) => ({
    index,
    para,
    score: scoreParagraphForCategory(para, keywords),
  }));

  const best = scored.sort((a, b) => b.score - a.score)[0];
  if (!best || best.score === 0) return "";
  const trimmed =
    best.para.length > 260 ? `${best.para.slice(0, 260).trim()}…` : best.para;
  return `[P${best.index + 1}] ${trimmed}`;
}

function analyzeFeedbackHeuristic({ rubricText, feedbackText, submissionText, criteriaOverride }) {
  const redactedRubric = redactPII(rubricText);
  const redactedFeedback = redactPII(feedbackText);
  const redactedSubmission = redactPII(submissionText || "");

  const rubricStructure = buildRubricStructure({
    rubricText: redactedRubric,
    criteriaOverride,
  });

  const categories = rubricStructure.categories || [];

  const feedbackLower = redactedFeedback.toLowerCase();
  const sentences = splitSentences(redactedFeedback);

  const reviews = categories.map((category) => {
    const keywords = extractKeywords(category);
    const addressed = keywords.length
      ? keywords.some((keyword) => feedbackLower.includes(keyword))
      : false;

    const matchingSentences = sentences
      .filter((sentence) => keywords.some((keyword) => sentence.toLowerCase().includes(keyword)))
      .map((sentence) => sentence.trim())
      .filter(Boolean);

    let vagueDetected = false;
    let missingActionDetected = false;

    if (addressed) {
      for (const sentence of matchingSentences) {
        if (containsPattern(sentence, VAGUE_PATTERNS)) {
          vagueDetected = true;
        }
        if (
          containsPattern(sentence, WEAKNESS_PATTERNS) &&
          !containsPattern(sentence, ACTION_HINTS)
        ) {
          missingActionDetected = true;
        }
      }
    }

    const subcriteriaReviews = (category.subcriteria || []).map((sub) => {
      const subKeywords = extractKeywords(sub);
      const subAddressed = subKeywords.length
        ? subKeywords.some((keyword) => feedbackLower.includes(keyword))
        : false;
      return {
        subcriterion_id: sub.id,
        coverage_status: subAddressed ? "addressed" : "missing",
      };
    });

    return buildFallbackCategoryReview({
      criterion: category,
      matchingSentences,
      addressed,
      vagueDetected,
      missingActionDetected,
      subcriteriaReviews,
      evidenceQuote: pickEvidenceQuote(redactedSubmission, category),
    });
  });

  const reviewsWithLinks = attachLinkedSnippets(
    reviews,
    categories,
    redactedFeedback
  );
  const reviewsWithOverride = applyExplicitFeedbackOverride(
    reviewsWithLinks,
    categories,
    redactedFeedback
  );

  const minimumStandard = computeMinimumStandardFromReviews(reviewsWithOverride);
  const checklistSummary = summarizeCoverage(reviewsWithOverride);
  const titleById = new Map(categories.map((category) => [category.id, category.title]));

  const improvedDraft = buildImprovedDraft(
    redactedFeedback,
    reviewsWithOverride,
    titleById
  );

  return {
    analysis_version: ANALYSIS_VERSION,
    redaction_applied: true,
    redacted_feedback: redactedFeedback,
    minimum_standard_met: minimumStandard.met,
    minimum_standard_label: minimumStandard.label,
    checklist_summary: checklistSummary,
    rubric: rubricStructure,
    category_reviews: reviewsWithOverride,
    improved_feedback_draft: improvedDraft,
  };
}

async function analyzeFeedback({
  rubricText,
  feedbackText,
  submissionText,
  evidenceEnabled,
  criteriaOverride,
  useAI,
  extraInstructions,
}) {
  const redactedRubric = redactPII(rubricText);
  const redactedFeedback = redactPII(feedbackText);
  const redactedSubmission = redactPII(submissionText || "");
  const rubricStructure = buildRubricStructure({
    rubricText: redactedRubric,
    criteriaOverride,
  });

  if (useAI) {
    try {
      if (!process.env.OPENAI_API_KEY) {
        throw new Error(
          "OpenAI API key is missing. Set OPENAI_API_KEY to enable AI analysis."
        );
      }
      if (AI_MODE === "parallel") {
        const parallelResult = await analyzeWithOpenAIParallel({
          rubricText: redactedRubric,
          feedbackText: redactedFeedback,
          submissionText: redactedSubmission,
          evidenceEnabled,
          rubricStructure,
          apiKey: process.env.OPENAI_API_KEY,
          extraInstructions,
        });

        return buildAnalysisFromParallelResult({
          parallelResult,
          rubricText: redactedRubric,
          feedbackText: redactedFeedback,
          submissionText: redactedSubmission,
          criteriaOverride,
        });
      }
      if (AI_MODE === "text_quality") {
        const textOutput = await analyzeWithOpenAITextQualityStream({
          rubricText: redactedRubric,
          feedbackText: redactedFeedback,
          submissionText: redactedSubmission,
          evidenceEnabled,
          rubricStructure,
          apiKey: process.env.OPENAI_API_KEY,
          extraInstructions,
        });

        return buildAnalysisFromTextQuality({
          textOutput,
          rubricText: redactedRubric,
          feedbackText: redactedFeedback,
          criteriaOverride,
        });
      }
      if (AI_MODE === "ultra") {
        const textOutput = await analyzeWithOpenAITextFast({
          rubricText: redactedRubric,
          feedbackText: redactedFeedback,
          submissionText: redactedSubmission,
          evidenceEnabled,
          rubricStructure,
          apiKey: process.env.OPENAI_API_KEY,
          extraInstructions,
        });

        const heuristic = analyzeFeedbackHeuristic({
          rubricText: redactedRubric,
          feedbackText: redactedFeedback,
          submissionText: redactedSubmission,
          criteriaOverride,
        });

        const textById = parseTextFastOutput(textOutput);

        const mergedReviews = (heuristic.category_reviews || []).map(
          (review) => {
            const text = textById.get(review.category_id);
            if (!text) return review;
            let evidenceQuote = "";
            const quoted =
              text.match(/“[^”]+”\\s*\\[P\\d+\\]/) ||
              text.match(/\"[^\"]+\"\\s*\\[P\\d+\\]/);
            if (quoted) {
              evidenceQuote = quoted[0];
            } else if (text.includes("[P")) {
              evidenceQuote = text;
            }
            return {
              ...review,
              ai_feedback: {
                text,
                rationale: review.ai_feedback.rationale || "",
                evidence_quote: evidenceQuote,
              },
            };
          }
        );

        const reviewsWithLinks = attachLinkedSnippets(
          mergedReviews,
          heuristic.rubric?.categories || [],
          redactedFeedback
        );
        const reviewsWithOverride = applyExplicitFeedbackOverride(
          reviewsWithLinks,
          heuristic.rubric?.categories || [],
          redactedFeedback
        );

        const minimumStandard = computeMinimumStandardFromReviews(reviewsWithOverride);
        const checklistSummary = summarizeCoverage(reviewsWithOverride);

        const titleById = new Map(
          (heuristic.rubric?.categories || []).map((category) => [
            category.id,
            category.title,
          ])
        );

        const improvedDraft = buildImprovedDraft(
          redactedFeedback,
          reviewsWithOverride,
          titleById
        );

        return {
          analysis_version: AI_ULTRA_VERSION,
          redaction_applied: true,
          redacted_feedback: redactedFeedback,
          minimum_standard_met: minimumStandard.met,
          minimum_standard_label: minimumStandard.label,
          checklist_summary: checklistSummary,
          rubric: heuristic.rubric,
          category_reviews: reviewsWithOverride,
          improved_feedback_draft: improvedDraft,
        };
      }

      if (AI_MODE === "fast") {
        const fastResult = await analyzeWithOpenAIFast({
          rubricText: redactedRubric,
          feedbackText: redactedFeedback,
          submissionText: redactedSubmission,
          evidenceEnabled,
          rubricStructure,
          apiKey: process.env.OPENAI_API_KEY,
          extraInstructions,
        });

        const heuristic = analyzeFeedbackHeuristic({
          rubricText: redactedRubric,
          feedbackText: redactedFeedback,
          submissionText: redactedSubmission,
          criteriaOverride,
        });

        const fastById = new Map(
          (fastResult.category_reviews || []).map((review) => [
            review.category_id,
            review,
          ])
        );

        const mergedReviews = (heuristic.category_reviews || []).map(
          (review) => {
            const fastReview = fastById.get(review.category_id);
            if (!fastReview) return review;
            return {
              ...review,
              coverage_status:
                fastReview.coverage_status || review.coverage_status,
              issues: fastReview.issues?.length
                ? fastReview.issues
                : review.issues,
              marker_feedback_assessment:
                fastReview.marker_feedback_assessment ||
                review.marker_feedback_assessment,
              ai_feedback: {
                text: (fastReview.ai_feedback?.text || review.ai_feedback.text || "").trim(),
                rationale: review.ai_feedback.rationale || "",
                evidence_quote: (fastReview.ai_feedback?.evidence_quote || "").trim(),
              },
            };
          }
        );

        const reviewsWithLinks = attachLinkedSnippets(
          mergedReviews,
          heuristic.rubric?.categories || [],
          redactedFeedback
        );
        const reviewsWithOverride = applyExplicitFeedbackOverride(
          reviewsWithLinks,
          heuristic.rubric?.categories || [],
          redactedFeedback
        );

        const minimumStandard = computeMinimumStandardFromReviews(reviewsWithOverride);
        const checklistSummary =
          fastResult.checklist_summary || summarizeCoverage(reviewsWithOverride);

        const titleById = new Map(
          (heuristic.rubric?.categories || []).map((category) => [
            category.id,
            category.title,
          ])
        );

        const improvedDraft = buildImprovedDraft(
          redactedFeedback,
          reviewsWithOverride,
          titleById
        );

        return {
          analysis_version: AI_FAST_VERSION,
          redaction_applied: true,
          redacted_feedback: redactedFeedback,
          minimum_standard_met: minimumStandard.met,
          minimum_standard_label: minimumStandard.label,
          checklist_summary: checklistSummary,
          rubric: heuristic.rubric,
          category_reviews: reviewsWithOverride,
          improved_feedback_draft: improvedDraft,
        };
      }

      const aiResult = await analyzeWithOpenAI({
        rubricText: redactedRubric,
        feedbackText: redactedFeedback,
        submissionText: redactedSubmission,
        evidenceEnabled,
        rubricStructure,
        apiKey: process.env.OPENAI_API_KEY,
        extraInstructions,
      });

      return buildAnalysisFromAIResult({
        aiResult,
        redactedFeedback,
        rubricStructure,
      });
    } catch (error) {
      const fallback = analyzeFeedbackHeuristic({
        rubricText: redactedRubric,
        feedbackText: redactedFeedback,
        submissionText: redactedSubmission,
        criteriaOverride,
      });
      return { ...fallback, ai_error: error?.message || "AI analysis failed." };
    }
  }

  return analyzeFeedbackHeuristic({
    rubricText: redactedRubric,
    feedbackText: redactedFeedback,
    submissionText: redactedSubmission,
    criteriaOverride,
  });
}

function buildAnalysisFromAIResult({ aiResult, redactedFeedback, rubricStructure }) {
  const categories = rubricStructure?.categories?.length
    ? rubricStructure.categories
    : aiResult.rubric?.categories || [];

  const reviewsById = new Map(
    (aiResult.category_reviews || []).map((review) => [
      review.category_id,
      review,
    ])
  );

  const normalizedReviews = categories.map((category) => {
    const review = reviewsById.get(category.id) || {
      category_id: category.id,
      coverage_status: "missing",
      subcriteria_reviews: [],
      marker_feedback_assessment: "",
      issues: ["not_rubric_linked"],
      linked_feedback_snippets: [],
      ai_feedback: { text: "", rationale: "", evidence_quote: "" },
    };
    const subById = new Map(
      (review.subcriteria_reviews || []).map((sub) => [
        sub.subcriterion_id,
        sub.coverage_status,
      ])
    );
    const normalizedSub = (category.subcriteria || []).map((sub) => ({
      subcriterion_id: sub.id,
      coverage_status: subById.get(sub.id) || "missing",
    }));
    return { ...review, subcriteria_reviews: normalizedSub };
  });

  const reviewsWithLinks = attachLinkedSnippets(
    normalizedReviews,
    categories,
    redactedFeedback
  );
  const reviewsWithOverride = applyExplicitFeedbackOverride(
    reviewsWithLinks,
    categories,
    redactedFeedback
  );

  const minimumStandard = computeMinimumStandardFromReviews(reviewsWithOverride);
  const checklistSummary = summarizeCoverage(reviewsWithOverride);

  return {
    analysis_version: AI_ANALYSIS_VERSION,
    redaction_applied: true,
    redacted_feedback: redactedFeedback,
    minimum_standard_met: minimumStandard.met,
    minimum_standard_label: minimumStandard.label,
    checklist_summary: aiResult.checklist_summary || checklistSummary,
    rubric: { categories },
    category_reviews: reviewsWithOverride,
    improved_feedback_draft: aiResult.improved_feedback_draft || "",
  };
}

function buildAnalysisFromTextFast({
  textOutput,
  rubricText,
  feedbackText,
  criteriaOverride,
}) {
  const heuristic = analyzeFeedbackHeuristic({
    rubricText,
    feedbackText,
    submissionText: "",
    criteriaOverride,
  });

  const textById = parseTextFastOutput(textOutput);

  const mergedReviews = (heuristic.category_reviews || []).map((review) => {
    const text = textById.get(review.category_id);
    if (!text) return review;
    let evidenceQuote = "";
    const quoted =
      text.match(/“[^”]+”\s*\[P\d+\]/) ||
      text.match(/\"[^\"]+\"\s*\[P\d+\]/);
    if (quoted) {
      evidenceQuote = quoted[0];
    } else if (text.includes("[P")) {
      evidenceQuote = text;
    }
    return {
      ...review,
      ai_feedback: {
        text,
        rationale: review.ai_feedback.rationale || "",
        evidence_quote: evidenceQuote,
      },
    };
  });

  const reviewsWithLinks = attachLinkedSnippets(
    mergedReviews,
    heuristic.rubric?.categories || [],
    feedbackText
  );
  const reviewsWithOverride = applyExplicitFeedbackOverride(
    reviewsWithLinks,
    heuristic.rubric?.categories || [],
    feedbackText
  );

  const minimumStandard = computeMinimumStandardFromReviews(reviewsWithOverride);
  const checklistSummary = summarizeCoverage(reviewsWithOverride);

  const titleById = new Map(
    (heuristic.rubric?.categories || []).map((category) => [
      category.id,
      category.title,
    ])
  );

  const improvedDraft = buildImprovedDraft(
    feedbackText,
    reviewsWithOverride,
    titleById
  );

  return {
    analysis_version: AI_ULTRA_VERSION,
    redaction_applied: true,
    redacted_feedback: feedbackText,
    minimum_standard_met: minimumStandard.met,
    minimum_standard_label: minimumStandard.label,
    checklist_summary: checklistSummary,
    rubric: heuristic.rubric,
    category_reviews: reviewsWithOverride,
    improved_feedback_draft: improvedDraft,
  };
}

function buildAnalysisFromTextQuality({
  textOutput,
  rubricText,
  feedbackText,
  criteriaOverride,
}) {
  const rubricStructure = buildRubricStructure({
    rubricText,
    criteriaOverride,
  });
  const categories = rubricStructure.categories || [];
  const heuristic = analyzeFeedbackHeuristic({
    rubricText,
    feedbackText,
    submissionText: "",
    criteriaOverride,
  });
  const fallbackById = new Map(
    (heuristic.category_reviews || []).map((review) => [
      review.category_id,
      review,
    ])
  );
  const parsed = parseTextQualityOutput(textOutput);
  const parsedById = new Map(
    parsed.map((item) => [item.category_id, item])
  );

  const reviews = categories.map((category) => {
    const parsedReview = parsedById.get(category.id);
    const fallback = fallbackById.get(category.id);
    if (!parsedReview || !parsedReview.ai_feedback?.text) {
      return (
        fallback || {
          category_id: category.id,
          coverage_status: "missing",
          subcriteria_reviews: (category.subcriteria || []).map((sub) => ({
            subcriterion_id: sub.id,
            coverage_status: "missing",
          })),
          marker_feedback_assessment: "",
          issues: ["not_rubric_linked"],
          linked_feedback_snippets: [],
          ai_feedback: { text: "", rationale: "", evidence_quote: "" },
        }
      );
    }

    const evidenceFromText = extractEvidenceFromText(
      parsedReview.ai_feedback.text || ""
    );

    return {
      category_id: category.id,
      coverage_status: parsedReview.coverage_status || fallback?.coverage_status || "missing",
      subcriteria_reviews:
        fallback?.subcriteria_reviews ||
        (category.subcriteria || []).map((sub) => ({
          subcriterion_id: sub.id,
          coverage_status: "missing",
        })),
      marker_feedback_assessment:
        parsedReview.marker_feedback_assessment ||
        fallback?.marker_feedback_assessment ||
        "",
      issues: parsedReview.issues?.length
        ? parsedReview.issues
        : fallback?.issues || [],
      linked_feedback_snippets: [],
      ai_feedback: {
        text: parsedReview.ai_feedback.text || fallback?.ai_feedback?.text || "",
        rationale: "",
        evidence_quote:
          parsedReview.ai_feedback.evidence_quote ||
          evidenceFromText ||
          fallback?.ai_feedback?.evidence_quote ||
          "",
      },
    };
  });

  const reviewsWithLinks = attachLinkedSnippets(reviews, categories, feedbackText);
  const reviewsWithOverride = applyExplicitFeedbackOverride(
    reviewsWithLinks,
    categories,
    feedbackText
  );

  const minimumStandard = computeMinimumStandardFromReviews(reviewsWithOverride);
  const checklistSummary = summarizeCoverage(reviewsWithOverride);

  const titleById = new Map(
    categories.map((category) => [category.id, category.title])
  );

  const improvedDraft = buildImprovedDraft(
    feedbackText,
    reviewsWithOverride,
    titleById
  );

  return {
    analysis_version: AI_TEXT_VERSION,
    redaction_applied: true,
    redacted_feedback: feedbackText,
    minimum_standard_met: minimumStandard.met,
    minimum_standard_label: minimumStandard.label,
    checklist_summary: checklistSummary,
    rubric: { categories },
    category_reviews: reviewsWithOverride,
    improved_feedback_draft: improvedDraft,
  };
}

function buildAnalysisFromParallelResult({
  parallelResult,
  rubricText,
  feedbackText,
  submissionText,
  criteriaOverride,
}) {
  const rubricStructure = buildRubricStructure({
    rubricText,
    criteriaOverride,
  });
  const categories =
    parallelResult?.categories?.length
      ? parallelResult.categories
      : rubricStructure.categories || [];

  const heuristic = analyzeFeedbackHeuristic({
    rubricText,
    feedbackText,
    submissionText: "",
    criteriaOverride,
  });
  const fallbackById = new Map(
    (heuristic.category_reviews || []).map((review) => [
      review.category_id,
      review,
    ])
  );

  const resultById = new Map(
    (parallelResult?.category_results || []).map((entry) => [
      entry.category?.id,
      entry,
    ])
  );

  const reviews = categories.map((category) => {
    const fallback = fallbackById.get(category.id) || {
      category_id: category.id,
      coverage_status: "missing",
      subcriteria_reviews: (category.subcriteria || []).map((sub) => ({
        subcriterion_id: sub.id,
        coverage_status: "missing",
      })),
      marker_feedback_assessment: "",
      issues: ["not_rubric_linked"],
      linked_feedback_snippets: [],
      ai_feedback: { text: "", rationale: "", evidence_quote: "" },
    };

    const entry = resultById.get(category.id);
    const result = entry?.result;
    if (!result || entry?.error) {
      return fallback;
    }

    const aiText =
      (result.ai_feedback?.text || "").trim() ||
      fallback.ai_feedback?.text ||
      "";
    const evidenceQuote =
      (result.ai_feedback?.evidence_quote || "").trim() ||
      extractEvidenceFromText(aiText) ||
      fallback.ai_feedback?.evidence_quote ||
      pickEvidenceQuote(submissionText || "", category) ||
      "";
    const evidenceValid =
      /\[P\d+\]/.test(evidenceQuote) && !evidenceQuote.includes("[P#]");
    const finalEvidence = evidenceValid
      ? evidenceQuote
      : pickEvidenceQuote(submissionText || "", category) || evidenceQuote;
    let finalText = isLowQualityDraft(aiText)
      ? buildLocalDraft(category, finalEvidence)
      : aiText;
    finalText = sanitizeStudentFeedback(finalText);

    return {
      category_id: category.id,
      coverage_status: result.coverage_status || fallback.coverage_status || "missing",
      subcriteria_reviews: buildSubcriteriaReviewsFromText(
        category,
        finalText,
        fallback.subcriteria_reviews
      ),
      marker_feedback_assessment:
        result.marker_feedback_assessment ||
        fallback.marker_feedback_assessment ||
        "",
      issues: Array.isArray(result.issues) && result.issues.length
        ? result.issues
        : fallback.issues || [],
      linked_feedback_snippets: [],
      ai_feedback: {
        text: finalText,
        rationale: "",
        evidence_quote: finalEvidence,
      },
    };
  });

  const reviewsWithLinks = attachLinkedSnippets(reviews, categories, feedbackText);
  const reviewsWithOverride = applyExplicitFeedbackOverride(
    reviewsWithLinks,
    categories,
    feedbackText
  );

  const minimumStandard = computeMinimumStandardFromReviews(reviewsWithOverride);
  const checklistSummary = summarizeCoverage(reviewsWithOverride);

  const titleById = new Map(
    categories.map((category) => [category.id, category.title])
  );

  const improvedDraft = buildImprovedDraft(
    feedbackText,
    reviewsWithOverride,
    titleById
  );

  return {
    analysis_version: AI_PARALLEL_VERSION,
    redaction_applied: true,
    redacted_feedback: feedbackText,
    minimum_standard_met: minimumStandard.met,
    minimum_standard_label: minimumStandard.label,
    checklist_summary: checklistSummary,
    rubric: { categories },
    category_reviews: reviewsWithOverride,
    improved_feedback_draft: improvedDraft,
  };
}

module.exports = {
  analyzeFeedback,
  analyzeWithOpenAIStream,
  buildAnalysisFromAIResult,
  buildRubricStructure,
  buildAnalysisFromTextFast,
  buildAnalysisFromTextQuality,
  buildAnalysisFromParallelResult,
};
