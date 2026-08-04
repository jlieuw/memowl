/**
 * Chat titles, folder names and paths are read from disk, so they must be
 * neutralised before being interpolated into a `MarkdownString` tooltip.
 */
export function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+\-.!<>|]/g, '\\$&');
}
