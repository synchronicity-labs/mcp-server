// Shared HTML contains no credentials or generation data; the host supplies the result.
export const GENERATION_STATUS_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light dark; font: 14px/1.5 system-ui, sans-serif; }
  body { margin: 0; color: var(--color-text-primary, light-dark(#141414, #f4f4f4)); background: var(--color-background-primary, light-dark(#fff, #171717)); }
  main { padding: 20px; display: grid; gap: 12px; }
  h1, p { margin: 0; }
  h1 { font-size: 16px; font-weight: 600; }
  .muted { color: var(--color-text-secondary, light-dark(#666, #aaa)); }
  #identity { overflow-wrap: anywhere; font-size: 12px; }
  nav { display: flex; flex-wrap: wrap; align-items: center; gap: 16px; }
  button { font: inherit; border: 1px solid light-dark(#ddd, #555); border-radius: 8px; padding: 8px 14px; background: light-dark(#141414, #f4f4f4); color: light-dark(#fff, #141414); cursor: pointer; }
  button:disabled { opacity: .6; cursor: wait; }
  a { color: inherit; text-underline-offset: 3px; }
  :focus-visible { outline: 2px solid Highlight; outline-offset: 3px; }
  [hidden] { display: none !important; }
</style></head><body>
<main aria-label="Sync generation status">
  <h1>Generation status</h1>
  <p id="status" role="status">Waiting for submission…</p>
  <p id="estimate" class="muted">Estimated time remaining is unavailable.</p>
  <p id="error" role="alert" hidden></p>
  <p id="identity" class="muted"></p>
  <nav aria-label="Generation actions">
    <button id="check" type="button" disabled>Check status</button>
    <a id="studio" href="https://sync.so/projects" target="_blank" rel="noopener noreferrer">Open in Sync</a>
    <a id="result" target="_blank" rel="noopener noreferrer" hidden>View video</a>
  </nav>
</main>
<script>
(() => {
  const status = document.getElementById('status');
  const estimate = document.getElementById('estimate');
  const error = document.getElementById('error');
  const identity = document.getElementById('identity');
  const checkButton = document.getElementById('check');
  const studio = document.getElementById('studio');
  const resultLink = document.getElementById('result');
  const terminal = new Set(['COMPLETED', 'FAILED', 'REJECTED', 'CANCELED', 'CANCELLED']);
  const pending = new Map();
  let nextId = 0, generationId, generation, clock, timer;
  let busy = false, connecting, ready = false, verified = false;

  function request(method, params, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timeoutId = setTimeout(() => {
        pending.delete(id);
        reject(new Error('Sync did not respond. Check status again.'));
      }, timeout);
      pending.set(id, { resolve, reject, timeoutId });
      window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*');
    });
  }
  function payload(value) {
    if (!value || typeof value !== 'object') throw new Error('Sync returned an invalid status.');
    let data = value.structuredContent;
    if (!data && Array.isArray(value.content)) {
      const text = value.content.find(item => item.type === 'text');
      if (text) { try { data = JSON.parse(text.text); } catch {} }
    }
    data = data || value;
    if (value.isError || data.error && !data.id) throw new Error(typeof data.error?.message === 'string' ? data.error.message : 'Unable to check this generation.');
    return data;
  }
  function renderEstimate() {
    if (!generation || !error.hidden) return;
    estimate.hidden = terminal.has(generation.status);
    if (estimate.hidden) return;
    if (!clock) { estimate.textContent = 'Estimated time remaining is unavailable.'; return; }
    const now = clock.serverNow + performance.now() - clock.receivedAt;
    const remaining = clock.finish - now;
    estimate.textContent = now >= clock.delayed
      ? 'This is taking longer than usual. Please wait a little longer.'
      : remaining <= 0
        ? 'This is taking a little longer than estimated. Please wait a little longer.'
        : remaining <= 60000
          ? 'Estimated time remaining: less than a minute'
          : 'Estimated time remaining: about ' + Math.ceil(remaining / 60000) + ' minutes';
  }
  function render() {
    checkButton.disabled = !generationId || busy;
    checkButton.textContent = busy ? 'Checking status…' : 'Check status';
    if (!generation) return;
    const labels = { PENDING: 'Queued', PROCESSING: 'Processing', COMPLETED: 'Completed', FAILED: 'Failed', REJECTED: 'Rejected', CANCELED: 'Canceled', CANCELLED: 'Canceled' };
    status.textContent = labels[generation.status] || 'Processing';
    identity.textContent = 'Generation ID: ' + generationId;
    if (typeof generation.projectId === 'string' && generation.projectId) studio.href = 'https://sync.so/projects/' + encodeURIComponent(generation.projectId) + '/studio?notification=generation&generationId=' + encodeURIComponent(generationId);
    resultLink.hidden = true;
    if (verified && error.hidden && generation.status === 'COMPLETED' && typeof generation.outputUrl === 'string') {
      try {
        if (new URL(generation.outputUrl).protocol === 'https:') {
          resultLink.href = generation.outputUrl;
          resultLink.hidden = false;
        }
      } catch {}
    }
    renderEstimate();
  }
  function apply(data, fresh) {
    if (typeof data.id !== 'string' || !data.id || typeof data.status !== 'string' || generationId && data.id !== generationId) throw new Error('Sync returned an invalid status for this generation.');
    generationId = data.id;
    generation = data;
    verified = fresh;
    const value = data.generationEstimate;
    const serverNow = Date.parse(value?.serverTime), finish = Date.parse(value?.estimatedFinishAt), delayed = Date.parse(value?.delayedAt);
    clock = Number.isFinite(serverNow) && Number.isFinite(finish) ? { serverNow, finish, delayed, receivedAt: performance.now() } : undefined;
    error.hidden = true;
    if (['FAILED', 'REJECTED'].includes(data.status)) {
      error.textContent = typeof data.error === 'string' ? data.error : 'This generation could not be completed. Open it in Sync for details.';
      error.hidden = false;
      estimate.hidden = true;
    }
    render();
  }
  function setTheme(context) {
    if (context?.theme === 'dark' || context?.theme === 'light') document.documentElement.style.colorScheme = context.theme;
  }
  function notifySize() {
    if (!ready) return;
    const height = Math.ceil(document.documentElement.getBoundingClientRect().height);
    if (window.openai?.notifyIntrinsicHeight) window.openai.notifyIntrinsicHeight(height);
    else window.parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { height } }, '*');
  }
  function connect() {
    if (!connecting) connecting = (async () => {
      if (!window.openai?.callTool) {
        const initialized = await request('ui/initialize', { protocolVersion: '2026-01-26', appInfo: { name: 'Sync generation status', version: '1.0.0' }, appCapabilities: {} }, 4000);
        setTheme(initialized.hostContext);
        window.parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/initialized' }, '*');
      }
      ready = true;
      notifySize();
    })().catch(cause => { connecting = undefined; throw cause; });
    return connecting;
  }
  function showError(cause) {
    error.textContent = cause?.message || 'Unable to check this generation. Try again.';
    error.hidden = false;
    status.textContent = 'Status unavailable';
    estimate.hidden = true;
    resultLink.hidden = true;
  }
  async function readStatus() {
    if (!window.openai?.callTool) return request('tools/call', { name: 'generate_get-generation', arguments: { id: generationId } });
    let timeout;
    try {
      return await Promise.race([
        window.openai.callTool('generate_get-generation', { id: generationId }),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Sync did not respond. Check status again.')), 15000); }),
      ]);
    } finally { clearTimeout(timeout); }
  }
  async function check() {
    if (!generationId || busy) return;
    clearTimeout(timer);
    busy = true;
    render();
    try {
      await connect();
      const response = await readStatus();
      apply(payload(response), true);
      if (!terminal.has(generation.status) && !document.hidden) timer = setTimeout(check, 10000);
    } catch (cause) { showError(cause); }
    finally {
      busy = false;
      checkButton.disabled = !generationId;
      checkButton.textContent = 'Check status';
    }
  }
  function receive(value) {
    // Pin the creating tool's job; unrelated notifications cannot select another one.
    if (generationId) return;
    try {
      const knownId = value?.structuredContent?.error?.generationId ?? value?.error?.generationId;
      apply(typeof knownId === 'string' && knownId ? { id: knownId, status: 'PENDING' } : payload(value), false);
      void check();
    }
    catch (cause) { showError(cause); }
  }
  window.addEventListener('message', event => {
    if (event.source !== window.parent || event.data?.jsonrpc !== '2.0') return;
    const message = event.data;
    if (pending.has(message.id)) {
      const operation = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(operation.timeoutId);
      if (message.error) operation.reject(new Error(message.error.message || 'Sync request failed.'));
      else operation.resolve(message.result);
    } else if (message.method === 'ui/notifications/tool-result') receive(message.params);
    else if (message.method === 'ui/notifications/host-context-changed') setTheme(message.params);
  });
  window.addEventListener('openai:set_globals', event => {
    setTheme(event.detail?.globals);
    if (event.detail?.globals?.toolOutput) receive(event.detail.globals.toolOutput);
  });
  document.addEventListener('visibilitychange', () => {
    clearTimeout(timer);
    if (!document.hidden && generationId && !terminal.has(generation?.status)) void check();
  });
  checkButton.addEventListener('click', check);
  new ResizeObserver(notifySize).observe(document.body);
  setInterval(renderEstimate, 1000);
  setTheme(window.openai);
  void connect().catch(showError);
  if (window.openai?.toolOutput) receive(window.openai.toolOutput);
})();
</script></body></html>`;
