import { defineConfig } from "vite";

// AGENTS.md §5.1 reserves 9011 for the frontend when it runs separately from the server on
// 9010. `strictPort` so a clash fails loudly instead of silently moving — a moved port is a
// confusing five minutes when the server's links stop matching.
export default defineConfig({
  server: { port: 9011, strictPort: true },
  preview: { port: 9011, strictPort: true },
  test: {
    environment: "node",
    // why: `e2e/` holds Playwright specs. Vitest's default glob would collect them, and they
    // fail confusingly out of a Playwright runner rather than reporting they were misrun.
    exclude: ["node_modules/**", "dist/**", "e2e/**"],
    coverage: { provider: "v8", reporter: ["text", "json-summary"], include: ["src/**/*.ts"], // `main.ts` is the entry shim that wires the DOM to the modules below it, the same
      // role `mb-cli/src/main.rs` plays; `src/wasm` is generated.
      exclude: ["src/wasm/**", "src/main.ts"] },
  },
});
