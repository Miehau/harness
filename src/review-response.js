/** Validate the review contract before ending the model session. */
export function validateReviewResponse(parsed, { role, criteria = [], artifacts = [], inspectedMedia = new Set() }) {
  const errors = [];
  if (typeof parsed.summary !== "string" || !parsed.summary.trim()) errors.push("summary must be non-empty");
  if (!Array.isArray(parsed.findings)) errors.push("findings must be an array");
  const results = parsed.criterionResults || [];
  const assigned = criteria.filter((criterion) => criterion.scope !== "step");
  if (!Array.isArray(results)) errors.push("criterionResults must be an array");
  else {
    if (role === "requirements") for (const criterion of assigned) {
      const count = results.filter((result) => result?.criterionId === criterion.id).length;
      if (count !== 1) errors.push(`${criterion.id}: expected one verdict, received ${count}`);
    }
    for (const result of results) {
      if (!result || typeof result !== "object") { errors.push("criterion verdict must be an object"); continue; }
      if (criteria.length && !criteria.some((criterion) => criterion.id === result.criterionId)) errors.push(`${result.criterionId}: unknown criterion`);
      if (results.filter((item) => item?.criterionId === result.criterionId).length !== 1) errors.push(`${result.criterionId}: duplicate verdict`);
      if (!["verified", "failed", "blocked"].includes(result.status)) errors.push(`${result.criterionId}: invalid status`);
      if (result.status === "verified" && !result.evidence?.length) errors.push(`${result.criterionId}: verified needs evidence`);
      if (result.evidence !== undefined && !Array.isArray(result.evidence)) { errors.push(`${result.criterionId}: evidence must be an array`); continue; }
      for (const locator of result.evidence || []) {
        if (!locator || typeof locator !== "object") { errors.push(`${result.criterionId}: evidence locator must be an object`); continue; }
        if (["artifact", "media"].includes(locator.type)) {
          if (!locator.artifactId || !artifacts.some((item) => item.id === locator.artifactId)) errors.push(`${result.criterionId}: ${locator.type} needs an exact current artifactId`);
          if (locator.type === "media" && !inspectedMedia.has(locator.artifactId)) errors.push(`${result.criterionId}: uninspected media ${locator.artifactId}; use review_media`);
        } else if (locator.type !== "check" || !["final", "step", "attempt"].includes(locator.scope)
          || (locator.scope !== "final" && !locator.stepId) || (locator.scope === "attempt" && !locator.attemptId)) {
          errors.push(`${result.criterionId}: invalid check locator (scope, stepId, attemptId)`);
        }
      }
    }
  }
  if (errors.length) throw Object.assign(new Error(`Independent-review output: ${errors.join("; ")}`), { code: "MODEL_RESPONSE_ERROR" });
  return parsed;
}
