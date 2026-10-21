/*
 * Trace canvas layer: the offline base map, drawn crisply on every frame.
 *
 * Why this exists: Leaflet's canvas renderer redraws by re-projecting every
 * feature (about 12,700 separate layers here), which costs far too much to do
 * per frame. During an animated flight it therefore only CSS-scales the last
 * bitmap, which smears a wide-to-street descent into blocks. This layer instead
 * pre-builds vector geometry once as Path2D objects in a fixed "world pixel at
 * zoom 0" space, then draws each frame with a single affine transform. A spatial
 * grid culls what is off screen and level-of-detail rules thin out what is too
 * small to read, so streets and buildings stay sharp from regional to street scale.
 *
 * It draws only data bundled with the app (Natural Earth overview, OpenStreetMap
 * geometry for the Gainesville / UF area) and never requests anything.
 * Leaflet remains responsible for the camera, markers, popup and controls.
 */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.TraceCanvasLayer=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';

  const TILE=256,D2R=Math.PI/180,MAX_LAT=85.05112878;
  const mercX=lng=>(lng+180)/360*TILE;
  const mercY=lat=>{const s=Math.sin(Math.max(-MAX_LAT,Math.min(MAX_LAT,lat))*D2R);return (0.5-Math.log((1+s)/(1-s))/(4*Math.PI))*TILE;};

  const MINOR_WAYS=new Set(['footway','path','cycleway','steps','pedestrian']);
  const MAJOR_WAYS=new Set(['primary','secondary','tertiary','trunk']);
  const INDOOR_WAYS=new Set(['corridor','elevator','bus_stop']);
  const BASE_KINDS=['green','parking','paved','water','building'];
  const LOCAL_MIN_ZOOM=10.5,POINT_MIN_ZOOM=17.5,GRID=10;
const GRATICULE_FADE_END=15.5,GRATICULE_STEPS=[.0005,.001,.0025,.005,.01,.025,.05,.1,.25,.5,1,2,5,10,15,30,45,60,90];

  const palette={
    land:'#281321',landStroke:'#6e354f',
    casing:'#100a0f',
    labelHalo:'#170b12',labelDefault:'#d1a0b5',labelRoad:'#cf89a4',labelPlace:'#f0bed4',labelMinor:'#9b5f7d',symbol:'#f17ba3'
  };

  /** Static drawing rules for one group of features. Roads get their width per frame from zoom. */
  function specFor(kind,highway,highlight){
    switch(kind){
      case 'green':return {order:0,minZoom:12.5,stroke:'#39222c',weight:.3,fill:'#21161c',fillOpacity:.95,opacity:1};
      case 'parking':return {order:1,minZoom:14.5,stroke:'#57303e',weight:.6,fill:'#1b141a',fillOpacity:.95,opacity:1};
      case 'paved':return {order:2,minZoom:14.5,stroke:'#4c2938',weight:.5,fill:'#251820',fillOpacity:.9,opacity:1};
      case 'water':return {order:3,minZoom:11,stroke:'#644151',weight:.8,fill:'#211722',fillOpacity:.95,opacity:1};
      case 'building':return {order:4,minZoom:13.5,strokeMinZoom:15.5,stroke:highlight?'#d65b80':'#74404f',weight:highlight?1.3:.7,fill:highlight?'#4e2235':'#33212b',fillOpacity:.95,opacity:1};
      case 'barrier':return {order:6,minZoom:17,stroke:'#b65f75',weight:.8,opacity:.55,dash:[2,3]};
      case 'road':{
        const major=MAJOR_WAYS.has(highway),minor=MINOR_WAYS.has(highway),indoor=INDOOR_WAYS.has(highway);
        return {order:7,road:true,major,minor,casing:!minor,minZoom:major?10.5:minor?15.5:indoor?17:13,stroke:major?'#ad6275':minor?'#663c4a':'#734454',base:major?5.5:minor?.8:2.8,opacity:minor?.65:1,dash:minor?[2,3]:null};
      }
      default:return null;
    }
  }
  /** Road weight in CSS pixels, matching the v2 style: scales with zoom between 0.25x and 2.8x. */
  function roadWeight(spec,zoom){return Math.max(.65,spec.base*Math.pow(2,Math.max(-2,Math.min(1.5,zoom-17))));}

  const pointStyle=kind=>({radius:kind==='tree'?2.8:1.5,stroke:'#ab5b7c',fill:'#48253a',weight:.5,fillOpacity:.7});

  function labelFont(kind){return kind==='parking'||kind==='bus'?{size:9,color:palette.labelMinor}:kind==='poi'||kind==='place'?{size:11,color:palette.labelPlace}:kind==='road'?{size:10,color:palette.labelRoad,spacing:.4}:{size:10,color:palette.labelDefault};}

  function inBounds(lat,lng,b){return lng>=b[0]&&lng<=b[2]&&lat>=b[1]&&lat<=b[3];}

  /** Pure projection helper, exported so tests can compare it with Leaflet's own projection. */
  function containerPoint(lat,lng,zoom,minX,minY){const s=Math.pow(2,zoom);return {x:mercX(lng)*s-minX,y:mercY(lat)*s-minY};}

  function createLayer(L,options){
    const Layer=L.Layer.extend({
      options:{pane:'traceBase'},
      initialize(opts){
        L.setOptions(this,{pane:opts.pane||'traceBase'});
        this._cfg=opts;this._local=null;this._labels=[];this._labelState=new Map();this._lastSelect=-1e9;this._lastKey='';this._lastDraw=0;
        this.stats={draws:0,lastMs:0,avgMs:0,maxMs:0,localReady:false};
        this._buildWorld(opts.world);
      },
      onAdd(map){
        this._map=map;
        const pane=map.getPane(this.options.pane);
        const canvas=this._canvas=L.DomUtil.create('canvas','trace-canvas leaflet-zoom-animated',pane);
        canvas.setAttribute('aria-hidden','true');
        this._ctx=canvas.getContext('2d',{alpha:true});
        this._resize();this.redraw(true);
      },
      onRemove(){L.DomUtil.remove(this._canvas);this._canvas=null;this._ctx=null;cancelAnimationFrame(this._raf);},
      getEvents(){return {viewreset:this._onView,move:this._onMove,zoom:this._onMove,moveend:this._onSettle,zoomend:this._onSettle,zoomanim:this._onZoomAnim,resize:this._onResize};},
      _onView(){this.redraw(true);},
      _onMove(){this.redraw(false);},
      _onSettle(){this._selectLabels(true);this.redraw(true);},
      _onResize(){this._resize();this.redraw(true);},
      // Same transform Leaflet applies to its own renderers during an animated zoom.
      _onZoomAnim(e){
        if(!this._canvas||!this._center)return;
        const map=this._map,scale=map.getZoomScale(e.zoom,this._zoomAtDraw),viewHalf=map.getSize().multiplyBy(.5),
          current=map.project(this._center,e.zoom),offset=viewHalf.multiplyBy(-scale).add(current).subtract(map._getNewPixelOrigin(e.center,e.zoom));
        L.DomUtil.setTransform(this._canvas,offset,scale);
      },
      _resize(){
        if(!this._canvas)return;
        const size=this._map.getSize(),dpr=Math.min(2,(typeof devicePixelRatio==='number'&&devicePixelRatio)||1);
        this._dpr=dpr;this._w=size.x;this._h=size.y;
        this._canvas.width=Math.max(1,Math.round(size.x*dpr));this._canvas.height=Math.max(1,Math.round(size.y*dpr));
        this._canvas.style.width=size.x+'px';this._canvas.style.height=size.y+'px';
        this._lastKey='';
      },

      // ---- geometry -------------------------------------------------------------
      _buildWorld(world){
        const rings=[];
        const add=ring=>{let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9;const xs=new Float64Array(ring.length),ys=new Float64Array(ring.length);
          for(let i=0;i<ring.length;i++){const x=mercX(ring[i][0]),y=mercY(ring[i][1]);xs[i]=x;ys[i]=y;if(x<x0)x0=x;if(x>x1)x1=x;if(y<y0)y0=y;if(y>y1)y1=y;}
          rings.push({xs,ys,x0,y0,x1,y1});};
        for(const f of (world&&world.features)||[]){const g=f.geometry;if(!g)continue;
          if(g.type==='Polygon')g.coordinates.forEach(add);
          else if(g.type==='MultiPolygon')g.coordinates.forEach(p=>p.forEach(add));}
        this._worldRings=rings;
      },
      /** Builds the detailed local geometry once. Safe to call repeatedly. Returns the build time in ms. */
      prepare(){
        if(this._local)return 0;
        const data=this._cfg.local,bounds=this._cfg.bounds;if(!data||!bounds)return 0;
        const t0=performance.now();
        const ox=mercX((bounds[0]+bounds[2])/2),oy=mercY((bounds[1]+bounds[3])/2);
        const gx0=mercX(bounds[0])-ox,gx1=mercX(bounds[2])-ox,gy0=mercY(bounds[3])-oy,gy1=mercY(bounds[1])-oy;
        const cw=(gx1-gx0)/GRID,ch=(gy1-gy0)/GRID;
        const groups=new Map(),cellPoints=new Map(),points=[];
        const cellOf=(x,y)=>[Math.max(0,Math.min(GRID-1,Math.floor((x-gx0)/cw))),Math.max(0,Math.min(GRID-1,Math.floor((y-gy0)/ch)))];
        const emit=(path,coords,close)=>{for(let i=0;i<coords.length;i++){const x=mercX(coords[i][0])-ox,y=mercY(coords[i][1])-oy;if(i)path.lineTo(x,y);else path.moveTo(x,y);}if(close)path.closePath();};
        for(const f of data.features){
          const p=f.properties,g=f.geometry;if(!g)continue;
          if(g.type==='Point'){
            const x=mercX(g.coordinates[0])-ox,y=mercY(g.coordinates[1])-oy,[ci,cj]=cellOf(x,y),idx=cj*GRID+ci;
            const pt={kind:p.kind,x,y};points.push(pt);let list=cellPoints.get(idx);if(!list)cellPoints.set(idx,list=[]);list.push(pt);continue;
          }
          const spec=specFor(p.kind,p.highway,p.highlight);if(!spec)continue;
          const key=p.kind+'|'+(p.highway||'')+'|'+(p.highlight?1:0);
          let group=groups.get(key);if(!group){group={spec,kind:p.kind,full:new Path2D(),cells:new Map()};groups.set(key,group);}
          const lines=g.type==='LineString'?[g.coordinates]:g.type==='Polygon'?g.coordinates:g.type==='MultiLineString'?g.coordinates:g.type==='MultiPolygon'?g.coordinates.flat():[];
          const close=g.type==='Polygon'||g.type==='MultiPolygon';
          let bx0=1e9,by0=1e9,bx1=-1e9,by1=-1e9;
          for(const line of lines)for(const c of line){const x=mercX(c[0])-ox,y=mercY(c[1])-oy;if(x<bx0)bx0=x;if(x>bx1)bx1=x;if(y<by0)by0=y;if(y>by1)by1=y;}
          const [i0,j0]=cellOf(bx0,by0),[i1,j1]=cellOf(bx1,by1);
          for(const line of lines)emit(group.full,line,close);
          for(let j=j0;j<=j1;j++)for(let i=i0;i<=i1;i++){
            const idx=j*GRID+i;let path=group.cells.get(idx);if(!path)group.cells.set(idx,path=new Path2D());
            for(const line of lines)emit(path,line,close);
          }
        }
        const list=[...groups.values()];
        this._local={ox,oy,gx0,gy0,cw,ch,bounds,points,cellPoints,
          base:list.filter(g=>BASE_KINDS.includes(g.kind)).sort((a,b)=>a.spec.order-b.spec.order),
          casings:list.filter(g=>g.spec.road&&g.spec.casing),
          // Thin roads first so wider roads draw over their junctions.
          roads:list.filter(g=>g.spec.road).sort((a,b)=>Number(a.spec.major)-Number(b.spec.major)),barriers:list.filter(g=>g.kind==='barrier')};
        this.stats.localReady=true;
        const ms=performance.now()-t0;this.stats.buildMs=ms;
        this.redraw(true);
        return ms;
      },
      setLabels(local,world){this._cfg.localLabels=local;this._cfg.worldLabels=world;},

      // ---- labels ---------------------------------------------------------------
      _selectLabels(force){
        const map=this._map;if(!map||!this._canvas)return;
        const now=performance.now();if(!force&&now-this._lastSelect<250)return;this._lastSelect=now;
        const z=map.getZoom(),c=map.getCenter(),local=z>=14&&this._local&&inBounds(c.lat,c.lng,this._cfg.bounds);
        const source=(local?this._cfg.localLabels:this._cfg.worldLabels)||[];
        const project=p=>{const lon=local?p.lon:p.lon+360*Math.round((c.lng-p.lon)/360);return map.latLngToContainerPoint([p.lat,lon]);};
        const picked=this._cfg.selectLabels(source,z,project,map.getSize(),{});
        const keep=new Set();
        for(const p of picked){
          const key=p.kind+'|'+p.text+'|'+p.lat.toFixed(5)+'|'+p.lon.toFixed(5);keep.add(key);
          const e=this._labelState.get(key);if(e){e.target=1;e.label=p;e.local=local;}else this._labelState.set(key,{label:p,alpha:0,target:1,local});
        }
        for(const [key,e] of this._labelState)if(!keep.has(key))e.target=0;
      },
      _drawLabels(ctx,dt,center){
        const map=this._map;let animating=false;
        for(const [key,e] of this._labelState){
          if(e.alpha<e.target){e.alpha=Math.min(e.target,e.alpha+dt/160);animating=true;}
          else if(e.alpha>e.target){e.alpha=Math.max(e.target,e.alpha-dt/160);animating=true;}
          if(e.alpha<=0&&e.target===0){this._labelState.delete(key);continue;}
          const p=e.label,lon=e.local?p.lon:p.lon+360*Math.round((center.lng-p.lon)/360),pt=map.latLngToContainerPoint([p.lat,lon]);
          if(pt.x<-120||pt.y<-30||pt.x>this._w+120||pt.y>this._h+30)continue;
          const f=labelFont(p.kind);
          ctx.save();ctx.globalAlpha=e.alpha;ctx.translate(pt.x,pt.y);if(p.angle)ctx.rotate(p.angle*D2R);
          ctx.font=f.size+'px "Segoe UI Variable Text","Segoe UI",system-ui,Arial,sans-serif';ctx.textBaseline='middle';ctx.textAlign='left';
          if('letterSpacing' in ctx)ctx.letterSpacing=(f.spacing||0)+'px';
          const symbol=p.symbol?p.symbol+' ':'',wSym=symbol?ctx.measureText(symbol).width:0,wText=ctx.measureText(p.text).width,x0=-(wSym+wText)/2;
          ctx.lineJoin='round';ctx.lineWidth=3;ctx.strokeStyle=palette.labelHalo;
          if(symbol)ctx.strokeText(symbol,x0,0);ctx.strokeText(p.text,x0+wSym,0);
          if(symbol){ctx.fillStyle=palette.symbol;ctx.fillText(symbol,x0,0);}
          ctx.fillStyle=f.color;ctx.fillText(p.text,x0+wSym,0);
          ctx.restore();
        }
        return animating;
      },

      // ---- drawing --------------------------------------------------------------
      redraw(force){
        if(!this._canvas||this._map._animatingZoom)return;
        const map=this._map,z=map.getZoom(),c=map.getCenter(),size=map.getSize();
        if(size.x!==this._w||size.y!==this._h)this._resize();
        const key=z+'|'+c.lat+'|'+c.lng+'|'+size.x+'|'+size.y+'|'+(this._local?1:0);
        if(!force&&key===this._lastKey)return;
        this._lastKey=key;
        const t0=performance.now();
        this._center=c;this._zoomAtDraw=z;
        L.DomUtil.setPosition(this._canvas,map.containerPointToLayerPoint([0,0]));
        const ctx=this._ctx,dpr=this._dpr,s=Math.pow(2,z),min=map.getPixelBounds().min;
        ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,this._w,this._h);
        this._drawWorld(ctx,s,min);
        this._drawGraticule(ctx,s,min,z);
        if(this._local&&z>=LOCAL_MIN_ZOOM)this._drawLocal(ctx,s,min,z,dpr);
        ctx.setTransform(dpr,0,0,dpr,0,0);
        this._selectLabels(false);
        const dt=Math.min(60,t0-(this._lastDraw||t0));this._lastDraw=t0;
        const animating=this._drawLabels(ctx,dt||16,c);
        const ms=performance.now()-t0,st=this.stats;st.draws++;st.lastMs=ms;st.avgMs=st.avgMs?st.avgMs*.9+ms*.1:ms;if(ms>st.maxMs)st.maxMs=ms;
        if(animating&&!this._raf)this._raf=requestAnimationFrame(()=>{this._raf=0;this.redraw(true);});
      },
      _drawWorld(ctx,s,min){
        const W=TILE*s,rings=this._worldRings;if(!rings||!rings.length)return;
        const kFrom=Math.floor(min.x/W),kTo=Math.floor((min.x+this._w)/W);
        ctx.beginPath();
        for(let k=kFrom;k<=kTo;k++){
          const ox=k*W-min.x,oy=-min.y;
          for(const r of rings){
            const px0=r.x0*s+ox,px1=r.x1*s+ox,py0=r.y0*s+oy,py1=r.y1*s+oy;
            if(px1<-2||py1<-2||px0>this._w+2||py0>this._h+2)continue;
            if(px1-px0<.35&&py1-py0<.35)continue;
            const xs=r.xs,ys=r.ys;ctx.moveTo(xs[0]*s+ox,ys[0]*s+oy);
            for(let i=1;i<xs.length;i++)ctx.lineTo(xs[i]*s+ox,ys[i]*s+oy);
            ctx.closePath();
          }
        }
        ctx.globalAlpha=.95;ctx.fillStyle=palette.land;ctx.fill('evenodd');
        ctx.globalAlpha=1;ctx.lineWidth=.7;ctx.strokeStyle=palette.landStroke;ctx.lineJoin='round';ctx.stroke();
      },
      /**
       * Latitude/longitude grid. It is exact geometry, drawn from the camera alone, and it gives the descent
       * a sense of scale in the zoom range where neither the world outline nor the street data has detail.
       */
      _drawGraticule(ctx,s,min,z){
        if(z>=GRATICULE_FADE_END)return;
        const fade=Math.min(1,(GRATICULE_FADE_END-z)/2.5),W=TILE*s,w=this._w,h=this._h;
        const step=GRATICULE_STEPS.find(v=>v>=360/W*80)||90;
        const lonA=min.x/W*360-180,lonB=(min.x+w)/W*360-180;
        const latOf=y=>Math.atan(Math.sinh(Math.PI*(1-2*y/W)))/D2R;
        const latTop=Math.min(MAX_LAT,latOf(min.y)),latBottom=Math.max(-MAX_LAT,latOf(min.y+h));
        const k0=Math.ceil(lonA/step),k1=Math.floor(lonB/step),j0=Math.ceil(latBottom/step),j1=Math.floor(latTop/step);
        if(k1-k0>80||j1-j0>80)return;
        const decimals=step>=1?0:Math.min(6,Math.ceil(-Math.log10(step)));
        ctx.save();
        ctx.beginPath();
        for(let k=k0;k<=k1;k++){const x=Math.round((k*step+180)/360*W-min.x)+.5;ctx.moveTo(x,0);ctx.lineTo(x,h);}
        for(let j=j0;j<=j1;j++){const y=Math.round(mercY(j*step)*s-min.y)+.5;ctx.moveTo(0,y);ctx.lineTo(w,y);}
        ctx.lineWidth=1;ctx.strokeStyle='rgba(234,102,141,'+(.085*fade).toFixed(3)+')';ctx.stroke();
        ctx.font='10px "Bahnschrift","Cascadia Mono",Consolas,ui-monospace,monospace';ctx.fillStyle='rgba(200,130,160,'+(.75*fade).toFixed(3)+')';ctx.textBaseline='bottom';
        ctx.textAlign='left';
        for(let j=j0;j<=j1;j++){const lat=j*step,y=Math.round(mercY(lat)*s-min.y)-3;if(y<18||y>h-8)continue;ctx.fillText(Math.abs(lat).toFixed(decimals)+'°'+(lat<0?'S':lat>0?'N':''),10,y);}
        for(let k=k0;k<=k1;k++){const lon=((k*step+180)%360+360)%360-180,x=Math.round((k*step+180)/360*W-min.x)+4;if(x<56||x>w-70)continue;ctx.fillText(Math.abs(lon).toFixed(decimals)+'°'+(lon<0?'W':lon>0?'E':''),x,h*.3);}
        ctx.restore();
      },
      _visiblePath(group,cells,full){
        if(full)return group.full;
        const out=new Path2D();let any=false;
        for(const idx of cells){const p=group.cells.get(idx);if(p){out.addPath(p);any=true;}}
        return any?out:null;
      },
      _drawLocal(ctx,s,min,z,dpr){
        const L0=this._local;
        // Viewport in the layer's relative unit space; skip entirely if it cannot overlap the dataset.
        const ux0=min.x/s-L0.ox,ux1=(min.x+this._w)/s-L0.ox,uy0=min.y/s-L0.oy,uy1=(min.y+this._h)/s-L0.oy;
        const gx1=L0.gx0+L0.cw*GRID,gy1=L0.gy0+L0.ch*GRID,pad=Math.max(L0.cw,L0.ch)*.6;
        // Features can run slightly beyond the nominal bounds, so allow a margin before skipping.
        if(ux1<L0.gx0-pad||ux0>gx1+pad||uy1<L0.gy0-pad||uy0>gy1+pad)return;
        const i0=Math.max(0,Math.floor((ux0-L0.gx0)/L0.cw)),i1=Math.min(GRID-1,Math.floor((ux1-L0.gx0)/L0.cw)),
          j0=Math.max(0,Math.floor((uy0-L0.gy0)/L0.ch)),j1=Math.min(GRID-1,Math.floor((uy1-L0.gy0)/L0.ch));
        const cells=[];for(let j=j0;j<=j1;j++)for(let i=i0;i<=i1;i++)cells.push(j*GRID+i);
        const full=cells.length>=GRID*GRID*.55;
        ctx.setTransform(dpr*s,0,0,dpr*s,dpr*(L0.ox*s-min.x),dpr*(L0.oy*s-min.y));
        ctx.lineJoin='round';ctx.lineCap='round';
        for(const g of L0.base){
          const sp=g.spec;if(z<sp.minZoom)continue;const path=this._visiblePath(g,cells,full);if(!path)continue;
          ctx.globalAlpha=sp.fillOpacity;ctx.fillStyle=sp.fill;ctx.fill(path,'evenodd');
          if(sp.strokeMinZoom===undefined||z>=sp.strokeMinZoom){ctx.globalAlpha=sp.opacity;ctx.lineWidth=sp.weight/s;ctx.strokeStyle=sp.stroke;ctx.stroke(path);}
        }
        ctx.setLineDash([]);
        for(const g of L0.casings){
          const sp=g.spec;if(z<sp.minZoom)continue;const path=this._visiblePath(g,cells,full);if(!path)continue;
          ctx.globalAlpha=1;ctx.strokeStyle=palette.casing;ctx.lineWidth=(roadWeight(sp,z)+2.8)/s;ctx.stroke(path);
        }
        for(const g of L0.roads){
          const sp=g.spec;if(z<sp.minZoom)continue;const path=this._visiblePath(g,cells,full);if(!path)continue;
          ctx.globalAlpha=sp.opacity;ctx.strokeStyle=sp.stroke;ctx.lineWidth=roadWeight(sp,z)/s;
          ctx.setLineDash(sp.dash?sp.dash.map(d=>d/s):[]);ctx.stroke(path);
        }
        ctx.setLineDash([]);
        for(const g of L0.barriers){
          const sp=g.spec;if(z<sp.minZoom)continue;const path=this._visiblePath(g,cells,full);if(!path)continue;
          ctx.globalAlpha=sp.opacity;ctx.strokeStyle=sp.stroke;ctx.lineWidth=sp.weight/s;ctx.setLineDash(sp.dash.map(d=>d/s));ctx.stroke(path);
        }
        ctx.setLineDash([]);ctx.globalAlpha=1;
        if(z>=POINT_MIN_ZOOM){
          for(const kind of ['tree','furniture','poi','bus']){
            const st=pointStyle(kind);ctx.beginPath();let n=0;
            for(const idx of cells){const list=L0.cellPoints.get(idx);if(!list)continue;for(const p of list){if(p.kind!==kind)continue;ctx.moveTo(p.x+st.radius/s,p.y);ctx.arc(p.x,p.y,st.radius/s,0,Math.PI*2);n++;}}
            if(!n)continue;
            ctx.globalAlpha=st.fillOpacity;ctx.fillStyle=st.fill;ctx.fill();ctx.globalAlpha=1;ctx.lineWidth=st.weight/s;ctx.strokeStyle=st.stroke;ctx.stroke();
          }
        }
        ctx.globalAlpha=1;
      }
    });
    return new Layer(options);
  }

  return {create:createLayer,mercX,mercY,specFor,roadWeight,containerPoint,LOCAL_MIN_ZOOM,POINT_MIN_ZOOM,MAX_LAT};
});
