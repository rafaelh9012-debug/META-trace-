/*
 * Globe data: turns the inline world pack (see tools/build_globe_pack.py) into geometry the globe can draw quickly.
 *
 * Every vertex comes from the pack. Edges are subdivided so a long straight edge follows the sphere, but a subdivided
 * point lies exactly on the original edge in Web Mercator space, which is how the flat map (trace-canvas-layer.js) draws
 * the same edge. That keeps the globe and the flat map on top of each other at the hand-off.
 *
 * Polylines are cut into short chunks and every chunk and ring carries a bounding cap (centre and angular radius), so
 * a frame only touches the geometry that can be on screen. Memory is one Float32Array per chunk: unit vectors, x y z.
 */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.GlobeData=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';

  const D2R=Math.PI/180,MAX_MERC=85.05112878;
  const mercY=lat=>Math.log(Math.tan(Math.PI/4+Math.max(-MAX_MERC,Math.min(MAX_MERC,lat))*D2R/2));
  const invMercY=y=>(2*Math.atan(Math.exp(y))-Math.PI/2)/D2R;

  /** Unit vector of a longitude/latitude pair written into `out` at `i`. */
  function put(out,i,lat,lon){
    const p=lat*D2R,l=lon*D2R,c=Math.cos(p);out[i]=c*Math.cos(l);out[i+1]=c*Math.sin(l);out[i+2]=Math.sin(p);
  }

  /**
   * Subdivides one polyline given as flat integer pairs (x = lon, y = lat, in 1/precision degree) into unit vectors.
   * Returns a Float32Array of x y z triples, or null when there are fewer than two points.
   */
  function densify(flat,precision,maxStepDeg){
    const n=flat.length>>1;if(n<2)return null;
    const pts=[];
    let lon0=flat[0]/precision,lat0=flat[1]/precision;
    const first=new Float32Array(3);put(first,0,lat0,lon0);pts.push(first[0],first[1],first[2]);
    for(let i=1;i<n;i++){
      const lon1=flat[2*i]/precision,lat1=flat[2*i+1]/precision;
      let dl=lon1-lon0;if(dl>180)dl-=360;else if(dl<-180)dl+=360;
      const useMerc=Math.abs(lat0)<=MAX_MERC&&Math.abs(lat1)<=MAX_MERC;
      const y0=useMerc?mercY(lat0):lat0,y1=useMerc?mercY(lat1):lat1;
      const dy=useMerc?Math.abs(y1-y0)/D2R:Math.abs(lat1-lat0),span=Math.max(Math.abs(dl),dy),steps=Math.max(1,Math.ceil(span/maxStepDeg));   // a latitude step is never larger than its Mercator step, so both bounds hold
      const tmp=new Float32Array(3);
      for(let s=1;s<=steps;s++){
        const t=s/steps,lon=s===steps?lon1:lon0+dl*t,lat=s===steps?lat1:(useMerc?invMercY(y0+(y1-y0)*t):y0+(y1-y0)*t);
        put(tmp,0,lat,lon);pts.push(tmp[0],tmp[1],tmp[2]);
      }
      lon0=lon1;lat0=lat1;
    }
    return Float32Array.from(pts);
  }

  /** Bounding cap of a vertex array: unit centre and the cosine of its angular radius. */
  function cap(xyz){
    let sx=0,sy=0,sz=0;const n=xyz.length/3;
    for(let i=0;i<xyz.length;i+=3){sx+=xyz[i];sy+=xyz[i+1];sz+=xyz[i+2];}
    let len=Math.hypot(sx,sy,sz);
    if(len<1e-6){sx=xyz[0];sy=xyz[1];sz=xyz[2];len=1;}   // a ring around the world: any vertex is as good a centre as another
    sx/=len;sy/=len;sz/=len;
    let min=1;
    for(let i=0;i<xyz.length;i+=3){const d=xyz[i]*sx+xyz[i+1]*sy+xyz[i+2]*sz;if(d<min)min=d;}
    return {cx:sx,cy:sy,cz:sz,cosR:Math.max(-1,min-1e-6),n};
  }

  function chunkLine(xyz,size){
    const n=xyz.length/3,out=[];
    for(let a=0;a<n-1;a+=size-1){
      const b=Math.min(n,a+size);
      const part=xyz.subarray(a*3,b*3);
      out.push({xyz:part,...cap(part)});
      if(b>=n)break;
    }
    return out;
  }

  /**
   * Decodes a pack. Options: maxStepDeg (edge subdivision, default 2), chunk (vertices per polyline chunk, default 96).
   * Unknown layers and malformed entries are skipped rather than trusted.
   */
  function load(pack,options={}){
    if(!pack||pack.format!=='meta-trace-globe-pack'||!pack.layers)return null;
    const precision=pack.precision||10000,step=options.maxStepDeg||2,chunk=options.chunk||96;
    const out={scale:pack.scale||'',attribution:pack.attribution||'',layers:{},places:[],countries:[],stats:{vertices:0,rings:0,chunks:0}};
    for(const [name,layer] of Object.entries(pack.layers)){
      if(!layer)continue;
      if(layer.kind==='polygon'){
        const rings=[];
        for(const flat of layer.rings||[]){
          const xyz=densify(flat,precision,step);if(!xyz||xyz.length<12)continue;
          rings.push({xyz,...cap(xyz)});out.stats.vertices+=xyz.length/3;
        }
        out.layers[name]={kind:'polygon',rings};out.stats.rings+=rings.length;
      }else if(layer.kind==='line'){
        const chunks=[];
        (layer.lines||[]).forEach((flat,i)=>{
          const xyz=densify(flat,precision,step);if(!xyz)return;
          const rank=layer.ranks?layer.ranks[i]:0;
          for(const c of chunkLine(xyz,chunk)){c.rank=rank;chunks.push(c);}
          out.stats.vertices+=xyz.length/3;
        });
        out.layers[name]={kind:'line',chunks};out.stats.chunks+=chunks.length;
      }else if(layer.kind==='point'&&name==='places'){
        for(const it of layer.items||[]){
          const [lon,lat,text,cc,rank,pop]=it;if(!Number.isFinite(lat)||!Number.isFinite(lon)||!text)continue;
          const v=new Float32Array(3);put(v,0,lat,lon);
          out.places.push({lat,lon,text,cc,rank:rank===undefined?5:rank,pop:pop||0,x:v[0],y:v[1],z:v[2]});
        }
        out.placesBasis=layer.basis||'';
      }
    }
    for(const it of pack.countryLabels||[]){
      const [lon,lat,text,pop]=it;if(!Number.isFinite(lat)||!Number.isFinite(lon)||!text)continue;
      const v=new Float32Array(3);put(v,0,lat,lon);out.countries.push({lat,lon,text,pop:pop||0,x:v[0],y:v[1],z:v[2]});
    }
    return out;
  }

  return {load,densify,cap,chunkLine,mercY,invMercY,MAX_MERC};
});
