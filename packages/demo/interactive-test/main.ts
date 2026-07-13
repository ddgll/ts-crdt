import { Doc } from "@ddgll/ts-crdt";
import { CrdtClient } from "@ddgll/ts-crdt/client";

const textarea = document.getElementById("user1") as HTMLTextAreaElement;
const replicaId = crypto.randomUUID();
const doc = new Doc(replicaId);
const client = new CrdtClient(doc);
let isInitialized = false;

// Disable the textarea until the client is initialized
textarea.disabled = true;

const urlParams = new URLSearchParams(window.location.search);
const room = urlParams.get("room") || "default";
const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
const wsUrl = `${protocol}//${window.location.host}/ws?room=${room}`;

client.onMessage((type) => {
  if (type === "snapshot") {
    isInitialized = true;
    textarea.disabled = false; // Enable input now
    console.log("Client initialized.");
  }
  updateTextarea();
});

// Reconnection story: on every disconnect we open a fresh WebSocket and hand it
// to the client via rebind(). The client keeps a queue of local edits across
// sockets, so anything typed while offline is replayed to the server once the
// new connection is established (and survives the reconnect snapshot load).
let reconnectDelay = 500;
let isFirstConnection = true;

function connect() {
  const ws = new WebSocket(wsUrl);

  if (isFirstConnection) {
    client.bind(ws);
    isFirstConnection = false;
  } else {
    client.rebind(ws);
  }

  ws.onopen = () => {
    console.log("Connected to server");
    reconnectDelay = 500; // reset backoff on a successful connection
  };

  ws.onclose = () => {
    console.log("Disconnected from server, will reconnect...");
    textarea.disabled = true;
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 10_000);
  };

  ws.onerror = (error) => {
    console.error("WebSocket error:", error);
    textarea.disabled = true;
  };
}

connect();

function updateTextarea() {
  const content = doc.getMap().getArray("content");
  if (content) {
    const text = content.toJSON().join("");
    // Avoid resetting cursor position if text is the same
    if (textarea.value !== text) {
      textarea.value = text;
    }
  } else {
    textarea.value = "";
  }
}

textarea.addEventListener("input", () => {
  if (!isInitialized || client.isApplyingRemoteChanges()) {
    return;
  }

  client.syncText(["content"], textarea.value, "array");
});
