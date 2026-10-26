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
  /**
   * `bounds` is one [west, south, east, north] box or a list of them (bundled data and installed regional packages).
   * `zoomFor(location)` supplies the final zoom (the five-mile frame, fitted from the viewport); without it the fixed
   * street and overview zooms of earlier versions are used.
   */
  function inBounds(location,bounds){
    if(!Array.isArray(bounds)||!bounds.length)return false;
    const boxes=Array.isArray(bounds[0])?bounds:[bounds];
    return boxes.some(b=>Array.isArray(b)&&location.longitude>=b[0]&&location.longitude<=b[2]&&location.latitude>=b[1]&&location.latitude<=b[3]);
  }
  function classify(location,bounds,zoomFor){
    if(!location||!Number.isFinite(location.latitude)||!Number.isFinite(location.longitude))return {kind:'none'};
    if(Math.abs(location.latitude)>MAX_MERCATOR_LAT)return {kind:'polar'};
    // Without bundled street geometry nothing is regional: the exact point stays on the world overview.
    const regional=inBounds(location,bounds);
    const zoom=typeof zoomFor==='function'?zoomFor(location):regional?STREET_ZOOM:OVERVIEW_ZOOM;
    return regional?{kind:'regional',zoom}:{kind:'overview',zoom};
  }

  function create({L,map,bounds,onInterrupt,zoomFor}){
    const getBounds=typeof bounds==='function'?bounds:()=>bounds;
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
          if(Math.abs(map.getZoom()-zoom)>tolerance)return;
          // Leaflet quantises the centre to whole pixels once the person has dragged the map, so "arrived" means
          // within a pixel and a half at the target zoom, not equal to the last digit.
          const degPerPixel=360/(256*Math.pow(2,zoom)),lngSlack=1.5*degPerPixel,latSlack=1.5*degPerPixel*Math.max(Math.cos(target.lat*Math.PI/180),.05);
          if(Math.abs(c.lat-target.lat)>latSlack||Math.abs(c.lng-target.lng)>lngSlack)return;
          const finalLng=!keepWorldCopy&&trueLongitude!==undefined?trueLongitude:target.lng;
          if(Math.abs(c.lat-target.lat)>1e-9||Math.abs(c.lng-finalLng)>1e-9){
            // `reset` matters: at an unchanged zoom Leaflet would otherwise pan by whole pixels and leave the gap.
            // Close the last sub-pixel gap, and normalise a longitude that was unwrapped for the flight (same picture on
            // another world copy), so later panning, Recenter and the readout all use the true coordinate.
            f.done=true;map.off('moveend',f.onEnd);if(flight===f)flight=null;
            map.setView([target.lat,finalLng],zoom,{animate:false,reset:true});resolve('arrived');return;
          }
          settleFlight(f,'arrived');
        };
        flight=f;map.on('moveend',f.onEnd);
        if(!animate||duration<=0)map.setView(target,zoom,{animate:false});
        else map.flyTo(target,zoom,{animate:true,duration});
      });
    }

    function fly(location,{animate=true,duration=2.9}={}){
      const plan=classify(location,getBounds(),zoomFor);
      if(plan.kind==='none'||plan.kind==='polar')return Promise.resolve('skipped');
      const c=map.getCenter(),lng=unwrapLongitude(location.longitude,c.lng);
      return move({lat:location.latitude,lng},plan.zoom,{animate,duration,trueLongitude:location.longitude});
    }

    /** Immediate placement at the final view (skip, reduced motion, renderer fallback). */
    function jump(location){
      const plan=classify(location,getBounds(),zoomFor);
      if(flight)cancel('replaced');
      if(plan.kind==='none'||plan.kind==='polar')return plan;
      map.setView([location.latitude,location.longitude],plan.zoom,{animate:false,reset:true});
      return plan;
    }

    /** A short, quiet move back to a wide view, used before a new descent. */
    function widen({animate=true,duration=1.1}={}){
      const c=map.getCenter();if(map.getZoom()<=WIDE_ZOOM+.5)return Promise.resolve('arrived');
      return move({lat:c.lat,lng:c.lng},WIDE_ZOOM,{animate,duration});
    }

    /** Ends any move in progress and leaves the camera on the wide view if it is closer in than that. Used when
     *  nothing can be plotted, so a result without a location never ends mid-zoom or stuck on an earlier street view. */
    function rest(){
      if(flight)cancel('replaced');
      if(map.getZoom()>WIDE_ZOOM+.5)map.setView(map.getCenter(),WIDE_ZOOM,{animate:false,reset:true});
    }

    function recenter(location,{animate=true}={}){
      const plan=classify(location,getBounds(),zoomFor);if(plan.kind==='none'||plan.kind==='polar')return Promise.resolve('skipped');
      const c=map.getCenter(),lng=unwrapLongitude(location.longitude,c.lng);
      return move({lat:location.latitude,lng},plan.zoom,{animate,duration:.9,trueLongitude:location.longitude});
    }

    // Any deliberate manual map input hands control back to the person.
    const interrupt=()=>{if(cancel('interrupted')&&typeof onInterrupt==='function')onInterrupt();};
    for(const type of ['pointerdown','wheel','touchstart','dblclick'])container.addEventListener(type,interrupt,{passive:true,capture:true});
    container.addEventListener('keydown',e=>{if(/^(Arrow|\+|-|=|PageUp|PageDown|Home|End)/.test(e.key))interrupt();},true);

    return {
      fly,jump,widen,rest,recenter,cancel,classify:loc=>classify(loc,getBounds(),zoomFor),
      get flying(){return !!flight;},
      get flightId(){return flight?flight.id:0;},
      dispose(){cancel('cancelled');}
    };
  }

  return {create,classify,unwrapLongitude,MAX_MERCATOR_LAT,STREET_ZOOM,OVERVIEW_ZOOM,WIDE_ZOOM};
});
