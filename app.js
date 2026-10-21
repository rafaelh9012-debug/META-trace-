/* This file animates text. It never executes the displayed shell commands. */
(() => {
  'use strict';
  const $=id=>document.getElementById(id);
  const {target,sequence,Playback,formatElapsed,humanTypingPlan}=TraceCore;
  const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
  const output=$('output'),scroll=$('terminalContent'),app=$('app');
  const storage={get(k){try{return localStorage.getItem(k);}catch{return null;}},set(k,v){try{if(v===null)localStorage.removeItem(k);else localStorage.setItem(k,v);}catch{}}};
  let clock=null,state='ready',map=null,marker=null,pinHalo=null,labelLayer=null,detailLayer=null,roadsLayer=null,roadCasing=null;
  let currentTab='bash',generation=0,lineTotal=0,activeLine=null,stage=0,mapVisible=false,toastTimer=null;
  const savedMapOptions=(()=>{try{return JSON.parse(storage.get('qmd.offlineOptions')||'{}');}catch{return {};}})();
  const mapOptions={roads:savedMapOptions.roads!==false,places:savedMapOptions.places!==false,details:savedMapOptions.details!==false};
  let refreshTimer=null;
  const info={npcap:{title:'Npcap / adapter',desc:'Adapter status',lines:['driver.status   ready','adapter         local','capture.active  false','packets.read    0','permissions     not requested']},wireshark:{title:'Wireshark / packet inspector',desc:'TCP / TLS stream summary',table:[['Time','Source','Destination','Protocol'],['0.000000','192.0.2.10','198.51.100.20','TLSv1.3'],['0.004263','198.51.100.20','192.0.2.10','TCP'],['0.022149','192.0.2.10','198.51.100.20','TLSv1.3']],lines:['capture.active  false','filter          tcp || tls']},suricata:{title:'Suricata / event monitor',desc:'Inspection status',lines:['engine.status   idle','policy          local','events.read     0','capture.active  false','network.source  none','identity.match  inconclusive']}};
  function toast(text){$('toast').textContent=text;$('toast').classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.remove('visible'),5500);}
  function showTab(name){
    currentTab=name;document.querySelectorAll('.terminal-tab').forEach(b=>{const yes=b.dataset.tab===name;b.classList.toggle('active',yes);b.setAttribute('aria-selected',String(yes));});
    $('terminalContent').hidden=name!=='bash';$('toolPane').hidden=name==='bash';$('shellStatus').textContent=name.toUpperCase();
    if(name==='bash'){scroll.scrollTop=scroll.scrollHeight;return;}
    const data=info[name],pane=$('toolPane');pane.replaceChildren();
    const label=document.createElement('div');label.className='buffer-label';label.textContent=name.toUpperCase()+' / STATUS';pane.append(label);
    const title=document.createElement('h3');title.textContent=data.title;pane.append(title);
    const desc=document.createElement('p');desc.textContent=data.desc;pane.append(desc);
    if(data.table){const table=document.createElement('table');data.table.forEach((row,i)=>{const tr=document.createElement('tr');row.forEach(v=>{const td=document.createElement(i?'td':'th');td.textContent=v;tr.append(td);});table.append(tr);});pane.append(table);}
    for(const text of data.lines){const div=document.createElement('div');div.textContent=text;pane.append(div);}
  }
  function setStage(index){stage=index;const names=['INITIALIZE WORKSPACE','ANALYZE REFERENCE','OPEN COORDINATE VIEW','RESOLVE IDENTITY'];const labels=['Initializing Qwen','Processing reference data','Opening coordinate view','Resolving contact identity'];$('stageLabel').children[0].textContent=String(index+1).padStart(2,'0');$('stageLabel').children[1].textContent=names[index];$('stageText').textContent=labels[index];document.querySelectorAll('[data-step]').forEach(el=>{const n=Number(el.dataset.step);el.classList.toggle('active',n===index);el.classList.toggle('done',n<index);});}
  function updateState(){const running=state==='running';$('playPause').textContent=running?'Ⅱ':'▶';$('playPause').setAttribute('aria-label',running?'Suspend process':'Resume process');$('playState').textContent=({ready:'Ready',running:'Active',paused:'Suspended',complete:'Complete'})[state];$('terminalState').textContent=({ready:'READY',running:'RUNNING',paused:'SUSPENDED',complete:'COMPLETE'})[state];}
  function newLine(kind,text=''){
    const el=document.createElement('div');el.className='line '+kind;
    if(kind==='cmd'){const p=document.createElement('span');p.className='prompt';p.textContent='$ ';el.append(p);const code=document.createElement('span');code.textContent=text;el.append(code);activeLine=code;}else{el.textContent=text;activeLine=el;}
    output.append(el);lineTotal++;$('lineCount').textContent=lineTotal+' lines';scroll.scrollTop=scroll.scrollHeight;return el;
  }
  async function type(text,c,line={}){
    const el=newLine('cmd').lastChild;el.parentElement.dataset.typing=line.human?'manual':'automatic';
    const cursor=document.createElement('span');cursor.className='cursor';el.after(cursor);$('idleCursor').hidden=true;
    try{
      if(line.human){
        for(const action of humanTypingPlan(text,line.humanIndex)){
          if(action.kind==='wait')await c.sleep(action.ms);
          else if(action.kind==='type')el.textContent+=action.text;
          else if(action.kind==='erase')el.textContent=el.textContent.slice(0,-action.count);
          scroll.scrollTop=scroll.scrollHeight;
        }
      }else{let i=0;while(i<text.length){i=Math.min(text.length,i+3+((i*13)%5));el.textContent=text.slice(0,i);scroll.scrollTop=scroll.scrollHeight;await c.sleep(16);}await c.sleep(130);}
    }finally{cursor.remove();}
  }
  async function progress(c){const el=newLine('progress');for(let n=0;n<=100;n+=5){el.textContent='['+'█'.repeat(n/5)+'░'.repeat(20-n/5)+'] '+String(n).padStart(3)+'%';await c.sleep(65);}await c.sleep(220);}
  function featureStyle(f){
    const p=f.properties,z=map?map.getZoom():17,scale=Math.pow(2,Math.max(-2,Math.min(1.5,z-17)));
    if(p.kind==='building')return {color:p.highlight?'#e65370':'#74404f',weight:p.highlight?1.8:.7,fillColor:p.highlight?'#662b3c':'#33212b',fillOpacity:.92};
    if(p.kind==='water')return {color:'#644151',weight:.8,fillColor:'#211722',fillOpacity:.95};
    if(p.kind==='green')return {color:'#39222c',weight:.3,fillColor:'#21161c',fillOpacity:.95};
    if(p.kind==='parking')return {color:'#57303e',weight:.6,fillColor:'#1b141a',fillOpacity:.95};
    if(p.kind==='paved')return {color:'#4c2938',weight:.5,fillColor:'#251820',fillOpacity:.9};
    if(p.kind==='barrier')return {color:'#b65f75',weight:.8,opacity:.55,dashArray:'2 3'};
    if(['tree','furniture','poi','bus'].includes(p.kind))return {color:p.kind==='tree'?'#794154':'#e07891',weight:.6,fillColor:p.kind==='tree'?'#3a2230':'#b45b75',fillOpacity:.7};
    const major=['primary','secondary','tertiary','trunk'].includes(p.highway),minor=['footway','path','cycleway','steps','pedestrian'].includes(p.highway);
    return {color:major?'#ad6275':minor?'#663c4a':'#734454',weight:Math.max(.65,(major?5.5:minor?.8:2.8)*scale),opacity:minor?.65:1,dashArray:minor?'2 3':null,lineCap:'round'};
  }
  function casingStyle(f){const s=featureStyle(f);return {...s,color:'#100a0f',weight:s.weight+2.8,dashArray:null,opacity:1};}
  const escapeHtml=text=>String(text).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function refreshLabels(){
    if(!map||!labelLayer)return;labelLayer.clearLayers();
    const chosen=TraceCore.selectLabels(window.TRACE_MAP_LABELS,map.getZoom(),p=>map.latLngToContainerPoint([p.lat,p.lon]),map.getSize(),mapOptions);
    for(const p of chosen){
      const text=(p.symbol?'<i class="poi-symbol">'+escapeHtml(p.symbol)+'</i>':'')+escapeHtml(p.text);
      const html='<span class="osm-label osm-'+p.kind+'" style="width:'+p.width+'px;transform:rotate('+(p.angle||0)+'deg)">'+text+'</span>';
      L.marker([p.lat,p.lon],{interactive:false,pane:'localLabels',icon:L.divIcon({className:'osm-label-anchor',html,iconSize:[p.width,18],iconAnchor:[p.width/2,9]})}).addTo(labelLayer);
    }
  }
  function refreshMap(){
    if(!map)return;
    if(roadsLayer)roadsLayer.setStyle(featureStyle);if(roadCasing)roadCasing.setStyle(casingStyle);
    if(detailLayer){const show=mapOptions.details&&map.getZoom()>=17.5;if(show&&!map.hasLayer(detailLayer))detailLayer.addTo(map);if(!show&&map.hasLayer(detailLayer))map.removeLayer(detailLayer);}
    refreshLabels();
  }
  function scheduleMapRefresh(){clearTimeout(refreshTimer);refreshTimer=setTimeout(refreshMap,90);}
  function localMap(){
    map.createPane('localBase').style.zIndex=150;
    map.createPane('localLabels').style.zIndex=450;
    map.createPane('localDetails').style.zIndex=180;
    const renderer=L.canvas({pane:'localBase'});
    L.geoJSON(window.TRACE_MAP_DATA,{renderer,pane:'localBase',style:featureStyle,filter:f=>['green','parking','paved','water','building'].includes(f.properties.kind),interactive:false}).addTo(map);
    roadCasing=L.geoJSON(window.TRACE_MAP_DATA,{renderer,pane:'localBase',style:casingStyle,filter:f=>f.properties.kind==='road'&&!['footway','path','cycleway','steps','pedestrian'].includes(f.properties.highway),interactive:false}).addTo(map);
    roadsLayer=L.geoJSON(window.TRACE_MAP_DATA,{renderer,pane:'localBase',style:featureStyle,filter:f=>f.properties.kind==='road',interactive:false}).addTo(map);
    const detailsRenderer=L.canvas({pane:'localDetails'});
    detailLayer=L.geoJSON(window.TRACE_MAP_DATA,{renderer:detailsRenderer,pane:'localDetails',interactive:false,filter:f=>['barrier','tree','furniture','bus','poi'].includes(f.properties.kind),style:featureStyle,pointToLayer:(f,latlng)=>{
      const k=f.properties.kind;return L.circleMarker(latlng,{renderer:detailsRenderer,pane:'localDetails',radius:k==='tree'?2.8:k==='poi'?2:1.4,color:k==='tree'?'#794154':'#e07891',weight:.6,fillColor:k==='tree'?'#3a2230':'#b45b75',fillOpacity:k==='tree'?.65:.8,interactive:false});
    }});
    labelLayer=L.layerGroup().addTo(map);map.on('moveend zoomend',scheduleMapRefresh);refreshMap();
    map.attributionControl.addAttribution('Bundled data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>');
    $('mapSource').textContent=window.TRACE_MAP_META.features.toLocaleString()+' map features · vector geometry';
    $('mapFeatureCount').textContent=window.TRACE_MAP_META.features.toLocaleString()+' map features / '+window.TRACE_MAP_META.labels.toLocaleString()+' labels';
  }
  function ensureMap(){
    if(map)return;
    const b=window.TRACE_MAP_META.bounds;
    map=L.map('map',{zoomControl:false,attributionControl:true,zoomSnap:.1,zoomDelta:.5,preferCanvas:true,minZoom:15,maxZoom:20,maxBounds:[[b[1],b[0]],[b[3],b[2]]],maxBoundsViscosity:.9,scrollWheelZoom:true,fadeAnimation:!reduced,zoomAnimation:!reduced}).setView([29.6485,-82.341],15.4);
    localMap();
    L.control.scale({position:'bottomright',imperial:false,maxWidth:80}).addTo(map);
  }
  async function reveal(c){
    showTab('bash');setStage(2);mapVisible=true;app.classList.add('map-open');$('mapPanel').setAttribute('aria-hidden','false');ensureMap();await c.sleep(reduced?30:850);map.invalidateSize({pan:false});
    const text=target.lat.toFixed(8)+', '+target.lon.toFixed(8);for(let i=0;i<=text.length;i+=2){$('searchText').textContent=text.slice(0,i);await c.sleep(24);}$('searchText').textContent=text;await c.sleep(400);
  }
  async function cameraTo(lat,lon,zoom,c,duration){const from=map.getCenter(),fromZoom=map.getZoom(),start=c.time;if(reduced){map.setView([lat,lon],zoom,{animate:false});refreshMap();return;}while(c.time-start<duration){const t=Math.min(1,(c.time-start)/duration),e=1-Math.pow(1-t,3);map.setView([from.lat+(lat-from.lat)*e,from.lng+(lon-from.lng)*e],fromZoom+(zoom-fromZoom)*e,{animate:false});await c.sleep(32);}map.setView([lat,lon],zoom,{animate:false});refreshMap();}
  function pin(){
    if(marker)return;
    pinHalo=L.circle([target.lat,target.lon],{radius:18,color:'#ef486b',weight:1,opacity:.45,fillColor:'#e74265',fillOpacity:.08,interactive:false}).addTo(map);
    marker=L.marker([target.lat,target.lon],{zIndexOffset:500,icon:L.divIcon({className:'reference-pin',html:'<div class="pin-wrap pin-enter"><span class="pin-ring"></span><span class="pin-tail"></span><span class="pin-ball">?</span><span class="pin-dot"></span></div>',iconSize:[64,83],iconAnchor:[30,79]}),title:'User-supplied reference · identity inconclusive'}).addTo(map);
    marker.on('click',()=>{$('targetCard').classList.toggle('visible');});
  }
  async function event(name,c){if(name==='reveal-map')await reveal(c);if(name==='fly-map'){await cameraTo(target.lat,target.lon,18,c,3400);await c.sleep(450);}if(name==='drop-pin'){pin();await c.sleep(650);}if(name==='complete'){showTab('bash');$('targetCard').classList.add('visible');app.classList.add('complete');setStage(3);await c.sleep(700);}}
  async function start(){
    const gen=++generation;if(clock)clock.cancel();clock=new Playback({frame:time=>{$('timer').textContent=formatElapsed(time);}});clock.setSpeed($('speed').value);const c=clock;
    state='running';mapVisible=false;app.classList.remove('map-open','complete','map-focused');app.classList.add('running');$('terminal').setAttribute('aria-hidden','false');$('mapPanel').setAttribute('aria-hidden','true');$('targetCard').classList.remove('visible');output.replaceChildren();lineTotal=0;$('lineCount').textContent='0 lines';$('idleCursor').hidden=true;$('searchText').textContent='Waiting for coordinates…';$('progressFill').style.width='0%';showTab('bash');setStage(0);updateState();
    if(map){if(marker){marker.remove();marker=null;}if(pinHalo){pinHalo.remove();pinHalo=null;}map.setView([29.6485,-82.341],15.4,{animate:false});refreshMap();}
    c.start();try{await c.sleep(650);for(let i=0;i<sequence.length;i++){if(gen!==generation)break;const line=sequence[i];if(line.stage)setStage({metadata:1,map:2,identity:3}[line.stage]);if(line.kind==='event')await event(line.event,c);else if(line.kind==='cmd')await type(line.text,c,line);else if(line.kind==='progress')await progress(c);else{newLine(line.kind,line.text);await c.sleep(line.kind==='error'?1000:line.kind==='result'?650:220);}$('progressFill').style.width=((i+1)/sequence.length*100)+'%';}if(gen!==generation)return;state='complete';c.pause();$('idleCursor').hidden=false;$('stageText').textContent='Identity inconclusive';updateState();}catch(e){if(!c.cancelled)toast('Process stopped: '+e.message);}
  }
  function playPause(){if(state==='ready'||state==='complete'){start();return;}if(state==='running'){clock.pause();state='paused';}else{clock.resume();state='running';}updateState();}
  $('startButton').addEventListener('click',start);$('playPause').addEventListener('click',playPause);$('replay').addEventListener('click',start);$('speed').addEventListener('change',()=>{if(clock)clock.setSpeed($('speed').value);storage.set('qmd.speed',$('speed').value);});
  document.querySelectorAll('[data-tab]').forEach(btn=>btn.addEventListener('click',()=>showTab(btn.dataset.tab)));
  $('zoomIn').addEventListener('click',()=>map&&map.zoomIn());$('zoomOut').addEventListener('click',()=>map&&map.zoomOut());$('recenter').addEventListener('click',()=>map&&map.setView([target.lat,target.lon],18));
  $('mapDetailsButton').addEventListener('click',()=>openSettings());
  $('mapFocus').addEventListener('click',()=>{if(!mapVisible){toast('The map opens during step 03.');return;}app.classList.toggle('map-focused');setTimeout(()=>map.invalidateSize({pan:false}),850);});
  $('fullscreen').addEventListener('click',async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();}catch{toast('Use your browser’s fullscreen control (F11 on Windows).');}});
  const dialog=$('settingsDialog');let settingsPaused=false;
  function openSettings(){settingsPaused=state==='running';if(settingsPaused)playPause();$('roadNames').checked=mapOptions.roads;$('placeNames').checked=mapOptions.places;$('fineDetails').checked=mapOptions.details;dialog.showModal();}
  function closeSettings(){dialog.close();if(settingsPaused&&state==='paused')playPause();settingsPaused=false;}
  $('settingsButton').addEventListener('click',openSettings);$('closeSettings').addEventListener('click',closeSettings);dialog.addEventListener('cancel',e=>{e.preventDefault();closeSettings();});
  $('settingsForm').addEventListener('submit',e=>{e.preventDefault();mapOptions.roads=$('roadNames').checked;mapOptions.places=$('placeNames').checked;mapOptions.details=$('fineDetails').checked;storage.set('qmd.offlineOptions',JSON.stringify(mapOptions));refreshMap();closeSettings();toast('Offline map detail settings applied.');});
  document.addEventListener('keydown',e=>{if(dialog.open||e.target.matches('input,select,textarea,button,a'))return;if(e.code==='Space'){e.preventDefault();playPause();}else if(e.key.toLowerCase()==='r')start();else if(e.key.toLowerCase()==='m')$('mapFocus').click();});
  new ResizeObserver(()=>{if(map)map.invalidateSize({pan:false});}).observe($('mapPanel'));
  function frame(at){if(clock)clock.tick(at);requestAnimationFrame(frame);}requestAnimationFrame(frame);
  // Open directly into the terminal; transport controls stay off the screen.
  setTimeout(()=>{if(state==='ready')start();},350);
})();
