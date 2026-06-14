from datetime import date, timedelta

from fastapi import APIRouter, HTTPException, Query

from app.models import TodoCreate, TodoReorder, TodoUpdate
from app.storage import vault


router = APIRouter(prefix="/api/todos", tags=["todos"])


@router.get("")
def list_todos(target_date: date | None = Query(default=None, alias="date")):
    day = target_date or date.today()
    vault.rollover_todos(day)
    return {"items": vault.list_todos(day)}


@router.post("", status_code=201)
def create_todo(payload: TodoCreate):
    return vault.create_todo(payload.model_dump())


@router.patch("/{todo_id}")
def update_todo(todo_id: str, payload: TodoUpdate):
    updated = vault.update_todo(todo_id, payload.model_dump(exclude_unset=True))
    if updated is None:
        raise HTTPException(status_code=404, detail="todo not found")
    return updated


@router.delete("/{todo_id}")
def delete_todo(todo_id: str):
    deleted = vault.delete_todo(todo_id)
    if deleted is None:
        raise HTTPException(status_code=404, detail="todo not found")
    return {"deleted": True, "item": deleted}


@router.post("/reorder")
def reorder_todos(payload: TodoReorder):
    return {"items": vault.reorder_todos(payload.ids)}


@router.post("/rollover")
def rollover_todos(target_date: date | None = Query(default=None, alias="date")):
    day = target_date or date.today()
    return {"items": vault.rollover_todos(day)}


@router.post("/weekly-report")
def create_weekly_report(week_start: date | None = None):
    start = week_start or (date.today() - timedelta(days=date.today().weekday()))
    return vault.weekly_report(start)
