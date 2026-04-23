export function cleanUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value
      .map((item) => cleanUndefined(item))
      .filter((item) => item !== undefined) as T;
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
      .map(([key, entryValue]) => [key, cleanUndefined(entryValue)]);

    return Object.fromEntries(entries) as T;
  }

  return value;
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export function unixTimestampSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function makeChatId(): string {
  return `chatcmpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}
