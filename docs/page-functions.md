# 페이지별 기능 분해

## 1. 오늘 상태 대시보드

- 오늘 날짜 기준 TODO 완료율 표시
- 오늘 일정 수 표시
- 현재 진행 중인 작업바 수 표시
- 진행 중인 프로젝트 수 표시
- 미완료 TODO를 오늘 날짜로 자동 이월한 뒤 목록 표시

담당 API: `app/routers/dashboard.py`

## 2. 달력

- 월 단위 달력 표시
- 날짜 클릭 시 선택 날짜 변경
- 연차, 반차, 미팅, 회사 일정, 기타 일정 등록
- 참석자와 메모를 Obsidian 노트 본문으로 저장

담당 API: `app/routers/calendar.py`

## 3. 작업 타임라인

- JIRA 이슈처럼 작업명, 담당자, 상태, 우선순위 등록
- start date와 end date를 기반으로 가로 작업바 표시
- 프로젝트와 작업을 연결할 수 있는 project_id 필드 제공

담당 API: `app/routers/tasks.py`

## 4. TODO 및 주간 보고서

- 날짜별 TODO 등록
- 체크하지 못한 과거 TODO를 오늘 날짜로 자동 이월
- 이월된 TODO는 source_id로 원본과 연결
- 주간 TODO와 작업 타임라인을 모아 Markdown 보고서 생성
- 보고서는 `vault/Reports`에 저장되어 Obsidian에서 문서로 열람 가능

담당 API: `app/routers/todos.py`

## 5. 프로젝트 기록

- 프로젝트명, 담당자, 상태, 기간, 요약, 목표, 링크 저장
- 프로젝트 노트는 LLM이 프로젝트 맥락을 읽을 수 있도록 goals와 links를 frontmatter에도 보관

담당 API: `app/routers/projects.py`
