import argparse
import csv
import json
import os
import time

import pdfplumber

from textbook_parser import (
    BOOK,
    cluster_rows,
    row_text,
    parse_lines,
    merge_meanings,
    generate_seed_sql,
    generate_reset_sql,
)

PDF_DEFAULT = "materials/三年级上.pdf"
OUT_DEFAULT = "scripts/out"


def build_lines(pdf_path):
    lines = []
    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            for row in cluster_rows(page.extract_words()):
                lines.append((row_text(row), row))
    return lines


def main():
    ap = argparse.ArgumentParser(description="三年级上 PDF → dotVocab seed")
    ap.add_argument("--pdf", default=PDF_DEFAULT)
    ap.add_argument("--out", default=OUT_DEFAULT)
    ap.add_argument("--reset", action="store_true",
                    help="另出 reset.sql（DESTRUCTIVE：清空词书与进度，保留 users）")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    anomalies = []
    units = parse_lines(build_lines(args.pdf), anomalies=anomalies)  # {n: [(term, meaning)]}
    unit_order = sorted(units)

    # 跨单元去重
    term_meanings = {}
    unit_words = {n: [] for n in unit_order}
    skipped = []
    for n in unit_order:
        for term, meaning in units[n]:
            if not term or not meaning:
                skipped.append((n, term, meaning))
                continue
            term_meanings.setdefault(term, []).append(meaning)
            if term not in unit_words[n]:
                unit_words[n].append(term)

    words = {}
    conflicts = []
    for term, ms in term_meanings.items():
        words[term] = merge_meanings(ms)
        if len(set(ms)) > 1:
            conflicts.append((term, ms))

    created_at = int(time.time() * 1000)

    # units.csv
    with open(os.path.join(args.out, "units.csv"), "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["unit", "words"])
        for n in unit_order:
            w.writerow([f"Unit {n}", len(units[n])])

    # UnitNN.csv
    for n in unit_order:
        with open(os.path.join(args.out, f"Unit{n:02d}.csv"), "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            for term, meaning in units[n]:
                w.writerow([term, meaning])

    # words.json（单一事实源）
    payload = {
        "book": BOOK,
        "created_at": created_at,
        "words": words,
        "units": {str(n): unit_words[n] for n in unit_order},
        "conflicts": [{"term": t, "meanings": ms} for t, ms in conflicts],
        "skipped": skipped,
    }
    with open(os.path.join(args.out, "words.json"), "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    # qa-report.txt
    total_entries = sum(len(units[n]) for n in unit_order)
    with open(os.path.join(args.out, "qa-report.txt"), "w", encoding="utf-8") as f:
        f.write(f"units: {len(unit_order)}  entries: {total_entries}  unique terms: {len(words)}\n\n")
        f.write("## 同词不同义（人工复核；如需修正，直接编辑 scripts/out/seed.sql 与 scripts/seed.example.sql）：\n")
        for t, ms in conflicts:
            f.write(f"  {t}: {ms}\n")
        if skipped:
            f.write("\n## 跳过（term/释义为空）：\n")
            for n, term, meaning in skipped:
                f.write(f"  Unit {n}: term={term!r} meaning={meaning!r}\n")
        if anomalies:
            f.write("\n## 对齐异常（英文/中文条目数不匹配或孤行，需人工核查）：\n")
            for unit_no, en, zh, reason in anomalies:
                f.write(f"  Unit {unit_no}: {reason} | EN={en!r} ZH={zh!r}\n")

    # seed.sql
    seed = generate_seed_sql(BOOK, unit_order, words, unit_words, created_at)
    with open(os.path.join(args.out, "seed.sql"), "w", encoding="utf-8") as f:
        f.write(seed)

    if args.reset:
        with open(os.path.join(args.out, "reset.sql"), "w", encoding="utf-8") as f:
            f.write(generate_reset_sql())

    print(f"units={len(unit_order)} entries={total_entries} unique={len(words)} "
          f"conflicts={len(conflicts)} skipped={len(skipped)}")
    print(f"artifacts in {args.out}/  (review units.csv, Unit*.csv, qa-report.txt)")


if __name__ == "__main__":
    main()
