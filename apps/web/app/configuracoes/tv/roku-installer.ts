export function rokuInstallerUrl(value: string): string | null {
  const normalized = value.trim();
  if (!/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(normalized)) return null;

  const octets = normalized.split(".").map(Number);
  if (octets.some((octet) => octet > 255)) return null;

  const [first, second] = octets;
  const privateAddress = first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168);

  return privateAddress ? `http://${normalized}` : null;
}
