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
let taskCreateContext = null;
let taskDetailId = null;
let taskDetailEditingId = null;
let taskDragId = null;
let taskGanttInitialScrollDone = false;
let taskPendingDeleteId = null;
let taskGanttSuppressClickUntil = 0;
let taskRowClickTimer = null;
let taskTimelineResizeJustEnded = false;
let todoEditingId = null;
let todoPendingDeleteId = null;
let selectedProjectId = null;
let projectCreateDialogOpen = false;
let projectDetailTab = "meetings";
let selectedProjectResourceId = null;
let projectResourceMode = "view";
let projectInfoEditOpen = false;
let activeRichEditor = null;
let activeImageResize = null;
let chatWidgetOpen = false;
let chatSending = false;
const chatMessages = [
  {
    role: "bot",
    text: "저장된 Obsidian 노트를 기준으로 답변합니다. 궁금한 내용을 입력해주세요.",
    time: new Date().toISOString(),
  },
];
const collapsedTaskGroups = new Set();
const TASK_GANTT_DAY_WIDTH = 52;
const TASK_GANTT_LEFT_WIDTH = 560;

todayLabel.textContent = toDateInputValue(new Date());
setupChatWidget();

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
  if (event.key === "Escape" && chatWidgetOpen) {
    chatWidgetOpen = false;
    renderChatWidget();
    return;
  }
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
  if (event.key === "Escape" && currentRoute() === "tasks" && (taskCreateContext || taskDetailId || taskDetailEditingId || taskPendingDeleteId)) {
    taskCreateContext = null;
    taskDetailId = null;
    taskDetailEditingId = null;
    taskPendingDeleteId = null;
    clearTaskRowClickTimer();
    renderTasks();
  }
  if (event.key === "Escape" && currentRoute() === "projects") {
    if (projectInfoEditOpen) {
      projectInfoEditOpen = false;
      renderProjects();
      return;
    }
    if (projectCreateDialogOpen) {
      projectCreateDialogOpen = false;
      renderProjects();
      return;
    }
    closeProjectDetailDialog();
  }
});
renderRoute(currentRoute());

function setupChatWidget() {
  const widget = document.createElement("section");
  widget.className = "chat-widget";
  widget.setAttribute("aria-label", "노트 상담봇");
  document.body.appendChild(widget);
  renderChatWidget();
}

function renderChatWidget() {
  const widget = document.querySelector(".chat-widget");
  if (!widget) {
    return;
  }
  const panelHtml = chatWidgetOpen
    ? `
      <div class="chat-panel open">
        <div class="chat-panel-head">
          <div>
            <strong>노트 상담봇</strong>
            <span>Obsidian 저장 내용을 기반으로 답변합니다</span>
          </div>
          <button class="chat-close" type="button" data-chat-close aria-label="채팅 닫기">X</button>
        </div>
        <div class="chat-messages" data-chat-messages>
          ${chatMessages.map(chatMessageHtml).join("")}
        </div>
        <form class="chat-form" data-chat-form>
          <input name="message" autocomplete="off" placeholder="저장된 내용에 대해 질문하세요" ${chatSending ? "disabled" : ""} />
          <button type="submit" ${chatSending ? "disabled" : ""}>${chatSending ? "확인중" : "전송"}</button>
        </form>
      </div>
    `
    : "";
  widget.innerHTML = `
    ${panelHtml}
    <button class="chat-launcher ${chatWidgetOpen ? "active" : ""}" type="button" data-chat-toggle aria-label="${chatWidgetOpen ? "채팅 닫기" : "상담 채팅 열기"}">
      <span class="chat-launcher-icon" aria-hidden="true"></span>
    </button>
  `;

  widget.querySelector("[data-chat-toggle]")?.addEventListener("click", () => {
    chatWidgetOpen = !chatWidgetOpen;
    renderChatWidget();
  });
  widget.querySelector("[data-chat-close]")?.addEventListener("click", () => {
    chatWidgetOpen = false;
    renderChatWidget();
  });
  widget.querySelector("[data-chat-form]")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (chatSending) {
      return;
    }
    const form = event.currentTarget;
    const input = form.elements.message;
    const text = String(input.value || "").trim();
    if (!text) {
      input.focus();
      return;
    }
    chatMessages.push({ role: "user", text, time: new Date().toISOString() });
    const pendingMessage = {
      role: "bot",
      text: "저장된 노트를 확인하는 중입니다.",
      time: new Date().toISOString(),
      pending: true,
    };
    chatMessages.push(pendingMessage);
    chatSending = true;
    renderChatWidget();
    try {
      const reply = await api("/api/chat/ask", {
        method: "POST",
        body: JSON.stringify({ question: text }),
      });
      Object.assign(pendingMessage, {
        text: reply.answer || "답변을 생성하지 못했습니다.",
        time: new Date().toISOString(),
        pending: false,
        mode: reply.mode || "",
      });
      if (reply.mode === "codex_sdk_error") {
        try {
          pendingMessage.auth = await api("/api/chat/auth/start", { method: "POST" });
          pendingMessage.text = `${pendingMessage.text}\n\n아래 링크로 Codex 인증을 완료한 뒤 같은 질문을 다시 보내주세요.`;
        } catch (authError) {
          pendingMessage.text = `${pendingMessage.text}\n\n인증 링크 생성도 실패했습니다. ${authError.message}`;
        }
      }
    } catch (error) {
      Object.assign(pendingMessage, {
        text: `답변 생성 중 오류가 발생했습니다. ${error.message}`,
        time: new Date().toISOString(),
        pending: false,
        sources: [],
      });
    } finally {
      chatSending = false;
      renderChatWidget();
    }
  });

  const messages = widget.querySelector("[data-chat-messages]");
  if (messages) {
    messages.scrollTop = messages.scrollHeight;
  }
  if (chatWidgetOpen) {
    widget.querySelector(".chat-form input")?.focus();
  }
}

function chatMessageHtml(message) {
  const isUser = message.role === "user";
  const auth = message.auth || null;
  return `
    <div class="chat-message ${isUser ? "user" : "bot"} ${message.pending ? "pending" : ""}">
      <p>${escapeHtml(message.text)}</p>
      ${
        auth?.auth_url
          ? `<div class="chat-auth">
              <a href="${escapeHtml(auth.auth_url)}" target="_blank" rel="noreferrer">Codex 인증하기</a>
              <span>${escapeHtml(auth.expires_at ? `${auth.expires_at}까지 유효` : "새 창에서 인증을 완료하세요")}</span>
            </div>`
          : ""
      }
      <time>${escapeHtml(formatChatTime(message.time))}</time>
    </div>
  `;
}

function formatChatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

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
  if (route !== "tasks") {
    taskCreateContext = null;
    taskDetailId = null;
    taskDetailEditingId = null;
    taskDragId = null;
    taskGanttInitialScrollDone = false;
    taskPendingDeleteId = null;
    clearTaskRowClickTimer();
  }
  if (route !== "projects") {
    selectedProjectId = null;
    projectCreateDialogOpen = false;
    projectDetailTab = "meetings";
    selectedProjectResourceId = null;
    projectResourceMode = "view";
    projectInfoEditOpen = false;
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
  const todayData = data.today || { date: data.date, absences: data.absences || [], meetings: data.meetings || [], events: data.events || [] };
  const tomorrowData = data.tomorrow_day || { date: data.tomorrow, absences: data.tomorrow_absences || [], meetings: data.tomorrow_meetings || [], events: data.tomorrow_events || [] };
  view.innerHTML = `
    <section class="stats">
      ${stat("오늘 TODO", `${counts.todos_done}/${counts.todos_total}`)}
      ${stat("오늘 부재", `${counts.absence_people || 0}명`)}
      ${stat("내일 부재", `${counts.absence_people_tomorrow || 0}명`)}
      ${stat("오늘 회의", counts.meetings_today || 0)}
      ${stat("내일 회의", counts.meetings_tomorrow || 0)}
      ${stat("진행 작업", counts.active_tasks)}
      ${stat("진행 프로젝트", counts.active_projects)}
    </section>
    <section class="dashboard-day-grid">
      ${dashboardDayPanel("오늘", todayData, counts.absence_events || 0)}
      ${dashboardDayPanel("내일", tomorrowData, counts.absence_events_tomorrow || 0)}
    </section>
    <section class="panel dashboard-calendar-panel">
      <div class="section-head">
        <h2>캘린더 일정</h2>
        <span class="badge">오늘 ${counts.events_today || 0}건 · 내일 ${counts.events_tomorrow || 0}건</span>
      </div>
      <div class="dashboard-schedule-grid">
        ${dashboardScheduleBlock("오늘 일정", todayData.events || [])}
        ${dashboardScheduleBlock("내일 일정", tomorrowData.events || [])}
      </div>
    </section>
    <section class="grid two dashboard-bottom-grid">
      <div class="panel dashboard-list-panel">
        <h2>오늘 할 일</h2>
        ${rows(data.todos, todoSummary)}
      </div>
      <div class="panel dashboard-list-panel">
        <h2>현재 작업</h2>
        ${rows(data.active_tasks, taskSummary)}
      </div>
    </section>
    <section class="panel dashboard-list-panel dashboard-project-panel">
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
  const scrollAnchorDate = captureTaskGanttScrollAnchorDate();
  const [{ items: tasks }, { items: projects }] = await Promise.all([api("/api/tasks"), api("/api/projects")]);
  const today = toDateInputValue(new Date());
  view.innerHTML = `
    <section class="panel task-board-panel">
      <div class="task-board-head">
        <div>
          <p class="eyebrow">Gantt</p>
          <div class="task-title-row">
            <h2>작업바</h2>
            <button class="secondary task-register-button" type="button" data-task-add-root>작업등록</button>
          </div>
        </div>
        <span class="badge">${tasks.length}개 작업 · 오늘 ${today}</span>
      </div>
      ${taskGantt(tasks, projects)}
    </section>
    ${taskCreateContext ? taskCreateDialog(taskCreateContext, tasks, projects, today) : ""}
    ${taskDetailId ? taskDetailDialog(tasks.find((task) => task.id === taskDetailId), tasks, projects) : ""}
    ${taskPendingDeleteId ? taskDeleteConfirmDialog(tasks.find((task) => task.id === taskPendingDeleteId), tasks) : ""}
  `;
  document.querySelector("[data-task-add-root]")?.addEventListener("click", () => {
    taskCreateContext = {
      projectId: "",
      parentId: "",
      selectableProject: true,
    };
    taskDetailId = null;
    taskDetailEditingId = null;
    renderTasks();
  });
  document.querySelectorAll("[data-task-group-toggle]").forEach((button) => {
    button.addEventListener("click", () => {
      const groupId = button.dataset.taskGroupToggle;
      if (!groupId) {
        return;
      }
      if (collapsedTaskGroups.has(groupId)) {
        collapsedTaskGroups.delete(groupId);
      } else {
        collapsedTaskGroups.add(groupId);
      }
      renderTasks();
    });
  });
  document.querySelectorAll("[data-task-toggle]").forEach((button) => {
    button.addEventListener("click", () => {
      const taskId = button.dataset.taskToggle;
      if (!taskId) {
        return;
      }
      const collapseKey = `task:${taskId}`;
      if (collapsedTaskGroups.has(collapseKey)) {
        collapsedTaskGroups.delete(collapseKey);
      } else {
        collapsedTaskGroups.add(collapseKey);
      }
      renderTasks();
    });
  });
  document.querySelectorAll("[data-task-add-project]").forEach((button) => {
    button.addEventListener("click", () => {
      taskCreateContext = {
        projectId: button.dataset.taskAddProject || "",
        parentId: "",
        label: button.dataset.taskAddLabel || "프로젝트 미지정",
      };
      taskDetailId = null;
      taskDetailEditingId = null;
      renderTasks();
    });
  });
  document.querySelectorAll("[data-task-add-parent]").forEach((button) => {
    button.addEventListener("click", () => {
      const task = tasks.find((item) => item.id === button.dataset.taskAddParent);
      if (!task) {
        return;
      }
      taskCreateContext = {
        projectId: task.project_id || "",
        parentId: task.id,
        label: task.title,
      };
      taskDetailId = null;
      taskDetailEditingId = null;
      renderTasks();
    });
  });
  document.querySelectorAll("[data-task-delete]").forEach((button) => {
    button.addEventListener("click", () => {
      taskPendingDeleteId = button.dataset.taskDelete;
      taskCreateContext = null;
      taskDetailId = null;
      taskDetailEditingId = null;
      clearTaskRowClickTimer();
      renderTasks();
    });
  });
  document.querySelectorAll("[data-task-done]").forEach((checkbox) => {
    checkbox.addEventListener("change", async () => {
      await api(`/api/tasks/${encodeURIComponent(checkbox.dataset.taskDone)}`, {
        method: "PATCH",
        body: JSON.stringify({ status: checkbox.checked ? "done" : "in_progress" }),
      });
      renderTasks();
    });
  });
  setupTaskDragDrop(tasks);
  setupTaskGanttPanning();
  setupTaskTimelineEditing(tasks);
  setupTaskRowDetails(tasks);
  restoreTaskGanttScroll(scrollAnchorDate);
  document.querySelectorAll("[data-task-dialog-close]").forEach((control) => {
    control.addEventListener("click", () => {
      taskCreateContext = null;
      renderTasks();
    });
  });
  document.querySelectorAll("[data-task-detail-close]").forEach((control) => {
    control.addEventListener("click", () => {
      taskDetailId = null;
      taskDetailEditingId = null;
      clearTaskRowClickTimer();
      renderTasks();
    });
  });
  document.querySelectorAll("[data-task-detail-edit]").forEach((control) => {
    control.addEventListener("click", () => {
      taskDetailEditingId = control.dataset.taskDetailEdit || null;
      renderTasks();
    });
  });
  document.querySelectorAll("[data-task-detail-edit-cancel]").forEach((control) => {
    control.addEventListener("click", () => {
      taskDetailEditingId = null;
      renderTasks();
    });
  });
  document.querySelectorAll("[data-task-delete-cancel]").forEach((control) => {
    control.addEventListener("click", () => {
      taskPendingDeleteId = null;
      renderTasks();
    });
  });
  document.querySelector(".task-create-dialog")?.addEventListener("click", (event) => {
    event.stopPropagation();
  });
  document.querySelector(".task-detail-dialog")?.addEventListener("click", (event) => {
    event.stopPropagation();
  });
  document.querySelector(".task-delete-dialog")?.addEventListener("click", (event) => {
    event.stopPropagation();
  });
  document.querySelector("[data-task-delete-confirm]")?.addEventListener("click", async () => {
    if (!taskPendingDeleteId) {
      return;
    }
    await api(`/api/tasks/${encodeURIComponent(taskPendingDeleteId)}`, { method: "DELETE" });
    taskPendingDeleteId = null;
    renderTasks();
  });
  document.querySelector("#task-dialog-form input[name='start_date']")?.addEventListener("change", (event) => {
    const endDate = document.querySelector("#task-dialog-form input[name='end_date']");
    if (endDate && endDate.value < event.currentTarget.value) {
      endDate.value = event.currentTarget.value;
    }
  });
  document.querySelector("#task-dialog-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await api("/api/tasks", {
      method: "POST",
      body: JSON.stringify(Object.fromEntries(form.entries())),
    });
    taskCreateContext = null;
    renderTasks();
  });
  document.querySelector("#task-edit-form input[name='start_date']")?.addEventListener("change", (event) => {
    const endDate = document.querySelector("#task-edit-form input[name='end_date']");
    if (endDate && endDate.value < event.currentTarget.value) {
      endDate.value = event.currentTarget.value;
    }
  });
  document.querySelector("#task-edit-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const payload = Object.fromEntries(form.entries());
    const taskId = payload.task_id;
    delete payload.task_id;
    if (!taskId) {
      return;
    }
    await api(`/api/tasks/${encodeURIComponent(taskId)}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
    taskDetailEditingId = null;
    renderTasks();
  });
}

function taskDetailDialog(task, tasks, projects) {
  if (!task) {
    return "";
  }
  const project = projects.find((item) => item.id === task.project_id);
  const parent = tasks.find((item) => item.id === task.parent_id);
  const projectLabel = project ? (project.company_name ? `${project.company_name} / ${project.name}` : project.name) : "프로젝트 미지정";
  const parentLabel = parent ? parent.title : "없음";
  const description = taskDescriptionText(task);
  const isEditing = taskDetailEditingId === task.id;
  const summaryItems = [
    ["프로젝트", projectLabel],
    ["상위 작업", parentLabel],
    ["담당자", task.owner || "담당자 미정"],
    ["상태", statusLabel(task.status)],
    ["우선순위", priorityLabel(task.priority)],
    ["기간", taskPeriodText(task)],
    ["등록", formatDateTime(task.created_at)],
    ["수정", formatDateTime(task.updated_at)],
  ]
    .map(([label, value]) => taskDetailSummaryItem(label, value))
    .join("");
  return `
    <div class="modal-backdrop" data-task-detail-close>
      <div class="modal-dialog task-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="task-detail-title">
        <div class="modal-head">
          <div>
            <p class="eyebrow">${isEditing ? "작업 수정" : "작업 상세"}</p>
            <h2 id="task-detail-title">${escapeHtml(task.title)}</h2>
          </div>
          <div class="task-detail-actions">
            ${
              isEditing
                ? `<button class="secondary" type="button" data-task-detail-edit-cancel>보기</button>`
                : `<button class="secondary" type="button" data-task-detail-edit="${escapeHtml(task.id)}">수정</button>`
            }
            <button class="icon-button" type="button" data-task-detail-close aria-label="닫기">X</button>
          </div>
        </div>
        ${
          isEditing
            ? taskDetailEditForm(task, projects, projectLabel, parentLabel, description)
            : `<article class="task-detail">
                <div class="task-detail-summary">${summaryItems}</div>
                <div class="task-detail-main is-single">
                  <div class="detail-notes">
                    <span>설명</span>
                    <p>${description ? escapeHtml(description) : "등록된 설명이 없습니다."}</p>
                  </div>
                </div>
                ${task.path ? `<p class="detail-path">${escapeHtml(task.path)}</p>` : ""}
              </article>`
        }
      </div>
    </div>
  `;
}

function taskDetailSummaryItem(label, value) {
  return `
    <div class="task-detail-summary-item">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value || "-")}</strong>
    </div>
  `;
}

function taskDetailEditForm(task, projects, projectLabel, parentLabel, description) {
  const projectField = task.parent_id
    ? `<input type="hidden" name="project_id" value="${escapeHtml(task.project_id || "")}" />`
    : `<label>프로젝트<select name="project_id"><option value="">미지정</option>${projectOptions(projects, task.project_id || "")}</select></label>`;
  return `
    <form class="form task-dialog-form task-detail-edit-form" id="task-edit-form">
      <input type="hidden" name="task_id" value="${escapeHtml(task.id)}" />
      <input type="hidden" name="parent_id" value="${escapeHtml(task.parent_id || "")}" />
      <div class="task-edit-context full">
        <span><small>프로젝트</small><strong>${escapeHtml(projectLabel)}</strong></span>
        <span><small>상위 작업</small><strong>${escapeHtml(parentLabel)}</strong></span>
      </div>
      ${projectField}
      <label class="task-edit-title ${task.parent_id ? "full" : ""}">작업명<input name="title" required maxlength="140" value="${escapeHtml(task.title)}" /></label>
      <label>시작일<input name="start_date" type="date" required value="${escapeHtml(task.start_date)}" /></label>
      <label>종료일<input name="end_date" type="date" required value="${escapeHtml(task.end_date)}" /></label>
      <label>담당자<input name="owner" placeholder="담당자명" value="${escapeHtml(task.owner || "")}" /></label>
      <label>상태<select name="status">${statusOptions(task.status)}</select></label>
      <label>우선순위<select name="priority">${priorityOptions(task.priority)}</select></label>
      <label class="full">설명<textarea name="description">${escapeHtml(description)}</textarea></label>
      <div class="task-edit-actions full">
        <button class="secondary" type="button" data-task-detail-edit-cancel>취소</button>
        <button type="submit">수정 저장</button>
      </div>
    </form>
  `;
}

function taskDeleteConfirmDialog(task, tasks) {
  if (!task) {
    return "";
  }
  const childCount = taskDescendantIds(task.id, tasks).size;
  const childText = childCount ? ` 하위 작업 ${childCount}개도 함께 삭제됩니다.` : "";
  return `
    <div class="modal-backdrop" data-task-delete-cancel>
      <div class="confirm-dialog task-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="task-delete-dialog-title">
        <p class="eyebrow">작업 삭제</p>
        <h3 id="task-delete-dialog-title">${escapeHtml(task.title)}</h3>
        <p>이 작업을 작업바에서 삭제합니다.${escapeHtml(childText)} Obsidian 노트에는 삭제 시간과 변경 로그가 남습니다.</p>
        <div class="confirm-actions">
          <button class="secondary" type="button" data-task-delete-cancel>취소</button>
          <button class="danger-button" type="button" data-task-delete-confirm>삭제</button>
        </div>
      </div>
    </div>
  `;
}

function taskCreateDialog(context, tasks, projects, today) {
  const isRootCreate = Boolean(context.selectableProject);
  const project = projects.find((item) => item.id === context.projectId);
  const parent = context.parentId ? tasks.find((item) => item.id === context.parentId) : null;
  const projectLabel = project ? (project.company_name ? `${project.company_name} / ${project.name}` : project.name) : "프로젝트 미지정";
  const targetLabel = isRootCreate ? "새 작업" : parent ? `상위 작업: ${parent.title}` : `프로젝트: ${projectLabel}`;
  const title = isRootCreate ? "작업 등록" : "하위 작업 등록";
  const projectField = isRootCreate
    ? `<label>프로젝트<select name="project_id"><option value="">미지정</option>${projectOptions(projects, context.projectId || "")}</select></label>`
    : `<input type="hidden" name="project_id" value="${escapeHtml(context.projectId || "")}" />`;
  return `
    <div class="modal-backdrop" data-task-dialog-close>
      <div class="modal-dialog task-create-dialog" role="dialog" aria-modal="true" aria-labelledby="task-create-dialog-title">
        <div class="modal-head">
          <div>
            <p class="eyebrow">${escapeHtml(targetLabel)}</p>
            <h2 id="task-create-dialog-title">${escapeHtml(title)}</h2>
          </div>
          <button class="icon-button" type="button" data-task-dialog-close aria-label="닫기">X</button>
        </div>
        <form class="form task-create-form task-dialog-form" id="task-dialog-form">
          ${projectField}
          <input type="hidden" name="parent_id" value="${escapeHtml(context.parentId || "")}" />
          <label class="full">작업명<input name="title" required maxlength="140" placeholder="작업 이름" /></label>
          <label>시작일<input name="start_date" type="date" required value="${escapeHtml(today)}" /></label>
          <label>종료일<input name="end_date" type="date" required value="${escapeHtml(today)}" /></label>
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
    </div>
  `;
}

function setupTaskDragDrop(tasks) {
  document.querySelectorAll("[data-task-drag]").forEach((handle) => {
    handle.addEventListener("dragstart", (event) => {
      const taskId = handle.dataset.taskDrag;
      if (!taskId) {
        return;
      }
      taskDragId = taskId;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", taskId);
      document.querySelectorAll("[data-task-row-id]").forEach((cell) => {
        cell.classList.toggle("is-task-dragging", cell.dataset.taskRowId === taskId);
      });
    });
    handle.addEventListener("dragend", () => {
      clearTaskDragState();
    });
  });

  document.querySelectorAll("[data-task-drop-type]").forEach((target) => {
    target.addEventListener("dragover", (event) => {
      const taskId = taskDragId || event.dataTransfer.getData("text/plain");
      if (!canDropTask(taskId, target, tasks)) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      target.classList.add("is-task-drop-target");
    });
    target.addEventListener("dragleave", (event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) {
        event.currentTarget.classList.remove("is-task-drop-target");
      }
    });
    target.addEventListener("drop", async (event) => {
      const taskId = taskDragId || event.dataTransfer.getData("text/plain");
      if (!canDropTask(taskId, target, tasks)) {
        return;
      }
      event.preventDefault();
      await moveTaskToDropTarget(taskId, target, tasks, event);
    });
  });
}

function setupTaskGanttPanning() {
  const scroller = document.querySelector(".task-gantt-scroll");
  if (!scroller) {
    return;
  }
  let panState = null;

  scroller.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || isTaskInteractiveTarget(event.target)) {
      return;
    }
    panState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: scroller.scrollLeft,
      active: false,
    };
  });

  scroller.addEventListener("pointermove", (event) => {
    if (!panState || panState.pointerId !== event.pointerId) {
      return;
    }
    const dx = event.clientX - panState.startX;
    const dy = event.clientY - panState.startY;
    if (!panState.active) {
      if (Math.abs(dx) < 5 || Math.abs(dx) <= Math.abs(dy)) {
        return;
      }
      panState.active = true;
      scroller.classList.add("is-panning");
      try {
        scroller.setPointerCapture?.(event.pointerId);
      } catch {
        // Pointer capture is a progressive enhancement for smoother panning.
      }
      clearTaskRowClickTimer();
    }
    event.preventDefault();
    scroller.scrollLeft = panState.scrollLeft - dx;
  });

  const finishPan = (event) => {
    if (!panState || panState.pointerId !== event.pointerId) {
      return;
    }
    if (panState.active) {
      taskGanttSuppressClickUntil = Date.now() + 180;
    }
    scroller.classList.remove("is-panning");
    try {
      scroller.releasePointerCapture?.(event.pointerId);
    } catch {
      // Pointer capture can already be released by the browser.
    }
    panState = null;
  };

  scroller.addEventListener("pointerup", finishPan);
  scroller.addEventListener("pointercancel", finishPan);
}

function scrollTaskGanttToTodayOnce() {
  if (taskGanttInitialScrollDone) {
    return;
  }
  const scroller = document.querySelector(".task-gantt-scroll");
  if (!scroller) {
    return;
  }
  const todayIndex = Number(scroller.dataset.taskTodayIndex);
  if (!Number.isFinite(todayIndex) || todayIndex < 0) {
    taskGanttInitialScrollDone = true;
    return;
  }
  const targetLeft = Math.max(0, todayIndex * TASK_GANTT_DAY_WIDTH - TASK_GANTT_DAY_WIDTH);
  scroller.scrollLeft = targetLeft;
  taskGanttInitialScrollDone = true;
}

function captureTaskGanttScrollAnchorDate() {
  const scroller = document.querySelector(".task-gantt-scroll");
  const rangeStart = parseDateValue(scroller?.dataset.taskRangeStart);
  if (!scroller || !rangeStart) {
    return "";
  }
  const dayIndex = Math.max(0, Math.floor(scroller.scrollLeft / TASK_GANTT_DAY_WIDTH));
  return toDateInputValue(addDays(rangeStart, dayIndex));
}

function restoreTaskGanttScroll(anchorDate) {
  const scroller = document.querySelector(".task-gantt-scroll");
  if (!scroller) {
    return;
  }
  if (anchorDate && scrollTaskGanttToDate(scroller, anchorDate)) {
    taskGanttInitialScrollDone = true;
    return;
  }
  scrollTaskGanttToTodayOnce();
}

function scrollTaskGanttToDate(scroller, dateValue) {
  const rangeStart = parseDateValue(scroller?.dataset.taskRangeStart);
  const targetDate = parseDateValue(dateValue);
  const dayCount = Number(scroller?.dataset.taskDayCount || 0);
  if (!rangeStart || !targetDate || !dayCount) {
    return false;
  }
  const index = Math.max(0, Math.min(dayCount - 1, dateDiffDays(rangeStart, targetDate)));
  scroller.scrollLeft = Math.max(0, index * TASK_GANTT_DAY_WIDTH);
  return true;
}

function setupTaskRowDetails(tasks) {
  const taskIds = new Set(tasks.map((task) => task.id));
  document.querySelectorAll(".task-left-cell[data-task-row-id], .task-gantt-bar[data-task-bar]").forEach((target) => {
    target.addEventListener("click", (event) => {
      clearTaskRowClickTimer();
      if (event.detail > 1 || shouldIgnoreTaskRowClick(event)) {
        return;
      }
      const taskId = target.dataset.taskRowId || target.dataset.taskBar;
      if (!taskIds.has(taskId)) {
        return;
      }
      taskRowClickTimer = window.setTimeout(() => {
        taskRowClickTimer = null;
        if (Date.now() < taskGanttSuppressClickUntil) {
          return;
        }
        taskCreateContext = null;
        taskDetailId = taskId;
        taskDetailEditingId = null;
        renderTasks();
      }, 320);
    });
  });
}

function shouldIgnoreTaskRowClick(event) {
  return (
    Date.now() < taskGanttSuppressClickUntil ||
    taskDragId ||
    taskTimelineResizeJustEnded ||
    isTaskRowControlTarget(event.target)
  );
}

function isTaskInteractiveTarget(target) {
  return Boolean(target?.closest?.("button, input, select, textarea, a, [data-task-drag], .task-gantt-bar, .task-bar-resize"));
}

function isTaskRowControlTarget(target) {
  return Boolean(target?.closest?.("button, input, select, textarea, a, [data-task-drag], .task-bar-resize"));
}

function clearTaskRowClickTimer() {
  if (!taskRowClickTimer) {
    return;
  }
  window.clearTimeout(taskRowClickTimer);
  taskRowClickTimer = null;
}

function canDropTask(taskId, target, tasks) {
  const task = tasks.find((item) => item.id === taskId);
  const context = taskDropContext(target);
  if (!task || !context) {
    return false;
  }
  if (context.parentId) {
    if (context.parentId === taskId || taskDescendantIds(taskId, tasks).has(context.parentId)) {
      return false;
    }
  }
  const targetTask = context.dropTaskId ? tasks.find((item) => item.id === context.dropTaskId) : null;
  if (targetTask && sameTaskScope(task, targetTask)) {
    return context.dropTaskId !== taskId;
  }
  return (task.parent_id || "") !== context.parentId || (task.project_id || "") !== context.projectId;
}

function taskDropContext(target) {
  const type = target.dataset.taskDropType;
  if (type === "project") {
    return { parentId: "", projectId: target.dataset.taskDropProject || "" };
  }
  if (type === "task") {
    return {
      parentId: target.dataset.taskDropTask || "",
      projectId: target.dataset.taskDropProject || "",
      dropTaskId: target.dataset.taskDropTask || "",
    };
  }
  return null;
}

async function moveTaskToDropTarget(taskId, target, tasks, event) {
  const context = taskDropContext(target);
  if (!context) {
    return;
  }
  const task = tasks.find((item) => item.id === taskId);
  const targetTask = context.dropTaskId ? tasks.find((item) => item.id === context.dropTaskId) : null;
  if (task && targetTask && sameTaskScope(task, targetTask)) {
    await reorderTaskWithinScope(taskId, targetTask.id, tasks, event);
    return;
  }
  const descendants = tasks.filter((task) => taskDescendantIds(taskId, tasks).has(task.id));
  await api(`/api/tasks/${encodeURIComponent(taskId)}`, {
    method: "PATCH",
    body: JSON.stringify({ parent_id: context.parentId, project_id: context.projectId }),
  });
  await Promise.all(
    descendants
      .filter((task) => (task.project_id || "") !== context.projectId)
      .map((task) =>
        api(`/api/tasks/${encodeURIComponent(task.id)}`, {
          method: "PATCH",
          body: JSON.stringify({ project_id: context.projectId }),
        }),
      ),
  );
  collapsedTaskGroups.delete(`project:${context.projectId || "__unassigned__"}`);
  if (context.parentId) {
    collapsedTaskGroups.delete(`task:${context.parentId}`);
  }
  clearTaskDragState();
  renderTasks();
}

function sameTaskScope(a, b) {
  if (!a || !b) {
    return false;
  }
  return (a.project_id || "") === (b.project_id || "") && (a.parent_id || "") === (b.parent_id || "");
}

async function reorderTaskWithinScope(taskId, targetTaskId, tasks, event) {
  const task = tasks.find((item) => item.id === taskId);
  const targetTask = tasks.find((item) => item.id === targetTaskId);
  if (!task || !targetTask || task.id === targetTask.id) {
    return;
  }
  const targetRect = event.currentTarget.getBoundingClientRect();
  const insertAfter = event.clientY > targetRect.top + targetRect.height / 2;
  const siblings = sortTasks(tasks.filter((item) => sameTaskScope(item, task) && item.id !== taskId));
  const targetIndex = siblings.findIndex((item) => item.id === targetTaskId);
  if (targetIndex < 0) {
    return;
  }
  siblings.splice(insertAfter ? targetIndex + 1 : targetIndex, 0, task);
  await Promise.all(
    siblings.map((item, index) =>
      api(`/api/tasks/${encodeURIComponent(item.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ order: index }),
      }),
    ),
  );
  clearTaskDragState();
  renderTasks();
}

function taskDescendantIds(taskId, tasks) {
  const childrenByParent = tasks.reduce((acc, task) => {
    const parentId = task.parent_id || "";
    if (!parentId) {
      return acc;
    }
    if (!acc.has(parentId)) {
      acc.set(parentId, []);
    }
    acc.get(parentId).push(task);
    return acc;
  }, new Map());
  const descendants = new Set();
  const stack = [...(childrenByParent.get(taskId) || [])];
  while (stack.length) {
    const child = stack.pop();
    if (!child || descendants.has(child.id)) {
      continue;
    }
    descendants.add(child.id);
    stack.push(...(childrenByParent.get(child.id) || []));
  }
  return descendants;
}

function clearTaskDragState() {
  taskDragId = null;
  document.querySelectorAll(".is-task-dragging, .is-task-drop-target").forEach((element) => {
    element.classList.remove("is-task-dragging", "is-task-drop-target");
  });
}

function setupTaskTimelineEditing(tasks) {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  document.querySelectorAll(".task-timeline-cell[data-task-row-id]").forEach((cell) => {
    cell.addEventListener("dblclick", async (event) => {
      clearTaskRowClickTimer();
      if (Date.now() < taskGanttSuppressClickUntil || taskTimelineResizeJustEnded || event.target.closest(".task-bar-resize")) {
        return;
      }
      event.preventDefault();
      const task = tasksById.get(cell.dataset.taskRowId);
      const dateValue = taskDateFromTimelinePointer(cell, event.clientX);
      if (!task || !dateValue) {
        return;
      }
      taskDetailId = null;
      taskDetailEditingId = null;
      await api(`/api/tasks/${encodeURIComponent(task.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ start_date: dateValue, end_date: dateValue }),
      });
      renderTasks();
    });
  });

  document.querySelectorAll("[data-task-bar-resize]").forEach((handle) => {
    handle.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const edge = handle.dataset.taskBarResize;
      const bar = handle.closest(".task-gantt-bar");
      const timeline = handle.closest(".task-timeline-cell");
      const task = tasksById.get(bar?.dataset.taskBar || "");
      const rangeStart = parseDateValue(timeline?.dataset.taskRangeStart);
      if (!edge || !bar || !timeline || !task || !rangeStart) {
        return;
      }
      bar.classList.add("is-resizing");
      let nextStart = task.start_date;
      let nextEnd = task.end_date;

      const onMove = (moveEvent) => {
        const dateValue = taskDateFromTimelinePointer(timeline, moveEvent.clientX);
        if (!dateValue) {
          return;
        }
        if (edge === "start") {
          nextStart = dateValue > nextEnd ? nextEnd : dateValue;
        } else {
          nextEnd = dateValue < nextStart ? nextStart : dateValue;
        }
        updateTaskTimelineBarPreview(bar, nextStart, nextEnd, rangeStart);
      };

      const onUp = async () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        bar.classList.remove("is-resizing");
        taskTimelineResizeJustEnded = true;
        window.setTimeout(() => {
          taskTimelineResizeJustEnded = false;
        }, 120);
        if (nextStart === task.start_date && nextEnd === task.end_date) {
          return;
        }
        await api(`/api/tasks/${encodeURIComponent(task.id)}`, {
          method: "PATCH",
          body: JSON.stringify({ start_date: nextStart, end_date: nextEnd }),
        });
        renderTasks();
      };

      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    });
  });
}

function taskDateFromTimelinePointer(timeline, clientX) {
  const rangeStart = parseDateValue(timeline?.dataset.taskRangeStart);
  const dayCount = Number(timeline?.dataset.taskDayCount || 0);
  if (!rangeStart || !dayCount) {
    return "";
  }
  const rect = timeline.getBoundingClientRect();
  const rawIndex = Math.floor((clientX - rect.left) / TASK_GANTT_DAY_WIDTH);
  const index = Math.max(0, Math.min(dayCount - 1, rawIndex));
  return toDateInputValue(addDays(rangeStart, index));
}

function updateTaskTimelineBarPreview(bar, startValue, endValue, rangeStart) {
  const start = parseDateValue(startValue);
  const end = parseDateValue(endValue);
  const left = taskDateIndex(start, rangeStart);
  const span = taskDateSpan(start, end, rangeStart);
  bar.style.left = `${left * TASK_GANTT_DAY_WIDTH + 4}px`;
  bar.style.width = `${Math.max(18, span * TASK_GANTT_DAY_WIDTH - 8)}px`;
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
    projectInfoEditOpen = false;
    renderProjects();
  });
  document.querySelectorAll("[data-project-open]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedProjectId = button.dataset.projectOpen;
      projectCreateDialogOpen = false;
      projectDetailTab = "meetings";
      selectedProjectResourceId = null;
      projectResourceMode = "view";
      projectInfoEditOpen = false;
      renderProjects();
    });
  });
  setupProjectCreateDialog();
  setupProjectWorkspaceDialog(selectedProject);
}

async function projectWorkspaceDialog(project) {
  const projectId = encodeURIComponent(project.id);
  const [{ items: meetings }, { items: projectFiles }, { items: projectRecords }] = await Promise.all([
    api(`/api/meetings?project_id=${projectId}`),
    api(`/api/project-files?project_id=${projectId}`),
    api(`/api/project-records?project_id=${projectId}`),
  ]);
  const items = projectItemsForTab(projectDetailTab, { meetings, projectFiles, projectRecords });
  if (projectResourceMode !== "new" && selectedProjectResourceId && !items.some((item) => item.id === selectedProjectResourceId)) {
    selectedProjectResourceId = null;
    if (projectDetailTab === "records") {
      projectResourceMode = "view";
    }
  }
  if (projectDetailTab !== "records" && projectResourceMode !== "new" && !selectedProjectResourceId && items.length) {
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
            <button class="secondary" type="button" data-project-info-edit>프로젝트 수정</button>
            <span class="badge">${escapeHtml(projectStatusLabel(project.status))}</span>
            <button class="icon-button" type="button" data-project-detail-close aria-label="닫기">X</button>
          </div>
        </div>
        <div class="project-dialog-body">
          ${projectResourceTabs(meetings.length, projectFiles.length, projectRecords.length)}
          ${
            projectDetailTab === "records"
              ? projectRecordWorkspace(projectRecords, projectResourceMode === "edit" ? selectedItem : null)
              : `
                <section class="project-resource-layout">
                  <aside class="project-resource-list">
                    <div class="section-head">
                      <h2>${projectResourceLabel()}</h2>
                      <button class="add-button small-add-button" type="button" data-project-resource-new aria-label="${projectDetailTab === "files" ? "파일 업로드" : "새 글 작성"}">+</button>
                    </div>
                    ${projectResourceList(items)}
                  </aside>
                  <section class="project-resource-detail">
                    ${projectResourceDetail(selectedItem)}
                  </section>
                </section>
              `
          }
        </div>
        ${projectInfoEditOpen ? projectInfoEditDialog(project) : ""}
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
      projectInfoEditOpen = false;
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
      if (projectDetailTab === "files") {
        document.querySelector("[data-project-file-input]")?.click();
        return;
      }
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
  document.querySelector("[data-project-info-edit]")?.addEventListener("click", () => {
    projectInfoEditOpen = true;
    renderProjects();
  });
  document.querySelector(".project-info-edit-dialog")?.addEventListener("click", (event) => {
    event.stopPropagation();
  });
  document.querySelectorAll("[data-project-info-cancel]").forEach((control) => {
    control.addEventListener("click", () => {
      projectInfoEditOpen = false;
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
    const isFile = projectDetailTab === "files";
    const isRecord = projectDetailTab === "records";
    const confirmText = isFile ? "선택한 자료를 삭제할까요?" : isRecord ? "선택한 기록을 삭제할까요?" : "선택한 글을 삭제할까요?";
    if (!selectedProjectResourceId || !confirm(confirmText)) {
      return;
    }
    const path = isFile
      ? `/api/project-files/${encodeURIComponent(selectedProjectResourceId)}`
      : isRecord
        ? `/api/project-records/${encodeURIComponent(selectedProjectResourceId)}`
        : `/api/meetings/${encodeURIComponent(selectedProjectResourceId)}`;
    await api(path, { method: "DELETE" });
    selectedProjectResourceId = null;
    projectResourceMode = "view";
    renderProjects();
  });
  document.querySelectorAll("[data-project-record-edit]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedProjectResourceId = button.dataset.projectRecordEdit;
      projectResourceMode = "edit";
      renderProjects();
    });
  });
  document.querySelectorAll("[data-project-record-delete]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (!confirm("선택한 기록을 삭제할까요?")) {
        return;
      }
      await api(`/api/project-records/${encodeURIComponent(button.dataset.projectRecordDelete)}`, { method: "DELETE" });
      if (selectedProjectResourceId === button.dataset.projectRecordDelete) {
        selectedProjectResourceId = null;
        projectResourceMode = "view";
      }
      renderProjects();
    });
  });
  document.querySelector("#project-info-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") || "").trim();
    if (!name) {
      event.currentTarget.querySelector("input[name='name']")?.focus();
      return;
    }
    const updated = await api(`/api/projects/${encodeURIComponent(project.id)}`, {
      method: "PATCH",
      body: JSON.stringify({
        company_name: String(form.get("company_name") || "").trim(),
        name,
        owner: String(form.get("owner") || "").trim(),
        status: form.get("status") || "active",
      }),
    });
    selectedProjectId = updated.id;
    projectInfoEditOpen = false;
    renderProjects();
  });
  if (projectInfoEditOpen) {
    document.querySelector("#project-info-form input[name='company_name']")?.focus();
  }
  setupResourceListScroller(document.querySelector(".project-detail-dialog"));
  setupProjectFileUpload(project);
  setupInlineImageEditors(document.querySelector(".project-detail-dialog"));
  document.querySelector("#project-resource-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (projectDetailTab === "files") {
      return;
    }
    const formEl = event.currentTarget;
    syncRichTextEditors(formEl);
    const form = new FormData(formEl);
    const isEdit = projectResourceMode === "edit" && selectedProjectResourceId;
    const isRecord = projectDetailTab === "records";
    const bodyContent = String(form.get(isRecord ? "content" : "notes") || "");
    if (isRecord && !bodyContent.trim()) {
      formEl.querySelector("[name='content']")?.focus();
      return;
    }
    const images = imagesReferencedInContent(uniqueImages([...existingFormImages(form), ...uploadedInlineImages(formEl)]), bodyContent);
    const payload = isRecord
      ? {
          project_id: project.id,
          title: projectRecordTitleFromContent(bodyContent),
          content: form.get("content") || "",
          images: [],
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
    const path = isRecord
      ? isEdit
        ? `/api/project-records/${encodeURIComponent(selectedProjectResourceId)}`
        : "/api/project-records"
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
    projectInfoEditOpen = false;
    renderProjects();
  }
}

function setupProjectFileUpload(project) {
  if (projectDetailTab !== "files") {
    return;
  }
  const dropzone = document.querySelector("[data-project-file-dropzone]");
  const input = document.querySelector("[data-project-file-input]");
  if (!dropzone || !input) {
    return;
  }
  const uploadSelectedFiles = async (files) => {
    const selectedFiles = [...(files || [])].filter(Boolean);
    if (!selectedFiles.length) {
      return;
    }
    dropzone.classList.add("is-uploading");
    try {
      const savedItems = [];
      for (const file of selectedFiles) {
        savedItems.push(await uploadProjectFile(project.id, file));
      }
      const lastSaved = savedItems[savedItems.length - 1];
      selectedProjectResourceId = lastSaved?.id || selectedProjectResourceId;
      projectResourceMode = "view";
      await renderProjects();
    } catch (error) {
      alert(error.message || "파일 업로드에 실패했습니다.");
    } finally {
      dropzone.classList.remove("is-uploading", "is-drag-over");
    }
  };

  dropzone.addEventListener("click", (event) => {
    if (event.target === input) {
      return;
    }
    input.click();
  });
  dropzone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      input.click();
    }
  });
  input.addEventListener("change", async () => {
    await uploadSelectedFiles(input.files);
    input.value = "";
  });
  ["dragenter", "dragover"].forEach((eventName) => {
    dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropzone.classList.add("is-drag-over");
    });
  });
  ["dragleave", "drop"].forEach((eventName) => {
    dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropzone.classList.remove("is-drag-over");
    });
  });
  dropzone.addEventListener("drop", async (event) => {
    await uploadSelectedFiles(event.dataTransfer?.files);
  });
}

async function uploadProjectFile(projectId, file) {
  const dataUrl = await fileToDataUrl(file);
  return api("/api/project-files", {
    method: "POST",
    body: JSON.stringify({
      project_id: projectId,
      filename: file.name || "file",
      content_type: file.type || "application/octet-stream",
      data_url: dataUrl,
    }),
  });
}

function setupResourceListScroller(root = document) {
  const scroller = root?.querySelector("[data-resource-list-scroll]");
  const button = root?.querySelector("[data-resource-scroll-jump]");
  if (!scroller || !button) {
    return;
  }
  const update = () => {
    const maxScroll = scroller.scrollHeight - scroller.clientHeight;
    const hasMore = maxScroll > 2;
    button.classList.toggle("is-hidden", !hasMore);
    if (!hasMore) {
      return;
    }
    const atBottom = scroller.scrollTop >= maxScroll - 2;
    button.dataset.resourceScrollDirection = atBottom ? "top" : "down";
    button.textContent = atBottom ? "↑" : "↓";
    button.setAttribute("aria-label", atBottom ? "맨 위로 이동" : "아래 항목 더 보기");
  };
  scroller.addEventListener("scroll", update, { passive: true });
  button.addEventListener("click", () => {
    if (button.dataset.resourceScrollDirection === "top") {
      scroller.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    scroller.scrollBy({ top: Math.max(160, scroller.clientHeight * 0.8), behavior: "smooth" });
  });
  requestAnimationFrame(update);
  setTimeout(update, 0);
}

function projectInfoEditDialog(project) {
  return `
    <div class="project-info-edit-layer" data-project-info-cancel>
      <section class="project-info-edit-dialog" role="dialog" aria-modal="true" aria-labelledby="project-info-edit-title">
        <div class="modal-head">
          <div>
            <p class="eyebrow">프로젝트 정보</p>
            <h2 id="project-info-edit-title">프로젝트 수정</h2>
          </div>
          <button class="icon-button" type="button" data-project-info-cancel aria-label="닫기">X</button>
        </div>
        <form class="form project-info-form" id="project-info-form">
          <label>회사명<input name="company_name" maxlength="120" autocomplete="off" value="${escapeHtml(project.company_name || "")}" /></label>
          <label>프로젝트명<input name="name" required maxlength="120" autocomplete="off" value="${escapeHtml(project.name || "")}" /></label>
          <label>담당자<input name="owner" autocomplete="off" value="${escapeHtml(project.owner || "")}" /></label>
          <label>상태<select name="status">${projectStatusOptions(project.status)}</select></label>
          <div class="project-info-edit-actions">
            <button class="secondary" type="button" data-project-info-cancel>취소</button>
            <button type="submit">저장</button>
          </div>
        </form>
      </section>
    </div>
  `;
}

function projectItemsForTab(tab, resources) {
  if (tab === "files") {
    return resources.projectFiles;
  }
  if (tab === "records") {
    return resources.projectRecords;
  }
  return resources.meetings;
}

function projectResourceLabel() {
  return {
    meetings: "회의록",
    files: "자료",
    records: "기록",
  }[projectDetailTab] || "회의록";
}

function projectResourceTabs(meetingCount, fileCount, recordCount) {
  return `
    <div class="project-page-tabs" role="tablist" aria-label="프로젝트 자료">
      <button class="project-page-tab ${projectDetailTab === "meetings" ? "active" : ""}" type="button" data-project-tab="meetings" role="tab" aria-selected="${projectDetailTab === "meetings"}">
        회의록 <span>${meetingCount}</span>
      </button>
      <button class="project-page-tab ${projectDetailTab === "files" ? "active" : ""}" type="button" data-project-tab="files" role="tab" aria-selected="${projectDetailTab === "files"}">
        자료 <span>${fileCount}</span>
      </button>
      <button class="project-page-tab ${projectDetailTab === "records" ? "active" : ""}" type="button" data-project-tab="records" role="tab" aria-selected="${projectDetailTab === "records"}">
        기록 <span>${recordCount}</span>
      </button>
    </div>
  `;
}

function projectResourceList(items) {
  if (!items.length) {
    const emptyText = {
      files: "업로드된 자료가 없습니다.",
      records: "등록된 기록이 없습니다.",
    }[projectDetailTab] || "등록된 글이 없습니다.";
    return `<p class="empty">${emptyText}</p>`;
  }
  return `
    <div class="resource-list-shell">
      <div class="resource-list resource-list-scroll" data-resource-list-scroll>
        ${items.map(projectResourceListItem).join("")}
      </div>
      <button class="resource-scroll-jump is-hidden" type="button" data-resource-scroll-jump aria-label="아래 항목 더 보기">↓</button>
    </div>
  `;
}

function projectResourceListItem(item) {
  const isSelected = item.id === selectedProjectResourceId && projectResourceMode !== "new";
  if (projectDetailTab === "files") {
    const meta = [formatFileSize(item.size), formatDateTime(item.updated_at)].filter(Boolean).join(" · ");
    return `
      <a class="resource-list-item file-list-item ${isSelected ? "active" : ""}" href="${escapeHtml(projectFileDownloadUrl(item))}" download>
        <strong>${escapeHtml(projectFileName(item))}</strong>
        <span>${escapeHtml(meta)}</span>
      </a>
    `;
  }
  const meta = projectDetailTab === "records" ? formatDateTime(item.updated_at) : [item.date, item.start_time || "시간 미정"].filter(Boolean).join(" · ");
  return `
    <button class="resource-list-item ${isSelected ? "active" : ""}" type="button" data-project-resource-id="${escapeHtml(item.id)}">
      <strong>${escapeHtml(item.title)}</strong>
      <span>${escapeHtml(meta)}</span>
    </button>
  `;
}

function projectResourceDetail(item) {
  if (projectDetailTab === "files") {
    return projectFileDetail(item);
  }
  if (projectDetailTab === "records") {
    if (projectResourceMode === "new") {
      return projectRecordForm();
    }
    if (projectResourceMode === "edit" && item) {
      return projectRecordForm(item);
    }
    if (!item) {
      return `
        <div class="resource-empty">
          <p class="empty">선택된 기록이 없습니다.</p>
        </div>
      `;
    }
    return projectRecordView(item);
  }
  if (projectResourceMode === "new") {
    return meetingResourceForm();
  }
  if (projectResourceMode === "edit" && item) {
    return meetingResourceForm(item);
  }
  if (!item) {
    return `
      <div class="resource-empty">
        <p class="empty">선택된 글이 없습니다.</p>
      </div>
    `;
  }
  return meetingResourceView(item);
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

function projectRecordWorkspace(items, editItem = null) {
  return `
    <section class="project-record-layout">
      <aside class="project-record-compose">
        <div class="section-head">
          <h2>${editItem ? "기록 수정" : "기록 작성"}</h2>
        </div>
        ${projectRecordForm(editItem)}
      </aside>
      <section class="project-record-feed">
        <div class="section-head">
          <h2>기록 목록</h2>
          <span class="badge">${items.length}</span>
        </div>
        ${projectRecordFeed(items)}
      </section>
    </section>
  `;
}

function projectRecordForm(item = null) {
  const submitLabel = item ? "기록 수정" : "기록 저장";
  return `
    <form class="record-compose-form" id="project-resource-form">
      <label class="record-compose-label">기록
        <textarea class="record-compose-textarea" name="content" required placeholder="프로젝트 진행 중 남겨둘 내용을 적어주세요.">${escapeHtml(projectRecordPlainContent(item))}</textarea>
      </label>
      <div class="resource-form-actions">
        ${item ? `<button class="secondary" type="button" data-project-resource-cancel>취소</button>` : ""}
        <button type="submit">${submitLabel}</button>
      </div>
    </form>
  `;
}

function projectRecordFeed(items) {
  if (!items.length) {
    return `<p class="empty">등록된 기록이 없습니다.</p>`;
  }
  return `<div class="record-feed-list">${items.map(projectRecordFeedItem).join("")}</div>`;
}

function projectRecordFeedItem(item) {
  const isEditing = projectResourceMode === "edit" && selectedProjectResourceId === item.id;
  return `
    <article class="record-feed-item ${isEditing ? "active" : ""}">
      <div class="record-feed-head">
        <time>${escapeHtml(formatDateTime(item.created_at))}</time>
        <div class="record-feed-actions">
          <button class="secondary" type="button" data-project-record-edit="${escapeHtml(item.id)}">수정</button>
          <button class="danger-button" type="button" data-project-record-delete="${escapeHtml(item.id)}">삭제</button>
        </div>
      </div>
      <p>${escapeHtml(projectRecordPlainContent(item))}</p>
    </article>
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

function projectRecordView(item) {
  return `
    <article class="resource-reader">
      <div class="resource-reader-actions">
        <button class="secondary" type="button" data-project-resource-edit>수정</button>
        <button class="danger-button" type="button" data-project-resource-delete>삭제</button>
      </div>
      <p class="eyebrow">기록</p>
      <h3>${escapeHtml(item.title)}</h3>
      <dl class="resource-meta">
        <dt>작성</dt><dd>${escapeHtml(formatDateTime(item.created_at))}</dd>
        <dt>수정</dt><dd>${escapeHtml(formatDateTime(item.updated_at))}</dd>
      </dl>
      ${resourceBlock("기록 내용", noteContentWithImages(item))}
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

function projectFileDetail(item) {
  if (!item) {
    return `
      <div class="file-resource-panel">
        ${projectFileDropzone()}
      </div>
    `;
  }
  return `
    <article class="resource-reader file-resource-reader">
      <div class="resource-reader-actions">
        <a class="button-link secondary" href="${escapeHtml(projectFileDownloadUrl(item))}" download>다운로드</a>
        <button class="danger-button" type="button" data-project-resource-delete>삭제</button>
      </div>
      <p class="eyebrow">자료</p>
      <h3>${escapeHtml(projectFileName(item))}</h3>
      <dl class="resource-meta">
        <dt>크기</dt><dd>${escapeHtml(formatFileSize(item.size))}</dd>
        <dt>형식</dt><dd>${escapeHtml(item.content_type || "application/octet-stream")}</dd>
        <dt>업로드</dt><dd>${escapeHtml(formatDateTime(item.created_at || item.updated_at))}</dd>
      </dl>
      ${projectFileDropzone()}
    </article>
  `;
}

function projectFileDropzone() {
  return `
    <section class="file-dropzone" data-project-file-dropzone tabindex="0" role="button" aria-label="자료 파일 업로드">
      <input class="project-file-input" type="file" multiple data-project-file-input />
      <strong>파일을 끌어놓거나 클릭해서 업로드</strong>
      <span>문서, 이미지, 압축파일 등 모든 형식을 등록할 수 있습니다.</span>
    </section>
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

function projectRecordPlainContent(item) {
  return notePlainContent(item);
}

function projectRecordTitleFromContent(content) {
  const firstLine = String(content || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) {
    return `기록 ${formatDateTime(new Date().toISOString())}`;
  }
  return firstLine.slice(0, 80);
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
  root.addEventListener("pointerdown", (event) => {
    const handle = event.target.closest("[data-image-resize-handle]");
    if (!handle || !root.contains(handle)) {
      return;
    }
    startEditorImageResize(event, handle);
  });
  root.querySelectorAll("[data-image-resize-handle]").forEach((handle) => {
    handle.addEventListener("pointerdown", (event) => {
      startEditorImageResize(event, handle);
    });
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
      <div class="editor-image-frame" style="width: ${width}%;">
        <img src="${escapeHtml(safeUrl)}" alt="${escapeHtml(alt)}" loading="lazy" />
        <button class="editor-image-resize-handle top-left" type="button" data-image-resize-handle="left" aria-label="이미지 크기 조절"></button>
        <button class="editor-image-resize-handle top-right" type="button" data-image-resize-handle="right" aria-label="이미지 크기 조절"></button>
        <button class="editor-image-resize-handle bottom-left" type="button" data-image-resize-handle="left" aria-label="이미지 크기 조절"></button>
        <button class="editor-image-resize-handle bottom-right" type="button" data-image-resize-handle="right" aria-label="이미지 크기 조절"></button>
      </div>
      <figcaption>${escapeHtml(alt)}</figcaption>
      <div class="editor-image-controls">
        <span>${width}%</span>
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
    const node = htmlToElement(editorImageHtml({ ...image, width: image?.width ?? 60 }));
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
  setEditorImageWidth(figure, nextWidth);
}

function startEditorImageResize(event, handle) {
  const figure = handle.closest(".editor-rich-image");
  const surface = figure?.closest("[data-rich-editor]");
  if (!figure || !surface) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  const figureRect = figure.getBoundingClientRect();
  const figureStyle = window.getComputedStyle(figure);
  const horizontalPadding = parseFloat(figureStyle.paddingLeft || "0") + parseFloat(figureStyle.paddingRight || "0");
  const availableWidth = Math.max(1, figureRect.width - horizontalPadding);
  activeImageResize = {
    figure,
    surface,
    startX: event.clientX,
    startWidth: Number(figure.dataset.width || 100),
    availableWidth,
    side: handle.dataset.imageResizeHandle === "left" ? "left" : "right",
  };
  figure.classList.add("is-resizing");
  handle.setPointerCapture?.(event.pointerId);
  window.addEventListener("pointermove", moveEditorImageResize);
  window.addEventListener("pointerup", finishEditorImageResize, { once: true });
  window.addEventListener("pointercancel", finishEditorImageResize, { once: true });
}

function moveEditorImageResize(event) {
  if (!activeImageResize) {
    return;
  }
  event.preventDefault();
  const direction = activeImageResize.side === "left" ? -1 : 1;
  const deltaPercent = (((event.clientX - activeImageResize.startX) * direction) / activeImageResize.availableWidth) * 100;
  setEditorImageWidth(activeImageResize.figure, activeImageResize.startWidth + deltaPercent);
}

function finishEditorImageResize() {
  if (!activeImageResize) {
    return;
  }
  activeImageResize.figure.classList.remove("is-resizing");
  syncRichTextEditor(activeImageResize.surface);
  activeImageResize = null;
  window.removeEventListener("pointermove", moveEditorImageResize);
  window.removeEventListener("pointerup", finishEditorImageResize);
  window.removeEventListener("pointercancel", finishEditorImageResize);
}

function setEditorImageWidth(figure, width) {
  if (!figure) {
    return;
  }
  const nextWidth = clampImageWidth(width);
  figure.dataset.width = String(nextWidth);
  figure.querySelector(".editor-image-frame")?.style.setProperty("width", `${nextWidth}%`);
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
  return Math.max(15, Math.min(100, Math.round(number)));
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
      reject(new Error("파일을 읽지 못했습니다."));
    });
    reader.addEventListener("error", () => reject(reader.error || new Error("파일을 읽지 못했습니다.")));
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
    projectInfoEditOpen = false;
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

function dashboardDayPanel(label, day, absenceEventCount) {
  const dateText = day?.date ? formatDateLabel(day.date) : "";
  return `
    <section class="panel dashboard-day-panel">
      <div class="section-head">
        <div>
          <p class="eyebrow">${escapeHtml(label)}</p>
          <h2>${escapeHtml(dateText || label)}</h2>
        </div>
        <span class="badge">부재 ${absenceEventCount || 0}건 · 회의 ${(day?.meetings || []).length}건</span>
      </div>
      <div class="dashboard-day-content">
        <section class="dashboard-focus-block">
          <h3>휴가/부재</h3>
          ${absenceOverview(day?.absences || [], `${label} 등록된 휴가/부재 일정이 없습니다.`)}
        </section>
        <section class="dashboard-focus-block">
          <h3>회의</h3>
          ${dashboardMeetingList(day?.meetings || [], `${label} 등록된 회의가 없습니다.`)}
        </section>
      </div>
    </section>
  `;
}

function dashboardScheduleBlock(title, items) {
  return `
    <section class="dashboard-focus-block">
      <h3>${escapeHtml(title)}</h3>
      ${rows(items, eventSummary)}
    </section>
  `;
}

function dashboardMeetingList(items, emptyText) {
  if (!items.length) {
    return `<p class="empty">${escapeHtml(emptyText || "표시할 회의가 없습니다.")}</p>`;
  }
  return `<div class="list">${items.map((item) => `<div class="row">${dashboardMeetingSummary(item)}</div>`).join("")}</div>`;
}

function dashboardMeetingSummary(item) {
  const attendees = Array.isArray(item.attendees) ? item.attendees.join(", ") : "";
  const time = item.start_time || "시간 미정";
  const meta = [time, attendees || "참석자 미정"].filter(Boolean).join(" · ");
  return `<div class="row-main"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(meta)}</span></div><span class="badge">회의록</span>`;
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

function absenceOverview(items, emptyText = "오늘 등록된 휴가/부재 일정이 없습니다.") {
  if (!items.length) {
    return `<p class="empty">${escapeHtml(emptyText)}</p>`;
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

function taskGantt(tasks, projects) {
  const range = taskGanttRange(tasks);
  const days = taskGanttDays(range.start, range.end);
  const groups = taskGanttGroups(tasks, projects);
  const rows = taskGanttRows(groups, range);
  const todayIndex = dateDiffDays(range.start, new Date(`${toDateInputValue(new Date())}T00:00:00`));
  if (!tasks.length) {
    return `<div class="task-gantt-empty"><p class="empty">등록된 작업이 없습니다. 아래에서 첫 작업을 등록하세요.</p></div>`;
  }
  const rowTemplate = `40px 40px repeat(${rows.length}, 56px)`;
  return `
    <div class="task-gantt" style="--task-day-count:${days.length}; --task-day-width:${TASK_GANTT_DAY_WIDTH}px; --task-left-width:${TASK_GANTT_LEFT_WIDTH}px;">
      <div class="task-gantt-scroll" data-task-today-index="${todayIndex}" data-task-range-start="${toDateInputValue(range.start)}" data-task-day-count="${days.length}">
        <div class="task-gantt-grid" style="min-width:${TASK_GANTT_LEFT_WIDTH + days.length * TASK_GANTT_DAY_WIDTH}px; grid-template-columns: var(--task-left-width) repeat(${days.length}, var(--task-day-width)); grid-template-rows:${rowTemplate};">
          <div class="task-left-header" style="grid-row:1 / 3;">업무</div>
          <div class="task-month-header" style="grid-column:2 / -1;">${taskMonthHeader(days)}</div>
          <div class="task-day-header" style="grid-column:2 / -1;">${taskDayHeader(days)}</div>
          ${rows
            .map((row, index) => {
              const gridRow = index + 3;
              const rowAttrs = taskRowDataAttrs(row);
              const selectedClass = row.taskId && row.taskId === taskDetailId ? " is-selected" : "";
              const timelineAttrs = row.taskId
                ? `data-task-range-start="${toDateInputValue(range.start)}" data-task-day-count="${days.length}"`
                : "";
              return `
                <div class="task-left-cell ${row.type === "group" ? "is-group" : "is-task"}${selectedClass}" ${rowAttrs} style="grid-row:${gridRow};">${row.left}</div>
                <div class="task-timeline-cell ${row.type === "group" ? "is-group" : "is-task"}${selectedClass}" ${rowAttrs} ${timelineAttrs} style="grid-column:2 / -1; grid-row:${gridRow};">
                  ${todayIndex >= 0 && todayIndex < days.length ? `<span class="task-today-line" style="left:${todayIndex * TASK_GANTT_DAY_WIDTH}px;"></span>` : ""}
                  ${row.bar}
                </div>
              `;
            })
            .join("")}
        </div>
      </div>
    </div>
  `;
}

function taskGanttRange(tasks) {
  const today = new Date(`${toDateInputValue(new Date())}T00:00:00`);
  const validTasks = tasks
    .map((item) => ({ start: parseDateValue(item.start_date), end: parseDateValue(item.end_date) }))
    .filter((item) => item.start && item.end);
  let start = today;
  let end = addDays(today, 27);
  if (validTasks.length) {
    start = validTasks.reduce((min, item) => minDate(min, item.start), today);
    end = validTasks.reduce((max, item) => maxDate(max, item.end), today);
  }
  start = startOfWeek(addDays(start, -2));
  end = addDays(end, 7);
  if (dateDiffDays(start, end) < 28) {
    end = addDays(start, 28);
  }
  return { start, end };
}

function taskGanttDays(start, end) {
  const days = [];
  let cursor = new Date(start);
  while (cursor <= end) {
    days.push(new Date(cursor));
    cursor = addDays(cursor, 1);
  }
  return days;
}

function taskMonthHeader(days) {
  const segments = [];
  let startIndex = 0;
  for (let index = 1; index <= days.length; index += 1) {
    const current = days[index];
    const previous = days[index - 1];
    if (!current || current.getMonth() !== previous.getMonth() || current.getFullYear() !== previous.getFullYear()) {
      segments.push({ start: startIndex + 1, span: index - startIndex, label: taskMonthLabel(previous) });
      startIndex = index;
    }
  }
  return segments.map((segment) => `<span style="grid-column:${segment.start} / span ${segment.span};">${escapeHtml(segment.label)}</span>`).join("");
}

function taskDayHeader(days) {
  const today = toDateInputValue(new Date());
  return days
    .map((day) => {
      const value = toDateInputValue(day);
      return `<span class="${value === today ? "is-today" : ""}">${day.getDate()}</span>`;
    })
    .join("");
}

function taskMonthLabel(dateValue) {
  return dateValue.toLocaleDateString("en-US", { month: "short" });
}

function taskGanttGroups(tasks, projects) {
  const projectMap = new Map(projects.map((project) => [project.id, project]));
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const groups = [];
  const byProject = tasks.reduce((acc, task) => {
    const key = task.project_id || "__unassigned__";
    if (!acc.has(key)) {
      acc.set(key, []);
    }
    acc.get(key).push(task);
    return acc;
  }, new Map());

  projects.forEach((project) => {
    const groupTasks = byProject.get(project.id) || [];
    if (groupTasks.length) {
      groups.push({ id: `project:${project.id}`, projectId: project.id, title: project.name, company: project.company_name || "", tasks: sortTasks(groupTasks) });
    }
  });

  byProject.forEach((groupTasks, key) => {
    if (key === "__unassigned__") {
      groups.push({ id: "project:__unassigned__", projectId: "", title: "프로젝트 미지정", company: "", tasks: sortTasks(groupTasks) });
      return;
    }
    if (!projectMap.has(key)) {
      groups.push({ id: `project:${key}`, projectId: key, title: "알 수 없는 프로젝트", company: "", tasks: sortTasks(groupTasks) });
    }
  });

  return groups.map((group) => ({
    ...group,
    tree: taskTreeForGroup(group.tasks, group.projectId, taskById),
  }));
}

function taskGanttRows(groups, range) {
  return groups.flatMap((group) => {
    const collapsed = collapsedTaskGroups.has(group.id);
    const groupDates = taskRangeForItems(group.tasks);
    const rows = [
      {
        type: "group",
        leftIndex: taskDateIndex(groupDates.start, range.start),
        span: taskDateSpan(groupDates.start, groupDates.end, range.start),
        left: taskGroupLeft(group, collapsed),
        bar: taskBar("group", groupDates.start, groupDates.end, range.start, `${group.title} 기간`),
        dropType: "project",
        groupId: group.id,
        projectId: group.projectId || "",
      },
    ];
    if (!collapsed) {
      rows.push(...taskTreeRows(group.tree.roots, group.tree.childrenByParent, range, 0));
    }
    return rows;
  });
}

function taskTreeForGroup(tasks, projectId, taskById) {
  const childrenByParent = new Map();
  const roots = [];
  tasks.forEach((task) => {
    const parentId = task.parent_id || "";
    const parent = parentId ? taskById.get(parentId) : null;
    if (parent && (parent.project_id || "") === projectId) {
      if (!childrenByParent.has(parentId)) {
        childrenByParent.set(parentId, []);
      }
      childrenByParent.get(parentId).push(task);
      return;
    }
    roots.push(task);
  });
  childrenByParent.forEach((items) => items.sort(compareTasks));
  roots.sort(compareTasks);
  return { roots, childrenByParent };
}

function taskTreeRows(tasks, childrenByParent, range, level) {
  return tasks.flatMap((task) => {
    const children = childrenByParent.get(task.id) || [];
    const collapsed = collapsedTaskGroups.has(`task:${task.id}`);
    const rows = [
      {
        type: "task",
        taskId: task.id,
        projectId: task.project_id || "",
        parentId: task.parent_id || "",
        dropType: "task",
        leftIndex: taskDateIndex(parseDateValue(task.start_date), range.start),
        span: taskDateSpan(parseDateValue(task.start_date), parseDateValue(task.end_date), range.start),
        left: taskRowLeft(task, level, children.length, collapsed),
        bar: taskBar("task", parseDateValue(task.start_date), parseDateValue(task.end_date), range.start, taskPeriodText(task), task),
      },
    ];
    if (children.length && !collapsed) {
      rows.push(...taskTreeRows(children, childrenByParent, range, level + 1));
    }
    return rows;
  });
}

function taskRowDataAttrs(row) {
  const attrs = [];
  if (row.dropType) {
    attrs.push(`data-task-drop-type="${escapeHtml(row.dropType)}"`);
    attrs.push(`data-task-drop-project="${escapeHtml(row.projectId || "")}"`);
  }
  if (row.taskId) {
    attrs.push(`data-task-row-id="${escapeHtml(row.taskId)}"`);
    attrs.push(`data-task-drop-task="${escapeHtml(row.taskId)}"`);
  }
  if (row.groupId) {
    attrs.push(`data-task-group-row="${escapeHtml(row.groupId)}"`);
  }
  return attrs.join(" ");
}

function sortTasks(tasks) {
  return [...tasks].sort(compareTasks);
}

function compareTasks(a, b) {
  return (
    taskOrderValue(a) - taskOrderValue(b) ||
    String(a.created_at || "").localeCompare(String(b.created_at || "")) ||
    String(a.title || "").localeCompare(String(b.title || "")) ||
    String(a.id || "").localeCompare(String(b.id || ""))
  );
}

function taskOrderValue(task) {
  const order = Number(task?.order);
  return Number.isFinite(order) ? order : 1_000_000;
}

function taskRangeForItems(items) {
  const valid = items
    .map((item) => ({ start: parseDateValue(item.start_date), end: parseDateValue(item.end_date) }))
    .filter((item) => item.start && item.end);
  if (!valid.length) {
    const today = new Date(`${toDateInputValue(new Date())}T00:00:00`);
    return { start: today, end: today };
  }
  return {
    start: valid.reduce((min, item) => minDate(min, item.start), valid[0].start),
    end: valid.reduce((max, item) => maxDate(max, item.end), valid[0].end),
  };
}

function taskGroupLeft(group, collapsed) {
  const doneCount = group.tasks.filter((task) => task.status === "done").length;
  const progress = group.tasks.length ? Math.round((doneCount / group.tasks.length) * 100) : 0;
  return `
    <div class="task-group-line">
      <input type="checkbox" disabled ${progress === 100 ? "checked" : ""} aria-label="프로젝트 완료 상태" />
      <button class="task-collapse ${collapsed ? "is-collapsed" : "is-expanded"}" type="button" data-task-group-toggle="${escapeHtml(group.id)}" aria-label="${collapsed ? "펼치기" : "접기"}" aria-expanded="${collapsed ? "false" : "true"}"><span class="task-collapse-icon" aria-hidden="true"></span></button>
      <span class="task-epic-icon">↯</span>
      <div class="task-group-title">
        <strong>${escapeHtml(group.title)}</strong>
        ${group.company ? `<span>${escapeHtml(group.company)}</span>` : ""}
        <div class="task-progress"><span style="width:${progress}%"></span></div>
      </div>
      <span class="task-group-count">${doneCount}/${group.tasks.length}</span>
      <button class="task-add-child-button" type="button" data-task-add-project="${escapeHtml(group.projectId || "")}" data-task-add-label="${escapeHtml(group.title)}" aria-label="하위 작업 추가">+</button>
    </div>
  `;
}

function taskPeriodText(task) {
  if (task.start_date === task.end_date) {
    return task.start_date;
  }
  return `${task.start_date} → ${task.end_date}`;
}

function taskDescriptionText(task) {
  return splitEventBody(task.body).content
    .replace(/^# .*(?:\r?\n|$)/, "")
    .trim();
}

function taskRowLeft(task, level, childCount, collapsed) {
  const checked = task.status === "done";
  const safeLevel = Math.min(Number(level) || 0, 8);
  return `
    <div class="task-row-line" style="--task-level:${safeLevel};">
      <span class="drag-handle task-drag-handle" draggable="true" data-task-drag="${escapeHtml(task.id)}" title="작업 이동" aria-label="작업 이동">⋮⋮</span>
      <input type="checkbox" data-task-done="${escapeHtml(task.id)}" ${checked ? "checked" : ""} aria-label="작업 완료" />
      ${
        childCount
          ? `<button class="task-collapse ${collapsed ? "is-collapsed" : "is-expanded"}" type="button" data-task-toggle="${escapeHtml(task.id)}" aria-label="${collapsed ? "펼치기" : "접기"}" aria-expanded="${collapsed ? "false" : "true"}"><span class="task-collapse-icon" aria-hidden="true"></span></button>`
          : `<span class="task-child-toggle-placeholder"></span>`
      }
      <div class="task-title-line">
        <strong class="${checked ? "is-done" : ""}">${escapeHtml(task.title)}</strong>
        <span>${escapeHtml(task.owner || "담당자 미정")} · ${escapeHtml(taskPeriodText(task))}</span>
      </div>
      <span class="task-status-pill status-${escapeHtml(task.status || "todo")}">${escapeHtml(statusLabel(task.status))}</span>
      <span class="task-row-actions">
        <button class="task-delete-button" type="button" data-task-delete="${escapeHtml(task.id)}" aria-label="작업 삭제">-</button>
        <button class="task-add-child-button" type="button" data-task-add-parent="${escapeHtml(task.id)}" aria-label="하위 작업 추가">+</button>
      </span>
    </div>
  `;
}

function taskDateIndex(dateValue, rangeStart) {
  if (!dateValue) {
    return 0;
  }
  return Math.max(0, dateDiffDays(rangeStart, dateValue));
}

function taskDateSpan(start, end, rangeStart) {
  if (!start || !end) {
    return 1;
  }
  return Math.max(1, dateDiffDays(rangeStart, end) - taskDateIndex(start, rangeStart) + 1);
}

function taskBar(type, start, end, rangeStart, label, task = null) {
  const left = taskDateIndex(start, rangeStart);
  const span = taskDateSpan(start, end, rangeStart);
  const leftPx = left * TASK_GANTT_DAY_WIDTH + 4;
  const widthPx = Math.max(18, span * TASK_GANTT_DAY_WIDTH - 8);
  const isGroup = type === "group";
  const classNames = ["task-gantt-bar", isGroup ? "is-group" : "is-task"];
  if (task) {
    classNames.push(`status-${task.status || "todo"}`);
  }
  return `
    <span class="${escapeHtml(classNames.join(" "))}" ${task ? `data-task-bar="${escapeHtml(task.id)}"` : ""} style="left:${leftPx}px; width:${widthPx}px;" title="${escapeHtml(label || "")}">
      ${
        task
          ? `<span class="task-bar-resize is-start" data-task-bar-resize="start" aria-label="시작일 조정"></span>
             <span class="task-bar-resize is-end" data-task-bar-resize="end" aria-label="종료일 조정"></span>`
          : ""
      }
    </span>
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

function projectOptions(projects, selectedId = "") {
  return projects
    .map((project) => {
      const label = project.company_name ? `${project.company_name} / ${project.name}` : project.name;
      return `<option value="${escapeHtml(project.id)}" ${project.id === selectedId ? "selected" : ""}>${escapeHtml(label)}</option>`;
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

function formatFileSize(value) {
  const size = Number(value);
  if (!Number.isFinite(size) || size < 0) {
    return "-";
  }
  const units = ["B", "KB", "MB", "GB"];
  let nextSize = size;
  let unitIndex = 0;
  while (nextSize >= 1024 && unitIndex < units.length - 1) {
    nextSize /= 1024;
    unitIndex += 1;
  }
  const digits = unitIndex === 0 || nextSize >= 10 ? 0 : 1;
  return `${nextSize.toFixed(digits)} ${units[unitIndex]}`;
}

function projectFileName(item) {
  return item?.filename || item?.title || "자료";
}

function projectFileDownloadUrl(item) {
  if (item?.id) {
    return `/api/project-files/${encodeURIComponent(item.id)}/download`;
  }
  const url = String(item?.url || "");
  return url.startsWith("/api/project-files/") ? url : "#";
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

function statusOptions(selected) {
  return ["todo", "in_progress", "review", "blocked", "done"]
    .map((value) => `<option value="${value}" ${value === selected ? "selected" : ""}>${escapeHtml(statusLabel(value))}</option>`)
    .join("");
}

function priorityLabel(value) {
  return {
    low: "낮음",
    normal: "보통",
    high: "높음",
    urgent: "긴급",
  }[value] || value || "보통";
}

function priorityOptions(selected) {
  return ["normal", "high", "urgent", "low"]
    .map((value) => `<option value="${value}" ${value === selected ? "selected" : ""}>${escapeHtml(priorityLabel(value))}</option>`)
    .join("");
}

function projectStatusLabel(value) {
  return {
    planning: "기획",
    active: "진행",
    paused: "보류",
    done: "완료",
  }[value] || value;
}

function projectStatusOptions(selected) {
  return ["planning", "active", "paused", "done"]
    .map((value) => `<option value="${value}" ${value === selected ? "selected" : ""}>${escapeHtml(projectStatusLabel(value))}</option>`)
    .join("");
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
