"""
Qualitative coding for the KYC/Youth Profile page's "Open questions raised
before joining" card (AWARENESS_KYC.open_questions).

Manually reviewed the full live distribution before writing these rules --
432 distinct free-text values / ~3,037 total mentions (2026-08-05). The vast
majority (~88%) are not questions at all: a bare "no"/"NA"/"none", or
gratitude ("appreciated the program", "thank you"). Grouping by exact
wording (the previous approach) buried the real signal under typo/casing
variants of those non-answers and a long tail of one-off substantive
questions -- classifying into themes surfaces what youth are actually
asking, weighted by how often it comes up, not by exact phrasing.

Each theme is a list of regex patterns checked against the lowercased
question text with `re.search` (not full-match) -- order matters, first
theme with a matching pattern wins, so keep each pattern set specific
enough not to swallow a later theme's territory. Anything matching nothing
falls into "Other". Extend by adding patterns to an existing theme or a new
tuple; re-run against a fresh full-text pull (see recruitment.py's
awareness_kyc()) before trusting a change, since these were tuned against
one point-in-time sample and new phrasing will surface as more data lands.
"""

import re

THEMES = [
    ("No question raised (or just thanks)", [
        r"^\s*(no|na|n[\s./:]*a\.?|none?|nq|mone|thabk you|thank\w*|on|coming|w)\s*[.!]*\s*$",
        r"no\s*question", r"no\s*qns?\b", r"no\s*any\s*question", r"has no question",
        r"doesn.?t have (a|any) question", r"not having any question", r"no more question",
        r"the you had no question", r"she doesn.?t have a question",
        r"no\s+additional\s+question", r"no\b.{0,15}question", r"^not at all\.?$",
        r"appreciat\w*", r"thank\w*", r"happy\b", r"^happ\b", r"satisfied", r"excited",
        r"^ready\b", r"^just ready", r"^am ready\b", r"willing to (learn|develop|participate|train)",
        r"^ready to", r"just (very )?eager", r"waiting to start", r"waiting for your feedback",
        r"^great\b", r"^good\b", r"liked the program", r"it.?s good for us", r"am fine with it",
        r"gives us hope", r"just being (very )?happy", r"^no,? (just|am|but)\b",
        r"no question\w* (but|just|only|at|per)", r"no question\w*$",
        r"will ask (more|while)", r"i will (ask|be available)", r"ask.*(bootcamp|on ground|while on ground)",
    ]),
    ("Startup capital / financial support", [
        r"capital", r"start\s*up", r"give.*money", r"do give\b",
    ]),
    ("Transport & facilitation", [
        r"transport", r"facilitat",
    ]),
    ("Bootcamp schedule, venue & logistics", [
        r"when (is|are|shall)", r"venue", r"place of", r"period of", r"how long", r"how.*duration",
        r"which meals", r"\bfood\b", r"uniform", r"come with (books|the child|my (baby|child))",
        r"books and pens", r"hours of the training", r"what time", r"early morning",
        r"every day", r"time shall the lesson", r"for how long", r"duration",
        r"study(ing)? from", r"learn in english",
    ]),
    ("Eligibility & who can join", [
        r"eligib", r"\bbaby\b", r"pregnan", r"husband", r"\bwife\b", r"married",
        r"sister", r"brother", r"\bage\b", r"18\s*-?\s*30", r"up\s*40", r"disab", r"\blame\b",
        r"girls than boys", r"student", r"\bkid", r"national identity", r"identification",
        r"who is a youth\b(?!\s*(leader|chairman))",
    ]),
    ("Certificate, jobs & post-training outcomes", [
        r"certificat", r"\bjob", r"employ", r"follow\s*up", r"what next",
    ]),
    ("Attendance policy, selection & trust", [
        r"disqualif", r"miss (a|one) day", r"late", r"selected", r"deceive",
        r"don.?t be like other", r"why have you registered", r"far.*make it",
        r"remind",
    ]),
    ("What is Educate / program identity", [
        r"what\s*is\s*educate", r"who is (a|the) (youth|founder|community|donor)",
        r"mission", r"vision", r"purpose of educate", r"origin of educate",
        r"founder", r"social enterprise", r"profile of educate", r"headquarters",
        r"how.*benefit.*educate", r"vht", r"chairman", r"youth leader",
        r"community leader", r"differenc\w* between", r"skill\w* (offered|are we|going to learn)",
        r"what skill", r"learn (more )?about business", r"what if am pregnant",
    ]),
    ("Control-group / study design", [
        r"control group",
    ]),
]

_COMPILED = [(name, [re.compile(p, re.I) for p in patterns]) for name, patterns in THEMES]

OTHER_THEME = "Other"


def classify_question(question: str) -> str:
    """Returns the first theme (in THEMES order) whose pattern matches
    `question`, or OTHER_THEME if none do."""
    text = question.strip().lower()
    for name, patterns in _COMPILED:
        for pattern in patterns:
            if pattern.search(text):
                return name
    return OTHER_THEME
