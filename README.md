# GAI ERP

회사 내부용 ERP MVP입니다. FastAPI 백엔드, 정적 프론트엔드, Obsidian Markdown Vault 저장 구조로 구성되어 있습니다.

## 실행

```powershell
python run.py
```

브라우저에서 `config.yaml`의 `server.host`와 `server.port`에 맞춰 접속하면 됩니다. 기본값은 `http://127.0.0.1:8010`입니다.

## 로컬 설정

실행 IP, 포트, reload 여부는 `config.yaml`에서 관리합니다. 이 파일은 로컬 전용이라 Git에 올라가지 않습니다. 공유용 기본값은 `config.example.yaml`을 참고하면 됩니다.

```yaml
server:
  host: 127.0.0.1
  port: 8010
  reload: true

vault:
  path: vault
```

`gai_erp` 가상환경을 직접 지정해서 실행할 때는 다음 명령을 사용합니다.

```powershell
C:\Users\sim\anaconda3\envs\gai_erp\python.exe run.py
```

## 페이지

- `/dashboard`: 오늘 상태 대시보드
- `/calendar`: 연차, 반차, 미팅, 회사 일정 등록
- `/tasks`: JIRA 형태의 작업 등록 및 start/end date 기반 작업바 표시
- `/todos`: 오늘 TODO, 미완료 항목 자동 이월, 주간 보고서 생성
- `/projects`: 회사별 프로젝트 생성, 프로젝트별 회의록 및 Wiki 관리
- `/meetings`: 회의록 작성 및 Markdown 저장
- `/wiki`: 운영 지식과 절차 문서 저장

## 저장 방식

모든 업무 데이터는 `vault/` 아래 Markdown 노트로 저장됩니다. 각 노트는 YAML 스타일 frontmatter를 포함하므로 Obsidian에서 바로 열 수 있고, LLM Wiki 형태로 폴더별 검색과 요약이 가능합니다. 회의록과 Wiki 첨부 이미지는 `vault/Assets`에 저장됩니다.

## 주요 API

- `GET /api/dashboard`
- `GET /api/calendar`, `POST /api/calendar/events`
- `GET /api/tasks`, `POST /api/tasks`, `PATCH /api/tasks/{task_id}`
- `GET /api/todos`, `POST /api/todos`, `PATCH /api/todos/{todo_id}`, `POST /api/todos/weekly-report`
- `GET /api/projects`, `POST /api/projects`, `PATCH /api/projects/{project_id}`
- `GET /api/meetings`, `POST /api/meetings`
- `GET /api/wiki`, `POST /api/wiki`

API 문서는 서버 실행 후 `{server.host}:{server.port}/docs`에서 확인할 수 있습니다. 기본 설정에서는 `http://127.0.0.1:8010/docs`입니다.
