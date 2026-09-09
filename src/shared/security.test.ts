import { describe, expect, it } from "vitest";
import { base64UrlToBytes, bytesToBase64Url, constantTimeEqual, hmacSha256Hex } from "./security";

describe("shared security helpers", () => {
  it("preserves unpadded base64url encoding", () => {
    const bytes = Uint8Array.from([0xfb, 0xff, 0xef, 0x00]);
    const encoded = bytesToBase64Url(bytes);
    expect(encoded).toBe("-__vAA");
    expect(base64UrlToBytes(encoded)).toEqual(bytes);
  });

  it("matches the RFC 4231 HMAC-SHA-256 vector", async () => {
    expect(await hmacSha256Hex("Jefe", "what do ya want for nothing?")).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
  });

  it("rejects length and content differences", () => {
    expect(constantTimeEqual("same", "same")).toBe(true);
    expect(constantTimeEqual("same", "sand")).toBe(false);
    expect(constantTimeEqual("same", "same-longer")).toBe(false);
  });
});
