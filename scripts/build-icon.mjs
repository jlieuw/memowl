// Rasterizes media/icon-source.svg to the 128x128 PNG the Marketplace requires.
// Run with: npm run build:icon
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import sharp from 'sharp';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', 'media', 'icon-source.svg');
const out = join(here, '..', 'media', 'memowl-icon.png');

const svg = readFileSync(src);

await sharp(svg, { density: 384 })
  .resize(128, 128, { fit: 'contain' })
  .png()
  .toFile(out);

console.log(`Wrote ${out}`);
