"""
WHERE-clause builders shared across routers.

Each helper returns a (clause, params) pair so callers splice filters into
SQL without ever interpolating user input into the query string — every
user-supplied value flows through a BigQuery ScalarQueryParameter/
ArrayQueryParameter.

Column model for the E!BA recruitment schema: district, gender, cohort (BC2..BC5),
parish, venue, stage, channel. Mirror this file when adding a new filter dimension.
"""

from typing import List

from app.core.database import _array, _scalar


def build_where(
    districts: List[str] = None,
    gender:    str       = None,
    stages:    List[str] = None,
    parishes:  List[str] = None,
    venues:    List[str] = None,
    channel:   str       = None,
    extra:     list      = None,
    prefix:    str       = "bw",
    district_col: str    = "district",
    gender_col:   str    = "gender",
    venue_col:    str    = "venue",
):
    """
    Build a WHERE clause string + BigQuery parameter list for the standard
    recruitment-table filters. Returns (clause, params).

    `extra` accepts either bare SQL strings (must be literals only, e.g. the
    NOT_TEST_DATA constant) OR (clause, params) tuples so callers can mix in
    their own parameterised fragments. `prefix` namespaces the parameter names
    so multiple build_where() calls in one query don't collide.

    `district_col`/`gender_col`/`venue_col` let callers point at a real table's
    actual column name (e.g. "youth_district", "agent_district", "venue_name")
    when it differs from the scaffold's "district"/"gender"/"venue" — these are
    fixed literals set by the caller, never user input, so splicing them into
    the SQL is safe.
    """
    filters: list[str] = []
    params:  list      = []

    for item in (extra or []):
        if isinstance(item, tuple):
            clause, item_params = item
            filters.append(clause)
            params.extend(item_params)
        else:
            filters.append(item)

    if districts:
        filters.append(f"UPPER({district_col}) IN UNNEST(@{prefix}_districts)")
        params.append(_array(f"{prefix}_districts", "STRING", [d.upper() for d in districts]))
    if gender:
        filters.append(f"UPPER(COALESCE({gender_col}, 'UNKNOWN')) = @{prefix}_gender")
        params.append(_scalar(f"{prefix}_gender", "STRING", gender.upper()))
    if stages:
        filters.append(f"stage IN UNNEST(@{prefix}_stages)")
        params.append(_array(f"{prefix}_stages", "STRING", list(stages)))
    if parishes:
        filters.append(f"UPPER(parish) IN UNNEST(@{prefix}_parishes)")
        params.append(_array(f"{prefix}_parishes", "STRING", [p.upper() for p in parishes]))
    if venues:
        filters.append(f"{venue_col} IN UNNEST(@{prefix}_venues)")
        params.append(_array(f"{prefix}_venues", "STRING", list(venues)))
    if channel:
        filters.append(f"channel = @{prefix}_channel")
        params.append(_scalar(f"{prefix}_channel", "STRING", channel))

    clause = " AND ".join(filters) if filters else "TRUE"
    return clause, params


def cohort_clause(cohort, prefix: str):
    """
    Returns (clause, params) for a cohort filter (BC2..BC5), or (None, []) if no
    cohort was supplied. Accepts a single string (equality) or a list (IN UNNEST).
    Caller splices the clause into a WHERE/AND chain.
    """
    if not cohort:
        return None, []
    if isinstance(cohort, (list, tuple)):
        return (
            f"COALESCE(cohort, 'Unknown') IN UNNEST(@{prefix}_cohort)",
            [_array(f"{prefix}_cohort", "STRING", list(cohort))],
        )
    return (
        f"COALESCE(cohort, 'Unknown') = @{prefix}_cohort",
        [_scalar(f"{prefix}_cohort", "STRING", cohort)],
    )


def date_clauses(date_col_expr: str, date_from, date_to, prefix: str):
    """
    Returns (clauses_list, params_list) for an optional date range.
    `date_col_expr` is spliced into the SQL verbatim, so callers MUST keep
    it as a literal (e.g. "DATE(event_date)") — never a user value.
    """
    clauses, params = [], []
    if date_from:
        clauses.append(f"{date_col_expr} >= @{prefix}_from")
        params.append(_scalar(f"{prefix}_from", "DATE", str(date_from)))
    if date_to:
        clauses.append(f"{date_col_expr} <= @{prefix}_to")
        params.append(_scalar(f"{prefix}_to", "DATE", str(date_to)))
    return clauses, params


def multiselect_array_sql(column: str) -> str:
    """
    Array expression for a multiselect-style silver column, to UNNEST.
    `column` is a fixed literal set by the caller (a real column name), never
    user input, so splicing it in is safe -- same rule as build_where's
    district_col/gender_col/venue_col.

    Several of AWARENESS_KYC's multiselect columns (current_activty,
    registration_reasons, decision_consultation, bc5_support_required,
    open_questions) turn out to hold THREE inconsistent formats across
    bootcamp cycles/form versions -- confirmed against live data, 2026-08-04,
    by checking why their UNNEST(JSON_EXTRACT_STRING_ARRAY(...)) queries were
    returning far fewer rows than the column's actual non-null count:
      - a valid JSON array literal, e.g. '["Staying home"]'
      - one or more quoted values with no enclosing brackets, e.g.
        '"Learn business skills", "Network"' -- JSON_EXTRACT_STRING_ARRAY
        fails on this as-is; wrapping it in [...] fixes it
      - a single bare (unquoted) value, e.g. 'Attending school' -- still
        fails JSON parsing even after wrapping, since bare text isn't a
        valid JSON string literal
    Each row's actual shape is detected before parsing, rather than assuming
    one format for the whole column. NULL/blank values produce an empty
    array (UNNEST drops that row, same as a bare JSON_EXTRACT_STRING_ARRAY
    on a NULL column would) rather than a 1-element [NULL] array.
    """
    return f"""CASE
      WHEN {column} IS NULL OR TRIM({column}) = '' THEN []
      WHEN STARTS_WITH(TRIM({column}), '[') THEN JSON_EXTRACT_STRING_ARRAY({column})
      WHEN STARTS_WITH(TRIM({column}), '"') THEN JSON_EXTRACT_STRING_ARRAY(CONCAT('[', {column}, ']'))
      ELSE [{column}]
    END"""
