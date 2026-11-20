// The "Servers" view: one node per server from sftp.json, with the directories and files below its
// remotePath. Directories are listed when they are expanded; clicking a file opens it from the server.
import * as vscode from 'vscode';
import * as path from 'path';
import { ConfigProblem, ServerConfig, ServerRegistry } from './config';
import { ConnectionManager } from './connections';
import { SERVER_COLORS } from './colors';
import { remoteUri } from './fsProvider';
import { RemoteEntry } from './remote';
import { CancelledError, errorMessage, log } from './util';

export type TreeNode =
  | { kind: 'server'; server: ServerConfig }
  | { kind: 'entry'; server: ServerConfig; path: string; entry: RemoteEntry }
  | { kind: 'problem'; problem: ConfigProblem }
  | { kind: 'message'; key: string; text: string; error: boolean };

/** Remote directory a node stands for: the server's remotePath, a directory itself, or a file's parent. */
export function directoryOf(node: TreeNode): string | undefined {
  if (node.kind === 'server') return node.server.remotePath;
  if (node.kind === 'entry') return node.entry.type === 'dir' ? node.path : path.posix.dirname(node.path);
  return undefined;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export class ServersTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  /** Server and directory nodes from the last listing, by "<server id>:<path>", so a single directory can be refreshed. */
  private readonly dirNodes = new Map<string, TreeNode>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly registry: ServerRegistry,
    private readonly connections: ConnectionManager
  ) {
    this.disposables.push(registry.onDidChange(() => this.refresh()));
  }

  refresh(node?: TreeNode): void {
    this.emitter.fire(node);
  }

  /** Refreshes the listing of one remote directory, or the whole view when it is not shown. */
  refreshDirectory(server: ServerConfig, remoteDir: string): void {
    this.emitter.fire(this.dirNodes.get(`${server.id}:${remoteDir}`));
  }

  async getChildren(node?: TreeNode): Promise<TreeNode[]> {
    if (!node) {
      this.dirNodes.clear();
      const servers = await this.registry.all();
      const nodes: TreeNode[] = servers.map((server) => ({ kind: 'server', server }));
      servers.forEach((s, i) => this.dirNodes.set(`${s.id}:${s.remotePath}`, nodes[i]));
      for (const problem of await this.registry.problems()) nodes.push({ kind: 'problem', problem });
      return nodes;
    }
    const dir = node.kind === 'server' ? node.server.remotePath : node.kind === 'entry' ? node.path : undefined;
    if (!dir || (node.kind !== 'server' && node.kind !== 'entry')) return [];
    const server = node.server;

    try {
      const entries = await this.connections.run(server, (remote) => remote.list(dir));
      entries.sort((a, b) => {
        const ad = a.type === 'dir' ? 0 : 1;
        const bd = b.type === 'dir' ? 0 : 1;
        return ad - bd || collator.compare(a.name, b.name);
      });
      const children: TreeNode[] = entries.map((entry) => ({
        kind: 'entry',
        server,
        path: path.posix.join(dir, entry.name),
        entry,
      }));
      for (const child of children) {
        if (child.kind === 'entry' && child.entry.type === 'dir') this.dirNodes.set(`${server.id}:${child.path}`, child);
      }
      if (!children.length) return [{ kind: 'message', key: `${server.id}:${dir}:empty`, text: 'Empty folder', error: false }];
      return children;
    } catch (e) {
      if (e instanceof CancelledError) {
        return [{ kind: 'message', key: `${server.id}:${dir}:cancelled`, text: 'Not connected. Use Refresh to connect.', error: false }];
      }
      log(`Listing ${server.label}:${dir} failed: ${errorMessage(e)}`);
      return [{ kind: 'message', key: `${server.id}:${dir}:error`, text: errorMessage(e), error: true }];
    }
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    switch (node.kind) {
      case 'server': {
        const item = new vscode.TreeItem(node.server.label, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `server:${node.server.id}`;
        item.description = node.server.detail;
        item.tooltip = new vscode.MarkdownString(
          `**${node.server.label}**\n\n${node.server.detail}\n\nRemote path: \`${node.server.remotePath}\`\n\n` +
            `Config: \`${vscode.workspace.asRelativePath(node.server.configPath)}\``
        );
        const color = node.server.color;
        item.iconPath = new vscode.ThemeIcon('server', color ? new vscode.ThemeColor(SERVER_COLORS[color].theme) : undefined);
        item.contextValue = 'server';
        return item;
      }
      case 'entry': {
        const uri = remoteUri(node.server, node.path);
        const isDir = node.entry.type === 'dir';
        const item = new vscode.TreeItem(
          uri,
          isDir ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
        );
        item.id = uri.toString();
        const details = [node.path];
        if (!isDir) details.push(formatSize(node.entry.size));
        if (node.entry.mtime) details.push(`Modified ${new Date(node.entry.mtime).toLocaleString()}`);
        if (node.entry.isLink) details.push('Symbolic link');
        item.tooltip = details.join('\n');
        if (node.entry.isLink) item.description = '↪';
        if (node.entry.type === 'file') {
          item.command = { command: 'vscode.open', title: 'Open', arguments: [uri] };
          item.contextValue = 'file';
        } else {
          item.contextValue = isDir ? 'dir' : 'other';
        }
        return item;
      }
      case 'problem': {
        const item = new vscode.TreeItem(vscode.workspace.asRelativePath(node.problem.configPath));
        item.description = node.problem.message;
        item.tooltip = node.problem.message;
        item.iconPath = new vscode.ThemeIcon('warning');
        item.contextValue = 'problem';
        item.command = {
          command: 'vscode.open',
          title: 'Open config',
          arguments: [vscode.Uri.file(node.problem.configPath)],
        };
        return item;
      }
      case 'message': {
        const item = new vscode.TreeItem(node.text);
        item.id = `message:${node.key}`;
        item.tooltip = node.text;
        item.iconPath = node.error ? new vscode.ThemeIcon('error') : undefined;
        item.contextValue = 'message';
        return item;
      }
    }
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.emitter.dispose();
  }
}
