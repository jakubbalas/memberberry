import { defineConfig } from "@playwright/test";
import base from "./playwright.config.js";
const server=base.webServer;
if(server===undefined || Array.isArray(server))throw new Error("Expected existing single disposable web server");
// why: preserve the onboarding fixtures/defaults, but never reuse a listener or write reports outside t-003.
export default defineConfig({...base,fullyParallel:false,workers:1,reporter:"list",outputDir:"../local/t-003-ui/browser-artifacts",webServer:{...server,reuseExistingServer:false}});
