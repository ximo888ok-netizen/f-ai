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
  const observed = new Set();

  function syncMotion() {
    moving = preferred == null ? true : preferred === 'on';
    root.dataset.motion = !moving ? 'off' : (preferred == null && reduced.matches ? 'reduced' : 'on');
    root.dataset.visible = document.hidden ? 'no' : 'yes';
    document.querySelectorAll('[data-motion-toggle]').forEach(button => {
      const label = moving ? '暂停动效' : '播放动效';
      button.title = label;
      button.setAttribute('aria-label',label);
      button.querySelector('span').textContent = label;
    });
    if (!moving || document.hidden) for (const animation of activeAnimations) animation.cancel();
  }
  function moveThumb(target, animation, x, scale) {
    animation?.cancel();
    if (!moving || reduced.matches || document.hidden) return;
    const shift = target.animate([
      { transform: `translateX(${x}px) scaleX(${scale})` },
      { transform: 'none' },
    ], { id: 'studio-thumb', duration: 185, easing: 'cubic-bezier(.23, 1, .32, 1)' });
    activeAnimations.add(shift);
    const clear = () => activeAnimations.delete(shift);
    shift.onfinish = clear; shift.oncancel = clear;
  }

  // Red and green carry edge normals; blue mixes a sharp bevel over the frosted centre.
  function applyLens(element) {
    if (!definitions) return;
    const w = element.offsetWidth, h = element.offsetHeight;
    if (!w || !h) return;
    const css = getComputedStyle(element);
    const blur = parseFloat(css.getPropertyValue('--glass-blur')) || 24;
    const radius = Math.min(parseFloat(css.borderTopLeftRadius)||0, w/2, h/2);
    const bevel = Math.max(5, Math.min(13, radius * .7));
    const id = 'refraction-'+w+'-'+h+'-'+Math.round(radius)+'-'+blur;
    if (!lenses.has(id)) {
      const canvas = document.createElement('canvas');
      const scale=Math.min(1,400/Math.max(w,h),Math.sqrt(44000/(w*h)));
      const mw=Math.max(1,Math.round(w*scale)),mh=Math.max(1,Math.round(h*scale));
      canvas.width=mw; canvas.height=mh;
      const ctx=canvas.getContext('2d');
      if (!ctx) return;
      const map=ctx.createImageData(mw,mh);
      for(let y=0;y<mh;y++) for(let x=0;x<mw;x++) {
        const dx=(x+.5)*w/mw-w/2, dy=(y+.5)*h/mh-h/2, qx=Math.abs(dx)-w/2+radius, qy=Math.abs(dy)-h/2+radius;
        const nx=Math.max(qx,0), ny=Math.max(qy,0), length=Math.hypot(nx,ny);
        const depth=radius-length-Math.min(Math.max(qx,qy),0);
        const edge=Math.max(0,1-Math.max(0,depth)/bevel);
        const bend=edge*edge;
        const normalX=length?nx/length:Number(qx>qy), normalY=length?ny/length:Number(qy>=qx);
        const i=(y*mw+x)*4;
        map.data[i]=128-118*Math.sign(dx)*normalX*bend;
        map.data[i+1]=128-118*Math.sign(dy)*normalY*bend;
        map.data[i+2]=255*edge*edge*(3-2*edge); map.data[i+3]=255;
      }
      ctx.putImageData(map,0,0);
      const filter=document.createElementNS(svgNS,'filter');
      filter.id=id;
      for(const [name,value] of Object.entries({filterUnits:'userSpaceOnUse',primitiveUnits:'userSpaceOnUse',x:0,y:0,width:w,height:h,'color-interpolation-filters':'sRGB'})) filter.setAttribute(name,value);
      const image=document.createElementNS(svgNS,'feImage');
      image.setAttribute('href',canvas.toDataURL());image.setAttribute('preserveAspectRatio','none');image.setAttribute('width',w);image.setAttribute('height',h);image.setAttribute('result','normal');
      function primitive(tag, attributes) {
        const node = document.createElementNS(svgNS, tag);
        for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
        return node;
      }
      const frost = primitive('feGaussianBlur', { in:'SourceGraphic', stdDeviation:blur, edgeMode:'duplicate', result:'frost' });
      const displacement = primitive('feDisplacementMap', { in:'SourceGraphic', in2:'normal', scale:24, xChannelSelector:'R', yChannelSelector:'G', result:'bent' });
      const mask = primitive('feColorMatrix', { in:'normal', type:'matrix', values:'0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 1 0 0', result:'rim' });
      const rim = primitive('feComposite', { in:'bent', in2:'rim', operator:'in', result:'bevel' });
      const combined = primitive('feComposite', { in:'bevel', in2:'frost', operator:'over' });
      filter.append(image, frost, displacement, mask, rim, combined);
      definitions.append(filter);lenses.set(id,filter);
    }
    element.style.setProperty('--edge-filter','url("#'+id+'")');
    return id;
  }
  function refresh() {
    const groups=[...document.querySelectorAll(segmentSelector)].filter(g=>g.querySelector(selectedSelector));
    groups.forEach(group=>group.classList.add('glass-segment'));
    const liveLenses=new Set();
    const surfaces='.quickFloat,.node,.medium,.composerShell,.glass-segment:is(.hubTabs,.modes,.medium,.tabs,.slideTabs),.rail,.topline,.card,.deskTile,.example,.hubLink,.guideBar,.miniStats button,.quickGrid button,.toolList button,dialog[open],.editorTools,.review-guide section,[data-optical-surface]';
    const targets = definitions ? [...document.querySelectorAll(surfaces)].filter(element => !element.classList.contains('liquid-glass')) : [];
    for(const element of targets) {
      liveLenses.add(applyLens(element));
    }
    for(const [id,filter] of lenses) if(!liveLenses.has(id)){filter.remove();lenses.delete(id);}
    for (const group of groups) {
      const selected = group.querySelector('button.sel');
      const button = selected ?? group.querySelector(selectedSelector);
      let thumb=group.querySelector('.glass-thumb');
      if(!thumb) {
        thumb=document.createElement('i');thumb.className='glass-thumb';thumb.setAttribute('aria-hidden','true');group.prepend(thumb);
      }
      const x=button.offsetLeft,y=button.offsetTop,w=button.offsetWidth,h=button.offsetHeight;
      const token=[location.pathname,document.body.dataset.page,group.classList[0],button.dataset.hubTab||''].join('|');
      const old=previousThumbs.get(token);
      const changed = old && (old.x !== x || old.y !== y || old.w !== w || old.name !== button.textContent);
      const previous = changed ? thumb.getAnimations().find(animation => animation.id === 'studio-thumb') : null;
      // A second selection begins at the indicator's current painted position.
      const inFlight = previous ? thumb.getBoundingClientRect() : null;
      Object.assign(thumb.style,{left:x+'px',top:y+'px',width:w+'px',height:h+'px'});
      if (selected) group.querySelectorAll('button').forEach(option => option.setAttribute('aria-pressed', String(option === selected)));
      if (changed && w && old.name !== button.textContent && old.y === y && !group.matches(':focus-within:has(:focus-visible)')) {
        const nextLeft = inFlight ? button.getBoundingClientRect().left : 0;
        moveThumb(thumb, previous, inFlight ? inFlight.left - nextLeft : old.x - x, (inFlight?.width ?? old.w) / w);
      } else {
        previous?.cancel();
      }
      previousThumbs.set(token,{x,y,w,name:button.textContent});
    }
    const sized = new Set([...groups, ...targets]);
    for (const element of observed) if (!sized.has(element)) { observer.unobserve(element); observed.delete(element); }
    for (const element of sized) if (!observed.has(element)) { observed.add(element); observer.observe(element); }
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
    }
  });
  document.addEventListener('DOMContentLoaded', syncMotion, { once: true });
  syncMotion();schedule();
  return {schedule};
})();
