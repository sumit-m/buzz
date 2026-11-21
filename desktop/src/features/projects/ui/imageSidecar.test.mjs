import assert from "node:assert/strict";
import { test } from "node:test";

import { parseImageSidecar, sidecarPathFor } from "./imageSidecar.ts";

test("sidecarPathFor swaps the extension in the same folder", () => {
  assert.equal(sidecarPathFor("assets/f4e3.jpg"), "assets/f4e3.json");
  assert.equal(sidecarPathFor("a.b/c.png"), "a.b/c.json");
  assert.equal(sidecarPathFor("noext"), "noext.json");
});

test("parseImageSidecar labels mage's fields in sidebar order", () => {
  const sidecar = parseImageSidecar(
    JSON.stringify({
      name: "f4e3.jpg",
      history_id: "f4e31de5-1bc3",
      prompt: "a white fox in a jungle",
      architecture: "mango",
      model_id: "mango-v4",
      aspect_ratio: "square",
      resolution: "1K",
      width: 1024,
      height: 1024,
      generation_mode: "unlimited",
      type: "image",
      duration_sec: 15.38,
      status: "success",
      result_url: "https://cdn/x.jpg",
      seed: 42,
      tags: ["x"],
    }),
  );
  assert.equal(sidecar.prompt, "a white fox in a jungle");
  assert.equal(sidecar.values.model_id, "mango-v4");
  assert.equal(sidecar.values.width, "1024");
  assert.equal(sidecar.values.tags, undefined);
  assert.deepEqual(
    sidecar.fields.map((field) => [field.label, field.value]),
    [
      ["Model", "mango-v4"],
      ["Architecture", "mango"],
      ["Dimensions", "1024 × 1024"],
      ["Resolution", "1K"],
      ["Aspect Ratio", "square"],
      ["Duration", "15.4s"],
      ["Type", "image"],
      ["Seed", "42"],
    ],
  );
});

test("parseImageSidecar rejects anything but a JSON object", () => {
  assert.equal(parseImageSidecar("{not json"), null);
  assert.equal(parseImageSidecar("[1,2]"), null);
  assert.deepEqual(parseImageSidecar("{}"), {
    prompt: null,
    fields: [],
    values: {},
    origin: null,
  });
});

test("parseImageSidecar reads mage-agent's origin block", () => {
  const sidecar = parseImageSidecar(
    JSON.stringify({
      prompt: "remove the ball",
      buzz: {
        mode: "edit",
        source: {
          url: "https://relay/media/ab.png",
          m: "image/png",
          x: "ab",
          dim: "896x1152",
          extra: "x",
        },
        repo: "owner/site",
      },
    }),
  );
  assert.deepEqual(sidecar.origin, {
    mode: "edit",
    sources: [
      {
        url: "https://relay/media/ab.png",
        m: "image/png",
        x: "ab",
        dim: "896x1152",
      },
    ],
    repo: "owner/site",
  });
  assert.equal(sidecar.fields.length, 0);
  assert.deepEqual(
    parseImageSidecar('{"buzz":{"mode":"generate"}}').origin.sources,
    [],
  );
  assert.equal(parseImageSidecar('{"buzz":{"mode":"later"}}').origin, null);
  assert.deepEqual(
    parseImageSidecar(
      '{"buzz":{"mode":"edit","source":{"url":"file:///c/a.png"}}}',
    ).origin.sources,
    [],
  );
});

test("parseImageSidecar lists every source in order, ahead of the single one", () => {
  const origin = parseImageSidecar(
    JSON.stringify({
      buzz: {
        mode: "edit",
        sources: [
          { url: "https://relay/media/a.png", x: "aa" },
          { url: "file:///c/skip.png" },
          { url: "https://relay/media/b.png", x: "bb" },
        ],
        source: { url: "https://relay/media/a.png", x: "aa" },
      },
    }),
  ).origin;
  assert.deepEqual(
    origin.sources.map((source) => source.url),
    ["https://relay/media/a.png", "https://relay/media/b.png"],
  );
});
