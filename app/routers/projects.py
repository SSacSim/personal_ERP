from fastapi import APIRouter, HTTPException

from app.models import ProjectCreate, ProjectUpdate
from app.storage import vault


router = APIRouter(prefix="/api/projects", tags=["projects"])


@router.get("")
def list_projects():
    return {"items": vault.list_projects()}


@router.post("", status_code=201)
def create_project(payload: ProjectCreate):
    return vault.create_project(payload.model_dump())


@router.patch("/{project_id}")
def update_project(project_id: str, payload: ProjectUpdate):
    updated = vault.update_project(project_id, payload.model_dump(exclude_unset=True))
    if updated is None:
        raise HTTPException(status_code=404, detail="project not found")
    return updated
