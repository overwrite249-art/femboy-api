import test from "node:test";
import assert from "node:assert/strict";
import { landingExamples } from "../../lib/landing/examples.ts";

test("landing examples use the current gateway and environment keys, not embedded credentials", () => {
  const examples = landingExamples("https://gateway.example");
  assert.deepEqual(Object.keys(examples), ["JavaScript", "Python", "cURL"]);
  for (const code of Object.values(examples)) {
    assert.ok(code.includes("https://gateway.example/v1"));
    assert.ok(code.includes("FEMBOY_API_KEY"));
    assert.ok(code.includes("YOUR_MODEL"));
    assert.ok(code.includes("128"));
  }
  assert.ok(examples.JavaScript.includes("process.env.FEMBOY_API_KEY"));
  assert.ok(examples.Python.includes('os.environ["FEMBOY_API_KEY"]'));
  assert.ok(examples.cURL.includes("Bearer $FEMBOY_API_KEY"));
});

test("landing examples discard URL credentials, paths, queries and fragments", () => {
  const examples = landingExamples(
    "https://example-user:example-only@gateway.example/path?private=example-only#fragment",
  );
  for (const code of Object.values(examples)) {
    assert.ok(!code.includes("example-user"));
    assert.ok(!code.includes("example-only"));
    assert.ok(!code.includes("/path"));
    assert.ok(!code.includes("fragment"));
    assert.ok(code.includes("https://gateway.example/v1"));
  }
});

test("landing examples permit local HTTP development but reject non-web origins", () => {
  assert.ok(
    landingExamples("http://localhost:3000").JavaScript.includes(
      "http://localhost:3000/v1",
    ),
  );
  for (const origin of [
    "javascript:alert(1)",
    "data:text/plain,example",
    "file:///example",
    "not a URL",
  ]) {
    assert.throws(() => landingExamples(origin));
  }
});

test("landing cURL body is valid bounded, non-streaming chat JSON", () => {
  const code = landingExamples("https://gateway.example").cURL;
  const body = JSON.parse(code.slice(code.indexOf("-d '") + 4, -1));
  assert.equal(body.model, "YOUR_MODEL");
  assert.equal(body.max_tokens, 128);
  assert.equal(body.stream, false);
  assert.deepEqual(body.messages, [{ role: "user", content: "Hello, world!" }]);
});
