from datetime import date

from fastapi import APIRouter, HTTPException, Query

from app.models import CalendarEventCreate, CalendarEventUpdate
from app.storage import vault


router = APIRouter(prefix="/api/calendar", tags=["calendar"])


@router.get("")
def list_events(month: str | None = None, target_date: date | None = Query(default=None, alias="date")):
    return {"items": vault.list_calendar_events(month=month, target_date=target_date)}


@router.post("/events", status_code=201)
def create_event(payload: CalendarEventCreate):
    return vault.create_calendar_event(payload.model_dump())


@router.patch("/events/{event_id}")
def update_event(event_id: str, payload: CalendarEventUpdate):
    updated = vault.update_calendar_event(event_id, payload.model_dump(exclude_unset=True))
    if updated is None:
        raise HTTPException(status_code=404, detail="event not found")
    return updated


@router.delete("/events/{event_id}")
def delete_event(event_id: str):
    deleted = vault.delete_calendar_event(event_id)
    if deleted is None:
        raise HTTPException(status_code=404, detail="event not found")
    return {"deleted": True, "item": deleted}


@router.get("/events/{event_id}")
def get_event(event_id: str):
    note = vault.find_by_id("calendar_event", event_id)
    if note is None:
        raise HTTPException(status_code=404, detail="event not found")
    return note.as_dict()
