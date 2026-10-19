import { defineConfig } from "@playwright/test";
import base from "./playwright.config.js";

// why: the standalone headless shell crashed before newContext on this host. Exercise the
// full installed Chromium engine with an isolated fixture, without retries or exclusions.
export default defineConfig({ ...base, use: { ...base.use, channel: "chromium" } });
