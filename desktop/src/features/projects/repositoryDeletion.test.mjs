import assert from "node:assert/strict";
import test from "node:test";

import { buildRepositoryTombstone } from "./repositoryDeletion.ts";

const OWNER = "a".repeat(64);
const OTHER = "b".repeat(64);

function repository(dtag, owner = OWNER) {
  return {
    id: `${owner}:${dtag}`,
    dtag,
    name: dtag,
    description: "",
    cloneUrls: [],
    webUrl: null,
    owner,
    contributors: [],
    createdAt: 100,
    status: "active",
    defaultBranch: "main",
    repoAddress: `30617:${owner}:${dtag}`,
  };
}

test("a repository tombstone names exactly its own coordinate", () => {
  const template = buildRepositoryTombstone({
    ownerPubkey: OWNER,
    repository: repository("api"),
  });
  assert.equal(template.kind, 5);
  assert.deepEqual(template.tags, [["a", `30617:${OWNER}:api`]]);
});

/** Nothing else may ride along: the relay destroys every coordinate named. */
test("a repository tombstone carries no other coordinate", () => {
  const template = buildRepositoryTombstone({
    ownerPubkey: OWNER,
    repository: repository("api"),
  });
  assert.equal(template.tags.length, 1);
});

test("only the repository owner can tombstone it", () => {
  assert.throws(
    () =>
      buildRepositoryTombstone({
        ownerPubkey: OTHER,
        repository: repository("api"),
      }),
    /Only the repository owner/,
  );
});

test("owner matching ignores case and stray whitespace", () => {
  const template = buildRepositoryTombstone({
    ownerPubkey: ` ${OWNER.toUpperCase()} `,
    repository: repository("api"),
  });
  assert.deepEqual(template.tags, [["a", `30617:${OWNER}:api`]]);
});
