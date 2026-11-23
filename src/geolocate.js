import dbus from "dbus-next";

const ENDPOINT = "https://www.googleapis.com/geolocation/v1/geolocate";
const NM = "org.freedesktop.NetworkManager";
const NM_DEVICE_TYPE_WIFI = 2;

// Shape NetworkManager access points for Google's API (Strength is a 0-100 byte)
export function toWifiAccessPoints(aps) {
	return aps
		.map((ap) => ({ macAddress: ap.hwAddress, signalStrength: Math.round(ap.strength / 2 - 100) }))
		.filter((ap) => /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(ap.macAddress));
}

// Nearby WiFi access points from NetworkManager over the system bus (works inside flatpak)
async function readAccessPoints() {
	const bus = dbus.systemBus();
	const get = async (path, iface, prop) => {
		const obj = await bus.getProxyObject(NM, path);
		return (await obj.getInterface("org.freedesktop.DBus.Properties").Get(iface, prop)).value;
	};
	try {
		const root = await bus.getProxyObject(NM, "/org/freedesktop/NetworkManager");
		const devices = await root.getInterface(NM).GetDevices();
		const out = [];
		for (const devPath of devices) {
			if ((await get(devPath, `${NM}.Device`, "DeviceType")) !== NM_DEVICE_TYPE_WIFI) continue;
			const dev = await bus.getProxyObject(NM, devPath);
			const apPaths = await dev.getInterface(`${NM}.Device.Wireless`).GetAllAccessPoints().catch(() => []);
			for (const apPath of apPaths)
				try {
					out.push({
						hwAddress: await get(apPath, `${NM}.AccessPoint`, "HwAddress"),
						strength: Number(await get(apPath, `${NM}.AccessPoint`, "Strength")),
					});
				} catch {}
		}
		return out;
	} finally {
		bus.disconnect();
	}
}

// A precise fix from Google, using the WiFi it can see. Throws if unavailable.
export async function googleLocate(key) {
	const wifiAccessPoints = toWifiAccessPoints(await readAccessPoints());
	if (wifiAccessPoints.length < 2) throw new Error("too few WiFi access points in range");
	const response = await fetch(`${ENDPOINT}?key=${key}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ considerIp: false, wifiAccessPoints }),
	});
	if (!response.ok) throw new Error(`Google geolocation ${response.status}: ${(await response.text()).slice(0, 200)}`);
	const { location, accuracy } = await response.json();
	return {
		coords: { latitude: location.lat, longitude: location.lng, accuracy, altitude: null, altitudeAccuracy: null, heading: null, speed: null },
		timestamp: Date.now(),
	};
}
