export class WorkspaceConflict extends Error {}
export function requireWorkspaceEpoch(requested,current) {
  if(!Number.isSafeInteger(requested)||requested!==current)throw new WorkspaceConflict('A workspace backup was restored in another tab. Reload the project or compare your draft with its latest saved record before saving.');
}
export const MAX_WORKSPACE_BYTES = 64 * 1024 * 1024;

const done = transaction => new Promise((resolve,reject) => {
  transaction.oncomplete = resolve;
  transaction.onabort = () => reject(transaction.error || new Error('Device storage transaction was interrupted.'));
  transaction.onerror = () => {};
});
const read = request => new Promise((resolve,reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
function valid(row) {
  if (row == null) return {revision:0,epoch:0,bytes:null};
  if (!Number.isSafeInteger(row.revision) || row.revision < 1 || !(row.bytes instanceof Uint8Array) || row.bytes.byteLength > MAX_WORKSPACE_BYTES) {
    const error = new Error('The saved workspace cannot be read. Its stored copy has been preserved.');
    error.recoveryBytes = row.bytes instanceof Uint8Array ? row.bytes : null;
    throw error;
  }
  if(row.epoch!==undefined&&(!Number.isSafeInteger(row.epoch)||row.epoch<0)){
    const error=new Error('The saved workspace identity cannot be read. Its stored copy has been preserved.');error.recoveryBytes=row.bytes;throw error;
  }
  return {...row,epoch:row.epoch??0};
}

export class WorkspaceStore {
  constructor(name, indexedDB = globalThis.indexedDB) {
    this.name=name; this.indexedDB=indexedDB; this.mode='device'; this.memory={revision:0,epoch:0,bytes:null};
  }
  async open() {
    try {
      if (!this.indexedDB) throw new Error('Device storage is unavailable.');
      const request=this.indexedDB.open(this.name,1);
      request.onupgradeneeded=()=>request.result.createObjectStore('workspaces');
      this.db=await read(request);
      this.db.onversionchange=()=>this.db.close();
    } catch(error) { this.mode='memory'; this.reason=error.message; }
    return this;
  }
  async load(key='current') {
    if(this.mode==='memory') return key==='current'?structuredClone(this.memory):null;
    const tx=this.db.transaction('workspaces','readonly'), completed=done(tx);
    completed.catch(()=>{});
    const row=await read(tx.objectStore('workspaces').get(key));
    await completed;
    return key==='current'?valid(row):row||null;
  }
  async save(bytes,expected,{retainPrevious=false,advanceEpoch=false}={}) {
    if(!(bytes instanceof Uint8Array) || bytes.byteLength>MAX_WORKSPACE_BYTES) throw new Error('The browser workspace limit is 64 MiB. No change was saved. Export or use the local app for larger workspaces.');
    if(this.mode==='memory') {
      if(this.memory.revision!==expected)throw new WorkspaceConflict('The workspace changed before it could be saved.');
      if(retainPrevious)this.previous=structuredClone(this.memory);
      this.memory={revision:expected+1,epoch:this.memory.epoch+(advanceEpoch?1:0),bytes:bytes.slice()};return this.memory.revision;
    }
    const tx=this.db.transaction('workspaces','readwrite'), completed=done(tx), store=tx.objectStore('workspaces');
    completed.catch(()=>{});
    const previous=valid(await read(store.get('current')));
    if(previous.revision!==expected) {
      tx.abort();await completed.catch(()=>{});
      throw new WorkspaceConflict('Another tab saved this workspace. Your change was not committed. Reload the project and review your draft.');
    }
    if(retainPrevious&&previous.bytes)store.put(previous,'previous');
    store.put({revision:expected+1,epoch:previous.epoch+(advanceEpoch?1:0),bytes},'current');
    await completed;
    return expected+1;
  }
  async recovery() { return this.mode==='memory'?this.previous||null:this.load('previous'); }
}
