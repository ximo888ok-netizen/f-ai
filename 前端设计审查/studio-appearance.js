import { requestStudio } from './studio-session.js';

// Both windows use the same per-member settings endpoint. Serialize writes so the
// last selection wins, even when the user changes colors before the initial read returns.
export function bindStudioAppearance(onError) {
  let active;
  function apply(group, preferences) {
    if (group === 'palette') window.applyStudioTheme(preferences.studioTheme ?? 'glass', preferences.theme, true);
    else window.applyStudioMotion(preferences.studioMotion);
  }

  function save(group, patch) {
    const scope = active;
    if (!scope) return;
    const sequence = ++scope.revision[group];
    scope.queue = scope.queue.then(async () => {
      try {
        const result = await requestStudio('/v1/settings', { ...scope.auth, method: 'PATCH', body: patch });
        scope.saved = result.preferences;
      } catch (error) {
        if (active !== scope) return;
        if (sequence === scope.revision[group]) apply(group, scope.saved);
        onError(error);
      }
    });
  }
  document.addEventListener('studio-theme', event => save('palette', event.detail));
  document.addEventListener('studio-motion', event => save('motion', { studioMotion: event.detail }));

  return (workspaceId, accountId) => {
    if (!accountId || !workspaceId) {
      delete document.documentElement.dataset.workspaceAppearance;
      active = null;
      return;
    }
    if (active?.accountId === accountId && active.auth.workspaceId === workspaceId) return;
    document.documentElement.dataset.workspaceAppearance = workspaceId + '/' + accountId;
    const scope = { accountId, auth: { workspaceId }, revision: { palette: 0, motion: 0 }, saved: {} };
    active = scope;
    scope.queue = requestStudio('/v1/settings', scope.auth).then(({ preferences }) => {
      scope.saved = preferences;
      if (active !== scope) return;
      for (const group of ['palette', 'motion']) {
        if (!scope.revision[group]) apply(group, preferences);
      }
    }).catch(error => { if (active === scope) onError(error); });
  };
}
