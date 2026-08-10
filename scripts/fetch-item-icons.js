'use strict';

// One-time (or periodically re-run) fetch of a LOCAL, offline copy of Minecraft
// item/block icons into public/icons/mc-items/ — one flat PNG per item id
// (unprefixed, e.g. "diamond_sword.png"). The panel serves these itself so the
// item browser and inventory grid never depend on reaching an external CDN
// through whatever reverse proxy/firewall a self-hosted deployment sits behind.
//
// Source: PrismarineJS/minecraft-data (item list) + PrismarineJS/minecraft-assets
// (textures), both MIT. Not every item has a clean single-texture icon — blocks
// like chests, beds, furnaces and crafting tables are rendered as live 3D
// models by the real game client, so no flat icon PNG exists for them anywhere
// (not even in Mojang's own client jar). Where possible this falls back to the
// block's most recognizable single face texture (front, then top, then side)
// instead of nothing; a genuine miss just means no local icon — the item
// browser/inventory grid already show a generic glyph for that case.
//
// Usage: node scripts/fetch-item-icons.js [mcVersion]   (default: 1.21.11)
//
// Both sources are fetched from GitHub's `master` branch via jsdelivr's `gh`
// CDN mode, NOT the published npm packages — minecraft-assets' latest npm
// release (1.17.0) predates a lot of current content (e.g. the copper tool
// line, wall shelves), so pinning to it silently missed textures that
// actually exist in the repo. `master` is a moving target, but this is a
// manually re-run maintenance script, not runtime code, so always fetching
// current data on refresh is exactly what's wanted.

const fs = require('node:fs/promises');
const path = require('node:path');

const MCDATA_BASE = 'https://cdn.jsdelivr.net/gh/PrismarineJS/minecraft-data@master/data/pc';
const ASSETS_BASE = 'https://cdn.jsdelivr.net/gh/PrismarineJS/minecraft-assets@master/data';
const VERSION = process.argv[2] || '1.21.11';
const OUT_DIR = path.join(__dirname, '..', 'public', 'icons', 'mc-items');
const CONCURRENCY = 24;

// A "shaped" block (stairs/slab/wall/fence/button/…) renders its inventory
// icon from a live 3D model, same as chests/furnaces — but unlike those, its
// MODEL just reuses its base material's flat texture (oak_stairs literally
// looks like oak_planks from the icon's-eye view). Stripping the shape gets
// us back to a real, resolvable texture name.
const SHAPE_SUFFIXES = [
  '_fence_gate',
  '_pressure_plate',
  '_hanging_sign',
  '_stairs',
  '_slab',
  '_wall',
  '_fence',
  '_button',
  '_door',
  '_trapdoor',
  '_sign',
  '_carpet',
];

/** Plausible texture-file names for a stripped base ("oak" -> oak_planks, "brick" -> bricks, …). */
function guessesFor(base) {
  return [base, `${base}s`, `${base}_planks`, `${base}_wool`, `${base}_block`, `${base}_block_side`, `${base}_bricks`];
}

// Standalone multi-face blocks (furnace, crafting table, pumpkin, campfire…)
// aren't a "shaped variant" of anything else, but still have no single
// composited icon — their most recognizable single texture is one face.
const FACE_SUFFIXES = ['_front', '_front_on', '_top', '_side'];

function baseGuesses(name) {
  const out = new Set();
  for (const suf of SHAPE_SUFFIXES) {
    if (name.endsWith(suf)) {
      for (const g of guessesFor(name.slice(0, -suf.length))) out.add(g);
    }
  }
  for (const suf of FACE_SUFFIXES) out.add(`${name}${suf}`);
  // "oak_wood" (all-bark log variant) shares oak_log's texture.
  if (name.endsWith('_wood')) out.add(name.replace(/_wood$/, '_log'));
  // "smooth_quartz"/"smooth_sandstone" share their normal block's top/bottom face.
  if (name.startsWith('smooth_')) {
    const base = name.slice('smooth_'.length);
    for (const g of baseGuesses(base)) out.add(g); // e.g. smooth_red_sandstone_slab -> red_sandstone…
    out.add(`${base}_top`);
    out.add(`${base}_bottom`);
    out.add(`${base}_block_top`);
    out.add(`${base}_block_bottom`);
  }
  return out;
}

// One-off items whose texture name doesn't follow any of the patterns above.
const ALIASES = {
  crimson_hyphae: 'crimson_stem',
  stripped_crimson_hyphae: 'stripped_crimson_stem',
  warped_hyphae: 'warped_stem',
  stripped_warped_hyphae: 'stripped_warped_stem',
  heavy_weighted_pressure_plate: 'iron_block',
  light_weighted_pressure_plate: 'gold_block',
  magma_block: 'magma',
  snow_block: 'snow',
  petrified_oak_slab: 'oak_planks',
  enchanted_golden_apple: 'golden_apple',
  sticky_piston: 'piston_top_sticky',
  dried_kelp_block: 'dried_kelp_top',
};

/** All candidate texture-file names for an item id, original first. */
function candidateNames(name) {
  const names = new Set([name]);
  if (ALIASES[name]) names.add(ALIASES[name]);
  for (const g of baseGuesses(name)) names.add(g);
  // Waxed copper and infested-block variants share their plain counterpart's
  // texture — retry the whole pipeline on the name with that prefix stripped.
  for (const prefix of ['waxed_', 'infested_']) {
    if (name.startsWith(prefix)) {
      const stripped = name.slice(prefix.length);
      names.add(stripped);
      for (const g of baseGuesses(stripped)) names.add(g);
    }
  }
  return [...names];
}

// Tried in order; first hit wins.
const CANDIDATES = (name) =>
  candidateNames(name).flatMap((n) => [
    { folder: 'items', file: n },
    { folder: 'blocks', file: n },
  ]);

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function tryDownload(name) {
  for (const { folder, file } of CANDIDATES(name)) {
    const url = `${ASSETS_BASE}/${VERSION}/${folder}/${file}.png`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (res.ok) return Buffer.from(await res.arrayBuffer());
    } catch {
      /* network hiccup on this candidate — try the next one */
    }
  }
  return null;
}

async function main() {
  console.log(`Fetching item list for ${VERSION}...`);
  const items = await fetchJson(`${MCDATA_BASE}/${VERSION}/items.json`);
  await fs.mkdir(OUT_DIR, { recursive: true });

  const names = [...new Set(items.map((it) => it.name).filter(Boolean))].sort();
  let done = 0;
  let hits = 0;
  const misses = [];
  const queue = [...names];

  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length) {
        const name = queue.shift();
        const buf = await tryDownload(name);
        done += 1;
        if (buf) {
          await fs.writeFile(path.join(OUT_DIR, `${name}.png`), buf);
          hits += 1;
        } else {
          misses.push(name);
        }
        if (done % 200 === 0) console.log(`  ${done}/${names.length}...`);
      }
    })
  );

  console.log(`\nDone: ${hits}/${names.length} icons saved to ${path.relative(process.cwd(), OUT_DIR)}`);
  console.log(`${misses.length} item(s) have no local icon (falls back to a generic glyph client-side):`);
  console.log(misses.join(', '));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
