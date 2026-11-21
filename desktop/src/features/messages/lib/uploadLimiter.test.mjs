import assert from "node:assert/strict";
import { test } from "node:test";

import { createUploadLimiter } from "./uploadLimiter.ts";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("runs at most the limit at once, the rest in queue order", async () => {
  const limit = createUploadLimiter(2);
  const gates = [deferred(), deferred(), deferred(), deferred()];
  const started = [];
  const runs = gates.map((gate, index) =>
    limit(async () => {
      started.push(index);
      return gate.promise;
    }),
  );
  await Promise.resolve();
  assert.deepEqual(started, [0, 1]);
  gates[1].resolve("b");
  assert.equal(await runs[1], "b");
  await Promise.resolve();
  assert.deepEqual(started, [0, 1, 2]);
  gates[0].reject(new Error("failed"));
  await assert.rejects(runs[0], /failed/);
  await Promise.resolve();
  assert.deepEqual(started, [0, 1, 2, 3]);
  gates[2].resolve("c");
  gates[3].resolve("d");
  assert.deepEqual(await Promise.all(runs.slice(2)), ["c", "d"]);
});
