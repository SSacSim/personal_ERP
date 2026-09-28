from pathlib import Path
import re
from tempfile import NamedTemporaryFile
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field, model_validator
from starlette.concurrency import run_in_threadpool

from app.config import VAULT_DIR
from app.auth import current_user
from app.team_chat import ChatStore, MAX_ATTACHMENTS, MAX_FILE_BYTES, MAX_MESSAGE_LENGTH


router = APIRouter(prefix="/api/team-chat", tags=["team-chat"])
store = ChatStore(VAULT_DIR / "Chat")


class MessageCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str = Field(default="", max_length=MAX_MESSAGE_LENGTH)
    attachment_ids: list[str] = Field(default_factory=list, max_length=MAX_ATTACHMENTS)
    client_id: UUID

    @model_validator(mode="after")
    def validate_content(self):
        self.text = self.text.strip()
        if not self.text and not self.attachment_ids:
            raise ValueError("메시지 또는 파일을 추가해 주세요.")
        if len(set(self.attachment_ids)) != len(self.attachment_ids):
            raise ValueError("첨부 파일이 중복되었습니다.")
        if any(not re.fullmatch(r"[a-f0-9]{32}", value) for value in self.attachment_ids):
            raise ValueError("올바르지 않은 첨부 파일입니다.")
        return self


class MessageUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str = Field(max_length=MAX_MESSAGE_LENGTH)


def participant(user: dict = Depends(current_user)) -> dict:
    return store.account_participant(user["id"], user["name"], user["job_title"])


@router.get("/session")
def current_session(current: dict = Depends(participant)):
    store.touch(current["id"])
    return {"participant": current}


@router.get("/messages")
def messages(after: int | None = Query(default=None, ge=0), before: int | None = Query(default=None, ge=1),
             since_change: int | None = Query(default=None, ge=0),
             limit: int = Query(default=60, ge=1, le=100), current: dict = Depends(participant)):
    if after is not None and before is not None:
        raise HTTPException(status_code=422, detail="after와 before는 함께 사용할 수 없습니다.")
    store.touch(current["id"])
    return {**store.messages(after=after, before=before, limit=limit, since_change=since_change), "participants": store.participants()}


@router.post("/messages", status_code=201)
def send_message(payload: MessageCreate, current: dict = Depends(participant)):
    try:
        return store.send(current, payload.text, payload.attachment_ids, str(payload.client_id))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


def change_message(current: dict, message_id: int, **changes):
    try:
        return store.change_message(current["id"], message_id, **changes)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.patch("/messages/{message_id}")
def edit_message(message_id: int, payload: MessageUpdate, current: dict = Depends(participant)):
    return change_message(current, message_id, text=payload.text)


@router.delete("/messages/{message_id}")
def delete_message(message_id: int, current: dict = Depends(participant)):
    return change_message(current, message_id, delete=True)


@router.get("/files")
def shared_files(current: dict = Depends(participant)):
    return {"items": store.shared_files()}


@router.post("/files", status_code=201)
async def upload_file(request: Request, upload_id: UUID, filename: str = Query(min_length=1, max_length=240),
                      current: dict = Depends(participant)):
    # Original names are download metadata only; disk paths always use generated IDs.
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
    existing = await run_in_threadpool(store.uploaded, current["id"], str(upload_id))
    if existing:
        return existing
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
        return await run_in_threadpool(store.save_upload, current["id"], str(upload_id), filename, temporary, size)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


@router.get("/files/{file_id}/download")
def download_file(file_id: str, current: dict = Depends(participant)):
    result = store.download(file_id)
    if result is None:
        raise HTTPException(status_code=404, detail="공유된 파일을 찾을 수 없습니다.")
    path, metadata = result
    return FileResponse(path, filename=metadata["filename"], media_type="application/octet-stream",
                        headers={"X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store"})


@router.delete("/files/{file_id}")
def discard_file(file_id: str, current: dict = Depends(participant)):
    if not store.discard_upload(current["id"], file_id):
        raise HTTPException(status_code=404, detail="전송 대기 중인 파일을 찾을 수 없습니다.")
    return {"deleted": True}
