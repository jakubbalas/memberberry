import { expandTemplate } from "../notes.js";

export interface TemplateSummary {
  readonly path: string;
  readonly name: string;
}

export interface TemplateIndex {
  readonly folder: string;
  readonly templates: readonly TemplateSummary[];
}

export async function fetchTemplates(vault: string, fetcher: typeof globalThis.fetch = globalThis.fetch.bind(globalThis)): Promise<TemplateIndex> {
  const response = await fetcher(`/api/v1/vaults/${encodeURIComponent(vault)}/templates`, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error("Templates are unavailable.");
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null) throw new Error("Templates are unavailable.");
  const record = body as Record<string, unknown>;
  const folder = record["folder"];
  const entries = record["templates"];
  if (typeof folder !== "string" || !Array.isArray(entries)) throw new Error("Templates are unavailable.");
  const templates = entries.flatMap((entry): TemplateSummary[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const value = entry as Record<string, unknown>;
    return typeof value["path"] === "string" && typeof value["name"] === "string"
      ? [{ path: value["path"], name: value["name"] }]
      : [];
  });
  return { folder, templates };
}

export async function readTemplate(vault: string, path: string, fetcher: typeof globalThis.fetch = globalThis.fetch.bind(globalThis)): Promise<string> {
  const response = await fetcher(`/api/v1/vaults/${encodeURIComponent(vault)}/templates/${path.split("/").map(encodeURIComponent).join("/")}`, { headers: { accept: "text/plain" } });
  if (!response.ok) throw new Error("That template is unavailable.");
  return response.text();
}

export const TEMPLATE_EVENT = "memberberry:insert-template";
export const TEMPLATE_PALETTE_EVENT = "memberberry:open-template-palette";

export interface TemplateEventDetail {
  readonly body: string;
}

export function dispatchTemplate(body: string): void {
  window.dispatchEvent(new CustomEvent<TemplateEventDetail>(TEMPLATE_EVENT, { detail: { body } }));
}

export function openTemplatePalette(): void {
  window.dispatchEvent(new Event(TEMPLATE_PALETTE_EVENT));
}

export function templateContext(title: string, user: string, selection = ""): Parameters<typeof expandTemplate>[1] {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, "0");
  return {
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
    title,
    selection,
    uuid: crypto.randomUUID(),
    user,
  };
}
