import { describe, expect, it } from "vitest";
import { slugify } from "../../lib/seed/slugify";

describe("slugify", () => {
  it("lowercases and joins words with underscores so the seed scripts and the backfill agree on the same curated id", () => {
    expect(slugify("Pad See Ew")).toBe("pad_see_ew");
  });

  it("treats accented letters as separators the same as spaces, keeping curated ids ASCII only", () => {
    expect(slugify("Crème Brûlée")).toBe("cr_me_br_l_e");
  });

  it("trims a leading and trailing separator instead of leaving a stray underscore at either end", () => {
    expect(slugify("  Leading and Trailing  ")).toBe("leading_and_trailing");
  });

  it("collapses repeated separators into a single underscore instead of one per character", () => {
    expect(slugify("Double--Hyphen")).toBe("double_hyphen");
  });
});
