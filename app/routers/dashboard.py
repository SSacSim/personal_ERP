from datetime import date

from fastapi import APIRouter, Query

from app.storage import vault


router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])


@router.get("")
def get_dashboard(target_date: date | None = Query(default=None, alias="date")):
    return vault.dashboard(target_date or date.today())
