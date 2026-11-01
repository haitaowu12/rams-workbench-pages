import {pythonCall as callPython} from './browser-python.mjs';
import {loadPyodide} from './pyodide/pyodide.mjs';
import {WorkspaceStore,WorkspaceConflict,MAX_WORKSPACE_BYTES,requireWorkspaceEpoch} from './browser-store.mjs';
const base=new URL('./',import.meta.url);
const store=new WorkspaceStore('rams-workbench:'+base.pathname);
let python, revision=0, epoch=0, initialRow, stage=null;
const channel=typeof BroadcastChannel==='function'?new BroadcastChannel(store.name):null;
const identity=crypto.randomUUID();
const messageFor=error=>{
  const message=String(error.message||error);
  if(message.includes('Traceback (most recent call last)')) {
    const last=message.trim().split('\n').at(-1);
    if(last.includes('Invalid:'))return last.split('Invalid:').slice(1).join('Invalid:').trim();
    return 'The analysis engine could not complete the operation. The saved workspace has been preserved.';
  }
  if(/^(KeyError|TypeError|PythonError):/.test(message))return 'The analysis engine could not complete the operation. The saved workspace has been preserved.';
  return message;
};
const announce=()=>{try{channel?.postMessage({identity,revision,epoch});}catch{}};
const pythonCall=(name,arg)=>callPython(python,name,arg);
function status(extra={}) {return {mode:store.mode,revision,epoch,...extra};}
function binary(bytes) {return bytes==null?null:new Uint8Array(bytes);}
async function restore(row) {
  if(row.bytes)pythonCall('browser_validate_workspace',row.bytes);
  pythonCall('browser_replace_workspace',row.bytes);
  revision=row.revision;epoch=row.epoch??0;
}
const ready=(async()=>{
  await store.open();initialRow=await store.load();
  self.postMessage({event:'progress',message:'Preparing the workbench… First load may take longer. You can open the user guide while it starts.'});
  python=await loadPyodide({indexURL:new URL('pyodide/',base).href});
  self.postMessage({event:'progress',message:'Opening device storage…'});
  await python.loadPackage('sqlite3');
  self.postMessage({event:'progress',message:'Loading study methods…'});
  const manifest=await(await fetch(new URL('python-files.json',base))).json();
  const response=await fetch(new URL(manifest.archive.path,base));
  if(!response.ok)throw Error('Required analysis files are unavailable. Reload after checking the connection.');
  const bytes=new Uint8Array(await response.arrayBuffer());
  const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(v=>v.toString(16).padStart(2,'0')).join('');
  if(hash!==manifest.archive.sha256)throw Error('Application file verification failed. Reload before opening a study.');
  python.globals.set('app_archive',bytes);
  python.runPython("import io,zipfile\nwith zipfile.ZipFile(io.BytesIO(bytes(app_archive))) as archive: archive.extractall('/app')\n");
  python.globals.delete('app_archive');
  python.runPython("import sys\nsys.path.insert(0,'/app')\nfrom rams.browser import request as browser_request, replace_workspace as browser_replace_workspace, validate_workspace as browser_validate_workspace, workspace_bytes as browser_workspace_bytes\n");
  self.postMessage({event:'progress',message:'Opening your saved workspace…'});
  await restore(initialRow);
  self.postMessage({event:'ready',storage:status()});
})().catch(error=>{
  self.postMessage({event:'fatal',error:messageFor(error),recoveryBytes:binary(error.recoveryBytes||initialRow?.bytes)});
  throw error;
});
// Every write is serialized within this tab and commits through an IndexedDB
// compare-and-swap across tabs. No successful mutation is acknowledged early.
let queue=Promise.resolve();
self.onmessage=({data:message})=>{queue=queue.then(async()=>{
  try {
    await ready;
    const latest=await store.load();if(latest.revision!==revision)await restore(latest);
    let response;
    if(message.operation==='preview-workspace') {
      if(!(message.bytes instanceof Uint8Array)||message.bytes.byteLength>MAX_WORKSPACE_BYTES)throw Error('Choose a workspace backup up to 64 MiB.');
      const preview=pythonCall('browser_validate_workspace',message.bytes);
      stage={bytes:message.bytes.slice(),token:crypto.randomUUID(),expected:revision};
      response={preview:{...preview,token:stage.token,expected:revision}};
    } else if(message.operation==='restore-workspace') {
      if(!stage||stage.token!==message.token||stage.expected!==revision)throw new WorkspaceConflict('The workspace changed after this restore preview. Inspect the backup again before replacing it.');
      revision=await store.save(stage.bytes,revision,{retainPrevious:true,advanceEpoch:true});
      epoch++;
      pythonCall('browser_replace_workspace',stage.bytes);stage=null;
      response={restored:true};announce();
    } else if(message.operation==='previous-workspace') {
      const previous=await store.recovery();if(!previous?.bytes)throw Error('There is no earlier workspace retained for recovery.');
      response={status:200,content_type:'application/vnd.sqlite3',filename:'rams-previous-workspace.sqlite3',body:previous.bytes};
    } else {
      const mutation=message.body!==undefined&&!['/api/import-preview','/api/rbd-diagram','/api/check-analysis','/api/check-fault-tree'].includes(message.path);
      if(mutation)requireWorkspaceEpoch(message.epoch,epoch);
      const serialized=JSON.stringify({path:message.path,body:message.body});
      if(new TextEncoder().encode(serialized).byteLength>20_000_000)throw Error('Request exceeds the 20 MB input limit.');
      response=pythonCall('browser_request',serialized);
      if(message.body!==undefined&&response.status>=400)await restore(await store.load());
      if(mutation&&response.status<400) {
        try {
          revision=await store.save(pythonCall('browser_workspace_bytes'),revision);
          announce();
        } catch(error) {
          await restore(await store.load());
          response={status:error instanceof WorkspaceConflict?409:507,content_type:'application/json',body:new TextEncoder().encode(JSON.stringify({error:error.message||'Device saving failed. No change was committed.'}))};
        }
      }
    }
    self.postMessage({id:message.id,...response,storage:status()});
  } catch(error) {
    // Reopen the last committed snapshot even after an unexpected engine error.
    // If that fails, stop editing rather than continue with uncertain state.
    try {if(python)await restore(await store.load());}
    catch(recoveryError){self.postMessage({event:'fatal',error:messageFor(recoveryError)});return;}
    self.postMessage({id:message.id,error:messageFor(error),status:error instanceof WorkspaceConflict?409:400,storage:status()});
  }
}).catch(error=>self.postMessage({id:message.id,error:messageFor(error)}));};
channel?.addEventListener('message',event=>{
  if(event.data.identity!==identity&&event.data.revision>revision)self.postMessage({event:'changed',revision:event.data.revision});
});
