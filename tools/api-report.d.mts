export const ENTRIES: Record<string, string>;
export function buildApiReport(root: string): {
  entries: Record<string, { values: string[]; types: string[] }>;
  text: string;
};
