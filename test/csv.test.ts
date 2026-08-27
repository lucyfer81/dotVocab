import { describe, it, expect } from "vitest";
import { parseWordCsv } from "../src/csv";

describe("parseWordCsv", () => {
  it("parses word + meaning (2 columns)", () => {
    const { rows, errors } = parseWordCsv("apple,苹果");
    expect(errors).toEqual([]);
    expect(rows).toEqual([
      { term: "apple", meaning_cn: "苹果", pos: null, example_en: null, example_cn: null },
    ]);
  });

  it("lowercases term and trims fields", () => {
    const { rows } = parseWordCsv("  Apple , 苹果 ");
    expect(rows[0].term).toBe("apple");
    expect(rows[0].meaning_cn).toBe("苹果");
  });

  it("parses all 5 columns: english,meaning,pos,ex_en,ex_cn", () => {
    const { rows } = parseWordCsv("cat,猫,n,A cat sat,一只猫坐着");
    expect(rows[0]).toEqual({
      term: "cat", meaning_cn: "猫", pos: "n", example_en: "A cat sat", example_cn: "一只猫坐着",
    });
  });

  it("supports tab as delimiter", () => {
    const { rows } = parseWordCsv("dog\t狗");
    expect(rows[0]).toEqual({ term: "dog", meaning_cn: "狗", pos: null, example_en: null, example_cn: null });
  });

  it("skips blank lines", () => {
    const { rows } = parseWordCsv("\napple,苹果\n\n");
    expect(rows.length).toBe(1);
  });

  it("errors on missing meaning but keeps other rows", () => {
    const { rows, errors } = parseWordCsv("apple,苹果\nbanana");
    expect(rows.length).toBe(1);
    expect(rows[0].term).toBe("apple");
    expect(errors.length).toBe(1);
    expect(errors[0].line).toBe(2);
  });

  it("strips a leading UTF-8 BOM from the first term", () => {
    const { rows, errors } = parseWordCsv("﻿apple,苹果");
    expect(errors).toEqual([]);
    expect(rows[0].term).toBe("apple");
    expect(rows[0].meaning_cn).toBe("苹果");
  });

  it("parses quoted fields containing commas (B3)", () => {
    const { rows, errors } = parseWordCsv('orange,"橙子, 柑橘",n,I like orange juice.,我喜欢橙汁。');
    expect(errors).toEqual([]);
    expect(rows[0]).toEqual({
      term: "orange", meaning_cn: "橙子, 柑橘", pos: "n",
      example_en: "I like orange juice.", example_cn: "我喜欢橙汁。",
    });
  });

  it("parses escaped double quotes inside quoted fields", () => {
    const { rows } = parseWordCsv('word,"He said ""hi""",n');
    expect(rows[0].meaning_cn).toBe('He said "hi"');
  });

  it("delimiter sniff ignores tabs inside quotes", () => {
    const { rows, errors } = parseWordCsv('a,"b\tc",d');
    expect(errors).toEqual([]);
    expect(rows[0]).toEqual({ term: "a", meaning_cn: "b\tc", pos: "d", example_en: null, example_cn: null });
  });

  it("tab-delimited lines still work with quoted commas", () => {
    const { rows, errors } = parseWordCsv('dog\t"狗, 犬"\tn');
    expect(errors).toEqual([]);
    expect(rows[0]).toEqual({ term: "dog", meaning_cn: "狗, 犬", pos: "n", example_en: null, example_cn: null });
  });

  it("accepts the full supported term charset (digits, ' . , ? ! -)", () => {
    const { rows, errors } = parseWordCsv(
      "ask...for help,向……求助\nwhat?,什么\nit's,它是\nmother-in-law,岳母\n3D,三维"
    );
    expect(errors).toEqual([]);
    expect(rows.map((r) => r.term)).toEqual(
      ["ask...for help", "what?", "it's", "mother-in-law", "3d"]
    );
  });

  it("rejects terms with unsupported chars, naming the first bad char", () => {
    const { rows, errors } = parseWordCsv(
      "apple,苹果\nbe interested in (doing),感兴趣\nwhat?,什么"
    );
    expect(rows.map((r) => r.term)).toEqual(["apple", "what?"]);
    expect(errors.length).toBe(1);
    expect(errors[0].line).toBe(2);
    expect(errors[0].message).toContain("(");
    expect(errors[0].message).toContain("be interested in (doing)");
  });

  it("rejects terms with non-ascii letters (accented / chinese)", () => {
    const { rows, errors } = parseWordCsv("café,咖啡\n苹果,apple");
    expect(rows.length).toBe(0);
    expect(errors.length).toBe(2);
    expect(errors[0].message).toContain("é");
    expect(errors[1].message).toContain("苹");
  });

  it("rejects terms longer than 200 chars", () => {
    const { rows, errors } = parseWordCsv(`${"a".repeat(201)},太长`);
    expect(rows.length).toBe(0);
    expect(errors.length).toBe(1);
    expect(errors[0].message).toContain("200");
  });
});
