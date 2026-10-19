import { defineConfig } from "@playwright/test";
import process from "node:process";
// Standalone disposable servers per test; no shared webServer inheritance or reuse.
export default defineConfig({
  testDir: "./e2e", retries: 0, fullyParallel: false, workers: 1,
  reporter: [["list"], ["json", {outputFile: process.env["FOLDER_REPORT"] ?? "../local/t-006-ui/browser-reporter.json"}]],
  outputDir: process.env["FOLDER_OUTPUT"] ?? "../local/t-006-ui/browser-artifacts",
  use: { trace: "retain-on-failure", screenshot: "only-on-failure", launchOptions: {executablePath: "/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome"} },
  projects: [
    { name: "desktop", use: { viewport: { width: 1280, height: 800 } } },
    { name: "mobile", use: { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true } },
  ],
});
