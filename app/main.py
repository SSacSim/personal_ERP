from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from app.config import APP_NAME
from app import auth
from app.routers import auth as auth_routes
from app.routers import assets, attendance, calendar, chat, companies, dashboard, documents, id_info, meetings, pomodoro, project_files, project_records, projects, receipts, remote_work, tasks, team_chat, todos
from app.storage import vault


STATIC_DIR = Path(__file__).resolve().parent / "static"
RECEIPT_STATIC_DIR = Path(__file__).resolve().parent / "receipt_static"

app = FastAPI(title=APP_NAME, version="0.1.0")
app.add_middleware(auth.AuthenticationMiddleware)
app.include_router(auth_routes.router)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
app.mount("/receipt-static", StaticFiles(directory=RECEIPT_STATIC_DIR), name="receipt-static")

app.include_router(dashboard.router)
app.include_router(calendar.router)
app.include_router(attendance.router)
app.include_router(tasks.router)
app.include_router(todos.router)
app.include_router(projects.router)
app.include_router(meetings.router)
app.include_router(companies.router)
app.include_router(project_files.router)
app.include_router(project_records.router)
app.include_router(documents.router)
app.include_router(assets.router)
app.include_router(chat.router)
app.include_router(team_chat.router)
app.include_router(receipts.router)
app.include_router(id_info.router)
app.include_router(remote_work.router)
app.include_router(pomodoro.router)


@app.on_event("startup")
def ensure_vault() -> None:
    auth.store.ensure()
    vault.ensure()
    admin = next(user for user in auth.store.list_users() if user["login_id"] == "admin")
    vault.migrate_private_notes(admin["id"])
    vault.migrate_project_meeting_companies()
    team_chat.store.ensure()
    team_chat.store.sync_account_profiles(auth.store.list_users())


@app.exception_handler(RequestValidationError)
async def invalid_request(request: Request, exc: RequestValidationError):
    # Validation errors must never echo submitted passwords or uploaded data.
    return JSONResponse(status_code=422, content={"detail": [
        {"loc": error["loc"], "msg": error["msg"], "type": error["type"]} for error in exc.errors()
    ]})


@app.get("/login", include_in_schema=False)
def login_page(request: Request):
    user = getattr(request.state, "user", None)
    if user:
        return RedirectResponse("/admin" if user["role"] == "admin" else "/dashboard", status_code=303)
    return FileResponse(STATIC_DIR / "login.html")


@app.get("/admin", include_in_schema=False)
def admin_page(request: Request):
    auth.admin_user(request)
    return FileResponse(STATIC_DIR / "admin.html")


@app.get("/health")
def health():
    return {"status": "ok", "vault": str(vault.root)}


@app.get("/", include_in_schema=False)
def index(request: Request):
    user = auth.current_user(request)
    return RedirectResponse("/admin" if user["role"] == "admin" else "/dashboard", status_code=303)


@app.get("/receipt-upload", include_in_schema=False)
def receipt_upload():
    return FileResponse(RECEIPT_STATIC_DIR / "index.html")


@app.get("/{page}", include_in_schema=False)
def page(page: str):
    if page in {"dashboard", "calendar", "attendance", "tasks", "todos", "projects", "meetings", "documents", "chat", "receipts", "id-info", "pomodoro", "remote-work"}:
        return FileResponse(STATIC_DIR / "index.html")
    raise HTTPException(status_code=404, detail="not found")
