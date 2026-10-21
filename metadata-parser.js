(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(require('./metadata-core.js'),require('./vendor/exifr-7.1.3.umd.js'));else root.MetadataParser=factory(root.MetadataCore,root.exifr);})(typeof globalThis!=='undefined'?globalThis:this,function(Core,exifr){
  'use strict';
  const options={tiff:true,xmp:true,iptc:true,icc:false,jfif:true,ihdr:true,makerNote:false,userComment:false,mergeOutput:false,translateKeys:true,translateValues:false,reviveValues:false,silentErrors:false};
  function fail(message,code='parse_error'){const e=new Error(message);e.code=code;throw e;}
  function validate(bytes,format){
    const b=bytes,v=new DataView(b.buffer,b.byteOffset,b.byteLength);
    if(format==='jpeg'&&b.length<20)fail('The JPEG is truncated.');
    if(format==='png'&&(b.length<33||v.getUint32(8)!==13||String.fromCharCode(...b.subarray(12,16))!=='IHDR'||v.getUint32(16)===0||v.getUint32(20)===0))fail('The PNG header is truncated or invalid.');
    if(format==='tiff'&&b.length<8)fail('The TIFF header is truncated.');
    if((format==='heic'||format==='avif')&&(b.length<16||v.getUint32(0)>b.length||v.getUint32(0)<16))fail('The HEIF container header is invalid.');
  }
  async function webp(bytes){
    const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),end=v.getUint32(4,true)+8;
    if(end>bytes.length||end<12)fail('The WebP RIFF container is truncated.');
    let result={},pos=12,chunks=0;
    while(pos+8<=end){if(++chunks>4096)fail('The WebP contains too many chunks.');const type=String.fromCharCode(...bytes.subarray(pos,pos+4)),size=v.getUint32(pos+4,true),start=pos+8,stop=start+size;if(stop>end)fail('A WebP metadata chunk is truncated.');
      if(type==='EXIF'){
        let block=bytes.subarray(start,stop);if(String.fromCharCode(...block.subarray(0,6))==='Exif\0\0')block=block.subarray(6);
        if(Core.detectFormat(block)!=='tiff')fail('The WebP EXIF chunk does not contain TIFF metadata.');
        result={...result,...await exifr.parse(block,options)};
      }else if(type==='XMP '){const xmp=await exifr.sidecar(bytes.subarray(start,stop));if(xmp)result.xmp=xmp;}
      pos=stop+(size%2);
    }
    if(pos!==end)fail('The WebP chunk table has an invalid length.');
    return result;
  }
  async function parse(buffer){
    const bytes=buffer instanceof Uint8Array?buffer:new Uint8Array(buffer),format=Core.detectFormat(bytes);
    if(!format)fail('Unsupported file format. Choose a JPEG, PNG, TIFF, WebP, HEIC, or AVIF image.','unsupported_format');
    validate(bytes,format);
    try{return {format,raw:format==='webp'?await webp(bytes):(await exifr.parse(bytes,options)||{})};}
    catch(e){if(e.code)throw e;let message=String(e.message||e);if(format==='heic'||format==='avif')message='This HEIC/AVIF metadata variant could not be read. No location has been assumed. '+message;fail(message.slice(0,400));}
  }
  return {parse,options};
});
