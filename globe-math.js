/*
 * Globe maths: everything about the globe that is a pure function.
 *
 * Nothing here touches the DOM, a canvas or a clock, so it can be tested in Node and reasoned about on paper.
 *
 *   - geodesy: WGS84 ground scale, Vincenty and haversine distances, the five-mile frame bounds
 *   - Web Mercator fit: the Leaflet zoom at which a square frame covers five miles of ground at a latitude
 *   - camera: a perspective camera looking at the centre of a unit sphere, north up
 *   - sequence: the cinematic plan, with an UNWRAPPED longitude so that no easing function can shorten the turn
 *
 * The camera is three numbers: longitude (degrees, unwrapped, never normalised), latitude and altitude (metres above
 * the surface). The ground scale at the point directly below the camera is altitude / focal length metres per pixel,
 * which is the same quantity Leaflet exposes as metres per pixel, so the two renderers can be matched numerically.
 */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.GlobeMath=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';

  const D2R=Math.PI/180,R2D=180/Math.PI;
  const WGS84_A=6378137,WGS84_F=1/298.257223563,WGS84_E2=WGS84_F*(2-WGS84_F);
  const R_MEAN=6371008.8;                 // sphere used to draw the globe; ground distances use the ellipsoid
  const MILE=1609.344;
  const FRAME_MILES=5,FRAME_METERS=FRAME_MILES*MILE;       // 8,046.72 m wide and high; 4,023.36 m from the point to each edge
  const MAX_MERCATOR_LAT=85.05112878;
  const FOV_DEG=36;                       // field of view across the smaller viewport side
  const MIN_ALT=200;                      // metres: closest the globe camera may be
  const IDLE_ALT=3*R_MEAN;                // default orbit: 4 Earth radii from the centre
  const MAX_ALT=7*R_MEAN;

  const clamp=(v,lo,hi)=>Math.min(hi,Math.max(lo,v));
  const lerp=(a,b,t)=>a+(b-a)*t;
  const mod=(a,n)=>((a%n)+n)%n;
  const smoothstep=t=>{t=clamp(t,0,1);return t*t*(3-2*t);};
  const smootherstep=t=>{t=clamp(t,0,1);return t*t*t*(t*(t*6-15)+10);};
  /** Quintic Hermite with zero acceleration at both ends: position p0 to p1, end slopes v0 and v1 (per unit of u). */
  function hermite5(u,p0,p1,v0,v1){
    u=clamp(u,0,1);const u2=u*u,u3=u2*u,u4=u3*u,u5=u4*u;
    return (1-10*u3+15*u4-6*u5)*p0+(u-6*u3+8*u4-3*u5)*v0+(10*u3-15*u4+6*u5)*p1+(-4*u3+7*u4-3*u5)*v1;
  }
  function hermite5Slope(u,p0,p1,v0,v1){
    u=clamp(u,0,1);const u2=u*u,u3=u2*u,u4=u3*u;
    return (-30*u2+60*u3-30*u4)*p0+(1-18*u2+32*u3-15*u4)*v0+(30*u2-60*u3+30*u4)*p1+(-12*u2+28*u3-15*u4)*v1;
  }

  /** Longitude in [-180, 180). */
  const wrapLon=lon=>mod(lon+180,360)-180;
  /** `lon` moved by whole turns to the copy nearest `ref`. */
  const unwrapNear=(lon,ref)=>lon+360*Math.round((ref-lon)/360);

  // ---- geodesy ------------------------------------------------------------------------
  function ellipsoidScale(lat){
    const s=Math.sin(lat*D2R),w=1-WGS84_E2*s*s,sw=Math.sqrt(w);
    const N=WGS84_A/sw,M=WGS84_A*(1-WGS84_E2)/(w*sw);
    return {M,N,metersPerDegLat:M*D2R,metersPerDegLon:N*Math.cos(lat*D2R)*D2R,gaussianRadius:Math.sqrt(M*N)};
  }

  function haversine(lat1,lon1,lat2,lon2,radius=R_MEAN){
    const p1=lat1*D2R,p2=lat2*D2R,dp=p2-p1,dl=(lon2-lon1)*D2R;
    const a=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
    return 2*radius*Math.asin(Math.min(1,Math.sqrt(a)));
  }

  /** Vincenty's inverse formula on WGS84, metres. Accurate to well under a millimetre except for near-antipodal pairs. */
  function vincentyInverse(lat1,lon1,lat2,lon2){
    const a=WGS84_A,f=WGS84_F,b=(1-f)*a;
    const L=wrapLon(lon2-lon1)*D2R;
    const U1=Math.atan((1-f)*Math.tan(lat1*D2R)),U2=Math.atan((1-f)*Math.tan(lat2*D2R));
    const sinU1=Math.sin(U1),cosU1=Math.cos(U1),sinU2=Math.sin(U2),cosU2=Math.cos(U2);
    let lambda=L,prev,iter=0,sinSigma,cosSigma,sigma,cos2Alpha,cos2SigmaM;
    do{
      const sinL=Math.sin(lambda),cosL=Math.cos(lambda);
      sinSigma=Math.sqrt((cosU2*sinL)**2+(cosU1*sinU2-sinU1*cosU2*cosL)**2);
      if(sinSigma===0)return 0;
      cosSigma=sinU1*sinU2+cosU1*cosU2*cosL;sigma=Math.atan2(sinSigma,cosSigma);
      const sinAlpha=cosU1*cosU2*sinL/sinSigma;cos2Alpha=1-sinAlpha*sinAlpha;
      cos2SigmaM=cos2Alpha!==0?cosSigma-2*sinU1*sinU2/cos2Alpha:0;
      const C=f/16*cos2Alpha*(4+f*(4-3*cos2Alpha));prev=lambda;
      lambda=L+(1-C)*f*sinAlpha*(sigma+C*sinSigma*(cos2SigmaM+C*cosSigma*(-1+2*cos2SigmaM*cos2SigmaM)));
    }while(Math.abs(lambda-prev)>1e-12&&++iter<200);
    const u2=cos2Alpha*(a*a-b*b)/(b*b);
    const A=1+u2/16384*(4096+u2*(-768+u2*(320-175*u2))),B=u2/1024*(256+u2*(-128+u2*(74-47*u2)));
    const ds=B*sinSigma*(cos2SigmaM+B/4*(cosSigma*(-1+2*cos2SigmaM*cos2SigmaM)-B/6*cos2SigmaM*(-3+4*sinSigma*sinSigma)*(-3+4*cos2SigmaM*cos2SigmaM)));
    return b*A*(sigma-ds);
  }

  /**
   * The five-mile frame around a point, in degrees. `halfMeters` is the distance from the point to each edge (not a
   * radius). The longitude edges are returned UNWRAPPED (west may be below -180, east above 180), with
   * `crossesAntimeridian` set, plus the same edges wrapped for lookups. Near a pole the longitude span is not
   * meaningful, so `polar` is set and the span is the whole circle.
   */
  function frameBounds(lat,lon,halfMeters=FRAME_METERS/2){
    const sc=ellipsoidScale(lat),dLat=halfMeters/sc.metersPerDegLat;
    const polar=Math.abs(lat)+dLat>=90-1e-9;
    const dLon=polar||sc.metersPerDegLon<1e-6?180:Math.min(180,halfMeters/sc.metersPerDegLon);
    const west=lon-dLon,east=lon+dLon;
    return {
      south:Math.max(-90,lat-dLat),north:Math.min(90,lat+dLat),west,east,dLat,dLon,polar,
      crossesAntimeridian:!polar&&(west<-180||east>180),
      wrapped:{west:wrapLon(west),east:wrapLon(east)}
    };
  }

  // ---- Web Mercator fit (Leaflet's CRS: 256 px tiles, x = 256 * 2^z * (lon + 180) / 360) ---------------------
  const mercatorY=lat=>Math.log(Math.tan(Math.PI/4+clamp(lat,-MAX_MERCATOR_LAT,MAX_MERCATOR_LAT)*D2R/2));
  /**
   * Metres of ground per pixel at a latitude and zoom, horizontal and vertical, on the WGS84 ellipsoid. Web Mercator is
   * conformal on a sphere; on the ellipsoid the two differ slightly, so both are reported and the fit uses their mean.
   */
  function mercatorGroundScale(lat,zoom){
    const sc=ellipsoidScale(lat),k=256*Math.pow(2,zoom)/360,cosLat=Math.cos(lat*D2R);
    const h=sc.metersPerDegLon/k,v=sc.metersPerDegLat*cosLat/k;
    return {horizontal:h,vertical:v,mean:(h+v)/2};
  }
  /** Zoom at which the mean ground scale is `mpp` metres per pixel. */
  function zoomForMetersPerPixel(lat,mpp){
    const sc=ellipsoidScale(lat),cosLat=Math.cos(lat*D2R);
    return Math.log2(((sc.metersPerDegLon+sc.metersPerDegLat*cosLat)/2)*360/(256*mpp));
  }
  /** The zoom and ground extents for a square frame `framePx` pixels wide that should cover `frameMeters` of ground. */
  function fitFrame(lat,framePx,frameMeters=FRAME_METERS){
    const mpp=frameMeters/framePx,zoom=zoomForMetersPerPixel(lat,mpp),g=mercatorGroundScale(lat,zoom);
    return {zoom,metersPerPixel:mpp,widthMeters:g.horizontal*framePx,heightMeters:g.vertical*framePx};
  }
  /** Side of the square target frame for a map viewport. */
  const FRAME_MARGIN=72,FRAME_MIN=200,FRAME_MAX=640,FRAME_FLOOR=160;
  /**
   * `reserve` ({top, bottom}, pixels) is the band of the pane that text overlays keep for themselves. The frame is centred
   * on the point, which is the centre of the pane, so it can be no larger than twice the room above or below that centre
   * once those bands are taken out. Without it the frame is sized from the pane alone.
   */
  function frameSide(width,height,reserve){
    const m=Math.min(width,height);
    let side=clamp(m-2*FRAME_MARGIN,FRAME_MIN,FRAME_MAX);
    if(reserve){
      const half=Math.min(height/2-(reserve.top||0),height/2-(reserve.bottom||0));
      if(Number.isFinite(half))side=Math.min(side,Math.max(FRAME_FLOOR,2*half));
    }
    return Math.round(Math.min(side,Math.max(120,m-24)));   // never larger than the pane allows
  }
  /** True when Web Mercator can draw the whole viewport around the frame (otherwise the globe stays the final renderer). */
  function mercatorCanShow(lat,mpp,width,height){
    const sc=ellipsoidScale(lat),halfDeg=(height/2)*mpp/sc.metersPerDegLat*1.15;
    return Math.abs(lat)+halfDeg<=MAX_MERCATOR_LAT;
  }

  // ---- camera ----------------------------------------------------------------------------
  function toVec(lat,lon,out=[0,0,0]){
    const p=lat*D2R,l=lon*D2R,cp=Math.cos(p);out[0]=cp*Math.cos(l);out[1]=cp*Math.sin(l);out[2]=Math.sin(p);return out;
  }
  function fromVec(x,y,z){const r=Math.hypot(x,y,z)||1;return {lat:Math.asin(clamp(z/r,-1,1))*R2D,lon:Math.atan2(y,x)*R2D};}
  /** North tangent (d position / d latitude): defined and continuous at the poles. */
  function northVec(lat,lon,out=[0,0,0]){
    const p=lat*D2R,l=lon*D2R;out[0]=-Math.sin(p)*Math.cos(l);out[1]=-Math.sin(p)*Math.sin(l);out[2]=Math.cos(p);return out;
  }

  /** Focal length in pixels so that the smaller side spans FOV_DEG. */
  const focalFor=(width,height,fov=FOV_DEG)=>Math.min(width,height)/2/Math.tan(fov*D2R/2);

  /**
   * A perspective camera at (lon, lat, alt) looking at the centre of the unit sphere, with north up.
   * Units: the sphere has radius 1. A point `p` (unit vector) is visible when p . c >= 1 / D.
   */
  function createCamera(width,height,fov=FOV_DEG){
    const cam={width,height,fov,cx:width/2,cy:height/2,focal:focalFor(width,height,fov),lon:0,lat:0,alt:IDLE_ALT,
      c:[1,0,0],e:[0,1,0],n:[0,0,1],D:1+IDLE_ALT/R_MEAN,horizon:1,limb:0};
    cam.set=function(lon,lat,alt){
      this.lon=lon;this.lat=clamp(lat,-90,90);this.alt=clamp(alt,MIN_ALT,MAX_ALT);
      toVec(this.lat,lon,this.c);northVec(this.lat,lon,this.n);
      const l=lon*D2R;this.e[0]=-Math.sin(l);this.e[1]=Math.cos(l);this.e[2]=0;
      this.D=1+this.alt/R_MEAN;this.horizon=1/this.D;
      this.limb=this.focal/Math.sqrt(this.D*this.D-1);   // projected radius of the visible disc, in pixels
      return this;
    };
    cam.resize=function(w,h){this.width=w;this.height=h;this.cx=w/2;this.cy=h/2;this.focal=focalFor(w,h,this.fov);return this.set(this.lon,this.lat,this.alt);};
    /** Metres of ground per pixel at the point directly below the camera. */
    cam.metersPerPixel=function(){return this.alt/this.focal;};
    /** Projects a unit vector. Returns false when it is on the far side of the horizon (out is untouched). */
    cam.project=function(x,y,z,out){
      const c=this.c,dotc=x*c[0]+y*c[1]+z*c[2];
      if(dotc<this.horizon)return false;
      const depth=this.D-dotc;
      out[0]=this.cx+this.focal*(x*this.e[0]+y*this.e[1]+z*this.e[2])/depth;
      out[1]=this.cy-this.focal*(x*this.n[0]+y*this.n[1]+z*this.n[2])/depth;
      out[2]=depth;return true;
    };
    cam.projectLatLon=function(lat,lon,out=[0,0,0]){const v=toVec(lat,lon);return this.project(v[0],v[1],v[2],out)?out:null;};
    /** The point on the sphere under a pixel, as {lat, lon, vec}, or null if the pixel misses the globe. */
    cam.unproject=function(px,py){
      const dx=(px-this.cx)/this.focal,dy=-(py-this.cy)/this.focal,c=this.c,e=this.e,n=this.n,D=this.D;
      const d0=dx*e[0]+dy*n[0]-c[0],d1=dx*e[1]+dy*n[1]-c[1],d2=dx*e[2]+dy*n[2]-c[2];
      const P0=c[0]*D,P1=c[1]*D,P2=c[2]*D;
      const a=d0*d0+d1*d1+d2*d2,b=2*(P0*d0+P1*d1+P2*d2),cc=D*D-1,disc=b*b-4*a*cc;
      if(disc<0)return null;
      const t=(-b-Math.sqrt(disc))/(2*a),x=P0+t*d0,y=P1+t*d1,z=P2+t*d2,ll=fromVec(x,y,z);
      return {lat:ll.lat,lon:ll.lon,vec:[x,y,z]};
    };
    return cam.set(0,0,IDLE_ALT);
  }

  /**
   * The globe is drawn on a sphere of mean radius, but ground distances belong to the WGS84 ellipsoid. A real metre on
   * the ground at `lat` spans slightly more or less sphere than a sphere metre, by the local radius over the mean one.
   * These two convert between camera altitude and real ground metres per pixel at the point under the camera.
   */
  const groundScaleForAlt=(focal,lat,alt)=>alt/focal*ellipsoidScale(lat).gaussianRadius/R_MEAN;
  const altForGroundScale=(focal,lat,mpp)=>focal*mpp*R_MEAN/ellipsoidScale(lat).gaussianRadius;
  /** Ground scale at the hand-off from the globe to the flat map. About 1 km per pixel, finer at high latitude. */
  function handoffMetersPerPixel(lat,minSide,finalMpp){
    const t=Math.max(Math.abs(Math.tan(lat*D2R)),.05);
    return Math.max(finalMpp*1.35,Math.min(1000,509680/(t*minSide)));
  }

  // ---- the cinematic sequence ---------------------------------------------------------------
  /**
   * Plans one sequence. Lengths are seconds, angles degrees, altitudes metres.
   *
   *   start      {lon (unwrapped), lat, alt}  where the camera is now
   *   target     {lat, lon}                   the coordinate in the image
   *   finalAlt   altitude at which the five-mile frame fills the target frame
   *   revolutions 1 = at least one full 360 degree turn; 0 = the shortest way round (Fast)
   *   idleRate   degrees per second the globe was turning at, so the turn continues from that speed
   *
   * The camera moves west (its longitude falls), which turns the surface eastward as the real Earth does. The total
   * sweep is 360 * revolutions + the remaining westward distance to the target meridian, so it ends exactly on it and
   * is never less than a full turn. Longitude is NEVER normalised inside the plan.
   */
  function planSequence({start,target,finalAlt,duration,revolutions=1,idleRate=4,spinFraction=.6,descentStart=.46,orientStart=.1,orientEnd=.58}){
    const T=duration,deltaWest=mod(start.lon-target.lon,360);
    let sweep;
    if(revolutions>=1)sweep=360*Math.floor(revolutions)+deltaWest;
    else sweep=deltaWest<=180?deltaWest:deltaWest-360;
    const spinT=T*spinFraction;
    return {
      T,spinT,revolutions:revolutions>=1?Math.floor(revolutions):0,
      lonStart:start.lon,lonEnd:start.lon-sweep,sweep,
      v0:sweep>0?idleRate*spinT:0,
      latStart:start.lat,latEnd:target.lat,
      altStart:start.alt,altEnd:Math.min(finalAlt,start.alt),
      latT0:T*orientStart,latT1:T*orientEnd,descT0:T*descentStart,
      target:{lat:target.lat,lon:target.lon}
    };
  }
  /** Camera state at `t` seconds into the plan. */
  function cameraAt(plan,t){
    t=clamp(t,0,plan.T);
    const us=plan.spinT>0?clamp(t/plan.spinT,0,1):1;
    const swept=hermite5(us,0,plan.sweep,plan.v0,0);
    const lat=lerp(plan.latStart,plan.latEnd,smootherstep((t-plan.latT0)/Math.max(1e-9,plan.latT1-plan.latT0)));
    const w=clamp((t-plan.descT0)/Math.max(1e-9,plan.T-plan.descT0),0,1);
    const alt=Math.exp(lerp(Math.log(plan.altStart),Math.log(plan.altEnd),smootherstep(w)));
    return {t,lon:plan.lonStart-swept,lat,alt,swept,spin:us,descent:w};
  }
  /** Rotation speed in degrees per second at `t` (positive = camera moving west). */
  function spinRateAt(plan,t){
    if(plan.spinT<=0)return 0;const us=clamp(t/plan.spinT,0,1);
    return hermite5Slope(us,0,plan.sweep,plan.v0,0)/plan.spinT;
  }

  return {
    D2R,R2D,WGS84_A,WGS84_F,R_MEAN,MILE,FRAME_MILES,FRAME_METERS,MAX_MERCATOR_LAT,FOV_DEG,MIN_ALT,MAX_ALT,IDLE_ALT,
    FRAME_MARGIN,FRAME_MIN,FRAME_MAX,FRAME_FLOOR,
    clamp,lerp,mod,smoothstep,smootherstep,hermite5,hermite5Slope,wrapLon,unwrapNear,
    ellipsoidScale,haversine,vincentyInverse,frameBounds,
    mercatorY,mercatorGroundScale,zoomForMetersPerPixel,fitFrame,frameSide,mercatorCanShow,
    toVec,fromVec,northVec,focalFor,createCamera,groundScaleForAlt,altForGroundScale,handoffMetersPerPixel,
    planSequence,cameraAt,spinRateAt
  };
});
