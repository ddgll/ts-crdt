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
const ws = new WebSocket(`${protocol}//${window.location.host}/ws-text?room=${room}`);

client.bind(ws);

ws.onopen = () => {
  console.log("Connected to server (Text-DB mode)");
};

client.onMessage((type) => {
  if (type === "snapshot") {
    isInitialized = true;
    textarea.disabled = false; // Enable input now
    console.log("Client initialized (Text-DB mode).");
  }
  updateTextarea();
});

ws.onclose = () => {
  console.log("Disconnected from server");
  textarea.disabled = true;
};

ws.onerror = (error) => {
  console.error("WebSocket error:", error);
  textarea.disabled = true;
};

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

  client.syncText(["content"], textarea.value);
});
