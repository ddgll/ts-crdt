/**
 * Collaborative JSON document demo.
 *
 * Two views onto one CRDT-backed JSON document: a raw textarea you can edit and
 * apply wholesale, and a field-level record editor. Both go through
 * {@link applyJson} / {@link setPath}, which emit only the operations a change
 * actually requires — so two browsers editing different fields of the same
 * document (or different records of the same array) both keep their edits.
 */

import { Doc } from "@ddgll/ts-crdt";
import { CrdtClient } from "@ddgll/ts-crdt/client";
import {
  readJson,
  applyJson,
  setPath,
  deletePath,
  type Json,
  type JsonObject,
} from "./jsonCrdt.js";

/** Key under the document root holding the JSON document. */
const ROOT = "doc";

const STATUSES = ["draft", "review", "published", "archived"];

const replicaId = crypto.randomUUID();
const doc = new Doc(replicaId);
const client = new CrdtClient(doc);

let ready = false;
/** Operations this replica has emitted, shown in the status bar. */
let opsEmitted = 0;
/** True while the user is editing the raw textarea, so remote updates leave it alone. */
let editorDirty = false;

// --- element handles -------------------------------------------------------

const el = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element #${id}`);
  return found as T;
};

const statusEl = el<HTMLSpanElement>("status");
const replicaEl = el<HTMLSpanElement>("replica-id");
const opCountEl = el<HTMLSpanElement>("op-count");
const recordCountEl = el<HTMLSpanElement>("record-count");
const docSizeEl = el<HTMLSpanElement>("doc-size");

const jsonInput = el<HTMLTextAreaElement>("json-input");
const parseErrorEl = el<HTMLDivElement>("parse-error");
const jsonViewEl = el<HTMLPreElement>("json-view");
const recordsEl = el<HTMLDivElement>("records");
const titleInput = el<HTMLInputElement>("doc-title");
const notesInput = el<HTMLTextAreaElement>("doc-notes");

replicaEl.textContent = replicaId.slice(0, 8);

// --- connection ------------------------------------------------------------

const params = new URLSearchParams(window.location.search);
const room = params.get("room") || "json-default";
const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
const wsUrl = `${protocol}//${window.location.host}/ws?room=${room}`;

let reconnectDelay = 500;
let firstConnection = true;

function connect() {
  const ws = new WebSocket(wsUrl);

  if (firstConnection) {
    client.bind(ws);
    firstConnection = false;
  } else {
    client.rebind(ws);
  }

  ws.onopen = () => {
    reconnectDelay = 500;
    setStatus(ready ? "ready" : "connected");
  };

  ws.onclose = () => {
    setStatus("disconnected");
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 10_000);
  };

  ws.onerror = () => setStatus("error");
}

client.onMessage((type) => {
  if (type === "snapshot") {
    ready = true;
    setStatus("ready");
  }
  scheduleRender();
});

function setStatus(state: string) {
  statusEl.textContent = state;
  statusEl.dataset.state = state;
}

// --- rendering -------------------------------------------------------------

let renderQueued = false;

/**
 * Coalesces renders into one per frame. A bulk change arrives as thousands of
 * individual events, and rendering each one separately would re-read and
 * re-paint the whole document thousands of times.
 */
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function render() {
  const json = readJson(doc, ROOT);

  jsonViewEl.textContent = JSON.stringify(json, null, 2);
  docSizeEl.textContent = String(JSON.stringify(json).length);
  opCountEl.textContent = String(opsEmitted);

  const records = Array.isArray(json.records) ? (json.records as JsonObject[]) : [];
  recordCountEl.textContent = String(records.length);

  // Leave the raw editor alone while it is being edited, or its contents would
  // be replaced mid-keystroke by an incoming remote change.
  if (!editorDirty && document.activeElement !== jsonInput) {
    jsonInput.value = JSON.stringify(json, null, 2);
  }

  syncInput(titleInput, typeof json.title === "string" ? json.title : "");
  const meta = isObject(json.meta) ? json.meta : {};
  syncInput(notesInput, typeof meta.notes === "string" ? meta.notes : "");

  renderRecords(records);
}

/** Writes a value into an input unless the user is currently typing in it. */
function syncInput(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  if (document.activeElement === input) return;
  if (input.value !== value) input.value = value;
}

function renderRecords(records: JsonObject[]) {
  const seen = new Set<string>();

  for (const record of records) {
    const id = String(record.id ?? "");
    if (!id) continue;
    seen.add(id);

    let row = recordsEl.querySelector<HTMLDivElement>(`[data-record-id="${cssEscape(id)}"]`);
    if (!row) {
      row = buildRecordRow(id);
      recordsEl.appendChild(row);
    }

    syncInput(row.querySelector<HTMLInputElement>('[data-field="name"]')!, str(record.name));
    syncInput(
      row.querySelector<HTMLTextAreaElement>('[data-field="description"]')!,
      str(record.description),
    );
    syncInput(row.querySelector<HTMLInputElement>('[data-field="score"]')!, str(record.score));

    const status = row.querySelector<HTMLSelectElement>('[data-field="status"]')!;
    if (document.activeElement !== status) status.value = str(record.status);

    const active = row.querySelector<HTMLInputElement>('[data-field="active"]')!;
    if (document.activeElement !== active) active.checked = record.active === true;
  }

  // Drop rows for records that no longer exist.
  for (const row of Array.from(recordsEl.children) as HTMLDivElement[]) {
    const id = row.dataset.recordId;
    if (id && !seen.has(id)) row.remove();
  }

  // Keep DOM order matching document order so the array's RGA ordering is visible.
  records.forEach((record, index) => {
    const id = String(record.id ?? "");
    const row = recordsEl.querySelector<HTMLDivElement>(`[data-record-id="${cssEscape(id)}"]`);
    if (row && recordsEl.children[index] !== row) {
      recordsEl.insertBefore(row, recordsEl.children[index] ?? null);
    }
  });
}

function buildRecordRow(id: string): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "record";
  row.dataset.recordId = id;
  row.innerHTML = `
    <div class="record-head">
      <code class="record-id">${escapeHtml(id)}</code>
      <button type="button" data-action="delete" title="Delete record">✕</button>
    </div>
    <label>Name <input type="text" data-field="name" /></label>
    <label>Description <textarea data-field="description" rows="2"></textarea></label>
    <div class="record-row">
      <label>Score <input type="number" data-field="score" /></label>
      <label>Status
        <select data-field="status">
          ${STATUSES.map((s) => `<option value="${s}">${s}</option>`).join("")}
        </select>
      </label>
      <label class="inline">Active <input type="checkbox" data-field="active" /></label>
    </div>
  `;

  const recordPath = (field: string) => ["records", `k${id}`, field];

  const name = row.querySelector<HTMLInputElement>('[data-field="name"]')!;
  name.addEventListener("input", () => emit(() => setPath(doc, ROOT, recordPath("name"), name.value)));

  const description = row.querySelector<HTMLTextAreaElement>('[data-field="description"]')!;
  description.addEventListener("input", () =>
    emit(() => setPath(doc, ROOT, recordPath("description"), description.value)),
  );

  const score = row.querySelector<HTMLInputElement>('[data-field="score"]')!;
  score.addEventListener("input", () =>
    emit(() => setPath(doc, ROOT, recordPath("score"), Number(score.value) || 0)),
  );

  const status = row.querySelector<HTMLSelectElement>('[data-field="status"]')!;
  status.addEventListener("change", () =>
    emit(() => setPath(doc, ROOT, recordPath("status"), status.value)),
  );

  const active = row.querySelector<HTMLInputElement>('[data-field="active"]')!;
  active.addEventListener("change", () =>
    emit(() => setPath(doc, ROOT, recordPath("active"), active.checked)),
  );

  row.querySelector<HTMLButtonElement>('[data-action="delete"]')!.addEventListener("click", () => {
    const current = currentRecords();
    emit(() => applyJson(doc, ROOT, { ...readJson(doc, ROOT), records: current.filter((r) => String(r.id) !== id) }));
  });

  return row;
}

// --- mutations -------------------------------------------------------------

/** Runs a mutation, tallies the operations it emitted, and re-renders. */
function emit(mutate: () => { ops: number }) {
  if (!ready) return;
  opsEmitted += mutate().ops;
  scheduleRender();
}

function currentRecords(): JsonObject[] {
  const json = readJson(doc, ROOT);
  return Array.isArray(json.records) ? (json.records as JsonObject[]) : [];
}

/** Builds a deterministic record set, so tests can assert on exact contents. */
function generateRecords(count: number, prefix: string): JsonObject[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}${i}`,
    name: `Record ${i}`,
    description: `Description for record ${i}. Generated for the collaborative JSON demo.`,
    score: (i * 7) % 100,
    status: STATUSES[i % STATUSES.length],
    active: i % 3 !== 0,
    tags: [`tag-${i % 5}`, `group-${i % 3}`],
  }));
}

function seed(count: number, prefix = "r") {
  emit(() =>
    applyJson(doc, ROOT, {
      title: `Seeded document (${count} records)`,
      version: 1,
      meta: { owner: replicaId.slice(0, 8), notes: "Edit any field; changes merge per field." },
      records: generateRecords(count, prefix),
    }),
  );
}

// --- wiring ----------------------------------------------------------------

jsonInput.addEventListener("input", () => {
  editorDirty = true;
  try {
    JSON.parse(jsonInput.value);
    parseErrorEl.textContent = "";
    parseErrorEl.dataset.state = "ok";
  } catch (err) {
    parseErrorEl.textContent = (err as Error).message;
    parseErrorEl.dataset.state = "error";
  }
});

el<HTMLButtonElement>("apply").addEventListener("click", () => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonInput.value);
  } catch (err) {
    parseErrorEl.textContent = (err as Error).message;
    parseErrorEl.dataset.state = "error";
    return;
  }
  if (!isObject(parsed)) {
    parseErrorEl.textContent = "Top level must be a JSON object.";
    parseErrorEl.dataset.state = "error";
    return;
  }
  parseErrorEl.textContent = "";
  parseErrorEl.dataset.state = "ok";
  editorDirty = false;
  emit(() => applyJson(doc, ROOT, parsed as JsonObject));
});

el<HTMLButtonElement>("reload").addEventListener("click", () => {
  editorDirty = false;
  render();
});

titleInput.addEventListener("input", () =>
  emit(() => setPath(doc, ROOT, ["title"], titleInput.value)),
);
notesInput.addEventListener("input", () =>
  emit(() => setPath(doc, ROOT, ["meta", "notes"], notesInput.value)),
);

el<HTMLButtonElement>("seed-small").addEventListener("click", () => seed(5));
el<HTMLButtonElement>("seed-big").addEventListener("click", () => seed(200));

el<HTMLButtonElement>("add-record").addEventListener("click", () => {
  const records = currentRecords();
  const id = `n${crypto.randomUUID().slice(0, 8)}`;
  emit(() =>
    applyJson(doc, ROOT, {
      ...readJson(doc, ROOT),
      records: [
        ...records,
        {
          id,
          name: "New record",
          description: "",
          score: 0,
          status: "draft",
          active: true,
          tags: [],
        },
      ],
    }),
  );
});

// --- test hooks ------------------------------------------------------------

/**
 * Exposed for the Playwright suite so tests can drive large documents and
 * precise deep-path edits without going through the DOM.
 */
Object.defineProperty(window, "__json", {
  value: {
    isReady: () => ready,
    get: (): JsonObject => readJson(doc, ROOT),
    apply: (next: JsonObject) => emit(() => applyJson(doc, ROOT, next)),
    set: (path: string[], value: Json) => emit(() => setPath(doc, ROOT, path, value)),
    del: (path: string[]) => emit(() => deletePath(doc, ROOT, path)),
    seed: (count: number, prefix?: string) => seed(count, prefix ?? "r"),
    records: () => currentRecords(),
    opsEmitted: () => opsEmitted,
    replicaId,
  },
});

// --- helpers ---------------------------------------------------------------

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

/** CSS.escape is not available in every test browser build. */
function cssEscape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

connect();
render();
