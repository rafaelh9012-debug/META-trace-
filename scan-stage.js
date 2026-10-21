/*
 * Scan stage: the optical-scanner presentation around the selected image.
 *
 * Most of the look is CSS, keyed off `data-phase` on the bay, so cancelling is
 * just changing that attribute. JavaScript only handles what CSS cannot:
 *   - a small canvas with (a) fragments of the file's REAL bytes and, once the
 *     report exists, REAL tag names, drifting through the margins beside the
 *     scan line, and (b) decorative segmentation tiles that light behind the line;
 *   - the tag ticker under the image, which only ever shows tags that were read;
 *   - the digit-settle effect used on coordinates.
 *
 * Nothing here detects objects, faces or places. The tiles are a grid that does
 * not look at the image at all, and they carry no labels.
 */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.ScanStage=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';

  const PHASES=['idle','ready','acquire','scan','reveal','resolve','fly','lock','settled','error'];
  const hex=(n,w)=>n.toString(16).toUpperCase().padStart(w,'0');
  // Tags worth showing first. Only ones that exist in the file are used.
  const PRIORITY=['Make','Model','LensModel','DateTimeOriginal','CreateDate','ExposureTime','FNumber','ISO','ISOSpeedRatings','FocalLength','GPSLatitude','GPSLongitude','GPSAltitude'];
  const tagName=tag=>String(tag).split('.').at(-1).split(':').at(-1);

  /** Picks tags to show on the ticker, from the real report only. */
  function pickTags(metadata,limit=10){
    const list=Array.isArray(metadata)?metadata:[],out=[],used=new Set();
    for(const name of PRIORITY){const f=list.find(x=>tagName(x.tag).toLowerCase()===name.toLowerCase());if(f&&!used.has(f)){used.add(f);out.push(f);}}
    for(const f of list){if(out.length>=limit)break;if(!used.has(f)&&typeof f.value==='string'&&!f.value.startsWith('[')){used.add(f);out.push(f);}}
    return out.slice(0,limit).map(f=>({name:tagName(f.tag),value:String(f.value)}));
  }
  /** Samples evenly spaced real bytes from a file buffer. */
  function sampleBytes(buffer,count=40){
    const u8=buffer instanceof Uint8Array?buffer:new Uint8Array(buffer),n=u8.length,out=[];
    if(!n)return out;
    const span=Math.min(8,n);
    for(let i=0;i<count;i++){const offset=count>1?Math.floor(i*(n-span)/(count-1)):0;out.push({offset,bytes:Array.from(u8.subarray(offset,offset+span))});}
    return out;
  }

  /** Digit-settle effect. The real element always holds the exact text; the overlay is decoration. */
  function scramble(real,overlay,finalText,{duration=600,step=48,now=()=>Date.now(),setTimeoutFn=(fn,ms)=>setTimeout(fn,ms),clearTimeoutFn=id=>clearTimeout(id),random=Math.random,onDone}={}){
    const chars=[...String(finalText)];let timer=0,stopped=false;const start=now();
    real.classList.add('is-scrambling');
    const finish=()=>{if(stopped)return;stopped=true;clearTimeoutFn(timer);overlay.textContent='';real.classList.remove('is-scrambling');if(onDone)onDone();};
    function frame(){
      if(stopped)return;
      const t=Math.min(1,(now()-start)/duration),settled=Math.floor(t*chars.length);
      overlay.textContent=chars.map((c,i)=>i<settled||!/\d/.test(c)?c:String(Math.floor(random()*10))).join('');
      if(t>=1)finish();else timer=setTimeoutFn(frame,step);
    }
    frame();
    return {cancel(){if(stopped)return;stopped=true;clearTimeoutFn(timer);overlay.textContent='';real.classList.remove('is-scrambling');},get active(){return !stopped;}};
  }

  function create({bay,frame,canvas,ticker,onTick,now=()=>performance.now(),raf=cb=>requestAnimationFrame(cb),caf=id=>cancelAnimationFrame(id),setTimeoutFn=(fn,ms)=>setTimeout(fn,ms),clearTimeoutFn=id=>clearTimeout(id)}){
    const ctx=canvas.getContext?canvas.getContext('2d'):null;
    let phase='idle',rafId=0,running=false,sample=[],tags=[],fragments=[],tiles=[],metrics=null,theatrics=true,sweepMs=900,startedAt=0,lastFrame=0,tickTimers=[],lastBand=-1,pass=0;
    const tickerKey=ticker&&ticker.querySelector('.ticker-key'),tickerValue=ticker&&ticker.querySelector('.ticker-value');
    const rand=(a,b)=>a+Math.random()*(b-a);

    function setPhase(p){phase=p;bay.dataset.phase=p;}
    function setTimings(profile){
      sweepMs=Math.max(380,Math.round(profile.scan*1.05));
      bay.style.setProperty('--t-acquire',profile.acquire+'ms');bay.style.setProperty('--t-scan',profile.scan+'ms');bay.style.setProperty('--t-reveal',profile.reveal+'ms');
      bay.style.setProperty('--t-lock',profile.lock+'ms');bay.style.setProperty('--t-sweep',sweepMs+'ms');
    }
    function measure(){
      const b=canvas.getBoundingClientRect(),f=frame.getBoundingClientRect(),dpr=Math.min(2,(typeof devicePixelRatio==='number'&&devicePixelRatio)||1);
      if(!b.width||!f.width){metrics=null;return false;}
      metrics={w:b.width,h:b.height,fx:f.left-b.left,fy:f.top-b.top,fw:f.width,fh:f.height,dpr};
      canvas.width=Math.round(b.width*dpr);canvas.height=Math.round(b.height*dpr);   // CSS owns the displayed size
      const cols=12,rows=Math.max(4,Math.round(cols*metrics.fh/metrics.fw));
      tiles=[];for(let r=0;r<rows;r++)for(let c=0;c<cols;c++)tiles.push({c,r,cols,rows,lit:-1e9,gain:0});
      return true;
    }
    // Position of the CSS sweep line, 0 at the top and 1 at the bottom of the image.
    function sweepPosition(t){
      const el=frame.querySelector('.sweep-run');const a=el&&el.getAnimations?el.getAnimations()[0]:null;
      const elapsed=a&&a.currentTime!=null?Number(a.currentTime):t-startedAt;
      return ((elapsed%sweepMs)/sweepMs);
    }
    function spawn(side,y,t){
      if(fragments.length>=14)return;
      // Fragments are sized to the margin they drift in, so none is ever clipped or drawn over the image.
      const margin=side==='left'?metrics.fx:metrics.w-(metrics.fx+metrics.fw),max=Math.floor((margin-12)/5.9);
      if(max<6)return;
      const yy=y+rand(-14,6);
      if(fragments.some(f=>f.side===side&&Math.abs(f.y-yy)<11&&t-f.born<500))return;
      let text;
      if(side==='right'&&tags.length){const name=tags[Math.floor(Math.random()*tags.length)].name;text=name.length>max?name.slice(0,max-1)+'…':name;}
      else if(sample.length){const s=sample[Math.floor(Math.random()*sample.length)],count=Math.max(1,Math.min(4,Math.floor((max-5)/3)));text=hex(s.offset&0xffff,4)+' '+s.bytes.slice(0,count).map(b=>hex(b,2)).join(' ');}
      else return;
      fragments.push({side,y:yy,born:t,life:rand(650,950),text});
    }
    function draw(t){
      if(!ctx||!metrics)return;
      const {w,h,fx,fy,fw,fh,dpr}=metrics;
      ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);
      const pos=sweepPosition(t),lineY=fy+fh*pos,band=Math.floor(pos*tiles[tiles.length-1].rows);
      // Light the tile row the line has just crossed.
      if(band!==lastBand){if(band<lastBand)pass++;lastBand=band;for(const tile of tiles)if(tile.r===band&&Math.random()<.62){tile.lit=t;tile.gain=Math.max(.35,1-pass*.18);}}
      const tw=fw/tiles[0].cols,th=fh/tiles[0].rows;
      for(const tile of tiles){
        const age=t-tile.lit;if(age>900||age<0)continue;const a=(1-age/900)*tile.gain;
        ctx.globalAlpha=a*.5;ctx.strokeStyle='#ea668d';ctx.lineWidth=1;ctx.strokeRect(fx+tile.c*tw+1.5,fy+tile.r*th+1.5,tw-3,th-3);
        ctx.globalAlpha=a*.12;ctx.fillStyle='#ea668d';ctx.fillRect(fx+tile.c*tw+1.5,fy+tile.r*th+1.5,tw-3,th-3);
      }
      // Fragments only in the margins beside the image, never over it.
      const marginL=fx,marginR=w-(fx+fw);
      if(running&&Math.random()<.55){if(marginL>46)spawn('left',lineY,t);if(marginR>46)spawn('right',lineY,t);}
      ctx.font='10px "Cascadia Mono","Consolas",ui-monospace,monospace';ctx.textBaseline='middle';
      fragments=fragments.filter(f=>t-f.born<f.life);
      for(const f of fragments){
        const age=(t-f.born)/f.life,alpha=age<.15?age/.15:age>.6?(1-age)/.4:1;
        ctx.globalAlpha=alpha*.85;ctx.fillStyle=f.side==='left'?'#c98ba2':'#f2a2bd';
        const yy=f.y+(f.side==='left'?-1:1)*age*6;
        if(f.side==='left'){ctx.textAlign='right';ctx.fillText(f.text,fx-8,yy);}else{ctx.textAlign='left';ctx.fillText(f.text,fx+fw+8,yy);}
      }
      ctx.globalAlpha=1;
    }
    function loop(t){
      rafId=0;
      if(!running&&!fragments.length&&!tiles.some(x=>t-x.lit<900)){ctx&&metrics&&ctx.clearRect(0,0,metrics.w,metrics.h);return;}
      if(typeof document!=='undefined'&&document.hidden){rafId=raf(loop);return;}
      if(t-lastFrame>=32){lastFrame=t;draw(t);}
      rafId=raf(loop);
    }
    function startCanvas(){
      if(!ctx||!theatrics)return;
      if(!measure())return;
      running=true;fragments=[];pass=0;lastBand=-1;startedAt=now();lastFrame=0;
      if(!rafId)rafId=raf(loop);
    }
    function stopCanvas(){running=false;}
    function killCanvas(){running=false;fragments=[];if(rafId){caf(rafId);rafId=0;}if(ctx&&metrics)ctx.clearRect(0,0,metrics.w,metrics.h);for(const t of tiles)t.lit=-1e9;}
    function clearTicks(){for(const id of tickTimers)clearTimeoutFn(id);tickTimers=[];}
    function showTag(tag){if(!ticker)return;tickerKey.textContent=tag?tag.name:'';tickerValue.textContent=tag?tag.value.slice(0,36):'';ticker.classList.toggle('on',!!tag);}

    return {
      get phase(){return phase;},
      PHASES,pickTags,sampleBytes,
      setSample(list){sample=Array.isArray(list)?list:[];},
      /** An image has been chosen and is seated, not yet analysed. */
      ready(){this.stop();showTag(null);setPhase('ready');},
      acquire(profile){this.stop();theatrics=profile.theatrics;setTimings(profile);showTag(null);setPhase('acquire');},
      scan(profile){theatrics=profile.theatrics;setTimings(profile);setPhase('scan');startCanvas();},
      reveal(profile,metadata){
        setTimings(profile);setPhase('reveal');stopCanvas();
        tags=pickTags(metadata);
        if(!profile.theatrics||!tags.length){showTag(null);return [];}
        // One tag per tick across the beat, capped so ticks stay sparse.
        const shown=tags.slice(0,Math.max(3,Math.min(8,Math.round(profile.reveal/130)))),gap=profile.reveal/(shown.length+1);
        shown.forEach((tag,i)=>{tickTimers.push(setTimeoutFn(()=>{showTag(tag);if(onTick)onTick(i,tag);},Math.round(gap*(i+.6))));});
        tickTimers.push(setTimeoutFn(()=>showTag(null),Math.round(profile.reveal*0.97)));
        return shown;
      },
      resolve(profile){setTimings(profile);setPhase('resolve');showTag(null);},
      fly(){setPhase('fly');},
      lock(profile){setTimings(profile);setPhase('lock');},
      /** Final resting look. kind: located | neutral | warning */
      settle(kind){this.stop();showTag(null);bay.dataset.outcome=kind||'neutral';setPhase('settled');},
      fail(){this.stop();showTag(null);bay.dataset.outcome='error';setPhase('error');},
      /** Stops every animation and timer this stage owns, leaving the current look in place. */
      stop(){clearTicks();killCanvas();},
      /** Back to an empty bay. */
      reset(){this.stop();showTag(null);delete bay.dataset.outcome;sample=[];tags=[];setPhase('idle');},
      /** Re-measure after a layout change. */
      resize(){if(running)measure();},
      get active(){return running||!!rafId||tickTimers.length>0;},
      scramble
    };
  }

  return {create,scramble,pickTags,sampleBytes,PHASES};
});
