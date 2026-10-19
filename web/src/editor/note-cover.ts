import type { Editor } from "@tiptap/core";
import type { Doc, YMapEvent } from "yjs";
import type { MediaUploader } from "./media-upload.js";
import "./note-cover.css";

interface CoverOptions {
  readonly editor: Editor;
  readonly document: Doc;
  readonly panel: HTMLElement;
  readonly status: HTMLElement;
  readonly vault: string;
  readonly uploader?: MediaUploader | undefined;
  readonly canEdit: () => boolean;
  readonly onPendingChange?: () => void;
}

/** Mounts a note's Markdown-backed cover, using only authorized vault media. */
export function mountNoteCover(options: CoverOptions): { destroy(): void; hasPending(): boolean; refresh(): void } {
  const metadata = options.document.getMap("frontmatter");
  const root = document.createElement("section");
  root.className = "note-cover";
  root.setAttribute("aria-label", "Note cover");
  const image = document.createElement("img");
  image.alt = "Note cover";
  const menu = document.createElement("details");
  menu.className = "note-cover-menu";
  const toggle = document.createElement("summary");
  toggle.textContent = "Edit cover";
  menu.append(toggle);
  const actions = document.createElement("div");
  actions.className = "note-cover-actions";
  const upload = document.createElement("button");
  upload.type = "button";
  const paste = document.createElement("button");
  paste.type = "button";
  paste.textContent = "Paste from clipboard";
  const hint = document.createElement("p");
  hint.className = "note-cover-hint";
  hint.textContent = "Drop an image here, or use your paste shortcut.";
  const dropHint = document.createElement("p");
  dropHint.className = "note-cover-drop-hint";
  dropHint.textContent = "Drop image to set cover";
  dropHint.hidden = true;
  const remove = document.createElement("button");
  remove.type = "button";
  remove.textContent = "Remove cover";
  const picker = document.createElement("input");
  picker.type = "file";
  picker.accept = "image/png,image/jpeg,image/gif,image/webp";
  picker.setAttribute("aria-label", "Upload cover image");
  picker.hidden = true;
  const positionLabel = document.createElement("label");
  positionLabel.textContent = "Reposition";
  const position = document.createElement("input");
  position.type = "range";
  position.min = "0";
  position.max = "100";
  position.setAttribute("aria-label", "Cover vertical position");
  positionLabel.append(position);
  actions.append(upload, paste, positionLabel, remove, hint, picker);
  menu.append(actions);
  root.append(image, menu, dropHint);
  options.panel.querySelector(".editor-surface")?.before(root);
  if (!root.isConnected && !options.panel.contains(root)) options.panel.append(root);
  let destroyed = false;
  let busy = false;
  let revision = 0;
  let generation = 0;
  let lastPath: string | undefined;
  let lastPosition: unknown;
  let lastEditable: boolean | undefined;
  let lastReady: boolean | undefined;
  let lastBusy: boolean | undefined;
  const editable = (): boolean => !destroyed && !options.editor.isDestroyed
    && options.editor.isEditable && options.panel.dataset["body"] !== "waiting"
    && options.panel.dataset["editor"] !== "loading" && options.canEdit();
  const coverPath = (): string | undefined => {
    const value = metadata.get("cover");
    return typeof value === "string" && /^media\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{64}\.(png|jpe?g|gif|webp)$/.test(value)
      ? value : undefined;
  };
  const render = (): void => {
    if (destroyed) return;
    const ready = options.panel.dataset["body"] !== "waiting" && options.panel.dataset["editor"] !== "loading";
    const path = ready ? coverPath() : undefined;
    const canEdit = editable();
    if (!canEdit && root.dataset["dragging"] !== undefined) clearDrag();
    const rawPosition = metadata.get("cover_position");
    if (path === lastPath && rawPosition === lastPosition && canEdit === lastEditable && ready === lastReady && busy === lastBusy) return;
    if (path !== lastPath || !canEdit) menu.open = false;
    root.dataset["covered"] = String(path !== undefined);
    toggle.textContent = path === undefined ? "+ Add cover" : "Edit cover";
    toggle.setAttribute("aria-label", path === undefined ? "Add cover" : "Edit cover");
    menu.hidden = !canEdit;
    lastPath = path; lastPosition = rawPosition; lastEditable = canEdit; lastReady = ready; lastBusy = busy;
    root.hidden = !ready || (path === undefined && (!canEdit || options.uploader === undefined));
    image.hidden = path === undefined;
    if (path === undefined) image.removeAttribute("src");
    else {
      const url = `/api/v1/vaults/${encodeURIComponent(options.vault)}/media/${path}`;
      if (image.getAttribute("src") !== url) image.src = url;
    }
    const value = typeof rawPosition === "string" && /^\d{1,3}$/.test(rawPosition) ? Number(rawPosition) : 50;
    position.value = String(Math.min(100, value));
    image.style.objectPosition = `50% ${position.value}%`;
    actions.hidden = !canEdit;
    upload.hidden = options.uploader === undefined;
    upload.disabled = busy || !canEdit;
    upload.textContent = busy ? "Uploading cover…" : path === undefined ? "Choose from files" : "Change cover";
    paste.hidden = options.uploader === undefined;
    paste.disabled = busy || !canEdit;
    remove.hidden = path === undefined && !busy;
    remove.disabled = !canEdit;
    positionLabel.hidden = path === undefined;
    position.disabled = !canEdit;
  };
  const onMetadata = (event: YMapEvent<unknown>): void => {
    if (!event.keysChanged.has("cover") && !event.keysChanged.has("cover_position")) return;
    revision += 1; render();
  };
  const onUpload = (): void => { if (editable() && !busy) picker.click(); };
  const onRemove = (): void => {
    if (!editable()) return;
    revision += 1;
    generation += 1;
    busy = false;
    options.onPendingChange?.();
    options.document.transact(() => { metadata.delete("cover"); metadata.delete("cover_position"); });
    render();
  };
  const onPosition = (): void => {
    if (!editable() || coverPath() === undefined) return;
    metadata.set("cover_position", position.value);
  };
  const onMenuKey = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || !menu.open) return;
    event.preventDefault();
    event.stopPropagation();
    menu.open = false;
    toggle.focus();
  };
  const onOutsidePointer = (event: PointerEvent): void => {
    if (menu.open && !event.composedPath().includes(menu)) menu.open = false;
  };
  const saveImage = async (read: () => File | undefined | Promise<File | undefined>): Promise<void> => {
    if (!editable() || busy || options.uploader === undefined) return;
    busy = true;
    options.onPendingChange?.();
    const captured = ++revision;
    const attempt = ++generation;
    render();
    try {
      const reading = read();
      const file = reading instanceof Promise ? await reading : reading;
      if (file === undefined || !editable() || captured !== revision) return;
      if (!supportedImage(file)) throw new Error("Choose a PNG, JPEG, GIF or WebP cover image.");
      let result = await options.uploader.upload(file);
      if (result.pending !== undefined) {
        if (!destroyed && captured === revision) options.status.textContent = "Cover upload queued. Reconnect to finish saving it.";
        // why: a blob URL is not a durable Markdown reference; keep the old cover until uploaded.
        result = await result.pending;
      }
      if (!editable() || captured !== revision) return;
      if (!/^media\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{64}\.(png|jpe?g|gif|webp)$/.test(result.path)) {
        throw new Error("The upload did not return a supported cover image.");
      }
      options.document.transact(() => {
        metadata.set("cover", result.path);
        metadata.set("cover_position", "50");
      });
      options.status.textContent = "Cover added.";
    } catch (error: unknown) {
      if (!destroyed && captured === revision) options.status.textContent = error instanceof Error ? error.message : "Cover upload failed.";
    } finally {
      if (!destroyed && attempt === generation) { busy = false; options.onPendingChange?.(); render(); }
    }
  };
  const onFile = (): void => {
    const file = picker.files?.[0];
    picker.value = "";
    if (file !== undefined) void saveImage(() => file);
  };
  const onClipboard = (): void => {
    void saveImage(async () => {
      if (navigator.clipboard?.read === undefined) throw new Error("Clipboard access is unavailable. Focus Add cover or Edit cover and use your paste shortcut.");
      const items = await navigator.clipboard.read().catch(() => {
        throw new Error("Clipboard access was denied. Focus Add cover or Edit cover and use your paste shortcut, or choose a file.");
      });
      for (const item of items) {
        const type = item.types.find(type => /^image\/(png|jpeg|gif|webp)$/.test(type));
        if (type === undefined) continue;
        const blob = await item.getType(type);
        return new File([blob], `cover.${type === "image/jpeg" ? "jpg" : type.slice(6)}`, { type });
      }
      throw new Error("No supported image in the clipboard. Copy an image first.");
    });
  };
  const onPaste = (event: ClipboardEvent): void => {
    if (!editable() || busy || options.uploader === undefined) return;
    const file = Array.from(event.clipboardData?.files ?? []).find(supportedImage);
    if (file === undefined) return;
    event.preventDefault(); event.stopPropagation();
    void saveImage(() => file);
  };
  const isImageDrag = (event: DragEvent): boolean => Array.from(event.dataTransfer?.items ?? [])
    .some(item => item.kind === "file" && (item.type.startsWith("image/") || item.type === ""));
  let dragDepth = 0;
  const clearDrag = (): void => { dragDepth = 0; delete root.dataset["dragging"]; dropHint.hidden = true; };
  const highlightDrag = (): void => { root.dataset["dragging"] = "true"; dropHint.hidden = false; };
  const onDragEnter = (event: DragEvent): void => {
    if (!editable() || busy || options.uploader === undefined || !isImageDrag(event)) return;
    dragDepth += 1; highlightDrag();
  };
  const onDragOver = (event: DragEvent): void => {
    if (!editable() || busy || options.uploader === undefined || !isImageDrag(event)) return;
    event.preventDefault(); event.stopPropagation();
    if (event.dataTransfer !== null) event.dataTransfer.dropEffect = "copy";
    highlightDrag();
  };
  const onDragLeave = (): void => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) clearDrag();
  };
  const onDrop = (event: DragEvent): void => {
    clearDrag();
    if (!editable() || busy || options.uploader === undefined) return;
    const files = Array.from(event.dataTransfer?.files ?? []);
    const file = files.find(supportedImage) ?? files[0];
    if (file === undefined) return;
    event.preventDefault(); event.stopPropagation();
    void saveImage(() => file);
  };
  picker.addEventListener("change", onFile);
  upload.addEventListener("click", onUpload);
  remove.addEventListener("click", onRemove);
  position.addEventListener("input", onPosition);
  // why: pointer clicks on summary can leave focus in the editor or on the page body.
  options.panel.ownerDocument.addEventListener("keydown", onMenuKey, true);
  options.panel.ownerDocument.addEventListener("pointerdown", onOutsidePointer, true);
  paste.addEventListener("click", onClipboard);
  root.addEventListener("paste", onPaste);
  options.panel.addEventListener("dragenter", onDragEnter);
  root.addEventListener("dragover", onDragOver);
  options.panel.addEventListener("dragleave", onDragLeave);
  root.addEventListener("drop", onDrop);
  options.panel.addEventListener("drop", clearDrag);
  options.panel.addEventListener("dragend", clearDrag);
  metadata.observe(onMetadata);
  options.editor.on("transaction", render);
  const observer = new MutationObserver(render);
  observer.observe(options.panel, { attributes: true, attributeFilter: ["data-body", "data-editor"] });
  render();
  return {
    refresh: render,
    hasPending: () => busy,
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      metadata.unobserve(onMetadata);
      options.editor.off("transaction", render);
      observer.disconnect();
      picker.removeEventListener("change", onFile);
      upload.removeEventListener("click", onUpload);
      remove.removeEventListener("click", onRemove);
      position.removeEventListener("input", onPosition);
      options.panel.ownerDocument.removeEventListener("keydown", onMenuKey, true);
      options.panel.ownerDocument.removeEventListener("pointerdown", onOutsidePointer, true);
      paste.removeEventListener("click", onClipboard);
      root.removeEventListener("paste", onPaste);
      options.panel.removeEventListener("dragenter", onDragEnter);
      root.removeEventListener("dragover", onDragOver);
      options.panel.removeEventListener("dragleave", onDragLeave);
      root.removeEventListener("drop", onDrop);
      options.panel.removeEventListener("drop", clearDrag);
      options.panel.removeEventListener("dragend", clearDrag);
      root.remove();
    },
  };
}

function supportedImage(file: File): boolean {
  return /^image\/(png|jpeg|gif|webp)$/.test(file.type)
    || (file.type === "" && /\.(png|jpe?g|gif|webp)$/i.test(file.name));
}
