import assert from "node:assert/strict";
import test from "node:test";

import {
  isDuplicateChannelNameError,
  pickReusableHomeChannel,
  rebindRepositoryTemplate,
} from "./projectRecreation.ts";

const YOU = "a".repeat(64);
const THEM = "b".repeat(64);

function channel(overrides) {
  return {
    archivedAt: null,
    channelType: "stream",
    id: "home",
    managerPubkeys: [YOU],
    name: "bee-garden",
    visibility: "open",
    ...overrides,
  };
}

function pick(candidates, leftoverChannelId = null) {
  return (
    pickReusableHomeChannel({
      candidates,
      leftoverChannelId,
      name: "Bee-Garden",
      ownerPubkey: YOU.toUpperCase(),
    })?.id ?? null
  );
}

test("no leftovers re-use nothing", () => {
  assert.equal(pick([]), null);
});

test("the leftover repository's channel wins over a same-named one", () => {
  const bound = channel({ id: "bound", name: "renamed" });
  const named = channel({ id: "named" });
  assert.equal(pick([named, bound], "bound"), "bound");
});

test("a same-named open stream of yours is re-used, ignoring case", () => {
  assert.equal(pick([channel({ name: "BEE-GARDEN" })]), "home");
});

test("an archived channel of yours is still re-used", () => {
  assert.equal(pick([channel({ archivedAt: "2026-11-14T00:00:00Z" })]), "home");
});

test("someone else's channel is never re-used", () => {
  assert.equal(pick([channel({ managerPubkeys: [THEM] })], "home"), null);
});

test("a private or forum channel with the name does not count as a leftover", () => {
  assert.equal(pick([channel({ visibility: "private" })]), null);
  assert.equal(pick([channel({ channelType: "forum" })]), null);
});

const REPO = {
  kind: 30617,
  content: "",
  tags: [
    ["d", "bee-garden"],
    ["name", "bee-garden"],
    ["buzz-channel", "old"],
    ["clone", "http://relay/git/x/bee-garden"],
    ["t", "private"],
  ],
};

test("re-binding swaps only the channel and keeps every other tag", () => {
  const rebound = rebindRepositoryTemplate(REPO, "new");
  assert.deepEqual(rebound, {
    kind: 30617,
    content: "",
    tags: [
      ["d", "bee-garden"],
      ["name", "bee-garden"],
      ["clone", "http://relay/git/x/bee-garden"],
      ["t", "private"],
      ["buzz-channel", "new"],
    ],
  });
});

test("an already bound repository with a description is left alone", () => {
  const described = {
    ...REPO,
    tags: [...REPO.tags, ["description", "Bees"]],
  };
  assert.equal(rebindRepositoryTemplate(described, "old", "New"), null);
});

test("a missing description is filled in, an existing one kept", () => {
  const filled = rebindRepositoryTemplate(REPO, "old", " Bees ");
  assert.equal(filled.content, "Bees");
  assert.deepEqual(filled.tags.at(-1), ["description", "Bees"]);

  const described = {
    ...REPO,
    content: "Old",
    tags: [...REPO.tags, ["description", "Old"]],
  };
  const rebound = rebindRepositoryTemplate(described, "new", "New");
  assert.equal(rebound.content, "Old");
  assert.equal(
    rebound.tags.filter((tag) => tag[0] === "description").length,
    1,
  );
});

test("the relay's duplicate-name refusal is recognised", () => {
  assert.ok(
    isDuplicateChannelNameError(
      new Error('invalid: an open channel named "bee-garden" already exists'),
    ),
  );
  assert.ok(!isDuplicateChannelNameError(new Error("timed out")));
});
