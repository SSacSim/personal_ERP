from __future__ import annotations

from dataclasses import dataclass
import os
import re
import textwrap
from typing import Any

from app.config import BASE_DIR
from app.storage import parse_note, split_change_log, vault


TOKEN_PATTERN = re.compile(r"[0-9A-Za-z가-힣]{2,}")
MAX_CONTEXT_CHARS = 18000
MAX_SOURCE_CHARS = 2200
DOCS_DIR = BASE_DIR / "docs"
PROJECT_TEXT_EXTENSIONS = {
    ".cfg",
    ".css",
    ".html",
    ".ini",
    ".js",
    ".json",
    ".md",
    ".py",
    ".toml",
    ".txt",
    ".yaml",
    ".yml",
}
PROJECT_TEXT_FILENAMES = {"dockerfile", "makefile", "requirements.txt"}
PROJECT_EXCLUDED_DIRS = {
    ".agents",
    ".codex",
    ".git",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".venv",
    "__pycache__",
    "build",
    "dist",
    "node_modules",
    "uploads",
}
PROJECT_EXCLUDED_FILENAMES = {".env", ".env.local", ".env.production", ".env.development"}
MAX_PROJECT_FILE_BYTES = 200_000


@dataclass
class VaultSource:
    title: str
    path: str
    note_type: str
    updated_at: str
    body: str
    metadata: dict[str, Any]
    score: int = 0

    def as_public_dict(self) -> dict[str, str]:
        return {
            "title": self.title,
            "path": self.path,
            "type": self.note_type,
            "updated_at": self.updated_at,
        }


def answer_from_vault(question: str) -> dict[str, Any]:
    question = question.strip()
    tokens = tokenize(question)
    sources = ranked_sources(tokens)
    prompt_context = build_context(sources)

    codex_answer, codex_mode = answer_with_codex(question, prompt_context)
    if codex_answer:
        return {
            "answer": codex_answer,
            "sources": [source.as_public_dict() for source in sources],
            "mode": codex_mode,
        }

    return {
        "answer": local_answer(question, tokens, sources),
        "sources": [source.as_public_dict() for source in sources],
        "mode": "vault_search",
    }


def tokenize(value: str) -> list[str]:
    return [token.lower() for token in TOKEN_PATTERN.findall(value)]


def ranked_sources(tokens: list[str], limit: int = 8) -> list[VaultSource]:
    sources = []
    all_sources = iter_search_sources()
    for source in all_sources:
        source.score = score_source(source, tokens)
        if source.score > 0:
            sources.append(source)
    sources.sort(key=lambda item: (item.score, item.updated_at, item.title), reverse=True)
    if sources:
        return sources[:limit]
    return default_project_sources(all_sources, limit)


def iter_search_sources() -> list[VaultSource]:
    sources = iter_vault_sources()
    sources.extend(iter_project_sources())
    return sources


def iter_vault_sources() -> list[VaultSource]:
    sources: list[VaultSource] = []
    for path in sorted(vault.root.rglob("*.md")):
        if any(part.startswith(".") for part in path.relative_to(vault.root).parts):
            continue
        try:
            metadata, body = parse_note(path.read_text(encoding="utf-8"))
        except UnicodeDecodeError:
            continue
        if metadata.get("deleted") is True:
            continue
        title = str(
            metadata.get("title")
            or metadata.get("name")
            or metadata.get("filename")
            or first_heading(body)
            or path.stem
        )
        body_content, _ = split_change_log(body)
        sources.append(
            VaultSource(
                title=title,
                path=path.relative_to(vault.root).as_posix(),
                note_type=str(metadata.get("type") or path.parent.name),
                updated_at=str(metadata.get("updated_at") or metadata.get("created_at") or ""),
                body=body_content,
                metadata=metadata,
            )
        )
    sources.extend(iter_docs_sources())
    return sources


def iter_project_sources() -> list[VaultSource]:
    sources: list[VaultSource] = []
    for path in sorted(BASE_DIR.rglob("*")):
        if not path.is_file():
            continue
        if should_skip_project_file(path):
            continue
        try:
            raw = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue

        relative_path = path.relative_to(BASE_DIR).as_posix()
        if path.suffix.lower() == ".md":
            metadata, body = parse_note(raw)
            body_content, _ = split_change_log(body)
            title = str(metadata.get("title") or first_heading(body_content) or relative_path)
            metadata = {**metadata, "title": title, "type": "project_file", "path": relative_path}
        else:
            body_content = raw
            title = relative_path
            metadata = {"title": title, "type": "project_file", "path": relative_path}

        sources.append(
            VaultSource(
                title=title,
                path=relative_path,
                note_type="project_file",
                updated_at=str(int(path.stat().st_mtime)),
                body=body_content,
                metadata=metadata,
            )
        )
    return sources


def should_skip_project_file(path: Any) -> bool:
    try:
        relative = path.relative_to(BASE_DIR)
    except ValueError:
        return True
    parts = relative.parts
    if any(part in PROJECT_EXCLUDED_DIRS or part.startswith(".") for part in parts[:-1]):
        return True
    if path.name.lower() in PROJECT_EXCLUDED_FILENAMES:
        return True
    if path.suffix.lower() not in PROJECT_TEXT_EXTENSIONS and path.name.lower() not in PROJECT_TEXT_FILENAMES:
        return True
    if is_relative_to(path, vault.root) or is_relative_to(path, DOCS_DIR):
        return True
    try:
        return path.stat().st_size > MAX_PROJECT_FILE_BYTES
    except OSError:
        return True


def is_relative_to(path: Any, parent: Any) -> bool:
    try:
        path.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def default_project_sources(sources: list[VaultSource], limit: int) -> list[VaultSource]:
    preferred_paths = [
        "README.md",
        "docs/agents/team.md",
        "docs/obsidian-vault.md",
        "docs/page-functions.md",
        "run.py",
        "app/main.py",
        "app/models.py",
        "app/vault_answer.py",
        "app/static/app.js",
    ]
    by_path = {source.path: source for source in sources}
    defaults = [by_path[path] for path in preferred_paths if path in by_path]
    if len(defaults) < limit:
        defaults.extend(
            source
            for source in sources
            if source not in defaults and source.note_type in {"project_doc", "project_file"}
        )
    return defaults[:limit]


def iter_docs_sources() -> list[VaultSource]:
    sources: list[VaultSource] = []
    if not DOCS_DIR.exists():
        return sources
    for path in sorted(DOCS_DIR.rglob("*.md")):
        if any(part.startswith(".") for part in path.relative_to(DOCS_DIR).parts):
            continue
        try:
            raw = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        metadata, body = parse_note(raw)
        body_content, _ = split_change_log(body)
        title = str(metadata.get("title") or first_heading(body_content) or path.stem)
        relative_path = path.relative_to(BASE_DIR).as_posix()
        sources.append(
            VaultSource(
                title=title,
                path=relative_path,
                note_type="project_doc",
                updated_at="",
                body=body_content,
                metadata={
                    **metadata,
                    "title": title,
                    "type": "project_doc",
                    "path": relative_path,
                },
            )
        )
    return sources


def first_heading(body: str) -> str:
    for line in body.splitlines():
        text = line.strip()
        if text.startswith("#"):
            return text.lstrip("#").strip()
    return ""


def score_source(source: VaultSource, tokens: list[str]) -> int:
    if not tokens:
        return 0
    title = source.title.lower()
    path = source.path.lower()
    note_type = source.note_type.lower()
    body = source.body.lower()
    metadata_text = " ".join(str(value).lower() for value in source.metadata.values())
    title_tokens = set(tokenize(source.title))
    path_tokens = set(tokenize(source.path))
    score = 0
    for token in tokens:
        if token in title_tokens:
            score += 20
        if token in path_tokens:
            score += 12
        score += title.count(token) * 8
        score += path.count(token) * 5
        score += note_type.count(token) * 4
        score += min(metadata_text.count(token), 8) * 3
        score += min(body.count(token), 12)
    return score


def build_context(sources: list[VaultSource]) -> str:
    chunks = []
    remaining = MAX_CONTEXT_CHARS
    for index, source in enumerate(sources, start=1):
        metadata = ", ".join(
            f"{key}: {value}"
            for key, value in source.metadata.items()
            if key in {"type", "title", "name", "filename", "company_name", "status", "date", "project_id", "updated_at"}
            and value is not None
            and value != ""
        )
        content = source.body.strip()[:MAX_SOURCE_CHARS]
        chunk = f"[{index}] {source.title}\npath: {source.path}\nmetadata: {metadata}\ncontent:\n{content}".strip()
        if len(chunk) > remaining:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    return "\n\n---\n\n".join(chunks)


def answer_with_codex(question: str, context: str) -> tuple[str | None, str]:
    if not context or os.getenv("GAI_ERP_USE_CODEX_SDK", "1").lower() in {"0", "false", "no"}:
        return None, ""
    prompt = codex_prompt(question, context)
    sdk_answer = answer_with_codex_sdk(prompt)
    if sdk_answer:
        if sdk_answer.startswith("Codex Python SDK 실행 실패"):
            return sdk_answer, "codex_sdk_error"
        return sdk_answer, "codex_sdk"
    return None, ""


def codex_prompt(question: str, context: str) -> str:
    return textwrap.dedent(
        f"""
        너는 Obsidian vault, docs 폴더, 그리고 run.py가 있는 현재 프로젝트 폴더의 텍스트 파일을 읽고 답변하는 한국어 어시스턴트다.
        아래 CONTEXT는 질문과 관련도가 높은 파일만 선별한 내용이다.
        CONTEXT와 현재 작업 디렉터리의 읽을 수 있는 파일에서 확인되지 않는 내용은 추측하지 말고, 확인되지 않는다고 말한다.

        답변 형식 규칙:
        - 사용자가 바로 읽을 수 있게 짧은 문단과 bullet list 중심으로 정리한다.
        - bullet은 반드시 "* " 로 시작한다.
        - 질문이 요약형이면 "요약" 아래 핵심만 3~5개 bullet로 정리한다.
        - 질문이 진행상황/업무 확인이면 "확인된 내용", "다음 확인 필요" 순서로 정리한다.
        - 질문이 일정/회의/자료 관련이면 날짜, 대상, 상태를 bullet에 포함한다.
        - 불필요한 긴 설명, 원문 전체 복사, JSON, 코드블록은 쓰지 않는다.
        - "근거", "출처", 노트 경로, 파일 경로 섹션은 작성하지 않는다.
        - 확인할 수 없는 내용은 "저장된 노트에서 확인되지 않습니다."라고 명확히 말한다.

        CONTEXT:
        {context}

        QUESTION:
        {question}
        """
    ).strip()


def answer_with_codex_sdk(prompt: str) -> str | None:
    try:
        from openai_codex import ApprovalMode, Codex, CodexConfig, Sandbox
    except ImportError as exc:
        return sdk_error_answer(f"openai_codex 패키지를 import할 수 없습니다: {exc}")

    try:
        model = os.getenv("GAI_ERP_CODEX_MODEL", "").strip() or None
        config = CodexConfig(
            cwd=str(BASE_DIR),
            env={
                "PYTHONIOENCODING": "utf-8",
                "LANG": "C.UTF-8",
                "LC_ALL": "C.UTF-8",
                "NO_COLOR": "1",
            },
        )
        with Codex(config=config) as codex:
            thread = codex.thread_start(
                approval_mode=ApprovalMode.deny_all,
                cwd=str(BASE_DIR),
                ephemeral=True,
                model=model,
                sandbox=Sandbox.read_only,
            )
            result = thread.run(
                prompt,
                approval_mode=ApprovalMode.deny_all,
                cwd=str(BASE_DIR),
                model=model,
                sandbox=Sandbox.read_only,
            )
    except Exception as exc:
        return sdk_error_answer(str(exc))
    return (result.final_response or "").strip() or sdk_error_answer("Codex SDK가 빈 답변을 반환했습니다.")


def sdk_error_answer(message: str) -> str:
    return "\n".join(
        [
            "Codex Python SDK 실행 실패",
            f"* {message}",
            "* 서버 Python 환경에서 openai-codex 인증과 런타임 권한을 확인해 주세요.",
        ]
    )


def local_answer(question: str, tokens: list[str], sources: list[VaultSource]) -> str:
    if not sources:
        return "\n".join(
            [
                "확인 결과",
                "* 저장된 Obsidian 노트와 프로젝트 폴더에서 질문과 관련된 내용을 찾지 못했습니다.",
                "* 관련 내용을 문서, 코드, 회의록, 기록, 프로젝트 메모에 저장한 뒤 다시 질문해 주세요.",
            ]
        )
    if all(source.score <= 0 for source in sources):
        return "\n".join(
            [
                "확인 결과",
                "* 질문과 직접 일치하는 내용은 저장된 노트와 프로젝트 폴더에서 찾지 못했습니다.",
                "* 현재 검색 가능한 기본 범위는 README.md, docs 폴더, run.py, app 폴더의 주요 텍스트 파일입니다.",
            ]
        )

    lines = ["확인된 내용"]
    for source in sources[:4]:
        snippet = source_snippet(source, tokens)
        lines.append(f"* {source.title}: {snippet}")
    return "\n".join(lines)


def source_snippet(source: VaultSource, tokens: list[str]) -> str:
    clean_lines = [line.strip(" -\t") for line in source.body.splitlines() if line.strip()]
    matches = [
        line
        for line in clean_lines
        if any(token in line.lower() for token in tokens)
        and not line.startswith("#")
    ]
    selected = matches[:3] or [line for line in clean_lines if not line.startswith("#")][:3]
    text = " / ".join(selected).strip()
    if not text:
        text = "본문 내용이 비어 있고 메타데이터만 저장되어 있습니다."
    return textwrap.shorten(text, width=220, placeholder="...")
