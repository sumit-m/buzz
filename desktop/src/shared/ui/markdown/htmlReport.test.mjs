import assert from "node:assert/strict";
import { test } from "node:test";

import {
  REPORT_CSP,
  isHtmlFilename,
  isJsonFilename,
  isRelayHtmlReport,
  prettyJson,
  withReportCsp,
  withViewerTheme,
} from "./htmlReport.ts";

const HASH = "a".repeat(64);

test("isHtmlFilename matches .html and .htm only", () => {
  assert.equal(isHtmlFilename("report.HTML"), true);
  assert.equal(isHtmlFilename("report.htm"), true);
  assert.equal(isHtmlFilename("report.html.pdf"), false);
});

test("isJsonFilename matches .json only", () => {
  assert.equal(isJsonFilename("h1.JSON"), true);
  assert.equal(isJsonFilename("h1.json.txt"), false);
  assert.equal(isJsonFilename("h1.jsonl"), false);
});

test("prettyJson indents valid JSON and keeps anything else as is", () => {
  assert.equal(
    prettyJson('{"a":1,"b":[2]}'),
    '{\n  "a": 1,\n  "b": [\n    2\n  ]\n}',
  );
  assert.equal(prettyJson("{not json"), "{not json");
});

test("isRelayHtmlReport accepts relay-hosted HTML", () => {
  assert.equal(
    isRelayHtmlReport(
      `https://relay.example/media/${HASH}.html`,
      "https://relay.example",
    ),
    true,
  );
});

test("isRelayHtmlReport treats loopback spellings as one relay", () => {
  assert.equal(
    isRelayHtmlReport(
      `http://127.0.0.1:3000/media/${HASH}.html`,
      "http://localhost:3000",
    ),
    true,
  );
  assert.equal(
    isRelayHtmlReport(
      `http://127.0.0.1:3001/media/${HASH}.html`,
      "http://localhost:3000",
    ),
    false,
  );
});

test("isRelayHtmlReport rejects other origins, paths and types", () => {
  const relay = "https://relay.example";
  assert.equal(
    isRelayHtmlReport(`https://other.example/media/${HASH}.html`, relay),
    false,
  );
  assert.equal(
    isRelayHtmlReport(`https://relay.example/files/${HASH}.html`, relay),
    false,
  );
  assert.equal(
    isRelayHtmlReport(`https://relay.example/media/${HASH}.pdf`, relay),
    false,
  );
  assert.equal(
    isRelayHtmlReport(`https://relay.example/media/${HASH}.html`, null),
    false,
  );
});

test("withReportCsp places the policy after the doctype", () => {
  const out = withReportCsp(
    "<!-- note --><!DOCTYPE html><html><head></head></html>",
  );
  assert.ok(out.startsWith("<!-- note --><!DOCTYPE html><meta http-equiv"));
  assert.ok(out.includes(REPORT_CSP));
});

test("withReportCsp leads a document without a doctype", () => {
  assert.ok(withReportCsp("<img src=x>").startsWith("<meta http-equiv"));
});

test("withViewerTheme marks the html element with the app theme", () => {
  assert.equal(
    withViewerTheme('<!doctype html><html lang="en"><body>', true),
    '<!doctype html><html data-theme="dark" lang="en"><body>',
  );
  assert.equal(
    withViewerTheme('<html data-theme="dark">', false),
    '<html data-theme="light">',
  );
  assert.equal(
    withViewerTheme("<!DOCTYPE html><p>x", true),
    '<!DOCTYPE html><html data-theme="dark"><p>x',
  );
});
