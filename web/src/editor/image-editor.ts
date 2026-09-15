import type { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";

import type { MediaUploader } from "./media-upload.js";

interface ImageEditorOptions {
  readonly editor: Editor;
  readonly panel: HTMLElement;
  readonly uploader: MediaUploader;
  readonly status: HTMLElement;
  readonly vault: string;
  readonly control?: HTMLButtonElement;
}

interface ImageSelection {
  readonly position: number;
  readonly destination: string;
  readonly alt: string;
}

interface ImageEditorHandle {
  readonly element: HTMLElement;
  destroy(): void;
}

/** Mounts keyboard-reachable controls for editing a selected image's derived display copy. */
export function mountImageEditor(options: ImageEditorOptions): ImageEditorHandle {
  const control = options.control ?? document.createElement("button");
  control.type = "button";
  control.className = "editor-control";
  control.classList.add("image-editor-trigger");
  control.textContent = "Edit image";
  control.setAttribute("aria-label", "Edit selected image");
  control.disabled = true;
  control.hidden = true;

  const dialog = document.createElement("dialog");
  dialog.className = "image-editor-dialog";
  dialog.setAttribute("aria-labelledby", "image-editor-title");
  const title = document.createElement("h2");
  title.id = "image-editor-title";
  title.textContent = "Edit image";
  const canvas = document.createElement("canvas");
  canvas.className = "image-editor-canvas";
  canvas.setAttribute("aria-label", "Image preview");
  const controls = document.createElement("div");
  controls.className = "image-editor-options";
  const crop = select("Crop", [
    ["none", "Original"],
    ["square", "Square"],
    ["landscape", "Landscape"],
    ["portrait", "Portrait"],
  ]);
  const size = range("Display size", 25, 100, 100, "%");
  const brightness = range("Brightness", 50, 150, 100, "%");
  const contrast = range("Contrast", 50, 150, 100, "%");
  const saturation = range("Saturation", 0, 200, 100, "%");
  const rotateLeft = action("Rotate left");
  const rotateRight = action("Rotate right");
  const useOriginal = action("Use original");
  const save = action("Save edited display");
  const cancel = action("Cancel");
  cancel.setAttribute("value", "cancel");
  controls.append(crop.element, size.element, brightness.element, contrast.element, saturation.element, rotateLeft, rotateRight, useOriginal);
  const actions = document.createElement("div");
  actions.className = "image-editor-actions";
  actions.append(save, cancel);
  dialog.append(title, canvas, controls, actions);
  document.body.append(dialog);

  let selection: ImageSelection | undefined;
  let image: HTMLImageElement | undefined;
  let objectUrl: string | undefined;
  let rotation = 0;
  let hasEdits = false;
  let destroyed = false;

  const selectedImage = (): ImageSelection | undefined => {
    const node = options.editor.state.selection instanceof NodeSelection
      ? options.editor.state.selection.node
      : undefined;
    if (node?.type.name !== "image") return undefined;
    const destination = node.attrs["dest"];
    const alt = node.attrs["alt"];
    return typeof destination === "string" && typeof alt === "string"
      ? { position: options.editor.state.selection.from, destination, alt }
      : undefined;
  };
  const refresh = (): void => {
    selection = selectedImage();
    control.disabled = selection === undefined;
    control.hidden = selection === undefined;
    if (selection !== undefined) positionControl(selection.position);
  };
  const positionControl = (position: number): void => {
    const element = options.editor.view.nodeDOM(position);
    if (!(element instanceof HTMLElement)) return;
    const bounds = element.getBoundingClientRect();
    const left = Math.min(Math.max(8, bounds.left), Math.max(8, window.innerWidth - control.offsetWidth - 8));
    const top = Math.min(Math.max(8, bounds.bottom + 8), Math.max(8, window.innerHeight - control.offsetHeight - 8));
    control.style.left = `${left}px`;
    control.style.top = `${top}px`;
  };
  const setImage = async (url: string): Promise<void> => {
    const response = await fetch(url);
    if (!response.ok) throw new Error("image could not be loaded");
    const blob = await response.blob();
    if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(blob);
    image = await imageFrom(objectUrl);
    draw();
  };
  const sourceUrl = (path: string, original: boolean): string =>
    `/api/v1/vaults/${encodeURIComponent(options.vault)}/media/${path}${original ? "?original=true" : ""}`;
  const draw = (): void => {
    if (image === undefined) return;
    const sourceWidth = image.naturalWidth;
    const sourceHeight = image.naturalHeight;
    const aspect = crop.input.value === "square" ? 1 : crop.input.value === "landscape" ? 16 / 9 : crop.input.value === "portrait" ? 9 / 16 : sourceWidth / sourceHeight;
    let cropWidth = sourceWidth;
    let cropHeight = sourceHeight;
    if (sourceWidth / sourceHeight > aspect) cropWidth = Math.max(1, Math.round(sourceHeight * aspect));
    else cropHeight = Math.max(1, Math.round(sourceWidth / aspect));
    const scale = Number(size.input.value) / 100;
    const outputWidth = Math.max(1, Math.round(cropWidth * scale));
    const outputHeight = Math.max(1, Math.round(cropHeight * scale));
    const quarterTurn = rotation % 180 !== 0;
    canvas.width = quarterTurn ? outputHeight : outputWidth;
    canvas.height = quarterTurn ? outputWidth : outputHeight;
    const context = canvas.getContext("2d");
    if (context === null) return;
    context.save();
    context.filter = `brightness(${brightness.input.value}%) contrast(${contrast.input.value}%) saturate(${saturation.input.value}%)`;
    context.translate(canvas.width / 2, canvas.height / 2);
    context.rotate(rotation * Math.PI / 180);
    context.drawImage(image, (sourceWidth - cropWidth) / -2, (sourceHeight - cropHeight) / -2, cropWidth, cropHeight, -outputWidth / 2, -outputHeight / 2, outputWidth, outputHeight);
    context.restore();
  };
  const resetControls = (): void => {
    crop.input.value = "none";
    size.input.value = "100";
    brightness.input.value = "100";
    contrast.input.value = "100";
    saturation.input.value = "100";
    rotation = 0;
    hasEdits = false;
  };
  const closeDialog = (): void => {
    if (typeof dialog.close === "function") dialog.close();
    else dialog.open = false;
  };
  const open = async (): Promise<void> => {
    selection = selectedImage();
    if (selection === undefined) return;
    resetControls();
    try {
      await setImage(sourceUrl(selection.destination, false));
      if (!destroyed) dialog.showModal();
    } catch {
      options.status.textContent = "Image could not be opened for editing.";
    }
  };
  const onSelection = (): void => refresh();
  const onImageClick = (event: MouseEvent): void => {
    if (!(event.target instanceof HTMLImageElement)) return;
    const position = options.editor.view.posAtDOM(event.target, 0);
    options.editor.view.dispatch(options.editor.state.tr.setSelection(NodeSelection.create(options.editor.state.doc, position)));
    options.editor.view.focus();
  };
  const onControl = (): void => {
    hasEdits = true;
    draw();
  };
  const onViewportChange = (): void => {
    if (selection !== undefined) positionControl(selection.position);
  };
  const onOriginal = (): void => {
    if (selection === undefined) return;
    hasEdits = true;
    useOriginal.disabled = true;
    options.status.textContent = "Loading original image…";
    void setImage(sourceUrl(selection.destination, true))
      .then(() => {
        options.status.textContent = "Original image loaded.";
      })
      .catch(() => {
        options.status.textContent = "The original image is unavailable.";
      })
      .finally(() => {
        useOriginal.disabled = false;
      });
  };
  const onRotateLeft = (): void => { hasEdits = true; rotation = (rotation + 270) % 360; draw(); };
  const onRotateRight = (): void => { hasEdits = true; rotation = (rotation + 90) % 360; draw(); };
  const onSave = async (): Promise<void> => {
    if (selection === undefined) return;
    if (!hasEdits) {
      closeDialog();
      options.status.textContent = "No image changes made.";
      return;
    }
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png", 0.92));
    if (blob === null) {
      options.status.textContent = "Edited image could not be encoded.";
      return;
    }
    try {
      options.status.textContent = "Uploading edited image…";
      const result = await options.uploader.uploadDerived?.(new File([blob], "edited.png", { type: "image/png" }), selection.destination);
      if (result === undefined) throw new Error("derived media uploads are unavailable");
      options.editor.view.dispatch(options.editor.state.tr.setNodeMarkup(selection.position, undefined, {
        ...options.editor.state.doc.nodeAt(selection.position)?.attrs,
        dest: result.path,
        alt: selection.alt,
      }));
      closeDialog();
      options.status.textContent = "Edited image saved.";
    } catch {
      options.status.textContent = "Edited image upload failed.";
    }
  };
  control.addEventListener("click", () => { void open(); });
  options.editor.on("selectionUpdate", onSelection);
  options.editor.view.dom.addEventListener("click", onImageClick);
  window.addEventListener("resize", onViewportChange);
  window.addEventListener("scroll", onViewportChange, true);
  crop.input.addEventListener("input", onControl);
  for (const input of [size.input, brightness.input, contrast.input, saturation.input]) input.addEventListener("input", onControl);
  rotateLeft.addEventListener("click", onRotateLeft);
  rotateRight.addEventListener("click", onRotateRight);
  useOriginal.addEventListener("click", onOriginal);
  cancel.addEventListener("click", () => {
    if (typeof dialog.close === "function") dialog.close();
    else dialog.open = false;
  });
  save.addEventListener("click", () => { void onSave(); });
  refresh();
  options.panel.append(control);
  return {
    element: control,
    destroy: () => {
      destroyed = true;
      options.editor.off("selectionUpdate", onSelection);
      options.editor.view.dom.removeEventListener("click", onImageClick);
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
      control.remove();
      dialog.remove();
      if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl);
    },
  };
}

function action(label: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "editor-control";
  button.textContent = label;
  return button;
}

function select(label: string, values: readonly (readonly [string, string])[]): { readonly element: HTMLElement; readonly input: HTMLSelectElement } {
  const wrapper = document.createElement("label");
  wrapper.textContent = label;
  const input = document.createElement("select");
  for (const [value, text] of values) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    input.append(option);
  }
  wrapper.append(input);
  return { element: wrapper, input };
}

function range(label: string, min: number, max: number, value: number, suffix: string): { readonly element: HTMLElement; readonly input: HTMLInputElement } {
  const wrapper = document.createElement("label");
  const name = document.createElement("span");
  name.textContent = label;
  const input = document.createElement("input");
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  input.value = String(value);
  input.setAttribute("aria-label", label);
  const output = document.createElement("output");
  const update = (): void => { output.textContent = `${input.value}${suffix}`; };
  input.addEventListener("input", update);
  update();
  wrapper.append(name, input, output);
  return { element: wrapper, input };
}

function imageFrom(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("image could not be loaded"));
    image.src = url;
  });
}
