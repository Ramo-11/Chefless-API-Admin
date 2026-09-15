import { describe, it, expect, vi, afterEach } from "vitest";
import {
  detectSource,
  extractCaption,
  extractFromUrl,
  isAllowedImportUrl,
} from "../../services/recipe-import-service";

function mockFetchHtml(html: string, finalUrl: string): void {
  vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: true,
    status: 200,
    url: finalUrl,
    text: async () => html,
  } as Response);
}

describe("recipe-import-service", () => {
  describe("detectSource", () => {
    it("maps Instagram hosts", () => {
      expect(detectSource("https://www.instagram.com/reel/abc123/")).toEqual({
        type: "instagram",
        url: "https://www.instagram.com/reel/abc123/",
        siteName: "Instagram",
      });
    });

    it("maps TikTok hosts", () => {
      expect(detectSource("https://www.tiktok.com/@chef/video/9").type).toBe(
        "tiktok"
      );
    });

    it("maps both YouTube hosts", () => {
      expect(detectSource("https://youtube.com/watch?v=x").type).toBe("youtube");
      expect(detectSource("https://youtu.be/x").type).toBe("youtube");
    });

    it("maps Pinterest hosts including country TLDs", () => {
      expect(detectSource("https://pinterest.com/pin/1").type).toBe("pinterest");
      expect(detectSource("https://pinterest.co.uk/pin/1").type).toBe(
        "pinterest"
      );
    });

    it("maps Facebook hosts", () => {
      expect(detectSource("https://www.facebook.com/watch/?v=1").type).toBe(
        "facebook"
      );
      expect(detectSource("https://fb.watch/abc/").type).toBe("facebook");
    });

    it("falls back to website with the hostname as siteName", () => {
      expect(detectSource("https://www.allrecipes.com/recipe/123")).toEqual({
        type: "website",
        url: "https://www.allrecipes.com/recipe/123",
        siteName: "allrecipes.com",
      });
    });

    it("returns other for an unparseable URL", () => {
      expect(detectSource("not a url").type).toBe("other");
    });
  });

  describe("extractCaption", () => {
    const igSource = {
      type: "instagram" as const,
      url: "https://www.instagram.com/reel/abc/",
      siteName: "Instagram",
    };

    it("unwraps an Instagram og:description and captures the handle", () => {
      const html = `<html><head>
        <meta property="og:title" content="chef.jane on Instagram">
        <meta property="og:description" content="1,234 likes, 56 comments - chef.jane on May 1, 2026: &quot;One-pan lemon garlic pasta. Boil 200g spaghetti, toss with garlic, lemon, and parmesan. So good!&quot;">
      </head></html>`;

      const result = extractCaption(html, igSource);
      expect(result).not.toBeNull();
      expect(result?.text.startsWith("One-pan lemon garlic pasta")).toBe(true);
      expect(result?.text.includes('"')).toBe(false);
      expect(result?.author).toBe("@chef.jane");
    });

    it("reads a generic page og:description", () => {
      const html = `<html><head>
        <meta property="og:description" content="A cozy weeknight stew with beef, carrots, and potatoes simmered slowly.">
      </head></html>`;

      const result = extractCaption(html, {
        type: "website",
        url: "https://example.com/post",
        siteName: "example.com",
      });
      expect(result?.text).toContain("cozy weeknight stew");
      expect(result?.author).toBeUndefined();
    });

    it("falls back to twitter:description then meta name=description", () => {
      const twitterHtml = `<meta name="twitter:description" content="Smoky chipotle black bean tacos with lime crema on top.">`;
      expect(
        extractCaption(twitterHtml, {
          type: "website",
          url: "https://x.test/a",
        })?.text
      ).toContain("chipotle black bean tacos");

      const descHtml = `<meta name="description" content="Crispy roasted brussels sprouts tossed in balsamic glaze.">`;
      expect(
        extractCaption(descHtml, { type: "website", url: "https://x.test/b" })
          ?.text
      ).toContain("brussels sprouts");
    });

    it("returns null when there is no usable caption", () => {
      expect(
        extractCaption("<html><head></head></html>", {
          type: "website",
          url: "https://x.test/c",
        })
      ).toBeNull();
    });

    it("returns null for a caption shorter than the minimum", () => {
      const html = `<meta property="og:description" content="Yum!">`;
      expect(extractCaption(html, igSource)).toBeNull();
    });

    it("reads content placed before the property attribute", () => {
      const html = `<meta content="Slow braised lamb shoulder with apricots and cumin." property="og:description">`;
      expect(
        extractCaption(html, { type: "website", url: "https://x.test/d" })?.text
      ).toBe("Slow braised lamb shoulder with apricots and cumin.");
    });

    it("keeps apostrophes inside double quoted content and reads single quoted attributes", () => {
      const doubleQuoted = `<meta property="og:description" content="Grandma's lemon cake with a crackly sugar top.">`;
      expect(
        extractCaption(doubleQuoted, { type: "website", url: "https://x.test/e" })?.text
      ).toBe("Grandma's lemon cake with a crackly sugar top.");

      const singleQuoted = `<meta name='description' content='Charred corn salad with feta and lime.'>`;
      expect(
        extractCaption(singleQuoted, { type: "website", url: "https://x.test/f" })?.text
      ).toBe("Charred corn salad with feta and lime.");
    });

    it("skips a meta tag whose content is blank and uses the next matching tag", () => {
      const html = `<meta property="og:description" content="   "><meta name="description" content="Toasted sesame noodles with scallions and chili oil.">`;
      expect(
        extractCaption(html, { type: "website", url: "https://x.test/g" })?.text
      ).toBe("Toasted sesame noodles with scallions and chili oil.");
    });

    it("does not treat a data attribute that ends in property as the key", () => {
      const html = `<meta data-property="og:description" content="This should never be read as a caption text.">`;
      expect(
        extractCaption(html, { type: "website", url: "https://x.test/h" })
      ).toBeNull();
    });

    it("returns quickly for a large quote heavy page without any caption so one import cannot stall the server", () => {
      const filler = Array.from(
        { length: 6000 },
        (_, index) => `<meta content="value ${index}" data-a='x'><div class="c" title='t'>"quoted" 'text'</div>`
      ).join("");
      const html = `<html><head>${filler}</head><body>${filler}</body></html>`;
      expect(html.length).toBeGreaterThan(600_000);

      const startedAt = Date.now();
      expect(extractCaption(html, igSource)).toBeNull();
      expect(Date.now() - startedAt).toBeLessThan(1000);
    });
  });

  describe("extractFromUrl", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("returns INVALID_URL for an SSRF-blocked host", async () => {
      const result = await extractFromUrl("http://127.0.0.1/admin");
      expect(result).toEqual({ kind: "error", code: "INVALID_URL" });
    });

    it("returns INVALID_URL for a loopback address written as an IPv4 mapped IPv6 literal", async () => {
      const result = await extractFromUrl("http://[::ffff:7f00:1]:3102/admin");
      expect(result).toEqual({ kind: "error", code: "INVALID_URL" });
    });

    it("returns INVALID_URL for a malformed URL", async () => {
      const result = await extractFromUrl("ftp://example.com/file");
      expect(result).toEqual({ kind: "error", code: "INVALID_URL" });
    });

    it("returns a structured result from JSON-LD Recipe markup", async () => {
      const html = `<html><head>
        <script type="application/ld+json">
        {
          "@context": "https://schema.org",
          "@type": "Recipe",
          "name": "Garlic Butter Shrimp",
          "recipeIngredient": ["2 tbsp butter", "1 lb shrimp"],
          "recipeInstructions": [
            { "@type": "HowToStep", "text": "Melt butter." },
            { "@type": "HowToStep", "text": "Add shrimp and cook." }
          ]
        }
        </script>
      </head></html>`;
      const url = "https://www.seriouseats.com/garlic-butter-shrimp";
      mockFetchHtml(html, url);

      const result = await extractFromUrl(url);
      expect(result.kind).toBe("structured");
      if (result.kind === "structured") {
        expect(result.recipe.title).toBe("Garlic Butter Shrimp");
        expect(result.recipe.ingredients).toHaveLength(2);
        expect(result.recipe.steps).toHaveLength(2);
        expect(result.source.type).toBe("website");
      }
    });

    it("returns a caption result when no JSON-LD but a caption exists", async () => {
      const html = `<html><head>
        <meta property="og:title" content="chef.jane on Instagram">
        <meta property="og:description" content="200 likes, 10 comments - chef.jane on May 2, 2026: &quot;Quick weeknight stir fry with broccoli, soy sauce, and ginger over rice.&quot;">
      </head></html>`;
      const url = "https://www.instagram.com/reel/abc123/";
      mockFetchHtml(html, url);

      const result = await extractFromUrl(url);
      expect(result.kind).toBe("caption");
      if (result.kind === "caption") {
        expect(result.text).toContain("stir fry");
        expect(result.source.type).toBe("instagram");
        expect(result.source.author).toBe("@chef.jane");
      }
    });

    it("returns NO_CAPTION when the page has no recipe and no caption", async () => {
      const url = "https://example.com/empty";
      mockFetchHtml("<html><head></head><body></body></html>", url);

      const result = await extractFromUrl(url);
      expect(result).toEqual({ kind: "error", code: "NO_CAPTION" });
    });
  });

  describe("isAllowedImportUrl", () => {
    it("is true for a public https URL", () => {
      expect(isAllowedImportUrl("https://www.allrecipes.com/recipe/123")).toBe(true);
    });

    it("is false for a private class C address", () => {
      expect(isAllowedImportUrl("http://192.168.1.1/x")).toBe(false);
    });

    it("is false for IPv4 loopback", () => {
      expect(isAllowedImportUrl("http://127.0.0.1/x")).toBe(false);
    });

    it("is false for link-local addresses including cloud metadata", () => {
      expect(isAllowedImportUrl("http://169.254.169.254/latest/meta-data")).toBe(false);
    });

    it("is false for IPv6 loopback", () => {
      expect(isAllowedImportUrl("http://[::1]/x")).toBe(false);
    });

    it("is false for a non http scheme", () => {
      expect(isAllowedImportUrl("ftp://example.com/file")).toBe(false);
    });

    it("is false for garbage input", () => {
      expect(isAllowedImportUrl("definitely not a url")).toBe(false);
    });

    it("is true for public domains whose names only look like private address prefixes", () => {
      expect(isAllowedImportUrl("https://fc2.com/recipe")).toBe(true);
      expect(isAllowedImportUrl("https://fcbarcelona.com/recipe")).toBe(true);
      expect(isAllowedImportUrl("https://fdgroup.com/recipe")).toBe(true);
      expect(isAllowedImportUrl("https://10.wiki/page")).toBe(true);
      expect(isAllowedImportUrl("https://127.example.com/page")).toBe(true);
    });

    it("is still false for private IPv6 literals and localhost names", () => {
      expect(isAllowedImportUrl("http://[fd00::1]/x")).toBe(false);
      expect(isAllowedImportUrl("http://[fe80::1]/x")).toBe(false);
      expect(isAllowedImportUrl("http://[::ffff:10.0.0.1]/x")).toBe(false);
      expect(isAllowedImportUrl("http://[::ffff:7f00:1]/x")).toBe(false);
      expect(isAllowedImportUrl("http://[::ffff:a9fe:a9fe]/latest/meta-data")).toBe(false);
      expect(isAllowedImportUrl("http://[::ffff:808:808]/x")).toBe(true);
      expect(isAllowedImportUrl("http://2130706433/x")).toBe(false);
      expect(isAllowedImportUrl("http://app.localhost/x")).toBe(false);
    });
  });
});
