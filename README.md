# SFTP Remote Editor

Edit files directly on your server. Browse the server in a side panel, click a file, change it and press Save: it is written straight to the server. No local copy, no upload step.

It reads the `.vscode/sftp.json` you already have for Git SFTP Upload or the SFTP extension, so there is nothing to set up.

## Features

- **Servers panel.** Every server in `.vscode/sftp.json` appears in the SFTP Remote Editor panel in the Activity Bar, with the folders and files under its `remotePath`. Each profile in the config is listed as a separate server.
- **Edit in place.** A file opens in a normal editor, with syntax highlighting, search and everything else. Save writes it to the server. Images and other files open the same way.
- **No silent overwrites.** If someone changed the file on the server after you opened it, saving is refused with *The content of the file is newer*. You can compare both versions or overwrite on purpose.
- **Permissions stay as they are.** Saving overwrites the file in place, so its owner and permissions on the server do not change. New files get the server's default permissions.
- **File management.** New file, new folder, rename and delete (with confirmation), straight from the panel.
- **Local project.** Compare a remote file with the local file in your project, or download it into the project.
- **SFTP, FTPS and FTP.** SFTP with password, private key or SSH agent. FTPS with explicit or implicit TLS. Unencrypted FTP only when you ask for it with `"secure": false`.
- **Host key check.** SFTP host keys are checked against `~/.ssh/known_hosts`. An unknown server is only trusted after you confirm its fingerprint, and a changed key is refused.

## Getting started

1. Open a project that has a `.vscode/sftp.json`, or click **Create sftp.json** in the panel.
2. Open the **SFTP Remote Editor** panel in the Activity Bar.
3. Expand a server to connect. Click a file to open it.

A minimal `.vscode/sftp.json`:

```json
{
  "name": "Production",
  "protocol": "sftp",
  "host": "example.com",
  "port": 22,
  "username": "deploy",
  "privateKeyPath": "~/.ssh/id_ed25519",
  "remotePath": "/var/www/html"
}
```

Use `"password": true` to be asked for the password when connecting, instead of storing it in the file. A password you type is kept in memory for the session only.

The file may also be an array of configs, each with its own `context` (the local folder that corresponds to `remotePath`), and a config may have `profiles`, the same as in Git SFTP Upload.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `sftpRemoteEditor.configFile` | `.vscode/sftp.json` | Path to the config, relative to the workspace folder. |
| `sftpRemoteEditor.idleDisconnectMinutes` | `10` | Close a connection after this many idle minutes. It reconnects when needed. `0` keeps it open. |

## Good to know

- Saving changes the live server immediately. There is no undo on the server and no git history. Use it to inspect files or for an urgent fix, and put that fix in git afterwards.
- The server is not watched for changes. Use **Refresh** in the panel to see files that others added or removed.
- Over FTP, the change check depends on the times the server reports. Servers without `MLSD` or `MDTM` support report times to the minute only.

## Commands

All commands are in the panel's toolbar and context menu. In the Command Palette: **SFTP Remote: Refresh**, **SFTP Remote: Open sftp.json**, and **SFTP Remote: Forget Trusted Host Keys** (after a server key was changed on purpose).

Connection details and errors are logged in the Output panel under **SFTP Remote Editor**.
