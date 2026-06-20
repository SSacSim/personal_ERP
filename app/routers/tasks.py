from datetime import date

from fastapi import APIRouter, HTTPException

from app.models import WorkTaskCreate, WorkTaskUpdate
from app.storage import parse_iso_date, vault


router = APIRouter(prefix="/api/tasks", tags=["tasks"])


@router.get("")
def list_tasks():
    return {"items": vault.list_tasks()}


def parent_chain_contains(task_id: str, parent_id: str) -> bool:
    seen: set[str] = set()
    current_parent_id = parent_id
    while current_parent_id:
        if current_parent_id == task_id:
            return True
        if current_parent_id in seen:
            return False
        seen.add(current_parent_id)
        parent = vault.find_by_id("work_task", current_parent_id)
        if parent is None:
            return False
        current_parent_id = str(parent.metadata.get("parent_id") or "")
    return False


def validate_parent(task_id: str | None, parent_id: str) -> dict | None:
    if not parent_id:
        return None
    parent = vault.find_by_id("work_task", parent_id)
    if parent is None or parent.metadata.get("deleted") is True:
        raise HTTPException(status_code=422, detail="parent task not found")
    if task_id is not None and parent_chain_contains(task_id, parent_id):
        raise HTTPException(status_code=422, detail="task cannot be moved under itself")
    return parent.metadata


@router.post("", status_code=201)
def create_task(payload: WorkTaskCreate):
    data = payload.model_dump()
    parent = validate_parent(None, str(data.get("parent_id") or ""))
    if parent is not None:
        data["project_id"] = parent.get("project_id") or ""
    return vault.create_task(data)


@router.patch("/{task_id}")
def update_task(task_id: str, payload: WorkTaskUpdate):
    current = vault.find_by_id("work_task", task_id)
    if current is None or current.metadata.get("deleted") is True:
        raise HTTPException(status_code=404, detail="task not found")

    updates = payload.model_dump(exclude_unset=True)
    start = updates.get("start_date") or parse_iso_date(current.metadata.get("start_date"))
    end = updates.get("end_date") or parse_iso_date(current.metadata.get("end_date"))
    if isinstance(start, date) and isinstance(end, date) and end < start:
        raise HTTPException(status_code=422, detail="end_date must be on or after start_date")
    if "parent_id" in updates:
        parent = validate_parent(task_id, str(updates.get("parent_id") or ""))
        if parent is not None and updates.get("project_id") is None:
            updates["project_id"] = parent.get("project_id") or ""

    updated = vault.update_task(task_id, updates)
    if updated is None:
        raise HTTPException(status_code=404, detail="task not found")
    return updated


@router.delete("/{task_id}")
def delete_task(task_id: str):
    deleted = vault.delete_task(task_id)
    if deleted is None:
        raise HTTPException(status_code=404, detail="task not found")
    return {"deleted": True, "item": deleted}
