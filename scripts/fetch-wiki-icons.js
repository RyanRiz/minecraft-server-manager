'use strict';

// Fills in whatever public/icons/mc-items/ is still missing after
// fetch-item-icons.js, using the Minecraft Wiki's rendered "Invicon" images
// (beds, banners, chests, heads, clock, compass, shield, … — items that have
// no static texture in minecraft-assets because the real game renders them
// as live 3D models, so there's nothing there to fetch).
//
// !! LICENSING — READ BEFORE RUNNING ON A FORK YOU DISTRIBUTE OR RUN COMMERCIALLY !!
// Minecraft Wiki content is CC BY-NC-SA 3.0 — NonCommercial. This script
// exists for a personal, non-commercial fork/deployment ONLY (per an explicit
// request in that context). It is intentionally separate from
// fetch-item-icons.js (MIT-sourced, safe for anyone using this project) so
// that default/public checkouts of this codebase never silently pull in
// NonCommercial-licensed images. Do not wire this into CI, a Docker build, or
// any workflow that runs for users who haven't made that same call for their
// own deployment.
//
// Usage: node scripts/fetch-wiki-icons.js [mcVersion]   (default: 1.21.11)

const fs = require('node:fs/promises');
const path = require('node:path');

const MCDATA_BASE = 'https://cdn.jsdelivr.net/gh/PrismarineJS/minecraft-data@master/data/pc';
const WIKI_API = 'https://minecraft.wiki/api.php';
const VERSION = process.argv[2] || '1.21.11';
const OUT_DIR = path.join(__dirname, '..', 'public', 'icons', 'mc-items');
const CONCURRENCY = 8; // be polite to the wiki

// A handful of ids whose wiki page title doesn't match a plain title-cased
// version of the id.
const TITLE_OVERRIDES = {
  copper_golem_statue: 'Copper Golem',
  exposed_copper_golem_statue: 'Copper Golem',
  weathered_copper_golem_statue: 'Copper Golem',
  oxidized_copper_golem_statue: 'Copper Golem',
  waxed_copper_golem_statue: 'Copper Golem',
  waxed_exposed_copper_golem_statue: 'Copper Golem',
  waxed_weathered_copper_golem_statue: 'Copper Golem',
  waxed_oxidized_copper_golem_statue: 'Copper Golem',
};

function titleCase(name) {
  if (TITLE_OVERRIDES[name]) return TITLE_OVERRIDES[name];
  return name
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function wikiIconUrl(title) {
  const params = new URLSearchParams({
    action: 'query',
    titles: `File:Invicon ${title}.png`,
    prop: 'imageinfo',
    iiprop: 'url',
    format: 'json',
  });
  const data = await fetchJson(`${WIKI_API}?${params}`);
  const pages = data?.query?.pages || {};
  const page = Object.values(pages)[0];
  return page?.imageinfo?.[0]?.url || null;
}

async function tryFetch(name) {
  try {
    const url = await wikiIconUrl(titleCase(name));
    if (!url) return null;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

async function main() {
  console.log(`Fetching item list for ${VERSION}...`);
  const items = await fetchJson(`${MCDATA_BASE}/${VERSION}/items.json`);
  const names = [...new Set(items.map((it) => it.name).filter(Boolean))].sort();

  await fs.mkdir(OUT_DIR, { recursive: true });
  const existing = new Set(await fs.readdir(OUT_DIR));
  const missing = names.filter((n) => n !== 'air' && !existing.has(`${n}.png`));
  console.log(`${missing.length} item(s) still missing a local icon — trying the wiki...`);

  let hits = 0;
  const stillMissing = [];
  const queue = [...missing];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length) {
        const name = queue.shift();
        const buf = await tryFetch(name);
        if (buf) {
          await fs.writeFile(path.join(OUT_DIR, `${name}.png`), buf);
          hits += 1;
        } else {
          stillMissing.push(name);
        }
      }
    })
  );

  console.log(`\nFetched ${hits}/${missing.length} from the wiki.`);
  if (stillMissing.length) {
    console.log(`${stillMissing.length} item(s) have no icon anywhere (falls back to a category/generic glyph):`);
    console.log(stillMissing.join(', '));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
