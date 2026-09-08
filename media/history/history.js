// Client of the Plastic SCM Graph view. Plain ES2020, no build step. The message
// contract is `HistoryWebviewMessage` / `HistoryExtensionMessage` in
// src/history/historyViewProvider.ts. Everything user-provided goes through
// textContent: this file never assigns innerHTML.
(function () {
  "use strict";

  const vscode = acquireVsCodeApi();

  const ROW_HEIGHT = 22;
  const LANE_WIDTH = 16;
  const LANE_PADDING = 8;
  const NODE_RADIUS = 4;
  const CURRENT_RADIUS = 5;
  const TAIL_HEIGHT = 11;
  const SVG_NS = "http://www.w3.org/2000/svg";
  const NAVIGATION_KEYS = new Set(["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End", "Enter", " "]);

  const root = document.getElementById("root");

  /** Last `state` message, verbatim. */
  let workspaces = [];
  let hasState = false;
  /** wkId -> Set of expanded changeset ids. */
  const expanded = new Map();
  /**
   * wkId -> changesetId -> { loading?, files?, error? }. A changeset's file list
   * never changes, so it is cached for the life of the page; only errors are retried.
   */
  const filesCache = new Map();
  /** Last error announced per workspace, so a live region is not re-read. */
  const announcedErrors = new Map();
  /** Scroll offset restored from the persisted state until real content is tall enough to hold it. */
  let pendingScrollTop = 0;
  let scrollRestored = false;
  /** Set while the client is scrolling itself, so the handler can tell the two apart. */
  let programmaticScroll = false;

  function scrollTo(top) {
    programmaticScroll = true;
    window.scrollTo(0, top);
    // The scroll event lands in a later task; clear the flag after it.
    setTimeout(() => {
      programmaticScroll = false;
    }, 0);
  }
  let saveStateTimer;
  let redrawFrame;

  // ---------------------------------------------------------------- persisted state

  function restoreState() {
    let state;
    try {
      state = vscode.getState();
    } catch (e) {
      return;
    }
    if (!state || typeof state !== "object") {
      return;
    }
    if (state.expanded && typeof state.expanded === "object") {
      for (const wkId of Object.keys(state.expanded)) {
        const ids = state.expanded[wkId];
        if (Array.isArray(ids)) {
          expanded.set(wkId, new Set(ids.filter(id => typeof id === "number")));
        }
      }
    }
    if (typeof state.scrollTop === "number" && state.scrollTop > 0) {
      pendingScrollTop = state.scrollTop;
    }
  }

  function saveState() {
    saveStateTimer = undefined;
    const expandedIds = {};
    for (const [wkId, ids] of expanded) {
      expandedIds[wkId] = Array.from(ids);
    }
    vscode.setState({
      expanded: expandedIds,
      scrollTop: scrollRestored ? window.scrollY : pendingScrollTop,
    });
  }

  function scheduleSaveState() {
    if (saveStateTimer !== undefined) {
      return;
    }
    saveStateTimer = setTimeout(saveState, 200);
  }

  // ---------------------------------------------------------------- DOM helpers

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  }

  function svgEl(tag, attributes) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const name of Object.keys(attributes || {})) {
      node.setAttribute(name, String(attributes[name]));
    }
    return node;
  }

  function icon(name, extraClass) {
    return el("span", `codicon codicon-${name}${extraClass ? ` ${extraClass}` : ""}`);
  }

  function spinner() {
    return icon("loading", "codicon-modifier-spin spinner-icon");
  }

  function graphCell(width) {
    const cell = el("div", "graph-cell");
    cell.style.width = `${width}px`;
    return cell;
  }

  function button(text, action, className) {
    const node = el("button", className, text);
    node.type = "button";
    node.dataset.action = action;
    return node;
  }

  function cellWidthFor(laneCount) {
    return LANE_PADDING + laneCount * LANE_WIDTH + LANE_PADDING;
  }

  function laneX(lane) {
    return LANE_PADDING + lane * LANE_WIDTH + LANE_WIDTH / 2;
  }

  // ---------------------------------------------------------------- dates

  function pad2(value) {
    return value < 10 ? `0${value}` : String(value);
  }

  function relativeDate(date, now) {
    if (isNaN(date.getTime())) {
      return "";
    }
    const minute = 60 * 1000;
    const hour = 60 * minute;
    const day = 24 * hour;
    const diff = now - date.getTime();
    if (diff < minute) {
      return "just now";
    }
    if (diff < hour) {
      return `${Math.floor(diff / minute)}m`;
    }
    if (diff < day) {
      return `${Math.floor(diff / hour)}h`;
    }
    if (diff < 7 * day) {
      return `${Math.floor(diff / day)}d`;
    }
    if (date.getFullYear() === new Date(now).getFullYear()) {
      return date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
    }
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  }

  function fullDate(date) {
    return isNaN(date.getTime()) ? "unknown date" : date.toLocaleString();
  }

  // ---------------------------------------------------------------- files cache

  function getFilesEntry(wkId, changesetId) {
    const perWorkspace = filesCache.get(wkId);
    return perWorkspace ? perWorkspace.get(changesetId) : undefined;
  }

  function setFilesEntry(wkId, changesetId, entry) {
    let perWorkspace = filesCache.get(wkId);
    if (!perWorkspace) {
      perWorkspace = new Map();
      filesCache.set(wkId, perWorkspace);
    }
    perWorkspace.set(changesetId, entry);
  }

  /**
   * Called when a workspace starts loading again: a file list that failed is
   * worth another try, while the successful ones stay because a changeset's
   * contents never change.
   */
  function dropCachedFileErrors(wkId) {
    const perWorkspace = filesCache.get(wkId);
    if (!perWorkspace) {
      return;
    }
    for (const [changesetId, entry] of perWorkspace) {
      if (entry && entry.error) {
        perWorkspace.delete(changesetId);
      }
    }
  }

  function requestFiles(wkId, changesetId) {
    setFilesEntry(wkId, changesetId, { loading: true });
    vscode.postMessage({ changesetId, type: "files", wkId });
  }

  function isExpanded(wkId, changesetId) {
    const ids = expanded.get(wkId);
    return !!ids && ids.has(changesetId);
  }

  function toggleExpanded(wkId, changesetId) {
    let ids = expanded.get(wkId);
    if (!ids) {
      ids = new Set();
      expanded.set(wkId, ids);
    }
    if (ids.has(changesetId)) {
      ids.delete(changesetId);
    } else {
      ids.add(changesetId);
      const entry = getFilesEntry(wkId, changesetId);
      if (entry && entry.error) {
        // A failed request is retried by the render, which asks for missing entries.
        filesCache.get(wkId).delete(changesetId);
      }
    }
    saveState();
    render();
  }

  // ---------------------------------------------------------------- rows

  function changesetRow(ws, row, cellWidth) {
    const open = isExpanded(ws.id, row.id);
    const div = el("div", `row changeset${row.isCurrent ? " current" : ""}${open ? " expanded" : ""}`);
    div.setAttribute("role", "treeitem");
    div.setAttribute("aria-level", "1");
    div.setAttribute("aria-expanded", String(open));
    div.tabIndex = -1;
    div.dataset.kind = "changeset";
    div.dataset.key = `${ws.id}:${row.id}`;
    div.dataset.wk = ws.id;
    div.dataset.id = String(row.id);
    div.dataset.lane = String(row.lane);
    div.dataset.vscodeContext = JSON.stringify({
      changesetId: row.id,
      preventDefaultContextMenuItems: true,
      webviewSection: "changeset",
      wkId: ws.id,
    });

    const date = new Date(row.date);
    const localized = fullDate(date);
    const comment = row.comment && row.comment.trim() ? row.comment.trim() : "(no comment)";
    div.title = `cs:${row.id} · ${row.branch}\n${row.owner} · ${localized}\n\n${comment}`;

    div.appendChild(graphCell(cellWidth));
    div.appendChild(el("span", `twistie codicon codicon-${open ? "chevron-down" : "chevron-right"}`));

    const subject = row.subject
      ? el("span", "subject", row.subject)
      : el("span", "subject empty", "(no comment)");
    div.appendChild(subject);

    if (row.labels && row.labels.length) {
      const labels = el("span", "labels");
      for (const label of row.labels) {
        const pill = el("span", `label ${label.kind}`);
        pill.title = label.isCurrent ? `${label.text} (current changeset)` : label.text;
        pill.appendChild(icon(label.isCurrent ? "target" : "git-branch"));
        pill.appendChild(el("span", "label-text", label.text));
        labels.appendChild(pill);
      }
      div.appendChild(labels);
    }

    const owner = el("span", "owner", row.ownerShort || row.owner);
    owner.title = row.owner;
    div.appendChild(owner);

    const when = el("span", "date", relativeDate(date, Date.now()));
    when.title = localized;
    div.appendChild(when);

    return div;
  }

  function fileRow(ws, changesetId, file, cellWidth) {
    const div = el("div", `row file${file.canDiff ? "" : " disabled"}`);
    div.setAttribute("role", "treeitem");
    div.setAttribute("aria-level", "2");
    div.tabIndex = -1;
    div.dataset.kind = "file";
    // A changeset can list one path twice (deleted, then re-added), so the
    // revision id is part of the row's identity and of every message about it.
    div.dataset.key = `${ws.id}:${changesetId}:${file.path}:${file.revisionId}`;
    div.dataset.wk = ws.id;
    div.dataset.id = String(changesetId);
    div.dataset.path = file.path;
    div.dataset.rev = String(file.revisionId);
    div.dataset.vscodeContext = JSON.stringify({
      changesetId,
      path: file.path,
      preventDefaultContextMenuItems: true,
      revisionId: file.revisionId,
      webviewSection: "file",
      wkId: ws.id,
    });
    div.title = `${file.path}\n${file.statusTooltip}${file.reason ? `\n${file.reason}` : ""}`;

    div.appendChild(graphCell(cellWidth));
    div.appendChild(el("span", "indent"));
    div.appendChild(el("span", "name", file.name));
    div.appendChild(el("span", "dir", file.directory));
    const status = el("span", `status${file.status ? ` status-${file.status.charAt(0)}` : ""}`, file.status);
    div.appendChild(status);
    return div;
  }

  function messageRow(className, cellWidth, indent) {
    const div = el("div", `row ${className}`);
    div.setAttribute("role", "treeitem");
    div.setAttribute("aria-level", indent ? "2" : "1");
    div.setAttribute("aria-disabled", "true");
    div.appendChild(graphCell(cellWidth));
    if (indent) {
      div.appendChild(el("span", "indent"));
    }
    return div;
  }

  function filesGroup(ws, row, cellWidth) {
    const group = el("div", "files");
    group.setAttribute("role", "group");

    let entry = getFilesEntry(ws.id, row.id);
    if (!entry) {
      requestFiles(ws.id, row.id);
      entry = getFilesEntry(ws.id, row.id);
    }

    if (entry.loading) {
      const loading = messageRow("loading", cellWidth, true);
      loading.setAttribute("aria-busy", "true");
      loading.appendChild(spinner());
      loading.appendChild(el("span", "text", "Loading…"));
      group.appendChild(loading);
    } else if (entry.error !== undefined) {
      const error = messageRow("error", cellWidth, true);
      error.title = entry.error;
      error.appendChild(el("span", "text", entry.error));
      group.appendChild(error);
    } else if (!entry.files.length) {
      const empty = messageRow("lane-empty", cellWidth, true);
      empty.appendChild(el("span", "text", "No files in this changeset"));
      group.appendChild(empty);
    } else {
      for (const file of entry.files) {
        group.appendChild(fileRow(ws, row.id, file, cellWidth));
      }
    }
    return group;
  }

  function actionRow(className, kind, key, cellWidth) {
    const div = el("div", `row ${className}`);
    div.setAttribute("role", "treeitem");
    div.setAttribute("aria-level", "1");
    div.tabIndex = -1;
    div.dataset.kind = kind;
    div.dataset.key = key;
    div.appendChild(graphCell(cellWidth));
    return div;
  }

  function newerRow(ws, lane, cellWidth) {
    const div = actionRow("newer", "newer", `${ws.id}:newer:${lane.branch}`, cellWidth);
    div.title = "Refresh the graph to load them";
    div.appendChild(el("span", "text", `New changesets on ${lane.branch} — Refresh`));
    return div;
  }

  function moreRow(ws, lane, cellWidth) {
    const div = actionRow("more", "more", `${ws.id}:more:${lane.branch}`, cellWidth);
    div.dataset.wk = ws.id;
    div.dataset.branch = lane.branch;
    if (lane.loading) {
      div.setAttribute("aria-busy", "true");
      div.appendChild(spinner());
    }
    div.appendChild(el("span", "text", `Load more changesets on ${lane.branch}…`));
    return div;
  }

  function laneLoadingRow(lane, cellWidth) {
    const div = messageRow("lane-loading", cellWidth, false);
    div.setAttribute("aria-busy", "true");
    div.appendChild(spinner());
    div.appendChild(el("span", "text", `Loading ${lane.branch}…`));
    return div;
  }

  function laneErrorRow(lane, cellWidth) {
    const div = messageRow("lane-error", cellWidth, false);
    div.title = lane.error;
    div.appendChild(el("span", "text", lane.error));
    div.appendChild(button("Retry", "refresh", "inline"));
    return div;
  }

  function laneEmptyRow(lane, cellWidth) {
    const div = messageRow("lane-empty", cellWidth, false);
    div.appendChild(el("span", "text", `No changesets on ${lane.branch} yet`));
    return div;
  }

  function noticeRow(ws, cellWidth) {
    const div = messageRow("notice", cellWidth, false);
    div.appendChild(el("span", "text",
      `Current changeset cs:${ws.currentChangesetId} is older than the loaded history.`));
    return div;
  }

  // ---------------------------------------------------------------- sections

  function emptyState(text, className) {
    const div = el("div", `empty-state${className ? ` ${className}` : ""}`);
    div.appendChild(el("div", "message", text));
    return div;
  }

  function loadingState(text) {
    const div = el("div", "empty-state");
    const line = el("span", "spinner");
    line.appendChild(spinner());
    line.appendChild(el("span", undefined, text));
    div.appendChild(line);
    return div;
  }

  function errorState(message) {
    const div = emptyState(message || "The graph could not be loaded.", "error");
    const actions = el("div", "actions");
    actions.appendChild(button("Show Output", "showOutput", "secondary"));
    actions.appendChild(button("Retry", "refresh"));
    div.appendChild(actions);
    return div;
  }

  /**
   * Shown above a graph that is still on screen after a failed reload: the rows
   * are the previous, still-valid ones, and without this the failure is silent.
   */
  function errorBanner(wkId, message) {
    const div = el("div", "banner error");
    const text = message || "The graph could not be refreshed.";
    // Every render rebuilds the DOM, and a live region that reappears is read
    // out again: announce a failure once, not on every state message that
    // arrives while it lasts.
    if (announcedErrors.get(wkId) !== text) {
      announcedErrors.set(wkId, text);
      div.setAttribute("role", "alert");
    }
    div.appendChild(el("span", "message", text));
    const actions = el("div", "actions");
    actions.appendChild(button("Show Output", "showOutput", "secondary"));
    actions.appendChild(button("Retry", "refresh"));
    div.appendChild(actions);
    return div;
  }

  function branchName(ws) {
    return ws.currentBranch || (ws.model && ws.model.lanes[0] ? ws.model.lanes[0].branch : "the current branch");
  }

  function renderWorkspace(ws) {
    const section = el("section", "workspace");
    section.dataset.wk = ws.id;

    if (workspaces.length > 1) {
      const header = el("header", "workspace-header");
      header.appendChild(el("span", "name", ws.name));
      if (ws.currentBranch) {
        header.appendChild(el("span", "branch", ws.currentBranch));
      }
      header.title = ws.path;
      section.appendChild(header);
    }

    const model = ws.model;
    if (!model) {
      switch (ws.status) {
      case "error":
        section.appendChild(errorState(ws.message));
        break;
      case "unsupported":
        section.appendChild(emptyState(ws.message || "This workspace has no branch history to show."));
        break;
      case "ready":
        section.appendChild(emptyState(`No changesets found on ${branchName(ws)}.`));
        break;
      default:
        section.appendChild(loadingState("Loading changesets…"));
        break;
      }
      return section;
    }

    if (ws.status === "loading") {
      const progress = el("div", "progress");
      progress.setAttribute("role", "progressbar");
      progress.setAttribute("aria-label", "Reloading changesets");
      progress.appendChild(el("div", "progress-bar"));
      section.appendChild(progress);
    }

    if (ws.status === "error") {
      section.appendChild(errorBanner(ws.id, ws.message));
    } else {
      announcedErrors.delete(ws.id);
    }

    const laneBusy = model.lanes.some(lane => lane.loading || lane.error);
    if (!model.rows.length && ws.status === "ready" && !laneBusy) {
      section.appendChild(emptyState(`No changesets found on ${branchName(ws)}.`));
      return section;
    }

    const cellWidth = cellWidthFor(model.lanes.length);
    const graph = el("div", "graph");
    const svg = svgEl("svg", { "aria-hidden": "true", "class": "lanes" });
    const rows = el("div", "rows");
    rows.setAttribute("role", "tree");
    rows.setAttribute("aria-label", ws.name);

    const rowsByLane = model.lanes.map(() => []);
    for (const row of model.rows) {
      if (!rowsByLane[row.lane]) {
        rowsByLane[row.lane] = [];
      }
      rowsByLane[row.lane].push(row);
    }

    model.lanes.forEach((lane, index) => {
      const laneRows = rowsByLane[index] || [];
      if (lane.hasNewer) {
        rows.appendChild(newerRow(ws, lane, cellWidth));
      }
      if (lane.loading && lane.count === 0) {
        rows.appendChild(laneLoadingRow(lane, cellWidth));
      }
      if (lane.error) {
        rows.appendChild(laneErrorRow(lane, cellWidth));
      }
      const parentHasRows = rowsByLane.slice(1).some(list => list.length > 0);
      if (index === 0 && !laneRows.length && parentHasRows && !lane.loading && !lane.error) {
        rows.appendChild(laneEmptyRow(lane, cellWidth));
      }
      for (const row of laneRows) {
        rows.appendChild(changesetRow(ws, row, cellWidth));
        if (isExpanded(ws.id, row.id)) {
          rows.appendChild(filesGroup(ws, row, cellWidth));
        }
      }
      if (index === 0 && !model.currentLoaded && ws.status === "ready") {
        rows.appendChild(noticeRow(ws, cellWidth));
      }
      if (lane.hasMore) {
        rows.appendChild(moreRow(ws, lane, cellWidth));
      }
    });

    graph.appendChild(svg);
    graph.appendChild(rows);
    section.appendChild(graph);
    return section;
  }

  // ---------------------------------------------------------------- graph drawing

  const MERGE_KIND_TEXT = {
    cherrypick: "Cherry-picked from",
    cherrypicksubtractive: "Subtractive cherry-pick from",
  };

  /** Adds the link's meaning to the tooltip of the changeset it lands on. */
  function describeLink(rowsEl, link) {
    const rowEl = rowsEl.querySelector(`.row.changeset[data-id="${link.fromId}"]`);
    if (!rowEl) {
      return;
    }
    const text = `${MERGE_KIND_TEXT[link.mergeType] || link.mergeType} cs:${link.toId}`;
    if (!rowEl.title.includes(text)) {
      rowEl.title = `${rowEl.title}\n\n${text}`;
    }
  }

  function drawGraph(section) {
    const ws = workspaces.find(candidate => candidate.id === section.dataset.wk);
    const svg = section.querySelector("svg.lanes");
    const rowsEl = section.querySelector(".rows");
    if (!ws || !ws.model || !svg || !rowsEl) {
      return;
    }

    const model = ws.model;
    const width = cellWidthFor(model.lanes.length);
    const height = rowsEl.offsetHeight;
    svg.replaceChildren();
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

    // Measured, not computed from indices: expanded file groups and placeholder
    // rows sit between changesets, so only the DOM knows where each node is.
    const positions = new Map();
    for (const rowEl of rowsEl.querySelectorAll(".row.changeset")) {
      const lane = Number(rowEl.dataset.lane);
      positions.set(Number(rowEl.dataset.id), {
        lane,
        x: laneX(lane),
        y: rowEl.offsetTop + ROW_HEIGHT / 2,
      });
    }

    const solid = [];
    const dashed = [];
    for (const link of model.links) {
      const from = positions.get(link.fromId);
      const to = positions.get(link.toId);
      if (!from || !to) {
        continue;
      }
      // Links are ordered by age, not by row: a merge into the parent lane has
      // its newer endpoint drawn below its older one in the block layout.
      const top = from.y <= to.y ? from : to;
      const bottom = top === from ? to : from;
      let shape;
      if (top.lane === bottom.lane) {
        shape = svgEl("line", { x1: top.x, x2: bottom.x, y1: top.y, y2: bottom.y });
      } else {
        const bend = top.y + ROW_HEIGHT / 2;
        const d = `M ${top.x} ${top.y} C ${top.x} ${bend}, ${bottom.x} ${bend}, ${bottom.x} ${top.y + ROW_HEIGHT}`
          + ` L ${bottom.x} ${bottom.y}`;
        shape = svgEl("path", { d });
      }
      shape.classList.add("link", `lane-${bottom.lane}`);
      if (link.kind === "merge" && link.mergeType && link.mergeType !== "merge") {
        shape.classList.add("dashed");
        // The link cannot carry the tooltip itself: the lane layer is painted over
        // the rows, and a shape that catches the pointer to show a title also
        // swallows the click and the context menu of the row beneath it.
        describeLink(rowsEl, link);
        dashed.push(shape);
      } else {
        solid.push(shape);
      }
    }
    for (const shape of solid) {
      svg.appendChild(shape);
    }
    for (const shape of dashed) {
      svg.appendChild(shape);
    }

    for (const row of model.rows) {
      if (row.parentLoaded || row.parentId === -1) {
        continue;
      }
      const position = positions.get(row.id);
      if (!position) {
        continue;
      }
      // The parent is not loaded: a tail says "history continues" and, when it
      // bends, on which lane.
      const targetLane = row.parentLane >= 0 && row.parentLane < model.lanes.length ? row.parentLane : row.lane;
      let tail;
      if (targetLane === row.lane) {
        tail = svgEl("line", { x1: position.x, x2: position.x, y1: position.y, y2: position.y + TAIL_HEIGHT });
      } else {
        const targetX = laneX(targetLane);
        const d = `M ${position.x} ${position.y} C ${position.x} ${position.y + 7}, ${targetX} ${position.y + 4},`
          + ` ${targetX} ${position.y + TAIL_HEIGHT}`;
        tail = svgEl("path", { d });
      }
      tail.classList.add("link", "tail", `lane-${targetLane}`);
      svg.appendChild(tail);
    }

    for (const row of model.rows) {
      const position = positions.get(row.id);
      if (!position) {
        continue;
      }
      const node = svgEl("circle", {
        cx: position.x,
        cy: position.y,
        r: row.isCurrent ? CURRENT_RADIUS : NODE_RADIUS,
      });
      node.classList.add("node", `lane-${position.lane}`);
      if (row.isCurrent) {
        node.classList.add("current");
      }
      svg.appendChild(node);
    }
  }

  function drawAllGraphs() {
    for (const section of root.querySelectorAll("section.workspace")) {
      drawGraph(section);
    }
  }

  function scheduleRedraw() {
    if (redrawFrame !== undefined) {
      return;
    }
    redrawFrame = requestAnimationFrame(() => {
      redrawFrame = undefined;
      drawAllGraphs();
    });
  }

  // ---------------------------------------------------------------- focus

  function focusableRows() {
    return Array.from(root.querySelectorAll(".row[tabindex]"));
  }

  function activeRow() {
    const active = document.activeElement;
    return active instanceof HTMLElement ? active.closest(".row[tabindex]") : null;
  }

  function markFocusable(row) {
    for (const other of root.querySelectorAll('.row[tabindex="0"]')) {
      if (other !== row) {
        other.tabIndex = -1;
      }
    }
    row.tabIndex = 0;
  }

  function focusRow(row, preventScroll) {
    if (!row) {
      return;
    }
    markFocusable(row);
    row.focus({ preventScroll: !!preventScroll });
  }

  function initialRow() {
    return root.querySelector(".row.changeset.current[tabindex]") || root.querySelector(".row[tabindex]");
  }

  /** The first row the reader can actually see, so focus lands where they look. */
  function firstVisibleRow() {
    for (const row of focusableRows()) {
      const box = row.getBoundingClientRect();
      if (box.bottom > 0 && box.top < window.innerHeight) {
        return row;
      }
    }
    return undefined;
  }

  function ensureFocus() {
    if (activeRow()) {
      return;
    }

    // Never scroll here: this runs when the view regains focus, usually from a
    // click, and scrolling a row into view under the pointer moves the row the
    // user was aiming at out from under it. Focus therefore goes to a row that
    // is already on screen, so the focus ring is where they can see it.
    focusRow(firstVisibleRow() || initialRow(), true);
  }

  // ---------------------------------------------------------------- render

  function render() {
    const focused = activeRow();
    const focusKey = focused ? focused.dataset.key : undefined;
    const scrollTop = scrollRestored ? window.scrollY : pendingScrollTop;

    root.replaceChildren();
    if (!hasState) {
      root.appendChild(loadingState("Loading changesets…"));
    } else if (!workspaces.length) {
      root.appendChild(emptyState("No Plastic SCM workspace in this window."));
    } else {
      for (const ws of workspaces) {
        root.appendChild(renderWorkspace(ws));
      }
    }

    drawAllGraphs();

    // The document grows after this render as the lane SVG is sized and the
    // expanded file lists arrive, so the saved offset may be out of reach for
    // now. It is re-applied on every render until it is reached, or until the
    // reader scrolls themselves, whichever comes first.
    scrollTo(scrollTop);
    if (!scrollRestored && workspaces.some(ws => ws.model) && Math.abs(window.scrollY - scrollTop) < 1) {
      scrollRestored = true;
    }

    const target = focusKey ? focusableRows().find(row => row.dataset.key === focusKey) : undefined;
    if (target) {
      focusRow(target, true);
      return;
    }
    const first = initialRow();
    if (first) {
      markFocusable(first);
      if (focusKey) {
        // The focused row vanished (collapsed, or a reload dropped it): keep the
        // keyboard inside the tree rather than dropping it on the body.
        first.focus({ preventScroll: true });
      }
    }
  }

  // ---------------------------------------------------------------- actions

  function handleAction(action) {
    switch (action) {
    case "refresh":
      vscode.postMessage({ type: "refresh" });
      break;
    case "showOutput":
      vscode.postMessage({ type: "showOutput" });
      break;
    default:
      break;
    }
  }

  function activateRow(row) {
    switch (row.dataset.kind) {
    case "changeset":
      toggleExpanded(row.dataset.wk, Number(row.dataset.id));
      break;
    case "file":
      if (!row.classList.contains("disabled")) {
        vscode.postMessage({
          changesetId: Number(row.dataset.id),
          path: row.dataset.path,
          revisionId: row.dataset.rev ? Number(row.dataset.rev) : undefined,
          type: "openDiff",
          wkId: row.dataset.wk,
        });
      }
      break;
    case "more":
      if (row.getAttribute("aria-busy") !== "true") {
        vscode.postMessage({ branch: row.dataset.branch, type: "loadMore", wkId: row.dataset.wk });
      }
      break;
    case "newer":
      vscode.postMessage({ type: "refresh" });
      break;
    default:
      break;
    }
  }

  function parentChangesetOf(fileRowEl) {
    const group = fileRowEl.closest(".files");
    const previous = group ? group.previousElementSibling : null;
    return previous && previous.classList.contains("changeset") ? previous : null;
  }

  function onKeyDown(event) {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }
    if (!NAVIGATION_KEYS.has(event.key)) {
      return;
    }
    if (event.target instanceof HTMLElement && event.target.tagName === "BUTTON") {
      return;
    }

    const row = activeRow();
    if (!row) {
      const first = initialRow();
      if (first) {
        focusRow(first, false);
        event.preventDefault();
      }
      return;
    }

    const rows = focusableRows();
    const index = rows.indexOf(row);
    switch (event.key) {
    case "ArrowDown":
      focusRow(rows[Math.min(rows.length - 1, index + 1)], false);
      break;
    case "ArrowUp":
      focusRow(rows[Math.max(0, index - 1)], false);
      break;
    case "Home":
      focusRow(rows[0], false);
      break;
    case "End":
      focusRow(rows[rows.length - 1], false);
      break;
    case "Enter":
      activateRow(row);
      break;
    case " ":
      if (row.dataset.kind !== "file") {
        activateRow(row);
      }
      break;
    case "ArrowRight":
      if (row.dataset.kind === "changeset") {
        if (row.getAttribute("aria-expanded") !== "true") {
          toggleExpanded(row.dataset.wk, Number(row.dataset.id));
        } else if (rows[index + 1] && rows[index + 1].dataset.kind === "file") {
          focusRow(rows[index + 1], false);
        }
      }
      break;
    case "ArrowLeft":
      if (row.dataset.kind === "changeset") {
        if (row.getAttribute("aria-expanded") === "true") {
          toggleExpanded(row.dataset.wk, Number(row.dataset.id));
        }
      } else if (row.dataset.kind === "file") {
        focusRow(parentChangesetOf(row), false);
      }
      break;
    default:
      return;
    }
    event.preventDefault();
  }

  function onClick(event) {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const actionButton = target.closest("button[data-action]");
    if (actionButton) {
      handleAction(actionButton.dataset.action);
      return;
    }
    const row = target.closest(".row");
    if (!row || !root.contains(row)) {
      return;
    }
    if (row.hasAttribute("tabindex")) {
      focusRow(row, true);
    }
    activateRow(row);
  }

  function onMessage(event) {
    const message = event.data;
    if (!message || typeof message !== "object") {
      return;
    }
    switch (message.type) {
    case "state": {
      const previousStatus = new Map(workspaces.map(ws => [ ws.id, ws.status ]));
      workspaces = Array.isArray(message.workspaces) ? message.workspaces : [];
      hasState = true;
      for (const ws of workspaces) {
        if (ws.status === "loading" && previousStatus.get(ws.id) !== "loading") {
          dropCachedFileErrors(ws.id);
        }
      }
      render();
      break;
    }
    case "files":
      setFilesEntry(message.wkId, message.changesetId, { files: Array.isArray(message.files) ? message.files : [] });
      if (isExpanded(message.wkId, message.changesetId)) {
        render();
      }
      break;
    case "filesError":
      setFilesEntry(message.wkId, message.changesetId, { error: String(message.message || "Unable to load files") });
      if (isExpanded(message.wkId, message.changesetId)) {
        render();
      }
      break;
    default:
      break;
    }
  }

  // ---------------------------------------------------------------- wiring

  window.addEventListener("message", onMessage);
  document.addEventListener("keydown", onKeyDown);
  root.addEventListener("click", onClick);
  root.addEventListener("focusin", event => {
    const row = event.target instanceof HTMLElement ? event.target.closest(".row[tabindex]") : null;
    if (row) {
      markFocusable(row);
    }
  });
  window.addEventListener("focus", () => {
    // Only when the focus landed on nothing in particular: a click on a row
    // already focused that row.
    if (document.activeElement === document.body || document.activeElement === null) {
      ensureFocus();
    }
  });
  window.addEventListener("scroll", () => {
    // A scroll the reader made settles where the view sits, so stop trying to
    // restore the offset from the last session.
    if (!programmaticScroll) {
      scrollRestored = true;
    }
    scheduleSaveState();
  }, { passive: true });
  window.addEventListener("resize", scheduleRedraw);

  restoreState();
  render();
  vscode.postMessage({ type: "ready" });
})();
