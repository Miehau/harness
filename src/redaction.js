const secretKey = /(?:api[_-]?key|authorization|credential|password|secret|token|cookie|private[_-]?key)/i;
const tokenPatterns = [
  /\b(?:gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|glpat-[A-Za-z0-9_-]{8,}|npm_[A-Za-z0-9]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{16})\b/g,
  /\b(?:sk|pk|api|token|secret|password)[-_][A-Za-z0-9_-]{8,}\b/gi,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}\b/gi,
  /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|KEY))\s*[=:]\s*[^\s,;]+/g,
  /([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi
];
const absolutePath = /(^|[\s"'`(])(?:~\/|\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+|[A-Za-z]:\\[^\s"'`),;]+)/g;

export function redactText(value) {
  let text = String(value ?? "");
  for (const pattern of tokenPatterns) text = text.replace(pattern, (...parts) => parts[1] && pattern === tokenPatterns[4] ? `${parts[1]}[redacted]@` : "[redacted]");
  return text.replace(absolutePath, "$1[path]");
}

export function boundedText(value, limit) {
  const text = redactText(value);
  return text.length > limit
    ? { value: text.slice(0, limit), state: "truncated", truncated: true }
    : { value: text, state: "available", truncated: false };
}

export function redactRecord(value, key = "") {
  if (typeof value === "string") return secretKey.test(key) ? "[redacted]" : redactText(value);
  if (Array.isArray(value)) return value.map((item) => redactRecord(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, secretKey.test(name) ? "[redacted]" : redactRecord(item, name)]));
}

export function safeArtifactMetadata(artifact) {
  if (!artifact || typeof artifact !== "object") return artifact;
  const { path, content, ...metadata } = artifact;
  return redactRecord(metadata);
}

export function safeReasoningSummary(value, limit = 240) {
  return boundedText(value, limit).value.replace(/[*`]/g, "").trim();
}
