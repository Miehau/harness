import assert from "node:assert/strict";
import test from "node:test";
import { parseModelJson, parseModelOutput, validateModelOutput } from "../src/model-output.js";

test("parses direct, fenced, and prose-wrapped JSON model replies", () => {
  assert.deepEqual(parseModelJson('{"artifact":"ready"}'), { artifact: "ready" });
  assert.deepEqual(parseModelJson('```json\n{"artifact":"ready"}\n```'), { artifact: "ready" });
  assert.deepEqual(parseModelJson('Draft {not JSON}. Final answer: {"artifact":"a } in a string"} done.'), { artifact: "a } in a string" });
});

test("falls through an invalid fence to a later valid JSON value", () => {
  assert.deepEqual(parseModelJson('```json\n{broken}\n```\n{"artifact":"ready"}'), { artifact: "ready" });
});

test("finds the JSON value that satisfies the requested phase contract", () => {
  assert.deepEqual(
    parseModelOutput('Example: {"artifact":"draft"}. Final: {"artifact":"ready","questions":[]}', { artifact: "nonEmptyString", questions: "array" }),
    { artifact: "ready", questions: [] }
  );
});

test("prefers the final matching object over an earlier example", () => {
  const reply = 'Example: {"artifact":"example","questions":[]}\nFinal: {"artifact":"approved","questions":[]}';
  assert.equal(parseModelOutput(reply, { artifact: "nonEmptyString", questions: "array" }).artifact, "approved");
});

test("validates required harness output fields", () => {
  const requirements = parseModelOutput(
    '{"artifact":"# Requirements","questions":[]}',
    { artifact: "nonEmptyString", questions: "array" },
    "Requirements output"
  );
  assert.equal(requirements.artifact, "# Requirements");
  assert.throws(
    () => validateModelOutput({ artifact: " ", questions: [] }, { artifact: "nonEmptyString", questions: "array" }, "Requirements output"),
    /Requirements output\.artifact must be non empty string/
  );
  assert.throws(
    () => validateModelOutput({ summary: "ok", findings: {} }, { summary: "string", findings: "array" }, "Review output"),
    /Review output\.findings must be array/
  );
});

test("rejects empty, malformed, and non-object model outputs", () => {
  assert.throws(() => parseModelJson(""), /Model output is empty/);
  assert.throws(() => parseModelJson("{broken}"), /did not contain valid JSON/);
  assert.throws(() => parseModelOutput("[]"), /must be an object/);
});
