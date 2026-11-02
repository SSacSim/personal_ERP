import base64
import binascii
from contextlib import asynccontextmanager
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile
from starlette.formparsers import MultiPartException, MultiPartParser

from app.config import VAULT_DIR
from app.receipts import MAX_CONTENT_LENGTH, MAX_IMAGE_BYTES, MAX_IMAGES, UNFILED_FOLDER, ReceiptConflict, ReceiptStore


router = APIRouter(prefix="/api/receipts", tags=["receipts"])
store = ReceiptStore(VAULT_DIR / "Receipts")
MAX_REQUEST_BYTES = ((MAX_IMAGE_BYTES + 2) // 3) * 4 + 64 * 1024
MAX_MULTIPART_BYTES = MAX_IMAGES * MAX_IMAGE_BYTES + 128 * 1024


class ReceiptGroupCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    submission_id: UUID
    folder_id: UUID | Literal["unfiled"]
    registrant: str = Field(default="", min_length=1, max_length=50)
    content: str = Field(min_length=1, max_length=MAX_CONTENT_LENGTH)

    @field_validator("registrant", "content")
    @classmethod
    def trim_text(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("등록자와 내용을 입력해 주세요.")
        return value


class ReceiptCreate(ReceiptGroupCreate):
    filename: str = Field(min_length=1, max_length=255)
    image_base64: str = Field(min_length=1, max_length=((MAX_IMAGE_BYTES + 2) // 3) * 4)


class ReceiptGroupUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    content: str = Field(min_length=1, max_length=MAX_CONTENT_LENGTH)

    @field_validator("content")
    @classmethod
    def trim_content(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("내용을 입력해 주세요.")
        return value.strip()


class ReceiptUpdate(ReceiptGroupUpdate):
    filename: str | None = Field(default=None, min_length=1, max_length=255)
    image_base64: str | None = Field(default=None, min_length=1, max_length=((MAX_IMAGE_BYTES + 2) // 3) * 4)

    @model_validator(mode="after")
    def paired_image(self):
        if (self.filename is None) != (self.image_base64 is None):
            raise ValueError("교체할 사진과 파일 이름을 함께 보내 주세요.")
        return self


class ReceiptFolderCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=80)


class ReceiptFolderStatus(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: Literal["in_progress", "completed"]


class ReceiptMove(BaseModel):
    model_config = ConfigDict(extra="forbid")

    folder_id: UUID | Literal["unfiled"]


@router.get("/folders")
def list_receipt_folders():
    return store.list_folders()


@router.post("/folders", status_code=201)
async def create_receipt_folder(request: Request):
    payload = await read_payload(request, ReceiptFolderCreate)
    try:
        return await run_in_threadpool(store.create_folder, payload.name)
    except ReceiptConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.patch("/folders/{folder_id}")
async def update_receipt_folder(folder_id: str, request: Request):
    payload = await read_payload(request, ReceiptFolderStatus)
    record = await run_in_threadpool(store.set_folder_status, folder_id, payload.status)
    if record is None:
        raise HTTPException(status_code=404, detail="영수증 폴더를 찾을 수 없습니다.")
    return record


@router.post("/{receipt_id}/move")
async def move_receipt(receipt_id: str, request: Request):
    payload = await read_payload(request, ReceiptMove)
    try:
        record = await run_in_threadpool(store.move, receipt_id, str(payload.folder_id))
    except ReceiptConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if record is None:
        raise HTTPException(status_code=404, detail="영수증을 찾을 수 없습니다.")
    return record


@router.get("")
def list_receipts(offset: int = Query(default=0, ge=0), limit: int = Query(default=24, ge=1, le=100),
                  folder_id: str | None = Query(default=None, max_length=36)):
    if folder_id is not None and folder_id != UNFILED_FOLDER:
        folder = store.get_folder(folder_id)
        if folder is None:
            raise HTTPException(status_code=404, detail="영수증 폴더를 찾을 수 없습니다.")
        folder_id = folder["id"]
    return store.list(offset, limit, folder_id)


@router.get("/{receipt_id}/image")
@router.get("/{receipt_id}/images/{image_id}")
def receipt_image(receipt_id: str, download: bool = False, image_id: str | None = None):
    result = store.image(receipt_id, image_id)
    if result is None:
        raise HTTPException(status_code=404, detail="영수증 파일을 찾을 수 없습니다.")
    path, record = result
    return FileResponse(path, media_type=record["content_type"], filename=record["filename"],
                        content_disposition_type="attachment" if download else "inline",
                        headers={"X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store"})


class ReceiptBodyTooLarge(MultiPartException):
    pass


@asynccontextmanager
async def read_group(request: Request, model, require_images: bool):
    # The browser sends File objects directly. Spool large files to disk instead
    # of holding up to 20 base64-encoded photos in phone/server memory at once.
    async def bounded_stream():
        size = 0
        async for chunk in request.stream():
            size += len(chunk)
            if size > MAX_MULTIPART_BYTES:
                raise ReceiptBodyTooLarge("파일은 최대 20개, 파일당 10MB까지 등록할 수 있습니다.")
            yield chunk

    parser = MultiPartParser(request.headers, bounded_stream(), max_files=MAX_IMAGES, max_fields=1, max_part_size=64 * 1024)
    try:
        form = await parser.parse()
    except ReceiptBodyTooLarge as exc:
        raise HTTPException(status_code=413, detail=exc.message) from exc
    except (MultiPartException, ValueError) as exc:
        raise HTTPException(status_code=422, detail="파일은 최대 20개까지 등록할 수 있습니다. 업로드 내용을 확인해 주세요.") from exc
    try:
        metadata = form.get("metadata")
        files = form.getlist("images")
        if not isinstance(metadata, str) or set(form) - {"metadata", "images"} or (require_images and not files):
            raise HTTPException(status_code=422, detail="영수증 파일과 등록 내용을 함께 보내 주세요.")
        try:
            payload = model.model_validate_json(metadata)
        except ValidationError as exc:
            raise HTTPException(status_code=422, detail="등록 폴더, 등록자(50자 이내), 내용(4,000자 이내)를 확인해 주세요.") from exc
        for file in files:
            if not isinstance(file, UploadFile) or not file.filename or len(file.filename) > 255:
                raise HTTPException(status_code=422, detail="영수증 파일과 파일 이름(255자 이내)을 확인해 주세요.")
            if not file.size or file.size > MAX_IMAGE_BYTES:
                raise HTTPException(status_code=422, detail="파일은 0바이트보다 크고 파일당 10MB 이하여야 합니다.")
        yield payload, [(file.filename, file.file) for file in files]
    finally:
        await form.close()


async def read_payload(request: Request, model):
    if request.headers.get("content-type", "").split(";", 1)[0].lower() != "application/json":
        raise HTTPException(status_code=415, detail="JSON 형식으로 등록해 주세요.")
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > MAX_REQUEST_BYTES:
            raise HTTPException(status_code=413, detail="영수증 파일은 10MB까지 등록할 수 있습니다.")
        body.extend(chunk)
    try:
        return model.model_validate_json(body)
    except ValidationError as exc:
        messages = {ReceiptFolderCreate: "폴더 이름을 1~80자로 입력해 주세요.",
                    ReceiptFolderStatus: "폴더 상태는 진행 또는 완료로 선택해 주세요.",
                    ReceiptMove: "이동할 폴더를 선택해 주세요."}
        message = messages.get(model, "등록 폴더, 등록자(50자 이내), 내용(4,000자 이내), 파일을 확인해 주세요.")
        raise HTTPException(status_code=422, detail=message) from exc


@router.post("", status_code=201)
async def create_receipt(request: Request):
    try:
        user = getattr(request.state, "user", None)
        if request.headers.get("content-type", "").split(";", 1)[0].lower() == "multipart/form-data":
            async with read_group(request, ReceiptGroupCreate, require_images=True) as (payload, images):
                registrant = user["name"] if user else payload.registrant
                if not registrant:
                    raise ValueError("등록자를 확인해 주세요.")
                return await run_in_threadpool(store.create, payload.submission_id, registrant, payload.content,
                                               folder_id=str(payload.folder_id), images=images)
        payload = await read_payload(request, ReceiptCreate)
        image = base64.b64decode(payload.image_base64, validate=True)
        registrant = user["name"] if user else payload.registrant
        if not registrant:
            raise ValueError("등록자를 확인해 주세요.")
        return await run_in_threadpool(store.create, payload.submission_id, registrant,
                                       payload.content, payload.filename, image, folder_id=str(payload.folder_id))
    except ReceiptConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except (ValueError, binascii.Error) as exc:
        raise HTTPException(status_code=422, detail=str(exc) or "10MB 이하의 JPG, PNG, WEBP, GIF, PDF를 선택해 주세요.") from exc


@router.patch("/{receipt_id}")
async def update_receipt(receipt_id: str, request: Request):
    try:
        if request.headers.get("content-type", "").split(";", 1)[0].lower() == "multipart/form-data":
            async with read_group(request, ReceiptGroupUpdate, require_images=False) as (payload, images):
                record = await run_in_threadpool(store.update, receipt_id, payload.content, images=images or None)
        else:
            payload = await read_payload(request, ReceiptUpdate)
            image = base64.b64decode(payload.image_base64, validate=True) if payload.image_base64 is not None else None
            record = await run_in_threadpool(store.update, receipt_id, payload.content, payload.filename, image)
    except (ValueError, binascii.Error) as exc:
        raise HTTPException(status_code=422, detail=str(exc) or "10MB 이하의 JPG, PNG, WEBP, GIF, PDF를 선택해 주세요.") from exc
    if record is None:
        raise HTTPException(status_code=404, detail="영수증을 찾을 수 없습니다.")
    return record


@router.delete("/{receipt_id}", status_code=204)
def delete_receipt(receipt_id: str):
    if not store.delete(receipt_id):
        raise HTTPException(status_code=404, detail="영수증을 찾을 수 없습니다.")
    return Response(status_code=204)
