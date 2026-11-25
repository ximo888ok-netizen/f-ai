import { bindPopover } from './live-popover.js';
import { describeError } from './studio-errors.js';

export function bindAccountMenu(onError) {
  const trigger = document.querySelector('#profile');
  const panel = document.querySelector('#account-menu');
  const name = panel.querySelector('[data-account-name]');
  const scope = panel.querySelector('[data-account-scope]');
  const balance = panel.querySelector('[data-account-balance]');
  const logout = panel.querySelector('[data-account-logout]');
  let current;

  bindPopover(trigger, panel);
  panel.addEventListener('toggle', async event => {
    const ctx = current;
    if (event.newState !== 'open' || !ctx?.account) return;
    balance.textContent = '正在读取余额…';
    try {
      const wallet = await ctx.api('/v1/credits/wallet');
      if (current === ctx) balance.textContent = wallet.available + ' 可用积分';
    } catch (error) {
      if (current === ctx) balance.textContent = describeError(error);
    }
  });
  panel.addEventListener('click', event => {
    if (event.target.closest('a')) panel.hidePopover();
  });
  panel.querySelector('[data-account-appearance]').addEventListener('click', () => {
    panel.hidePopover();
    document.querySelector('[data-theme-open]').click();
  });
  logout.addEventListener('click', async () => {
    if (!current?.account) return;
    logout.disabled = true;
    try {
      await current.logout();
    } catch (error) {
      onError(error);
    } finally {
      logout.disabled = false;
    }
  });

  return (ctx, role) => {
    current = ctx;
    if (panel.matches(':popover-open')) panel.hidePopover();
    trigger.hidden = !ctx.account;
    trigger.dataset.initial = Array.from(ctx.account?.displayName ?? '')[0] ?? '';
    name.textContent = ctx.account?.displayName ?? '';
    trigger.querySelector('.account-avatar').textContent = trigger.dataset.initial;
    trigger.querySelector('.account-name').textContent = ctx.workspace?.name ?? '';
    trigger.querySelector('.account-sub').textContent = [name.textContent, role].filter(Boolean).join(' · ');
    scope.textContent = ctx.workspace ? ctx.workspace.name + ' · ' + role : '';
    balance.textContent = '';
  };
}
