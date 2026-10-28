/**
 * Anki export — the native Save dialog (FORK-ONLY, docs/fork/anki-export.md
 * A20, docs/fork/anki-export-implementation.md I9). The renderer gets the
 * file text from POST /api/anki/export {deliver:"preview"}, hands it here,
 * and commits the ledger only when this reports the file was written. A
 * cancelled dialog writes nothing and records nothing.
 *
 * The last folder is remembered in userData/anki-export.json
 * ({ lastFolder }); the first default is ~/Downloads.
 */
const fs = require("node:fs");
const path = require("node:path");
const { dialog, BrowserWindow } = require("electron");

function lastFolderFile(app) {
	return path.join(app.getPath("userData"), "anki-export.json");
}

function readLastFolder(app) {
	try {
		const folder = JSON.parse(fs.readFileSync(lastFolderFile(app), "utf-8")).lastFolder;
		if (typeof folder === "string" && fs.statSync(folder).isDirectory()) return folder;
	} catch {
		/* first export, or the folder is gone */
	}
	return app.getPath("downloads");
}

function rememberFolder(app, folder) {
	try {
		fs.writeFileSync(lastFolderFile(app), JSON.stringify({ lastFolder: folder }), "utf-8");
	} catch {
		/* remembering is best-effort */
	}
}

/**
 * @param {{ ipcMain: import("electron").IpcMain, app: import("electron").App,
 *           trusted: (event: import("electron").IpcMainInvokeEvent) => boolean }} deps
 */
function registerAnkiIpc({ ipcMain, app, trusted }) {
	ipcMain.handle("lh:anki:save", async (event, payload) => {
		if (!trusted(event)) throw new Error("Untrusted desktop request.");
		const fileName = typeof payload?.fileName === "string" ? path.basename(payload.fileName) : "";
		const text = typeof payload?.text === "string" ? payload.text : null;
		if (!fileName.endsWith(".txt") || text === null) throw new Error("Invalid Anki export.");
		const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
		const result = await dialog.showSaveDialog(win, {
			title: "Save Anki cards",
			defaultPath: path.join(readLastFolder(app), fileName),
			filters: [{ name: "Anki text import", extensions: ["txt"] }],
		});
		if (result.canceled || !result.filePath) return { saved: false };
		fs.writeFileSync(result.filePath, text, "utf-8");
		rememberFolder(app, path.dirname(result.filePath));
		return { saved: true, path: result.filePath };
	});
}

module.exports = { registerAnkiIpc };
