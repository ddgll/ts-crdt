import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Doc } from "@ddgll/ts-crdt";

const replicaId = crypto.randomUUID();
const doc = new Doc(replicaId);
let isApplyingRemoteChanges = false;
let isInitialized = false;

const editor = new Editor({
  element: document.querySelector("#editor"),
  extensions: [StarterKit],
  content: "<p>Connecting to server...</p>",
  editable: false, // Initially not editable
});

// Toolbar buttons
const boldButton = document.querySelector("#bold");
const italicButton = document.querySelector("#italic");
const strikeButton = document.querySelector("#strike");
const h1Button = document.querySelector("#h1");
const h2Button = document.querySelector("#h2");
const pButton = document.querySelector("#p");
const bulletListButton = document.querySelector("#bulletList");
const orderedListButton = document.querySelector("#orderedList");

boldButton?.addEventListener(
  "click",
  () => editor.chain().focus().toggleBold().run(),
);
italicButton?.addEventListener(
  "click",
  () => editor.chain().focus().toggleItalic().run(),
);
strikeButton?.addEventListener(
  "click",
  () => editor.chain().focus().toggleStrike().run(),
);
h1Button?.addEventListener(
  "click",
  () => editor.chain().focus().toggleHeading({ level: 1 }).run(),
);
h2Button?.addEventListener(
  "click",
  () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
);
pButton?.addEventListener(
  "click",
  () => editor.chain().focus().setParagraph().run(),
);
bulletListButton?.addEventListener(
  "click",
  () => editor.chain().focus().toggleBulletList().run(),
);
orderedListButton?.addEventListener(
  "click",
  () => editor.chain().focus().toggleOrderedList().run(),
);

const updateToolbarButtons = () => {
  boldButton?.classList.toggle("is-active", editor.isActive("bold"));
  italicButton?.classList.toggle("is-active", editor.isActive("italic"));
  strikeButton?.classList.toggle("is-active", editor.isActive("strike"));
  h1Button?.classList.toggle(
    "is-active",
    editor.isActive("heading", { level: 1 }),
  );
  h2Button?.classList.toggle(
    "is-active",
    editor.isActive("heading", { level: 2 }),
  );
  pButton?.classList.toggle("is-active", editor.isActive("paragraph"));
  bulletListButton?.classList.toggle(
    "is-active",
    editor.isActive("bulletList"),
  );
  orderedListButton?.classList.toggle(
    "is-active",
    editor.isActive("orderedList"),
  );
};

editor.on("transaction", updateToolbarButtons);
editor.on("selectionUpdate", updateToolbarButtons);

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
    editor.setEditable(true);
    console.log("Client initialized.");
    updateEditorContent();
  } else if (type === "event") {
    if (data.replicaId !== doc.egWalker.getReplicaId()) {
      if (isInitialized) {
        doc.egWalker.integrateRemote([data]);
        updateEditorContent();
      } else {
        console.warn("Ignoring event received before initialization.");
      }
    }
  }

  setTimeout(() => {
    isApplyingRemoteChanges = false;
  }, 0);
};

ws.onclose = () => {
  console.log("Disconnected from server");
  editor.setEditable(false);
};

ws.onerror = (error) => {
  console.error("WebSocket error:", error);
  editor.setEditable(false);
};

function updateEditorContent() {
  const contentArray = doc.getMap().getArray("content");
  if (!contentArray) return;

  const html = contentArray.toJSON().join("");

  if (editor.getHTML() !== html) {
    console.log("Applying remote content:", html);
    const { from, to } = editor.state.selection;
    editor.commands.setContent(html);
    editor.commands.setTextSelection({ from, to });
  }
}

editor.on("update", () => {
  if (!isInitialized || isApplyingRemoteChanges) {
    return;
  }

  const newHtml = editor.getHTML();
  const oldHtml = (doc.getMap().getArray("content")?.toJSON() ?? []).join("");

  if (newHtml === oldHtml) {
    return;
  }

  console.log("Old HTML:", oldHtml);
  console.log("New HTML:", newHtml);

  let start = 0;
  while (
    start < oldHtml.length &&
    start < newHtml.length &&
    oldHtml[start] === newHtml[start]
  ) {
    start++;
  }

  let oldEnd = oldHtml.length;
  let newEnd = newHtml.length;
  while (
    oldEnd > start &&
    newEnd > start &&
    oldEnd <= oldHtml.length && // boundary checks
    newEnd <= newHtml.length && // boundary checks
    oldHtml[oldEnd - 1] === newHtml[newEnd - 1]
  ) {
    oldEnd--;
    newEnd--;
  }

  const deletedLength = oldEnd - start;
  if (deletedLength > 0) {
    const deletedContent = oldHtml.substring(start, oldEnd);
    console.log(
      `Deleting ${deletedLength} chars from ${start}: "${deletedContent}"`,
    );
    const event = doc.localDelete(["content"], start, deletedLength);
    if (event) {
      ws.send(JSON.stringify(event));
    }
  }

  const insertedText = newHtml.substring(start, newEnd);
  if (insertedText.length > 0) {
    console.log(`Inserting at ${start}: "${insertedText}"`);
    const event = doc.localInsert(["content"], start, insertedText.split(""));
    if (event) {
      ws.send(JSON.stringify(event));
    }
  }
});
