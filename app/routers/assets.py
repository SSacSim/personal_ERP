import base64
import mimetypes

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from app.models import AssetUpload
from app.storage import vault


router = APIRouter(prefix="/api/assets", tags=["assets"])


@router.post("", status_code=201)
def upload_asset(payload: AssetUpload):
    marker = ";base64,"
    if marker not in payload.data_url:
        raise HTTPException(status_code=422, detail="data_url must be base64 encoded")
    header, encoded = payload.data_url.split(marker, 1)
    if not header.startswith("data:image/"):
        raise HTTPException(status_code=422, detail="only image data URLs are supported")
    try:
        content = base64.b64decode(encoded, validate=True)
        return vault.save_asset(payload.filename, payload.content_type, content)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/{asset_path:path}")
def get_asset(asset_path: str):
    path = vault.asset_file(asset_path)
    if path is None:
        raise HTTPException(status_code=404, detail="asset not found")
    media_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return FileResponse(path, media_type=media_type)
