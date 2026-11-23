import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HELIUM = path.join(os.homedir(), ".config", "net.imput.helium");
const SAME_SITE = { "-1": "unspecified", 0: "no_restriction", 1: "lax", 2: "strict" };
const KEYRING_APPS = ["Helium", "helium", "chromium", "chrome"];

// Candidate Chromium keyring secrets; the right one is the one that decrypts
function keyringPasswords() {
	const out = [];
	for (const app of KEYRING_APPS)
		try {
			const secret = execFileSync("secret-tool", ["lookup", "application", app], { encoding: "utf8" });
			if (secret) out.push(secret);
		} catch {}
	return out;
}

function deriveKey(password) {
	return crypto.pbkdf2Sync(password, "saltysalt", 1, 16, "sha1");
}

// Decrypt a Chromium v10/v11 cookie. Newer builds prepend SHA256(host) to the plaintext.
export function decryptCookie(key, host, encrypted) {
	const version = encrypted.subarray(0, 3).toString();
	if (version !== "v10" && version !== "v11") return encrypted.toString("utf8");
	const decipher = crypto.createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, " "));
	let out = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
	const hostHash = crypto.createHash("sha256").update(host).digest();
	if (out.length >= 32 && out.subarray(0, 32).equals(hostHash)) out = out.subarray(32);
	return out.toString("utf8");
}

function readCookies(profile) {
	const copy = path.join(os.tmpdir(), `maps-cookies-${process.pid}`);
	fs.copyFileSync(path.join(HELIUM, profile, "Cookies"), copy);
	const json = "json_object('host',host_key,'name',name,'path',path,'secure',is_secure,'httpOnly',is_httponly,'hasExpires',has_expires,'expires',expires_utc,'samesite',samesite,'hex',hex(encrypted_value))";
	const where = "host_key like '%google.com' or host_key like '%google.co.uk' or host_key like '%youtube.com' or host_key like '%googleusercontent.com'";
	const dump = execFileSync("sqlite3", [copy, `select ${json} from cookies where ${where};`], { encoding: "utf8", maxBuffer: 64 << 20 });
	fs.unlinkSync(copy);
	return dump.split("\n").filter(Boolean).map((line) => {
		const r = JSON.parse(line);
		return {
			host: r.host, name: r.name, path: r.path, secure: r.secure === 1, httpOnly: r.httpOnly === 1,
			sameSite: SAME_SITE[r.samesite] ?? "unspecified",
			expirationDate: r.hasExpires === 1 && r.expires !== 0 ? r.expires / 1e6 - 11644473600 : undefined,
			encrypted: Buffer.from(r.hex, "hex"),
		};
	});
}

// The key whose decryption of a known Google auth cookie is printable ASCII
function pickKey(cookies) {
	const sample = cookies.find((c) => ["SAPISID", "SID", "__Secure-1PSID"].includes(c.name));
	if (!sample) throw new Error("no Google login cookies found in that profile");
	for (const password of keyringPasswords()) {
		const key = deriveKey(password);
		const value = decryptCookie(key, sample.host, sample.encrypted);
		if (value && /^[\x20-\x7e]+$/.test(value)) return key;
	}
	throw new Error("could not read Helium's keyring key (is the keyring unlocked?)");
}

// Copy a Helium profile's Google login into this app's session
export async function importLogin(session, profile = "Default") {
	const cookies = readCookies(profile);
	const key = pickKey(cookies);
	let ok = 0;
	for (const c of cookies) {
		const domainCookie = c.host.startsWith(".");
		try {
			await session.cookies.set({
				url: `https://${c.host.replace(/^\./, "")}${c.path}`,
				name: c.name, value: decryptCookie(key, c.host, c.encrypted), path: c.path,
				domain: domainCookie ? c.host : undefined,
				secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite, expirationDate: c.expirationDate,
			});
			ok++;
		} catch (e) {
			console.error(`cookie ${c.name} failed:`, e.message);
		}
	}
	console.log(`Imported ${ok}/${cookies.length} cookies from Helium ${profile}`);
	return ok;
}
