"""
PII pseudonymisation + name masking.

The prototype carries re-identifiable personal data: youth full names (+ village,
demographics), plus named mobilisers and trainers. In production:

  • `youth_id()` is the public row identifier; the raw identifier (phone number /
    national id) never leaves the backend. If EBA_ID_SALT leaks, anyone can re-link
    a youth_id to a phone by brute-forcing Ugandan mobile prefixes — treat it with
    the same care as JWT_SECRET.
  • `mask_name()` hides personal names from the guest role (staff see full names).

Routers must pass the caller's role into `mask_name` before serialising any
person's name, and must never serialise a raw phone number / national id.
"""

import hmac

from app.core.cache import cache_key, cached_query
from app.core.config import settings
from app.core.database import get_bq_client
from app.core.tables import TRAINER_OBSERVATIONS, YOUTHS

EBA_ID_SALT = settings.EBA_ID_SALT


def youth_id(identifier: str | None) -> str | None:
    """Deterministic non-reversible pseudonym for a raw identifier (phone/id)."""
    if identifier is None:
        return None
    digest = hmac.new(
        EBA_ID_SALT.encode(),
        str(identifier).encode(),
        "sha256",
    ).hexdigest()
    return "Y-" + digest[:8].upper()


def trainer_key(name: str | None) -> str | None:
    """Deterministic non-reversible pseudonym for a trainer_name.

    trainer_name is masked to initials for the guest role (mask_name), so the
    frontend can never round-trip a raw name back to the server to fetch one
    trainer's observation detail — this is the stable id it uses instead.
    """
    if name is None:
        return None
    digest = hmac.new(
        EBA_ID_SALT.encode(),
        str(name).encode(),
        "sha256",
    ).hexdigest()
    return "T-" + digest[:8].upper()


def mask_name(role: str, name: str | None) -> str | None:
    """Full name for staff; initials only for guests (e.g. 'Ochwo Joseph' -> 'O. J.')."""
    if name is None:
        return None
    if role == "staff":
        return name
    parts = [p for p in str(name).split() if p]
    if not parts:
        return None
    return " ".join(f"{p[0].upper()}." for p in parts)


def _build_identifier_map() -> dict[str, str]:
    client = get_bq_client()
    sql = f"SELECT DISTINCT phone_number FROM {YOUTHS} WHERE phone_number IS NOT NULL"
    result = client.query(sql).result()
    return {youth_id(r["phone_number"]): r["phone_number"] for r in result}


def phone_from_youth_id(yid: str) -> str | None:
    """Reverse-lookup a youth_id to its raw phone_number, or None for unknown ids.

    Backed by the 5-min query cache; rebuilds on miss/expiry. Never expose the
    result in an API response — this is for server-side drilldown resolution only.
    """
    key = cache_key("youth_id_reverse_map_v1")
    id_map = cached_query(key, _build_identifier_map)
    return id_map.get(yid)


def _build_trainer_key_map() -> dict[str, str]:
    client = get_bq_client()
    sql = (
        f"SELECT DISTINCT trainer_name FROM {TRAINER_OBSERVATIONS} "
        "WHERE report_type = 'rct_lesson_observation' AND trainer_name IS NOT NULL"
    )
    result = client.query(sql).result()
    return {trainer_key(r["trainer_name"]): r["trainer_name"] for r in result}


def name_from_trainer_key(key: str) -> str | None:
    """Reverse-lookup a trainer_key to its raw trainer_name, or None if unknown.

    Backed by the 5-min query cache; rebuilds on miss/expiry. Never expose the
    result in an API response — this is for server-side drilldown resolution only.
    """
    cache_id = cache_key("trainer_key_reverse_map_v1")
    id_map = cached_query(cache_id, _build_trainer_key_map)
    return id_map.get(key)
