export function toJson(value: unknown): string {
  return JSON.stringify(value, (_key, current: unknown) =>
    typeof current === 'bigint' ? current.toString() : current,
  );
}

export function fromJson<T>(text: string): T {
  return JSON.parse(text) as T;
}
