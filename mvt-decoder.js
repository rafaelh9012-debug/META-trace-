/*
 * Mapbox Vector Tile (MVT, vector_tile.proto version 2.1) decoder.
 *
 * Regional map packages are PMTiles archives of gzip-compressed vector tiles. This reads one decompressed tile:
 * protocol-buffer wire format, string/number key tables, and the command-integer geometry encoding
 * (MoveTo / LineTo / ClosePath with zigzag deltas). Nothing here knows about any particular map schema.
 *
 * Output geometry is held in typed arrays so a dense city tile does not become a hundred thousand small arrays:
 *   POINT       Int32Array [x0,y0, x1,y1, ...]                (a multipoint is simply more pairs)
 *   LINESTRING  array of Int32Array lines [x0,y0, x1,y1, ...]
 *   POLYGON     array of Int32Array rings, first vertex not repeated (the ring is closed implicitly)
 * Coordinates are tile units (0..extent, y down); values outside that range are the tile's buffer.
 */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.MVTDecoder=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';

  class MVTError extends Error{constructor(code,message){super(message);this.name='MVTError';this.code=code;}}
  const GEOM={UNKNOWN:0,POINT:1,LINESTRING:2,POLYGON:3};
  const GEOM_NAME=['unknown','point','linestring','polygon'];
  const MAX_TILE_BYTES=64*1024*1024;
  const TWO32=4294967296;

  /** Wire-format reader over a Uint8Array window. Varints are returned as numbers (exact up to 2^53). */
  class Wire{
    constructor(buf,start=0,end=buf.length){this.buf=buf;this.pos=start;this.end=end;}
    get done(){return this.pos>=this.end;}
    /** Reads a varint as {lo,hi} 32-bit halves in the scratch fields lo/hi; returns lo + hi*2^32 as an unsigned number. */
    varint(){
      let lo=0,hi=0,shift=0,b;
      do{
        if(this.pos>=this.end)throw new MVTError('truncated','The tile ends in the middle of a number.');
        b=this.buf[this.pos++];
        if(shift<28)lo|=(b&0x7f)<<shift;
        else if(shift===28){lo|=(b&0x0f)<<28;hi|=(b&0x7f)>>4;}
        else if(shift<=63)hi|=(b&0x7f)<<(shift-32);
        shift+=7;
        if(shift>70)throw new MVTError('bad_varint','A number in the tile is longer than 64 bits.');
      }while(b&0x80);
      this.lo=lo>>>0;this.hi=hi>>>0;
      return this.hi*TWO32+this.lo;
    }
    /** A uint32 (lengths, keys, commands): the low half only, after checking nothing was dropped. */
    u32(){const v=this.varint();if(this.hi!==0)throw new MVTError('bad_varint','A 32-bit field holds a larger number.');return v;}
    /** int64 two's complement. */
    int64(){this.varint();return signed(this.lo,this.hi);}
    /** sint64 zigzag. */
    sint64(){
      this.varint();
      let lo=((this.lo>>>1)|((this.hi&1)<<31))>>>0,hi=this.hi>>>1;
      if(this.lo&1){lo=(~lo)>>>0;hi=(~hi)>>>0;}
      return signed(lo,hi);
    }
    bytes(){const n=this.u32();if(this.pos+n>this.end)throw new MVTError('truncated','A field is longer than the tile.');const s=this.pos;this.pos+=n;return [s,s+n];}
    string(){const [s,e]=this.bytes();return utf8(this.buf,s,e);}
    float(){if(this.pos+4>this.end)throw new MVTError('truncated','The tile ends in the middle of a number.');const v=new DataView(this.buf.buffer,this.buf.byteOffset+this.pos,4).getFloat32(0,true);this.pos+=4;return v;}
    double(){if(this.pos+8>this.end)throw new MVTError('truncated','The tile ends in the middle of a number.');const v=new DataView(this.buf.buffer,this.buf.byteOffset+this.pos,8).getFloat64(0,true);this.pos+=8;return v;}
    skip(wireType){
      switch(wireType){
        case 0:this.varint();break;
        case 1:if(this.pos+8>this.end)throw new MVTError('truncated','The tile ends in the middle of a field.');this.pos+=8;break;
        case 2:this.bytes();break;
        case 5:if(this.pos+4>this.end)throw new MVTError('truncated','The tile ends in the middle of a field.');this.pos+=4;break;
        default:throw new MVTError('bad_wire_type','The tile uses a field type ('+wireType+') that protocol buffers do not define.');
      }
    }
  }
  function signed(lo,hi){
    if(hi<0x80000000)return hi*TWO32+lo;
    // negative: -( (~hi,~lo) + 1 )
    const nlo=(~lo)>>>0,nhi=(~hi)>>>0;
    return -(nhi*TWO32+nlo+1);
  }

  const decoder=typeof TextDecoder==='function'?new TextDecoder('utf-8'):null;
  function utf8(buf,s,e){
    if(decoder)return decoder.decode(buf.subarray(s,e));
    let out='';for(let i=s;i<e;){const c=buf[i++];if(c<128)out+=String.fromCharCode(c);else if(c<224)out+=String.fromCharCode((c&31)<<6|buf[i++]&63);else if(c<240)out+=String.fromCharCode((c&15)<<12|(buf[i++]&63)<<6|buf[i++]&63);else{const cp=((c&7)<<18|(buf[i++]&63)<<12|(buf[i++]&63)<<6|buf[i++]&63)-0x10000;out+=String.fromCharCode(0xd800+(cp>>10),0xdc00+(cp&1023));}}
    return out;
  }

  function readValue(buf,s,e){
    const r=new Wire(buf,s,e);let v=null;
    while(!r.done){
      const tag=r.u32(),field=tag>>>3,wt=tag&7;
      switch(field){
        case 1:if(wt!==2){r.skip(wt);break;}v=r.string();break;
        case 2:if(wt!==5){r.skip(wt);break;}v=r.float();break;
        case 3:if(wt!==1){r.skip(wt);break;}v=r.double();break;
        case 4:if(wt!==0){r.skip(wt);break;}v=r.int64();break;
        case 5:if(wt!==0){r.skip(wt);break;}v=r.varint();break;
        case 6:if(wt!==0){r.skip(wt);break;}v=r.sint64();break;
        case 7:if(wt!==0){r.skip(wt);break;}v=r.varint()!==0;break;
        default:r.skip(wt);
      }
    }
    return v;
  }

  /**
   * Geometry command stream to typed arrays. `type` selects the output shape (see the header).
   * Throws MVTError('bad_geometry') on a stream that cannot be decoded; callers may skip that one feature.
   */
  function decodeGeometry(type,geom){
    const n=geom.length;
    let i=0,x=0,y=0;
    const points=[],lines=[];
    let cur=null;
    const flush=()=>{if(cur&&cur.length){lines.push(Int32Array.from(cur));}cur=null;};
    while(i<n){
      const cmdInt=geom[i++],cmd=cmdInt&7,count=cmdInt>>>3;
      if(cmd===1||cmd===2){
        if(i+count*2>n)throw new MVTError('bad_geometry','A geometry command asks for more coordinates than the feature has.');
        for(let k=0;k<count;k++){
          const dx=geom[i++],dy=geom[i++];
          x+=(dx>>>1)^-(dx&1);y+=(dy>>>1)^-(dy&1);
          if(cmd===1){
            if(type===GEOM.POINT){points.push(x,y);}
            else{flush();cur=[x,y];}
          }else{
            if(!cur)throw new MVTError('bad_geometry','A line continues before it has started.');
            cur.push(x,y);
          }
        }
      }else if(cmd===7){
        if(count!==1)throw new MVTError('bad_geometry','ClosePath must have a count of one.');
        if(!cur)throw new MVTError('bad_geometry','A ring is closed before it has started.');
        flush();                       // a polygon ring: closed implicitly, the first vertex is not repeated
      }else throw new MVTError('bad_geometry','Unknown geometry command '+cmd+'.');
    }
    flush();
    if(type===GEOM.POINT)return Int32Array.from(points);
    return lines;
  }

  /** Signed area of a ring in tile units (positive = exterior in the MVT convention, y pointing down). */
  function ringArea(ring){
    let a=0;const n=ring.length/2;
    for(let i=0,j=n-1;i<n;j=i++)a+=(ring[j*2]*ring[i*2+1]-ring[i*2]*ring[j*2+1]);
    return a/2;
  }
  /** Groups a polygon feature's rings into polygons: each exterior ring starts one, the interior rings after it belong to it. */
  function groupPolygons(rings){
    const out=[];
    for(const r of rings){
      const area=ringArea(r);
      if(area>0||!out.length)out.push([r]);
      else if(area<0)out[out.length-1].push(r);
    }
    return out;
  }

  function decodeFeature(buf,s,e,layer,wantFeature){
    const r=new Wire(buf,s,e);
    let id,type=0,tagsRange=null,geomRange=null;
    while(!r.done){
      const tag=r.u32(),field=tag>>>3,wt=tag&7;
      if(field===1&&wt===0)id=r.varint();
      else if(field===2&&wt===2)tagsRange=r.bytes();
      else if(field===3&&wt===0)type=r.u32();
      else if(field===4&&wt===2)geomRange=r.bytes();
      else r.skip(wt);
    }
    return {id,type,tagsRange,geomRange};
  }
  function packedU32(buf,range){
    const r=new Wire(buf,range[0],range[1]),out=[];
    while(!r.done)out.push(r.u32());
    return out;
  }

  /**
   * Decodes a tile.
   * options.layers: an array or Set of layer names to decode (others are skipped without being parsed); default all.
   * Returns {layers: [{name, version, extent, features: [{id, type, typeName, props, geometry}]}], skipped}
   * where `skipped` counts features dropped for unreadable geometry.
   */
  function decodeTile(bytes,options={}){
    if(!(bytes instanceof Uint8Array))throw new MVTError('bad_input','A tile must be a Uint8Array.');
    if(bytes.length>MAX_TILE_BYTES)throw new MVTError('too_large','The tile is larger than '+(MAX_TILE_BYTES>>20)+' MiB once decompressed.');
    const want=options.layers?new Set(options.layers):null;
    const out={layers:[],skipped:0};
    const r=new Wire(bytes);
    while(!r.done){
      const tag=r.u32(),field=tag>>>3,wt=tag&7;
      if(field===3&&wt===2){
        const [s,e]=r.bytes(),layer=decodeLayer(bytes,s,e,want);
        if(layer){out.layers.push(layer);out.skipped+=layer.skipped;}
      }else r.skip(wt);
    }
    return out;
  }

  function decodeLayer(buf,s,e,want){
    const r=new Wire(buf,s,e);
    let name='',version=1,extent=4096;const keys=[],values=[],featureRanges=[];
    // The layer name may come after the features in a legal encoding, so everything is gathered first.
    while(!r.done){
      const tag=r.u32(),field=tag>>>3,wt=tag&7;
      if(field===1&&wt===2)name=r.string();
      else if(field===2&&wt===2)featureRanges.push(r.bytes());
      else if(field===3&&wt===2)keys.push(r.string());
      else if(field===4&&wt===2){const [vs,ve]=r.bytes();values.push(readValue(buf,vs,ve));}
      else if(field===5&&wt===0)extent=r.u32();
      else if(field===15&&wt===0)version=r.u32();
      else r.skip(wt);
    }
    if(want&&!want.has(name))return null;
    if(version!==1&&version!==2)throw new MVTError('unsupported_version','Layer "'+name+'" is vector tile version '+version+'; versions 1 and 2 are supported.');
    if(!(extent>0&&extent<=1<<24))throw new MVTError('bad_extent','Layer "'+name+'" has an extent of '+extent+'.');
    const features=[];let skipped=0;
    for(const [fs,fe] of featureRanges){
      const f=decodeFeature(buf,fs,fe);
      if(!f.geomRange||f.type<1||f.type>3){skipped++;continue;}
      let geometry;
      try{geometry=decodeGeometry(f.type,packedU32(buf,f.geomRange));}catch(error){if(error instanceof MVTError&&error.code==='bad_geometry'){skipped++;continue;}throw error;}
      const props={};
      if(f.tagsRange){
        const t=packedU32(buf,f.tagsRange);
        for(let k=0;k+1<t.length;k+=2){const key=keys[t[k]],val=values[t[k+1]];if(key!==undefined&&val!==undefined&&val!==null)props[key]=val;}
      }
      features.push({id:f.id,type:f.type,typeName:GEOM_NAME[f.type],props,geometry});
    }
    return {name,version,extent,features,skipped};
  }

  return {decodeTile,decodeGeometry,ringArea,groupPolygons,MVTError,GEOM,GEOM_NAME,MAX_TILE_BYTES};
});
