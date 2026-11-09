/**
 * Worker-side decryption for provider API keys (spec §5).
 *
 * Mirrors apps/api/convex/lib/llmCrypto.ts: AES-256-GCM, ciphertext format
 * `v1:<iv b64>:<tag b64>:<cipher b64>`, key from the
 * `PROVIDER_ENCRYPTION_KEY` env var (base64-encoded 32 bytes) which must be
 * set to the SAME value on the worker and the Convex deployment.
 *
 * Decryption failure is a HARD error naming the provider — never a silent
 * fallback to another credential.
 */

const FORMAT_VERSION = "v1";
const TAG_BYTES = 16;

function base64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

let cachedKey: Promise<CryptoKey> | null = null;

function encryptionKey(): Promise<CryptoKey> {
  if (!cachedKey) {
    cachedKey = (async () => {
      const raw = process.env.PROVIDER_ENCRYPTION_KEY;
      if (!raw) {
        throw new Error(
          "PROVIDER_ENCRYPTION_KEY is not set in the worker environment. Provider credentials stored encrypted cannot be decrypted until it matches the key set on the Convex deployment."
        );
      }
      const keyBytes = base64ToBytes(raw.trim());
      if (keyBytes.length !== 32) {
        throw new Error(
          `PROVIDER_ENCRYPTION_KEY must decode to exactly 32 bytes (got ${keyBytes.length}).`
        );
      }
      return await globalThis.crypto.subtle.importKey(
        "raw",
        keyBytes as Uint8Array,
        { name: "AES-GCM" },
        false,
        ["decrypt"]
      );
    })();
  }
  return cachedKey;
}

/** Test hook: forget the cached imported key (env may have changed). */
export function resetEncryptionKeyCache(): void {
  cachedKey = null;
}

export async function decryptApiKey(
  ciphertext: string,
  providerName: string
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
    const sealed = new Uint8Array(cipher.length + TAG_BYTES);
    sealed.set(cipher);
    sealed.set(tag, cipher.length);
    const key = await encryptionKey();
    const plain = await globalThis.crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as Uint8Array },
      key,
      sealed as Uint8Array
    );
    return new TextDecoder().decode(plain);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("PROVIDER_ENCRYPTION_KEY")) {
      throw error;
    }
    throw new Error(
      `Failed to decrypt API key for provider "${providerName}": the stored credential cannot be decrypted with the worker's PROVIDER_ENCRYPTION_KEY (wrong key or corrupted data). Re-save the provider's API key in Settings or fix the encryption key.`
    );
  }
}
