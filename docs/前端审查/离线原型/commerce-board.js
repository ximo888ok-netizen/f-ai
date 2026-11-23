let boardZoom=1;
function positionNodes(){
 deskState.board.forEach((n,i)=>{if(n.x==null){n.x=24+(i%4)*214;n.y=24+Math.floor(i/4)*210}});
}
function boardLines(){
 return deskState.board.map(n=>{if(n.parent==null)return '';const a=deskState.board[n.parent],x=a.x+172,y=a.y+72,end=n.x,last=n.y+72;
 const bend=Math.max(38,Math.abs(end-x)*.45);return '<path d="M'+x+' '+y+' C'+(x+bend)+' '+y+' '+(end-bend)+' '+last+' '+end+' '+last+'"/>'}).join('');
}
function canvasMarkup(){
 positionNodes();const nodes=deskState.board,width=Math.max(880,...nodes.map(n=>n.x+230)),height=Math.max(390,...nodes.map(n=>n.y+195));
 return '<div class="nodeViewport"><div class="nodeSizer" style="width:'+width*boardZoom+'px;height:'+height*boardZoom+'px"><div class="nodeWorld" style="width:'+width+'px;height:'+height+'px;transform:scale('+boardZoom+')"><svg class="edges" aria-hidden="true" width="'+width+'" height="'+height+'">'+boardLines()+'</svg>'+nodes.map((n,i)=>'<div class="node" style="left:'+n.x+'px;top:'+n.y+'px"><button class="dragNode" data-drag-node="'+i+'" aria-label="移动节点 '+(i+1)+'">⠿　'+safe(n.type)+' · '+(i+1)+'</button><label>节点名称<input data-node-name="'+i+'" value="'+safe(n.name)+'"></label>'+(i?'<label>输入节点<select data-node-parent="'+i+'">'+nodes.slice(0,i).map((a,j)=>'<option value="'+j+'" '+(n.parent===j?'selected':'')+'>'+safe((j+1)+' · '+a.name)+'</option>').join('')+'</select></label>':'<small>素材起点</small>')+'</div>').join('')+'</div></div></div>';
}
function showBoard(item){
 return recipeHeader(item)+draftPanel('素材流程','<div class="boardTools"><label>节点类型<select id="node-type">'+selectOpts(['文字','图片','视频','分析','裁剪'],'图片')+'</select></label><button class="plain" data-add-node>添加并连接</button><label>缩放<select id="board-zoom">'+[.5,.75,1,1.25].map(z=>'<option value="'+z+'" '+(boardZoom===z?'selected':'')+'>'+Math.round(z*100)+'%</option>').join('')+'</select></label><button class="primary" data-save-board>保存流程</button></div>'+canvasMarkup()+'<p class="muted spaceTop">拖动节点标题调整位置。聚焦标题后可用方向键移动；变更输入节点可建立分支。</p>');
}
function moveBoardNode(i,x,y,el){const n=deskState.board[i];n.x=Math.max(0,Math.round(x));n.y=Math.max(0,Math.round(y));el.style.left=n.x+'px';el.style.top=n.y+'px';document.querySelector('.edges').innerHTML=boardLines()}
document.addEventListener('pointerdown',e=>{
 const handle=e.target.closest('[data-drag-node]');if(!handle||e.button!==0)return;
 const i=Number(handle.dataset.dragNode),n=deskState.board[i],left=n.x,top=n.y,sx=e.clientX,sy=e.clientY,el=handle.closest('.node');
 handle.setPointerCapture(e.pointerId);
 function move(v){moveBoardNode(i,left+(v.clientX-sx)/boardZoom,top+(v.clientY-sy)/boardZoom,el)}
 function stop(){handle.removeEventListener('pointermove',move);handle.removeEventListener('lostpointercapture',stop);
 const box=document.querySelector('.nodeViewport'),x=box.scrollLeft,y=box.scrollTop;render();document.querySelector('.nodeViewport').scrollTo(x,y);StudioGlass.rebound(document.querySelectorAll('.node')[i])}
 handle.addEventListener('pointermove',move);handle.addEventListener('lostpointercapture',stop);
});
document.addEventListener('keydown',e=>{
 const handle=e.target.closest('[data-drag-node]'),delta={ArrowLeft:[-12,0],ArrowRight:[12,0],ArrowUp:[0,-12],ArrowDown:[0,12]}[e.key];
 if(!handle||!delta)return;e.preventDefault();const i=Number(handle.dataset.dragNode),n=deskState.board[i];moveBoardNode(i,n.x+delta[0],n.y+delta[1],handle.closest('.node'));
});
document.addEventListener('change',e=>{if(e.target.matches('[data-node-parent]'))document.querySelector('.edges').innerHTML=boardLines();
 if(e.target.id==='board-zoom'){boardZoom=Number(e.target.value);render()}});

