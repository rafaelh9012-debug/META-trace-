(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.MetadataCore=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const MAX_FILE_BYTES=64*1024*1024,MAX_MERCATOR_LAT=85.05112878;
  const isPresent=v=>v!==undefined&&v!==null&&v!=='';
  function valueNumber(value){
    if(typeof value==='number')return Number.isFinite(value)?value:NaN;
    if(typeof value==='string'&&/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim()))return Number(value);
    if(value&&typeof value==='object'&&'numerator' in value&&'denominator' in value){const a=Number(value.numerator),b=Number(value.denominator);return Number.isFinite(a)&&Number.isFinite(b)&&b!==0?a/b:NaN;}
    if(ArrayBuffer.isView(value)&&value.length===1)return valueNumber(value[0]);
    return NaN;
  }
  function detectFormat(bytes){
    const b=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);
    const ascii=(a,n)=>String.fromCharCode(...b.subarray(a,a+n));
    if(b.length>=3&&b[0]===255&&b[1]===216&&b[2]===255)return 'jpeg';
    if(b.length>=8&&b[0]===137&&ascii(1,3)==='PNG'&&b[4]===13&&b[5]===10&&b[6]===26&&b[7]===10)return 'png';
    if(b.length>=4&&((ascii(0,2)==='II'&&b[2]===42&&b[3]===0)||(ascii(0,2)==='MM'&&b[2]===0&&b[3]===42)))return 'tiff';
    if(b.length>=12&&ascii(0,4)==='RIFF'&&ascii(8,4)==='WEBP')return 'webp';
    if(b.length>=16&&ascii(4,4)==='ftyp'){
      const view=new DataView(b.buffer,b.byteOffset,b.byteLength),size=view.getUint32(0),brands=ascii(8,Math.min(Math.max(0,size-8),b.length-8,256));
      if(/avif|avis/.test(brands))return 'avif';if(/heic|heix|hevc|hevx|mif1|msf1/.test(brands))return 'heic';
    }
    return null;
  }
  function coordinate(value,reference,axis,allowDecimal=false){
    const limit=axis==='lat'?90:180;let suffix='',numbers,decimal=false;
    if(typeof value==='string'){
      const trimmed=value.trim();const cardinal=trimmed.match(/([NSEW])\s*$/i);if(cardinal)suffix=cardinal[1].toUpperCase();
      const s=cardinal?trimmed.slice(0,cardinal.index):trimmed;
      if(/[^\d+\-.,\s°'"′″:]/.test(s))return {error:'Coordinate text is not a supported numeric form.'};
      numbers=(s.match(/[+-]?(?:\d+(?:\.\d*)?|\.\d+)/g)||[]).map(Number);decimal=numbers.length===1;
    }else if(Array.isArray(value)||ArrayBuffer.isView(value)){numbers=Array.from(value).map(valueNumber);}
    else{numbers=[valueNumber(value)];decimal=true;}
    if(numbers.length<1||numbers.length>3||numbers.some(n=>!Number.isFinite(n)))return {error:'Coordinate contains an invalid number.'};
    let ref=isPresent(reference)?String(reference).replace(/\0/g,'').trim().toUpperCase():suffix;
    if(ref&&suffix&&ref!==suffix)return {error:'Coordinate references conflict.'};
    if(ref&&!((axis==='lat'&&/^[NS]$/.test(ref))||(axis==='lon'&&/^[EW]$/.test(ref))))return {error:'Coordinate hemisphere is invalid.'};
    if(!ref&&!(allowDecimal&&decimal))return {incomplete:true,error:'A coordinate hemisphere reference is missing.'};
    const degree=numbers[0],minutes=numbers[1]||0,seconds=numbers[2]||0;
    if(minutes<0||minutes>=60||seconds<0||seconds>=60)return {error:'Coordinate minutes or seconds are outside their valid range.'};
    if(ref&&degree<0&&/^[NE]$/.test(ref))return {error:'Coordinate sign and hemisphere conflict.'};
    let out=Math.abs(degree)+minutes/60+seconds/3600;
    if(ref&&/^[SW]$/.test(ref)||!ref&&degree<0)out=-out;
    if(Math.abs(out)>limit)return {error:'Coordinate is outside the latitude/longitude range.'};
    return {value:Object.is(out,-0)?0:out};
  }
  function records(raw){
    const result=[],seen=new WeakSet();
    function visit(v,path,depth){if(!v||typeof v!=='object'||Array.isArray(v)||ArrayBuffer.isView(v)||depth>8||seen.has(v))return;seen.add(v);
      const own={};for(const [key,value] of Object.entries(v)){const name=key.split(':').at(-1).toLowerCase();own[name]=value;}
      const keys=['gpslatitude','gpslongitude','gpslatituderef','gpslongituderef','latitude','longitude'];
      if(keys.some(k=>isPresent(own[k])))result.push({values:own,path:path||'metadata'});
      for(const [key,value] of Object.entries(v))visit(value,path?path+'.'+key:key,depth+1);
    }
    visit(raw,'',0);return result.slice(0,32);
  }
  function locate(raw){
    const candidates=records(raw),valid=[],issues=[];let any=false;
    for(const {values:v,path} of candidates){
      const rawGPS=isPresent(v.gpslatitude)||isPresent(v.gpslongitude),lat=rawGPS?v.gpslatitude:v.latitude,lon=rawGPS?v.gpslongitude:v.longitude;
      if(!isPresent(lat)&&!isPresent(lon))continue;any=true;
      if(!isPresent(lat)||!isPresent(lon)){issues.push({incomplete:true,error:'Only one coordinate is present.',source:path});continue;}
      const xmp=/xmp/i.test(path);const a=coordinate(lat,v.gpslatituderef,'lat',!rawGPS||xmp),b=coordinate(lon,v.gpslongituderef,'lon',!rawGPS||xmp);
      if(a.error||b.error){issues.push({incomplete:!!(a.incomplete||b.incomplete),error:a.error||b.error,source:path});continue;}
      let altitude=null,altitudeValue=valueNumber(v.gpsaltitude),ref=v.gpsaltituderef;
      if(Number.isFinite(altitudeValue)){
        let n=valueNumber(ref);if(typeof ref==='string'&&/below/i.test(ref))n=1;if(typeof ref==='string'&&/above/i.test(ref))n=0;
        if(n===0)altitude=Math.abs(altitudeValue);else if(n===1)altitude=-Math.abs(altitudeValue);
      }
      const accuracy=valueNumber(v.gpshpositioningerror);
      valid.push({latitude:a.value,longitude:b.value,altitude,accuracyMeters:Number.isFinite(accuracy)&&accuracy>0&&accuracy<=100000?accuracy:null,source:path});
    }
    if(!valid.length){const incomplete=issues.some(x=>x.incomplete);return {status:!any?'no_location':incomplete?'incomplete_location':'invalid_location',location:null,issues};}
    const first=valid[0];const conflicts=valid.filter(p=>Math.abs(p.latitude-first.latitude)>1e-5||Math.abs(p.longitude-first.longitude)>1e-5);
    if(conflicts.length)return {status:'conflicting_location',location:null,candidates:valid,issues:[...issues,{error:'Embedded metadata contains conflicting coordinate pairs.'}]};
    return {status:'located',location:first,issues};
  }
  function flatten(raw){
    const entries=[],seen=new WeakSet();let count=0;
    function add(path,value){if(count++>=500)return;entries.push({tag:path,value});}
    function visit(value,path,depth){if(depth>8||entries.length>=500)return;
      if(value===null||value===undefined)return;
      if(ArrayBuffer.isView(value)||value instanceof ArrayBuffer){add(path,'[binary metadata: '+(value.byteLength||0)+' bytes]');return;}
      if(typeof value==='string'){add(path,value.length>4096?value.slice(0,4096)+'… [truncated]':value);return;}
      if(typeof value==='number'||typeof value==='boolean'){add(path,String(value));return;}
      if(Array.isArray(value)){if(value.length<=16&&value.every(x=>x===null||['number','string','boolean'].includes(typeof x))){add(path,JSON.stringify(value));return;}add(path,'[array: '+value.length+' items]');return;}
      if(typeof value==='object'){if(seen.has(value))return;seen.add(value);for(const [key,v] of Object.entries(value))visit(v,path?path+'.'+key:key,depth+1);}
    }
    visit(raw,'',0);return entries;
  }
  function firstTag(raw,names){const entries=flatten(raw);for(const name of names){const found=entries.find(e=>e.tag.split('.').at(-1).split(':').at(-1).toLowerCase()===name.toLowerCase());if(found)return found.value;}return null;}
  function describe(raw,file,format,sha256=null){
    const locationResult=locate(raw||{}),fields=flatten(raw||{});
    return {schemaVersion:1,analyzedAt:new Date().toISOString(),file:{name:file.name,sizeBytes:file.size,type:format,lastModified:file.lastModified?new Date(file.lastModified).toISOString():null,sha256},...locationResult,metadata:fields,summary:{make:firstTag(raw,['Make']),model:firstTag(raw,['Model']),recordedTime:firstTag(raw,['DateTimeOriginal','CreateDate','DateTime']),timeOffset:firstTag(raw,['OffsetTimeOriginal']),width:firstTag(raw,['ExifImageWidth','PixelXDimension','ImageWidth','width']),height:firstTag(raw,['ExifImageHeight','PixelYDimension','ImageHeight','height']),software:firstTag(raw,['Software'])}};
  }
  function toDMS(value,axis){const total=Math.round(Math.abs(value)*3600000)/1000,degrees=Math.floor(total/3600),minutes=Math.floor((total-degrees*3600)/60),seconds=(total-degrees*3600-minutes*60).toFixed(3);return degrees+'° '+minutes+'′ '+seconds+'″ '+(axis==='lat'?(value<0?'S':'N'):(value<0?'W':'E'));}
  function inBounds(location,bounds){return location.longitude>=bounds[0]&&location.longitude<=bounds[2]&&location.latitude>=bounds[1]&&location.latitude<=bounds[3];}
  return {MAX_FILE_BYTES,MAX_MERCATOR_LAT,detectFormat,valueNumber,coordinate,locate,flatten,describe,toDMS,inBounds};
});
