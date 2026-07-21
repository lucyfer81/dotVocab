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
});
