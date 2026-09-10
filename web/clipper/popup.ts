import { createClipTransport } from "../src/clipper/transport.js";

interface BrowserTab { readonly id?: number; }
interface BrowserApi {
  tabs: { query(query: { active: boolean; currentWindow: boolean }): Promise<BrowserTab[]>; sendMessage(tabId: number, message: { mode: string }): Promise<{ url: string; html: string; title?: string; author?: string }> };
  storage?: { local: {
    get(keys: string[]): Promise<Record<string, unknown>>;
    set(values: Record<string, string>): Promise<void>;
  } };
}

const api = (globalThis as typeof globalThis & { chrome?: BrowserApi; browser?: BrowserApi }).browser
  ?? (globalThis as typeof globalThis & { chrome?: BrowserApi }).chrome;
const byId = (id: string): HTMLElement => {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`missing clipper control: ${id}`);
  return element;
};

async function clip(): Promise<void> {
  const status = byId("status");
  if (api === undefined) { status.textContent = "Browser extension APIs are unavailable."; return; }
  const vault = (byId("vault") as HTMLInputElement).value.trim();
  const server = (byId("server") as HTMLInputElement).value.trim().replace(/\/$/, "");
  const token = (byId("token") as HTMLInputElement).value.trim();
  const folder = (byId("folder") as HTMLInputElement).value.trim();
  const tags = (byId("tags") as HTMLInputElement).value.split(",").map((tag) => tag.trim()).filter(Boolean);
  const template = (byId("template") as HTMLInputElement).value.trim();
  const mode = (byId("mode") as HTMLSelectElement).value as "full" | "selection" | "article";
  if (vault === "") { status.textContent = "Choose a vault."; return; }
  try {
    await api.storage?.local.set({ server, vault, token, folder, tags: tags.join(", "), template, mode });
    const tab = (await api.tabs.query({ active: true, currentWindow: true }))[0];
    if (tab?.id === undefined) { status.textContent = "No active page."; return; }
    const captured = await api.tabs.sendMessage(tab.id, { mode });
    const transport = createClipTransport({ vault, ...(server === "" ? {} : { baseUrl: server }), ...(token === "" ? {} : { token }) });
    const result = await transport.clip({ ...captured, folder, tags, ...(template === "" ? {} : { template }) });
    status.textContent = result.state === "queued" ? "Saved offline; will retry automatically." : `Clipped to ${result.clip.path}`;
  } catch {
    status.textContent = "Clip refused or unavailable.";
  }
}

byId("clip").addEventListener("click", () => { void clip(); });

async function restore(): Promise<void> {
  if (api?.storage === undefined) return;
  const values = await api.storage.local.get(["server", "vault", "token", "folder", "tags", "template", "mode"]);
  for (const id of ["server", "vault", "token", "folder", "tags", "template", "mode"]) {
    const value = values[id];
    if (typeof value === "string") (byId(id) as HTMLInputElement | HTMLSelectElement).value = value;
  }
}

void restore().catch(() => undefined);
