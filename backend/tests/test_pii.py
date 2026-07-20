"""PII helpers: pseudonymisation determinism + name masking by role."""

from app.core import pii


def test_youth_id_deterministic_and_prefixed():
    a = pii.youth_id("+256700000001")
    b = pii.youth_id("+256700000001")
    assert a == b
    assert a.startswith("Y-")
    assert len(a) == 10  # "Y-" + 8 hex chars


def test_youth_id_distinct_for_distinct_input():
    assert pii.youth_id("+256700000001") != pii.youth_id("+256700000002")


def test_youth_id_none_passthrough():
    assert pii.youth_id(None) is None


def test_youth_id_does_not_contain_raw_input():
    raw = "+256700000001"
    assert raw not in pii.youth_id(raw)


def test_mask_name_staff_sees_full():
    assert pii.mask_name("staff", "Ochwo Joseph") == "Ochwo Joseph"


def test_mask_name_guest_sees_initials():
    assert pii.mask_name("guest", "Ochwo Joseph") == "O. J."


def test_mask_name_none_passthrough():
    assert pii.mask_name("guest", None) is None
