import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { configPathFor, ServerConfig, ServerRegistry } from './config';
import { ConnectionManager } from './connections';
import { RemoteFileSystemProvider, remoteUri, SCHEME } from './fsProvider';
import { forgetTrustedHostKeys, initHostKeys } from './hostKeys';
import { directoryOf, ServersTreeProvider, TreeNode } from './tree';
import { CancelledError, errorMessage, output } from './util';

let tree: ServersTreeProvider;
let view: vscode.TreeView<TreeNode>;

export function activate(context: vscode.ExtensionContext) {
  initHostKeys(context.globalState);
  const registry = new ServerRegistry();
  const connections = new ConnectionManager();
  const provider = new RemoteFileSystemProvider(registry, connections);
  tree = new ServersTreeProvider(registry, connections);
  view = vscode.window.createTreeView('sftpRemoteEditor.servers', { treeDataProvider: tree, showCollapseAll: true });

  // Connection details changed or a server was removed: drop its connection, it reconnects on next use.
  registry.onDidChange(({ changed, removed }) => {
    changed.forEach((s) => void connections.disconnect(s.id));
    removed.forEach((id) => void connections.disconnect(id));
  });

  const command = (id: string, fn: (node?: TreeNode) => Promise<unknown> | unknown) =>
    vscode.commands.registerCommand(id, async (node?: TreeNode) => {
      try {
        await fn(node ?? view.selection[0]);
      } catch (e) {
        if (e instanceof CancelledError) return;
        const choice = await vscode.window.showErrorMessage(errorMessage(e), 'Show log');
        if (choice) output.show();
      }
    });

  context.subscriptions.push(
    output,
    registry,
    connections,
    tree,
    view,
    vscode.workspace.registerFileSystemProvider(SCHEME, provider, { isCaseSensitive: true }),
    command('sftpRemoteEditor.refresh', async (node) => {
      if (node && (node.kind === 'server' || node.kind === 'entry')) tree.refresh(node);
      else {
        await registry.reload();
        tree.refresh();
      }
    }),
    command('sftpRemoteEditor.openConfig', openConfig),
    command('sftpRemoteEditor.newFile', (node) => create(node, 'file')),
    command('sftpRemoteEditor.newFolder', (node) => create(node, 'folder')),
    command('sftpRemoteEditor.rename', rename),
    command('sftpRemoteEditor.delete', remove),
    command('sftpRemoteEditor.download', download),
    command('sftpRemoteEditor.compareWithLocal', compareWithLocal),
    command('sftpRemoteEditor.copyRemotePath', async (node) => {
      const p = node?.kind === 'server' ? node.server.remotePath : node?.kind === 'entry' ? node.path : undefined;
      if (p) await vscode.env.clipboard.writeText(p);
    }),
    command('sftpRemoteEditor.disconnect', async (node) => {
      if (node?.kind !== 'server') return;
      await connections.disconnect(node.server.id);
      tree.refresh(node);
    }),
    vscode.commands.registerCommand('sftpRemoteEditor.forgetTrustedHostKeys', forgetTrustedHostKeys)
  );
}

export function deactivate() {}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function serverOf(node?: TreeNode): ServerConfig | undefined {
  return node?.kind === 'server' || node?.kind === 'entry' ? node.server : undefined;
}

/** A single file or folder name, or a relative path below the current folder; no "..", no absolute paths. */
function validateName(value: string): string | undefined {
  const name = value.trim();
  if (!name) return 'Enter a name';
  if (name.startsWith('/')) return 'Enter a name relative to the selected folder';
  if (name.split('/').some((part) => part === '..' || part === '.')) return '"." and ".." are not allowed';
  return undefined;
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch (e) {
    if (e instanceof vscode.FileSystemError && e.code === 'FileNotFound') return false;
    throw e;
  }
}

async function create(node: TreeNode | undefined, kind: 'file' | 'folder'): Promise<void> {
  const server = serverOf(node);
  const dir = node && directoryOf(node);
  if (!server || !dir) return;
  const value = await vscode.window.showInputBox({
    prompt: `New ${kind} in ${server.label}:${dir}`,
    placeHolder: kind === 'file' ? 'name.php' : 'folder-name',
    validateInput: validateName,
  });
  if (!value) return;
  const target = path.posix.join(dir, value.trim());
  const uri = remoteUri(server, target);
  if (await exists(uri)) throw new Error(`${target} already exists on ${server.label}`);
  if (kind === 'folder') {
    await vscode.workspace.fs.createDirectory(uri);
  } else {
    const parent = path.posix.dirname(target);
    if (parent !== dir) await vscode.workspace.fs.createDirectory(remoteUri(server, parent));
    await vscode.workspace.fs.writeFile(uri, new Uint8Array());
  }
  tree.refreshDirectory(server, dir);
  if (kind === 'file') await vscode.window.showTextDocument(uri);
}

async function rename(node?: TreeNode): Promise<void> {
  if (node?.kind !== 'entry') return;
  const oldName = path.posix.basename(node.path);
  const dot = oldName.lastIndexOf('.');
  const value = await vscode.window.showInputBox({
    prompt: `Rename ${node.path} on ${node.server.label}`,
    value: oldName,
    valueSelection: [0, dot > 0 && node.entry.type === 'file' ? dot : oldName.length],
    validateInput: (v) => validateName(v) ?? (v.includes('/') ? 'Enter a name without "/"' : undefined),
  });
  if (!value || value.trim() === oldName) return;
  const dir = path.posix.dirname(node.path);
  const newUri = remoteUri(node.server, path.posix.join(dir, value.trim()));
  if (await exists(newUri)) throw new Error(`${value.trim()} already exists in ${dir}`);
  // A workspace edit also moves open editors of the file to the new name.
  const edit = new vscode.WorkspaceEdit();
  edit.renameFile(remoteUri(node.server, node.path), newUri, { overwrite: false });
  if (!(await vscode.workspace.applyEdit(edit))) throw new Error(`Renaming ${node.path} failed`);
  tree.refreshDirectory(node.server, dir);
}

async function remove(node?: TreeNode): Promise<void> {
  if (node?.kind !== 'entry') return;
  const isDir = node.entry.type === 'dir' && !node.entry.isLink;
  const DELETE = 'Delete';
  const choice = await vscode.window.showWarningMessage(
    `Delete ${isDir ? 'the folder' : ''} "${node.path}" on ${node.server.label}?`,
    {
      modal: true,
      detail: isDir
        ? 'The folder and everything in it are deleted from the server. This cannot be undone.'
        : 'The file is deleted from the server. This cannot be undone.',
    },
    DELETE
  );
  if (choice !== DELETE) return;
  await vscode.workspace.fs.delete(remoteUri(node.server, node.path), { recursive: true, useTrash: false });
  tree.refreshDirectory(node.server, path.posix.dirname(node.path));
}

/** Local file that corresponds to a remote path, following the config's "context" and "remotePath". */
function localPathFor(server: ServerConfig, remotePath: string): string | undefined {
  const rel = path.posix.relative(server.remotePath, remotePath);
  if (rel.startsWith('..') || path.posix.isAbsolute(rel)) return undefined;
  return path.join(server.contextPath, ...rel.split('/'));
}

async function download(node?: TreeNode): Promise<void> {
  if (node?.kind !== 'entry' || node.entry.type !== 'file') return;
  const local = localPathFor(node.server, node.path);
  if (!local) throw new Error(`${node.path} is outside the remotePath of ${node.server.label}`);
  const localUri = vscode.Uri.file(local);
  if (fs.existsSync(local)) {
    const OVERWRITE = 'Overwrite';
    const choice = await vscode.window.showWarningMessage(
      `Overwrite ${vscode.workspace.asRelativePath(localUri)} with the version from ${node.server.label}?`,
      { modal: true },
      OVERWRITE
    );
    if (choice !== OVERWRITE) return;
  }
  const data = await vscode.workspace.fs.readFile(remoteUri(node.server, node.path));
  await fs.promises.mkdir(path.dirname(local), { recursive: true });
  await vscode.workspace.fs.writeFile(localUri, data);
  vscode.window.showInformationMessage(`Downloaded to ${vscode.workspace.asRelativePath(localUri)}`);
}

async function compareWithLocal(node?: TreeNode): Promise<void> {
  if (node?.kind !== 'entry' || node.entry.type !== 'file') return;
  const local = localPathFor(node.server, node.path);
  if (!local || !fs.existsSync(local)) {
    vscode.window.showInformationMessage(`There is no local file for ${node.path} in this project.`);
    return;
  }
  const name = path.posix.basename(node.path);
  await vscode.commands.executeCommand(
    'vscode.diff',
    vscode.Uri.file(local),
    remoteUri(node.server, node.path),
    `${name} (Local ↔ ${node.server.label})`
  );
}

// Plain JSON, without comments, so the SFTP extension by Natizyskunk can read the same file.
const TEMPLATE = `{
  "name": "My server",
  "protocol": "sftp",
  "host": "example.com",
  "port": 22,
  "username": "deploy",
  "privateKeyPath": "~/.ssh/id_ed25519",
  "remotePath": "/var/www/html"
}
`;

async function openConfig(): Promise<void> {
  const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file');
  if (!folders.length) {
    vscode.window.showInformationMessage('Open a project folder first.');
    return;
  }
  const folder =
    folders.length === 1
      ? folders[0]
      : await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Which project?' });
  if (!folder) return;
  const cfgPath = configPathFor(folder);
  if (!cfgPath) throw new Error('sftpRemoteEditor.configFile must point inside the workspace folder');
  if (!fs.existsSync(cfgPath)) {
    await fs.promises.mkdir(path.dirname(cfgPath), { recursive: true });
    await fs.promises.writeFile(cfgPath, TEMPLATE, { flag: 'wx' });
  }
  await vscode.window.showTextDocument(vscode.Uri.file(cfgPath));
}
