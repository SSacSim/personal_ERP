from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field
from starlette.concurrency import run_in_threadpool

from app.config import VAULT_DIR
from app.documents import DocumentStore, MAX_FILE_BYTES


router = APIRouter(prefix="/api/documents", tags=["documents"])
store = DocumentStore(VAULT_DIR / "Documents")


class FolderInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    title: str = Field(min_length=1, max_length=140)
    description: str = Field(default="", max_length=3000)


@router.get("/folders")
def list_folders(response: Response):
    response.headers["Cache-Control"] = "no-store"
    return {"items": store.list_folders(), "max_file_bytes": MAX_FILE_BYTES}


@router.post("/folders", status_code=201)
def create_folder(payload: FolderInput):
    return store.create_folder(payload.model_dump())


@router.patch("/folders/{folder_id}")
def update_folder(folder_id: str, payload: FolderInput):
    item = store.update_folder(folder_id, payload.model_dump())
    if item is None:
        raise HTTPException(status_code=404, detail="폴더를 찾을 수 없습니다.")
    return item


@router.delete("/folders/{folder_id}", status_code=204)
def delete_folder(folder_id: str):
    try:
        deleted = store.delete_folder(folder_id)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if not deleted:
        raise HTTPException(status_code=404, detail="폴더를 찾을 수 없습니다.")
    return Response(status_code=204)


@router.get("/folders/{folder_id}/files")
def list_files(folder_id: str, response: Response):
    response.headers["Cache-Control"] = "no-store"
    items = store.list_files(folder_id)
    if items is None:
        raise HTTPException(status_code=404, detail="폴더를 찾을 수 없습니다.")
    return {"items": items}


@router.post("/folders/{folder_id}/files", status_code=201)
async def upload_file(folder_id: str, request: Request, filename: str = Query(min_length=1, max_length=240)):
    filename = filename.replace("\\", "/").rsplit("/", 1)[-1].strip()
    if filename in {"", ".", ".."} or any(ord(char) < 32 or ord(char) == 127 for char in filename):
        raise HTTPException(status_code=422, detail="사용할 수 없는 파일 이름입니다.")
    length = request.headers.get("content-length")
    if length:
        try:
            size = int(length)
        except ValueError:
            raise HTTPException(status_code=400, detail="올바르지 않은 파일 크기입니다.")
        if size < 0 or size > MAX_FILE_BYTES:
            raise HTTPException(status_code=413, detail="파일은 개당 1GB까지 업로드할 수 있습니다.")
    if await run_in_threadpool(store.folder, folder_id) is None:
        raise HTTPException(status_code=404, detail="폴더를 찾을 수 없습니다.")
    temporary = None
    try:
        with NamedTemporaryFile(dir=store.uploads, suffix=".part", delete=False) as output:
            temporary = Path(output.name)
            size = 0
            async for chunk in request.stream():
                size += len(chunk)
                if size > MAX_FILE_BYTES:
                    raise HTTPException(status_code=413, detail="파일은 개당 1GB까지 업로드할 수 있습니다.")
                await run_in_threadpool(output.write, chunk)
        item = await run_in_threadpool(store.save_file, folder_id, filename, temporary)
        if item is None:
            raise HTTPException(status_code=404, detail="폴더를 찾을 수 없습니다.")
        return item
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


@router.get("/files/{file_id}/{action}")
def get_file(file_id: str, action: Literal["download", "preview"]):
    result = store.file(file_id)
    if result is None or (action == "preview" and not result[1]["preview_type"]):
        raise HTTPException(status_code=404, detail="파일을 찾을 수 없습니다.")
    path, item = result
    return FileResponse(path, filename=item["filename"],
                        media_type=item["preview_type"] if action == "preview" else "application/octet-stream",
                        content_disposition_type="inline" if action == "preview" else "attachment",
                        headers={"X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store",
                                 "Content-Security-Policy": "sandbox"})


@router.delete("/files/{file_id}", status_code=204)
def delete_file(file_id: str):
    if not store.delete_file(file_id):
        raise HTTPException(status_code=404, detail="파일을 찾을 수 없습니다.")
    return Response(status_code=204)
