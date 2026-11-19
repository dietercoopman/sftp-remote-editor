// Host key verification for SFTP connections: keys in ~/.ssh/known_hosts are accepted, a mismatch is
// refused, and an unknown host is trusted only after the user confirms its fingerprint (trust on first use).
// Same logic as Git SFTP Upload.
import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { CancelledError, log } from './util';

const TRUSTED_HOST_KEYS = 'trustedHostKeys';

let state: vscode.Memento;

export function initHostKeys(globalState: vscode.Memento): void {
  state = globalState;
}

export interface HostCheckState {
  /** Set when the presented key contradicts known_hosts or a previously trusted key. */
  mismatch?: string;
  /** Set when the host is not known anywhere yet (trust-on-first-use prompt needed). */
  unknown?: { pattern: string; id: string };
}

/** Key type as encoded at the start of the SSH public key blob, e.g. "ssh-ed25519". */
function keyType(key: Buffer): string {
  const len = key.readUInt32BE(0);
  return key.subarray(4, 4 + len).toString('utf8');
}

function fingerprint(key: Buffer): string {
  return 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
}

/** Host as written in known_hosts: plain for port 22, "[host]:port" otherwise. */
function hostPattern(host: string, port: number): string {
  const h = host.toLowerCase();
  return port === 22 ? h : `[${h}]:${port}`;
}

function globMatch(glob: string, value: string): boolean {
  const re = glob
    .toLowerCase()
    .split('')
    .map((ch) => (ch === '*' ? '.*' : ch === '?' ? '.' : ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${re}$`).test(value);
}

/** Matches one known_hosts host field (plain, wildcard, negated or hashed) against the pattern. */
function hostFieldMatches(field: string, pattern: string): boolean {
  if (field.startsWith('|1|')) {
    const [, , salt, hash] = field.split('|');
    if (!salt || !hash) return false;
    const digest = crypto.createHmac('sha1', Buffer.from(salt, 'base64')).update(pattern).digest('base64');
    return digest === hash;
  }
  let matched = false;
  for (const entry of field.split(',')) {
    if (entry.startsWith('!')) {
      if (globMatch(entry.slice(1), pattern)) return false;
    } else if (globMatch(entry, pattern)) {
      matched = true;
    }
  }
  return matched;
}

type KnownHostsResult = 'match' | 'mismatch' | 'unknown';

function checkKnownHosts(pattern: string, key: Buffer): KnownHostsResult {
  let text: string;
  try {
    text = fs.readFileSync(path.join(os.homedir(), '.ssh', 'known_hosts'), 'utf8');
  } catch {
    return 'unknown';
  }
  const type = keyType(key);
  let sawHost = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    const marker = parts[0].startsWith('@') ? parts.shift() : undefined;
    if (parts.length < 3) continue;
    const [hosts, ktype, b64] = parts;
    if (marker === '@cert-authority') continue;
    if (!hostFieldMatches(hosts, pattern) || ktype !== type) continue;
    sawHost = true;
    if (Buffer.from(b64, 'base64').equals(key)) {
      return marker === '@revoked' ? 'mismatch' : 'match';
    }
  }
  return sawHost ? 'mismatch' : 'unknown';
}

function trustedHostKeys(): Record<string, string> {
  return state.get<Record<string, string>>(TRUSTED_HOST_KEYS, {});
}

/** Synchronous ssh2 host verifier: accepts only keys found in known_hosts or trusted earlier. */
export function checkHostKey(host: string, port: number, key: Buffer, result: HostCheckState): boolean {
  const pattern = hostPattern(host, port);
  const id = `${keyType(key)} ${fingerprint(key)}`;
  const known = checkKnownHosts(pattern, key);
  if (known === 'match') return true;
  if (known === 'mismatch') {
    result.mismatch =
      `HOST KEY MISMATCH for ${pattern}: the server presented ${id}, which does not match ` +
      `~/.ssh/known_hosts. Possible man-in-the-middle attack. Connection refused.`;
    return false;
  }
  const trusted = trustedHostKeys()[pattern];
  if (trusted === id) return true;
  if (trusted) {
    result.mismatch =
      `HOST KEY MISMATCH for ${pattern}: the server presented ${id}, but ${trusted} was trusted earlier. ` +
      `Possible man-in-the-middle attack. Connection refused. ` +
      `Run "SFTP Remote: Forget Trusted Host Keys" if the server key was changed on purpose.`;
    return false;
  }
  result.unknown = { pattern, id };
  return false;
}

export async function confirmNewHostKey(pattern: string, id: string): Promise<void> {
  const TRUST = 'Trust and connect';
  const choice = await vscode.window.showWarningMessage(
    `The authenticity of host "${pattern}" can't be established.`,
    {
      modal: true,
      detail:
        `Key fingerprint:\n${id}\n\n` +
        `Verify this fingerprint with your server administrator before continuing. ` +
        `If you trust it, it is remembered for future connections.`,
    },
    TRUST
  );
  if (choice !== TRUST) throw new CancelledError();
  await state.update(TRUSTED_HOST_KEYS, { ...trustedHostKeys(), [pattern]: id });
  log(`Trusted new host key for ${pattern}: ${id}`);
}

export async function forgetTrustedHostKeys(): Promise<void> {
  const keys = Object.keys(trustedHostKeys());
  if (!keys.length) {
    vscode.window.showInformationMessage('No trusted host keys stored.');
    return;
  }
  const picked = await vscode.window.showQuickPick(keys, {
    canPickMany: true,
    placeHolder: 'Select the hosts whose trusted key should be forgotten',
  });
  if (!picked?.length) return;
  const remaining = { ...trustedHostKeys() };
  picked.forEach((k) => delete remaining[k]);
  await state.update(TRUSTED_HOST_KEYS, remaining);
  vscode.window.showInformationMessage(`Forgot host key for ${picked.join(', ')}.`);
}
