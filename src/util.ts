import * as vscode from 'vscode';

export const output = vscode.window.createOutputChannel('SFTP Remote Editor');

export function log(line: string): void {
  output.appendLine(`[${new Date().toLocaleTimeString()}] ${line}`);
}

/** The user dismissed a prompt (password, profile, host key); the operation stops quietly. */
export class CancelledError extends Error {
  constructor() {
    super('Cancelled');
  }
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function askSecret(prompt: string): Promise<string> {
  const value = await vscode.window.showInputBox({ prompt, password: true, ignoreFocusOut: true });
  if (value === undefined) throw new CancelledError();
  return value;
}
