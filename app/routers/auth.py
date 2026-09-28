from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator

from app import auth
from app.auth_store import LoginLimited, SESSION_SECONDS


router = APIRouter(tags=["authentication"])


class Login(BaseModel):
    model_config = ConfigDict(extra="forbid")
    login_id: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=128)

    @field_validator("login_id", mode="before")
    @classmethod
    def trim_id(cls, value):
        return value.strip() if isinstance(value, str) else value


class UserCreate(Login):
    login_id: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
    password: str = Field(min_length=8, max_length=128)
    name: str = Field(min_length=1, max_length=32)
    job_title: str = Field(min_length=1, max_length=80)

    @field_validator("name", "job_title", mode="before")
    @classmethod
    def clean_text(cls, value):
        if not isinstance(value, str):
            return value
        if any(ord(char) < 32 or ord(char) == 127 for char in value):
            raise ValueError("이름과 직함에 제어 문자를 사용할 수 없습니다.")
        return value.strip()


@router.post("/api/auth/login")
def login(payload: Login, request: Request, response: Response):
    try:
        user = auth.store.authenticate(payload.login_id, payload.password, request.client.host if request.client else "unknown")
    except LoginLimited as exc:
        raise HTTPException(status_code=429, detail=str(exc), headers={"Retry-After": "900"}) from exc
    if user is None:
        raise HTTPException(status_code=401, detail="ID 또는 비밀번호를 확인해 주세요.")
    auth.store.logout(request.cookies.get(auth.COOKIE_NAME, ""))
    token = auth.store.create_session(user["id"])
    response.set_cookie(auth.COOKIE_NAME, token, max_age=SESSION_SECONDS, httponly=True,
                        secure=request.url.scheme == "https", samesite="lax", path="/")
    return {"user": user, "redirect": "/admin" if user["role"] == "admin" else "/dashboard"}


@router.get("/api/auth/me")
def me(user: dict = Depends(auth.current_user)):
    return {"user": user}


@router.post("/api/auth/logout", status_code=204)
def logout(request: Request):
    auth.store.logout(request.cookies.get(auth.COOKIE_NAME, ""))
    response = Response(status_code=204)
    response.delete_cookie(auth.COOKIE_NAME, path="/")
    return response


@router.get("/api/admin/users")
def users(user: dict = Depends(auth.admin_user)):
    return {"items": auth.store.list_users()}


@router.post("/api/admin/users", status_code=201)
def create_user(payload: UserCreate, user: dict = Depends(auth.admin_user)):
    try:
        return auth.store.create_user(**payload.model_dump())
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
