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


def parse_lines(lines, anomalies=None):
    """lines: 可迭代的 (text:str, row:list[dict])，跨整篇顺序。
    返回 {unit_number: [(term, meaning), ...]}。

    若传入 anomalies（list），则把对齐异常以 (unit, en_text, zh_text, reason)
    追加进去，供 CLI 的 QA 报告使用（spec §8：不静默吞错）。
    不传时行为与原版完全一致。"""
    units = {}
    cur = None
    in_vocab = False
    pending_en = None

    def _flush_pending(reason):
        if pending_en is not None and anomalies is not None:
            anomalies.append((cur, row_text(pending_en), "", reason))

    for text, row in lines:
        m = UNIT_HEADER_RE.search(text)
        if m:
            _flush_pending("英文行后无中文释义")
            cur = int(m.group(1))
            units.setdefault(cur, [])
            in_vocab = False
            pending_en = None
            continue
        if SECTION_VOCAB in text:
            _flush_pending("英文行后无中文释义")
            in_vocab = True
            pending_en = None
            continue
        if SECTION_SENTENCE in text or NUMERAL_HEADER_RE.match(text.strip()):
            _flush_pending("英文行后无中文释义")
            in_vocab = False
            pending_en = None
            continue
        if not in_vocab or cur is None:
            continue
        if is_latin_row(row):
            pending_en = row
        elif is_cjk_row(row) and pending_en is not None:
            pairs = align_row(pending_en, row)
            if anomalies is not None and (
                len(pairs) != len(row) or any(not t or not m for t, m in pairs)
            ):
                anomalies.append(
                    (cur, row_text(pending_en), row_text(row),
                     "对齐行英文/中文条目数不匹配或存在空值")
                )
            units[cur].extend(pairs)
            pending_en = None
    _flush_pending("英文行后无中文释义")
    return units


def merge_meanings(meanings):
    """仅去重完全相同的释义，保留首次出现顺序，用「；」连接。
    不做子串剔除——子串会误删独立义项（如「水」是「给…浇水」子串）。"""
    seen = []
    for m in meanings:
        if m not in seen:
            seen.append(m)
    return "；".join(seen)


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
