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

// 分隔符嗅探：引号外出现 tab → tab，否则逗号。
function detectDelim(line: string): string {
  let inQ = false;
  for (const ch of line) {
    if (ch === '"') inQ = !inQ;
    else if (!inQ && ch === "\t") return "\t";
  }
  return ",";
}

// RFC4180 风格的单行切分：引号包裹的字段可含分隔符；"" 转义为 "。
// 容错：引号只在字段开头生效；收引号后的尾随字符原样保留。
function splitFields(line: string, delim: string): string[] {
  const fields: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
    } else if (ch === '"' && cur === "") {
      inQ = true;
    } else if (ch === delim) {
      fields.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  fields.push(cur.trim());
  return fields;
}

export function parseWordCsv(text: string): ParseResult {
  const rows: WordRow[] = [];
  const errors: ParseError[] = [];
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  lines.forEach((rawLine, i) => {
    const lineNo = i + 1;
    const line = rawLine.trim();
    if (line === "") return;
    const f = splitFields(line, detectDelim(line));
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
