//! Reads and writes scripts under the scripts root.
//!
//! Every operation takes [`ScriptPath`]s, which cannot name anything outside the root lexically;
//! the store also canonicalizes existing entries and refuses the ones whose real location is
//! outside the root, which defeats symbolic links pointing elsewhere. All methods block on file
//! I/O and are meant to run on a blocking thread.

use std::{
    fmt, fs, io,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use super::{
    path::{EntryName, ScriptPath},
    tree::{ScriptTree, TreeEntry},
};
use crate::{
    atomic_fs,
    ppad::{self, Document, MAX_DOCUMENT_BYTES, PpadError},
};

/// Most entries [`ScriptStore::list`] returns before reporting the tree as truncated.
pub const MAX_TREE_ENTRIES: usize = 10_000;

/// Deepest folder level listed; deeper folders are left out and the tree reported truncated.
pub const MAX_TREE_DEPTH: usize = 64;

/// Fingerprint of a script's bytes, used to notice changes made by other programs.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type), specta(transparent))]
#[serde(transparent)]
pub struct ContentStamp(String);

impl ContentStamp {
    /// Stamp of `bytes`.
    #[must_use]
    pub fn of(bytes: &[u8]) -> Self {
        Self(blake3::hash(bytes).to_hex().to_string())
    }
}

/// Where deleted entries go.
pub trait Trash: Send + Sync + fmt::Debug {
    /// Moves the file or folder at `path` to the trash.
    ///
    /// # Errors
    ///
    /// Fails when the platform trash refuses the entry.
    fn move_to_trash(&self, path: &Path) -> io::Result<()>;
}

/// The operating system's trash (Recycle Bin, Finder Trash, freedesktop Trash).
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemTrash;

impl Trash for SystemTrash {
    fn move_to_trash(&self, path: &Path) -> io::Result<()> {
        trash::delete(path).map_err(io::Error::other)
    }
}

/// A script read from disk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct LoadedScript {
    /// The script.
    pub document: Document,
    /// Loading upgraded or corrected the document, so it differs from the file.
    pub normalized: bool,
    /// Stamp of the bytes on disk.
    pub stamp: ContentStamp,
}

/// Why a store operation failed.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum ScriptError {
    /// The scripts folder cannot be created or read.
    #[error("the scripts folder is not accessible")]
    Root(#[source] io::Error),
    /// The entry does not exist.
    #[error("{0} does not exist")]
    NotFound(ScriptPath),
    /// An entry with that path already exists.
    #[error("{0} already exists")]
    AlreadyExists(ScriptPath),
    /// The script on disk is not the version the caller expected.
    #[error("{path} changed on disk")]
    Conflict {
        /// The script.
        path: ScriptPath,
        /// Stamp of what is on disk now; `None` when the file is gone.
        current: Option<ContentStamp>,
    },
    /// The path names a folder or a file without the script extension.
    #[error("{0} is not a script")]
    NotAScript(ScriptPath),
    /// The path names a script where a folder is required.
    #[error("{0} is not a folder")]
    NotAFolder(ScriptPath),
    /// A folder cannot be moved into itself or one of its subfolders.
    #[error("{0} cannot be moved into itself")]
    MoveIntoItself(ScriptPath),
    /// The entry resolves to a location outside the scripts root.
    #[error("{0} is outside the scripts folder")]
    OutsideRoot(ScriptPath),
    /// The file is not UTF-8 text.
    #[error("{0} is not UTF-8 text")]
    InvalidEncoding(ScriptPath),
    /// The document is larger than a script may be, so it could not be reopened.
    #[error("{0} is too large to be saved as a script")]
    TooLarge(ScriptPath),
    /// The file is not a valid script.
    #[error("{path} is not a valid script")]
    Document {
        /// The script.
        path: ScriptPath,
        /// What is wrong with it.
        #[source]
        source: PpadError,
    },
    /// The document could not be encoded.
    #[error("the script could not be encoded")]
    Encode(#[source] serde_json::Error),
    /// A file system operation failed.
    #[error("could not access {path}")]
    Io {
        /// The entry.
        path: ScriptPath,
        /// The cause.
        #[source]
        source: io::Error,
    },
    /// The trash refused the entry.
    #[error("{path} could not be moved to the trash")]
    Trash {
        /// The entry.
        path: ScriptPath,
        /// The cause.
        #[source]
        source: io::Error,
    },
}

/// Scripts and folders under one root folder.
#[derive(Debug)]
pub struct ScriptStore {
    /// Canonical root in its plain form (no `\\?\` prefix where avoidable): joined to script
    /// paths, shown, and handed to the trash.
    root: PathBuf,
    /// Canonical root as `std::fs::canonicalize` returns it (always `\\?\` on Windows), the
    /// form containment is checked in: `dunce` keeps that prefix for some paths (longer than
    /// 260 characters, reserved-looking names), so comparing mixed forms would fail.
    root_real: PathBuf,
    trash: Box<dyn Trash>,
}

impl ScriptStore {
    /// Opens the scripts folder at `root`, creating it when missing.
    ///
    /// # Errors
    ///
    /// [`ScriptError::Root`] when the folder cannot be created or resolved.
    pub fn open(root: &Path, trash: Box<dyn Trash>) -> Result<Self, ScriptError> {
        fs::create_dir_all(root).map_err(ScriptError::Root)?;
        Self::from_root(root, trash)
    }

    fn from_root(root: &Path, trash: Box<dyn Trash>) -> Result<Self, ScriptError> {
        let root_real = fs::canonicalize(root).map_err(ScriptError::Root)?;
        // Drops the verbatim `\\?\` form where Windows allows, since the trash's shell APIs
        // reject it.
        let root = dunce::simplified(&root_real).to_owned();
        Ok(Self {
            root,
            root_real,
            trash,
        })
    }

    /// Opens the scripts folder at `root`, which must already exist.
    ///
    /// Used for a folder the user chose earlier: recreating it empty would hide that it is gone
    /// (an unplugged drive, a folder moved elsewhere).
    ///
    /// # Errors
    ///
    /// [`ScriptError::Root`] when the folder does not exist or cannot be resolved.
    pub fn open_existing(root: &Path, trash: Box<dyn Trash>) -> Result<Self, ScriptError> {
        if !root.is_dir() {
            return Err(ScriptError::Root(io::Error::new(
                io::ErrorKind::NotFound,
                "the scripts folder does not exist",
            )));
        }
        Self::from_root(root, trash)
    }

    /// Canonical location of the scripts folder.
    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The scripts tree, at most [`MAX_TREE_ENTRIES`] entries.
    ///
    /// Skipped: files without the script extension, hidden entries, symbolic links and names
    /// that [`ScriptPath`] rejects (for example `a:b.ppad` created on Linux).
    ///
    /// # Errors
    ///
    /// [`ScriptError::Root`] when the root cannot be read.
    pub fn list(&self) -> Result<ScriptTree, ScriptError> {
        self.list_limited(MAX_TREE_ENTRIES)
    }

    fn list_limited(&self, limit: usize) -> Result<ScriptTree, ScriptError> {
        let mut walk = Walk {
            budget: limit,
            truncated: false,
        };
        let entries = walk
            .folder(&self.root, None, 0)
            .map_err(ScriptError::Root)?;
        Ok(ScriptTree {
            entries,
            truncated: walk.truncated,
        })
    }

    /// Reads and parses a script.
    ///
    /// # Errors
    ///
    /// [`ScriptError::NotFound`], [`ScriptError::NotAScript`], [`ScriptError::InvalidEncoding`],
    /// [`ScriptError::Document`] (including files above the size limit), or an I/O error.
    pub fn read(&self, path: &ScriptPath) -> Result<LoadedScript, ScriptError> {
        let full = self.existing_script(path)?;
        let metadata = fs::metadata(&full).map_err(io_error(path))?;
        let size = usize::try_from(metadata.len()).unwrap_or(usize::MAX);
        if size > MAX_DOCUMENT_BYTES {
            return Err(ScriptError::Document {
                path: path.clone(),
                source: PpadError::TooLarge {
                    size,
                    max: MAX_DOCUMENT_BYTES,
                },
            });
        }
        let bytes = fs::read(&full).map_err(io_error(path))?;
        let stamp = ContentStamp::of(&bytes);
        let text =
            String::from_utf8(bytes).map_err(|_| ScriptError::InvalidEncoding(path.clone()))?;
        let parsed = ppad::parse(&text).map_err(|source| ScriptError::Document {
            path: path.clone(),
            source,
        })?;
        Ok(LoadedScript {
            document: parsed.document,
            normalized: parsed.normalized,
            stamp,
        })
    }

    /// Stamp of the script on disk, or `None` when it does not exist.
    ///
    /// # Errors
    ///
    /// [`ScriptError::NotAScript`] or an I/O error.
    pub fn stamp(&self, path: &ScriptPath) -> Result<Option<ContentStamp>, ScriptError> {
        match self.existing_script(path) {
            Ok(full) => {
                let bytes = fs::read(full).map_err(io_error(path))?;
                Ok(Some(ContentStamp::of(&bytes)))
            }
            Err(ScriptError::NotFound(_)) => Ok(None),
            Err(error) => Err(error),
        }
    }

    /// Writes `document` to `path` if the disk still holds `expected` (`None`: no file).
    ///
    /// Returns the stamp of the written bytes.
    ///
    /// # Errors
    ///
    /// [`ScriptError::Conflict`] when the disk differs from `expected`, leaving it untouched;
    /// [`ScriptError::NotFound`] when the folder does not exist; or an I/O error.
    pub fn save(
        &self,
        path: &ScriptPath,
        document: &Document,
        expected: Option<&ContentStamp>,
    ) -> Result<ContentStamp, ScriptError> {
        if !path.is_script() {
            return Err(ScriptError::NotAScript(path.clone()));
        }
        self.folder_dir(path.parent().as_ref())?;
        // Check-then-write: a change landing between the two is overwritten. The window is a few
        // milliseconds, and the alternative (locking) would block other editors.
        let current = self.stamp(path)?;
        if current.as_ref() != expected {
            return Err(ScriptError::Conflict {
                path: path.clone(),
                current,
            });
        }
        Self::write_script(path, &self.resolve(path), document)
    }

    /// Creates a script named `name` in `parent` (the root when `None`).
    ///
    /// # Errors
    ///
    /// [`ScriptError::AlreadyExists`], [`ScriptError::NotAScript`] when the name lacks the
    /// script extension, [`ScriptError::NotFound`] when `parent` is missing, or an I/O error.
    pub fn create_script(
        &self,
        parent: Option<&ScriptPath>,
        name: &EntryName,
        document: &Document,
    ) -> Result<(ScriptPath, ContentStamp), ScriptError> {
        let path = ScriptPath::child(parent, name);
        if !path.is_script() {
            return Err(ScriptError::NotAScript(path));
        }
        let full = self.new_entry(parent, name, &path)?;
        let stamp = Self::write_script(&path, &full, document)?;
        Ok((path, stamp))
    }

    /// Creates a folder named `name` in `parent` (the root when `None`).
    ///
    /// # Errors
    ///
    /// [`ScriptError::AlreadyExists`], [`ScriptError::NotFound`] when `parent` is missing, or
    /// an I/O error.
    pub fn create_folder(
        &self,
        parent: Option<&ScriptPath>,
        name: &EntryName,
    ) -> Result<ScriptPath, ScriptError> {
        let path = ScriptPath::child(parent, name);
        let full = self.new_entry(parent, name, &path)?;
        match fs::create_dir(&full) {
            Ok(()) => Ok(path),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                Err(ScriptError::AlreadyExists(path))
            }
            Err(source) => Err(ScriptError::Io { path, source }),
        }
    }

    /// Renames a script or folder in place.
    ///
    /// Renaming to a name that only differs in case works on case-insensitive file systems.
    ///
    /// # Errors
    ///
    /// [`ScriptError::AlreadyExists`], [`ScriptError::NotFound`], [`ScriptError::NotAScript`]
    /// when a script would lose its extension, or an I/O error.
    pub fn rename(&self, path: &ScriptPath, name: &EntryName) -> Result<ScriptPath, ScriptError> {
        let full = self.existing(path)?;
        let renamed = ScriptPath::child(path.parent().as_ref(), name);
        if !full.is_dir() && !renamed.is_script() {
            return Err(ScriptError::NotAScript(renamed));
        }
        if renamed == *path {
            return Ok(renamed);
        }
        let target = self.resolve(&renamed);
        // On case-insensitive file systems a case-only rename "finds" the entry itself.
        let taken = fs::symlink_metadata(&target).is_ok()
            && !same_file::is_same_file(&full, &target).unwrap_or(false);
        if taken {
            return Err(ScriptError::AlreadyExists(renamed));
        }
        fs::rename(&full, &target).map_err(io_error(path))?;
        Ok(renamed)
    }

    /// Moves a script or folder into `folder` (the root when `None`), keeping its name.
    ///
    /// # Errors
    ///
    /// [`ScriptError::MoveIntoItself`], [`ScriptError::AlreadyExists`],
    /// [`ScriptError::NotAFolder`], [`ScriptError::NotFound`], or an I/O error.
    pub fn move_to(
        &self,
        path: &ScriptPath,
        folder: Option<&ScriptPath>,
    ) -> Result<ScriptPath, ScriptError> {
        if folder.is_some_and(|folder| folder.is_within(path)) {
            return Err(ScriptError::MoveIntoItself(path.clone()));
        }
        let full = self.existing(path)?;
        let destination = self.folder_dir(folder)?;
        let moved = path.moved_to(folder);
        if moved == *path {
            return Ok(moved);
        }
        let target = destination.join(path.name());
        if fs::symlink_metadata(&target).is_ok() {
            return Err(ScriptError::AlreadyExists(moved));
        }
        fs::rename(&full, &target).map_err(io_error(path))?;
        Ok(moved)
    }

    /// Moves a script or folder to the trash.
    ///
    /// # Errors
    ///
    /// [`ScriptError::NotFound`] or [`ScriptError::Trash`].
    pub fn delete(&self, path: &ScriptPath) -> Result<(), ScriptError> {
        let full = self.existing(path)?;
        self.trash
            .move_to_trash(&full)
            .map_err(|source| ScriptError::Trash {
                path: path.clone(),
                source,
            })
    }

    /// Where `path` lives, without touching the disk.
    fn resolve(&self, path: &ScriptPath) -> PathBuf {
        path.components()
            .fold(self.root.clone(), |full, component| full.join(component))
    }

    /// Location of an existing entry whose real location is inside the root.
    fn existing(&self, path: &ScriptPath) -> Result<PathBuf, ScriptError> {
        let full = self.resolve(path);
        match fs::canonicalize(&full) {
            Ok(real) if real.starts_with(&self.root_real) => Ok(full),
            Ok(_) => Err(ScriptError::OutsideRoot(path.clone())),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                Err(ScriptError::NotFound(path.clone()))
            }
            Err(source) => Err(ScriptError::Io {
                path: path.clone(),
                source,
            }),
        }
    }

    /// Like [`Self::existing`], but the entry must be a script file.
    fn existing_script(&self, path: &ScriptPath) -> Result<PathBuf, ScriptError> {
        if !path.is_script() {
            return Err(ScriptError::NotAScript(path.clone()));
        }
        let full = self.existing(path)?;
        if full.is_dir() {
            return Err(ScriptError::NotAScript(path.clone()));
        }
        Ok(full)
    }

    /// Location of a folder (the root when `None`), which must exist.
    fn folder_dir(&self, folder: Option<&ScriptPath>) -> Result<PathBuf, ScriptError> {
        let Some(folder) = folder else {
            return Ok(self.root.clone());
        };
        let full = self.existing(folder)?;
        if full.is_dir() {
            Ok(full)
        } else {
            Err(ScriptError::NotAFolder(folder.clone()))
        }
    }

    /// Location for a new entry `name` in `parent`; nothing may exist there yet.
    fn new_entry(
        &self,
        parent: Option<&ScriptPath>,
        name: &EntryName,
        path: &ScriptPath,
    ) -> Result<PathBuf, ScriptError> {
        let full = self.folder_dir(parent)?.join(name.as_str());
        if fs::symlink_metadata(&full).is_ok() {
            return Err(ScriptError::AlreadyExists(path.clone()));
        }
        Ok(full)
    }

    fn write_script(
        path: &ScriptPath,
        full: &Path,
        document: &Document,
    ) -> Result<ContentStamp, ScriptError> {
        let text = ppad::serialize(document).map_err(ScriptError::Encode)?;
        // A larger file could be written but never read back.
        if text.len() > MAX_DOCUMENT_BYTES {
            return Err(ScriptError::TooLarge(path.clone()));
        }
        atomic_fs::write(full, text.as_bytes()).map_err(io_error(path))?;
        Ok(ContentStamp::of(text.as_bytes()))
    }
}

fn io_error(path: &ScriptPath) -> impl FnOnce(io::Error) -> ScriptError + '_ {
    move |source| ScriptError::Io {
        path: path.clone(),
        source,
    }
}

/// Recursive listing with a shared entry budget.
struct Walk {
    budget: usize,
    truncated: bool,
}

impl Walk {
    /// Lists `dir`, whose entries sit `depth + 1` levels below the root.
    fn folder(
        &mut self,
        dir: &Path,
        folder: Option<&ScriptPath>,
        depth: usize,
    ) -> io::Result<Vec<TreeEntry>> {
        let mut entries = Vec::new();
        for item in fs::read_dir(dir)? {
            let item = item?;
            // Non-UTF-8, hidden and platform-invalid names cannot be addressed by a ScriptPath.
            let Ok(file_name) = item.file_name().into_string() else {
                continue;
            };
            let Ok(name) = EntryName::new(&file_name) else {
                if !file_name.starts_with('.') {
                    tracing::warn!(name = %file_name, "skipping an entry other platforms reject");
                }
                continue;
            };
            // `file_type` does not follow symbolic links, so links are skipped here.
            let file_type = item.file_type()?;
            let path = ScriptPath::child(folder, &name);
            let is_folder = file_type.is_dir();
            let wanted = is_folder || (file_type.is_file() && path.is_script());
            if !wanted {
                continue;
            }
            if self.budget == 0 {
                self.truncated = true;
                break;
            }
            self.budget -= 1;
            entries.push(if is_folder {
                // Recursion depth is bounded so a pathological tree cannot exhaust the stack.
                let children = if depth + 1 < MAX_TREE_DEPTH {
                    self.folder(&item.path(), Some(&path), depth + 1)
                        .unwrap_or_else(|error| {
                            tracing::warn!(%path, %error, "skipping the contents of an unreadable folder");
                            Vec::new()
                        })
                } else {
                    self.truncated = true;
                    Vec::new()
                };
                TreeEntry::Folder {
                    path,
                    name: file_name,
                    children,
                }
            } else {
                TreeEntry::Script {
                    path,
                    name: file_name,
                }
            });
        }
        entries.sort_by(TreeEntry::explorer_cmp);
        Ok(entries)
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs, io,
        path::{Path, PathBuf},
        sync::Mutex,
    };

    use super::{ContentStamp, ScriptError, ScriptStore, Trash};
    use crate::{
        language::Language,
        ppad::{Document, Header, Newline, PpadError},
        scripts::{
            path::{EntryName, ScriptPath},
            tree::{ScriptTree, TreeEntry},
        },
    };

    const SAMPLE: &str =
        "{\"ppad\":1,\"language\":\"python\",\"mode\":\"script\"}\n---\nprint(1)\n";

    /// Moves entries into a folder outside the root and records what it received.
    #[derive(Debug)]
    struct FolderTrash {
        bin: PathBuf,
        received: Mutex<Vec<PathBuf>>,
    }

    impl Trash for FolderTrash {
        fn move_to_trash(&self, path: &Path) -> io::Result<()> {
            self.received.lock().unwrap().push(path.to_owned());
            fs::rename(path, self.bin.join(path.file_name().unwrap()))
        }
    }

    struct Fixture {
        _temp: tempfile::TempDir,
        root: PathBuf,
        bin: PathBuf,
        store: ScriptStore,
    }

    fn fixture() -> Fixture {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("scripts");
        let bin = temp.path().join("bin");
        fs::create_dir_all(&bin).unwrap();
        let trash = FolderTrash {
            bin: bin.clone(),
            received: Mutex::new(Vec::new()),
        };
        let store = ScriptStore::open(&root, Box::new(trash)).unwrap();
        Fixture {
            _temp: temp,
            root,
            bin,
            store,
        }
    }

    fn path(raw: &str) -> ScriptPath {
        ScriptPath::new(raw).unwrap()
    }

    fn name(raw: &str) -> EntryName {
        EntryName::new(raw).unwrap()
    }

    fn document(code: &str) -> Document {
        Document {
            header: Header::new(Language::Python),
            code: code.to_owned(),
            newline: Newline::Lf,
        }
    }

    fn write(root: &Path, relative: &str, contents: &str) {
        let full = root.join(relative);
        fs::create_dir_all(full.parent().unwrap()).unwrap();
        fs::write(full, contents).unwrap();
    }

    fn script(raw: &str) -> TreeEntry {
        TreeEntry::Script {
            path: path(raw),
            name: raw.rsplit('/').next().unwrap().to_owned(),
        }
    }

    fn folder(raw: &str, children: Vec<TreeEntry>) -> TreeEntry {
        TreeEntry::Folder {
            path: path(raw),
            name: raw.rsplit('/').next().unwrap().to_owned(),
            children,
        }
    }

    #[test]
    fn opening_creates_a_missing_root() {
        let f = fixture();

        assert!(f.root.is_dir());
        assert_eq!(f.store.root(), dunce::canonicalize(&f.root).unwrap());
    }

    #[test]
    fn a_configured_folder_that_disappeared_is_not_recreated() {
        let temp = tempfile::tempdir().unwrap();
        let gone = temp.path().join("unplugged-drive");

        let result = ScriptStore::open_existing(&gone, Box::new(super::SystemTrash));

        assert!(matches!(result, Err(ScriptError::Root(_))));
        assert!(!gone.exists());
        fs::create_dir(&gone).unwrap();
        assert!(ScriptStore::open_existing(&gone, Box::new(super::SystemTrash)).is_ok());
    }

    #[test]
    fn lists_folders_first_then_scripts_in_natural_order() {
        let f = fixture();
        for file in ["b.ppad", "a10.ppad", "a2.ppad", "zeta/inner.ppad"] {
            write(&f.root, file, SAMPLE);
        }
        fs::create_dir(f.root.join("Alpha")).unwrap();
        write(&f.root, "notes.txt", "not a script");
        write(&f.root, ".hidden.ppad", SAMPLE);
        write(&f.root, ".git/config.ppad", SAMPLE);

        let tree = f.store.list().unwrap();

        assert_eq!(
            tree,
            ScriptTree {
                entries: vec![
                    folder("Alpha", vec![]),
                    folder("zeta", vec![script("zeta/inner.ppad")]),
                    script("a2.ppad"),
                    script("a10.ppad"),
                    script("b.ppad"),
                ],
                truncated: false,
            }
        );
    }

    #[test]
    fn listing_stops_at_the_entry_limit() {
        let f = fixture();
        for file in ["a.ppad", "b.ppad", "c.ppad", "d.ppad"] {
            write(&f.root, file, SAMPLE);
        }

        let tree = f.store.list_limited(3).unwrap();

        assert!(tree.truncated);
        assert_eq!(tree.entries.len(), 3);
    }

    #[cfg(unix)]
    #[test]
    fn listing_skips_symlinks_and_names_other_platforms_reject() {
        let f = fixture();
        write(&f.root, "ok.ppad", SAMPLE);
        write(&f.root, "a:b.ppad", SAMPLE);
        std::os::unix::fs::symlink(f.root.join("ok.ppad"), f.root.join("link.ppad")).unwrap();

        let tree = f.store.list().unwrap();

        assert_eq!(tree.entries, vec![script("ok.ppad")]);
    }

    #[test]
    fn reads_a_script_and_stamps_its_bytes() {
        let f = fixture();
        write(&f.root, "reports/a.ppad", SAMPLE);

        let loaded = f.store.read(&path("reports/a.ppad")).unwrap();

        assert_eq!(loaded.document.header.language, Language::Python);
        assert_eq!(loaded.document.code, "print(1)\n");
        assert!(!loaded.normalized);
        assert_eq!(
            f.store.stamp(&path("reports/a.ppad")).unwrap(),
            Some(loaded.stamp.clone())
        );
        write(
            &f.root,
            "reports/a.ppad",
            &SAMPLE.replace("print(1)", "print(2)"),
        );
        assert_ne!(
            f.store.stamp(&path("reports/a.ppad")).unwrap(),
            Some(loaded.stamp)
        );
    }

    #[test]
    fn reading_reports_what_is_wrong_with_the_entry() {
        let f = fixture();
        fs::create_dir(f.root.join("folder.ppad")).unwrap();
        write(&f.root, "broken.ppad", "print(1)\n");
        fs::write(f.root.join("latin1.ppad"), b"{\"ppad\":1}\n---\n\xe9\n").unwrap();

        assert!(matches!(
            f.store.read(&path("missing.ppad")),
            Err(ScriptError::NotFound(p)) if p == path("missing.ppad")
        ));
        assert!(matches!(
            f.store.read(&path("folder.ppad")),
            Err(ScriptError::NotAScript(_))
        ));
        assert!(matches!(
            f.store.read(&path("notes")),
            Err(ScriptError::NotAScript(_))
        ));
        assert!(matches!(
            f.store.read(&path("broken.ppad")),
            Err(ScriptError::Document {
                source: PpadError::MissingHeader,
                ..
            })
        ));
        assert!(matches!(
            f.store.read(&path("latin1.ppad")),
            Err(ScriptError::InvalidEncoding(_))
        ));
    }

    #[test]
    fn reading_refuses_files_above_the_size_limit() {
        let f = fixture();
        let file = fs::File::create(f.root.join("huge.ppad")).unwrap();
        file.set_len(16 * 1024 * 1024 + 1).unwrap();

        assert!(matches!(
            f.store.read(&path("huge.ppad")),
            Err(ScriptError::Document {
                source: PpadError::TooLarge { .. },
                ..
            })
        ));
    }

    #[test]
    fn scripts_behind_long_paths_stay_inside_the_root() {
        let f = fixture();
        // Well past Windows' classic 260-character limit, every component still valid.
        let folder = "f".repeat(200);
        fs::create_dir(f.root.join(&folder)).unwrap();
        let long_name = format!("{}.ppad", "s".repeat(80));

        let (created, stamp) = f
            .store
            .create_script(
                Some(&path(&folder)),
                &name(&long_name),
                &document(
                    "x
",
                ),
            )
            .unwrap();

        assert_eq!(f.store.read(&created).unwrap().stamp, stamp);
        assert_eq!(f.store.stamp(&created).unwrap(), Some(stamp.clone()));
        f.store
            .save(
                &created,
                &document(
                    "y
",
                ),
                Some(&stamp),
            )
            .unwrap();
        let renamed = f.store.rename(&created, &name("short.ppad")).unwrap();
        f.store.delete(&renamed).unwrap();
        assert!(!f.root.join(&folder).join("short.ppad").exists());
    }

    #[test]
    fn very_deep_folders_are_cut_off_instead_of_exhausting_the_stack() {
        let f = fixture();
        let mut deep = f.root.clone();
        for _ in 0..(super::MAX_TREE_DEPTH + 10) {
            deep = deep.join("d");
        }
        fs::create_dir_all(&deep).unwrap();
        fs::write(deep.join("bottom.ppad"), SAMPLE).unwrap();
        write(&f.root, "top.ppad", SAMPLE);

        let tree = f.store.list().unwrap();

        assert!(tree.truncated);
        assert!(tree.entries.contains(&script("top.ppad")));
        let mut depth = 0;
        let mut level = &tree.entries;
        while let Some(TreeEntry::Folder { children, .. }) = level.first() {
            depth += 1;
            level = children;
        }
        assert_eq!(depth, super::MAX_TREE_DEPTH);
    }

    #[test]
    fn documents_too_large_to_reopen_are_not_saved() {
        let f = fixture();
        write(&f.root, "a.ppad", SAMPLE);
        let stamp = f.store.read(&path("a.ppad")).unwrap().stamp;
        let huge = document(&"x".repeat(crate::ppad::MAX_DOCUMENT_BYTES));

        let saved = f.store.save(&path("a.ppad"), &huge, Some(&stamp));
        let created = f.store.create_script(None, &name("b.ppad"), &huge);

        assert!(matches!(saved, Err(ScriptError::TooLarge(p)) if p == path("a.ppad")));
        assert!(matches!(created, Err(ScriptError::TooLarge(_))));
        assert_eq!(fs::read_to_string(f.root.join("a.ppad")).unwrap(), SAMPLE);
        assert!(!f.root.join("b.ppad").exists());
    }

    #[cfg(windows)]
    #[test]
    fn junctions_that_leave_the_root_are_refused() {
        let f = fixture();
        fs::write(f.bin.join("secret.ppad"), SAMPLE).unwrap();
        // Junctions need no privilege on Windows, unlike symbolic links.
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(f.root.join("linked"))
            .arg(&f.bin)
            .output()
            .unwrap();
        assert!(status.status.success(), "{status:?}");

        assert!(matches!(
            f.store.read(&path("linked/secret.ppad")),
            Err(ScriptError::OutsideRoot(_))
        ));
        assert!(matches!(
            f.store
                .create_script(Some(&path("linked")), &name("x.ppad"), &document("")),
            Err(ScriptError::OutsideRoot(_))
        ));
        assert_eq!(
            fs::read_to_string(f.bin.join("secret.ppad")).unwrap(),
            SAMPLE
        );
    }

    #[test]
    fn stamp_of_a_missing_script_is_none() {
        let f = fixture();

        assert_eq!(f.store.stamp(&path("nothing.ppad")).unwrap(), None);
    }

    #[test]
    fn saves_when_the_disk_matches_the_expected_stamp() {
        let f = fixture();
        write(&f.root, "a.ppad", SAMPLE);
        let before = f.store.read(&path("a.ppad")).unwrap().stamp;

        let after = f
            .store
            .save(&path("a.ppad"), &document("print(2)\n"), Some(&before))
            .unwrap();

        assert_ne!(after, before);
        let reread = f.store.read(&path("a.ppad")).unwrap();
        assert_eq!(reread.document.code, "print(2)\n");
        assert_eq!(reread.stamp, after);
    }

    #[test]
    fn a_save_over_changes_made_elsewhere_is_a_conflict_that_keeps_the_file() {
        let f = fixture();
        write(&f.root, "a.ppad", SAMPLE);
        let stale = f.store.read(&path("a.ppad")).unwrap().stamp;
        let external = SAMPLE.replace("print(1)", "print('elsewhere')");
        write(&f.root, "a.ppad", &external);

        let result = f
            .store
            .save(&path("a.ppad"), &document("mine\n"), Some(&stale));

        let Err(ScriptError::Conflict { path: p, current }) = result else {
            panic!("expected a conflict, got {result:?}");
        };
        assert_eq!(p, path("a.ppad"));
        assert_eq!(current, Some(ContentStamp::of(external.as_bytes())));
        assert_eq!(fs::read_to_string(f.root.join("a.ppad")).unwrap(), external);
    }

    #[test]
    fn expecting_no_file_recreates_a_deleted_script_but_never_overwrites_one() {
        let f = fixture();

        f.store
            .save(&path("again.ppad"), &document("x\n"), None)
            .unwrap();
        let second = f.store.save(&path("again.ppad"), &document("y\n"), None);

        assert_eq!(
            f.store.read(&path("again.ppad")).unwrap().document.code,
            "x\n"
        );
        assert!(matches!(
            second,
            Err(ScriptError::Conflict {
                current: Some(_),
                ..
            })
        ));
    }

    #[test]
    fn expecting_a_file_that_was_deleted_is_a_conflict() {
        let f = fixture();
        let stamp = ContentStamp::of(SAMPLE.as_bytes());

        let result = f
            .store
            .save(&path("gone.ppad"), &document("x\n"), Some(&stamp));

        assert!(matches!(
            result,
            Err(ScriptError::Conflict { current: None, .. })
        ));
        assert!(!f.root.join("gone.ppad").exists());
    }

    #[test]
    fn saving_into_a_missing_folder_is_not_found() {
        let f = fixture();

        let result = f.store.save(&path("nope/a.ppad"), &document(""), None);

        assert!(matches!(result, Err(ScriptError::NotFound(p)) if p == path("nope")));
    }

    #[test]
    fn creates_scripts_and_folders() {
        let f = fixture();

        let folder_path = f.store.create_folder(None, &name("reports")).unwrap();
        let (script_path, stamp) = f
            .store
            .create_script(Some(&folder_path), &name("q1.ppad"), &document("x\n"))
            .unwrap();

        assert_eq!(folder_path, path("reports"));
        assert_eq!(script_path, path("reports/q1.ppad"));
        assert_eq!(f.store.stamp(&script_path).unwrap(), Some(stamp));
        assert_eq!(f.store.read(&script_path).unwrap().document.code, "x\n");
    }

    #[test]
    fn creation_refuses_existing_names_missing_parents_and_non_script_names() {
        let f = fixture();
        write(&f.root, "a.ppad", SAMPLE);
        fs::create_dir(f.root.join("dir")).unwrap();

        assert!(matches!(
            f.store.create_script(None, &name("a.ppad"), &document("")),
            Err(ScriptError::AlreadyExists(p)) if p == path("a.ppad")
        ));
        assert!(matches!(
            f.store.create_folder(None, &name("dir")),
            Err(ScriptError::AlreadyExists(_))
        ));
        assert!(matches!(
            f.store.create_script(Some(&path("missing")), &name("b.ppad"), &document("")),
            Err(ScriptError::NotFound(p)) if p == path("missing")
        ));
        assert!(matches!(
            f.store
                .create_script(None, &name("notes.txt"), &document("")),
            Err(ScriptError::NotAScript(_))
        ));
        assert!(matches!(
            f.store.create_folder(Some(&path("a.ppad")), &name("x")),
            Err(ScriptError::NotAFolder(p)) if p == path("a.ppad")
        ));
        assert_eq!(fs::read_to_string(f.root.join("a.ppad")).unwrap(), SAMPLE);
    }

    #[test]
    fn renames_scripts_and_folders_with_their_contents() {
        let f = fixture();
        write(&f.root, "old/a.ppad", SAMPLE);

        let renamed_folder = f.store.rename(&path("old"), &name("new")).unwrap();
        let renamed_script = f
            .store
            .rename(&path("new/a.ppad"), &name("b.ppad"))
            .unwrap();

        assert_eq!(renamed_folder, path("new"));
        assert_eq!(renamed_script, path("new/b.ppad"));
        assert_eq!(
            fs::read_to_string(f.root.join("new/b.ppad")).unwrap(),
            SAMPLE
        );
        assert!(!f.root.join("old").exists());
    }

    #[test]
    fn a_rename_that_only_changes_case_works_everywhere() {
        let f = fixture();
        write(&f.root, "report.ppad", SAMPLE);

        let renamed = f
            .store
            .rename(&path("report.ppad"), &name("Report.ppad"))
            .unwrap();

        assert_eq!(renamed, path("Report.ppad"));
        assert_eq!(f.store.list().unwrap().entries, vec![script("Report.ppad")]);
    }

    #[test]
    fn renaming_refuses_taken_names_and_losing_the_script_extension() {
        let f = fixture();
        write(&f.root, "a.ppad", SAMPLE);
        write(&f.root, "b.ppad", "keep me");

        assert!(matches!(
            f.store.rename(&path("a.ppad"), &name("b.ppad")),
            Err(ScriptError::AlreadyExists(p)) if p == path("b.ppad")
        ));
        assert!(matches!(
            f.store.rename(&path("a.ppad"), &name("a.txt")),
            Err(ScriptError::NotAScript(_))
        ));
        assert!(matches!(
            f.store.rename(&path("missing.ppad"), &name("c.ppad")),
            Err(ScriptError::NotFound(_))
        ));
        assert_eq!(
            fs::read_to_string(f.root.join("b.ppad")).unwrap(),
            "keep me"
        );
    }

    #[test]
    fn moves_entries_into_folders_and_back_to_the_root() {
        let f = fixture();
        write(&f.root, "a.ppad", SAMPLE);
        fs::create_dir(f.root.join("archive")).unwrap();

        let moved = f
            .store
            .move_to(&path("a.ppad"), Some(&path("archive")))
            .unwrap();
        let back = f.store.move_to(&moved, None).unwrap();

        assert_eq!(moved, path("archive/a.ppad"));
        assert_eq!(back, path("a.ppad"));
        assert_eq!(fs::read_to_string(f.root.join("a.ppad")).unwrap(), SAMPLE);
    }

    #[test]
    fn moving_refuses_cycles_taken_names_and_non_folders() {
        let f = fixture();
        write(&f.root, "reports/2026/q1.ppad", SAMPLE);
        write(&f.root, "q1.ppad", "root copy");

        assert!(matches!(
            f.store.move_to(&path("reports"), Some(&path("reports/2026"))),
            Err(ScriptError::MoveIntoItself(p)) if p == path("reports")
        ));
        assert!(matches!(
            f.store.move_to(&path("reports"), Some(&path("reports"))),
            Err(ScriptError::MoveIntoItself(_))
        ));
        assert!(matches!(
            f.store.move_to(&path("reports/2026/q1.ppad"), None),
            Err(ScriptError::AlreadyExists(p)) if p == path("q1.ppad")
        ));
        assert!(matches!(
            f.store.move_to(&path("reports"), Some(&path("q1.ppad"))),
            Err(ScriptError::NotAFolder(_))
        ));
        assert_eq!(
            fs::read_to_string(f.root.join("q1.ppad")).unwrap(),
            "root copy"
        );
    }

    #[test]
    fn deleting_hands_the_entry_to_the_trash() {
        let f = fixture();
        write(&f.root, "reports/a.ppad", SAMPLE);

        f.store.delete(&path("reports")).unwrap();

        assert!(!f.root.join("reports").exists());
        assert_eq!(
            fs::read_to_string(f.bin.join("reports").join("a.ppad")).unwrap(),
            SAMPLE
        );
        assert!(matches!(
            f.store.delete(&path("reports")),
            Err(ScriptError::NotFound(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn entries_that_resolve_outside_the_root_are_refused() {
        let f = fixture();
        let outside = f.bin.join("secret.ppad");
        fs::write(&outside, SAMPLE).unwrap();
        std::os::unix::fs::symlink(&outside, f.root.join("link.ppad")).unwrap();
        std::os::unix::fs::symlink(&f.bin, f.root.join("linked-dir")).unwrap();

        assert!(matches!(
            f.store.read(&path("link.ppad")),
            Err(ScriptError::OutsideRoot(_))
        ));
        assert!(matches!(
            f.store.save(&path("link.ppad"), &document("x"), None),
            Err(ScriptError::OutsideRoot(_))
        ));
        assert!(matches!(
            f.store
                .create_script(Some(&path("linked-dir")), &name("x.ppad"), &document("")),
            Err(ScriptError::OutsideRoot(_))
        ));
        assert!(matches!(
            f.store.delete(&path("link.ppad")),
            Err(ScriptError::OutsideRoot(_))
        ));
        assert_eq!(fs::read_to_string(&outside).unwrap(), SAMPLE);
    }
}
