export const manifest = Object.freeze({id:'asset-inbox',sdkVersion:1,permissions:['assets.read','notifications.read']});

export async function overview(api) {
  const [assets, notifications] = await Promise.all([api.assets({limit:5}),api.notifications({limit:5})]);
  return {recentAssets:assets.items.map(({id,name})=>({id,name})),unread:notifications.unread};
}
