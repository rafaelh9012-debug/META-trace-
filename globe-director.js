/*
 * Globe director: owns every deliberate camera move between the globe and the flat street map.
 *
 * The cinematic sequence is one real camera path on one clock. GlobeMath.planSequence says where the camera is at each
 * moment (an unwrapped longitude that sweeps at least 360 degrees, a latitude that turns toward the target, an altitude
 * that falls continuously), and every frame this module places the camera there:
 *
 *   - while the camera is high, the globe renderer draws it;
 *   - once the ground scale reaches the hand-off scale, Leaflet is placed on the same centre at the same ground scale,
 *     both are drawn for a short real cross-fade, and from then on the flat map carries the descent;
 *   - the path ends on the five-mile frame, fitted from the real viewport (never a fixed zoom).
 *
 * Where the flat map cannot show the frame (very high latitudes) the globe is the final renderer and the descent
 * simply continues in it. Nothing here reads or changes a coordinate: it is given display targets, and the report that
 * holds the real GPS values is never touched.
 *
 * Every run has an id. Cancel, replace, skip and manual input all end the run at once, resolve its promise with the
 * reason, and leave both renderers where they are, in agreement.
 */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(typeof require==='function'?require('./globe-math.js'):null);else root.GlobeDirector=factory(root.GlobeMath);})(typeof globalThis!=='undefined'?globalThis:this,function(GM){
  'use strict';

  const {FRAME_METERS,MILE,MAX_MERCATOR_LAT,clamp,smootherstep,lerp}=GM;

  // Ground scale (real metres per pixel) at which each level of detail is announced while descending.
  const DETAIL_SCALES=[
    {level:1,name:'borders',mpp:36000},
    {level:2,name:'cities',mpp:9000},
    {level:3,name:'coast',mpp:2400},
    {level:4,name:'roads',mpp:110},
    {level:5,name:'frame',mpp:0}      // reached on arrival
  ];
  const TRACE_LIMIT=900;

  function create(options){
    const {L,map,mapDirector,globe,panel}=options;
    const frameEl=options.frame||null;
    const hooks=options.hooks||{};
    const now=options.now||(()=>performance.now());
    const raf=options.raf||(fn=>requestAnimationFrame(fn)),caf=options.caf||(id=>cancelAnimationFrame(id));
    const timers=options.timers||{setTimeout:(fn,ms)=>setTimeout(fn,ms),clearTimeout:id=>clearTimeout(id)};
    const fadeDefault=options.fadeMs===undefined?450:options.fadeMs;
    const idleRate=options.idleRate===undefined?3.2:options.idleRate;
    const REST_TOLERANCE=.97;   // a globe lower than this share of its resting height is "close": sequences start by backing off
    const finalFade=options.finalFadeMs===undefined?240:options.finalFadeMs;
    const userLimit=()=>typeof options.userMinAlt==='function'?options.userMinAlt():GM.MIN_ALT;
    /** The shallowest altitude the person may zoom the idle globe to. Only restored once the camera is above it. */
    const restoreLimit=()=>{const a=userLimit();if(globe.camera.alt>=a)globe.setUserMinAlt(a);};

    let view=panel&&panel.dataset&&panel.dataset.view==='map'?'map':'globe';
    let stage=view;                 // globe | toMap | map | toGlobe
    let run=null,runSeq=0,rafId=0,fadeTimer=null,mapDriving=false,internalMove=0;
    let finalState=null,frameState={visible:false,side:0};
    let lastPlan=null,traceOn=!!options.trace;const trace=[];
    const state={phase:'idle',detail:0,lastCamera:null};

    // ---- layout and the final target ----------------------------------------------------
    function layout(){
      const size=map.getSize();
      const w=Math.max(1,size.x),h=Math.max(1,size.y);
      return {w,h,side:GM.frameSide(w,h,typeof options.reserve==='function'?options.reserve():null),focal:globe.camera.focal};
    }
    /** What the final view for a coordinate is, from the viewport as it is right now. */
    function finalFor(location){
      const lat=location.latitude,lon=location.longitude,lay=layout();
      const mpp=FRAME_METERS/lay.side;                         // real ground metres per pixel the frame needs
      const fit=GM.fitFrame(lat,lay.side);
      const mapOk=Math.abs(lat)<=MAX_MERCATOR_LAT&&GM.mercatorCanShow(lat,mpp,lay.w,lay.h);
      const zoom=clamp(fit.zoom,map.getMinZoom?map.getMinZoom():1,map.getMaxZoom?map.getMaxZoom():20);
      const handoffMpp=GM.handoffMetersPerPixel(lat,Math.min(lay.w,lay.h),mpp);
      return {
        lat,lon,side:lay.side,w:lay.w,h:lay.h,focal:lay.focal,mpp,zoom,renderer:mapOk&&Math.abs(zoom-fit.zoom)<1e-6?'map':'globe',
        alt:GM.altForGroundScale(lay.focal,lat,mpp),
        handoffMpp,handoffAlt:mapOk?GM.altForGroundScale(lay.focal,lat,handoffMpp):null
      };
    }

    // ---- which renderer is visible ------------------------------------------------------
    function setView(next,fadeMs){
      view=next;
      if(panel){panel.style.setProperty('--view-fade',Math.max(0,fadeMs)+'ms');panel.dataset.view=next;}
      if(typeof hooks.onView==='function')try{hooks.onView(next,fadeMs);}catch{}
    }
    function clearFadeTimer(){if(fadeTimer){timers.clearTimeout(fadeTimer);fadeTimer=null;}}
    /** Stops drawing the renderer that is no longer visible, after the fade has finished. */
    function retireHidden(fadeMs){
      clearFadeTimer();
      const done=()=>{fadeTimer=null;if(view==='map'){globe.stop();}else{leafletEnd();}};
      if(fadeMs<=0)done();else fadeTimer=timers.setTimeout(done,fadeMs+30);
    }

    // ---- Leaflet driving (the same internals flyTo uses, driven by our own path) -----------------
    function leafletBegin(){if(mapDriving)return;mapDriving=true;internalMove++;if(typeof map._moveStart==='function')map._moveStart(true,false);}
    function leafletEnd(){if(!mapDriving)return;mapDriving=false;if(typeof map._moveEnd==='function')map._moveEnd(true);internalMove=Math.max(0,internalMove-1);}
    function leafletPlace(lat,lon,zoom){
      const c=L.latLng(clamp(lat,-MAX_MERCATOR_LAT,MAX_MERCATOR_LAT),GM.wrapLon(lon));
      if(typeof map._move==='function')map._move(c,zoom);else map.setView(c,zoom,{animate:false});
    }
    function mapZoomFor(lat,alt){
      const mpp=GM.groundScaleForAlt(globe.camera.focal,lat,alt);
      return clamp(GM.zoomForMetersPerPixel(clamp(lat,-MAX_MERCATOR_LAT,MAX_MERCATOR_LAT),mpp),map.getMinZoom?map.getMinZoom():1,map.getMaxZoom?map.getMaxZoom():20);
    }
    function altForMapView(){
      const c=map.getCenter(),z=map.getZoom();
      const mpp=GM.mercatorGroundScale(c.lat,z).mean;
      return {lat:c.lat,lon:c.lng,alt:GM.altForGroundScale(globe.camera.focal,c.lat,mpp)};
    }

    // ---- frame overlay -----------------------------------------------------------------------
    function showFrame(side){
      frameState={visible:true,side};
      if(frameEl){frameEl.style.width=side+'px';frameEl.style.height=side+'px';frameEl.hidden=false;frameEl.dataset.on='true';}
    }
    function hideFrame(){
      if(!frameState.visible)return;
      frameState={visible:false,side:frameState.side};
      if(frameEl){frameEl.dataset.on='false';frameEl.hidden=true;}
    }

    // ---- the run loop -------------------------------------------------------------------------
    function emit(name,info){state.phase=name;if(typeof hooks.onPhase==='function')try{hooks.onPhase(name,info||{});}catch(e){report(e);}}
    function report(e){if(typeof options.onError==='function')options.onError(e);else if(typeof console!=='undefined')console.error(e);}

    function endRun(r,result){
      if(!r||r.done)return false;
      r.done=true;if(run===r)run=null;
      if(rafId){caf(rafId);rafId=0;}
      r.resolve(result);return true;
    }

    /** Ends the current run where it is and makes both renderers agree about which one the person is looking at. */
    function settleStage(){
      if(stage==='toMap'){stage='map';setView('map',0);globe.stop();clearFadeTimer();}
      else if(stage==='toGlobe'){stage='globe';setView('globe',0);clearFadeTimer();}
      if(stage==='globe'){leafletEnd();}
      if(stage==='map'){leafletEnd();}
    }

    function cancel(why='cancelled'){
      const r=run;if(!r)return false;
      endRun(r,why);
      settleStage();
      if(stage==='map'){try{map.setView(map.getCenter(),map.getZoom(),{animate:false});}catch{}}
      else{globe.setDriven(false);globe.markUserActive();}
      state.phase='idle';
      return true;
    }

    function startRun(spec){
      if(run)endRun(run,'replaced');
      if(mapDirector)mapDirector.cancel('replaced');
      clearFadeTimer();
      return new Promise(resolve=>{
        const r={id:++runSeq,done:false,resolve,spec,start:null,fired:new Set(),detailIndex:0,blendStart:0,lastT:0};
        run=r;
        globe.setDriven(true);
        // The renderer in view at the start drives from the first frame.
        if(stage==='globe'||stage==='toGlobe'){/* globe is drawn by tick() */}
        const tick=ts=>{
          rafId=0;if(r.done||run!==r)return;
          if(r.start===null)r.start=ts;
          const t=clamp((ts-r.start)/1000,0,spec.duration);
          frame(r,t,ts);
          if(r.done)return;
          if(t>=spec.duration){finish(r);return;}
          rafId=raf(tick);
        };
        // The first call happens in the same turn so the very first frame is already on the path.
        rafId=raf(tick);
        if(spec.onStart)try{spec.onStart();}catch(e){report(e);}
      });
    }

    function frame(r,t,ts){
      const spec=r.spec,c=spec.at(t);
      state.lastCamera=c;r.lastT=t;
      const wantMap=spec.handoffAlt!=null&&c.alt<=spec.handoffAlt;
      if(wantMap&&(stage==='globe'||stage==='toGlobe'))beginBlend(r,'map',c,ts);
      else if(!wantMap&&spec.allowReturn&&(stage==='map'||stage==='toMap'))beginBlend(r,'globe',c,ts);
      if(stage==='toMap'||stage==='toGlobe'){
        if(ts-r.blendStart>=r.blendMs){
          if(stage==='toMap'){stage='map';globe.stop();}
          else{stage='globe';leafletEnd();}
        }
      }
      if(stage==='globe'||stage==='toMap'||stage==='toGlobe'){globe.setCamera({lon:c.lon,lat:c.lat,alt:c.alt},{quiet:true});globe.render();}
      if(stage==='map'||stage==='toMap'||stage==='toGlobe'){leafletBegin();leafletPlace(c.lat,c.lon,mapZoomFor(c.lat,c.alt));}
      if(spec.detail)checkDetail(r,c);
      if(spec.onFrame)try{spec.onFrame(c,t);}catch(e){report(e);}
      if(traceOn&&trace.length<TRACE_LIMIT)trace.push({t,lon:c.lon,lat:c.lat,alt:c.alt,stage,swept:c.swept});
      if(spec.phases)for(const p of spec.phases){if(t>=p.at&&!r.fired.has(p.name)){r.fired.add(p.name);emit(p.name,{t,camera:c});}}
    }

    function beginBlend(r,to,c,ts){
      r.blendStart=ts;r.blendMs=r.spec.fadeMs===undefined?fadeDefault:r.spec.fadeMs;
      if(to==='map'){
        leafletBegin();leafletPlace(c.lat,c.lon,mapZoomFor(c.lat,c.alt));
        stage='toMap';setView('map',r.blendMs);
        emit('handoff',{t:r.lastT,camera:c,to:'map'});
      }else{
        globe.setCamera({lon:c.lon,lat:c.lat,alt:c.alt},{quiet:true});globe.render();
        stage='toGlobe';setView('globe',r.blendMs);
        emit('handoff',{t:r.lastT,camera:c,to:'globe'});
      }
      if(r.blendMs<=0){if(to==='map'){stage='map';globe.stop();}else{stage='globe';leafletEnd();}}
    }

    function checkDetail(r,c){
      const mpp=GM.groundScaleForAlt(globe.camera.focal,c.lat,c.alt);
      while(r.detailIndex<DETAIL_SCALES.length-1&&mpp<=DETAIL_SCALES[r.detailIndex].mpp){
        const d=DETAIL_SCALES[r.detailIndex];r.detailIndex++;
        if(typeof hooks.onDetail==='function')try{hooks.onDetail(d.level,{name:d.name,mpp,camera:c});}catch(e){report(e);}
        state.detail=d.level;
      }
    }

    // ---- arrival ------------------------------------------------------------------------------
    function finish(r){
      const f=r.spec.final;
      if(f)applyFinal(f,{fade:r.spec.arrivalFade||0,fromRun:true});
      else{settleStage();if(stage==='globe')globe.setDriven(false);}
      const spec=r.spec;
      if(f&&spec.detail&&typeof hooks.onDetail==='function')try{hooks.onDetail(5,{name:'frame',mpp:f.mpp,camera:state.lastCamera});}catch(e){report(e);}
      endRun(r,'arrived');
      if(spec.onArrive)try{spec.onArrive();}catch(e){report(e);}
    }

    /** Puts the exact final view in place and shows the frame. Both renderers end in agreement. */
    function applyFinal(f,{fade=0,fromRun=false}={}){
      clearFadeTimer();
      if(f.renderer==='map'){
        // Close any sub-pixel gap and normalise the longitude to the true value (the same picture on another world copy).
        leafletEnd();
        map.setView([f.lat,f.lon],f.zoom,{animate:false,reset:true});
        if(stage!=='map'||view!=='map'){stage='map';setView('map',fade);retireHidden(fade);}
        else globe.stop();
      }else{
        leafletEnd();
        globe.setUserMinAlt(GM.MIN_ALT);
        globe.setCamera({lon:GM.unwrapNear(f.lon,globe.camera.lon),lat:f.lat,alt:f.alt},{quiet:true});
        globe.setDriven(false);globe.start();globe.render();
        stage='globe';if(view!=='globe')setView('globe',fade);
      }
      finalState={...f};
      showFrame(f.side);
      emit('final',{renderer:f.renderer});
    }

    // ---- public: the cinematic flight -----------------------------------------------------------
    /**
     * Flies from where the camera is to the five-mile frame around `location`. Resolves 'arrived', or the reason it
     * stopped ('cancelled', 'interrupted', 'replaced'). `revolutions` is 1 for the cinematic turn.
     */
    function fly(location,{duration=8,revolutions=1,fadeMs,onStart,onFrame}={}){
      const f=finalFor(location);
      hideFrame();
      // Start from the globe. If the flat map is showing, bring the globe up to the same view first, without a visible jump.
      const lay=layout();
      if(view==='map'||stage==='map'||stage==='toMap'){
        const m=altForMapView();
        globe.setCamera({lon:m.lon,lat:m.lat,alt:Math.min(GM.MAX_ALT,Math.max(m.alt,GM.MIN_ALT))},{quiet:true});
        settleStage();leafletEnd();stage='globe';setView('globe',0);
      }
      globe.setUserMinAlt(GM.MIN_ALT);
      const cam=globe.getCamera();
      const rate=globe.turning?idleRate:0;
      const plan=GM.planSequence({start:{lon:cam.lon,lat:cam.lat,alt:cam.alt},target:{lat:f.lat,lon:f.lon},finalAlt:f.alt,duration,revolutions,idleRate:rate});
      lastPlan=plan;
      const phases=[{name:'spin',at:0},{name:'orient',at:plan.latT0},{name:'descend',at:plan.descT0}];
      globe.setMarker({lat:f.lat,lon:f.lon});
      return startRun({
        label:'fly',duration,handoffAlt:f.renderer==='map'?f.handoffAlt:null,fadeMs,detail:true,phases,final:f,
        at:t=>GM.cameraAt(plan,t),
        onStart:()=>{emit('start',{plan,final:f});if(onStart)onStart(plan,f);},
        onFrame
      });
    }

    /** True when the globe is showing but closer than its resting height (a cancelled descent, or the person zoomed in). */
    function lowGlobe(){return view==='globe'&&stage==='globe'&&globe.getCamera().alt<GM.IDLE_ALT*REST_TOLERANCE;}
    /** A sequence should start from the whole globe: true when the camera first has to come back up to it. */
    function needsRise(){return view!=='globe'||stage!=='globe'||lowGlobe();}
    /**
     * Eases a globe that was left close to the surface (a cancelled descent) back to its resting height, keeping its
     * longitude and latitude. Instant when `ms` is 0. Does nothing when the flat map is showing or a sequence is running.
     */
    function relax(ms=900){
      if(run||view!=='globe'||stage!=='globe'||!lowGlobe())return Promise.resolve(false);
      if(ms<=0){const c=globe.getCamera();globe.setCamera({lon:c.lon,lat:c.lat,alt:GM.IDLE_ALT});return Promise.resolve(true);}
      globe.markUserActive();
      return globe.tweenTo({alt:GM.IDLE_ALT},ms);
    }

    /**
     * Brings the camera up from the flat map to the globe (the descent in reverse). Resolves like fly().
     * `target` is where the globe should end up; by default straight above the current map centre.
     */
    function rise({duration=1.6,fadeMs}={}){
      if(view==='globe'&&stage==='globe'&&!run&&!lowGlobe()){return Promise.resolve('arrived');}
      hideFrame();
      let start;
      if(view==='map'||stage==='map'||stage==='toMap'){start=altForMapView();}
      else{const c=globe.getCamera();start={lon:c.lon,lat:c.lat,alt:c.alt};}
      const lat=start.lat,endAlt=GM.IDLE_ALT;
      const f=finalState;
      const handoffMpp=f?f.handoffMpp:GM.handoffMetersPerPixel(lat,Math.min(layout().w,layout().h),1);
      const handoffAlt=GM.altForGroundScale(globe.camera.focal,lat,handoffMpp);
      if(stage==='globe'&&view==='globe'){globe.setCamera({lon:start.lon,lat:start.lat,alt:start.alt},{quiet:true});}
      return startRun({
        label:'rise',duration,handoffAlt,allowReturn:true,fadeMs,
        at:t=>{const u=smootherstep(t/duration);return {lon:start.lon,lat:start.lat,alt:Math.exp(lerp(Math.log(start.alt),Math.log(endAlt),u))};},
        final:null,
        onStart:()=>{emit('rise',{});}
      }).then(r=>{if(r==='arrived'){settleStage();globe.setDriven(false);globe.start();restoreLimit();}return r;});
    }

    // ---- public: immediate moves -----------------------------------------------------------------------
    /** Applies the final view at once (Skip, reduced motion, a fallback). `fadeMs` is the only visible transition. */
    function jump(location,{fadeMs=0}={}){
      if(run)endRun(run,'replaced');
      if(mapDirector)mapDirector.cancel('replaced');
      settleStage();
      const f=finalFor(location);
      globe.setMarker({lat:f.lat,lon:f.lon,locked:true});
      applyFinal(f,{fade:fadeMs});
      return f;
    }

    /** Returns to the globe without a path (Clear, no location, reduced motion). */
    function showGlobe({fadeMs=0,match=false}={}){
      if(run)endRun(run,'replaced');
      if(mapDirector)mapDirector.cancel('replaced');
      hideFrame();
      if(view==='globe'&&stage==='globe'){globe.setDriven(false);globe.start();restoreLimit();return;}
      const m=altForMapView();
      settleStage();
      // `match` keeps the ground scale the person was looking at; otherwise the globe returns to its resting height.
      const alt=match?clamp(m.alt,GM.MIN_ALT,GM.MAX_ALT):GM.IDLE_ALT;
      globe.setCamera({lon:m.lon,lat:m.lat,alt},{quiet:true});
      globe.setDriven(false);globe.start();globe.render();
      stage='globe';setView('globe',fadeMs);retireHidden(fadeMs);
      restoreLimit();
    }
    /** Switches to the flat map at the same centre and ground scale (the manual zoom-in past the globe's limit). */
    function showMap({fadeMs=fadeDefault,from}={}){
      if(view==='map')return;
      const c=from||globe.getCamera(),zoom=mapZoomFor(c.lat,c.alt);
      leafletEnd();
      map.setView([clamp(c.lat,-MAX_MERCATOR_LAT,MAX_MERCATOR_LAT),GM.wrapLon(c.lon)],zoom,{animate:false,reset:true});
      stage='map';setView('map',fadeMs);retireHidden(fadeMs);
    }

    function rest(){
      if(run)endRun(run,'replaced');
      if(mapDirector)mapDirector.cancel('replaced');
      hideFrame();
      settleStage();
      if(view==='map')showGlobe({fadeMs:finalFade});
      else{globe.setDriven(false);globe.start();}
    }

    /** Returns to the final frame for a coordinate. Animated through the same path as the descent, but short. */
    function recenter(location,{animate=true}={}){
      if(view==='globe'&&finalState&&finalState.renderer==='globe'&&animate){
        const f=finalFor(location);
        return globe.tweenTo({lon:f.lon,lat:f.lat,alt:f.alt},900).then(ok=>{if(ok)applyFinal(f);return ok?'arrived':'interrupted';});
      }
      if(view==='map'&&animate&&mapDirector){
        const f=finalFor(location);
        hideFrame();
        internalMove++;
        return mapDirector.recenter(location,{animate:true}).then(res=>{internalMove=Math.max(0,internalMove-1);if(res==='arrived')applyFinal(f);return res;});
      }
      jump(location,{fadeMs:finalFade});return Promise.resolve('arrived');
    }

    /** Re-fits the final view after the viewport changed size, so the frame always means five miles. */
    function refit(){
      if(!finalState||!frameState.visible||run)return false;
      const location={latitude:finalState.lat,longitude:finalState.lon};
      const f=finalFor(location);
      if(f.side===finalState.side&&f.w===finalState.w&&f.h===finalState.h)return false;
      applyFinal(f,{fade:0});return true;
    }

    // ---- manual input hands control back -----------------------------------------------------------------
    function interrupt(){
      if(run){const ok=cancel('interrupted');if(ok&&typeof hooks.onInterrupt==='function')try{hooks.onInterrupt();}catch(e){report(e);}}
      hideFrame();
    }
    if(map&&map.getContainer){
      const container=map.getContainer();
      for(const type of ['pointerdown','wheel','touchstart','dblclick'])container.addEventListener(type,interrupt,{passive:true,capture:true});
      container.addEventListener('keydown',e=>{if(/^(Arrow|\+|-|=|PageUp|PageDown|Home|End)/.test(e.key))interrupt();},true);
    }
    // A move the director did not make (the person dragging or zooming the map) means the frame no longer applies.
    if(map&&map.on)map.on('movestart zoomstart',()=>{if(!internalMove&&!run)hideFrame();});

    // ---- measurements for diagnostics and tests --------------------------------------------------------------
    function measureFrame(){
      if(!frameState.visible||!finalState)return null;
      const lay=layout(),cx=lay.w/2,cy=lay.h/2,r=frameState.side/2;
      const at=view==='map'?(x,y)=>{const p=map.containerPointToLatLng([x,y]);return {lat:p.lat,lon:p.lng};}:(x,y)=>globe.unproject(x,y);
      const pts={n:at(cx,cy-r),s:at(cx,cy+r),w:at(cx-r,cy),e:at(cx+r,cy),nw:at(cx-r,cy-r),ne:at(cx+r,cy-r),sw:at(cx-r,cy+r),se:at(cx+r,cy+r),c:at(cx,cy)};
      if(Object.values(pts).some(p=>!p))return null;
      const d=(a,b)=>GM.vincentyInverse(a.lat,a.lon,b.lat,b.lon);
      const width=d(pts.w,pts.e),height=d(pts.n,pts.s);
      return {
        renderer:view,sidePx:frameState.side,widthM:width,heightM:height,widthMiles:width/MILE,heightMiles:height/MILE,
        topM:d(pts.nw,pts.ne),bottomM:d(pts.sw,pts.se),leftM:d(pts.nw,pts.sw),rightM:d(pts.ne,pts.se),
        halfWestM:d(pts.c,pts.w),halfEastM:d(pts.c,pts.e),halfNorthM:d(pts.c,pts.n),halfSouthM:d(pts.c,pts.s),
        centre:{lat:pts.c.lat,lon:pts.c.lon},offsetFromTargetM:d(pts.c,{lat:finalState.lat,lon:finalState.lon})
      };
    }

    function dispose(){cancel('cancelled');clearFadeTimer();}

    return {
      fly,rise,relax,jump,showGlobe,showMap,rest,recenter,refit,cancel,interrupt,dispose,finalFor,measureFrame,showFrame,hideFrame,
      lockEffect(ms,onDone){
        // A short target-lock on the globe marker when the globe is the final renderer.
        if(view!=='globe'){if(onDone)onDone();return;}
        const t0=now();
        const step=()=>{const k=clamp((now()-t0)/ms,0,1);globe.setMarkerLock(k>=1?0:k,true);if(k<1)raf(step);else if(onDone)onDone();};
        raf(step);
      },
      setTrace(on){traceOn=!!on;if(on)trace.length=0;},
      get trace(){return trace.slice();},
      get view(){return view;},
      /** True when a sequence must first back off to the whole globe (flat map showing, or the globe left close). */
      get needsRise(){return needsRise();},
      get stage(){return stage;},
      get running(){return !!run;},
      /** True while the director is moving either renderer, so a zoom event it caused is not mistaken for the person's. */
      get busy(){return !!run||internalMove>0||mapDriving;},
      get runLabel(){return run?run.spec.label:null;},
      get phase(){return state.phase;},
      get plan(){return lastPlan;},
      get final(){return finalState?{...finalState}:null;},
      get frameVisible(){return frameState.visible;},
      snapshot(){
        const c=globe.getCamera(),r=run;
        return {
          view,stage,running:!!r,run:r?{label:r.spec.label,t:r.lastT,duration:r.spec.duration}:null,phase:state.phase,detail:state.detail,
          plan:lastPlan?{sweep:lastPlan.sweep,revolutions:lastPlan.revolutions,duration:lastPlan.T,lonStart:lastPlan.lonStart,lonEnd:lastPlan.lonEnd,altEnd:lastPlan.altEnd}:null,
          globe:{lon:c.lon,lat:c.lat,alt:c.alt},
          final:finalState?{lat:finalState.lat,lon:finalState.lon,renderer:finalState.renderer,zoom:finalState.zoom,side:finalState.side,handoffMpp:finalState.handoffMpp}:null,
          frame:{visible:frameState.visible,side:frameState.side,measured:measureFrame()}
        };
      }
    };
  }

  return {create,DETAIL_SCALES};
});
