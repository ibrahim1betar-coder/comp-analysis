import './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { runPythonJson, findPython, scriptPath } from '../server/python.js';

const fixture = new URL('./fixtures/tiktok-ytdlp.json', import.meta.url);
const fakeScript = new URL('./fixtures/fake_tiktok.py', import.meta.url).pathname;

test('tiktok_fetch.py parses the profile page and maps yt-dlp entries (real page fixture)', async () => {
  const bin = await findPython();
  const r = spawnSync(bin, [scriptPath('tiktok_fetch.py'), '--map-stdin'], { input: readFileSync(fixture), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.profile.displayName, 'NASA');
  assert.ok(out.profile.followers > 1_000_000);
  assert.ok(out.profile.totalLikes > 1_000_000);
  assert.equal(out.profile.postsCount, 67);
  assert.equal(out.profile.profileUrl, 'https://www.tiktok.com/@nasa');
  assert.equal(out.posts.length, 2); // entry without id skipped
  assert.deepEqual({ v: out.posts[0].views, l: out.posts[0].likes, c: out.posts[0].comments, s: out.posts[0].shares, t: out.posts[0].type }, { v: 221000, l: 15400, c: 410, s: 980, t: 'video' });
  assert.equal(out.posts[0].publishedAt, '2026-11-14T23:46:40Z');
  // `since` filters older entries
  const data = JSON.parse(readFileSync(fixture, 'utf8'));
  const r2 = spawnSync(bin, [scriptPath('tiktok_fetch.py'), '--map-stdin'], { input: JSON.stringify({ ...data, since: '2026-01-01T00:00:00Z' }), encoding: 'utf8' });
  assert.equal(JSON.parse(r2.stdout).posts.length, 1);
});

test('the Node runner returns the script JSON and surfaces script errors readably', async () => {
  const ok = await runPythonJson(fakeScript, ['nasa', '50', '']);
  assert.equal(ok.profile.followers, 123);
  assert.deepEqual(ok.args, ['nasa', '50', '']);
  await assert.rejects(runPythonJson(fakeScript, ['boom']), /could not read @boom/);
  await assert.rejects(runPythonJson(fakeScript, ['crash']), /exit 1.*ValueError/);
});

test('TikTok provider routes the python source through the script', async () => {
  const tiktok = (await import('../server/providers/tiktok.js')).default;
  const fields = tiktok.credentialFields.find((f) => f.key === 'source').options.map((o) => o[0]);
  assert.deepEqual(fields, ['apify', 'python', 'research']);
  const { saveCredentials, configuredPlatforms } = await import('../server/credentials.js');
  saveCredentials('tiktok', { source: 'python' });
  assert.ok(configuredPlatforms().has('tiktok')); // no token needed
});
