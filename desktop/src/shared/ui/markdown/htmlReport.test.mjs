import assert from "node:assert/strict";
import { test } from "node:test";

import {
  REPORT_CSP,
  isHtmlFilename,
  isRelayHtmlReport,
  withReportCsp,
} from "./htmlReport.ts";

const HASH = "a".repeat(64);

test("isHtmlFilename matches .html and .htm only", () => {
  assert.equal(isHtmlFilename("report.HTML"), true);
  assert.equal(isHtmlFilename("report.htm"), true);
  assert.equal(isHtmlFilename("report.html.pdf"), false);
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
