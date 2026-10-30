import "./unified/engineering-view.js";
import { actionState, sortedActions, mergeDraft } from "./workflow-model.js";
import { request, browserRuntime, runtimeReady, uiStorage } from "./transport.js";
const portable = document.getElementById("study-data") ? JSON.parse(document.getElementById("study-data").textContent) : null;
if (portable) document.body.classList.add("snapshot-mode");
let actionFilter = "open", actionOwner = "", evidenceView = "coverage", coverageFilter = "all", editorRevision = null, pendingDraft = null, conflictContext = null;
const localDay = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; };
let studyRecords = {runs: [], baselines: [], history: []}, ramEditing = false, restoringRoute = false;
let reviewTab = 'technical', reviewCategory = '', reviewTarget = '', reviewCache = null, traceCache = null, reviewRequest = 0;
const $ = (s) => document.querySelector(s);
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const nice = (v) => String(v ?? "").replaceAll("_", " ");
const lineText = value => Array.isArray(value) ? value.join('; ') : String(value ?? '');
const badge = (v, t = "") => `<span class="badge ${t}">${esc(nice(v))}</span>`;
const link = (id) =>
  `<button class="link" data-select="${esc(id)}">${esc(id)}</button>`;
const table = (heads, rows, cls = "") =>
  rows.length
    ? `<div class="table-wrap ${cls}" tabindex="0" role="region" aria-label="${esc(heads.join(', '))} table"><table><thead><tr>${heads.map((h) => `<th scope="col">${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`
    : '<p class="empty">No records match this view.</p>';
const row = (cells, selected = false) =>
  `<tr${selected ? ' class="selected"' : ""}>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`;
const option = (v, label = v, sel = "") =>
  `<option value="${esc(v)}" ${v === sel ? "selected" : ""}>${esc(label === v && !byId(v) ? nice(label) : label)}</option>`;
const options = (values, sel = "") =>
  values.map((v) => option(v, v, sel)).join("");
const notice = (text = "") => ($("#notice").textContent = text);
const clone = (v) => structuredClone(v);
const selectionHistory = [];
let recordsById = new Map();
let lastRemovedLink = null;
let bowtieHazard = "",
  ftaDraft = null,
  ftaRun = null,
  ftaDirty = false,
  diagramSVG = "",
  diagramName = "",
  diagramToken = 0, runRequest = 0;
let info,
  snapshot,
  view = "overview",
  selected = "",
  scope = "",
  filter = "all",
  query = "",
  kind = "requirement",
  method = "hazop",
  page = 0,
  editing = null,
  editingIsNew = false,
  related = null,
  draftDirty = false,
  actionHandler = null,
  currentRun = null,
  analysisDirty = false,
  tree = null,
  analysisDraft = null,
  setupDirty = false;
const byId = (id) => recordsById.get(id);
const incoming = (id, relation) =>
  snapshot.links
    .filter((l) => l.target === id && l.relation === relation)
    .map((l) => byId(l.source))
    .filter((e) => e && e.state !== "archived");
const outgoing = (id, relation) =>
  snapshot.links
    .filter((l) => l.source === id && l.relation === relation)
    .map((l) => byId(l.target))
    .filter((e) => e && e.state !== "archived");
async function api(path, data) {
  if (portable) {
    if (data !== undefined) throw new Error("This is a saved study. Open the workbench to change records.");
    const u = new URL(path, "http://study.local"), q = u.searchParams;
    const fixed = {"/api/info": portable.info, "/api/projects": [portable.snapshot.project], "/api/project": portable.snapshot, "/api/records": portable.records, "/api/technical-review": portable.technical_review, "/api/traceability": portable.traceability};
    if (u.pathname in fixed) return clone(fixed[u.pathname]);
    if (u.pathname === "/api/record") {
      const record = portable[q.get("kind")]?.find(r => r.id === q.get("id"));
      if (record) return clone(record.body);
    }
    if (["/api/diagram", "/api/run-diagram"].includes(u.pathname)) {
      const key = u.pathname === "/api/run-diagram" ? "rbd:" + q.get("run") : q.get("kind") + ":" + q.get("record");
      const drawing = portable.drawings[key];
      if (drawing && !drawing.error) return clone(drawing);
      throw new Error(drawing?.error || "No drawing is retained for this record.");
    }
    throw new Error("This operation requires the workbench.");
  }
  const r = await request(path, data);
  const body = await r.json();
  if (!r.ok) { const error = new Error(body.error || `Request failed (${r.status})`); error.status = r.status; throw error; }
  return body;
}
const url = (path) =>
  `${path}?project=${encodeURIComponent(snapshot.project.id)}`;
function download(name, value, type = "application/json") {
  const u = URL.createObjectURL(
    new Blob(
      [typeof value === "string" ? value : JSON.stringify(value, null, 2)],
      { type },
    ),
  );
  const a = document.createElement("a");
  a.href = u;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(u), 1000);
}
async function projectList(id) {
  const all = await api("/api/projects");
  const counts=new Map();for(const p of all)counts.set(p.title,(counts.get(p.title)||0)+1);
  $("#projects").innerHTML =
    (portable ? "" : option("", "Select a project")) +
    all.map((p) => option(p.id,counts.get(p.title)>1?`${p.title} · r${p.revision} · ${p.id.slice(-6)}`:p.title,id)).join("");
}
function defaultAnalysis() {
  return {
    name: "",
    mode: "normal",
    success: "",
    mission_hours: 100,
    repair_target_hours: 4,
    dependency_status: "unreviewed",
    independence: "",
    tree: null,
  };
}
function loadingProject(on) {
  $(".shell").inert = on;
  $("#main").setAttribute("aria-busy", String(on));
  $("#projects").disabled = on;
  document.querySelectorAll("header button").forEach((b) => (b.disabled = on));
}
async function load(id, fresh = false) {
  if (!id) {
    snapshot = null;
    recordsById.clear();
    selected = "";
    scope = "";
    $("#revision").textContent = "";
    $("#tree").innerHTML = "";
    $("#scopeNote").textContent = "";
    uiStorage.removeItem("rams-project");
    render();
    return;
  }
  loadingProject(true);
  try {
    if (analysisDraft) saveAnalysis();
    const loaded = await Promise.all([api(`/api/project?project=${encodeURIComponent(id)}`), api(`/api/records?project=${encodeURIComponent(id)}`)]);
    [snapshot, studyRecords] = loaded;
    recordsById = new Map(snapshot.entities.map((e) => [e.id, e]));
    uiStorage.setItem("rams-project", id);
    $("#projects").value = id;
    $("#projects").title=snapshot.project.title+" · "+snapshot.project.id;
    $("#revision").textContent = `Revision ${snapshot.project.revision}`;
    if (fresh) {
      view = "overview";
      actionFilter = "open"; actionOwner = ""; evidenceView = "coverage"; coverageFilter = "all";
      ramEditing = false;
      kind = "requirement";
      method = "hazop";
      filter = "all";
      selectionHistory.length = 0;
      selected = "";
      scope = "";
      query = "";
      page = 0;
      currentRun = null;
      bowtieHazard = "";
      ftaDraft = null;
      ftaRun = null;
      ftaDirty = false;
      try {
        analysisDraft =
          JSON.parse(uiStorage.getItem(`rams-analysis-${id}`)) ||
          defaultAnalysis();
      } catch {
        analysisDraft = defaultAnalysis();
      }
      tree = analysisDraft.tree || null;
      analysisDirty = false;
    }
    if (fresh) await readRoute();
    if (!byId(selected))
      selected = scope
        ? ""
        : snapshot.entities.find((e) => e.kind === "hazard")?.id || "";
    if (!byId(scope)) scope = "";
    renderTree();
    render();
    browserRuntime?.confirmFresh();
  } finally {
    loadingProject(false);
  }
}
async function mutate(operation, expected = snapshot.project.revision) {
  await api("/api/mutate", {
    project: snapshot.project.id,
    expected,
    operation,
  });
  await load(snapshot.project.id);
}
function scoped() {
  if (!scope) return new Set(snapshot.entities.map((e) => e.id));
  const ids = new Set([scope]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const l of snapshot.links)
      if (
        l.relation === "contains" &&
        ids.has(l.source) &&
        !ids.has(l.target)
      ) {
        ids.add(l.target);
        changed = true;
      }
  }
  // Only declared allocations propagate toward their source. Shared record links do not imply physical allocations.
  changed = true;
  while (changed) {
    changed = false;
    for (const l of snapshot.links)
      if (
        !["contains", "instance_of", "operates_in", "depends_on"].includes(
          l.relation,
        ) &&
        ids.has(l.target) &&
        !ids.has(l.source)
      ) {
        ids.add(l.source);
        changed = true;
      }
  }
  return ids;
}
function matching(type) {
  const ids = scoped();
  return snapshot.entities.filter(
    (e) =>
      e.state !== "archived" &&
      ids.has(e.id) &&
      (!type || e.kind === type) &&
      `${e.id} ${e.title} ${e.description}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
}
function renderTree() {
  if (!snapshot) {
    $("#tree").innerHTML = "";
    return;
  }
  const items = snapshot.entities.filter(
    (e) => e.kind === "item" && e.state !== "archived",
  );
  const activeIds = new Set(items.map((e) => e.id)),
    children = new Map(),
    parented = new Set();
  for (const l of snapshot.links) {
    if (
      l.relation !== "contains" ||
      !activeIds.has(l.source) ||
      !activeIds.has(l.target)
    )
      continue;
    if (!children.has(l.source)) children.set(l.source, []);
    children.get(l.source).push(recordsById.get(l.target));
    parented.add(l.target);
  }
  const kids = (id) => children.get(id) || [];
  const renderItem = (e) =>
    `<li><button data-scope="${esc(e.id)}" class="${scope === e.id ? "active" : ""}">${esc(e.title)}</button>${kids(e.id).length ? `<ul>${kids(e.id).map(renderItem).join("")}</ul>` : ""}</li>`;
  $("#tree").innerHTML = `<ul>${items
    .filter((e) => !parented.has(e.id))
    .map(renderItem)
    .join("")}</ul>`;
  $("#allScope").classList.toggle("active", !scope);
  $("#scopeNote").innerHTML = scope
    ? `<strong>${esc(scope)}</strong><p>Declared allocations and contained items. Unallocated records are excluded.</p><button data-select="${esc(scope)}">Inspect item</button>`
    : "Physical containment is separate from analysis topology.";
}
function render() {
  document.querySelectorAll(".app-nav [data-view]").forEach((b) => {
    const active = b.dataset.view === view || (view === "studies" && b.dataset.view === "hazards") || (view === "baselines" && b.dataset.view === "review");
    b.classList.toggle("active", active);
    b.setAttribute("aria-current", active ? "page" : "false");
  });
  $("#workspace").classList.toggle(
    "wide",
    ["overview", "review", "actions", "ram", "baselines", "setup", "practice", "studies"].includes(view) || (view === "evidence" && evidenceView === "coverage"),
  );
  $("#inspector").innerHTML = "";
  if (!snapshot) {
    $(".scope-menu").hidden = true;
    $("#export").disabled = true;
    $("#content").innerHTML = '<section class="welcome"><p class="eyebrow">RAMS Workbench</p><h1>Build a study you can trace and review.</h1><p>Connect hazards, controls and verification evidence. Model system reliability and retain the basis of every calculation.</p><div class="buttons"><button data-start="new" class="primary">Create a study</button><button data-start="complete">Explore the station example</button><button data-import-project>Import a study</button></div><ol class="start-path"><li><strong>Define the system</strong><span>Scope, equipment, operating context and risk criteria.</span></li><li><strong>Develop the analysis</strong><span>Hazards, HAZOP, FMECA, bow ties, fault trees and RAM.</span></li><li><strong>Review the evidence</strong><span>Resolve obligations, assign actions and retain a baseline.</span></li></ol><p class="muted">Single-user workspace · stored on this computer · export a portable study for review.</p></section>';
    return;
  }
  $("#export").disabled = false;
  uiStorage.setItem(
    `rams-ui-${snapshot.project.id}`,
    JSON.stringify({
      view,
      selected,
      scope,
      kind,
      method,
      filter,
      query,
      page,
      history: selectionHistory.slice(-30),
    }),
  );
  $("#scopeLabel").textContent = "Scope: " + (scope ? byId(scope)?.title : "all systems");
  $(".scope-menu").hidden = ["overview", "ram", "actions", "review", "baselines", "setup", "practice"].includes(view);
  if (view === "overview") renderOverview();
  if (view === "review") renderReview().catch(e => notice(e.message));
  if (view === "actions") renderActions();
  if (view === "hazards") renderHazards();
  if (view === "evidence") evidenceView === "coverage" ? renderCoverage() : renderRegister();
  if (view === "studies") renderStudies();
  if (view === "ram") renderRAM().catch(e => notice(e.message));
  if (view === "baselines") renderBaselines().catch((e) => notice(e.message));
  if (view === "setup") renderSetup();
  if (view === "practice") renderPractice();
  if (view === "hazards" || (view === "evidence" && evidenceView === "records")) renderInspector();
  writeRoute();
}
function head(title, action = "") {
  return `<div class="page-head"><div><h1>${esc(title)}</h1>${scope && !["actions","review","ram","baselines","setup"].includes(view) ? `<p>${esc(byId(scope)?.title)}</p>` : ""}</div>${action}</div>`;
}
function searchBar(extra = "") {
  return `<div class="toolbar"><input id="search" type="search" aria-label="Search records" placeholder="Search ID or title" value="${esc(query)}">${extra}</div>`;
}
function paginate(all) {
  const max = Math.max(0, Math.ceil(all.length / 40) - 1);
  page = Math.min(page, max);
  return {
    items: all.slice(page * 40, page * 40 + 40),
    html: `<div class="pagination"><span>${all.length} records · ${page + 1} / ${max + 1}</span><div class="buttons"><button data-page="-1" ${page === 0 ? "disabled" : ""}>Previous</button><button data-page="1" ${page === max ? "disabled" : ""}>Next</button></div></div>`,
  };
}
function attention(c) {
  return (
    c &&
    (c.gaps.length ||
      c.decision !== "accepted" ||
      c.decision_needs_review ||
      c.initial_risk === "unassessed" ||
      c.residual_risk === "unassessed")
  );
}
function rememberUI() {
  if (snapshot)
    uiStorage.setItem(
      `rams-ui-${snapshot.project.id}`,
      JSON.stringify({
        view,
        selected,
        scope,
        kind,
        method,
        filter,
        query,
        page,
        history: selectionHistory.slice(-30),
      }),
    );
}
function renderHazards() {
  rememberUI();
  const all = matching("hazard");
  const data = all.filter(
    (e) =>
      filter !== "attention" ||
      attention(snapshot.coverage.find((c) => c.hazard === e.id)),
  );
  const p = paginate(data);
  $("#content").innerHTML =
    `<div class="subnav"><button class="active" data-view="hazards">Hazards</button><button data-method="hazop">HAZOP</button><button data-method="fmeca">FMECA</button><button data-method="bowtie">Bow tie</button><button data-method="fta">Fault trees</button></div><div class="page-head hazard-head"><h1>Hazards (${all.length})</h1><input id="search" type="search" aria-label="Search records" placeholder="Search hazards" value="${esc(query)}"></div><div class="segmented"><button data-filter="all" class="${filter === "all" ? "active" : ""}">All ${all.length}</button><button data-filter="attention" class="${filter === "attention" ? "active" : ""}">Needs attention ${all.filter((e) => attention(snapshot.coverage.find((c) => c.hazard === e.id))).length}</button><button class="primary add-hazard" data-add="hazard">Add hazard</button></div>${table(
      ["ID / hazard", "State", "Residual risk", "Criterion"],
      p.items.map((e) => {
        const c = snapshot.coverage.find((c) => c.hazard === e.id);
        return row(
          [
            `${link(e.id)}<span class="title">${esc(e.title)}</span><span class="mobile-state">${badge(e.state)}</span>`,
            badge(e.state),
            `${esc(e.data.residual?.severity || "—")} / ${esc(e.data.residual?.frequency || "—")}`,
            badge(c?.residual_risk || "unassessed", "warn"),
          ],
          e.id === selected,
        );
      }),
      "hazard-table",
    )}${p.html}`;
}
function evidenceTabs() { return `<div class="subnav"><button data-evidence-view="coverage" class="${evidenceView === "coverage" ? "active" : ""}">Verification coverage</button><button data-evidence-view="records" class="${evidenceView === "records" ? "active" : ""}">Record library</button></div>`; }
function renderRegister() {
  rememberUI();
  const all = matching(kind);
  const p = paginate(all);
  $("#content").innerHTML =
    evidenceTabs() + head(
      "Record library",
      `<button class="primary" data-add="${esc(kind || "requirement")}">Add record</button>`,
    ) +
    searchBar(
      `<select id="recordKind" aria-label="Record type">${option("", "All record types", kind)}${options(info.kinds, kind)}</select>`,
    ) +
    table(
      ["Record", "State", "Revision"],
      p.items.map((e) =>
        row(
          [
            `${link(e.id)}<span class="title">${esc(e.title)}</span>${!kind ? `<span class="muted">${esc(nice(e.kind))}</span>` : ""}`,
            badge(e.state),
            e.revision,
          ],
          e.id === selected,
        ),
      ),
    ) +
    p.html;
}
function dataFacts(e) {
  return Object.entries(e.data)
    .filter(
      ([k, v]) =>
        ![
          "decision",
          "initial",
          "residual",
          "obligations",
          "evidence_content",
        ].includes(k) &&
        !k.startsWith("decision_") &&
        v !== "" &&
        v !== null,
    )
    .map(
      ([k, v]) =>
        `<div><dt>${esc(nice(k))}</dt><dd>${esc(Array.isArray(v) ? v.join("; ") : typeof v === "object" ? JSON.stringify(v) : v)}</dd></div>`,
    )
    .join("");
}
function requirementCard(r) {
  const vs = incoming(r.id, "verifies");
  const gaps = snapshot.coverage
    .flatMap((c) => c.gaps)
    .filter((g) => g.startsWith(r.id + "/"));
  return `<div class="trace-row"><div class="requirement-info">${link(r.id)}<p class="title">${esc(r.title)}</p></div><div class="requirement-status">${vs.length ? vs.map((v) => `<p>${link(v.id)}<br>${badge(`declared ${v.data.result || "not run"}`, v.data.result === "pass" ? "good" : "warn")}</p>`).join("") : badge("Missing verification", "warn")}</div><div class="actions"><button data-related="verification" data-target="${esc(r.id)}" data-relation="verifies">Add verification</button></div>${gaps.length ? `<p class="requirement-gap muted error">${esc([...new Set(gaps)].join("; "))}</p>` : ""}</div>`;
}
function renderInspector() {
  const e = byId(selected);
  if (!e) {
    $("#inspector").innerHTML =
      '<p class="empty">Select a record to inspect its assessment and links.</p>';
    return;
  }
  let body = `<div class="inspector-head"><div>${e.kind !== "hazard" ? `<p class="eyebrow">${esc(nice(e.kind))} · revision ${e.revision}</p>` : ""}<h2>${esc(e.id)}${e.kind === "hazard" ? ` <small class="object-revision">r${e.revision}</small>` : ""}</h2>${selectionHistory.length ? '<button class="link" id="backRecord">Back to previous record</button>' : ""}</div><button data-edit="${esc(e.id)}">Edit</button></div><p class="inspector-title">${esc(e.title)}</p>`;
  if (e.kind === "hazard") {
    const c = snapshot.coverage.find((c) => c.hazard === e.id);
    const relatedRuns = studyRecords.runs.filter(r => r.method !== "static_fta" && hazardsForRun(r).some(h => h.id === e.id));
    if (relatedRuns.length) body += `<section class="detail-section"><h3>RAM studies sharing equipment</h3>${relatedRuns.map(runButton).join(" · ")}</section>`;
    body += `<div class="buttons"><button data-method="bowtie">View bow tie</button></div><dl class="facts"><div><dt>Operating mode</dt><dd>${esc(e.data.mode || "Unspecified")}</dd></div><div><dt>System boundary</dt><dd>${esc(e.data.boundary || "Unspecified")}</dd></div></dl><section class="detail-section"><h3>Risk assessment</h3><dl class="risk">${["initial", "residual"].map((s) => `<div><dt>${s === "initial" ? "Initial" : "Residual"} risk</dt><dd><strong>${esc(e.data[s]?.severity || "—")} / ${esc(e.data[s]?.frequency || "—")}</strong>${badge(c?.[`${s}_risk`] || "unassessed", "warn")}</dd></div>`).join("")}</dl></section><section class="detail-section"><div class="section-head"><h3>Decision ${badge(c?.decision || "pending")}</h3><button data-decision="${esc(e.id)}">Record decision</button></div>${c?.decision_needs_review ? `<p>${badge("Applicability review required", "warn")}</p>` : ""}${e.data.decision?.rationale ? `<p class="muted">${esc(e.data.decision.rationale)}</p>` : ""}</section><section class="detail-section"><div class="section-head"><h3>Requirements (${c?.requirements.length || 0})</h3><button data-related="control" data-target="${esc(e.id)}" data-relation="controls">Add control</button></div>${(c?.requirements || []).map((id) => requirementCard(byId(id))).join("") || '<p class="muted">No implementing requirements linked.</p>'}<details class="control-links"><summary>Controls (${c?.controls.length || 0})</summary>${(c?.controls || []).map((id) => `<div class="record-row">${link(id)} · ${esc(byId(id).title)}<p><button data-related="requirement" data-target="${esc(id)}" data-relation="implements">Add requirement</button></p></div>`).join("")}</details></section>${c?.gaps.length ? `<details><summary>Coverage gaps (${c.gaps.length})</summary><ul class="muted">${c.gaps.map((g) => `<li>${esc(g)}</li>`).join("")}</ul></details>` : ""}`;
    const actionTargets = new Set([
      e.id,
      ...(c?.controls || []),
      ...(c?.requirements || []),
    ]);
    const actions = snapshot.entities.filter(
      (a) =>
        a.kind === "action" &&
        a.state !== "archived" &&
        !a.data.completion_evidence &&
        snapshot.links.some(
          (l) =>
            l.source === a.id &&
            l.relation === "addresses" &&
            actionTargets.has(l.target),
        ),
    );
    if (actions.length)
      body += `<section class="detail-section"><h3>Open actions (${actions.length})</h3>${actions.map((a) => `<div class="record-row">${link(a.id)}<p>${esc(a.title)}</p><p class="muted">${esc(a.data.owner || "Owner unassigned")} · ${esc(a.data.due || "Due date unassigned")}</p></div>`).join("")}</section>`;
  } else {
    body += e.description ? `<p>${esc(e.description)}</p>` : "";
    if (e.kind === "requirement") {
      body += `<section class="detail-section"><div class="section-head"><h3>Verification</h3><button data-related="verification" data-target="${esc(e.id)}" data-relation="verifies">Add verification</button></div>${
        incoming(e.id, "verifies")
          .map(
            (v) =>
              `<div class="record-row">${link(v.id)} · ${esc(v.title)} ${badge(`declared ${v.data.result || "not run"}`)}</div>`,
          )
          .join("") || '<p class="muted">No verification linked.</p>'
      }</section>`;
    }
    if (e.kind === "requirement" && e.data.obligations?.length)
      body += `<section class="detail-section"><h3>Verification obligations</h3>${table(
        ["ID", "Mode", "Configuration"],
        e.data.obligations.map((o) =>
          row([esc(o.id), esc(o.mode), esc(o.configuration)]),
        ),
      )}</section>`;
    body += `<section class="detail-section"><dl class="facts">${dataFacts(e)}</dl></section>`;
    if (e.data.evidence_content)
      body += `<section class="detail-section"><h3>Retained evidence content</h3><p>${esc(e.data.evidence_content.name)}</p><p class="muted">SHA-256 ${esc(e.data.evidence_content.sha256)}</p><button data-evidence="${esc(e.id)}">Download retained file</button></section>`;
  }
  const links = snapshot.links.filter(
    (l) => l.source === e.id || l.target === e.id,
  );
  if (e.kind !== "action") body += `<div class="detail-section"><button data-related="action" data-target="${esc(e.id)}" data-relation="addresses">Add follow-up action</button>${e.kind === "item" ? `<button data-related="item" data-target="${esc(e.id)}" data-relation="contains" data-reverse="true">Add child item</button>` : ""}</div>`;
  if (!portable && e.kind === 'item') body += `<p><button data-related="failure_mode" data-target="${esc(e.id)}" data-relation="fails">Analyze a failure mode</button></p>`;
  if (!portable && e.kind === 'control') body += `<p><button data-related="requirement" data-target="${esc(e.id)}" data-relation="implements">Add implementing requirement</button></p>`;
  if (!portable) body += `<p><button data-impact="${esc(e.id)}">Trace & change review</button></p>`;
  body += `<details class="detail-section"><summary>Relationships (${links.length})</summary><p><button data-link="${esc(e.id)}">Link existing</button></p>${links.map((l) => `<div class="record-row">${link(l.source === e.id ? l.target : l.source)} <span class="muted">${l.source === e.id ? "→" : "←"} ${esc(nice(l.relation))}</span><p class="muted">${esc(l.rationale)}</p></div>`).join("") || '<p class="muted">No relationships.</p>'}</details>`;
  $("#inspector").innerHTML = body;
}
const fields = {
  fault_gate: [
    ["logic", "Gate logic", "select", ["OR", "AND"]],
    ["mode", "Operating mode"],
  ],
  fault_event: [
    ["probability", "Basic-event probability at the stated horizon", "number"],
    ["mission_hours", "Probability horizon [h]", "number"],
    ["mode", "Operating mode"],
    ["source", "Probability source / revision"],
    ["conditions", "Probability conditions", "area"],
    [
      "dependency_status",
      "Dependency disposition",
      "select",
      ["unreviewed", "reviewed_independent"],
    ],
    ["dependency_review", "Dependency review rationale", "area"],
  ],
  hazard: [
    ["mode", "Operating mode"],
    ["boundary", "System boundary", "area"],
    ["owner", "Assessment owner"],
    ["severity", "Hazard severity"],
    ["initial.severity", "Initial severity"],
    ["initial.frequency", "Initial frequency"],
    ["residual.severity", "Residual severity"],
    ["residual.frequency", "Residual frequency"],
  ],
  control: [
    [
      "type",
      "Control type",
      "select",
      ["preventive", "mitigative", "recovery"],
    ],
    ["status", "Control status"],
    ["owner", "Owner"],
    ["independence_domain", "Independence domain", "area"],
    ["performance_standard", "Performance criterion / verification basis", "area"],
    ["degradation", "Degradation, bypass & unavailability conditions", "area"],
  ],
  requirement: [
    ["external_id", "External requirement ID"],
    ["source_system", "Source system"],
    ["source_baseline", "Source baseline"],
    [
      "verification_method",
      "Verification method",
      "select",
      ["analysis", "test", "inspection", "demonstration"],
    ],
  ],
  verification: [
    [
      "result",
      "Declared result",
      "select",
      ["not_run", "pass", "fail", "inconclusive"],
    ],
    ["artifact", "Artifact reference"],
    ["artifact_revision", "Artifact revision"],
    ["configuration", "Applicable configuration"],
    ["applicability", "Applicability statement", "area"],
    ["reviewer", "Reviewer declaration"],
    ["requirement_revision", "Requirement basis revision", "number"],
    ["mode", "Operating mode"],
    ["obligation", "Obligation ID"],
  ],
  item: [
    ["model", "Numerical model", "select", ["", "exponential"]],
    ["rate_per_hour", "Failure rate [1/h]", "number"],
    ["mean_active_repair_hours", "Mean active repair [h]", "number"],
    ["mode", "Operating mode"],
    ["source", "Data source / revision"],
    ["conditions", "Applicable conditions", "area"],
    [
      "dependency_status",
      "Dependency disposition",
      "select",
      ["unreviewed", "reviewed_independent"],
    ],
    ["dependency_review", "Dependency review rationale", "area"],
  ],
  operating_mode: [
    ["key", "Mode key"],
    ["conditions", "Conditions", "area"],
  ],
  study_node: [
    ["intent", "Design intent", "area"],
    ["mode", "Operating mode"],
    ["session", "Workshop / session"],
    ["participants", "Participants (one per line)", "lines"],
    ["source", "Design source"],
  ],
  deviation: [
    ["examination", "Examination disposition", "select", ["finding", "no_issue", "deferred", "not_applicable"]],
    ["examination_basis", "Examination / deferral rationale", "area"],
    ["parameter", "Parameter"],
    [
      "guideword",
      "Guide word",
      "select",
      [
        "No",
        "More",
        "Less",
        "As well as",
        "Part of",
        "Reverse",
        "Other than",
        "Early",
        "Late",
      ],
    ],
    ["causes", "Causes (one per line)", "lines"],
    ["consequences", "Consequences (one per line)", "lines"],
    ["safeguards", "Existing safeguards (one per line)", "lines"],
    ["recommendations", "Recommendations (one per line)", "lines"],
    ["action_owner", "Action owner"],
    ["hazard_disposition", "Hazard-log transfer / no-transfer rationale", "area"],
  ],
  failure_mode: [
    ["function", "Required function", "area"],
    ["mode", "Operating mode"],
    ["causes", "Failure causes / unknown-cause disposition (one per line)", "lines"],
    ["local_effect", "Local effect", "area"],
    ["next_effect", "Next-level effect", "area"],
    ["system_effect", "System effect", "area"],
    ["detection", "Detection", "area"],
    ["response", "Response / provision", "area"],
    ["source", "Source"],
    ["severity", "Severity classification"],
    ["criticality", "Criticality classification"],
    ["criticality_basis", "Criticality method / basis", "area"],
    ["hazard_disposition", "Hazard-log transfer / no-transfer rationale", "area"],
  ],
  action: [
    ["owner", "Owner"],
    ["due", "Due date (YYYY-MM-DD) / disposition"],
    ["completion_evidence", "Completion evidence", "area"],
  ],
  interface: [
    ["from", "From"],
    ["to", "To"],
    ["supplier_boundary", "Supplier boundary"],
    ["assumptions", "Assumptions (one per line)", "lines"],
  ],
  assumption: [
    ["rationale", "Rationale", "area"],
    ["validation_needed", "Validation needed", "area"],
    ["owner", "Owner"],
  ],
  srac: [
    ["condition", "Application condition", "area"],
    ["receiving_owner", "Receiving owner"],
    ["acceptance", "Acceptance disposition"],
    ["acceptance_reference", "Receiving decision reference"],
  ],
  cause: [],
  consequence: [],
  part_type: [],
  function: [],
};
const get = (obj, path) => path.split(".").reduce((v, k) => v?.[k], obj);
function put(obj, path, value) {
  const keys = path.split(".");
  let o = obj;
  for (const k of keys.slice(0, -1)) {
    if (typeof o[k] !== "object" || o[k] === null) o[k] = {};
    o = o[k];
  }
  o[keys.at(-1)] = value;
}
function field(
  name,
  label,
  value = "",
  type = "text",
  choices = [],
  required = false,
) {
  if (type === "select" && value !== "" && !choices.includes(value))
    choices = [value, ...choices];
  return `<label class="${["area", "lines"].includes(type) ? "full" : ""}">${esc(label)}${type === "select" ? `<select name="${esc(name)}" ${required ? "required" : ""}>${options(choices, value)}</select>` : ["area", "lines"].includes(type) ? `<textarea name="${esc(name)}" ${required ? "required" : ""}>${esc(Array.isArray(value) ? value.join("\n") : value)}</textarea>` : `<input name="${esc(name)}" type="${type === "number" ? "number" : "text"}" ${type === "number" ? 'step="any"' : ""} value="${esc(value)}" ${required ? "required" : ""}>`}</label>`;
}
function newID(k) {
  const prefix =
    {
      verification: "VER",
      requirement: "REQ",
      control: "CTRL",
      hazard: "HZ",
      study_node: "NODE",
      deviation: "DEV",
      failure_mode: "FM",
      item: "ITEM",
    }[k] || k.toUpperCase();
  let i = 1;
  while (byId(`${prefix}_${String(i).padStart(3, "0")}`)) i++;
  return `${prefix}_${String(i).padStart(3, "0")}`;
}
function edit(id = null, k = "hazard", rel = null) {
  const e = id ? byId(id) : null;
  editorRevision = snapshot.project.revision; pendingDraft = null; conflictContext = null;
  $("#draftRecovery")?.remove();
  editing = e
    ? clone(e)
    : {
        id: newID(k),
        kind: k,
        title: "",
        description: "",
        state: "draft",
        data: {},
        revision: 1,
      };
  editingIsNew = !e;
  related = rel;
  const d = editing.data;
  if (!e && k === "hazard")
    Object.assign(d, { mode: byId(rel?.target)?.data.mode || "normal", decision: { outcome: "pending" } });
  if (!e && k === 'failure_mode' && rel) d.mode = byId(rel.target)?.data.mode || '';
  if (!e && k === 'deviation') d.examination = 'finding';
  if (!e && k === "action") Object.assign(d, {owner:"", due:"", completion_evidence:""});
  if (!e && k === "verification") {
    Object.assign(d, { result: "not_run" });
    if (rel) {
      const req = byId(rel.target);
      d.requirement_revision = req?.revision;
      d.mode = "normal";
      const obligation = req?.data.obligations?.find(o => o.id === rel.obligation) || (req?.data.obligations?.length === 1 ? req.data.obligations[0] : null);
      if (obligation) Object.assign(d, {mode:obligation.mode, obligation:obligation.id, configuration:obligation.configuration});
    }
  }
  $("#editorType").textContent = nice(editing.kind);
  $("#editorTitle").textContent = e ? `Edit ${e.id}` : `Add ${k === "deviation" ? "HAZOP examination" : nice(k)}`;
  $("#entityFields").innerHTML =
    `${rel ? `<p class="result-state">${rel.reverse ? esc(rel.target) : "This record"} → ${esc(nice(rel.relation))} → ${rel.reverse ? "this record" : esc(rel.target)} · saved together</p>` : ""}<div class="form-grid">${e ? `<div class="read-only">Stable ID<br><strong>${esc(e.id)}</strong></div>` : field("id", "Stable ID", editing.id, "text", [], true)}${field("state", "Workflow state", editing.state, "select", info.states)}<div class="full">${field("title", "Title", editing.title, "text", [], true)}</div>${field("description", k === "requirement" ? "Requirement text" : "Description", editing.description, "area")}<fieldset><legend>${k === "item" ? "Component parameters (optional)" : k === "hazard" ? "Assessment" : "Record details"}</legend><div class="form-grid">${recordFields(editing)}</div></fieldset>${editing.kind === "verification" ? '<label class="full">Retain evidence file (optional, maximum 32 KiB)<input name="attachment" type="file"><span class="muted">Bytes and SHA-256 are retained in the study export. A file does not prove a successful test.</span></label>' : ""}${editing.kind === "requirement" ? `<fieldset><legend>Verification obligations</legend><p class="muted">Define each required mode and configuration explicitly.</p><div id="obligations">${(d.obligations || []).map(obligationRow).join("")}</div><button type="button" id="addObligation">Add obligation</button></fieldset>` : ""}</div>`;
  $("#entityError").textContent = "";
  draftDirty = false;
  $("#editor").showModal();
}
function recordFields(e) {
  const entries = (fields[e.kind] || []).map(([key, label, type, choices]) =>
    field(`data.${key}`, label, get(e.data, key) ?? "", type, choices),
  );
  if (e.kind !== "item") return entries.join("");
  return `<label>Numerical model<select name="data.model">${option("", "Structural item", e.data.model || "")}${option("exponential", "Exponential component", e.data.model || "")}${e.data.model && !["exponential"].includes(e.data.model) ? option(e.data.model, e.data.model + " (imported model)", e.data.model) : ""}</select></label><div id="numericalFields" class="form-grid full" ${e.data.model === "exponential" ? "" : "hidden"}>${entries.slice(1).join("")}</div>`;
}
function obligationRow(o = {}) {
  return `<div class="obligation form-grid">${field("ob_id", "Obligation ID", o.id || "")}${field("ob_mode", "Operating mode", o.mode || "")}${field("ob_config", "Configuration", o.configuration || "")}<button type="button" data-remove-obligation>Remove obligation</button></div>`;
}
function focusSelection() {
  const target =
    $("#inspector [data-edit]") ||
    $("#graphDock [data-edit]") ||
    $("#studyDock [data-edit]") ||
    $("#main");
  target?.focus();
}
function closeEditor() {
  if (draftDirty && !confirm("Discard the unsaved record draft?")) return;
  $("#editor").close();
  draftDirty = false;
}
async function evidenceContent(file) {
  if (file.size > 32768)
    throw new Error(
      "Evidence file exceeds 32 KiB. Keep larger artifacts in controlled storage and record a reference.",
    );
  const bytes = new Uint8Array(await file.arrayBuffer());
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return {
    name: file.name,
    media_type: file.type || "application/octet-stream",
    sha256: [...new Uint8Array(hash)]
      .map((v) => v.toString(16).padStart(2, "0"))
      .join(""),
    base64: btoa(String.fromCharCode(...bytes)),
  };
}
$("#entityForm").oninput = event => {
  draftDirty = true;
  if (!event.target.closest('#draftRecovery')) {
    $('#draftRecovery')?.remove(); pendingDraft = null; conflictContext = null;
  }
};
$("#entityForm").onsubmit = async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const submit = f.querySelector("button.primary");
  submit.disabled = true;
  try {
    const e = clone(editing);
    if (editingIsNew) {
      e.id = f.elements.id.value.trim();
      if (byId(e.id))
        throw new Error(
          "This stable ID already exists. Choose a new ID; the existing record has not changed.",
        );
    }
    e.title = f.elements.title.value.trim();
    e.description = f.elements.description.value;
    e.state = f.elements.state.value;
    for (const [key, , type] of fields[e.kind] || []) {
      const value = f.elements[`data.${key}`].value;
      if (
        e.kind === "item" &&
        !f.elements["data.model"].value &&
        [
          "model",
          "rate_per_hour",
          "mean_active_repair_hours",
          "dependency_status",
        ].includes(key)
      ) {
        delete e.data[key];
        continue;
      }
      if (type === "number") {
        if (value === "") {
          delete e.data[key];
          continue;
        }
        put(e.data, key, Number(value));
      } else
        put(
          e.data,
          key,
          type === "lines"
            ? value
                .split("\n")
                .map((s) => s.trim())
                .filter(Boolean)
            : value,
        );
    }
    if (e.kind === "requirement")
      e.data.obligations = [...f.querySelectorAll(".obligation")].map((el) => ({
        id: el.querySelector("[name=ob_id]").value.trim(),
        mode: el.querySelector("[name=ob_mode]").value.trim(),
        configuration: el.querySelector("[name=ob_config]").value.trim(),
      }));
    if (e.kind === "verification" && f.elements.attachment.files[0])
      e.data.evidence_content = await evidenceContent(
        f.elements.attachment.files[0],
      );
    pendingDraft = clone(e);
    delete e.revision;
    const op = related
      ? {
          related: {
            entity: e,
            link: {
              source: related.reverse ? related.target : e.id,
              relation: related.relation,
              target: related.reverse ? e.id : related.target,
              rationale:
                related.rationale ||
                "Created from the linked record workspace; applicability requires review.",
            },
          },
        }
      : editingIsNew
        ? { create_entity: e }
        : { entity: e };
    await mutate(op, editorRevision);
    selected = e.id;
    draftDirty = false;
    $("#editor").dataset.focusSelection = "true";
    $("#editor").close();
    render();
    notice(`Saved ${e.id}${related ? " and its relationship" : ""}.`);
  } catch (e) {
    $("#entityError").textContent = e.message;
    if (e.status === 409 && pendingDraft) {
      $("#draftRecovery")?.remove();
      $("#entityError").insertAdjacentHTML("afterend", '<div id="draftRecovery"><p>Your draft is still here. Compare it with the latest saved record before saving again.</p><div class="buttons"><button type="button" id="reconcileDraft">Compare latest revision</button><button type="button" id="downloadDraft">Download my draft</button></div><div id="conflictFields"></div></div>');
    }
  } finally {
    submit.disabled = false;
  }
};
for (const id of ["#editor", "#actionDialog"])
  $(id).addEventListener("close", (ev) => {
    if (ev.target.dataset.focusSelection) {
      delete ev.target.dataset.focusSelection;
      focusSelection();
    }
  });
$("#closeEditor").onclick = closeEditor;
$("#cancelEditor").onclick = closeEditor;
$("#editor").addEventListener("cancel", (e) => {
  e.preventDefault();
  closeEditor();
});
function action(title, html, handler, submit = "Save") {
  actionHandler = handler;
  $("#actionForm").dataset.dirty = "false";
  $("#actionTitle").textContent = title;
  $("#actionFields").innerHTML = html;
  $("#actionError").textContent = "";
  $("#actionSubmit").textContent = submit;
  $("#actionDialog").showModal();
}
function closeAction() {
  if ($("#actionForm").dataset.dirty === "true" && !confirm("Discard the unsaved changes?")) return;
  $("#actionDialog").close();
}
$("#actionForm").oninput = () => $("#actionForm").dataset.dirty = "true";
$("#closeAction").onclick = closeAction;
$("#actionDialog").addEventListener("cancel", e => { e.preventDefault(); closeAction(); });
$("#actionForm").onsubmit = async (e) => {
  e.preventDefault();
  $("#actionSubmit").disabled = true;
  try {
    await actionHandler(e.target);
    $("#actionDialog").dataset.focusSelection = "true";
    $("#actionDialog").close();
  } catch (err) {
    $("#actionError").textContent = err.message;
  } finally {
    $("#actionSubmit").disabled = false;
  }
};
function decision(id) {
  const e = byId(id),
    d = e.data.decision || { outcome: "pending" };
  action(
    `Decision · ${id}`,
    `<p class="muted">This records a local declaration. It does not authenticate an approval authority or close evidence gaps.</p><div class="form-grid">${field("outcome", "Outcome", d.outcome, "select", ["pending", "accepted", "rejected", "conditional"])}${field("authority", "Authority declaration", d.authority || "")}${field("date", "Decision date", d.date || "")}${field("basis_revision", "Hazard basis revision", d.basis_revision || e.revision, "number")}${field("rationale", "Decision rationale", d.rationale || "", "area")}${field("evidence", "Evidence / conditions", d.evidence || "", "area")}</div>`,
    async (f) => {
      const updated = clone(e);
      updated.data.decision = Object.fromEntries(
        ["outcome", "authority", "date", "rationale", "evidence"].map((k) => [
          k,
          f.elements[k].value,
        ]),
      );
      updated.data.decision.basis_revision = Number(
        f.elements.basis_revision.value,
      );
      await mutate({ entity: updated });
      notice(
        "Decision declaration recorded against the current engineering content.",
      );
    },
  );
}
const endpoints = {
  input_to: [["fault_event", "fault_gate"], ["fault_gate"]],
  analyzes: [["fault_gate"], ["hazard", "failure_mode"]],
  prevents: [["control"], ["cause"]],
  mitigates: [["control"], ["consequence"]],
  contains: [["item"], ["item"]],
  instance_of: [["item"], ["part_type"]],
  operates_in: [null, ["operating_mode"]],
  applies_to: [null, ["item", "function", "interface"]],
  causes: [
    ["cause", "failure_mode", "deviation", "hazard"],
    ["hazard", "consequence"],
  ],
  controls: [["control"], ["hazard"]],
  implements: [["requirement"], ["control"]],
  verifies: [["verification"], ["requirement", "control"]],
  depends_on: [null, null],
  addresses: [["action", "srac", "assumption"], null],
  studies: [["study_node"], ["item", "function", "interface"]],
  deviates: [["deviation"], ["study_node"]],
  fails: [["failure_mode"], ["item", "function"]],
};
function relationshipList(id) {
  const links = snapshot.links.filter(
    (l) => l.source === id || l.target === id,
  );
  return `<h3>Existing relationships</h3>${links.map((l) => `<div class="relationship-edit"><span>${esc(l.source)} · ${esc(nice(l.relation))} · ${esc(l.target)}<br><small>${esc(l.rationale)}</small></span><button type="button" data-unlink="${esc(JSON.stringify({ source: l.source, relation: l.relation, target: l.target }))}" data-link-owner="${esc(id)}">Remove</button></div>`).join("") || '<p class="muted">No relationships yet.</p>'}${lastRemovedLink && (lastRemovedLink.source === id || lastRemovedLink.target === id) ? `<p><button type="button" id="restoreLink" data-link-owner="${esc(id)}">Restore last removed relationship</button></p>` : ""}`;
}
function linkExisting(id) {
  const e = byId(id);
  action(
    `Link ${id}`,
    `<div id="actionLinks">${relationshipList(id)}</div><h3>Add relationship</h3><div class="form-grid">${field("direction", "Direction", "out", "select", ["out", "in"])}${field("relation", "Relationship", "", "select", Object.keys(endpoints))}<label class="full">Other record<select name="target"></select></label>${field("rationale", "Engineering rationale", "", "area", [], true)}</div>`,
    async (f) => {
      const out = f.elements.direction.value === "out";
      await mutate({
        link: {
          source: out ? id : f.elements.target.value,
          relation: f.elements.relation.value,
          target: out ? f.elements.target.value : id,
          rationale: f.elements.rationale.value,
        },
      });
      notice("Relationship saved.");
    },
  );
  const f = $("#actionForm");
  function choices() {
    const out = f.elements.direction.value === "out";
    const allowed = Object.entries(endpoints).filter(
      ([, ends]) => !ends[out ? 0 : 1] || ends[out ? 0 : 1].includes(e.kind),
    );
    const old = f.elements.relation.value;
    f.elements.relation.innerHTML = allowed
      .map(([r]) => option(r, r, old))
      .join("");
    const ends = endpoints[f.elements.relation.value];
    f.elements.target.innerHTML = snapshot.entities
      .filter(
        (o) =>
          o.id !== id &&
          (!ends[out ? 1 : 0] || ends[out ? 1 : 0].includes(o.kind)),
      )
      .map((o) => option(o.id, `${o.id} · ${o.title}`))
      .join("");
  }
  f.elements.direction.onchange = choices;
  f.elements.relation.onchange = choices;
  choices();
}
function renderStudies() {
  if (method === "bowtie") {
    renderBowtie().catch((e) => notice(e.message));
    return;
  }
  if (method === "fta") {
    renderFTA().catch((e) => notice(e.message));
    return;
  }
  const fm = method === "fmeca";
  const type = fm ? "failure_mode" : "deviation",
    data = matching(type);
  if (
    !["deviation", "failure_mode", "study_node"].includes(byId(selected)?.kind)
  )
    selected = data[0]?.id || "";
  const p = paginate(data);
  $("#content").innerHTML =
    `${methodTabs()}${head(fm ? "Failure modes & effects" : "HAZOP worksheet", `<div class="buttons">${!fm ? '<button data-add="study_node">Add study node</button>' : ""}<button class="primary" data-add="${type}">Add ${fm ? "failure mode" : "examination"}</button></div>`)}${searchBar()}<div class="worksheet">${table(
      fm
        ? [
            "Failure mode",
            "Function / causes",
            "Effects: local → next → end",
            "Detection",
            "Response / provision",
            "Criticality notes",
          ]
        : [
            "Deviation / study node",
            "Parameter / guide word",
            "Causes",
            "Consequences",
            "Existing safeguards",
            "Recommendations / owner",
          ],
      p.items.map((e) =>
        row(
          fm
            ? [
                `${link(e.id)}<span class="title">${esc(e.title)}</span><span class="muted">${esc(e.data.mode)}</span>`,
                `${esc(e.data.function || "Function not recorded")}<p class="muted">${esc(lineText(e.data.causes))}</p>`,
                `<strong>Local:</strong> ${esc(e.data.local_effect)}<p><strong>Next:</strong> ${esc(e.data.next_effect || "Not recorded")}</p><p><strong>End:</strong> ${esc(e.data.system_effect)}</p>`,
                esc(e.data.detection),
                esc(e.data.response),
                `${esc(e.data.severity || "Unassessed")} · ${esc(e.data.criticality || "Unassessed")}<p class="muted">${esc(e.data.criticality_basis || "")}</p>`,
              ]
            : [
                `${link(e.id)}<span class="title">${esc(e.title)}</span>${outgoing(
                  e.id,
                  "deviates",
                )
                  .map((n) => `<p>${link(n.id)}</p>`)
                  .join("")}`,
                `${esc(e.data.parameter)}<br>${badge(e.data.guideword || "Unspecified")}<p>${badge(e.data.examination || "finding", e.data.examination === "deferred" ? "warn" : "")}</p><p class="muted">${esc(e.data.examination_basis || "")}</p>`,
                esc(lineText(e.data.causes)),
                esc(lineText(e.data.consequences)),
                esc(lineText(e.data.safeguards)),
                `${esc(lineText(e.data.recommendations))}<p class="muted">${esc(e.data.action_owner || "Owner unassigned")}</p>`,
              ],
          e.id === selected,
        ),
      ),
    )}${p.html}</div><div id="studyDock"></div>${
      !fm
        ? `<details><summary>Study nodes (${matching("study_node").length})</summary>${matching(
            "study_node",
          )
            .map(
              (e) =>
                `<div class="record-row">${link(e.id)} · ${esc(e.title)}<p class="muted">${esc(e.data.intent)}</p></div>`,
            )
            .join("")}</details>`
        : ""
    }`;
  const e = byId(selected);
  $("#studyDock").innerHTML = e
    ? `<div class="dock"><div><p class="eyebrow">Selected ${esc(nice(e.kind))} · ${esc(e.id)}</p><h2>${esc(e.title)}</h2><p>${esc(e.description || e.data.intent || "")}</p><div class="buttons">${snapshot.links
        .filter((l) => l.source === e.id || l.target === e.id)
        .map((l) => link(l.source === e.id ? l.target : l.source))
        .join(
          " ",
        )}</div></div><div class="buttons"><button data-edit="${esc(e.id)}">Edit selected record</button><button data-link="${esc(e.id)}">Link existing</button><button data-related="action" data-target="${esc(e.id)}" data-relation="addresses">Add action</button>${e.kind === "study_node" ? `<button data-related="deviation" data-target="${esc(e.id)}" data-relation="deviates">Add examination</button>` : ""}${e.kind === "failure_mode" || e.kind === "deviation" ? `<button data-related="hazard" data-target="${esc(e.id)}" data-relation="causes" data-reverse="true">Create linked hazard</button>` : ""}</div></div>`
    : '<p class="empty">Select a worksheet row to inspect its links or edit it.</p>';
}
function saveAnalysis() {
  if (!snapshot || !analysisDraft) return;
  const f = $("#analysis");
  if (f) {
    for (const k of [
      "name",
      "mode",
      "success",
      "mission_hours",
      "repair_target_hours",
      "dependency_status",
      "independence",
    ])
      analysisDraft[k] = ["mission_hours", "repair_target_hours"].includes(k)
        ? f.elements[k].value
        : f.elements[k].value;
  }
  analysisDraft.tree = tree;
  uiStorage.setItem(
    `rams-analysis-${snapshot.project.id}`,
    JSON.stringify(analysisDraft),
  );
}
function topologyHTML(node, path = "") {
  if (!node)
    return '<p class="muted">Add a component or a group to begin.</p><div class="buttons"><button type="button" data-root="item">Add component</button><button type="button" data-root="group">Add group</button></div>';
  const comps = snapshot.entities.filter(
    (e) => e.kind === "item" && e.state !== "archived",
  );
  return `<div class="node"><div class="node-head">${node.item !== undefined ? `<select aria-label="Component ${esc(path || "root")}" data-component="${esc(path)}">${option("", "Select component", node.item)}${comps.map((e) => option(e.id, `${e.id} · ${e.title}`, node.item)).join("")}</select>` : `<select aria-label="Group logic ${esc(path || "root")}" data-gate="${esc(path)}">${option("series", "Series · all required", node.op)}${option("parallel", "Active parallel · any one sufficient", node.op)}</select>`}<button type="button" data-remove-node="${esc(path)}">Remove</button></div>${node.children ? `<div class="node-actions"><button type="button" data-child="${esc(path)}" data-child-type="item">Add component</button><button type="button" data-child="${esc(path)}" data-child-type="group">Add nested group</button></div>${node.children.map((n, i) => topologyHTML(n, path ? `${path}.${i}` : String(i))).join("")}` : ""}</div>`;
}
function renderRAMEditor() {
  diagramSVG = "";
  diagramName = "";
  const d = analysisDraft || defaultAnalysis();
  $("#content").innerHTML =
    head(
      "RAM study",
      '<button data-view="baselines">Historical runs</button>',
    ) +
    `<section class="ram-graphic"><h2>Success schematic</h2><div class="toolbar"><button type="button" id="previewRBD">Refresh draft schematic</button>${diagramTools()}</div><div class="engineering-diagram" id="rbdDiagram"><p class="empty">${tree ? "Drawing the draft topology…" : "Add a component or a group below to start the success model."}</p></div></section><div class="study-layout"><form id="analysis"><h2>Study definition</h2><div class="form-grid">${field("name", "Study name", d.name, "text", [], true)}${field("mode", "Operating mode", d.mode, "text", [], true)}${field("success", "Success condition", d.success, "area", [], true)}${field("mission_hours", "Mission duration [h]", d.mission_hours, "number", [], true)}${field("repair_target_hours", "Active repair target [h]", d.repair_target_hours, "number", [], true)}</div><h3>Success topology</h3><p class="muted">Physical containment does not define the RBD. Each installed component may appear once.</p><div class="topology" id="topology">${topologyHTML(tree)}</div><details><summary>Dependency review & assumptions</summary><div class="form-grid">${field("dependency_status", "Study dependency disposition", d.dependency_status, "select", ["unreviewed", "reviewed_independent", "factored_shared_support"])}${field("independence", "Independence and repair-resource rationale", d.independence, "area", [], true)}</div><p class="muted">Independent active exponential components; unlimited separate active repair resources. No standby, load sharing, operational availability, shared crews or general CCF model.</p></details><div class="form-actions"><button class="primary">Calculate & retain run</button></div></form><section class="results" id="results" aria-label="Calculation results"></section></div>`;
  renderResults();
  if (tree) previewRBD();
  $("#analysis").oninput = () => {
    analysisDirty = true;
    saveAnalysis();
    renderResults();
  };
  $("#analysis").onchange = () => {
    analysisDirty = true;
    saveAnalysis();
    renderResults();
  };
  $("#analysis").onsubmit = async (ev) => {
    ev.preventDefault();
    saveAnalysis();
    try {
      const c = clone(analysisDraft);
      for (const k of ["mission_hours", "repair_target_hours"]) {
        if (String(c[k]).trim() === "" || !Number.isFinite(Number(c[k])))
          throw new Error("Enter finite mission and repair durations.");
        c[k] = Number(c[k]);
      }
      currentRun = await api("/api/analyze", {
        project: snapshot.project.id,
        expected: snapshot.project.revision,
        config: c,
      });
      analysisDirty = false;
      ramEditing = false;
      studyRecords = await api(url("/api/records"));
      render();
      notice("Calculation retained with its exact snapshot and inputs.");
    } catch (e) {
      notice(e.message);
      $("#results").innerHTML =
        `<h2>Calculation unavailable</h2><p class="error">${esc(e.message)}</p><p class="muted">Your draft is retained. No run was saved.</p>`;
    }
  };
}
function nodeAt(path) {
  return path === ""
    ? tree
    : path.split(".").reduce((n, i) => n.children[Number(i)], tree);
}
function treeChanged() {
  ++diagramToken;
  diagramSVG = "";
  if ($("#rbdDiagram"))
    $("#rbdDiagram").innerHTML = "Draft changed; refresh the schematic.";
  analysisDirty = true;
  saveAnalysis();
  $("#topology").innerHTML = topologyHTML(tree);
  renderResults();
}
function components(node) {
  if (!node) return [];
  return node.item ? [node] : (node.children || []).flatMap(components);
}
function earlierProducer(run, method) {
  const current = info.producers?.[method],
    old = run.basis?.producer;
  return (
    !current ||
    !old ||
    current.engine_source_sha256 !== old.engine_source_sha256 ||
    current.python !== old.python
  );
}
function renderResults() {
  const el = $("#results");
  if (!el) return;
  if (!currentRun) {
    el.innerHTML =
      '<h2>Results</h2><p class="empty">Define the success topology and dependency review, then calculate.</p>';
    return;
  }
  const r = currentRun.result,
    c = currentRun.basis.config;
  const pct = (n) => (n * 100).toFixed(6) + "%";
  const stale =
    currentRun.project_revision !== snapshot.project.revision ||
    analysisDirty ||
    earlierProducer(currentRun, "rbd");
  el.innerHTML = `<h2>${esc(c.name)}</h2><p class="result-state">${stale ? "Historical result · inputs or producer differ" : "Retained result"} · project revision ${currentRun.project_revision}</p><div class="metrics"><div class="metric"><strong>${pct(r.mission_reliability)}</strong><span>Mission reliability · ${c.mission_hours} h</span></div><div class="metric"><strong>${r.mission_failure_probability.toExponential(6)}</strong><span>Mission failure probability</span></div><div class="metric"><strong>${pct(r.inherent_availability)}</strong><span>Steady-state inherent availability</span><span>U: ${Number.isFinite(r.inherent_unavailability) ? r.inherent_unavailability.toExponential(6) : "not retained"}</span></div></div><h3>Component maintainability</h3>${table(
    ["Component", "P(active repair ≤ " + c.repair_target_hours + " h)"],
    components(r).map((n) =>
      row([link(n.item), pct(n.repair_completion_probability)]),
    ),
  )}<h3>Mission reliability curve</h3><canvas id="reliabilityChart" role="img" aria-label="Reliability versus mission duration; exact values in the following table"></canvas><p class="muted">Exact sampled values are retained below. No equivalent constant failure rate is inferred.</p><details><summary>View time / probability values</summary>${table(
    ["Time [h]", "Reliability"],
    currentRun.curve.map((p) => row([p.hours, p.reliability.toPrecision(12)])),
  )}</details><details><summary>Applicability & producer</summary><p>${esc(c.success)}</p><p class="muted">${esc(c.independence)}</p><ul>${currentRun.applicability.map((a) => `<li>${esc(a)}</li>`).join("")}</ul><pre class="run-json">${esc(JSON.stringify(currentRun.basis.producer, null, 2))}</pre></details>${currentRun.warnings?.length ? `<p class="error">${currentRun.warnings.map(esc).join("; ")}</p>` : ""}<button id="downloadRun">Download full run</button>${!portable ? `<section class="detail-section"><h3>What drives this result?</h3><p>Review component importance and one-at-a-time failure-rate scenarios at this retained mission.</p><button data-importance="${esc(currentRun.id)}">Analyze importance & sensitivity</button><div id="importance-${esc(currentRun.id)}"></div></section>` : ""}`;
  drawReliability();
}
async function renderBaselines() {
  const project = snapshot.project.id;
  $("#content").innerHTML =
    head(
      "Baselines & change review",
      '<button class="primary" id="freeze">Freeze baseline</button>',
    ) +
    '<p class="muted">Frozen snapshots and runs retain their original inputs. Capturing a baseline does not approve it.</p><div id="recordsBody"></div>';
  const data = await api(url("/api/records"));
  if (view !== "baselines" || snapshot.project.id !== project) return;
  $("#recordsBody").innerHTML =
    `<section class="detail-section"><h2>Baselines</h2>${table(
      ["Label", "Captured", "Actions"],
      data.baselines.map((b) =>
        row([
          esc(b.label),
          esc(b.at),
          `<div class="buttons"><button data-compare="${b.id}">Compare to working</button><button data-record="${b.id}" data-kind="baselines">Download</button></div>`,
        ]),
      ),
    )}</section><div id="delta"></div><section class="detail-section"><h2>Calculation runs</h2>${table(
      ["Run", "Revision", "Captured", ""],
      data.runs.map((r) =>
        row([
          esc(r.name || r.id.slice(0, 14)),
          r.revision,
          esc(r.at),
          `<button data-record="${r.id}" data-kind="runs">Open run</button>`,
        ]),
      ),
    )}</section><details><summary>Change history (${data.history.length})</summary>${table(
      ["Revision", "Time", "Actor declaration", "Operation"],
      data.history
        .slice(0, 100)
        .map((h) =>
          row([
            h.revision,
            esc(h.at),
            esc(h.actor),
            esc(Object.keys(JSON.parse(h.payload)).join(", ")),
          ]),
        ),
    )}</details>`;
}
function fieldDifferences(before, after, path = "") {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (
    before &&
    after &&
    typeof before === "object" &&
    typeof after === "object"
  )
    return [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter((k) => k !== "import_lineage")
      .flatMap((k) =>
        fieldDifferences(before[k], after[k], path ? path + "." + k : k),
      );
  return [
    {
      path,
      before: before === undefined ? "(absent)" : JSON.stringify(before),
      after: after === undefined ? "(absent)" : JSON.stringify(after),
    },
  ];
}
function diffTable(diffs) {
  if (!diffs.length) return "";
  return `${table(
    ["Field", "Baseline value", "Working value"],
    diffs
      .slice(0, 100)
      .map((d) =>
        row([
          esc(d.path),
          `<span class="diff">${esc(d.before)}</span>`,
          `<span class="diff">${esc(d.after)}</span>`,
        ]),
      ),
  )}${diffs.length > 100 ? `<p class="muted">Showing 100 of ${diffs.length} changes. Download both complete snapshots for the remaining fields.</p>` : ""}`;
}
async function compare(id) {
  const base = await api(
    `${url("/api/record")}&kind=baselines&id=${encodeURIComponent(id)}`,
  );
  const old = base.snapshot || base;
  const a = new Map(old.entities.map((e) => [e.id, e])),
    b = new Map(snapshot.entities.map((e) => [e.id, e]));
  const changes = [];
  for (const [id, e] of b) {
    if (!a.has(id)) changes.push(row([esc(id), "Added", esc(e.title)]));
    else {
      const before = a.get(id);
      const keys = ["title", "description", "state", "data"].filter(
        (k) => JSON.stringify(before[k]) !== JSON.stringify(e[k]),
      );
      if (keys.length)
        changes.push(
          row([
            link(id),
            "Changed",
            `<details><summary>${esc(keys.join(", "))}</summary>${diffTable(keys.flatMap((k) => fieldDifferences(before[k], e[k], k)))}</details>`,
          ]),
        );
    }
  }
  for (const [id, e] of a)
    if (!b.has(id)) changes.push(row([esc(id), "Removed", esc(e.title)]));
  const identity = (l) => `${l.source}|${l.relation}|${l.target}`;
  const al = new Map(old.links.map((l) => [identity(l), l])),
    bl = new Map(snapshot.links.map((l) => [identity(l), l]));
  const lc = [];
  for (const [k, l] of bl) {
    if (!al.has(k)) lc.push(`Added ${k}`);
    else if (l.rationale !== al.get(k).rationale)
      lc.push(`Rationale changed ${k}`);
  }
  for (const k of al.keys()) if (!bl.has(k)) lc.push(`Removed ${k}`);
  $("#delta").innerHTML =
    `<section class="detail-section"><h2>Baseline → working revision ${snapshot.project.revision}</h2>${changes.length ? table(["Record", "Change", "Fields"], changes) : "<p>No entity changes.</p>"}<h3>Relationships</h3><p class="diff">${esc(lc.join("\n") || "No relationship changes.")}</p><p>Project criteria / context: ${JSON.stringify(old.project.config) === JSON.stringify(snapshot.project.config) ? "unchanged" : "changed — review governing criteria and applicability"}</p>${diffTable(fieldDifferences(old.project.config, snapshot.project.config))}</section>`;
}
function standardsRows(standards = [], offset = 0) {
  return standards
    .map(
      (s, i) =>
        `<div class="standard form-grid" data-original-index="${i + offset}">${field("standard_name", "Standard / reference", typeof s === "string" ? s : s.name || s.id || "")}${field("standard_edition", "Governing edition", typeof s === "string" ? "" : s.edition || "")}<button type="button" data-remove-standard>Remove reference</button></div>`,
    )
    .join("");
}
function renderSetup() {
  const c = snapshot.project.config,
    m = c.risk_matrix;
  $("#content").innerHTML =
    head("Project setup") +
    `<form id="setupForm" class="settings"><section><h2>Study context</h2><div class="form-grid">${field("profile", "Project profile", c.profile || "")}${field("lifecycle_phase", "Lifecycle phase / intended decision", c.lifecycle_phase || "")}${field("configuration", "Design / operational configuration", c.configuration || "")}${field("system_boundary", "System boundary, interfaces & exclusions", c.system_boundary || "", "area")}${field("operating_context", "Operating context", c.operating_context || "", "area")}${field("acceptance_process", "Acceptance process and authority", c.acceptance_process || "", "area")}</div></section><section><h2>Governing references</h2><p class="muted">Record the contractually governing edition. A current publisher edition is not automatically applicable.</p>${field("governing_basis", "Reference selection / non-standard basis", c.governing_basis || "", "area")}<div id="standards">${standardsRows(c.governing_standards)}</div><button type="button" id="addStandard">Add reference</button></section><section><div class="section-head"><h2>Operating modes</h2><button type="button" data-add="operating_mode">Add mode</button></div>${
      snapshot.entities
        .filter((e) => e.kind === "operating_mode")
        .map(
          (e) =>
            `<div class="record-row">${link(e.id)} · ${esc(e.title)} <button type="button" data-edit="${esc(e.id)}">Edit mode</button></div>`,
        )
        .join("") || '<p class="muted">No operating modes defined.</p>'
    }</section><section><h2>Risk criteria</h2><p class="muted">Explicit category lookup. Missing cells remain unassessed; categories are never multiplied or summed.</p><div class="form-grid">${field("matrix_id", "Matrix ID", m?.id || "")}${field("matrix_revision", "Policy revision", m?.revision || "")}${field("matrix_source", "Policy source", m?.source || "")}${field("severity_classes", "Severity classes (one per line)", m?.severity_classes || [], "lines")}${field("frequency_classes", "Frequency classes (one per line)", m?.frequency_classes || [], "lines")}</div><p><button type="button" id="rebuildMatrix">Update matrix grid</button></p><div id="matrixGrid">${matrixGrid(m)}</div></section><div class="form-actions"><button class="primary">Save project setup</button></div>${c.import_lineage || c.imported_from ? `<details><summary>Import lineage (read only)</summary><pre>${esc(JSON.stringify(c.import_lineage || c.imported_from, null, 2))}</pre></details>` : ""}<details><summary>Full configuration (read only)</summary><pre>${esc(JSON.stringify(c, null, 2))}</pre></details></form>`;
  $("#setupForm").onsubmit = saveSetup;
  $("#setupForm").oninput = () => (setupDirty = true);
}
function lines(value) {
  return value
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);
}
function matrixGrid(m) {
  if (!m?.severity_classes?.length || !m?.frequency_classes?.length)
    return '<p class="muted">Define classes and update the grid to enter criteria.</p>';
  return table(
    ["Severity / frequency", ...m.frequency_classes],
    m.severity_classes.map((s) =>
      row([
        esc(s),
        ...m.frequency_classes.map(
          (f) =>
            `<input class="matrix-cell" aria-label="Category ${esc(s)} ${esc(f)}" data-severity="${esc(s)}" data-frequency="${esc(f)}" value="${esc(m.cells?.find((c) => c.severity === s && c.frequency === f)?.category || "")}">`,
        ),
      ]),
    ),
    "matrix",
  );
}
function readCells() {
  return [...document.querySelectorAll(".matrix-cell")]
    .filter((e) => e.value.trim())
    .map((e) => ({
      severity: e.dataset.severity,
      frequency: e.dataset.frequency,
      category: e.value.trim(),
    }));
}
async function saveSetup(ev) {
  ev.preventDefault();
  try {
    const f = ev.target,
      c = clone(snapshot.project.config);
    for (const k of ["profile", "lifecycle_phase", "configuration", "system_boundary", "governing_basis", "operating_context", "acceptance_process"])
      c[k] = f.elements[k].value;
    c.governing_standards = [...f.querySelectorAll(".standard")].map(
      (el, i) => ({
        ...((typeof c.governing_standards?.[
          Number(el.dataset.originalIndex)
        ] === "object" &&
          c.governing_standards[Number(el.dataset.originalIndex)]) ||
          {}),
        name: el.querySelector("[name=standard_name]").value,
        edition: el.querySelector("[name=standard_edition]").value,
      }),
    );
    if (f.elements.matrix_id.value.trim()) {
      const ss = lines(f.elements.severity_classes.value),
        fs = lines(f.elements.frequency_classes.value);
      const cells = readCells();
      if (
        cells.some((v) => !ss.includes(v.severity) || !fs.includes(v.frequency))
      )
        throw new Error(
          "Update the matrix grid after changing classes before saving.",
        );
      c.risk_matrix = {
        ...(c.risk_matrix || {}),
        id: f.elements.matrix_id.value,
        revision: f.elements.matrix_revision.value,
        source: f.elements.matrix_source.value,
        severity_classes: ss,
        frequency_classes: fs,
        cells,
      };
    } else if (c.risk_matrix)
      throw new Error(
        "Retain the matrix ID, or explicitly migrate criteria in a separate reviewed change.",
      );
    await mutate({ config: c });
    setupDirty = false;
    notice(
      "Project setup saved. Earlier decisions require applicability review.",
    );
  } catch (e) {
    notice(e.message);
  }
}
function newProject() {
  action(
    "New engineering project",
    field("title", "Project title", "", "text", [], true),
    async (f) => {
      const s = await api("/api/create", { title: f.elements.title.value });
      await projectList(s.project.id);
      await load(s.project.id, true);
      view = "setup";
      render();
      notice("Project created. Define context and criteria.");
    },
    "Create project",
  );
}
async function example() {
  const source = await api("/api/example"),
    s = await api("/api/create", {
      title: "Synthetic station — training example",
      snapshot: source,
    });
  analysisDraft = null;
  await projectList(s.project.id);
  await load(s.project.id, true);
  analysisDraft = {
    name: "Synthetic station RAM study",
    mode: "normal",
    success: "At least one control channel and the shared supply operate.",
    mission_hours: 100,
    repair_target_hours: 4,
    dependency_status: "factored_shared_support",
    independence:
      "Synthetic independent active channels; shared supply represented once; unlimited separate active repair resources. No project acceptance.",
    tree: {
      op: "series",
      children: [
        { item: "PSU" },
        { op: "parallel", children: [{ item: "CH_A" }, { item: "CH_B" }] },
      ],
    },
  };
  tree = analysisDraft.tree;
  saveAnalysis();
  view = "hazards";
  render();
  notice("Fictional training study. Parameters and evidence are synthetic.");
}
async function freeze() {
  action(
    "Freeze baseline",
    `<p class="muted">Capture the working revision without approving its engineering content.</p>${field("label", "Baseline label", "", "text", [], true)}`,
    async (f) => {
      await api("/api/baseline", {
        project: snapshot.project.id,
        expected: snapshot.project.revision,
        label: f.elements.label.value,
      });
      if (view === "baselines") await renderBaselines();
      notice("Baseline retained.");
    },
    "Freeze snapshot",
  );
}
async function exportStudy(archive = false) {
  if (!snapshot) return notice("Select a project.");
  if (portable) return download("study-records.json", portable);
  const r = await request(url(archive ? "/api/export" : "/api/study-html"));
  if (!r.ok) throw new Error((await r.json()).error);
  const u = URL.createObjectURL(await r.blob());
  const a = document.createElement("a");
  a.href = u;
  a.download = archive ? "rams-study.zip" : "rams-study.html";
  a.click();
  setTimeout(() => URL.revokeObjectURL(u), 1000);
  notice(
    archive ? "Downloaded complete study and source archive." : "Downloaded the complete study for offline reading.",
  );
}
$("#projects").onchange = async (ev) => {
  try {
    if (draftDirty) return notice("Finish the open editor first.");
    if (setupDirty) {
      if (!confirm("Discard unsaved project setup changes?")) {
        ev.target.value = snapshot.project.id;
        return;
      }
      setupDirty = false;
    }
    analysisDraft && saveAnalysis();
    analysisDraft = null;
    history.replaceState(null, "", location.pathname + location.search);
    await load(ev.target.value, true);
    notice();
  } catch (e) {
    notice(e.message);
  }
};
function discardSetup() {
  if (setupDirty && !confirm("Discard unsaved project setup changes?"))
    return false;
  setupDirty = false;
  return true;
}
$("#create").onclick = () => {
  if (discardSetup()) newProject();
};
$("#example").onclick = () => {
  if (discardSetup()) example().catch((e) => notice(e.message));
};
$("#export").onclick = () => exportStudy().catch((e) => notice(e.message));
$("#reload").onclick = () =>
  discardSetup() &&
  snapshot &&
  load(snapshot.project.id)
    .then(() => notice("Reloaded current revision."))
    .catch((e) => notice(e.message));
$("#allScope").onclick = () => {
  if (!discardSetup()) return;
  scope = "";
  page = 0;
  renderTree();
  render();
};
$("#addItem").onclick = () => {
  if (!discardSetup()) return;
  if (snapshot) edit(null, "item", scope ? {target:scope,relation:"contains",reverse:true} : null);
  else notice("Create a project first.");
};
$("#import").onchange = async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  if (!discardSetup()) {
    ev.target.value = "";
    return;
  }
  try {
    if (file.size > 20000000) throw new Error("Project exceeds 20 MB.");
    const source = JSON.parse(await file.text());
    const preview = await api("/api/import-preview", {snapshot: source});
    action("Import study copy", `<p>${esc(file.name)} · validated project snapshot</p><dl class="facts"><div><dt>Source study</dt><dd>${esc(preview.title)}</dd></div><div><dt>Source revision</dt><dd>${esc(preview.revision ?? "Not supplied")}</dd></div><div><dt>Records / relationships</dt><dd>${preview.records} / ${preview.relationships}</dd></div><div><dt>Archived records</dt><dd>${preview.archived}</dd></div></dl><details><summary>Record breakdown</summary>${table(["Record type", "Count"],Object.entries(preview.kinds).map(([k,n])=>row([esc(nice(k)),n])))}</details><p class="result-state">Creates a separate study. ${preview.decisions_for_review} imported decisions will need review in the new scope. Runs, baselines and history remain in the original archive.</p>${field("title", "New study title", `${preview.title} — imported`, "text", [], true)}`, async f => {
      const created = await api("/api/create", {title:f.elements.title.value.trim(), snapshot:source});
      analysisDraft = null;
      history.replaceState(null, "", location.pathname + location.search);
      await projectList(created.project.id);
      await load(created.project.id, true);
      $(".project-menu").open = false;
      notice("Imported a new study copy. Source identity is retained in project lineage.");
    }, "Import as new study");
  } catch (e) {
    notice(e.message);
  } finally {
    ev.target.value = "";
  }
};
document.addEventListener('invalid', event => {
  event.target.setAttribute('aria-invalid','true');
  let parent = event.target.parentElement;
  while (parent) { if (parent.tagName === 'DETAILS') parent.open = true; parent = parent.parentElement; }
},true);
document.addEventListener("input", (ev) => {
  if (ev.target.hasAttribute('aria-invalid')) ev.target.removeAttribute('aria-invalid');
  if (ev.target.id === "search") {
    const input = ev.target;
    query = input.value;
    page = 0;
    if (view === "hazards") renderHazards();
    if (view === "evidence") evidenceView === "coverage" ? renderCoverage() : renderRegister();
    if (view === "studies") renderStudies();
    if (view === "actions") renderActions();
    if (view === "review") renderReview().catch(e => notice(e.message));
    const next = $("#search");
    next?.focus();
    next?.setSelectionRange(query.length, query.length);
  }
});
document.addEventListener("change", (ev) => {
  const t = ev.target;
  if (t.name === "data.model" && $("#numericalFields"))
    $("#numericalFields").hidden = t.value !== "exponential";
  if (t.id === "actionOwner") { actionOwner = t.value; page = 0; renderActions(); writeRoute(); }
  if (t.id === "reviewCategory") { reviewCategory = t.value; page = 0; renderReview().catch(e => notice(e.message)); }
  if (t.id === "recordKind") {
    kind = t.value;
    page = 0;
    selected = matching(kind)[0]?.id || ""; render();
  }
  if (t.dataset.component !== undefined) {
    nodeAt(t.dataset.component).item = t.value;
    treeChanged();
  }
  if (t.dataset.gate !== undefined) {
    nodeAt(t.dataset.gate).op = t.value;
    treeChanged();
  }
});
if(browserRuntime) {
  $('#restoreFile').onchange=async event=>{
    const file=event.target.files[0];event.target.value='';if(!file)return;
    try {
      const preview=await browserRuntime.previewWorkspace(new Uint8Array(await file.arrayBuffer()));
      action('Restore workspace backup', `<p>This replaces the browser workspace with <strong>${esc(file.name)}</strong>. The previous saved workspace will be retained for recovery.</p><dl class="facts">${Object.entries(preview.counts).map(([name,count])=>`<div><dt>${esc(({projects:'Studies',entities:'Records',links:'Relationships',history:'History entries',baselines:'Baselines',runs:'Analysis runs'})[name]||nice(name))}</dt><dd>${esc(count)}</dd></div>`).join('')}</dl><p>${preview.projects.map(p=>esc(p.title)).join(' · ')||'Empty workspace'}</p><label class="restore-confirm"><input type="checkbox" name="confirmRestore" required> Replace this browser workspace with the inspected backup</label>`,async form=>{
        if(!form.elements.confirmRestore.checked)throw new Error('Confirm the workspace replacement before restoring.');
        await browserRuntime.restoreWorkspace(preview.token);
        snapshot=null;analysisDraft=null;setupDirty=draftDirty=false;
        history.replaceState(null,'',location.pathname+location.search);
        await projectList();
        if(preview.projects.length)await load(preview.projects[0].id,true);else{await load('');render();}
        browserRuntime.confirmFresh();notice('Workspace restored. The previous saved workspace is available under Project menu → Download previous workspace.');
      },'Restore workspace');
    }catch(error){notice(error.message);}
  };
}
document.addEventListener("click", async (ev) => {
  const b = ev.target.closest("button, [data-select]");
  if (!b) return;
  try {
    if (b.dataset.reviewTab) { reviewTab = b.dataset.reviewTab; reviewCategory = ''; query = ''; page = 0; render(); }
    if (b.dataset.impact) { reviewTarget = b.dataset.impact; reviewTab = 'trace'; query = ''; page = 0; view = 'review'; render(); }
    if (b.id === 'clearImpact') { reviewTarget = ''; render(); }
    if (b.dataset.importance) await showImportance(b.dataset.importance, b);
    if(b.id==='restoreWorkspace'&&browserRuntime){
      if(draftDirty||setupDirty||analysisDirty||$('#actionDialog').open)return notice('Finish or retain your open draft before restoring a workspace.');
      $('#restoreFile').click();$('.project-menu').open=false;
    }
    if(b.id==='previousWorkspace'&&browserRuntime){await browserRuntime.previousWorkspace();$('.project-menu').open=false;}
    if (b.id === 'applicationStatus') {
      const status = await api('/api/health');
      action('Application status', `<dl class="facts">${(browserRuntime ? [['Version',status.version],['Saving',browserRuntime.state.mode==='device'?'On this device':'This tab only'],['Python',status.python],['Studies',status.projects],['Workspace limit','64 MiB'],['Transfer & recovery','Download a workspace backup; browser storage belongs to this device and site address.']] : [['Version',status.version],['Deployment',status.deployment],['Running application',status.application_path],['Workspace database',status.database_path],['Build',status.build],['Python',status.python],['Studies',status.projects]]).map(([label,value])=>`<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>`,async()=>{},'Close');
    }
    if (
      setupDirty &&
      (b.dataset.view ||
        b.dataset.method ||
        b.dataset.scope ||
        b.dataset.select ||
        b.dataset.add ||
        b.dataset.edit ||
        ["reload", "create", "example"].includes(b.id))
    ) {
      if (!confirm("Discard unsaved project setup changes?")) return;
      setupDirty = false;
    }
    if (b.dataset.view) {
      runRequest++;
      saveAnalysis();
      ramEditing = false;
      filter = "all";
      view = b.dataset.view;
      if (view === "hazards" && byId(selected)?.kind !== "hazard") selected = bowtieHazard || matching("hazard")[0]?.id || "";
      if (view === "evidence") {
        evidenceView = "coverage"; coverageFilter = "all";
        kind = byId(selected)?.kind !== "hazard" ? (byId(selected)?.kind || "requirement") : "requirement";
        if (byId(selected)?.kind !== kind) selected = matching(kind)[0]?.id || "";
      }
      query = "";
      page = 0;
      render();
    }
    if (b.dataset.view || b.dataset.method || b.dataset.reviewTab || b.dataset.impact) window.scrollTo({top:0,behavior:"instant"});
    if (b.dataset.method) {
      view = "studies";
      method = b.dataset.method;
      query = "";
      page = 0;
      const type = {fmeca: "failure_mode", hazop: "deviation", bowtie: "hazard", fta: "fault_gate"}[method];
      if (byId(selected)?.kind !== type) selected = matching(type)[0]?.id || "";
      if (method === "bowtie") bowtieHazard = selected;
      render();
    }
    if (b.dataset.scope) {
      saveAnalysis();
      scope = b.dataset.scope;
      $(".scope-menu").open = false;
      if (!scoped().has(selected)) selected = "";
      page = 0;
      renderTree();
      render();
    }
    if (b.id === "backRecord") {
      selected = selectionHistory.pop() || "";
      render();
    }
    if (b.dataset.select) {
      if (selected && selected !== b.dataset.select)
        selectionHistory.push(selected);
      selected = b.dataset.select;
      query = ""; page = 0;
      if (
        ["overview", "review", "actions", "ram", "setup", "baselines", "evidence"].includes(view) ||
        (view === "hazards" && byId(selected)?.kind !== "hazard") ||
        (view === "studies" &&
          !["bowtie", "fta"].includes(method) &&
          !["deviation", "failure_mode", "study_node"].includes(
            byId(selected)?.kind,
          ))
      ) {
        saveAnalysis();
        view = byId(selected).kind === "hazard" ? "hazards" : "evidence";
        scope = "";
        kind = byId(selected).kind;
        evidenceView = "records";
        query = "";
      }
      if (b.closest(".engineering-diagram") && $("#graphDock")) {
        $("#graphDock").innerHTML = graphDock();
        updateDiagramSelection();
      } else render();
      if (innerWidth <= 760) {
        const detail =
          $("#inspector:not(:empty)") || $("#graphDock") || $("#studyDock");
        detail?.scrollIntoView({ block: "start" });
      }
    }
    if (b.dataset.inspect) {
      kind = byId(selected).kind; evidenceView = "records"; view = kind === "hazard" ? "hazards" : "evidence"; scope = ""; query = ""; render();
    }
    if (b.id === "completeExample" || b.dataset.start === "complete") {
      const created = await api("/api/complete-example", {});
      history.replaceState(null, "", location.pathname + location.search);
      analysisDraft = null;
      await projectList(created.project.id);
      await load(created.project.id, true);
      notice("Fictional station study · all parameters and evidence are synthetic.");
    }
    if (b.id === "exportArchive") await exportStudy(true);
    if (b.id === "backupWorkspace") {
      const response = await request('/api/workspace-backup');
      if (!response.ok) throw new Error((await response.json()).error);
      const u = URL.createObjectURL(await response.blob()), a = document.createElement('a');
      a.href = u; a.download = `rams-workspace-${localDay()}.sqlite3`; a.click();
      setTimeout(()=>URL.revokeObjectURL(u),1000);
      notice(browserRuntime?'Workspace backup downloaded: all studies, history, baselines and retained runs. Use Restore workspace backup to reopen it.':'Workspace backup downloaded: all studies, history, baselines and retained runs. Restore to a new database using the documented recovery command.');
      $('.project-menu').open = false;
    }
    if (b.id === "editRAM" || b.id === "newRAM" || b.hasAttribute("data-new-ram")) {
      analysisDraft = b.id === "editRAM" && currentRun ? clone(currentRun.basis.config) : defaultAnalysis();
      tree = analysisDraft.tree; analysisDirty = false; ramEditing = true; render();
    }
    if (b.dataset.edit) edit(b.dataset.edit, byId(b.dataset.edit).kind);
    if (b.dataset.add) {
      const type = b.dataset.add;
      const rel = scope && byId(scope)?.kind === 'item' && ['hazard','item','requirement','control','failure_mode'].includes(type)
        ? {target:scope,relation:type === 'item' ? 'contains' : type === 'failure_mode' ? 'fails' : 'applies_to',reverse:type === 'item'} : null;
      edit(null,type,rel);
    }
    if (b.dataset.related)
      edit(null, b.dataset.related, {
        target: b.dataset.target,
        relation: b.dataset.relation,
        obligation: b.dataset.obligation,
        reverse: b.dataset.reverse === "true",
      });
    if (b.dataset.decision) decision(b.dataset.decision);
    if (b.dataset.link) linkExisting(b.dataset.link);
    if (b.dataset.evidenceView) { evidenceView = b.dataset.evidenceView; query = ""; page = 0; render(); }
    if (b.dataset.coverageFilter) { coverageFilter = b.dataset.coverageFilter; renderCoverage(); }
    if (b.dataset.actionFilter) { actionFilter = b.dataset.actionFilter; page = 0; renderActions(); writeRoute(); }
    if (b.hasAttribute("data-import-project")) $("#import").click();
    if (b.dataset.completeAction) completeAction(b.dataset.completeAction);
    if (b.id === "reconcileDraft") await reconcileDraft().catch(error => $("#entityError").textContent = error.message);
    if (b.id === "downloadDraft") download(`draft-${pendingDraft.id}.json`, {project:snapshot.project.id, base_revision:editorRevision, record:pendingDraft});
    if (b.id === "saveReconciled") await saveReconciled().catch(error => $("#entityError").textContent = error.message);
    if (b.dataset.filter) {
      filter = b.dataset.filter;
      page = 0;
      renderHazards();
    }
    if (b.dataset.page) {
      page += Number(b.dataset.page);
      render();
    }
    if (
      b.dataset.view ||
      b.id === "create" ||
      b.id === "example" ||
      b.id === "methodExample"
    )
      $(".project-menu").open = false;
    if (b.dataset.start === "new") newProject();
    if (b.dataset.start === "example") await example();
    if (b.id === "addObligation") {
      const el = document.createElement("div");
      el.innerHTML = obligationRow();
      $("#obligations").append(el.firstElementChild);
      draftDirty = true;
    }
    if (b.hasAttribute("data-remove-obligation")) {
      b.closest(".obligation").remove();
      draftDirty = true;
    }
    if (b.id === "addStandard") {
      setupDirty = true;
      const el = document.createElement("div");
      el.innerHTML = standardsRows([{}], -1);
      $("#standards").append(el.firstElementChild);
    }
    if (b.hasAttribute("data-remove-standard")) {
      setupDirty = true;
      b.closest(".standard").remove();
    }
    if (b.id === "rebuildMatrix") {
      setupDirty = true;
      const f = $("#setupForm"),
        m = {
          severity_classes: lines(f.elements.severity_classes.value),
          frequency_classes: lines(f.elements.frequency_classes.value),
          cells: readCells(),
        };
      if (m.severity_classes.length * m.frequency_classes.length > 400)
        throw new Error("The interactive matrix supports up to 400 cells.");
      $("#matrixGrid").innerHTML = matrixGrid(m);
    }
    if (b.dataset.root) {
      tree =
        b.dataset.root === "item"
          ? { item: "" }
          : { op: "series", children: [] };
      treeChanged();
    }
    if (b.dataset.child !== undefined) {
      const node = nodeAt(b.dataset.child);
      node.children.push(
        b.dataset.childType === "item"
          ? { item: "" }
          : { op: "parallel", children: [] },
      );
      treeChanged();
    }
    if (b.dataset.removeNode !== undefined) {
      const path = b.dataset.removeNode;
      if (!path) tree = null;
      else {
        const a = path.split(".");
        const i = Number(a.pop());
        nodeAt(a.join(".")).children.splice(i, 1);
      }
      treeChanged();
    }
    if (b.dataset.unlink) {
      const ids = JSON.parse(b.dataset.unlink);
      lastRemovedLink = snapshot.links.find(
        (l) =>
          l.source === ids.source &&
          l.relation === ids.relation &&
          l.target === ids.target,
      );
      await mutate({ remove_link: ids });
      if ($("#actionLinks"))
        $("#actionLinks").innerHTML = relationshipList(b.dataset.linkOwner);
      notice("Relationship removed. It can be restored in this dialog.");
    }
    if (b.id === "restoreLink" && lastRemovedLink) {
      const owner = b.dataset.linkOwner;
      await mutate({ link: lastRemovedLink });
      lastRemovedLink = null;
      if ($("#actionLinks"))
        $("#actionLinks").innerHTML = relationshipList(owner);
      notice("Relationship restored.");
    }
    if (b.hasAttribute("data-diagram-size")) {
      const el = document.querySelector(".engineering-diagram:has(svg)");
      if (el) {
        const graphic = el.querySelector("svg");
        if (graphic.style.width) {
          UnifiedEngineeringView.fit(el);
          b.textContent = "Actual size";
          document.querySelector("output[data-diagram-zoom]").textContent = "Fit";
        } else scaleDiagram(el, graphic.viewBox.baseVal.width);
      }
    }
    if (b.dataset.diagramZoom) {
      const el = document.querySelector(".engineering-diagram:has(svg)");
      if (el) scaleDiagram(el, diagramReadingWidth(el.querySelector("svg")) * Number(b.dataset.diagramZoom));
    }
    if (b.id === "methodExample") await methodExample();
    if (b.id === "allocateBarrier") allocateBarrier();
    if (b.dataset.linkInput) linkInput(b.dataset.linkInput);
    if (b.hasAttribute("data-download-diagram-source")) {
      if (!diagramSVG) throw new Error("Refresh the diagram first.");
      download(diagramName + ".json", UnifiedEngineeringView.source(diagramSVG));
    }
    if (b.hasAttribute("data-download-diagram")) {
      if (!diagramSVG) throw new Error("Refresh the diagram first.");
      download(diagramName + ".svg", diagramSVG, "image/svg+xml");
    }
    if (b.id === "downloadFTARun" && ftaRun)
      download(ftaRun.id + ".json", ftaRun);
    if (b.id === "downloadCutSets" && ftaRun)
      download(
        "minimal-cut-sets.csv",
        "cut_set,events\n" +
          ftaRun.result.minimal_cut_sets
            .map((c, i) => `${i + 1},"${c.join(" & ").replaceAll('"', '""')}"`)
            .join("\n"),
        "text/csv",
      );
    if (b.id === "previewRBD") {
      saveAnalysis();
      await previewRBD();
    }
    if (b.id === "freeze") await freeze();
    if (b.dataset.record) {
      const project = snapshot.project.id, request = ++runRequest;
      const r = await api(
        `${url("/api/record")}&kind=${b.dataset.kind}&id=${encodeURIComponent(b.dataset.record)}`,
      );
      if (snapshot.project.id !== project || request !== runRequest) return;
      if (b.dataset.kind === "runs") {
        saveAnalysis();
        if (r.method === "static_fta") {
          ftaRun = r;
          ftaDraft = clone(r.basis.config);
          ftaDirty = false;
          view = "studies";
          method = "fta";
          selected = r.basis.config.top;
        } else {
          currentRun = r;
          view = "ram";
          analysisDirty = false;
          ramEditing = false;
        }
        render();
      } else download(`${b.dataset.record}.json`, r);
    }
    if (b.dataset.compare) await compare(b.dataset.compare);
    if (b.id === "downloadRun" && currentRun)
      download(`${currentRun.id}.json`, currentRun);
    if (b.dataset.evidence) {
      const d = byId(b.dataset.evidence).data.evidence_content;
      const bytes = Uint8Array.from(atob(d.base64), (c) => c.charCodeAt(0));
      const u = URL.createObjectURL(new Blob([bytes], { type: d.media_type }));
      const a = document.createElement("a");
      a.href = u;
      a.download = d.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(u), 1000);
    }
  } catch (e) {
    notice(e.message);
  }
});
window.addEventListener("beforeunload", (ev) => {
  saveAnalysis();
  if (draftDirty || setupDirty || ($("#actionDialog").open && $("#actionForm").dataset.dirty === "true")) {
    ev.preventDefault();
    ev.returnValue = "";
  }
});
async function start() {
  try {
    if (portable) {
      $("#studyMode").textContent = "Saved study · read only";
      $("#export").textContent = "Download study data";
    }
    if(browserRuntime) { loadingProject(true); await runtimeReady; loadingProject(false); }
    info = await api("/api/info");
    await projectList();
    const id = portable?.snapshot.project.id || uiStorage.getItem("rams-project");
    if (id && [...$("#projects").options].some((o) => o.value === id))
      await load(id, true);
    else render();
  } catch (e) {
    notice(
      browserRuntime ? `Could not open workspace: ${e.message}` : `Could not open workspace: ${e.message}. Check the local server and reload.`,
    );
  }
}
start();

function drawReliability() {
  const canvas = $("#reliabilityChart");
  if (!canvas || !currentRun) return;
  const width = Math.max(280, canvas.parentElement.clientWidth),
    height = 200;
  canvas.width = width * 2;
  canvas.height = height * 2;
  canvas.style.width = "100%";
  canvas.style.height = "200px";
  const ctx = canvas.getContext("2d");
  ctx.scale(2, 2);
  ctx.font = "11px system-ui";
  const points = currentRun.curve,
    end = currentRun.basis.config.mission_hours,
    min = Math.max(0, Math.min(...points.map((p) => p.reliability)) - 0.0001),
    range = 1 - min || 1;
  ctx.fillStyle = "#5d707e";
  ctx.strokeStyle = "#dce5ea";
  for (let i = 0; i <= 4; i++) {
    const y = 18 + i * 35;
    ctx.beginPath();
    ctx.moveTo(65, y);
    ctx.lineTo(width - 15, y);
    ctx.stroke();
    ctx.fillText((100 * (1 - (i * range) / 4)).toFixed(3) + "%", 0, y + 4);
  }
  ctx.fillText("0 h", 65, 180);
  ctx.fillText(end + " h", width - 65, 180);
  ctx.fillText("Reliability · expanded vertical scale", 65, 198);
  ctx.strokeStyle = "#08677c";
  ctx.lineWidth = 2;
  ctx.beginPath();
  points.forEach((p, i) => {
    const x = 65 + (end ? p.hours / end : 0) * (width - 80),
      y = 18 + ((1 - p.reliability) / range) * 140;
    if (i) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
  });
  ctx.stroke();
}
window.addEventListener("resize", drawReliability);
document.addEventListener("keydown", (ev) => {
  if (
    !["ArrowUp", "ArrowDown"].includes(ev.key) ||
    !ev.target.matches("#content table button[data-select]")
  )
    return;
  const all = [
      ...document.querySelectorAll("#content table button[data-select]"),
    ],
    index = all.indexOf(ev.target),
    next = all[index + (ev.key === "ArrowDown" ? 1 : -1)];
  if (next) {
    ev.preventDefault();
    next.focus();
  }
});

function methodTabs() {
  return `<div class="subnav"><button data-view="hazards">Hazards</button>${[
    ["hazop", "HAZOP"],
    ["fmeca", "FMECA"],
    ["bowtie", "Bow tie"],
    ["fta", "Fault trees"],
  ]
    .map(
      ([key, label]) =>
        `<button data-method="${key}" class="${method === key ? "active" : ""}">${label}</button>`,
    )
    .join("")}</div>`;
}
async function previewRBD() {
  const token = ++diagramToken, project = snapshot.project.id;
  diagramSVG = "";
  try {
    const d = await api("/api/rbd-diagram", {
      project, expected: snapshot.project.revision, tree,
    });
    if (token !== diagramToken || snapshot.project.id !== project || !$("#rbdDiagram")) return;
    diagramSVG = d.svg;
    diagramName = "rbd-draft-rev-" + d.revision;
    mountDiagram("#rbdDiagram", d.svg);
  } catch (error) {
    if (token === diagramToken && $("#rbdDiagram")) $("#rbdDiagram").innerHTML = `<p class="error">${esc(error.message)}</p>`;
  }
}
function diagramTools() { return UnifiedEngineeringView.toolbar(); }
function diagramReadingWidth(graphic) { return UnifiedEngineeringView.readingWidth(graphic); }
function scaleDiagram(el, width) {
  document.querySelector("output[data-diagram-zoom]").textContent = UnifiedEngineeringView.scale(el, width);
  document.querySelector("[data-diagram-size]").textContent = "Fit to view";
}
function updateDiagramSelection() {
  document.querySelectorAll(".engineering-diagram").forEach(el => UnifiedEngineeringView.select(el, selected));
}
function mountDiagram(container, source) { UnifiedEngineeringView.mount($(container), source, selected); }
function graphDock() {
  const e = byId(selected);
  return e
    ? `<div class="dock"><div><p class="eyebrow">${esc(e.id)} · ${esc(nice(e.kind))}</p><h2>${esc(e.title)}</h2><p>${esc(e.description)}</p></div><div class="buttons"><button data-inspect="true">Open record</button><button data-edit="${esc(e.id)}">Edit selected</button><button data-link="${esc(e.id)}">Relationships</button></div></div>`
    : "";
}
async function showDiagram(kind, id, container) {
  const token = ++diagramToken, project = snapshot.project.id;
  diagramSVG = "";
  $(container).innerHTML = '<p class="empty">Drawing the study…</p>';
  try {
    const d = await api(`${url("/api/diagram")}&kind=${kind}&record=${encodeURIComponent(id)}`);
    if (token !== diagramToken || snapshot.project.id !== project || !$(container)) return;
    diagramSVG = d.svg;
    diagramName = `${kind}-${id}-rev-${snapshot.project.revision}`;
    mountDiagram(container, d.svg);
  } catch (error) {
    if (token === diagramToken && $(container)) $(container).innerHTML = `<p class="error">${esc(error.message)}</p>`;
  }
}
async function renderBowtie() {
  const hazards = matching("hazard");
  if (!hazards.some((e) => e.id === bowtieHazard))
    bowtieHazard = hazards[0]?.id || "";
  const h = byId(bowtieHazard);
  $("#content").innerHTML =
    methodTabs() +
    head(
      "Bow-tie analysis",
      h
        ? '<button id="allocateBarrier">Allocate existing control</button>'
        : "",
    ) +
    `<div class="toolbar"><label>Hazard<select id="bowtieHazard">${hazards.map((e) => option(e.id, `${e.id} · ${e.title}`, bowtieHazard)).join("")}</select></label>${h ? `<button data-related="cause" data-target="${esc(h.id)}" data-relation="causes">Add cause</button><button data-related="consequence" data-target="${esc(h.id)}" data-relation="causes" data-reverse="true">Add consequence</button><button data-related="control" data-target="${esc(h.id)}" data-relation="controls">Add control</button>${diagramTools()}` : ""}</div><p class="muted">Qualitative causal paths and explicit barrier allocations. Control effectiveness and risk reduction require evidence and review.</p><div class="engineering-diagram" id="bowtieDiagram"></div><div id="unallocatedControls"></div><div id="graphDock">${graphDock()}</div>`;
  if (!h) {
    $("#bowtieDiagram").innerHTML =
      '<p class="empty">Create a hazard and link its causes, consequences and controls.</p>';
    return;
  }
  $("#bowtieHazard").onchange = (e) => {
    bowtieHazard = e.target.value;
    selected = bowtieHazard;
    render();
  };
  const causes = incoming(h.id, "causes"),
    cons = outgoing(h.id, "causes"),
    targets = new Set([...causes, ...cons].map((e) => e.id));
  const controls = incoming(h.id, "controls");
  const unallocated = controls.filter(
    (c) =>
      !snapshot.links.some(
        (l) =>
          l.source === c.id &&
          ["prevents", "mitigates"].includes(l.relation) &&
          targets.has(l.target),
      ),
  );
  $("#unallocatedControls").innerHTML = unallocated.length
    ? `<section class="detail-section"><h2>Controls awaiting path allocation (${unallocated.length})</h2>${unallocated.map((c) => `<div class="record-row">${link(c.id)} · ${esc(c.title)} ${badge(c.data.status || "Unspecified")}</div>`).join("")}</section>`
    : "";
  await showDiagram("bowtie", h.id, "#bowtieDiagram");
}
function allocateBarrier() {
  const h = byId(bowtieHazard),
    controls = incoming(h.id, "controls");
  if (!controls.length)
    return notice(
      "Add a control to this hazard before allocating it to a causal path.",
    );
  action(
    "Allocate control to a bow-tie path",
    `<div class="form-grid"><label>Control<select name="control">${controls.map((c) => option(c.id, `${c.id} · ${c.title}`)).join("")}</select></label>${field("relation", "Allocation type", "prevents", "select", ["prevents", "mitigates"])}<label class="full">Cause or consequence<select name="target"></select></label>${field("rationale", "Allocation rationale", "", "area", [], true)}</div><p class="muted">Preventive allocation addresses a cause-to-top-event path. Mitigative allocation addresses a top-event-to-consequence path. Neither declares effectiveness.</p>`,
    async (f) => {
      await mutate({
        link: {
          source: f.elements.control.value,
          relation: f.elements.relation.value,
          target: f.elements.target.value,
          rationale: f.elements.rationale.value,
        },
      });
      notice("Barrier path allocation recorded.");
    },
  );
  const f = $("#actionForm");
  function targets() {
    const es =
      f.elements.relation.value === "prevents"
        ? incoming(h.id, "causes").filter((e) => e.kind === "cause")
        : outgoing(h.id, "causes").filter((e) => e.kind === "consequence");
    f.elements.target.innerHTML = es
      .map((e) => option(e.id, `${e.id} · ${e.title}`))
      .join("");
  }
  f.elements.relation.onchange = targets;
  targets();
}
function defaultFTA() {
  return {
    name: "",
    top: "",
    mode: "normal",
    mission_hours: 100,
    quantify: false,
    independence: "",
  };
}
function readFTA() {
  const f = $("#ftaForm");
  if (!f) return ftaDraft;
  const raw = f.elements.mission_hours.value;
  return {
    name: f.elements.name.value,
    top: f.elements.top.value,
    mode: f.elements.mode.value,
    mission_hours: raw.trim() === "" ? null : Number(raw),
    quantify: f.elements.quantify.checked,
    independence: f.elements.independence.value,
  };
}
function saveFTA() {
  ftaDraft = readFTA();
  const basis = document.querySelector(".fta-basis > summary");
  if (basis) basis.textContent = `Analysis setup · ${ftaDraft.mode || "mode required"} · ${ftaDraft.mission_hours ?? "—"} h · ${ftaDraft.quantify ? "quantitative" : "qualitative"}`;
  uiStorage.setItem(
    `rams-fta-${snapshot.project.id}`,
    JSON.stringify(ftaDraft),
  );
}
async function renderFTA() {
  if (!ftaRun && !ftaDraft) {
    const saved = studyRecords.runs.find(r => r.method === "static_fta");
    if (saved) {
      ftaRun = await api(`${url("/api/record")}&kind=runs&id=${encodeURIComponent(saved.id)}`);
      ftaDraft = clone(ftaRun.basis.config); ftaDirty = false; selected = ftaDraft.top;
      if (view !== "studies" || method !== "fta") return;
    }
  }
  const gates = matching("fault_gate");
  if (!ftaDraft) {
    try {
      ftaDraft =
        JSON.parse(uiStorage.getItem(`rams-fta-${snapshot.project.id}`)) ||
        defaultFTA();
    } catch {
      ftaDraft = defaultFTA();
    }
  }
  if (!gates.some((g) => g.id === ftaDraft.top))
    ftaDraft.top =
      gates.find(
        (g) =>
          !snapshot.links.some(
            (l) => l.source === g.id && l.relation === "input_to",
          ),
      )?.id ||
      gates[0]?.id ||
      "";
  const top = ftaDraft.top,
    d = ftaDraft;
  $("#content").innerHTML =
    methodTabs() +
    head(
      "Fault-tree analysis",
      '<button data-add="fault_gate">Add top gate</button>',
    ) +
    `${
      gates.length
        ? `<div class="fta-layout"><section><details class="fta-basis"><summary>Analysis setup · ${esc(d.mode || "mode required")} · ${esc(d.mission_hours ?? "—")} h · ${d.quantify ? "quantitative" : "qualitative"}</summary><form id="ftaForm"><div class="form-grid">${field("name", "Study name", d.name, "text", [], true)}<label>Top event / gate<select name="top" required>${gates.map((g) => option(g.id, `${g.id} · ${g.title}`, top)).join("")}</select></label>${field("mode", "Operating mode", d.mode, "text", [], true)}${field("mission_hours", "Probability horizon [h]", d.mission_hours ?? "", "number", [], true)}</div><label class="check"><input type="checkbox" name="quantify" ${d.quantify ? "checked" : ""}>Quantify declared independent basic events</label><details ${d.quantify ? "open" : ""}><summary>Quantification boundary</summary>${field("independence", "Independence rationale", d.independence, "area")}<p class="muted">Static AND/OR only; at most 16 basic events. Basic-event inputs are probabilities for this exact mode and horizon. No dynamic gates, dependency solver or safety target inferred.</p></details></form></details><div class="fta-run-control"><button class="primary" form="ftaForm">Analyze & retain run</button></div></section><section><div class="toolbar"><button data-related="fault_event" data-target="${esc(top)}" data-relation="input_to">Add basic event to top</button><button data-related="fault_gate" data-target="${esc(top)}" data-relation="input_to">Add gate to top</button><button data-link-input="${esc(top)}">Link existing input</button>${diagramTools()}</div><div class="engineering-diagram" id="ftaDiagram"></div><div id="ftaResults"></div><div id="graphDock">${graphDock()}</div><details><summary>Fault-tree records (${snapshot.entities.filter((e) => ["fault_gate", "fault_event"].includes(e.kind)).length})</summary>${snapshot.entities
            .filter((e) => ["fault_gate", "fault_event"].includes(e.kind))
            .map(
              (e) =>
                `<div class="record-row">${link(e.id)} · ${esc(e.title)} ${e.kind === "fault_gate" ? `<button data-link-input="${esc(e.id)}">Link input</button>` : ""}</div>`,
            )
            .join("")}</details></section></div>`
        : '<p class="empty">Create a top gate, then add basic events or nested gates. The method example demonstrates shared-event identity and minimal cut sets.</p><button id="methodExample">Open method examples</button>'
    }`;
  if (!gates.length) return;
  $("#ftaForm").oninput = () => {
    saveFTA();
    ftaDirty = true;
    renderFTAResults();
  };
  $("#ftaForm").onchange = (ev) => {
    saveFTA();
    ftaDirty = true;
    if (ev.target.name === "top") render();
    else renderFTAResults();
  };
  $("#ftaForm").onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      saveFTA();
      if (ftaDraft.mission_hours === null)
        throw new Error("Enter a probability horizon.");
      ftaRun = await api("/api/fault-tree", {
        project: snapshot.project.id,
        expected: snapshot.project.revision,
        config: ftaDraft,
      });
      ftaDirty = false;
      renderFTAResults();
      notice(
        "Fault-tree run retained with its exact snapshot and method basis.",
      );
    } catch (e) {
      notice(e.message);
      $("#ftaResults").innerHTML =
        `<p class="error">${esc(e.message)}</p><p class="muted">Draft retained. No new run saved.</p>`;
    }
  };
  renderFTAResults();
  await showDiagram("fta", top, "#ftaDiagram");
  writeRoute();
}
function renderFTAResults() {
  const el = $("#ftaResults");
  if (!el) return;
  if (!ftaRun) {
    el.innerHTML =
      '<p class="empty">Analyze the Boolean structure for minimal cut sets. Quantification is optional and requires complete applicable basic-event data.</p>';
    return;
  }
  const r = ftaRun.result;
  el.innerHTML = `<section class="detail-section"><h2>Retained fault-tree result</h2><p class="result-state">${ftaDirty || ftaRun.project_revision !== snapshot.project.revision || earlierProducer(ftaRun, "fta") ? "Historical basis / inputs or producer differ" : "Retained basis"} · revision ${ftaRun.project_revision} · ${esc(ftaRun.basis.config.top)}</p><p><strong>${r.top_event_probability === null ? "Qualitative only" : r.top_event_probability.toPrecision(12)}</strong>${r.top_event_probability === null ? "" : " top-event probability at " + ftaRun.basis.config.mission_hours + " h"}</p>${earlierProducer(ftaRun, "fta") ? `<p class="error">Producer differs from the current solver. Retain as historical or create a new run.</p>` : ""}<h3>Minimal cut sets (${r.minimal_cut_sets.length})</h3>${table(
    ["Set", "Basic-event identities"],
    r.minimal_cut_sets.map((c, i) => row([i + 1, c.map(link).join(" AND ")])),
  )}<p class="muted">${r.distinct_basic_events} distinct basic events. Overlapping cut sets are not added as mutually exclusive probabilities.</p><div class="buttons"><button id="downloadFTARun">Download full run</button><button id="downloadCutSets">Cut sets CSV</button></div>${!portable && r.top_event_probability !== null ? `<p><button data-importance="${esc(ftaRun.id)}">Analyze importance & sensitivity</button></p><div id="importance-${esc(ftaRun.id)}"></div>` : ""}<details><summary>Applicability & warnings</summary><ul>${[...ftaRun.applicability, ...ftaRun.warnings].map((a) => `<li>${esc(a)}</li>`).join("")}</ul></details></section>`;
}
function linkInput(gate) {
  const inputs = snapshot.entities.filter(
    (e) =>
      e.state !== "archived" &&
      ["fault_event", "fault_gate"].includes(e.kind) &&
      e.id !== gate &&
      !snapshot.links.some(
        (l) =>
          l.source === e.id && l.target === gate && l.relation === "input_to",
      ),
  );
  action(
    `Input to ${gate}`,
    `<label>Existing event or gate<select name="input">${inputs.map((e) => option(e.id, `${e.id} · ${e.title}`)).join("")}</select></label>${field("rationale", "Logic rationale", "", "area", [], true)}`,
    async (f) => {
      await mutate({
        link: {
          source: f.elements.input.value,
          relation: "input_to",
          target: gate,
          rationale: f.elements.rationale.value,
        },
      });
      notice("Input linked. Repeated event IDs retain one Boolean identity.");
    },
  );
}
async function methodExample() {
  const source = await api("/api/method-example"),
    p = await api("/api/create", {
      title: source.project.title,
      snapshot: source,
    });
  analysisDraft = null;
  await projectList(p.project.id);
  await load(p.project.id, true);
  view = "studies";
  method = "bowtie";
  selected = "HZ_001";
  ftaDraft = {
    name: "Synthetic shared-event FTA",
    top: "FT_TOP",
    mode: "normal",
    mission_hours: 100,
    quantify: false,
    independence:
      "Invented independent basic-event probabilities; shared initiator retains one identity in both branches. No actual project acceptance.",
  };
  uiStorage.setItem(`rams-fta-${p.project.id}`, JSON.stringify(ftaDraft));
  render();
  notice(
    "Fictional method examples opened. All controls are proposals and all probabilities are invented.",
  );
}

function activeRecords(type) {
  return snapshot.entities.filter(e => e.kind === type && e.state !== "archived");
}
function runButton(run) {
  return `<button class="link" data-record="${esc(run.id)}" data-kind="runs">${esc(run.name)}</button>`;
}
function renderOverview() {
  const hazards = activeRecords("hazard"), runs = studyRecords.runs.filter(r => r.method !== "static_fta");
  const actions = sortedActions(activeRecords("action"), {today:localDay()});
  const gaps = (snapshot.requirement_coverage || []).filter(r=>r.status !== "covered" || r.incomplete.length);
  const decisions = snapshot.coverage.filter(c=>c.decision !== "accepted" || c.decision_needs_review);
  const project = snapshot.project, empty = !snapshot.entities.length;
  if (empty) {
    $("#content").innerHTML = `<div class="study-heading"><p class="eyebrow">${portable ? "Saved study" : "Working study"} · revision ${project.revision}</p><h1>${esc(project.title)}</h1><p>${esc(project.config?.operating_context || "Start by defining the system and the question this study must answer.")}</p></div><section class="overview-section"><h2>Start with the study boundary</h2><div class="setup-path"><button data-view="setup"><strong>1. Define context & criteria</strong><span>Operating context, governing standards and risk matrix.</span></button><button data-add="item"><strong>2. Build the system</strong><span>Create equipment and link the physical hierarchy.</span></button><button data-add="hazard"><strong>3. Record the first hazard</strong><span>Describe the boundary, mode and assessment owner.</span></button></div><p class="muted">No engineering records yet. Verification coverage and retained results will appear as the study develops.</p></section>`;
    return;
  }
  $("#content").innerHTML = `<div class="study-heading"><p class="eyebrow">${portable ? "Saved study" : "Working study"} · revision ${project.revision}</p><h1>${esc(project.title)}</h1><p>${esc(project.config?.operating_context || "Define this study's operating context and system boundary in Project setup.")}</p></div>
    <div class="study-totals"><button data-view="hazards"><strong>${hazards.length}</strong><span>Hazards</span></button><button data-view="ram"><strong>${runs.length}</strong><span>RAM runs</span></button><button data-view="evidence"><strong>${activeRecords("requirement").length}</strong><span>Requirements</span></button><button data-view="actions"><strong>${actions.length}</strong><span>Open actions</span></button></div>

    <section class="overview-section"><div class="section-head"><h2>Needs attention</h2><button data-view="review">Open review</button></div><div class="attention-grid"><button data-view="evidence"><strong>${gaps.length}</strong><span>Verification items to review</span><small>Missing declarations or undefined scope</small></button><button data-view="review"><strong>${decisions.length}</strong><span>Hazard decisions to review</span><small>Pending or changed engineering basis</small></button><button data-view="actions"><strong>${actions.filter(a=>actionState(a,localDay()) === "overdue").length}</strong><span>Overdue actions</span><small>Open the register to assign or complete work</small></button></div></section>
    <div class="overview-columns"><section class="overview-section"><div class="section-head"><h2>Hazard register</h2><button data-view="hazards">All hazards</button></div>${table(["Hazard", "Residual risk", "Evidence gaps"], hazards.slice(0,5).map(h=>{ const c=snapshot.coverage.find(c=>c.hazard===h.id); return row([`${link(h.id)}<p>${esc(h.title)}</p>`,esc(c.residual_risk),c.gaps.length]);}))}${hazards.length>5?`<p class="muted">Showing 5 of ${hazards.length} hazards.</p>`:''}</section>
    <section class="overview-section"><div class="section-head"><h2>Next actions</h2><button data-view="actions">Action register</button></div>${actions.slice(0,4).map(a=>`<div class="next-action"><div>${link(a.id)} ${badge(actionState(a,localDay()), actionState(a,localDay())==='overdue'?'warn':'')}<p>${esc(a.title)}</p><small>${esc(a.data.owner || 'Unassigned')} · ${esc(a.data.due || 'Unscheduled')}</small></div><button data-edit="${esc(a.id)}">Edit</button></div>`).join('') || '<p class="empty">No open actions. Add an action when the study identifies follow-up work.</p>'}</section></div>
    <section class="overview-section"><div class="section-head"><h2>Retained RAM studies</h2><button data-view="ram">Open RAM</button></div>${table(["Study / success condition", "Mission", "Reliability", "Inherent availability", "Basis"], runs.map(r=>row([`${runButton(r)}<p>${esc(r.config.success)}</p>`,`${r.config.mission_hours} h`,`${(r.result.mission_reliability*100).toFixed(4)}%`,`${(r.result.inherent_availability*100).toFixed(6)}%`,`Revision ${r.revision}${r.revision !== project.revision ? '<br><span class="muted">Historical</span>' : ''}`])))}<p class="muted">Results apply to their retained success model. Mission reliability, inherent availability and active repair are separate quantities.</p></section>`;
}
function renderDecisionReview() {
  const actions = activeRecords("action").filter(a => !a.data.completion_evidence);
  $("#content").innerHTML = head("Review gaps & actions", '<button data-view="baselines">Baselines & history</button>') +
    `<section class="overview-section"><h2>Hazard decisions & evidence</h2>${table(["Hazard", "Decision", "Unresolved evidence / applicability"], snapshot.coverage.map(c => row([`${link(c.hazard)}<p>${esc(byId(c.hazard).title)}</p>`, badge(c.decision, "warn"), `${c.decision_needs_review ? '<p>Decision applicability requires review.</p>' : ''}${c.gaps.length ? '<ul>'+c.gaps.map(g => '<li>'+esc(g)+'</li>').join('')+'</ul>' : '<p>No structural coverage gaps identified.</p>'}`])))}</section>
    <section class="overview-section"><h2>Open actions (${actions.length})</h2>${table(["Action", "Owner", "Due", "Applies to"], actions.map(a => row([`${link(a.id)}<p>${esc(a.title)}</p>`, esc(a.data.owner || "Unassigned"), esc(a.data.due || "Unscheduled"), outgoing(a.id, "addresses").map(e => link(e.id)).join(" · ")])))}</section>
    <section class="overview-section"><h2>Retained analysis</h2>${table(["Study", "Method", "Revision", "Applicability"], studyRecords.runs.map(r => row([runButton(r), r.method === "static_fta" ? "Fault tree" : "RAM", r.revision, r.revision === snapshot.project.revision ? "Current study revision" : "Historical study revision"])))}</section>`;
}
function reviewTabs() {
  return `<div class="subnav">${[['technical','Technical review'],['trace','Traceability & change review'],['decisions','Decisions & retained results']].map(([key,label])=>`<button data-review-tab="${key}" class="${reviewTab === key ? 'active' : ''}">${label}</button>`).join('')}</div>`;
}
function renderPractice() {
  const methods = [
    ['HAZID / hazard log','What hazardous situations arise in the stated system and modes?','Boundary, operations, interfaces, people affected, sources, causes and consequences.','Hazards, controls, risk basis, actions and receiving decisions.','<button data-view="hazards">Open hazards</button>'],
    ['HAZOP','How can behavior depart from a node’s design intent?','Intent and design revision; parameter / guide word; session / participants; examination disposition.','Credible causes, consequences, existing safeguards, recommendations, linked actions and hazards.','<button data-method="hazop">Open HAZOP</button>'],
    ['FMEA / FMECA','How does an item or function fail, and what follows?','Required function, failure mode, causes, operating mode, scope and source.','Local / next / end effects, detection, provision, severity and stated criticality basis.','<button data-method="fmeca">Open FMECA</button>'],
    ['Bow tie','Which barriers act on each threat and consequence path?','Bounded top event, credible paths, shared barriers, owners, performance and degradation conditions.','Qualitative barrier allocations and their requirements / evidence. No automatic probability reduction.','<button data-method="bowtie">Open bow tie</button>'],
    ['Static FTA','Which combinations produce an unwanted event?','AND/OR failure logic; one ID per event; mode and horizon. Quantification additionally needs applicable independent probabilities.','Exact bounded minimal cut sets, optional top-event probability, importance and deterministic sensitivity.','<button data-method="fta">Open fault trees</button>'],
    ['Mission RBD / inherent availability','Which combinations deliver the named success function?','Distinct component instances, explicit series / active-parallel success logic, rate and active repair data, source and independence review.','Mission R/Q, separate inherent A/U, component active-repair CDF, importance and rate scenarios.','<button data-view="ram">Open RAM</button>'],
    ['Operational RAM / FRACAS','How do support policies and observed field behavior affect service?','Configuration / exposure, incidents, repair and logistics, crews / spares, service denominator and observation rules.','Use an applicable specialist analysis as controlled external evidence. Internal operational simulation and field-data analysis remain future methods.','<button data-view="evidence">Record external evidence</button>']
  ];
  $('#content').innerHTML = head('Methods & study workflow') +
    `<section class="overview-section"><h2>Carry one engineering question through the study</h2><ol class="practice-steps"><li><strong>Define the decision.</strong> Record lifecycle, system boundary, configuration, modes, governing editions, success/service criteria and accepting authority. <button data-view="setup">Project setup</button></li><li><strong>Build the analysis.</strong> Choose the method for the question below. Keep physical containment, causal paths and success logic separate.</li><li><strong>Resolve the evidence.</strong> Trace selected controls to requirements and explicit mode/configuration verification obligations. Review failed, incomplete and inapplicable results. <button data-view="evidence">Verification coverage</button></li><li><strong>Review change and handover.</strong> Check assumptions, shared causes, open actions and receiving conditions. Retain the baseline and exact calculation basis. <button data-view="review">Technical review</button></li></ol></section>` +
    table(['Method','Engineering question','Prepare','Working output / boundary','Start'], methods.map(cells=>row(cells)), 'methods-table') +
    `<section class="overview-section"><h2>Choose the metric before the model</h2><p>Mission reliability excludes repair during the mission. Inherent availability here assumes independent failure and active repair with separate unlimited repair resources. Component repair probability starts at active repair, and excludes diagnosis, access and logistics. These quantities do not establish operational availability, SIL, hazardous failure targets or accepted residual risk.</p><p>Importance and ×0.5 / ×2 scenarios describe this retained model. They do not include consequence severity, cost or confidence bounds. A critical shared support needs one physical/event identity and an applicable dependency model.</p><details><summary>Practice sources</summary><ul><li><a href="https://webstore.iec.ch/en/publication/68933" target="_blank" rel="noopener">IEC 62278-1:2025 — railway RAMS lifecycle scope</a></li><li><a href="https://webstore.iec.ch/en/publication/26359" target="_blank" rel="noopener">IEC 60812:2018 — FMEA/FMECA scope</a></li><li><a href="https://webstore.iec.ch/en/publication/24321" target="_blank" rel="noopener">IEC 61882:2016 — HAZOP scope</a></li><li><a href="https://webstore.iec.ch/en/publication/4311" target="_blank" rel="noopener">IEC 61025:2006 — FTA scope</a></li><li><a href="https://help.reliasoft.com/articles/content/basics/system_reliability.htm" target="_blank" rel="noopener">ReliaSoft — system reliability modelling</a></li></ul><p class="muted">Public scopes inform this workflow; project obligations need the adopted full editions and applicable engineering review.</p></details></section>`;
}
async function renderReview() {
  const project = snapshot.project.id, revision = snapshot.project.revision, tab = reviewTab, request = ++reviewRequest;
  const current = () => view === 'review' && snapshot.project.id === project && snapshot.project.revision === revision && reviewTab === tab && request === reviewRequest;
  if (tab === 'decisions') { renderDecisionReview(); $('#content').insertAdjacentHTML('afterbegin', reviewTabs()); return; }
  if (tab === 'technical') {
    if (reviewCache?.key !== `${project}:${revision}`) {
      $('#content').innerHTML = reviewTabs() + head('Technical review') + '<p role="status">Checking recorded study content…</p>';
      const data = await api(url('/api/technical-review'));
      if (!current()) return;
      reviewCache = {key:`${project}:${revision}`,data};
    }
    const data = reviewCache.data;
    const found = data.findings.filter(f => (!reviewCategory || f.category === reviewCategory) && `${f.record || ''} ${byId(f.record)?.title || ''} ${f.message}`.toLowerCase().includes(query.toLowerCase()));
    const p = paginate(found);
    $('#content').innerHTML = reviewTabs() + head('Technical review', '<button data-view="setup">Project setup</button>') +
      `<p class="view-intro">${esc(data.scope)}</p><p><strong>${data.findings.length} findings</strong> at revision ${revision}. Each finding identifies recorded information to resolve or justify.</p>` +
      searchBar(`<label>Discipline<select id="reviewCategory">${option('','All disciplines',reviewCategory)}${Object.keys(data.categories).sort().map(c=>option(c,`${c} (${data.categories[c]})`,reviewCategory)).join('')}</select></label>`) +
      table(['Record / discipline','Review finding','Next step'], p.items.map(f=>row([`${f.record ? link(f.record) + '<p>'+esc(byId(f.record)?.title)+'</p>' : '<strong>Project context</strong>'}<span class="muted">${esc(f.category)}</span>`, esc(f.message), `${esc(f.next_step)}<p>${f.record ? `<button data-edit="${esc(f.record)}">Edit record</button>${!portable ? ` <button data-impact="${esc(f.record)}">Inspect trace</button>` : ''}` : '<button data-view="setup">Open setup</button>'}</p>`]))) + p.html +
      (Object.keys(data.examinations).length ? `<details><summary>Recorded HAZOP examinations</summary>${table(['Disposition','Recorded combinations'],Object.entries(data.examinations).map(([k,n])=>row([esc(nice(k)),n])))}<p class="muted">Counts describe recorded combinations only. Unrecorded node / parameter / guide-word combinations have unknown coverage.</p></details>` : '');
    return;
  }
  if (traceCache?.key !== `${project}:${revision}`) {
    $('#content').innerHTML = reviewTabs() + head('Traceability & change review') + '<p role="status">Opening declared trace chains…</p>';
    const data = await api(url('/api/traceability'));
    if (!current()) return;
    traceCache = {key:`${project}:${revision}`,data};
  }
  const data = traceCache.data;
  const found = data.rows.filter(r => [...r.hazards, r.control, ...r.requirements].filter(Boolean).some(id=>`${id} ${byId(id)?.title}`.toLowerCase().includes(query.toLowerCase())));
  const p = paginate(found);
  const coverage = new Map();
  for (const c of data.coverage) { if (!coverage.has(c.requirement)) coverage.set(c.requirement, []); coverage.get(c.requirement).push(c); }
  $('#content').innerHTML = reviewTabs() + head('Traceability & change review') + `<p class="view-intro">${esc(data.scope)}</p><div id="changeNeighborhood"></div>` + searchBar() +
    table(['Hazard / path','Control / implementation','Requirements / current obligations','Verification declarations'],p.items.map(r=>row([
      r.hazards.map(id=>`${link(id)}<p>${esc(byId(id)?.title)}</p>`).join('') || '<span class="error">No hazard allocation</span>',
      r.control ? `${link(r.control)}<p>${esc(byId(r.control)?.title)}</p>${badge(byId(r.control)?.data.status || 'Status not recorded')}<details><summary>Declared allocations</summary>${r.allocations.map(a=>`<p>${esc(nice(a.relation))} → ${link(a.via)} → ${link(a.hazard)}</p>`).join('')}</details>${!portable ? `<p><button data-impact="${esc(r.control)}">Review related records</button></p>` : ''}` : '<span class="error">No implementing control</span>',
      r.requirements.map(id=>`${link(id)}<p>${esc(byId(id)?.title)}</p>${(coverage.get(id)||[]).map(c=>`<p>${esc(c.obligation ? `${c.obligation.id} · ${c.obligation.mode} · ${c.obligation.configuration}` : 'No explicit obligation')} ${badge(c.status,c.status === 'covered' ? '' : 'warn')}</p>`).join('')}`).join('') || '<span class="error">No implementing requirement</span>',
      [...new Set(r.requirements.flatMap(id=>(coverage.get(id)||[]).flatMap(c=>[...c.verifications,...c.incomplete])))].map(id=>`${link(id)}<p>${esc(byId(id)?.data.result || 'not run')}</p>`).join('') || '<span class="muted">No verification linked</span>'
    ]))) + p.html;
  if (reviewTarget && !portable && byId(reviewTarget)?.state !== 'archived') {
    const target = reviewTarget;
    $('#changeNeighborhood').innerHTML = `<p role="status">Inspecting links around ${esc(target)}…</p>`;
    const related = await api(`${url('/api/related-records')}&record=${encodeURIComponent(target)}`);
    if (!current() || reviewTarget !== target) return;
    $('#changeNeighborhood').innerHTML = `<section class="overview-section"><div class="section-head"><h2>Related to ${esc(target)} · ${esc(byId(target)?.title)}</h2><button id="clearImpact">Clear focus</button></div><p>${esc(related.scope)}</p><p class="result-state">${related.rows.length} records within ${related.depth} steps.${related.truncated ? ' Boundary reached: more links exist beyond this view. Review the wider study.' : ''} Engineering edits also require conservative project-wide decision applicability review.</p>${table(['Record','Steps','Declared path'],related.rows.map(r=>row([`${link(r.record)}<p>${esc(byId(r.record)?.title)}</p>`,r.distance,r.path.map(l=>`${link(l.source)} → ${esc(nice(l.relation))} → ${link(l.target)}`).join('<br>')])))}<button data-related="action" data-target="${esc(target)}" data-relation="addresses">Record a change-review action</button></section>`;
  }
}
async function showImportance(id, button) {
  const project = snapshot.project.id;
  const el = document.getElementById(`importance-${id}`);
  if (!el) return;
  button.disabled = true;
  el.innerHTML = '<p role="status">Replaying the retained basis and calculating importance…</p>';
  try {
    const result = await api(`${url('/api/importance')}&run=${encodeURIComponent(id)}`);
    if (snapshot.project.id !== project || !el.isConnected) return;
    const fmt = value => Number.isFinite(value) ? value.toExponential(6) : 'Unavailable';
    el.innerHTML = `<p class="result-state">Retained revision ${result.project_revision} · ${esc(result.mode)} · ${result.mission_hours} h · baseline failure probability ${fmt(result.probability)}</p><p>Ranked by improvement potential with each event hypothetically perfect. This ordering does not include consequence severity or cost.</p>` +
      table(['Component / event','Input failure probability','Birnbaum importance','Improvement potential','Failure probability if perfect / failed','Input ×0.5 / ×2'], result.rows.map(r=>row([`${esc(r.record)}<p>${esc(r.title)}</p>`,fmt(r.input_probability),fmt(r.birnbaum),fmt(r.improvement_potential),`${fmt(r.perfect_probability)}<br>${fmt(r.failed_probability)}`,r.scenarios.map(s=>s.reason ? `<p>×${s.factor}: ${esc(s.reason)}</p>` : `<p>×${s.factor}: ${fmt(s.probability)}</p>`).join('') ]))) +
      `<p class="muted">${esc(result.scenario_basis)}. One input varies at a time; these are not confidence bounds.</p><details><summary>Method, definitions & applicability</summary><p>${esc(result.scope)}</p><ul>${(result.warnings || []).map(w=>`<li>${esc(w)}</li>`).join('')}</ul><dl class="facts">${Object.entries(result.definitions).map(([k,v])=>`<div><dt>${esc(nice(k))}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl><p>Method ${esc(result.method)} · source ${esc(result.producer_sha256)} · retained basis ${esc(result.basis_sha256)}</p></details>`;
  } catch (e) { if (el.isConnected) el.innerHTML = `<p class="error">Importance unavailable: ${esc(e.message)}</p><p>Retain this historical result and calculate a new run with the current producer when appropriate.</p>`; }
  finally { if (button.isConnected) button.disabled = false; }
}
async function renderRAM() {
  if (ramEditing && !portable) return renderRAMEditor();
  const runs = studyRecords.runs.filter(r => r.method !== "static_fta");
  $("#content").innerHTML = head("Reliability, availability & maintainability", portable ? "" : '<button id="newRAM">New RAM study</button>') +
    `<div class="run-list" aria-label="Retained RAM studies">${runs.map(r => `<button data-record="${esc(r.id)}" data-kind="runs" class="${r.id === currentRun?.id ? "active" : ""}"><strong>${esc(r.name)}</strong><span>${r.config.mission_hours} h mission · revision ${r.revision}</span></button>`).join("")}</div><div id="ramRunBody"><p role="status">${runs.length ? "Opening retained results…" : "No calculated RAM runs in this study."}</p></div>`;
  if (!runs.length) { $("#ramRunBody").innerHTML = `<div class="empty-workflow"><h2>Define what successful operation means</h2><p>Choose physical components and arrange series / active-parallel success logic. Each component needs a failure rate, active repair time, operating mode and a dependency review.</p>${portable ? "" : '<div class="buttons"><button data-new-ram class="primary">Build a RAM study</button><button data-add="item">Add a component</button></div>'}<p class="muted">This solver covers independent exponential components. Standby, common-cause and shared-repair models require a different method.</p></div>`; return; }
  const project = snapshot.project.id, request = ++runRequest;
  const wanted = currentRun?.id || runs[0].id;
  if (!currentRun) {
    const loadedRun = await api(`${url("/api/record")}&kind=runs&id=${encodeURIComponent(wanted)}`);
    if (request !== runRequest || snapshot.project.id !== project || view !== 'ram') return;
    currentRun = loadedRun;
  }
  if (view !== "ram" || snapshot.project.id !== project || currentRun.id !== wanted || ramEditing) return;
  analysisDirty = false;
  document.querySelectorAll(".run-list button").forEach(b => b.classList.toggle("active", b.dataset.record === currentRun.id));
  const c = currentRun.basis.config;
  $("#ramRunBody").innerHTML = `<div class="run-purpose"><p>${esc(c.success)}</p><p class="muted">Mode: ${esc(c.mode)} · Mission: ${c.mission_hours} h · Active repair target: ${c.repair_target_hours} h</p>${portable ? "" : '<button id="editRAM">Revise this study</button>'}</div><p class="related-hazards">Hazards on modelled equipment: ${hazardsForRun(currentRun).map(h => link(h.id)).join(" · ") || "No declared hazard allocation"}</p><section class="results" id="results" aria-label="Calculation results"></section><section class="ram-graphic"><h2>Success model · exact retained run</h2><div class="toolbar">${diagramTools()}</div><div class="engineering-diagram" id="rbdDiagram"><p role="status">Drawing retained topology…</p></div></section>`;
  renderResults();
  writeRoute();
  const drawing = await api(`${url("/api/run-diagram")}&run=${encodeURIComponent(wanted)}`);
  if (view !== "ram" || currentRun?.id !== wanted || ramEditing || !$("#rbdDiagram")) return;
  diagramSVG = drawing.svg; diagramName = "rbd-" + wanted;
  mountDiagram("#rbdDiagram", drawing.svg);
}
function writeRoute() {
  if (!snapshot || restoringRoute) return;
  const params = new URLSearchParams({view});
  if (selected) params.set("record", selected);
  if (view === "studies") { params.set("method", method); if (method === "bowtie") params.set("hazard", bowtieHazard); }
  if (view === "ram" && currentRun) params.set("run", currentRun.id);
  if (scope && !["overview", "ram", "review"].includes(view)) params.set("scope", scope);
  if (view === "evidence") { params.set("kind", kind); params.set("tab", evidenceView); }
  if (view === "review") { params.set("tab",reviewTab); if (reviewTarget) params.set("focus",reviewTarget); }
  if (view === "actions") { params.set("filter",actionFilter); if (actionOwner) params.set("owner",actionOwner); }
  const hash = "#" + params;
  if (location.hash !== hash) history[location.hash ? "pushState" : "replaceState"](null, "", hash);
}
async function readRoute() {
  const p = new URLSearchParams(location.hash.slice(1));
  view = ["overview", "hazards", "studies", "ram", "evidence", "actions", "review", "baselines", "setup", "practice"].includes(p.get("view")) ? p.get("view") : "overview";
  selected = p.get("record") || ""; scope = p.get("scope") || "";
  reviewTab = ["technical","trace","decisions"].includes(p.get("tab")) ? p.get("tab") : "technical"; reviewTarget = p.get("focus") || ""; reviewCategory = "";
  kind = p.get("kind") || "requirement";
  evidenceView = p.get("tab") === "records" ? "records" : "coverage";
  method = ["hazop", "fmeca", "bowtie", "fta"].includes(p.get("method")) ? p.get("method") : "hazop";
  bowtieHazard = p.get("hazard") || (byId(selected)?.kind === "hazard" ? selected : "");
  ramEditing = false; query = ""; filter = "all"; page = 0;
  actionFilter = ["all","open","overdue","unassigned","completed"].includes(p.get("filter")) ? p.get("filter") : "open"; actionOwner = p.get("owner") || "";
  currentRun = null;
  if (view === "ram" && p.get("run") && studyRecords.runs.some(r => r.id === p.get("run") && r.method !== "static_fta")) currentRun = await api(`${url("/api/record")}&kind=runs&id=${encodeURIComponent(p.get("run"))}`);
}
window.addEventListener("popstate", async () => {
  if (location.hash === "#main") return;
  if (!snapshot) return;
  restoringRoute = true;
  try { await readRoute(); renderTree(); render(); } catch (error) { notice(error.message); }
  finally { restoringRoute = false; }
});

function hazardsForRun(run) {
  const ids = new Set(components(run.basis?.config.tree || run.config.tree).map(n => n.item));
  return activeRecords("hazard").filter(h => outgoing(h.id, "applies_to").some(e => ids.has(e.id)));
}

function renderCoverage() {
  const all = snapshot.requirement_coverage || [];
  const ids = scoped();
  const scopedRows = all.filter(r => ids.has(r.requirement) && `${r.requirement} ${byId(r.requirement)?.title}`.toLowerCase().includes(query.toLowerCase()));
  const rows = scopedRows.filter(r => coverageFilter !== 'gaps' || r.status !== 'covered' || r.incomplete.length);
  const gaps = scopedRows.filter(r => r.status !== 'covered' || r.incomplete.length).length;
  $('#content').innerHTML = evidenceTabs() + head('Verification coverage', '<button class="primary" data-add="requirement">Add requirement</button>') +
    `<p class="view-intro">Check every requirement against its current revision, operating mode and configuration. Passing declarations still need an evidence adequacy review.</p>${searchBar()}<div class="segmented"><button data-coverage-filter="all" class="${coverageFilter === 'all' ? 'active' : ''}">All coverage items ${scopedRows.length}</button><button data-coverage-filter="gaps" class="${coverageFilter === 'gaps' ? 'active' : ''}">Needs review ${gaps}</button></div>` +
    table(['Requirement / revision', 'Obligation', 'Declaration coverage', 'Next step'], rows.map(r => {
      const req = byId(r.requirement), o = r.obligation;
      return row([`${link(req.id)}<p>${esc(req.title)}</p><span class="muted">Revision ${r.revision}</span>`, o ? `<strong>${esc(o.id)}</strong><p>${esc(o.mode)} · ${esc(o.configuration)}</p>` : '<span class="muted">No explicit obligations</span>',
        `${badge(r.status === 'covered' ? 'Passing declaration' : r.status === 'legacy_declaration' ? 'Define obligations' : 'Missing declaration', r.status === 'covered' ? 'good' : 'warn')}<p>${r.verifications.map(link).join(' · ') || 'No verification linked'}</p>${r.incomplete.length ? '<p class="error">Incomplete or non-passing declarations remain.</p>' : ''}`,
        o ? `<button data-related="verification" data-target="${esc(req.id)}" data-relation="verifies" data-obligation="${esc(o.id)}">Add verification</button>` : `<button data-edit="${esc(req.id)}">Define obligations</button>`]);
    })) + (!all.length ? '<p class="empty">Add a requirement, then define its verification obligations for each mode and configuration.</p>' : '');
}
function renderActions() {
  const today = localDay(), records = activeRecords('action');
  const items = sortedActions(records,{today,filter:actionFilter,owner:actionOwner,query});
  const p = paginate(items), owners = [...new Set(records.map(r=>r.data.owner).filter(Boolean))].sort();
  $('#content').innerHTML = head('Action register', '<button class="primary" data-add="action">Add action</button>') +
    `<p class="view-intro">Assign the work, follow its engineering links, and retain the evidence of completion.</p><div class="segmented action-filters">${[['open','Open'],['overdue','Overdue'],['unassigned','Unassigned'],['completed','Completed'],['all','All']].map(([key,label])=>`<button data-action-filter="${key}" class="${actionFilter === key ? 'active' : ''}">${label} ${sortedActions(records,{today,filter:key}).length}</button>`).join('')}</div>` +
    searchBar(`<label class="owner-filter">Owner<select id="actionOwner">${option('', 'All owners', actionOwner)}${owners.map(o=>option(o,o,actionOwner)).join('')}</select></label>`) +
    table(['Action / linked records', 'Owner', 'Due', 'Status', 'Next step'], p.items.map(a => {
      const status = actionState(a,today);
      return row([`${link(a.id)}<p>${esc(a.title)}</p><span class="action-links">${outgoing(a.id,'addresses').map(e=>link(e.id)).join(' · ') || 'No linked record'}</span>`, esc(a.data.owner || 'Unassigned'), esc(a.data.due || 'Unscheduled'), badge(status,status === 'overdue' ? 'warn' : status === 'completed' ? 'good' : ''), `<div class="buttons"><button data-edit="${esc(a.id)}">Edit</button>${status !== 'completed' ? `<button data-complete-action="${esc(a.id)}">Record completion</button>` : ''}</div>${status === 'completed' ? `<details><summary>Completion evidence</summary><p>${esc(a.data.completion_evidence)}</p></details>` : ''}`]);
    })) + p.html;
}
function completeAction(id) {
  const basis = snapshot.project.revision, record = clone(byId(id));
  action('Record action completion', `<p><strong>${esc(id)}</strong> · ${esc(record.title)}</p>${field('evidence','Completion evidence / controlled reference','','area',[],true)}<p class="muted">This records completion evidence. It does not approve a hazard decision or close verification obligations.</p>`, async f => {
    record.data.completion_evidence = f.elements.evidence.value.trim();
    if (!record.data.completion_evidence) throw new Error('Enter completion evidence or a controlled reference.');
    delete record.revision;
    await mutate({entity:record},basis);
    notice(`Completion recorded for ${id}.`);
  }, 'Record completion');
}
async function reconcileDraft() {
  const latest = await api(`/api/project?project=${encodeURIComponent(snapshot.project.id)}`);
  const remote = latest.entities.find(e=>e.id === pendingDraft.id);
  if (editingIsNew) {
    if (remote) throw new Error('This ID now exists. Keep your draft and choose another stable ID.');
    editorRevision = latest.project.revision;
    $('#entityError').textContent = 'Latest revision checked. Your new record can now be saved; the server will recheck all relationships.';
    $('#conflictFields').innerHTML = '';
    return;
  }
  if (!remote) throw new Error('The record no longer exists. Download your draft before leaving this editor.');
  conflictContext = {latest, remote};
  const result = mergeDraft(editing,pendingDraft,remote);
  const display = value => value === undefined ? '(removed)' : typeof value === 'object' ? JSON.stringify(value,null,2) : String(value);
  $('#conflictFields').innerHTML = `<h3>Latest project revision ${latest.project.revision}</h3><p>Changes to different fields are combined. For each conflicting field, choose which value to save.</p>${result.conflicts.map((c,i)=>`<fieldset><legend>${esc(c.path.join(' / '))}</legend><div class="conflict-values"><div><strong>Your draft</strong><pre>${esc(display(c.local))}</pre></div><div><strong>Latest saved</strong><pre>${esc(display(c.remote))}</pre></div></div><label>Value to keep<select data-conflict-index="${i}"><option value="">Choose a value</option><option value="local">Your draft</option><option value="remote">Latest saved</option></select></label></fieldset>`).join('') || '<p>No conflicting fields. Your edits can be combined with the latest saved changes.</p>'}<button type="button" id="saveReconciled" class="primary">Save combined record</button>`;
}
async function saveReconciled() {
  if (!conflictContext) return;
  const {latest,remote} = conflictContext;
  const result = mergeDraft(editing,pendingDraft,remote), choices = {};
  for (const [i,c] of result.conflicts.entries()) {
    const choice = $(`[data-conflict-index="${i}"]`).value;
    if (!choice) { $('#entityError').textContent = 'Choose a value for every conflicting field.'; return; }
    choices[c.key] = choice;
  }
  const merged = mergeDraft(editing,pendingDraft,remote,choices).merged;
  delete merged.revision;
  const button = $('#saveReconciled'); button.disabled = true;
  try {
    await mutate({entity:merged},latest.project.revision);
    selected = merged.id; draftDirty = false; $('#editor').close(); render(); notice(`Reconciled and saved ${merged.id}.`);
  } catch (error) {
    $('#entityError').textContent = error.message + ' Compare again to include any newer changes.';
  } finally { button.disabled = false; }
}
