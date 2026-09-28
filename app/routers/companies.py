from fastapi import APIRouter
from pydantic import BaseModel, Field, field_validator

from app.companies import normalize_company_name
from app.storage import vault


router = APIRouter(prefix="/api/companies", tags=["companies"])


class CompanyCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)

    @field_validator("name", mode="before")
    @classmethod
    def clean_name(cls, value):
        return normalize_company_name(value) if isinstance(value, str) else value


@router.get("")
def list_companies():
    return {"items": vault.companies.list()}


@router.post("", status_code=201)
def create_company(payload: CompanyCreate):
    return vault.companies.create(payload.name)
