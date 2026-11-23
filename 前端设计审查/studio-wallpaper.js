const databaseName = 'fai.studio.wallpaper';
const storeName = 'preferences';
const wallpaperKey = 'active';
const acceptedTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const maxBytes = 20 * 1024 * 1024;

async function wallpaperTransaction(mode, action) {
  const database = await new Promise((resolve, reject) => {
    const open = indexedDB.open(databaseName, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(storeName);
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });

  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, mode);
      const request = action(transaction.objectStore(storeName));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error ?? request.error);
    });
  } finally {
    database.close();
  }
}

async function validateWallpaper(file) {
  if (!acceptedTypes.has(file.type)) return '请选择 JPG、PNG 或 WebP 图片。';
  if (file.size > maxBytes) return '图片不能超过 20 MB。';

  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return null;
  } catch {
    return '无法读取这张图片，请换一张。';
  } finally {
    URL.revokeObjectURL(url);
  }
}

function bindWallpaper() {
  const settings = document.querySelector('#themeDialog .ui-dialog-body');
  const displayMode = settings?.querySelector('.appearanceModes');
  if (!displayMode) return;

  const panel = document.createElement('fieldset');
  panel.className = 'studio-wallpaper-settings';
  panel.innerHTML = '<legend>壁纸</legend><div class="studio-wallpaper-row">' +
    '<div class="studio-wallpaper-preview" aria-hidden="true"></div>' +
    '<div class="studio-wallpaper-options"><div class="studio-wallpaper-actions">' +
    '<button type="button" class="smallbtn" data-wallpaper-choose>选择图片</button>' +
    '<button type="button" class="smallbtn" data-wallpaper-reset disabled>恢复默认</button>' +
    '<input type="file" accept="image/jpeg,image/png,image/webp" hidden></div>' +
    '<p class="live-muted" role="status">正在读取壁纸…</p></div></div>';
  displayMode.after(panel);

  const input = panel.querySelector('input');
  const choose = panel.querySelector('[data-wallpaper-choose]');
  const reset = panel.querySelector('[data-wallpaper-reset]');
  const status = panel.querySelector('[role="status"]');
  const root = document.documentElement;
  const updates = typeof BroadcastChannel === 'function' ? new BroadcastChannel(databaseName) : null;
  let activeUrl;
  let busy = false;
  let queue = Promise.resolve();

  function syncControls() {
    choose.disabled = busy;
    reset.disabled = busy || !activeUrl;
  }

  function show(file) {
    const previous = activeUrl;
    activeUrl = file instanceof Blob ? URL.createObjectURL(file) : undefined;
    if (activeUrl) root.style.setProperty('--studio-wallpaper-image', 'url("' + activeUrl + '")');
    else root.style.removeProperty('--studio-wallpaper-image');
    if (previous) URL.revokeObjectURL(previous);
    status.textContent = activeUrl ? '已保存到本机' + (file.name ? ' · ' + file.name : '') : '正在使用默认壁纸';
    syncControls();
  }

  function load() {
    queue = queue.then(async () => {
      try {
        show(await wallpaperTransaction('readonly', store => store.get(wallpaperKey)));
      } catch {
        status.textContent = '无法读取本机壁纸。';
      }
    });
  }

  function save(file) {
    if (busy) return;
    busy = true;
    syncControls();
    status.textContent = file ? '正在保存壁纸…' : '正在恢复默认壁纸…';
    queue = queue.then(async () => {
      try {
        if (file) {
          const error = await validateWallpaper(file);
          if (error) {
            status.textContent = error;
            return;
          }
          await wallpaperTransaction('readwrite', store => store.put(file, wallpaperKey));
        } else {
          await wallpaperTransaction('readwrite', store => store.delete(wallpaperKey));
        }
        show(file);
        updates?.postMessage('changed');
      } catch {
        status.textContent = file ? '壁纸未保存，请重试。' : '无法恢复默认壁纸，请重试。';
      } finally {
        busy = false;
        syncControls();
      }
    });
  }

  choose.onclick = () => input.click();
  input.onchange = () => {
    const file = input.files[0];
    input.value = '';
    if (file) save(file);
  };
  reset.onclick = () => save(null);
  updates?.addEventListener('message', load);
  window.addEventListener('pageshow', event => { if (event.persisted) load(); });
  load();
}

if (document.getElementById('themeDialog')) bindWallpaper();
else document.addEventListener('DOMContentLoaded', bindWallpaper, { once: true });
