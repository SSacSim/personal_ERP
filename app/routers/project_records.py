from fastapi import APIRouter, HTTPException

from app.models import ProjectRecordCreate, ProjectRecordUpdate
from app.storage import vault


router = APIRouter(prefix="/api/project-records", tags=["project-records"])


@router.get("")
def list_project_records(project_id: str | None = None):
    return {"items": vault.list_project_records(project_id=project_id)}


@router.post("", status_code=201)
def create_project_record(payload: ProjectRecordCreate):
    return vault.create_project_record(payload.model_dump())


@router.patch("/{record_id}")
def update_project_record(record_id: str, payload: ProjectRecordUpdate):
    updated = vault.update_project_record(record_id, payload.model_dump(exclude_unset=True))
    if updated is None:
        raise HTTPException(status_code=404, detail="project record not found")
    return updated


@router.delete("/{record_id}")
def delete_project_record(record_id: str):
    deleted = vault.delete_project_record(record_id)
    if deleted is None:
        raise HTTPException(status_code=404, detail="project record not found")
    return {"deleted": True, "item": deleted}
