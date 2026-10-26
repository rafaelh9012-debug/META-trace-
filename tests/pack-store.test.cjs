// The package store: session-only fallback, saved copies, quota and storage errors, stable ids. The real IndexedDB path is
// exercised in the browser suite (tests/regions.browser.test.cjs); here a small in-memory backend stands in for it.
const test = require('node:test');
const assert = require('node:assert/strict');
const PS = require('../pack-store.js');

const blobOf = (n, type = 'application/octet-stream') => new Blob([new Uint8Array(n)], {type});
const memoryBackend = () => {
  const m = new Map();
  return {kind: 'browser', all: async () => [...m.values()], put: async r => {m.set(r.id, r);}, remove: async id => m.delete(id), close() {}, m};
};

test('without IndexedDB the store is session-only and says why', async () => {
  const s = await PS.create({});
  assert.equal(s.persistent, false);
  assert.equal(s.kind, 'session');
  assert.match(s.reason, /persistent storage/);
  await assert.rejects(s.add({id: 'a', name: 'A', info: {}, blob: blobOf(10), remember: true}), e => e.code === 'unavailable');
  assert.deepEqual(await s.list(), []);
  await s.add({id: 'a', name: 'A', info: {}, blob: blobOf(10)});
  const list = await s.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].persisted, false);
  assert.equal(list[0].size, 10);
});

test('an IndexedDB that fails to open leaves a session-only store, not an error', async () => {
  const failing = {open() {const r = {}; setTimeout(() => r.onerror && r.onerror(), 0); r.error = new Error('denied'); return r;}};
  const s = await PS.create({indexedDB: failing});
  assert.equal(s.persistent, false);
  assert.match(s.reason, /denied/);
  const throwing = {open() {throw new Error('SecurityError');}};
  const t = await PS.create({indexedDB: throwing});
  assert.equal(t.persistent, false);
  assert.match(t.reason, /SecurityError/);
});

test('remember copies into browser storage; otherwise the file is held for the visit only', async () => {
  const backend = memoryBackend(), s = await PS.create({backend});
  assert.equal(s.persistent, true);
  await s.add({id: 'kept', name: 'Kept', info: {a: 1}, blob: blobOf(100), remember: true, addedAt: 1});
  await s.add({id: 'visit', name: 'Visit', info: {}, blob: blobOf(50), addedAt: 2});
  assert.deepEqual([...backend.m.keys()], ['kept']);
  const list = await s.list();
  assert.deepEqual(list.map(r => [r.id, r.persisted]), [['kept', true], ['visit', false]]);
  // a new visit sees only what was saved
  const next = await PS.create({backend});
  assert.deepEqual((await next.list()).map(r => r.id), ['kept']);
});

test('adding the same package again replaces it, and remembering moves it between tiers', async () => {
  const backend = memoryBackend(), s = await PS.create({backend});
  await s.add({id: 'x', name: 'X', info: {}, blob: blobOf(10), addedAt: 1});
  await s.add({id: 'x', name: 'X', info: {}, blob: blobOf(10), remember: true, addedAt: 2});
  let list = await s.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].persisted, true);
  await s.add({id: 'x', name: 'X', info: {}, blob: blobOf(10), remember: false, addedAt: 3});
  list = await s.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].persisted, false);
  assert.equal(backend.m.size, 0, 'the saved copy is gone when the package is kept for the visit only');
});

test('remove forgets both tiers', async () => {
  const backend = memoryBackend(), s = await PS.create({backend});
  await s.add({id: 'a', name: 'A', info: {}, blob: blobOf(5), remember: true});
  await s.add({id: 'b', name: 'B', info: {}, blob: blobOf(5)});
  assert.equal(await s.remove('a'), true);
  assert.equal(await s.remove('b'), true);
  assert.equal(await s.remove('zzz'), false);
  assert.deepEqual(await s.list(), []);
});

test('a copy that does not fit is refused before anything is written', async () => {
  const backend = memoryBackend(), storage = {estimate: async () => ({usage: 900, quota: 1000})};
  const s = await PS.create({backend, storage});
  assert.deepEqual(await s.quota(), {usage: 900, quota: 1000, free: 100});
  await assert.rejects(s.add({id: 'big', name: 'Big', info: {}, blob: blobOf(1000), remember: true}), e => e.name === 'PackStoreError' && e.code === 'quota');
  assert.equal(backend.m.size, 0);
  // still usable for this visit
  await s.add({id: 'big', name: 'Big', info: {}, blob: blobOf(1000)});
  assert.equal((await s.list()).length, 1);
});

test('the browser reporting QuotaExceededError while writing is a quota error', async () => {
  const backend = memoryBackend();
  backend.put = async () => {const e = new Error('full'); e.name = 'QuotaExceededError'; throw e;};
  const s = await PS.create({backend});
  await assert.rejects(s.add({id: 'a', name: 'A', info: {}, blob: blobOf(5), remember: true}), e => e.code === 'quota');
  backend.put = async () => {throw new Error('disk on fire');};
  await assert.rejects(s.add({id: 'a', name: 'A', info: {}, blob: blobOf(5), remember: true}), e => e.code === 'unavailable' && /disk on fire/.test(e.message));
  assert.deepEqual(await s.list(), [], 'a failed save leaves nothing behind');
});

test('an unreadable store reports why and still lists this visit\'s packages', async () => {
  const backend = memoryBackend();
  const s = await PS.create({backend});
  await s.add({id: 'v', name: 'V', info: {}, blob: blobOf(5)});
  backend.all = async () => {throw new Error('corrupt');};
  const list = await s.list();
  assert.deepEqual(list.map(r => r.id), ['v']);
  assert.match(s.reason, /corrupt/);
});

test('quota is null when the browser does not say', async () => {
  assert.equal(await (await PS.create({backend: memoryBackend()})).quota(), null);
  assert.equal(await (await PS.create({backend: memoryBackend(), storage: {estimate: async () => ({})}})).quota(), null);
  assert.equal(await (await PS.create({backend: memoryBackend(), storage: {estimate: async () => {throw new Error('x');}}})).quota(), null);
});

test('idFor is stable for the same file and differs when the file differs', () => {
  const f = (name, size, lastModified) => ({name, size, lastModified});
  assert.equal(PS.idFor(f('a.pmtiles', 10, 5)), PS.idFor(f('a.pmtiles', 10, 5)));
  assert.notEqual(PS.idFor(f('a.pmtiles', 10, 5)), PS.idFor(f('a.pmtiles', 11, 5)));
  assert.notEqual(PS.idFor(f('a.pmtiles', 10, 5)), PS.idFor(f('b.pmtiles', 10, 5)));
  assert.notEqual(PS.idFor(f('a.pmtiles', 10, 5)), PS.idFor(f('a.pmtiles', 10, 6)));
  assert.match(PS.idFor(f('a.pmtiles', 10, 5)), /^pkg-[0-9a-f]{8}-[0-9a-z]+$/);
});
