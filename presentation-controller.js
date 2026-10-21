/*
 * Presentation controller.
 *
 * Sequences the visual and audible presentation of one analysis run. It owns no
 * DOM, map or audio code: those are injected as hooks. It is deliberately kept
 * separate from analysis state. The analysis pipeline reports facts to it
 * (file accepted, report ready, failure) through `session.signal`, and the
 * controller decides only *when* those facts are shown.
 *
 * States: idle, acquire, scan, reveal, resolve, fly, lock, settled, cancelled, error.
 *
 * Every session carries the analysis generation (`gen`). All timers, pending
 * waits, signals and the map flight hook are scoped to one session, and a
 * single cancel() or skip() stops all of them. Signals from a dead session are
 * ignored, so a late parser result or a late map completion cannot reveal an
 * old result.
 */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.PresentationController=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';

  const STATES=Object.freeze(['idle','acquire','scan','reveal','resolve','fly','lock','settled','cancelled','error']);

  // Beat durations in milliseconds. These are presentation targets, not measured
  // processing times. `full` sums to 6.2 s: 0.3 + 0.9 + 1.0 + 0.6 + 2.9 + 0.5.
  const PROFILES=Object.freeze({
    full:Object.freeze({name:'full',acquire:300,scan:900,reveal:1000,resolve:600,fly:2900,lock:500,animateCamera:true,theatrics:true}),
    fast:Object.freeze({name:'fast',acquire:140,scan:420,reveal:450,resolve:260,fly:1300,lock:260,animateCamera:true,theatrics:true}),
    reduced:Object.freeze({name:'reduced',acquire:90,scan:140,reveal:220,resolve:140,fly:0,lock:200,animateCamera:false,theatrics:false})
  });

  const CANCEL={kind:'cancel'},SKIP={kind:'skip'};
  const FLIGHT_GRACE_MS=2500;

  function deferred(){
    const d={settled:false,value:undefined};
    d.promise=new Promise((resolve,reject)=>{d.resolve=v=>{if(!d.settled){d.settled=true;d.value=v;resolve(v);}};d.reject=e=>{if(!d.settled){d.settled=true;reject(e);}};});
    d.promise.catch(()=>{}); // a rejection nobody is waiting on yet is not an error
    return d;
  }

  function create(options={}){
    const hooks=options.hooks||{};
    const timers=options.timers||{setTimeout:(fn,ms)=>globalThis.setTimeout(fn,ms),clearTimeout:id=>globalThis.clearTimeout(id),now:()=>Date.now()};
    const getIntensity=typeof options.intensity==='function'?options.intensity:()=> 'full';
    const listeners=new Set();
    let current=null,state='idle',sequence=0;

    function report(error){try{(options.onError||(e=>{if(typeof console!=='undefined')console.error(e);}))(error);}catch{}}
    function emit(event){for(const fn of [...listeners]){try{fn(event);}catch(e){report(e);}}}
    function call(name,...args){const fn=hooks[name];if(typeof fn!=='function')return undefined;try{return fn(...args);}catch(e){report(e);return undefined;}}

    function context(session){
      return {
        id:session.id,gen:session.gen,profile:session.profile,intensity:session.profile.name,
        get state(){return session.state;},get report(){return session.report;},get error(){return session.error;},
        get skipped(){return session.skipped;},replay:session.replay,
        durations:session.profile,startedAt:session.startedAt,
        alive:()=>!session.dead&&session===current
      };
    }

    function setState(session,next,extra){
      if(session!==current)return false;
      const prev=state;state=next;session.state=next;
      emit({type:'state',state:next,prev,gen:session.gen,id:session.id,...extra});
      return true;
    }

    function enter(session,next,extra){
      if(session.dead||session!==current)return false;
      setState(session,next,extra);
      call('enter',next,context(session));
      return !session.dead&&session===current;
    }

    function clearTimers(session){for(const id of session.timers)timers.clearTimeout(id);session.timers.clear();}
    function dispose(session,reason){if(session.disposed)return;session.disposed=true;clearTimers(session);call('dispose',context(session),reason);}

    // A wait that any interruption (cancel, skip, failure) rejects immediately.
    function wait(session,promise){return Promise.race([promise,session.cancel.promise,session.skip.promise,session.fail.promise]);}
    // A wait that only cancel and failure can interrupt (used after skip).
    function waitFinal(session,promise){return Promise.race([promise,session.cancel.promise,session.fail.promise]);}
    function sleep(session,ms){
      if(!(ms>0))return wait(session,Promise.resolve());
      const p=new Promise(resolve=>{const id=timers.setTimeout(()=>{session.timers.delete(id);resolve();},ms);session.timers.add(id);});
      return wait(session,p);
    }

    async function flight(session){
      const T=session.profile;let watchdog;
      const timeout=new Promise(resolve=>{watchdog=timers.setTimeout(()=>{session.timers.delete(watchdog);resolve('timeout');},T.fly+FLIGHT_GRACE_MS);session.timers.add(watchdog);});
      let work;
      try{work=Promise.resolve(call('fly',context(session)));}catch(e){report(e);work=Promise.resolve('error');}
      try{return await wait(session,Promise.race([work.catch(e=>{report(e);return 'error';}),timeout]));}
      finally{timers.clearTimeout(watchdog);session.timers.delete(watchdog);}
    }

    function settle(session,extra){
      if(session.dead||session!==current)return;
      enter(session,'settled',{report:session.report,...extra});
      dispose(session,'settled');
      session.done.resolve(session.state);
    }

    function failed(session,error){
      if(session.dead||session!==current)return;
      session.error=error;clearTimers(session);dispose(session,'error');
      enter(session,'error',{error});
      session.done.resolve('error');
    }

    // After skip: apply the final state immediately, or as soon as the report exists.
    async function finalize(session){
      try{
        const report=session.report||await waitFinal(session,session.gates.report.promise);
        if(session.dead||session!==current)return;
        session.report=report;clearTimers(session);dispose(session,'skip');
        call('finish',context(session));
        if(session.dead||session!==current)return;
        setState(session,'settled',{report,skipped:true});
        session.done.resolve('settled');
      }catch(signal){route(session,signal);}
    }

    function route(session,signal){
      if(signal===CANCEL||session.dead)return;
      if(signal===SKIP)return finalize(session);
      if(signal&&signal.kind==='fail')return failed(session,signal.error);
      report(signal);failed(session,signal instanceof Error?signal:new Error(String(signal)));
    }

    async function run(session){
      const T=session.profile;
      try{
        if(!enter(session,'acquire'))return;
        await Promise.all([sleep(session,T.acquire),wait(session,session.gates.acquired.promise)]);
        if(!enter(session,'scan'))return;
        await sleep(session,T.scan);
        if(!session.gates.report.settled){session.waiting=true;emit({type:'waiting',value:true,gen:session.gen,id:session.id});}
        const result=await wait(session,session.gates.report.promise);
        if(session.waiting){session.waiting=false;emit({type:'waiting',value:false,gen:session.gen,id:session.id});}
        session.report=result;
        if(!enter(session,'reveal',{report:result}))return;
        await sleep(session,T.reveal);
        if(result.status==='located'&&result.location){
          if(!enter(session,'resolve',{report:result}))return;
          await sleep(session,T.resolve);
          const plan=call('plan',context(session));
          if(plan&&plan.fly===false){settle(session,{camera:'none'});return;}
          if(!enter(session,'fly',{report:result}))return;
          const outcome=await flight(session);
          if(outcome==='timeout'||outcome==='error'){emit({type:'warning',reason:'flight_'+outcome,gen:session.gen,id:session.id});call('recover',context(session),outcome);}
          if(!enter(session,'lock',{report:result}))return;
          await sleep(session,T.lock);
        }
        settle(session);
      }catch(signal){route(session,signal);}
    }

    function startSession(opts={}){
      if(current&&!current.dead)stop(current,'replaced');
      const profileName=PROFILES[opts.intensity]?opts.intensity:getIntensity();
      const profile=PROFILES[profileName]||PROFILES.full;
      const session={
        id:++sequence,gen:opts.gen,profile,state:'idle',dead:false,disposed:false,skipped:false,waiting:false,
        replay:!!opts.report,report:null,error:null,timers:new Set(),startedAt:timers.now(),
        cancel:deferred(),skip:deferred(),fail:deferred(),done:deferred(),
        gates:{acquired:deferred(),report:deferred()}
      };
      current=session;state='idle';
      session.signal=Object.freeze({
        acquired(info){if(!session.dead&&session===current)session.gates.acquired.resolve(info);},
        report(r){if(!session.dead&&session===current)session.gates.report.resolve(r);},
        fail(error){if(session.dead||session!==current||session.gates.report.settled)return;session.fail.reject({kind:'fail',error});}
      });
      if(opts.report){session.gates.acquired.resolve({replay:true});session.gates.report.resolve(opts.report);}
      run(session);
      return session;
    }

    function stop(session,reason){
      if(session.dead)return;
      const wasRunning=!['settled','error','idle','cancelled'].includes(session.state);
      session.dead=true;
      clearTimers(session);
      session.cancel.reject(CANCEL);
      dispose(session,reason);
      if(session===current){
        const prev=state;state=wasRunning?'cancelled':'idle';session.state=state;
        emit({type:'state',state,prev,gen:session.gen,id:session.id,reason});
      }
      session.done.resolve('cancelled');
    }

    return {
      start:startSession,
      /** Stops all work for the current session. Safe to call at any time. */
      cancel(reason='cancel'){if(current)stop(current,reason);},
      /** Jump to the final state, or to it as soon as the report exists. */
      skip(reason='skip'){const s=current;if(!s||s.dead||['settled','error','idle','cancelled'].includes(s.state))return false;if(s.skipped)return true;s.skipped=true;clearTimers(s);s.skip.reject(SKIP);return true;},
      /** Replays the presentation for an existing report without re-running analysis. */
      replay(opts={}){return startSession({...opts});},
      reset(){if(current)stop(current,'reset');state='idle';current=null;emit({type:'state',state:'idle',prev:'idle',reason:'reset'});},
      on(fn){listeners.add(fn);return()=>listeners.delete(fn);},
      get state(){return state;},
      get session(){return current;},
      get running(){return !!current&&!current.dead&&!['settled','error','idle','cancelled'].includes(current.state);},
      profile(name){return PROFILES[name]||PROFILES.full;}
    };
  }

  return {create,STATES,PROFILES};
});
