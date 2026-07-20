"""
Health endpoint. No auth, no client-header guard (exempt in main.py).
"""

from fastapi import APIRouter


router = APIRouter()


@router.get("/health")
def health():
    return {"status": "ok"}
