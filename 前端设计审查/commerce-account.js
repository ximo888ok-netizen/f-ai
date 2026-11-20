const serviceDemo={section:'wallet',points:0,plan:'个人',entries:[]};
function servicePage(){
 const tabs=[['wallet','积分与流水'],['member','会员权益'],['client','离线客户端']].map(([k,n])=>'<button class="pill '+(serviceDemo.section===k?'sel':'')+'" data-service-tab="'+k+'">'+n+'</button>').join('');
 let body;
 if(serviceDemo.section==='wallet'){
 body=draftPanel('演练账户','<div class="resultItem"><small>本地演练余额</small><strong>'+serviceDemo.points+' 积分</strong></div><label for="demo-deposit">模拟入账数量</label><input id="demo-deposit" type="number" min="1" max="10000" value="100"><button data-demo-deposit class="primary spaceTop">模拟入账</button><p class="muted spaceTop">仅更新当前页面会话；不会发起支付或改变第三方积分。</p>')+draftPanel('流水',serviceDemo.entries.length?serviceDemo.entries.map(x=>'<div class="stockrow"><strong>模拟入账　+'+x.value+'</strong><small>'+safe(x.time)+'</small></div>').join(''):'<p class="muted">暂无演练流水。</p>')
 }else if(serviceDemo.section==='member'){
 body=draftPanel('身份与权益','<label for="preview-plan">预览用户类型</label><select id="preview-plan">'+selectOpts(['个人','企业','代理'],serviceDemo.plan)+'</select><p class="notice">'+({个人:'个人项目、素材和积分流水。',企业:'企业项目、成员权限与积分分配。',代理:'推广归因、代理订单与结算记录。'})[serviceDemo.plan]+'</p>')+draftPanel('正式服务','<p>套餐价格、开通和支付回执将由平台账户服务提供。</p><button data-nav="home" class="plain spaceTop">查看角色工作区</button>')
 }else{
 body=draftPanel('Windows 离线审查包','<p>下载 ZIP 后解压全部文件，双击「打开设计稿.html」。可在 Windows 的 Edge 或 Chrome 中审查本轮工作台。</p>'+(document.documentElement.hasAttribute('data-offline-bundle')?'<p class="notice">当前打开的是离线审查包。</p>':'<p class="spaceTop"><a class="plain" download href="F-AI-Studio-Review.zip">下载离线审查包</a></p>')+'')+draftPanel('版本范围','<p>包含前端页面、交互脚本和原创商品示例。原生 Windows 安装、自动更新与在线服务属于正式客户端交付。</p>')
 }
 return title('账户与客户端','审查积分、角色权益和 Windows 离线分发入口。')+'<div class="tabs">'+tabs+'</div><div class="deskSplit">'+body+'</div>';
}
document.addEventListener('click',e=>{
 const b=e.target.closest('button');if(!b)return;
 if(b.dataset.serviceTab){serviceDemo.section=b.dataset.serviceTab;render()}
 if(b.hasAttribute('data-demo-deposit')){const value=Number(byId('demo-deposit').value);if(!Number.isInteger(value)||value<1||value>10000){toast('请输入 1–10000 的整数');return}serviceDemo.points+=value;serviceDemo.entries.unshift({value,time:new Date().toLocaleTimeString('zh-CN')});render();toast('本地演练已入账')}
});
document.addEventListener('change',e=>{if(e.target.id==='preview-plan'){serviceDemo.plan=e.target.value;render()}});

