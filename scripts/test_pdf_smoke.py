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
