/**
 * jsonCrdt — maps arbitrary JSON documents onto ts-crdt's YMap/YArray/YText.
 *
 * ## Encoding
 *
 * | JSON                    | CRDT representation                    | Merge granularity          |
 * | ----------------------- | -------------------------------------- | -------------------------- |
 * | object                  | `YMap`                                 | per key                    |
 * | string                  | `YText`                                | per character              |
 * | number / boolean / null | primitive in a `YMap` slot             | last-writer-wins per key   |
 * | array of primitives     | `YArray`                               | per element (RGA)          |
 * | array of objects        | keyed collection (see below)           | per field of each element  |
 *
 * ## Why arrays of objects are not plain YArrays
 *
 * A `YArray` element can hold a nested container in memory, but events are
 * JSON-serialized on the wire and a nested `YMap` collapses into a plain object
 * in the payload — the receiving replica stores an inert object, not a
 * container, so later edits to it never land. On top of that, `EgWalker` paths
 * address array elements *by position* (`["items", 2, "title"]`), so a
 * concurrent insert earlier in the array silently re-targets an in-flight edit
 * at a different element.
 *
 * Both problems disappear if array elements are addressed by a stable key
 * instead of a position, so an array of objects is stored as:
 *
 * ```
 * YMap {
 *   "#list":  true,
 *   "#order": YArray<string>,      // element ids, in order — RGA-merged
 *   "#items": YMap<string, YMap>,  // id -> element, each a normal YMap subtree
 * }
 * ```
 *
 * Reordering and insertion merge through `#order`; field edits merge through
 * `#items`, keyed by identity rather than index. Element identity comes from
 * the object's own `id`/`_id`/`uuid` field when present, and falls back to the
 * element's position otherwise (see {@link elementKey}).
 */

import { Doc, YMap, YArray, YText } from "@ddgll/ts-crdt";

export type JsonPrimitive = string | number | boolean | null;
export type Json = JsonPrimitive | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

/** Marker keys used by the encoding. All `#`-prefixed keys are hidden from the JSON view. */
const LIST_FLAG = "#list";
const LIST_ORDER = "#order";
const LIST_ITEMS = "#items";
/**
 * Materializes an otherwise-empty map.
 *
 * `getMap`/`getArray`/`getText` create a container without emitting an event, so
 * a container nothing was ever written into stays local and never reaches a
 * peer — an `{}` value would exist on its author and be missing everywhere else.
 * Writing this marker gives the empty map a replicable event. Empty *arrays*
 * need no equivalent: `YArray.insert(index, [])` is itself a replicable event.
 */
const EMPTY_FLAG = "#empty";

/** Counts the CRDT operations a reconcile pass produced. */
export interface ApplyStats {
  /** Operations emitted (each becomes one replicated event). */
  ops: number;
}

// ---------------------------------------------------------------------------
// Reading: CRDT -> plain JSON
// ---------------------------------------------------------------------------

/**
 * Reads the whole document as plain JSON.
 *
 * This makes a single `Doc.toJSON()` call and unwraps its `__crdt_type`
 * envelopes in one pass, so it stays O(document size) rather than re-serializing
 * each nested container.
 *
 * **Key order is not stable across replicas.** Replicas converge on content, but
 * a client that authored an object locally holds its keys in authoring order
 * while one that replayed the same object from remote events holds them in
 * event order. Compare documents with a deep, order-insensitive equality (or
 * sort keys first) — never by hashing `JSON.stringify` output.
 *
 * @param doc The document to read.
 * @param rootKey Key under the root map holding the JSON document.
 * @returns The document as plain JSON, or `{}` if `rootKey` is unset.
 */
export function readJson(doc: Doc, rootKey: string): JsonObject {
  const raw = doc.toJSON() as Record<string, unknown>;
  const node = raw[rootKey];
  if (node === undefined) return {};
  const value = unwrap(node);
  return isJsonObject(value) ? value : {};
}

/** Recursively strips `__crdt_type` envelopes and re-materializes keyed collections. */
function unwrap(value: unknown): Json {
  if (Array.isArray(value)) return value.map(unwrap);
  if (value === null || typeof value !== "object") return value as JsonPrimitive;

  const obj = value as Record<string, unknown>;
  const tag = obj.__crdt_type;
  if (tag === "YText") return typeof obj.data === "string" ? obj.data : "";
  if (tag === "YArray") {
    return Array.isArray(obj.data) ? obj.data.map(unwrap) : [];
  }
  if (tag === "YMap") {
    const data = obj.data;
    return isRecord(data) ? unwrapMap(data) : {};
  }
  return unwrapMap(obj);
}

/** Unwraps a YMap's payload, re-materializing the keyed-collection encoding as an array. */
function unwrapMap(data: Record<string, unknown>): Json {
  if (data[LIST_FLAG] === true) return unwrapList(data);
  const out: JsonObject = {};
  for (const key of Object.keys(data)) {
    if (key.startsWith("#")) continue;
    out[key] = unwrap(data[key]);
  }
  return out;
}

/** Rebuilds an array from a keyed collection's `#order` / `#items` pair. */
function unwrapList(data: Record<string, unknown>): Json[] {
  const orderNode = data[LIST_ORDER];
  const itemsNode = data[LIST_ITEMS];

  const order = isRecord(orderNode) && Array.isArray(orderNode.data) ? orderNode.data : [];
  const itemsRaw = isRecord(itemsNode) && isRecord(itemsNode.data) ? itemsNode.data : {};

  const out: Json[] = [];
  for (const id of order) {
    if (typeof id !== "string") continue;
    // An id present in #order but absent from #items means a concurrent delete
    // removed the element while its ordering entry survived. Skip it.
    if (!(id in itemsRaw)) continue;
    out.push(unwrap(itemsRaw[id]));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Writing: plain JSON -> CRDT
// ---------------------------------------------------------------------------

/**
 * Reconciles the document at `rootKey` toward `next`, emitting the minimal set
 * of CRDT operations rather than replacing the subtree wholesale. Fields that
 * did not change produce no events, so a concurrent editor's untouched fields
 * survive the merge.
 *
 * @param doc The document to mutate.
 * @param rootKey Key under the root map holding the JSON document.
 * @param next The desired JSON state.
 * @returns The number of operations emitted.
 */
export function applyJson(doc: Doc, rootKey: string, next: JsonObject): ApplyStats {
  const stats: ApplyStats = { ops: 0 };
  const current = readJson(doc, rootKey);
  reconcileMap(doc.getMap().getMap(rootKey), current, next, stats);
  return stats;
}

/**
 * Sets a single value at a JSON path, creating intermediate objects as needed.
 * Cheaper and more targeted than a whole-document reconcile.
 *
 * @param doc The document to mutate.
 * @param rootKey Key under the root map holding the JSON document.
 * @param path Path segments from the document root, e.g. `["user", "name"]`.
 * @param value The value to write.
 */
export function setPath(doc: Doc, rootKey: string, path: string[], value: Json): ApplyStats {
  if (path.length === 0) throw new Error("setPath requires a non-empty path");
  const stats: ApplyStats = { ops: 0 };
  const { container, leafKey, currentLeaf } = resolve(doc, rootKey, path);
  reconcileKey(container, leafKey, currentLeaf, value, stats);
  return stats;
}

/** Deletes a key at a JSON path. */
export function deletePath(doc: Doc, rootKey: string, path: string[]): ApplyStats {
  if (path.length === 0) throw new Error("deletePath requires a non-empty path");
  const stats: ApplyStats = { ops: 0 };
  const { container, leafKey } = resolve(doc, rootKey, path);
  container.delete(leafKey);
  stats.ops++;
  return stats;
}

/**
 * Walks `path` down both the CRDT tree and its plain-JSON view at once, so the
 * caller gets the container to mutate *and* the value currently at the leaf.
 * Carrying the view alongside matters: reconciling a string needs the old text
 * to diff against, and a keyed collection stores elements under derived ids
 * that the plain view does not expose.
 *
 * A keyed collection occupies two container levels (`collection` -> `#items`)
 * but also two path segments (the collection's key, then the element's key), so
 * the walk stays in step. An element key is spelled as {@link assignKeys}
 * derives it — `k<id>` for an element with an `id` field, `p<index>` otherwise.
 */
function resolve(
  doc: Doc,
  rootKey: string,
  path: string[],
): { container: YMap; leafKey: string; currentLeaf: Json | undefined } {
  let container = doc.getMap().getMap(rootKey);
  let view: Json | undefined = readJson(doc, rootKey);

  for (let i = 0; i < path.length - 1; i++) {
    const segment = path[i];
    if (Array.isArray(view)) {
      // `container` is already the collection's `#items` map, so this segment
      // names an element within it.
      view = elementByKey(view, segment);
      container = container.getMap(segment);
      continue;
    }

    const existing = container.get(segment);
    if (existing instanceof YMap && existing.get(LIST_FLAG) === true) {
      container = existing.getMap(LIST_ITEMS);
    } else {
      if (existing !== undefined && !(existing instanceof YMap)) {
        // Type change: an object has to replace whatever primitive or text was here.
        container.delete(segment);
      }
      container = container.getMap(segment);
    }
    view = isJsonObject(view) ? view[segment] : undefined;
  }

  const leafKey = path[path.length - 1];
  const currentLeaf = Array.isArray(view)
    ? elementByKey(view, leafKey)
    : isJsonObject(view)
      ? view[leafKey]
      : undefined;

  return { container, leafKey, currentLeaf };
}

/** Finds the element of a plain-JSON array whose derived collection key is `key`. */
function elementByKey(values: Json[], key: string): Json | undefined {
  const index = assignKeys(values).indexOf(key);
  return index === -1 ? undefined : values[index];
}

/** Reconciles every key of a YMap toward `next`, deleting keys `next` dropped. */
function reconcileMap(map: YMap, current: JsonObject, next: JsonObject, stats: ApplyStats): void {
  for (const key of Object.keys(next)) {
    // Reserved keys belong to the encoding, never to user data.
    if (key.startsWith("#")) continue;
    reconcileKey(map, key, current[key], next[key], stats);
  }
  for (const key of Object.keys(current)) {
    if (key.startsWith("#")) continue;
    if (!(key in next)) {
      map.delete(key);
      stats.ops++;
    }
  }
}

/** Reconciles one key of a YMap, switching representation when the JSON type changes. */
function reconcileKey(
  map: YMap,
  key: string,
  current: Json | undefined,
  next: Json,
  stats: ApplyStats,
): void {
  const nextKind = kindOf(next);
  const currentKind = current === undefined ? "undefined" : kindOf(current);

  // A type change invalidates the existing container, so clear the slot first;
  // getText/getMap/getArray throw on a type mismatch.
  if (currentKind !== nextKind && currentKind !== "undefined") {
    map.delete(key);
    stats.ops++;
    current = undefined;
  }

  switch (nextKind) {
    case "string": {
      const text = map.getText(key);
      syncText(text, typeof current === "string" ? current : "", next as string, stats);
      return;
    }
    case "primitive": {
      if (current !== next) {
        map.set(key, next);
        stats.ops++;
      }
      return;
    }
    case "object": {
      const child = map.getMap(key);
      const body = next as JsonObject;
      reconcileMap(child, isJsonObject(current) ? current : {}, body, stats);
      // An object that is empty on creation produced no event above, so give it
      // one; `current === undefined` keeps this from re-firing on later passes.
      if (current === undefined && Object.keys(body).length === 0) {
        child.set(EMPTY_FLAG, true);
        stats.ops++;
      }
      return;
    }
    case "primitive-array": {
      const arr = map.getArray(key);
      const body = next as Json[];
      if (current === undefined && body.length === 0) {
        // An empty insert is a real, replicable event that materializes the array.
        arr.insert(0, []);
        stats.ops++;
        return;
      }
      reconcilePrimitiveArray(arr, Array.isArray(current) ? current : [], body, stats);
      return;
    }
    case "object-array": {
      const container = map.getMap(key);
      reconcileList(container, Array.isArray(current) ? current : [], next as Json[], stats);
      return;
    }
  }
}

type Kind = "string" | "primitive" | "object" | "primitive-array" | "object-array" | "undefined";

/**
 * Classifies a JSON value into the representation it maps to. An array is a
 * keyed collection as soon as any element is an object or array, because the
 * encoding has to be uniform across the array's lifetime.
 */
function kindOf(value: Json): Kind {
  if (typeof value === "string") return "string";
  if (Array.isArray(value)) {
    const structured = value.some((v) => v !== null && typeof v === "object");
    return structured ? "object-array" : "primitive-array";
  }
  if (value !== null && typeof value === "object") return "object";
  return "primitive";
}

/** Applies the minimal insert/delete pair that turns `current` into `next`. */
function reconcilePrimitiveArray(
  arr: YArray,
  current: Json[],
  next: Json[],
  stats: ApplyStats,
): void {
  let prefix = 0;
  while (
    prefix < current.length &&
    prefix < next.length &&
    sameScalar(current[prefix], next[prefix])
  ) {
    prefix++;
  }

  let curEnd = current.length;
  let nextEnd = next.length;
  while (
    curEnd > prefix &&
    nextEnd > prefix &&
    sameScalar(current[curEnd - 1], next[nextEnd - 1])
  ) {
    curEnd--;
    nextEnd--;
  }

  if (curEnd > prefix) {
    arr.delete(prefix, curEnd - prefix);
    stats.ops++;
  }
  if (nextEnd > prefix) {
    arr.insert(prefix, next.slice(prefix, nextEnd));
    stats.ops++;
  }
}

/**
 * Reconciles an array of objects into the keyed-collection encoding: element
 * bodies are reconciled by identity under `#items`, and ordering is reconciled
 * separately as an RGA of ids under `#order`.
 */
function reconcileList(
  container: YMap,
  current: Json[],
  next: Json[],
  stats: ApplyStats,
): void {
  if (container.get(LIST_FLAG) !== true) {
    container.set(LIST_FLAG, true);
    stats.ops++;
  }

  const nextIds = assignKeys(next);
  const currentIds = assignKeys(current);

  const items = container.getMap(LIST_ITEMS);
  const currentById = new Map<string, Json>();
  currentIds.forEach((id, i) => currentById.set(id, current[i]));

  for (let i = 0; i < next.length; i++) {
    reconcileKey(items, nextIds[i], currentById.get(nextIds[i]), next[i], stats);
  }

  const keep = new Set(nextIds);
  for (const id of currentIds) {
    if (!keep.has(id)) {
      items.delete(id);
      stats.ops++;
    }
  }

  reconcilePrimitiveArray(container.getArray(LIST_ORDER), currentIds, nextIds, stats);
}

/**
 * Derives a stable key per array element. An element carrying its own
 * `id`/`_id`/`uuid` keeps that identity across reorderings; one without falls
 * back to its position, which means concurrent inserts into a list of
 * id-less objects merge by position rather than by identity.
 */
function assignKeys(values: Json[]): string[] {
  const used = new Set<string>();
  return values.map((value, index) => {
    let key = `p${index}`;
    if (isJsonObject(value)) {
      for (const field of ["id", "_id", "uuid"]) {
        const candidate = value[field];
        if (typeof candidate === "string" || typeof candidate === "number") {
          key = `k${String(candidate)}`;
          break;
        }
      }
    }
    // Duplicate ids would collapse two elements onto one slot; disambiguate.
    let unique = key;
    let suffix = 1;
    while (used.has(unique)) unique = `${key}~${suffix++}`;
    used.add(unique);
    return unique;
  });
}

/**
 * Applies the minimal delete/insert pair that turns the YText's content into
 * `next`. Diffs on code points so an edit never splits a surrogate pair, then
 * converts the boundaries back to the code-unit offsets YText indexes by.
 */
function syncText(text: YText, current: string, next: string, stats: ApplyStats): void {
  if (current === next) return;

  const currentCP = Array.from(current);
  const nextCP = Array.from(next);

  let prefix = 0;
  while (
    prefix < currentCP.length &&
    prefix < nextCP.length &&
    currentCP[prefix] === nextCP[prefix]
  ) {
    prefix++;
  }

  let curEnd = currentCP.length;
  let nextEnd = nextCP.length;
  while (curEnd > prefix && nextEnd > prefix && currentCP[curEnd - 1] === nextCP[nextEnd - 1]) {
    curEnd--;
    nextEnd--;
  }

  const start = currentCP.slice(0, prefix).join("").length;
  const deleted = currentCP.slice(prefix, curEnd).join("").length;
  const inserted = nextCP.slice(prefix, nextEnd).join("");

  if (deleted > 0) {
    text.delete(start, deleted);
    stats.ops++;
  }
  if (inserted.length > 0) {
    text.insert(start, inserted);
    stats.ops++;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sameScalar(a: Json, b: Json): boolean {
  return a === b;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value);
}
