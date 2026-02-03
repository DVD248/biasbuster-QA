const form = document.getElementById("analyze-form");
const statusEl = document.getElementById("status");
const reportEl = document.getElementById("report");
const summaryEl = document.getElementById("summary");
const aiDraftEl = document.getElementById("ai-draft");
const aiDraftStatusEl = document.getElementById("ai-draft-status");
const finalFeedbackEl = document.getElementById("final-feedback");
const confirmBtn = document.getElementById("confirm-final");
const copyBtn = document.getElementById("copy-btn");
const downloadBtn = document.getElementById("download-btn");
const minimumStandardEl = document.getElementById("minimum-standard");
const categoryBoard = document.getElementById("category-board");
const useAllBtn = document.getElementById("use-all-btn");
const clearAllBtn = document.getElementById("clear-all-btn");
const loadingEl = document.getElementById("loading");
const loadingTextEl = document.getElementById("loadingText");
const loadingStepEl = document.getElementById("loadingStep");
const loadingElapsedEl = document.getElementById("loadingElapsed");

const ISSUE_LABELS = {
  not_rubric_linked: "Not linked to rubric",
  missing_action: "Missing action",
  vagueness: "Vague phrasing",
};

const COVERAGE_LABELS = {
  addressed: "Addressed",
  partial: "Partial",
  missing: "Missing",
};

const COVERAGE_BADGES = {
  addressed: "ok",
  partial: "partial",
  missing: "warn",
};

const WHY_THIS_MATTERS =
  "Students frequently report dissatisfaction when this is unclear.";

const state = {
  sessionId: null,
  categories: [],
  originalFeedback: "",
  confirmed: false,
  manualOverride: false,
};

let loadingTimeout = null;
let lastStatusAt = null;
let loadingStartAt = null;
let loadingInterval = null;

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? "#c84d3b" : "";
}

function showLoading() {
  loadingEl.classList.remove("hidden");
  loadingTextEl.textContent = "Analyzing feedback quality…";
  loadingStepEl.textContent = "Waiting for analysis to start…";
  lastStatusAt = Date.now();
  loadingStartAt = Date.now();
  if (loadingElapsedEl) {
    loadingElapsedEl.textContent = "0.0s elapsed";
  }
  if (loadingInterval) clearInterval(loadingInterval);
  loadingInterval = setInterval(() => {
    if (!loadingStartAt || !loadingElapsedEl) return;
    const elapsed = (Date.now() - loadingStartAt) / 1000;
    loadingElapsedEl.textContent = `${elapsed.toFixed(1)}s elapsed`;
  }, 250);
  if (aiDraftStatusEl) {
    aiDraftStatusEl.textContent = "Awaiting analysis.";
  }

  if (loadingTimeout) clearTimeout(loadingTimeout);

  loadingTimeout = setTimeout(() => {
    loadingTextEl.textContent = "Still working…";
    if (!lastStatusAt || Date.now() - lastStatusAt > 4000) {
      loadingStepEl.textContent =
        "Waiting for the AI response (evidence can take longer).";
    }
  }, 5000);
}

function hideLoading() {
  loadingEl.classList.add("hidden");
  if (loadingTimeout) clearTimeout(loadingTimeout);
  if (loadingInterval) clearInterval(loadingInterval);
  loadingInterval = null;
}

function renderMinimumStandard(label, met) {
  const prefix = met ? "✓ " : "! ";
  minimumStandardEl.textContent = `${prefix}${label}`;
  minimumStandardEl.className = `minimum-standard ${met ? "ok" : "warn"}`;
}

function buildIssueBadges(issues) {
  const wrapper = document.createElement("div");
  wrapper.className = "issue-list";

  if (!issues.length) {
    const empty = document.createElement("span");
    empty.className = "suggestion-meta";
    empty.textContent = "No issues flagged.";
    wrapper.appendChild(empty);
    return wrapper;
  }

  issues.forEach((issue) => {
    const badge = document.createElement("span");
    badge.className = "issue-badge";
    badge.textContent = ISSUE_LABELS[issue] || issue;

    const info = document.createElement("span");
    info.className = "info-icon";
    info.textContent = "i";
    info.title = WHY_THIS_MATTERS;
    badge.appendChild(info);
    wrapper.appendChild(badge);
  });

  return wrapper;
}

function buildFormData() {
  const formData = new FormData();
  const rubricText = document.getElementById("rubricText").value.trim();
  const submissionText = document.getElementById("submissionText").value.trim();
  const feedbackText = document.getElementById("feedbackText").value.trim();

  const rubricFile = document.getElementById("rubricFile").files[0];
  const submissionFile = document.getElementById("submissionFile").files[0];
  const feedbackFile = document.getElementById("feedbackFile").files[0];

  if (rubricText) formData.append("rubricText", rubricText);
  if (submissionText) formData.append("submissionText", submissionText);
  if (feedbackText) formData.append("feedbackText", feedbackText);

  if (rubricFile) formData.append("rubricFile", rubricFile);
  if (submissionFile) formData.append("submissionFile", submissionFile);
  if (feedbackFile) formData.append("feedbackFile", feedbackFile);

  const evidenceEnabled = document.getElementById("evidenceEnabled").checked;
  const localOnly = document.getElementById("localOnly").checked;

  formData.append("evidenceEnabled", evidenceEnabled);
  formData.append("localOnly", localOnly);

  const criteriaOverrideRaw = document
    .getElementById("criteriaOverride")
    .value.trim();
  if (criteriaOverrideRaw) {
    const lines = criteriaOverrideRaw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const override = lines.map((line, index) => ({
      id: `manual-${index + 1}`,
      title: line,
      description: "",
    }));
    formData.append("criteriaOverride", JSON.stringify(override));
  }

  state.originalFeedback = feedbackText;
  state.manualOverride = false;
  return formData;
}

function updateFinalFeedback(force = false) {
  if (state.manualOverride && !force) return;
  const selected = state.categories.filter((category) => category.selected);
  let finalText = state.originalFeedback.trim();
  if (selected.length) {
    const additions = selected
      .map(
        (category) => `${category.title}:\n${category.draftText.trim()}`
      )
      .join("\n\n");
    finalText = `${finalText}\n\nAI-assisted category feedback:\n\n${additions}`.trim();
  }
  finalFeedbackEl.value = finalText;
}

function renderCategories() {
  categoryBoard.innerHTML = "";

  if (!state.categories.length) {
    const empty = document.createElement("p");
    empty.textContent = "No rubric categories were generated.";
    categoryBoard.appendChild(empty);
    return;
  }

  state.categories.forEach((category) => {
    const card = document.createElement("div");
    card.className = "category-card";

    const header = document.createElement("div");
    header.className = "category-header";

    const title = document.createElement("strong");
    title.textContent = category.title;

    const badge = document.createElement("span");
    const coverageStatus = category.review.coverage_status || "missing";
    badge.className = `badge ${COVERAGE_BADGES[coverageStatus] || "warn"}`;
    badge.textContent = COVERAGE_LABELS[coverageStatus] || "Missing";

    header.appendChild(title);
    header.appendChild(badge);

    const description = document.createElement("div");
    description.className = "suggestion-meta";
    description.textContent = category.description || "";

    const issues = buildIssueBadges(category.review.issues || []);

    const assessment = document.createElement("div");
    assessment.className = "suggestion-meta";
    assessment.textContent = category.review.marker_feedback_assessment || "";

    const subcriteria = document.createElement("div");
    subcriteria.className = "subcriteria";
    subcriteria.textContent = "Subcriteria";

    const subList = document.createElement("div");
    subList.className = "subcriteria-list";
    const subStatusMap = new Map(
      (category.review.subcriteria_reviews || []).map((sub) => [
        sub.subcriterion_id,
        sub.coverage_status,
      ])
    );
    if (category.subcriteria.length) {
      category.subcriteria.forEach((sub) => {
        const item = document.createElement("div");
        item.className = "subcriterion-item";

        const badge = document.createElement("span");
        const status = subStatusMap.get(sub.id) || "missing";
        badge.className = `subcriterion-badge ${COVERAGE_BADGES[status] || "warn"}`;
        badge.textContent = COVERAGE_LABELS[status] || "Missing";

        const label = document.createElement("span");
        label.textContent = sub.title;

        item.appendChild(badge);
        item.appendChild(label);
        subList.appendChild(item);
      });
    } else {
      const item = document.createElement("div");
      item.textContent = "No subcriteria listed.";
      subList.appendChild(item);
    }

    const linked = document.createElement("div");
    linked.className = "linked-feedback";
    if (category.review.linked_feedback_snippets?.length) {
      linked.innerHTML = "<strong>Linked marker feedback</strong>";
      category.review.linked_feedback_snippets.forEach((snippet) => {
        const snippetEl = document.createElement("div");
        snippetEl.className = "snippet";
        snippetEl.textContent = `“${snippet}”`;
        linked.appendChild(snippetEl);
      });
    } else {
      linked.innerHTML =
        "<strong>Linked marker feedback</strong><div class=\"snippet\">No linked feedback found.</div>";
    }

    const aiFeedback = document.createElement("div");
    aiFeedback.className = "ai-feedback";

    const aiLabel = document.createElement("div");
    aiLabel.className = "suggestion-meta";
    aiLabel.textContent = "AI draft student feedback (editable)";

    const rationale = document.createElement("div");
    rationale.className = "suggestion-meta";
    rationale.textContent = category.review.ai_feedback?.rationale || "";

    const textarea = document.createElement("textarea");
    textarea.value = category.draftText;
    textarea.addEventListener("input", (event) => {
      category.draftText = event.target.value;
      if (category.selected) {
        updateFinalFeedback();
      }
    });

    aiFeedback.appendChild(aiLabel);
    if (rationale.textContent) {
      aiFeedback.appendChild(rationale);
    }
    aiFeedback.appendChild(textarea);

    const evidence = category.review.ai_feedback?.evidence_quote;
    if (evidence) {
      const evidenceEl = document.createElement("div");
      evidenceEl.className = "evidence";
      evidenceEl.textContent = `Evidence: ${evidence}`;
      aiFeedback.appendChild(evidenceEl);
    }

    const actions = document.createElement("div");
    actions.className = "category-actions";

    const useBtn = document.createElement("button");
    useBtn.textContent = category.selected ? "Remove from final feedback" : "Use this draft";
    useBtn.addEventListener("click", () => {
      category.selected = !category.selected;
      state.manualOverride = false;
      renderCategories();
      updateFinalFeedback();
    });

    actions.appendChild(useBtn);

    card.appendChild(header);
    if (category.description) card.appendChild(description);
    if (assessment.textContent) card.appendChild(assessment);
    card.appendChild(issues);
    card.appendChild(subcriteria);
    card.appendChild(subList);
    card.appendChild(linked);
    card.appendChild(aiFeedback);
    card.appendChild(actions);

    categoryBoard.appendChild(card);
  });
}

function computeCounts() {
  const selected = state.categories.filter((category) => category.selected);
  const edited = selected.filter(
    (category) => category.draftText.trim() !== category.originalText.trim()
  );
  return {
    accepted: selected.length,
    rejected: Math.max(state.categories.length - selected.length, 0),
    edited: edited.length,
  };
}

async function logFinalize(exportFormat) {
  if (!state.sessionId) return;
  const counts = computeCounts();
  await fetch("/api/finalize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_id: state.sessionId,
      accepted_count: counts.accepted,
      rejected_count: counts.rejected,
      edited_count: counts.edited,
      export_format: exportFormat,
    }),
  });
}

useAllBtn.addEventListener("click", () => {
  state.categories.forEach((category) => {
    const status = category.review.coverage_status || "missing";
    category.selected = status !== "addressed";
  });
  state.manualOverride = false;
  renderCategories();
  updateFinalFeedback();
});

clearAllBtn.addEventListener("click", () => {
  state.categories.forEach((category) => {
    category.selected = false;
  });
  state.manualOverride = false;
  renderCategories();
  updateFinalFeedback();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  setStatus("Analyzing feedback quality...");
  showLoading();

  confirmBtn.disabled = true;
  copyBtn.disabled = true;
  downloadBtn.disabled = true;
  state.confirmed = false;

  try {
    const formData = buildFormData();
    const response = await fetch("/api/analyze-stream", {
      method: "POST",
      body: formData,
    });

    if (!response.ok || !response.body) {
      throw new Error("Analysis failed.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let streamedPreviewText = "";
    let streamedMainText = "";
    let finalData = null;
    let streamError = null;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let index;
      while ((index = buffer.indexOf("\n\n")) !== -1) {
        const chunk = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const lines = chunk.split("\n").filter(Boolean);
        let eventType = "message";
        const dataLines = [];
        lines.forEach((line) => {
          if (line.startsWith("event:")) {
            eventType = line.replace("event:", "").trim();
          } else if (line.startsWith("data:")) {
            dataLines.push(line.replace(/^data:\s?/, ""));
          }
        });
        if (!dataLines.length) continue;
        const dataStr = dataLines.join("\n");
        let payload;
        try {
          payload = JSON.parse(dataStr);
        } catch (error) {
          continue;
        }

        if (eventType === "delta") {
          if (payload.delta) {
            if (payload.preview) {
              streamedPreviewText += payload.delta;
              aiDraftEl.textContent = streamedPreviewText;
              loadingStepEl.textContent = "Streaming draft preview…";
              if (aiDraftStatusEl) {
                aiDraftStatusEl.textContent =
                  "Quick preview (evidence pending) — full analysis running.";
              }
            } else {
              streamedMainText += payload.delta;
              aiDraftEl.textContent = streamedMainText;
              loadingStepEl.textContent = "Streaming AI output…";
              if (aiDraftStatusEl) {
                aiDraftStatusEl.textContent = "Streaming full AI draft…";
              }
            }
            lastStatusAt = Date.now();
          }
        } else if (eventType === "status") {
          if (payload.step) {
            loadingStepEl.textContent = payload.step;
            lastStatusAt = Date.now();
          }
        } else if (eventType === "final") {
          finalData = payload;
        } else if (eventType === "error") {
          streamError = payload.message || "Analysis failed.";
        }
      }
    }

    if (!finalData) {
      throw new Error(streamError || "No final result received.");
    }

    const data = finalData;
    state.sessionId = data.session_id;
    if (!state.originalFeedback) {
      state.originalFeedback = data.redacted_feedback || "";
    }

    summaryEl.textContent = data.checklist_summary;
    renderMinimumStandard(
      data.minimum_standard_label || "Minimum standard status unavailable",
      Boolean(data.minimum_standard_met)
    );
    aiDraftEl.textContent = data.improved_feedback_draft || "";
    if (aiDraftStatusEl) {
      aiDraftStatusEl.textContent = "Full AI draft ready.";
    }

    const categories = data.rubric?.categories || [];
    const reviews = data.category_reviews || [];
    const reviewsById = new Map(
      reviews.map((review) => [review.category_id, review])
    );

    state.categories = categories.map((category) => {
      const review = reviewsById.get(category.id) || {
        coverage_status: "missing",
        issues: ["not_rubric_linked"],
        linked_feedback_snippets: [],
        ai_feedback: { text: "", rationale: "", evidence_quote: "" },
      };
      return {
        ...category,
        review,
        originalText: review.ai_feedback?.text || "",
        draftText: review.ai_feedback?.text || "",
        selected: review.coverage_status !== "addressed",
      };
    });

    renderCategories();
    updateFinalFeedback(true);

    reportEl.classList.remove("hidden");
    confirmBtn.disabled = false;
    confirmBtn.textContent = "Confirm & enable export";
    if (data.analysis_version && data.analysis_version.startsWith("heuristic")) {
      if (data.ai_error || streamError) {
        setStatus(
          `AI unavailable, used fallback. ${data.ai_error || streamError}`,
          true
        );
      } else {
        setStatus("Analysis complete (local-only fallback).");
      }
    } else if (streamError) {
      setStatus(`Analysis complete. ${streamError}`, true);
    } else {
      setStatus("Analysis complete.");
    }
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    hideLoading();
  }
});

finalFeedbackEl.addEventListener("input", () => {
  state.manualOverride = true;
});

confirmBtn.addEventListener("click", async () => {
  await logFinalize("confirm");
  state.confirmed = true;
  confirmBtn.textContent = "Confirmed";
  confirmBtn.disabled = true;
  copyBtn.disabled = false;
  downloadBtn.disabled = false;
});

copyBtn.addEventListener("click", async () => {
  await navigator.clipboard.writeText(finalFeedbackEl.value);
  await logFinalize("copy_to_clipboard");
  setStatus("Final feedback copied to clipboard.");
});

downloadBtn.addEventListener("click", async () => {
  const blob = new Blob([finalFeedbackEl.value], {
    type: "text/plain;charset=utf-8",
  });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "final-feedback.txt";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(link.href);
  await logFinalize("download_txt");
  setStatus("Final feedback downloaded.");
});
