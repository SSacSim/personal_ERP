from datetime import date

from fastapi import APIRouter, HTTPException

from app.models import WorkTaskCreate, WorkTaskUpdate
from app.storage import parse_iso_date, vault


router = APIRouter(prefix="/api/tasks", tags=["tasks"])


@router.get("")
def list_tasks():
    return {"items": vault.list_tasks()}


@router.post("", status_code=201)
def create_task(payload: WorkTaskCreate):
    return vault.create_task(payload.model_dump())


@router.patch("/{task_id}")
def update_task(task_id: str, payload: WorkTaskUpdate):
    current = vault.find_by_id("work_task", task_id)
    if current is None:
        raise HTTPException(status_code=404, detail="task not found")

    updates = payload.model_dump(exclude_unset=True)
    start = updates.get("start_date") or parse_iso_date(current.metadata.get("start_date"))
    end = updates.get("end_date") or parse_iso_date(current.metadata.get("end_date"))
    if isinstance(start, date) and isinstance(end, date) and end < start:
        raise HTTPException(status_code=422, detail="end_date must be on or after start_date")

    updated = vault.update_task(task_id, updates)
    if updated is None:
        raise HTTPException(status_code=404, detail="task not found")
    return updated
