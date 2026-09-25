import assert from "node:assert/strict";
import { test } from "node:test";

import {
  htmlDocumentHostCountForTests,
  openHtmlDocument,
} from "./htmlDocumentPanel.ts";

test("openHtmlDocument declines when no screen can dock it", () => {
  assert.equal(htmlDocumentHostCountForTests(), 0);
  const doc = {
    filename: "report.html",
    load: async () => "",
    loadKey: "k",
  };
  assert.equal(openHtmlDocument(doc), false);
});
