import assert from "node:assert/strict";
import { test } from "node:test";

import {
  activityLogClearKey,
  filterEventsAfterClear,
  readActivityLogClearedAt,
  writeActivityLogClearedAt,
} from "./activityLogClear.ts";

const AGENT =
  "9857acd558b3115a773b1bb51e4de8d38c26751ff4ad679114158a8b28a56b35";
const CHANNEL = "7fdd5a94-7523-5b86-b574-9124de6cdc0d";

function withStorage(store) {
  globalThis.window = {
    localStorage: {
      getItem: (key) => (key in store ? store[key] : null),
      setItem: (key, value) => {
        store[key] = value;
      },
    },
  };
}

function event(timestamp) {
  return { timestamp };
}

test("the key separates channels so clearing one does not blank another", () => {
  assert.notEqual(
    activityLogClearKey(AGENT, CHANNEL),
    activityLogClearKey(AGENT, "other-channel"),
  );
  assert.ok(activityLogClearKey(AGENT, null).endsWith(":all"));
});

test("a log that was never cleared has no watermark", () => {
  withStorage({});
  assert.equal(
    readActivityLogClearedAt(activityLogClearKey(AGENT, CHANNEL)),
    null,
  );
});

test("a written watermark round-trips", () => {
  const store = {};
  withStorage(store);
  const key = activityLogClearKey(AGENT, CHANNEL);
  writeActivityLogClearedAt(key, 1_700_000_000_000);
  assert.equal(readActivityLogClearedAt(key), 1_700_000_000_000);
});

/// Storage is user-writable and survives builds. A junk value must read as
/// "never cleared" rather than blanking the panel permanently.
test("a junk stored value reads as never cleared", () => {
  const key = activityLogClearKey(AGENT, CHANNEL);
  for (const raw of ["not-a-number", "", "-1", "0", "NaN"]) {
    withStorage({ [key]: raw });
    assert.equal(readActivityLogClearedAt(key), null, raw);
  }
});

test("unavailable storage degrades to never cleared instead of throwing", () => {
  globalThis.window = {
    localStorage: {
      getItem() {
        throw new Error("denied");
      },
      setItem() {
        throw new Error("denied");
      },
    },
  };
  const key = activityLogClearKey(AGENT, CHANNEL);
  assert.equal(readActivityLogClearedAt(key), null);
  assert.doesNotThrow(() => writeActivityLogClearedAt(key, Date.now()));
});

test("no watermark returns the events untouched", () => {
  const events = [event("2026-08-04T20:00:00Z")];
  assert.equal(filterEventsAfterClear(events, null), events);
});

test("frames at or before the watermark are hidden", () => {
  const clearedAt = Date.parse("2026-08-04T20:00:00Z");
  const kept = filterEventsAfterClear(
    [
      event("2026-08-04T19:59:59Z"),
      event("2026-08-04T20:00:00Z"),
      event("2026-08-04T20:00:01Z"),
    ],
    clearedAt,
  );
  assert.deepEqual(
    kept.map((e) => e.timestamp),
    ["2026-08-04T20:00:01Z"],
  );
});

/// An unreadable timestamp is not evidence the user has seen the frame, so
/// hiding it would lose activity the log exists to show.
test("a frame with an unparseable timestamp survives a clear", () => {
  const kept = filterEventsAfterClear(
    [event("not a timestamp"), event("2026-08-04T19:00:00Z")],
    Date.parse("2026-08-04T20:00:00Z"),
  );
  assert.deepEqual(
    kept.map((e) => e.timestamp),
    ["not a timestamp"],
  );
});
