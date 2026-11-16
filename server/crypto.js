import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

const KEY = scryptSync(config.secret, 'competitor-pulse-credentials', 32);

/** Encrypt a JSON-serialisable value with AES-256-GCM. Output: base64(iv).base64(tag).base64(ciphertext) */
export function encryptJson(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((b) => b.toString('base64')).join('.');
}

export function decryptJson(payload) {
  const [iv, tag, data] = payload.split('.').map((p) => Buffer.from(p, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8'));
}

export function sign(value) {
  return createHmac('sha256', config.secret).update(String(value)).digest('hex');
}

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Show the last 4 characters of a secret and hide the rest. */
export function mask(secret) {
  const s = String(secret ?? '');
  if (!s) return '';
  return s.length <= 6 ? '••••' : `••••••${s.slice(-4)}`;
}
