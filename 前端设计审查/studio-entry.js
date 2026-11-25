import { h } from './live-ui.js';
import { studioIcon } from './studio-icons.js';

export function studioEntry({ title, description, fields, alternate = '', merchant = false }) {
  const tools = merchant
    ? [['members', '成员与邀请'], ['data', '项目管理'], ['connections', '项目接入']]
    : [['image', '图片生成'], ['video', '视频生成'], ['copywriting', '电商文案']];
  return '<div class="studio-entry"><section class="entry-art"><img src="/studio/assets/optic-wave.webp" alt="" fetchpriority="high">' +
    '<div class="entry-caption"><span lang="en">COMMERCE STUDIO</span><h1>' +
    (merchant ? '商家管理后台' : '生产工作台') + '</h1></div><ul class="entry-tools">' +
    tools.map(([icon,label]) => '<li>' + studioIcon(icon) + label + '</li>').join('') +
    '</ul></section><section class="live-auth"><div class="card live-panel entry-form"><h2>' + h(title) +
    '</h2><p class="entry-intro">' + h(description) + '</p>' + fields + alternate + '</div></section></div>';
}
