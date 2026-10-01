/** Extension of script files, as `polypad-core` writes it. */
const SCRIPT_EXTENSION = /\.ppad$/i;

/** A script's file name as shown to the user: without its extension. */
export function scriptTitle(fileName: string): string {
  return fileName.replace(SCRIPT_EXTENSION, "");
}

/** Last component of a path inside the scripts folder. */
export function fileNameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Folder that contains `path`; `null` for the top level. */
export function parentOf(path: string): string | null {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? null : path.slice(0, separator);
}
