import { CrdtEvent } from "./eventGraph/eventGraph.js";
import { StateSnapshot } from "./egWalker/egWalker.js";

/**
 * Message sent from server to client.
 */
export type ServerMessage =
  | { type: "snapshot"; data: StateSnapshot }
  | { type: "event"; data: CrdtEvent };

/**
 * Message sent from client to server.
 */
export type ClientMessage = CrdtEvent;
