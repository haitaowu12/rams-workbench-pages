import {WorkspaceStore} from './browser-store.mjs';
const saveFile=(name,bytes,type='application/vnd.sqlite3')=>{
  const url=URL.createObjectURL(new Blob([bytes],{type})),a=document.createElement('a');
  a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
};
export class BrowserClient {
  constructor(base) {
    this.base=base;this.pending=new Map();this.next=0;this.epoch=0;this.state={mode:'loading'};this.changed=false;
    this.ready=new Promise((resolve,reject)=>{this.resolveReady=resolve;this.rejectReady=reject;});
    this.ready.catch(()=>{});
    this.worker=new Worker(new URL('browser-worker.js',base),{type:'module'});
    this.worker.onmessage=({data})=>this.receive(data);
    this.worker.onerror=event=>this.stop(event.message||'The analysis engine stopped.');
    this.worker.onmessageerror=()=>this.stop('The analysis response could not be read.');
    this.watchStartup();
    this.update('Opening the browser workspace…');
  }
  watchStartup() {
    clearTimeout(this.startTimer);
    this.startTimer=setTimeout(()=>this.stop('The analysis engine did not finish starting. Check the connection, then reload.'),180000);
  }
  update(message) {
    let banner=document.getElementById('browserStatus');
    if(!banner) {
      banner=document.createElement('div');banner.id='browserStatus';banner.className='browser-status';
      banner.setAttribute('role','status');banner.innerHTML='<span></span><div></div>';
      document.querySelector('header').after(banner);
    }
    banner.querySelector('span').textContent=message||(
      this.changed?'Saved in another tab. Reload this project before using its results.':
      this.state.mode==='memory'?'Device saving is unavailable. Work stays in this tab; download a workspace backup before closing.':
      'Saved on this device · Download workspace backups to keep a separate copy.');
    banner.classList.toggle('attention',Boolean(this.stopped||this.changed||this.state.mode==='memory'));
    const actions=banner.querySelector('div');actions.replaceChildren();
    if(this.changed&&!this.stopped) {
      const button=document.createElement('button');button.textContent='Reload saved workspace';button.onclick=()=>location.reload();actions.append(button);
    }
    if(this.stopped) {
      for(const [label,click] of [['Download saved workspace',()=>this.recover()],['Reload workspace',()=>location.reload()]]) {
        const button=document.createElement('button');button.textContent=label;button.onclick=click;actions.append(button);
      }
    }
    const mode=document.getElementById('studyMode');
    if(mode)mode.textContent=this.state.mode==='memory'?'Browser workspace · tab only':'Browser workspace';
  }
  receive(data) {
    if(data.event==='progress'){this.watchStartup();this.update(data.message);return;}
    if(data.event==='ready') {
      clearTimeout(this.startTimer);this.state=data.storage;this.epoch=data.storage.epoch??0;this.update();this.resolveReady();return;
    }
    if(data.event==='fatal') {this.recoveryBytes=data.recoveryBytes;this.stop(data.error);return;}
    if(data.event==='changed') {this.changed=true;this.update();return;}
    const pending=this.pending.get(data.id);if(!pending)return;
    this.pending.delete(data.id);clearTimeout(pending.timer);
    if(data.storage)this.state=data.storage;
    this.update();pending.resolve(data);
  }
  stop(message) {
    if(this.stopped)return;
    this.stopped=new Error(message+' Retain any open draft, then reload the saved workspace before editing again.');
    clearTimeout(this.startTimer);this.worker.terminate();
    this.rejectReady(this.stopped);
    for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(this.stopped);}
    this.pending.clear();this.update(this.stopped.message);
  }
  async call(payload,transfer=[]) {
    await this.ready;if(this.stopped)throw this.stopped;
    const id=++this.next;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>this.stop('The operation was interrupted. Its saved outcome must be checked.'),120000);
      this.pending.set(id,{resolve,reject,timer});
      try{this.worker.postMessage({id,epoch:this.epoch,...payload},transfer);}
      catch(error){clearTimeout(timer);this.pending.delete(id);reject(error);}
    });
  }
  async response(path,body) {
    const data=await this.call({path,body});
    if(!data.error&&data.status<400&&new URL(path,this.base).pathname==='/api/project')this.epoch=data.storage.epoch??0;
    if(data.error)return new Response(JSON.stringify({error:data.error}),{status:data.status||400,headers:{'Content-Type':'application/json'}});
    return new Response(data.body,{status:data.status,headers:{'Content-Type':data.content_type,...(data.filename?{'Content-Disposition':'attachment; filename="'+data.filename+'"'}:{})}});
  }
  confirmFresh(){this.changed=false;this.update();}
  async previewWorkspace(bytes) {
    const data=await this.call({operation:'preview-workspace',bytes});if(data.error)throw new Error(data.error);return data.preview;
  }
  async restoreWorkspace(token) {
    const data=await this.call({operation:'restore-workspace',token});if(data.error)throw new Error(data.error);this.epoch=data.storage.epoch??0;return data;
  }
  async previousWorkspace() {
    const data=await this.call({operation:'previous-workspace'});if(data.error)throw new Error(data.error);
    saveFile(data.filename,data.body);
  }
  async recover() {
    try {
      let bytes=this.recoveryBytes;
      if(!bytes){const store=await new WorkspaceStore('rams-workbench:'+this.base.pathname).open();bytes=(await store.load()).bytes;store.db?.close();}
      if(!bytes)throw new Error('No saved workspace is available in this browser.');
      saveFile('rams-workspace-recovery.sqlite3',bytes);
    }catch(error){this.update(error.message);}
  }
}
