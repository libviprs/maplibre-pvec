export const PAGES: { path: string; title: string; subject: string; group: string }[];
export function listDocPages(root?: string): string[];
export function generateDocs(root?: string): Map<string, string>;
