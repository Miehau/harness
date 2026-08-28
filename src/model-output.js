const fieldChecks = {
  string: (value) => typeof value === "string",
  nonEmptyString: (value) => typeof value === "string" && value.trim().length > 0,
  array: Array.isArray,
  nonEmptyArray: (value) => Array.isArray(value) && value.length > 0,
  object: (value) => value !== null && typeof value === "object" && !Array.isArray(value)
};

function balancedJsonCandidates(text) {
  const candidates = [];
  const stack = [];
  let start = -1;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (start < 0) {
      if (character === "{" || character === "[") {
        start = index;
        stack.push(character);
      }
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{" || character === "[") stack.push(character);
    else if (character === "}" || character === "]") {
      const opener = stack.pop();
      if ((opener === "{" && character !== "}") || (opener === "[" && character !== "]")) {
        start = -1;
        stack.length = 0;
      } else if (!stack.length) {
        candidates.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return candidates;
}

export function parseModelJson(reply) {
  if (typeof reply !== "string" || !reply.trim()) throw new Error("Model output is empty");
  const candidates = modelJsonCandidates(reply);
  let cause;
  for (const candidate of candidates) {
    try { return JSON.parse(candidate); }
    catch (error) { cause = error; }
  }
  throw new Error("Model output did not contain valid JSON", { cause });
}

function modelJsonCandidates(reply) {
  const fenced = [...reply.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((match) => match[1].trim());
  return [...new Set([reply.trim(), ...fenced.reverse(), ...balancedJsonCandidates(reply).reverse()])].filter(Boolean);
}

export function validateModelOutput(value, requiredFields = {}, label = "Model output") {
  if (!fieldChecks.object(value)) throw new Error(`${label} must be an object`);
  for (const [field, type] of Object.entries(requiredFields)) {
    const check = fieldChecks[type];
    if (!check) throw new Error(`Unknown model output field type: ${type}`);
    if (!check(value[field])) throw new Error(`${label}.${field} must be ${type.replace(/([A-Z])/g, " $1").toLowerCase()}`);
  }
  return value;
}

export function parseModelOutput(reply, requiredFields = {}, label) {
  if (typeof reply !== "string" || !reply.trim()) throw new Error("Model output is empty");
  for (const type of Object.values(requiredFields)) {
    if (!fieldChecks[type]) throw new Error(`Unknown model output field type: ${type}`);
  }
  let parseCause;
  let validationCause;
  for (const candidate of modelJsonCandidates(reply)) {
    let value;
    try { value = JSON.parse(candidate); }
    catch (error) {
      parseCause = error;
      continue;
    }
    try { return validateModelOutput(value, requiredFields, label); }
    catch (error) { validationCause = error; }
  }
  if (validationCause) throw validationCause;
  throw new Error("Model output did not contain valid JSON", { cause: parseCause });
}
