// Page files: gzipped for browsers that take it, and "304 Not Modified" when the browser has the file
// already. Runs the real server in-process. Run with: npm test
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await startServer(0);
const port = server.address().port;
after(() => server.close());

function get(urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ port, path: urlPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

test('text files go gzipped, and come back the same', async () => {
  const file = fs.readFileSync(path.join(ROOT, 'public', 'js', 'client.js'));
  const res = await get('/js/client.js', { 'Accept-Encoding': 'gzip, deflate, br' });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-encoding'], 'gzip');
  assert.ok(res.body.length < file.length / 2, `${res.body.length} bytes instead of ${file.length}`);
  assert.deepEqual(zlib.gunzipSync(res.body), file);
  const plain = await get('/js/client.js');
  assert.equal(plain.headers['content-encoding'], undefined, 'not for a browser that does not ask for it');
  assert.deepEqual(plain.body, file);
});

test('a file the browser has already: 304, nothing sent', async () => {
  for (const urlPath of ['/', '/js/client.js', '/map.json', '/navgrid.json', '/sim/game.js', '/shared/config.js',
    '/sounds/tick.wav', '/robots.txt', '/sitemap.xml', '/favicon.svg', '/og-image.jpg']) {
    const first = await get(urlPath, { 'Accept-Encoding': 'gzip' });
    assert.equal(first.status, 200, urlPath);
    assert.equal(first.headers['cache-control'], 'no-cache', `${urlPath}: always asks, so changes show at once`);
    const tag = first.headers.etag;
    assert.ok(tag, `${urlPath} has an ETag`);
    const again = await get(urlPath, { 'Accept-Encoding': 'gzip', 'If-None-Match': tag });
    assert.equal(again.status, 304, urlPath);
    assert.equal(again.body.length, 0);
    const other = await get(urlPath, { 'If-None-Match': 'W/"something-else"' });
    assert.equal(other.status, 200, `${urlPath}: a changed file comes whole`);
  }
  assert.equal((await get('/nope.js')).status, 404);
  assert.equal((await get('/js')).status, 404, 'a folder is not a file');
  assert.equal((await get('/sim/data/navgrid.json')).status, 404, 'no data under /sim/');
});

test('search engines: the page names its address, robots.txt points to the sitemap', async () => {
  const site = `http://localhost:${port}`;
  for (const urlPath of ['/', '/index.html']) {
    const page = await get(urlPath);
    assert.equal(page.status, 200, urlPath);
    assert.match(page.headers['content-type'], /^text\/html/);
    const html = page.body.toString();
    assert.ok(!html.includes('%SITE_URL%'), `${urlPath}: every address filled in`);
    assert.ok(html.includes(`<link rel="canonical" href="${site}/">`), `${urlPath}: canonical link`);
    assert.ok(html.includes(`<meta property="og:image" content="${site}/og-image.jpg">`), `${urlPath}: preview image`);
    assert.match(html, /<meta name="description" content="[^"]{50,160}">/);
    const data = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
    assert.equal(data['@graph'][0].url, `${site}/`, 'structured data is valid JSON with the address');
  }

  const robots = await get('/robots.txt');
  assert.match(robots.headers['content-type'], /^text\/plain/);
  assert.ok(robots.body.toString().includes(`Sitemap: ${site}/sitemap.xml`));
  // Behind a proxy that serves https, the addresses are https.
  const proxied = await get('/robots.txt', { 'X-Forwarded-Proto': 'https', Host: 'conquest.example.com' });
  assert.ok(proxied.body.toString().includes('Sitemap: https://conquest.example.com/sitemap.xml'));
  // A Host header that is not a host name is not copied into the page.
  const odd = await get('/', { Host: 'x"><script>' });
  assert.ok(odd.body.toString().includes('<link rel="canonical" href="http://localhost/">'));

  const sitemap = await get('/sitemap.xml');
  assert.match(sitemap.headers['content-type'], /^application\/xml/);
  assert.ok(sitemap.body.toString().includes(`<loc>${site}/</loc>`));
  assert.match((await get('/favicon.svg')).headers['content-type'], /^image\/svg\+xml/);
});
