from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict, Field, field_validator

from app import auth
from app.auth_store import LoginLimited
from app.config import VAULT_DIR
from app.id_info import IdInfoStore


class PrivateRoute(APIRoute):
    def get_route_handler(self):
        handle = super().get_route_handler()

        async def private_response(request: Request):
            try:
                response = await handle(request)
            except RequestValidationError:
                # Never echo submitted passwords in validation responses.
                detail = "접근 비밀번호를 입력해 주세요." if request.url.path.endswith("/unlock") else "구분(100자), ID(200자), PWD(1,000자), 기타 정보(4,000자)의 입력 내용을 확인해 주세요."
                response = JSONResponse(status_code=422, content={"detail": detail})
            except HTTPException as exc:
                response = JSONResponse(status_code=exc.status_code, content={"detail": exc.detail}, headers=exc.headers)
            response.headers["Cache-Control"] = "no-store"
            response.headers["Pragma"] = "no-cache"
            return response

        return private_response


router = APIRouter(prefix="/api/id-info", tags=["id-info"], route_class=PrivateRoute)
store = IdInfoStore(VAULT_DIR / "IdInfo")


def require_info_access(request: Request, user: dict = Depends(auth.current_user)):
    if not auth.store.info_access_allowed(request.cookies.get(auth.COOKIE_NAME, ""), request.headers.get("X-ERP-Info-Token", "")):
        raise HTTPException(status_code=403, detail="Info 접근 비밀번호를 입력해 주세요.", headers={"X-ERP-Info-Locked": "1"})


class InfoUnlock(BaseModel):
    model_config = ConfigDict(extra="forbid")
    password: str = Field(min_length=1, max_length=1000, repr=False)


@router.post("/unlock")
def unlock_info(payload: InfoUnlock, request: Request, user: dict = Depends(auth.current_user)):
    try:
        result = auth.store.unlock_info(request.cookies.get(auth.COOKIE_NAME, ""), payload.password)
    except LoginLimited as exc:
        raise HTTPException(status_code=429, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc
    if result is None:
        raise HTTPException(status_code=403, detail="비밀번호가 올바르지 않습니다.")
    return result


@router.post("/lock", status_code=204)
def lock_info(request: Request, user: dict = Depends(auth.current_user)):
    auth.store.lock_info(request.cookies.get(auth.COOKIE_NAME, ""), request.headers.get("X-ERP-Info-Token", ""))
    return Response(status_code=204)


class IdInfoCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    category: str = Field(min_length=1, max_length=100)
    login_id: str = Field(default="", max_length=200)
    password: str = Field(default="", max_length=1000, repr=False)
    notes: str = Field(default="", max_length=4000)

    @field_validator("category", mode="before")
    @classmethod
    def trim_category(cls, value):
        return value.strip() if isinstance(value, str) else value


class IdInfoUpdate(IdInfoCreate):
    category: str | None = Field(default=None, min_length=1, max_length=100)
    login_id: str | None = Field(default=None, max_length=200)
    password: str | None = Field(default=None, max_length=1000, repr=False)
    notes: str | None = Field(default=None, max_length=4000)


@router.get("", dependencies=[Depends(require_info_access)])
def list_id_info():
    return {"items": store.list()}


@router.post("", status_code=201, dependencies=[Depends(require_info_access)])
def create_id_info(payload: IdInfoCreate):
    return store.create(payload.model_dump())


@router.patch("/{entry_id}", dependencies=[Depends(require_info_access)])
def update_id_info(entry_id: str, payload: IdInfoUpdate):
    item = store.update(entry_id, payload.model_dump(exclude_none=True, exclude_unset=True))
    if item is None:
        raise HTTPException(status_code=404, detail="ID 정보를 찾을 수 없습니다.")
    return item


@router.get("/{entry_id}/password", dependencies=[Depends(require_info_access)])
def reveal_password(entry_id: str):
    password = store.password(entry_id)
    if password is None:
        raise HTTPException(status_code=404, detail="ID 정보를 찾을 수 없습니다.")
    return {"password": password}


@router.delete("/{entry_id}", status_code=204, dependencies=[Depends(require_info_access)])
def delete_id_info(entry_id: str):
    if not store.delete(entry_id):
        raise HTTPException(status_code=404, detail="ID 정보를 찾을 수 없습니다.")
    return Response(status_code=204)
