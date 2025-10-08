import { Doc } from "@ddgll/ts-crdt";

const textarea = document.getElementById("user1") as HTMLTextAreaElement;
const replicaId = crypto.randomUUID();
const doc = new Doc(replicaId);
let isApplyingRemoteChanges = false;
let isInitialized = false;

// Disable the textarea until the client is initialized
textarea.disabled = true;

const ws = new WebSocket("ws://localhost:3000/ws");

ws.onopen = () => {
  console.log("Connected to server");
};

ws.onmessage = (message) => {
  const { type, data } = JSON.parse(message.data);

  isApplyingRemoteChanges = true;
  if (type === "snapshot") {
    doc.egWalker.loadStateSnapshot(data);
    isInitialized = true;
    textarea.disabled = false; // Enable input now
    console.log("Client initialized.");
  } else if (type === "event") {
    if (data.replicaId !== doc.egWalker.getReplicaId()) {
      if (isInitialized) {
        doc.egWalker.integrateRemote([data]);
      } else {
        console.warn("Ignoring event received before initialization.");
      }
    }
  }
  updateTextarea();
  isApplyingRemoteChanges = false;
};

ws.onclose = () => {
  console.log("Disconnected from server");
  textarea.disabled = true;
};

ws.onerror = (error) => {
  console.error("WebSocket error:", error);
  textarea.disabled = true;
};

let previousText = "";
function updateTextarea() {
  const content = doc.getMap().getArray("content");
  if (content) {
    const text = content.toJSON().join("");
    // Avoid resetting cursor position if text is the same
    if (textarea.value !== text) {
      textarea.value = text;
    }
    previousText = text;
  } else {
    textarea.value = "";
    previousText = "";
  }
}

textarea.addEventListener("input", () => {
  if (!isInitialized || isApplyingRemoteChanges) {
    return;
  }

  const newText = textarea.value;
  const oldText = previousText;

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
    const event = doc.localDelete(["content"], start, deletedLength);
    if (event) {
      ws.send(JSON.stringify(event));
    }
  }

  const insertedText = newText.substring(start, newEnd);
  if (insertedText.length > 0) {
    const event = doc.localInsert(["content"], start, insertedText.split(""));
    if (event) {
      ws.send(JSON.stringify(event));
    }
  }

  previousText = newText;
});
