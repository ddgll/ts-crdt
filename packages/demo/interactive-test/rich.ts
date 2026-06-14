import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Doc } from "@ddgll/ts-crdt";
import { CrdtClient } from "@ddgll/ts-crdt-client";

const replicaId = crypto.randomUUID();
const doc = new Doc(replicaId);
const client = new CrdtClient(doc);
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
    editor.setEditable(true);
    console.log("Client initialized.");
  }
  updateEditorContent();
});

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
  if (!isInitialized || client.isApplyingRemoteChanges()) {
    return;
  }

  client.syncText(["content"], editor.getHTML());
});
