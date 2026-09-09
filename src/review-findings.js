import { redactText } from "./redaction.js";

const actionableSeverities = new Set(["critical", "high", "medium", "blocking", "warning"]);

function similarFinding(left, right) {
  const leftCategory = String(left.category || "general").toLowerCase();
  const rightCategory = String(right.category || "general").toLowerCase();
  if (leftCategory !== rightCategory && leftCategory !== "tests" && rightCategory !== "tests") return false;
  const sharedSurfaces = (left.evidence || []).filter((leftEvidence) => (right.evidence || []).some((rightEvidence) =>
    leftEvidence.file && String(leftEvidence.file).toLowerCase() === String(rightEvidence.file || "").toLowerCase()
      && (!leftEvidence.line || !rightEvidence.line || Math.abs(leftEvidence.line - rightEvidence.line) <= 5)
  )).length;
  if (!sharedSurfaces) return false;
  const leftMechanism = `${left.claim || ""} ${left.suggestedFix || left.suggested_fix || ""}`;
  const rightMechanism = `${right.claim || ""} ${right.suggestedFix || right.suggested_fix || ""}`;
  const sameLocator = (value) => /\b(?:same|identical)\b/i.test(value);
  const differentLocator = (value) => /\b(?:different|distinct|another|pre-existing)\b/i.test(value);
  if ((sameLocator(leftMechanism) && differentLocator(rightMechanism)) || (differentLocator(leftMechanism) && sameLocator(rightMechanism))) return false;
  const technicalIds = (value) => new Set(value.match(/\b[a-z][a-z0-9_]*(?:At|Id|ID)\b/g) || []);
  const leftIds = technicalIds(leftMechanism);
  const rightIds = technicalIds(rightMechanism);
  if (leftIds.size && rightIds.size && ![...leftIds].some((id) => rightIds.has(id))) return false;
  const words = (value) => new Set((String(value || "").toLowerCase().match(/[a-z]{5,}/g) || []).map((word) => {
    if (word.length > 7 && word.endsWith("ing")) return word.slice(0, -3);
    if (word.length > 6 && word.endsWith("ed")) return word.slice(0, -2);
    if (word.length > 6 && word.endsWith("es")) return word.slice(0, -2);
    if (word.length > 5 && word.endsWith("s")) return word.slice(0, -1);
    return word;
  }));
  const leftWords = words(leftMechanism);
  const rightWords = words(rightMechanism);
  if (Math.min(leftWords.size, rightWords.size) < 4) return false;
  const overlap = [...leftWords].filter((word) => rightWords.has(word)).length;
  const ratio = overlap / Math.min(leftWords.size, rightWords.size);
  return (sharedSurfaces >= 2 && overlap >= 4 && ratio >= 0.25) || (overlap >= 6 && ratio >= 0.6);
}

export function actionableFindings(reviews) {
  const findings = reviews.flatMap((review) => review.findings || []).filter((finding) => actionableSeverities.has(String(finding.severity || "").toLowerCase()));
  const genericGateClaim = (finding) => {
    const claim = String(finding.claim || "");
    return /^repository check failed:/i.test(claim) || /^(?:the\s+)?(?:(?:required|canonical|supplied)\s+)?(?:verification\s+)?(?:gate|suite)\b.{0,80}\b(?:red|not green|failed|failing|reports?\s+failures?)\b/i.test(claim);
  };
  const hasSpecificTestFinding = findings.some((finding) => String(finding.category || "").toLowerCase() === "tests" && (finding.evidence?.[0]?.file || finding.acceptanceCriterion) && !genericGateClaim(finding));
  const unique = new Map();
  for (const finding of findings) {
    if (hasSpecificTestFinding && String(finding.category || "").toLowerCase() === "tests" && genericGateClaim(finding)) continue;
    const evidence = finding.evidence?.[0] || {};
    const category = String(finding.category || "general").toLowerCase();
    const criterion = String(finding.acceptanceCriterion || "").trim().toLowerCase();
    const file = String(evidence.file || "").trim().toLowerCase();
    let key = category === "tests" && criterion && file ? `${category}:${criterion}:${file}` : `${file}:${evidence.line || ""}:${finding.claim || ""}`.toLowerCase();
    let previous = unique.get(key);
    if (!previous) {
      const similar = [...unique.entries()].find(([, item]) => similarFinding(item.finding, finding));
      if (similar) [key, previous] = similar;
    }
    const evidenceFiles = new Set((finding.evidence || []).map((item) => item.file).filter(Boolean));
    const detail = evidenceFiles.size * 100 + String(finding.claim || "").length + String(finding.suggestedFix || finding.suggested_fix || "").length;
    if (!previous || detail > previous.detail) unique.set(key, { finding, detail });
  }
  return [...unique.values()].map(({ finding }) => finding);
}

export function findingsFingerprint(findings = []) {
  return actionableFindings([{ findings }]).map((finding) => {
    const evidence = finding.evidence?.[0] || {};
    const diagnostic = !evidence.file || /^repository check failed:/i.test(String(finding.claim || "")) ? finding.suggestedFix || finding.suggested_fix || "" : "";
    return `${evidence.file || ""}:${evidence.line || ""}:${finding.claim || ""}:${diagnostic}`.toLowerCase();
  }).sort().join("|");
}

export function humanProofFindings(feedback) {
  const claim = String(feedback || "").trim();
  if (!claim) return [];
  const numbered = [...claim.matchAll(/\(\d+\)\s+([\s\S]*?)(?=\s+\(\d+\)\s+|$)/g)].map((match) => match[1].trim());
  return (numbered.length ? numbered : [claim]).map((item) => ({ severity: "blocking", category: "human-proof-review", claim: item, evidence: [], suggestedFix: item, confidence: "high" }));
}

export function refreshedReviewFindings(review = {}) {
  if (!Array.isArray(review.reviews) || !review.reviews.length) return review.actionableFindings || [];
  const humanFindings = (review.actionableFindings || []).filter((finding) => finding.category === "human-proof-review").flatMap((finding) => humanProofFindings(finding.claim));
  return humanFindings.length ? humanFindings : actionableFindings(review.reviews);
}

export function reviewFindingLedger(reviews = []) {
  const ledger = [];
  for (const review of reviews) {
    const findings = actionableFindings([{ findings: review.actionableFindings || [] }, ...(review.reviews || [])]);
    const independent = review.reviewMode === "independent" || (!review.reviewMode && (review.reviews || []).some((item) => ["requirements", "integration", "verification"].includes(item.role)));
    const seen = new Set();
    for (const finding of findings) {
      let entry = ledger.find((item) => findingsFingerprint([item.finding]) === findingsFingerprint([finding]) || similarFinding(item.finding, finding));
      if (!entry) {
        entry = { id: `finding-${ledger.length + 1}`, finding, status: "open", history: [] };
        ledger.push(entry);
      }
      const status = entry.status === "resolved" ? "regressed" : "open";
      entry.finding = finding;
      entry.status = status;
      entry.history.push({ round: review.round, status, reviewId: review.reviewId || null });
      seen.add(entry.id);
    }
    if (independent) for (const entry of ledger) if (!seen.has(entry.id) && entry.status !== "resolved") {
      entry.status = "resolved";
      entry.history.push({ round: review.round, status: "resolved", reviewId: review.reviewId || null });
    }
  }
  return ledger;
}

export function unresolvedReviewFindings(reviews = []) {
  return reviewFindingLedger(reviews).filter((item) => item.status !== "resolved").map((item) => item.finding);
}

export function reviewScopeExpanded(previous = [], refreshed = []) {
  const before = actionableFindings([{ findings: previous }]);
  const after = actionableFindings([{ findings: refreshed }]);
  return after.some((finding) => !before.some((prior) => findingsFingerprint([prior]) === findingsFingerprint([finding]) || similarFinding(prior, finding)));
}

export function storedFindingsFingerprint(findings = []) {
  return findings.map((finding) => {
    const evidence = finding.evidence?.[0] || {};
    return `${finding.severity || ""}:${finding.category || ""}:${evidence.file || ""}:${evidence.line || ""}:${finding.claim || ""}`.toLowerCase();
  }).sort().join("|");
}

export function recurringReviewClusters(reviews = [], minRounds = 3) {
  const counts = new Map();
  for (const review of reviews) {
    const keys = new Set(actionableFindings([{ findings: review.actionableFindings || review.findings || [] }]).map((finding) => {
      const evidence = finding.evidence?.[0] || {};
      const surface = String(evidence.file || finding.acceptanceCriterion || "").trim().toLowerCase();
      if (!surface) return null;
      const location = evidence.file && evidence.line ? `${surface}:${evidence.line}` : surface;
      return `${String(finding.category || "general").toLowerCase()}:${location}`;
    }).filter(Boolean));
    for (const key of keys) counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts].filter(([, count]) => count >= minRounds).map(([key]) => key).sort();
}

export function unaddressedReviewClusters(reviews = []) {
  const corrected = new Set(reviews.flatMap((review) => review.fix?.rootCauseClusters || []));
  const open = new Set(recurringReviewClusters([{ actionableFindings: unresolvedReviewFindings(reviews) }], 1));
  return recurringReviewClusters(reviews).filter((key) => open.has(key) && !corrected.has(key));
}

export function findingsRequireVisualEvidence(findings = []) {
  return findings.some((finding) => {
    const context = [finding.category, finding.claim, finding.suggestedFix, finding.suggested_fix, ...(finding.evidence || []).map((item) => item.file)].join(" ");
    return String(finding.category || "").toLowerCase() === "accessibility" || /\b(?:screenshot|image|video|visual|layout|viewport|pixel|desktop|mobile)\b/i.test(context);
  });
}

export function reviewFixImages(sessionFile, findings = [], images = []) {
  return sessionFile || !findingsRequireVisualEvidence(findings) ? [] : images;
}

export function executionFailure(error, { phase = "execution", command = null } = {}) {
  const message = redactText(String(error?.message || error?.summary || error || "Execution failed"));
  const kind = error?.failureKind || (error?.code === "MODEL_RESPONSE_ERROR" || /(?:model output|independent-review output)/i.test(message) ? "model-output"
    : /context (?:window|length)|provider|usage limit/i.test(message) ? "provider"
    : /conflict|unmerged/i.test(message) ? "merge-conflict"
    : /ETIMEDOUT|timed out|timeout/i.test(message) ? "timeout" : "execution");
  const nextAction = kind === "evidence-publication" ? "Restore forge access and resume delivery; retain the reviewed files and local proof."
    : kind === "visual-evidence" || kind === "capture-configuration" || kind === "capture-preflight" ? "Repair the separate capture command or fixture, then rerun checks and criterion coverage before independent review."
    : kind === "provider" ? "Restore provider capacity or retry with a fresh bounded review session; preserve verified repository work."
    : kind === "model-output" ? "Retry the structured report without repeating implementation."
    : kind === "merge-conflict" ? "Resolve the persisted conflict and reverify the combined tree before delivery."
    : "Inspect the failed command and diagnostic, correct the cause, then resume from the saved checkpoint.";
  return { kind, phase, command: error?.command || command, message, diagnostic: redactText(String(error?.failureHighlights || error?.output || "")).slice(-8000), nextAction };
}
