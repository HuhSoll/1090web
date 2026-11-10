"""Aircraft variant classification (audit H2). Aircraft-based evidence, not flight purpose."""

import pytest

from classify_aircraft import classify

CASES = [
    # --- H2 regression: correct pairs that used to be rejected as contradictions -------------
    ("A20N", "A320 251NSL", "passenger"),
    ("A20N", "A320-251N", "passenger"),
    ("A20N", "A320 271NSL", "passenger"),
    ("A21N", "A321-271NX", "passenger"),
    ("A21N", "A321 271NXSL", "passenger"),
    ("A21N", "A321NX", "passenger"),
    ("A19N", "A319 153NSL", "passenger"),
    ("B38M", "737-8", "passenger"),
    ("B38M", "737-8 MAX", "passenger"),
    ("B38M", "737-8 MAX 8", "passenger"),
    ("B38M", "737-8200", "passenger"),
    ("B38M", "737MAX 8", "passenger"),
    ("B39M", "737-9", "passenger"),
    ("B39M", "737-9 MAX", "passenger"),
    # --- genuine contradictions stay unknown ------------------------------------------------
    ("DH8D", "A320-232", "unknown"),
    ("B738", "787 9", "unknown"),
    ("B38M", "A321 251NXSL", "unknown"),
    ("B38M", "737NG 76N/W", "unknown"),     # NG variant on a MAX type code
    ("B738", "737MAX 8", "unknown"),        # MAX variant on an NG type code
    ("A20N", "A320 214SL", "unknown"),      # ceo variant on a neo type code
    ("A320", "A320-251N", "unknown"),       # neo variant on a ceo type code
    ("A21N", "A320 251NSL", "unknown"),     # A320 variant on an A321 type code
    ("B763", "F50", "unknown"),
    ("B789", "747 409F", "unknown"),
    # --- unchanged behaviour ------------------------------------------------------------------
    ("B738", "737NG 8F2/W", "passenger"),   # customer code F2, not a freighter
    ("B738", "737NG 85F/W", "passenger"),
    ("B738", "737NG 8ASBCF/W", "cargo"),    # BCF conversion
    ("B738", "737NG 85FSF/W", "cargo"),
    ("B738", "737-8FH", "passenger"),
    ("B77L", "777 F", "cargo"),
    ("B77L", "777 FS2", "cargo"),
    ("B77W", "777 3F2ER", "passenger"),
    ("B77W", "777 36NERSF", "cargo"),
    ("B77L", "777 2FBLR", "passenger"),
    ("B748", "747 8F", "cargo"),
    ("B744", "747 4F6", "passenger"),
    ("B744", "747 409F", "cargo"),
    ("B744", "747 446FSCD", "cargo"),
    ("B763", "767 300F", "cargo"),
    ("B763", "767 34AF/W", "cargo"),
    ("B764", "767 4FSER", "passenger"),
    ("B752", "757 24APF", "cargo"),
    ("B734", "737 490SF", "cargo"),
    ("B734", "737 476", "passenger"),
    ("A332", "A330 243F", "cargo"),
    ("A333", "A330 343E(F)", "cargo"),
    ("A321", "A321 231(P2F)", "cargo"),
    ("A306", "A300 F4-622R", "cargo"),
    ("A306", "A300 B4-622RF", "cargo"),
    ("A320", "A320 214", "passenger"),
    ("AT76", "ATR 72 600F", "cargo"),
    ("AT76", "ATR 72 600", "passenger"),
    ("F100", "F100", "passenger"),
    ("F50", "F50 F", "cargo"),
    ("MD11", "MD-11 F", "cargo"),
    ("CRJ2", "CRJ 200SF", "cargo"),
    ("B737", "737NG 7FG/W BBJ", "unknown"),  # business variant
    # --- no variant detail --------------------------------------------------------------------
    ("A21N", "-", "passenger"),             # passenger-only type
    ("B38M", "-", "passenger"),
    ("A320", "-", "unknown"),               # A320P2F exists
    ("B738", "-", "unknown"),               # 737-800BCF exists
    ("C172", "-", "unknown"),
]


@pytest.mark.parametrize("ac_type,detail,expected", CASES)
def test_classify(ac_type, detail, expected):
    cls, rule = classify(ac_type, detail)
    assert cls == expected, f"{ac_type} / {detail}: got {cls} ({rule})"


def test_every_result_has_a_rule():
    for ac_type, detail, _ in CASES:
        _, rule = classify(ac_type, detail)
        assert rule
