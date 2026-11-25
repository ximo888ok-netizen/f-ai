const paths = {
  wallet: '<path d="M3 8V6a2 2 0 0 1 2-2h13v4M5 8h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8h2zm16 4h-6v4h6"/>',
  bell: '<path d="M4 17h16l-2-3V10a6 6 0 1 0-12 0v4zm6 3a2.5 2.5 0 0 0 4 0"/>',
  home: '<path d="m3 10 9-7 9 7v9a2 2 0 0 1-2 2h-4v-7H9v7H5a2 2 0 0 1-2-2z"/>',
  desk: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 10h18M9 10v10"/>',
  capabilities: '<path d="M12 3v6m0 6v6M3 12h6m6 0h6M5.6 5.6l4.2 4.2m4.4 4.4 4.2 4.2m0-12.8-4.2 4.2m-4.4 4.4-4.2 4.2"/>',
  data: '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  tasks: '<rect x="5" y="4.5" width="14" height="16" rx="2"/><rect x="9" y="3" width="6" height="3.5" rx="1"/><path d="M9 11h6m-6 4h4"/>',
  search: '<circle cx="10" cy="10" r="6.5"/><path d="m15 15 5 5"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="8.5" cy="9" r="1.4"/><path d="m4 17 5-5 4 4 4-6 4 6"/>',
  video: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m10 9 5 3-5 3z"/>',
  copywriting: '<path d="m5 15-1 5 5-1L20 8l-4-4zm9-9 4 4"/>',
  products: '<path d="m12 3 8.5 4.7v8.6L12 21l-8.5-4.7V7.7zM4 8l8 4.4L20 8m-8 4.4V21"/>',
  operations: '<path d="M3 20h18M6 17v-5m6 5V6m6 11V9"/>',
  members: '<circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2m0-15a3 3 0 0 1 0 6m3 3a4 4 0 0 1 3 4v2"/>',
  features: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  connections: '<path d="m10 13 4-4m-5 6-1 1a3.5 3.5 0 1 1-5-5l4-4a3.5 3.5 0 0 1 5 0m0 10a3.5 3.5 0 0 0 5 0l4-4a3.5 3.5 0 0 0-5-5l-1 1"/>',
  service: '<path d="M21 13a4 4 0 0 1-4 4H9l-5 4v-5a4 4 0 0 1-1-3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/><path d="M7 9h10m-10 4h6"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  outward: '<path d="M6 18 18 6M7 6h11v11"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
};
export function studioIcon(name) {
  return '<svg class="studio-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + paths[name] + '</svg>';
}
