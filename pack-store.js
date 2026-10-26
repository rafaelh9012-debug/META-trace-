/*
 * Package store: where installed regional map packages are kept between visits.
 *
 * A package is a .pmtiles file the person chooses. Choosing a file gives the page a read handle to it on disk, and nothing
 * more: closing the page forgets it. To have a package available next time the page keeps a copy in the browser's own
 * storage (IndexedDB), which costs disk space equal to the file's size, so that is a choice the person makes per package.
 * Without IndexedDB (private windows, blocked storage, some embedded browsers) the store falls back to the current session and
 * says so. Either way the package is read by byte range from the Blob; it is never loaded whole into memory.
 *
 * Nothing here touches the network. This module has no DOM.
 */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.PackStore=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';

  const DB_NAME='meta-trace-map-data',STORE='packages',DB_VERSION=1;
  const HEADROOM=64*1024*1024;                   // storage left over after a copy, so the browser is not pushed to its limit

  class PackStoreError extends Error{constructor(code,message){super(message);this.name='PackStoreError';this.code=code;}}

  /** IndexedDB, wrapped so each call is one promise that settles when its transaction has completed. */
  function idbBackend(idb){
    return new Promise((resolve,reject)=>{
      let req;
      try{req=idb.open(DB_NAME,DB_VERSION);}catch(error){reject(error);return;}
      req.onupgradeneeded=()=>{const db=req.result;if(!db.objectStoreNames.contains(STORE))db.createObjectStore(STORE,{keyPath:'id'});};
      req.onerror=()=>reject(req.error||new Error('IndexedDB could not be opened.'));
      req.onblocked=()=>reject(new Error('IndexedDB is blocked by another tab.'));
      req.onsuccess=()=>{
        const db=req.result;
        const run=(mode,fn)=>new Promise((res,rej)=>{
          let result,tx;
          try{
            tx=db.transaction(STORE,mode);
            const r=fn(tx.objectStore(STORE));
            if(r)r.onsuccess=()=>{result=r.result;};
          }catch(error){rej(error);return;}
          tx.oncomplete=()=>res(result);
          tx.onerror=()=>rej(tx.error||new Error('IndexedDB transaction failed.'));
          tx.onabort=()=>rej(tx.error||new Error('IndexedDB transaction aborted.'));
        });
        resolve({
          kind:'browser',
          all:()=>run('readonly',s=>s.getAll()).then(list=>list||[]),
          put:rec=>run('readwrite',s=>s.put(rec)).then(()=>undefined),
          remove:id=>run('readwrite',s=>s.delete(id)).then(()=>true),
          close:()=>{try{db.close();}catch(error){/* already closed */}}
        });
      };
    });
  }

  /**
   * options: {indexedDB, storage (navigator.storage), backend (a ready backend, for tests)}.
   * Resolves to a store; never rejects, a storage that cannot be opened just leaves the store session-only.
   */
  async function create(options={}){
    let backend=options.backend||null,reason='';
    if(!backend){
      if(!options.indexedDB)reason='This browser does not offer persistent storage here.';
      else{
        try{backend=await idbBackend(options.indexedDB);}
        catch(error){reason='Browser storage could not be opened ('+(error&&error.message||error)+').';backend=null;}
      }
    }
    const session=new Map();                     // id -> record held only for this visit
    const storage=options.storage||null;

    const strip=rec=>({id:rec.id,name:rec.name,info:rec.info,size:rec.size,addedAt:rec.addedAt,persisted:!!rec.persisted,blob:rec.blob});

    /** Everything installed, oldest first. A package kept in browser storage and the same file added again this visit count once. */
    async function list(){
      const out=new Map();
      if(backend){
        try{for(const rec of await backend.all())out.set(rec.id,{...strip(rec),persisted:true});}
        catch(error){reason='Saved map data could not be read ('+(error&&error.message||error)+').';}
      }
      for(const rec of session.values())out.set(rec.id,{...strip(rec),persisted:false});
      return [...out.values()].sort((a,b)=>a.addedAt-b.addedAt||a.id.localeCompare(b.id));
    }

    /** Free browser storage in bytes, or null when the browser will not say. */
    async function quota(){
      if(!storage||typeof storage.estimate!=='function')return null;
      try{
        const e=await storage.estimate();
        if(!e||!Number.isFinite(e.quota))return null;
        return {usage:e.usage||0,quota:e.quota,free:Math.max(0,e.quota-(e.usage||0))};
      }catch(error){return null;}
    }

    /**
     * Adds a package: {id, name, info, blob}. With remember:true a copy goes into browser storage; otherwise the Blob is held for
     * this visit only. Throws PackStoreError('unavailable') when remember is asked for but storage is not there and
     * PackStoreError('quota') when the copy does not fit; the package is not added in either case.
     */
    async function add({id,name,info,blob,remember=false,addedAt=Date.now()}){
      if(!id||!blob)throw new PackStoreError('invalid','A package needs an id and its file.');
      const rec={id,name,info,blob,size:blob.size,addedAt};
      if(remember){
        if(!backend)throw new PackStoreError('unavailable',reason||'Browser storage is not available.');
        const q=await quota();
        if(q&&blob.size+HEADROOM>q.free)throw new PackStoreError('quota','This package needs '+blob.size+' bytes of browser storage and '+q.free+' are free.');
        try{await backend.put({...rec,persisted:true});}
        catch(error){
          const quotaError=error&&(error.name==='QuotaExceededError'||error.code===22);
          throw new PackStoreError(quotaError?'quota':'unavailable',quotaError?'The browser has no room for a copy of this package.':'Saving a copy failed ('+(error&&error.message||error)+').');
        }
        session.delete(id);
        return {...strip(rec),persisted:true};
      }
      session.set(id,{...rec,persisted:false});
      // A copy saved earlier under the same id is replaced by this visit's handle only for this visit; remove it so "forget" is honest.
      if(backend)try{await backend.remove(id);}catch(error){/* nothing was saved */}
      return {...strip(rec),persisted:false};
    }

    async function remove(id){
      const had=(await list()).some(r=>r.id===id);
      session.delete(id);
      if(backend)try{await backend.remove(id);}catch(error){/* the session copy is already gone */}
      return had;
    }

    function close(){if(backend&&backend.close)backend.close();}

    return {
      get kind(){return backend?backend.kind:'session';},
      get persistent(){return !!backend;},
      get reason(){return reason;},
      list,add,remove,quota,close
    };
  }

  /** A stable id for a chosen file, so choosing the same file twice replaces the first instead of listing it twice. */
  function idFor(file){
    const text=[file.name,file.size,file.lastModified||0].join('|');
    let h=2166136261;
    for(let i=0;i<text.length;i++){h^=text.charCodeAt(i);h=Math.imul(h,16777619)>>>0;}
    return 'pkg-'+h.toString(16).padStart(8,'0')+'-'+file.size.toString(36);
  }

  return {create,idFor,idbBackend,PackStoreError,DB_NAME,STORE,HEADROOM};
});
