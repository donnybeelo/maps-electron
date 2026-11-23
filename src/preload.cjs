const { contextBridge, ipcRenderer, webFrame } = require("electron");

// Trackpad pinch zooms the map (via ctrl+wheel), not the whole page
webFrame.setVisualZoomLevelLimits(1, 1);

// Dark map theme: inject the shader-patching script into the page's main world at document-start,
// then follow the system colour scheme. Source lives in the main process (preload is sandboxed).
try {
	const darkSource = ipcRenderer.sendSync("dark-theme-source");
	if (darkSource) {
		const setDark = (on) => contextBridge.executeInMainWorld({ func: (d) => window.__gmDark && window.__gmDark(d), args: [!!on] });
		const inject = () => {
			contextBridge.executeInMainWorld({ func: new Function(darkSource) });
			setDark(matchMedia("(prefers-color-scheme: dark)").matches);
			ipcRenderer.on("theme", (_e, on) => setDark(on));
		};
		// Electron runs the preload before <html> exists; the script needs it for appendChild
		if (document.documentElement) inject();
		else new MutationObserver((_, obs) => { if (document.documentElement) { obs.disconnect(); inject(); } }).observe(document, { childList: true });
	}
} catch (e) {
	console.error("dark theme inject failed:", e.message);
}

// Two-finger scroll pans the map (Maps zooms on wheel by default); pinch still zooms, panels still scroll.
// A real mouse wheel is left alone so Maps zooms as normal.
// Chromium over-accelerates touchpad wheel deltas on Linux/Fedora (no flag to disable); scale toward 1:1.
const PAN_GAIN = 0.5;
function isMouseWheel(e) {
	if (e.deltaMode !== 0) return true; // line/page deltas are classic mouse wheels
	// mouse notches step in multiples of 120 with no horizontal component; trackpads are small/continuous
	return e.deltaX === 0 && e.wheelDeltaY !== 0 && Math.abs(e.wheelDeltaY) % 120 === 0;
}
function scrollablePanel(el) {
	for (; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
		const s = getComputedStyle(el);
		if (/(auto|scroll)/.test(s.overflowY + s.overflowX) && (el.scrollHeight > el.clientHeight + 4 || el.scrollWidth > el.clientWidth + 4)) return true;
	}
	return false;
}
let pan = null, panEnd;
function drag(kind, buttons) {
	const init = { bubbles: true, cancelable: true, clientX: pan.x, clientY: pan.y, button: 0, buttons, pointerId: 1, pointerType: "mouse", isPrimary: true };
	pan.target.dispatchEvent(new PointerEvent(`pointer${kind}`, init));
	pan.target.dispatchEvent(new MouseEvent(`mouse${kind}`, init));
}
window.addEventListener("wheel", (e) => {
	if (!e.isTrusted) return; // let the dark-theme script's synthetic redraw wheel reach Maps
	if (e.ctrlKey || isMouseWheel(e) || scrollablePanel(e.target)) return; // mouse wheel -> Maps zooms; panels scroll
	e.preventDefault();
	e.stopImmediatePropagation(); // keep Maps from also zooming on this wheel
	const unit = (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1) * PAN_GAIN; // -> pixels, scaled
	if (!pan) {
		pan = { target: e.target, x: e.clientX, y: e.clientY };
		drag("down", 1);
		pan.x += 10; drag("move", 1); pan.x -= 10; drag("move", 1);
	}
	pan.x -= e.deltaX * unit;
	pan.y -= e.deltaY * unit;
	drag("move", 1);
	clearTimeout(panEnd);
	panEnd = setTimeout(() => {
		drag("up", 0);
		pan = null;
	}, 120);
}, { capture: true, passive: false });

contextBridge.exposeInMainWorld("mapsDesktop", {
	startLocation: () => ipcRenderer.send("location"),
	onLocation: (callback) => ipcRenderer.on("location", (_e, result) => callback(result)),
});

// navigator.geolocation backed by the desktop portal instead of Google's network API
contextBridge.executeInMainWorld({
	func: () => {
		const { startLocation, onLocation } = window.mapsDesktop;
		const MESSAGES = { 1: "User denied Geolocation", 2: "Position unavailable", 3: "Timeout expired" };
		const watchers = new Map();
		let last, nextId = 1;

		const deliver = (result, success, failure) => {
			if (result.position) success(structuredClone(result.position));
			else failure?.({ code: result.error, message: MESSAGES[result.error], PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 });
		};
		onLocation((result) => {
			last = result;
			for (const watcher of [...watchers.values()]) watcher(result);
		});

		const geolocation = navigator.geolocation;
		geolocation.watchPosition = (success, failure) => {
			const id = nextId++;
			watchers.set(id, (result) => deliver(result, success, failure));
			if (last) setTimeout(() => watchers.get(id)?.(last));
			startLocation();
			return id;
		};
		geolocation.clearWatch = (id) => watchers.delete(id);
		geolocation.getCurrentPosition = (success, failure, options = {}) => {
			let timer;
			const id = geolocation.watchPosition((position) => {
				clearTimeout(timer);
				watchers.delete(id);
				success(position);
			}, (error) => {
				clearTimeout(timer);
				watchers.delete(id);
				failure?.(error);
			});
			if (Number.isFinite(options.timeout))
				timer = setTimeout(() => watchers.delete(id) && deliver({ error: 3 }, success, failure), options.timeout);
		};
	},
});

// A draggable top bar in the side bar's colour, behind the search box, chips and
// account button. The window buttons sit at its right end, so the chips and
// account button move left to make room.
const BAR_HEIGHT = 72;
const CORNER = 16;
const RAIL = 'ul[role=list]:has(button[aria-label="Menu"])';
const STYLE = `
@keyframes maps-fade-in { from { opacity: 0; } }
#maps-desktop-bar { position: absolute; inset: 0 0 auto 0; height: ${BAR_HEIGHT}px; z-index: 2; background: var(--maps-desktop-bar); -webkit-app-region: drag; opacity: 0; }
#maps-desktop-bar.ready { opacity: 1; animation: maps-fade-in 0.35s ease; }
#maps-desktop-bar::after {
	content: ""; position: absolute; top: 100%; left: var(--maps-desktop-rail, 72px); width: ${CORNER}px; height: ${CORNER}px; pointer-events: none;
	background: radial-gradient(circle at 100% 100%, transparent ${CORNER - 0.5}px, var(--maps-desktop-bar) ${CORNER}px);
	transition: left 0.3s ease, opacity 0.3s ease;
}
#maps-desktop-bar.no-corner::after { opacity: 0; }
:root { --buttons-width: calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw)); }
div:has(> #gb) { right: var(--buttons-width) !important; translate: 0 4px; transition: right 0.3s ease; }
div[style*="max-width: calc(100% -"] { box-sizing: border-box; padding-right: var(--buttons-width) !important; translate: 0 -1px; transition: padding-right 0.3s ease; }
[role=search] { translate: 0 -4px; }
/* Dark mode puts an invert filter on the chips wrapper, trapping its z-index below the bar; lift it back above */
html.gm-dark div:has(> div[style*="max-width: calc(100% -"]) { position: relative !important; z-index: 3 !important; }
/* The hamburger menu panel's wrapper fills the window above everything, but only its contents take clicks */
html.gm-dark .gm-flt:has([role=menuitem]) { position: absolute !important; inset: 0 !important; z-index: 30 !important; pointer-events: none; }
html.gm-dark .gm-flt:has([role=menuitem]) > * { pointer-events: auto; }
html.gm-dark img[src*="/branding/lockups/"] { filter: none !important; }.Owrmqf > :nth-child(n+2) { translate: 0 14px; -webkit-app-region: no-drag; }
:is(.Owrmqf, div:has(> #gb), div[style*="max-width: calc(100% -"], div:has(> div[style*="max-width: calc(100% -"])) { -webkit-app-region: drag; }
:is([role=search], ${RAIL} button, :is(div:has(> #gb), div[style*="max-width: calc(100% -"]) :is(button, a, input, [role=button], [role=combobox], [tabindex="0"]):not(.maps-desktop-clipped)) { -webkit-app-region: no-drag; }
html.gm-dark.gm-split .gm-flt:has(ul[role=list] button[aria-label="Menu"]) { filter: none !important; background: transparent !important; isolation: isolate; }
html.gm-dark.gm-split .gm-flt:has(ul[role=list] button[aria-label="Menu"])::before { content: ""; position: absolute; inset: 0; z-index: -1; background: rgb(30, 30, 30); }
html.gm-dark.gm-split .gm-flt:has(ul[role=list] button[aria-label="Menu"]) > * { filter: invert(0.9) hue-rotate(180deg) !important; }
html.gm-dark.gm-split ${RAIL}:not(.maps-desktop-probe) { background: transparent !important; }
`;

window.addEventListener("DOMContentLoaded", () => {
	const style = document.createElement("style");
	style.textContent = STYLE;
	document.documentElement.append(style);

	const bar = document.createElement("div");
	bar.id = "maps-desktop-bar";
	let last;
	setInterval(() => {
		const layer = document.querySelector("div:has(> div > #gb)");
		if (layer && bar.parentElement !== layer) layer.prepend(bar);
		const chips = document.querySelector('div[style*="max-width: calc(100% -"]');
		let scroller = chips?.querySelector("button");
		while (scroller && scroller !== chips && getComputedStyle(scroller).overflowX === "visible") scroller = scroller.parentElement;
		const edge = scroller?.getBoundingClientRect().right ?? Infinity;
		scroller?.querySelectorAll("button").forEach((b) => b.classList.toggle("maps-desktop-clipped", b.getBoundingClientRect().right > edge));
		const rail = document.querySelector(RAIL);
		let side = rail;
		for (let el = rail; el && el !== layer; el = el.parentElement)
			if (getComputedStyle(el).position === "absolute") side = el;
		const sideRight = side?.getBoundingClientRect().right ?? 0;
		document.documentElement.style.setProperty("--maps-desktop-rail", `${sideRight}px`);
		bar.classList.toggle("no-corner", !sideRight);
		rail?.classList.add("maps-desktop-probe");
		const color = rail && getComputedStyle(rail).backgroundColor;
		rail?.classList.remove("maps-desktop-probe");
		if (!color || color === "rgba(0, 0, 0, 0)") return;
		// In dark mode the html invert filter darkens the bar visually, but the rail's computed colour
		// stays light; the native window buttons aren't under the filter, so feed them the displayed dark.
		const dark = document.documentElement.classList.contains("gm-dark");
		const key = `${color}|${devicePixelRatio}|${dark}`;
		if (key === last) return;
		last = key;
		document.documentElement.style.setProperty("--maps-desktop-bar", color);
		bar.classList.add("ready");
		ipcRenderer.send("title-bar", dark ? "rgb(26, 26, 26)" : color, BAR_HEIGHT);
	}, 500);
});
