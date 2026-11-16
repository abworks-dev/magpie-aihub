// Refresh only AIHub's public brand image; no login or application credentials.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const root = new URL('../', import.meta.url);
const html = await (await fetch('https://aihub.top/favicon.ico', { redirect: 'error', signal: AbortSignal.timeout(15000) })).text();
const icon = html.match(/<link\b[^>]*\brel="icon"[^>]*\bhref="(data:image\/png;base64,[A-Za-z0-9+/=]+)"/i)?.[1];
assert.ok(icon, 'Official AIHub embedded PNG favicon not found');
const png = Buffer.from(icon.slice(icon.indexOf(',') + 1), 'base64');
assert.equal(createHash('sha256').update(png).digest('hex'), '4ca27ef38578050dbf72af67769efd77fd3cba146916f60bcb6f1198b93793f0', 'Site image changed; review new branding before updating');
const packagePath = new URL('package.json', root), pagePath = new URL('ui/index.html', root);
const originalPackage = await readFile(packagePath, 'utf8'), originalPage = await readFile(pagePath, 'utf8');
const metadata = JSON.parse(originalPackage);
metadata.magpie.icon = icon;
const brand = '<div class="brand-mark" aria-hidden="true">↗</div>';
const image = `<img class="brand-mark" src="${icon}" alt="" aria-hidden="true">`;
let page;
if (originalPage.includes(brand)) page = originalPage.replace(brand, image);
else if (/<img class="brand-mark" src="data:image\/png;base64,[^"]+" alt="" aria-hidden="true">/.test(originalPage))
  page = originalPage.replace(/<img class="brand-mark" src="data:image\/png;base64,[^"]+" alt="" aria-hidden="true">/, image);
else throw new Error('Unexpected brand element; review page before generating');
// This generator owns only package metadata and page branding. Refuse concurrent edits.
assert.equal(await readFile(packagePath, 'utf8'), originalPackage);
assert.equal(await readFile(pagePath, 'utf8'), originalPage);
await writeFile(packagePath, `${JSON.stringify(metadata, null, 2)}\n`);
await writeFile(pagePath, page);
console.log(`Updated official AIHub image: ${png.length} bytes; embedded in metadata and page; no new asset route.`);
