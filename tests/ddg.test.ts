import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDDGHtml, unwrapDDGUrl } from "../src/ddg";

const FIX = (n: string) =>
  readFileSync(join(import.meta.dir, "fixtures", n), "utf8");

describe("unwrapDDGUrl", () => {
  test("decodes uddg redirect links", () => {
    expect(
      unwrapDDGUrl("//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=x")
    ).toBe("https://example.com/a");
  });
  test("preserves query params in the decoded url", () => {
    expect(
      unwrapDDGUrl(
        "//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage%3Fx%3D1%26y%3D2&rut=qwe"
      )
    ).toBe("https://example.com/page?x=1&y=2");
  });
  test("passes direct links through", () => {
    expect(unwrapDDGUrl("https://en.wikipedia.org/wiki/X")).toBe(
      "https://en.wikipedia.org/wiki/X"
    );
  });
});

describe("parseDDGHtml", () => {
  test("extracts results from a real-shaped fixture", () => {
    const r = parseDDGHtml(FIX("ddg-results.html"));
    expect(r.length).toBe(4);
    expect(r[0].url).toBe("https://bun.sh/");
    expect(r[0].title).toContain("Bun");
    expect(r[0].title).not.toContain("<");
    expect(r[0].snippet).toContain("all-in-one JavaScript runtime");
    // entity decoding
    expect(r[0].title).toContain("\u2014");
    expect(r[0].snippet).toContain("\u2013");
  });
  test("handles a result with no snippet", () => {
    const r = parseDDGHtml(FIX("ddg-results.html"));
    const wiki = r.find((x) => x.url.includes("wikipedia"));
    expect(wiki).toBeDefined();
    expect(wiki!.snippet).toBe("");
    expect(wiki!.title).toContain("Wikipedia");
  });
  test("respects maxResults", () => {
    expect(parseDDGHtml(FIX("ddg-results.html"), 2).length).toBe(2);
  });
  test("no-results page yields an empty list", () => {
    expect(parseDDGHtml(FIX("ddg-empty.html"))).toEqual([]);
  });
  test("ignores non-http(s) hrefs", () => {
    const r = parseDDGHtml(
      '<a class="result__a" href="javascript:void(0)">x</a>'
    );
    expect(r).toEqual([]);
  });
});
