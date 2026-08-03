import { describe, it, expect } from "vitest";
import { shouldRejectInputType, sanitizeValue, renderMirrorHtml } from "../public/spell-helpers.js";

describe("shouldRejectInputType", () => {
  it("rejects replacement-style inserts (iOS autocorrect, paste, drop)", () => {
    expect(shouldRejectInputType("insertReplacementText")).toBe(true);
    expect(shouldRejectInputType("insertFromPaste")).toBe(true);
    expect(shouldRejectInputType("insertFromDrop")).toBe(true);
  });
  it("allows normal typing, deletion, and IME composition", () => {
    expect(shouldRejectInputType("insertText")).toBe(false);
    expect(shouldRejectInputType("deleteContentBackward")).toBe(false);
    expect(shouldRejectInputType("insertCompositionText")).toBe(false);
  });
  it("handles undefined inputType (some browsers omit it)", () => {
    expect(shouldRejectInputType(undefined)).toBe(false);
  });
});

describe("sanitizeValue", () => {
  it("keeps ascii letters as-is", () => {
    expect(sanitizeValue("book")).toBe("book");
  });
  it("strips non-ascii chars (chinese IME commit)", () => {
    expect(sanitizeValue("bo你好ok")).toBe("book");
  });
  it("keeps apostrophe and hyphen", () => {
    expect(sanitizeValue("don't")).toBe("don't");
    expect(sanitizeValue("mother-in-law")).toBe("mother-in-law");
  });
  it("preserves case (lowercasing happens at submit, not here)", () => {
    expect(sanitizeValue("MOTHER-IN-LAW")).toBe("MOTHER-IN-LAW");
  });
  it("strips whitespace", () => {
    expect(sanitizeValue("a b c")).toBe("abc");
  });
  it("strips emoji", () => {
    expect(sanitizeValue("🎉book")).toBe("book");
  });
});

describe("renderMirrorHtml", () => {
  it("renders value + blinking caret when non-empty", () => {
    expect(renderMirrorHtml("bo", "拼写英文单词")).toBe(`bo<i class="caret"></i>`);
  });
  it("renders placeholder + caret when empty", () => {
    expect(renderMirrorHtml("", "拼写英文单词")).toBe(`<span class="ph">拼写英文单词</span><i class="caret"></i>`);
  });
  it("escapes html-special chars in value (defense in depth)", () => {
    expect(renderMirrorHtml("<b>&", "p")).toBe(`&lt;b&gt;&amp;<i class="caret"></i>`);
  });
  it("escapes html-special chars in placeholder", () => {
    expect(renderMirrorHtml("", `<x>`)).toBe(`<span class="ph">&lt;x&gt;</span><i class="caret"></i>`);
  });
});
