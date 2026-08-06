import assert from "node:assert/strict";
import test from "node:test";

import { effortCacheKeyFor } from "./usePersonaModelDiscovery.ts";

// Effort levels are per (agent config, model): the adapter rebuilds the option
// on every model switch and omits it for models with no effort control. The
// cache key has to carry both halves or one model's answer is served for
// another's — silently, since a wrong-but-plausible level looks fine in a
// dropdown.

const CONFIG_A = JSON.stringify({
  agentCommand: "claude-agent-acp",
  agentArgs: "[]",
  provider: "",
  envVars: "[]",
});
const CONFIG_B = JSON.stringify({
  agentCommand: "claude-agent-acp",
  agentArgs: "[]",
  provider: "",
  envVars: '[["ANTHROPIC_API_KEY","other"]]',
});

test("distinct models under one agent config get distinct keys", () => {
  assert.notEqual(
    effortCacheKeyFor(CONFIG_A, "opus"),
    effortCacheKeyFor(CONFIG_A, "haiku"),
  );
});

test("one model under distinct agent configs gets distinct keys", () => {
  // Model availability and effort support are account-scoped, so a different
  // env must not read another account's answer.
  assert.notEqual(
    effortCacheKeyFor(CONFIG_A, "opus"),
    effortCacheKeyFor(CONFIG_B, "opus"),
  );
});

test("the same pair is stable across calls", () => {
  // The cache is only useful if a re-selection recomputes the same key.
  assert.equal(
    effortCacheKeyFor(CONFIG_A, "opus"),
    effortCacheKeyFor(CONFIG_A, "opus"),
  );
});

test("surrounding whitespace does not fork the key", () => {
  assert.equal(
    effortCacheKeyFor(CONFIG_A, "  opus  "),
    effortCacheKeyFor(CONFIG_A, "opus"),
  );
});

test("no key without a model — nothing to probe for", () => {
  assert.equal(effortCacheKeyFor(CONFIG_A, ""), null);
  assert.equal(effortCacheKeyFor(CONFIG_A, "   "), null);
});

test("no key without a discovery key — discovery is gated off", () => {
  // Null means the dialog is closed, the runtime is unavailable, or the model
  // field is hidden. Probing then would spawn an adapter for a field nobody
  // is looking at.
  assert.equal(effortCacheKeyFor(null, "opus"), null);
});
