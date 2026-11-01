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

// An editing aid, not a substitute for the server's complete solver admission.
export function ramInputChecklist(records, config) {
  const byId = new Map(records.map(r => [r.id,r])), leaves = [];
  function walk(n, depth=0) {
    if (!n || depth>24) return;
    if (Object.hasOwn(n,'item')) leaves.push(n.item);
    else if (Array.isArray(n.children)) n.children.forEach(c=>walk(c,depth+1));
  }
  walk(config.tree);
  const occurrences = new Map();
  for (const id of leaves) occurrences.set(id,(occurrences.get(id)||0)+1);
  const positive = n => typeof n === 'number' && Number.isFinite(n) && n > 0;
  return [...new Set(leaves)].map(id => {
    const r = byId.get(id), d = r?.data || {}, issues = [];
    if (!r || r.state === 'archived' || r.kind !== 'item') issues.push('Select an active equipment item.');
    else {
      if (d.model !== 'exponential') issues.push('Select the exponential component model.');
      if (!positive(d.rate_per_hour)) issues.push('Enter a positive failure rate [1/h].');
      if (!positive(d.mean_active_repair_hours)) issues.push('Enter a positive mean active repair time [h].');
      if (!d.mode || d.mode !== config.mode) issues.push('Match the study operating mode.');
      if (!String(d.source || '').trim()) issues.push('Record the data source / revision.');
      if (!String(d.conditions || '').trim()) issues.push('State the applicable conditions.');
      if (d.dependency_status !== 'reviewed_independent' || !String(d.dependency_review || '').trim()) issues.push('Record the component dependency review and rationale.');
    }
    if (occurrences.get(id)>1) issues.push('This physical instance appears more than once in the success model.');
    return {id, title:r?.title || 'Unselected component', issues};
  });
}


// A projection of declared relationships, never an acceptance calculation.
export function hazardTrace(snapshot, hazardId) {
  const records = new Map(snapshot.entities.filter(r => r.state !== 'archived').map(r => [r.id,r]));
  const hazard = records.get(hazardId);
  if (!hazard || hazard.kind !== 'hazard') return null;
  const linked = (target, relation, kind) => [...new Set(snapshot.links.filter(l => l.target === target && l.relation === relation).map(l => l.source))].map(id => records.get(id)).filter(r => r && r.kind === kind);
  const controls = linked(hazardId,'controls','control');
  const requirements = new Map();
  for (const control of controls) for (const req of linked(control.id,'implements','requirement')) {
    if (!requirements.has(req.id)) requirements.set(req.id,{record:req,controls:[],verifications:linked(req.id,'verifies','verification'),coverage:(snapshot.requirement_coverage || []).filter(c => c.requirement === req.id)});
    requirements.get(req.id).controls.push(control.id);
  }
  const targetIds = new Set([hazardId,...controls.map(c=>c.id),...requirements.keys()]);
  const actions = snapshot.entities.filter(r => r.kind === 'action' && r.state !== 'archived' && !String(r.data?.completion_evidence || '').trim() && snapshot.links.some(l => l.source === r.id && l.relation === 'addresses' && targetIds.has(l.target)));
  return {hazard,controls,requirements:[...requirements.values()],actions,coverage:(snapshot.coverage || []).find(c=>c.hazard === hazardId)};
}
