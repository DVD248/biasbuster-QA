const path = require("path");
const crypto = require("crypto");
const express = require("express");
const multer = require("multer");

const {
  analyzeFeedback,
  analyzeWithOpenAIStream,
  buildAnalysisFromAIResult,
  buildRubricStructure,
  buildAnalysisFromTextFast,
  buildAnalysisFromTextQuality,
  buildAnalysisFromParallelResult,
} = require("./analyze");
const { extractTextFromFile } = require("./parse");
const { writeEvent } = require("./audit");
const { hashText } = require("./utils");
const { redactPII } = require("./pii");
const {
  analyzeWithOpenAITextFastStream,
  analyzeWithOpenAITextQualityStream,
  analyzeWithOpenAIParallel,
} = require("./openai");

const AI_MODE = process.env.AI_MODE || "parallel";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

function parseExtraInstructions(body) {
  if (!body) return null;
  const raw =
    body.extraInstructions ||
    body.prompt_additions ||
    body.promptAdditions ||
    body.promptInstructions;
  if (!raw) return null;
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "string") return raw;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    return trimmed;
  }
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.post(
  "/api/analyze",
  upload.fields([
    { name: "submissionFile", maxCount: 1 },
    { name: "rubricFile", maxCount: 1 },
    { name: "feedbackFile", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const files = req.files || {};
      const rubricFile = files.rubricFile ? files.rubricFile[0] : null;
      const submissionFile = files.submissionFile
        ? files.submissionFile[0]
        : null;
      const feedbackFile = files.feedbackFile ? files.feedbackFile[0] : null;

      const rubricText =
        req.body.rubricText || (await extractTextFromFile(rubricFile));
      const feedbackText =
        req.body.feedbackText || (await extractTextFromFile(feedbackFile));
      const submissionText =
        req.body.submissionText || (await extractTextFromFile(submissionFile));

      if (!rubricText || !feedbackText) {
        return res.status(400).json({
          error: "Rubric and feedback are required to analyze feedback quality.",
        });
      }

      const evidenceEnabled =
        req.body.evidenceEnabled === "true" || req.body.evidenceEnabled === true;
      const localOnly =
        req.body.localOnly === "true" || req.body.localOnly === true;

      let criteriaOverride = null;
      if (req.body.criteriaOverride) {
        try {
          criteriaOverride = JSON.parse(req.body.criteriaOverride);
        } catch (error) {
          criteriaOverride = null;
        }
      }

      const extraInstructions = parseExtraInstructions(req.body);

      const analysis = await analyzeFeedback({
        rubricText,
        feedbackText,
        submissionText,
        evidenceEnabled,
        criteriaOverride,
        useAI: !localOnly,
        extraInstructions,
      });

      const sessionId = crypto.randomUUID
        ? crypto.randomUUID()
        : crypto.randomBytes(16).toString("hex");

      const issueCount = (analysis.category_reviews || []).reduce(
        (total, review) => total + (review.issues || []).length,
        0
      );

      writeEvent({
        type: "analyze",
        session_id: sessionId,
        rubric_hash: hashText(rubricText),
        submission_hash: hashText(submissionText),
        feedback_hash: hashText(feedbackText),
        criteria_count: (analysis.rubric?.categories || []).length,
        issue_count: issueCount,
        analysis_version: analysis.analysis_version,
        prompt_version: analysis.analysis_version,
        local_only: localOnly,
        evidence_enabled: evidenceEnabled,
      });

      return res.json({
        session_id: sessionId,
        ...analysis,
      });
    } catch (error) {
      return res.status(500).json({
        error:
          error?.message ||
          "Analysis failed. Please check the inputs or try manual rubric entry.",
      });
    }
  }
);

app.post(
  "/api/analyze-stream",
  upload.fields([
    { name: "submissionFile", maxCount: 1 },
    { name: "rubricFile", maxCount: 1 },
    { name: "feedbackFile", maxCount: 1 },
  ]),
  async (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    if (res.flushHeaders) res.flushHeaders();

    const sendEvent = (event, payload) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    try {
      sendEvent("status", { step: "Reading inputs" });
      const files = req.files || {};
      const rubricFile = files.rubricFile ? files.rubricFile[0] : null;
      const submissionFile = files.submissionFile
        ? files.submissionFile[0]
        : null;
      const feedbackFile = files.feedbackFile ? files.feedbackFile[0] : null;

      sendEvent("status", { step: "Extracting inputs" });
      const rubricPromise = req.body.rubricText
        ? Promise.resolve(req.body.rubricText)
        : extractTextFromFile(rubricFile);
      const feedbackPromise = req.body.feedbackText
        ? Promise.resolve(req.body.feedbackText)
        : extractTextFromFile(feedbackFile);
      const getSubmissionText = () =>
        req.body.submissionText
          ? Promise.resolve(req.body.submissionText)
          : extractTextFromFile(submissionFile);

      const [rubricText, feedbackText] = await Promise.all([
        rubricPromise,
        feedbackPromise,
      ]);

      if (!rubricText || !feedbackText) {
        sendEvent("error", {
          message:
            "Rubric and feedback are required to analyze feedback quality.",
        });
        return res.end();
      }

      const evidenceEnabled =
        req.body.evidenceEnabled === "true" || req.body.evidenceEnabled === true;
      const localOnly =
        req.body.localOnly === "true" || req.body.localOnly === true;

      let criteriaOverride = null;
      if (req.body.criteriaOverride) {
        try {
          criteriaOverride = JSON.parse(req.body.criteriaOverride);
        } catch (error) {
          criteriaOverride = null;
        }
      }

      const extraInstructions = parseExtraInstructions(req.body);

      if (!localOnly) {
        try {
          sendEvent("status", { step: "Generating quick preview" });
          const preview = await analyzeFeedback({
            rubricText,
            feedbackText,
            submissionText: "",
            evidenceEnabled: false,
            criteriaOverride,
            useAI: false,
            extraInstructions,
          });
          if (preview?.improved_feedback_draft) {
            sendEvent("delta", {
              delta: preview.improved_feedback_draft,
              preview: true,
            });
          }
        } catch (error) {
          // Preview is optional; continue to full analysis.
        }
      }

      if (localOnly) {
        sendEvent("status", { step: "Running local-only analysis" });
        const submissionText = await getSubmissionText();
        const analysis = await analyzeFeedback({
          rubricText,
          feedbackText,
          submissionText,
          evidenceEnabled,
          criteriaOverride,
          useAI: false,
          extraInstructions,
        });

        const sessionId = crypto.randomUUID
          ? crypto.randomUUID()
          : crypto.randomBytes(16).toString("hex");

        const issueCount = (analysis.category_reviews || []).reduce(
          (total, review) => total + (review.issues || []).length,
          0
        );

        writeEvent({
          type: "analyze",
          session_id: sessionId,
          rubric_hash: hashText(rubricText),
          submission_hash: hashText(submissionText),
          feedback_hash: hashText(feedbackText),
          criteria_count: (analysis.rubric?.categories || []).length,
          issue_count: issueCount,
          analysis_version: analysis.analysis_version,
          prompt_version: analysis.analysis_version,
          local_only: true,
          evidence_enabled: evidenceEnabled,
        });

        sendEvent("final", { session_id: sessionId, ...analysis });
        return res.end();
      }

      if (!process.env.OPENAI_API_KEY) {
        sendEvent("error", {
          message:
            "OpenAI API key is missing. Set OPENAI_API_KEY to enable AI analysis.",
        });
        return res.end();
      }

      sendEvent("status", { step: "Redacting sensitive info" });
      const redactedRubric = redactPII(rubricText);
      const redactedFeedback = redactPII(feedbackText);
      const rubricStructure = buildRubricStructure({
        rubricText: redactedRubric,
        criteriaOverride,
      });

      let analysis;
      let submissionText = "";
      let heartbeat = null;
      const startHeartbeat = () => {
        if (heartbeat) return;
        heartbeat = setInterval(() => {
          sendEvent("status", { step: "Waiting for AI response…" });
        }, 4000);
      };
      const stopHeartbeat = () => {
        if (heartbeat) {
          clearInterval(heartbeat);
          heartbeat = null;
        }
      };
      try {
        sendEvent("status", { step: "Extracting submission" });
        submissionText = await getSubmissionText();
        const redactedSubmission = redactPII(submissionText || "");

        if (AI_MODE === "parallel") {
          sendEvent("status", { step: "Generating category drafts" });
          let streamStarted = false;
          let completed = 0;
          const total = rubricStructure?.categories?.length || 0;
          startHeartbeat();

          const parallelResult = await analyzeWithOpenAIParallel({
            rubricText: redactedRubric,
            feedbackText: redactedFeedback,
            submissionText: redactedSubmission,
            evidenceEnabled,
            rubricStructure,
            apiKey: process.env.OPENAI_API_KEY,
            extraInstructions,
            onCategory: (category, result, error) => {
              completed += 1;
              if (result && !streamStarted) {
                sendEvent("status", { step: "Receiving AI output" });
                streamStarted = true;
                stopHeartbeat();
              }
              if (total) {
                sendEvent("status", {
                  step: `Received ${completed}/${total} categories`,
                });
              }
              if (result?.ai_feedback?.text) {
                const block = `${category.title}:\n${result.ai_feedback.text}\n\n`;
                sendEvent("delta", { delta: block, preview: false });
              }
              if (error) {
                sendEvent("status", {
                  step: `Category ${category.title} used fallback`,
                });
              }
            },
          });
          stopHeartbeat();

          analysis = buildAnalysisFromParallelResult({
            parallelResult,
            rubricText: redactedRubric,
            feedbackText: redactedFeedback,
            submissionText: redactedSubmission,
            criteriaOverride,
          });
        } else if (AI_MODE === "quality") {
          sendEvent("status", { step: "Streaming AI output" });
          let streamStarted = false;
          startHeartbeat();
          const { sanitized } = await analyzeWithOpenAIStream({
            rubricText: redactedRubric,
            feedbackText: redactedFeedback,
            submissionText: redactedSubmission,
            evidenceEnabled,
            rubricStructure,
            apiKey: process.env.OPENAI_API_KEY,
            extraInstructions,
            onDelta: (delta) => {
              if (!streamStarted) {
                sendEvent("status", { step: "Receiving AI output" });
                streamStarted = true;
                stopHeartbeat();
              }
              sendEvent("delta", { delta, preview: false });
            },
          });

          analysis = buildAnalysisFromAIResult({
            aiResult: sanitized,
            redactedFeedback,
            rubricStructure,
          });
          stopHeartbeat();
        } else if (AI_MODE === "text_quality") {
          sendEvent("status", { step: "Preparing evidence + digest" });
          sendEvent("status", { step: "Streaming AI output" });
          let streamStarted = false;
          startHeartbeat();
          const textOutput = await analyzeWithOpenAITextQualityStream({
            rubricText: redactedRubric,
            feedbackText: redactedFeedback,
            submissionText: redactedSubmission,
            evidenceEnabled,
            rubricStructure,
            apiKey: process.env.OPENAI_API_KEY,
            extraInstructions,
            onDelta: (delta) => {
              if (!streamStarted) {
                sendEvent("status", { step: "Receiving AI output" });
                streamStarted = true;
                stopHeartbeat();
              }
              sendEvent("delta", { delta, preview: false });
            },
          });
          stopHeartbeat();

          analysis = buildAnalysisFromTextQuality({
            textOutput,
            rubricText: redactedRubric,
            feedbackText: redactedFeedback,
            criteriaOverride,
          });
        } else {
          sendEvent("status", { step: "Streaming AI output" });
          let streamStarted = false;
          startHeartbeat();
          const textOutput = await analyzeWithOpenAITextFastStream({
            rubricText: redactedRubric,
            feedbackText: redactedFeedback,
            submissionText: redactedSubmission,
            evidenceEnabled,
            rubricStructure,
            apiKey: process.env.OPENAI_API_KEY,
            extraInstructions,
            onDelta: (delta) => {
              if (!streamStarted) {
                sendEvent("status", { step: "Receiving AI output" });
                streamStarted = true;
                stopHeartbeat();
              }
              sendEvent("delta", { delta, preview: false });
            },
          });
          stopHeartbeat();

          analysis = buildAnalysisFromTextFast({
            textOutput,
            rubricText: redactedRubric,
            feedbackText: redactedFeedback,
            criteriaOverride,
          });
        }
      } catch (error) {
        stopHeartbeat();
        try {
          sendEvent("status", { step: "Retrying AI analysis" });
          const aiResult = await analyzeFeedback({
            rubricText,
            feedbackText,
            submissionText,
            evidenceEnabled,
            criteriaOverride,
            useAI: true,
            extraInstructions,
          });
          analysis = aiResult;
        } catch (fallbackError) {
          sendEvent("status", { step: "Using local fallback" });
          const fallback = await analyzeFeedback({
            rubricText,
            feedbackText,
            submissionText,
            evidenceEnabled,
            criteriaOverride,
            useAI: false,
            extraInstructions,
          });
          analysis = {
            ...fallback,
            ai_error:
              fallbackError?.message ||
              error?.message ||
              "AI analysis failed.",
          };
        }
      }

      const sessionId = crypto.randomUUID
        ? crypto.randomUUID()
        : crypto.randomBytes(16).toString("hex");

      const issueCount = (analysis.category_reviews || []).reduce(
        (total, review) => total + (review.issues || []).length,
        0
      );

      writeEvent({
        type: "analyze",
        session_id: sessionId,
        rubric_hash: hashText(rubricText),
        submission_hash: hashText(submissionText),
        feedback_hash: hashText(feedbackText),
        criteria_count: (analysis.rubric?.categories || []).length,
        issue_count: issueCount,
        analysis_version: analysis.analysis_version,
        prompt_version: analysis.analysis_version,
        local_only: false,
        evidence_enabled: evidenceEnabled,
      });

      sendEvent("final", { session_id: sessionId, ...analysis });
      return res.end();
    } catch (error) {
      sendEvent("error", {
        message:
          error?.message ||
          "Analysis failed. Please check the inputs or try manual rubric entry.",
      });
      return res.end();
    }
  }
);

app.post("/api/finalize", (req, res) => {
  const {
    session_id: sessionId,
    accepted_count: acceptedCount,
    rejected_count: rejectedCount,
    edited_count: editedCount,
    export_format: exportFormat,
  } = req.body || {};

  if (!sessionId) {
    return res.status(400).json({ error: "session_id is required." });
  }

  writeEvent({
    type: "finalize",
    session_id: sessionId,
    accepted_count: Number(acceptedCount) || 0,
    rejected_count: Number(rejectedCount) || 0,
    edited_count: Number(editedCount) || 0,
    export_format: exportFormat || "unknown",
  });

  return res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Feedback QA server running on http://localhost:${PORT}`);
});
