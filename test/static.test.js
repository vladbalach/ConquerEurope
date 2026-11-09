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
  for (const urlPath of ['/js/client.js', '/map.json', '/navgrid.json', '/sim/game.js', '/shared/config.js', '/sounds/tick.wav']) {
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
