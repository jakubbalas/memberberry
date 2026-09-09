import React, { useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  Excalidraw,
  exportToBlob,
  exportToSvg,
} from "@excalidraw/excalidraw";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import "@excalidraw/excalidraw/index.css";

import { replaceScene, type DrawingExports, type DrawingPayload } from "./drawing.js";

interface IslandProps {
  readonly payload: DrawingPayload;
  readonly editable: boolean;
  readonly save: (markdown: string, base: string, exports: DrawingExports) => Promise<string>;
}

/** Mounts the Excalidraw React island into a DOM host and returns its teardown. */
export function mountDrawingIsland(
  host: HTMLElement,
  payload: DrawingPayload,
  editable: boolean,
  save: (markdown: string, base: string, exports: DrawingExports) => Promise<string>,
): () => void {
  const root: Root = createRoot(host);
  root.render(<DrawingIsland payload={payload} editable={editable} save={save} />);
  return () => root.unmount();
}

function DrawingIsland({ payload, editable, save }: IslandProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const preview = useRef<HTMLSpanElement>(null);
  const scene = payload.scene;
  let currentMarkdown = payload.markdown;
  let currentRevision = payload.revision;
  let saveChain: Promise<void> = Promise.resolve();
  const elements = scene["elements"] as readonly ExcalidrawElement[];
  const appState = scene["appState"] as Partial<AppState> | undefined;
  const files = scene["files"] as BinaryFiles | undefined;

  useEffect(() => {
    if (open) return;
    let live = true;
    void exportToSvg({ elements, appState, files: files ?? null, exportPadding: 16 })
      .then((svg: SVGSVGElement) => {
        if (live) {
          preview.current?.replaceChildren(svg);
        }
      })
      .catch(() => {
        if (live) setError("drawing preview unavailable");
      });
    return () => {
      live = false;
    };
  }, [elements, appState, files, open]);

  if (!open) {
    return (
      <button type="button" className="drawing-preview" onClick={() => setOpen(true)}>
        <span data-drawing-preview aria-hidden="true" ref={preview} />
        <span className="drawing-preview-label">{error ?? "Open drawing"}</span>
      </button>
    );
  }

  return (
    <div className="drawing-editor">
      <Excalidraw
        initialData={{ elements, ...(appState === undefined ? {} : { appState }), ...(files === undefined ? {} : { files }) }}
        viewModeEnabled={!editable}
        onChange={(nextElements, nextAppState, nextFiles) => {
          if (!editable) return;
          const nextScene = { ...scene, elements: nextElements, appState: nextAppState, files: nextFiles };
          saveChain = saveChain.then(() => persist(nextScene, nextElements, nextAppState, nextFiles));
        }}
      />
      {error === undefined ? null : <p role="alert" className="drawing-error">{error}</p>}
    </div>
  );

  async function persist(
    nextScene: Record<string, unknown>,
    nextElements: readonly ExcalidrawElement[],
    nextAppState: AppState,
    nextFiles: BinaryFiles,
  ): Promise<void> {
    try {
      const [svg, png] = await Promise.all([
        exportToSvg({ elements: nextElements, appState: nextAppState, files: nextFiles, exportPadding: 16 }),
        exportToBlob({ elements: nextElements, appState: nextAppState, files: nextFiles, mimeType: "image/png", exportPadding: 16 }),
      ]);
      const markdown = replaceScene(currentMarkdown, nextScene);
      const revision = await save(markdown, currentRevision, {
        svg: svg.outerHTML,
        png: await blobDataUrl(png),
      });
      currentMarkdown = markdown;
      currentRevision = revision;
    } catch {
      setError("drawing changed elsewhere; reload before saving");
    }
  }
}

async function blobDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:image/png;base64,${btoa(binary)}`;
}
