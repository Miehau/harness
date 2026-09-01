import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { loadLocalFixture } from "../src/local.js";

test("hello-readme fixture is a single documentation ticket", async () => {
  const fixture = await loadLocalFixture(fileURLToPath(new URL("../fixtures/hello-readme", import.meta.url)), ".");
  assert.equal(fixture.plan.nodes.length, 1);
  assert.equal(fixture.plan.nodes[0].id, "write-readme");
  assert.equal(fixture.plan.nodes[0].writeScope, "README.md");
});
