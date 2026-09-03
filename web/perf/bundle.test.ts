/**
 * The bundle measurement, against a real directory on disk.
 *
 * Real files in a temp directory rather than a mocked filesystem: this module's whole job is
 * reading a build output and compressing it, and a mock of `node:fs` would test the mock
 * (AGENTS.md §2.3). The files are tiny, so it costs nothing.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { measureBundle } from "./bundle.js";

let dist = "";

beforeEach(() => {
  dist = mkdtempSync(join(tmpdir(), "mb-bundle-"));
});

afterEach(() => {
  rmSync(dist, { recursive: true, force: true });
});

/** Content that actually compresses, so a gzip figure is distinguishable from a raw one. */
function compressible(size: number): string {
  return "the quick brown fox ".repeat(Math.ceil(size / 20)).slice(0, size);
}

describe("measuring the critical-path bundle", () => {
  it("sums the gzipped size of every script and wasm module, recursively", () => {
    mkdirSync(join(dist, "assets"), { recursive: true });
    writeFileSync(join(dist, "assets", "index.js"), compressible(4_000));
    writeFileSync(join(dist, "assets", "mb_bg.wasm"), compressible(8_000));

    const measured = measureBundle(dist);

    expect(measured.assets.map((a) => a.name)).toEqual([
      "assets/mb_bg.wasm",
      "assets/index.js",
    ]);
    expect(measured.totalRaw).toBe(12_000);
    expect(measured.totalGzip).toBeLessThan(measured.totalRaw);
    expect(measured.totalGzip).toBe(
      measured.assets.reduce((sum, asset) => sum + asset.gzip, 0),
    );
  });

  it("compresses at level 9, the smallest an operator can serve", () => {
    // Pinned because the budget is stated in gzip: measuring at the zlib default would report
    // a larger number than the same build behind `gzip_comp_level 9`, and a budget that moves
    // with a compression setting nobody chose is not a budget.
    mkdirSync(join(dist, "assets"), { recursive: true });
    const body = compressible(20_000);
    writeFileSync(join(dist, "assets", "index.js"), body);

    expect(measureBundle(dist).totalGzip).toBe(
      gzipSync(Buffer.from(body), { level: 9 }).byteLength,
    );
  });

  it("ignores everything that is not JS or wasm", () => {
    // CSS, HTML, source maps and fonts are all real build output, and none of them is what
    // §21.2's "JS + WASM" row budgets.
    mkdirSync(join(dist, "assets"), { recursive: true });
    writeFileSync(join(dist, "assets", "index.js"), compressible(1_000));
    writeFileSync(join(dist, "assets", "app.css"), compressible(9_000));
    writeFileSync(join(dist, "index.html"), compressible(9_000));
    writeFileSync(join(dist, "assets", "index.js.map"), compressible(9_000));

    expect(measureBundle(dist).assets.map((a) => a.name)).toEqual(["assets/index.js"]);
  });

  it("excludes the lazy Excalidraw island, and says that it did", () => {
    // §21.2 excludes it by name. Nothing matches this yet — the point of the assertion is
    // that when M12 lands, the exclusion is a rule the harness already applies and reports
    // rather than a subtraction someone remembers to do by hand.
    mkdirSync(join(dist, "assets"), { recursive: true });
    writeFileSync(join(dist, "assets", "index.js"), compressible(1_000));
    writeFileSync(join(dist, "assets", "excalidraw-island.js"), compressible(90_000));

    const measured = measureBundle(dist);

    expect(measured.assets.map((a) => a.name)).toEqual(["assets/index.js"]);
    expect(measured.excluded).toEqual(["assets/excalidraw-island.js"]);
  });

  it("refuses a missing build rather than reporting a passing zero", () => {
    expect(() => measureBundle(join(dist, "nope"))).toThrow(/not a directory/);
  });

  it("refuses a directory with nothing to weigh", () => {
    writeFileSync(join(dist, "index.html"), "<!doctype html>");

    expect(() => measureBundle(dist)).toThrow(/no \.js or \.wasm/);
  });
});
