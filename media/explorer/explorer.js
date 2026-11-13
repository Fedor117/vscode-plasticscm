// The Branch Explorer's client. It draws what the extension sends (see
// src/explorer/branchExplorerPanel.ts for the messages) and keeps only view
// state of its own: the filters, the selection and the scroll position.
(function () {
  "use strict";

  const vscode = acquireVsCodeApi();

  const ROW_HEIGHT = 26;
  const LANE_WIDTH = 14;
  /** Lanes drawn at most; a wider graph is clipped rather than squeezing the text out. */
  const MAX_LANES = 30;
  /** Rows rendered above and below what is visible. */
  const OVERSCAN = 12;
  const SVG_NS = "http://www.w3.org/2000/svg";

  const saved = vscode.getState() || {};

  const ui = {
    /** The last `state` message. */
    state: null,
    /** Live text filter over the loaded rows. */
    search: "",
    /** Full owner name, or "" for everyone. */
    author: "",
    /** A search of the whole repository: { text, pending, rows, error }. */
    repoSearch: null,
    selectedId: typeof saved.selectedId === "number" ? saved.selectedId : null,
    detailsHeight: typeof saved.detailsHeight === "number" ? saved.detailsHeight : 260,
    /** changesetId -> { status: "loading" | "ready" | "error", files, message } */
    files: new Map(),
    fileFilter: "",
    branchFilter: "",
    branchMenuOpen: false,
    /** The scope picked in the toolbar while its state is on the way; "" otherwise. */
    pendingScope: "",
    selectedBranches: new Set(),
    /** The rows listed right now, after the filters. */
    rows: [],
    /** True when the rows are a filtered list rather than the graph. */
    flat: false,
    renderQueued: false,
  };

  const haystacks = new WeakMap();
  const dom = {};

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

  function icon(name) {
    return el("span", `codicon codicon-${name}`);
  }

  function iconButton(name, title, onClick) {
    const button = el("button", "icon-button");
    button.type = "button";
    button.title = title;
    button.setAttribute("aria-label", title);
    button.appendChild(icon(name));
    button.addEventListener("click", onClick);
    return button;
  }

  function saveState() {
    vscode.setState({ detailsHeight: ui.detailsHeight, selectedId: ui.selectedId });
  }

  function post(message) {
    vscode.postMessage(message);
  }

  // ---------------------------------------------------------------- skeleton

  function build() {
    const root = document.getElementById("root");
    root.textContent = "";

    // Toolbar
    dom.toolbar = el("div", "toolbar");

    dom.scope = el("select", "control");
    dom.scope.title = "Which changesets the graph shows";
    for (const [ value, label ] of [
      [ "all", "All branches" ],
      [ "current", "Current branch and its ancestors" ],
      [ "branches", "Selected branches…" ],
    ]) {
      const option = el("option", "", label);
      option.value = value;
      dom.scope.appendChild(option);
    }
    dom.scope.addEventListener("change", onScopeChanged);

    dom.branchButton = el("button", "control branch-button");
    dom.branchButton.type = "button";
    dom.branchButton.addEventListener("click", event => {
      event.stopPropagation();
      ui.branchMenuOpen = !ui.branchMenuOpen;
      renderBranchMenu();
    });
    dom.branchMenu = el("div", "branch-menu");
    dom.branchMenu.addEventListener("click", event => event.stopPropagation());
    dom.branchFilter = el("input", "search branch-filter");
    dom.branchFilter.type = "text";
    dom.branchFilter.placeholder = "Filter branches";
    dom.branchFilter.spellcheck = false;
    dom.branchFilter.addEventListener("input", () => {
      ui.branchFilter = dom.branchFilter.value;
      fillBranchList();
    });
    const branchActions = el("div", "branch-actions");
    const clearBranches = el("button", "link", "Clear");
    clearBranches.type = "button";
    clearBranches.addEventListener("click", () => {
      ui.selectedBranches.clear();
      postBranchScope();
      fillBranchList();
    });
    branchActions.append(el("span", "hint", "Branches with loaded changesets"), clearBranches);
    dom.branchList = el("div", "branch-list");
    dom.branchMenu.append(dom.branchFilter, branchActions, dom.branchList);
    dom.branchMenu.style.display = "none";
    const branchWrap = el("div", "branch-wrap");
    branchWrap.append(dom.branchButton, dom.branchMenu);

    dom.author = el("select", "control");
    dom.author.title = "Show only the changesets of one author";
    dom.author.addEventListener("change", () => {
      ui.author = dom.author.value;
      refreshRows(true);
    });

    const searchWrap = el("div", "search-wrap");
    searchWrap.appendChild(icon("search"));
    dom.search = el("input", "search");
    dom.search.type = "text";
    dom.search.placeholder = "Filter by comment, branch, author, label or changeset number";
    dom.search.spellcheck = false;
    dom.search.addEventListener("input", () => {
      ui.search = dom.search.value;
      refreshRows(true);
    });
    dom.search.addEventListener("keydown", event => {
      if (event.key === "Enter") {
        searchRepository();
      } else if (event.key === "Escape") {
        clearSearch();
      }
    });
    dom.clearSearch = iconButton("close", "Clear the filter", clearSearch);
    searchWrap.append(dom.search, dom.clearSearch);

    dom.searchRepo = el("button", "control text-button", "Search repository");
    dom.searchRepo.type = "button";
    dom.searchRepo.title =
      "Search every changeset of the repository, not only the loaded ones (comment text, case-sensitive, or a number)";
    dom.searchRepo.addEventListener("click", searchRepository);

    dom.count = el("span", "count");

    dom.toolbar.append(
      dom.scope, branchWrap, dom.author, searchWrap, dom.searchRepo, dom.count,
      iconButton("home", "Go to the workspace's changeset", goToCurrent),
      iconButton("refresh", "Reload from the server", () => post({ type: "refresh" })));

    // Banner
    dom.banner = el("div", "banner");

    // List
    dom.header = el("div", "list-header");
    for (const [ className, label ] of [
      [ "graph", "Graph" ],
      [ "desc", "Description" ],
      [ "cs", "Cs" ],
      [ "branch", "Branch" ],
      [ "author", "Author" ],
      [ "date", "Date" ],
    ]) {
      dom.header.appendChild(el("div", `cell ${className}`, label));
    }

    dom.viewport = el("div", "viewport");
    dom.viewport.tabIndex = 0;
    dom.viewport.setAttribute("role", "listbox");
    dom.viewport.setAttribute("aria-label", "Changesets");
    dom.spacer = el("div", "spacer");
    dom.viewport.appendChild(dom.spacer);
    dom.viewport.addEventListener("scroll", queueRender);
    dom.viewport.addEventListener("keydown", onListKey);

    dom.list = el("div", "list");
    dom.list.append(dom.header, dom.viewport);

    // Details
    dom.splitter = el("div", "splitter");
    dom.splitter.title = "Drag to resize";
    dom.splitter.addEventListener("mousedown", startResize);

    dom.details = el("div", "details");
    dom.info = el("div", "details-info");
    dom.filesPane = el("div", "details-files");
    dom.details.append(dom.info, dom.filesPane);

    root.append(dom.toolbar, dom.banner, dom.list, dom.splitter, dom.details);

    document.addEventListener("click", () => {
      if (ui.branchMenuOpen) {
        ui.branchMenuOpen = false;
        renderBranchMenu();
      }
    });
    window.addEventListener("resize", queueRender);
    applyDetailsHeight();
  }

  // ------------------------------------------------------------------ filters

  function onScopeChanged() {
    const kind = dom.scope.value;
    // Shown until the extension answers with a state for the new scope.
    ui.pendingScope = kind;
    if (kind === "branches") {
      if (ui.selectedBranches.size === 0 && ui.state && ui.state.currentBranch) {
        ui.selectedBranches.add(ui.state.currentBranch);
      }
      ui.branchMenuOpen = true;
      postBranchScope();
      renderToolbar();
      return;
    }
    ui.branchMenuOpen = false;
    post({ scope: { kind }, type: "scope" });
  }

  function postBranchScope() {
    post({ scope: { branches: Array.from(ui.selectedBranches), kind: "branches" }, type: "scope" });
  }

  function clearSearch() {
    ui.search = "";
    ui.repoSearch = null;
    dom.search.value = "";
    refreshRows(true);
  }

  function searchRepository() {
    const text = ui.search.trim();
    if (!text) {
      return;
    }
    ui.repoSearch = { error: null, pending: true, rows: null, text };
    post({ text, type: "search" });
    refreshRows(true);
  }

  function haystackOf(row) {
    let haystack = haystacks.get(row);
    if (haystack === undefined) {
      haystack = [
        `cs:${row.id}`, row.comment, row.branch, row.owner, row.refs.map(ref => ref.text).join(" "),
      ].join("\n").toLowerCase();
      haystacks.set(row, haystack);
    }
    return haystack;
  }

  /** Recomputes the listed rows from the state and the filters. */
  function computeRows() {
    const model = ui.state ? ui.state.model : null;
    if (ui.repoSearch) {
      ui.flat = true;
      ui.rows = ui.repoSearch.rows || [];
      return;
    }
    if (!model) {
      ui.flat = false;
      ui.rows = [];
      return;
    }

    const tokens = ui.search.toLowerCase().split(/\s+/).filter(token => token.length > 0);
    if (tokens.length === 0 && !ui.author) {
      ui.flat = false;
      ui.rows = model.rows;
      return;
    }

    ui.flat = true;
    ui.rows = model.rows.filter(row => {
      if (ui.author && row.owner !== ui.author) {
        return false;
      }
      const haystack = haystackOf(row);
      return tokens.every(token => haystack.includes(token));
    });
  }

  function refreshRows(resetScroll) {
    computeRows();
    if (resetScroll) {
      dom.viewport.scrollTop = 0;
    }
    render();
  }

  // ------------------------------------------------------------------- render

  function queueRender() {
    if (ui.renderQueued) {
      return;
    }
    ui.renderQueued = true;
    requestAnimationFrame(() => {
      ui.renderQueued = false;
      renderRows();
    });
  }

  function render() {
    renderToolbar();
    renderBanner();
    renderRows();
    renderDetails();
  }

  function renderToolbar() {
    const state = ui.state;
    const model = state ? state.model : null;

    dom.scope.value = ui.pendingScope || (state ? state.scope.kind : "all");
    const branchesScope = (state && state.scope.kind === "branches") || ui.branchMenuOpen;
    dom.branchButton.parentElement.style.display = branchesScope ? "" : "none";
    dom.branchButton.textContent =
      `${ui.selectedBranches.size} ${ui.selectedBranches.size === 1 ? "branch" : "branches"} ▾`;

    const owners = model ? model.owners : [];
    const wanted = [""].concat(owners);
    const present = Array.from(dom.author.options).map(option => option.value);
    if (wanted.length !== present.length || wanted.some((value, index) => value !== present[index])) {
      dom.author.textContent = "";
      for (const owner of wanted) {
        const option = el("option", "", owner === "" ? "All authors" : shortOwner(owner));
        option.value = owner;
        option.title = owner;
        dom.author.appendChild(option);
      }
    }
    if (ui.author && !owners.includes(ui.author)) {
      ui.author = "";
    }
    dom.author.value = ui.author;

    dom.clearSearch.style.visibility = ui.search || ui.repoSearch ? "visible" : "hidden";
    dom.searchRepo.disabled = ui.search.trim().length === 0;

    if (!model) {
      dom.count.textContent = "";
    } else if (ui.repoSearch) {
      dom.count.textContent = "";
    } else if (ui.flat) {
      dom.count.textContent = `${ui.rows.length} of ${model.rows.length} loaded`;
    } else if (model.rows.length !== model.loadedCount) {
      dom.count.textContent = `${model.rows.length} of ${model.loadedCount} loaded`;
    } else {
      dom.count.textContent = `${model.loadedCount} loaded`;
    }

    if (ui.branchMenuOpen) {
      renderBranchMenu();
    } else {
      dom.branchMenu.style.display = "none";
    }
  }

  /**
   * Shows or hides the branch list. The list is refilled in place, so a state
   * arriving after each tick of a checkbox neither scrolls it back to the top
   * nor takes the focus from the filter.
   */
  function renderBranchMenu() {
    const menu = dom.branchMenu;
    if (!ui.branchMenuOpen || !ui.state) {
      menu.style.display = "none";
      return;
    }
    const opening = menu.style.display === "none";
    menu.style.display = "";
    fillBranchList();
    if (opening) {
      dom.branchFilter.value = ui.branchFilter;
      dom.branchFilter.focus();
    }
  }

  function fillBranchList() {
    const list = dom.branchList;
    const scrollTop = list.scrollTop;
    list.textContent = "";
    const needle = ui.branchFilter.toLowerCase();
    const branches = ui.state.model.branches.filter(branch => branch.toLowerCase().includes(needle));
    if (branches.length === 0) {
      list.appendChild(el("div", "hint", "No branch matches."));
      return;
    }
    for (const branch of branches) {
      const label = el("label", "branch-item");
      const box = el("input");
      box.type = "checkbox";
      box.checked = ui.selectedBranches.has(branch);
      box.addEventListener("change", () => {
        if (box.checked) {
          ui.selectedBranches.add(branch);
        } else {
          ui.selectedBranches.delete(branch);
        }
        postBranchScope();
      });
      const name = el("span", `branch-name c${colorOf(branch)}`, branch);
      label.append(box, name);
      if (branch === ui.state.currentBranch) {
        label.appendChild(el("span", "hint", "current"));
      }
      list.appendChild(label);
    }
    list.scrollTop = scrollTop;
  }

  function renderBanner() {
    const banner = dom.banner;
    banner.textContent = "";
    banner.className = "banner";
    const state = ui.state;

    if (ui.repoSearch) {
      const search = ui.repoSearch;
      let text;
      if (search.pending) {
        text = `Searching the repository for “${search.text}”…`;
      } else if (search.error) {
        text = `The repository search for “${search.text}” failed: ${search.error}`;
        banner.classList.add("error");
      } else {
        const count = search.rows.length;
        text = `Repository search for “${search.text}”: ${count} ${count === 1 ? "changeset" : "changesets"}`
          + (count >= 200 ? " (the newest 200)" : "") + ". Comment text is matched case-sensitively.";
      }
      banner.appendChild(el("span", "", text));
      const back = el("button", "link", "Back to the graph");
      back.type = "button";
      back.addEventListener("click", clearSearch);
      banner.appendChild(back);
      banner.classList.add("shown");
      return;
    }

    if (state && state.status === "error") {
      banner.classList.add("shown", "error");
      banner.appendChild(el("span", "", `The Branch Explorer could not be loaded: ${state.message || "unknown error"}`));
      const retry = el("button", "link", "Retry");
      retry.type = "button";
      retry.addEventListener("click", () => post({ type: "refresh" }));
      const output = el("button", "link", "Show Output");
      output.type = "button";
      output.addEventListener("click", () => post({ type: "showOutput" }));
      banner.append(retry, output);
    }
  }

  function graphWidth() {
    const model = ui.state ? ui.state.model : null;
    const lanes = ui.flat || !model ? 1 : Math.max(1, Math.min(model.laneCount, MAX_LANES));
    return lanes * LANE_WIDTH + 10;
  }

  function renderRows() {
    const viewport = dom.viewport;
    const rows = ui.rows;
    const width = graphWidth();
    dom.list.style.setProperty("--graph-width", `${width}px`);

    // One extra row for the footer (load more / end of history / empty state).
    const total = rows.length + 1;
    dom.spacer.style.height = `${total * ROW_HEIGHT}px`;

    const first = Math.max(0, Math.floor(viewport.scrollTop / ROW_HEIGHT) - OVERSCAN);
    const last = Math.min(total - 1, Math.ceil((viewport.scrollTop + viewport.clientHeight) / ROW_HEIGHT) + OVERSCAN);

    const fragment = document.createDocumentFragment();
    for (let index = first; index <= last; index++) {
      fragment.appendChild(index < rows.length ? rowNode(rows[index], index, width) : footerNode(index));
    }
    dom.spacer.textContent = "";
    dom.spacer.appendChild(fragment);

    // Paging follows the scroll in the graph; a filtered list asks first, or one
    // rare match would pull the whole repository in.
    const state = ui.state;
    if (state && !ui.flat && state.status === "ready" && state.hasMore && !state.loadingMore
        && last >= rows.length - 1 && rows.length > 0) {
      post({ type: "loadMore" });
    }
  }

  function rowNode(row, index, width) {
    const node = el("div", "row");
    node.style.top = `${index * ROW_HEIGHT}px`;
    node.setAttribute("role", "option");
    node.dataset.id = String(row.id);
    if (row.id === ui.selectedId) {
      node.classList.add("selected");
      node.setAttribute("aria-selected", "true");
    }
    if (row.isCurrent) {
      node.classList.add("current");
    }

    const state = ui.state;
    node.dataset.vscodeContext = JSON.stringify({
      branch: row.branch,
      changesetId: row.id,
      compareWithId: ui.selectedId === null ? undefined : ui.selectedId,
      explorerCanCompare: ui.selectedId !== null && ui.selectedId !== row.id,
      explorerIsWorkspaceChangeset: row.isCurrent,
      preventDefaultContextMenuItems: true,
      webviewSection: "explorerChangeset",
      wkId: state ? state.workspaceId : "",
    });

    const graph = el("div", "cell graph");
    graph.appendChild(graphSvg(row, width));

    const desc = el("div", "cell desc");
    for (const ref of row.refs) {
      const pill = el("span", `ref ${ref.kind} c${row.color}`);
      if (ref.isCurrent) {
        pill.classList.add("current");
      }
      pill.appendChild(icon(ref.kind === "label" ? "tag" : "git-branch"));
      pill.appendChild(el("span", "", ref.kind === "label" ? ref.text : shortBranch(ref.text)));
      pill.title = ref.kind === "label" ? `Label ${ref.text}` : `Head of ${ref.text}`;
      desc.appendChild(pill);
    }
    if (row.isCurrent) {
      const home = el("span", "ref home");
      home.appendChild(icon("home"));
      home.title = "The workspace is on this changeset";
      desc.appendChild(home);
    }
    desc.appendChild(el("span", row.subject ? "subject" : "subject empty", row.subject || "No comment"));
    desc.title = row.comment;

    const date = new Date(row.date);
    node.append(
      graph,
      desc,
      el("div", "cell cs", String(row.id)),
      cellWithTitle("branch", row.branch),
      cellWithTitle("author", row.ownerShort, row.owner),
      cellWithTitle("date", formatDate(date), date.toLocaleString()));

    node.addEventListener("click", () => select(row.id));
    node.addEventListener("contextmenu", () => {
      // The menu acts on the row under the pointer, so it becomes the selection
      // only when nothing was selected to compare with.
      if (ui.selectedId === null) {
        select(row.id);
      }
    });
    return node;
  }

  function cellWithTitle(className, text, title) {
    const cell = el("div", `cell ${className}`, text);
    cell.title = title === undefined ? text : title;
    return cell;
  }

  function footerNode(index) {
    const node = el("div", "row footer");
    node.style.top = `${index * ROW_HEIGHT}px`;
    const state = ui.state;

    const say = text => node.appendChild(el("span", "hint", text));
    const loadMoreButton = () => {
      const button = el("button", "link", "Load older changesets");
      button.type = "button";
      button.addEventListener("click", () => post({ type: "loadMore" }));
      node.appendChild(button);
    };

    if (ui.repoSearch) {
      if (!ui.repoSearch.pending && !ui.repoSearch.error && ui.rows.length === 0) {
        say("Nothing in the repository matches.");
      }
      return node;
    }
    if (!state || state.status === "idle" || state.status === "loading") {
      say("Loading changesets…");
      return node;
    }
    if (state.status === "error") {
      return node;
    }
    if (state.loadingMore) {
      say("Loading older changesets…");
      return node;
    }

    if (ui.flat) {
      say(`${ui.rows.length} of the ${state.model.rows.length} loaded changesets match.`);
      if (state.hasMore) {
        loadMoreButton();
      }
      return node;
    }
    if (ui.rows.length === 0) {
      say(state.scope.kind === "branches"
        ? "No loaded changeset is on the selected branches."
        : "No changesets to show.");
    }
    if (state.hasMore) {
      loadMoreButton();
    } else if (ui.rows.length > 0) {
      say("Beginning of the history.");
    }
    return node;
  }

  function graphSvg(row, width) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(ROW_HEIGHT));
    svg.setAttribute("class", "graph-svg");

    const middle = ROW_HEIGHT / 2;
    const x = lane => lane * LANE_WIDTH + LANE_WIDTH / 2 + 2;
    const dotX = x(ui.flat ? 0 : row.lane);

    if (!ui.flat) {
      // One path per colour and style keeps the element count down on wide graphs.
      const paths = new Map();
      const lines = row.lines;
      for (let index = 0; index + 3 < lines.length; index += 4) {
        const top = lines[index];
        const bottom = lines[index + 1];
        const key = `${lines[index + 2]}:${lines[index + 3]}`;
        let piece;
        if (top >= 0 && bottom >= 0) {
          piece = `M${x(top)} 0V${ROW_HEIGHT}`;
        } else if (top >= 0) {
          piece = x(top) === dotX
            ? `M${dotX} 0V${middle}`
            : `M${x(top)} 0Q${x(top)} ${middle} ${dotX} ${middle}`;
        } else {
          piece = x(bottom) === dotX
            ? `M${dotX} ${middle}V${ROW_HEIGHT}`
            : `M${dotX} ${middle}Q${x(bottom)} ${middle} ${x(bottom)} ${ROW_HEIGHT}`;
        }
        paths.set(key, (paths.get(key) || "") + piece);
      }
      for (const [ key, d ] of paths) {
        const [ color, merge ] = key.split(":");
        const path = document.createElementNS(SVG_NS, "path");
        path.setAttribute("d", d);
        path.setAttribute("class", `line c${color}${merge === "1" ? " merge" : ""}`);
        svg.appendChild(path);
      }
    }

    const dot = document.createElementNS(SVG_NS, "circle");
    dot.setAttribute("cx", String(dotX));
    dot.setAttribute("cy", String(middle));
    dot.setAttribute("r", row.isCurrent ? "5" : "4");
    dot.setAttribute("class", `dot c${row.color}${row.isCurrent ? " current" : ""}`);
    svg.appendChild(dot);
    return svg;
  }

  // ------------------------------------------------------------------ details

  function findRow(id) {
    if (id === null) {
      return undefined;
    }
    const listed = ui.rows.find(row => row.id === id);
    if (listed) {
      return listed;
    }
    return ui.state ? ui.state.model.rows.find(row => row.id === id) : undefined;
  }

  function select(id) {
    if (ui.selectedId === id) {
      return;
    }
    ui.selectedId = id;
    ui.fileFilter = "";
    saveState();
    requestFiles(id);
    renderRows();
    renderDetails();
  }

  function requestFiles(id) {
    if (id === null || ui.files.has(id)) {
      return;
    }
    ui.files.set(id, { status: "loading" });
    post({ changesetId: id, type: "files" });
  }

  function jumpTo(id) {
    let index = ui.rows.findIndex(row => row.id === id);
    if (index < 0 && (ui.flat || ui.repoSearch)) {
      // It may be hidden by the filter rather than missing.
      ui.search = "";
      ui.author = "";
      ui.repoSearch = null;
      dom.search.value = "";
      computeRows();
      index = ui.rows.findIndex(row => row.id === id);
    }
    if (index < 0) {
      renderDetailsNote(`cs:${id} is not among the loaded changesets. Load older changesets, or search for it.`);
      render();
      return;
    }
    select(id);
    scrollToIndex(index, true);
    render();
  }

  function goToCurrent() {
    if (ui.state && ui.state.currentChangesetId >= 0) {
      jumpTo(ui.state.currentChangesetId);
    }
  }

  function scrollToIndex(index, center) {
    const viewport = dom.viewport;
    const top = index * ROW_HEIGHT;
    if (center) {
      viewport.scrollTop = Math.max(0, top - viewport.clientHeight / 2);
    } else if (top < viewport.scrollTop) {
      viewport.scrollTop = top;
    } else if (top + ROW_HEIGHT > viewport.scrollTop + viewport.clientHeight) {
      viewport.scrollTop = top + ROW_HEIGHT - viewport.clientHeight;
    }
  }

  function onListKey(event) {
    const rows = ui.rows;
    if (rows.length === 0) {
      return;
    }
    const current = rows.findIndex(row => row.id === ui.selectedId);
    const page = Math.max(1, Math.floor(dom.viewport.clientHeight / ROW_HEIGHT) - 1);
    let next;
    switch (event.key) {
    case "ArrowDown": next = current + 1; break;
    case "ArrowUp": next = current < 0 ? 0 : current - 1; break;
    case "PageDown": next = current + page; break;
    case "PageUp": next = current - page; break;
    case "Home": next = 0; break;
    case "End": next = rows.length - 1; break;
    default: return;
    }
    event.preventDefault();
    next = Math.max(0, Math.min(rows.length - 1, next));
    select(rows[next].id);
    scrollToIndex(next, false);
    renderRows();
  }

  let detailsNote = "";

  function renderDetailsNote(text) {
    detailsNote = text;
  }

  function renderDetails() {
    const info = dom.info;
    const filesPane = dom.filesPane;
    info.textContent = "";
    filesPane.textContent = "";

    if (detailsNote) {
      info.appendChild(el("div", "note", detailsNote));
      detailsNote = "";
    }

    const row = findRow(ui.selectedId);
    if (!row) {
      info.appendChild(el("div", "hint", "Select a changeset to see its details and files."));
      return;
    }

    const title = el("div", "details-title");
    title.appendChild(el("span", `cs-badge c${row.color}`, `cs:${row.id}`));
    title.appendChild(el("span", "details-branch", row.branch));
    info.appendChild(title);

    const date = new Date(row.date);
    info.appendChild(el("div", "details-meta", `${row.owner} · ${date.toLocaleString()}`));

    const links = el("div", "details-links");
    if (row.parentId >= 0) {
      links.appendChild(linkLine("Parent", row.parentId, ""));
    }
    for (const source of row.mergedFrom) {
      links.appendChild(linkLine(mergeWord(source.type), source.id, source.branch));
    }
    for (const ref of row.refs) {
      if (ref.kind === "label") {
        const line = el("div", "link-line");
        line.append(el("span", "link-key", "Label"), el("span", "", ref.text));
        links.appendChild(line);
      }
    }
    info.appendChild(links);
    info.appendChild(el("pre", row.comment ? "comment" : "comment empty", row.comment || "No comment"));

    renderFiles(row);
  }

  function mergeWord(type) {
    switch (type) {
    case "cherrypick": return "Cherry-picked from";
    case "cherrypicksubtractive": return "Subtracted";
    case "interval": return "Interval merge from";
    case "intervalsubtractive": return "Interval subtracted";
    default: return "Merged from";
    }
  }

  function linkLine(key, id, branch) {
    const line = el("div", "link-line");
    line.appendChild(el("span", "link-key", key));
    const link = el("button", "link", `cs:${id}`);
    link.type = "button";
    link.addEventListener("click", () => jumpTo(id));
    line.appendChild(link);
    if (branch) {
      line.appendChild(el("span", "hint", branch));
    }
    return line;
  }

  function renderFiles(row) {
    const pane = dom.filesPane;
    const entry = ui.files.get(row.id);
    if (!entry) {
      requestFiles(row.id);
    }

    const header = el("div", "files-header");
    const filter = el("input", "search");
    filter.type = "text";
    filter.placeholder = "Filter files";
    filter.spellcheck = false;
    filter.value = ui.fileFilter;

    const list = el("div", "files-list");
    const count = el("span", "count");
    header.append(el("span", "files-title", "Files"), count, filter);
    pane.append(header, list);

    const fill = () => {
      list.textContent = "";
      const current = ui.files.get(row.id);
      if (!current || current.status === "loading") {
        count.textContent = "";
        list.appendChild(el("div", "hint", "Loading the files…"));
        return;
      }
      if (current.status === "error") {
        count.textContent = "";
        list.appendChild(el("div", "note error", `The files could not be loaded: ${current.message}`));
        const retry = el("button", "link", "Retry");
        retry.type = "button";
        retry.addEventListener("click", () => {
          ui.files.delete(row.id);
          requestFiles(row.id);
          renderDetails();
        });
        list.appendChild(retry);
        return;
      }

      const needle = ui.fileFilter.toLowerCase();
      const files = current.files.filter(file => file.path.toLowerCase().includes(needle));
      count.textContent = files.length === current.files.length
        ? String(current.files.length)
        : `${files.length} of ${current.files.length}`;
      if (files.length === 0) {
        list.appendChild(el("div", "hint", current.files.length === 0 ? "No files changed." : "No file matches."));
        return;
      }
      for (const file of files) {
        list.appendChild(fileNode(row, file));
      }
    };

    filter.addEventListener("input", () => {
      ui.fileFilter = filter.value;
      fill();
    });
    fill();
  }

  function fileNode(row, file) {
    const node = el("div", "file");
    if (!file.canDiff) {
      node.classList.add("no-diff");
    }
    node.title = file.canDiff
      ? `${file.statusTooltip}: ${file.path}\nClick to open the changes`
      : `${file.statusTooltip}: ${file.path}\n${file.reason || ""}`;
    node.dataset.vscodeContext = JSON.stringify({
      changesetId: row.id,
      path: file.path,
      preventDefaultContextMenuItems: true,
      webviewSection: "explorerFile",
      wkId: ui.state ? ui.state.workspaceId : "",
    });

    node.appendChild(el("span", `status s${file.status.charAt(0) || "N"}`, file.status || "·"));
    node.appendChild(el("span", "file-name", file.name));
    node.appendChild(el("span", "file-dir", file.directory));
    if (file.oldPath) {
      node.appendChild(el("span", "file-dir", `← ${file.oldPath}`));
    }
    if (file.canDiff) {
      node.addEventListener("click", () => post({
        changesetId: row.id, path: file.path, revisionId: file.revisionId, type: "openDiff",
      }));
    }
    return node;
  }

  // -------------------------------------------------------------------- utils

  function shortOwner(owner) {
    const at = owner.indexOf("@");
    return at < 0 ? owner : owner.substring(0, at);
  }

  function shortBranch(branch) {
    const slash = branch.lastIndexOf("/");
    return slash <= 0 ? branch : branch.substring(slash + 1);
  }

  /** Mirrors `branchColor` in src/explorer/explorerGraph.ts. */
  function colorOf(branch) {
    let hash = 5381;
    for (let index = 0; index < branch.length; index++) {
      hash = ((hash << 5) + hash + branch.charCodeAt(index)) | 0;
    }
    return Math.abs(hash) % 8;
  }

  function formatDate(date) {
    if (isNaN(date.getTime())) {
      return "";
    }
    const day = date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
    const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    return `${day} ${time}`;
  }

  function applyDetailsHeight() {
    dom.details.style.height = `${ui.detailsHeight}px`;
  }

  function startResize(event) {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = ui.detailsHeight;
    const onMove = move => {
      const max = Math.max(120, window.innerHeight - 200);
      ui.detailsHeight = Math.max(100, Math.min(max, startHeight + (startY - move.clientY)));
      applyDetailsHeight();
      queueRender();
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      saveState();
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  // ----------------------------------------------------------------- messages

  function onState(message) {
    const previous = ui.state;
    const anchor = ui.rows.length > 0 ? ui.rows[0].id : null;
    ui.state = message;
    ui.pendingScope = "";

    if (message.scope.kind === "branches") {
      ui.selectedBranches = new Set(message.scope.branches);
    }
    // A reload from the top makes cached file lists of other changesets stale only
    // in theory (a changeset never changes), so they are kept.

    computeRows();

    // Newer changesets arriving on top must not shove the list under the reader.
    if (previous && anchor !== null && !ui.flat && dom.viewport.scrollTop > 0) {
      const shift = ui.rows.findIndex(row => row.id === anchor);
      if (shift > 0) {
        dom.viewport.scrollTop += shift * ROW_HEIGHT;
      }
    }

    if (ui.selectedId !== null && !ui.files.has(ui.selectedId) && findRow(ui.selectedId)) {
      requestFiles(ui.selectedId);
    }
    render();
  }

  window.addEventListener("message", event => {
    const message = event.data;
    if (!message || typeof message.type !== "string") {
      return;
    }

    switch (message.type) {
    case "state":
      onState(message);
      break;
    case "files":
      ui.files.set(message.changesetId, { files: message.files, status: "ready" });
      if (message.changesetId === ui.selectedId) {
        renderDetails();
      }
      break;
    case "filesError":
      ui.files.set(message.changesetId, { message: message.message, status: "error" });
      if (message.changesetId === ui.selectedId) {
        renderDetails();
      }
      break;
    case "searchResults":
      if (ui.repoSearch && ui.repoSearch.text === message.text) {
        ui.repoSearch = { error: null, pending: false, rows: message.rows, text: message.text };
        refreshRows(true);
      }
      break;
    case "searchError":
      if (ui.repoSearch && ui.repoSearch.text === message.text) {
        ui.repoSearch = { error: message.message, pending: false, rows: [], text: message.text };
        refreshRows(true);
      }
      break;
    default:
      break;
    }
  });

  build();
  render();
  post({ type: "ready" });
})();
