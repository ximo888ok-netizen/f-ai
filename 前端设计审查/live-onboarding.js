import { action, link, notice } from './live-ui.js';
const steps=[['建立商品档案','products'],['添加已获授权的素材','assets'],['制作商品主图','media/images'],
  ['填写上新草稿','drafts/new'],['检查规格和库存','drafts/quality'],['查看任务与交付物','tasks']];
export function onboarding(preferences) {
  const index=preferences.onboardingStep??0;
  const current=steps[index];
  return '<details class="card live-panel live-fold"><summary>上新操作清单 · '+index+' / '+steps.length+'</summary>'+
    (current?notice('当前步骤：'+current[0])+link(current[0],current[1])+action('标记此步完成','onboarding',index+1):
      notice('已完成这份清单。')+action('重新开始清单','onboarding',0))+'</details>';
}
export function bindOnboarding(ctx) {
  ctx.click('onboarding',async value=>{
    await ctx.api('/v1/settings',{method:'PATCH',body:{onboardingStep:Number(value)}});ctx.reload();
  });
}
