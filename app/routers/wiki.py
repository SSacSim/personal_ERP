from fastapi import APIRouter, HTTPException

from app.models import WikiPageCreate, WikiPageUpdate
from app.storage import vault


router = APIRouter(prefix="/api/wiki", tags=["wiki"])


@router.get("")
def list_wiki_pages(project_id: str | None = None):
    return {"items": vault.list_wiki_pages(project_id=project_id)}


@router.post("", status_code=201)
def create_wiki_page(payload: WikiPageCreate):
    return vault.create_wiki_page(payload.model_dump())


@router.patch("/{page_id}")
def update_wiki_page(page_id: str, payload: WikiPageUpdate):
    updated = vault.update_wiki_page(page_id, payload.model_dump(exclude_unset=True))
    if updated is None:
        raise HTTPException(status_code=404, detail="wiki page not found")
    return updated


@router.delete("/{page_id}")
def delete_wiki_page(page_id: str):
    deleted = vault.delete_wiki_page(page_id)
    if deleted is None:
        raise HTTPException(status_code=404, detail="wiki page not found")
    return {"deleted": True, "item": deleted}
