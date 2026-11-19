// Reads the servers from .vscode/sftp.json (the format of Git SFTP Upload and the SFTP extension by
// Natizyskunk / liximomo). Every config entry, and every profile of an entry, becomes one server.
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as tls from 'tls';
import { parse as parseJsonc, ParseError, printParseErrorCode } from 'jsonc-parser';
import { log } from './util';

export interface SftpConfig {
  name?: string;
  protocol?: string;
  host?: string;
  port?: number;
  username?: string;
  password?: string | boolean;
  privateKeyPath?: string;
  passphrase?: string | boolean;
  agent?: string;
  remotePath?: string;
  context?: string;
  connectTimeout?: number;
  /** FTP only: true = explicit FTPS (default), "implicit" = implicit FTPS, false = unencrypted FTP. */
  secure?: boolean | 'implicit' | 'control';
  /** FTP only: TLS options such as rejectUnauthorized, passed to Node's tls.connect. */
  secureOptions?: tls.ConnectionOptions;
  profiles?: Record<string, Partial<SftpConfig>>;
  defaultProfile?: string;
}

export interface ServerConfig {
  /** Stable id, used as the authority of sftp-remote:// URIs, so it must not depend on UI state. */
  id: string;
  label: string;
  /** user@host plus protocol, shown next to the label. */
  detail: string;
  folder: vscode.WorkspaceFolder;
  configPath: string;
  /** Local directory that corresponds to remotePath (the entry's "context"). */
  contextPath: string;
  remotePath: string;
  protocol: 'sftp' | 'ftp';
  settings: SftpConfig;
  /** Serialized settings, to notice when a server's connection details changed. */
  fingerprint: string;
}

export interface ConfigProblem {
  configPath: string;
  message: string;
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function configPathFor(folder: vscode.WorkspaceFolder): string | undefined {
  const rel = vscode.workspace
    .getConfiguration('sftpRemoteEditor', folder.uri)
    .get<string>('configFile', '.vscode/sftp.json');
  const cfgPath = path.resolve(folder.uri.fsPath, rel);
  // The config file must live inside the workspace folder; never read arbitrary files on disk.
  return isInside(folder.uri.fsPath, cfgPath) ? cfgPath : undefined;
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'server'
  );
}

/** Warnings are written once per config file per session, not on every reload. */
const warned = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  log(`WARNING: ${message}`);
}

export async function loadServers(): Promise<{ servers: ServerConfig[]; problems: ConfigProblem[] }> {
  const servers: ServerConfig[] = [];
  const problems: ConfigProblem[] = [];
  const usedIds = new Set<string>();

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme !== 'file') continue;
    const cfgPath = configPathFor(folder);
    if (!cfgPath) {
      problems.push({
        configPath: folder.uri.fsPath,
        message: `sftpRemoteEditor.configFile must point inside the workspace folder "${folder.name}"`,
      });
      continue;
    }
    if (!fs.existsSync(cfgPath)) continue;
    const display = vscode.workspace.asRelativePath(cfgPath);

    const errors: ParseError[] = [];
    const raw = parseJsonc(await fs.promises.readFile(cfgPath, 'utf8'), errors, { allowTrailingComma: true });
    if (errors.length) {
      problems.push({
        configPath: cfgPath,
        message: `Invalid JSON: ${printParseErrorCode(errors[0].error)} (position ${errors[0].offset})`,
      });
      continue;
    }

    const entries = (Array.isArray(raw) ? raw : [raw]) as SftpConfig[];
    entries.forEach((entry, index) => {
      if (!entry || typeof entry !== 'object') return;
      const profiles = entry.profiles ?? {};
      const variants: { profile?: string; settings: SftpConfig }[] = Object.keys(profiles).map((p) => ({
        profile: p,
        settings: { ...entry, ...profiles[p] },
      }));
      if (!variants.length || entry.host) variants.unshift({ settings: { ...entry } });

      for (const { profile, settings } of variants) {
        const name = (settings.name ?? settings.host ?? `config ${index + 1}`) + (profile ? ` (${profile})` : '');
        const protocol = settings.protocol ?? 'sftp';
        let problem: string | undefined;
        if (protocol !== 'sftp' && protocol !== 'ftp') problem = `Protocol "${protocol}" is not supported, only sftp and ftp`;
        else if (!settings.host) problem = 'No "host" set';
        else if (!settings.remotePath) problem = 'No "remotePath" set';
        if (problem) {
          problems.push({ configPath: cfgPath, message: `${name}: ${problem}` });
          continue;
        }

        if (protocol === 'ftp' && settings.secure === false) {
          warnOnce(
            `${cfgPath}#${index}#plain`,
            `${display} (${name}) uses unencrypted FTP ("secure": false). The password and all file contents are sent in plaintext.`
          );
        } else if (protocol === 'ftp' && settings.secureOptions?.rejectUnauthorized === false) {
          warnOnce(
            `${cfgPath}#${index}#tls`,
            `${display} (${name}) disables TLS certificate verification ("rejectUnauthorized": false).`
          );
        }
        if (typeof settings.password === 'string' || typeof settings.passphrase === 'string') {
          warnOnce(
            `${cfgPath}#${index}#pw`,
            `${display} contains a plaintext password or passphrase. Use "password": true to be prompted instead, and keep this file out of version control.`
          );
        }

        let id = slug(name);
        for (let n = 2; usedIds.has(id); n++) id = `${slug(name)}-${n}`;
        usedIds.add(id);

        const detail =
          `${settings.username ? settings.username + '@' : ''}${settings.host}` +
          (protocol === 'ftp' ? (settings.secure === false ? ' · ftp' : ' · ftps') : '');
        const { profiles: _p, defaultProfile: _d, ...connection } = settings;
        servers.push({
          id,
          label: name,
          detail,
          folder,
          configPath: cfgPath,
          contextPath: path.resolve(folder.uri.fsPath, entry.context ?? '.'),
          remotePath: path.posix.normalize(settings.remotePath!),
          protocol: protocol as 'sftp' | 'ftp',
          settings,
          fingerprint: JSON.stringify(connection),
        });
      }
    });
  }
  return { servers, problems };
}

/** Keeps the current list of servers and reloads it when a config file or a setting changes. */
export class ServerRegistry implements vscode.Disposable {
  private servers = new Map<string, ServerConfig>();
  private problemList: ConfigProblem[] = [];
  private loading: Promise<void>;
  private readonly emitter = new vscode.EventEmitter<{ changed: ServerConfig[]; removed: string[] }>();
  /** Fires after a reload with the servers whose connection details changed or that disappeared. */
  readonly onDidChange = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.loading = this.reload();
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.json');
    const onFile = (uri: vscode.Uri) => {
      const folder = vscode.workspace.getWorkspaceFolder(uri);
      if (folder && configPathFor(folder) === uri.fsPath) void this.reload();
    };
    this.disposables.push(
      watcher,
      watcher.onDidChange(onFile),
      watcher.onDidCreate(onFile),
      watcher.onDidDelete(onFile),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.reload()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('sftpRemoteEditor.configFile')) void this.reload();
      })
    );
  }

  reload(): Promise<void> {
    this.loading = (async () => {
      const previous = this.servers;
      const { servers, problems } = await loadServers();
      this.servers = new Map(servers.map((s) => [s.id, s]));
      this.problemList = problems;
      problems.forEach((p) => log(`${vscode.workspace.asRelativePath(p.configPath)}: ${p.message}`));
      const changed = servers.filter((s) => previous.has(s.id) && previous.get(s.id)!.fingerprint !== s.fingerprint);
      const removed = [...previous.keys()].filter((id) => !this.servers.has(id));
      this.emitter.fire({ changed, removed });
    })();
    return this.loading;
  }

  async all(): Promise<ServerConfig[]> {
    await this.loading;
    return [...this.servers.values()];
  }

  async problems(): Promise<ConfigProblem[]> {
    await this.loading;
    return this.problemList;
  }

  async get(id: string): Promise<ServerConfig | undefined> {
    await this.loading;
    return this.servers.get(id);
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.emitter.dispose();
  }
}
