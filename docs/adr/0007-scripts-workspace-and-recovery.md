# ADR-0007: Scripts workspace, saving and crash recovery

- **Status:** Accepted
- **Date:** 2026-09-30
- **Amends:** ADR-0002 (error contract) and ADR-0003 (capabilities)

## Context

Phase 1 turns PolyPad into an editor of scripts that live in a folder the user owns and that
other programs (git, editors, sync clients) change too. The acceptance criteria ask to create,
rename, move, save and reopen scripts, reflect external changes, and lose no data when the app is
killed. The WebView is an untrusted boundary (ADR-0003), and file systems differ across Windows,
macOS and Linux.

## Decision

**Save model: explicit save plus a recovery journal** (chosen with the user over autosave to the
file). Ctrl+S writes the `.ppad`; unsaved buffers are journaled continuously and restored on the
next start without prompting.

- `app_local_data_dir()/recovery/` holds `session.json` (open tabs) and one snapshot per dirty
  buffer, written atomically. The UI sends snapshots with a 300 ms debounce and at most 1 s apart,
  so killing the process loses at most the last second of typing. On a normal close, Rust holds
  the first close request for up to 1 s while the UI flushes.
- Loading never drops work: snapshots the session does not list come back as extra tabs,
  unreadable files are moved aside, and files from a newer journal version are left alone.
- Buffer ids become file names, so they are restricted to `[A-Za-z0-9-]`, at most 64 characters.

**Conflict-checked saves.** A save names the state the caller expects on disk: the content
stamp (BLAKE3 of the bytes) it read, or "no file". Anything else is a conflict and the file is
left untouched. This one rule covers saving, recreating a script deleted elsewhere and keeping
local changes after a conflict (adopt the current stamp, then save). Writes go to a temporary
file in the same folder, are flushed and renamed over the target, and are retried for up to
620 ms on Windows while scanners or sync clients hold the file.

**Paths never leave Rust in absolute form.** The UI addresses entries with `ScriptPath`, relative
to the scripts root and validated with the strictest rules of the three platforms (no characters
Windows forbids, no reserved device names, no trailing dot or space, no hidden entries, at most
255 bytes per component). The store canonicalizes existing entries and refuses those whose real
location leaves the root, which covers symbolic links. The root itself is chosen only through the
native folder picker, opened from Rust. Case-only renames compare file identity, so they work on
case-insensitive file systems without overwriting another file on Linux. Deletion moves entries to
the operating system trash.

**External changes are hints.** `notify` 8.2 with `notify-debouncer-full` reports batches
(changed paths, renames paired within the root, a rescan flag). Consumers re-read what a batch
mentions and everything on a rescan; a watcher that reports errors is replaced after two seconds,
because notify can stop watching after some Windows errors and drops events when its buffer
overflows. The UI also reconciles when the window regains focus. Hidden entries (including the
temporary files of atomic writes and `.git`) never produce events. Own writes need no special
case: after a save, the tab's stamp already matches the disk.

**Nothing blocks start-up.** Preferences fall back to defaults (an invalid file is moved aside);
the configured scripts folder falls back to `Documents/PolyPad` (then `~/PolyPad`), and without a
usable folder the app still starts and asks for one; without a journal, editing works and the UI
warns that crash recovery is off.

### Amendment to ADR-0002 (error contract)

`CommandError` still never carries absolute paths, secrets or user code, but it is no longer only
`internal`: expected failures are typed (`conflict`, `notFound`, `alreadyExists`, `invalidName`,
`unsupportedDocument`, `scriptsFolderUnavailable`, `recoveryUnavailable`…) and may carry data the
UI sent (relative script paths), content stamps and fixed reason codes. Unexpected failures remain
`internal` with a log reference. The language catalogue is exported to TypeScript as the
`LANGUAGE_MODES` constant.

### Amendment to ADR-0003 (capabilities)

The main window gains one `allow-<command>` permission per workspace command. The `dialog` and
`window-state` plugins are registered but used from Rust only, so no plugin permission reaches the
WebView; `tauri-plugin-fs` is not used, because Rust file access does not go through
capabilities and the store enforces its own confinement.

## Consequences

- The core logic (`polypad-core`: `ppad`, `scripts`, `recovery`, `preferences`, `atomic_fs`) is
  tested without a WebView, including escape attempts and real file watching.
- A save can still lose an external change that lands between the stamp check and the rename (a
  window of milliseconds); locking would block other editors, so it is accepted.
- On macOS, FSEvents does not always pair renames; the tab then shows "deleted on disk" instead of
  following the file. Linux may miss files created inside a brand-new folder before it is watched;
  the folder itself is reported and re-read.
- The `trash` crate warns that its Linux implementation calls non-thread-safe `getmntent`
  functions behind a mutex; PolyPad does not call them elsewhere.
- Licences ISC and CC0-1.0 (brought by `notify`) were added to the cargo-deny allow list.
