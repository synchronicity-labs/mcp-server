// The page side of the card browser tests: an iframe host that speaks the MCP Apps
// postMessage bridge, the ChatGPT `window.openai` bridge, or both.

/**
 * Runs in the browser. Loads a card resource into the page's iframe under the resource's
 * own media policy and answers its host requests through `window.callSync` and
 * `window.canOpenSyncLink`, which the test exposes.
 */
export const mountCard = ({ html, toolResult, hostBridge, fontSources }) => {
  let srcdoc = html.replace(
    '<head>',
    `<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src ${fontSources.join(' ')}; img-src ${fontSources.join(' ')}; media-src ${fontSources.join(' ')}">`,
  );
  const iframe = document.querySelector('iframe');
  window.standardInitializes = 0;
  window.standardInitialized = false;
  const handleMessage = async (event) => {
    if (event.source !== iframe.contentWindow) return;
    const message = event.data;
    if (message.method === 'ui/notifications/initialized') {
      window.standardInitialized = true;
      return;
    }
    if (message.method === 'ui/notifications/size-changed') {
      iframe.style.height = `${message.params.height}px`;
      return;
    }
    if (message.id === undefined) return;
    if (message.method === 'ui/initialize') {
      window.standardInitializes += 1;
      if (hostBridge.startsWith('legacy')) return;
      // Deliver immediately, including before initialization has finished.
      event.source.postMessage(
        { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: toolResult },
        '*',
      );
      event.source.postMessage(
        {
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: message.params.protocolVersion,
            hostInfo: { name: 'fixture', version: '1' },
            hostCapabilities: { serverTools: {} },
            hostContext: { theme: 'dark' },
          },
        },
        '*',
      );
    } else if (message.method === 'ui/open-link') {
      if (!(await window.canOpenSyncLink())) {
        event.source.postMessage(
          {
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32000, message: 'Fixture host refused navigation' },
          },
          '*',
        );
        return;
      }
      window.open(message.params.url, '_blank', 'noopener,noreferrer');
      event.source.postMessage({ jsonrpc: '2.0', id: message.id, result: {} }, '*');
    } else if (message.method === 'tools/call') {
      const result = await window.callSync(message.params);
      event.source.postMessage({ jsonrpc: '2.0', id: message.id, result }, '*');
    }
  };
  window.addEventListener('message', (event) => {
    void handleMessage(event);
  });
  if (hostBridge.startsWith('legacy') || hostBridge === 'hybrid')
    srcdoc = srcdoc.replace(
      '<script>',
      '<script>window.openai = { theme: "light", toolOutput: ' +
        JSON.stringify(toolResult.structuredContent ?? toolResult) +
        ', callTool: (name, args) => window.parent.callSync({name, arguments: args}), openExternal: async options => { if (!await window.parent.canOpenSyncLink()) throw new Error("Fixture host refused navigation"); if (options.redirectUrl !== false) throw new Error("Signed links must not be rewritten"); window.parent.open(options.href, "_blank", "noopener,noreferrer"); }, notifyIntrinsicHeight: height => { window.frameElement.style.height = height + "px"; } };</script><script>',
    );
  iframe.srcdoc = srcdoc;
};
