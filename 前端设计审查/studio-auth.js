import { bindLoginScene } from './studio-login-scene.js';
import { studioEntry } from './studio-entry.js';
import { authError, bindCaptcha, bindVerification } from './studio-auth-challenges.js';

const finalLabel = { login: '登录', register: '注册并登录', upgrade: '绑定并登录' };
const pendingLabel = { login: '正在登录…', register: '正在创建账号…', upgrade: '正在绑定…' };

function newFlowId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

const validUsername = value => /^[\p{L}\p{N}._-]{3,32}$/u.test(value) && /\p{L}/u.test(value);
const validPhone = value => /^(1[3-9]\d{9}|\+[1-9]\d{7,14})$/.test(value);
const oldEmailHint = '原邮箱账号请点“绑定旧账号”，使用原邮箱和密码完成绑定。';

function identifierError(value) {
  const id = value.trim();
  if (id.includes('@')) return oldEmailHint;
  if (validPhone(id) || validUsername(id.normalize('NFKC').toLowerCase())) return '';
  return '请输入注册时的用户名或手机号。国际号码须以 + 和国家码开头。';
}

function detailValues(form) {
  const values = Object.fromEntries(new FormData(form));
  values.username = values.username.normalize('NFKC').trim();
  values.phone = values.phone.trim();
  values.email = values.email.trim();
  if (values.type === 'enterprise') values.workspaceName = values.workspaceName.trim();
  else delete values.workspaceName;
  const errors = {
    username: validUsername(values.username.toLowerCase()) ? '' : '用户名须为 3–32 个字符，至少含一个字母或汉字，可使用数字、点、下划线和连字符。',
    phone: validPhone(values.phone) ? '' : '请输入 11 位大陆手机号，或以 + 和国家码开头的国际号码。',
    email: /@[^@]+\.[^@.]+$/.test(values.email) ? '' : '请填写完整邮箱地址，包括邮箱域名。',
    workspaceName: values.type === 'enterprise' && !values.workspaceName ? '请填写企业工作区名称。' : '',
  };
  for (const [name, message] of Object.entries(errors)) {
    if (!message) continue;
    form.elements[name].setCustomValidity(message);
    form.elements[name].reportValidity();
    return;
  }
  return values;
}

export function mountStudioAuth(ctx, root, merchant, signedIn) {
  let view;
  function show(mode, focus = true) {
    view?.abort();
    view = new AbortController();
    const signal = AbortSignal.any([ctx.signal, view.signal]);
    const api = (url, options) => ctx.api(url, { ...options, auth: false, signal });
    ctx.html(studioEntry(mode, merchant));
    const form = root.querySelector('form[data-auth-mode]');
    const errorBox = form.querySelector('[data-auth-error]');
    const submit = form.querySelector('[type=submit]');
    const back = form.querySelector('[data-auth-back]');
    const login = mode === 'login';
    if (login) {
      bindLoginScene(root.querySelector('[data-entry-scene]'), signal);
      const reveal = form.querySelector('[data-entry-password]');
      reveal.addEventListener('click', () => {
        const password = form.elements.password;
        const visible = password.type === 'password';
        password.type = visible ? 'text' : 'password';
        reveal.textContent = visible ? '隐藏' : '显示';
        reveal.setAttribute('aria-label', visible ? '隐藏密码' : '显示密码');
      }, {signal});
    }
    const flowId = login ? null : newFlowId();
    const captcha = login ? bindCaptcha(form, api, signal) : null;
    const verification = login ? null : bindVerification(form, api, signal, flowId);
    let details;
    function showStep(checkCodes) {
      form.dataset.authStep = checkCodes ? 'verification' : 'details';
      for (const [selector, hidden] of [['[data-details]', checkCodes], ['[data-verification]', !checkCodes]]) {
        const group = form.querySelector(selector);
        group.hidden = group.disabled = hidden;
      }
      const stages = root.querySelectorAll('.entry-steps li');
      stages[checkCodes ? 0 : 1].removeAttribute('aria-current');
      stages[checkCodes ? 1 : 0].setAttribute('aria-current', 'step');
      submit.textContent = checkCodes ? finalLabel[mode] : '下一步';
      back.hidden = !checkCodes;
      errorBox.textContent = '';
      form.elements[checkCodes ? 'phoneCode' : 'username'].focus();
    }
    const type = form.elements.namedItem('type');
    if (type) {
      const enterprise = form.elements.workspaceName;
      const toggle = () => {
        enterprise.closest('.entry-enterprise').hidden = enterprise.disabled = type.value !== 'enterprise';
        enterprise.required = !enterprise.disabled;
      };
      type.addEventListener('change', toggle);
      toggle();
    }
    root.querySelectorAll('[data-auth-view]').forEach(button => {
      button.addEventListener('click', () => { if (!form.dataset.submitting) show(button.dataset.authView); });
    });
    back?.addEventListener('click', () => showStep(false));
    form.addEventListener('input', event => {
      event.target.setCustomValidity('');
      event.target.removeAttribute('aria-invalid');
      errorBox.textContent = '';
      if (event.target.name === 'identifier') {
        form.querySelector('#entry-identifier-hint').textContent = event.target.value.includes('@') ? oldEmailHint : '';
      }
    });
    form.addEventListener('invalid', event => {
      const field = event.target;
      field.setAttribute('aria-invalid', 'true');
      const label = field.labels[0]?.textContent || '该字段';
      if (field.validity.valueMissing) errorBox.textContent = '请填写' + label + '。';
      else if (field.validity.customError) errorBox.textContent = field.validationMessage;
      else if (field.validity.typeMismatch) errorBox.textContent = '请填写有效的邮箱地址。';
      else if (field.validity.tooShort) errorBox.textContent = label + '至少需要 ' + field.minLength + ' 个字符。';
      else if (field.validity.patternMismatch) errorBox.textContent = label + '应为 6 位数字。';
    }, true);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (form.dataset.submitting) return;
      if (!login && form.dataset.authStep === 'details') {
        details = detailValues(form);
        if (details) {
          verification.setTargets(details);
          showStep(true);
        }
        return;
      }
      if (login && !captcha.id()) return;
      const values = Object.fromEntries(new FormData(form));
      if (login) {
        const hint = identifierError(values.identifier);
        if (hint) {
          form.elements.identifier.setCustomValidity(hint);
          form.elements.identifier.reportValidity();
          return;
        }
      }
      const body = login ? { ...values, identifier: values.identifier.trim(), captchaId: captcha.id() } :
        { ...details, ...values, flowId };
      form.dataset.submitting = 'true';
      form.setAttribute('aria-busy', 'true');
      submit.disabled = true;
      submit.textContent = pendingLabel[mode];
      errorBox.textContent = '';
      verification?.update();
      const otherButtons = [...root.querySelectorAll('[data-auth-view],[data-auth-back],[data-refresh-captcha]')];
      otherButtons.forEach(button => { button.disabled = true; });
      try {
        const session = await api('/v1/auth/' + mode, { method: 'POST', body });
        if (!session?.token) throw new Error('服务端未返回会话，请重试。');
        if (!signal.aborted) signedIn(session);
      } catch (error) {
        if (!signal.aborted) errorBox.textContent = authError(error, mode);
      } finally {
        if (!signal.aborted) {
          delete form.dataset.submitting;
          form.removeAttribute('aria-busy');
          submit.textContent = finalLabel[mode];
          otherButtons.forEach(button => { button.disabled = false; });
          submit.disabled = false;
          verification?.update();
          if (captcha) await captcha.refresh();
        }
      }
    });
    if (focus) form.querySelector('input').focus();
  }
  show('login', false);
}
