//! Reports changes that other programs make under the scripts root.
//!
//! Events are hints, not a journal: the platforms coalesce and drop them (Windows loses events
//! when its buffer overflows, macOS merges bursts), so consumers re-read what a batch mentions
//! and re-read everything when a batch asks for a rescan or the watcher fails.

use std::{io, path::Path, time::Duration};

use notify::{
    EventKind, RecommendedWatcher, RecursiveMode,
    event::{ModifyKind, RenameMode},
};
use notify_debouncer_full::{
    DebounceEventResult, DebouncedEvent, Debouncer, RecommendedCache, new_debouncer,
};
use serde::{Deserialize, Serialize};

use super::path::ScriptPath;

/// How long the watcher waits for a burst of events to settle.
pub const DEBOUNCE: Duration = Duration::from_millis(250);

/// What changed during one debounce window.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ScriptChanges {
    /// Scripts and folders created, modified or deleted, sorted and without duplicates.
    pub paths: Vec<ScriptPath>,
    /// Entries renamed or moved within the root.
    pub renamed: Vec<Renamed>,
    /// Events were lost or cannot be attributed; everything must be re-read.
    pub rescan: bool,
}

/// An entry that moved within the root.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Renamed {
    /// Previous location.
    pub from: ScriptPath,
    /// New location.
    pub to: ScriptPath,
}

/// What the watcher reports to its callback.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WatchEvent {
    /// Changes observed during one debounce window.
    Changes(ScriptChanges),
    /// The platform watcher reported errors and may have stopped watching: re-read everything
    /// and start a new watcher.
    Failed,
}

/// Why the watcher could not start.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum WatchError {
    /// The root cannot be resolved.
    #[error("the scripts folder is not accessible")]
    Root(#[source] io::Error),
    /// The platform watcher refused the root.
    #[error("the file watcher could not start")]
    Notify(#[from] notify::Error),
}

/// Watches the scripts root recursively until dropped.
pub struct ScriptWatcher {
    _debouncer: Debouncer<RecommendedWatcher, RecommendedCache>,
}

impl std::fmt::Debug for ScriptWatcher {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ScriptWatcher").finish_non_exhaustive()
    }
}

impl ScriptWatcher {
    /// Starts watching `root`; `on_event` runs on the watcher's own thread.
    ///
    /// # Errors
    ///
    /// Fails when the root cannot be resolved or the platform watcher cannot watch it.
    pub fn start<F>(root: &Path, mut on_event: F) -> Result<Self, WatchError>
    where
        F: FnMut(WatchEvent) + Send + 'static,
    {
        // Canonical like the store's root, so event paths share its prefix (macOS reports
        // `/private/var/...` for `/var/...`).
        let root = dunce::canonicalize(root).map_err(WatchError::Root)?;
        let prefix = root.clone();
        let mut debouncer =
            new_debouncer(
                DEBOUNCE,
                None,
                move |result: DebounceEventResult| match result {
                    Ok(events) => {
                        let changes = changes(&prefix, &events);
                        if !changes.is_empty() {
                            on_event(WatchEvent::Changes(changes));
                        }
                    }
                    Err(errors) => {
                        for error in &errors {
                            tracing::warn!(%error, "the file watcher reported an error");
                        }
                        on_event(WatchEvent::Failed);
                    }
                },
            )?;
        debouncer.watch(&root, RecursiveMode::Recursive)?;
        Ok(Self {
            _debouncer: debouncer,
        })
    }
}

/// Where an event path lies relative to the root.
#[derive(Debug, PartialEq, Eq)]
enum Relative {
    /// An entry a [`ScriptPath`] can name.
    Entry(ScriptPath),
    /// The root itself.
    Root,
    /// Outside the root, hidden, or a name the explorer never shows.
    Ignored,
}

impl ScriptChanges {
    /// A batch that only asks consumers to re-read everything.
    #[must_use]
    pub fn rescan() -> Self {
        Self {
            rescan: true,
            ..Self::default()
        }
    }

    /// Whether the batch carries nothing to act on.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.paths.is_empty() && self.renamed.is_empty() && !self.rescan
    }
}

fn relative(root: &Path, path: &Path) -> Relative {
    let Ok(rest) = path.strip_prefix(root) else {
        return Relative::Ignored;
    };
    let components: Option<Vec<&str>> = rest
        .components()
        .map(|component| component.as_os_str().to_str())
        .collect();
    match components {
        Some(components) if components.is_empty() => Relative::Root,
        Some(components) => {
            ScriptPath::new(&components.join("/")).map_or(Relative::Ignored, Relative::Entry)
        }
        None => Relative::Ignored,
    }
}

/// Translates one debounced batch into script paths.
fn changes(root: &Path, events: &[DebouncedEvent]) -> ScriptChanges {
    let mut changes = ScriptChanges::default();
    for event in events {
        if event.need_rescan() {
            changes.rescan = true;
            continue;
        }
        match (&event.kind, event.paths.as_slice()) {
            (EventKind::Access(_), _) => {}
            (EventKind::Modify(ModifyKind::Name(RenameMode::Both)), [from, to]) => {
                if let (Relative::Entry(from), Relative::Entry(to)) =
                    (relative(root, from), relative(root, to))
                {
                    changes.renamed.push(Renamed { from, to });
                } else {
                    // Moved in from or out to somewhere else, or to a hidden name.
                    mention(root, from, &mut changes);
                    mention(root, to, &mut changes);
                }
            }
            (_, paths) => {
                for path in paths {
                    mention(root, path, &mut changes);
                }
            }
        }
    }
    changes.paths.sort();
    changes.paths.dedup();
    changes
}

fn mention(root: &Path, path: &Path, changes: &mut ScriptChanges) {
    match relative(root, path) {
        Relative::Entry(entry) => changes.paths.push(entry),
        Relative::Root => changes.rescan = true,
        Relative::Ignored => {}
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::Path,
        sync::mpsc::{self, Receiver},
        thread,
        time::{Duration, Instant},
    };

    use super::{Relative, Renamed, ScriptChanges, ScriptWatcher, WatchEvent, relative};
    use crate::scripts::path::ScriptPath;

    fn path(raw: &str) -> ScriptPath {
        ScriptPath::new(raw).unwrap()
    }

    fn watch(root: &Path) -> (ScriptWatcher, Receiver<WatchEvent>) {
        let (sender, receiver) = mpsc::channel();
        let watcher = ScriptWatcher::start(root, move |event| {
            let _ = sender.send(event);
        })
        .unwrap();
        // Give backends that register asynchronously (FSEvents) a moment before the first change.
        thread::sleep(Duration::from_millis(200));
        (watcher, receiver)
    }

    /// Merges batches until `done` accepts them; every batch must carry something.
    fn collect_until(
        receiver: &Receiver<WatchEvent>,
        done: impl Fn(&ScriptChanges) -> bool,
    ) -> ScriptChanges {
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut all = ScriptChanges::default();
        while !done(&all) {
            let remaining = deadline.saturating_duration_since(Instant::now());
            match receiver.recv_timeout(remaining) {
                Ok(WatchEvent::Changes(batch)) => {
                    assert!(
                        !batch.paths.is_empty() || !batch.renamed.is_empty() || batch.rescan,
                        "empty batch reported"
                    );
                    all.paths.extend(batch.paths);
                    all.renamed.extend(batch.renamed);
                    all.rescan |= batch.rescan;
                }
                Ok(WatchEvent::Failed) => panic!("the watcher failed"),
                Err(error) => panic!("{error}; received {all:?}"),
            }
        }
        all
    }

    fn mentions(changes: &ScriptChanges, entry: &ScriptPath) -> bool {
        changes.paths.contains(entry)
            || changes
                .renamed
                .iter()
                .any(|r| &r.from == entry || &r.to == entry)
    }

    #[test]
    fn maps_event_paths_to_script_paths() {
        let root = Path::new("/scripts");

        assert_eq!(
            relative(root, &root.join("reports").join("q1.ppad")),
            Relative::Entry(path("reports/q1.ppad"))
        );
        assert_eq!(relative(root, root), Relative::Root);
        assert_eq!(
            relative(root, Path::new("/elsewhere/a.ppad")),
            Relative::Ignored
        );
        assert_eq!(
            relative(root, &root.join(".git").join("index")),
            Relative::Ignored
        );
        assert_eq!(
            relative(root, &root.join(".a.ppad.x7Kq2")),
            Relative::Ignored
        );
    }

    #[test]
    fn reports_scripts_other_programs_create_modify_and_delete() {
        let temp = tempfile::tempdir().unwrap();
        let (_watcher, events) = watch(temp.path());
        let script = path("a.ppad");

        fs::write(temp.path().join("a.ppad"), "one").unwrap();
        collect_until(&events, |c| mentions(c, &script));
        fs::write(temp.path().join("a.ppad"), "two").unwrap();
        collect_until(&events, |c| mentions(c, &script));
        fs::remove_file(temp.path().join("a.ppad")).unwrap();
        collect_until(&events, |c| mentions(c, &script));
    }

    #[test]
    fn reports_new_folders_and_their_scripts() {
        let temp = tempfile::tempdir().unwrap();
        let (_watcher, events) = watch(temp.path());

        fs::create_dir(temp.path().join("reports")).unwrap();
        fs::write(temp.path().join("reports").join("q1.ppad"), "x").unwrap();

        // inotify may miss files created before it watches a brand-new folder; the folder itself
        // is always reported, and consumers re-read it.
        collect_until(&events, |c| mentions(c, &path("reports")));
    }

    #[test]
    fn mentions_both_sides_of_a_rename() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("a.ppad"), "x").unwrap();
        let (_watcher, events) = watch(temp.path());

        fs::rename(temp.path().join("a.ppad"), temp.path().join("b.ppad")).unwrap();

        let changes = collect_until(&events, |c| {
            c.renamed.contains(&Renamed {
                from: path("a.ppad"),
                to: path("b.ppad"),
            }) || (c.paths.contains(&path("a.ppad")) && c.paths.contains(&path("b.ppad")))
        });
        assert!(!changes.rescan);
    }

    #[test]
    fn hidden_entries_are_never_reported() {
        let temp = tempfile::tempdir().unwrap();
        let (_watcher, events) = watch(temp.path());

        fs::create_dir(temp.path().join(".git")).unwrap();
        fs::write(temp.path().join(".git").join("index"), "x").unwrap();
        fs::write(temp.path().join(".scratch.ppad"), "x").unwrap();
        thread::sleep(Duration::from_millis(600));
        fs::write(temp.path().join("visible.ppad"), "x").unwrap();

        // collect_until rejects empty batches, which is what hidden-only batches would be.
        let changes = collect_until(&events, |c| mentions(c, &path("visible.ppad")));
        assert_eq!(changes.paths, vec![path("visible.ppad")]);
    }
}
