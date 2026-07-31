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
