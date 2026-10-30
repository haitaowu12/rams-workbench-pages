/** Convert bridge arguments and detach results before releasing Python proxies. */
export function pythonCall(python,name,arg) {
  if(arg!==undefined)python.globals.set('browser_argument',arg);
  const expression=name+(arg===null?'(None)':arg!==undefined?'(browser_argument)':'()');
  let value;
  try {
    value=python.runPython(expression);
    return value?.toJs?value.toJs({dict_converter:Object.fromEntries}):value;
  } finally {
    value?.destroy?.();
    if(arg!==undefined)python.globals.delete('browser_argument');
  }
}
