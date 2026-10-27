// Mismo formato que src/crypto.ts: pbkdf2$<iter>$<sal b64url>$<hash b64url> (PBKDF2-SHA256, 100 000 iteraciones).
import { pbkdf2Sync, randomBytes } from "node:crypto";

const ITERATIONS = 100_000;

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(password, salt, ITERATIONS, 32, "sha256");
  return `pbkdf2$${ITERATIONS}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export function sqlQuote(text) {
  return `'${String(text).replace(/'/g, "''")}'`;
}
