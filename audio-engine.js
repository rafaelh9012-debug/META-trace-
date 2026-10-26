/*
 * Audio engine: original interface sounds synthesised locally with Web Audio.
 *
 * - No samples, no network, no third-party assets.
 * - The AudioContext is only created or resumed by unlock(), which the app calls
 *   from a user gesture (the Analyze click or the Sound control).
 * - Every cue is routed through voice -> master gain -> limiter -> output, with
 *   short attack and release envelopes, so overlapping cues cannot click or clip.
 * - Every voice is tracked, so stopAll() / stopGeneration() can fade out whatever
 *   is playing when a new file is chosen, Clear is pressed, sound is muted, the
 *   run is cancelled or the tab is hidden.
 * - A blocked, suspended or unsupported context turns every cue into a quiet
 *   no-op. Nothing here throws into the caller or retries in a loop.
 */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.AudioEngine=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';

  const FLOOR=0.0001;
  const clamp=(v,lo,hi)=>Math.min(hi,Math.max(lo,v));
  // Perceptual volume curve. The default of 0.7 puts the loudest cue near -13 dBFS and the quietest tick near -28 dBFS.
  const volumeToGain=v=>Math.pow(clamp(Number.isFinite(v)?v:0,0,1),1.6);
  const PITCHES=[1760,1976,2349,2637,2093];

  function create(options={}){
    const Ctor=options.AudioContext||(typeof globalThis!=='undefined'&&(globalThis.AudioContext||globalThis.webkitAudioContext))||null;
    const injected=options.context||null;
    const self={
      supported:!!(injected||Ctor),
      enabled:options.enabled!==false,
      volume:clamp(options.volume===undefined?0.7:options.volume,0,1),
      blocked:false,failed:false
    };
    let ctx=injected,master=null,limiter=null,noise=null,tickCount=0;
    const voices=new Set();
    // An injected OfflineAudioContext never reports "running" before rendering starts.
    const assumeRunning=!!options.assumeRunning;

    function ensureGraph(){
      if(ctx&&master)return true;
      try{
        if(!ctx){if(!Ctor){self.supported=false;return false;}ctx=new Ctor({latencyHint:'interactive'});}
        master=ctx.createGain();master.gain.value=self.enabled?volumeToGain(self.volume):0;
        limiter=ctx.createDynamicsCompressor();
        limiter.threshold.value=-8;limiter.knee.value=8;limiter.ratio.value=12;limiter.attack.value=0.003;limiter.release.value=0.2;
        master.connect(limiter);limiter.connect(ctx.destination);
        return true;
      }catch{self.failed=true;self.supported=false;ctx=injected;master=null;return false;}
    }
    function playable(){return !!(self.enabled&&ctx&&master&&(assumeRunning||ctx.state==='running'));}
    function noiseBuffer(){
      if(noise)return noise;
      const length=Math.floor(ctx.sampleRate*1.5),buffer=ctx.createBuffer(1,length,ctx.sampleRate),data=buffer.getChannelData(0);
      // Deterministic pseudo-random noise: identical output between runs, which keeps tests stable.
      let seed=0x2f6e2b1;for(let i=0;i<length;i++){seed=(seed*1664525+1013904223)>>>0;data[i]=(seed/0x80000000)-1;}
      return noise=buffer;
    }

    // ---- envelope and voice helpers -------------------------------------------------
    function envelope(param,t,{attack=0.005,peak=0.3,hold=0,release=0.1}){
      param.cancelScheduledValues(t);
      param.setValueAtTime(FLOOR,t);
      param.linearRampToValueAtTime(peak,t+attack);
      if(hold>0)param.setValueAtTime(peak,t+attack+hold);
      param.exponentialRampToValueAtTime(FLOOR,t+attack+hold+release);
      return t+attack+hold+release;
    }
    function makeVoice(name,gen,gain){
      const voice={name,gen,gain,sources:[],ended:false,endTime:0};
      voice.stop=(fade=0.05)=>{
        if(voice.ended)return;voice.ended=true;
        try{
          const now=ctx.currentTime,g=gain.gain;
          g.cancelScheduledValues(now);g.setValueAtTime(Math.max(FLOOR,g.value||FLOOR),now);g.exponentialRampToValueAtTime(FLOOR,now+Math.max(0.01,fade));
          for(const s of voice.sources){try{s.stop(now+Math.max(0.01,fade)+0.02);}catch{}}
        }catch{}
      };
      voices.add(voice);return voice;
    }
    function osc(type,freq,t,stop,voice,dest,gainValue=1){
      const o=ctx.createOscillator(),g=ctx.createGain();o.type=type;o.frequency.setValueAtTime(freq,t);g.gain.value=gainValue;o.connect(g);g.connect(dest);
      voice.sources.push(o);o.start(t);o.stop(stop);o.onended=()=>{voice.sources=voice.sources.filter(s=>s!==o);try{g.disconnect();}catch{}if(!voice.sources.length){voice.ended=true;try{voice.gain.disconnect();}catch{}voices.delete(voice);}};
      return {o,g};
    }
    function noiseSource(t,stop,voice,dest,{filter='bandpass',freq=1000,q=1,loop=false}={}){
      const s=ctx.createBufferSource(),f=ctx.createBiquadFilter();s.buffer=noiseBuffer();s.loop=loop;f.type=filter;f.frequency.setValueAtTime(freq,t);f.Q.value=q;s.connect(f);f.connect(dest);
      voice.sources.push(s);s.start(t);s.stop(stop);s.onended=()=>{voice.sources=voice.sources.filter(x=>x!==s);try{f.disconnect();}catch{}if(!voice.sources.length){voice.ended=true;try{voice.gain.disconnect();}catch{}voices.delete(voice);}};
      return {s,f};
    }
    function begin(name,params){
      if(!playable())return null;
      const t=(params.when!==undefined?params.when:ctx.currentTime)+0.005,gain=ctx.createGain();
      gain.gain.value=1;gain.connect(master);
      return {t,voice:makeVoice(name,params.gen,gain),gain};
    }

    // ---- cues -----------------------------------------------------------------------
    const cues={
      // Image seats in the scanner: a dry click with a small low thump.
      intake(params){
        const c=begin('intake',params);if(!c)return null;const {t,voice,gain}=c;
        const click=ctx.createGain();click.connect(gain);envelope(click.gain,t,{attack:0.002,peak:0.5,release:0.03});
        noiseSource(t,t+0.06,voice,click,{filter:'bandpass',freq:2400,q:1.2});
        const thump=ctx.createGain();thump.connect(gain);envelope(thump.gain,t,{attack:0.003,peak:0.45,release:0.09});
        const th=osc('sine',150,t,t+0.14,voice,thump);th.o.frequency.exponentialRampToValueAtTime(70,t+0.07);
        return voice;
      },
      // Sparse extraction tick. Pitch cycles through a small set; one tick per revealed field group.
      tick(params){
        const c=begin('tick',params);if(!c)return null;const {t,voice,gain}=c;
        const f=PITCHES[(params.index!==undefined?params.index:tickCount++)%PITCHES.length];
        const e=ctx.createGain();e.connect(gain);envelope(e.gain,t,{attack:0.002,peak:0.22,release:0.04});
        osc('sine',f,t,t+0.07,voice,e);return voice;
      },
      // Low scanner texture. Runs until stop() is called on the returned voice.
      scan(params){
        const c=begin('scan',params);if(!c)return null;const {t,voice,gain}=c;
        const bus=ctx.createGain();bus.connect(gain);
        bus.gain.setValueAtTime(FLOOR,t);bus.gain.linearRampToValueAtTime(0.09,t+0.15);
        const far=t+(params.maxSeconds||12);
        noiseSource(t,far,voice,bus,{filter:'bandpass',freq:380,q:5,loop:true});
        const hum=ctx.createGain();hum.gain.value=0.35;hum.connect(bus);
        osc('sine',110,t,far,voice,hum);
        const lfo=osc('sine',5.5,t,far,voice,ctx.createGain(),1);
        try{lfo.g.gain.value=0.02;lfo.g.connect(bus.gain);}catch{}
        return voice;
      },
      // Coordinate digits settle: three short rising sine notes.
      resolve(params){
        const c=begin('resolve',params);if(!c)return null;const {t,voice,gain}=c;
        [[523.25,0],[659.25,0.07],[880,0.14]].forEach(([f,d])=>{const e=ctx.createGain();e.connect(gain);envelope(e.gain,t+d,{attack:0.006,peak:0.24,release:0.24});osc('sine',f,t+d,t+d+0.32,voice,e);});
        return voice;
      },
      // Map descent: filtered noise rising in pitch, swelling, then fading before the lock.
      descend(params){
        const c=begin('descend',params);if(!c)return null;const {t,voice,gain}=c;
        const d=Math.max(0.3,(params.duration||2.9)),end=t+d;
        const bus=ctx.createGain();bus.connect(gain);
        bus.gain.setValueAtTime(FLOOR,t);bus.gain.linearRampToValueAtTime(0.42,t+d*0.55);bus.gain.exponentialRampToValueAtTime(FLOOR,end);
        const n=noiseSource(t,end+0.05,voice,bus,{filter:'bandpass',freq:250,q:1.8,loop:true});
        n.f.frequency.exponentialRampToValueAtTime(3200,t+d*0.9);
        const sweepGain=ctx.createGain();sweepGain.gain.value=0.12;sweepGain.connect(bus);
        const sweep=osc('sine',180,t,end+0.05,voice,sweepGain);sweep.o.frequency.exponentialRampToValueAtTime(900,t+d*0.9);
        return voice;
      },
      // The globe turning up to speed and settling. Level and pitch follow `curve` (0..1 samples spread evenly over
      // `duration`), which the caller derives from the real rotation speed, so the sound rises and falls with the camera.
      spin(params){
        const c=begin('spin',params);if(!c)return null;const {t,voice,gain}=c;
        const d=Math.max(0.4,params.duration||3),end=t+d;
        const curve=Array.isArray(params.curve)&&params.curve.length>1?params.curve:Array.from({length:49},(_,i)=>Math.pow(Math.sin(Math.PI*i/48),1.5));
        const bus=ctx.createGain();bus.connect(gain);
        const wind=noiseSource(t,end+0.4,voice,bus,{filter:'bandpass',freq:230,q:1.4,loop:true});
        const toneGain=ctx.createGain();toneGain.gain.value=0.5;toneGain.connect(bus);
        const tone=osc('sine',64,t,end+0.4,voice,toneGain);
        bus.gain.setValueAtTime(FLOOR,t);
        curve.forEach((v,i)=>{
          const at=t+d*i/(curve.length-1),k=clamp(Number(v)||0,0,1);
          bus.gain.linearRampToValueAtTime(0.012+0.2*Math.pow(k,1.15),at);
          wind.f.frequency.linearRampToValueAtTime(230+2100*k*k,at);
          tone.o.frequency.linearRampToValueAtTime(64+200*k,at);
        });
        bus.gain.exponentialRampToValueAtTime(FLOOR,end+0.3);
        return voice;
      },
      // A level of detail appearing during the descent: a short, soft, rising blip. `index` 0 to 4.
      detail(params){
        const c=begin('detail',params);if(!c)return null;const {t,voice,gain}=c;
        const ladder=[784,987.77,1318.5,1760,2349.3],f=ladder[clamp(Math.round(Number(params.index)||0),0,ladder.length-1)];
        const e=ctx.createGain();e.connect(gain);envelope(e.gain,t,{attack:0.003,peak:0.13,release:0.1});
        osc('sine',f,t,t+0.16,voice,e);
        const h=ctx.createGain();h.connect(gain);envelope(h.gain,t,{attack:0.003,peak:0.04,release:0.06});
        osc('sine',f*2,t,t+0.1,voice,h);
        return voice;
      },
      // Target lock: a soft click and a clean two-partial tone.
      lock(params){
        const c=begin('lock',params);if(!c)return null;const {t,voice,gain}=c;
        const click=ctx.createGain();click.connect(gain);envelope(click.gain,t,{attack:0.001,peak:0.18,release:0.02});
        noiseSource(t,t+0.05,voice,click,{filter:'highpass',freq:3000,q:0.7});
        [[880,0.3,0.6],[1320,0.18,0.42],[1760,0.07,0.25]].forEach(([f,peak,rel])=>{const e=ctx.createGain();e.connect(gain);envelope(e.gain,t,{attack:0.004,peak,release:rel});osc('sine',f,t,t+rel+0.05,voice,e);});
        return voice;
      },
      // A quiet, neutral falling interval for results without a location.
      neutral(params){
        const c=begin('neutral',params);if(!c)return null;const {t,voice,gain}=c;
        const lp=ctx.createBiquadFilter();lp.type='lowpass';lp.frequency.value=1200;lp.connect(gain);
        [[392,0],[293.66,0.11]].forEach(([f,d])=>{const e=ctx.createGain();e.connect(lp);envelope(e.gain,t+d,{attack:0.012,peak:0.2,release:0.34});osc('sine',f,t+d,t+d+0.45,voice,e);});
        return voice;
      },
      // Read failure: two short, low, dull pulses. Distinct from neutral, never harsh.
      error(params){
        const c=begin('error',params);if(!c)return null;const {t,voice,gain}=c;
        const lp=ctx.createBiquadFilter();lp.type='lowpass';lp.frequency.value=620;lp.connect(gain);
        [0,0.17].forEach(d=>{const e=ctx.createGain();e.connect(lp);envelope(e.gain,t+d,{attack:0.008,peak:0.26,hold:0.05,release:0.09});osc('sawtooth',164.81,t+d,t+d+0.2,voice,e);});
        return voice;
      },
      // Small acknowledgement when the person turns sound on.
      confirm(params){
        const c=begin('confirm',params);if(!c)return null;const {t,voice,gain}=c;
        [[660,0],[880,0.07]].forEach(([f,d])=>{const e=ctx.createGain();e.connect(gain);envelope(e.gain,t+d,{attack:0.005,peak:0.2,release:0.14});osc('sine',f,t+d,t+d+0.2,voice,e);});
        return voice;
      }
    };

    function cue(name,params={}){
      const fn=cues[name];if(!fn)return null;
      try{return fn(params)||null;}catch{return null;}
    }
    function stopAll(fade=0.05){for(const v of [...voices])v.stop(fade);}
    function stopGeneration(gen,fade=0.05){for(const v of [...voices])if(v.gen===gen)v.stop(fade);}
    function applyMaster(){
      if(!ctx||!master)return;
      try{const now=ctx.currentTime,g=master.gain;g.cancelScheduledValues(now);g.setValueAtTime(g.value,now);g.linearRampToValueAtTime(self.enabled?volumeToGain(self.volume):0,now+0.04);}catch{}
    }

    /** Must be called from a user gesture. Resolves to the resulting status; never rejects. */
    async function unlock(){
      if(!self.enabled)return 'off';
      if(!self.supported)return 'unsupported';
      if(!ensureGraph())return 'unsupported';
      try{
        if(ctx.state!=='running'&&typeof ctx.resume==='function'){
          await Promise.race([ctx.resume(),new Promise(resolve=>setTimeout(resolve,800))]);
        }
      }catch{}
      const running=assumeRunning||ctx.state==='running';
      self.blocked=!running;
      return running?'running':'blocked';
    }

    return {
      unlock,cue,stopAll,stopGeneration,
      setEnabled(on){
        self.enabled=!!on;
        if(!self.enabled)stopAll(0.04);
        applyMaster();
      },
      setVolume(v){self.volume=clamp(Number(v),0,1);applyMaster();},
      get enabled(){return self.enabled;},get volume(){return self.volume;},get supported(){return self.supported;},get blocked(){return self.blocked;},
      get state(){return ctx?ctx.state:'none';},
      get active(){return voices.size;},
      get context(){return ctx;},
      snapshot(){return {supported:self.supported,enabled:self.enabled,blocked:self.blocked,state:ctx?ctx.state:'none',volume:self.volume,voices:voices.size};},
      cueNames:Object.keys(cues)
    };
  }

  return {create,volumeToGain};
});
