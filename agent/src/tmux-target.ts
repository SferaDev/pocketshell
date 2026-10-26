// A bare "-t name" is resolved as a window index or prefix before an exact session name,
// so a session called "0" would hit window 0 of whichever session tmux considers current.
export const sessionTarget = (name: string): string => `=${name}`;
export const paneTarget = (name: string): string => `=${name}:`;
