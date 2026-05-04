# Seed Data Pipeline

Populates the discovery feed with ~270 synthetic chef accounts and ~1,000 real recipes across all 77 cuisines.

## What it does

- Pulls recipes from **TheMealDB** (free, no key) for ~26 cuisines.
- Reads curated JSON in `data/{cuisine}.json` for the remaining 51 cuisines (real, named, traditional dishes — no inventions).
- Looks up real photos on **Wikipedia / Wikimedia Commons** (4-step fallback chain).
- Creates seed users with localized names + Pravatar avatars and unusable Firebase UIDs (`seed-{cuisine}-{n}`).
- Inserts everything with `isSeed: true` so it stays separable from real users.
- Final report: `data/_seed-report.json` (per-cuisine counts + dropped dishes).

## Run on dev

```bash
cd ~/codespace/sahab/products/chefless/chefless-api

MONGODB_URI="mongodb+srv://...@.../chefless_dev?appName=MainCluster" \
  npx tsx src/scripts/seed/seed-real-recipes.ts
```

Runtime: ~15–25 min.

## Run on prod

Add `--allow-prod`. Script prints an 8-second warning banner — Ctrl+C to abort.

```bash
MONGODB_URI="mongodb+srv://...@.../chefless?appName=MainCluster" \
  npx tsx src/scripts/seed/seed-real-recipes.ts --allow-prod
```

## Wipe seed data

Only deletes `isSeed: true` rows. Real users/recipes are never touched.

```bash
# dev
MONGODB_URI="..._dev..." npx tsx src/scripts/seed/seed-real-recipes.ts cleanup

# prod
MONGODB_URI="...prod..." npx tsx src/scripts/seed/seed-real-recipes.ts cleanup --allow-prod
```

## Re-run is safe

Re-running the seed deduplicates by `(authorId, seedExternalId)` — only inserts what's missing. No need to wipe first.

## Manage from admin

Admin panel → **Seed Data** tab (left nav, seedling icon):

- View totals + per-cuisine breakdown.
- Drill into any cuisine to see its seed users + recipes.
- Delete a single user (cascades follows/likes/saves), single recipe, whole cuisine, or wipe all (typed confirmation required).
