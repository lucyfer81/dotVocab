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
