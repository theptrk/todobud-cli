import { Entry } from "@napi-rs/keyring";

const SERVICE = "todobud-cli";

export interface CredentialBackend {
  get(baseUrl: string): string | null;
  set(baseUrl: string, value: string): void;
  delete(baseUrl: string): void;
}

export interface StoredCredentials {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
  scope: string;
}

function entry(baseUrl: string): Entry {
  return new Entry(SERVICE, baseUrl);
}

let backend: CredentialBackend = {
  get: (baseUrl) => entry(baseUrl).getPassword(),
  set: (baseUrl, value) => entry(baseUrl).setPassword(value),
  delete: (baseUrl) => entry(baseUrl).deletePassword(),
};

export function setCredentialBackendForTesting(value: CredentialBackend): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("The credential backend can only be replaced in tests.");
  }
  backend = value;
}

function keychainError(error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(
    `Unable to use the operating-system keychain: ${detail}. ` +
      "Configure a keychain or use TODOBUD_API_KEY for automation.",
  );
}

export function loadCredentials(baseUrl: string): StoredCredentials | null {
  try {
    const serialized = backend.get(baseUrl);
    if (!serialized) return null;
    const value = JSON.parse(serialized) as Partial<StoredCredentials>;
    if (
      typeof value.accessToken !== "string" ||
      typeof value.refreshToken !== "string" ||
      typeof value.accessExpiresAt !== "string" ||
      typeof value.scope !== "string"
    ) {
      throw new Error("stored credentials are malformed");
    }
    return value as StoredCredentials;
  } catch (error) {
    throw keychainError(error);
  }
}

export function saveCredentials(
  baseUrl: string,
  credentials: StoredCredentials,
): void {
  try {
    backend.set(baseUrl, JSON.stringify(credentials));
  } catch (error) {
    throw keychainError(error);
  }
}

export function deleteCredentials(baseUrl: string): void {
  try {
    backend.delete(baseUrl);
  } catch (error) {
    throw keychainError(error);
  }
}
