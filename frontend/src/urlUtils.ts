/**
 * Encodes a filesystem path for use in a URL, preserving path separators
 * while encoding fragment (#), query (?), spaces, and other special characters
 * that would otherwise confuse URL parsing.
 *
 * Use this for every /thumbnails/ and /originals/ URL to handle filenames
 * that contain # or other reserved URL characters.
 */
export function encodeFilePath(path: string): string {
  return path.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/");
}

// Generated thumbnail paths repeat between profiles. Keep cache reuse inside
// one app view while preventing a newly opened profile from reusing another's images.
let mediaViewKey = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
export function setMediaCacheScope(key: string) {mediaViewKey=key;}
export function withMediaCacheScope(url: string) {
  return `${url}${url.includes("?") ? "&" : "?"}view=${mediaViewKey}`;
}
