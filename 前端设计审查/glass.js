/* Shared optical surfaces and motion for the offline workspace. */
const StudioGlass = (() => {
  const root = document.documentElement;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const key = 'fai.studio.motion';
  let preferred;
  try { preferred = localStorage.getItem(key); } catch { /* Storage can be disabled for files. */ }
  let moving;
  const activeAnimations = new Set();
  const previousThumbs = new Map();
  const segmentSelector = '.slideTabs,.medium,.modes,.tabs,.deskCategories,.filters,.formats,.hubTabs';
  const selectedSelector = 'button[aria-pressed="true"],button.sel,button[aria-current="page"]';
  const svgNS = 'http://www.w3.org/2000/svg';
  const definitions = document.getElementById('glassFilters');
  const lenses = new Map();
  let layoutFrame = 0;
  let observedGroups = [];

  function syncMotion() {
    moving = preferred == null ? !reduced.matches : preferred === 'on';
    root.dataset.motion = moving ? 'on' : 'off';
    root.dataset.visible = document.hidden ? 'no' : 'yes';
    document.querySelectorAll('[data-motion-toggle]').forEach(button => {
      const label = moving ? '暂停动效' : '播放动效';
      button.title = label;
      button.setAttribute('aria-label',label);
      button.querySelector('span').textContent = label;
    });
    if (!moving || document.hidden) for (const animation of activeAnimations) animation.cancel();
  }
  function motion(target, frames, duration) {
    if (!target || !moving || document.hidden) return;
    for (const animation of target.getAnimations()) if (animation.id === 'studio-jelly') animation.cancel();
    const animation = target.animate(frames,{id:'studio-jelly',duration,easing:'ease-in-out'});
    activeAnimations.add(animation);
    const clear = () => activeAnimations.delete(animation);
    animation.onfinish = clear; animation.oncancel = clear;
  }
  function rebound(target) {
    motion(target,[{scale:'1 1'},{scale:'1.012 .986',offset:.18},{scale:'.994 1.007',offset:.68},{scale:'1 1'}],310);
  }

  // A neutral displacement map preserves the centre. Only the rounded bevel bends the backdrop.
  function applyLens(element) {
    if (!definitions) return;
    const w = element.offsetWidth, h = element.offsetHeight;
    if (!w || !h) return;
    const radius = Math.min(parseFloat(getComputedStyle(element).borderTopLeftRadius)||0, w/2, h/2);
    const id = 'refraction-'+w+'-'+h+'-'+Math.round(radius);
    if (!lenses.has(id)) {
      const canvas = document.createElement('canvas');
      const scale=Math.min(1,400/Math.max(w,h),Math.sqrt(44000/(w*h)));
      const mw=Math.max(1,Math.round(w*scale)),mh=Math.max(1,Math.round(h*scale));
      canvas.width=mw; canvas.height=mh;
      const ctx=canvas.getContext('2d'), map=ctx.createImageData(mw,mh);
      for(let y=0;y<mh;y++) for(let x=0;x<mw;x++) {
        const dx=(x+.5)*w/mw-w/2, dy=(y+.5)*h/mh-h/2, qx=Math.abs(dx)-w/2+radius, qy=Math.abs(dy)-h/2+radius;
        const nx=Math.max(qx,0), ny=Math.max(qy,0), length=Math.hypot(nx,ny);
        const depth=radius-length-Math.min(Math.max(qx,qy),0);
        const bend=Math.pow(Math.max(0,1-Math.max(0,depth)/8),2);
        const normalX=length?nx/length:Number(qx>qy), normalY=length?ny/length:Number(qy>=qx);
        const i=(y*mw+x)*4;
        map.data[i]=128-118*Math.sign(dx)*normalX*bend;
        map.data[i+1]=128-118*Math.sign(dy)*normalY*bend;
        map.data[i+2]=128; map.data[i+3]=255;
      }
      ctx.putImageData(map,0,0);
      const filter=document.createElementNS(svgNS,'filter');
      filter.id=id;
      for(const [name,value] of Object.entries({filterUnits:'userSpaceOnUse',primitiveUnits:'userSpaceOnUse',x:0,y:0,width:w,height:h,'color-interpolation-filters':'sRGB'})) filter.setAttribute(name,value);
      const image=document.createElementNS(svgNS,'feImage');
      image.setAttribute('href',canvas.toDataURL());image.setAttribute('preserveAspectRatio','none');image.setAttribute('width',w);image.setAttribute('height',h);image.setAttribute('result','normal');
      const displacement=document.createElementNS(svgNS,'feDisplacementMap');
      for(const [name,value] of Object.entries({in:'SourceGraphic',in2:'normal',scale:17,xChannelSelector:'R',yChannelSelector:'G'})) displacement.setAttribute(name,value);
      filter.append(image,displacement);definitions.append(filter);lenses.set(id,filter);
    }
    element.style.setProperty('--edge-filter','url("#'+id+'")');
    return id;
  }
  function refresh() {
    const groups=[...document.querySelectorAll(segmentSelector)].filter(g=>g.querySelector(selectedSelector));
    groups.forEach(group=>group.classList.add('glass-segment'));
    const liveLenses=new Set();
    const surfaces='.quickFloat,.node,.medium,.composerShell,.glass-segment:is(.hubTabs,.modes,.medium,.tabs,.slideTabs),.rail,.topline,.card,.deskTile,.example,.hubLink,.guideBar,.miniStats button,.quickGrid button,.toolList button,dialog[open],.editorTools,.review-guide section';
    for(const element of (root.dataset.theme==='glass' ? document.querySelectorAll(surfaces) : [])) {
      liveLenses.add(applyLens(element));
    }
    for(const [id,filter] of lenses) if(!liveLenses.has(id)){filter.remove();lenses.delete(id);}
    for (const group of groups) {
      const button=group.querySelector(selectedSelector);
      let thumb=group.querySelector('.glass-thumb');
      if(!thumb) {
        thumb=document.createElement('i');thumb.className='glass-thumb';thumb.setAttribute('aria-hidden','true');group.prepend(thumb);
      }
      const x=button.offsetLeft,y=button.offsetTop,w=button.offsetWidth,h=button.offsetHeight;
      Object.assign(thumb.style,{left:x+'px',top:y+'px',width:w+'px',height:h+'px'});
      const token=[location.pathname,document.body.dataset.page,group.classList[0],button.dataset.hubTab||''].join('|');
      if(group.querySelector('button.sel'))group.querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(b.classList.contains('sel'))));
      const old=previousThumbs.get(token);
      if(old && old.name!==button.textContent && old.y===y){
        motion(thumb,[
          {transform:'translateX('+(old.x-x)+'px) scaleX('+old.w/w+')'},
          {transform:'translateX('+((old.x-x)*.16)+'px) scale(1.035,.976)',offset:.48},
          {transform:'translateX(0) scale(.987,1.012)',offset:.77},{transform:'none'}
        ],420);
      }
      previousThumbs.set(token,{x,y,w,name:button.textContent});
    }
    if(groups.length!==observedGroups.length || groups.some((g,i)=>g!==observedGroups[i])){
      observer.disconnect();observedGroups=groups;
      groups.forEach(g=>observer.observe(g));
    }
  }
  function schedule(){
    if(layoutFrame) return;
    layoutFrame=requestAnimationFrame(()=>{layoutFrame=0;refresh();});
  }
  const observer=new ResizeObserver(schedule);
  new MutationObserver(schedule).observe(document.body,{subtree:true,attributes:true,attributeFilter:['open']});
  window.addEventListener('resize',schedule);
  document.addEventListener('visibilitychange',syncMotion);
  reduced.addEventListener('change',()=>{preferred=null;try{localStorage.removeItem(key);}catch{}syncMotion();});
  window.applyStudioMotion = setting => {
    preferred = setting === 'on' || setting === 'off' ? setting : null;
    syncMotion();
  };
  document.addEventListener('click',event=>{
    const toggle=event.target.closest('[data-motion-toggle]');
    if(toggle){
      preferred=moving?'off':'on';
      try{localStorage.setItem(key,preferred);}catch{}
      syncMotion();
      document.dispatchEvent(new CustomEvent('studio-motion', { detail: preferred }));
      return;
    }
    const button=event.target.closest('button:not(:disabled)');
    if(button&&!button.closest(segmentSelector) && !button.hasAttribute('data-float-grip')){
      queueMicrotask(()=>{if(button.isConnected)rebound(button);});
    }
  });
  syncMotion();schedule();
  return {schedule,rebound};
})();
