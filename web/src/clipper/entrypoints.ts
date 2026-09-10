/** Bookmarklet and extension entry points over the shared clipper primitives. */

import { captureClip, type ClipMode } from "./capture.js";
import { type ClipPayload, type ClipResult } from "./transport.js";

export interface ClipTarget {
  readonly vault: string;
  /** Optional vault-relative Markdown destination, validated again by the server. */
  readonly path?: string;
  readonly folder?: string;
  readonly tags?: readonly string[];
  readonly template?: string;
}

export interface ClipSender {
  clip(payload: ClipPayload): Promise<ClipResult>;
}

/** Captures the current page and hands it to the authenticated transport. */
export function clipCurrentPage(
  mode: ClipMode,
  target: ClipTarget,
  sender: ClipSender,
  page?: Pick<Document, "URL" | "documentElement" | "querySelector" | "createElement">,
  selection?: Pick<Selection, "rangeCount" | "getRangeAt"> | null,
): Promise<ClipResult> {
  const captured = captureClip(mode, page, selection);
  const payload = {
    ...captured,
    ...(target.path === undefined ? {} : { path: target.path }),
    ...(target.folder === undefined ? {} : { folder: target.folder }),
    ...(target.tags === undefined ? {} : { tags: target.tags }),
    ...(target.template === undefined ? {} : { template: target.template }),
  };
  return sender.clip(payload);
}

/** Produces the tiny bookmarklet body; the host page still supplies the actual UI and token. */
export function bookmarkletSource(endpoint: string): string {
  const encoded = JSON.stringify(endpoint);
  return `javascript:(()=>{window.open(${encoded},"_blank","noopener,noreferrer")})()`;
}
