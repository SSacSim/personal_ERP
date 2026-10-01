import base64
import binascii
from contextlib import asynccontextmanager
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile
from starlette.formparsers import MultiPartException, MultiPartParser

from app.config import VAULT_DIR
from app.receipts import MAX_CONTENT_LENGTH, MAX_IMAGE_BYTES, MAX_IMAGES, ReceiptConflict, ReceiptStore


router = APIRouter(prefix="/api/receipts", tags=["receipts"])
store = ReceiptStore(VAULT_DIR / "Receipts")
MAX_REQUEST_BYTES = ((MAX_IMAGE_BYTES + 2) // 3) * 4 + 64 * 1024
MAX_MULTIPART_BYTES = MAX_IMAGES * MAX_IMAGE_BYTES + 128 * 1024


class ReceiptGroupCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    submission_id: UUID
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


@router.get("")
def list_receipts(offset: int = Query(default=0, ge=0), limit: int = Query(default=24, ge=1, le=100)):
    return store.list(offset, limit)


@router.get("/{receipt_id}/image")
@router.get("/{receipt_id}/images/{image_id}")
def receipt_image(receipt_id: str, download: bool = False, image_id: str | None = None):
    result = store.image(receipt_id, image_id)
    if result is None:
        raise HTTPException(status_code=404, detail="영수증 사진을 찾을 수 없습니다.")
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
                raise ReceiptBodyTooLarge("사진은 최대 20장, 사진당 10MB까지 등록할 수 있습니다.")
            yield chunk

    parser = MultiPartParser(request.headers, bounded_stream(), max_files=MAX_IMAGES, max_fields=1, max_part_size=64 * 1024)
    try:
        form = await parser.parse()
    except ReceiptBodyTooLarge as exc:
        raise HTTPException(status_code=413, detail=exc.message) from exc
    except (MultiPartException, ValueError) as exc:
        raise HTTPException(status_code=422, detail="사진은 최대 20장까지 등록할 수 있습니다. 업로드 내용을 확인해 주세요.") from exc
    try:
        metadata = form.get("metadata")
        files = form.getlist("images")
        if not isinstance(metadata, str) or set(form) - {"metadata", "images"} or (require_images and not files):
            raise HTTPException(status_code=422, detail="사진과 등록 내용을 함께 보내 주세요.")
        try:
            payload = model.model_validate_json(metadata)
        except ValidationError as exc:
            raise HTTPException(status_code=422, detail="등록자(50자 이내), 내용(4,000자 이내)를 확인해 주세요.") from exc
        for file in files:
            if not isinstance(file, UploadFile) or not file.filename or len(file.filename) > 255:
                raise HTTPException(status_code=422, detail="사진 파일과 파일 이름(255자 이내)을 확인해 주세요.")
            if not file.size or file.size > MAX_IMAGE_BYTES:
                raise HTTPException(status_code=422, detail="사진은 0바이트보다 크고 사진당 10MB 이하여야 합니다.")
        yield payload, [(file.filename, file.file) for file in files]
    finally:
        await form.close()


async def read_payload(request: Request, model):
    if request.headers.get("content-type", "").split(";", 1)[0].lower() != "application/json":
        raise HTTPException(status_code=415, detail="JSON 형식으로 등록해 주세요.")
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > MAX_REQUEST_BYTES:
            raise HTTPException(status_code=413, detail="영수증 사진은 10MB까지 등록할 수 있습니다.")
        body.extend(chunk)
    try:
        return model.model_validate_json(body)
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail="등록자(50자 이내), 내용(4,000자 이내), 사진을 확인해 주세요.") from exc


@router.post("", status_code=201)
async def create_receipt(request: Request):
    try:
        user = getattr(request.state, "user", None)
        if request.headers.get("content-type", "").split(";", 1)[0].lower() == "multipart/form-data":
            async with read_group(request, ReceiptGroupCreate, require_images=True) as (payload, images):
                registrant = user["name"] if user else payload.registrant
                if not registrant:
                    raise ValueError("등록자를 확인해 주세요.")
                return await run_in_threadpool(store.create, payload.submission_id, registrant, payload.content, images=images)
        payload = await read_payload(request, ReceiptCreate)
        image = base64.b64decode(payload.image_base64, validate=True)
        registrant = user["name"] if user else payload.registrant
        if not registrant:
            raise ValueError("등록자를 확인해 주세요.")
        return await run_in_threadpool(store.create, payload.submission_id, registrant,
                                       payload.content, payload.filename, image)
    except ReceiptConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except (ValueError, binascii.Error) as exc:
        raise HTTPException(status_code=422, detail="사진 형식이 올바르지 않습니다. 10MB 이하의 JPG, PNG, WEBP, GIF를 선택해 주세요.") from exc


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
        raise HTTPException(status_code=422, detail="사진 형식이 올바르지 않습니다. 10MB 이하의 JPG, PNG, WEBP, GIF를 선택해 주세요.") from exc
    if record is None:
        raise HTTPException(status_code=404, detail="영수증을 찾을 수 없습니다.")
    return record


@router.delete("/{receipt_id}", status_code=204)
def delete_receipt(receipt_id: str):
    if not store.delete(receipt_id):
        raise HTTPException(status_code=404, detail="영수증을 찾을 수 없습니다.")
    return Response(status_code=204)
