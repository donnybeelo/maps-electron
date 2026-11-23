// Google sign-in in a WebKitGTK window; prints the session's cookies as JSON on success.
// Exits 0 when signed in, 1 when the window is closed.
// Usage: gjs signin.js <data dir> <sign-in url>
imports.gi.versions.Gtk = "4.0";
imports.gi.versions.WebKit = "6.0";
const { Gio, Gtk, WebKit, GLib } = imports.gi;

const [dataDir, url] = ARGV;
const DONE = /^https:\/\/www\.google\.[a-z.]+\/maps/;
const SAME_SITE = ["no_restriction", "lax", "strict"];
let status = 1;

const app = new Gtk.Application({ application_id: "net.donnybeelo.Maps.SignIn", flags: Gio.ApplicationFlags.NON_UNIQUE });
app.connect("activate", () => {
	const session = WebKit.NetworkSession.new(GLib.build_filenamev([dataDir, "data"]), GLib.build_filenamev([dataDir, "cache"]));
	const view = new WebKit.WebView({ network_session: session });
	const win = new Gtk.ApplicationWindow({ application: app, title: "Sign in to Google", default_width: 480, default_height: 680, child: view });

	view.connect("decide-policy", (_v, decision, type) => {
		if (type !== WebKit.PolicyDecisionType.NAVIGATION_ACTION) return false;
		if (!DONE.test(decision.get_navigation_action().get_request().get_uri())) return false;
		decision.ignore();
		const manager = session.get_cookie_manager();
		manager.get_all_cookies(null, (_m, res) => {
			const cookies = manager.get_all_cookies_finish(res).map((c) => ({
				domain: c.get_domain(), name: c.get_name(), value: c.get_value(), path: c.get_path(),
				secure: c.get_secure(), httpOnly: c.get_http_only(),
				sameSite: SAME_SITE[c.get_same_site_policy()] ?? "unspecified",
				expires: c.get_expires()?.to_unix() ?? null,
			}));
			print(JSON.stringify(cookies));
			status = 0;
			app.quit();
		});
		return true;
	});

	view.load_uri(url);
	win.present();
});
app.run([imports.system.programInvocationName]);
imports.system.exit(status);
