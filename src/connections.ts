// One connection per server, reused for every operation. Operations on a connection run one after
// another (FTP cannot run two commands at once), a dropped connection is reopened once, and an idle
// connection is closed after the configured time.
import * as vscode from 'vscode';
import * as os from 'os';
import * as fs from 'fs';
import SftpClient from 'ssh2-sftp-client';
import { FTPError } from 'basic-ftp';
import { ServerConfig, SftpConfig } from './config';
import { checkHostKey, confirmNewHostKey, HostCheckState } from './hostKeys';
import { connectFtp, connectSftp, RemoteError, RemoteFs } from './remote';
import { askSecret, CancelledError, errorMessage, log } from './util';

/** FTP reply codes a server gives when it does not understand or refuses "AUTH TLS". */
const TLS_REFUSED_CODES = new Set([500, 502, 504, 534]);

/** Passwords and passphrases typed in this session, so an automatic reconnect does not ask again. Never stored on disk. */
const typedSecrets = new Map<string, string>();

async function secret(key: string, prompt: string): Promise<string> {
  const known = typedSecrets.get(key);
  if (known !== undefined) return known;
  const value = await askSecret(prompt);
  typedSecrets.set(key, value);
  return value;
}

function forgetSecrets(server: ServerConfig): void {
  for (const key of [...typedSecrets.keys()]) {
    if (key.startsWith(`${server.fingerprint}#`)) typedSecrets.delete(key);
  }
}

async function sftpOptions(server: ServerConfig): Promise<SftpClient.ConnectOptions> {
  const c: SftpConfig = server.settings;
  const key = (what: string) => `${server.fingerprint}#${what}`;
  const opts: SftpClient.ConnectOptions = {
    host: c.host,
    port: c.port ?? 22,
    username: c.username,
    readyTimeout: c.connectTimeout ?? 20000,
    keepaliveInterval: 30000,
    // No automatic retries: a rejected host key or wrong password must fail immediately.
    retries: 0,
  };

  if (c.privateKeyPath) {
    const keyPath = c.privateKeyPath.replace(/^~(?=$|[\/\\])/, os.homedir());
    opts.privateKey = await fs.promises.readFile(keyPath);
    if (c.passphrase === true) opts.passphrase = await secret(key('passphrase'), `Passphrase for ${keyPath}`);
    else if (typeof c.passphrase === 'string') opts.passphrase = c.passphrase;
  }

  if (c.password === true) opts.password = await secret(key('password'), `Password for ${c.username}@${c.host}`);
  else if (typeof c.password === 'string') opts.password = c.password;

  const agent = c.agent ?? process.env.SSH_AUTH_SOCK;
  if (agent && !opts.privateKey && !opts.password) opts.agent = agent;

  if (!opts.privateKey && !opts.password && !opts.agent) {
    opts.password = await secret(key('password'), `Password for ${c.username}@${c.host}`);
  }
  return opts;
}

/** Connects with host key verification; on an unknown host asks the user once and retries. */
async function openSftp(server: ServerConfig): Promise<RemoteFs> {
  const opts = await sftpOptions(server);
  const host = server.settings.host!;
  const port = opts.port ?? 22;
  for (let attempt = 0; ; attempt++) {
    const check: HostCheckState = {};
    opts.hostVerifier = (key: Buffer) => checkHostKey(host, port, key, check);
    try {
      return await connectSftp(opts);
    } catch (e) {
      if (check.mismatch) throw new Error(check.mismatch);
      if (check.unknown && attempt === 0) {
        await confirmNewHostKey(check.unknown.pattern, check.unknown.id);
        continue;
      }
      throw e;
    }
  }
}

async function openFtp(server: ServerConfig): Promise<RemoteFs> {
  const c = server.settings;
  const secure: boolean | 'implicit' = c.secure === false ? false : c.secure === 'implicit' ? 'implicit' : true;
  const user = c.username ?? 'anonymous';
  const password =
    typeof c.password === 'string'
      ? c.password
      : await secret(`${server.fingerprint}#password`, `Password for ${user}@${c.host}`);
  try {
    return await connectFtp({
      host: c.host!,
      port: c.port ?? (secure === 'implicit' ? 990 : 21),
      user,
      password,
      secure,
      secureOptions: c.secureOptions,
      timeout: c.connectTimeout ?? 20000,
    });
  } catch (e) {
    if (c.secure === undefined && e instanceof FTPError && TLS_REFUSED_CODES.has(e.code)) {
      throw new Error(
        `${e.message.trim()} — the server does not accept FTPS (explicit TLS). ` +
          `Set "secure": "implicit" for implicit FTPS, or "secure": false to allow unencrypted FTP.`
      );
    }
    throw e;
  }
}

class Connection {
  private remote: RemoteFs | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private idleTimer: NodeJS.Timeout | undefined;
  private pending = 0;

  constructor(readonly server: ServerConfig) {}

  /** Runs fn with a connected client, after every operation queued before it. */
  run<T>(fn: (remote: RemoteFs) => Promise<T>): Promise<T> {
    this.pending++;
    this.clearIdle();
    const task = this.queue.then(() => this.execute(fn));
    this.queue = task.catch(() => undefined);
    return task.finally(() => {
      if (--this.pending === 0) this.armIdle();
    });
  }

  private async execute<T>(fn: (remote: RemoteFs) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const remote = await this.connect();
      try {
        return await fn(remote);
      } catch (e) {
        // A connection that dropped (server restart, network change, sleep) is reopened once.
        const dropped = remote.closed || (e instanceof RemoteError && e.kind === 'connection');
        if (dropped && attempt === 0) {
          log(`Connection to ${this.server.label} was lost, reconnecting`);
          await this.close();
          continue;
        }
        throw e;
      }
    }
  }

  private async connect(): Promise<RemoteFs> {
    if (this.remote && !this.remote.closed) return this.remote;
    log(`Connecting to ${this.server.label} (${this.server.detail})`);
    try {
      this.remote = this.server.protocol === 'ftp' ? await openFtp(this.server) : await openSftp(this.server);
    } catch (e) {
      if (!(e instanceof CancelledError)) {
        log(`Connection to ${this.server.label} failed: ${errorMessage(e)}`);
        // A wrong password must be asked again next time instead of being reused.
        const authFailed =
          (e instanceof FTPError && e.code === 530) || /authentication|passphrase|decrypt/i.test(errorMessage(e));
        if (authFailed) forgetSecrets(this.server);
      }
      throw e;
    }
    log(`Connected to ${this.server.label}`);
    return this.remote;
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private armIdle(): void {
    this.clearIdle();
    const minutes = vscode.workspace
      .getConfiguration('sftpRemoteEditor', this.server.folder.uri)
      .get<number>('idleDisconnectMinutes', 10);
    if (!this.remote || !minutes || minutes <= 0) return;
    this.idleTimer = setTimeout(() => {
      if (this.pending === 0 && this.remote) {
        log(`Closing idle connection to ${this.server.label}`);
        void this.close();
      }
    }, minutes * 60_000);
  }

  get connected(): boolean {
    return !!this.remote && !this.remote.closed;
  }

  async close(): Promise<void> {
    this.clearIdle();
    const remote = this.remote;
    this.remote = undefined;
    await remote?.end().catch(() => undefined);
  }
}

export class ConnectionManager implements vscode.Disposable {
  private readonly connections = new Map<string, Connection>();

  run<T>(server: ServerConfig, fn: (remote: RemoteFs) => Promise<T>): Promise<T> {
    let conn = this.connections.get(server.id);
    if (!conn || conn.server.fingerprint !== server.fingerprint) {
      void conn?.close();
      conn = new Connection(server);
      this.connections.set(server.id, conn);
    }
    return conn.run(fn);
  }

  isConnected(id: string): boolean {
    return this.connections.get(id)?.connected ?? false;
  }

  async disconnect(id: string): Promise<void> {
    const conn = this.connections.get(id);
    this.connections.delete(id);
    if (conn) {
      await conn.close();
      log(`Disconnected from ${conn.server.label}`);
    }
  }

  dispose(): void {
    this.connections.forEach((c) => void c.close());
    this.connections.clear();
  }
}
