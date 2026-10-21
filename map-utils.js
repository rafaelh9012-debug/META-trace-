(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.MapUtils=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
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
return {selectLabels};
});
