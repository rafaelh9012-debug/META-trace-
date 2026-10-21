self.onmessage=async function(event){
  try{const result=await MetadataParser.parse(event.data.buffer);self.postMessage({ok:true,result});}
  catch(e){self.postMessage({ok:false,code:e.code||'parse_error',message:String(e.message||e).slice(0,400)});}
};
