import { Doc } from "@ddgll/ts-crdt";
import { CrdtClient } from "@ddgll/ts-crdt-client";

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
const ws = new WebSocket(`${protocol}//${window.location.host}/ws?room=${room}`);

client.bind(ws);

ws.onopen = () => {
  console.log("Connected to server");
};

client.onMessage((type) => {
  if (type === "snapshot") {
    isInitialized = true;
    textarea.disabled = false; // Enable input now
    console.log("Client initialized.");
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

  const newText = textarea.value;
  const oldText = (doc.getMap().getArray("content")?.toJSON() ?? []).join("");

  if (newText === oldText) {
    return;
  }

  let start = 0;
  while (
    start < oldText.length &&
    start < newText.length &&
    oldText[start] === newText[start]
  ) {
    start++;
  }

  let oldEnd = oldText.length;
  let newEnd = newText.length;
  while (
    oldEnd > start &&
    newEnd > start &&
    oldText[oldEnd - 1] === newText[newEnd - 1]
  ) {
    oldEnd--;
    newEnd--;
  }

  const deletedLength = oldEnd - start;
  if (deletedLength > 0) {
    doc.localDelete(["content"], start, deletedLength);
  }

  const insertedText = newText.substring(start, newEnd);
  if (insertedText.length > 0) {
    doc.localInsert(["content"], start, insertedText.split(""));
  }
});
