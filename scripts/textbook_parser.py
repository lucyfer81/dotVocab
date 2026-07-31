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
