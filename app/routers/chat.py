from fastapi import APIRouter, HTTPException

from app.codex_auth import codex_login_status, start_codex_login
from app.models import ChatQuestion
from app.vault_answer import answer_from_vault


router = APIRouter(prefix="/api/chat", tags=["chat"])


@router.post("/ask")
def ask_chatbot(payload: ChatQuestion):
    question = payload.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="question is required")
    return answer_from_vault(question)


@router.post("/auth/start")
def start_auth():
    try:
        return start_codex_login()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.get("/auth/{login_id}")
def auth_status(login_id: str):
    return codex_login_status(login_id)
