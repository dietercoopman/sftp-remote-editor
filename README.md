# SFTP Remote Editor

![Edit files on your server. Straight from VS Code.](images/marketplace/hero.png)

**Edit files on your server, in place.** Browse the server in a side panel, click a file, change it and press Save: it is written straight to the server. No local copy, no upload step, nothing to sync.

It reads the `.vscode/sftp.json` you already have, so there is nothing to set up.

[![VS Marketplace](https://vsmarketplacebadges.dev/version-short/delta-solutions.sftp-remote-editor.svg?color=0f172a)](https://marketplace.visualstudio.com/items?itemName=delta-solutions.sftp-remote-editor)
[![Installs](https://vsmarketplacebadges.dev/installs-short/delta-solutions.sftp-remote-editor.svg?color=0f172a)](https://marketplace.visualstudio.com/items?itemName=delta-solutions.sftp-remote-editor)
[![Open VSX](https://img.shields.io/open-vsx/v/delta-solutions/sftp-remote-editor?label=Open%20VSX&color=0f172a)](https://open-vsx.org/extension/delta-solutions/sftp-remote-editor)
[![License: MIT](https://img.shields.io/badge/license-MIT-0f172a)](LICENSE)

**Install:** search for *SFTP Remote Editor* in the Extensions view, or open `vscode:extension/delta-solutions.sftp-remote-editor`. Also available for Cursor and VSCodium through [Open VSX](https://open-vsx.org/extension/delta-solutions/sftp-remote-editor). Free, MIT licensed, macOS, Windows and Linux.

## Why

A typo on a live page, a setting in a config file, a quick look at what is really on the server. In other editors you open the remote host, double-click the file and save. In VS Code that meant downloading the file into your project first, or connecting the whole window to the server.

SFTP Remote Editor gives you the remote host view:

- **The server in a side panel.** Every server in your `sftp.json`, with its folders and files. Folders load when you open them.
- **Edit in place.** A file opens in a normal editor, with syntax highlighting, search and everything else. Save writes it to the server.
- **No silent overwrites.** If someone changed the file on the server after you opened it, saving stops and you compare first.
- **Permissions stay as they are.** A saved file keeps its owner and permissions. New files get the server's defaults.
- **Your existing config.** Same `.vscode/sftp.json` as Git SFTP Upload and the SFTP extension by Natizyskunk, including profiles and multiple servers.
- **SFTP, FTPS and FTP.** Password, private key or SSH agent for SFTP. Explicit or implicit TLS for FTPS.

## A quick tour

### Your server, in a side panel

Click the **server icon with the pencil** in the Activity Bar. Every server from your `sftp.json` is listed; expand one to connect and browse. Click a file to open it. Right-click for **Compare with Local File**, **Download to Project**, **Copy Remote Path**, **Rename** and **Delete**. The icons next to a folder create a new file or folder in it.

![The SFTP Remote Editor panel with a server expanded, and the context menu of a file](images/marketplace/panel.png)

### No silent overwrites

VS Code checks the file on the server before it saves. When a colleague changed it in the meantime, the save is refused with *The content of the file is newer*. **Compare** shows both versions side by side, **Overwrite** saves yours anyway.

![Save refused because the file changed on the server, and the comparison of both versions](images/marketplace/conflict.png)

### Checked before anything is sent

With `"password": true` the password is asked when you connect and kept in memory for the session only. The first time you connect to a server, its SSH host key fingerprint is shown and must be confirmed before the password is sent. A key that later changes is refused.

![Password prompt and host key confirmation](images/marketplace/security.png)

### Next to your local project

**Compare with Local File** opens a diff between the file on the server and the same file in your project. Every connection and every save is logged in the Output panel under *SFTP Remote Editor*.

![Diff between the local file and the server, and the Output panel](images/marketplace/local.png)

## How it works

1. Install the extension. A server icon with a pencil appears in the Activity Bar.
2. Make sure your project has a `.vscode/sftp.json` (see below), or click **Create sftp.json** in the panel. If you use Git SFTP Upload or the SFTP extension by Natizyskunk, you already have one.
3. Expand a server, click a file, edit, save. Done.

## Configuration

A minimal `.vscode/sftp.json`:

```json
{
  "name": "My site (production)",
  "host": "example.com",
  "protocol": "sftp",
  "username": "deploy",
  "password": true,
  "remotePath": "/var/www/mysite"
}
```

Supported: `name`, `host`, `port`, `username`, `password`, `privateKeyPath`, `passphrase`, `agent`, `remotePath`, `context`, `connectTimeout`, `profiles`, and an array of configs. Each profile is shown as a separate server. `context` is the local folder that corresponds to `remotePath`, used by **Compare with Local File** and **Download to Project**.

Protocols:

- `"protocol": "sftp"` (default): SFTP over SSH, with password, private key or agent authentication.
- `"protocol": "ftp"`: FTPS with explicit TLS on port 21 by default. `"secure": "implicit"` uses implicit FTPS on port 990. `"secureOptions"` is passed to Node's TLS connection. Unencrypted FTP is only used with an explicit `"secure": false`.

Settings:

- `sftpRemoteEditor.configFile`: alternative path to the config (default `.vscode/sftp.json`).
- `sftpRemoteEditor.idleDisconnectMinutes`: close a connection after this many idle minutes (default `10`, `0` keeps it open). It reconnects when needed.

## Security

- **Host key verification (SFTP).** The server's SSH host key is checked against `~/.ssh/known_hosts`. Unknown hosts are shown once with their fingerprint and must be confirmed before the password is sent; the key is then remembered. A key that no longer matches is refused. Use **SFTP Remote: Forget Trusted Host Keys** if a server key was changed on purpose.
- **Encrypted by default (FTP).** `"protocol": "ftp"` means FTPS with certificate verification. Plain FTP requires `"secure": false` and is flagged in the Output panel.
- **No passwords on disk.** With `"password": true` the password is asked when needed and kept in memory for the session only. A plaintext password in `sftp.json` is flagged in the Output panel.
- **Permissions are kept.** Saving over SFTP overwrites the file in place without changing its mode, so a file never becomes world-writable by being edited.
- **Trusted workspaces only.** The extension stays disabled in Restricted Mode, because the workspace itself decides which servers it connects to.

## FAQ

**Is a saved file really live right away?**
Yes. Save writes the file on the server, outside git. Use it to inspect files or for an urgent fix, and put that fix in your repository afterwards.

**How is this different from the Remote Explorer of the SFTP extension?**
Its *Edit in Local* downloads the file into your project and uploads it again when you save. SFTP Remote Editor opens the file from the server itself; nothing is written to your project unless you choose **Download to Project**.

**Why not Remote - SSH?**
Remote - SSH connects the whole window to the server and installs a VS Code server there, which needs shell access. SFTP Remote Editor works next to your local project, over plain SFTP or FTPS, without installing anything on the server.

**Does it work together with Git SFTP Upload?**
Yes. Both read the same `sftp.json`. Use Git SFTP Upload to deploy what you changed in git, and SFTP Remote Editor to look at or fix a file on the server.

**Does it notice files that others add on the server?**
The server is not watched. Use **Refresh** in the panel to reload a folder.

**Does it work with Cursor or VSCodium?**
Yes, install it from [Open VSX](https://open-vsx.org/extension/delta-solutions/sftp-remote-editor).

## Publisher

[Delta Solutions](https://www.deltasolutions.be/). Source on [GitHub](https://github.com/dietercoopman/sftp-remote-editor); issues and ideas are welcome there.
