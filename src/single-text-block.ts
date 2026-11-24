import type { CallToolResult } from '@modelcontextprotocol/server';

/**
 * Handshake names (lower case) of clients that pass the model only one text block of a
 * tool result. The Gemini app (`gemini`) showed the model only the trailing content
 * notice, not the JSON before it (agent reports, 2026-11-18 and 11-19). Gemini CLI
 * (`gemini-cli-mcp-client`) keeps every block, so it is not listed.
 */
const ONE_TEXT_BLOCK_CLIENTS = new Set(['gemini']);

export function keepsOneTextBlock(clientName?: string): boolean {
  return ONE_TEXT_BLOCK_CLIENTS.has((clientName ?? '').toLowerCase());
}

/**
 * Joins a result's text blocks into one, in order and separated by a blank line, at the
 * position of the first. Other blocks and structuredContent are unchanged.
 */
export function joinTextBlocks(result: CallToolResult): CallToolResult {
  const content = result.content ?? [];
  const texts = content.flatMap((block) => (block.type === 'text' ? [block.text] : []));
  if (texts.length < 2) return result;
  const joined = { type: 'text' as const, text: texts.join('\n\n') };
  type Block = (typeof content)[number];
  let placed = false;
  const next = content.flatMap((block): Block[] => {
    if (block.type !== 'text') return [block];
    if (placed) return [];
    placed = true;
    return [joined];
  });
  return { ...result, content: next };
}
