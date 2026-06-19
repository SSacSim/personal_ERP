from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.config import APP_NAME
from app.routers import assets, calendar, chat, dashboard, meetings, project_files, project_records, projects, tasks, todos, wiki
from app.storage import vault


STATIC_DIR = Path(__file__).resolve().parent / "static"

app = FastAPI(title=APP_NAME, version="0.1.0")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

app.include_router(dashboard.router)
app.include_router(calendar.router)
app.include_router(tasks.router)
app.include_router(todos.router)
app.include_router(projects.router)
app.include_router(meetings.router)
app.include_router(project_files.router)
app.include_router(project_records.router)
app.include_router(wiki.router)
app.include_router(assets.router)
app.include_router(chat.router)


@app.on_event("startup")
def ensure_vault() -> None:
    vault.ensure()


@app.get("/health")
def health():
    return {"status": "ok", "vault": str(vault.root)}


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/{page}", include_in_schema=False)
def page(page: str):
    if page in {"dashboard", "calendar", "tasks", "todos", "projects", "meetings", "wiki"}:
        return FileResponse(STATIC_DIR / "index.html")
    raise HTTPException(status_code=404, detail="not found")
