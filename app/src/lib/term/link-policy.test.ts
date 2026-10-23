import { test, expect, vi, afterEach } from "vitest";
import { safeLinkUrl, openTerminalLink } from "./link-policy";

afterEach(() => vi.restoreAllMocks());

test("allows http and https", () => {
  expect(safeLinkUrl("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
  expect(safeLinkUrl("http://localhost:3000")).toBe("http://localhost:3000/");
  expect(safeLinkUrl("  HTTPS://Example.com  ")).toBe("https://example.com/");
});

test.each([
  "javascript:alert(1)",
  "JaVaScRiPt:alert(1)",
  " javascript:alert(1)",
  "data:text/html,<script>alert(1)</script>",
  "file:///etc/passwd",
  "vbscript:msgbox(1)",
  "blob:https://example.com/x",
  "ftp://example.com",
  "tel:123",
  "//example.com",
  "example.com",
  "",
])("rejects %j", (text) => {
  expect(safeLinkUrl(text)).toBeNull();
});

test("openTerminalLink opens with noopener,noreferrer only for web URLs", () => {
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  openTerminalLink(new MouseEvent("click"), "https://example.com");
  expect(open).toHaveBeenCalledWith("https://example.com/", "_blank", "noopener,noreferrer");
  open.mockClear();
  openTerminalLink(new MouseEvent("click"), "javascript:alert(1)");
  expect(open).not.toHaveBeenCalled();
});
