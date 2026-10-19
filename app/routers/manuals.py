from fastapi import APIRouter, HTTPException, Request

from app.auth import current_user
from app.manuals import GUIDELINES, REVIEW_CYCLES, SECTIONS, ManualConflict, list_manuals as stored_manuals, manual_dict, save_manual
from app.models import ManualCreate, ManualUpdate
from app.storage import vault


router = APIRouter(prefix="/api/manuals", tags=["manuals"])


@router.get("")
def list_manuals():
    return {"items": stored_manuals(vault)}


@router.get("/guide")
def manual_guide():
    return {"sections": SECTIONS, "guidelines": GUIDELINES, "review_cycles": REVIEW_CYCLES}


@router.get("/{manual_id}")
def get_manual(manual_id: str):
    note = vault.find_by_id("manual", manual_id)
    if note is None:
        raise HTTPException(status_code=404, detail="매뉴얼을 찾을 수 없습니다.")
    return manual_dict(note)


@router.post("", status_code=201)
def create_manual(payload: ManualCreate, request: Request):
    return save_manual(vault, payload.model_dump(), current_user(request))


@router.patch("/{manual_id}")
def update_manual(manual_id: str, payload: ManualUpdate, request: Request):
    try:
        saved = save_manual(vault, payload.model_dump(), current_user(request), manual_id)
    except ManualConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if saved is None:
        raise HTTPException(status_code=404, detail="매뉴얼을 찾을 수 없습니다.")
    return saved
