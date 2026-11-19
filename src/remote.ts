// File operations on a remote server over SFTP or FTP(S).
// This module does not import vscode, so it can be tested on its own with plain Node.
import * as path from 'path';
import * as tls from 'tls';
import { PassThrough, Readable } from 'stream';
import SftpClient from 'ssh2-sftp-client';
import { Client as FtpClient, FileInfo as FtpFileInfo, FileType as FtpFileType, FTPError } from 'basic-ftp';

export type EntryType = 'file' | 'dir' | 'other';

export interface RemoteStat {
  type: EntryType;
  /** True when the entry itself is a symbolic link (type is then the type of its target). */
  isLink: boolean;
  size: number;
  /** Modification time in milliseconds since the epoch; 0 when the server does not report it. */
  mtime: number;
}

export interface RemoteEntry extends RemoteStat {
  name: string;
}

export type RemoteErrorKind = 'notFound' | 'exists' | 'permission' | 'connection' | 'other';

export class RemoteError extends Error {
  constructor(message: string, readonly kind: RemoteErrorKind) {
    super(message);
  }
}

/** The operations the file system provider and the tree view need, for SFTP and FTP(S) alike. */
export interface RemoteFs {
  readonly protocol: 'sftp' | 'ftp';
  /** True once the connection has been closed, by us or by the server. */
  readonly closed: boolean;
  stat(remotePath: string): Promise<RemoteStat>;
  list(remoteDir: string): Promise<RemoteEntry[]>;
  read(remotePath: string): Promise<Buffer>;
  /** Overwrites the file in place, so owner and permissions of an existing file are kept. */
  write(remotePath: string, data: Buffer): Promise<void>;
  /** Creates the directory and any missing parents. */
  mkdir(remoteDir: string): Promise<void>;
  deleteFile(remotePath: string): Promise<void>;
  /** Deletes a directory and everything in it. */
  deleteDir(remoteDir: string): Promise<void>;
  rename(from: string, to: string, overwrite: boolean): Promise<void>;
  end(): Promise<void>;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const posix = path.posix;

// ---------------------------------------------------------------------------
// SFTP
// ---------------------------------------------------------------------------

/** SFTP status codes (draft-ietf-secsh-filexfer) as reported by ssh2. */
const SFTP_NO_SUCH_FILE = 2;
const SFTP_PERMISSION_DENIED = 3;

function sftpError(e: unknown, closed: boolean): RemoteError {
  if (e instanceof RemoteError) return e;
  const code = (e as { code?: unknown })?.code;
  const message = errorText(e);
  if (code === 'ENOENT' || code === SFTP_NO_SUCH_FILE || /no such file/i.test(message)) {
    return new RemoteError(message, 'notFound');
  }
  if (code === 'EACCES' || code === SFTP_PERMISSION_DENIED || /permission denied/i.test(message)) {
    return new RemoteError(message, 'permission');
  }
  if (closed || code === 'ERR_NOT_CONNECTED' || code === 'ECONNRESET' || /not connected|no sftp connection/i.test(message)) {
    return new RemoteError(message, 'connection');
  }
  return new RemoteError(message, 'other');
}

/** The part of ssh2's SFTP channel used for writing. */
interface RawSftp {
  open(path: string, flags: string, attrs: object, cb: (err: Error | undefined, handle: Buffer) => void): void;
  write(handle: Buffer, data: Buffer, offset: number, length: number, position: number, cb: (err?: Error) => void): void;
  close(handle: Buffer, cb: (err?: Error) => void): void;
}

const WRITE_CHUNK = 32 * 1024;

function writeWithoutChmod(sftp: RawSftp, remotePath: string, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.open(remotePath, 'w', {}, (openErr, handle) => {
      if (openErr) return reject(openErr);
      let offset = 0;
      const next = () => {
        if (offset >= data.length) {
          sftp.close(handle, (closeErr) => (closeErr ? reject(closeErr) : resolve()));
          return;
        }
        const length = Math.min(WRITE_CHUNK, data.length - offset);
        sftp.write(handle, data, offset, length, offset, (writeErr) => {
          if (writeErr) {
            sftp.close(handle, () => reject(writeErr));
            return;
          }
          offset += length;
          next();
        });
      };
      next();
    });
  });
}

function sftpType(s: { isDirectory: boolean; isFile: boolean }): EntryType {
  return s.isDirectory ? 'dir' : s.isFile ? 'file' : 'other';
}

export class SftpFs implements RemoteFs {
  readonly protocol = 'sftp';
  private isClosed = false;

  constructor(private readonly client: SftpClient) {
    const markClosed = () => {
      this.isClosed = true;
    };
    client.on('close', markClosed);
    client.on('end', markClosed);
  }

  get closed(): boolean {
    return this.isClosed;
  }

  private async wrap<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw sftpError(e, this.isClosed);
    }
  }

  stat(remotePath: string): Promise<RemoteStat> {
    return this.wrap(async () => {
      const s = await this.client.stat(remotePath);
      return { type: sftpType(s), isLink: false, size: s.size, mtime: s.modifyTime };
    });
  }

  list(remoteDir: string): Promise<RemoteEntry[]> {
    return this.wrap(async () => {
      const result: RemoteEntry[] = [];
      for (const item of await this.client.list(remoteDir)) {
        if (item.name === '.' || item.name === '..') continue;
        if (item.type === 'l') {
          // Resolve the link target; a broken link is shown as "other".
          let target: RemoteStat = { type: 'other', isLink: true, size: 0, mtime: item.modifyTime };
          try {
            const s = await this.client.stat(posix.join(remoteDir, item.name));
            target = { type: sftpType(s), isLink: true, size: s.size, mtime: s.modifyTime };
          } catch {
            // broken link
          }
          result.push({ name: item.name, ...target });
        } else {
          const type: EntryType = item.type === 'd' ? 'dir' : item.type === '-' ? 'file' : 'other';
          result.push({ name: item.name, type, isLink: false, size: item.size, mtime: item.modifyTime });
        }
      }
      return result;
    });
  }

  read(remotePath: string): Promise<Buffer> {
    return this.wrap(async () => (await this.client.get(remotePath)) as Buffer);
  }

  write(remotePath: string, data: Buffer): Promise<void> {
    // Not client.put(): its write stream always chmods the file to 0666 after opening it, which would
    // make every saved file world-writable. A plain open without attributes truncates an existing file
    // and keeps its permissions, and gives a new file the server's default permissions (umask).
    return this.wrap(() => {
      const sftp = (this.client as unknown as { sftp?: RawSftp }).sftp;
      if (!sftp) throw new RemoteError('No SFTP connection', 'connection');
      return writeWithoutChmod(sftp, remotePath, data);
    });
  }

  mkdir(remoteDir: string): Promise<void> {
    return this.wrap(async () => {
      await this.client.mkdir(remoteDir, true);
    });
  }

  deleteFile(remotePath: string): Promise<void> {
    return this.wrap(async () => {
      await this.client.delete(remotePath);
    });
  }

  deleteDir(remoteDir: string): Promise<void> {
    return this.wrap(async () => {
      await this.client.rmdir(remoteDir, true);
    });
  }

  rename(from: string, to: string, overwrite: boolean): Promise<void> {
    return this.wrap(async () => {
      const exists = await this.client.exists(to);
      if (exists && !overwrite) throw new RemoteError(`${to} already exists`, 'exists');
      if (!exists) {
        await this.client.rename(from, to);
        return;
      }
      // Plain SFTP rename refuses an existing target; OpenSSH's posix-rename replaces it atomically.
      try {
        await this.client.posixRename(from, to);
      } catch {
        if (exists === 'd') await this.client.rmdir(to, true);
        else await this.client.delete(to);
        await this.client.rename(from, to);
      }
    });
  }

  async end(): Promise<void> {
    this.isClosed = true;
    await this.client.end().catch(() => undefined);
  }
}

/** Connects with the given options (which carry the host key verifier). */
export async function connectSftp(options: SftpClient.ConnectOptions): Promise<SftpFs> {
  const client = new SftpClient();
  try {
    await client.connect(options);
  } catch (e) {
    await client.end().catch(() => undefined);
    throw e;
  }
  return new SftpFs(client);
}

// ---------------------------------------------------------------------------
// FTP / FTPS
// ---------------------------------------------------------------------------

function ftpError(e: unknown, closed: boolean): RemoteError {
  if (e instanceof RemoteError) return e;
  const message = errorText(e);
  if (e instanceof FTPError) {
    if (e.code === 553 || /denied|permission|not allowed/i.test(message)) return new RemoteError(message, 'permission');
    if (e.code === 550 || e.code === 450 || /no such|not found|does ?n[o']t exist/i.test(message)) {
      return new RemoteError(message, 'notFound');
    }
    return new RemoteError(message, 'other');
  }
  if (closed || /closed|ECONNRESET|socket|timeout/i.test(message)) return new RemoteError(message, 'connection');
  return new RemoteError(message, 'other');
}

const LIST_CACHE_MS = 2000;

export class FtpFs implements RemoteFs {
  readonly protocol = 'ftp';
  private isEnded = false;
  /** Short-lived cache of directory listings: VS Code stats a file several times in a row, and FTP has no stat. */
  private readonly listCache = new Map<string, { at: number; entries: RemoteEntry[] }>();

  constructor(private readonly client: FtpClient) {}

  get closed(): boolean {
    return this.isEnded || this.client.closed;
  }

  private async wrap<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw ftpError(e, this.closed);
    }
  }

  private invalidate(remotePath: string): void {
    this.listCache.delete(posix.dirname(remotePath));
    this.listCache.delete(remotePath);
  }

  private async isDir(remotePath: string): Promise<boolean> {
    try {
      await this.client.cd(remotePath);
      return true;
    } catch (e) {
      if (e instanceof FTPError) return false;
      throw e;
    }
  }

  private async toEntry(remoteDir: string, info: FtpFileInfo): Promise<RemoteEntry> {
    const mtime = info.modifiedAt?.getTime() ?? 0;
    if (info.type === FtpFileType.SymbolicLink) {
      // FTP cannot stat a link target; a link that can be entered is a directory.
      const dir = await this.isDir(posix.join(remoteDir, info.name));
      return { name: info.name, type: dir ? 'dir' : 'file', isLink: true, size: info.size, mtime };
    }
    const type: EntryType =
      info.type === FtpFileType.Directory ? 'dir' : info.type === FtpFileType.File ? 'file' : 'other';
    return { name: info.name, type, isLink: false, size: info.size, mtime };
  }

  private async listUncached(remoteDir: string): Promise<RemoteEntry[]> {
    const entries: RemoteEntry[] = [];
    for (const info of await this.client.list(remoteDir)) {
      if (info.name === '.' || info.name === '..') continue;
      entries.push(await this.toEntry(remoteDir, info));
    }
    this.listCache.set(remoteDir, { at: Date.now(), entries });
    return entries;
  }

  private async cachedList(remoteDir: string): Promise<RemoteEntry[]> {
    const hit = this.listCache.get(remoteDir);
    if (hit && Date.now() - hit.at < LIST_CACHE_MS) return hit.entries;
    return this.listUncached(remoteDir);
  }

  list(remoteDir: string): Promise<RemoteEntry[]> {
    return this.wrap(() => this.listUncached(remoteDir));
  }

  stat(remotePath: string): Promise<RemoteStat> {
    return this.wrap(async () => {
      if (remotePath === '/') return { type: 'dir', isLink: false, size: 0, mtime: 0 };
      let entry: RemoteEntry | undefined;
      let listed = false;
      try {
        entry = (await this.cachedList(posix.dirname(remotePath))).find((e) => e.name === posix.basename(remotePath));
        listed = true;
      } catch (e) {
        if (!(e instanceof FTPError)) throw e;
        // The parent may not be listable (for example the root of a chrooted account); try the path itself.
      }
      if (entry) {
        if (entry.type === 'file' && !entry.mtime) {
          // LIST gives no precise time; MDTM does, when the server supports it.
          try {
            entry = { ...entry, mtime: (await this.client.lastMod(remotePath)).getTime() };
          } catch {
            // MDTM not supported
          }
        }
        const { name, ...stat } = entry;
        return stat;
      }
      if (!listed && (await this.isDir(remotePath))) return { type: 'dir', isLink: false, size: 0, mtime: 0 };
      throw new RemoteError(`No such file: ${remotePath}`, 'notFound');
    });
  }

  read(remotePath: string): Promise<Buffer> {
    return this.wrap(async () => {
      const chunks: Buffer[] = [];
      const sink = new PassThrough();
      sink.on('data', (chunk: Buffer) => chunks.push(chunk));
      await this.client.downloadTo(sink, remotePath);
      return Buffer.concat(chunks);
    });
  }

  write(remotePath: string, data: Buffer): Promise<void> {
    return this.wrap(async () => {
      await this.client.uploadFrom(Readable.from(data), remotePath);
      this.invalidate(remotePath);
    });
  }

  mkdir(remoteDir: string): Promise<void> {
    return this.wrap(async () => {
      await this.client.ensureDir(remoteDir);
      this.invalidate(remoteDir);
    });
  }

  deleteFile(remotePath: string): Promise<void> {
    return this.wrap(async () => {
      await this.client.remove(remotePath);
      this.invalidate(remotePath);
    });
  }

  deleteDir(remoteDir: string): Promise<void> {
    return this.wrap(async () => {
      await this.client.removeDir(remoteDir);
      this.listCache.clear();
    });
  }

  rename(from: string, to: string, overwrite: boolean): Promise<void> {
    return this.wrap(async () => {
      const target = (await this.listUncached(posix.dirname(to))).find((e) => e.name === posix.basename(to));
      if (target) {
        if (!overwrite) throw new RemoteError(`${to} already exists`, 'exists');
        if (target.type === 'dir') await this.client.removeDir(to);
        else await this.client.remove(to);
      }
      await this.client.rename(from, to);
      this.listCache.clear();
    });
  }

  async end(): Promise<void> {
    this.isEnded = true;
    this.client.close();
  }
}

export interface FtpConnectOptions {
  host: string;
  port: number;
  user: string;
  password: string;
  secure: boolean | 'implicit';
  secureOptions?: tls.ConnectionOptions;
  timeout: number;
}

export async function connectFtp(o: FtpConnectOptions): Promise<FtpFs> {
  const client = new FtpClient(o.timeout);
  try {
    await client.access({
      host: o.host,
      port: o.port,
      user: o.user,
      password: o.password,
      secure: o.secure,
      secureOptions: o.secureOptions,
    });
  } catch (e) {
    client.close();
    throw e;
  }
  return new FtpFs(client);
}
