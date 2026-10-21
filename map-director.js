/*
 * Map director: owns every deliberate camera move.
 *
 * It uses the real Leaflet camera (flyTo / setView) and its real completion
 * events. It never scales a screenshot. Each move gets an id; a completion event
 * only counts if it belongs to the move that is still current and the camera is
 * actually where that move was going, so a stale or unrelated `moveend` (resize,
 * an earlier cancelled flight) cannot be mistaken for arrival.
 *
 * The director only moves the camera. The coordinates it is given are display
 * targets; the original report.location is never read back from, or replaced by,
 * anything here. Longitude is unwrapped to the nearest world copy only for the
 * flight path, then normalised to the true longitude on arrival.
 */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.MapDirector=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';

  const MAX_MERCATOR_LAT=85.05112878;
  const STREET_ZOOM=18,OVERVIEW_ZOOM=5,WIDE_ZOOM=3;
  const unwrapLongitude=(lng,centerLng)=>lng+360*Math.round((centerLng-lng)/360);

  /** What the map can honestly show for a coordinate. Pure, so it can be tested without a map. */
  function classify(location,bounds){
    if(!location||!Number.isFinite(location.latitude)||!Number.isFinite(location.longitude))return {kind:'none'};
    if(Math.abs(location.latitude)>MAX_MERCATOR_LAT)return {kind:'polar'};
    // Without bundled street geometry nothing is regional: the exact point stays on the world overview.
    const regional=Array.isArray(bounds)&&location.longitude>=bounds[0]&&location.longitude<=bounds[2]&&location.latitude>=bounds[1]&&location.latitude<=bounds[3];
    return regional?{kind:'regional',zoom:STREET_ZOOM}:{kind:'overview',zoom:OVERVIEW_ZOOM};
  }

  function create({L,map,bounds,onInterrupt}){
    let flight=null,sequence=0;
    const container=map.getContainer();

    function freeze(){map.setView(map.getCenter(),map.getZoom(),{animate:false});}

    function settleFlight(f,result){
      if(f.done)return false;
      f.done=true;map.off('moveend',f.onEnd);if(flight===f)flight=null;f.resolve(result);return true;
    }

    /** Stops the current move where it is. Resolves its promise with `why`. */
    function cancel(why='cancelled'){
      const f=flight;if(!f)return false;
      f.done=true;map.off('moveend',f.onEnd);flight=null;
      freeze();
      f.resolve(why);return true;
    }

    /** Moves the camera. Resolves 'arrived', or 'cancelled' / 'interrupted' / 'replaced' if stopped first. */
    function move(latlng,zoom,{animate=true,duration=2.9,trueLongitude,keepWorldCopy=false}={}){
      if(flight)cancel('replaced');
      return new Promise(resolve=>{
        const id=++sequence,target=L.latLng(latlng.lat,latlng.lng),f={id,done:false,resolve,target,zoom};
        const tolerance=1e-4;
        f.onEnd=()=>{
          if(flight!==f||f.done)return;
          const c=map.getCenter();
          if(Math.abs(map.getZoom()-zoom)>tolerance||Math.abs(c.lat-target.lat)>1e-7||Math.abs(c.lng-target.lng)>1e-7)return;
          if(!keepWorldCopy&&trueLongitude!==undefined&&Math.abs(trueLongitude-target.lng)>1e-9){
            // Same picture on another world copy: normalise so later panning and the pin use the true longitude.
            f.done=true;map.off('moveend',f.onEnd);if(flight===f)flight=null;
            map.setView([target.lat,trueLongitude],zoom,{animate:false});resolve('arrived');return;
          }
          settleFlight(f,'arrived');
        };
        flight=f;map.on('moveend',f.onEnd);
        if(!animate||duration<=0)map.setView(target,zoom,{animate:false});
        else map.flyTo(target,zoom,{animate:true,duration});
      });
    }

    function fly(location,{animate=true,duration=2.9}={}){
      const plan=classify(location,bounds);
      if(plan.kind==='none'||plan.kind==='polar')return Promise.resolve('skipped');
      const c=map.getCenter(),lng=unwrapLongitude(location.longitude,c.lng);
      return move({lat:location.latitude,lng},plan.zoom,{animate,duration,trueLongitude:location.longitude});
    }

    /** Immediate placement at the final view (skip, reduced motion, renderer fallback). */
    function jump(location){
      const plan=classify(location,bounds);
      if(flight)cancel('replaced');
      if(plan.kind==='none'||plan.kind==='polar')return plan;
      map.setView([location.latitude,location.longitude],plan.zoom,{animate:false});
      return plan;
    }

    /** A short, quiet move back to a wide view, used before a new descent. */
    function widen({animate=true,duration=1.1}={}){
      const c=map.getCenter();if(map.getZoom()<=WIDE_ZOOM+.5)return Promise.resolve('arrived');
      return move({lat:c.lat,lng:c.lng},WIDE_ZOOM,{animate,duration});
    }

    function recenter(location,{animate=true}={}){
      const plan=classify(location,bounds);if(plan.kind==='none'||plan.kind==='polar')return Promise.resolve('skipped');
      const c=map.getCenter(),lng=unwrapLongitude(location.longitude,c.lng);
      return move({lat:location.latitude,lng},plan.zoom,{animate,duration:.9,trueLongitude:location.longitude});
    }

    // Any deliberate manual map input hands control back to the person.
    const interrupt=()=>{if(cancel('interrupted')&&typeof onInterrupt==='function')onInterrupt();};
    for(const type of ['pointerdown','wheel','touchstart','dblclick'])container.addEventListener(type,interrupt,{passive:true,capture:true});
    container.addEventListener('keydown',e=>{if(/^(Arrow|\+|-|=|PageUp|PageDown|Home|End)/.test(e.key))interrupt();},true);

    return {
      fly,jump,widen,recenter,cancel,classify:loc=>classify(loc,bounds),
      get flying(){return !!flight;},
      get flightId(){return flight?flight.id:0;},
      dispose(){cancel('cancelled');}
    };
  }

  return {create,classify,unwrapLongitude,MAX_MERCATOR_LAT,STREET_ZOOM,OVERVIEW_ZOOM,WIDE_ZOOM};
});
