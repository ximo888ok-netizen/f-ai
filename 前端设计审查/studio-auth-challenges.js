const failureLabels = {
  CAPTCHA_INVALID: '图形验证码有误或已过期，请输入新图中的字符。',
  VERIFICATION_CODE_INVALID: '短信或邮箱验证码有误或已过期，请核对两条验证码，或重新发送。',
  USERNAME_IN_USE: '该用户名已被使用，请返回上一步更换用户名。',
  PHONE_IN_USE: '该手机号已绑定其他账号，请核对号码或返回登录。',
  EMAIL_IN_USE: '该邮箱已注册，可返回登录或选择“绑定旧账号”。',
  RATE_LIMITED: '请求过于频繁，请稍后重试。',
  INVALID_INPUT: '请核对填写的信息后重试。',
  DATABASE_UNAVAILABLE: '服务暂时无法读取账号信息，请稍后重试。',
};

export function authError(error, mode) {
  if (error.code === 'UNAUTHENTICATED' || error.status === 401) {
    return mode === 'upgrade' ? '无法绑定，请核对原邮箱和原密码。已绑定的账号可直接登录。' : '用户名、手机号或密码有误，请重新输入。';
  }
  return failureLabels[error.code] || error.message || '请求未完成，请重试。';
}

export function bindCaptcha(form, api, signal) {
  const button = form.querySelector('[data-refresh-captcha]');
  const image = button.querySelector('img');
  const placeholder = button.querySelector('[data-captcha-placeholder]');
  const status = form.querySelector('[data-captcha-status]');
  const submit = form.querySelector('[type=submit]');
  let challenge;
  let expiry;
  function clear(label) {
    challenge = undefined;
    clearTimeout(expiry);
    form.elements.captchaAnswer.value = '';
    image.hidden = true;
    image.removeAttribute('src');
    placeholder.hidden = false;
    placeholder.textContent = label;
    submit.disabled = true;
  }
  async function refresh() {
    if (button.disabled || signal.aborted) return;
    clear('加载中…');
    status.textContent = '';
    button.disabled = true;
    try {
      const result = await api('/v1/auth/captcha');
      if (signal.aborted) return;
      if (!result.id || !result.image?.startsWith('data:image/png;base64,') || !(result.expiresIn > 0)) {
        throw new Error('图形验证码加载失败，请点击刷新。');
      }
      image.src = result.image;
      image.hidden = false;
      placeholder.hidden = true;
      challenge = result.id;
      submit.disabled = false;
      expiry = setTimeout(() => {
        clear('点击刷新');
        status.textContent = '图形验证码已过期，请刷新。';
      }, result.expiresIn * 1000);
    } catch (error) {
      if (signal.aborted) return;
      clear('点击重试');
      status.textContent = authError(error) + ' 点击右侧按钮重新加载。';
    } finally {
      if (!signal.aborted) button.disabled = false;
    }
  }
  button.addEventListener('click', async () => {
    await refresh();
    if (!signal.aborted) form.elements.captchaAnswer.focus();
  });
  signal.addEventListener('abort', () => clearTimeout(expiry), { once: true });
  void refresh();
  return { id: () => challenge, refresh };
}

export function bindVerification(form, api, signal, flowId) {
  const channels = [...form.querySelectorAll('[data-send-code]')].map(button => {
    const channel = button.dataset.sendCode;
    const sms = channel === 'sms';
    return { button, channel, name: sms ? '短信' : '邮件', input: form.elements[sms ? 'phoneCode' : 'emailCode'],
      status: form.querySelector('[data-send-status="' + channel + '"]'),
      display: form.querySelector('[data-target="' + channel + '"]'), attempts: new Map(), target: '' };
  });
  let timer;
  function update() {
    clearTimeout(timer);
    let coolingDown = false;
    for (const { button, name, target, attempts } of channels) {
      const attempt = attempts.get(target);
      const seconds = Math.max(0, Math.ceil(((attempt?.until || 0) - Date.now()) / 1000));
      if (seconds) coolingDown = true;
      button.disabled = Boolean(attempt?.sending || seconds || form.dataset.submitting);
      const title = attempt?.sending ? '发送中…' : seconds ? seconds + ' 秒后重发' : attempt?.delivered ? '重新发送' : '发送验证码';
      if (button.textContent !== title) button.textContent = title;
      button.setAttribute('aria-label', (title === '发送验证码' ? '发送' + name + '验证码' : name + '验证码，' + title));
    }
    if (coolingDown) timer = setTimeout(update, 1000);
  }
  for (const item of channels) item.button.addEventListener('click', async () => {
    const { target, channel, name } = item;
    if (item.button.disabled || !target) return;
    const attempt = { sending: true };
    item.attempts.set(target, attempt);
    item.status.textContent = '正在发送' + name + '验证码…';
    update();
    try {
      const result = await api('/v1/auth/verification-codes', { method: 'POST', body: { channel, target, flowId } });
      if (signal.aborted) return;
      attempt.until = Date.now() + result.resendAfter * 1000;
      attempt.delivered = true;
      attempt.message = name + '已发送，验证码 ' + Math.ceil(result.expiresIn / 60) + ' 分钟内有效。';
    } catch (error) {
      if (signal.aborted) return;
      if ([429, 502].includes(error.status) && error.retryAfter > 0) attempt.until = Date.now() + error.retryAfter * 1000;
      if (error.code === 'VERIFICATION_COOLDOWN') attempt.message = '发送间隔过短，请稍后重试。';
      else if (error.code === 'VERIFICATION_UNAVAILABLE') attempt.message = name + '发送服务尚未配置，请联系管理员启用后重试。';
      else if (error.code === 'VERIFICATION_DELIVERY_FAILED') attempt.message = name + '服务商尚未确认发送，请稍后重试。';
      else attempt.message = authError(error);
    } finally {
      attempt.sending = false;
      if (!signal.aborted && item.target === target) {
        item.status.textContent = attempt.message;
        update();
      }
    }
  });
  signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  return {
    update,
    setTargets({ phone, email }) {
      for (const item of channels) {
        const target = item.channel === 'sms' ? phone : email;
        if (target !== item.target) item.input.value = '';
        item.target = target;
        item.display.textContent = target;
        item.status.textContent = item.attempts.get(target)?.message || '';
      }
      update();
    },
  };
}
