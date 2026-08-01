import { describe, it, expect } from "vitest";
import { validateTerm, cacheKey, escapeXml } from "../src/tts";

describe("validateTerm", () => {
  it("returns null for missing / empty / whitespace", () => {
    expect(validateTerm(undefined)).toBeNull();
    expect(validateTerm("")).toBeNull();
    expect(validateTerm("   ")).toBeNull();
  });
  it("returns null when > 200 chars", () => {
    expect(validateTerm("a".repeat(201))).toBeNull();
  });
  it("returns null for disallowed characters", () => {
    expect(validateTerm("hello<world")).toBeNull();
    expect(validateTerm("a;b")).toBeNull();
    expect(validateTerm("你好")).toBeNull();
  });
  it("normalizes (trim + lowercase) allowed input", () => {
    expect(validateTerm("  Hello  ")).toBe("hello");
    expect(validateTerm("Fish-and-Chips")).toBe("fish-and-chips");
    expect(validateTerm("it's")).toBe("it's");
    expect(validateTerm("What?")).toBe("what?");
  });
});

describe("cacheKey", () => {
  it("joins lang, provider name, and term with the audio: prefix", () => {
    expect(cacheKey("en-US", "azure-jenny", "hello")).toBe("audio:en-US:azure-jenny:hello");
  });
});

describe("escapeXml", () => {
  it("escapes the five XML special characters", () => {
    expect(escapeXml("a & b < c > d \" e ' f"))
      .toBe("a &amp; b &lt; c &gt; d &quot; e &apos; f");
  });
  it("leaves other text untouched", () => {
    expect(escapeXml("hello world")).toBe("hello world");
  });
});
