import assert from "node:assert/strict";
import test from "node:test";

import {
  countUnreadObservedEvents,
  removeObservedUnreadEvents,
} from "./unreadChannelCounts.ts";

const observed = (id, createdAt) => ({
  id,
  createdAt,
  countsTowardBadge: true,
  countsTowardAppBadge: true,
  isHighPriority: true,
  rootId: null,
});

const channelWith = (...events) =>
  new Map([["dm-1", new Map(events.map((e) => [e.id, e]))]]);

// The badge showed 2 after an agent sent two DMs and deleted both. Badge counts
// come from this map; the deletion handler only cleared home-inbox activity
// rows, which a top-level DM never has in the first place.
test("deleting the messages clears the badge they were counting for", () => {
  const byChannel = channelWith(observed("a", 100), observed("b", 200));
  const unread = () =>
    countUnreadObservedEvents(byChannel.get("dm-1"), () => 0);

  assert.equal(unread(), 2, "both DMs start unread");

  const removed = removeObservedUnreadEvents(byChannel, new Set(["a", "b"]));

  assert.equal(removed, true, "should report that it changed something");
  assert.equal(unread(), 0, "a destroyed message must stop counting");
});

// A cascade names the whole destroyed subtree, and the caller has the ids
// without knowing which channel each belonged to.
test("ids are cleared across every channel", () => {
  const byChannel = new Map([
    ["dm-1", new Map([["a", observed("a", 100)]])],
    ["chan-1", new Map([["b", observed("b", 200)]])],
  ]);

  assert.equal(
    removeObservedUnreadEvents(byChannel, new Set(["a", "b"])),
    true,
  );
  assert.equal(byChannel.get("dm-1").size, 0);
  assert.equal(byChannel.get("chan-1").size, 0);
});

// The handler bumps a render version only when something changed, so an
// unrelated deletion must not report one.
test("a deletion naming nothing observed reports no change", () => {
  const byChannel = channelWith(observed("a", 100));

  assert.equal(
    removeObservedUnreadEvents(byChannel, new Set(["unrelated"])),
    false,
  );
  assert.equal(removeObservedUnreadEvents(byChannel, new Set()), false);
  assert.equal(byChannel.get("dm-1").size, 1, "nothing else was touched");
});
