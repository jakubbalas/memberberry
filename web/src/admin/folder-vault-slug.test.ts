import { afterEach, expect, test, vi } from "vitest";
import fc from "fast-check";
import { composeVaultSlug, generateVaultSlug } from "./folder-vault-slug.js";
afterEach(()=>vi.restoreAllMocks());
const grammar=/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
test("generated slugs obey grammar and length for arbitrary Unicode, punctuation, blank and long labels (seed 1004)",()=>{
 const unicode=fc.array(fc.integer({min:0,max:0x10ffff}).filter(n=>n<0xd800||n>0xdfff),{maxLength:400}).map(ns=>ns.map(n=>String.fromCodePoint(n)).join(""));
 const labels=fc.oneof(unicode,fc.string({maxLength:1000}),fc.constantFrom("","  ","!!!","日本","📚","e\u0301","école","a".repeat(2000)));
 fc.assert(fc.property(labels,fc.uint8Array({minLength:6,maxLength:6}),(label,bytes)=>{
  const original=new TextEncoder().encode(label),suffix=[...bytes].map(b=>b.toString(16).padStart(2,"0")).join("");const result=composeVaultSlug(label,suffix);
  expect(result).toMatch(grammar);expect(result.length).toBeLessThanOrEqual(64);expect(result.endsWith(`-${suffix}`)).toBe(true);expect(composeVaultSlug(label,suffix)).toBe(result);expect(new TextEncoder().encode(label)).toEqual(original);
 }),{seed:1004,numRuns:400});
});
test("only generated bases normalize diacritics; non-ASCII and punctuation-only labels use vault",()=>{
 for(const label of ["日本","📚","!!!"," "])expect(composeVaultSlug(label,"010203040506")).toBe("vault-010203040506");
 expect(composeVaultSlug(" École 日本 ","010203040506")).toBe("ecole-010203040506");expect(composeVaultSlug("a".repeat(200),"010203040506")).toHaveLength(64);
});
test("secure generation asks for independent six-byte entropy each time and never uses Math.random",()=>{
 // Platform entropy is the external boundary. The pure composition itself is not mocked.
 const entropy=vi.spyOn(crypto,"getRandomValues");entropy.mockImplementationOnce(array=>{if(!(array instanceof Uint8Array))throw new Error("buffer");array.set([1,2,3,4,5,6]);return array;});entropy.mockImplementationOnce(array=>{if(!(array instanceof Uint8Array))throw new Error("buffer");array.set([6,5,4,3,2,1]);return array;});
 const insecure=vi.spyOn(Math,"random");expect(generateVaultSlug("Label")).toBe("label-010203040506");expect(generateVaultSlug("Label")).toBe("label-060504030201");expect(entropy).toHaveBeenCalledTimes(2);expect(insecure).not.toHaveBeenCalled();
});
test("secure generation fails closed if entropy is unavailable rather than inventing a suffix",()=>{vi.spyOn(crypto,"getRandomValues").mockImplementation(()=>{throw new Error("unavailable");});expect(()=>generateVaultSlug("Label")).toThrow("unavailable");});
test("composition refuses malformed supplied suffixes instead of repairing them",()=>{for(const suffix of ["","ABCDEF123456","a".repeat(11),"a".repeat(13),"../../path"])expect(()=>composeVaultSlug("Label",suffix)).toThrow();});
