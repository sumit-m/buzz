import assert from "node:assert/strict";
import { test } from "node:test";

import { mergeRepoContributors } from "./projectContributorAggregation.ts";

const contributor = (name, email, commitCount, lastCommitAt) => ({
  commitCount,
  email,
  lastCommitAt,
  name,
});

test("a single repository's list is returned untouched", () => {
  const list = [
    contributor("Zoe", "zoe@example.com", 1, 10),
    contributor("Al", "al@example.com", 9, 20),
  ];
  assert.deepEqual(mergeRepoContributors([list, []]), list);
});

test("the same author in two repositories sums into one row", () => {
  const merged = mergeRepoContributors([
    [contributor("Sam", "sam@example.com", 3, 100)],
    [contributor("Sam", "sam@example.com", 4, 200)],
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].commitCount, 7);
  assert.equal(merged[0].lastCommitAt, 200);
});

test("the most recent commit decides the displayed name", () => {
  const [row] = mergeRepoContributors([
    [contributor("Old Name", "sam@example.com", 1, 100)],
    [contributor("New Name", "sam@example.com", 1, 300)],
  ]);
  assert.equal(row.name, "New Name");
});

test("authors are keyed by email, so distinct emails stay distinct", () => {
  const merged = mergeRepoContributors([
    [contributor("Sam", "sam@work.example", 1, 100)],
    [contributor("Sam", "sam@home.example", 1, 100)],
  ]);
  assert.equal(merged.length, 2);
});

test("merged rows lead with the most prolific author", () => {
  const merged = mergeRepoContributors([
    [contributor("Quiet", "quiet@example.com", 1, 100)],
    [contributor("Busy", "busy@example.com", 5, 50)],
  ]);
  assert.deepEqual(
    merged.map((row) => row.name),
    ["Busy", "Quiet"],
  );
});

test("no snapshots yet is an empty list, not a crash", () => {
  assert.deepEqual(mergeRepoContributors([[], []]), []);
});
