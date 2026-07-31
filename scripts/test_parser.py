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
