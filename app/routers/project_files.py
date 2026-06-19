import base64
import mimetypes

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from app.models import ProjectFileUpload
from app.storage import vault


router = APIRouter(prefix="/api/project-files", tags=["project-files"])


@router.get("")
def list_project_files(project_id: str | None = None):
    return {"items": vault.list_project_files(project_id=project_id)}


@router.post("", status_code=201)
def upload_project_file(payload: ProjectFileUpload):
    marker = ";base64,"
    if marker not in payload.data_url:
        raise HTTPException(status_code=422, detail="data_url must be base64 encoded")
    _, encoded = payload.data_url.split(marker, 1)
    try:
        content = base64.b64decode(encoded, validate=True)
        return vault.save_project_file(payload.model_dump(exclude={"data_url"}), content)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/{file_id}/download")
def download_project_file(file_id: str):
    result = vault.project_file(file_id)
    if result is None:
        raise HTTPException(status_code=404, detail="file not found")
    path, metadata = result
    filename = str(metadata.get("filename") or path.name)
    media_type = str(metadata.get("content_type") or "") or mimetypes.guess_type(filename)[0] or "application/octet-stream"
    return FileResponse(path, media_type=media_type, filename=filename)


@router.delete("/{file_id}")
def delete_project_file(file_id: str):
    deleted = vault.delete_project_file(file_id)
    if deleted is None:
        raise HTTPException(status_code=404, detail="file not found")
    return {"deleted": True, "item": deleted}
