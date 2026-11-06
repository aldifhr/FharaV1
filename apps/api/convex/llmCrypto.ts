/**
 * AES-256-GCM encryption for provider API keys at rest (spec §5).
 *
 * The encryption key lives ONLY in environment variables
 * (`PROVIDER_ENCRYPTION_KEY`, base64-encoded 32 bytes) — set on the Convex
 * deployment (this side, encrypting on write) and on the worker (decrypting
 * on use). It is never stored in the database and never returned to clients.
 *
 * Ciphertext format: `v1:<iv b64>:<tag b64>:<cipher b64>`.
 * WebCrypto's AES-GCM output appends the 16-byte tag to the ciphertext; we
 * split it out so the stored format carries it explicitly.
 *
 * Decryption failure is a HARD error naming the provider — silently falling
 * back to some other credential would send requests with the wrong key and
 * hide a broken configuration (PLAN Phase 2).
 */

const FORMAT_VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function importKey(
  rawKey: string | undefined,
  envName: string,
  usages: KeyUsage[]
): Promise<CryptoKey> {
  if (!rawKey) {
    throw new Error(
      `${envName} is not configured on this deployment. Provider credential encryption is unavailable until it is set (base64-encoded 32-byte key).`
    );
  }
  let keyBytes: Uint8Array;
  try {
    keyBytes = base64ToBytes(rawKey.trim());
  } catch {
    throw new Error(`${envName} is not valid base64.`);
  }
  if (keyBytes.length !== 32) {
    throw new Error(
      `${envName} must decode to exactly 32 bytes (got ${keyBytes.length}).`
    );
  }
  return await crypto.subtle.importKey(
    "raw",
    keyBytes as BufferSource,
    { name: "AES-GCM" },
    false,
    usages
  );
}

function encryptionKey(usages: KeyUsage[]): Promise<CryptoKey> {
  return importKey(process.env.PROVIDER_ENCRYPTION_KEY, "PROVIDER_ENCRYPTION_KEY", usages);
}

/** Encrypt a plaintext API key for storage in `llmProviders.apiKeyCiphertext`. */
export async function encryptApiKey(plaintext: string): Promise<string> {
  const key = await encryptionKey(["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      new TextEncoder().encode(plaintext)
    )
  );
  const cipher = sealed.slice(0, sealed.length - TAG_BYTES);
  const tag = sealed.slice(sealed.length - TAG_BYTES);
  return [
    FORMAT_VERSION,
    bytesToBase64(iv),
    bytesToBase64(tag),
    bytesToBase64(cipher),
  ].join(":");
}

/**
 * Decrypt a stored ciphertext. Used by trusted backend code paths only
 * (chat, model discovery) — the plaintext result must never be returned to
 * a frontend query. Throws a hard error naming the provider on any failure.
 */
export async function decryptApiKey(
  ciphertext: string,
  providerName: string
): Promise<string> {
  return await decryptApiKeyWithKey(
    ciphertext,
    providerName,
    await encryptionKey(["decrypt"])
  );
}

async function decryptApiKeyWithKey(
  ciphertext: string,
  providerName: string,
  key: CryptoKey
): Promise<string> {
  const parts = ciphertext.split(":");
  if (parts.length !== 4 || parts[0] !== FORMAT_VERSION) {
    throw new Error(
      `Failed to decrypt API key for provider "${providerName}": stored credential is not in the expected ${FORMAT_VERSION} format. Re-save the provider's API key in Settings.`
    );
  }
  try {
    const iv = base64ToBytes(parts[1]);
    const tag = base64ToBytes(parts[2]);
    const cipher = base64ToBytes(parts[3]);
    const sealed = new Uint8Array(cipher.length + tag.length);
    sealed.set(cipher);
    sealed.set(tag, cipher.length);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      sealed as BufferSource
    );
    return new TextDecoder().decode(plain);
  } catch {
    throw new Error(
      `Failed to decrypt API key for provider "${providerName}": the stored credential cannot be decrypted with the configured PROVIDER_ENCRYPTION_KEY (wrong key or corrupted data). Re-save the provider's API key in Settings or fix the encryption key.`
    );
  }
}

/**
 * Credential rotation support: re-encrypt a ciphertext that was produced
 * with the OLD key (`PROVIDER_ENCRYPTION_KEY_OLD`) under the current
 * `PROVIDER_ENCRYPTION_KEY`. Used by the rotation migration; see
 * migrations.ts.
 */
export async function reEncryptApiKey(
  ciphertext: string,
  providerName: string
): Promise<string> {
  const oldKey = await importKey(
    process.env.PROVIDER_ENCRYPTION_KEY_OLD,
    "PROVIDER_ENCRYPTION_KEY_OLD",
    ["decrypt"]
  );
  const plaintext = await decryptApiKeyWithKey(ciphertext, providerName, oldKey);
  return await encryptApiKey(plaintext);
}
