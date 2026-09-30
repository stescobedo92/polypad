//! Journal of unsaved work, restored on the next start ("hot exit").
//!
//! ```text
//! recovery/
//!   session.json            open tabs in order, and the active one
//!   buffers/<buffer id>.json one snapshot per tab with unsaved changes
//! ```
//!
//! Every file is written atomically. Loading never drops a snapshot: buffers the session does not
//! list (a crash between two writes) come back as extra tabs, and unreadable files are moved
//! aside instead of deleted. See docs/adr/0007.

use std::{
    collections::BTreeMap,
    fs, io,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;

use crate::{atomic_fs, ppad::Document, scripts::path::ScriptPath, scripts::store::ContentStamp};

const SESSION_FILE: &str = "session.json";
const BUFFERS_DIR: &str = "buffers";
const SNAPSHOT_EXTENSION: &str = ".json";

/// Version of the journal's files.
pub const JOURNAL_VERSION: u32 = 1;

/// Longest accepted buffer id.
pub const MAX_BUFFER_ID_LEN: usize = 64;

/// Identifier of an editor buffer; also the name of its snapshot file, hence the strict
/// alphabet (ASCII letters, digits and `-`).
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type), specta(transparent))]
#[serde(try_from = "String", into = "String")]
pub struct BufferId(String);

/// The id is empty, too long or uses characters outside `[A-Za-z0-9-]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("buffer ids use 1 to {MAX_BUFFER_ID_LEN} ASCII letters, digits or dashes")]
pub struct InvalidBufferId;

/// Open tabs, in order.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct Session {
    /// Tabs from left to right.
    pub tabs: Vec<SessionTab>,
    /// The focused tab.
    pub active: Option<BufferId>,
}

/// A tab in the session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct SessionTab {
    /// The tab's buffer.
    pub buffer_id: BufferId,
    /// The script it edits; `None` for an untitled script.
    pub path: Option<ScriptPath>,
}

/// Unsaved state of one buffer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct BufferSnapshot {
    /// The script it edits; `None` for an untitled script.
    pub path: Option<ScriptPath>,
    /// Stamp of the file when the buffer last matched it; `None` if it never existed.
    pub base_stamp: Option<ContentStamp>,
    /// The unsaved document.
    pub document: Document,
    /// When the snapshot was taken, in milliseconds since the Unix epoch.
    // A JavaScript number holds any millisecond timestamp exactly (below 2^53).
    #[cfg_attr(feature = "specta", specta(type = f64))]
    pub updated_at: u64,
}

/// Identity of a scripts folder (a hash of its canonical path), recorded next to journaled work
/// so a buffer is never saved into a different folder that happens to hold the same path.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct FolderId(String);

impl FolderId {
    /// Identity of the scripts folder at `root` (a canonical path).
    #[must_use]
    pub fn of(root: &Path) -> Self {
        Self(
            blake3::hash(root.to_string_lossy().as_bytes())
                .to_hex()
                .to_string(),
        )
    }
}

/// A tab to reopen.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct RecoveredTab {
    /// The tab's buffer.
    pub buffer_id: BufferId,
    /// The script it edits; `None` for an untitled script, or for work detached from a scripts
    /// folder that is not open now.
    pub path: Option<ScriptPath>,
    /// Set when the buffer edited this script in another scripts folder: it comes back untitled,
    /// so it can only be saved under a new name, never over an unrelated file.
    pub previous_path: Option<ScriptPath>,
    /// Unsaved changes; `None` when the tab was clean and should be reloaded from disk.
    pub snapshot: Option<BufferSnapshot>,
}

/// What the journal holds after a restart.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct RecoveredSession {
    /// Session tabs in order, then buffers the session did not list, oldest first.
    pub tabs: Vec<RecoveredTab>,
    /// The focused tab, if it was recovered.
    pub active: Option<BufferId>,
}

/// Why the journal cannot be used.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum RecoveryError {
    /// A journal file or folder cannot be read or written.
    #[error("the recovery journal is not accessible")]
    Io(#[from] io::Error),
    /// A snapshot could not be encoded.
    #[error("the recovery journal could not encode a snapshot")]
    Encode(#[from] serde_json::Error),
}

/// The recovery journal in one folder.
#[derive(Debug)]
pub struct RecoveryJournal {
    dir: PathBuf,
}

impl BufferId {
    /// Validates an id.
    ///
    /// # Errors
    ///
    /// [`InvalidBufferId`] when it is empty, too long or has other characters.
    pub fn new(id: &str) -> Result<Self, InvalidBufferId> {
        let valid = !id.is_empty()
            && id.len() <= MAX_BUFFER_ID_LEN
            && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-');
        if valid {
            Ok(Self(id.to_owned()))
        } else {
            Err(InvalidBufferId)
        }
    }

    /// The id as text.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for BufferId {
    type Error = InvalidBufferId;

    fn try_from(id: String) -> Result<Self, Self::Error> {
        Self::new(&id)
    }
}

impl From<BufferId> for String {
    fn from(id: BufferId) -> Self {
        id.0
    }
}

impl RecoveryJournal {
    /// Opens the journal in `dir`, creating it when missing.
    ///
    /// # Errors
    ///
    /// Fails when the folder cannot be created.
    pub fn open(dir: &Path) -> Result<Self, RecoveryError> {
        fs::create_dir_all(dir.join(BUFFERS_DIR))?;
        Ok(Self {
            dir: dir.to_owned(),
        })
    }

    /// Reads the session and every snapshot.
    ///
    /// Work recorded for a scripts folder other than `current` (or while none was open) comes
    /// back detached; clean tabs of another folder are dropped, as they hold nothing to lose.
    ///
    /// # Errors
    ///
    /// Fails only when the journal folder itself cannot be read; unreadable files are moved
    /// aside and reported in the log.
    pub fn load(&self, current: Option<&FolderId>) -> Result<RecoveredSession, RecoveryError> {
        let (session, session_folder) =
            read_versioned::<Session>(&self.dir.join(SESSION_FILE)).unwrap_or_default();
        let mut snapshots = self.read_snapshots()?;
        let belongs = |folder: Option<&FolderId>| current.is_some() && folder == current;

        let mut tabs: Vec<RecoveredTab> = session
            .tabs
            .into_iter()
            .filter_map(|tab| {
                let snapshot = snapshots.remove(&tab.buffer_id);
                match snapshot {
                    Some((snapshot, folder)) => {
                        Some(restore(tab.buffer_id, snapshot, belongs(folder.as_ref())))
                    }
                    // A clean tab only matters in the folder it was opened from.
                    None if tab.path.is_none() || belongs(session_folder.as_ref()) => {
                        Some(RecoveredTab {
                            buffer_id: tab.buffer_id,
                            path: tab.path,
                            previous_path: None,
                            snapshot: None,
                        })
                    }
                    None => None,
                }
            })
            .collect();

        let mut orphans: Vec<_> = snapshots.into_iter().collect();
        orphans.sort_by(|(a_id, (a, _)), (b_id, (b, _))| {
            a.updated_at.cmp(&b.updated_at).then_with(|| a_id.cmp(b_id))
        });
        tabs.extend(
            orphans
                .into_iter()
                .map(|(id, (snapshot, folder))| restore(id, snapshot, belongs(folder.as_ref()))),
        );

        let active = session
            .active
            .filter(|active| tabs.iter().any(|tab| &tab.buffer_id == active));
        Ok(RecoveredSession { tabs, active })
    }

    /// Records the open tabs.
    ///
    /// `folder` is the scripts folder the tabs' paths belong to.
    ///
    /// # Errors
    ///
    /// Fails when the session file cannot be written.
    pub fn set_session(
        &self,
        session: &Session,
        folder: Option<&FolderId>,
    ) -> Result<(), RecoveryError> {
        write_versioned(&self.dir.join(SESSION_FILE), session, folder)
    }

    /// Records the unsaved state of a buffer, replacing its previous snapshot.
    ///
    /// `folder` is the scripts folder the snapshot's path belongs to.
    ///
    /// # Errors
    ///
    /// Fails when the snapshot cannot be written.
    pub fn put_buffer(
        &self,
        id: &BufferId,
        snapshot: &BufferSnapshot,
        folder: Option<&FolderId>,
    ) -> Result<(), RecoveryError> {
        write_versioned(&self.snapshot_path(id), snapshot, folder)
    }

    /// Forgets a buffer's snapshot (it was saved, reverted or closed); a missing one is fine.
    ///
    /// # Errors
    ///
    /// Fails when the snapshot exists but cannot be removed.
    pub fn discard_buffer(&self, id: &BufferId) -> Result<(), RecoveryError> {
        match fs::remove_file(self.snapshot_path(id)) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error.into()),
            _ => Ok(()),
        }
    }

    fn snapshot_path(&self, id: &BufferId) -> PathBuf {
        self.dir
            .join(BUFFERS_DIR)
            .join(format!("{}{SNAPSHOT_EXTENSION}", id.0))
    }

    /// Every readable snapshot with the folder it belongs to, keyed by buffer.
    fn read_snapshots(
        &self,
    ) -> Result<BTreeMap<BufferId, (BufferSnapshot, Option<FolderId>)>, RecoveryError> {
        let mut snapshots = BTreeMap::new();
        for entry in fs::read_dir(self.dir.join(BUFFERS_DIR))? {
            let entry = entry?;
            // Files moved aside, or not written by the journal, do not parse as ids.
            let id = entry
                .file_name()
                .to_str()
                .and_then(|name| name.strip_suffix(SNAPSHOT_EXTENSION))
                .and_then(|stem| BufferId::new(stem).ok());
            if let Some(id) = id
                && let Some(snapshot) = read_versioned(&entry.path())
            {
                snapshots.insert(id, snapshot);
            }
        }
        Ok(snapshots)
    }
}

/// Turns a snapshot into a tab, detaching it from a scripts folder it no longer belongs to.
fn restore(buffer_id: BufferId, mut snapshot: BufferSnapshot, belongs: bool) -> RecoveredTab {
    if belongs || snapshot.path.is_none() {
        return RecoveredTab {
            buffer_id,
            path: snapshot.path.clone(),
            previous_path: None,
            snapshot: Some(snapshot),
        };
    }
    let previous_path = snapshot.path.take();
    snapshot.base_stamp = None;
    RecoveredTab {
        buffer_id,
        path: None,
        previous_path,
        snapshot: Some(snapshot),
    }
}

/// A journal file: its format version and scripts folder next to the data.
#[derive(Serialize, Deserialize)]
struct Versioned<T> {
    version: u32,
    #[serde(default)]
    folder: Option<FolderId>,
    #[serde(flatten)]
    data: T,
}

fn write_versioned<T: Serialize>(
    path: &Path,
    data: &T,
    folder: Option<&FolderId>,
) -> Result<(), RecoveryError> {
    let json = serde_json::to_vec(&Versioned {
        version: JOURNAL_VERSION,
        folder: folder.cloned(),
        data,
    })?;
    atomic_fs::write(path, &json)?;
    Ok(())
}

/// Reads a journal file and the folder it belongs to; `None` when it is missing, unreadable
/// (then moved aside) or written by a newer version (then left for that version, whatever its
/// layout).
fn read_versioned<T: DeserializeOwned>(path: &Path) -> Option<(T, Option<FolderId>)> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return None,
        Err(error) => {
            tracing::warn!(file = %display_name(path), %error, "cannot read a recovery file");
            return None;
        }
    };
    let parsed = serde_json::from_str::<Value>(&text).and_then(|value| {
        let version = value.get("version").and_then(Value::as_u64).unwrap_or(0);
        if version > u64::from(JOURNAL_VERSION) {
            return Ok(None);
        }
        serde_json::from_value::<Versioned<T>>(value).map(Some)
    });
    match parsed {
        Ok(Some(file)) => Some((file.data, file.folder)),
        Ok(None) => {
            tracing::warn!(
                file = %display_name(path),
                "skipping a recovery file written by a newer PolyPad"
            );
            None
        }
        Err(error) => {
            tracing::warn!(file = %display_name(path), %error, "moving aside an unreadable recovery file");
            move_aside(path);
            None
        }
    }
}

/// Renames an unreadable file so it is kept but not read again.
fn move_aside(path: &Path) {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis());
    let aside = path.with_file_name(format!("{}.unreadable-{millis}", display_name(path)));
    if let Err(error) = fs::rename(path, &aside) {
        tracing::warn!(file = %display_name(path), %error, "cannot move an unreadable recovery file aside");
    }
}

fn display_name(path: &Path) -> String {
    path.file_name()
        .map_or_else(String::new, |name| name.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use std::path::Path;

    use super::{
        BufferId, BufferSnapshot, FolderId, InvalidBufferId, RecoveredSession, RecoveredTab,
        RecoveryJournal, Session, SessionTab,
    };
    use crate::{
        language::Language,
        ppad::{Document, Header, Newline},
        scripts::{path::ScriptPath, store::ContentStamp},
    };

    fn id(raw: &str) -> BufferId {
        BufferId::new(raw).unwrap()
    }

    fn snapshot(path: Option<&str>, code: &str, updated_at: u64) -> BufferSnapshot {
        BufferSnapshot {
            path: path.map(|p| ScriptPath::new(p).unwrap()),
            base_stamp: path.map(|_| ContentStamp::of(b"on disk")),
            document: Document {
                header: Header::new(Language::Go),
                code: code.to_owned(),
                newline: Newline::Lf,
            },
            updated_at,
        }
    }

    fn tab(buffer: &str, path: Option<&str>) -> SessionTab {
        SessionTab {
            buffer_id: id(buffer),
            path: path.map(|p| ScriptPath::new(p).unwrap()),
        }
    }

    fn home() -> FolderId {
        FolderId::of(Path::new("/scripts/home"))
    }

    fn usb() -> FolderId {
        FolderId::of(Path::new("/scripts/usb"))
    }

    fn journal() -> (tempfile::TempDir, RecoveryJournal) {
        let temp = tempfile::tempdir().unwrap();
        let journal = RecoveryJournal::open(&temp.path().join("recovery")).unwrap();
        (temp, journal)
    }

    #[test]
    fn buffer_ids_cannot_name_other_files() {
        for valid in [
            "b1",
            "0f8b2c1e-7d3a-4e5f-9a6b-1c2d3e4f5a6b",
            &"a".repeat(64),
        ] {
            assert_eq!(BufferId::new(valid).unwrap().as_str(), valid);
        }
        for invalid in [
            "",
            "../session",
            "a/b",
            "a\\b",
            "a.json",
            "é",
            &"a".repeat(65),
        ] {
            assert_eq!(BufferId::new(invalid), Err(InvalidBufferId), "{invalid:?}");
        }
    }

    #[test]
    fn an_empty_journal_restores_nothing() {
        let (_temp, journal) = journal();

        assert_eq!(
            journal.load(Some(&home())).unwrap(),
            RecoveredSession::default()
        );
    }

    #[test]
    fn restores_tabs_in_order_with_their_unsaved_changes() {
        let (_temp, journal) = journal();
        journal
            .set_session(
                &Session {
                    tabs: vec![
                        tab("a", Some("orders.ppad")),
                        tab("b", None),
                        tab("c", Some("q.ppad")),
                    ],
                    active: Some(id("b")),
                },
                Some(&home()),
            )
            .unwrap();
        journal
            .put_buffer(&id("b"), &snapshot(None, "untitled work", 5), Some(&home()))
            .unwrap();
        journal
            .put_buffer(
                &id("c"),
                &snapshot(Some("q.ppad"), "edited", 6),
                Some(&home()),
            )
            .unwrap();

        let recovered = journal.load(Some(&home())).unwrap();

        assert_eq!(
            recovered,
            RecoveredSession {
                tabs: vec![
                    RecoveredTab {
                        buffer_id: id("a"),
                        path: Some(ScriptPath::new("orders.ppad").unwrap()),
                        previous_path: None,
                        snapshot: None,
                    },
                    RecoveredTab {
                        buffer_id: id("b"),
                        path: None,
                        previous_path: None,
                        snapshot: Some(snapshot(None, "untitled work", 5)),
                    },
                    RecoveredTab {
                        buffer_id: id("c"),
                        path: Some(ScriptPath::new("q.ppad").unwrap()),
                        previous_path: None,
                        snapshot: Some(snapshot(Some("q.ppad"), "edited", 6)),
                    },
                ],
                active: Some(id("b")),
            }
        );
    }

    #[test]
    fn a_newer_snapshot_replaces_the_previous_one() {
        let (_temp, journal) = journal();
        journal
            .set_session(
                &Session {
                    tabs: vec![tab("a", None)],
                    active: None,
                },
                Some(&home()),
            )
            .unwrap();
        journal
            .put_buffer(&id("a"), &snapshot(None, "first", 1), Some(&home()))
            .unwrap();
        journal
            .put_buffer(&id("a"), &snapshot(None, "second", 2), Some(&home()))
            .unwrap();

        let tabs = journal.load(Some(&home())).unwrap().tabs;

        assert_eq!(tabs[0].snapshot, Some(snapshot(None, "second", 2)));
    }

    #[test]
    fn discarded_buffers_come_back_clean() {
        let (_temp, journal) = journal();
        journal
            .set_session(
                &Session {
                    tabs: vec![tab("a", Some("a.ppad"))],
                    active: None,
                },
                Some(&home()),
            )
            .unwrap();
        journal
            .put_buffer(&id("a"), &snapshot(Some("a.ppad"), "x", 1), Some(&home()))
            .unwrap();

        journal.discard_buffer(&id("a")).unwrap();
        journal.discard_buffer(&id("never-written")).unwrap();

        assert_eq!(journal.load(Some(&home())).unwrap().tabs[0].snapshot, None);
    }

    #[test]
    fn buffers_the_session_does_not_list_come_back_as_extra_tabs() {
        let (_temp, journal) = journal();
        journal
            .set_session(
                &Session {
                    tabs: vec![tab("listed", None)],
                    active: Some(id("gone")),
                },
                Some(&home()),
            )
            .unwrap();
        journal
            .put_buffer(
                &id("late"),
                &snapshot(Some("late.ppad"), "late", 20),
                Some(&home()),
            )
            .unwrap();
        journal
            .put_buffer(&id("early"), &snapshot(None, "early", 10), Some(&home()))
            .unwrap();

        let recovered = journal.load(Some(&home())).unwrap();

        let order: Vec<_> = recovered
            .tabs
            .iter()
            .map(|t| t.buffer_id.as_str())
            .collect();
        assert_eq!(order, ["listed", "early", "late"]);
        assert_eq!(
            recovered.tabs[2].path,
            Some(ScriptPath::new("late.ppad").unwrap())
        );
        assert_eq!(recovered.active, None);
    }

    #[test]
    fn unsaved_work_from_another_scripts_folder_comes_back_detached() {
        let (_temp, journal) = journal();
        journal
            .set_session(
                &Session {
                    tabs: vec![
                        tab("a", Some("orders.ppad")),
                        tab("b", Some("clean.ppad")),
                        tab("c", None),
                    ],
                    active: Some(id("a")),
                },
                Some(&usb()),
            )
            .unwrap();
        journal
            .put_buffer(
                &id("a"),
                &snapshot(Some("orders.ppad"), "unsaved", 1),
                Some(&usb()),
            )
            .unwrap();
        journal
            .put_buffer(&id("c"), &snapshot(None, "draft", 2), Some(&usb()))
            .unwrap();

        let recovered = journal.load(Some(&home())).unwrap();

        let mut detached = snapshot(Some("orders.ppad"), "unsaved", 1);
        detached.path = None;
        detached.base_stamp = None;
        assert_eq!(
            recovered.tabs,
            vec![
                RecoveredTab {
                    buffer_id: id("a"),
                    path: None,
                    previous_path: Some(ScriptPath::new("orders.ppad").unwrap()),
                    snapshot: Some(detached),
                },
                RecoveredTab {
                    buffer_id: id("c"),
                    path: None,
                    previous_path: None,
                    snapshot: Some(snapshot(None, "draft", 2)),
                },
            ]
        );
        assert_eq!(recovered.active, Some(id("a")));
    }

    #[test]
    fn without_a_scripts_folder_every_script_tab_is_detached_or_dropped() {
        let (_temp, journal) = journal();
        journal
            .set_session(
                &Session {
                    tabs: vec![tab("a", Some("a.ppad")), tab("b", Some("b.ppad"))],
                    active: None,
                },
                Some(&home()),
            )
            .unwrap();
        journal
            .put_buffer(&id("a"), &snapshot(Some("a.ppad"), "x", 1), Some(&home()))
            .unwrap();

        let recovered = journal.load(None).unwrap();

        assert_eq!(recovered.tabs.len(), 1);
        assert_eq!(recovered.tabs[0].path, None);
        assert_eq!(
            recovered.tabs[0].previous_path,
            Some(ScriptPath::new("a.ppad").unwrap())
        );
    }

    #[test]
    fn files_from_a_newer_journal_are_left_in_place() {
        let (temp, journal) = journal();
        let buffers = temp.path().join("recovery").join("buffers");
        let newer = r#"{"version":9,"payload":{"completely":"different"}}"#;
        fs::write(buffers.join("future.json"), newer).unwrap();

        let recovered = journal.load(Some(&home())).unwrap();

        assert!(recovered.tabs.is_empty());
        assert_eq!(
            fs::read_to_string(buffers.join("future.json")).unwrap(),
            newer
        );
    }

    #[test]
    fn a_corrupt_session_still_restores_every_snapshot() {
        let (temp, journal) = journal();
        journal
            .put_buffer(&id("a"), &snapshot(None, "keep me", 1), Some(&home()))
            .unwrap();
        fs::write(
            temp.path().join("recovery").join("session.json"),
            "{ not json",
        )
        .unwrap();

        let recovered = journal.load(Some(&home())).unwrap();

        assert_eq!(recovered.tabs.len(), 1);
        assert_eq!(
            recovered.tabs[0].snapshot,
            Some(snapshot(None, "keep me", 1))
        );
    }

    #[test]
    fn an_unreadable_snapshot_is_moved_aside_not_deleted() {
        let (temp, journal) = journal();
        journal
            .set_session(
                &Session {
                    tabs: vec![tab("bad", None), tab("good", None)],
                    active: None,
                },
                Some(&home()),
            )
            .unwrap();
        journal
            .put_buffer(&id("good"), &snapshot(None, "fine", 1), Some(&home()))
            .unwrap();
        let buffers = temp.path().join("recovery").join("buffers");
        fs::write(buffers.join("bad.json"), "garbage").unwrap();

        let recovered = journal.load(Some(&home())).unwrap();

        assert_eq!(recovered.tabs[0].snapshot, None);
        assert_eq!(recovered.tabs[1].snapshot, Some(snapshot(None, "fine", 1)));
        assert!(!buffers.join("bad.json").exists());
        let kept: Vec<_> = fs::read_dir(&buffers)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .filter(|name| name.starts_with("bad"))
            .collect();
        assert_eq!(kept.len(), 1, "{kept:?}");
        assert_eq!(
            fs::read_to_string(buffers.join(&kept[0])).unwrap(),
            "garbage"
        );
        // Moved aside once: the next load does not find it again.
        assert_eq!(journal.load(Some(&home())).unwrap().tabs.len(), 2);
    }
}
