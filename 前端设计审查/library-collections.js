export const collections = [
  { id:'commerce', label:'商品运营', icon:'products' },
  { id:'content', label:'内容创作', icon:'copywriting' },
  { id:'dialogue', label:'对话问答', icon:'service' },
  { id:'teamwork', label:'团队协作', icon:'members' },
];

const actions = { 'sku-review':'commerce', 'copy-review':'content', 'model-chat':'dialogue' };
const actionLabels = { 'sku-review':'商品 SKU 核对', 'copy-review':'文案措辞检查', 'model-chat':'模型对话' };

export function directoryRecords(entries) {
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const parents = new Map();
  for (const entry of entries) {
    for (const id of entry.relatedIds) {
      if (!parents.has(id)) parents.set(id, []);
      parents.get(id).push(entry);
    }
  }
  const children = entry => entry.relatedIds.map(id => byId.get(id)).filter(Boolean);
  return entries.map(entry => {
    const related = children(entry);
    const linkedFrom = parents.get(entry.id) ?? [];
    const skills = entry.kind === 'skill' ? [entry] : entry.kind === 'team' ? related.flatMap(children) : related;
    const groups = new Set(skills.map(skill => actions[skill.skillAction ?? 'model-chat']).filter(Boolean));
    const teamWork = entry.kind === 'team' || linkedFrom.some(parent =>
      parent.kind === 'team' || (parents.get(parent.id) ?? []).some(group => group.kind === 'team'));
    if (teamWork) groups.add('teamwork');
    const tags = entry.kind === 'skill' ? [actionLabels[entry.skillAction ?? 'model-chat']] : related.map(item => item.name);
    const detail = entry.kind === 'skill' ? linkedFrom.length + ' 位专家挂载'
      : entry.kind === 'team' ? related.length + ' 位成员专家' : related.length + ' 项挂载技能';
    return { ...entry, groups, tags, detail, connections:related.length + linkedFrom.length,
      route:(entry.kind === 'skill' ? 'skills/' : 'library/experts/') + encodeURIComponent(entry.id) };
  });
}

export function matchingRecords(records, { kind, group, query, sort }) {
  const needle = query.trim().toLocaleLowerCase();
  const matched = records.filter(entry =>
    (kind === 'custom' ? entry.kind === 'skill' && !entry.builtin : entry.kind === kind) &&
    (group === 'all' || (group === 'custom' ? !entry.builtin : entry.groups.has(group))) &&
    (!needle || [entry.name, entry.description, ...entry.tags].join(' ').toLocaleLowerCase().includes(needle)));
  if (sort === 'recent') return matched.sort((a,b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  if (sort === 'links') return matched.sort((a,b) => b.connections - a.connections);
  return matched;
}
