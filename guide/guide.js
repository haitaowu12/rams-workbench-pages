document.querySelector('#printGuide')?.addEventListener('click',()=>window.print());
const player=document.querySelector('#walkthroughVideo'),chapters=document.querySelector('#chapters');
if(player&&chapters)fetch('./chapters.json').then(response=>{if(!response.ok)throw Error('Chapters unavailable');return response.json()}).then(items=>{
 for(const item of items){const button=document.createElement('button'),time=document.createElement('time'),title=document.createElement('span');time.textContent=Math.floor(item.start/60)+':'+String(Math.floor(item.start%60)).padStart(2,'0');title.textContent=item.title;button.type='button';button.append(time,title);button.addEventListener('click',()=>{player.currentTime=item.start;player.play().catch(()=>{});player.focus()});chapters.append(button)}
 const start=Number(new URLSearchParams(location.search).get('chapter'));if(Number.isFinite(start)&&start>0)player.addEventListener('loadedmetadata',()=>{player.currentTime=Math.min(start,player.duration)},{once:true});
}).catch(()=>{chapters.textContent='Use the video controls to explore the walkthrough.'});
