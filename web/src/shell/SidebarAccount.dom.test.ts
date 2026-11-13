// @vitest-environment jsdom

/**
 * The account footer (§7.6.8): in the desktop app there is no one to log out — the app signs
 * its window straight back in — so the footer offers the app's server page instead.
 */

import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it } from "vitest";

import Sidebar from "./Sidebar.svelte";

let app: ReturnType<typeof mount> | undefined;
afterEach(() => {
  if (app !== undefined) void unmount(app);
  app = undefined;
  document.body.innerHTML = "";
});

async function footer(desktop: boolean | undefined): Promise<HTMLAnchorElement | null> {
  const target = document.createElement("div");
  document.body.append(target);
  app = mount(Sidebar, {
    target,
    props: { side: "left", label: "Navigation", collapsed: false, user: "jo", ...(desktop === undefined ? {} : { desktop }) },
  });
  await tick();
  return target.querySelector<HTMLAnchorElement>(".account-logout");
}

describe("the account footer", () => {
  it("offers log out in a browser", async () => {
    const link = await footer(undefined);
    expect([link?.textContent, link?.getAttribute("href")]).toEqual(["Log out", "/logout"]);
  });

  it("offers the server page, not log out, in the desktop app", async () => {
    const link = await footer(true);
    expect([link?.textContent, link?.getAttribute("href")]).toEqual(["Servers", "/desktop/connect"]);
  });
});
