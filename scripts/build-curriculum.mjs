// 离线生成五册教材核心词汇清单（共享词池导入数据）。
//
// 设计依据：docs/superpowers/specs/2026-11-22-shared-pool-fsrs-design.md
// 任务来源：docs/superpowers/plans/2026-11-22-shared-pool-fsrs.md 任务 1
//
// 用法（Node ≥ 18）：
//   node scripts/build-curriculum.mjs --preview   预览：逐册逐单元计数、重复与疑项（有未决时退出码 1）
//   node scripts/build-curriculum.mjs             生成 data/curriculum/books.json；存在未裁决条目时拒绝写出
//   node scripts/build-curriculum.mjs --check     连续构建两次：输出一致且未决数为 0 才通过
//   可选参数：--dir <词表目录>（默认下方 DEFAULT_DIR）
//             --overrides <path>（默认 data/curriculum/overrides.json）
//             --out <path>（默认 data/curriculum/books.json）
//
// 五份指定 Markdown 表按序号、单元、单词、读音、词义排列；Starter 编为 0。
// 保留非粗体词和短语，排除附录。兼容单元标题下的两列词表。
// 本模块顶层不依赖任何 Node 内置模块，可在 vitest workers 池中导入；
// 文件 IO 默认实现在函数内动态 import("node:fs")，仅真实 Node CLI 使用。

export const BOOK_SPECS = [
  { id: "一上", title: "一年级上", file: "一年级上-核心词汇表.md" },
  { id: "一下", title: "一年级下", file: "一年级下-核心词汇表.md" },
  { id: "二上", title: "二年级上", file: "二年级上-核心词汇表.md" },
  { id: "二下", title: "二年级下", file: "二年级下-核心词汇表.md" },
  { id: "三上", title: "三年级上", file: "三年级上-核心词汇表.md" },
];

export const SOURCE_LABEL = "working-vault/30-Resources/小学资源/英语单词";
const DEFAULT_DIR = "/home/ubuntu/working-vault/30-Resources/小学资源/英语单词";

const CJK_RE = /[\u3400-\u9fff]/;
const LATIN_RE = /[A-Za-z]/;
const UNIT_LINE_RE = /(?:^|[^\p{L}\p{N}])(?:unit|u)\s*(\d+)(?![\p{L}\p{N}])/iu;
const UNIT_CN_RE = /第\s*(\d+)\s*单元/;
const SENTENCE_SECTION_RE = /句|sentence/i;
const HEADER_TERMS = new Set([
  "word", "words", "english", "term", "单词", "词", "英文", "英语", "词语", "词汇",
]);

// ---------------------------------------------------------------------------
// 基础工具

function cleanCell(raw) {
  return String(raw ?? "")
    .replace(/\*\*|__|`/g, "")
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanMeaning(raw) {
  return cleanCell(raw).replace(/[；;。．.，,、\s]+$/, "").trim();
}

function cleanWord(w) {
  return w
    .replace(/^[.。!！?？,，;；、\s]+/, "")
    .replace(/[.。!！?？,，;；、]+$/, "")
    .trim()
    .toLowerCase();
}

function splitTermCell(termCell) {
  const parts = termCell.split(/\s*\/\s*/).map(cleanWord);
  if (parts.some((p) => p === "")) return null;
  return parts;
}

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function senseKeyOf(accepted, meaning) {
  const key = [...accepted].sort().join("/");
  return `${key}@${fnv1a(key + "\u0000" + meaning)}`;
}

function issue(type, blocking, fields) {
  return {
    type,
    blocking,
    book: fields.book ?? null,
    unit: fields.unit ?? null,
    row: fields.row ?? null,
    term: fields.term ?? null,
    meaning: fields.meaning ?? null,
    detail: fields.detail ?? "",
  };
}

function loc(i) {
  const unit = i.unit != null ? ` Unit ${i.unit}` : "";
  const row = i.row != null ? ` 行${i.row}` : "";
  return `${i.book ?? "?"}${unit}${row}`;
}

// ---------------------------------------------------------------------------
// Markdown 解析

function splitTableRow(line) {
  const t = String(line ?? "").trim();
  if (!t.startsWith("|")) return null;
  const body = t.replace(/^\|/, "").replace(/\|$/, "");
  const cells = body.split("|").map((c) => c.trim());
  if (cells.length < 2) return null;
  return cells;
}

function isSeparatorRow(cells) {
  return cells.every((c) => /^:?-{2,}:?$/.test(c.replace(/\s+/g, ""))) && cells.some((c) => /-/.test(c));
}

function detectUnit(text) {
  const m = UNIT_LINE_RE.exec(text) ?? UNIT_CN_RE.exec(text);
  return m ? Number(m[1]) : null;
}

function isHeaderish(termCell, meaningCell) {
  if (termCell === "") return true; // 首列为空视为表头/噪音
  if (HEADER_TERMS.has(termCell.toLowerCase())) return true;
  return !LATIN_RE.test(termCell) && (meaningCell === "" || CJK_RE.test(meaningCell));
}

// 解析单册内容为行记录。行号按“该单元内解析出的数据行”从 1 递增（含后来被去重的行）。
function parseBookContent(content) {
  const rows = [];
  const skipped = [];
  let unit = null;
  let inSentenceSection = false;
  let tableSeenData = false;
  let tableSeenHeader = false;
  const counters = new Map();
  let numbered = false;
  let appendix = false;

  for (const rawLine of String(content ?? "").split(/\r?\n/)) {
    const cells = splitTableRow(rawLine);
    if (!cells) {
      const text = String(rawLine ?? "").trim();
      tableSeenData = false;
      tableSeenHeader = false;
      if (!text) continue;
      const isHeading = /^#{1,6}\s/.test(text);
      const u = detectUnit(text);
      if (u != null) {
        unit = u;
        if (!isHeading || !SENTENCE_SECTION_RE.test(text)) inSentenceSection = false;
      }
      if (isHeading) appendix = text.includes("附录");
      if (isHeading && SENTENCE_SECTION_RE.test(text)) inSentenceSection = true;
      continue;
    }
    if (isSeparatorRow(cells)) continue;

    if (appendix) continue;
    if (cells.join("|") === "序号|单元|单词|读音|词义") { numbered = true; continue; }
    if (numbered) {
      if (cells.length !== 5 || !/^\d+$/.test(cells[0])) throw new Error("词表列结构异常：" + rawLine);
      unit = cells[1] === "Starter" ? 0 : detectUnit(cells[1]);
    }
    const termCell = cleanCell(cells[numbered ? 2 : 0]);
    const meaningCell = cleanMeaning(cells[numbered ? 4 : 1] ?? "");
    if (!numbered && termCell === "" && meaningCell === "") continue;
    if (!numbered && !tableSeenData && !tableSeenHeader && isHeaderish(termCell, meaningCell)) {
      tableSeenHeader = true;
      continue;
    }
    tableSeenData = true;

    if (inSentenceSection) {
      skipped.push({ term: termCell, heading: "句型段落" });
      continue;
    }
    if (unit == null) {
      rows.push({ unit: null, row: null, display: termCell, meaning: meaningCell, problem: { type: "missing-unit", detail: "表格出现在任何单元标题之前" } });
      continue;
    }
    const rowCounter = (counters.get(unit) ?? 0) + 1;
    counters.set(unit, rowCounter);
    const row = { unit, row: rowCounter, display: termCell, meaning: meaningCell };

    if (termCell === "") {
      row.problem = { type: "unparseable-term", detail: `词列为空；释义“${meaningCell}”` };
    } else if (CJK_RE.test(termCell)) {
      row.problem = { type: "mixed-script-term", detail: `词列混入中文“${termCell}”` };
    } else {
      const accepted = splitTermCell(termCell);
      if (!accepted) {
        row.problem = { type: "unparseable-term", detail: `无法从“${termCell}”拆出英文词（检查斜杠用法）` };
      } else if (meaningCell === "") {
        row.problem = { type: "missing-meaning", detail: "释义列为空" };
      } else if (!CJK_RE.test(meaningCell)) {
        row.problem = { type: "non-cjk-meaning", detail: `释义“${meaningCell}”不含中文，疑似列错位` };
      } else {
        row.accepted = accepted;
        row.key = [...accepted].sort().join("/");
      }
    }
    rows.push(row);
  }
  return { rows, skipped };
}

// ---------------------------------------------------------------------------
// 裁决与装配

function normalizeOverrides(raw) {
  const o = raw && typeof raw === "object" ? raw : {};
  const pick = (k) => (Array.isArray(o[k]) ? o[k] : []);
  return { merge: pick("merge"), split: pick("split"), aliases: pick("aliases"), ignore: pick("ignore") };
}

function matchesRow(ov, bookId, row) {
  return (
    ov.book === bookId &&
    Number(ov.unit) === row.unit &&
    cleanCell(String(ov.term ?? "")).toLowerCase() === String(row.display ?? "").toLowerCase()
  );
}

function overrideShapeIssue(ov, kind) {
  const bad =
    typeof ov?.book !== "string" ||
    ov.term === undefined || String(ov.term).trim() === "" ||
    !Number.isFinite(Number(ov?.unit));
  if (!bad) return null;
  return issue("override-invalid", true, {
    book: typeof ov?.book === "string" ? ov.book : null,
    term: String(ov?.term ?? ""),
    detail: `${kind} 条目缺少 book/unit/term`,
  });
}

function makeEntry(bookId, row, display, accepted, meaning) {
  return {
    senseKey: senseKeyOf(accepted, meaning),
    term: display,
    meaning,
    accepted: [...accepted],
    book: bookId,
    unit: row.unit,
    row: row.row,
  };
}

function resolveBookFiles(files, pushIssue) {
  return BOOK_SPECS.map((spec, idx) => {
    const chosen = files.includes(spec.file);
    if (!chosen) {
      pushIssue(idx, issue("missing-book", true, {
        book: spec.id,
        detail: `目录中未找到 ${spec.file}`,
      }));
      return null;
    }
    return { ...spec };
  });
}

/**
 * 构建五册教材词表。
 * @param {string} dir 词表目录（仅作为 io 的定位依据，注入 io 时不访问磁盘）
 * @param {object} overrides 人工裁决（merge/split/aliases/ignore，见 data/curriculum/overrides.json）
 * @param {{listFiles(): Promise<string[]>, readFile(name: string): Promise<string>}} [io]
 *        可注入的文件读取接口；缺省用 node:fs 实现真实目录读取。
 * @returns {Promise<{books: Array, issues: Array}>}
 */
export async function buildCurriculum(dir, overrides = {}, io) {
  const reader = io ?? (await defaultIo(dir));
  const files = (await reader.listFiles()).map(String);
  const ov = normalizeOverrides(overrides);
  const issues = [];
  const specIndexOf = new Map(BOOK_SPECS.map((s, i) => [s.id, i]));
  const pushIssue = (specIdx, i) => issues.push({ ...i, __bookIdx: specIdx });

  const specs = resolveBookFiles(files, pushIssue);

  // 裁决条目统一先做结构校验（只报告一次），有效条目稍后按命中情况检查 unused。
  const overrideLists = [
    ["merge", ov.merge], ["split", ov.split], ["aliases", ov.aliases], ["ignore", ov.ignore],
  ];
  const matched = new Set();
  const validOverrides = new Set();
  for (const [kind, list] of overrideLists) {
    for (const entryOv of list) {
      const shape = overrideShapeIssue(entryOv, kind);
      if (shape) pushIssue(-1, shape);
      else validOverrides.add(entryOv);
    }
  }

  for (const spec of specs) {
    if (!spec) continue;
    const idx = specIndexOf.get(spec.id);
    const content = await reader.readFile(spec.file);
    const { rows: parsedRows, skipped } = parseBookContent(content);
    for (const r of parsedRows) {
      const alias = ov.aliases.find(e => matchesRow(e, spec.id, r));
      if (r.problem?.type === "mixed-script-term" && alias?.display && /^[a-z -]+$/i.test(alias.display) && CJK_RE.test(r.meaning)) {
        delete r.problem;
        r.accepted = [cleanWord(alias.display)];
        r.key = r.display; // 带词性标注的源行单独裁决，保留其行序。
      }
    }
    for (const s of skipped) {
      pushIssue(idx, issue("skipped-section", false, { book: spec.id, term: s.term, detail: "句型段落，未采词" }));
    }
    for (const r of parsedRows) {
      if (r.unit == null) {
        pushIssue(idx, issue("missing-unit", true, {
          book: spec.id, term: r.display, meaning: r.meaning, detail: r.problem.detail,
        }));
      }
    }
    for (const e of validOverrides) {
      if (e.book === spec.id && parsedRows.some((r) => matchesRow(e, spec.id, r))) matched.add(e);
    }

    const isIgnored = (r) => ov.ignore.some((e) => matchesRow(e, spec.id, r));
    const entries = [];
    const rows = parsedRows.filter((r) => r.unit != null);

    // 按单元分组（保持出现顺序）。
    const units = new Map();
    for (const r of rows) {
      if (!units.has(r.unit)) units.set(r.unit, []);
      units.get(r.unit).push(r);
    }

    for (const [unitNo, unitRows] of units) {
      const live = unitRows.filter((r) => !isIgnored(r));

      for (const r of live) {
        if (r.problem) {
          pushIssue(idx, issue(r.problem.type, true, {
            book: spec.id, unit: unitNo, row: r.row, term: r.display, meaning: r.meaning, detail: r.problem.detail,
          }));
        }
      }

      const groups = new Map();
      for (const r of live) {
        if (r.problem || !r.key) continue;
        if (!groups.has(r.key)) groups.set(r.key, []);
        groups.get(r.key).push(r);
      }

      for (const [, grows] of groups) {
        const first = grows[0];
        const mergeOv = ov.merge.find((e) => grows.some((r) => matchesRow(e, spec.id, r)));
        const splitOv = ov.split.find((e) => grows.some((r) => matchesRow(e, spec.id, r)));
        const aliasOv = ov.aliases.find((e) => grows.some((r) => matchesRow(e, spec.id, r)));

        if (mergeOv && splitOv) {
          pushIssue(idx, issue("override-conflict", true, {
            book: spec.id, unit: unitNo, row: first.row, term: first.display,
            detail: "同一组词同时命中 merge 与 split",
          }));
          continue;
        }

        let produced = null;
        if (mergeOv) {
          const meaning = cleanMeaning(mergeOv.meaning);
          if (meaning === "") {
            pushIssue(idx, issue("override-invalid", true, {
              book: spec.id, unit: unitNo, row: first.row, term: first.display, detail: "merge 缺少有效释义",
            }));
            continue;
          }
          const accepted = Array.isArray(mergeOv.accepted)
            ? mergeOv.accepted.map(cleanWord).filter((w) => w !== "")
            : null;
          if (Array.isArray(mergeOv.accepted) && (!accepted || accepted.length === 0)) {
            pushIssue(idx, issue("override-invalid", true, {
              book: spec.id, unit: unitNo, row: first.row, term: first.display, detail: "merge.accepted 无有效词",
            }));
            continue;
          }
          produced = [{ meaning, accepted: accepted ?? [...first.accepted] }];
        } else if (splitOv) {
          const senses = Array.isArray(splitOv.senses) ? splitOv.senses : [];
          const cleaned = senses.map((s) => cleanMeaning(s?.meaning ?? ""));
          if (senses.length === 0 || cleaned.some((m) => m === "") || new Set(cleaned).size !== cleaned.length) {
            pushIssue(idx, issue("override-invalid", true, {
              book: spec.id, unit: unitNo, row: first.row, term: first.display,
              detail: "split.senses 需为非空且释义互不相同",
            }));
            continue;
          }
          produced = senses.map((s, i) => ({
            meaning: cleaned[i], display: s.display,
            accepted: Array.isArray(s.accepted) && s.accepted.map(cleanWord).filter((w) => w !== "").length
              ? s.accepted.map(cleanWord).filter((w) => w !== "")
              : [...first.accepted],
          }));
        } else {
          const distinct = [...new Set(grows.map((r) => r.meaning))];
          if (distinct.length > 1) {
            pushIssue(idx, issue("same-form-conflict", true, {
              book: spec.id, unit: unitNo, row: first.row, term: first.display,
              detail: grows.map((r) => `行${r.row} ${r.meaning}`).join("；") + "；需在 overrides.json 中 merge 或 split",
            }));
            continue;
          }
          produced = [{ meaning: distinct[0], accepted: [...first.accepted] }];
          for (const r of grows.slice(1)) {
            pushIssue(idx, issue("duplicate-row", false, {
              book: spec.id, unit: unitNo, row: r.row, term: r.display, meaning: r.meaning,
              detail: `与行${first.row}重复，已去重`,
            }));
          }
        }

        if (aliasOv) {
          const accepted = Array.isArray(aliasOv.accepted)
            ? aliasOv.accepted.map(cleanWord).filter((w) => w !== "")
            : [];
          if (accepted.length === 0) {
            pushIssue(idx, issue("override-invalid", true, {
              book: spec.id, unit: unitNo, row: first.row, term: first.display, detail: "aliases.accepted 无有效词",
            }));
            continue;
          }
          produced = produced.map((p) => ({ ...p, accepted }));
        }

        for (const p of produced) entries.push(makeEntry(spec.id, first, p.display ?? aliasOv?.display ?? first.display, p.accepted, p.meaning));
      }
    }

    entries.sort((a, b) => a.unit - b.unit || a.row - b.row || (a.senseKey < b.senseKey ? -1 : 1));
    // 同单元内相同 senseKey 只保留首条（防止拆分/别名造成重复卡面）。
    const seen = new Set();
    const deduped = [];
    for (const e of entries) {
      const id = `${e.unit}\u0000${e.senseKey}`;
      if (seen.has(id)) {
        pushIssue(idx, issue("duplicate-row", false, {
          book: spec.id, unit: e.unit, row: e.row, term: e.term, meaning: e.meaning,
          detail: `同单元同词义重复（senseKey ${e.senseKey}），保留首条`,
        }));
        continue;
      }
      seen.add(id);
      deduped.push(e);
    }
    spec.entries = deduped;
  }

  // 有效裁决条目必须命中至少一行，否则视为陈旧裁决，阻止生成。
  for (const e of validOverrides) {
    if (!matched.has(e)) {
      pushIssue(specIndexOf.get(e.book) ?? -1, issue("override-unused", true, {
        book: e.book, unit: Number(e.unit), term: cleanCell(String(e.term)),
        detail: "未命中任何已解析的行（核对 book/unit/term，或册文件是否缺失）",
      }));
    }
  }

  // 跨单元/跨册同词义：共享 senseKey（只占一个每日名额），列出供预览核对。
  const bySense = new Map();
  for (const spec of specs) {
    if (!spec) continue;
    for (const e of spec.entries ?? []) {
      const id = `${e.book}\u0000${e.unit}`;
      if (!bySense.has(e.senseKey)) bySense.set(e.senseKey, []);
      const list = bySense.get(e.senseKey);
      if (!list.some((l) => l.book === e.book && l.unit === e.unit)) list.push(e);
    }
  }
  for (const [senseKey, list] of bySense) {
    if (list.length < 2) continue;
    const idx = specIndexOf.get(list[0].book);
    pushIssue(idx, issue("cross-unit-repeat", false, {
      book: list[0].book, unit: list[0].unit, row: list[0].row, term: list[0].term, meaning: list[0].meaning,
      detail: `同词义出现于 ${list.map((e) => `${e.book} Unit${e.unit} 行${e.row}`).join("；")}（senseKey ${senseKey}）`,
    }));
  }

  issues.sort(
    (a, b) =>
      a.__bookIdx - b.__bookIdx ||
      (a.unit ?? -1) - (b.unit ?? -1) ||
      (a.row ?? -1) - (b.row ?? -1) ||
      (a.type < b.type ? -1 : a.type > b.type ? 1 : 0) ||
      (a.detail < b.detail ? -1 : 1)
  );

  const books = (specs ?? []).filter(Boolean).map((s) => ({
    id: s.id,
    title: s.title,
    file: s.file,
    entries: s.entries ?? [],
  }));
  return {
    books,
    issues: issues.map(({ __bookIdx, ...rest }) => rest),
  };
}

// ---------------------------------------------------------------------------
// 预览与产物

export function formatPreview(result) {
  const lines = ["== 教材词表预览 =="];
  for (const b of result.books) {
    const byUnit = new Map();
    for (const e of b.entries) byUnit.set(e.unit, (byUnit.get(e.unit) ?? 0) + 1);
    lines.push(`${b.id}（${b.file}）：${byUnit.size} 单元 / ${b.entries.length} 词条`);
    for (const [u, n] of [...byUnit.entries()].sort((x, y) => x[0] - y[0])) {
      lines.push(`  Unit ${u}：${n} 词条`);
    }
  }
  const blocking = result.issues.filter((i) => i.blocking);
  const info = result.issues.filter((i) => !i.blocking);
  lines.push(`信息类提示：${info.length} 条（重复行、跨单元重复、跳过句型段等，不阻止生成）`);
  lines.push(`未裁决条目：${blocking.length} 条${blocking.length ? "（存在未决时禁止生成正式数据）" : ""}`);
  const fmt = (i) => `  [${i.type}] ${loc(i)} ${i.term ?? ""}${i.detail ? "：" + i.detail : ""}`;
  for (const i of blocking) lines.push(fmt(i));
  for (const i of info) lines.push(fmt(i));
  return lines.join("\n");
}

export function renderBooksJson(result) {
  const payload = { version: 1, source: SOURCE_LABEL, books: result.books };
  return JSON.stringify(payload, null, 2) + "\n";
}

// ---------------------------------------------------------------------------
// CLI（仅在真实 Node 中执行；workers 测试池导入本模块不会触发）

async function defaultIo(dir) {
  const fs = await import("node:fs");
  const base = String(dir).replace(/\/+$/, "");
  return {
    async listFiles() {
      return fs.readdirSync(base);
    },
    async readFile(name) {
      return fs.readFileSync(`${base}/${name}`, "utf8");
    },
  };
}

function parseArgs(argv) {
  const flags = { preview: false, check: false, dir: DEFAULT_DIR, overrides: null, out: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--preview") flags.preview = true;
    else if (a === "--check") flags.check = true;
    else if (a === "--dir") flags.dir = String(argv[++i] ?? "");
    else if (a === "--overrides") flags.overrides = String(argv[++i] ?? "");
    else if (a === "--out") flags.out = String(argv[++i] ?? "");
    else {
      console.error(`未知参数：${a}（可用：--preview --check --dir --overrides --out）`);
      process.exitCode = 2;
    }
  }
  return flags;
}

async function main() {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");

  const flags = parseArgs(process.argv);
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const overridesPath = flags.overrides ?? path.join(repoRoot, "data", "curriculum", "overrides.json");
  const outPath = flags.out ?? path.join(repoRoot, "data", "curriculum", "books.json");

  if (!fs.existsSync(overridesPath)) {
    console.warn(`警告：未找到裁决文件 ${overridesPath}，按空裁决处理（同词异义等将报未决）。`);
  }
  const overrides = fs.existsSync(overridesPath)
    ? JSON.parse(fs.readFileSync(overridesPath, "utf8"))
    : {};

  const io = await defaultIo(flags.dir);

  if (flags.check) {
    const a = await buildCurriculum(flags.dir, overrides, io);
    const b = await buildCurriculum(flags.dir, overrides, io);
    const ja = renderBooksJson(a);
    const jb = renderBooksJson(b);
    const blocking = a.issues.filter((i) => i.blocking).length;
    let ok = ja === jb && blocking === 0;
    console.log(ja === jb ? "两次构建输出一致。" : "两次构建输出不一致！");
    console.log(blocking === 0 ? "未裁决条目：0。" : `未裁决条目：${blocking} 条（见 --preview）。`);
    if (fs.existsSync(outPath)) {
      const onDisk = fs.readFileSync(outPath, "utf8");
      ok = ok && onDisk === ja;
      console.log(onDisk === ja ? `与现有 ${outPath} 一致。` : `与现有 ${outPath} 不一致（需重新生成）。`);
    }
    console.log(ok ? "检查通过。" : "检查未通过。");
    process.exitCode = ok ? 0 : 1;
    return;
  }

  const result = await buildCurriculum(flags.dir, overrides, io);
  const blocking = result.issues.filter((i) => i.blocking);
  console.log(formatPreview(result));

  if (flags.preview) {
    if (blocking.length > 0) {
      console.log(`存在 ${blocking.length} 条未裁决条目（退出码 1）。`);
      process.exitCode = 1;
    }
    return;
  }

  if (blocking.length > 0) {
    console.error(`存在 ${blocking.length} 条未裁决条目，禁止生成正式数据；修正源表或 data/curriculum/overrides.json 后重试。`);
    process.exitCode = 1;
    return;
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, renderBooksJson(result));
  const total = result.books.reduce((n, b) => n + b.entries.length, 0);
  console.log(`已生成 ${outPath}：${result.books.length} 册 / ${total} 词条。`);
}

const isCli =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  /build-curriculum\.mjs$/.test(String(process.argv[1] ?? ""));

if (isCli) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
