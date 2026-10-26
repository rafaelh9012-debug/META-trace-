/*
 * Region manager: which map-package tiles are needed for the view, loading them a few at a time, and remembering the
 * recent ones within a fixed budget.
 *
 * A package is an opened PMTiles archive (see pmtiles-reader.js). Nothing is ever loaded whole: for the current view the
 * manager works out the handful of tiles it needs, asks the reader for each one (a range read of a few kilobytes), decodes
 * and adapts it, and keeps the result in a bounded least-recently-used cache. Loading is asynchronous and one tile at a
 * time per slot, so the camera never waits for it: the canvas layer draws what is ready and is told to redraw as more arrives.
 *
 * Tile zoom follows the map zoom (one level finer than the map zoom, rounded). When the zoom crosses a level the new set
 * replaces the old one as a whole, once it is all in, so the picture never shows a mix of two detail levels or a hole.
 *
 * This module has no DOM. The canvas layer owns drawing; this owns "what, when, and how much".
 */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.RegionManager=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';

  const TILE=256;
  const DEFAULTS={maxTiles:220,maxBytes:56*1024*1024,concurrency:2,maxViewTiles:96,swapTimeoutMs:900,errorRetryMs:30000,minMapZoom:9};

  const lonToX=(lon,z)=>(lon+180)/360*Math.pow(2,z);
  const latToY=(lat,z)=>{const s=Math.sin(Math.max(-85.05112878,Math.min(85.05112878,lat))*Math.PI/180);return (0.5-Math.log((1+s)/(1-s))/(4*Math.PI))*Math.pow(2,z);};
  const xToLon=(x,z)=>x/Math.pow(2,z)*360-180;
  const yToLat=(y,z)=>{const n=Math.PI-2*Math.PI*y/Math.pow(2,z);return 180/Math.PI*Math.atan(.5*(Math.exp(n)-Math.exp(-n)));};
  const wrapX=(x,z)=>{const n=Math.pow(2,z);return ((x%n)+n)%n;};
  const area=b=>Math.max(0,b[2]-b[0])*Math.max(0,b[3]-b[1]);
  const within=(b,lat,lon)=>lon>=b[0]&&lon<=b[2]&&lat>=b[1]&&lat<=b[3];

  function create(options){
    const cfg={...DEFAULTS,...options};
    const decode=cfg.decode,adapt=cfg.adapt;
    const now=cfg.now||(()=>Date.now());
    const later=cfg.schedule||(fn=>setTimeout(fn,0));
    const notify=cfg.onChange||(()=>{});
    const report=cfg.onError||(()=>{});

    const pkgs=new Map();                 // id -> {id,name,reader,info,order}
    const tiles=new Map();                // "id|z|x|y" -> entry
    const queue=[];                       // entries waiting to load, nearest to the view first
    let active=0,generation=0,serial=0,bytes=0,pending=false,notifyTimer=0;
    let lastNeeded=null,stable=null;
    const stats={loaded:0,empty:0,failed:0,evicted:0,tileBytesRead:0,decodeMs:0,adaptMs:0,readMs:0,maxLoadMs:0,lastLoadMs:0,decoded:0,droppedFeatures:0};
    const key=(id,z,x,y)=>id+'|'+z+'|'+x+'|'+y;

    // ---- packages --------------------------------------------------------------------------
    function addPackage(pkg){
      if(!pkg||!pkg.id||!pkg.reader||!pkg.info)throw new Error('A package needs an id, a reader and its description.');
      const b=pkg.info.bounds;
      if(!Array.isArray(b)||b.length!==4||!b.every(Number.isFinite))throw new Error('A package needs bounds [west, south, east, north].');
      pkgs.set(pkg.id,{...pkg,order:++serial});
      stable=null;lastNeeded=null;notifyNow();
      return pkg.id;
    }
    function removePackage(id){
      if(!pkgs.delete(id))return false;
      for(const [k,e] of [...tiles])if(e.pkg===id)drop(k,e);
      for(let i=queue.length-1;i>=0;i--)if(queue[i].pkg===id)queue.splice(i,1);
      stable=null;pendingLevel=null;lastNeeded=null;generation++;notifyNow();
      return true;
    }
    /** Most specific first: a smaller coverage area wins, then the one installed later. */
    const ordered=()=>[...pkgs.values()].sort((a,b)=>area(a.info.bounds)-area(b.info.bounds)||b.order-a.order);
    const packages=()=>ordered().map(p=>({id:p.id,name:p.name,...p.info}));
    const coverageBoxes=()=>[...pkgs.values()].map(p=>p.info.bounds);
    function covers(lat,lon){
      for(const p of ordered())if(within(p.info.bounds,lat,lon))return p;
      return null;
    }
    const packageFor=(z,x,y)=>{
      const lat=yToLat(y+.5,z),lon=xToLon(x+.5,z);
      for(const p of ordered())if(z>=p.info.minZoom&&within(p.info.bounds,lat,lon))return p;
      for(const p of ordered())if(tileTouches(p.info.bounds,z,x,y))return p;
      return null;
    };
    function tileTouches(b,z,x,y){
      const w=xToLon(x,z),e=xToLon(x+1,z),n=yToLat(y,z),s=yToLat(y+1,z);
      return e>=b[0]&&w<=b[2]&&n>=b[1]&&s<=b[3];
    }

    // ---- what the view needs ----------------------------------------------------------------
    /** The tile zoom for a map zoom: one finer than the rounded map zoom, within what the package holds. */
    function tileZoomFor(mapZoom,info){return Math.max(info.minZoom,Math.min(info.maxZoom,Math.round(mapZoom)-1));}

    /**
     * The tiles that cover a view. view = {zoom, west, south, east, north} in degrees (west/east may run past ±180).
     * Returns {tz, list:[{z,x,y,shift,pkg}]} where shift is the world copy (0, ±256, ...) the tile is drawn in.
     */
    function needed(view){
      if(!pkgs.size||view.zoom<cfg.minMapZoom)return {tz:null,list:[]};
      const out=[];let tzUsed=null;
      for(const p of ordered()){
        // A package sits in the world copy at 0; a view past +/-180 degrees overlaps its copy one world to the side.
        for(const off of [-360,0,360]){
          const b=[p.info.bounds[0]+off,p.info.bounds[1],p.info.bounds[2]+off,p.info.bounds[3]];
          if(view.east<b[0]-1||view.west>b[2]+1)continue;
          let tz=tileZoomFor(view.zoom,p.info),range=null;
          for(;;){
            const pad=360/Math.pow(2,tz);
            const w=Math.max(view.west,b[0]-pad),e=Math.min(view.east,b[2]+pad);
            const s=Math.max(view.south,b[1]-pad),n=Math.min(view.north,b[3]+pad);
            if(w>e||s>n){range=null;break;}
            const x0=Math.floor(lonToX(w,tz)),x1=Math.floor(lonToX(e,tz)),y0=Math.floor(latToY(n,tz)),y1=Math.floor(latToY(s,tz));
            if((x1-x0+1)*(y1-y0+1)>cfg.maxViewTiles&&tz>p.info.minZoom){tz--;continue;}
            range={x0,x1,y0,y1};break;
          }
          if(!range)continue;
          tzUsed=tzUsed===null?tz:Math.min(tzUsed,tz);
          const n2=Math.pow(2,tz);
          for(let y=Math.max(0,range.y0);y<=Math.min(n2-1,range.y1);y++)for(let x=range.x0;x<=range.x1;x++){
            const wx=wrapX(x,tz),shift=Math.floor(x/n2)*TILE;
            const owner=packageFor(tz,wx,y);
            if(!owner||owner.id!==p.id)continue;                    // a more specific package already covers this tile
            out.push({z:tz,x:wx,y,shift,pkg:p.id});
          }
        }
      }
      return {tz:tzUsed,list:out};
    }

    // ---- loading ----------------------------------------------------------------------------
    function distanceKey(view){const cx=(view.west+view.east)/2,cy=(view.south+view.north)/2;return t=>Math.hypot(xToLon(t.x+.5,t.z)-cx,yToLat(t.y+.5,t.z)-cy);}

    /** True when a tile that failed has waited long enough to be tried again. */
    function retryDue(req){
      if(!stats.failed)return false;
      const t=now();
      for(const tl of req.list){const e=tiles.get(key(tl.pkg,tl.z,tl.x,tl.y));if(e&&e.state==='error'&&t-e.errorAt>=cfg.errorRetryMs)return true;}
      return false;
    }
    /** Asks for the tiles a view needs. Cheap when nothing changed. */
    function ensure(view){
      const n=needed(view);
      const sig=n.list.length?n.tz+'|'+n.list.map(t=>t.pkg+t.x+','+t.y+','+t.shift).join(';'):'none';
      if(lastNeeded&&lastNeeded.sig===sig&&!retryDue(lastNeeded))return lastNeeded;
      lastNeeded={sig,tz:n.tz,list:n.list,at:now()};
      generation++;
      for(const q of queue)if(q.state==='queued')q.state='new';       // not started, no longer assumed wanted: asked for again below if it still is
      queue.length=0;
      const dist=distanceKey(view),t=now();
      const want=[];
      for(const tile of n.list){
        const k=key(tile.pkg,tile.z,tile.x,tile.y);let e=tiles.get(k);
        if(!e){e={k,pkg:tile.pkg,z:tile.z,x:tile.x,y:tile.y,state:'new',model:null,bytes:0,used:t,errorAt:0};tiles.set(k,e);}
        e.used=t;
        if(e.state==='new'||(e.state==='error'&&t-e.errorAt>=cfg.errorRetryMs))want.push(e);
      }
      want.sort((a,b)=>dist(a)-dist(b));
      for(const e of want){e.state='queued';queue.push(e);}
      pump();
      return lastNeeded;
    }
    function pump(){
      while(active<cfg.concurrency&&queue.length){
        const e=queue.shift();
        if(e.state!=='queued'||!pkgs.has(e.pkg))continue;
        active++;e.state='loading';
        load(e).finally(()=>{active--;pump();});
      }
    }
    async function load(e){
      const p=pkgs.get(e.pkg),t0=now();
      try{
        const data=await p.reader.getTile(e.z,e.x,e.y);
        if(!pkgs.has(e.pkg)){tiles.delete(e.k);return;}
        const t1=now();stats.readMs+=t1-t0;
        if(!data||!data.length){e.state='empty';e.model=null;stats.empty++;tidy();notifySoon();return;}
        stats.tileBytesRead+=data.length;
        await new Promise(r=>later(r));                           // decode between frames, not inside one
        if(!pkgs.has(e.pkg)){tiles.delete(e.k);return;}
        const t2=now(),decoded=decode(data,p.layers?{layers:p.layers}:{});
        const t3=now(),model=adapt(decoded,{z:e.z,x:e.x,y:e.y});
        const t4=now();
        stats.decodeMs+=t3-t2;stats.adaptMs+=t4-t3;stats.decoded++;stats.droppedFeatures+=model.stats.dropped;
        e.model=model;e.bytes=model.bytes+256;e.state='ready';bytes+=e.bytes;stats.loaded++;
        const ms=t4-t0;stats.lastLoadMs=ms;if(ms>stats.maxLoadMs)stats.maxLoadMs=ms;
        tidy();notifySoon();
      }catch(error){
        e.state='error';e.errorAt=now();e.model=null;stats.failed++;
        try{report(e.pkg,error);}catch{}
        notifySoon();
      }
    }
    function drop(k,e){if(e.state==='ready')bytes-=e.bytes;tiles.delete(k);}
    /** Keeps the cache inside its budget by dropping the least recently used tiles that the view does not need. */
    function tidy(){
      if(tiles.size<=cfg.maxTiles&&bytes<=cfg.maxBytes)return;
      const keep=new Set();
      if(lastNeeded)for(const t of lastNeeded.list)keep.add(key(t.pkg,t.z,t.x,t.y));
      if(stable)for(const t of stable.list)keep.add(key(t.pkg,t.z,t.x,t.y));
      const old=[...tiles.values()].filter(e=>!keep.has(e.k)&&e.state!=='loading'&&e.state!=='queued').sort((a,b)=>a.used-b.used);
      for(const e of old){
        if(tiles.size<=cfg.maxTiles*.85&&bytes<=cfg.maxBytes*.85)break;
        drop(e.k,e);stats.evicted++;
      }
    }
    function notifySoon(){
      if(notifyTimer)return;
      notifyTimer=1;later(()=>{notifyTimer=0;try{notify();}catch(error){report(null,error);}});
    }
    function notifyNow(){try{notify();}catch(error){report(null,error);}}

    // ---- what to draw ------------------------------------------------------------------------
    const settled=e=>!!e&&(e.state==='ready'||e.state==='empty'||e.state==='error');
    const readyOf=list=>{
      const out=[];
      for(const t of list){const e=tiles.get(key(t.pkg,t.z,t.x,t.y));if(e&&e.state==='ready')out.push({model:e.model,shift:t.shift,z:t.z,x:t.x,y:t.y,pkg:t.pkg});}
      return out;
    };
    let pendingLevel=null;
    /**
     * The tiles to draw for the view right now: {tiles:[{model,shift}], complete, loading, tz}.
     * Panning at one tile level just draws what is ready. When the zoom crosses to a new level, the previous level stays on
     * screen until every tile of the new one is in (or swapTimeoutMs has passed), so there is never a hole or a mix of levels.
     */
    function drawable(view){
      const req=ensure(view),t=now();
      const done=req.list.every(tl=>settled(tiles.get(key(tl.pkg,tl.z,tl.x,tl.y))));
      if(!req.list.length){stable=null;pendingLevel=null;return {tiles:[],complete:true,loading:false,tz:null};}
      if(done){stable={tz:req.tz,list:req.list};pendingLevel=null;return {tiles:readyOf(req.list),complete:true,loading:false,tz:req.tz};}
      if(!stable||stable.tz===req.tz){if(stable)pendingLevel=null;return {tiles:readyOf(req.list),complete:false,loading:true,tz:req.tz};}
      if(!pendingLevel||pendingLevel.tz!==req.tz)pendingLevel={tz:req.tz,at:t};
      if(t-pendingLevel.at>cfg.swapTimeoutMs){stable={tz:req.tz,list:req.list};pendingLevel=null;return {tiles:readyOf(req.list),complete:false,loading:true,tz:req.tz};}
      return {tiles:readyOf(stable.list),complete:false,loading:true,tz:stable.tz};
    }

    /** Labels of the tiles being drawn that are due at this zoom, without duplicates (neighbouring tiles repeat a road's name). */
    function labels(view,drawn){
      const out=[],seen=new Set();
      const set=drawn||drawable(view).tiles;
      for(const {model} of set)for(const l of model.labels){
        if(view.zoom<l.minZoom)continue;
        const k=l.text+'|'+l.lat.toFixed(4)+'|'+l.lon.toFixed(4);if(seen.has(k))continue;seen.add(k);out.push(l);
      }
      return out;
    }

    /**
     * Whether the loaded tiles hold any feature that touches a view (west/south/east/north in degrees): {settled, tiles, features}.
     * It looks at where the geometry is, not just at whether a tile is non-empty, because a tile is much larger than a five-mile
     * frame. A feature counts when its bounding box touches the view, so the answer errs towards "there is data". It starts no
     * loads and changes nothing on screen; settled is false while any needed tile is still loading.
     */
    function featuresIn(view){
      const n=needed(view);
      const wx0=lonToX(view.west,0)*TILE,wx1=lonToX(view.east,0)*TILE,wy0=latToY(view.north,0)*TILE,wy1=latToY(view.south,0)*TILE;
      let all=true,any=false;
      for(const t of n.list){
        const e=tiles.get(key(t.pkg,t.z,t.x,t.y));
        if(!settled(e)){all=false;continue;}
        if(any||e.state!=='ready')continue;
        const m=e.model,x0=wx0-t.shift-m.ox,x1=wx1-t.shift-m.ox,y0=wy0-m.oy,y1=wy1-m.oy;
        const touches=(a)=>{
          let lx=Infinity,hx=-Infinity,ly=Infinity,hy=-Infinity;
          for(let i=0;i<a.length;i+=2){const x=a[i],y=a[i+1];if(x<lx)lx=x;if(x>hx)hx=x;if(y<ly)ly=y;if(y>hy)hy=y;}
          return hx>=x0&&lx<=x1&&hy>=y0&&ly<=y1;
        };
        for(const p of m.points)if(p.x>=x0&&p.x<=x1&&p.y>=y0&&p.y<=y1){any=true;break;}
        if(any)continue;
        for(const g of m.groups){
          for(const ring of g.fill)if(touches(ring)){any=true;break;}
          if(any)break;
          for(const line of g.stroke)if(touches(line.pts)){any=true;break;}
          if(any)break;
        }
      }
      return {settled:all,tiles:n.list.length,features:any};
    }

    /** Resolves when nothing is loading or queued (for tests and for "wait until the area is drawn"). */
    function whenIdle(timeoutMs=15000){
      return new Promise((resolve,reject)=>{
        const t0=now();
        const poll=()=>{
          if(active===0&&queue.length===0&&!notifyTimer)return resolve();
          if(now()-t0>timeoutMs)return reject(new Error('The map data did not finish loading in '+timeoutMs+' ms.'));
          later(poll);
        };
        poll();
      });
    }

    function snapshot(){
      let ready=0,loading=0,queued=0,empty=0,errors=0;
      for(const e of tiles.values()){if(e.state==='ready')ready++;else if(e.state==='loading')loading++;else if(e.state==='queued')queued++;else if(e.state==='empty')empty++;else if(e.state==='error')errors++;}
      return {packages:pkgs.size,tiles:tiles.size,ready,loading,queued,empty,errors,bytes,maxTiles:cfg.maxTiles,maxBytes:cfg.maxBytes,...stats,tz:lastNeeded?lastNeeded.tz:null,active};
    }
    function clear(){for(const [k,e] of [...tiles])drop(k,e);queue.length=0;stable=null;pendingLevel=null;lastNeeded=null;generation++;}
    function idle(){return active===0&&queue.length===0;}

    return {addPackage,removePackage,packages,coverageBoxes,covers,needed,ensure,drawable,labels,featuresIn,whenIdle,snapshot,clear,idle,tileZoomFor,
      get size(){return pkgs.size;},get generation(){return generation;}};
  }

  return {create,lonToX,latToY,xToLon,yToLat,wrapX,DEFAULTS};
});
