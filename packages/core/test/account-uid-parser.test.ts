import { describe, expect, it } from "vitest";
import { accountUidFromIdToken } from "../src/index";
const b64url = (t: string) => Buffer.from(t).toString("base64url");
const header = b64url(JSON.stringify({ alg: "none", typ: "JWT" }));
const tokSub = (sub: unknown, sig = "sig") => `${header}.${b64url(JSON.stringify({ sub }))}.${sig}`;
const sized = (n: number) => {
  const base = `${header}.${b64url(JSON.stringify({ sub: "user-1", pad: "" }))}.sig`;
  // grow the pad until the token length is exactly n (base64url grows 4 chars per 3 bytes, so tune the sig instead)
  let pad = "";
  let t = base;
  while (t.length < n - 8) { pad += "x".repeat(Math.max(1, Math.floor((n - 8 - t.length) * 0.75))); t = `${header}.${b64url(JSON.stringify({ sub: "user-1", pad }))}.s`; }
  t = `${header}.${b64url(JSON.stringify({ sub: "user-1", pad }))}.${"s".repeat(n - t.length + 1)}`;
  expect(t.length).toBe(n);
  return t;
};
const call = (t: unknown) => { let o: unknown = "threw"; expect(() => { o = accountUidFromIdToken(t as string); }).not.toThrow(); return o; };

describe("PR #4 parser rules ahead of the rebase (Avery's review)", () => {
  it("16384-char token is accepted", () => { expect(call(sized(16384))).toBe("user-1"); });
  it.fails("16385-char token -> null (16 KB cap)", () => { const t = sized(16385); expect(call(t)).toBeNull(); });
  it("sub of 128 printable ASCII chars is accepted", () => { expect(call(tokSub("a".repeat(128)))).toBe("a".repeat(128)); });
  it("empty sub -> null", () => { expect(call(tokSub(""))).toBeNull(); });
  it.fails("sub of 129 chars -> null", () => { expect(call(tokSub("a".repeat(129)))).toBeNull(); });
  it.fails("sub with a space -> null", () => { expect(call(tokSub("user 1"))).toBeNull(); });
  it.fails("whitespace-only sub -> null", () => { expect(call(tokSub("   "))).toBeNull(); });
  it.fails("non-ASCII sub -> null", () => { expect(call(tokSub("usér"))).toBeNull(); });
  it.fails("control char in sub -> null", () => { expect(call(tokSub("user\u0001"))).toBeNull(); });
  it.fails("DEL (0x7F) in sub -> null", () => { expect(call(tokSub("user\u007f"))).toBeNull(); });
  it("boundary chars 0x21 and 0x7E accepted", () => { expect(call(tokSub("!~"))).toBe("!~"); });
  it.fails("empty signature part -> null", () => { expect(call(tokSub("user-1", ""))).toBeNull(); });
  it.fails("signature with non-base64url chars -> null", () => { expect(call(tokSub("user-1", "ab+/="))).toBeNull(); });
  it("header with non-base64url chars -> null (pins header regex; survivor mutant)", () => { expect(call(`ab+/.${b64url(JSON.stringify({ sub: "user-1" }))}.sig`)).toBeNull(); });
  it("payload in std base64 with + or / -> null (pins payload regex; survivor mutant)", () => {
    const p = Buffer.from(JSON.stringify({ sub: "user-1", p: "\u00fb\u00ff\u00bf" })).toString("base64").replace(/=+$/, "");
    expect(p).toMatch(/[+/]/); expect(call(`${header}.${p}.sig`)).toBeNull();
  });
  it.each([undefined, null, 42, {}])("non-string input %s -> null", (v) => { expect(call(v)).toBeNull(); });
});

describe("accountUidFromIdToken edge probes folded from Morgan's PR #4 review", () => {
  it.each([["null", null], ["array", ["u"]], ["object", { id: "u" }]])("sub as %s -> null", (_l, sub) => {
    expect(call(tokSub(sub))).toBeNull();
  });
  it("array input -> null", () => { expect(call(["a", "b", "c"])).toBeNull(); });
  it("payload with invalid UTF-8 bytes -> no throw", () => {
    const bad = Buffer.from([0x7b, 0x22, 0x73, 0x75, 0x62, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0x22, 0x7d]).toString("base64url");
    expect(() => accountUidFromIdToken(`${header}.${bad}.sig`)).not.toThrow();
  });
  it("payload with a lone-surrogate escape -> no throw", () => {
    expect(() => accountUidFromIdToken(`${header}.${b64url('{"sub":"u-\\ud800"}')}.sig`)).not.toThrow();
  });
  it("huge token (8 MB payload) -> no throw, returns quickly", () => {
    const t0 = Date.now();
    expect(() => accountUidFromIdToken(`${header}.${b64url(JSON.stringify({ sub: "u", pad: "x".repeat(8_000_000) }))}.sig`)).not.toThrow();
    expect(Date.now() - t0).toBeLessThan(5000);
  });
  it("user_id: null alongside a valid sub -> null", () => {
    expect(call(`${header}.${b64url(JSON.stringify({ sub: "user-1", user_id: null }))}.sig`)).toBeNull();
  });
});
