const DeskFloat = (() => {
  const sets = [
    [['mainimg','商品主图'],['skuimg','多规格图'],['detailimg','详情长图'],['retouch','局部精修']],
    [['quickfilm','商品快创'],['direct','分镜导演'],['materialcut','素材套剪'],['speech','文案配音']],
    [['roi','收益测算'],['mentor','运营顾问'],['publish','发布确认'],['promotion','推广归因']]
  ];
  let position=null;
  function markup(slide) {
    const tools=sets[slide].filter(([id])=>deskAvailable(deskIndex.get(id)));
    if(!tools.length)return '';
    return '<section class="quickFloat" aria-label="快捷工具浮板"><button class="floatGrip" data-float-grip title="拖动标题，或按方向键移动"><b>快捷工具</b><span aria-hidden="true">⠿</span></button><div class="floatGrid">'+tools.map(([id,label])=>'<button data-desk="'+id+'">'+glyph(deskIndex.get(id).icon)+'<span>'+label+'</span></button>').join('')+'</div></section>';
  }
  function bounds(el) {
    const host=el.offsetParent;
    return [Math.max(0,host.clientWidth-el.offsetWidth-12),Math.max(0,host.clientHeight-el.offsetHeight-12)];
  }
  function place(el,x,y) {
    const [w,h]=bounds(el);
    x=Math.max(0,Math.min(w,x-6)); y=Math.max(0,Math.min(h,y-6));
    position=[w?x/w:0,h?y/h:0];
    el.style.left=(6+x)+'px';el.style.top=(6+y)+'px';
  }
  function restore() {
    const el=document.querySelector('.quickFloat');
    if(!el || !position)return;
    const [w,h]=bounds(el);
    el.style.left=(6+w*position[0])+'px';el.style.top=(6+h*position[1])+'px';
  }
  window.addEventListener('resize',restore);
  document.addEventListener('pointerdown',e=>{
    const grip=e.target.closest('[data-float-grip]');
    if(!grip || e.button!==0)return;
    const el=grip.parentElement, x=el.offsetLeft, y=el.offsetTop, startX=e.clientX, startY=e.clientY;
    grip.setPointerCapture(e.pointerId);
    const move=event=>{if(event.pointerId===e.pointerId)place(el,x+event.clientX-startX,y+event.clientY-startY);};
    const stop=()=>{grip.removeEventListener('pointermove',move);grip.removeEventListener('lostpointercapture',stop);StudioGlass.rebound(el);};
    grip.addEventListener('pointermove',move);grip.addEventListener('lostpointercapture',stop);
  });
  document.addEventListener('keydown',e=>{
    const grip=e.target.closest('[data-float-grip]');
    const d={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[e.key];
    if(!grip||!d)return;e.preventDefault();
    const el=grip.parentElement,step=e.shiftKey?20:6;
    place(el,el.offsetLeft+d[0]*step,el.offsetTop+d[1]*step);
  });
  return {markup,restore};
})();
