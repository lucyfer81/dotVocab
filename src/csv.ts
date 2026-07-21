export interface WordRow {
  term: string;
  meaning_cn: string;
  pos: string | null;
  example_en: string | null;
  example_cn: string | null;
}

export interface ParseError {
  line: number;
  message: string;
}

export interface ParseResult {
  rows: WordRow[];
  errors: ParseError[];
}

function splitFields(line: string): string[] {
  const delim = line.includes("\t") ? "\t" : ",";
  return line.split(delim).map((f) => f.trim().replace(/^"|"$/g, ""));
}

export function parseWordCsv(text: string): ParseResult {
  const rows: WordRow[] = [];
  const errors: ParseError[] = [];
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  lines.forEach((rawLine, i) => {
    const lineNo = i + 1;
    const line = rawLine.trim();
    if (line === "") return;
    const f = splitFields(line);
    const term = (f[0] ?? "").toLowerCase();
    const meaning_cn = f[1] ?? "";
    if (!term) { errors.push({ line: lineNo, message: "缺少英文单词" }); return; }
    if (!meaning_cn) { errors.push({ line: lineNo, message: "缺少中文释义" }); return; }
    rows.push({
      term,
      meaning_cn,
      pos: f[2] || null,
      example_en: f[3] || null,
      example_cn: f[4] || null,
    });
  });
  return { rows, errors };
}
