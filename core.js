(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.TraceCore=api;})(typeof window!=='undefined'?window:globalThis,function(){
  'use strict';
  const target=Object.freeze({lat:29+38/60+55.87/3600,lon:-(82+20/60+16.40/3600),alt:47.46,latDMS:'29°38\'55.87"N',lonDMS:'82°20\'16.40"W'});
  const row=(kind,text,extra={})=>({kind,text,...extra});
  const sequence=[
    row('cmd','cd ~/workspace/trace',{human:true,humanIndex:0}),
    row('cmd','set -euo pipefail; mkdir -p ./work/{logs,metadata,maps}',{human:true,humanIndex:1}),
    row('cmd',"MODEL='Qwen-3.8-27b-obliterated'",{human:true,humanIndex:2}),
    row('cmd','./init-model "$MODEL" --ctx-size 8192 --device auto'),
    row('info','initiating Qwen-3.8-27b-obliterated…'),
    row('progress','Loading model', {label:'MODEL INITIALIZATION'}),
    row('ok','Qwen-3.8-27b-obliterated initialized · context ready'),
    row('cmd',"printf '%s\\n' 'Npcap: ready' 'Wireshark: ready' 'Suricata: ready'"),
    row('out','Npcap: ready  |  Wireshark: ready  |  Suricata: ready'),
    row('cmd','exiftool -json ./input.jpg > ./work/metadata/meta.json'),
    row('error','ERROR: ./input.jpg: file not found', {stage:'metadata'}),
    row('cmd',"find ./uploads -type f -iname '*.jpg' | head -n 1"),
    row('out','./uploads/image.jpg'),
    row('cmd',"SRC=$(find ./uploads -type f -iname '*.jpg' | head -n 1)"),
    row('cmd',"exiftool -json \"$SRC\" | jq '.[0]' > ./work/metadata/meta.json"),
    row('ok','metadata parsed · source path corrected'),
    row('cmd','sha256sum "$SRC" | tee ./work/logs/checksum.txt'),
    row('out','a3f9c7e0d6c124b35e8f3a6b1e4d590f3e9c2a0f9b6d8c7e1f2a9b4c0d3e6f10  ./uploads/image.jpg'),
    row('cmd',"jq '{GPSLatitude,GPSLongitude,GPSAltitude}' ./work/reference.json"),
    row('coordinate','GPSLatitude:  '+target.latDMS),
    row('coordinate','GPSLongitude: '+target.lonDMS),
    row('coordinate','GPSAltitude:  47.46 m'),
    row('info','coordinate source: reference.json'),
    row('cmd',"jq -s '.[0] * .[1]' ./work/metadata/meta.json ./work/reference.json > ./work/merged.json"),
    row('cmd','./metadata --scrub --analyze ./work/merged.json'),
    row('ok','metadata scrub / analysis complete'),
    row('cmd','./geomatch --offline --input ./work/merged.json --emit ./work/maps/target.geojson'),
    row('info','coordinate marker prepared · identity unresolved', {stage:'map'}),
    row('cmd','./map-view --theme dark --center "29.64885278,-82.33788889" --zoom 18'),
    row('event','', {event:'reveal-map'}),
    row('event','', {event:'fly-map'}),
    row('cmd','./map-view --marker question --source ./work/maps/target.geojson'),
    row('event','', {event:'drop-pin'}),
    row('ok','coordinate marker placed'),
    row('cmd',"jq -r '.GPSLatitude,.GPSLongitude,.GPSAltitude' ./work/reference.json"),
    row('coordinate',target.latDMS+'  '+target.lonDMS),
    row('coordinate','Elevation: 47.46 m'),
    row('cmd','./identity --local-only --contacts ./work/contacts.json'),
    row('warning','No verified contact identity available', {stage:'identity'}),
    row('cmd',"printf '%s\\n' 'identity: inconclusive' 'user not in contacts' 'confidence: unknown'"),
    row('result','identity: inconclusive'),
    row('out','user not in contacts'),
    row('out','confidence: unknown'),
    row('event','', {event:'complete'})
  ];
  class Playback {
    constructor({now=()=>performance.now(),frame=()=>{}}={}){this.now=now;this.onframe=frame;this.time=0;this.speed=1;this.running=false;this.cancelled=false;this.last=null;this.waiters=[];}
    start(){this.running=true;this.cancelled=false;this.last=null;}
    tick(at){if(this.last===null)this.last=at;const delta=Math.max(0,Math.min(100,at-this.last));this.last=at;if(this.running&&!this.cancelled)this.time+=delta*this.speed;for(const w of [...this.waiters])if(this.time>=w.until){this.waiters.splice(this.waiters.indexOf(w),1);w.resolve();}this.onframe(this.time);}
    sleep(ms){if(this.cancelled)return Promise.reject(new Error('cancelled'));return new Promise((resolve,reject)=>this.waiters.push({until:this.time+Math.max(0,ms),resolve,reject}));}
    pause(){this.running=false;}
    resume(){if(!this.cancelled){this.running=true;this.last=null;}}
    cancel(){this.cancelled=true;this.running=false;for(const w of this.waiters.splice(0))w.reject(new Error('cancelled'));}
    setSpeed(value){this.speed=Math.min(8,Math.max(.25,Number(value)||1));}
  }
  function formatElapsed(ms){const s=Math.floor(ms/1000);return String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0');}
  function humanTypingPlan(text,index=0,random=Math.random){
    const edits=[{at:11,wrong:'ec'},{at:text.indexOf('pipefail')+4,wrong:'al'},{at:text.indexOf('obliterated')+9,wrong:'d'}];
    const edit=edits[index]||{at:Math.min(10,text.length-1),wrong:'x'},steps=[];
    const wait=ms=>steps.push({kind:'wait',ms:Math.round(ms)});
    wait(450+random()*600);
    for(let i=0;i<text.length;i++){
      if(i===edit.at){
        for(const char of edit.wrong){steps.push({kind:'type',text:char});wait(60+random()*85);}
        wait(380+random()*350);
        for(let n=0;n<edit.wrong.length;n++){steps.push({kind:'erase',count:1});wait(55+random()*55);}
        wait(180+random()*260);
      }
      steps.push({kind:'type',text:text[i]});
      wait(text[i]===' '?65+random()*135:35+random()*95);
      if(i>4&&i%13===0)wait(130+random()*230);
    }
    wait(400+random()*400);
    return steps;
  }
  function selectLabels(labels,zoom,project,size,options={}){
    const placed=[],rects=[];
    for(const label of [...labels].sort((a,b)=>a.priority-b.priority)){
      if(zoom<label.minZoom||label.kind==='road'&&options.roads===false||label.kind!=='road'&&options.places===false)continue;
      const p=project(label),w=Math.min(190,label.text.length*(label.kind==='road'?5.3:5.8)+15),h=17;
      if(!p||p.x<10||p.y<12||p.x>size.x-10||p.y>size.y-12)continue;
      const angle=(label.angle||0)*Math.PI/180,bw=Math.abs(w*Math.cos(angle))+Math.abs(h*Math.sin(angle))+8,bh=Math.abs(h*Math.cos(angle))+Math.abs(w*Math.sin(angle))+8;
      const box={x:p.x-bw/2,y:p.y-bh/2,w:bw,h:bh};
      if(rects.some(r=>box.x<r.x+r.w&&box.x+box.w>r.x&&box.y<r.y+r.h&&box.y+box.h>r.y))continue;
      placed.push({...label,width:w});rects.push(box);
      if(placed.length>=65)break;
    }
    return placed;
  }
  return {target,sequence,Playback,formatElapsed,selectLabels,humanTypingPlan};
});
