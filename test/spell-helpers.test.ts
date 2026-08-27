import { describe, it, expect } from "vitest";
import { shouldRejectInputType, sanitizeValue, renderMirrorHtml, diffHtml } from "../public/spell-helpers.js";

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
  it("keeps single spaces so phrases can be typed", () => {
    expect(sanitizeValue("ice cream")).toBe("ice cream");
  });
  it("collapses consecutive spaces into one", () => {
    expect(sanitizeValue("ice  cream")).toBe("ice cream");
  });
  it("strips leading spaces (term never starts with a space)", () => {
    expect(sanitizeValue(" ice")).toBe("ice");
  });
  it("keeps a trailing space while typing mid-word", () => {
    expect(sanitizeValue("ice ")).toBe("ice ");
  });
  it("strips tabs and newlines", () => {
    expect(sanitizeValue("a\tb\nc")).toBe("abc");
  });
  it("keeps dots so terms like ask...for help can be typed", () => {
    expect(sanitizeValue("ask...for help")).toBe("ask...for help");
  });
  it("keeps punctuation a stored term may contain (aligned with validateTerm charset)", () => {
    expect(sanitizeValue("what?")).toBe("what?");
    expect(sanitizeValue("wow!")).toBe("wow!");
    expect(sanitizeValue("hello, world")).toBe("hello, world");
    expect(sanitizeValue("3D")).toBe("3D");
  });
  it("strips html-special chars not in the term charset", () => {
    expect(sanitizeValue("<script>")).toBe("script");
    expect(sanitizeValue("a;b")).toBe("ab");
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

describe("diffHtml", () => {
  it("marks matching letters ok and mismatching letters bad, aligned by position", () => {
    expect(diffHtml("cat", "cat")).toBe(`<b class="ok">c</b><b class="ok">a</b><b class="ok">t</b>`);
    expect(diffHtml("cat", "cap")).toBe(`<b class="ok">c</b><b class="ok">a</b><b class="bad">t</b>`);
  });
  it("shows shorter answers as fully bad", () => {
    expect(diffHtml("cat", "ca")).toBe(`<b class="ok">c</b><b class="ok">a</b><b class="bad">t</b>`);
    expect(diffHtml("cat", "")).toBe(`<b class="bad">c</b><b class="bad">a</b><b class="bad">t</b>`);
  });
  it("shows extra typed letters as strikethrough extras instead of dropping them", () => {
    expect(diffHtml("cat", "catts")).toBe(
      `<b class="ok">c</b><b class="ok">a</b><b class="ok">t</b><b class="bad extra">ts</b>`
    );
  });
  it("escapes html-special letters (defense in depth)", () => {
    expect(diffHtml("don't", "dont")).toContain(`&#39;`);
    expect(diffHtml("don't", "don'tt")).toContain(`<b class="bad extra">t</b>`);
  });
});
