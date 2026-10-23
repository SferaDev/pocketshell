import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { resolveStatic, contentEtag, isNotModified, inlineScriptHashes, buildAppCsp, staticSecurityHeaders } from "./static-serve";

const keys = new Set(["/index.html", "/assets/index-abc.js", "/assets/index-abc.css", "/favicon.svg"]);

test("root serves index.html with no-cache", () => {
  const r = resolveStatic("/", "text/html", keys);
  expect(r).toEqual({ status: 200, assetKey: "/index.html", headers: { "Cache-Control": "no-cache" } });
});

test("hashed assets get immutable long cache", () => {
  const r = resolveStatic("/assets/index-abc.js", "*/*", keys);
  expect(r.status).toBe(200);
  expect(r.assetKey).toBe("/assets/index-abc.js");
  expect(r.headers["Cache-Control"]).toBe("public, max-age=31536000, immutable");
});

test("non-/assets root file (favicon) is no-cache", () => {
  expect(resolveStatic("/favicon.svg", "*/*", keys).headers["Cache-Control"]).toBe("no-cache");
});

test("unknown navigation request falls back to index.html (SPA)", () => {
  const r = resolveStatic("/some/deep/route", "text/html,application/xhtml+xml", keys);
  expect(r).toEqual({ status: 200, assetKey: "/index.html", headers: { "Cache-Control": "no-cache" } });
});

test("unknown non-navigation request is 404 (no SPA fallback for assets)", () => {
  expect(resolveStatic("/missing.js", "*/*", keys).status).toBe(404);
});

test("empty asset map is always 404", () => {
  expect(resolveStatic("/", "text/html", new Set()).status).toBe(404);
});

const withVariants = new Set([
  "/index.html",
  "/index.html.br",
  "/index.html.gz",
  "/assets/index-abc.js",
  "/assets/index-abc.js.gz",
  "/favicon.svg",
]);

test("br preferred when client accepts br and .br exists", () => {
  const r = resolveStatic("/", "text/html", withVariants, "gzip, deflate, br");
  expect(r.assetKey).toBe("/index.html.br");
  expect(r.contentType).toBe("text/html; charset=utf-8");
  expect(r.headers["Content-Encoding"]).toBe("br");
  expect(r.headers["Vary"]).toBe("Accept-Encoding");
  expect(r.headers["Cache-Control"]).toBe("no-cache");
});

test("gzip chosen when br sibling missing, with original content-type", () => {
  const r = resolveStatic("/assets/index-abc.js", "*/*", withVariants, "gzip, br");
  expect(r.assetKey).toBe("/assets/index-abc.js.gz");
  expect(r.contentType).toBe("text/javascript; charset=utf-8");
  expect(r.headers["Content-Encoding"]).toBe("gzip");
  expect(r.headers["Cache-Control"]).toBe("public, max-age=31536000, immutable");
});

test("identity variant when client accepts no supported encoding (Vary still set)", () => {
  const r = resolveStatic("/", "text/html", withVariants, "");
  expect(r.assetKey).toBe("/index.html");
  expect(r.contentType).toBeUndefined();
  expect(r.headers["Content-Encoding"]).toBeUndefined();
  expect(r.headers["Vary"]).toBe("Accept-Encoding");
});

test("encoding tokens tolerate parameters and whitespace", () => {
  const r = resolveStatic("/", "text/html", withVariants, "br;q=1.0, gzip;q=0.5");
  expect(r.assetKey).toBe("/index.html.br");
});

test("file without compressed siblings is served as before", () => {
  const r = resolveStatic("/favicon.svg", "*/*", withVariants, "br");
  expect(r).toEqual({ status: 200, assetKey: "/favicon.svg", headers: { "Cache-Control": "no-cache" } });
});

test("SPA fallback honors compressed index.html variant", () => {
  const r = resolveStatic("/deep/route", "text/html", withVariants, "br");
  expect(r.assetKey).toBe("/index.html.br");
  expect(r.headers["Content-Encoding"]).toBe("br");
});

test("contentEtag is a quoted, stable, content-derived token", () => {
  const a = contentEtag(new TextEncoder().encode("hello"));
  expect(a).toMatch(/^"[0-9a-f]{16}"$/);
  expect(contentEtag(new TextEncoder().encode("hello"))).toBe(a);
  expect(contentEtag(new TextEncoder().encode("world"))).not.toBe(a);
  expect(contentEtag(new TextEncoder().encode("hello").buffer as ArrayBuffer)).toBe(a);
});

test("isNotModified matches exact, list, weak and star forms", () => {
  const etag = '"abc123"';
  expect(isNotModified(null, etag)).toBe(false);
  expect(isNotModified('"abc123"', etag)).toBe(true);
  expect(isNotModified('"other", "abc123"', etag)).toBe(true);
  expect(isNotModified('W/"abc123"', etag)).toBe(true);
  expect(isNotModified("*", etag)).toBe(true);
  expect(isNotModified('"other"', etag)).toBe(false);
});

test("inlineScriptHashes hashes inline scripts only", () => {
  const html = '<script>var a=1;</script><script type="module" src="/x.js"></script><script src="/y.js"></script>';
  const want = `'sha256-${createHash("sha256").update("var a=1;").digest("base64")}'`;
  expect(inlineScriptHashes(html)).toEqual([want]);
});

test("app CSP is strict and scopes ws/wss to the request host", () => {
  const csp = buildAppCsp(["'sha256-abc='"], "pocket.example:8722");
  const dirs = Object.fromEntries(csp.split("; ").map((d) => [d.split(" ")[0], d.split(" ").slice(1)]));
  expect(dirs["default-src"]).toEqual(["'self'"]);
  expect(dirs["script-src"]).toEqual(["'self'", "'wasm-unsafe-eval'", "'sha256-abc='"]);
  expect(csp).not.toContain("'unsafe-eval'");
  expect(dirs["script-src"]).not.toContain("'unsafe-inline'");
  expect(dirs["connect-src"]).toEqual(["'self'", "ws://pocket.example:8722", "wss://pocket.example:8722"]);
  expect(dirs["object-src"]).toEqual(["'none'"]);
  expect(dirs["base-uri"]).toEqual(["'none'"]);
  expect(dirs["frame-ancestors"]).toEqual(["'none'"]);
  expect(dirs["frame-src"]).toEqual(["'self'"]);
});

test("app CSP drops a malformed host instead of injecting it", () => {
  expect(buildAppCsp([], "evil; script-src *")).toContain("connect-src 'self'");
  expect(buildAppCsp([], "evil; script-src *")).not.toContain("evil");
  expect(buildAppCsp([], null)).toContain("connect-src 'self';");
  expect(buildAppCsp([], "[::1]:8722")).toContain("ws://[::1]:8722");
});

test("staticSecurityHeaders adds nosniff and no-referrer", () => {
  const h = staticSecurityHeaders([], "h:1");
  expect(h["X-Content-Type-Options"]).toBe("nosniff");
  expect(h["Referrer-Policy"]).toBe("no-referrer");
  expect(h["Content-Security-Policy"]).toContain("default-src 'self'");
});
