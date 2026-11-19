// The sftp-remote:// file system. VS Code opens, saves, renames and deletes remote files through it,
// so a remote file opens in a normal editor and Save writes straight to the server, with no local copy.
//
// URI layout: sftp-remote://<server id>/<absolute path on the server>
//
// VS Code compares the modification time and size from stat() before it saves. When someone else
// changed the file on the server in the meantime, it shows "The content of the file is newer" with
// Compare / Overwrite instead of silently overwriting their change.
import * as vscode from 'vscode';
import * as path from 'path';
import { ConnectionManager } from './connections';
import { ServerConfig, ServerRegistry } from './config';
import { RemoteError, RemoteFs, RemoteStat } from './remote';
import { CancelledError, errorMessage, log } from './util';

export const SCHEME = 'sftp-remote';

export function remoteUri(server: ServerConfig, remotePath: string): vscode.Uri {
  return vscode.Uri.from({ scheme: SCHEME, authority: server.id, path: remotePath });
}

function toFileType(s: RemoteStat): vscode.FileType {
  const base =
    s.type === 'dir' ? vscode.FileType.Directory : s.type === 'file' ? vscode.FileType.File : vscode.FileType.Unknown;
  return s.isLink ? base | vscode.FileType.SymbolicLink : base;
}

export class RemoteFileSystemProvider implements vscode.FileSystemProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;

  constructor(
    private readonly registry: ServerRegistry,
    private readonly connections: ConnectionManager
  ) {}

  /** Runs an operation on the server behind the URI and turns errors into VS Code file system errors. */
  private async call<T>(uri: vscode.Uri, fn: (remote: RemoteFs, remotePath: string) => Promise<T>): Promise<T> {
    const server = await this.registry.get(uri.authority);
    if (!server) {
      throw vscode.FileSystemError.Unavailable(
        `Unknown server "${uri.authority}". Is its sftp.json part of the open workspace?`
      );
    }
    const remotePath = path.posix.normalize(uri.path || '/');
    try {
      return await this.connections.run(server, (remote) => fn(remote, remotePath));
    } catch (e) {
      if (e instanceof vscode.FileSystemError) throw e;
      if (e instanceof CancelledError) throw vscode.FileSystemError.Unavailable('Cancelled');
      if (e instanceof RemoteError) {
        switch (e.kind) {
          case 'notFound':
            throw vscode.FileSystemError.FileNotFound(uri);
          case 'exists':
            throw vscode.FileSystemError.FileExists(uri);
          case 'permission':
            throw vscode.FileSystemError.NoPermissions(`${server.label}: ${e.message}`);
        }
      }
      throw vscode.FileSystemError.Unavailable(`${server.label}: ${errorMessage(e)}`);
    }
  }

  watch(): vscode.Disposable {
    // The server is not watched; changes made by others show up on refresh, or as a conflict on save.
    return new vscode.Disposable(() => undefined);
  }

  stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    return this.call(uri, async (remote, p) => {
      const s = await remote.stat(p);
      return { type: toFileType(s), ctime: s.mtime, mtime: s.mtime, size: s.size };
    });
  }

  readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    return this.call(uri, async (remote, p) =>
      (await remote.list(p)).map((e) => [e.name, toFileType(e)] as [string, vscode.FileType])
    );
  }

  readFile(uri: vscode.Uri): Promise<Uint8Array> {
    return this.call(uri, (remote, p) => remote.read(p));
  }

  async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { readonly create: boolean; readonly overwrite: boolean }
  ): Promise<void> {
    let created = false;
    await this.call(uri, async (remote, p) => {
      let existing: RemoteStat | undefined;
      try {
        existing = await remote.stat(p);
      } catch (e) {
        if (!(e instanceof RemoteError && e.kind === 'notFound')) throw e;
      }
      if (existing?.type === 'dir') throw vscode.FileSystemError.FileIsADirectory(uri);
      if (existing && !options.overwrite) throw vscode.FileSystemError.FileExists(uri);
      if (!existing && !options.create) throw vscode.FileSystemError.FileNotFound(uri);
      await remote.write(p, Buffer.from(content.buffer, content.byteOffset, content.byteLength));
      created = !existing;
      log(`saved     ${uri.authority}:${p} (${content.byteLength} bytes)`);
    });
    this.emitter.fire([{ type: created ? vscode.FileChangeType.Created : vscode.FileChangeType.Changed, uri }]);
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    await this.call(uri, async (remote, p) => {
      await remote.mkdir(p);
      log(`created   ${uri.authority}:${p}/`);
    });
    this.emitter.fire([{ type: vscode.FileChangeType.Created, uri }]);
  }

  async delete(uri: vscode.Uri, options: { readonly recursive: boolean }): Promise<void> {
    await this.call(uri, async (remote, p) => {
      const s = await remote.stat(p);
      if (s.type === 'dir' && !s.isLink) {
        if (!options.recursive && (await remote.list(p)).length) {
          throw vscode.FileSystemError.NoPermissions('Directory is not empty');
        }
        await remote.deleteDir(p);
      } else {
        await remote.deleteFile(p);
      }
      log(`deleted   ${uri.authority}:${p}`);
    });
    this.emitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
  }

  async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { readonly overwrite: boolean }): Promise<void> {
    if (oldUri.authority !== newUri.authority) {
      throw vscode.FileSystemError.NoPermissions('Moving files between servers is not supported');
    }
    await this.call(oldUri, async (remote, from) => {
      const to = path.posix.normalize(newUri.path);
      await remote.rename(from, to, options.overwrite);
      log(`renamed   ${oldUri.authority}:${from} → ${to}`);
    });
    this.emitter.fire([
      { type: vscode.FileChangeType.Deleted, uri: oldUri },
      { type: vscode.FileChangeType.Created, uri: newUri },
    ]);
  }
}
