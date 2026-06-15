from fastapi import APIRouter, HTTPException

from app.models import MeetingCreate, MeetingUpdate
from app.storage import vault


router = APIRouter(prefix="/api/meetings", tags=["meetings"])


@router.get("")
def list_meetings(project_id: str | None = None):
    return {"items": vault.list_meetings(project_id=project_id)}


@router.post("", status_code=201)
def create_meeting(payload: MeetingCreate):
    return vault.create_meeting(payload.model_dump())


@router.patch("/{meeting_id}")
def update_meeting(meeting_id: str, payload: MeetingUpdate):
    updated = vault.update_meeting(meeting_id, payload.model_dump(exclude_unset=True))
    if updated is None:
        raise HTTPException(status_code=404, detail="meeting not found")
    return updated


@router.delete("/{meeting_id}")
def delete_meeting(meeting_id: str):
    deleted = vault.delete_meeting(meeting_id)
    if deleted is None:
        raise HTTPException(status_code=404, detail="meeting not found")
    return {"deleted": True, "item": deleted}
