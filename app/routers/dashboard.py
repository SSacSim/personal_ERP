from datetime import date

from fastapi import APIRouter, Depends, Query

from app.auth import current_user
from app.storage import vault


router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])


@router.get("")
def get_dashboard(target_date: date | None = Query(default=None, alias="date"), user: dict = Depends(current_user)):
    return vault.dashboard(target_date or date.today(), user["id"])
