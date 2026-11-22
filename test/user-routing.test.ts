import { describe, it, expect } from "vitest";
import { slugFromPath, nameForSlug, resolveUser, SLUG_BY_NAME } from "../public/user-routing.js";

const users = [
  { id: 1, name: "哥哥", avatar: "👦" },
  { id: 2, name: "弟弟", avatar: "👶" },
];

describe("slugFromPath", () => {
  it.each([["/xct", "xct"], ["/xct/", "xct"], ["/XCT", "xct"], ["/", ""], ["", ""], ["/foo/bar", "foo/bar"]])
    ("%s -> %s", (path, want) => expect(slugFromPath(path)).toBe(want));
});

describe("nameForSlug", () => {
  it("maps known slugs", () => {
    expect(nameForSlug("xct")).toBe("哥哥");
    expect(nameForSlug("lcl")).toBe("弟弟");
  });
  it("normalizes case and whitespace before comparing", () => {
    expect(nameForSlug(" XCT ")).toBe("哥哥");
  });
  it("returns null for unknown slug, empty, multi-segment path", () => {
    expect(nameForSlug("xtc")).toBeNull();
    expect(nameForSlug("")).toBeNull();
    expect(nameForSlug("foo/bar")).toBeNull();
  });
});

describe("resolveUser", () => {
  it("finds the user by exact name match", () => {
    expect(resolveUser("xct", users)).toEqual(users[0]);
    expect(resolveUser("lcl", users)).toEqual(users[1]);
  });
  it("returns null when name missing from users — never falls back to another user", () => {
    expect(resolveUser("xct", [{ id: 9, name: "小虎", avatar: "🐯" }])).toBeNull();
    expect(resolveUser("xtc", users)).toBeNull();
  });
});

describe("SLUG_BY_NAME", () => {
  it("is the exact two-account table", () => {
    expect(SLUG_BY_NAME).toEqual({ "哥哥": "xct", "弟弟": "lcl" });
  });
});
