import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { conversionLandingHtml, conversionDocsHtml } from '../src/conversion-pages.ts';
const origin = 'https://delta-witness-api.ruphussten.workers.dev';
const sha = process.env.GITHUB_SHA;
if (!/^[0-9a-f]{40}$/.test(sha || '')) throw new Error('Exact source commit is required');
cpSync('channels/base-app/dist', 'conversion-preview', { recursive: true });
mkdirSync('conversion-preview/buyer', { recursive: true });
mkdirSync('conversion-preview/docs', { recursive: true });
cpSync('channels/base-app/dist/index.html', 'conversion-preview/buyer/index.html');
// Link adjustment only for this combined static preview; production source is unchanged.
const localLinks = (html) => html.replaceAll('https://delta-witness-app.pages.dev/', '/buyer/');
const version = JSON.parse(readFileSync('wrangler.jsonc', 'utf8')).vars.APP_VERSION;
writeFileSync('conversion-preview/index.html', localLinks(conversionLandingHtml(origin, version)));
writeFileSync('conversion-preview/docs/index.html', localLinks(conversionDocsHtml(origin)));
// The existing core favicon is SVG at /favicon.ico. Reuse its exact route response.
const source = readFileSync('src/index.ts', 'utf8');
const favicon = source.match(/app\.get\("\/favicon\.ico",[\s\S]*?'(<svg[\s\S]*?<\/svg>)'/);
if (!favicon) throw new Error('Existing core favicon source not found');
writeFileSync('conversion-preview/favicon.ico', favicon[1]);
writeFileSync('conversion-preview/_release.json', JSON.stringify({ commit: sha, purpose: 'conversion-preview', core_deployed: false }) + '\n');
writeFileSync('conversion-preview/_headers', '/*\n  X-Robots-Tag: noindex, nofollow\n');
console.log(`Exported static preview for ${sha}; app at /buyer/, docs at /docs/`);
