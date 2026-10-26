const test=require('node:test'),assert=require('node:assert/strict');
const PC=require('../presentation-controller.js');

function fakeClock(){
  let t=0,id=0;const queue=new Map();
  const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
  return {
    setTimeout(fn,ms){const i=++id;queue.set(i,{at:t+ms,fn});return i;},
    clearTimeout(i){queue.delete(i);},
    now:()=>t,
    get pending(){return queue.size;},
    async advance(ms){
      const end=t+ms;await flush();
      for(;;){
        const next=[...queue.entries()].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at||a[0]-b[0])[0];
        if(!next)break;
        queue.delete(next[0]);t=next[1].at;next[1].fn();await flush();
      }
      t=end;await flush();
    },
    flush
  };
}

function harness(opts={}){
  const clock=fakeClock(),log=[],states=[],events=[];
  const flights=[];
  const hooks={
    enter:(state,ctx)=>{log.push(['enter',state,ctx.gen]);opts.onEnter?.(state,ctx,api);},
    plan:ctx=>opts.plan?opts.plan(ctx):{fly:true},
    fly:ctx=>{log.push(['fly',ctx.gen]);if(opts.fly)return opts.fly(ctx);const d={};d.promise=new Promise(r=>d.resolve=r);flights.push(d);return d.promise;},
    finish:ctx=>log.push(['finish',ctx.gen]),
    dispose:(ctx,reason)=>log.push(['dispose',ctx.gen,reason]),
    recover:(ctx,why)=>log.push(['recover',why])
  };
  const errors=[];
  const controller=PC.create({hooks,timers:clock,intensity:()=>opts.intensity||'full',onError:e=>errors.push(e)});
  controller.on(e=>{events.push(e);if(e.type==='state')states.push(e.state);});
  const api={clock,log,states,events,flights,controller,errors};
  return api;
}
const located={status:'located',location:{latitude:29.6,longitude:-82.3,altitude:null,accuracyMeters:null,source:'gps'},issues:[]};
const noLocation={status:'no_location',location:null,issues:[]};
const disposals=log=>log.filter(x=>x[0]==='dispose');

test('successful run follows the specified beats and ends settled with no timers left',async()=>{
  const h=harness(),s=h.controller.start({gen:1});
  assert.equal(h.controller.state,'acquire');
  s.signal.acquired({format:'jpeg'});s.signal.report(located);
  await h.clock.advance(299);assert.equal(h.controller.state,'acquire');
  await h.clock.advance(1);assert.equal(h.controller.state,'scan');
  await h.clock.advance(899);assert.equal(h.controller.state,'scan');
  await h.clock.advance(1);assert.equal(h.controller.state,'reveal');
  await h.clock.advance(1000);assert.equal(h.controller.state,'resolve');
  await h.clock.advance(600);assert.equal(h.controller.state,'fly');
  await h.clock.advance(PC.PROFILES.full.fly);assert.equal(h.controller.state,'fly','waits for the camera, not a timer');
  h.flights[0].resolve('arrived');await h.clock.flush();
  assert.equal(h.controller.state,'lock');
  await h.clock.advance(PC.PROFILES.full.lock);assert.equal(h.controller.state,'settled');
  assert.deepEqual(h.states,['acquire','scan','reveal','resolve','fly','lock','settled']);
  assert.equal(h.clock.pending,0);
  assert.equal(disposals(h.log).length,1);
  assert.equal(h.controller.running,false);
});

test('no_location never resolves, flies or locks',async()=>{
  const h=harness(),s=h.controller.start({gen:1});
  s.signal.acquired({});s.signal.report(noLocation);
  await h.clock.advance(5000);
  assert.deepEqual(h.states,['acquire','scan','reveal','settled']);
  assert.equal(h.log.some(x=>x[0]==='fly'),false);
});

test('incomplete, invalid and conflicting outcomes are also settled without a flight',async()=>{
  for(const status of ['incomplete_location','invalid_location','conflicting_location']){
    const h=harness(),s=h.controller.start({gen:1});s.signal.acquired({});s.signal.report({status,location:null,issues:[]});
    await h.clock.advance(4000);assert.deepEqual(h.states,['acquire','scan','reveal','settled'],status);
  }
});

test('a polar result is shown numerically and skips the camera',async()=>{
  const h=harness({plan:()=>({fly:false})}),s=h.controller.start({gen:1});s.signal.acquired({});s.signal.report(located);
  await h.clock.advance(4000);
  assert.deepEqual(h.states,['acquire','scan','reveal','resolve','settled']);
  assert.equal(h.log.some(x=>x[0]==='fly'),false);
});

test('slow parsing holds an honest waiting phase and reveals as soon as the result exists',async()=>{
  const h=harness(),s=h.controller.start({gen:1});s.signal.acquired({});
  await h.clock.advance(4000);
  assert.equal(h.controller.state,'scan');
  assert.ok(h.events.some(e=>e.type==='waiting'&&e.value===true));
  s.signal.report(noLocation);await h.clock.flush();
  assert.equal(h.controller.state,'reveal');
  assert.ok(h.events.some(e=>e.type==='waiting'&&e.value===false));
});

test('failure at any point goes to error immediately and clears timers',async()=>{
  for(const when of [0,400,1500]){
    const h=harness(),s=h.controller.start({gen:7});
    if(when>0){s.signal.acquired({});await h.clock.advance(when);}
    s.signal.fail(new Error('boom'));await h.clock.flush();
    assert.equal(h.controller.state,'error');assert.equal(h.clock.pending,0);
    assert.deepEqual(disposals(h.log).map(x=>x[2]),['error']);
    s.signal.report(located);await h.clock.advance(9000);assert.equal(h.controller.state,'error','a late report cannot replace an error');
  }
});

test('skip jumps to the final state once and does not run later beats',async()=>{
  for(const at of [100,600,1500,2500,3200]){
    const h=harness(),s=h.controller.start({gen:2});s.signal.acquired({});s.signal.report(located);
    await h.clock.advance(at);
    assert.equal(h.controller.skip(),true);await h.clock.flush();
    assert.equal(h.controller.state,'settled',String(at));
    const settled=h.events.filter(e=>e.state==='settled');assert.equal(settled.length,1);assert.equal(settled[0].skipped,true);
    assert.equal(h.log.filter(x=>x[0]==='finish').length,1);
    assert.deepEqual(disposals(h.log).map(x=>x[2]),['skip'],'effects are stopped exactly once');
    assert.equal(h.clock.pending,0);
    await h.clock.advance(9000);assert.equal(h.log.filter(x=>x[0]==='finish').length,1);
  }
});

test('skip while the flight is running disposes the flight and a late arrival changes nothing',async()=>{
  const h=harness(),s=h.controller.start({gen:2});s.signal.acquired({});s.signal.report(located);
  await h.clock.advance(3000);assert.equal(h.controller.state,'fly');
  h.controller.skip();await h.clock.flush();
  assert.equal(h.controller.state,'settled');
  const before=h.states.length;
  h.flights[0].resolve('arrived');await h.clock.advance(5000);
  assert.equal(h.states.length,before);
});

test('skip before the result exists waits for it and then finishes at once',async()=>{
  const h=harness(),s=h.controller.start({gen:3});s.signal.acquired({});
  await h.clock.advance(300);
  h.controller.skip();await h.clock.flush();
  assert.notEqual(h.controller.state,'settled');
  assert.equal(h.log.some(x=>x[0]==='finish'),false);
  s.signal.report(located);await h.clock.flush();
  assert.equal(h.controller.state,'settled');assert.equal(h.log.filter(x=>x[0]==='finish').length,1);
});

test('skip before the result exists, then a failure, ends in error',async()=>{
  const h=harness(),s=h.controller.start({gen:3});s.signal.acquired({});await h.clock.advance(100);
  h.controller.skip();s.signal.fail(new Error('bad file'));await h.clock.flush();
  assert.equal(h.controller.state,'error');assert.equal(h.log.some(x=>x[0]==='finish'),false);
});

test('cancel at every phase stops timers, disposes once and ignores late signals',async()=>{
  for(const at of [50,400,1300,2300,3000,5000]){
    const h=harness(),s=h.controller.start({gen:4});s.signal.acquired({});s.signal.report(located);
    await h.clock.advance(at);
    h.controller.cancel('clear');await h.clock.flush();
    assert.equal(h.controller.state,'cancelled',String(at));
    assert.equal(h.clock.pending,0);
    assert.deepEqual(disposals(h.log).map(x=>x[2]),['clear']);
    const count=h.states.length;
    s.signal.report(noLocation);s.signal.acquired({});s.signal.fail(new Error('late'));
    h.flights[0]?.resolve('arrived');
    await h.clock.advance(20000);
    assert.equal(h.states.length,count,'nothing is revealed after cancel');
    assert.equal(h.log.some(x=>x[0]==='finish'),false);
  }
});

test('starting a new run replaces the old one, and the old run cannot reveal anything',async()=>{
  const h=harness(),a=h.controller.start({gen:1});a.signal.acquired({});await h.clock.advance(1500);
  const b=h.controller.start({gen:2});
  assert.deepEqual(disposals(h.log).map(x=>[x[1],x[2]]),[[1,'replaced']]);
  a.signal.report(located);b.signal.acquired({});await h.clock.advance(3000);
  assert.equal(h.controller.session.gen,2);
  assert.equal(h.controller.state,'scan','run 2 is still waiting for its own result');
  assert.ok(!h.log.some(x=>x[0]==='enter'&&x[1]==='reveal'&&x[2]===1),'run 1 never revealed');
  b.signal.report(noLocation);await h.clock.advance(1100);
  assert.equal(h.controller.state,'settled');
});

test('replay reuses an existing report without any analysis signals',async()=>{
  const h=harness(),s=h.controller.start({gen:5});s.signal.acquired({});s.signal.report(located);
  await h.clock.advance(3000);h.flights[0].resolve('arrived');await h.clock.advance(PC.PROFILES.full.lock);
  assert.equal(h.controller.state,'settled');
  const r=h.controller.replay({gen:5,report:located});
  assert.equal(r.replay,true);
  await h.clock.advance(3000);assert.equal(h.controller.state,'fly');
  h.flights[1].resolve('arrived');await h.clock.advance(PC.PROFILES.full.lock);
  assert.equal(h.controller.state,'settled');
});

test('reduced intensity uses short beats and the camera hook receives the profile',async()=>{
  let profile;const h=harness({intensity:'reduced',fly:ctx=>{profile=ctx.profile;return Promise.resolve('arrived');}});
  const s=h.controller.start({gen:1});s.signal.acquired({});s.signal.report(located);
  await h.clock.advance(1200);
  assert.equal(h.controller.state,'settled');assert.equal(profile.animateCamera,false);assert.equal(profile.fly,0);
});

test('a flight that never reports back is released by a watchdog and recovered',async()=>{
  const h=harness(),s=h.controller.start({gen:1});s.signal.acquired({});s.signal.report(located);
  await h.clock.advance(2800);assert.equal(h.controller.state,'fly');
  await h.clock.advance(PC.PROFILES.full.fly+2500);
  assert.equal(h.controller.state,'lock');
  assert.ok(h.log.some(x=>x[0]==='recover'&&x[1]==='timeout'));
  assert.ok(h.events.some(e=>e.type==='warning'));
});

test('a throwing hook is reported but does not stop the sequence',async()=>{
  const h=harness({onEnter:state=>{if(state==='reveal')throw new Error('hook failed');}});
  const s=h.controller.start({gen:1});s.signal.acquired({});s.signal.report(noLocation);
  await h.clock.advance(3000);
  assert.equal(h.controller.state,'settled');assert.equal(h.errors.length,1);
});

test('cancelling from inside a hook is safe',async()=>{
  const h=harness({onEnter:(state,ctx,api)=>{if(state==='scan')api.controller.cancel('inside');}});
  const s=h.controller.start({gen:1});s.signal.acquired({});s.signal.report(located);
  await h.clock.advance(5000);
  assert.equal(h.controller.state,'cancelled');assert.equal(h.clock.pending,0);
  assert.ok(!h.states.includes('reveal'));
});

test('profiles match the specified windows',()=>{
  const p=PC.PROFILES.full;
  assert.equal(p.acquire+p.scan+p.reveal+p.resolve+p.fly+p.lock,11500);
  const f=PC.PROFILES.fast;assert.equal(f.acquire+f.scan+f.reveal+f.resolve+f.fly+f.lock,5070,'fast keeps the full turn in a shorter flight');
  assert.equal(p.acquire,300);assert.equal(p.acquire+p.scan,1200);assert.equal(p.acquire+p.scan+p.reveal,2200);
  assert.ok(PC.PROFILES.fast.fly<p.fly);assert.equal(PC.PROFILES.reduced.animateCamera,false);
});
