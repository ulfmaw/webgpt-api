import { Fault } from '../errors.js';

// The version picker exposes intelligence presets, not one option per slug.
// Different effort presets can share a slug; Instant/Pro can change the slug.
export function chatPickerCatalog(body) {
  if (!Array.isArray(body?.versions) || !Array.isArray(body?.models)) {
    throw new Fault(502, 'model_discovery_failed', 'The Chat model picker was not provided. No generic catalog was substituted.');
  }
  const models = new Map(body.models.filter(m => m && typeof m.slug === 'string').map(m => [m.slug, m]));
  const seen = new Set();
  const selected = [];
  for (const version of body.versions) {
    if (version?.enabled !== true || typeof version.id !== 'string' || !/^[a-zA-Z0-9_.-]{1,40}$/.test(version.id) || !Array.isArray(version.intelligence_presets)) continue;
    for (const preset of version.intelligence_presets) {
    if (preset?.preset_type !== 'available' || !['string','number'].includes(typeof preset.id)) continue;
    const id = preset.model_slug;
    const model = models.get(id);
    const key = `${version.id}:${preset.id}`;
    if (!model || model.is_work_mode_model !== false || model.work_mode === true || !id || id.length > 160 || key.length > 160 || seen.has(key)) continue;
    const effort = preset.thinking_effort;
    if (effort !== undefined && (typeof effort !== 'string' || !model.thinking_efforts?.some(e=>e.thinking_effort===effort))) continue;
    seen.add(key);
    const group = typeof version.display_text_for_intelligence === 'string' ? version.display_text_for_intelligence.slice(0,80) : version.id;
    const title = typeof preset.title === 'string' ? preset.title.slice(0,80) : String(preset.id);
    selected.push({ slug: id, title: `${group} · ${title}`, option_key: key, group, preset: title,
      ...(effort !== undefined ? { thinking_effort: effort } : {}), is_work_mode_model: false });
    }
  }
  if (!selected.length) throw new Fault(502, 'model_discovery_failed', 'The Chat picker did not provide selectable Chat models.');
  return { models: selected, default_model_slug: body.default_model_slug };
}

export async function discoverChatCatalog(connection, { timeout = 20_000 } = {}) {
  const ready = Promise.withResolvers();
  const requests = new Map();
  const navigation = Promise.withResolvers();
  const disposers = [];
  let timer;
  // Attach before navigation: only consume the Chat page's own catalog request.
  disposers.push(connection.on('Network.responseReceived', event => {
    let url;
    try { url = new URL(event.response.url); } catch { return; }
    if (url.origin !== 'https://chatgpt.com' || url.pathname !== '/backend-api/models') return;
    requests.set(event.requestId, { loaderId: event.loaderId, status: event.response.status });
  }));
  disposers.push(connection.on('Network.loadingFinished', event => {
    const request = requests.get(event.requestId);
    if (!request) return;
    requests.delete(event.requestId);
    void navigation.promise.then(async loaderId => {
      if (request.loaderId !== loaderId) return;
      if (request.status !== 200) throw new Fault(503, 'model_discovery_failed', 'The Chat page could not load its model picker.');
      const response = await connection.call('Network.getResponseBody', { requestId: event.requestId });
      const text = response.base64Encoded ? Buffer.from(response.body, 'base64').toString('utf8') : response.body;
      ready.resolve(chatPickerCatalog(JSON.parse(text)));
    }).catch(error => {
      // The authenticated page may still finish a request from its previous
      // navigation. CDP can no longer read that body; wait for the new page.
      if (error instanceof SyntaxError || error instanceof Fault) ready.reject(new Fault(502, 'model_discovery_failed', 'The Chat picker response could not be read.'));
    });
  }));
  // Handle early rejection while navigation is still pending.
  ready.promise.catch(() => {});
  try {
    timer = setTimeout(() => ready.reject(new Fault(503, 'model_discovery_failed', 'Timed out waiting for the Chat page model picker.')), timeout);
    await connection.call('Network.enable', { maxTotalBufferSize: 8 * 1024 * 1024, maxResourceBufferSize: 2 * 1024 * 1024 });
    await connection.call('Network.setCacheDisabled', { cacheDisabled: true });
    const page = await connection.call('Page.navigate', { url: 'https://chatgpt.com/?temporary-chat=true' });
    navigation.resolve(page.loaderId);
    return await ready.promise;
  } finally {
    clearTimeout(timer);
    navigation.resolve(null);
    for (const dispose of disposers) dispose();
    await connection.call('Network.setCacheDisabled', { cacheDisabled: false }).catch(() => {});
  }
}
