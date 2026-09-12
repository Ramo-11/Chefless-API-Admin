import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { CUISINE_REGIONS } from "../../lib/cuisines";

const DART_FILE_PATH = path.resolve(
  __dirname,
  "../../../../chefless-app/lib/utils/cuisine_data.dart"
);

interface ParsedRegion {
  id: string;
  name: string;
  cuisines: string[];
}

function parseDartCuisineRegions(source: string): ParsedRegion[] {
  const regionHeaderRegex = /CuisineRegion\('([^']+)',\s*'([^']+)',\s*\[/g;
  const headers: Array<{ id: string; name: string; blockStart: number }> = [];
  let headerMatch: RegExpExecArray | null;

  while ((headerMatch = regionHeaderRegex.exec(source)) !== null) {
    headers.push({
      id: headerMatch[1],
      name: headerMatch[2],
      blockStart: headerMatch.index + headerMatch[0].length,
    });
  }

  return headers.map((header, i) => {
    const blockEnd = i + 1 < headers.length ? headers[i + 1].blockStart : source.length;
    const block = source.slice(header.blockStart, blockEnd);
    const itemRegex = /CuisineItem\('([^']+)'/g;
    const cuisines: string[] = [];
    let itemMatch: RegExpExecArray | null;
    while ((itemMatch = itemRegex.exec(block)) !== null) {
      cuisines.push(itemMatch[1]);
    }
    return { id: header.id, name: header.name, cuisines };
  });
}

const dartFileExists = fs.existsSync(DART_FILE_PATH);

describe("cuisine data parity with the Flutter client", () => {
  if (!dartFileExists) {
    it.skip("mirrors chefless-app/lib/utils/cuisine_data.dart (skipped: file not found on disk)", () => {});
    return;
  }

  it("mirrors chefless-app/lib/utils/cuisine_data.dart region ids, names, and cuisines in order", () => {
    const source = fs.readFileSync(DART_FILE_PATH, "utf8");
    const dartRegions = parseDartCuisineRegions(source);

    expect(dartRegions.length).toBeGreaterThan(0);
    expect(CUISINE_REGIONS.map((r) => r.id)).toEqual(dartRegions.map((r) => r.id));
    expect(CUISINE_REGIONS.map((r) => r.name)).toEqual(dartRegions.map((r) => r.name));

    for (let i = 0; i < dartRegions.length; i += 1) {
      expect(CUISINE_REGIONS[i].cuisines).toEqual(dartRegions[i].cuisines);
    }
  });
});
