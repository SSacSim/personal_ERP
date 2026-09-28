from datetime import date
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator
from starlette.concurrency import run_in_threadpool

from app.config import VAULT_DIR
from app.remote_work import MAX_ATTACHMENTS, MAX_FILE_BYTES, RemoteWorkStore


router = APIRouter(prefix="/api/remote-work", tags=["remote-work"])
store = RemoteWorkStore(VAULT_DIR / "RemoteWork")


class RemoteWorkCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    work_date: date
    author: str = Field(default="", min_length=1, max_length=80)
    content: str = Field(min_length=1, max_length=10000)
    attachment_ids: list[Annotated[str, StringConstraints(pattern=r"^[a-f0-9]{32}$")]] = Field(default_factory=list, max_length=MAX_ATTACHMENTS)

    @field_validator("attachment_ids")
    @classmethod
    def unique_attachments(cls, value):
        if len(set(value)) != len(value):
            raise ValueError("첨부 파일이 중복되었습니다.")
        return value

    @field_validator("author", "content", mode="before")
    @classmethod
    def clean_text(cls, value):
        return value.strip() if isinstance(value, str) else value

    @field_validator("work_date", mode="before")
    @classmethod
    def calendar_date(cls, value):
        if not isinstance(value, str) or len(value) != 10:
            raise ValueError("근무 날짜는 YYYY-MM-DD 형식으로 입력해 주세요.")
        parsed = date.fromisoformat(value)
        if parsed.isoformat() != value:
            raise ValueError("근무 날짜는 YYYY-MM-DD 형식으로 입력해 주세요.")
        return parsed


class RemoteWorkUpdate(RemoteWorkCreate):
    work_date: date | None = None
    author: str | None = Field(default=None, min_length=1, max_length=80)
    content: str | None = Field(default=None, min_length=1, max_length=10000)

    @field_validator("author", "content", mode="before")
    @classmethod
    def reject_null(cls, value):
        if value is None:
            raise ValueError("작성자와 진행 내용은 비워둘 수 없습니다.")
        return value


@router.get("")
def list_remote_work(response: Response, month: str = Query(default="", pattern=r"^(?:[0-9]{4}-(?:0[1-9]|1[0-2]))?$"),
                     q: str = Query(default="", max_length=100), limit: int = Query(default=25, ge=1, le=100),
                     offset: int = Query(default=0, ge=0)):
    response.headers["Cache-Control"] = "no-store"
    return store.list(month=month, query=q.strip(), limit=limit, offset=offset)


@router.post("", status_code=201)
def create_remote_work(payload: RemoteWorkCreate, request: Request):
    try:
        values = payload.model_dump(mode="json")
        user = getattr(request.state, "user", None)
        if user:
            values["author"] = user["name"]
        if not values["author"]:
            raise ValueError("작성자를 확인해 주세요.")
        return store.create(values)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/files", status_code=201)
async def upload_file(request: Request, upload_id: UUID, kind: Literal["image", "file"],
                      filename: str = Query(min_length=1, max_length=240)):
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
            raise HTTPException(status_code=413, detail="파일은 20MB까지 첨부할 수 있습니다.")
    temporary = None
    try:
        with NamedTemporaryFile(dir=store.uploads, suffix=".part", delete=False) as output:
            temporary = Path(output.name)
            size = 0
            async for chunk in request.stream():
                size += len(chunk)
                if size > MAX_FILE_BYTES:
                    raise HTTPException(status_code=413, detail="파일은 20MB까지 첨부할 수 있습니다.")
                await run_in_threadpool(output.write, chunk)
        return await run_in_threadpool(store.save_upload, upload_id.hex, filename, kind, temporary)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


@router.delete("/files/{file_id}", status_code=204)
def discard_file(file_id: str):
    if not store.discard_upload(file_id):
        raise HTTPException(status_code=404, detail="등록 대기 중인 파일을 찾을 수 없습니다.")
    return Response(status_code=204)


@router.get("/files/{file_id}/{action}")
def get_file(file_id: str, action: Literal["download", "preview"]):
    result = store.file(file_id)
    if result is None or (action == "preview" and result[1]["kind"] != "image"):
        raise HTTPException(status_code=404, detail="첨부 파일을 찾을 수 없습니다.")
    path, metadata = result
    return FileResponse(path, filename=metadata["filename"],
                        media_type=metadata["media_type"] if action == "preview" else "application/octet-stream",
                        content_disposition_type="inline" if action == "preview" else "attachment",
                        headers={"X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store"})


@router.patch("/{entry_id}")
def update_remote_work(entry_id: str, payload: RemoteWorkUpdate, request: Request):
    try:
        changes = payload.model_dump(mode="json", exclude_unset=True)
        if getattr(request.state, "user", None):
            changes.pop("author", None)
        item = store.update(entry_id, changes)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if item is None:
        raise HTTPException(status_code=404, detail="재택근무 기록을 찾을 수 없습니다.")
    return item


@router.delete("/{entry_id}", status_code=204)
def delete_remote_work(entry_id: str):
    if not store.delete(entry_id):
        raise HTTPException(status_code=404, detail="재택근무 기록을 찾을 수 없습니다.")
    return Response(status_code=204)
