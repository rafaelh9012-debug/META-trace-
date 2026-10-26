// A small PMTiles v3 writer for tests, written straight from the specification. It is deliberately independent of the
// reader (it shares no code with it) and of the Python writer in tools/make_pmtiles.py, so each can check the others.
const zlib = require('node:zlib');

const levelStart = [0]; for (let z = 1; z <= 27; z++) levelStart.push(levelStart[z - 1] + 4 ** (z - 1));
/** Hilbert tile id, from the spec's reference algorithm. */
function tileId(z, x, y) {
  let d = 0, n = 2 ** z; const xy = [x, y];
  for (let s = n / 2; s >= 1; s /= 2) {
    const rx = (xy[0] & s) > 0 ? 1 : 0, ry = (xy[1] & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {if (rx === 1) {xy[0] = s - 1 - xy[0]; xy[1] = s - 1 - xy[1];} [xy[0], xy[1]] = [xy[1], xy[0]];}
  }
  return levelStart[z] + d;
}
function putVarint(out, v) {while (v >= 128) {out.push((v % 128) | 128); v = Math.floor(v / 128);} out.push(v);}
function serializeDirectory(entries) {
  const out = []; putVarint(out, entries.length);
  let last = 0; for (const e of entries) {putVarint(out, e.tileId - last); last = e.tileId;}
  for (const e of entries) putVarint(out, e.runLength);
  for (const e of entries) putVarint(out, e.length);
  entries.forEach((e, i) => putVarint(out, i > 0 && e.offset === entries[i - 1].offset + entries[i - 1].length ? 0 : e.offset + 1));
  return Buffer.from(out);
}
const gz = b => zlib.gzipSync(b, {level: 9});

/**
 * tiles: [{z, x, y, data: Buffer}] (data is stored as given, gzip'ed when tileCompression is 2).
 * Options: bounds [minLon, minLat, maxLon, maxLat], metadata object, tileCompression (1 or 2), internalCompression (1 or 2),
 * leafSize (entries per leaf directory; 0 puts everything in the root), tileType (1 = mvt).
 */
function build(tiles, {bounds = [-180, -85, 180, 85], metadata = {}, tileCompression = 2, internalCompression = 2, leafSize = 0, tileType = 1, version = 3} = {}) {
  const comp = (b, kind) => kind === 2 ? gz(b) : b;
  const sorted = tiles.map(t => ({...t, id: tileId(t.z, t.x, t.y)})).sort((a, b) => a.id - b.id);
  const chunks = [], entries = [], seen = new Map(); let offset = 0;
  for (const t of sorted) {
    const data = comp(t.data, tileCompression), key = data.toString('latin1');
    let at = seen.get(key);
    if (at === undefined) {at = {offset, length: data.length}; seen.set(key, at); chunks.push(data); offset += data.length;}
    entries.push({tileId: t.id, offset: at.offset, length: at.length, runLength: 1});
  }
  // Merge runs of identical consecutive tiles, as clustered archives do.
  const merged = [];
  for (const e of entries) {
    const p = merged[merged.length - 1];
    if (p && p.offset === e.offset && p.length === e.length && p.tileId + p.runLength === e.tileId) p.runLength++; else merged.push({...e});
  }
  let root, leaves = Buffer.alloc(0);
  if (leafSize > 0 && merged.length > leafSize) {
    const ptrs = [], parts = []; let pos = 0;
    for (let i = 0; i < merged.length; i += leafSize) {
      const group = merged.slice(i, i + leafSize), buf = comp(serializeDirectory(group), internalCompression);
      ptrs.push({tileId: group[0].tileId, offset: pos, length: buf.length, runLength: 0}); parts.push(buf); pos += buf.length;
    }
    leaves = Buffer.concat(parts); root = comp(serializeDirectory(ptrs), internalCompression);
  } else root = comp(serializeDirectory(merged), internalCompression);
  const meta = comp(Buffer.from(JSON.stringify(metadata)), internalCompression), data = Buffer.concat(chunks);
  const header = Buffer.alloc(127);
  header.write('PMTiles', 0, 'latin1'); header[7] = version;
  const w64 = (o, v) => {header.writeUInt32LE(v % 4294967296, o); header.writeUInt32LE(Math.floor(v / 4294967296), o + 4);};
  const rootOffset = 127, metaOffset = rootOffset + root.length, leafOffset = metaOffset + meta.length, dataOffset = leafOffset + leaves.length;
  w64(8, rootOffset); w64(16, root.length); w64(24, metaOffset); w64(32, meta.length); w64(40, leafOffset); w64(48, leaves.length); w64(56, dataOffset); w64(64, data.length);
  w64(72, sorted.length); w64(80, merged.length); w64(88, seen.size);
  header[96] = 1; header[97] = internalCompression; header[98] = tileCompression; header[99] = tileType;
  header[100] = Math.min(...sorted.map(t => t.z)); header[101] = Math.max(...sorted.map(t => t.z));
  [bounds[0], bounds[1], bounds[2], bounds[3]].forEach((v, i) => header.writeInt32LE(Math.round(v * 1e7), 102 + 4 * i));
  header[118] = header[100]; header.writeInt32LE(Math.round((bounds[0] + bounds[2]) / 2 * 1e7), 119); header.writeInt32LE(Math.round((bounds[1] + bounds[3]) / 2 * 1e7), 123);
  return Buffer.concat([header, root, meta, leaves, data]);
}

module.exports = {build, tileId, serializeDirectory};
