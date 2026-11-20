// Shows which server a remote file belongs to: files and editor tabs of a server with a "color" get that color,
// and the status bar names the server of the active editor, on a red or yellow background for those colors.
// "Set Color..." on a server writes "color" to sftp.json, so the whole team sees production in red.
import * as vscode from 'vscode';
import * as fs from 'fs';
import { SERVER_COLORS, ServerColor, withColor } from './colors';
import { ServerConfig, ServerRegistry } from './config';
import { SCHEME } from './fsProvider';

export class ServerColors implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.emitter.event;
  private readonly status: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly registry: ServerRegistry) {
    this.status = vscode.window.createStatusBarItem('sftpRemoteEditor.server', vscode.StatusBarAlignment.Left, 100);
    this.status.name = 'SFTP Remote Editor: Server';
    this.status.command = 'sftpRemoteEditor.servers.focus';
    this.disposables.push(
      this.status,
      vscode.window.registerFileDecorationProvider(this),
      registry.onDidChange(() => {
        this.emitter.fire(undefined);
        void this.updateStatus();
      }),
      vscode.window.onDidChangeActiveTextEditor(() => void this.updateStatus())
    );
    void this.updateStatus();
  }

  async provideFileDecoration(uri: vscode.Uri): Promise<vscode.FileDecoration | undefined> {
    if (uri.scheme !== SCHEME) return undefined;
    const server = await this.registry.get(uri.authority);
    if (!server?.color) return undefined;
    return new vscode.FileDecoration(undefined, `On ${server.label}`, new vscode.ThemeColor(SERVER_COLORS[server.color].theme));
  }

  private async updateStatus(): Promise<void> {
    const uri = vscode.window.activeTextEditor?.document.uri;
    const server = uri?.scheme === SCHEME ? await this.registry.get(uri.authority) : undefined;
    if (!server) {
      this.status.hide();
      return;
    }
    const color = server.color ? SERVER_COLORS[server.color] : undefined;
    this.status.text = `$(server) ${server.label}`;
    this.status.tooltip = new vscode.MarkdownString(
      `Editing on **${server.label}**\n\n${server.detail}:\`${server.remotePath}\`\n\nSaving writes straight to this server.`
    );
    // The status bar only allows its own error and warning backgrounds; other colors color the text.
    this.status.backgroundColor = color?.statusBackground ? new vscode.ThemeColor(color.statusBackground) : undefined;
    this.status.color = color && !color.statusBackground ? new vscode.ThemeColor(color.theme) : undefined;
    this.status.show();
  }

  async pickColor(server: ServerConfig): Promise<void> {
    type Item = vscode.QuickPickItem & { color: ServerColor | undefined };
    const items: Item[] = (Object.keys(SERVER_COLORS) as ServerColor[]).map((c) => ({
      label: `${SERVER_COLORS[c].emoji}  ${SERVER_COLORS[c].label}`,
      description: c === server.color ? 'current' : c === 'red' ? 'for example for production' : undefined,
      color: c,
    }));
    items.push({ label: '$(circle-slash)  No color', description: server.color ? undefined : 'current', color: undefined });
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: `Color for ${server.label}, shown in the panel, on its editor tabs and in the status bar`,
    });
    if (!picked || picked.color === server.color) return;

    const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === server.configPath);
    if (open?.isDirty) throw new Error(`Save ${vscode.workspace.asRelativePath(server.configPath)} first; it has unsaved changes.`);
    const text = await fs.promises.readFile(server.configPath, 'utf8');
    await fs.promises.writeFile(server.configPath, withColor(text, server.jsonPath, picked.color), 'utf8');
    await this.registry.reload();
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.emitter.dispose();
  }
}
