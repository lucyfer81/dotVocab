import { describe, it, expect } from "vitest";
// @ts-expect-error 离线 Node 转换脚本（scripts/）不在 tsc 编译范围，无类型声明
import { buildCurriculum, BOOK_SPECS } from "../scripts/build-curriculum.mjs";

// 夹具模仿 vault 词表格式：每册一个 Markdown 文件，单元标题 + 两列表格。
// 词列可含 **加粗** 与 “/” 别名；表头行与分隔行应被跳过；句型段落不采词。
const BOOK_1A = [
  "# 一年级上 核心词汇",
  "",
  "## Unit 1",
  "",
  "| 英文 | 中文 |",
  "| --- | --- |",
  "| **hello** / hi | 你好 |",
  "| good morning | 早上好 |",
  "| cat | 猫 |",
  "| apple | 苹果 |",
  "| apple | 苹果 |",
  "| orange | 橙子 |",
  "| orange | 橙色 |",
  "| can | 能；可以 |",
  "| can | 罐头 |",
  "| dog | 狗 |",
  "",
  "## Unit 2 My day",
  "",
  "| 英文 | 中文 |",
  "| --- | --- |",
  "| dog | 狗 |",
  "| egg | 鸡蛋 |",
  "",
].join("\n");

const BOOK_2A = [
  "## Unit 1",
  "",
  "| 英文 | 中文 |",
  "| --- | --- |",
  "| fish | |",
  "| 猫 cat | 猫 |",
  "",
].join("\n");

const BOOK_1X = [
  "## Unit 1",
  "",
  "| word | 中文 |",
  "| --- | --- |",
  "| bag | 书包 |",
  "",
].join("\n");

const BOOK_2X = [
  "## Unit 1",
  "",
  "| word | 中文 |",
  "| --- | --- |",
  "| bed | 床 |",
  "",
].join("\n");

const BOOK_3A = [
  "## Unit 1",
  "",
  "| word | 中文 |",
  "| --- | --- |",
  "| pen | 钢笔 |",
  "",
  "## Unit 1 句子",
  "",
  "| 英文 | 中文 |",
  "| --- | --- |",
  "| Good morning. | 早上好。 |",
  "",
].join("\n");

const FILES: Record<string, string> = {
  "一年级上-核心词汇表.md": BOOK_1A,
  "一年级下-核心词汇表.md": BOOK_1X,
  "二年级上-核心词汇表.md": BOOK_2A,
  "二年级下-核心词汇表.md": BOOK_2X,
  "三年级上-核心词汇表.md": BOOK_3A,
};

const DIR = "fixture:英语单词";

// 注入式文件 IO：workers 测试池内不能使用 node:fs。
function io(files: Record<string, string>) {
  return {
    async listFiles(): Promise<string[]> {
      return Object.keys(files);
    },
    async readFile(name: string): Promise<string> {
      if (!(name in files)) throw new Error(`ENOENT: ${name}`);
      return files[name];
    },
  };
}

function findEntry(result: any, term: string) {
  return result.books
    .flatMap((b: any) => b.entries)
    .find((e: any) => e.term === term);
}

const ADJUDICATED = {
  split: [
    { book: "一上", unit: 1, term: "orange", senses: [{ meaning: "橙子" }, { meaning: "橙色" }] },
  ],
  merge: [
    { book: "一上", unit: 1, term: "can", meaning: "能；可以；罐头" },
  ],
  ignore: [
    { book: "二上", unit: 1, term: "fish", reason: "原表缺释义，修正后移除 ignore" },
    { book: "二上", unit: 1, term: "猫 cat", reason: "词列混入中文，修正原表后移除 ignore" },
  ],
};

describe("buildCurriculum 五册词表转换", () => {
  it("按固定顺序返回五册", async () => {
    const r = await buildCurriculum(DIR, {}, io(FILES));
    expect(r.books.map((b: any) => b.id)).toEqual(BOOK_SPECS.map((s: any) => s.id));
  });

  it("斜杠别名拆成可接受答案，斜杠不是必拼字符", async () => {
    const r = await buildCurriculum(DIR, {}, io(FILES));
    const hello = findEntry(r, "hello / hi");
    expect(hello).toBeDefined();
    expect(hello.accepted).toEqual(["hello", "hi"]);
    expect(hello.senseKey).toMatch(/^hello\/hi@[0-9a-f]{8}$/);
    expect(hello.term).toBe("hello / hi");
    expect(hello.meaning).toBe("你好");
    expect(hello.book).toBe("一上");
    expect(hello.unit).toBe(1);
    expect(hello.row).toBe(1);
  });

  it("收录短语与非加粗词", async () => {
    const r = await buildCurriculum(DIR, {}, io(FILES));
    const phrase = findEntry(r, "good morning");
    expect(phrase).toBeDefined();
    expect(phrase.accepted).toEqual(["good morning"]);
    const plain = findEntry(r, "cat"); // 无 **加粗** 标记
    expect(plain).toBeDefined();
    expect(plain.accepted).toEqual(["cat"]);
  });

  it("表头、分隔行与句型段落不被采词", async () => {
    const r = await buildCurriculum(DIR, {}, io(FILES));
    const terms = r.books.flatMap((b: any) => b.entries.map((e: any) => e.term));
    expect(terms).not.toContain("英文");
    expect(terms).not.toContain("word");
    // 三上仅 pen 进词表；“Unit 1 句子” 下的 Good morning 不采词。
    expect(r.books[4].entries.map((e: any) => e.term)).toEqual(["pen"]);
    expect(r.issues.some((i: any) => i.type === "skipped-section" && i.book === "三上")).toBe(true);
  });

  it("按单元与行序输出词条", async () => {
    const r = await buildCurriculum(DIR, {}, io(FILES));
    expect(r.books[0].entries.map((e: any) => [e.unit, e.row, e.term])).toEqual([
      [1, 1, "hello / hi"],
      [1, 2, "good morning"],
      [1, 3, "cat"],
      [1, 4, "apple"],
      [1, 10, "dog"],
      [2, 1, "dog"],
      [2, 2, "egg"],
    ]);
  });

  it("同词异义未裁决时报告冲突且不生成条目", async () => {
    const r = await buildCurriculum(DIR, {}, io(FILES));
    expect(findEntry(r, "orange")).toBeUndefined();
    expect(findEntry(r, "can")).toBeUndefined();
    const conflict = r.issues.filter((i: any) => i.type === "same-form-conflict");
    expect(conflict.map((i: any) => i.term).sort()).toEqual(["can", "orange"]);
    expect(conflict.every((i: any) => i.blocking)).toBe(true);
  });

  it("重复行去重并报告", async () => {
    const r = await buildCurriculum(DIR, {}, io(FILES));
    const apples = r.books[0].entries.filter((e: any) => e.term === "apple");
    expect(apples).toHaveLength(1);
    expect(apples[0].row).toBe(4);
    const dup = r.issues.find((i: any) => i.type === "duplicate-row" && i.term === "apple");
    expect(dup).toBeDefined();
    expect(dup.blocking).toBe(false);
    expect(dup.row).toBe(5);
  });

  it("结构性未决条目（缺释义、词列混中文）被报告且不入表", async () => {
    const r = await buildCurriculum(DIR, {}, io(FILES));
    expect(findEntry(r, "fish")).toBeUndefined();
    const missing = r.issues.find((i: any) => i.type === "missing-meaning");
    expect(missing).toBeDefined();
    expect(missing.blocking).toBe(true);
    expect(missing.term).toBe("fish");
    const mixed = r.issues.find((i: any) => i.type === "mixed-script-term");
    expect(mixed).toBeDefined();
    expect(mixed.blocking).toBe(true);
    expect(mixed.term).toBe("猫 cat");
  });

  it("跨单元同词义共享 senseKey 并提示重复", async () => {
    const r = await buildCurriculum(DIR, {}, io(FILES));
    const dogs = r.books[0].entries.filter((e: any) => e.term === "dog");
    expect(dogs).toHaveLength(2);
    expect(dogs[0].senseKey).toBe(dogs[1].senseKey);
    const repeat = r.issues.find((i: any) => i.type === "cross-unit-repeat" && i.term === "dog");
    expect(repeat).toBeDefined();
    expect(repeat.blocking).toBe(false);
  });

  it("overrides.split 将同形异义拆成独立词义", async () => {
    const r = await buildCurriculum(DIR, ADJUDICATED, io(FILES));
    const oranges = r.books[0].entries.filter((e: any) => e.term === "orange");
    expect(oranges).toHaveLength(2);
    expect(new Set(oranges.map((e: any) => e.meaning))).toEqual(new Set(["橙子", "橙色"]));
    expect(new Set(oranges.map((e: any) => e.senseKey)).size).toBe(2);
    expect(oranges.every((e: any) => e.accepted.includes("orange"))).toBe(true);
  });

  it("overrides.merge 合并词义、ignore 清噪，未决清零", async () => {
    const r = await buildCurriculum(DIR, ADJUDICATED, io(FILES));
    const cans = r.books[0].entries.filter((e: any) => e.term === "can");
    expect(cans).toHaveLength(1);
    expect(cans[0].meaning).toBe("能；可以；罐头");
    expect(cans[0].accepted).toEqual(["can"]);
    expect(cans[0].row).toBe(8);
    expect(findEntry(r, "fish")).toBeUndefined();
    expect(r.issues.filter((i: any) => i.blocking)).toHaveLength(0);
  });

  it("overrides.aliases 覆盖可接受答案", async () => {
    const overrides = {
      aliases: [{ book: "一上", unit: 1, term: "hello / hi", accepted: ["hello", "hi", "yo"] }],
    };
    const r = await buildCurriculum(DIR, overrides, io(FILES));
    expect(findEntry(r, "hello / hi").accepted).toEqual(["hello", "hi", "yo"]);
  });

  it("未命中的 override 报 override-unused（阻止生成）", async () => {
    const overrides = {
      merge: [{ book: "一上", unit: 1, term: "ghost", meaning: "幽灵" }],
    };
    const r = await buildCurriculum(DIR, overrides, io(FILES));
    const unused = r.issues.find((i: any) => i.type === "override-unused" && i.term === "ghost");
    expect(unused).toBeDefined();
    expect(unused.blocking).toBe(true);
  });

  it("对同一输入连续构建两次输出一致", async () => {
    const r1 = await buildCurriculum(DIR, ADJUDICATED, io(FILES));
    const r2 = await buildCurriculum(DIR, ADJUDICATED, io(FILES));
    expect(JSON.stringify(r2.books)).toBe(JSON.stringify(r1.books));
    expect(JSON.stringify(r2.issues)).toBe(JSON.stringify(r1.issues));
  });

  it("缺少册文件时报告 missing-book", async () => {
    const r = await buildCurriculum(DIR, {}, io({ "一年级上-核心词汇表.md": BOOK_1A }));
    expect(r.books.map((b: any) => b.id)).toEqual(["一上"]);
    const missing = r.issues.filter((i: any) => i.type === "missing-book");
    expect(missing).toHaveLength(4);
    expect(missing.every((i: any) => i.blocking)).toBe(true);
  });
});

it("真实五列表按行读取 Starter 和 Unit，忽略读音与词性附录", async () => {
  const file = "二年级上-核心词汇表.md";
  const text = ["| 序号 | 单元 | 单词 | 读音 | 词义 |", "|---|---|---|---|---|",
    "| 1 | Starter | **hello / hi** | /həˈləʊ/ | 你好 |",
    "| 2 | Unit 1 | good morning | /ɡʊd/ | 早上好 |",
    "## 附录：英语单词词性缩写对照表", "| n. | 名词 |"].join("\n");
  const { books } = await buildCurriculum(DIR, {}, io({ ...FILES, [file]: text }));
  expect(books[2].entries).toMatchObject([
    { unit: 0, row: 1, accepted: ["hello", "hi"], meaning: "你好" },
    { unit: 1, row: 1, accepted: ["good morning"], meaning: "早上好" },
  ]);
});
