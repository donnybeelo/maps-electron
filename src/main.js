import { app, BrowserWindow, Menu, MenuItem, clipboard, dialog, ipcMain, nativeTheme, shell } from "electron";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import dbus from "dbus-next";
import { googleLocate } from "./geolocate.js";

const APP_ID = "net.donnybeelo.Maps";
const URL = "https://www.google.com/maps";
const ASSETS = path.join(import.meta.dirname, "..", "assets").replace("app.asar", "app.asar.unpacked");
const PORTAL = ["--session", "--dest", "org.freedesktop.portal.Desktop", "--object-path", "/org/freedesktop/portal/desktop"];
const IN_APP = /^https:\/\/(www\.google\.[a-z.]+\/maps|maps\.google\.[a-z.]+|consent\.google\.com)(\/|$|\?)/;
const SIGN_IN = /^https:\/\/accounts\.google\.com\//;
const BAR_HEIGHT = 72;

app.setPath("userData", path.join(app.getPath("appData"), APP_ID));
app.setDesktopName(`${APP_ID}.desktop`);
app.userAgentFallback = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome.split(".")[0]}.0.0.0 Safari/537.36`;

if (!app.requestSingleInstanceLock()) {
	app.quit();
	process.exit(0);
}

const STATE = path.join(app.getPath("userData"), "window.json");
const KEY_FILE = path.join(app.getPath("userData"), "geolocation-key");
const overlay = { color: "rgba(0, 0, 0, 0)", height: BAR_HEIGHT };
let win, location, geoCache;

// Google Geolocation API key, from the environment or a file in the app's data dir
function geolocationKey() {
	if (process.env.GOOGLE_GEOLOCATION_KEY) return process.env.GOOGLE_GEOLOCATION_KEY.trim();
	try {
		return fs.readFileSync(KEY_FILE, "utf8").trim() || null;
	} catch {
		return null;
	}
}

async function sendLocation() {
	const key = geolocationKey();
	if (!key) {
		if (location?.last) win.webContents.send("location", location.last);
		return startLocation();
	}
	if (geoCache && Date.now() - geoCache.timestamp < 300000) return win.webContents.send("location", { position: geoCache });
	try {
		geoCache = await googleLocate(key);
		win.webContents.send("location", { position: geoCache });
	} catch (e) {
		console.error("Google geolocation failed:", e.message);
		if (location?.last) win.webContents.send("location", location.last);
		startLocation();
	}
}

// Window buttons fill the page's top bar, scaled with the page zoom, with
// black or white symbols to suit the bar's colour
function setTitleBar(color, height) {
	const [r, g, b] = color.match(/[\d.]+/g).map(Number);
	const linear = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
	const luminance = 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
	overlay.symbolColor = luminance > 0.4 ? "#000000" : "#ffffff";
	overlay.height = Math.round(height * win.webContents.getZoomFactor());
	win.setTitleBarOverlay(overlay);
}

function loadState() {
	try {
		return JSON.parse(fs.readFileSync(STATE, "utf8"));
	} catch {
		return { width: 1300, height: 850, maximized: false };
	}
}

function saveState() {
	const { width, height } = win.getNormalBounds();
	fs.writeFileSync(STATE, JSON.stringify({ width, height, maximized: win.isMaximized(), overlayHeight: overlay.height }));
}

// Location from the desktop portal (GeoClue), sent to the page as { position } or { error }
async function startLocation() {
	if (location) return;
	location = {};
	const send = (result) => {
		location.last = result;
		win?.webContents.send("location", result);
	};
	try {
		const bus = (location.bus = dbus.sessionBus());
		const call = (member, signature, body) => bus.call(new dbus.Message({
			destination: "org.freedesktop.portal.Desktop", path: "/org/freedesktop/portal/desktop",
			interface: "org.freedesktop.portal.Location", member, signature, body,
		}));
		await bus.call(new dbus.Message({
			destination: "org.freedesktop.DBus", path: "/org/freedesktop/DBus", interface: "org.freedesktop.DBus",
			member: "AddMatch", signature: "s", body: ["type='signal',sender='org.freedesktop.portal.Desktop'"],
		}));
		const token = `maps${process.pid}`;
		const sender = bus.name.slice(1).replaceAll(".", "_");
		const requestPath = `/org/freedesktop/portal/desktop/request/${sender}/${token}`;
		bus.on("message", (msg) => {
			if (msg.member === "Response" && msg.path === requestPath && msg.body[0] !== 0) send({ error: 1 });
			if (msg.member !== "LocationUpdated") return;
			const fix = Object.fromEntries(Object.entries(msg.body[1]).map(([k, v]) => [k, v.value]));
			const known = (v) => (v >= 0 ? v : null);
			send({
				position: {
					coords: {
						latitude: fix.Latitude, longitude: fix.Longitude, accuracy: fix.Accuracy,
						altitude: fix.Altitude > -1e300 ? fix.Altitude : null, altitudeAccuracy: null,
						heading: known(fix.Heading), speed: known(fix.Speed),
					},
					timestamp: Number(fix.Timestamp?.[0] ?? Date.now() / 1000) * 1000,
				},
			});
		});
		const session = await call("CreateSession", "a{sv}", [{
			session_handle_token: new dbus.Variant("s", token),
			accuracy: new dbus.Variant("u", 5),
		}]);
		await call("Start", "osa{sv}", [session.body[0], "", { handle_token: new dbus.Variant("s", token) }]);
	} catch (e) {
		console.error("Location portal failed:", e.message);
		send({ error: 2 });
		location = null;
	}
}

function contextMenu(params) {
	if (!params.isEditable && !params.linkURL && !params.selectionText) return;
	const menu = new Menu();
	const contents = win.webContents;
	for (const suggestion of params.dictionarySuggestions)
		menu.append(new MenuItem({ label: suggestion, click: () => contents.replaceMisspelling(suggestion) }));
	if (params.linkURL) menu.append(new MenuItem({ label: "Copy Link", click: () => clipboard.writeText(params.linkURL) }));
	const flags = params.editFlags;
	for (const [flag, role] of [["canCut", "cut"], ["canCopy", "copy"], ["canPaste", "paste"], ["canSelectAll", "selectAll"]])
		if (flags[flag] && (role !== "selectAll" || params.isEditable)) menu.append(new MenuItem({ role }));
	if (menu.items.length) menu.popup({ window: win });
}

function createWindow() {
	const state = loadState();
	if (state.overlayHeight) overlay.height = state.overlayHeight;
	win = new BrowserWindow({
		width: state.width, height: state.height, minWidth: 500, minHeight: 400,
		titleBarStyle: "hidden", titleBarOverlay: overlay, title: "Google Maps",
		icon: path.join(ASSETS, "maps-512x512.png"),
		backgroundColor: nativeTheme.shouldUseDarkColors ? "#202124" : "#ffffff",
		webPreferences: { preload: path.join(import.meta.dirname, "preload.cjs"), spellcheck: true },
	});
	if (state.maximized) win.maximize();

	const contents = win.webContents;
	const session = contents.session;

	win.on("close", saveState);
	contents.on("context-menu", (_e, params) => contextMenu(params));
	contents.on("before-input-event", (e, input) => {
		if (input.type !== "keyDown" || !input.control) return;
		const key = input.key.toLowerCase();
		const actions = {
			q: () => app.quit(),
			w: () => win.close(),
			r: () => contents.reload(),
			i: () => input.shift && contents.toggleDevTools(),
			"=": () => contents.setZoomLevel(contents.getZoomLevel() + 0.5),
			"+": () => contents.setZoomLevel(contents.getZoomLevel() + 0.5),
			"-": () => contents.setZoomLevel(contents.getZoomLevel() - 0.5),
			0: () => contents.setZoomLevel(0),
		};
		if (actions[key]) {
			actions[key]();
			e.preventDefault();
		}
	});

	contents.on("will-navigate", (e) => {
		if (!e.isMainFrame) return;
		if (SIGN_IN.test(e.url)) {
			e.preventDefault();
			signIn(e.url);
			return;
		}
		if (IN_APP.test(e.url)) return;
		e.preventDefault();
		shell.openExternal(e.url);
	});
	contents.setWindowOpenHandler(({ url }) => {
		if (SIGN_IN.test(url)) {
			signIn(url);
			return { action: "deny" };
		}
		if (url === "about:blank" || IN_APP.test(url)) return { action: "allow" };
		shell.openExternal(url);
		return { action: "deny" };
	});

	const allowed = ["geolocation", "notifications", "fullscreen", "clipboard-sanitized-write", "clipboard-read"];
	session.setPermissionRequestHandler((_c, permission, callback) => callback(allowed.includes(permission)));
	session.setPermissionCheckHandler((_c, permission) => allowed.includes(permission));

	contents.loadURL(process.argv.find((a) => IN_APP.test(a)) ?? URL);
}

function watchSetting(namespace, key, onChange) {
	const read = () => execFileSync("gdbus",
		["call", ...PORTAL, "--method", "org.freedesktop.portal.Settings.ReadOne", namespace, key], { encoding: "utf8" });
	onChange(read());
	const monitor = spawn("gdbus", ["monitor", ...PORTAL]);
	monitor.stdout.on("data", (chunk) => String(chunk).includes(`'${namespace}', '${key}'`) && onChange(read()));
	app.on("will-quit", () => monitor.kill());
}

let darkThemeSource = "";
try {
	darkThemeSource = fs.readFileSync(path.join(ASSETS, "dark-theme.js"), "utf8");
} catch (e) {
	console.error("dark-theme.js missing:", e.message);
}

app.whenReady().then(() => {
	Menu.setApplicationMenu(null);
	ipcMain.on("dark-theme-source", (e) => (e.returnValue = darkThemeSource));
	watchSetting("org.freedesktop.appearance", "color-scheme", (value) => {
		const dark = value.includes("uint32 1");
		nativeTheme.themeSource = dark ? "dark" : "light";
		win?.webContents.send("theme", dark);
	});
	createWindow();

	ipcMain.on("location", sendLocation);
	ipcMain.on("title-bar", (_e, color, height) => setTitleBar(color, height));
});

// Sign in through a WebKitGTK window (assets/signin.js) and copy its cookies into this session
let signingIn = false;
function signIn(url) {
	if (signingIn) return;
	signingIn = true;
	const child = spawn("gjs", [path.join(ASSETS, "signin.js"), path.join(app.getPath("userData"), "signin"), url]);
	let out = "";
	child.stdout.on("data", (chunk) => (out += chunk));
	child.stderr.on("data", (chunk) => process.stderr.write(chunk));
	child.on("error", (e) => {
		signingIn = false;
		dialog.showMessageBox(win, { type: "error", message: "Couldn't open the sign-in window", detail: e.message });
	});
	child.on("close", async (code) => {
		signingIn = false;
		if (code !== 0) return;
		for (const c of JSON.parse(out)) {
			await win.webContents.session.cookies.set({
				url: `https://${c.domain.replace(/^\./, "")}${c.path}`,
				name: c.name, value: c.value, path: c.path,
				domain: c.domain.startsWith(".") ? c.domain : undefined,
				secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite, expirationDate: c.expires ?? undefined,
			}).catch((e) => console.error(`cookie ${c.name} failed:`, e.message));
		}
		win.webContents.reload();
	});
}

app.on("second-instance", (_e, argv) => {
	const url = argv.find((a) => IN_APP.test(a));
	if (url) win.webContents.loadURL(url);
	if (win.isMinimized()) win.restore();
	win.show();
	win.focus();
});
app.on("window-all-closed", () => app.quit());
process.on("SIGTERM", () => app.quit());
