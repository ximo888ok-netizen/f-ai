import { loginScene } from './studio-login-scene.js';
import { input, select } from './live-ui.js';

function control(label, name, attrs, hint = '') {
  return '<div class="entry-field"><label for="entry-' + name + '">' + label + '</label>' +
    input(name, 'id="entry-' + name + '" required ' + attrs) + hint + '</div>';
}

const literalText = 'autocapitalize="none" spellcheck="false"';
const loginFields = control('用户名或手机号', 'identifier', 'autocomplete="username" maxlength="128" aria-describedby="entry-identifier-hint" ' + literalText,
  '<small id="entry-identifier-hint" role="status"></small>') +
  '<div class="entry-field"><label for="entry-password">密码</label><div class="entry-password-wrap">' +
  input('password','id="entry-password" type="password" required autocomplete="current-password" minlength="10" maxlength="128"') +
  '<button type="button" data-entry-password aria-label="显示密码">显示</button></div></div>' +
  '<div class="entry-field"><label for="entry-captcha">图形验证码</label><div class="entry-code-row">' +
  '<input id="entry-captcha" name="captchaAnswer" required inputmode="numeric" autocomplete="off" maxlength="16" placeholder="输入图中字符">' +
  '<button type="button" class="entry-captcha" data-refresh-captcha aria-label="刷新图形验证码" title="刷新图形验证码">' +
  '<img data-captcha-image alt="" hidden><span data-captcha-placeholder>加载中…</span><span aria-hidden="true">↻</span></button></div>' +
  '<small data-captcha-status role="status"></small></div>';

function detailsFields(mode, merchant) {
  const upgrade = mode === 'upgrade';
  const password = upgrade ? '原账号密码' : '设置密码';
  return control('用户名', 'username', 'autocomplete="username" maxlength="64" placeholder="3–32 个字符，至少含一个字母或汉字" ' + literalText) +
    control(password, 'password', 'type="password" autocomplete="' + (upgrade ? 'current' : 'new') + '-password" minlength="10" maxlength="128" placeholder="' + (upgrade ? '输入原账号密码' : '10–128 个字符') + '"') +
    control('手机号', 'phone', 'type="tel" autocomplete="tel" maxlength="32" placeholder="大陆手机号或含国家码的号码"') +
    control(upgrade ? '原账号邮箱' : '邮箱', 'email', 'type="email" autocomplete="email" maxlength="254" ' + literalText) +
    (upgrade ? '' : '<div class="entry-field"><label for="entry-type">账号类型</label>' +
      select('type', [['personal','个人'], ['enterprise','企业']], merchant ? 'enterprise' : 'personal', 'id="entry-type"') + '</div>' +
      '<div class="entry-enterprise">' + control('企业工作区名称', 'workspaceName', 'autocomplete="organization" maxlength="100"') + '</div>');
}

function verificationField(channel, label, name) {
  return '<div class="entry-field"><label for="entry-' + name + '">' + label + '验证码</label>' +
    '<span class="entry-target" data-target="' + channel + '"></span><div class="entry-code-row">' +
    input(name, 'id="entry-' + name + '" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required autocomplete="one-time-code" placeholder="6 位数字" aria-describedby="entry-' + channel + '-status"') +
    '<button type="button" class="entry-send" data-send-code="' + channel + '" aria-label="发送' + label + '验证码">发送验证码</button></div>' +
    '<small id="entry-' + channel + '-status" data-send-status="' + channel + '" role="status"></small></div>';
}

function steps() {
  return '<ol class="entry-steps" aria-label="办理进度"><li aria-current="step">账号信息</li><li>双重验证</li></ol>';
}

function switchButton(mode, label) {
  return '<button type="button" data-auth-view="' + mode + '">' + label + '</button>';
}

export function studioEntry(mode, merchant) {
  const login = mode === 'login';
  const title = login ? '欢迎回来' : mode === 'register' ? '创建账号' : '绑定旧账号';
  const info = login ? (merchant ? '登录商家工作空间' : '登录你的工作台空间') :
    mode === 'upgrade' ? '使用原账号邮箱和密码，绑定新的登录方式。' : '';
  const fields = login ? loginFields :
    '<fieldset data-details><legend class="entry-sr">账号信息</legend>' + detailsFields(mode, merchant) + '</fieldset>' +
    '<fieldset data-verification hidden disabled><legend class="entry-sr">验证手机号和邮箱</legend>' +
    verificationField('sms', '短信', 'phoneCode') + verificationField('email', '邮箱', 'emailCode') + '</fieldset>';
  const footer = login ? switchButton('upgrade', '绑定旧账号') : switchButton('login', '返回登录');
  const artwork = login ? loginScene(merchant) : '<section class="entry-art" aria-label="' + (merchant ? '商家管理后台' : '生产工作台') + '">' +
    '<div class="entry-caption"><div class="entry-brand">寰球 AI</div><p>' + (merchant ? '商家管理后台' : '电商生产工作台') + '</p></div>' +
    '<img src="/studio/assets/optic-wave.webp" alt="" fetchpriority="high" width="720" height="720">' +
    '<p class="entry-art-note">' + (merchant ? '成员与权限 · 企业项目 · 操作记录' : '商品素材 · 图像与视频 · 电商文案') + '</p></section>';
  const modes = '<div class="entry-login-modes" aria-label="账号入口"><span aria-current="page">密码登录</span>' +
    switchButton('register','创建账号') + '</div>';
  return '<div class="studio-entry' + (login ? ' entry-split' : '') + '">' + artwork +
    '<section class="live-auth" aria-labelledby="entry-title"><div class="entry-form"><h1 id="entry-title">' + title + '</h1>' +
    (info ? '<p class="entry-intro">' + info + '</p>' : '') + (login ? modes : steps()) +
    '<form class="live-form" data-form="' + (merchant ? 'login' : 'auth') + '" data-auth-mode="' + mode + '" data-auth-step="details">' +
    fields + '<p class="entry-feedback" data-auth-error role="alert"></p><div class="entry-actions">' +
    (login ? '' : '<button type="button" class="entry-back" data-auth-back hidden>上一步</button>') +
    '<button class="primary" type="submit">' + (login ? '登录' : '下一步') + '</button></div></form>' +
    '<div class="entry-alternate">' + footer + '</div></div></section></div>';
}
