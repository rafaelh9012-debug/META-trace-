/*
 * PMTiles v3 reader: a single-file tile archive read by byte range, never loaded whole.
 *
 * Format: https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md (127-byte header, a root directory, optional
 * leaf directories, then the tile data). Directories are varint-encoded and compressed; tiles are addressed by a Hilbert
 * curve tile id that runs through the zoom levels.
 *
 * This reader needs no network. Its input is a "source": { size, read(offset, length) -> Promise<Uint8Array> }. In the
 * app that is a Blob or File (blob.slice(a, b) reads only those bytes from disk), so a multi-gigabyte archive costs
 * the memory of the few directories and tiles actually in use. Supported: internal and tile compression "none" and
 * "gzip" (the browser's DecompressionStream); MVT tiles. Anything else is refused with a clear reason, not guessed at.
 */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.PMTiles=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';

  const HEADER_BYTES=127,MAGIC='PMTiles';
  const COMPRESSION={unknown:0,none:1,gzip:2,brotli:3,zstd:4};
  const COMPRESSION_NAME=['unknown','none','gzip','brotli','zstd'];
  const TILE_TYPE={unknown:0,mvt:1,png:2,jpeg:3,webp:4,avif:5,mlt:6};
  const TILE_TYPE_NAME=['unknown','mvt','png','jpeg','webp','avif','MapLibre Tile (mlt)'];
  const MAX_ZOOM=26;                                             // tile ids stay exact in a double up to this zoom

  class PMTilesError extends Error{constructor(code,message){super(message);this.name='PMTilesError';this.code=code;}}

  // ---- tile ids (Hilbert curve) ---------------------------------------------------------------------------------
  const levelStart=[0];for(let z=1;z<=MAX_ZOOM+1;z++)levelStart.push(levelStart[z-1]+Math.pow(4,z-1));

  function rotate(n,xy,rx,ry){
    if(ry===0){
      if(rx===1){xy[0]=n-1-xy[0];xy[1]=n-1-xy[1];}
      const t=xy[0];xy[0]=xy[1];xy[1]=t;
    }
  }
  function zxyToTileId(z,x,y){
    if(!Number.isInteger(z)||z<0||z>MAX_ZOOM)throw new PMTilesError('bad_tile','Tile zoom must be an integer from 0 to '+MAX_ZOOM+'.');
    const n=Math.pow(2,z);
    if(!Number.isInteger(x)||!Number.isInteger(y)||x<0||y<0||x>=n||y>=n)throw new PMTilesError('bad_tile','Tile x and y must lie inside zoom level '+z+'.');
    const xy=[x,y];let d=0;
    for(let s=n/2;s>=1;s/=2){
      const rx=(xy[0]&s)>0?1:0,ry=(xy[1]&s)>0?1:0;
      d+=s*s*((3*rx)^ry);
      rotate(s,xy,rx,ry);
    }
    return levelStart[z]+d;
  }
  function tileIdToZxy(id){
    if(!Number.isInteger(id)||id<0)throw new PMTilesError('bad_tile','A tile id is a non-negative integer.');
    for(let z=0;z<=MAX_ZOOM;z++){
      const count=Math.pow(4,z);
      if(id<levelStart[z]+count){
        let t=id-levelStart[z],tx=0,ty=0;const n=Math.pow(2,z);
        for(let s=1;s<n;s*=2){
          const rx=1&(t/2),ry=1&(t^rx);
          const xy=[tx,ty];rotate(s,xy,rx,ry);tx=xy[0]+s*rx;ty=xy[1]+s*ry;
          t=Math.floor(t/4);
        }
        return [z,tx,ty];
      }
    }
    throw new PMTilesError('bad_tile','Tile id is beyond zoom level '+MAX_ZOOM+'.');
  }

  // ---- header --------------------------------------------------------------------------------------------------
  const u64=(dv,o)=>{const lo=dv.getUint32(o,true),hi=dv.getUint32(o+4,true);if(hi>0x1fffff)throw new PMTilesError('bad_header','A header offset is larger than this reader can address.');return hi*4294967296+lo;};

  function parseHeader(bytes){
    if(!bytes||bytes.length<HEADER_BYTES)throw new PMTilesError('not_pmtiles','The file is too short to be a PMTiles archive.');
    for(let i=0;i<MAGIC.length;i++)if(bytes[i]!==MAGIC.charCodeAt(i))throw new PMTilesError('not_pmtiles','This is not a PMTiles file (it does not start with "PMTiles").');
    const dv=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    const version=bytes[7];
    if(version!==3)throw new PMTilesError('unsupported_version','This PMTiles file is version '+version+'. Only version 3 is supported.');
    const e7=o=>dv.getInt32(o,true)/1e7;
    const h={
      specVersion:version,
      rootDirOffset:u64(dv,8),rootDirLength:u64(dv,16),
      metadataOffset:u64(dv,24),metadataLength:u64(dv,32),
      leafDirsOffset:u64(dv,40),leafDirsLength:u64(dv,48),
      tileDataOffset:u64(dv,56),tileDataLength:u64(dv,64),
      numAddressedTiles:u64(dv,72),numTileEntries:u64(dv,80),numTileContents:u64(dv,88),
      clustered:bytes[96]===1,
      internalCompression:bytes[97],tileCompression:bytes[98],tileType:bytes[99],
      minZoom:bytes[100],maxZoom:bytes[101],
      minLon:e7(102),minLat:e7(106),maxLon:e7(110),maxLat:e7(114),
      centerZoom:bytes[118],centerLon:e7(119),centerLat:e7(123)
    };
    h.internalCompressionName=COMPRESSION_NAME[h.internalCompression]||'unknown';
    h.tileCompressionName=COMPRESSION_NAME[h.tileCompression]||'unknown';
    h.tileTypeName=TILE_TYPE_NAME[h.tileType]||'unknown';
    if(h.minZoom>h.maxZoom||h.maxZoom>MAX_ZOOM)throw new PMTilesError('bad_header','The zoom range in the header is not valid.');
    if(!(h.minLon<=h.maxLon&&h.minLat<=h.maxLat)||Math.abs(h.minLat)>90||Math.abs(h.maxLat)>90||Math.abs(h.minLon)>180||Math.abs(h.maxLon)>180)throw new PMTilesError('bad_header','The bounds in the header are not valid.');
    return h;
  }

  /** Fails for anything this reader will not decode, with a reason a person can act on. */
  function checkSupported(h){
    if(h.tileType===TILE_TYPE.mlt)throw new PMTilesError('unsupported_tiles','These tiles are in the newer MapLibre Tile (MLT) format. This app reads Mapbox Vector Tile (MVT) packages only; re-export the package as MVT.');
    if(h.tileType!==TILE_TYPE.mvt)throw new PMTilesError('unsupported_tiles','These tiles are '+h.tileTypeName+', not vector (MVT) tiles. This app draws vector map data only.');
    if(![COMPRESSION.none,COMPRESSION.gzip].includes(h.tileCompression))throw new PMTilesError('unsupported_compression','The tiles are compressed with '+h.tileCompressionName+'. Only gzip or no compression is supported; re-export the package with gzip.');
    if(![COMPRESSION.none,COMPRESSION.gzip].includes(h.internalCompression))throw new PMTilesError('unsupported_compression','The directories are compressed with '+h.internalCompressionName+'. Only gzip or no compression is supported.');
    return true;
  }

  // ---- directories ---------------------------------------------------------------------------------------------
  /** Reads one varint at pos.i. Values up to 2^53 are exact; the format does not need more. */
  function varint(bytes,pos){
    let result=0,mul=1;
    for(let n=0;n<10;n++){
      if(pos.i>=bytes.length)throw new PMTilesError('bad_directory','A directory ends in the middle of a number.');
      const b=bytes[pos.i++];
      result+=(b&0x7f)*mul;
      if(b<0x80)return result;
      mul*=128;
    }
    throw new PMTilesError('bad_directory','A directory contains a number that is too long.');
  }
  /** Entries as {tileId, offset, length, runLength}; runLength 0 marks a pointer to a leaf directory. */
  function parseDirectory(bytes){
    const pos={i:0},n=varint(bytes,pos);
    if(n>5e6)throw new PMTilesError('bad_directory','A directory claims '+n+' entries.');
    const entries=new Array(n);let last=0;
    for(let i=0;i<n;i++){last+=varint(bytes,pos);entries[i]={tileId:last,offset:0,length:0,runLength:1};}
    for(let i=0;i<n;i++)entries[i].runLength=varint(bytes,pos);
    for(let i=0;i<n;i++)entries[i].length=varint(bytes,pos);
    for(let i=0;i<n;i++){
      const v=varint(bytes,pos);
      entries[i].offset=v===0&&i>0?entries[i-1].offset+entries[i-1].length:v-1;
    }
    return entries;
  }
  /** Binary search for the entry that holds a tile id (honouring run lengths), or the leaf pointer that may hold it. */
  function findEntry(entries,tileId){
    let lo=0,hi=entries.length-1;
    while(lo<=hi){
      const mid=(lo+hi)>>1,id=entries[mid].tileId;
      if(id<tileId)lo=mid+1;else if(id>tileId)hi=mid-1;else return entries[mid];
    }
    if(hi>=0){
      const e=entries[hi];
      if(e.runLength===0)return e;                                // a leaf directory covers everything up to the next entry
      if(tileId-e.tileId<e.runLength)return e;
    }
    return null;
  }

  // ---- compression ---------------------------------------------------------------------------------------------
  /** gzip through the platform's DecompressionStream (browsers and Node 18+). */
  async function gunzip(bytes){
    if(typeof DecompressionStream==='undefined')throw new PMTilesError('no_gzip','This browser cannot decompress gzip data (no DecompressionStream).');
    const stream=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  async function decompress(bytes,kind,inflate){
    if(kind===COMPRESSION.none||kind===COMPRESSION.unknown)return bytes;
    if(kind===COMPRESSION.gzip)return (inflate||gunzip)(bytes);
    throw new PMTilesError('unsupported_compression','Compression '+(COMPRESSION_NAME[kind]||kind)+' is not supported.');
  }

  // ---- sources -------------------------------------------------------------------------------------------------
  /** A Blob or File as a byte-range source. Only the requested range is read. */
  function blobSource(blob){
    return {
      size:blob.size,name:blob.name||'',
      async read(offset,length){
        if(offset<0||length<0||offset+length>blob.size)throw new PMTilesError('bad_range','A read beyond the end of the file was requested.');
        return new Uint8Array(await blob.slice(offset,offset+length).arrayBuffer());
      }
    };
  }
  /** A Uint8Array as a source (tests and tiny packages). */
  function bytesSource(bytes){
    return {size:bytes.length,name:'',async read(offset,length){if(offset<0||length<0||offset+length>bytes.length)throw new PMTilesError('bad_range','A read beyond the end of the data was requested.');return bytes.subarray(offset,offset+length);}};
  }

  // ---- the reader ----------------------------------------------------------------------------------------------
  /**
   * Opens an archive. Directories read so far are kept (at most `dirCache` of them). `stats` counts what was really read,
   * which is how the tests show that opening and reading a tile touches a few kilobytes, not the file.
   */
  async function open(source,{inflate,dirCache=48}={}){
    const stats={reads:0,bytesRead:0,tilesRead:0,directoriesRead:0};
    const read=async(offset,length)=>{stats.reads++;stats.bytesRead+=length;return source.read(offset,length);};
    const header=parseHeader(await read(0,Math.min(HEADER_BYTES,source.size)));
    checkSupported(header);
    for(const [name,off,len] of [['root directory',header.rootDirOffset,header.rootDirLength],['metadata',header.metadataOffset,header.metadataLength],['leaf directories',header.leafDirsOffset,header.leafDirsLength],['tile data',header.tileDataOffset,header.tileDataLength]])
      if(off+len>source.size)throw new PMTilesError('truncated','The file is shorter than its header says (the '+name+' runs past the end). It may be an incomplete download.');
    const dirs=new Map();
    async function directory(offset,length,leaf){
      const key=(leaf?'L':'R')+offset+':'+length;
      if(dirs.has(key)){const d=dirs.get(key);dirs.delete(key);dirs.set(key,d);return d;}
      const base=leaf?header.leafDirsOffset:header.rootDirOffset;
      const raw=await read(base+offset,length);
      stats.directoriesRead++;
      const entries=parseDirectory(await decompress(raw,header.internalCompression,inflate));
      dirs.set(key,entries);
      while(dirs.size>dirCache)dirs.delete(dirs.keys().next().value);
      return entries;
    }
    let metadata;
    return {
      header,source,stats,
      async metadata(){
        if(metadata!==undefined)return metadata;
        if(!header.metadataLength){metadata={};return metadata;}
        const raw=await decompress(await read(header.metadataOffset,header.metadataLength),header.internalCompression,inflate);
        try{metadata=JSON.parse(new TextDecoder().decode(raw));}catch{metadata={};}
        return metadata;
      },
      /** The raw (still tile-compressed) bytes of a tile, or null if the archive has none there. */
      async tileBytes(z,x,y){
        if(z<header.minZoom||z>header.maxZoom)return null;
        const id=zxyToTileId(z,x,y);
        let offset=0,length=header.rootDirLength,leaf=false;       // the root directory is read relative to its own start
        for(let depth=0;depth<4;depth++){
          const entries=await directory(offset,length,leaf);
          const e=findEntry(entries,id);
          if(!e)return null;
          if(e.runLength>0){
            if(e.offset+e.length>header.tileDataLength)throw new PMTilesError('truncated','A tile points beyond the end of the tile data.');
            stats.tilesRead++;
            return read(header.tileDataOffset+e.offset,e.length);
          }
          offset=e.offset;length=e.length;leaf=true;
        }
        throw new PMTilesError('bad_directory','Directories nest deeper than the format allows.');
      },
      /** A decompressed MVT tile, or null. */
      async getTile(z,x,y){
        const raw=await this.tileBytes(z,x,y);
        return raw?decompress(raw,header.tileCompression,inflate):null;
      }
    };
  }

  /**
   * Describes an archive for the "Map data" list without keeping it open: bounds, zoom range, size, what its own metadata
   * says about name and attribution. Reads the header and the metadata block only.
   */
  /** Credits are often written as HTML ("&copy; <a href=...>OpenStreetMap</a> contributors"); the app shows them as plain text. */
  const ENTITIES={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ',copy:'\u00a9',reg:'\u00ae'};
  function plainText(html){
    return html.replace(/<[^>]*>/g,'').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,(m,e)=>{
      if(e[0]==='#'){const code=e[1]==='x'||e[1]==='X'?parseInt(e.slice(2),16):parseInt(e.slice(1),10);return code>0&&code<0x110000&&!(code>=0xd800&&code<=0xdfff)?String.fromCodePoint(code):m;}
      const v=ENTITIES[e.toLowerCase()];return v===undefined?m:v;
    }).replace(/\s+/g,' ').trim();
  }
  async function describe(source,options){
    const r=await open(source,options),m=await r.metadata(),h=r.header;
    return {
      name:String(m.name||source.name||'Map data package').slice(0,120),
      description:m.description?String(m.description).slice(0,400):'',
      attribution:m.attribution?plainText(String(m.attribution)).slice(0,400):'',
      licenseNote:m.meta_trace&&m.meta_trace.license?String(m.meta_trace.license).slice(0,300):'',
      synthetic:!!(m.meta_trace&&m.meta_trace.synthetic),
      version:m.version?String(m.version).slice(0,40):'',
      layers:Array.isArray(m.vector_layers)?m.vector_layers.map(l=>String(l.id)).slice(0,30):[],
      bounds:[h.minLon,h.minLat,h.maxLon,h.maxLat],minZoom:h.minZoom,maxZoom:h.maxZoom,
      tiles:h.numAddressedTiles,bytes:source.size,clustered:h.clustered,
      tileCompression:h.tileCompressionName,reads:r.stats.reads,bytesRead:r.stats.bytesRead
    };
  }

  return {open,describe,plainText,parseHeader,checkSupported,parseDirectory,findEntry,zxyToTileId,tileIdToZxy,gunzip,blobSource,bytesSource,PMTilesError,HEADER_BYTES,COMPRESSION,TILE_TYPE};
});
