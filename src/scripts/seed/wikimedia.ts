/**
 * Real-photo image lookup for named dishes. Free, no API key.
 *
 * Lookup chain (each falls through on miss):
 *   1. Wikipedia article infobox image — the canonical photo of the dish.
 *   2. Wikimedia Commons keyword search — free-text fallback.
 *
 * Returns null when nothing matches; the caller decides whether to drop the
 * recipe or push it to the "needs image" admin queue.
 */

const WIKI_API = "https://en.wikipedia.org/w/api.php";
const COMMONS_API = "https://commons.wikimedia.org/w/api.php";

interface WikipediaPageImageResponse {
  query?: {
    pages?: Record<
      string,
      {
        pageid?: number;
        title?: string;
        original?: { source?: string };
        thumbnail?: { source?: string };
      }
    >;
  };
}

interface CommonsSearchResponse {
  query?: {
    pages?: Record<
      string,
      {
        title?: string;
        imageinfo?: Array<{
          url?: string;
          thumburl?: string;
          mime?: string;
          width?: number;
          height?: number;
        }>;
      }
    >;
  };
}

/** Wikipedia opensearch returns [query, [titles], [descs], [urls]]. */
type OpenSearchResponse = [string, string[], string[], string[]];

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: {
      // Header values must be ASCII; the em dash here used to crash Node's
      // fetch with a ByteString error and silently null out every recipe.
      "User-Agent":
        "ChefelessSeed/1.0 (https://chefless.app - seed data ingestion)",
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return (await res.json()) as T;
}

/**
 * Pull the infobox/lead image from a Wikipedia article whose title best
 * matches `dishName`. Disambiguation pages and stub articles often lack a
 * pageimage — those return null and the caller falls back to commons search.
 */
async function fromWikipediaArticle(dishName: string): Promise<string | null> {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    titles: dishName,
    prop: "pageimages",
    piprop: "original|thumbnail",
    pithumbsize: "1024",
    redirects: "1",
    origin: "*",
  });
  const data = await fetchJson<WikipediaPageImageResponse>(
    `${WIKI_API}?${params.toString()}`
  );
  const pages = data.query?.pages;
  if (!pages) return null;

  for (const page of Object.values(pages)) {
    const url = page.original?.source ?? page.thumbnail?.source;
    if (url && /\.(jpe?g|png|webp)(?:\?|$)/i.test(url)) return url;
  }
  return null;
}

/**
 * Search Wikimedia Commons by keyword. Returns the first File: result whose
 * MIME type is an image. Adds "food" to the query to bias toward dish photos
 * rather than maps/portraits.
 */
async function fromCommonsSearch(dishName: string): Promise<string | null> {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    generator: "search",
    gsrsearch: `${dishName} food filetype:bitmap`,
    gsrnamespace: "6",
    gsrlimit: "5",
    prop: "imageinfo",
    iiprop: "url|mime",
    iiurlwidth: "1024",
    origin: "*",
  });

  const data = await fetchJson<CommonsSearchResponse>(
    `${COMMONS_API}?${params.toString()}`
  );
  const pages = data.query?.pages;
  if (!pages) return null;

  for (const page of Object.values(pages)) {
    const info = page.imageinfo?.[0];
    if (!info) continue;
    if (info.mime && !info.mime.startsWith("image/")) continue;
    const url = info.thumburl ?? info.url;
    if (url) return url;
  }
  return null;
}

/**
 * Resolve the closest matching Wikipedia article via opensearch, then pull
 * its pageimage. This catches transliteration mismatches (e.g., "Nom Banh
 * Chok" vs "Num Banh Chok") that the literal pageimage call misses.
 */
async function fromOpenSearch(dishName: string): Promise<string | null> {
  const params = new URLSearchParams({
    action: "opensearch",
    format: "json",
    search: dishName,
    limit: "3",
    namespace: "0",
    origin: "*",
  });

  const data = await fetchJson<OpenSearchResponse>(
    `${WIKI_API}?${params.toString()}`
  );
  const titles = data?.[1] ?? [];
  for (const candidate of titles) {
    if (!candidate) continue;
    // Cheap heuristic: skip disambiguation hits.
    if (/disambiguation/i.test(candidate)) continue;
    const url = await fromWikipediaArticle(candidate);
    if (url) return url;
  }
  return null;
}

/**
 * Trim a dish title down to its core canonical form. Removes parenthetical
 * qualifiers ("Couscous (Algerian)" → "Couscous") and stylistic suffixes
 * ("Lasagna alla Bolognese" → "Lasagna") so the simpler name lands a hit.
 */
function simplifyTitle(raw: string): string | null {
  let t = raw
    .replace(/\(.*?\)/g, "")
    .replace(/\b(alla|al la|al|à la|de|à|de la|del|do|do uma|alle)\b.+$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t || t.toLowerCase() === raw.toLowerCase()) return null;
  return t;
}

/**
 * Resolve a real photo for the named dish.
 *
 * Lookup chain:
 *   1. Direct Wikipedia article match (most precise).
 *   2. Wikipedia opensearch suggestions (handles transliteration drift).
 *   3. Simplified title — strip parentheticals/qualifiers, retry article + search.
 *   4. Wikimedia Commons keyword search (last resort).
 */
export async function findDishImage(
  dishName: string
): Promise<string | null> {
  try {
    const direct = await fromWikipediaArticle(dishName);
    if (direct) return direct;
  } catch {
    // fall through
  }

  try {
    const viaOpenSearch = await fromOpenSearch(dishName);
    if (viaOpenSearch) return viaOpenSearch;
  } catch {
    // fall through
  }

  const simplified = simplifyTitle(dishName);
  if (simplified) {
    try {
      const direct = await fromWikipediaArticle(simplified);
      if (direct) return direct;
    } catch {
      // fall through
    }
    try {
      const viaOpenSearch = await fromOpenSearch(simplified);
      if (viaOpenSearch) return viaOpenSearch;
    } catch {
      // fall through
    }
  }

  try {
    return await fromCommonsSearch(dishName);
  } catch {
    return null;
  }
}
