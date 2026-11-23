import assert from "node:assert";
import { toWifiAccessPoints } from "./geolocate.js";

// NetworkManager AccessPoint.Strength is a 0-100 byte; Google wants dBm + a clean BSSID
const aps = toWifiAccessPoints([
	{ hwAddress: "AA:BB:CC:DD:EE:FF", strength: 72 },
	{ hwAddress: "00:11:22:33:44:55", strength: 40 },
	{ hwAddress: "", strength: 50 },
]);

assert.deepEqual(aps, [
	{ macAddress: "AA:BB:CC:DD:EE:FF", signalStrength: -64 },
	{ macAddress: "00:11:22:33:44:55", signalStrength: -80 },
]);

console.log("ok");
