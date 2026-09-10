import { captureClip, type ClipMode } from "../src/clipper/capture.js";

interface ClipMessage { readonly mode: ClipMode; }

const extension = globalThis as typeof globalThis & {
  browser?: { runtime?: { onMessage?: { addListener(listener: (message: ClipMessage) => CapturedResponse): void } } };
  chrome?: { runtime?: { onMessage?: { addListener(listener: (message: ClipMessage) => CapturedResponse): void } } };
};

interface CapturedResponse { readonly url: string; readonly html: string; readonly title?: string; readonly author?: string; }

function respond(message: ClipMessage): CapturedResponse {
  return captureClip(message.mode);
}

const listener = extension.browser?.runtime?.onMessage ?? extension.chrome?.runtime?.onMessage;
listener?.addListener(respond);
