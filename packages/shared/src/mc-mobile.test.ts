import { describe, expect, it } from "vitest";
import { isAllowedMobileMethod, parseMobilePairUri } from "./mc-mobile.js";

describe("mc-mobile", () => {
  it("parses valid mc-pair://v1 URIs with relay and multiple addresses", () => {
    const uri =
      "mc-pair://v1?node=1234567890abcdef1234567890abcdef&secret=abcdefghijklmnop123456&name=Work+Mac&relay=https%3A%2F%2Frelay.iroh.network&addr=192.168.1.5%3A12345&addr=10.0.0.2%3A12345";
    const res = parseMobilePairUri(uri);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.nodeId).toBe("1234567890abcdef1234567890abcdef");
      expect(res.value.secret).toBe("abcdefghijklmnop123456");
      expect(res.value.name).toBe("Work Mac");
      expect(res.value.relay).toBe("https://relay.iroh.network");
      expect(res.value.addrs).toEqual(["192.168.1.5:12345", "10.0.0.2:12345"]);
    }
  });

  it("rejects malformed, missing-field, or non-mc-pair URIs", () => {
    for (const bad of [
      "",
      "http://example.com/?node=1234567890abcdef&secret=1234567890abcdef",
      "mc-pair://v1?node=short&secret=abcdefghijklmnop123456",
      "mc-pair://v1?node=1234567890abcdef1234567890abcdef&secret=short",
      "mc-pair://v1?node=1234567890abcdef\n&secret=abcdefghijklmnop123456",
    ]) {
      expect(parseMobilePairUri(bad).ok).toBe(false);
    }
  });

  it("enforces the small-vocabulary method allowlist including whiteboard methods", () => {
    expect(isAllowedMobileMethod("attention.list")).toBe(true);
    expect(isAllowedMobileMethod("canvas.saveWhiteboard")).toBe(true);
    expect(isAllowedMobileMethod("approval.respond")).toBe(true);
    expect(isAllowedMobileMethod("settings.set")).toBe(false);
    expect(isAllowedMobileMethod("providers.getSecret")).toBe(false);
  });
});
