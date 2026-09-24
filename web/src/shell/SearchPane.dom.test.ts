// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { expect, it } from "vitest";

import SearchPane from "./SearchPane.svelte";
import { SearchView } from "./search.svelte.js";

it("renders every matching block when successive queries return repeated note paths", async () => {
  const target = document.createElement("div");
  document.body.append(target);
  const hits = [
    { path: "Linux.md", title: "Linux", context: "Install fedora" },
    { path: "Linux.md", title: "Linux", context: "Update fedora" },
    { path: "Linux.md", title: "Linux", context: "Update fedora" },
    { path: "Other.md", title: null, context: "Try fedora" },
  ];
  const view = new SearchView({
    vault: "personal",
    request: async (url) => new Response(JSON.stringify({
      hits: String(url).includes("q=fe&") ? hits.slice(0, 1) : hits,
    })),
  });
  const opened: string[] = [];
  const component = mount(SearchPane, { target, props: { view, onopen: (path: string) => opened.push(path) } });
  try {
    await view.search("fe");
    await tick();
    expect(target.querySelectorAll(".search-result")).toHaveLength(1);
    await view.search("fed");
    await tick();
    expect([...target.querySelectorAll(".search-context")].map((node) => node.textContent))
      .toEqual(hits.map((hit) => hit.context));
    target.querySelectorAll<HTMLButtonElement>(".search-result").forEach((button) => button.click());
    expect(opened).toEqual(hits.map((hit) => hit.path));
    await view.search("fe");
    await tick();
    expect(target.querySelectorAll(".search-result")).toHaveLength(1);
  } finally {
    await unmount(component);
    target.remove();
  }
});
