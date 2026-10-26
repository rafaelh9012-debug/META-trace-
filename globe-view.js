/*
 * Globe view: a real 3D globe drawn with Canvas 2D.
 *
 * A perspective camera (globe-math.js) looks at the centre of a unit sphere. Every vertex is a unit vector, projected
 * with the camera's own basis, and anything past the horizon is clipped, so rotating, tilting and descending are camera
 * movements and never a spinning image. No WebGL is needed, so a machine with a weak or blocked graphics stack still
 * gets the same picture. The cost is that projection runs in JavaScript: caps cull what cannot be on screen, and the
 * view measures its own drawing time and lowers its quality (glow pass, pixel density, label count) if it falls behind.
 *
 * The view draws only data it is given (the bundled world pack, see globe-data.js). It never requests anything.
 */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(typeof require==='function'?require('./globe-math.js'):null);else root.GlobeView=factory(root.GlobeMath);})(typeof globalThis!=='undefined'?globalThis:this,function(M){
  'use strict';

  const {D2R,R_MEAN,clamp,smoothstep}=M;
  const FONT='"Segoe UI Variable Text","Segoe UI",system-ui,Arial,sans-serif';
  const MONO='"Bahnschrift","Cascadia Mono",Consolas,ui-monospace,monospace';

  // Deep black, burgundy and crimson. The map-mode colours are those of the flat map (trace-canvas-layer.js), so the
  // two renderers match where the view changes over.
  const PALETTE={
    space:'#050106',
    oceanHi:'#2b0f21',oceanMid:'#1a0a15',oceanLo:'#0b0509',
    land:'#35162a',landMap:'#281321',
    coast:'#ff5c8a',coastMap:'#6e354f',
    border:'rgba(224,122,160,0.46)',borderMap:'rgba(110,53,79,0.55)',
    admin1:'rgba(190,100,135,0.28)',
    water:'#1d0e1a',river:'rgba(236,119,161,0.40)',road:'rgba(214,140,120,0.45)',rail:'rgba(180,120,160,0.4)',
    grid:'rgba(234,102,141,0.11)',gridStrong:'rgba(234,102,141,0.22)',gridLabel:'rgba(214,150,176,0.75)',
    atmosphere:'234,102,141',label:'#f0bed4',labelHalo:'#12060c',labelCountry:'#cf93ad',
    marker:'#ff7aa2',markerCore:'#fff1f6'
  };

  /** The idle turn runs only at or above this fraction of the resting height. */
  const IDLE_BAND=.8;
  const GRATICULE_STEPS=[30,15,10,5,2,1,.5,.2,.1,.05,.02,.01,.005,.002,.001];
  const QUALITY=[{dprCap:1,glow:false,labels:.5},{dprCap:1.5,glow:true,labels:.8},{dprCap:2,glow:true,labels:1}];

  function mixHex(a,b,t){
    const pa=parseInt(a.slice(1),16),pb=parseInt(b.slice(1),16);
    const r=Math.round(((pa>>16)&255)*(1-t)+((pb>>16)&255)*t),g=Math.round(((pa>>8)&255)*(1-t)+((pb>>8)&255)*t),bl=Math.round((pa&255)*(1-t)+(pb&255)*t);
    return 'rgb('+r+','+g+','+bl+')';
  }

  function create(options){
    const canvas=options.canvas,data=options.data||null,readout=options.readout||null,onUserInput=options.onUserInput||(()=>{}),onUserCamera=options.onUserCamera||(()=>{});
    const clock=options.now||(()=>performance.now());
    const raf=options.requestAnimationFrame||(fn=>requestAnimationFrame(fn)),caf=options.cancelAnimationFrame||(id=>cancelAnimationFrame(id));
    const ctx=canvas.getContext('2d',{alpha:false});
    let w=Math.max(1,options.width||canvas.clientWidth||600),h=Math.max(1,options.height||canvas.clientHeight||480),dpr=1;
    let quality=options.quality===undefined?2:options.quality,maxQuality=quality;
    const cam=M.createCamera(w,h).set(options.lon||0,options.lat||18,options.alt||M.IDLE_ALT);
    const state={
      active:true,interactive:true,idleRate:0,dirty:true,dragging:false,
      marker:null,markerLock:0,locked:false,motionReduced:false,
      bg:null,bgKey:'',lastFrame:0,loop:0,tween:null,driven:false,lastUserAt:-1e9,idleResumeMs:options.idleResumeMs===undefined?8000:options.idleResumeMs,
      userMinAlt:options.userMinAlt||M.MIN_ALT
    };
    const stats={frames:0,lastMs:0,avgMs:0,maxMs:0,slowRun:0,fastRun:0,vertices:0,qualityChanges:0};
    let readoutAt=0;

    // ---- sizing ------------------------------------------------------------------------
    function applySize(){
      dpr=Math.min(QUALITY[quality].dprCap,(typeof devicePixelRatio==='number'&&devicePixelRatio)||1);
      canvas.width=Math.max(1,Math.round(w*dpr));canvas.height=Math.max(1,Math.round(h*dpr));
      canvas.style.width=w+'px';canvas.style.height=h+'px';
      cam.resize(w,h);state.bg=null;state.dirty=true;
    }
    function resize(width,height){
      const nw=Math.max(1,Math.round(width)),nh=Math.max(1,Math.round(height));
      if(nw===w&&nh===h&&state.bg)return;
      w=nw;h=nh;applySize();
    }
    applySize();

    // ---- camera ------------------------------------------------------------------------
    function setCamera(c,opts){cam.set(c.lon!==undefined?c.lon:cam.lon,c.lat!==undefined?c.lat:cam.lat,c.alt!==undefined?c.alt:cam.alt);state.dirty=true;if(!(opts&&opts.quiet))schedule();}
    const getCamera=()=>({lon:cam.lon,lat:cam.lat,alt:cam.alt});
    const zoomLevel=()=>cam.limb/(Math.min(w,h)/2);   // 1 when the globe just fits, large when zoomed in

    // ---- space background (cached): vignette and a restrained star field ---------------------------
    function buildBackground(){
      const c=typeof OffscreenCanvas==='function'?new OffscreenCanvas(canvas.width,canvas.height):Object.assign(document.createElement('canvas'),{width:canvas.width,height:canvas.height});
      const g=c.getContext('2d');
      g.setTransform(dpr,0,0,dpr,0,0);
      g.fillStyle=PALETTE.space;g.fillRect(0,0,w,h);
      const v=g.createRadialGradient(w/2,h/2,Math.min(w,h)*.15,w/2,h/2,Math.hypot(w,h)*.62);
      v.addColorStop(0,'rgba(58,16,38,0.34)');v.addColorStop(.55,'rgba(24,6,18,0.18)');v.addColorStop(1,'rgba(0,0,0,0.35)');
      g.fillStyle=v;g.fillRect(0,0,w,h);
      let seed=0x5eed1234;const rnd=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};
      const count=Math.round(clamp(w*h/2400,70,300));
      for(let i=0;i<count;i++){
        const x=rnd()*w,y=rnd()*h,m=rnd(),a=.1+.55*m*m*m+.1*rnd(),r=.35+.55*m*m,pink=rnd();
        g.fillStyle='rgba(255,'+Math.round(236-34*pink)+','+Math.round(244-40*pink)+','+a.toFixed(3)+')';
        g.beginPath();g.arc(x,y,r,0,6.2832);g.fill();
      }
      state.bg=c;
    }

    // ---- per-frame projection setup -----------------------------------------------------
    let c0,c1,c2,e0,e1,e2,n0,n1,n2,D,hz,F,CX,CY,limb,viewCos,pushR;
    function frameSetup(){
      const c=cam.c,e=cam.e,n=cam.n;
      c0=c[0];c1=c[1];c2=c[2];e0=e[0];e1=e[1];e2=e[2];n0=n[0];n1=n[1];n2=n[2];D=cam.D;hz=cam.horizon;F=cam.focal;CX=cam.cx;CY=cam.cy;limb=cam.limb;pushR=limb*1.006;
      // Angular radius of everything that can be on screen: the horizon, or less when zoomed in.
      let far=Math.acos(hz);
      if(limb>Math.hypot(w,h)/2){
        far=0;
        for(const [px,py] of [[0,0],[w,0],[0,h],[w,h]]){
          const u=cam.unproject(px,py);
          far=Math.max(far,u?Math.acos(clamp(u.vec[0]*c0+u.vec[1]*c1+u.vec[2]*c2,-1,1)):Math.acos(hz));
        }
        far=Math.min(far*1.04+.002,Math.acos(hz));
      }
      viewCos=Math.cos(far);farAngle=far;
    }
    let farAngle=0;
    /** True when a cap (unit centre, cos of angular radius) can touch the visible region. */
    function capVisible(cx,cy,cz,cosR){
      const d=cx*c0+cy*c1+cz*c2;
      if(cosR<=-1)return true;
      const ang=Math.acos(clamp(d,-1,1))-Math.acos(clamp(cosR,-1,1));
      return ang<=farAngle;
    }

    const P=[0,0,0];
    /** Screen position of a unit vector that is past the horizon: pushed out along its direction to the limb. */
    function pushOut(x,y,z,prev){
      const lx=x*e0+y*e1+z*e2,ly=x*n0+y*n1+z*n2,len=Math.hypot(lx,ly);
      if(len<1e-7){return prev;}
      prev[0]=CX+pushR*lx/len;prev[1]=CY-pushR*ly/len;return prev;
    }
    function projectXYZ(x,y,z,out){
      const d=x*c0+y*c1+z*c2,depth=D-d;
      out[0]=CX+F*(x*e0+y*e1+z*e2)/depth;out[1]=CY-F*(x*n0+y*n1+z*n2)/depth;return d;
    }
    /** Where a segment from a (hidden or visible) to b crosses the horizon, as a projected point. */
    function crossing(ax,ay,az,ad,bx,by,bz,bd,out){
      const t=(hz-ad)/(bd-ad);
      let x=ax+(bx-ax)*t,y=ay+(by-ay)*t,z=az+(bz-az)*t;const len=Math.hypot(x,y,z)||1;x/=len;y/=len;z/=len;
      projectXYZ(x,y,z,out);
    }

    /** Adds a polyline to the current context path, split where it passes behind the horizon. */
    function addLine(g,xyz,from=0,to=xyz.length/3){
      let open=false,pvis=false,px=0,py=0,pz=0,pd=0;const t=[0,0,0];
      for(let i=from;i<to;i++){
        const x=xyz[3*i],y=xyz[3*i+1],z=xyz[3*i+2],d=x*c0+y*c1+z*c2,vis=d>=hz;
        if(vis){
          if(i>from&&!pvis){crossing(px,py,pz,pd,x,y,z,d,t);g.moveTo(t[0],t[1]);open=true;}
          projectXYZ(x,y,z,t);
          if(open)g.lineTo(t[0],t[1]);else{g.moveTo(t[0],t[1]);open=true;}
        }else if(pvis&&i>from){
          crossing(px,py,pz,pd,x,y,z,d,t);g.lineTo(t[0],t[1]);open=false;
        }
        pvis=vis;px=x;py=y;pz=z;pd=d;
      }
      stats.vertices+=to-from;
    }

    /** Adds a closed ring for filling. Hidden vertices are pushed to the limb, so a ring cut by the horizon fills to it. */
    function addRing(g,xyz){
      const n=xyz.length/3;let pvis=false,px=0,py=0,pz=0,pd=0,started=false;const t=[0,0,0],last=[0,0];
      const emit=(x,y)=>{
        if(!started){g.moveTo(x,y);started=true;last[0]=x;last[1]=y;return;}
        if(Math.abs(x-last[0])<.15&&Math.abs(y-last[1])<.15)return;
        g.lineTo(x,y);last[0]=x;last[1]=y;
      };
      for(let i=0;i<n;i++){
        const x=xyz[3*i],y=xyz[3*i+1],z=xyz[3*i+2],d=x*c0+y*c1+z*c2,vis=d>=hz;
        if(i>0&&vis!==pvis){crossing(px,py,pz,pd,x,y,z,d,t);emit(t[0],t[1]);}
        if(vis){projectXYZ(x,y,z,t);emit(t[0],t[1]);}
        else{const q=pushOut(x,y,z,t);emit(q[0],q[1]);}
        pvis=vis;px=x;py=y;pz=z;pd=d;
      }
      stats.vertices+=n;
      g.closePath();
    }

    // ---- layers --------------------------------------------------------------------------
    const scratch=new Float32Array(3*2048);
    function visibleBounds(){
      if(limb<=Math.hypot(w,h)/2*1.02)return {whole:true,latMin:-90,latMax:90,lonMin:-180,lonMax:180};
      let latMin=90,latMax=-90,lonMin=1e9,lonMax=-1e9,hits=0;
      const pts=[[0,0],[w/2,0],[w,0],[0,h/2],[w/2,h/2],[w,h/2],[0,h],[w/2,h],[w,h]];
      for(const [px,py] of pts){
        const u=cam.unproject(px,py);if(!u)continue;hits++;
        latMin=Math.min(latMin,u.lat);latMax=Math.max(latMax,u.lat);const l=M.unwrapNear(u.lon,cam.lon);lonMin=Math.min(lonMin,l);lonMax=Math.max(lonMax,l);
      }
      if(hits<pts.length||latMax>=89||latMin<=-89)return {whole:true,latMin:Math.min(latMin,-90+(latMin>-89?90-0:0)),latMax:90,lonMin:-180,lonMax:180,partial:true};
      const padLat=(latMax-latMin)*.08,padLon=(lonMax-lonMin)*.08;
      return {whole:false,latMin:latMin-padLat,latMax:latMax+padLat,lonMin:lonMin-padLon,lonMax:lonMax+padLon};
    }

    function drawGraticule(alpha,mapBlend){
      if(alpha<=.01)return;
      const mpp=cam.metersPerPixel(),degPx=R_MEAN*D2R/mpp;
      // The finest step whose lines are still at least ~70 px apart (the list runs from coarse to fine).
      let step=GRATICULE_STEPS[0];
      for(const s of GRATICULE_STEPS){if(s*degPx>=70)step=s;else break;}
      if(limb<Math.hypot(w,h)/2)step=Math.max(step,15);        // whole globe in view: keep the grid calm
      const b=visibleBounds();
      const latMin=Math.max(-90,Math.floor(b.latMin/step)*step),latMax=Math.min(90,Math.ceil(b.latMax/step)*step);
      const lonA=Math.floor(b.lonMin/step)*step,lonB=Math.ceil(b.lonMax/step)*step;
      if((latMax-latMin)/step>140||(lonB-lonA)/step>140)return;
      const sample=clamp((b.whole?3:(latMax-latMin)/48),.0002,3);
      const minor=new Path2D(),major=new Path2D();
      const polyl=(path,fn,a0,a1)=>{
        let n=0;for(let a=a0;a<=a1+1e-9&&n<2040;a+=sample,n++)fn(a,n);
        const cnt=Math.min(n,2040);addLine(path,scratch,0,cnt);
      };
      for(let lon=lonA;lon<=lonB+1e-9;lon+=step){
        const path=Math.abs(lon%90)<1e-9?major:minor;let n=0;
        for(let lat=Math.max(-90,latMin);lat<=Math.min(90,latMax)+1e-9&&n<2040;lat+=sample,n++){const p=lat*D2R,l=lon*D2R,cp=Math.cos(p);scratch[3*n]=cp*Math.cos(l);scratch[3*n+1]=cp*Math.sin(l);scratch[3*n+2]=Math.sin(p);}
        addLine(path,scratch,0,n);
      }
      for(let lat=latMin;lat<=latMax+1e-9;lat+=step){
        if(Math.abs(lat)>=90)continue;
        const path=Math.abs(lat)<1e-9?major:minor;let n=0;const p=lat*D2R,cp=Math.cos(p),sp=Math.sin(p),sl=b.whole?3:sample;
        for(let lon=b.whole?-180:lonA;lon<=(b.whole?180:lonB)+1e-9&&n<2040;lon+=sl,n++){const l=lon*D2R;scratch[3*n]=cp*Math.cos(l);scratch[3*n+1]=cp*Math.sin(l);scratch[3*n+2]=sp;}
        addLine(path,scratch,0,n);
      }
      ctx.lineWidth=1;
      ctx.globalAlpha=alpha;ctx.strokeStyle=PALETTE.grid;ctx.stroke(minor);
      ctx.strokeStyle=PALETTE.gridStrong;ctx.stroke(major);
      ctx.globalAlpha=1;
      return step;
    }

    function drawLand(mapBlend){
      const layer=data&&data.layers.land;if(!layer)return;
      ctx.fillStyle=mapBlend>.01?mixHex(PALETTE.land,PALETTE.landMap,mapBlend):PALETTE.land;
      for(const r of layer.rings){
        if(!capVisible(r.cx,r.cy,r.cz,r.cosR))continue;
        ctx.beginPath();addRing(ctx,r.xyz);ctx.fill();
      }
    }
    function drawLines(name,style,width,{mapBlend=0,minZoom=0,glow=false}={}){
      const layer=data&&data.layers[name];if(!layer)return;
      ctx.beginPath();let any=false;
      for(const c of layer.chunks){
        if(!capVisible(c.cx,c.cy,c.cz,c.cosR))continue;
        addLine(ctx,c.xyz);any=true;
      }
      if(!any)return;
      ctx.lineJoin='round';ctx.lineCap='round';
      if(glow&&QUALITY[quality].glow){
        ctx.save();ctx.globalCompositeOperation='lighter';ctx.lineWidth=width*4.2;ctx.strokeStyle='rgba(255,70,120,'+(0.13*(1-mapBlend)).toFixed(3)+')';ctx.stroke();ctx.restore();
      }
      ctx.lineWidth=width;ctx.strokeStyle=style;ctx.stroke();
    }

    // ---- labels --------------------------------------------------------------------------------
    function drawLabels(zoom,mapBlend){
      if(!data)return;
      const q=QUALITY[quality].labels,placed=[];
      const overlaps=(x,y,wd,ht)=>{for(const r of placed)if(x<r.x+r.w&&x+wd>r.x&&y<r.y+r.h&&y+ht>r.y)return true;return false;};
      ctx.textBaseline='middle';ctx.textAlign='left';ctx.lineJoin='round';
      // Countries by size of population, more of them as the view closes in. They fade out as the flat map takes over.
      const cA=smoothstep((zoom-1.15)/.6)*(1-smoothstep((zoom-9)/6));
      if(cA>.02){
        const limit=Math.round(clamp(16+(zoom-1.2)*14,16,70)*q);let drawn=0;
        ctx.font='11px '+FONT;if('letterSpacing' in ctx)ctx.letterSpacing='.6px';
        for(const c of data.countries){
          if(drawn>=limit)break;
          const d=c.x*c0+c.y*c1+c.z*c2;if(d<hz+.05)continue;
          projectXYZ(c.x,c.y,c.z,P);
          if(P[0]<20||P[1]<14||P[0]>w-20||P[1]>h-14)continue;
          const wd=ctx.measureText(c.text).width,x=P[0]-wd/2,y=P[1]-7;
          if(overlaps(x-4,y,wd+8,14))continue;
          placed.push({x:x-4,y,w:wd+8,h:14});drawn++;
          const a=cA*smoothstep((d-hz-.05)/.25);
          ctx.globalAlpha=a;ctx.lineWidth=3;ctx.strokeStyle=PALETTE.labelHalo;ctx.strokeText(c.text,x,P[1]);ctx.fillStyle=PALETTE.labelCountry;ctx.fillText(c.text,x,P[1]);
        }
      }
      // Reference cities (one per time-zone region; see the data basis), only once the view is close.
      const pA=smoothstep((zoom-2.4)/1.6)*(1-smoothstep((zoom-14)/8));
      if(pA>.02&&data.places.length){
        const limit=Math.round(clamp(10+(zoom-3)*5,10,48)*q);let drawn=0;
        ctx.font='10.5px '+FONT;if('letterSpacing' in ctx)ctx.letterSpacing='.2px';
        for(const p of data.places){
          const d=p.x*c0+p.y*c1+p.z*c2;if(d<hz+.04)continue;
          projectXYZ(p.x,p.y,p.z,P);
          if(P[0]<8||P[1]<10||P[0]>w-8||P[1]>h-10)continue;
          const a=pA*smoothstep((d-hz-.04)/.2);
          ctx.globalAlpha=a;ctx.fillStyle='#ffb6cf';ctx.beginPath();ctx.arc(P[0],P[1],1.7,0,6.2832);ctx.fill();
          if(drawn>=limit)continue;
          const wd=ctx.measureText(p.text).width,x=P[0]+5,y=P[1]-7;
          if(overlaps(x-2,y,wd+6,14))continue;
          placed.push({x:x-2,y,w:wd+6,h:14});drawn++;
          ctx.lineWidth=3;ctx.strokeStyle=PALETTE.labelHalo;ctx.strokeText(p.text,x,P[1]);ctx.fillStyle=PALETTE.label;ctx.fillText(p.text,x,P[1]);
        }
      }
      ctx.globalAlpha=1;if('letterSpacing' in ctx)ctx.letterSpacing='0px';
    }

    // ---- marker -------------------------------------------------------------------------------------
    function angleTo(lat,lon){const v=M.toVec(lat,lon);return Math.acos(clamp(v[0]*c0+v[1]*c1+v[2]*c2,-1,1))/D2R;}
    function drawMarker(now){
      const m=state.marker;if(!m)return;
      const v=M.toVec(m.lat,m.lon),d=v[0]*c0+v[1]*c1+v[2]*c2;if(d<hz)return;
      projectXYZ(v[0],v[1],v[2],P);
      const ang=angleTo(m.lat,m.lon),near=1-smoothstep((ang-12)/70);          // fades in as the target nears the centre
      let appear=Math.max(near*(m.strength===undefined?1:m.strength),state.locked?1:0);
      if(appear<.02)return;
      const x=P[0],y=P[1],lock=state.markerLock,pulse=state.motionReduced?0:(now/1400)%1;
      ctx.save();ctx.translate(x,y);
      const col=PALETTE.marker;
      ctx.globalAlpha=appear;ctx.lineWidth=1.4;ctx.strokeStyle=col;ctx.fillStyle=col;
      // Resting reticle: ring, four ticks, centre point.
      const R=lock>0&&lock<1?14+(1-lock)*18:14;
      ctx.beginPath();ctx.arc(0,0,R,0,6.2832);ctx.stroke();
      ctx.beginPath();for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){ctx.moveTo(dx*(R+3),dy*(R+3));ctx.lineTo(dx*(R+9),dy*(R+9));}ctx.stroke();
      ctx.beginPath();ctx.arc(0,0,2.6,0,6.2832);ctx.fillStyle=PALETTE.markerCore;ctx.fill();
      if(!state.motionReduced){
        ctx.globalAlpha=appear*(1-pulse)*.55;ctx.beginPath();ctx.arc(0,0,R+4+pulse*26,0,6.2832);ctx.strokeStyle=col;ctx.stroke();
      }
      if(lock>0&&lock<1){   // target lock: a ring closes onto the point, and a short flash follows
        ctx.globalAlpha=appear*(.9-.5*lock);ctx.lineWidth=2;ctx.strokeStyle=PALETTE.markerCore;ctx.beginPath();ctx.arc(0,0,R+10+(1-lock)*34,0,6.2832);ctx.stroke();
        ctx.globalAlpha=Math.max(0,1-Math.abs(lock-.7)*5)*.5;ctx.fillStyle=col;ctx.beginPath();ctx.arc(0,0,22,0,6.2832);ctx.fill();
      }
      ctx.restore();
    }

    // ---- the frame ---------------------------------------------------------------------------------------
    function render(){
      const t0=clock();
      stats.vertices=0;
      if(!state.bg)buildBackground();
      ctx.setTransform(dpr,0,0,dpr,0,0);
      ctx.globalAlpha=1;ctx.globalCompositeOperation='source-over';
      ctx.drawImage(state.bg,0,0,w,h);
      frameSetup();
      const zoom=zoomLevel(),mapBlend=smoothstep((zoom-7)/14),diag=Math.hypot(w,h);
      const whole=limb<diag/2;
      // Atmosphere: a restrained glow just outside the limb, only while the whole disc is in view.
      if(limb<diag*.7&&mapBlend<.5){
        const a=(1-smoothstep((zoom-1.3)/.8))*(1-mapBlend*2);
        if(a>.01){
          const g=ctx.createRadialGradient(CX,CY,limb*.97,CX,CY,limb*1.16);
          g.addColorStop(0,'rgba('+PALETTE.atmosphere+','+(.26*a).toFixed(3)+')');g.addColorStop(.35,'rgba('+PALETTE.atmosphere+','+(.08*a).toFixed(3)+')');g.addColorStop(1,'rgba('+PALETTE.atmosphere+',0)');
          ctx.fillStyle=g;ctx.fillRect(0,0,w,h);
        }
      }
      // The sphere. Past the clip, everything is drawn only inside the disc.
      ctx.save();
      ctx.beginPath();ctx.arc(CX,CY,limb,0,6.2832);
      const og=ctx.createRadialGradient(CX-limb*.28,CY-limb*.34,limb*.04,CX,CY,limb);
      og.addColorStop(0,PALETTE.oceanHi);og.addColorStop(.62,PALETTE.oceanMid);og.addColorStop(1,PALETTE.oceanLo);
      ctx.fillStyle=og;ctx.fill();
      if(mapBlend>.01){ctx.globalAlpha=mapBlend;ctx.fillStyle='#10090f';ctx.fill();ctx.globalAlpha=1;}
      ctx.clip();
      const gridAlpha=1-mapBlend*.6;
      state.gridStep=drawGraticule(gridAlpha,mapBlend);
      drawLand(mapBlend);
      if(data){
        drawLines('lakes',PALETTE.water,0.8);
        drawLines('admin1',PALETTE.admin1,.5,{mapBlend});
        drawLines('borders',mapBlend>.01?PALETTE.borderMap:PALETTE.border,.8+.2*(1-mapBlend),{mapBlend});
        drawLines('rivers',PALETTE.river,.7);
        drawLines('rail',PALETTE.rail,.6);
        drawLines('roads',PALETTE.road,.7);
        drawLines('coast',mapBlend>.01?mixHex(PALETTE.coast,PALETTE.coastMap,Math.min(1,mapBlend*1.6)):PALETTE.coast,1.15-.45*mapBlend,{mapBlend,glow:true});
      }
      drawLabels(zoom,mapBlend);
      // Limb darkening and a thin rim light give the disc its depth.
      if(limb<diag*.9){
        const ld=ctx.createRadialGradient(CX,CY,limb*.5,CX,CY,limb);
        const k=1-mapBlend;
        ld.addColorStop(0,'rgba(4,1,6,0)');ld.addColorStop(.82,'rgba(4,1,6,'+(.18*k).toFixed(3)+')');ld.addColorStop(1,'rgba(4,1,6,'+(.7*k).toFixed(3)+')');
        ctx.fillStyle=ld;ctx.fillRect(0,0,w,h);
      }
      ctx.restore();
      if(limb<diag*.9&&mapBlend<.7){
        ctx.save();ctx.globalAlpha=(1-mapBlend)*.55;ctx.lineWidth=1.1;
        const rg=ctx.createLinearGradient(CX-limb,CY-limb,CX+limb,CY+limb);rg.addColorStop(0,'rgba(255,122,162,0.9)');rg.addColorStop(.5,'rgba(255,92,138,0.25)');rg.addColorStop(1,'rgba(255,92,138,0.06)');
        ctx.strokeStyle=rg;ctx.beginPath();ctx.arc(CX,CY,limb,0,6.2832);ctx.stroke();ctx.restore();
      }
      drawMarker(t0);
      state.dirty=false;
      const ms=clock()-t0;
      stats.frames++;stats.lastMs=ms;stats.avgMs=stats.avgMs?stats.avgMs*.92+ms*.08:ms;if(ms>stats.maxMs)stats.maxMs=ms;
      adaptQuality(ms);
      updateReadout(t0);
    }

    /** Lowers quality when drawing is slow, raises it again when there is room. Never goes above the starting level. */
    function adaptQuality(ms){
      if(options.adaptive===false)return;
      if(stats.avgMs>16&&quality>0){stats.slowRun++;stats.fastRun=0;}
      else if(stats.avgMs<5&&quality<maxQuality){stats.fastRun++;stats.slowRun=0;}
      else{stats.slowRun=Math.max(0,stats.slowRun-1);stats.fastRun=Math.max(0,stats.fastRun-1);}
      if(stats.slowRun>=18){quality--;stats.slowRun=0;stats.qualityChanges++;stats.avgMs=8;applySize();}
      else if(stats.fastRun>=400){quality++;stats.fastRun=0;stats.qualityChanges++;applySize();}
    }

    function fmtDist(m){return m>=1e6?(m/1e3).toLocaleString('en-US',{maximumFractionDigits:0})+' km':m>=1e4?(m/1e3).toFixed(1)+' km':m>=1000?(m/1e3).toFixed(2)+' km':Math.round(m)+' m';}
    function updateReadout(now){
      if(!readout||now-readoutAt<120)return;readoutAt=now;
      readout.textContent='Altitude '+fmtDist(cam.alt)+'  ·  1 px = '+fmtDist(cam.metersPerPixel());
    }

    // ---- loop: idle rotation, tweens, drawing only when something changed ----------------------------------
    /** The slow idle turn belongs to the whole-globe view. Close to the ground it would sweep hundreds of kilometres a second
     *  and drag a result off its marker, so it only runs near the resting height (and a person who has zoomed in keeps the view they chose). */
    const nearHome=()=>cam.alt>=M.IDLE_ALT*IDLE_BAND;
    const idleAllowed=()=>!!(state.idleRate&&!state.dragging&&!state.motionReduced&&!state.driven&&nearHome()&&clock()-state.lastUserAt>=state.idleResumeMs);
    function frame(now){
      state.loop=0;
      if(!state.active)return;
      const dt=state.lastFrame?Math.min(.1,(now-state.lastFrame)/1000):0;state.lastFrame=now;
      if(state.driven)return;                  // an owner (the sequence director) calls render() itself
      let animating=false;
      const idle=idleAllowed();
      if(state.tween){animating=true;stepTween(now);}
      else if(state.inertia){animating=true;stepInertia(dt);}
      else if(idle){cam.set(cam.lon-state.idleRate*dt,cam.lat,cam.alt);state.dirty=true;animating=true;}
      else if(state.idleRate&&!state.motionReduced&&!state.dragging&&nearHome())animating=true;   // waiting to resume turning
      if(state.dirty||state.continuous)render();
      if(animating||state.dirty||state.continuous)schedule();
    }
    function schedule(){if(!state.loop&&state.active&&!state.driven)state.loop=raf(frame);}
    function start(){state.active=true;state.lastFrame=0;state.dirty=true;schedule();}
    function stop(){state.active=false;if(state.loop){caf(state.loop);state.loop=0;}}
    function invalidate(){state.dirty=true;schedule();}

    // ---- tween (user-driven moves: recenter, double-click) ---------------------------------------------------
    function tweenTo(target,ms=700){
      cancelTween();
      return new Promise(resolve=>{
        const from={lon:cam.lon,lat:cam.lat,alt:cam.alt},toLon=M.unwrapNear(target.lon!==undefined?target.lon:cam.lon,cam.lon);
        state.tween={from,to:{lon:toLon,lat:target.lat!==undefined?target.lat:cam.lat,alt:target.alt!==undefined?target.alt:cam.alt},ms,start:clock(),resolve};
        schedule();
      });
    }
    function stepTween(now){
      const t=state.tween,u=clamp((now-t.start)/t.ms,0,1),e=M.smootherstep(u);
      cam.set(M.lerp(t.from.lon,t.to.lon,e),M.lerp(t.from.lat,t.to.lat,e),Math.exp(M.lerp(Math.log(t.from.alt),Math.log(t.to.alt),e)));
      state.dirty=true;
      if(u>=1){const done=t.resolve;state.tween=null;done(true);}
    }
    function cancelTween(){const t=state.tween;if(t){state.tween=null;t.resolve(false);}state.inertia=null;}

    // ---- pointer, wheel, keyboard --------------------------------------------------------------------------------
    const pointers=new Map();let pinch=null,lastMoves=[];
    const degPerPixel=()=>({lon:(cam.metersPerPixel()/R_MEAN)/D2R/Math.max(.12,Math.cos(cam.lat*D2R)),lat:(cam.metersPerPixel()/R_MEAN)/D2R});
    function userMoved(){state.lastUserAt=clock();state.dirty=true;schedule();onUserCamera(getCamera());}
    function interrupt(kind){state.lastUserAt=clock();cancelTween();onUserInput(kind);}
    function onDown(e){
      if(!state.interactive||(e.pointerType==='mouse'&&e.button!==0))return;
      interrupt('pointerdown');
      try{canvas.setPointerCapture(e.pointerId);}catch{}
      pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
      if(pointers.size===2){const [a,b]=[...pointers.values()];pinch={d:Math.hypot(a.x-b.x,a.y-b.y),alt:cam.alt};}
      state.dragging=true;lastMoves=[];canvas.focus({preventScroll:true});
      canvas.style.cursor='grabbing';
    }
    function onMove(e){
      const p=pointers.get(e.pointerId);if(!p||!state.interactive)return;
      const dx=e.clientX-p.x,dy=e.clientY-p.y;p.x=e.clientX;p.y=e.clientY;
      if(pointers.size>=2&&pinch){
        const [a,b]=[...pointers.values()],d=Math.hypot(a.x-b.x,a.y-b.y);
        if(d>0&&pinch.d>0)setAlt(pinch.alt*pinch.d/d);
        userMoved();return;
      }
      const k=degPerPixel();
      cam.set(cam.lon-dx*k.lon,clamp(cam.lat+dy*k.lat,-90,90),cam.alt);
      lastMoves.push({t:clock(),dx,dy});if(lastMoves.length>6)lastMoves.shift();
      userMoved();
    }
    function onUp(e){
      if(!pointers.has(e.pointerId))return;
      pointers.delete(e.pointerId);try{canvas.releasePointerCapture(e.pointerId);}catch{}
      if(pointers.size<2)pinch=null;
      if(pointers.size===0){
        state.dragging=false;canvas.style.cursor='grab';
        const now=clock(),recent=lastMoves.filter(m=>now-m.t<90);
        if(recent.length&&!state.motionReduced){
          const span=Math.max(16,now-recent[0].t),vx=recent.reduce((s,m)=>s+m.dx,0)/span*1000,vy=recent.reduce((s,m)=>s+m.dy,0)/span*1000;
          if(Math.hypot(vx,vy)>60){state.inertia={vx,vy};schedule();}
        }
      }
    }
    function stepInertia(dt){
      const s=state.inertia;if(!s)return;
      const k=degPerPixel();cam.set(cam.lon-s.vx*dt*k.lon,clamp(cam.lat+s.vy*dt*k.lat,-90,90),cam.alt);
      const damp=Math.exp(-dt/.35);s.vx*=damp;s.vy*=damp;state.dirty=true;onUserCamera(getCamera());
      if(Math.hypot(s.vx,s.vy)<8)state.inertia=null;
    }
    function setAlt(alt){
      const lo=state.userMinAlt;
      if(alt<lo&&options.onZoomPastLimit){options.onZoomPastLimit({lon:cam.lon,lat:cam.lat,alt});}
      cam.set(cam.lon,cam.lat,clamp(alt,lo,M.MAX_ALT));
    }
    function onWheel(e){
      if(!state.interactive)return;
      e.preventDefault();interrupt('wheel');
      const dy=e.deltaMode===1?e.deltaY*16:e.deltaMode===2?e.deltaY*120:e.deltaY;
      setAlt(cam.alt*Math.exp(clamp(dy,-300,300)*.0016));userMoved();
    }
    function onKey(e){
      if(!state.interactive)return;
      const k=degPerPixel(),step=Math.min(w,h)*.08;
      const move=(dx,dy)=>{interrupt('key');cam.set(cam.lon-dx*k.lon,clamp(cam.lat+dy*k.lat,-90,90),cam.alt);userMoved();e.preventDefault();};
      switch(e.key){
        case 'ArrowLeft':move(step,0);break;case 'ArrowRight':move(-step,0);break;
        case 'ArrowUp':move(0,step);break;case 'ArrowDown':move(0,-step);break;     // up shows what is further north, as on the flat map
        case '+':case '=':interrupt('key');setAlt(cam.alt/1.35);userMoved();e.preventDefault();break;
        case '-':case '_':interrupt('key');setAlt(cam.alt*1.35);userMoved();e.preventDefault();break;
        case 'Home':if(options.onHome){interrupt('key');options.onHome();e.preventDefault();}break;
        default:break;
      }
    }
    function onDbl(e){
      if(!state.interactive)return;
      const r=canvas.getBoundingClientRect(),u=cam.unproject(e.clientX-r.left,e.clientY-r.top);
      interrupt('dblclick');
      if(u)tweenTo({lon:u.lon,lat:u.lat,alt:Math.max(state.userMinAlt,cam.alt*.5)},600);
    }
    canvas.addEventListener('pointerdown',onDown);canvas.addEventListener('pointermove',onMove);
    canvas.addEventListener('pointerup',onUp);canvas.addEventListener('pointercancel',onUp);
    canvas.addEventListener('wheel',onWheel,{passive:false});canvas.addEventListener('keydown',onKey);canvas.addEventListener('dblclick',onDbl);
    canvas.style.cursor='grab';canvas.style.touchAction='none';

    return {
      canvas,camera:cam,resize,setCamera,getCamera,render,start,stop,invalidate,tweenTo,cancelTween,
      setMarker(m){state.marker=m;state.locked=!!(m&&m.locked);if(!m)state.markerLock=0;invalidate();},
      setMarkerLock(v,locked){state.markerLock=v;if(locked!==undefined)state.locked=locked;invalidate();},
      setIdleRate(v){state.idleRate=v||0;if(v)schedule();},
      setMotionReduced(v){state.motionReduced=!!v;if(v){state.inertia=null;}invalidate();},
      setInteractive(v){state.interactive=!!v;canvas.style.pointerEvents=v?'auto':'none';if(!v){pointers.clear();state.dragging=false;}},
      setUserMinAlt(a){state.userMinAlt=Math.max(M.MIN_ALT,a);if(cam.alt<state.userMinAlt)setCamera({alt:state.userMinAlt});},
      setContinuous(v){state.continuous=!!v;if(v)schedule();},
      /** Driven: the owner moves the camera and calls render(); the view's own loop, idle turning and inertia are off. */
      setDriven(v){state.driven=!!v;if(v){if(state.loop){caf(state.loop);state.loop=0;}cancelTween();}else{state.lastFrame=0;state.dirty=true;schedule();}},
      get driven(){return state.driven;},
      get idleRate(){return state.idleRate;},
      markUserActive(){state.lastUserAt=clock();},
      /** True while the idle turn is running: no owner driving, no one dragging, motion allowed, not just touched. */
      get turning(){return idleAllowed();},
      setData(d){options.data=d;state.dirty=true;},
      project(lat,lon){const v=M.toVec(lat,lon),out=[0,0,0];return cam.project(v[0],v[1],v[2],out)?{x:out[0],y:out[1],visible:true}:{x:NaN,y:NaN,visible:false};},
      unproject:(x,y)=>cam.unproject(x,y),
      get zoom(){return zoomLevel();},
      get size(){return {w,h,dpr};},
      get quality(){return quality;},
      get dragging(){return state.dragging;},
      get tweening(){return !!state.tween;},
      get active(){return state.active;},
      get gridStep(){return state.gridStep||null;},
      stats,
      setQuality(q){quality=clamp(q,0,2);maxQuality=Math.max(maxQuality,quality);applySize();},
      dispose(){stop();for(const [t,f] of [['pointerdown',onDown],['pointermove',onMove],['pointerup',onUp],['pointercancel',onUp],['wheel',onWheel],['keydown',onKey],['dblclick',onDbl]])canvas.removeEventListener(t,f);}
    };
  }

  return {create,PALETTE,GRATICULE_STEPS};
});
