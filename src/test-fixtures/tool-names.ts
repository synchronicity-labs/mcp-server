import { RENAMED_TOOLS } from '../tool-names.js';

const current = new Set(Object.values(RENAMED_TOOLS));
const legacy = new Set(Object.keys(RENAMED_TOOLS).filter((name) => !current.has(name)));

/** A listing without the app-only entries that keep old names callable by retained widgets. */
export function currentTools<T extends { name: string }>(tools: T[]): T[] {
  return tools.filter((tool) => !legacy.has(tool.name));
}
