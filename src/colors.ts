// The colors a server can get with "color" in sftp.json, for example "red" for production.
// Named colors only: VS Code colors tree items, tabs and the status bar through theme colors, which
// every theme defines (charts.*), so the color stays readable in light and dark themes alike.
// This module does not import vscode, so config.ts and tests can use it on their own.
import { applyEdits, FormattingOptions, modify } from 'jsonc-parser';

export const SERVER_COLORS = {
  red: { label: 'Red', emoji: '🔴', theme: 'charts.red', statusBackground: 'statusBarItem.errorBackground' },
  orange: { label: 'Orange', emoji: '🟠', theme: 'charts.orange', statusBackground: 'statusBarItem.warningBackground' },
  yellow: { label: 'Yellow', emoji: '🟡', theme: 'charts.yellow', statusBackground: 'statusBarItem.warningBackground' },
  green: { label: 'Green', emoji: '🟢', theme: 'charts.green', statusBackground: undefined },
  blue: { label: 'Blue', emoji: '🔵', theme: 'charts.blue', statusBackground: undefined },
  purple: { label: 'Purple', emoji: '🟣', theme: 'charts.purple', statusBackground: undefined },
} as const;

export type ServerColor = keyof typeof SERVER_COLORS;

export function isServerColor(value: unknown): value is ServerColor {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(SERVER_COLORS, value);
}

/** Indentation and line endings as used in the file, so an edit blends in. */
function formattingOf(text: string): FormattingOptions {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const indent = /\n([ \t]+)\S/.exec(text)?.[1] ?? '  ';
  return indent.startsWith('\t') ? { insertSpaces: false, tabSize: 4, eol } : { insertSpaces: true, tabSize: indent.length, eol };
}

/** sftp.json text with "color" set at the server's place (its entry or profile), or removed for undefined. */
export function withColor(text: string, jsonPath: (string | number)[], color: ServerColor | undefined): string {
  return applyEdits(text, modify(text, [...jsonPath, 'color'], color, { formattingOptions: formattingOf(text) }));
}
