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
