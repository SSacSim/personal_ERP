export function normalizeMenuOrder(defaults, saved) {
  return Object.fromEntries(Object.entries(defaults).map(([group, routes]) => {
    const preferred = Array.isArray(saved?.[group]) ? saved[group] : [];
    return [group, [...new Set([...preferred.filter((route) => routes.includes(route)), ...routes])]];
  }));
}

export function moveMenuItem(order, group, route, target, after = false) {
  const routes = order[group];
  // Membership comes from the fixed groups, never from a drop or saved setting.
  if (!routes?.includes(route) || !routes.includes(target) || route === target) return order;
  const moved = routes.filter((item) => item !== route);
  moved.splice(moved.indexOf(target) + (after ? 1 : 0), 0, route);
  return { ...order, [group]: moved };
}

export function setupSidebarOrder(nav, storageKey) {
  const groups = new Map([...nav.querySelectorAll("[data-menu-group]")].map((group) => [group.dataset.menuGroup, group]));
  const defaults = {};
  const rows = new Map();
  const status = document.createElement("span");
  status.className = "nav-sort-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  nav.append(status);

  for (const [name, group] of groups) {
    defaults[name] = [];
    for (const link of [...group.querySelectorAll("a[data-route]")]) {
      const route = link.dataset.route;
      defaults[name].push(route);
      const row = document.createElement("div");
      row.className = "nav-item";
      row.dataset.menuItem = route;
      const handle = document.createElement("button");
      handle.type = "button";
      handle.className = "nav-drag-handle";
      const label = link.textContent.trim();
      handle.setAttribute("aria-label", `${label} 순서 변경`);
      handle.title = "드래그하거나 방향키로 그룹 안에서 순서 변경";
      handle.innerHTML = '<svg viewBox="0 0 12 18" aria-hidden="true"><g fill="currentColor"><circle cx="3" cy="4" r="1.3"/><circle cx="9" cy="4" r="1.3"/><circle cx="3" cy="9" r="1.3"/><circle cx="9" cy="9" r="1.3"/><circle cx="3" cy="14" r="1.3"/><circle cx="9" cy="14" r="1.3"/></g></svg>';
      link.draggable = false;
      link.replaceWith(row);
      row.append(handle, link);
      rows.set(route, { row, handle, label, group: name });
    }
  }

  let order = normalizeMenuOrder(defaults, null);
  let dragging = null;
  let scrollFrame = null;
  const horizontal = () => window.matchMedia("(max-width: 760px)").matches;

  function apply() {
    for (const [name, group] of groups) {
      for (const route of order[name]) group.append(rows.get(route).row);
    }
  }

  function restore(raw) {
    let saved = null;
    try { saved = JSON.parse(raw); } catch { /* Invalid preferences use the default order. */ }
    order = normalizeMenuOrder(defaults, saved);
    apply();
  }

  try { restore(localStorage.getItem(storageKey)); } catch { apply(); }

  function commit(group, route, target, after) {
    const next = moveMenuItem(order, group, route, target, after);
    if (next === order || next[group].every((item, index) => item === order[group][index])) return;
    order = next;
    apply();
    const item = rows.get(route);
    item.handle.focus({ preventScroll: true });
    status.textContent = `${item.label}, ${group.toUpperCase()} 메뉴 ${order[group].indexOf(route) + 1}번째로 이동했습니다.`;
    try { localStorage.setItem(storageKey, JSON.stringify(order)); }
    catch { status.textContent += " 브라우저 저장이 불가능해 현재 화면에만 적용됩니다."; }
  }

  function clearTarget() {
    dragging?.target?.row.classList.remove("nav-drop-before", "nav-drop-after");
    if (dragging) dragging.target = null;
  }

  function updateTarget() {
    if (!dragging?.active) return;
    clearTarget();
    const hit = document.elementFromPoint(dragging.x, dragging.y);
    let targetRow = hit?.closest("[data-menu-item]");
    // The insertion line lies in the gap between rows; accept that gap too.
    if (!targetRow && hit?.closest("[data-menu-group]") === groups.get(dragging.group)) {
      const sideways = horizontal();
      const coordinate = sideways ? dragging.x : dragging.y;
      targetRow = order[dragging.group].map((route) => rows.get(route).row).reduce((nearest, row) => {
        const rect = row.getBoundingClientRect();
        const distance = Math.abs(coordinate - (sideways ? rect.left + rect.width / 2 : rect.top + rect.height / 2));
        return !nearest || distance < nearest.distance ? { row, distance } : nearest;
      }, null)?.row;
    }
    const target = targetRow ? rows.get(targetRow.dataset.menuItem) : null;
    const valid = target?.group === dragging.group;
    dragging.preview.classList.toggle("invalid", !valid);
    if (!valid || target.row === dragging.row) return;
    const rect = target.row.getBoundingClientRect();
    dragging.after = horizontal() ? dragging.x > rect.left + rect.width / 2 : dragging.y > rect.top + rect.height / 2;
    dragging.target = target;
    target.row.classList.add(dragging.after ? "nav-drop-after" : "nav-drop-before");
  }

  function autoScroll() {
    if (!dragging?.active) return;
    const sideways = horizontal();
    const scroller = sideways ? nav : nav.closest(".sidebar");
    const rect = scroller.getBoundingClientRect();
    const { x, y } = dragging;
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
      const coordinate = sideways ? x : y;
      const start = sideways ? rect.left : rect.top;
      const end = sideways ? rect.right : rect.bottom;
      const step = coordinate < start + 36 ? -8 : coordinate > end - 36 ? 8 : 0;
      if (step) {
        if (sideways) scroller.scrollLeft += step;
        else scroller.scrollTop += step;
        updateTarget();
      }
    }
    scrollFrame = requestAnimationFrame(autoScroll);
  }

  function finish(save = false) {
    if (!dragging) return;
    const state = dragging;
    clearTarget();
    dragging = null;
    cancelAnimationFrame(scrollFrame);
    state.row.classList.remove("nav-item-dragging");
    document.body.classList.remove("sidebar-sorting");
    state.preview?.remove();
    if (state.handle.hasPointerCapture(state.pointerId)) state.handle.releasePointerCapture(state.pointerId);
    if (save && state.active && state.dropTarget) {
      commit(state.group, state.route, state.dropTarget.row.dataset.menuItem, state.after);
    } else if (state.active) status.textContent = "메뉴 이동을 취소했습니다. 같은 그룹 안에 놓아 주세요.";
  }

  for (const [route, item] of rows) {
    const { handle, row, group, label } = item;
    handle.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); });
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || !event.isPrimary || dragging) return;
      event.preventDefault();
      handle.focus({ preventScroll: true });
      dragging = { route, row, group, handle, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
        x: event.clientX, y: event.clientY, active: false, target: null };
      handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener("pointermove", (event) => {
      if (!dragging || dragging.pointerId !== event.pointerId) return;
      dragging.x = event.clientX;
      dragging.y = event.clientY;
      if (!dragging.active && Math.hypot(event.clientX - dragging.startX, event.clientY - dragging.startY) < 5) return;
      if (!dragging.active) {
        dragging.active = true;
        row.classList.add("nav-item-dragging");
        document.body.classList.add("sidebar-sorting");
        dragging.preview = document.createElement("div");
        dragging.preview.className = "nav-drag-preview";
        dragging.preview.setAttribute("aria-hidden", "true");
        dragging.preview.textContent = label;
        document.body.append(dragging.preview);
        status.textContent = `${label} 이동 중. ${group.toUpperCase()} 그룹 안에 놓아 주세요. Escape 키로 취소합니다.`;
        scrollFrame = requestAnimationFrame(autoScroll);
      }
      dragging.preview.style.left = `${Math.max(8, Math.min(event.clientX + 12, window.innerWidth - 188))}px`;
      dragging.preview.style.top = `${Math.max(8, Math.min(event.clientY + 12, window.innerHeight - 48))}px`;
      updateTarget();
    });
    handle.addEventListener("pointerup", (event) => {
      if (!dragging || dragging.pointerId !== event.pointerId) return;
      dragging.x = event.clientX;
      dragging.y = event.clientY;
      updateTarget();
      dragging.dropTarget = dragging.target;
      finish(true);
    });
    handle.addEventListener("pointercancel", () => finish());
    handle.addEventListener("lostpointercapture", () => finish());
    handle.addEventListener("keydown", (event) => {
      const direction = { ArrowUp: -1, ArrowLeft: -1, ArrowDown: 1, ArrowRight: 1 }[event.key];
      if (!direction || dragging) return;
      event.preventDefault();
      const target = order[group][order[group].indexOf(route) + direction];
      if (target) commit(group, route, target, direction > 0);
    });
  }
  window.addEventListener("keydown", (event) => {
    if (dragging && event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); finish(); }
  });
  window.addEventListener("blur", () => finish());
  window.addEventListener("resize", () => finish());
  window.addEventListener("storage", (event) => {
    if (event.key === storageKey || event.key === null) { finish(); restore(event.key === null ? null : event.newValue); }
  });
}
