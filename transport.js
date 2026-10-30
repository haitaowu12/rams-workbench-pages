import {BrowserClient} from './browser-client.js';
export const browserRuntime=document.documentElement.dataset.runtime==='browser'?new BrowserClient(new URL('./',import.meta.url)):null;
export const runtimeReady=browserRuntime?.ready||Promise.resolve();
export const request=(path,body)=>browserRuntime?browserRuntime.response(path,body):fetch(path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','X-RAMS-Request':'1'},body:JSON.stringify(body)});
const preferences=new Map();
const storageKey=key=>browserRuntime?'rams-browser-v1:'+key:key;
export const uiStorage={
  getItem(key){if(preferences.has(key))return preferences.get(key);try{const value=localStorage.getItem(storageKey(key));if(value!==null)preferences.set(key,value);return value;}catch{return null;}},
  setItem(key,value){preferences.set(key,String(value));try{localStorage.setItem(storageKey(key),String(value));}catch{browserRuntime?.update('Draft preferences cannot be saved on this device. Apply valid changes and download a workspace backup before closing.');}},
  removeItem(key){preferences.set(key,null);try{localStorage.removeItem(storageKey(key));}catch{}}
};
