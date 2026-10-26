/*
 * Tile schema adapter: decoded vector-tile layers -> what the offline map layer draws.
 *
 * Vector tiles say what is where, not how it looks, and every tile producer names its layers and properties differently.
 * This reads two widely used schemas (the Protomaps basemap schema and OpenMapTiles) and the small extension the bundled
 * Gainesville converter writes, and reduces them to the vocabulary the canvas layer already draws:
 *
 *   polygons   green, parking, paved, water, building
 *   lines      road (with a highway class), waterway, rail
 *   points     tree, furniture, bus, poi
 *   labels     place names, road names, point-of-interest names
 *
 * Anything it does not recognise is dropped, never guessed at, and counted.
 *
 * Output geometry is in "world pixels at zoom 0" (256 px for the whole Web Mercator world), relative to the tile centre,
 * which is the unit space the canvas layer draws in. Float32 is exact enough: a tile at zoom 15 spans 0.0078 units and
 * float32 resolves 5e-10, a thousandth of a pixel at zoom 22.
 *
 * Verified against one real archive: the Protomaps basemap sample for Florence in the protomaps/PMTiles repository (basemap
 * build 3.7.1, kept in data/samples/). That is where the "pmap:" property prefix, the layers physical_line and physical_point,
 * and the real vocabulary of road, place and transit kinds below come from. OpenMapTiles names follow its public
 * documentation and have only been exercised with tiles built to that description (tests/helpers).
 */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.TileSchema=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';

  const TILE=256,D2R=Math.PI/180,R2D=180/Math.PI;
  const MAX_LABELS_PER_TILE=500,MAX_LABELS_COLLECTED=20000;

  const KNOWN_HIGHWAYS=new Set(['motorway','motorway_link','trunk','trunk_link','primary','primary_link','secondary','secondary_link','tertiary','tertiary_link','residential','unclassified','service','living_street','pedestrian','footway','path','cycleway','steps','track','corridor','bridleway','busway','road','construction','elevator','bus_stop']);
  const GREEN=new Set(['park','nature_reserve','national_park','forest','wood','golf_course','cemetery','garden','playground','grass','grassland','meadow','farmland','farm','orchard','vineyard','recreation_ground','pitch','village_green','scrub','heath','wetland','allotments','common','dog_park','sports_centre','stadium','track','zoo','protected_area','plant_nursery','greenfield','landfill','quarry','cropland','forest_wood','tree','shrub','grass_land']);
  const PAVED=new Set(['pedestrian','plaza','square','paved','apron','runway','taxiway','pier','bridge','platform']);
  const WATER_AREAS=new Set(['water','ocean','sea','lake','river','riverbank','pond','reservoir','basin','dock','bay','canal','fountain','swimming_pool','wastewater','strait','lagoon','oxbow','stream']);
  const WATER_LINES=new Set(['river','stream','canal','drain','ditch','tidal_channel','waterway','brook','rapids']);

  /** Details of the Protomaps basemap that are not drawn: lane-level or non-street features that would only add noise. */
  const DROPPED_DETAILS=new Set(['sidewalk','crossing','platform','no','services','rest_area','traffic_island','disused','abandoned','proposed','turntable']);
  const WATER_LINE_KINDS=new Set(['river','stream','canal']);          // drains and ditches are drainage, not geography

  /**
   * Protomaps basemap builds from 3.x prefix their own properties ("pmap:kind", "pmap:kind_detail", "pmap:min_zoom",
   * "pmap:level"); older builds and other producers do not. Returns an object that reads either way, without copying the
   * feature's many name:xx properties.
   */
  const PMAP_KEYS=['kind','kind_detail','min_zoom','level','link'];
  function normProps(raw){
    if(raw['pmap:kind']===undefined&&raw['pmap:kind_detail']===undefined&&raw['pmap:min_zoom']===undefined)return raw;
    const p=Object.create(raw);
    for(const k of PMAP_KEYS){const v=raw['pmap:'+k];if(v!==undefined)p[k]=v;}
    return p;
  }

  function lngOf(tx,z){return tx/Math.pow(2,z)*360-180;}
  function latOf(ty,z){const n=Math.PI-2*Math.PI*ty/Math.pow(2,z);return R2D*Math.atan(.5*(Math.exp(n)-Math.exp(-n)));}

  /** The road class a feature stands for, in the OpenStreetMap highway vocabulary the layer's styles use. */
  function roadClass(layer,p){
    const kind=p.kind,detail=p.kind_detail,cls=p.class,sub=p.subclass;
    if(layer==='transportation'){                         // OpenMapTiles
      switch(cls){
        case 'motorway':case 'trunk':case 'primary':case 'secondary':case 'tertiary':return {highway:cls+(/_link$/.test(sub||'')?'_link':'')};
        case 'minor':return {highway:sub==='living_street'?'living_street':sub==='pedestrian'?'pedestrian':'residential'};
        case 'service':return {highway:'service'};
        case 'track':return {highway:'track'};
        case 'path':return {highway:KNOWN_HIGHWAYS.has(sub)?sub:'path'};
        case 'rail':case 'transit':return {rail:true};
        case 'motorway_construction':case 'trunk_construction':case 'primary_construction':case 'secondary_construction':case 'tertiary_construction':case 'minor_construction':case 'service_construction':return {highway:'construction'};
        case 'busway':case 'bus_guideway':return {highway:'service'};
        default:return null;                              // ferry, aerialway, ...
      }
    }
    // Protomaps basemap schema: kind groups, kind_detail is the OpenStreetMap highway value.
    if(kind==='rail'||kind==='train'||kind==='subway'||kind==='light_rail'||kind==='tram')return {rail:true};
    if(kind==='ferry'||kind==='aerialway'||DROPPED_DETAILS.has(detail))return null;
    const fallback={highway:'motorway',major_road:'primary',medium_road:'secondary',minor_road:'residential',path:'path',other:'service'}[kind];
    if(!fallback&&!KNOWN_HIGHWAYS.has(detail))return null;
    return {highway:KNOWN_HIGHWAYS.has(detail)?detail:fallback};
  }

  const isMajor=h=>h==='motorway'||h==='trunk'||h==='primary'||h==='secondary'||h==='tertiary'||/^(motorway|trunk)_link$/.test(h);
  const isMinor=h=>h==='footway'||h==='path'||h==='cycleway'||h==='steps'||h==='pedestrian'||h==='bridleway';

  function roadLabelSpec(highway){
    if(isMajor(highway))return {priority:5,minZoom:13};
    if(isMinor(highway)||highway==='track'||highway==='corridor')return {priority:13,minZoom:16.5};
    if(highway==='service'||highway==='construction')return {priority:11,minZoom:16};
    return {priority:9,minZoom:15};
  }
  function placeLabelSpec(kind,detail){
    const k=detail||kind;
    switch(k){
      case 'country':return {priority:1,minZoom:1};
      case 'region':case 'state':case 'province':return {priority:2,minZoom:4};
      case 'locality':return kind==='locality'&&detail==='locality'?{priority:6,minZoom:13}:{priority:2,minZoom:5};   // Protomaps: a named locality that is neither city nor village
      case 'city':return {priority:2,minZoom:5};
      case 'town':return {priority:3,minZoom:8};
      case 'village':return {priority:4,minZoom:10};
      case 'suburb':case 'macrohood':case 'borough':case 'quarter':return {priority:5,minZoom:11};
      case 'hamlet':case 'neighbourhood':case 'neighborhood':case 'isolated_dwelling':return {priority:6,minZoom:13};
      default:return null;
    }
  }

  /** Builds one tile's model. `layers` is the decoder's output; z/x/y address the tile. */
  function adaptTile(decoded,addr,options={}){
    const {z,x,y}=addr,n=Math.pow(2,z),unit=TILE/n,ox=(x+.5)*unit,oy=(y+.5)*unit;
    const groups=new Map(),points=[],labels=[],stats={features:0,used:0,dropped:0,vertices:0,byKind:{}};
    const bump=k=>{stats.used++;stats.byKind[k]=(stats.byKind[k]||0)+1;};

    for(const layer of decoded.layers){
      const extent=layer.extent,scale=unit/extent,name=layer.name;
      const toX=px=>(x*unit+px*scale)-ox,toY=py=>(y*unit+py*scale)-oy;
      // lon/lat of a tile coordinate, for labels only
      const lonAt=px=>lngOf(x+px/extent,z),latAt=py=>latOf(y+py/extent,z);
      const lo=-1,hiX=extent+1,hiY=extent+1;
      const outside=(ax,ay,bx,by)=>(ax<lo&&bx<lo)||(ax>hiX&&bx>hiX)||(ay<lo&&by<lo)||(ay>hiY&&by>hiY);

      const group=(key,kind,highway)=>{let g=groups.get(key);if(!g){g={key,kind,highway:highway||'',fill:[],stroke:[]};groups.set(key,g);}return g;};
      /** Converts a tile-unit ring or line to world units. */
      const world=(coords,closed)=>{
        const m=coords.length/2,out=new Float32Array(coords.length);
        for(let i=0;i<m;i++){out[i*2]=toX(coords[i*2]);out[i*2+1]=toY(coords[i*2+1]);}
        stats.vertices+=m;return out;
      };
      /** Splits a line (or a polygon's outline) into runs of segments that are not entirely in the buffer: those belong to the neighbouring tile. */
      const runs=(coords,closed)=>{
        const m=coords.length/2,res=[];let cur=null;
        const segs=closed?m:m-1;
        for(let i=0;i<segs;i++){
          const j=(i+1)%m,ax=coords[i*2],ay=coords[i*2+1],bx=coords[j*2],by=coords[j*2+1];
          if(outside(ax,ay,bx,by)){if(cur){res.push(cur);cur=null;}continue;}
          if(!cur)cur=[ax,ay];
          cur.push(bx,by);
        }
        if(cur)res.push(cur);
        return res;
      };
      const addStroke=(g,coords,closed)=>{
        const m=coords.length/2;if(m<2)return;
        const rs=runs(coords,closed);
        if(closed&&rs.length===1&&rs[0].length===(m+1)*2){g.stroke.push({pts:world(coords,true),closed:true});return;}   // nothing cut: keep it closed
        for(const r of rs)if(r.length>=4)g.stroke.push({pts:world(r,false),closed:false});
      };
      const addPolygon=(g,rings)=>{for(const ring of rings){if(ring.length<6)continue;g.fill.push(world(ring,true));addStroke(g,ring,true);}};
      const addLine=(g,lines)=>{for(const line of lines)addStroke(g,line,false);};

      const pushLabel=(text,px,py,kind,spec,angle,symbol)=>{
        if(!text||labels.length>=MAX_LABELS_COLLECTED)return;   // trimmed to MAX_LABELS_PER_TILE, most important first, once the tile is read
        labels.push({text:String(text),lon:lonAt(px),lat:latAt(py),kind,priority:spec.priority,minZoom:spec.minZoom,rank:spec.rank||0,angle:angle||0,symbol:symbol||'',region:true});
      };
      /** A road name goes at the middle of the longest straight stretch inside the tile, along the line. */
      const lineLabel=(text,lines,spec,kind)=>{
        if(!text)return;
        let best=null,bestLen=0;
        for(const line of lines)for(let i=0;i+3<line.length;i+=2){
          const ax=line[i],ay=line[i+1],bx=line[i+2],by=line[i+3];
          if(outside(ax,ay,bx,by))continue;
          const len=Math.hypot(bx-ax,by-ay);if(len>bestLen){bestLen=len;best=[ax,ay,bx,by];}
        }
        if(!best||bestLen<extent*.04)return;
        const mx=(best[0]+best[2])/2,my=(best[1]+best[3])/2;
        if(mx<0||my<0||mx>extent||my>extent)return;
        let angle=Math.atan2(best[3]-best[1],best[2]-best[0])*R2D;
        // Mercator tile y runs south, which is also screen down, so the angle is already a screen angle; keep text upright.
        if(angle>90)angle-=180;else if(angle<-90)angle+=180;
        pushLabel(text,mx,my,kind||'road',spec,angle);
      };

      for(const f of layer.features){
        stats.features++;
        const p=normProps(f.props),type=f.type;let used=false;
        const rings=type===3?f.geometry:null,lines=type===2?f.geometry:null;
        switch(name){
          // ---- roads --------------------------------------------------------------------
          case 'roads':case 'transportation':{
            if(type!==2)break;
            const c=roadClass(name,p);if(!c)break;
            if(c.rail){addLine(group('rail||','rail',''),lines);bump('rail');used=true;break;}
            const g=group('road|'+c.highway+'|','road',c.highway);addLine(g,lines);bump('road');used=true;
            const nm=p.name||p['name:latin']||p['name_en'];
            if(nm){const spec=roadLabelSpec(c.highway);lineLabel(nm,lines,{priority:spec.priority,minZoom:Math.max(spec.minZoom,Number(p.min_zoom)||0),rank:Number(p.min_zoom)||0});}
            break;
          }
          case 'transit':{
            if(type===2&&!DROPPED_DETAILS.has(p.kind_detail)&&(p.kind==='rail'||p.kind==='train'||p.kind==='subway'||p.kind==='light_rail'||p.kind==='tram'||p.class==='rail')){addLine(group('rail||','rail',''),lines);bump('rail');used=true;}
            break;
          }
          // ---- rivers, streams and canals (Protomaps physical_line) and named water bodies (physical_point) ------
          case 'physical_line':{
            if(type!==2||!WATER_LINE_KINDS.has(p.kind))break;
            addLine(group('waterway||','waterway',''),lines);bump('waterway');used=true;
            if(p.name)lineLabel(p.name,lines,p.kind==='river'?{priority:7,minZoom:Math.max(12,Number(p.min_zoom)||0),rank:Number(p.min_zoom)||0}:{priority:10,minZoom:15,rank:Number(p.min_zoom)||0},'waterway');
            break;
          }
          case 'physical_point':{
            if(type!==1||p.kind!=='water'||!p.name)break;
            pushLabel(p.name,f.geometry[0],f.geometry[1],'waterway',{priority:8,minZoom:Math.max(14,Number(p.min_zoom)||0),rank:Number(p.min_zoom)||0});
            bump('waterlabel');used=true;break;
          }
          // ---- buildings ------------------------------------------------------------------
          case 'buildings':case 'building':{
            if(type!==3)break;
            if(p.kind==='building_part'&&!options.buildingParts)break;           // parts duplicate the building outline
            addPolygon(group('building||','building',''),rings);bump('building');used=true;
            const nm=p.name;if(nm){const r=rings[0];let sx=0,sy=0;const m=r.length/2;for(let i=0;i<m;i++){sx+=r[i*2];sy+=r[i*2+1];}pushLabel(nm,sx/m,sy/m,'building',{priority:14,minZoom:17});}
            break;
          }
          // ---- water ----------------------------------------------------------------------
          case 'water':case 'waterway':{
            const kind=p.kind||p.class||'water';
            if(type===3&&(name==='water'||WATER_AREAS.has(kind))){addPolygon(group('water||','water',''),rings);bump('water');used=true;}
            else if(type===2&&(name==='waterway'||WATER_LINES.has(kind)||WATER_AREAS.has(kind))){addLine(group('waterway||','waterway',''),lines);bump('waterway');used=true;}
            break;
          }
          // ---- land use and cover -----------------------------------------------------------
          case 'landuse':case 'landcover':case 'natural':case 'park':{
            if(type!==3)break;
            const kind=p.kind||p.class||(name==='park'?'park':'');
            let target=null;
            if(kind==='parking'||kind==='parking_lot'||kind==='parking_space')target=['parking','parking'];
            else if(PAVED.has(kind))target=['paved','paved'];
            else if(GREEN.has(kind)||name==='park')target=['green','green'];
            else if(kind==='water'||kind==='lake'||kind==='ocean')target=['water','water'];
            if(!target)break;
            addPolygon(group(target[0]+'||',target[1],''),rings);bump(target[1]);used=true;
            break;
          }
          case 'earth':break;                                                         // the globe's own land is drawn underneath
          // ---- places and points -----------------------------------------------------------
          case 'places':case 'place':{
            if(type!==1)break;
            const base=placeLabelSpec(p.kind,p.kind_detail||p.class);if(!base)break;
            const nm=p.name||p['name:latin']||p.name_en;if(!nm)break;
            const mz=Number(p.min_zoom),spec={priority:base.priority,minZoom:mz>0?mz:base.minZoom,rank:mz>0?mz:0};   // the producer's own choice of when a name appears wins over the default
            for(let i=0;i<f.geometry.length;i+=2)pushLabel(nm,f.geometry[i],f.geometry[i+1],'place',spec);
            bump('place');used=true;break;
          }
          case 'pois':case 'poi':{
            if(type!==1)break;
            const kind=p.kind||p.class||'';
            let pk=null;
            // tools/make_pmtiles.py writes the kind the app draws as mt_kind, so a converted package draws what its source did.
            if(p.mt_kind==='tree'||p.mt_kind==='furniture'||p.mt_kind==='bus'||p.mt_kind==='poi')pk=p.mt_kind;
            else if(kind==='tree')pk='tree';
            else if(kind==='crossing'||kind==='traffic_signals'||kind==='street_lamp'||kind==='bench'||kind==='waste_basket')pk='furniture';
            else if(kind==='bus_stop'||kind==='bus_station')pk='bus';
            else if(p.name||kind==='parking')pk='poi';
            if(!pk)break;
            for(let i=0;i<f.geometry.length;i+=2)points.push({kind:pk,x:toX(f.geometry[i]),y:toY(f.geometry[i+1])});
            if(p.name&&pk!=='tree'&&pk!=='furniture')pushLabel(p.name,f.geometry[0],f.geometry[1],pk==='bus'?'bus':'poi',{priority:12,minZoom:Math.max(16.5,Number(p.min_zoom)||0),rank:Number(p.min_zoom)||0});
            bump(pk);used=true;break;
          }
          case 'barriers':{
            if(type===2){addLine(group('barrier||','barrier',''),lines);bump('barrier');used=true;}
            break;
          }
          default:break;                                                                // boundaries, aeroway, mountain_peak, ...
        }
        if(!used)stats.dropped++;
      }
    }
    // More names than a tile may carry: keep the most important first (priority, then the producer's own min_zoom rank).
    if(labels.length>MAX_LABELS_PER_TILE){labels.sort((a,b)=>a.priority-b.priority||a.rank-b.rank);labels.length=MAX_LABELS_PER_TILE;}
    return {z,x,y,ox,oy,groups:[...groups.values()].filter(g=>g.fill.length||g.stroke.length),points,labels,stats,
      bytes:estimateBytes(groups,points,labels)};
  }

  function estimateBytes(groups,points,labels){
    let b=0;
    for(const g of groups.values()){for(const a of g.fill)b+=a.byteLength;for(const s of g.stroke)b+=s.pts.byteLength;}
    return b+points.length*40+labels.length*120;
  }

  /** Layer names the adapter reads. A package with none of these has nothing the map can draw (the app says so when it is added). */
  const KNOWN_LAYERS=new Set(['roads','transportation','transit','buildings','building','water','waterway','physical_line','physical_point','landuse','landcover','natural','park','places','place','pois','poi','barriers']);
  const recognisesLayers=names=>Array.isArray(names)&&names.some(n=>KNOWN_LAYERS.has(n));

  return {adaptTile,roadClass,roadLabelSpec,placeLabelSpec,KNOWN_HIGHWAYS,KNOWN_LAYERS,recognisesLayers,GREEN,PAVED,isMajor,isMinor,MAX_LABELS_PER_TILE};
});
