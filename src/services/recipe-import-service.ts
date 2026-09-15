/**
 * Recipe import service.
 *
 * Fetches a URL, extracts structured Recipe data from the page's JSON-LD
 * (schema.org/Recipe), and maps it to the Chefless recipe shape so the
 * client can pre-fill the creation form.
 *
 * No external packages needed — uses the Node 18+ built-in `fetch`.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ImportedIngredient {
  name: string;
  quantity: number;
  unit: string;
}

export interface ImportedStep {
  order: number;
  instruction: string;
}

export interface ImportedRecipe {
  title: string;
  description?: string;
  prepTime?: number; // minutes
  cookTime?: number; // minutes
  servings?: number;
  ingredients: ImportedIngredient[];
  steps: ImportedStep[];
  dietaryTags: string[];
  cuisineTags: string[];
  sourceUrl: string;
}

export type RecipeSourceType =
  | "website"
  | "instagram"
  | "tiktok"
  | "youtube"
  | "pinterest"
  | "facebook"
  | "other";

/** The provenance subset the client persists alongside an imported recipe. */
export interface RecipeSourceInfo {
  type: RecipeSourceType;
  url: string;
  siteName?: string;
  author?: string;
}

export type ImportErrorCode =
  | "INVALID_URL"
  | "UNREACHABLE"
  | "PRIVATE_OR_BLOCKED"
  | "NO_CAPTION"
  | "NO_RECIPE_FOUND"
  | "TIMEOUT";

/**
 * Outcome of fetching + parsing an import URL.
 * - `structured`: the page exposed schema.org/Recipe JSON-LD (free path).
 * - `caption`: no structured recipe, but a usable caption was extracted and
 *   should be handed to the AI extractor (gated path).
 * - `error`: nothing usable; carries a code the route maps to an HTTP status.
 */
export type ImportExtractionResult =
  | { kind: "structured"; recipe: ImportedRecipe; source: RecipeSourceInfo }
  | { kind: "caption"; text: string; source: RecipeSourceInfo }
  | { kind: "error"; code: ImportErrorCode };

// ---------------------------------------------------------------------------
// Main export — stepwise extractor
// ---------------------------------------------------------------------------

/**
 * Fetches [url] and decides how the recipe can be imported:
 *   1. validate (SSRF guard) -> INVALID_URL on failure
 *   2. fetch (10s timeout) -> TIMEOUT / PRIVATE_OR_BLOCKED / UNREACHABLE
 *   3. schema.org/Recipe JSON-LD -> structured (free)
 *   4. else caption (og/twitter/meta description) -> caption (AI path)
 *   5. else NO_CAPTION
 * Never throws; all failure paths return `{ kind: "error", code }`.
 */
export async function extractFromUrl(
  url: string
): Promise<ImportExtractionResult> {
  try {
    validateUrl(url);
  } catch {
    return { kind: "error", code: "INVALID_URL" };
  }

  let html: string;
  try {
    // Redirects are followed manually so EVERY hop passes the SSRF guard.
    // Automatic following would let a public page 302 to an internal address
    // (cloud metadata, 10.x, localhost) and have Node fetch it before any
    // post-hoc check could run.
    const signal = AbortSignal.timeout(10_000); // one 10s deadline, all hops
    let currentUrl = url;
    let response: Response | undefined;

    for (let hop = 0; hop <= MAX_IMPORT_REDIRECTS; hop++) {
      if (hop > 0) {
        try {
          validateUrl(currentUrl);
        } catch {
          return { kind: "error", code: "PRIVATE_OR_BLOCKED" };
        }
      }
      // validateUrl only string-matches the hostname; a public name can still
      // resolve to a private address. Check what DNS actually returns.
      const resolution = await checkResolvedAddresses(currentUrl);
      if (resolution === "blocked") {
        return { kind: "error", code: "PRIVATE_OR_BLOCKED" };
      }
      if (resolution === "unreachable") {
        return { kind: "error", code: "UNREACHABLE" };
      }

      response = await fetch(currentUrl, {
        headers: {
          // Polite user-agent — some sites block empty UA strings.
          "User-Agent":
            "Mozilla/5.0 (compatible; Chefless/1.0; +https://chefless.app)",
          Accept: "text/html,application/xhtml+xml",
        },
        redirect: "manual",
        signal,
      });

      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get("location");
        if (!location) {
          return { kind: "error", code: "UNREACHABLE" };
        }
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
      break;
    }

    if (!response || REDIRECT_STATUSES.has(response.status)) {
      // Redirect chain never settled within the hop budget.
      return { kind: "error", code: "UNREACHABLE" };
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return { kind: "error", code: "PRIVATE_OR_BLOCKED" };
      }
      return { kind: "error", code: "UNREACHABLE" };
    }

    // A redirect to a login wall presents as a 2xx on the auth host.
    if (isLoginWallUrl(currentUrl)) {
      return { kind: "error", code: "PRIVATE_OR_BLOCKED" };
    }

    html = await response.text();
  } catch (err: unknown) {
    if (isTimeoutError(err)) {
      return { kind: "error", code: "TIMEOUT" };
    }
    return { kind: "error", code: "UNREACHABLE" };
  }

  const source = detectSource(url);
  if (source.type === "website" && !source.siteName) {
    const ogSiteName = extractMetaContent(html, "og:site_name");
    if (ogSiteName) source.siteName = ogSiteName.slice(0, 100);
  }

  const schema = extractRecipeSchema(html);
  if (schema) {
    return { kind: "structured", recipe: mapSchemaToRecipe(schema, url), source };
  }

  const caption = extractCaption(html, source);
  if (caption) {
    return {
      kind: "caption",
      text: caption.text,
      source: caption.author ? { ...source, author: caption.author } : source,
    };
  }

  return { kind: "error", code: "NO_CAPTION" };
}

function isTimeoutError(err: unknown): boolean {
  if (err instanceof Error) {
    return err.name === "AbortError" || err.name === "TimeoutError";
  }
  return false;
}

function isLoginWallUrl(finalUrl: string): boolean {
  try {
    const u = new URL(finalUrl);
    const path = u.pathname.toLowerCase();
    return (
      path.startsWith("/accounts/login") ||
      path.startsWith("/login") ||
      path === "/accounts/login/"
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Source detection
// ---------------------------------------------------------------------------

/**
 * Maps a URL's hostname to a {@link RecipeSourceInfo}. Known social hosts get
 * a fixed type + display name; everything else is `website` (the caller fills
 * `siteName` from og:site_name, falling back to the hostname).
 */
export function detectSource(url: string): RecipeSourceInfo {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return { type: "other", url };
  }

  const matches = (domain: string): boolean =>
    host === domain || host.endsWith(`.${domain}`);

  if (matches("instagram.com")) {
    return { type: "instagram", url, siteName: "Instagram" };
  }
  if (matches("tiktok.com")) {
    return { type: "tiktok", url, siteName: "TikTok" };
  }
  if (matches("youtube.com") || matches("youtu.be")) {
    return { type: "youtube", url, siteName: "YouTube" };
  }
  if (host === "pinterest.com" || host.startsWith("pinterest.")) {
    return { type: "pinterest", url, siteName: "Pinterest" };
  }
  if (matches("facebook.com") || matches("fb.watch")) {
    return { type: "facebook", url, siteName: "Facebook" };
  }

  return { type: "website", url, siteName: host || undefined };
}

// ---------------------------------------------------------------------------
// Caption extraction
// ---------------------------------------------------------------------------

/**
 * Pulls a usable caption from page metadata when there is no JSON-LD recipe.
 * Tries og:description, then twitter:description, then <meta name=description>.
 * For Instagram, og:description carries an engagement/username prefix and the
 * real caption wrapped in quotes (e.g.
 * `123 likes, 45 comments - chef.jane on May 1, 2026: "Best pasta..."`) — this
 * strips the prefix and unwraps the quote, capturing the handle as `author`.
 * Returns null when nothing meaningful (>= 15 chars) survives.
 */
export function extractCaption(
  html: string,
  source: RecipeSourceInfo
): { text: string; author?: string } | null {
  const raw =
    extractMetaContent(html, "og:description") ??
    extractMetaContent(html, "twitter:description") ??
    extractMetaNameContent(html, "twitter:description") ??
    extractMetaNameContent(html, "description");

  if (!raw) return null;

  let text = decodeHtmlEntities(raw).trim();
  let author: string | undefined;

  if (source.type === "instagram") {
    const parsed = parseInstagramDescription(text);
    text = parsed.text;
    author = parsed.author;
  }

  if (!author) {
    const ogTitle = extractMetaContent(html, "og:title");
    if (ogTitle) {
      const handle = extractHandle(decodeHtmlEntities(ogTitle));
      if (handle) author = handle;
    }
  }

  text = text.trim();
  if (text.length < 15) return null;

  return author ? { text: text.slice(0, 12000), author } : { text: text.slice(0, 12000) };
}

/**
 * Splits an Instagram og:description into the engagement/username prefix and
 * the quoted caption. Falls back to the whole string when the shape differs.
 */
function parseInstagramDescription(description: string): {
  text: string;
  author?: string;
} {
  let author: string | undefined;

  // Prefix shape: "<N> likes, <M> comments - <handle> on <date>: ..."
  const prefixMatch = description.match(
    /^[\d,.\sKkMm]*likes?,[^-]*-\s*([^:]+?)\s+on\s+[^:]*:\s*([\s\S]*)$/i
  );
  if (prefixMatch) {
    author = extractHandle(prefixMatch[1]) ?? toHandle(prefixMatch[1]);
    const body = prefixMatch[2].trim();
    return { text: unwrapQuoted(body), author };
  }

  // Simpler shape: "<handle> on <date>: ..." (no engagement counts).
  const handleMatch = description.match(/^([^:]+?)\s+on\s+[^:]*:\s*([\s\S]*)$/i);
  if (handleMatch) {
    author = extractHandle(handleMatch[1]) ?? toHandle(handleMatch[1]);
    const body = handleMatch[2].trim();
    return { text: unwrapQuoted(body), author };
  }

  return { text: unwrapQuoted(description), author };
}

/** Strips a single surrounding pair of straight or curly double quotes. */
function unwrapQuoted(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^["“]([\s\S]*)["”]$/);
  if (match) return match[1].trim();
  return trimmed;
}

/** Pulls an `@handle` or a bare username token out of a label string. */
function extractHandle(label: string): string | undefined {
  const at = label.match(/@([A-Za-z0-9._]+)/);
  if (at) return `@${at[1]}`;
  const paren = label.match(/\(@([A-Za-z0-9._]+)\)/);
  if (paren) return `@${paren[1]}`;
  return undefined;
}

/** Normalizes a bare username label into an `@handle`, or undefined if empty. */
function toHandle(label: string): string | undefined {
  const trimmed = label.trim();
  if (!trimmed) return undefined;
  return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
}

const META_TAG_PATTERN = /<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
const META_ATTRIBUTE_PATTERN = /([^\s"'=<>/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;

function readMetaContent(
  html: string,
  keyAttribute: "property" | "name",
  key: string
): string | undefined {
  const wanted = key.toLowerCase();
  for (const tag of html.matchAll(META_TAG_PATTERN)) {
    let matchesKey = false;
    let content: string | undefined;
    for (const attribute of tag[0].matchAll(META_ATTRIBUTE_PATTERN)) {
      const attributeName = attribute[1].toLowerCase();
      const value = attribute[2] ?? attribute[3] ?? attribute[4] ?? "";
      if (attributeName === keyAttribute && value.toLowerCase() === wanted) {
        matchesKey = true;
      } else if (attributeName === "content") {
        content = value;
      }
    }
    if (matchesKey && content !== undefined && content.trim()) return content;
  }
  return undefined;
}

/** Reads `<meta property="og:..." content="...">` (either attribute order). */
function extractMetaContent(html: string, property: string): string | undefined {
  return readMetaContent(html, "property", property);
}

/** Reads `<meta name="description" content="...">` (either attribute order). */
function extractMetaNameContent(
  html: string,
  name: string
): string | undefined {
  return readMetaContent(html, "name", name);
}

const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&#x27;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

/** Decodes the small set of HTML entities that show up in meta content. */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, dec: string) =>
      String.fromCodePoint(Number.parseInt(dec, 10))
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16))
    )
    .replace(/&[a-z]+;/gi, (entity) => HTML_ENTITIES[entity.toLowerCase()] ?? entity);
}

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

/** Redirect statuses that carry a Location header worth following. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Hop budget for manually followed redirects (initial request + 5 hops). */
const MAX_IMPORT_REDIRECTS = 5;

export function isAllowedImportUrl(url: string): boolean {
  try {
    validateUrl(url);
    return true;
  } catch {
    return false;
  }
}

function validateUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid URL format.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only HTTP and HTTPS URLs are supported.");
  }

  // Block private / loopback / link-local addresses to prevent SSRF.
  const hostname = parsed.hostname.toLowerCase();

  // Strip IPv6 brackets if present
  const host = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;

  if (isBlockedHost(host)) {
    throw new Error("That URL is not accessible.");
  }
}

function isBlockedHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (isIP(host) === 0) return false;
  return (
    // Loopback
    host === "localhost" ||
    host === "127.0.0.1" ||
    host.startsWith("127.") ||
    // Link-local (AWS metadata, Azure IMDS, GCP metadata)
    host.startsWith("169.254.") ||
    // Private class A
    host.startsWith("10.") ||
    // Private class B (172.16.0.0 – 172.31.255.255)
    isPrivateClassB(host) ||
    // Private class C
    host.startsWith("192.168.") ||
    // Multicast
    isMulticast(host) ||
    // Reserved
    isReserved(host) ||
    // Unspecified
    host === "0.0.0.0" ||
    // IPv6 loopback
    host === "::1" ||
    host === "0:0:0:0:0:0:0:1" ||
    // IPv4-mapped IPv6 loopback/private
    isIPv4MappedPrivate(host) ||
    // IPv6 link-local
    host.startsWith("fe80:") ||
    // IPv6 unique local
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    // IPv6 unspecified
    host === "::" ||
    host === "0:0:0:0:0:0:0:0"
  );
}

/**
 * Resolves the URL's hostname and confirms no returned address falls in a
 * blocked range. `validateUrl` only string-matches the hostname, so an
 * attacker-controlled DNS name pointing at 169.254.169.254 or 10.x would pass
 * it; this closes that hole. Literal IPs were already vetted by
 * `validateUrl`, so they pass straight through. A resolve-then-connect gap
 * (DNS rebinding) technically remains, but requires an attacker-run DNS
 * server with near-zero TTL and buys only what this pre-check already
 * restricts.
 */
async function checkResolvedAddresses(
  url: string
): Promise<"ok" | "blocked" | "unreachable"> {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return "blocked";
  }
  const host = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  if (isIP(host)) return "ok";

  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    return "unreachable";
  }
  return addresses.some((a) => isBlockedHost(a.address.toLowerCase()))
    ? "blocked"
    : "ok";
}

function isPrivateClassB(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const second = parseInt(parts[1], 10);
  return parts[0] === "172" && second >= 16 && second <= 31;
}

function isMulticast(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const first = parseInt(parts[0], 10);
  return first >= 224 && first <= 239;
}

function isReserved(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const first = parseInt(parts[0], 10);
  return first >= 240;
}

function isIPv4MappedPrivate(host: string): boolean {
  // Matches ::ffff:127.0.0.1, ::ffff:10.x.x.x, etc.
  const dotted = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  const hex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (!dotted && !hex) return false;
  const ipv4 = dotted
    ? dotted[1]
    : [
        parseInt(hex![1], 16) >> 8,
        parseInt(hex![1], 16) & 255,
        parseInt(hex![2], 16) >> 8,
        parseInt(hex![2], 16) & 255,
      ].join(".");
  return (
    ipv4.startsWith("127.") ||
    ipv4.startsWith("10.") ||
    ipv4.startsWith("192.168.") ||
    ipv4.startsWith("169.254.") ||
    ipv4 === "0.0.0.0" ||
    isPrivateClassB(ipv4) ||
    isMulticast(ipv4) ||
    isReserved(ipv4)
  );
}

// ---------------------------------------------------------------------------
// JSON-LD extraction
// ---------------------------------------------------------------------------

/**
 * Finds all <script type="application/ld+json"> blocks in [html], parses each
 * one, and returns the first object (or @graph item) whose @type is "Recipe".
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractRecipeSchema(html: string): Record<string, any> | null {
  const scriptRegex =
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

  let match: RegExpExecArray | null;
  while ((match = scriptRegex.exec(html)) !== null) {
    const raw = match[1].trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }

    const recipe = findRecipeInObject(parsed);
    if (recipe) return recipe;
  }

  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findRecipeInObject(obj: unknown): Record<string, any> | null {
  if (!obj || typeof obj !== "object") return null;

  // Direct @type: "Recipe"
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const asRecord = obj as Record<string, any>;
  if (isRecipeType(asRecord["@type"])) {
    return asRecord;
  }

  // @graph array (e.g. on sites that bundle multiple schemas in one block)
  if (Array.isArray(asRecord["@graph"])) {
    for (const item of asRecord["@graph"]) {
      const found = findRecipeInObject(item);
      if (found) return found;
    }
  }

  // Top-level array
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findRecipeInObject(item);
      if (found) return found;
    }
  }

  return null;
}

function isRecipeType(type: unknown): boolean {
  if (!type) return false;
  const normalize = (t: string) =>
    t.toLowerCase().replace("http://schema.org/", "").replace("https://schema.org/", "");
  if (typeof type === "string") return normalize(type) === "recipe";
  if (Array.isArray(type)) return type.some((t) => typeof t === "string" && normalize(t) === "recipe");
  return false;
}

// ---------------------------------------------------------------------------
// Mapping schema → Chefless recipe
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapSchemaToRecipe(schema: Record<string, any>, sourceUrl: string): ImportedRecipe {
  const title = getString(schema.name) ?? getString(schema.headline) ?? "Imported Recipe";

  const description = getString(schema.description);

  const prepTime = parseDurationMinutes(schema.prepTime);
  const cookTime = parseDurationMinutes(schema.cookTime);

  const servings = parseServings(schema.recipeYield);

  const ingredients = parseIngredients(schema.recipeIngredient);
  const steps = parseSteps(schema.recipeInstructions);

  const dietaryTags = parseDietaryTags(schema.suitableForDiet);
  const cuisineTags = parseCuisineTags(schema.recipeCuisine);

  return {
    title: title.trim().slice(0, 200),
    description: description?.trim().slice(0, 500),
    prepTime,
    cookTime,
    servings,
    ingredients,
    steps,
    dietaryTags,
    cuisineTags,
    sourceUrl,
  };
}

// ---------------------------------------------------------------------------
// Field parsers
// ---------------------------------------------------------------------------

function getString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

/**
 * Parses ISO 8601 duration strings like "PT15M", "PT1H30M" into minutes.
 */
function parseDurationMinutes(value: unknown): number | undefined {
  const str = getString(value);
  if (!str) return undefined;

  const match = str.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
  if (!match) return undefined;

  const days = parseInt(match[1] ?? "0");
  const hours = parseInt(match[2] ?? "0");
  const minutes = parseInt(match[3] ?? "0");
  const seconds = parseInt(match[4] ?? "0");

  const total = days * 1440 + hours * 60 + minutes + Math.round(seconds / 60);
  return total > 0 ? total : undefined;
}

function parseServings(value: unknown): number | undefined {
  if (typeof value === "number") return Math.round(value);
  const str = getString(value);
  if (!str) return undefined;
  // Handle "4 servings", "4-6", "4" etc.
  const match = str.match(/(\d+)/);
  if (!match) return undefined;
  const n = parseInt(match[1]);
  return n > 0 ? n : undefined;
}

function parseIngredients(value: unknown): ImportedIngredient[] {
  if (!Array.isArray(value)) return [];

  const result: ImportedIngredient[] = [];

  for (const item of value) {
    const raw = typeof item === "string" ? item : getString(item);
    if (!raw) continue;

    const parsed = parseIngredientString(raw.trim());
    if (parsed) {
      result.push(parsed);
    } else {
      // Can't parse quantity/unit — store the whole string as name with quantity 1.
      result.push({ name: raw.trim().slice(0, 200), quantity: 1, unit: "item" });
    }
  }

  return result;
}

/**
 * Very simple ingredient line parser.
 * Handles patterns like "2 cups flour", "1/2 tsp salt", "3 large eggs".
 */
function parseIngredientString(raw: string): ImportedIngredient | null {
  // Match: optional number (int or fraction), optional unit, rest = name.
  const match = raw.match(
    /^([\d./]+\s*(?:–|-|to)\s*[\d./]+|[\d./]+)?\s*([a-zA-Z]{1,20})?\s+(.*)/
  );
  if (!match) return null;

  const quantityRaw = match[1]?.trim();
  const unitRaw = match[2]?.trim().toLowerCase();
  const nameRaw = match[3]?.trim();

  if (!nameRaw) return null;

  const quantity = quantityRaw ? parseFraction(quantityRaw) : 1;
  const unit = unitRaw && isUnit(unitRaw) ? unitRaw : "item";
  const name = unitRaw && !isUnit(unitRaw)
    ? `${unitRaw} ${nameRaw}`.trim()
    : nameRaw;

  return {
    name: name.slice(0, 200),
    quantity: Math.max(quantity, 0),
    unit: unit.slice(0, 50),
  };
}

function parseFraction(str: string): number {
  // Handle range "1-2" or "1 to 2" → take lower bound.
  const rangeParts = str.split(/\s*(?:–|-|to)\s*/);
  const part = rangeParts[0].trim();

  if (part.includes("/")) {
    const [num, den] = part.split("/").map(Number);
    if (!isNaN(num) && !isNaN(den) && den !== 0) return num / den;
  }
  const n = parseFloat(part);
  return isNaN(n) ? 1 : n;
}

const COMMON_UNITS = new Set([
  "cup", "cups", "tbsp", "tablespoon", "tablespoons",
  "tsp", "teaspoon", "teaspoons", "oz", "ounce", "ounces",
  "lb", "lbs", "pound", "pounds", "g", "gram", "grams",
  "kg", "kilogram", "kilograms", "ml", "l", "liter", "liters",
  "clove", "cloves", "slice", "slices", "can", "cans",
  "bunch", "bunch", "stalk", "stalks", "head", "heads",
  "piece", "pieces", "medium", "large", "small", "whole",
  "pinch", "dash", "handful", "package", "packet",
]);

function isUnit(word: string): boolean {
  return COMMON_UNITS.has(word.toLowerCase());
}

function parseSteps(value: unknown): ImportedStep[] {
  if (!Array.isArray(value)) {
    // Some sites use a single string for instructions.
    const str = getString(value);
    if (str) {
      return [{ order: 1, instruction: str.trim().slice(0, 5000) }];
    }
    return [];
  }

  const result: ImportedStep[] = [];
  let order = 1;

  for (const item of value) {
    if (typeof item === "string" && item.trim()) {
      result.push({ order: order++, instruction: item.trim().slice(0, 5000) });
    } else if (typeof item === "object" && item !== null) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const obj = item as Record<string, any>;
      const type = (getString(obj["@type"]) ?? "").toLowerCase();

      if (type === "howtostep" || !type) {
        const text = getString(obj.text) ?? getString(obj.name);
        if (text?.trim()) {
          result.push({ order: order++, instruction: text.trim().slice(0, 5000) });
        }
      } else if (type === "howtosection") {
        // Section contains an array of steps.
        const nested = parseSteps(obj.itemListElement);
        for (const step of nested) {
          result.push({ order: order++, instruction: step.instruction });
        }
      }
    }
  }

  return result;
}

const DIETARY_MAP: Record<string, string> = {
  "https://schema.org/VeganDiet": "vegan",
  "https://schema.org/VegetarianDiet": "vegetarian",
  "https://schema.org/GlutenFreeDiet": "gluten-free",
  "https://schema.org/HalalDiet": "halal",
  "https://schema.org/KosherDiet": "kosher",
  "https://schema.org/DiabeticDiet": "diabetic",
  "https://schema.org/LowCalorieDiet": "low-calorie",
  "https://schema.org/LowFatDiet": "low-fat",
  "https://schema.org/LowLactoseDiet": "dairy-free",
  "https://schema.org/LowSaltDiet": "low-sodium",
};

function parseDietaryTags(value: unknown): string[] {
  if (!value) return [];
  const items = Array.isArray(value) ? value : [value];
  const tags: string[] = [];

  for (const item of items) {
    const str = typeof item === "string" ? item : getString(item);
    if (!str) continue;
    const mapped = DIETARY_MAP[str] ?? str.toLowerCase().replace(/https?:\/\/schema\.org\//i, "").replace("diet", "").trim();
    if (mapped) tags.push(mapped);
  }

  return [...new Set(tags)].slice(0, 10);
}

function parseCuisineTags(value: unknown): string[] {
  if (!value) return [];
  const items = Array.isArray(value) ? value : [value];
  const tags: string[] = [];

  for (const item of items) {
    const str = (typeof item === "string" ? item : getString(item))?.trim();
    if (str && str.length <= 50) {
      tags.push(str.slice(0, 50));
    }
  }

  return [...new Set(tags)].slice(0, 10);
}
