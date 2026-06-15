const view = document.querySelector("#view");
const pageTitle = document.querySelector("#page-title");
const todayLabel = document.querySelector("#today-label");

const titles = {
  dashboard: "대시보드",
  calendar: "달력",
  tasks: "작업 타임라인",
  todos: "TODO",
  projects: "프로젝트",
  meetings: "회의록",
  wiki: "Wiki",
};

let calendarMonth = startOfMonth(new Date());
let selectedCalendarDate = toDateInputValue(new Date());
let calendarDialogDate = null;
let calendarDetailEventId = null;
let calendarEditEventId = null;
let calendarPendingDeleteId = null;
let todoEditingId = null;
let todoPendingDeleteId = null;
let selectedProjectId = null;
let projectCreateDialogOpen = false;
let projectDetailTab = "meetings";
let selectedProjectResourceId = null;
let projectResourceMode = "view";
let activeRichEditor = null;

todayLabel.textContent = toDateInputValue(new Date());

document.querySelectorAll(".nav a").forEach((link) => {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    const route = link.dataset.route;
    history.pushState({}, "", `/${route}`);
    renderRoute(route);
  });
});

window.addEventListener("popstate", () => renderRoute(currentRoute()));
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && calendarDialogDate && currentRoute() === "calendar") {
    if (calendarPendingDeleteId) {
      calendarPendingDeleteId = null;
      renderCalendar();
      return;
    }
    calendarDialogDate = null;
    calendarDetailEventId = null;
    calendarEditEventId = null;
    calendarPendingDeleteId = null;
    renderCalendar();
  }
  if (event.key === "Escape" && currentRoute() === "todos" && (todoEditingId || todoPendingDeleteId)) {
    todoEditingId = null;
    todoPendingDeleteId = null;
    renderTodos();
  }
  if (event.key === "Escape" && currentRoute() === "projects") {
    if (projectCreateDialogOpen) {
      projectCreateDialogOpen = false;
      renderProjects();
      return;
    }
    closeProjectDetailDialog();
  }
});
renderRoute(currentRoute());

function currentRoute() {
  const route = location.pathname.replace("/", "") || "dashboard";
  return titles[route] ? route : "dashboard";
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || response.statusText);
  }
  return response.json();
}

function renderRoute(route) {
  if (route !== "calendar") {
    calendarDialogDate = null;
    calendarDetailEventId = null;
    calendarEditEventId = null;
    calendarPendingDeleteId = null;
  }
  if (route !== "todos") {
    todoEditingId = null;
    todoPendingDeleteId = null;
  }
  if (route !== "projects") {
    selectedProjectId = null;
    projectCreateDialogOpen = false;
    projectDetailTab = "meetings";
    selectedProjectResourceId = null;
    projectResourceMode = "view";
  }
  document.querySelectorAll(".nav a").forEach((link) => {
    link.classList.toggle("active", link.dataset.route === route);
  });
  document.body.dataset.route = route;
  pageTitle.textContent = titles[route];

  const renderers = {
    dashboard: renderDashboard,
    calendar: renderCalendar,
    tasks: renderTasks,
    todos: renderTodos,
    projects: renderProjects,
    meetings: renderMeetings,
    wiki: renderWiki,
  };
  renderers[route]().catch((error) => {
    view.innerHTML = `<div class="panel"><p class="empty">${escapeHtml(error.message)}</p></div>`;
  });
}

async function renderDashboard() {
  const today = toDateInputValue(new Date());
  const data = await api(`/api/dashboard?date=${today}`);
  const counts = data.counts;
  view.innerHTML = `
    <section class="stats">
      ${stat("오늘 TODO", `${counts.todos_done}/${counts.todos_total}`)}
      ${stat("오늘 일정", counts.events_today)}
      ${stat("오늘 부재", `${counts.absence_people || 0}명`)}
      ${stat("진행 작업", counts.active_tasks)}
      ${stat("진행 프로젝트", counts.active_projects)}
    </section>
    <section class="grid two">
      <div class="panel">
        <div class="section-head">
          <h2>오늘 휴가/부재 현황</h2>
          <span class="badge">${counts.absence_events || 0}건</span>
        </div>
        ${absenceOverview(data.absences || [])}
      </div>
      <div class="panel">
        <h2>오늘 일정</h2>
        ${rows(data.events, eventSummary)}
      </div>
    </section>
    <section class="grid two">
      <div class="panel">
        <h2>오늘 할 일</h2>
        ${rows(data.todos, todoSummary)}
      </div>
      <div class="panel">
        <h2>현재 작업</h2>
        ${rows(data.active_tasks, taskSummary)}
      </div>
    </section>
    <section class="panel">
      <h2>진행 프로젝트</h2>
      ${rows(data.projects, projectSummary)}
    </section>
  `;
}

async function renderCalendar() {
  const monthKey = `${calendarMonth.getFullYear()}-${pad(calendarMonth.getMonth() + 1)}`;
  const { items } = await api(`/api/calendar?month=${monthKey}`);
  const calendarLayout = getCalendarLayout(calendarMonth);
  const multiDayLayout = getMultiDayLayout(items, calendarLayout);
  const eventsByDate = calendarEventsByDate(items, calendarLayout);
  view.innerHTML = `
    <section class="panel calendar-panel">
      <div class="calendar-head">
        <button class="secondary" id="prev-month" type="button" aria-label="이전 달">이전</button>
        <div class="calendar-title">
          <h2>${formatMonthLabel(calendarMonth)}</h2>
          <span>${monthKey}</span>
        </div>
        <button class="secondary" id="next-month" type="button" aria-label="다음 달">다음</button>
      </div>
      <div class="calendar-weekdays" aria-hidden="true">
        ${["월", "화", "수", "목", "금", "토", "일"].map((day) => `<div class="day-name">${day}</div>`).join("")}
      </div>
      <div class="calendar-grid" style="${calendarGridStyle(multiDayLayout)}">
        ${calendarCells(calendarMonth, eventsByDate, calendarLayout, multiDayLayout)}
      </div>
    </section>
    ${calendarDialogDate ? calendarEventDialog(calendarDialogDate, eventsByDate[calendarDialogDate] || []) : ""}
  `;
  document.querySelector("#prev-month").addEventListener("click", () => {
    calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1);
    selectedCalendarDate = toDateInputValue(calendarMonth);
    calendarDialogDate = null;
    calendarDetailEventId = null;
    calendarEditEventId = null;
    calendarPendingDeleteId = null;
    renderCalendar();
  });
  document.querySelector("#next-month").addEventListener("click", () => {
    calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1);
    selectedCalendarDate = toDateInputValue(calendarMonth);
    calendarDialogDate = null;
    calendarDetailEventId = null;
    calendarEditEventId = null;
    calendarPendingDeleteId = null;
    renderCalendar();
  });
  document.querySelectorAll(".day").forEach((day) => {
    day.addEventListener("click", () => {
      selectedCalendarDate = day.dataset.date;
      calendarDialogDate = selectedCalendarDate;
      calendarDetailEventId = null;
      calendarEditEventId = null;
      calendarPendingDeleteId = null;
      calendarMonth = startOfMonth(new Date(`${selectedCalendarDate}T00:00:00`));
      renderCalendar();
    });
  });
  document.querySelectorAll("[data-close-calendar-dialog]").forEach((control) => {
    control.addEventListener("click", () => {
      calendarDialogDate = null;
      calendarDetailEventId = null;
      calendarEditEventId = null;
      calendarPendingDeleteId = null;
      renderCalendar();
    });
  });
  document.querySelectorAll("[data-calendar-event-id]").forEach((control) => {
    control.addEventListener("click", () => {
      calendarDetailEventId = control.dataset.calendarEventId;
      calendarEditEventId = null;
      calendarPendingDeleteId = null;
      renderCalendar();
    });
  });
  document.querySelector("[data-calendar-list-back]")?.addEventListener("click", () => {
    calendarDetailEventId = null;
    calendarEditEventId = null;
    calendarPendingDeleteId = null;
    renderCalendar();
  });
  document.querySelector("[data-calendar-edit]")?.addEventListener("click", () => {
    calendarEditEventId = calendarDetailEventId;
    calendarPendingDeleteId = null;
    renderCalendar();
  });
  document.querySelector("[data-calendar-edit-cancel]")?.addEventListener("click", () => {
    calendarEditEventId = null;
    renderCalendar();
  });
  document.querySelector("[data-calendar-delete]")?.addEventListener("click", () => {
    calendarPendingDeleteId = calendarDetailEventId;
    renderCalendar();
  });
  document.querySelector("[data-calendar-delete-cancel]")?.addEventListener("click", () => {
    calendarPendingDeleteId = null;
    renderCalendar();
  });
  document.querySelector(".confirm-dialog")?.addEventListener("click", (event) => {
    event.stopPropagation();
  });
  document.querySelector("[data-calendar-delete-confirm]")?.addEventListener("click", async () => {
    if (!calendarPendingDeleteId) {
      return;
    }
    await api(`/api/calendar/events/${encodeURIComponent(calendarPendingDeleteId)}`, { method: "DELETE" });
    calendarDetailEventId = null;
    calendarEditEventId = null;
    calendarPendingDeleteId = null;
    renderCalendar();
  });
  document.querySelector(".modal-dialog")?.addEventListener("click", (event) => {
    event.stopPropagation();
  });
  document.querySelector("#event-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const eventId = form.get("event_id");
    const isEdit = Boolean(eventId);
    await api(isEdit ? `/api/calendar/events/${encodeURIComponent(eventId)}` : "/api/calendar/events", {
      method: isEdit ? "PATCH" : "POST",
      body: JSON.stringify({
        title: form.get("title"),
        date: form.get("start_date"),
        start_date: form.get("start_date"),
        end_date: form.get("end_date"),
        category: String(form.get("category") || "").trim(),
        start_time: emptyToNull(form.get("start_time")),
        end_time: emptyToNull(form.get("end_time")),
        attendees: splitList(form.get("attendees")),
        notes: form.get("notes") || "",
      }),
    });
    selectedCalendarDate = form.get("start_date");
    calendarDialogDate = selectedCalendarDate;
    calendarDetailEventId = null;
    calendarEditEventId = null;
    calendarPendingDeleteId = null;
    calendarMonth = startOfMonth(new Date(`${selectedCalendarDate}T00:00:00`));
    renderCalendar();
  });
  document.querySelector("#event-form input[name='start_date']")?.addEventListener("change", (event) => {
    const endDate = document.querySelector("#event-form input[name='end_date']");
    if (endDate && endDate.value < event.currentTarget.value) {
      endDate.value = event.currentTarget.value;
    }
  });
  if (!calendarDetailEventId || calendarEditEventId) {
    document.querySelector("#event-form input[name='title']")?.focus();
  }
}

async function renderTasks() {
  const [{ items: tasks }, { items: projects }] = await Promise.all([api("/api/tasks"), api("/api/projects")]);
  view.innerHTML = `
    <section class="grid two">
      <div class="panel">
        <h2>작업바</h2>
        ${timeline(tasks)}
      </div>
      <div class="panel">
        <h2>작업 등록</h2>
        <form class="form" id="task-form">
          <label class="full">작업명<input name="title" required maxlength="140" placeholder="JIRA 이슈처럼 등록" /></label>
          <label>시작일<input name="start_date" type="date" required value="${toDateInputValue(new Date())}" /></label>
          <label>종료일<input name="end_date" type="date" required value="${toDateInputValue(new Date())}" /></label>
          <label>프로젝트<select name="project_id"><option value="">미지정</option>${projectOptions(projects)}</select></label>
          <label>담당자<input name="owner" placeholder="담당자명" /></label>
          <label>상태
            <select name="status">
              <option value="todo">대기</option>
              <option value="in_progress">진행</option>
              <option value="review">리뷰</option>
              <option value="blocked">막힘</option>
              <option value="done">완료</option>
            </select>
          </label>
          <label>우선순위
            <select name="priority">
              <option value="normal">보통</option>
              <option value="high">높음</option>
              <option value="urgent">긴급</option>
              <option value="low">낮음</option>
            </select>
          </label>
          <label class="full">설명<textarea name="description"></textarea></label>
          <button class="full" type="submit">작업 저장</button>
        </form>
      </div>
    </section>
  `;
  document.querySelector("#task-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await api("/api/tasks", {
      method: "POST",
      body: JSON.stringify(Object.fromEntries(form.entries())),
    });
    renderTasks();
  });
}

async function renderTodos() {
  const selected = document.querySelector("#todo-date")?.value || toDateInputValue(new Date());
  const { items: todos } = await api(`/api/todos?date=${selected}`);
  const pendingDeleteTodo = todos.find((item) => item.id === todoPendingDeleteId);
  view.innerHTML = `
    <section class="panel">
      <div class="calendar-head">
        <div>
          <h2>오늘 할 일</h2>
        </div>
        <div class="todo-controls">
          <input id="todo-date" type="date" value="${selected}" />
        </div>
      </div>
      <div class="list todo-list" data-todo-list>
        ${todos.length ? todos.map((item, index) => todoLine(item, index)).join("") : `<p class="empty">등록된 TODO가 없습니다.</p>`}
      </div>
      ${todoQuickForm()}
    </section>
    <section class="panel">
      <div class="calendar-head">
        <h2>주간 보고서</h2>
        <button id="report-button" type="button">이번 주 보고서 생성</button>
      </div>
      <div id="report-output" class="empty">생성된 보고서는 vault/Reports 폴더에 Markdown 문서로 저장됩니다.</div>
    </section>
    ${pendingDeleteTodo ? todoDeleteConfirmDialog(pendingDeleteTodo) : ""}
  `;
  document.querySelector("#todo-date").addEventListener("change", () => {
    todoEditingId = null;
    todoPendingDeleteId = null;
    renderTodos();
  });
  document.querySelectorAll("[data-todo-check]").forEach((checkbox) => {
    checkbox.addEventListener("change", async () => {
      await api(`/api/todos/${checkbox.dataset.todoCheck}`, {
        method: "PATCH",
        body: JSON.stringify({ completed: checkbox.checked }),
      });
      renderTodos();
    });
  });
  document.querySelectorAll("[data-todo-edit]").forEach((button) => {
    button.addEventListener("click", () => {
      todoEditingId = button.dataset.todoEdit;
      todoPendingDeleteId = null;
      renderTodos();
    });
  });
  document.querySelector("[data-todo-edit-cancel]")?.addEventListener("click", () => {
    todoEditingId = null;
    renderTodos();
  });
  document.querySelector("#todo-edit-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const todoId = form.get("todo_id");
    const title = String(form.get("title") || "").trim();
    if (!todoId || !title) {
      return;
    }
    await api(`/api/todos/${encodeURIComponent(todoId)}`, {
      method: "PATCH",
      body: JSON.stringify({
        title,
        note: String(form.get("note") || "").trim(),
      }),
    });
    todoEditingId = null;
    renderTodos();
  });
  document.querySelector("#todo-edit-form textarea[name='note']")?.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  });
  if (todoEditingId) {
    document.querySelector("#todo-edit-form input[name='title']")?.focus();
  }
  document.querySelectorAll("[data-todo-delete]").forEach((button) => {
    button.addEventListener("click", () => {
      todoPendingDeleteId = button.dataset.todoDelete;
      todoEditingId = null;
      renderTodos();
    });
  });
  document.querySelectorAll("[data-todo-delete-cancel]").forEach((control) => {
    control.addEventListener("click", () => {
      todoPendingDeleteId = null;
      renderTodos();
    });
  });
  document.querySelector(".todo-delete-dialog")?.addEventListener("click", (event) => {
    event.stopPropagation();
  });
  document.querySelector("[data-todo-delete-confirm]")?.addEventListener("click", async () => {
    if (!todoPendingDeleteId) {
      return;
    }
    await api(`/api/todos/${encodeURIComponent(todoPendingDeleteId)}`, { method: "DELETE" });
    todoPendingDeleteId = null;
    renderTodos();
  });
  document.querySelector("#todo-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const title = String(form.get("title") || "").trim();
    const note = String(form.get("note") || "").trim();
    if (!title) {
      return;
    }
    await api("/api/todos", {
      method: "POST",
      body: JSON.stringify({
        title,
        date: selected,
        project_id: null,
        priority: "normal",
        note,
      }),
    });
    renderTodos();
  });
  document.querySelector("#todo-form textarea[name='note']")?.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  });
  setupTodoDrag();
  document.querySelector("#report-button").addEventListener("click", async () => {
    const weekStart = startOfWeek(new Date(`${selected}T00:00:00`));
    const report = await api(`/api/todos/weekly-report?week_start=${toDateInputValue(weekStart)}`, { method: "POST" });
    document.querySelector("#report-output").outerHTML = `<pre id="report-output" class="report">${escapeHtml(report.body)}</pre>`;
  });
}

function todoQuickForm() {
  return `
    <form class="todo-quick-form" id="todo-form" aria-label="TODO 빠른 등록">
      <span class="todo-plus" aria-hidden="true">+</span>
      <div class="todo-quick-fields">
        <input name="title" required maxlength="140" autocomplete="off" placeholder="새 TODO 제목" />
        <textarea name="note" placeholder="상세 내용"></textarea>
      </div>
      <button type="submit">추가</button>
    </form>
  `;
}

async function renderProjects() {
  const { items } = await api("/api/projects");
  const selectedProject = items.find((item) => item.id === selectedProjectId);
  if (selectedProjectId && !selectedProject) {
    selectedProjectId = null;
  }
  const projectDetailDialog = selectedProject ? await projectWorkspaceDialog(selectedProject) : "";

  view.innerHTML = `
    <section class="panel">
      <div class="section-head project-head">
        <h2>프로젝트</h2>
        <button class="add-button" type="button" data-project-add aria-label="프로젝트 추가">+</button>
      </div>
      ${projectCards(items)}
    </section>
    ${projectCreateDialogOpen ? projectCreateDialog() : ""}
    ${projectDetailDialog}
  `;

  document.querySelector("[data-project-add]")?.addEventListener("click", () => {
    projectCreateDialogOpen = true;
    selectedProjectId = null;
    renderProjects();
  });
  document.querySelectorAll("[data-project-open]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedProjectId = button.dataset.projectOpen;
      projectCreateDialogOpen = false;
      projectDetailTab = "meetings";
      selectedProjectResourceId = null;
      projectResourceMode = "view";
      renderProjects();
    });
  });
  setupProjectCreateDialog();
  setupProjectWorkspaceDialog(selectedProject);
}

async function projectWorkspaceDialog(project) {
  const projectId = encodeURIComponent(project.id);
  const [{ items: meetings }, { items: wikiPages }] = await Promise.all([api(`/api/meetings?project_id=${projectId}`), api(`/api/wiki?project_id=${projectId}`)]);
  const items = projectDetailTab === "wiki" ? wikiPages : meetings;
  if (projectResourceMode !== "new" && selectedProjectResourceId && !items.some((item) => item.id === selectedProjectResourceId)) {
    selectedProjectResourceId = null;
  }
  if (projectResourceMode !== "new" && !selectedProjectResourceId && items.length) {
    selectedProjectResourceId = items[0].id;
  }
  const selectedItem = items.find((item) => item.id === selectedProjectResourceId) || null;
  return `
    <div class="modal-backdrop" data-project-detail-close>
      <div class="modal-dialog project-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="project-detail-title">
        <div class="modal-head project-detail-head">
          <div>
            <p class="eyebrow">${escapeHtml(project.company_name || "회사명 미지정")}</p>
            <h2 id="project-detail-title">${escapeHtml(project.name)}</h2>
          </div>
          <div class="project-detail-actions">
            <span class="badge">${escapeHtml(projectStatusLabel(project.status))}</span>
            <button class="icon-button" type="button" data-project-detail-close aria-label="닫기">X</button>
          </div>
        </div>
        <div class="project-dialog-body">
          ${projectResourceTabs(meetings.length, wikiPages.length)}
          <section class="project-resource-layout">
            <aside class="project-resource-list">
              <div class="section-head">
                <h2>${projectDetailTab === "wiki" ? "Wiki" : "회의록"}</h2>
                <button class="add-button small-add-button" type="button" data-project-resource-new aria-label="새 글 작성">+</button>
              </div>
              ${projectResourceList(items)}
            </aside>
            <section class="project-resource-detail">
              ${projectResourceDetail(selectedItem)}
            </section>
          </section>
        </div>
      </div>
    </div>
  `;
}

function setupProjectWorkspaceDialog(project) {
  if (!project) {
    return;
  }
  document.querySelector(".project-detail-dialog")?.addEventListener("click", (event) => {
    event.stopPropagation();
  });
  document.querySelectorAll("[data-project-detail-close]").forEach((control) => {
    control.addEventListener("click", () => {
      selectedProjectId = null;
      selectedProjectResourceId = null;
      projectResourceMode = "view";
      renderProjects();
    });
  });
  document.querySelectorAll("[data-project-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      projectDetailTab = button.dataset.projectTab;
      selectedProjectResourceId = null;
      projectResourceMode = "view";
      renderProjects();
    });
  });
  document.querySelectorAll("[data-project-resource-new]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedProjectResourceId = null;
      projectResourceMode = "new";
      renderProjects();
    });
  });
  document.querySelectorAll("[data-project-resource-id]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedProjectResourceId = button.dataset.projectResourceId;
      projectResourceMode = "view";
      renderProjects();
    });
  });
  document.querySelector("[data-project-resource-edit]")?.addEventListener("click", () => {
    projectResourceMode = "edit";
    renderProjects();
  });
  document.querySelector("[data-project-resource-cancel]")?.addEventListener("click", () => {
    projectResourceMode = "view";
    renderProjects();
  });
  document.querySelector("[data-project-resource-delete]")?.addEventListener("click", async () => {
    if (!selectedProjectResourceId || !confirm("선택한 글을 삭제할까요?")) {
      return;
    }
    const path = projectDetailTab === "wiki" ? `/api/wiki/${encodeURIComponent(selectedProjectResourceId)}` : `/api/meetings/${encodeURIComponent(selectedProjectResourceId)}`;
    await api(path, { method: "DELETE" });
    selectedProjectResourceId = null;
    projectResourceMode = "view";
    renderProjects();
  });
  setupInlineImageEditors(document.querySelector(".project-detail-dialog"));
  document.querySelector("#project-resource-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formEl = event.currentTarget;
    syncRichTextEditors(formEl);
    const form = new FormData(formEl);
    const isEdit = projectResourceMode === "edit" && selectedProjectResourceId;
    const isWiki = projectDetailTab === "wiki";
    const bodyContent = String(form.get(isWiki ? "content" : "notes") || "");
    const images = imagesReferencedInContent(uniqueImages([...existingFormImages(form), ...uploadedInlineImages(formEl)]), bodyContent);
    const payload = isWiki
      ? {
          project_id: project.id,
          title: form.get("title"),
          category: form.get("category") || "General",
          tags: splitList(form.get("tags")),
          content: form.get("content") || "",
          images,
        }
      : {
          project_id: project.id,
          title: form.get("title"),
          date: form.get("date"),
          start_time: emptyToNull(form.get("start_time")),
          attendees: splitList(form.get("attendees")),
          agenda: "",
          notes: form.get("notes") || "",
          images,
        };
    const path = isWiki
      ? isEdit
        ? `/api/wiki/${encodeURIComponent(selectedProjectResourceId)}`
        : "/api/wiki"
      : isEdit
        ? `/api/meetings/${encodeURIComponent(selectedProjectResourceId)}`
        : "/api/meetings";
    const saved = await api(path, {
      method: isEdit ? "PATCH" : "POST",
      body: JSON.stringify(payload),
    });
    selectedProjectResourceId = saved.id;
    projectResourceMode = "view";
    renderProjects();
  });
}

function closeProjectDetailDialog() {
  if (selectedProjectId) {
    selectedProjectId = null;
    selectedProjectResourceId = null;
    projectResourceMode = "view";
    renderProjects();
  }
}

function projectResourceTabs(meetingCount, wikiCount) {
  return `
    <div class="project-page-tabs" role="tablist" aria-label="프로젝트 자료">
      <button class="project-page-tab ${projectDetailTab === "meetings" ? "active" : ""}" type="button" data-project-tab="meetings" role="tab" aria-selected="${projectDetailTab === "meetings"}">
        회의록 <span>${meetingCount}</span>
      </button>
      <button class="project-page-tab ${projectDetailTab === "wiki" ? "active" : ""}" type="button" data-project-tab="wiki" role="tab" aria-selected="${projectDetailTab === "wiki"}">
        Wiki <span>${wikiCount}</span>
      </button>
    </div>
  `;
}

function projectResourceList(items) {
  if (!items.length) {
    return `<p class="empty">등록된 글이 없습니다.</p>`;
  }
  return `
    <div class="resource-list">
      ${items.map(projectResourceListItem).join("")}
    </div>
  `;
}

function projectResourceListItem(item) {
  const isSelected = item.id === selectedProjectResourceId && projectResourceMode !== "new";
  const meta = projectDetailTab === "wiki" ? [item.category || "General", formatDateTime(item.updated_at)].filter(Boolean).join(" · ") : [item.date, item.start_time || "시간 미정"].filter(Boolean).join(" · ");
  return `
    <button class="resource-list-item ${isSelected ? "active" : ""}" type="button" data-project-resource-id="${escapeHtml(item.id)}">
      <strong>${escapeHtml(item.title)}</strong>
      <span>${escapeHtml(meta)}</span>
    </button>
  `;
}

function projectResourceDetail(item) {
  if (projectResourceMode === "new") {
    return projectDetailTab === "wiki" ? wikiResourceForm() : meetingResourceForm();
  }
  if (projectResourceMode === "edit" && item) {
    return projectDetailTab === "wiki" ? wikiResourceForm(item) : meetingResourceForm(item);
  }
  if (!item) {
    return `
      <div class="resource-empty">
        <p class="empty">선택된 글이 없습니다.</p>
        <button class="add-button small-add-button" type="button" data-project-resource-new aria-label="새 글 작성">+</button>
      </div>
    `;
  }
  return projectDetailTab === "wiki" ? wikiResourceView(item) : meetingResourceView(item);
}

function meetingResourceForm(item = null) {
  const title = item?.title || "";
  const attendees = Array.isArray(item?.attendees) ? item.attendees.join(", ") : "";
  const images = resourceImages(item);
  const submitLabel = item ? "회의록 수정" : "회의록 저장";
  return `
    <form class="form resource-form" id="project-resource-form">
      <input name="existing_images" type="hidden" value="${escapeHtml(JSON.stringify(images))}" />
      <label class="full">회의명<input name="title" required maxlength="140" value="${escapeHtml(title)}" placeholder="예: 킥오프 회의" /></label>
      <label>일자<input name="date" type="date" required value="${escapeHtml(item?.date || toDateInputValue(new Date()))}" /></label>
      <label>시작 시간<input name="start_time" type="time" value="${escapeHtml(item?.start_time || "")}" /></label>
      <label class="full">참석자<input name="attendees" value="${escapeHtml(attendees)}" placeholder="쉼표 또는 줄바꿈으로 구분" /></label>
      ${richTextEditor("notes", "회의 내용", meetingContentWithImages(item))}
      <div class="resource-form-actions full">
        ${item ? `<button class="secondary" type="button" data-project-resource-cancel>취소</button>` : ""}
        <button type="submit">${submitLabel}</button>
      </div>
    </form>
  `;
}

function wikiResourceForm(item = null) {
  const tags = Array.isArray(item?.tags) ? item.tags.join(", ") : "";
  const images = resourceImages(item);
  const submitLabel = item ? "Wiki 수정" : "Wiki 저장";
  return `
    <form class="form resource-form" id="project-resource-form">
      <input name="existing_images" type="hidden" value="${escapeHtml(JSON.stringify(images))}" />
      <label class="full">문서 제목<input name="title" required maxlength="140" value="${escapeHtml(item?.title || "")}" placeholder="예: 고객사 운영 규칙" /></label>
      <label>카테고리<input name="category" required maxlength="60" value="${escapeHtml(item?.category || "General")}" /></label>
      <label>태그<input name="tags" value="${escapeHtml(tags)}" placeholder="쉼표 또는 줄바꿈으로 구분" /></label>
      ${richTextEditor("content", "본문", noteContentWithImages(item))}
      <div class="resource-form-actions full">
        ${item ? `<button class="secondary" type="button" data-project-resource-cancel>취소</button>` : ""}
        <button type="submit">${submitLabel}</button>
      </div>
    </form>
  `;
}

function meetingResourceView(item) {
  const attendees = Array.isArray(item.attendees) && item.attendees.length ? item.attendees.join(", ") : "없음";
  return `
    <article class="resource-reader">
      <div class="resource-reader-actions">
        <button class="secondary" type="button" data-project-resource-edit>수정</button>
        <button class="danger-button" type="button" data-project-resource-delete>삭제</button>
      </div>
      <p class="eyebrow">회의록</p>
      <h3>${escapeHtml(item.title)}</h3>
      <dl class="resource-meta">
        <dt>일자</dt><dd>${escapeHtml(item.date || "-")}</dd>
        <dt>시간</dt><dd>${escapeHtml(item.start_time || "시간 미정")}</dd>
        <dt>참석자</dt><dd>${escapeHtml(attendees)}</dd>
      </dl>
      ${resourceBlock("회의 내용", meetingContentWithImages(item))}
    </article>
  `;
}

function wikiResourceView(item) {
  const tags = Array.isArray(item.tags) && item.tags.length ? item.tags.join(", ") : "없음";
  return `
    <article class="resource-reader">
      <div class="resource-reader-actions">
        <button class="secondary" type="button" data-project-resource-edit>수정</button>
        <button class="danger-button" type="button" data-project-resource-delete>삭제</button>
      </div>
      <p class="eyebrow">Wiki</p>
      <h3>${escapeHtml(item.title)}</h3>
      <dl class="resource-meta">
        <dt>카테고리</dt><dd>${escapeHtml(item.category || "General")}</dd>
        <dt>태그</dt><dd>${escapeHtml(tags)}</dd>
        <dt>수정</dt><dd>${escapeHtml(formatDateTime(item.updated_at))}</dd>
      </dl>
      ${resourceBlock("본문", noteContentWithImages(item))}
    </article>
  `;
}

function resourceBlock(title, content) {
  const text = String(content || "").trim();
  return `
    <section class="resource-block">
      <h4>${escapeHtml(title)}</h4>
      ${text ? renderRichText(text) : `<p class="muted-inline">작성된 내용이 없습니다.</p>`}
    </section>
  `;
}

function meetingSection(item, heading) {
  if (!item?.body) {
    return "";
  }
  const content = splitEventBody(item.body).content;
  const match = content.match(new RegExp(`(?:^|\\n)## ${escapeRegExp(heading)}\\s*([\\s\\S]*?)(?=\\n## |$)`));
  return match ? match[1].trim().replace(/^- /gm, "") : "";
}

function notePlainContent(item) {
  if (!item?.body) {
    return "";
  }
  return splitEventBody(item.body)
    .content.replace(/^# .*(\r?\n)+/, "")
    .trim();
}

function meetingContentWithImages(item) {
  return contentWithLegacyImages(meetingSection(item, "회의 내용"), resourceImages(item));
}

function noteContentWithImages(item) {
  return contentWithLegacyImages(notePlainContent(item), resourceImages(item));
}

function contentWithLegacyImages(content, images) {
  const text = String(content || "").trim();
  const imageMarkdown = resourceImages({ images })
    .filter((image) => !text.includes(image.url))
    .map((image) => markdownImage(image))
    .join("\n");
  return [text, imageMarkdown].filter(Boolean).join("\n\n");
}

function listText(value) {
  return Array.isArray(value) ? value.join("\n") : String(value || "");
}

function resourceImages(item) {
  return Array.isArray(item?.images) ? item.images.filter((image) => image && image.url) : [];
}

function richTextEditor(name, label, value = "") {
  const fieldId = `rich-${name}`;
  return `
    <div class="text-editor full" data-inline-editor="${escapeHtml(name)}">
      <div class="text-editor-head">
        <label for="${escapeHtml(fieldId)}">${escapeHtml(label)}</label>
        <button class="secondary inline-image-button" type="button" data-inline-image-button="${escapeHtml(name)}">이미지 삽입</button>
      </div>
      <div id="${escapeHtml(fieldId)}" class="rich-editor-surface" contenteditable="true" role="textbox" aria-multiline="true" data-rich-editor="${escapeHtml(name)}">${richEditorHtml(value)}</div>
      <textarea name="${escapeHtml(name)}" class="rich-editor-source" data-rich-source hidden>${escapeHtml(value)}</textarea>
      <input class="inline-image-input" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple data-inline-image-input="${escapeHtml(name)}" />
    </div>
  `;
}

function setupInlineImageEditors(root = document) {
  if (!root) {
    return;
  }
  root.querySelectorAll("[data-rich-editor]").forEach((surface) => {
    surface.addEventListener("focus", () => {
      activeRichEditor = surface;
    });
    surface.addEventListener("click", () => {
      activeRichEditor = surface;
    });
    surface.addEventListener("keyup", () => {
      activeRichEditor = surface;
    });
    surface.addEventListener("input", () => {
      syncRichTextEditor(surface);
    });
  });
  root.addEventListener("click", (event) => {
    const resizeButton = event.target.closest("[data-image-resize]");
    if (resizeButton && root.contains(resizeButton)) {
      const figure = resizeButton.closest(".editor-rich-image");
      resizeEditorImage(figure, Number(resizeButton.dataset.imageResize || 0));
      return;
    }
    const removeButton = event.target.closest("[data-image-remove]");
    if (removeButton && root.contains(removeButton)) {
      const figure = removeButton.closest(".editor-rich-image");
      const surface = figure?.closest("[data-rich-editor]");
      figure?.remove();
      ensureEditorParagraph(surface);
      syncRichTextEditor(surface);
    }
  });
  root.querySelectorAll("[data-inline-image-button]").forEach((button) => {
    button.addEventListener("click", () => {
      const editor = button.closest("[data-inline-editor]");
      const surface = editor?.querySelector("[data-rich-editor]");
      if (surface) {
        activeRichEditor = surface;
        surface.focus();
      }
      editor?.querySelector("[data-inline-image-input]")?.click();
    });
  });
  root.querySelectorAll("[data-inline-image-input]").forEach((input) => {
    input.addEventListener("change", async () => {
      const editor = input.closest("[data-inline-editor]");
      const surface = editor?.querySelector("[data-rich-editor]");
      const button = editor?.querySelector("[data-inline-image-button]");
      const files = [...(input.files || [])];
      if (!surface || !files.length) {
        return;
      }
      const buttonText = button?.textContent || "";
      if (button) {
        button.disabled = true;
        button.textContent = "업로드 중";
      }
      try {
        const images = await Promise.all(files.map(uploadImageFile));
        appendUploadedInlineImages(input.form, images);
        insertImagesIntoEditor(surface, images);
      } catch (error) {
        alert(error.message || "이미지를 업로드하지 못했습니다.");
      } finally {
        input.value = "";
        if (button) {
          button.disabled = false;
          button.textContent = buttonText || "이미지 삽입";
        }
      }
    });
  });
}

function richEditorHtml(value) {
  const html = renderRichEditorContent(value);
  return html || "<p><br></p>";
}

function renderRichEditorContent(content) {
  const text = String(content || "").trim();
  if (!text) {
    return "";
  }
  const imagePattern = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
  let html = "";
  let lastIndex = 0;
  let match;
  while ((match = imagePattern.exec(text))) {
    html += renderEditorTextBlocks(text.slice(lastIndex, match.index));
    html += renderEditorImage(match[2], match[1]);
    lastIndex = imagePattern.lastIndex;
  }
  html += renderEditorTextBlocks(text.slice(lastIndex));
  return html;
}

function renderEditorTextBlocks(text) {
  return String(text || "")
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function renderEditorImage(url, altSpec = "") {
  const safeUrl = safeImageUrl(url);
  if (!safeUrl) {
    return renderEditorTextBlocks(`![${altSpec}](${url})`);
  }
  const { alt, width } = parseMarkdownImageAlt(altSpec);
  return editorImageHtml({ name: alt, url: safeUrl, width });
}

function editorImageHtml(image) {
  const safeUrl = safeImageUrl(image?.url);
  if (!safeUrl) {
    return "";
  }
  const width = clampImageWidth(image?.width);
  const alt = markdownImageAlt(image?.name || image?.alt || "본문 이미지");
  return `
    <figure class="editor-rich-image" contenteditable="false" data-url="${escapeHtml(safeUrl)}" data-alt="${escapeHtml(alt)}" data-width="${width}">
      <img src="${escapeHtml(safeUrl)}" alt="${escapeHtml(alt)}" style="width: ${width}%;" loading="lazy" />
      <figcaption>${escapeHtml(alt)}</figcaption>
      <div class="editor-image-controls">
        <button class="secondary" type="button" data-image-resize="-10">축소</button>
        <span>${width}%</span>
        <button class="secondary" type="button" data-image-resize="10">확대</button>
        <button class="danger-button" type="button" data-image-remove>삭제</button>
      </div>
    </figure>
  `;
}

function insertImagesIntoEditor(surface, images) {
  if (!surface) {
    return;
  }
  const target = activeRichEditor === surface ? currentEditorBlock(surface) : null;
  let anchor = target || surface.lastElementChild;
  if (anchor?.matches?.(".editor-rich-image")) {
    anchor = anchor.nextElementSibling || anchor;
  }
  images.forEach((image) => {
    const node = htmlToElement(editorImageHtml(image));
    if (!node) {
      return;
    }
    if (anchor && anchor.parentElement === surface) {
      anchor.after(node);
    } else {
      surface.append(node);
    }
    anchor = node;
  });
  const paragraph = document.createElement("p");
  paragraph.append(document.createElement("br"));
  if (anchor && anchor.parentElement === surface) {
    anchor.after(paragraph);
  } else {
    surface.append(paragraph);
  }
  placeCaretIn(paragraph);
  syncRichTextEditor(surface);
}

function htmlToElement(html) {
  const template = document.createElement("template");
  template.innerHTML = html.trim();
  return template.content.firstElementChild;
}

function currentEditorBlock(surface) {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !surface.contains(selection.anchorNode)) {
    return null;
  }
  let node = selection.anchorNode;
  if (node.nodeType === Node.TEXT_NODE) {
    node = node.parentElement;
  }
  while (node && node.parentElement !== surface) {
    node = node.parentElement;
  }
  return node || null;
}

function placeCaretIn(element) {
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

function resizeEditorImage(figure, delta) {
  if (!figure) {
    return;
  }
  const nextWidth = clampImageWidth(Number(figure.dataset.width || 100) + delta);
  figure.dataset.width = String(nextWidth);
  figure.querySelector("img")?.style.setProperty("width", `${nextWidth}%`);
  const label = figure.querySelector(".editor-image-controls span");
  if (label) {
    label.textContent = `${nextWidth}%`;
  }
  syncRichTextEditor(figure.closest("[data-rich-editor]"));
}

function ensureEditorParagraph(surface) {
  if (surface && !surface.textContent.trim() && !surface.querySelector(".editor-rich-image")) {
    surface.innerHTML = "<p><br></p>";
  }
}

function syncRichTextEditors(root = document) {
  root.querySelectorAll("[data-rich-editor]").forEach(syncRichTextEditor);
}

function syncRichTextEditor(surface) {
  if (!surface) {
    return;
  }
  const wrapper = surface.closest("[data-inline-editor]");
  const source = wrapper?.querySelector("[data-rich-source]");
  if (source) {
    source.value = richEditorToMarkdown(surface);
  }
}

function richEditorToMarkdown(surface) {
  const blocks = [];
  surface.childNodes.forEach((node) => collectEditorMarkdown(node, blocks));
  return blocks.join("\n\n").trim();
}

function collectEditorMarkdown(node, blocks) {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = normalizeEditorText(node.textContent).trim();
    if (text) {
      blocks.push(text);
    }
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return;
  }
  if (node.matches(".editor-rich-image")) {
    blocks.push(markdownImage({ name: node.dataset.alt, url: node.dataset.url, width: Number(node.dataset.width || 100) }));
    return;
  }
  if (node.matches(".editor-image-controls")) {
    return;
  }
  if (node.matches("p, div")) {
    const nestedImages = [...node.children].filter((child) => child.matches?.(".editor-rich-image"));
    if (nestedImages.length) {
      node.childNodes.forEach((child) => collectEditorMarkdown(child, blocks));
      return;
    }
    const text = editorElementText(node).trim();
    if (text) {
      blocks.push(text);
    }
    return;
  }
  node.childNodes.forEach((child) => collectEditorMarkdown(child, blocks));
}

function editorElementText(element) {
  let text = "";
  element.childNodes.forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE || node.matches(".editor-image-controls, .editor-rich-image")) {
      return;
    }
    if (node.tagName === "BR") {
      text += "\n";
      return;
    }
    text += editorElementText(node);
  });
  return normalizeEditorText(text);
}

function normalizeEditorText(text) {
  return String(text || "").replace(/\u00a0/g, " ");
}

function appendUploadedInlineImages(form, images) {
  if (!form) {
    return;
  }
  const current = uploadedInlineImages(form);
  form.dataset.inlineImages = JSON.stringify(uniqueImages([...current, ...images]));
}

function uploadedInlineImages(form) {
  try {
    const parsed = JSON.parse(form?.dataset.inlineImages || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function imagesReferencedInContent(images, content) {
  const urls = new Set([...String(content || "").matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].map((match) => match[1]));
  return uniqueImages(images).filter((image) => urls.has(image.url));
}

function uniqueImages(images) {
  const seen = new Set();
  return images.filter((image) => {
    if (!image?.url || seen.has(image.url)) {
      return false;
    }
    seen.add(image.url);
    return true;
  });
}

function markdownImageAlt(value) {
  return String(value || "이미지").replace(/[\[\]\r\n]/g, " ").trim() || "이미지";
}

function markdownImage(image) {
  const url = image?.url || "";
  const alt = markdownImageAlt(image?.name || image?.alt || "이미지");
  const width = clampImageWidth(image?.width);
  const altSpec = width === 100 ? alt : `${alt}|${width}`;
  return `![${altSpec}](${url})`;
}

function renderRichText(content) {
  const text = String(content || "").trim();
  if (!text) {
    return "";
  }
  const imagePattern = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
  let html = "";
  let lastIndex = 0;
  let match;
  while ((match = imagePattern.exec(text))) {
    html += renderTextBlocks(text.slice(lastIndex, match.index));
    html += renderInlineImage(match[2], match[1]);
    lastIndex = imagePattern.lastIndex;
  }
  html += renderTextBlocks(text.slice(lastIndex));
  return `<div class="rich-content">${html}</div>`;
}

function renderTextBlocks(text) {
  return String(text || "")
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function renderInlineImage(url, altSpec = "") {
  const safeUrl = safeImageUrl(url);
  if (!safeUrl) {
    return renderTextBlocks(`![${altSpec}](${url})`);
  }
  const { alt, width } = parseMarkdownImageAlt(altSpec);
  const caption = String(alt || "").trim();
  return `
    <figure class="inline-rich-image" style="width: ${width}%;">
      <a href="${escapeHtml(safeUrl)}" target="_blank" rel="noreferrer">
        <img src="${escapeHtml(safeUrl)}" alt="${escapeHtml(caption || "본문 이미지")}" loading="lazy" />
      </a>
      ${caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : ""}
    </figure>
  `;
}

function parseMarkdownImageAlt(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/^(.*)\|(\d{1,3})$/);
  if (!match) {
    return { alt: raw, width: 100 };
  }
  return {
    alt: markdownImageAlt(match[1] || "이미지"),
    width: clampImageWidth(Number(match[2])),
  };
}

function clampImageWidth(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return 100;
  }
  return Math.max(20, Math.min(100, Math.round(number / 10) * 10));
}

function safeImageUrl(url) {
  const value = String(url || "").trim();
  if (/^\/api\/assets\//.test(value) || /^https?:\/\//i.test(value)) {
    return value;
  }
  return "";
}

function existingFormImages(form) {
  try {
    const parsed = JSON.parse(String(form.get("existing_images") || "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function uploadImageFile(file) {
  if (!file.type.startsWith("image/")) {
    throw new Error("이미지 파일만 첨부할 수 있습니다.");
  }
  const dataUrl = await fileToDataUrl(file);
  return api("/api/assets", {
    method: "POST",
    body: JSON.stringify({
      filename: file.name,
      content_type: file.type,
      data_url: dataUrl,
    }),
  });
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("이미지를 읽지 못했습니다."));
    });
    reader.addEventListener("error", () => reject(reader.error || new Error("이미지를 읽지 못했습니다.")));
    reader.readAsDataURL(file);
  });
}

function projectCards(items) {
  if (!items.length) {
    return `<p class="empty">등록된 프로젝트가 없습니다.</p>`;
  }
  return `
    <div class="project-card-grid">
      ${items.map(projectCard).join("")}
    </div>
  `;
}

function projectCard(item) {
  const company = item.company_name || "회사명 미지정";
  const status = projectStatusLabel(item.status);
  return `
    <button class="project-card" type="button" data-project-open="${escapeHtml(item.id)}">
      <span>${escapeHtml(company)}</span>
      <strong>${escapeHtml(item.name)}</strong>
      <small>${escapeHtml(status)}</small>
    </button>
  `;
}

function projectCreateDialog() {
  return `
    <div class="modal-backdrop" data-project-create-cancel>
      <div class="modal-dialog project-create-dialog" role="dialog" aria-modal="true" aria-labelledby="project-create-title">
        <div class="modal-head">
          <div>
            <p class="eyebrow">프로젝트 생성</p>
            <h2 id="project-create-title">새 프로젝트</h2>
          </div>
          <button class="icon-button" type="button" data-project-create-cancel aria-label="닫기">X</button>
        </div>
        <div class="project-dialog-body">
          <form class="form" id="project-create-form">
            <label class="full">회사명<input name="company_name" required maxlength="120" autocomplete="off" /></label>
            <label class="full">프로젝트명<input name="name" required maxlength="120" autocomplete="off" /></label>
            <button class="full" type="submit">프로젝트 저장</button>
          </form>
        </div>
      </div>
    </div>
  `;
}

function setupProjectCreateDialog() {
  if (!projectCreateDialogOpen) {
    return;
  }
  document.querySelector(".project-create-dialog")?.addEventListener("click", (event) => {
    event.stopPropagation();
  });
  document.querySelectorAll("[data-project-create-cancel]").forEach((control) => {
    control.addEventListener("click", () => {
      projectCreateDialogOpen = false;
      renderProjects();
    });
  });
  document.querySelector("#project-create-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const created = await api("/api/projects", {
      method: "POST",
      body: JSON.stringify({
        company_name: form.get("company_name"),
        name: form.get("name"),
        status: "active",
        summary: "",
        goals: [],
        links: [],
      }),
    });
    selectedProjectId = created.id;
    projectCreateDialogOpen = false;
    projectDetailTab = "meetings";
    selectedProjectResourceId = null;
    projectResourceMode = "view";
    renderProjects();
  });
  document.querySelector("#project-create-form input[name='company_name']")?.focus();
}

async function renderMeetings() {
  const { items } = await api("/api/meetings");
  const today = toDateInputValue(new Date());
  view.innerHTML = `
    <section class="grid two">
      <div class="panel">
        <div class="section-head">
          <h2>최근 회의록</h2>
          <span class="badge">${items.length}건</span>
        </div>
        ${rows(items, meetingSummary)}
      </div>
      <div class="panel">
        <h2>회의록 작성</h2>
        <form class="form" id="meeting-form">
          <label class="full">회의명<input name="title" required maxlength="140" placeholder="예: 주간 운영 회의" /></label>
          <label>일자<input name="date" type="date" required value="${today}" /></label>
          <label>시작 시간<input name="start_time" type="time" /></label>
          <label class="full">참석자<input name="attendees" placeholder="쉼표 또는 줄바꿈으로 구분" /></label>
          <label class="full">안건<textarea name="agenda"></textarea></label>
          ${richTextEditor("notes", "회의 내용")}
          <button class="full" type="submit">회의록 저장</button>
        </form>
      </div>
    </section>
  `;
  setupInlineImageEditors(document.querySelector("#meeting-form"));
  document.querySelector("#meeting-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const formEl = event.currentTarget;
    syncRichTextEditors(formEl);
    const form = new FormData(formEl);
    const notes = form.get("notes") || "";
    const images = imagesReferencedInContent(uploadedInlineImages(formEl), notes);
    await api("/api/meetings", {
      method: "POST",
      body: JSON.stringify({
        title: form.get("title"),
        date: form.get("date"),
        start_time: emptyToNull(form.get("start_time")),
        attendees: splitList(form.get("attendees")),
        agenda: form.get("agenda") || "",
        notes,
        images,
      }),
    });
    renderMeetings();
  });
}

async function renderWiki() {
  const { items } = await api("/api/wiki");
  view.innerHTML = `
    <section class="grid two">
      <div class="panel">
        <div class="section-head">
          <h2>Wiki 문서</h2>
          <span class="badge">${items.length}건</span>
        </div>
        ${rows(items, wikiSummary)}
      </div>
      <div class="panel">
        <h2>Wiki 작성</h2>
        <form class="form" id="wiki-form">
          <label class="full">문서 제목<input name="title" required maxlength="140" placeholder="예: 배포 절차" /></label>
          <label>카테고리<input name="category" required maxlength="60" value="General" /></label>
          <label>태그<input name="tags" placeholder="쉼표 또는 줄바꿈으로 구분" /></label>
          ${richTextEditor("content", "본문")}
          <button class="full" type="submit">Wiki 저장</button>
        </form>
      </div>
    </section>
  `;
  setupInlineImageEditors(document.querySelector("#wiki-form"));
  document.querySelector("#wiki-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const formEl = event.currentTarget;
    syncRichTextEditors(formEl);
    const form = new FormData(formEl);
    const content = form.get("content") || "";
    const images = imagesReferencedInContent(uploadedInlineImages(formEl), content);
    await api("/api/wiki", {
      method: "POST",
      body: JSON.stringify({
        title: form.get("title"),
        category: form.get("category") || "General",
        tags: splitList(form.get("tags")),
        content,
        images,
      }),
    });
    renderWiki();
  });
}

function stat(label, value) {
  return `<div class="stat"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong></div>`;
}

function rows(items, summary) {
  if (!items.length) {
    return `<p class="empty">표시할 항목이 없습니다.</p>`;
  }
  return `<div class="list">${items.map((item) => `<div class="row">${summary(item)}</div>`).join("")}</div>`;
}

function absenceOverview(items) {
  if (!items.length) {
    return `<p class="empty">오늘 등록된 휴가/부재 일정이 없습니다.</p>`;
  }
  return `
    <div class="absence-list">
      ${items.map(absenceRow).join("")}
    </div>
  `;
}

function absenceRow(item) {
  const type = categoryLabel(item.category || "");
  const meta = [type, item.time, item.date_range].filter(Boolean).join(" · ");
  return `
    <div class="absence-row">
      <div class="absence-person">${escapeHtml(item.person || "대상 미지정")}</div>
      <div class="row-main">
        <strong>${escapeHtml(item.title || type || "휴가/부재")}</strong>
        <span>${escapeHtml(meta)}</span>
      </div>
      <span class="badge">${escapeHtml(type || "부재")}</span>
    </div>
  `;
}

function todoSummary(item) {
  return `<div class="row-main"><strong>${escapeHtml(item.title)}</strong><span>${item.completed ? "완료" : "미완료"}</span></div><span class="badge">${escapeHtml(item.date)}</span>`;
}

function eventSummary(item) {
  const time = [item.start_time, item.end_time].filter(Boolean).join(" - ") || "종일";
  const startDate = eventStartDate(item);
  const endDate = eventEndDate(item);
  const range = startDate === endDate ? startDate : `${startDate} → ${endDate}`;
  return `<div class="row-main"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(categoryLabel(item.category))} · ${escapeHtml(time)}</span></div><span class="badge">${escapeHtml(range)}</span>`;
}

function taskSummary(item) {
  return `<div class="row-main"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.owner || "담당자 미정")} · ${escapeHtml(statusLabel(item.status))}</span></div><span class="badge">${escapeHtml(item.start_date)} → ${escapeHtml(item.end_date)}</span>`;
}

function projectSummary(item) {
  const meta = [item.company_name || "회사명 미지정", item.owner || "", projectStatusLabel(item.status)].filter(Boolean).join(" · ");
  return `<div class="row-main"><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(meta)}</span></div><span class="badge">${escapeHtml(item.path || "vault")}</span>`;
}

function meetingSummary(item) {
  const attendees = Array.isArray(item.attendees) ? item.attendees.join(", ") : "";
  const meta = [item.date, item.start_time, attendees || "참석자 미정"].filter(Boolean).join(" · ");
  return `<div class="row-main"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(meta)}</span></div><span class="badge">${escapeHtml(item.path || "회의록")}</span>`;
}

function wikiSummary(item) {
  const tags = Array.isArray(item.tags) && item.tags.length ? item.tags.join(", ") : "";
  const preview = notePreview(item);
  const meta = [item.category || "General", tags].filter(Boolean).join(" · ");
  return `<div class="row-main"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(meta)}</span>${preview ? `<p class="note-preview">${escapeHtml(preview)}</p>` : ""}</div><span class="badge">${escapeHtml(String(item.updated_at || "").slice(0, 10) || "Wiki")}</span>`;
}

function notePreview(item) {
  return splitEventBody(item.body)
    .content.replace(/^# .*(\r?\n)+/, "")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .trim()
    .slice(0, 140);
}

function todoLine(item) {
  if (item.id === todoEditingId) {
    return todoEditLine(item);
  }
  const note = todoNote(item);
  const age = todoAgeLabel(item);
  return `
    <div class="row todo-line ${item.completed ? "done" : ""}" data-todo-id="${escapeHtml(item.id)}">
      <span class="drag-handle" draggable="true" data-todo-drag="${escapeHtml(item.id)}" title="순서 변경" aria-label="순서 변경">⋮⋮</span>
      <input type="checkbox" data-todo-check="${escapeHtml(item.id)}" ${item.completed ? "checked" : ""} aria-label="TODO 완료" />
      <div class="row-main">
        <strong>${escapeHtml(item.title)}</strong>
        <span>${item.completed ? "완료" : "미완료"}</span>
        ${note ? `<p class="todo-note-preview">${escapeHtml(note)}</p>` : ""}
      </div>
      <span class="badge">${escapeHtml(age)}</span>
      <div class="todo-actions">
        <button class="secondary compact-button" type="button" data-todo-edit="${escapeHtml(item.id)}">수정</button>
        <button class="danger-button compact-button" type="button" data-todo-delete="${escapeHtml(item.id)}">삭제</button>
      </div>
    </div>
  `;
}

function todoEditLine(item) {
  return `
    <div class="row todo-line todo-edit-line" data-todo-id="${escapeHtml(item.id)}">
      <form class="todo-edit-form" id="todo-edit-form">
        <input name="todo_id" type="hidden" value="${escapeHtml(item.id)}" />
        <label>제목<input name="title" required maxlength="140" value="${escapeHtml(item.title)}" /></label>
        <label>상세 내용<textarea name="note">${escapeHtml(todoNote(item))}</textarea></label>
        <div class="todo-edit-actions">
          <button type="submit">저장</button>
          <button class="secondary" type="button" data-todo-edit-cancel>취소</button>
        </div>
      </form>
    </div>
  `;
}

function todoDeleteConfirmDialog(item) {
  return `
    <div class="modal-backdrop" data-todo-delete-cancel>
      <div class="confirm-dialog todo-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="todo-delete-dialog-title">
        <p class="eyebrow">TODO 삭제</p>
        <h3 id="todo-delete-dialog-title">${escapeHtml(item.title)}</h3>
        <p>이 TODO를 목록에서 삭제합니다. Obsidian 노트에는 삭제 시간과 변경 로그가 남습니다.</p>
        <div class="confirm-actions">
          <button class="secondary" type="button" data-todo-delete-cancel>취소</button>
          <button class="danger-button" type="button" data-todo-delete-confirm>삭제</button>
        </div>
      </div>
    </div>
  `;
}

function todoNote(item) {
  return splitEventBody(item.body)
    .content.replace(/^# .*(\r?\n)+/, "")
    .trim();
}

function todoAgeLabel(item) {
  const createdDate = String(item.origin_created_at || item.created_at || item.date || "").slice(0, 10);
  const targetDate = toDateInputValue(new Date());
  const created = new Date(`${createdDate}T00:00:00`);
  const target = new Date(`${targetDate}T00:00:00`);
  const diff = Math.floor((target.getTime() - created.getTime()) / 86400000);
  if (!Number.isFinite(diff) || diff <= 0) {
    return "당일";
  }
  return `${diff}일 전`;
}

function setupTodoDrag() {
  const list = document.querySelector("[data-todo-list]");
  if (!list) {
    return;
  }
  let dragStarted = false;
  let originalOrder = "";

  list.querySelectorAll("[data-todo-drag]").forEach((handle) => {
    handle.addEventListener("dragstart", (event) => {
      const row = handle.closest(".todo-line");
      if (!row) {
        return;
      }
      dragStarted = true;
      originalOrder = currentTodoOrder();
      list.classList.add("is-sorting");
      handle.classList.add("is-active");
      row.classList.add("is-dragging");
      row.setAttribute("aria-grabbed", "true");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", row.dataset.todoId || "");
      const preview = createTodoDragPreview(row);
      event.dataTransfer.setDragImage(preview, 22, 22);
      setTimeout(() => preview.remove(), 0);
    });

    handle.addEventListener("dragend", async () => {
      const row = list.querySelector(".todo-line.is-dragging");
      row?.classList.remove("is-dragging");
      row?.removeAttribute("aria-grabbed");
      handle.classList.remove("is-active");
      list.classList.remove("is-sorting");
      clearTodoDropTargets(list);
      if (dragStarted && currentTodoOrder() !== originalOrder) {
        dragStarted = false;
        await saveTodoOrder();
        return;
      }
      dragStarted = false;
    });
  });

  list.addEventListener("dragover", (event) => {
    const dragging = list.querySelector(".todo-line.is-dragging");
    if (!dragging) {
      return;
    }
    event.preventDefault();
    const afterElement = todoDragAfterElement(list, event.clientY);
    clearTodoDropTargets(list);
    afterElement?.classList.add("is-drop-target");
    if (afterElement) {
      list.insertBefore(dragging, afterElement);
    } else {
      list.appendChild(dragging);
    }
  });
}

function createTodoDragPreview(row) {
  const preview = row.cloneNode(true);
  preview.classList.add("todo-drag-preview");
  preview.classList.remove("is-dragging", "is-drop-target");
  preview.style.width = `${row.getBoundingClientRect().width}px`;
  document.body.appendChild(preview);
  return preview;
}

function clearTodoDropTargets(list) {
  list.querySelectorAll(".todo-line.is-drop-target").forEach((row) => row.classList.remove("is-drop-target"));
}

function currentTodoOrder() {
  return [...document.querySelectorAll("[data-todo-list] .todo-line")]
    .map((row) => row.dataset.todoId)
    .filter(Boolean)
    .join("|");
}

function todoDragAfterElement(list, y) {
  const rows = [...list.querySelectorAll(".todo-line:not(.is-dragging)")];
  return rows.reduce(
    (closest, row) => {
      const box = row.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) {
        return { offset, element: row };
      }
      return closest;
    },
    { offset: Number.NEGATIVE_INFINITY, element: null },
  ).element;
}

async function saveTodoOrder() {
  const ids = [...document.querySelectorAll("[data-todo-list] .todo-line")]
    .map((row) => row.dataset.todoId)
    .filter(Boolean);
  if (!ids.length) {
    return;
  }
  await api("/api/todos/reorder", {
    method: "POST",
    body: JSON.stringify({ ids }),
  });
  renderTodos();
}

function timeline(items) {
  if (!items.length) {
    return `<p class="empty">등록된 작업이 없습니다.</p>`;
  }
  const starts = items.map((item) => new Date(`${item.start_date}T00:00:00`).getTime());
  const ends = items.map((item) => new Date(`${item.end_date}T00:00:00`).getTime());
  const min = Math.min(...starts);
  const max = Math.max(...ends);
  const span = Math.max(1, max - min);
  return `
    <div class="timeline">
      ${items
        .map((item) => {
          const start = new Date(`${item.start_date}T00:00:00`).getTime();
          const end = new Date(`${item.end_date}T00:00:00`).getTime();
          const left = ((start - min) / span) * 100;
          const width = Math.max(((end - start) / span) * 100, 4);
          return `
            <div class="timeline-row">
              <div class="row-main"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.start_date)} → ${escapeHtml(item.end_date)}</span></div>
              <div class="track"><div class="bar" style="--bar-left:${left}%;--bar-width:${width}%"></div></div>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

function calendarCells(monthDate, eventsByDate, layout, multiDayLayout) {
  const today = toDateInputValue(new Date());
  const rangeEventsByDate = calendarRangeSegmentsByDate(multiDayLayout.segments, layout);
  const cells = [];
  for (let index = 0; index < layout.totalCells; index += 1) {
    const cellDate = addDays(layout.start, index);
    const value = toDateInputValue(cellDate);
    const inMonth = cellDate.getMonth() === monthDate.getMonth();
    const events = eventsByDate[value] || [];
    const rangeEvents = rangeEventsByDate[value] || [];
    const singleDayEvents = events.filter((event) => !isMultiDayEvent(event));
    const visibleEvents = singleDayEvents.slice(0, 2);
    const hiddenCount = Math.max(0, singleDayEvents.length - visibleEvents.length);
    const column = (index % 7) + 1;
    const row = Math.floor(index / 7) + 1;
    const weekLanes = multiDayLayout.weekLaneCounts[row - 1] || 0;
    cells.push(`
      <button class="day ${inMonth ? "" : "is-muted"} ${value === selectedCalendarDate ? "is-selected" : ""} ${value === today ? "is-today" : ""}" type="button" data-date="${value}" style="grid-column:${column};grid-row:${row};--week-lanes:${weekLanes};">
        <span class="day-number">${cellDate.getDate()}</span>
        ${weekLanes ? `<span class="day-range-events" style="--week-lanes:${weekLanes};">${rangeEvents.map(rangeSegmentChip).join("")}</span>` : ""}
        ${
          visibleEvents.length || hiddenCount
            ? `<span class="day-events">
                ${visibleEvents.map((event) => `<span class="event-chip category-${categoryClass(event.category)}">${escapeHtml(event.title)}</span>`).join("")}
                ${hiddenCount ? `<span class="day-more">+${hiddenCount}건</span>` : ""}
              </span>`
            : ""
        }
      </button>
    `);
  }
  return cells.join("");
}

function calendarRangeSegmentsByDate(segments, layout) {
  const byDate = segments.reduce((acc, segment) => {
    for (let column = segment.columnStart; column <= segment.columnEnd; column += 1) {
      const dayOffset = segment.weekIndex * 7 + column - 1;
      const value = toDateInputValue(addDays(layout.start, dayOffset));
      acc[value] = acc[value] || [];
      acc[value].push({
        ...segment,
        startsEvent: segment.startsEvent && column === segment.columnStart,
        endsEvent: segment.endsEvent && column === segment.columnEnd,
      });
    }
    return acc;
  }, {});
  Object.values(byDate).forEach((items) => {
    items.sort((a, b) => a.lane - b.lane || a.item.title.localeCompare(b.item.title));
  });
  return byDate;
}

function rangeSegmentChip(segment) {
  const className = categoryClass(segment.item.category);
  return `
    <span class="range-chip category-${className} ${segment.startsEvent ? "starts-range" : ""} ${segment.endsEvent ? "ends-range" : ""}" style="--event-lane:${segment.lane};" title="${escapeHtml(segment.item.title)} · ${escapeHtml(eventStartDate(segment.item))} ~ ${escapeHtml(eventEndDate(segment.item))}">
      <span>${escapeHtml(segment.item.title)}</span>
    </span>
  `;
}

function getMultiDayLayout(items, layout) {
  const end = addDays(layout.start, layout.totalCells - 1);
  const weekLanes = Array.from({ length: layout.weeks }, () => []);
  const segments = items
    .filter(isMultiDayEvent)
    .flatMap((item) => eventWeekSegments(item, layout.start, end))
    .sort((a, b) => a.weekIndex - b.weekIndex || a.columnStart - b.columnStart || b.columnSpan - a.columnSpan || a.item.title.localeCompare(b.item.title))
    .map((segment) => {
      const lanes = weekLanes[segment.weekIndex];
      const lane = firstAvailableLane(lanes, segment.columnStart, segment.columnEnd);
      if (lane > 2) {
        return null;
      }
      lanes.push({ lane, columnStart: segment.columnStart, columnEnd: segment.columnEnd });
      return { ...segment, lane };
    })
    .filter(Boolean);
  const weekLaneCounts = weekLanes.map((lanes) => (lanes.length ? Math.max(...lanes.map((item) => item.lane)) + 1 : 0));
  return { segments, weekLaneCounts };
}

function calendarGridStyle(multiDayLayout) {
  const rowCount = multiDayLayout.weekLaneCounts.length || 6;
  const rowMin = rowCount > 5 ? 78 : 96;
  return `grid-template-rows:repeat(${rowCount}, minmax(min(${rowMin}px, calc((100vh - 244px) / ${rowCount})), 1fr));--calendar-row-count:${rowCount};`;
}

function eventWeekSegments(item, calendarStart, calendarEnd) {
  const eventStart = parseDateValue(eventStartDate(item));
  const eventEnd = parseDateValue(eventEndDate(item));
  if (!eventStart || !eventEnd || eventEnd < calendarStart || eventStart > calendarEnd) {
    return [];
  }

  const segments = [];
  let cursor = maxDate(eventStart, calendarStart);
  const finalDate = minDate(eventEnd, calendarEnd);
  while (cursor <= finalDate) {
    const dayOffset = dateDiffDays(calendarStart, cursor);
    const weekIndex = Math.floor(dayOffset / 7);
    const weekEnd = addDays(calendarStart, weekIndex * 7 + 6);
    const segmentEnd = minDate(finalDate, weekEnd);
    const columnStart = (dateDiffDays(calendarStart, cursor) % 7) + 1;
    const columnEnd = (dateDiffDays(calendarStart, segmentEnd) % 7) + 1;
    segments.push({
      item,
      weekIndex,
      columnStart,
      columnEnd,
      columnSpan: columnEnd - columnStart + 1,
      startsEvent: sameDate(cursor, eventStart),
      endsEvent: sameDate(segmentEnd, eventEnd),
    });
    cursor = addDays(segmentEnd, 1);
  }
  return segments;
}

function firstAvailableLane(lanes, columnStart, columnEnd) {
  for (let lane = 0; lane < 4; lane += 1) {
    const hasOverlap = lanes.some((item) => item.lane === lane && columnStart <= item.columnEnd && columnEnd >= item.columnStart);
    if (!hasOverlap) {
      return lane;
    }
  }
  return 4;
}

function getCalendarLayout(monthDate) {
  const first = startOfMonth(monthDate);
  const offset = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const totalCells = Math.max(35, Math.ceil((offset + daysInMonth) / 7) * 7);
  const start = new Date(first);
  start.setDate(first.getDate() - offset);
  return { start, totalCells, weeks: totalCells / 7 };
}

function calendarEventsByDate(items, layout) {
  const end = addDays(layout.start, layout.totalCells - 1);
  return items.reduce((acc, item) => {
    const eventStart = parseDateValue(eventStartDate(item));
    const eventEnd = parseDateValue(eventEndDate(item));
    if (!eventStart || !eventEnd || eventEnd < layout.start || eventStart > end) {
      return acc;
    }
    let cursor = maxDate(eventStart, layout.start);
    const finalDate = minDate(eventEnd, end);
    while (cursor <= finalDate) {
      const value = toDateInputValue(cursor);
      acc[value] = acc[value] || [];
      acc[value].push(item);
      cursor = addDays(cursor, 1);
    }
    return acc;
  }, {});
}

function calendarEventDialog(dateValue, events) {
  const selectedEvent = events.find((event) => eventKey(event) === calendarDetailEventId);
  const editingEvent = events.find((event) => eventKey(event) === calendarEditEventId);
  const pendingDeleteEvent = events.find((event) => eventKey(event) === calendarPendingDeleteId);
  return `
    <div class="modal-backdrop" data-close-calendar-dialog>
      <div class="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="calendar-dialog-title">
        <div class="modal-head">
          <div>
            <p class="eyebrow">일정 등록</p>
            <h2 id="calendar-dialog-title">${formatDateLabel(dateValue)}</h2>
          </div>
          <button class="icon-button" type="button" data-close-calendar-dialog aria-label="닫기">X</button>
        </div>
        <div class="modal-body">
          <section class="modal-existing">
            ${selectedEvent ? calendarEventDetail(selectedEvent) : calendarEventList(events)}
          </section>
          <section class="modal-create">
            <div class="modal-subhead">
              <h3>${editingEvent ? "일정 수정" : "새 일정"}</h3>
              ${editingEvent ? `<button class="secondary compact-button" type="button" data-calendar-edit-cancel>취소</button>` : ""}
            </div>
            ${calendarEventForm(dateValue, editingEvent)}
          </section>
        </div>
        ${pendingDeleteEvent ? calendarDeleteConfirmDialog(pendingDeleteEvent) : ""}
      </div>
    </div>
  `;
}

function calendarDeleteConfirmDialog(item) {
  return `
    <div class="confirm-backdrop" data-calendar-delete-cancel>
      <div class="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-dialog-title">
        <p class="eyebrow">일정 삭제</p>
        <h3 id="delete-dialog-title">${escapeHtml(item.title)}</h3>
        <p>이 일정을 달력에서 삭제합니다. Obsidian 노트에는 삭제 시간과 변경 로그가 남습니다.</p>
        <div class="confirm-actions">
          <button class="secondary" type="button" data-calendar-delete-cancel>취소</button>
          <button class="danger-button" type="button" data-calendar-delete-confirm>삭제</button>
        </div>
      </div>
    </div>
  `;
}

function calendarEventForm(dateValue, item = null) {
  const startDate = item ? eventStartDate(item) : dateValue;
  const endDate = item ? eventEndDate(item) : dateValue;
  const attendees = Array.isArray(item?.attendees) ? item.attendees.join(", ") : "";
  const notes = item ? eventNotes(item) : "";
  return `
    <form class="form event-form" id="event-form">
      ${item ? `<input name="event_id" type="hidden" value="${escapeHtml(eventKey(item))}" />` : ""}
      <label class="full">제목<input name="title" required maxlength="120" placeholder="예: 고객사 방문, 여름휴가" value="${escapeHtml(item?.title || "")}" /></label>
      <label class="full">유형
        <input name="category" required maxlength="40" list="event-category-list" placeholder="출장, 연차, 미팅 등 직접 입력" value="${escapeHtml(categoryLabel(item?.category || ""))}" />
        <datalist id="event-category-list">
          <option value="출장"></option>
          <option value="연차"></option>
          <option value="반차"></option>
          <option value="미팅"></option>
          <option value="회사 일정"></option>
        </datalist>
      </label>
      <div class="form-row full">
        <label>시작일<input name="start_date" type="date" required value="${escapeHtml(startDate)}" /></label>
        <label>종료일<input name="end_date" type="date" required value="${escapeHtml(endDate)}" /></label>
      </div>
      <div class="form-row full">
        <label>시작 시간<input name="start_time" type="time" value="${escapeHtml(item?.start_time || "")}" /></label>
        <label>종료 시간<input name="end_time" type="time" value="${escapeHtml(item?.end_time || "")}" /></label>
      </div>
      <label class="full">참석자<input name="attendees" placeholder="쉼표로 구분" value="${escapeHtml(attendees)}" /></label>
      <label class="full">메모<textarea name="notes" placeholder="Obsidian 노트 본문으로 저장됩니다.">${escapeHtml(notes)}</textarea></label>
      <button class="full" type="submit">${item ? "일정 수정" : "일정 저장"}</button>
    </form>
  `;
}

function calendarEventList(events) {
  return `
    <div class="modal-subhead">
      <h3>등록된 일정</h3>
      <span class="badge">${events.length}건</span>
    </div>
    ${
      events.length
        ? `<div class="list event-list">
            ${events
              .map(
                (item) => `
                  <button class="row event-list-button" type="button" data-calendar-event-id="${escapeHtml(eventKey(item))}">
                    ${eventSummary(item)}
                  </button>
                `,
              )
              .join("")}
          </div>`
        : `<p class="empty">등록된 일정이 없습니다.</p>`
    }
  `;
}

function calendarEventDetail(item) {
  const time = [item.start_time, item.end_time].filter(Boolean).join(" - ") || "종일";
  const startDate = eventStartDate(item);
  const endDate = eventEndDate(item);
  const range = startDate === endDate ? startDate : `${startDate} → ${endDate}`;
  const attendees = Array.isArray(item.attendees) && item.attendees.length ? item.attendees.join(", ") : "없음";
  const notes = eventNotes(item);
  const changeLog = eventChangeLog(item);
  return `
    <article class="event-detail">
      <div class="detail-actions">
        <button class="secondary" type="button" data-calendar-list-back>목록</button>
        <button class="secondary" type="button" data-calendar-edit>수정</button>
        <button class="danger-button" type="button" data-calendar-delete>삭제</button>
      </div>
      <p class="eyebrow">일정 상세</p>
      <h3>${escapeHtml(item.title)}</h3>
      <div class="detail-grid">
        <span>유형</span><strong>${escapeHtml(categoryLabel(item.category))}</strong>
        <span>기간</span><strong>${escapeHtml(range)}</strong>
        <span>시간</span><strong>${escapeHtml(time)}</strong>
        <span>참석자</span><strong>${escapeHtml(attendees)}</strong>
        <span>등록</span><strong>${escapeHtml(formatDateTime(item.created_at))}</strong>
        <span>수정</span><strong>${escapeHtml(formatDateTime(item.updated_at))}</strong>
      </div>
      ${notes ? `<div class="detail-notes"><span>메모</span><p>${escapeHtml(notes)}</p></div>` : ""}
      ${changeLog ? `<div class="detail-notes"><span>변경 로그</span><p>${escapeHtml(changeLog)}</p></div>` : ""}
      ${item.path ? `<p class="detail-path">${escapeHtml(item.path)}</p>` : ""}
    </article>
  `;
}

function projectOptions(projects) {
  return projects
    .map((project) => {
      const label = project.company_name ? `${project.company_name} / ${project.name}` : project.name;
      return `<option value="${escapeHtml(project.id)}">${escapeHtml(label)}</option>`;
    })
    .join("");
}

function groupBy(items, key) {
  return items.reduce((acc, item) => {
    const value = item[key];
    acc[value] = acc[value] || [];
    acc[value].push(item);
    return acc;
  }, {});
}

function splitList(value) {
  return String(value || "")
    .split(/\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function emptyToNull(value) {
  return value ? value : null;
}

function eventKey(item) {
  return String(item.id || item.path || `${item.title}-${eventStartDate(item)}-${eventEndDate(item)}`);
}

function eventNotes(item) {
  return splitEventBody(item.body).content
    .replace(/^# .*(\r?\n)+/, "")
    .trim();
}

function eventChangeLog(item) {
  return splitEventBody(item.body).log;
}

function splitEventBody(body) {
  const text = String(body || "");
  const match = text.match(/^## 변경 로그\s*$/m);
  if (!match || match.index === undefined) {
    return { content: text, log: "" };
  }
  return {
    content: text.slice(0, match.index).trim(),
    log: text.slice(match.index + match[0].length).trim(),
  };
}

function eventStartDate(item) {
  return item.start_date || item.date;
}

function eventEndDate(item) {
  return item.end_date || eventStartDate(item);
}

function isMultiDayEvent(item) {
  return eventEndDate(item) > eventStartDate(item);
}

function parseDateValue(value) {
  return value ? new Date(`${value}T00:00:00`) : null;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function dateDiffDays(start, end) {
  return Math.round((end.getTime() - start.getTime()) / 86400000);
}

function minDate(a, b) {
  return a <= b ? a : b;
}

function maxDate(a, b) {
  return a >= b ? a : b;
}

function sameDate(a, b) {
  return toDateInputValue(a) === toDateInputValue(b);
}

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function startOfWeek(date) {
  const next = new Date(date);
  const day = (next.getDay() + 6) % 7;
  next.setDate(next.getDate() - day);
  return next;
}

function toDateInputValue(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function formatMonthLabel(date) {
  return `${date.getFullYear()}년 ${date.getMonth() + 1}월`;
}

function formatDateLabel(value) {
  const date = new Date(`${value}T00:00:00`);
  const day = ["일", "월", "화", "수", "목", "금", "토"][date.getDay()];
  return `${date.getFullYear()}년 ${date.getMonth() + 1}월 ${date.getDate()}일 (${day})`;
}

function formatDateTime(value) {
  return value ? String(value).replace("T", " ") : "-";
}

function categoryLabel(value) {
  return {
    annual_leave: "연차",
    half_day: "반차",
    meeting: "미팅",
    company: "회사 일정",
    other: "기타",
  }[value] || value;
}

function categoryClass(value) {
  const label = categoryLabel(value);
  return {
    annual_leave: "annual-leave",
    연차: "annual-leave",
    half_day: "half-day",
    반차: "half-day",
    meeting: "meeting",
    미팅: "meeting",
    company: "company",
    "회사 일정": "company",
    출장: "business-trip",
  }[value] || {
    연차: "annual-leave",
    반차: "half-day",
    미팅: "meeting",
    "회사 일정": "company",
    출장: "business-trip",
  }[label] || "custom";
}

function statusLabel(value) {
  return {
    todo: "대기",
    in_progress: "진행",
    review: "리뷰",
    done: "완료",
    blocked: "막힘",
  }[value] || value;
}

function projectStatusLabel(value) {
  return {
    planning: "기획",
    active: "진행",
    paused: "보류",
    done: "완료",
  }[value] || value;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
