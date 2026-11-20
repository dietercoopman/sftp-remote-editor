# Changelog

## 0.2.0

- **Server colors.** Give a server a color with **Set Color...** in the panel, or `"color": "red"` in sftp.json (per server or per profile): red, orange, yellow, green, blue or purple. Its icon, its editor tabs and file names get that color, and a status bar item names the server of the active editor, on a red background for red servers.
- Settings are now resource scoped, so they can differ per folder in a multi-root workspace.

## 0.1.1

- Marketplace listing: README rewritten with a hero image and screenshots of the panel, the save conflict check, the host key check and the comparison with the local project. No functional changes.

## 0.1.0

Initial release.

- Servers panel with the folders and files of every server in `.vscode/sftp.json`.
- Files open in a normal editor and are saved straight to the server.
- Saving is refused when the file changed on the server since it was opened.
- New file, new folder, rename, delete, compare with local file, download to project, copy remote path.
- SFTP (password, private key, SSH agent, host key check), FTPS and FTP.
