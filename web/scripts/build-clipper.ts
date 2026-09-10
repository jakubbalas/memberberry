import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { build } from "vite";

const web = resolve(import.meta.dirname, "..");
const output = join(web, "dist-clipper");
const common = join(output, "common");
rmSync(output, { recursive: true, force: true });
mkdirSync(common, { recursive: true });
await build({
  root: web,
  configFile: false,
  publicDir: false,
  build: {
    outDir: common,
    emptyOutDir: false,
    rollupOptions: { input: { content: join(web, "clipper/content.ts"), popup: join(web, "clipper/popup.html") }, output: { entryFileNames: "[name].js", chunkFileNames: "chunks/[name].js" } },
  },
});
renameSync(join(common, "clipper/popup.html"), join(common, "popup.html"));
rmSync(join(common, "clipper"), { recursive: true, force: true });

for (const browser of ["chrome", "firefox"] as const) {
  const target = join(output, browser);
  cpSync(common, target, { recursive: true });
  copyFileSync(join(web, `clipper/manifest.${browser}.json`), join(target, "manifest.json"));
  const manifest = JSON.parse(readFileSync(join(target, "manifest.json"), "utf8")) as { action?: { default_popup?: string }; browser_action?: { default_popup?: string } };
  const popup = manifest.action?.default_popup ?? manifest.browser_action?.default_popup;
  for (const required of ["manifest.json", "content.js", "popup.js", popup]) {
    if (required === undefined || !existsSync(join(target, required))) {
      throw new Error(`${browser} clipper package is missing ${required ?? "its popup declaration"}`);
    }
  }
}
rmSync(common, { recursive: true, force: true });
