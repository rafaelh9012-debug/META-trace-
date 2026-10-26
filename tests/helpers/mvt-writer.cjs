// A small Mapbox Vector Tile encoder for tests. It is written from the specification, independently of the decoder, and is
// checked against hand-written bytes and the specification's own geometry examples in mvt-decoder.test.cjs.
// Used by the tile-schema, region and browser tests to build tiles and PMTiles archives without any map data.

const bytes = a => Buffer.from(a);
function varint(n) {
  // exact for non-negative integers up to 2^53; negative numbers are written as 64-bit two's complement
  const out = [];
  let lo, hi;
  if (n >= 0) {lo = n % 4294967296; hi = Math.floor(n / 4294967296);}
  else {
    const m = -n - 1; // ~(-n - 1) = n  for two's complement
    lo = (~(m % 4294967296)) >>> 0; hi = (~Math.floor(m / 4294967296)) >>> 0;
  }
  lo >>>= 0; hi >>>= 0;
  for (let i = 0; i < 10; i++) {
    let b = lo & 0x7f;
    lo = ((lo >>> 7) | ((hi & 0x7f) << 25)) >>> 0; hi >>>= 7;
    if (lo !== 0 || hi !== 0) out.push(b | 0x80); else {out.push(b); break;}
  }
  return bytes(out);
}
const zigzag32 = v => ((v << 1) ^ (v >> 31)) >>> 0;
function zigzag64(n) {
  // sint64: (n << 1) ^ (n >> 63), exact for |n| < 2^52
  return n >= 0 ? varint(n * 2) : varint(-n * 2 - 1);
}
const key = (field, wt) => varint(field * 8 + wt);
const lenField = (field, buf) => Buffer.concat([key(field, 2), varint(buf.length), buf]);
const varField = (field, n) => Buffer.concat([key(field, 0), varint(n)]);

function value(v) {
  if (typeof v === 'string') return lenField(1, Buffer.from(v, 'utf8'));
  if (typeof v === 'boolean') return varField(7, v ? 1 : 0);
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return v < 0 ? Buffer.concat([key(6, 0), zigzag64(v)]) : Buffer.concat([key(5, 0), varint(v)]);
    const b = Buffer.alloc(8); b.writeDoubleLE(v); return Buffer.concat([key(3, 1), b]);
  }
  if (v && typeof v === 'object') {
    if ('int64' in v) return Buffer.concat([key(4, 0), varint(v.int64)]);
    if ('sint64' in v) return Buffer.concat([key(6, 0), zigzag64(v.sint64)]);
    if ('uint64' in v) return Buffer.concat([key(5, 0), varint(v.uint64)]);
    if ('double' in v) {const b = Buffer.alloc(8); b.writeDoubleLE(v.double); return Buffer.concat([key(3, 1), b]);}
    if ('float' in v) {const b = Buffer.alloc(4); b.writeFloatLE(v.float); return Buffer.concat([key(2, 5), b]);}
  }
  throw new Error('cannot encode value ' + JSON.stringify(v));
}

/** Geometry as command integers. points: [x,y,...]; lines: [[x,y,...],...]; polygons: rings [[x,y,...],...] (first vertex not repeated). */
function geometry(type, g) {
  const out = [];
  let cx = 0, cy = 0;
  const move = (cmd, pts) => {
    out.push(((pts.length / 2) << 3) | cmd);
    for (let i = 0; i < pts.length; i += 2) {out.push(zigzag32(pts[i] - cx), zigzag32(pts[i + 1] - cy)); cx = pts[i]; cy = pts[i + 1];}
  };
  if (type === 1) {move(1, Array.from(g));}
  else if (type === 2 || type === 3) {
    for (const line of g) {
      const a = Array.from(line);
      move(1, a.slice(0, 2));
      if (a.length > 2) move(2, a.slice(2));
      if (type === 3) out.push((1 << 3) | 7);
    }
  } else throw new Error('geometry type');
  return out;
}
const packed = (field, nums) => lenField(field, Buffer.concat(nums.map(n => varint(n))));

/**
 * layers: [{name, extent=4096, version=2, features: [{id?, type: 1|2|3, props?, geometry, rawGeometry?}]}]
 * options.unknownFields adds fields no reader knows, to prove they are skipped; options.nameLast writes the layer name after its features.
 */
function encodeTile(layers, options = {}) {
  const parts = [];
  for (const layer of layers) {
    const keys = [], keyIndex = new Map(), values = [], valueIndex = new Map();
    const feats = [];
    for (const f of layer.features) {
      const tags = [];
      for (const [k, v] of Object.entries(f.props || {})) {
        if (v === undefined) continue;
        if (!keyIndex.has(k)) {keyIndex.set(k, keys.length); keys.push(k);}
        const enc = value(v), id = enc.toString('hex');
        if (!valueIndex.has(id)) {valueIndex.set(id, values.length); values.push(enc);}
        tags.push(keyIndex.get(k), valueIndex.get(id));
      }
      const cmds = f.rawGeometry || geometry(f.type, f.geometry);
      const fb = [];
      if (f.id !== undefined) fb.push(varField(1, f.id));
      if (tags.length) fb.push(packed(2, tags));
      fb.push(varField(3, f.type));
      fb.push(packed(4, cmds));
      if (options.unknownFields) fb.push(varField(99, 7), lenField(98, Buffer.from('ignored')));
      feats.push(lenField(2, Buffer.concat(fb)));
    }
    const lb = [];
    if (!options.nameLast) lb.push(lenField(1, Buffer.from(layer.name, 'utf8')));
    lb.push(...feats);
    for (const k of keys) lb.push(lenField(3, Buffer.from(k, 'utf8')));
    for (const v of values) lb.push(lenField(4, v));
    lb.push(varField(5, layer.extent === undefined ? 4096 : layer.extent));
    lb.push(varField(15, layer.version === undefined ? 2 : layer.version));
    if (options.unknownFields) lb.push(varField(97, 1));
    if (options.nameLast) lb.push(lenField(1, Buffer.from(layer.name, 'utf8')));
    parts.push(lenField(3, Buffer.concat(lb)));
  }
  if (options.unknownFields) parts.push(varField(55, 3));
  return Buffer.concat(parts);
}

module.exports = {encodeTile, geometry, varint, zigzag32, POINT: 1, LINESTRING: 2, POLYGON: 3};
