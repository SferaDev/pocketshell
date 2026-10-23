// OSC 8 link targets come from whatever prints to the terminal, so only plain web URLs may open.
export function safeLinkUrl(text: string): string | null {
  let u: URL;
  try {
    u = new URL(text.trim());
  } catch {
    return null;
  }
  return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
}

export function openTerminalLink(_event: MouseEvent, text: string): void {
  const url = safeLinkUrl(text);
  if (url) window.open(url, "_blank", "noopener,noreferrer");
}
