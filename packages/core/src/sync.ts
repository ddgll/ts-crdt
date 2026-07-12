import { CrdtEvent } from "./eventGraph/eventGraph.js";
import { StateSnapshot } from "./egWalker/egWalker.js";

/**
 * Message sent from server to client.
 */
export type ServerMessage =
  | { type: "snapshot"; data: StateSnapshot }
  | { type: "event"; data: CrdtEvent }
  | { type: "awareness"; data: { replicaId: string; state: unknown } };

/**
 * Message sent from client to server.
 *
 * The bare `CrdtEvent` member is a **deprecated** legacy wire format retained for
 * backward compatibility; new clients should always send the tagged
 * `{ type: "event"; data }` form. The server still accepts the bare form (see
 * `CrdtServer.handleConnection`) but it may be removed in a future major release.
 */
export type ClientMessage =
  | { type: "event"; data: CrdtEvent }
  | { type: "awareness"; data: { replicaId: string; state: unknown } }
  /** @deprecated Send `{ type: "event"; data }` instead. */
  | CrdtEvent;
