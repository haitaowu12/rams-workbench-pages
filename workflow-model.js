// Pure workflow rules shared by the live workbench and portable study.
export function actionState(record, today) {
  const data = record.data || {};
  if (typeof data.completion_evidence === 'string' && data.completion_evidence.trim()) return 'completed';
  const due = data.due || '';
  // Legacy free-text dispositions remain readable, but are never guessed as dates.
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(due) && Number.isFinite(Date.parse(due)) && new Date(due).toISOString().slice(0,10) === due;
  if (validDate && due < today) return 'overdue';
  if (validDate && due === today) return 'due_today';
  return 'open';
}

export function sortedActions(records, {today, filter = 'open', owner = '', query = ''} = {}) {
  const rank = {overdue: 0, due_today: 1, open: 2, completed: 3};
  return records.filter(r => r.kind === 'action' && r.state !== 'archived')
    .filter(r => filter === 'all' || (filter === 'open' ? actionState(r,today) !== 'completed' :
      filter === 'unassigned' ? !String(r.data.owner || '').trim() && actionState(r,today) !== 'completed' : actionState(r,today) === filter))
    .filter(r => !owner || r.data.owner === owner)
    .filter(r => `${r.id} ${r.title} ${r.description} ${r.data.owner || ''}`.toLowerCase().includes(query.toLowerCase()))
    .sort((a,b) => rank[actionState(a,today)] - rank[actionState(b,today)] || String(a.data.due || '9999').localeCompare(String(b.data.due || '9999')) || a.id.localeCompare(b.id));
}

export function mergeDraft(base, local, remote, choices = {}) {
  const conflicts = [];
  const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);
  const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  function visit(b,l,r,path) {
    if (equal(l,b)) return r;
    if (equal(r,b) || equal(l,r)) return l;
    if (object(b) && object(l) && object(r)) {
      const result = {};
      for (const key of new Set([...Object.keys(b), ...Object.keys(l), ...Object.keys(r)])) {
        if (path.length === 0 && key === 'revision') { result[key] = r[key]; continue; }
        const own = (obj,k) => Object.hasOwn(obj,k) ? obj[k] : undefined;
        const v = visit(own(b,key),own(l,key),own(r,key),[...path,key]);
        if (v !== undefined) Object.defineProperty(result,key,{value:v,enumerable:true,writable:true,configurable:true});
      }
      return result;
    }
    const key = JSON.stringify(path);
    if (!['local','remote'].includes(choices[key])) conflicts.push({key, path, before:b, local:l, remote:r});
    return choices[key] === 'local' ? l : r;
  }
  return {merged: visit(base,local,remote,[]), conflicts};
}
