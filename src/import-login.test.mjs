import assert from "node:assert";
import crypto from "node:crypto";
import { decryptCookie } from "./import-login.js";

// v10 uses the fixed password "peanuts"; same AES/KDF as v11
const key = crypto.pbkdf2Sync("peanuts", "saltysalt", 1, 16, "sha1");
const host = ".google.com";

function encrypt(plain, withHostHash) {
	const body = withHostHash
		? Buffer.concat([crypto.createHash("sha256").update(host).digest(), Buffer.from(plain)])
		: Buffer.from(plain);
	const cipher = crypto.createCipheriv("aes-128-cbc", key, Buffer.alloc(16, " "));
	return Buffer.concat([Buffer.from("v10"), cipher.update(body), cipher.final()]);
}

assert.equal(decryptCookie(key, host, encrypt("SID-value-123", false)), "SID-value-123");
assert.equal(decryptCookie(key, host, encrypt("SID-value-123", true)), "SID-value-123");
assert.equal(decryptCookie(key, host, Buffer.from("plaintext")), "plaintext");

console.log("ok");
