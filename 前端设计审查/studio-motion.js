export const studioMotion = (()=>{
 const root=document.documentElement,nav=document.querySelector('#nav'),main=document.querySelector('#main');
 const enabled=()=>root.dataset.motion==='on'&&!matchMedia('(prefers-reduced-motion: reduce)').matches;
 const links=document.createElement('div');links.className='water-nav-links';nav.append(links);
 const pill=document.createElement('i');pill.className='preview-pill water-pill';pill.setAttribute('aria-hidden','true');
 pill.innerHTML='<i class="water-lens"></i><svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><defs>'+
   '<linearGradient id="water-fill" x2="85%" y2="100%"><stop class="water-fill-top"/><stop offset=".53" class="water-fill-mid"/><stop offset="1" class="water-fill-end"/></linearGradient>'+
   '<linearGradient id="water-rim" x2="76%" y2="100%"><stop class="water-rim-top"/><stop offset=".38" class="water-rim-mid"/><stop offset=".72" class="water-rim-end"/><stop offset="1" class="water-rim-top"/></linearGradient>'+
   '<path id="water-outline"/></defs><use href="#water-outline" class="water-under"/><use href="#water-outline" class="water-skin"/></svg>';
 nav.prepend(pill);
 const outline=pill.querySelector('path'),lens=pill.querySelector('.water-lens');
 const box=r=>({x:r.x,y:r.y,w:r.width,h:r.height});
 let targetBox=null,points=[],flight=null,navFrame=0;
 function perimeter(b){
   const cx=b.x+b.w/2,cy=b.y+b.h/2,r=Math.min(b.h,b.w)/2,half=b.w/2-r,ring=[];
   const add=(x,y,nx,ny)=>ring.push({x:cx+x,y:cy+y,nx,ny});
   for(let i=0;i<12;i++)add(-half+2*half*i/12,-r,0,-1);
   for(let i=0;i<14;i++){const a=-Math.PI/2+Math.PI*i/14;add(half+r*Math.cos(a),r*Math.sin(a),Math.cos(a),Math.sin(a));}
   for(let i=0;i<12;i++)add(half-2*half*i/12,r,0,1);
   for(let i=0;i<14;i++){const a=Math.PI/2+Math.PI*i/14;add(-half+r*Math.cos(a),r*Math.sin(a),Math.cos(a),Math.sin(a));}
   return ring;
 }
 // Tint and rim share a single smooth contour through the surface samples.
 function paintPill(ring){
   const xs=ring.map(p=>p.x),ys=ring.map(p=>p.y),left=Math.min(...xs)-1.5,top=Math.min(...ys)-1.5;
   const xy=p=>(p.x-left).toFixed(2)+' '+(p.y-top).toFixed(2),count=ring.length;
   let shape='M'+xy(ring[0]);
   for(let i=0;i<count;i++){
     const a=ring[(i+count-1)%count],b=ring[i],c=ring[(i+1)%count],d=ring[(i+2)%count];
     shape+='C'+xy({x:b.x+(c.x-a.x)/6,y:b.y+(c.y-a.y)/6})+' '+xy({x:c.x-(d.x-b.x)/6,y:c.y-(d.y-b.y)/6})+' '+xy(c);
   }
   shape+='Z';pill.style.transform='translate3d('+left.toFixed(2)+'px,'+top.toFixed(2)+'px,0)';
   pill.style.width=(Math.max(...xs)-left+1.5)+'px';pill.style.height=(Math.max(...ys)-top+1.5)+'px';
   outline.setAttribute('d',shape);lens.style.clipPath='path("'+shape+'")';
 }
 function residual(delta,velocity,omega,drag,t){
   const attenuation=drag*omega,wd=omega*Math.sqrt(1-drag*drag),phase=wd*t;
   return Math.exp(-attenuation*t)*(delta*Math.cos(phase)+(velocity+attenuation*delta)/wd*Math.sin(phase));
 }
 function sample(m,t){
   const bulkRest=(1+23*t)*Math.exp(-23*t);
   const fast=residual(1,0,26,.5,t),slow=residual(1,0,11.6,.5,t);
   const squeeze=Math.max(-2.1/m.crossRadius,Math.min(.16,(slow-fast)*.24*m.amount));
   // A short axial compression on arrival releases into a smaller second stretch.
   const age=Math.max(0,t-.165);
   const impulse=Math.exp(-7.8*age)*Math.sin(24*age);
   const squash=.43*m.amount*impulse;
   const rebound=m.kick*impulse;
   return m.nodes.map(n=>({
     x:n.end.x-m.bulkX*bulkRest+residual(n.rx,n.vx,n.omega,n.drag,t)-m.px*n.cross*squeeze+m.ux*(rebound-n.axial*squash),
     y:n.end.y-m.bulkY*bulkRest+residual(n.ry,n.vy,n.omega,n.drag,t)-m.py*n.cross*squeeze+m.uy*(rebound-n.axial*squash)
   }));
 }
 function settle(){
   cancelAnimationFrame(navFrame);navFrame=0;flight=null;pill.removeAttribute('data-flow');
   if(targetBox){points=perimeter(targetBox);paintPill(points);}
 }
 function tick(time){
   if(!flight)return;
   flight.age+=Math.max(0,Math.min(28,time-flight.lastFrame))/1000;flight.lastFrame=time;const t=flight.age;
   if(t>=1.02||root.dataset.motion!=='on'||document.hidden)return settle();
   points=sample(flight,t);paintPill(points);navFrame=requestAnimationFrame(tick);
 }
 function align(route,animate=true){
   const parent={drafts:'products',commerce:'shops','copy-review':'skills','cloud-assets':'assets',feishu:'inbox'};
   const active=links.querySelector('[aria-current=page]')||links.querySelector('a[href="#'+(parent[route]||'__')+'"]');
   links.querySelector('[data-motion-parent]')?.removeAttribute('data-motion-parent');
   if(active&&!active.hasAttribute('aria-current'))active.setAttribute('data-motion-parent','');
   if(!active){targetBox=null;settle();points=[];pill.hidden=true;return;}
   pill.hidden=false;
   const nb=nav.getBoundingClientRect(),b=active.getBoundingClientRect();
   const dest={x:b.left-nb.left-nav.clientLeft+nav.scrollLeft+3,y:b.top-nb.top-nav.clientTop+nav.scrollTop+1.5,w:Math.max(2,b.width-6),h:Math.max(2,b.height-3)};
   if(targetBox&&Object.keys(dest).every(k=>Math.abs(dest[k]-targetBox[k])<.25))return;
   const previous=targetBox;targetBox=dest;
   if(!previous||!points.length||!animate||root.dataset.motion!=='on'||document.hidden)return settle();
   const now=performance.now(),t=flight?flight.age:0;
   const source=flight?sample(flight,t):points,next=flight?sample(flight,t+.006):source;
   const cx=source.reduce((sum,p)=>sum+p.x,0)/source.length,cy=source.reduce((sum,p)=>sum+p.y,0)/source.length;
   const tx=dest.x+dest.w/2,ty=dest.y+dest.h/2,dx=tx-cx,dy=ty-cy,distance=Math.hypot(dx,dy);
   if(distance<.75)return settle();
   const ux=dx/distance,uy=dy/distance,px=-uy,py=ux;
   const crossRadius=Math.max(1,(Math.abs(px)*dest.w+Math.abs(py)*dest.h)/2);
   const bulk=Math.max(0,distance-76),bulkX=ux*bulk,bulkY=uy*bulk;
   const limitVelocity=v=>Math.max(-750,Math.min(750,v));
   // Retarget from the current contour and velocity so a second click can reverse the drop.
   const nodes=perimeter(dest).map((end,i)=>{
     const cross=(end.x-tx)*px+(end.y-ty)*py;
     const spine=Math.max(0,1-(cross/crossRadius)**2);
     const leading=(end.nx*ux+end.ny*uy)*(.27+.73*spine*spine);
     return {end,cross,axial:(end.x-tx)*ux+(end.y-ty)*uy,omega:18.8+7.2*leading,drag:.50+.035*leading,
       rx:source[i].x-end.x+bulkX,ry:source[i].y-end.y+bulkY,
       vx:limitVelocity((next[i].x-source[i].x)/.006),vy:limitVelocity((next[i].y-source[i].y)/.006)};
   });
   cancelAnimationFrame(navFrame);flight={lastFrame:now,age:0,bulkX,bulkY,ux,uy,px,py,crossRadius,nodes,kick:Math.min(12,distance*.30),amount:Math.min(1,distance/42)};
   pill.dataset.flow='';tick(now);
 }
 new ResizeObserver(()=>align(location.hash.slice(1).split('/')[0]||'desk',false)).observe(nav);
 document.addEventListener('studio-motion',()=>{if(root.dataset.motion!=='on')settle()});
 document.addEventListener('visibilitychange',()=>{if(document.hidden)settle()});

 const reducePointerMotion=matchMedia('(prefers-reduced-motion: reduce)');
 const canLightPointer=()=>enabled() && !matchMedia('(forced-colors: active)').matches;
 const softWindow=document.createElement('i'),sheen=document.createElement('i');
 softWindow.className='soft-pointer-window';sheen.className='soft-pointer-sheen';
 softWindow.setAttribute('aria-hidden','true');softWindow.inert=true;softWindow.append(sheen);
 let card=null,paintFrame=0,pointer=null;
 function restCard(){
   if(!card)return;
   card.removeAttribute('data-lit');card.style.setProperty('--angle','0deg');card=null;
 }
 function clear(){
   cancelAnimationFrame(paintFrame);paintFrame=0;pointer=null;restCard();
   softWindow.removeAttribute('data-visible');
 }
 function paint(){
   paintFrame=0;
   if(!pointer||!canLightPointer()||document.hidden)return clear();
   const {x,y}=pointer;
   const target=document.elementFromPoint(x,y);
   if(!target)return clear();
   const dialog=target.closest('dialog[open]'),host=dialog||document.body;
   if(softWindow.parentNode!==host)host.append(softWindow);
   let sx=x,sy=y;
   if(dialog){
     const r=dialog.getBoundingClientRect();
     if(!r.width||!r.height)return clear();
     sx=(x-r.left)*dialog.offsetWidth/r.width-dialog.clientLeft;
     sy=(y-r.top)*dialog.offsetHeight/r.height-dialog.clientTop;
     Object.assign(softWindow.style,{left:dialog.scrollLeft+'px',top:dialog.scrollTop+'px',width:dialog.clientWidth+'px',height:dialog.clientHeight+'px'});
   }else if(softWindow.hasAttribute('style'))softWindow.removeAttribute('style');
   const hovered=target.closest('#main :is(.live-panel,.studio-summary-card,.studio-service,.studio-tasks-list),#themeDialog .themeChoice');
   if(hovered!==card){restCard();card=hovered;}
   if(card){
     let edge=card.querySelector(':scope > .soft-card-edge');
     if(!edge){edge=document.createElement('i');edge.className='soft-card-edge';edge.setAttribute('aria-hidden','true');card.append(edge);}
     const r=card.getBoundingClientRect(),clip=v=>Math.max(0,Math.min(1,v));
     const u=clip((x-r.left)/Math.max(1,r.width)),v=clip((y-r.top)/Math.max(1,r.height));
     const nx=2*u-1,ny=2*v-1,dist=Math.hypot(nx,ny);
     const limit=reducePointerMotion.matches?0:(r.width>740||r.height>480?1.6:3.8);
     card.style.setProperty('--ax',dist?-ny/dist:1);card.style.setProperty('--ay',dist?nx/dist:0);
     card.style.setProperty('--angle',Math.min(1,dist)*limit+'deg');
     card.style.setProperty('--mx',(u*100).toFixed(2)+'%');card.style.setProperty('--my',(v*100).toFixed(2)+'%');
     card.dataset.lit='';
   }
   softWindow.toggleAttribute('data-on-card',Boolean(card));
   sheen.style.transform='translate3d('+sx.toFixed(2)+'px,'+sy.toFixed(2)+'px,0) translate(-50%,-50%)';
   softWindow.setAttribute('data-visible','');
 }
 function schedulePaint(){if(pointer&&!paintFrame)paintFrame=requestAnimationFrame(paint);}
 document.addEventListener('pointermove',e=>{
   if(e.pointerType==='touch'||!canLightPointer())return clear();
   pointer={x:e.clientX,y:e.clientY};schedulePaint();
 },{passive:true});
 document.addEventListener('pointerout',e=>{if(!e.relatedTarget)clear();});
 document.addEventListener('scroll',schedulePaint,{capture:true,passive:true});
 document.addEventListener('pointercancel',clear);window.addEventListener('blur',clear);
 document.addEventListener('visibilitychange',()=>{if(document.hidden)clear()});
 document.addEventListener('studio-motion',clear);

 let pending, activeDetail, returnFocus;
 document.addEventListener('click',event=>{
   if(event.defaultPrevented||event.button!==0||event.ctrlKey||event.metaKey||event.altKey||event.shiftKey)return;
   const link=event.target.closest('#main a[href^="#"]');
   if(!link||link.hash===location.hash||!link.matches('.smallbtn,[data-expand-route]'))return;
   const detail=location.hash==='#products'&&link.hash.startsWith('#products/edit/');
   if(!detail&&!link.hasAttribute('data-expand-route'))return;
   pending={to:link.hash,anchor:box(link.getBoundingClientRect()),detail};
   if(detail){
     const background=main.querySelector('.live-main')?.cloneNode(true);
     if(background){
       background.inert=true;
       background.className='fx-scenery';
       background.setAttribute('aria-hidden','true');
       background.querySelectorAll('.soft-card-edge').forEach(node=>node.remove());
       for(const node of background.querySelectorAll('*')){
         for(const {name} of [...node.attributes]){
           if(name.startsWith('data-')||['id','for','name','autofocus'].includes(name))node.removeAttribute(name);
         }
       }
       pending.background=background;
     }
   }
 },true);

 function takeTransition(){
   const transition=pending?.to===location.hash?pending:activeDetail?.to===location.hash?activeDetail:null;
   returnFocus=activeDetail&&location.hash==='#products'?activeDetail.to:null;
   pending=null;
   activeDetail=null;
   if(transition&&main.firstElementChild)main.firstElementChild.inert=true;
   return transition;
 }

 function discardTransition(transition){
   if(transition)transition.cancelled=true;
 }

 function mount(view,transition){
   clear();
   if(!transition||transition.cancelled||transition.to!==location.hash){
     main.replaceChildren(view);
     if(returnFocus){
       const previous=Array.from(view.querySelectorAll('a[href^="#"]')).find(link=>link.hash===returnFocus);
       if(previous){previous.focus({preventScroll:true});returnFocus=null;}
     }
     return;
   }
   if(transition.detail&&transition.background){
     const dialog=document.createElement('dialog');
     dialog.className='fx-detail';
     const title=view.querySelector('h1');
     dialog.setAttribute('aria-label',title?.textContent||'商品详情');
     const close=document.createElement('button');
     close.type='button';
     close.className='plain fx-back';
     close.textContent='关闭';
     const closeDetail=()=>{
       if(dialog.open&&location.hash===transition.to)history.back();
     };
     close.addEventListener('click',closeDetail);
     dialog.addEventListener('cancel',event=>{event.preventDefault();closeDetail();});
     (view.querySelector('.live-title')||view).prepend(close);
     dialog.append(view);
     main.replaceChildren(transition.background,dialog);
     dialog.showModal();
     close.focus({preventScroll:true});
     dialog.scrollTop=0;
     activeDetail=transition;
     if(enabled()&&!transition.shown){
       const {x,y,w,h}=box(dialog.getBoundingClientRect());
       const start=transition.anchor;
       if(w&&h)dialog.animate([
         {transform:'translate('+(start.x-x)+'px,'+(start.y-y)+'px) scale('+start.w/w+','+start.h/h+')',
           transformOrigin:'top left',opacity:.45},
         {transform:'none',transformOrigin:'top left',opacity:1}
       ],{duration:340,easing:'cubic-bezier(.18,.73,.21,1)'});
     }
     transition.shown=true;
     return;
   }
   main.replaceChildren(view);
   if(enabled()&&!transition.shown)view.animate([
     {opacity:.5,transform:'translateY(7px)'},{opacity:1,transform:'none'}
   ],{duration:180,easing:'ease-out'});
   transition.shown=true;
 }

 return {links,align,takeTransition,discardTransition,mount};
})();
