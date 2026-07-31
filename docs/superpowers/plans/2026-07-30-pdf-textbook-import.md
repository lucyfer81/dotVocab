# 三年级上 PDF 词书导入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `materials/三年级上.pdf`（沪教新版三年级英语上册，10 单元）的核心词汇解析成 `(term, meaning_cn)` 对，生成幂等 `seed.sql`，全量清零线上词书后导入。

**Architecture:** 一个离线 Python 流水线（`scripts/`，uv `.venv` + pdfplumber）。纯解析逻辑放在可测的 `scripts/textbook_parser.py`（无 pdfplumber 依赖），CLI 与文件写入放在 `scripts/import_textbook.py`。核心难点——多词短语对齐——用 PDF 词块的 x 坐标按列归组解决（已原型验证）。产出 `scripts/out/` 下的 CSV/JSON/QA 复核件 + `seed.sql`；本地 `--local` 验证后，备份线上、全量清零、再 `--remote` 导入。

**Tech Stack:** Python 3.12（uv `.venv`）、pdfplumber、pytest；Cloudflare D1（`wrangler d1 execute/export`）。

**Spec:** `docs/superpowers/specs/2026-07-30-pdf-textbook-import-design.md`

> **一处对 spec 的细化（已在下方实现）：** spec §5 说「去掉被更长释义包含的子串」。原型发现这会误删——`水` 是 `给…浇水` 的子串却语义独立。故 `merge_meanings` 改为**仅去重完全相同的释义**，全部不同释义用 `；` 保留，并在 QA 报告里标记供人工裁剪。结果更诚实、不丢义。

---

## File Structure

- **Create** `scripts/textbook_parser.py` — 纯解析/生成逻辑（无 pdfplumber 依赖，可单测）。
  - `cluster_rows`, `row_text`, `is_cjk_row`, `is_latin_row`
  - `normalize_term`, `clean_meaning`
  - `align_row`（x 坐标列归组，核心）
  - `parse_lines`（按单元/小节状态机）
  - `merge_meanings`（跨单元同词去重）
  - `sql_quote`, `generate_seed_sql`, `generate_reset_sql`
- **Create** `scripts/import_textbook.py` — CLI：读 PDF → 调 parser → 写 `scripts/out/` 复核件 + `seed.sql`（`--reset` 另出 `reset.sql`）。
- **Create** `scripts/test_parser.py` — pytest 单元测试（合成词块，不依赖 PDF）。
- **Create** `scripts/test_pdf_smoke.py` — pytest：对真实 PDF 跑全流程并断言结构不变式（文件缺失则 skip）。
- **Create** `pytest.ini` — 限定 `testpaths = scripts`，避免扫描 node_modules。
- **Modify** `.gitignore` — 追加 `.venv/`、`scripts/out/`、`materials/`。
- **Create (产物，gitignore)** `scripts/out/{units.csv,Unit01.csv..Unit10.csv,words.json,qa-report.txt,seed.sql,reset.sql,backup-remote.sql}`。

---

### Task 1: 脚手架（uv 依赖、pytest、.gitignore、目录）

**Files:**
- Modify: `.gitignore`
- Create: `pytest.ini`

- [ ] **Step 1: 装 pytest 进 .venv**

Run:
```bash
uv pip install --python .venv/bin/python pytest
```
Expected: `+ pytest==…`，退出码 0。

- [ ] **Step 2: 更新 .gitignore**

把 `.gitignore` 末尾追加（用 Edit 工具，保持现有内容）：
```
.venv/
scripts/out/
materials/
```

- [ ] **Step 3: 写 pytest.ini**

Create `pytest.ini`：
```ini
[pytest]
testpaths = scripts
python_files = test_*.py
```

- [ ] **Step 4: 验证 pytest 能空跑**

Run:
```bash
.venv/bin/python -m pytest scripts -q
```
Expected: `no tests ran`（或 `0 selected`），退出码 0/5，不报收集错误。

- [ ] **Step 5: 提交**

```bash
git add .gitignore pytest.ini
git commit -m "chore(py): 加 pytest + gitignore venv/out/materials"
```

---

### Task 2: 文本规范化（normalize_term / clean_meaning）— TDD

**Files:**
- Create: `scripts/textbook_parser.py`
- Test: `scripts/test_parser.py`

- [ ] **Step 1: 写失败测试**

Create `scripts/test_parser.py`：
```python
from textbook_parser import normalize_term, clean_meaning


def test_normalize_term():
    assert normalize_term("  Play  Sports ") == "play sports"
    assert normalize_term("New") == "new"


def test_clean_meaning_strips_trailing_punct():
    assert clean_meaning("厨师;") == "厨师"
    assert clean_meaning("太空；") == "太空"
    assert clean_meaning("擅长于...") == "擅长于"
    assert clean_meaning("目标;目的") == "目标;目的"
    assert clean_meaning("  水  ") == "水"
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `.venv/bin/python -m pytest scripts/test_parser.py -q`
Expected: FAIL（`ModuleNotFoundError: No module named 'textbook_parser'`）。

- [ ] **Step 3: 写最小实现**

Create `scripts/textbook_parser.py`：
```python
import re

CJK_RE = re.compile(r"[一-鿿]")
LATIN_RE = re.compile(r"[A-Za-z]")
UNIT_HEADER_RE = re.compile(r"U(\d+)\s*词句汇总")
NUMERAL_HEADER_RE = re.compile(r"^\s*[一二三四五六七八九十]+\s*、")
SECTION_VOCAB = "核心词汇"
SECTION_SENTENCE = "核心句子"
TRAIL_PUNCT = "；;。……· •\t,."

BOOK = "三年级上(沪教新版)"


def normalize_term(s: str) -> str:
    return re.sub(r"\s+", " ", s.strip().lower())


def clean_meaning(s: str) -> str:
    return s.strip().rstrip(TRAIL_PUNCT).strip()
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `.venv/bin/python -m pytest scripts/test_parser.py -q`
Expected: PASS（2 个用例）。

- [ ] **Step 5: 提交**

```bash
git add scripts/textbook_parser.py scripts/test_parser.py
git commit -m "feat(parse): 词项/释义规范化"
```

---

### Task 3: 行聚类与中/英行判定（cluster_rows / row_text / is_cjk_row / is_latin_row）— TDD

**Files:**
- Modify: `scripts/textbook_parser.py`
- Test: `scripts/test_parser.py`

- [ ] **Step 1: 写失败测试**

在 `scripts/test_parser.py` 末尾追加：
```python
from textbook_parser import cluster_rows, row_text, is_cjk_row, is_latin_row


def _box(text, x0, x1, top):
    return {"text": text, "x0": x0, "x1": x1, "top": top}


def test_cluster_rows_groups_by_top():
    words = [
        _box("new", 100, 120, 133),
        _box("school", 180, 220, 134),     # 与上一行 top 差 1 → 同行
        _box("新的", 100, 120, 153),
    ]
    rows = cluster_rows(words)
    assert len(rows) == 2
    assert row_text(rows[0]) == "newschool"
    assert row_text(rows[1]) == "新的"


def test_row_classification():
    en = [_box("play", 100, 120, 100), _box("sports", 130, 160, 100)]
    zh = [_box("运动", 100, 120, 120)]
    assert is_latin_row(en) and not is_cjk_row(en)
    assert is_cjk_row(zh) and not is_latin_row(zh)
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `.venv/bin/python -m pytest scripts/test_parser.py -q`
Expected: FAIL（`ImportError: cannot import name 'cluster_rows'`）。

- [ ] **Step 3: 写最小实现**

在 `scripts/textbook_parser.py` 的 `clean_meaning` 之后追加：
```python
def cluster_rows(words, tol=3.0):
    rows = []
    for w in sorted(words, key=lambda x: x["top"]):
        if rows and abs(w["top"] - rows[-1][0]["top"]) <= tol:
            rows[-1].append(w)
        else:
            rows.append([w])
    for r in rows:
        r.sort(key=lambda x: x["x0"])
    return rows


def row_text(row) -> str:
    return "".join(w["text"] for w in row)


def is_cjk_row(row) -> bool:
    return bool(CJK_RE.search(row_text(row)))


def is_latin_row(row) -> bool:
    t = row_text(row)
    return bool(LATIN_RE.search(t)) and not CJK_RE.search(t)
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `.venv/bin/python -m pytest scripts/test_parser.py -q`
Expected: PASS（4 个用例）。

- [ ] **Step 5: 提交**

```bash
git add scripts/textbook_parser.py scripts/test_parser.py
git commit -m "feat(parse): 行聚类 + 中/英行判定"
```

---

### Task 4: 多词短语列归组（align_row）— TDD 【核心】

**Files:**
- Modify: `scripts/textbook_parser.py`
- Test: `scripts/test_parser.py`

- [ ] **Step 1: 写失败测试**

在 `scripts/test_parser.py` 末尾追加：
```python
from textbook_parser import align_row


def test_align_row_one_to_one():
    en = [_box("new", 100, 120, 100), _box("school", 180, 220, 100)]
    zh = [_box("新的", 100, 120, 120), _box("学校", 180, 220, 120)]
    assert align_row(en, zh) == [("new", "新的"), ("school", "学校")]


def test_align_row_groups_two_word_phrase():
    # 中文「运动」居中落在 play+sports 整组下方
    en = [_box("play", 448.8, 473.8, 133), _box("sports", 477.1, 514.9, 133)]
    zh = [_box("运动", 469.9, 493.9, 153)]
    assert align_row(en, zh) == [("play sports", "运动")]


def test_align_row_multiple_phrases_in_line():
    en = [_box(t, x0, x1, 100) for t, x0, x1 in [
        ("be", 100, 120), ("good", 122, 138), ("at", 140, 156),
        ("draw", 200, 220),
        ("tell", 290, 310), ("a", 312, 320), ("story", 322, 342),
        ("dance", 400, 420), ("player", 500, 524)]]
    zh = [_box(m, x0, x1, 120) for m, x0, x1 in [
        ("擅长于", 100, 120), ("画画", 200, 220), ("讲故事", 290, 342),
        ("跳舞", 400, 420), ("运动员", 500, 524)]]
    assert align_row(en, zh) == [
        ("be good at", "擅长于"), ("draw", "画画"), ("tell a story", "讲故事"),
        ("dance", "跳舞"), ("player", "运动员"),
    ]
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `.venv/bin/python -m pytest scripts/test_parser.py -q`
Expected: FAIL（`ImportError: cannot import name 'align_row'`）。

- [ ] **Step 3: 写最小实现**

在 `scripts/textbook_parser.py` 的 `is_latin_row` 之后追加：
```python
def align_row(en_row, zh_row):
    """按中文词条中心 x 切列，把英文 token 归组到所属中文词条。"""
    zh_centers = [((w["x0"] + w["x1"]) / 2, w["text"]) for w in zh_row]
    bounds = []
    for i in range(len(zh_centers) - 1):
        bounds.append((zh_centers[i][0] + zh_centers[i + 1][0]) / 2)

    def col_of(x):
        for i, b in enumerate(bounds):
            if x < b:
                return i
        return len(bounds)

    groups = {}
    order = []
    for w in en_row:
        i = col_of((w["x0"] + w["x1"]) / 2)
        if i not in groups:
            groups[i] = []
            order.append(i)
        groups[i].append(w["text"])

    pairs = []
    for i in order:
        term = normalize_term(" ".join(groups[i]))
        meaning = clean_meaning(zh_centers[i][1]) if i < len(zh_centers) else ""
        pairs.append((term, meaning))
    return pairs
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `.venv/bin/python -m pytest scripts/test_parser.py -q`
Expected: PASS（7 个用例）。

- [ ] **Step 5: 提交**

```bash
git add scripts/textbook_parser.py scripts/test_parser.py
git commit -m "feat(parse): x 坐标列归组对齐多词短语"
```

---

### Task 5: 单元/小节状态机（parse_lines）— TDD

**Files:**
- Modify: `scripts/textbook_parser.py`
- Test: `scripts/test_parser.py`

- [ ] **Step 1: 写失败测试**

在 `scripts/test_parser.py` 末尾追加：
```python
from textbook_parser import parse_lines


def _mkrow(tokens, top, x0=100, gap=80):
    boxes = []
    x = x0
    for t in tokens:
        boxes.append(_box(t, x, x + 40, top))
        x += gap
    return ("".join(tokens), boxes)


def test_parse_lines_one_unit():
    lines = [
        _mkrow(["2026", "沪教新版三年级英语上册", "U1", "词句汇总"], 80),
        _mkrow(["一、核心词汇（要求掌握）"], 109),
        _mkrow(["new", "school"], 133),
        _mkrow(["新的", "学校"], 153),
        _mkrow(["二、核心句子（熟读）"], 181),
        _mkrow(["Hello"], 200),     # 句子区，应被忽略
        _mkrow(["你好"], 220),
    ]
    assert parse_lines(lines) == {1: [("new", "新的"), ("school", "学校")]}


def test_parse_lines_two_units():
    lines = [
        _mkrow(["U1", "词句汇总"], 80),
        _mkrow(["一、核心词汇"], 109),
        _mkrow(["cat"], 133),
        _mkrow(["猫"], 153),
        _mkrow(["二、核心句子"], 181),
        _mkrow(["U2", "词句汇总"], 260),
        _mkrow(["一、核心词汇"], 289),
        _mkrow(["dog"], 313),
        _mkrow(["狗"], 333),
    ]
    got = parse_lines(lines)
    assert set(got.keys()) == {1, 2}
    assert got[1] == [("cat", "猫")]
    assert got[2] == [("dog", "狗")]
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `.venv/bin/python -m pytest scripts/test_parser.py -q`
Expected: FAIL（`ImportError: cannot import name 'parse_lines'`）。

- [ ] **Step 3: 写最小实现**

在 `scripts/textbook_parser.py` 的 `align_row` 之后追加：
```python
def parse_lines(lines):
    """lines: 可迭代的 (text:str, row:list[dict])，跨整篇顺序。
    返回 {unit_number: [(term, meaning), ...]}。"""
    units = {}
    cur = None
    in_vocab = False
    pending_en = None
    for text, row in lines:
        m = UNIT_HEADER_RE.search(text)
        if m:
            cur = int(m.group(1))
            units.setdefault(cur, [])
            in_vocab = False
            pending_en = None
            continue
        if SECTION_VOCAB in text:
            in_vocab = True
            pending_en = None
            continue
        if SECTION_SENTENCE in text or NUMERAL_HEADER_RE.match(text.strip()):
            in_vocab = False
            pending_en = None
            continue
        if not in_vocab or cur is None:
            continue
        if is_latin_row(row):
            pending_en = row
        elif is_cjk_row(row) and pending_en is not None:
            units[cur].extend(align_row(pending_en, row))
            pending_en = None
    return units
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `.venv/bin/python -m pytest scripts/test_parser.py -q`
Expected: PASS（9 个用例）。

- [ ] **Step 5: 提交**

```bash
git add scripts/textbook_parser.py scripts/test_parser.py
git commit -m "feat(parse): 单元/小节状态机 parse_lines"
```

---

### Task 6: 跨单元同词去重（merge_meanings）— TDD

**Files:**
- Modify: `scripts/textbook_parser.py`
- Test: `scripts/test_parser.py`

- [ ] **Step 1: 写失败测试**

在 `scripts/test_parser.py` 末尾追加：
```python
from textbook_parser import merge_meanings


def test_merge_meanings_keeps_distinct_senses():
    # water: U3 给…浇水 / U4 水 —— 语义独立，都保留
    assert merge_meanings(["给…浇水", "水"]) == "给…浇水；水"


def test_merge_meanings_exact_dedupe():
    assert merge_meanings(["学习", "学习", "学习;研读"]) == "学习；学习;研读"
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `.venv/bin/python -m pytest scripts/test_parser.py -q`
Expected: FAIL（`ImportError: cannot import name 'merge_meanings'`）。

- [ ] **Step 3: 写最小实现**

在 `scripts/textbook_parser.py` 的 `parse_lines` 之后追加：
```python
def merge_meanings(meanings):
    """仅去重完全相同的释义，保留首次出现顺序，用「；」连接。
    不做子串剔除——子串会误删独立义项（如「水」是「给…浇水」子串）。"""
    seen = []
    for m in meanings:
        if m not in seen:
            seen.append(m)
    return "；".join(seen)
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `.venv/bin/python -m pytest scripts/test_parser.py -q`
Expected: PASS（11 个用例）。

- [ ] **Step 5: 提交**

```bash
git add scripts/textbook_parser.py scripts/test_parser.py
git commit -m "feat(parse): 跨单元同词释义合并"
```

---

### Task 7: SQL 生成（sql_quote / generate_seed_sql / generate_reset_sql）— TDD

**Files:**
- Modify: `scripts/textbook_parser.py`
- Test: `scripts/test_parser.py`

- [ ] **Step 1: 写失败测试**

在 `scripts/test_parser.py` 末尾追加：
```python
from textbook_parser import sql_quote, generate_seed_sql, generate_reset_sql


def test_sql_quote_escapes_single_quote():
    assert sql_quote("it's") == "'it''s'"


def test_generate_seed_sql_structure():
    sql = generate_seed_sql(
        book="三年级上(沪教新版)",
        unit_order=[1, 2],
        words={"new": "新的", "cat": "猫"},
        unit_words={1: ["new", "cat"], 2: ["cat"]},
        created_at=1700000000000,
    )
    assert "INSERT OR IGNORE INTO units (book, unit, sort_key) VALUES ('三年级上(沪教新版)', 'Unit 1', 1);" in sql
    assert "INSERT OR IGNORE INTO words (term, pos, meaning_cn, example_en, example_cn, created_at) VALUES ('new', NULL, '新的', NULL, NULL, 1700000000000);" in sql
    assert "(SELECT id FROM units WHERE book='三年级上(沪教新版)' AND unit='Unit 2')" in sql
    assert "(SELECT id FROM words WHERE term='cat')" in sql
    # 幂等
    assert "INSERT OR IGNORE" in sql


def test_generate_reset_sql_keeps_users():
    sql = generate_reset_sql()
    assert "DELETE FROM unit_words;" in sql
    assert "DELETE FROM user_unit_word_seen;" in sql
    assert "DELETE FROM user_word_state;" in sql
    assert "DELETE FROM words;" in sql
    assert "DELETE FROM units;" in sql
    assert "DELETE FROM user_stats;" in sql
    assert "DELETE FROM users" not in sql  # 保留两个孩子
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `.venv/bin/python -m pytest scripts/test_parser.py -q`
Expected: FAIL（`ImportError: cannot import name 'sql_quote'`）。

- [ ] **Step 3: 写最小实现**

在 `scripts/textbook_parser.py` 的 `merge_meanings` 之后追加：
```python
def sql_quote(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"


def generate_seed_sql(book, unit_order, words, unit_words, created_at):
    lines = [
        f"-- dotVocab seed: {book}",
        "-- generated; idempotent (INSERT OR IGNORE)",
        "",
    ]
    for n in unit_order:
        lines.append(
            f"INSERT OR IGNORE INTO units (book, unit, sort_key) "
            f"VALUES ({sql_quote(book)}, {sql_quote(f'Unit {n}')}, {n});"
        )
    for term, meaning in words.items():
        lines.append(
            f"INSERT OR IGNORE INTO words (term, pos, meaning_cn, example_en, example_cn, created_at) "
            f"VALUES ({sql_quote(term)}, NULL, {sql_quote(meaning)}, NULL, NULL, {created_at});"
        )
    for n in unit_order:
        for term in unit_words.get(n, []):
            lines.append(
                f"INSERT OR IGNORE INTO unit_words (unit_id, word_id) VALUES ("
                f"(SELECT id FROM units WHERE book={sql_quote(book)} AND unit={sql_quote(f'Unit {n}')}), "
                f"(SELECT id FROM words WHERE term={sql_quote(term)}));"
            )
    return "\n".join(lines) + "\n"


def generate_reset_sql():
    return (
        "-- dotVocab FULL WIPE (keeps `users`). DESTRUCTIVE.\n"
        "DELETE FROM unit_words;\n"
        "DELETE FROM user_unit_word_seen;\n"
        "DELETE FROM user_word_state;\n"
        "DELETE FROM words;\n"
        "DELETE FROM units;\n"
        "DELETE FROM user_stats;\n"
    )
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `.venv/bin/python -m pytest scripts/test_parser.py -q`
Expected: PASS（14 个用例）。

- [ ] **Step 5: 提交**

```bash
git add scripts/textbook_parser.py scripts/test_parser.py
git commit -m "feat(parse): 幂等 seed.sql + 全量清零 reset.sql 生成"
```

---

### Task 8: CLI 与产物写入（import_textbook.py），端到端跑通

**Files:**
- Create: `scripts/import_textbook.py`

- [ ] **Step 1: 写 CLI**

Create `scripts/import_textbook.py`：
```python
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
    units = parse_lines(build_lines(args.pdf))   # {n: [(term, meaning)]}
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
        f.write("## 同词不同义（人工复核，必要时编辑 words.json 后重跑 --seed）：\n")
        for t, ms in conflicts:
            f.write(f"  {t}: {ms}\n")
        if skipped:
            f.write("\n## 跳过（term/释义为空）：\n")
            for n, term, meaning in skipped:
                f.write(f"  Unit {n}: term={term!r} meaning={meaning!r}\n")

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
```

- [ ] **Step 2: 跑全流程，不带 reset**

Run:
```bash
.venv/bin/python scripts/import_textbook.py
```
Expected: 一行 `units=10 entries=... unique=... conflicts=... skipped=...`（conflicts 含 water / study 等；units=10）。

- [ ] **Step 3: 人工复核产物**

查看 `scripts/out/units.csv`（10 行）、`scripts/out/qa-report.txt`、抽查 `scripts/out/Unit09.csv` 与 `scripts/out/Unit07.csv`。
- 确认 Unit 7 无尾部 `;` 残留（`chef`→`厨师`、`space`→`太空`）。
- 确认 Unit 9 的 `Chinese New Year` 是否被正确成组（若仍异常，记录到 QA，后续在 words.json 手改后重跑）。
- 若一切正常，继续；若需手改，编辑 `words.json` 后跳到 Step 4 的「--seed-only」无（本版未实现 seed-only；直接重跑脚本即可，PDF 解析会重新覆盖，故手改应改在脚本输出之后的 seed.sql，或暂存 words.json 后手编 seed.sql）。

> 说明：人工复核是远程写入前的强制门槛。seed.sql 可在复核后直接手编微调（如 U9），再用于本地/远程。

- [ ] **Step 4: 提交脚本 + 一份示例 seed.sql**

```bash
git add scripts/import_textbook.py
# 产物默认 gitignore；有意保留一份示例 seed 供复现：
cp scripts/out/seed.sql scripts/seed.example.sql
git add scripts/seed.example.sql
git commit -m "feat(py): PDF→seed CLI 与产物写入"
```

---

### Task 9: 真实 PDF 结构不变式测试（test_pdf_smoke.py）

**Files:**
- Create: `scripts/test_pdf_smoke.py`

- [ ] **Step 1: 写冒烟测试**

Create `scripts/test_pdf_smoke.py`：
```python
import os

import pytest

PDF = "materials/三年级上.pdf"

pytestmark = pytest.mark.skipif(
    not os.path.exists(PDF),
    reason="materials/三年级上.pdf 不存在（已 gitignore）",
)


def _parse():
    import pdfplumber
    from textbook_parser import cluster_rows, row_text, parse_lines
    lines = []
    with pdfplumber.open(PDF) as pdf:
        for page in pdf.pages:
            for row in cluster_rows(page.extract_words()):
                lines.append((row_text(row), row))
    return parse_lines(lines)


def test_ten_units():
    units = _parse()
    assert set(units.keys()) == set(range(1, 11))


def test_known_phrases_resolved():
    units = _parse()
    all_terms = {t for entries in units.values() for t, _ in entries}
    assert "be good at" in all_terms
    assert "play sports" in all_terms
    assert "fish and chips" in all_terms


def test_volume_sane():
    units = _parse()
    total = sum(len(v) for v in units.values())
    assert total >= 150  # 原型得 168


def test_meaning_for_known_term():
    units = _parse()
    for entries in units.values():
        d = dict(entries)
        if "be good at" in d:
            assert "擅长" in d["be good at"]
            return
    pytest.fail("be good at 未找到")
```

- [ ] **Step 2: 跑全部测试**

Run:
```bash
.venv/bin/python -m pytest scripts -q
```
Expected: 全部 PASS（单元测试 14 + 冒烟 4 = 18；若 PDF 不存在则冒烟 4 个 skip）。

- [ ] **Step 3: 提交**

```bash
git add scripts/test_pdf_smoke.py
git commit -m "test(py): 真实 PDF 结构不变式冒烟"
```

---

### Task 10: 本地 D1 验证（建表 → 导入 → 核对词数）

**Files:** 无（操作本地 D1）

- [ ] **Step 1: 本地建表（幂等）**

Run:
```bash
wrangler d1 execute dotvocab --local --file=migrations/0001_init.sql
```
Expected: 退出码 0（表已存在则 `CREATE TABLE IF NOT EXISTS` 无副作用）。

- [ ] **Step 2: 本地导入 seed**

Run:
```bash
wrangler d1 execute dotvocab --local --file=scripts/out/seed.sql
```
Expected: 退出码 0，多行 `[✓]` 或语句执行统计，无 SQL 错误。

- [ ] **Step 3: 核对单元词数**

Run:
```bash
wrangler d1 execute dotvocab --local --command "SELECT u.unit, COUNT(uw.word_id) AS n FROM units u LEFT JOIN unit_words uw ON uw.unit_id=u.id GROUP BY u.unit ORDER BY u.sort_key;"
```
Expected: 10 行，每行 `n` 与 `scripts/out/units.csv` 对应行一致。

- [ ] **Step 4: 核对去重词条数**

Run:
```bash
wrangler d1 execute dotvocab --local --command "SELECT COUNT(*) AS words FROM words; SELECT COUNT(*) AS links FROM unit_words;"
```
Expected: `words` ≈ `scripts/out/qa-report.txt` 里的 unique terms（≈166）；`links` = 总 entries（≈168）。

- [ ] **Step 5: 提交（如有脚本微调）**

```bash
git add -A
git commit -m "chore(d1): 本地 seed 验证通过" || echo "无改动，跳过提交"
```

---

### Task 11: 线上：备份 → 全量清零 → 导入 → 核对 【DESTRUCTIVE，需人工把关】

> ⚠️ 这是面向生产（twins 在用的 App）的不可逆操作。**先备份**；每步确认成功再下一步。本地 Task 10 必须已通过。

**Files:** 操作远程 D1；产物 `scripts/out/backup-remote.sql`（gitignore）。

- [ ] **Step 1: 生成 reset.sql**

Run:
```bash
.venv/bin/python scripts/import_textbook.py --reset
```
Expected: 同 Task 8 输出，且 `scripts/out/reset.sql` 生成。

- [ ] **Step 2: 备份线上 DB（可回滚）**

Run:
```bash
wrangler d1 export dotvocab --remote --output=scripts/out/backup-remote.sql
```
Expected: 退出码 0，生成 `scripts/out/backup-remote.sql`（非空，含 INSERT 语句）。
> 确认文件非空后再继续。这是唯一回滚途径。

- [ ] **Step 3: 全量清零（保留 users）**

Run:
```bash
wrangler d1 execute dotvocab --remote --file=scripts/out/reset.sql
```
Expected: 退出码 0，6 条 DELETE 各有执行统计。

- [ ] **Step 4: 导入新词书**

Run:
```bash
wrangler d1 execute dotvocab --remote --file=scripts/out/seed.sql
```
Expected: 退出码 0，多行执行统计，无错误。

- [ ] **Step 5: 远程核对**

Run:
```bash
wrangler d1 execute dotvocab --remote --command "SELECT COUNT(*) AS units FROM units; SELECT COUNT(*) AS words FROM words; SELECT COUNT(*) AS links FROM unit_words; SELECT COUNT(*) AS kids FROM users;"
```
Expected: `units=10`；`words`≈166；`links`≈168；`kids=2`（哥哥/弟弟仍在）。

Run（按单元抽查）：
```bash
wrangler d1 execute dotvocab --remote --command "SELECT u.unit, COUNT(uw.word_id) AS n FROM units u LEFT JOIN unit_words uw ON uw.unit_id=u.id GROUP BY u.unit ORDER BY u.sort_key;"
```
Expected: 10 行，词数与 `units.csv` 一致。

- [ ] **Step 6: 人工验收**

打开线上 `https://dotvocab.lucyfer81.workers.dev`，孩子端选任一单元看到新词；家长端 `/admin.html` 看到 10 个单元、词数正确。确认后结束。

> **连接排障（若 wrangler --remote 连不上 Cloudflare）：** 本机有 `http_proxy=127.0.0.1:1081`，而 Node 的 fetch 默认不走代理。可尝试 `HTTPS_PROXY=http://127.0.0.1:1081 HTTP_PROXY=http://127.0.0.1:1081 wrangler d1 execute …`，或确认本机可直连 Cloudflare。

---

## Self-Review（写完后自检，已修正）

- **Spec 覆盖**：解析（Task 2–5）、去重（6）、SQL 生成（7）、产物与端到端（8）、QA 复核（8–3、9）、本地验证（10）、远程备份+全量清零+导入+核对（11）、依赖与 gitignore（1）——spec 各节均有对应任务。
- **占位符**：无 TBD/TODO；每个代码步骤含完整代码与命令。
- **类型/命名一致**：`align_row` / `parse_lines` / `merge_meanings` / `generate_seed_sql(book, unit_order, words, unit_words, created_at)` / `generate_reset_sql()` 在各任务中签名一致；CLI 调用与之一致。
- **对 spec 的细化已注明**：`merge_meanings` 改为仅精确去重（见顶部说明），避免误删 `水` 等独立义项。
