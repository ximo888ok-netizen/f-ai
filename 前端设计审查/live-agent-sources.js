const path = encodeURIComponent;
const library = new Set(['expert', 'team', 'skill']);
const documents = baseId => '/v1/knowledge/bases/' + path(baseId) + '/documents';
const feishu = '/v1/channels/feishu';
const cloud = '/v1/cloud-assets';
const ref = (kind, row) => ({kind, id:row.id, name:row.name});

export function addReference(references, entry) {
  if (references.some(r => r.kind === entry.kind && r.id === entry.id)) return references;
  const current = entry.kind === 'project' ? references.filter(r => r.kind !== 'project') : references;
  if (current.length >= 8) throw new Error('最多可引用 8 项资料。');
  if (library.has(entry.kind) && current.filter(r => library.has(r.kind)).length >= 4) {
    throw new Error('专家、专家团和技能合计最多可选 4 项。');
  }
  return [...current, entry];
}

async function connectorList(ctx) {
  const [storage, inbox] = await Promise.all([
    ctx.api(cloud + '/status'), ctx.manager ? ctx.api(feishu + '?limit=1') : null,
  ]);
  return [
    ...(storage.available ? [{kind:'connector', id:'webdav', name:'WebDAV 网盘', detail:'引用最近备份的文件清单'}] : []),
    ...(inbox?.available ? [{kind:'connector', id:'feishu', name:'飞书消息', detail:'引用最近 3 条收到的消息'}] : []),
  ];
}

export async function sourceChoices(ctx, category, baseId) {
  switch (category) {
    case 'files': return (await ctx.all('/v1/knowledge/bases')).map(row => ref('base',row));
    case 'documents': return (await ctx.all(documents(baseId))).map(row => ({...ref('document',row), baseId}));
    case 'experts':
    case 'skills': {
      const entries = await ctx.all('/v1/library?enabled=true');
      return entries.filter(e => e.enabled && (category === 'skills' ? e.kind === 'skill' : ['expert','team'].includes(e.kind)))
        .map(e => ({...ref(e.kind,e), detail:{expert:'专家',team:'专家团',skill:'技能'}[e.kind]}));
    }
    case 'connections': return connectorList(ctx);
    case 'context': {
      const [projects, products] = await Promise.all([ctx.all('/v1/projects'), ctx.all('/v1/studio/products')]);
      return [...projects.map(p => ({...ref('project',p), detail:'项目'})),
        ...products.map(p => ({...ref('product',p), detail:p.sku}))];
    }
    default: return [];
  }
}

async function connectorContext(ctx, id) {
  if (id === 'webdav') {
    if (!(await ctx.api(cloud + '/status')).available) throw new Error('当前工作区无法访问此网盘。');
    const {items} = await ctx.api(cloud + '?limit=5');
    return 'WebDAV 最近备份的文件清单：' + (items.map(r => r.name + ' · ' + r.mediaType + ' · ' + r.state).join('\n') || '暂无备份');
  }
  if (id === 'feishu' && ctx.manager) {
    const result = await ctx.api(feishu + '?limit=3');
    if (result.available) return '飞书最近收到的消息：' + (result.items.map(m => m.createdAt + ' · ' + m.content).join('\n') || '暂无消息');
  }
  throw new Error('当前账号无法访问此连接器。');
}

export async function resolveReferences(ctx, references, image) {
  const guidanceIds = references.filter(r => library.has(r.kind)).map(r => r.id);
  const entries = references.filter(r => !library.has(r.kind));
  if (image) entries.push({kind:'image', id:image.id});
  const products = entries.some(r => r.kind === 'product') ? ctx.all('/v1/studio/products') : null;
  const excerpts = await Promise.all(entries.map(async r => {
    switch (r.kind) {
      case 'document': {
        const doc = await ctx.api(documents(r.baseId) + '/' + path(r.id));
        return '知识库文件《' + doc.name + '》\n' + doc.content;
      }
      case 'text': return '本地文件《' + r.name + '》\n' + r.content;
      case 'project': return '所属项目：' + (await ctx.api('/v1/projects/' + path(r.id))).name;
      case 'product': {
        const product = (await products).find(p => p.id === r.id);
        if (!product) throw new Error('当前工作区无法访问所引用的商品。');
        return '商品：' + product.name + ' · SKU ' + product.sku + '\n' + (product.description ?? '');
      }
      case 'connector': return connectorContext(ctx, r.id);
      case 'image': {
        const a = await ctx.api('/v1/assets/' + path(r.id));
        return '主图文件信息：' + a.name + ' · ' + a.mediaType + ' · 来源：' + a.source + ' · 用途：' + a.purpose;
      }
      default: throw new Error('请移除无法识别的引用。');
    }
  }));
  return {guidanceIds, excerpts, projectId:entries.find(r => r.kind === 'project')?.id};
}
