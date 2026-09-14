import { readFileSync } from "node:fs";
import { beforeAll, bench } from "vitest";
import { load, tagInputParser } from "../notes.js";

let parse: (text: string) => string | undefined;

beforeAll(async () => {
  await load(readFileSync("src/wasm/mb_bg.wasm"));
  parse = await tagInputParser();
});

bench("validate a completed nested tag through WASM", () => {
  parse("#project/memberberry");
});
