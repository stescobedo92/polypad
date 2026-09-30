//! Crash-safe file writes.
//!
//! A write goes to a temporary file in the destination's folder, is flushed to disk and then
//! renamed over the destination, so a crash or a kill leaves either the old or the new contents,
//! never a mix. On Windows, antivirus scanners, cloud sync clients and editors briefly hold files
//! open, which makes the rename fail; those failures are retried with backoff.

use std::{
    io::{self, Write as _},
    path::Path,
    thread,
    time::Duration,
};

use atomic_write_file::AtomicWriteFile;

/// Replaces the contents of `path` atomically, creating the file if needed.
///
/// Blocking: may sleep between retries, so call it from a blocking context.
///
/// # Errors
///
/// Fails when the folder does not exist or is not writable, or when the file stays locked by
/// another process for longer than the retry budget (about 0.6 s).
pub fn write(path: &Path, contents: &[u8]) -> io::Result<()> {
    let mut delays = RETRY_DELAYS.iter();
    loop {
        match write_once(path, contents) {
            Err(error) if is_transient_lock(&error) => match delays.next() {
                Some(delay) => thread::sleep(*delay),
                None => return Err(error),
            },
            result => return result,
        }
    }
}

/// Pauses between attempts; their sum (620 ms) bounds how long a write waits for a lock.
const RETRY_DELAYS: [Duration; 5] = [
    Duration::from_millis(20),
    Duration::from_millis(40),
    Duration::from_millis(80),
    Duration::from_millis(160),
    Duration::from_millis(320),
];

/// Whether another process holds the file, which on Windows is usually brief.
#[cfg(windows)]
fn is_transient_lock(error: &io::Error) -> bool {
    // ERROR_ACCESS_DENIED (what a rename over an open file reports), ERROR_SHARING_VIOLATION,
    // ERROR_LOCK_VIOLATION.
    matches!(error.raw_os_error(), Some(5 | 32 | 33))
}

/// Unix renames succeed over open files, so a permission error there is permanent.
#[cfg(not(windows))]
fn is_transient_lock(_error: &io::Error) -> bool {
    false
}

fn write_once(path: &Path, contents: &[u8]) -> io::Result<()> {
    let mut file = AtomicWriteFile::options().open(path)?;
    file.write_all(contents)?;
    file.commit()
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::write;

    #[test]
    fn creates_a_file_that_did_not_exist() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("new.ppad");

        write(&path, b"hello").unwrap();

        assert_eq!(fs::read(&path).unwrap(), b"hello");
    }

    #[test]
    fn replaces_the_previous_contents_entirely() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("script.ppad");
        fs::write(&path, b"a much longer original text").unwrap();

        write(&path, b"short").unwrap();

        assert_eq!(fs::read(&path).unwrap(), b"short");
    }

    #[test]
    fn leaves_no_temporary_files_behind() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("script.ppad");

        write(&path, b"one").unwrap();
        write(&path, b"two").unwrap();

        let names: Vec<_> = fs::read_dir(temp.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names, vec!["script.ppad"]);
    }

    #[test]
    fn fails_when_the_folder_does_not_exist() {
        let temp = tempfile::tempdir().unwrap();

        let result = write(&temp.path().join("missing").join("script.ppad"), b"x");

        assert_eq!(result.unwrap_err().kind(), std::io::ErrorKind::NotFound);
    }

    #[cfg(windows)]
    mod windows {
        use std::{fs, os::windows::fs::OpenOptionsExt, thread, time::Duration};

        use super::super::write;

        /// Opens `path` the way a scanner or sync client does: nobody else may delete or rename
        /// it while the handle is open.
        fn lock(path: &std::path::Path) -> fs::File {
            fs::OpenOptions::new()
                .read(true)
                .share_mode(0)
                .open(path)
                .unwrap()
        }

        #[test]
        fn retries_while_another_process_briefly_holds_the_file() {
            let temp = tempfile::tempdir().unwrap();
            let path = temp.path().join("script.ppad");
            fs::write(&path, b"old").unwrap();
            let handle = lock(&path);
            let releaser = thread::spawn(move || {
                thread::sleep(Duration::from_millis(150));
                drop(handle);
            });

            write(&path, b"new").unwrap();

            releaser.join().unwrap();
            assert_eq!(fs::read(&path).unwrap(), b"new");
        }

        #[test]
        fn gives_up_and_keeps_the_old_contents_when_the_lock_persists() {
            let temp = tempfile::tempdir().unwrap();
            let path = temp.path().join("script.ppad");
            fs::write(&path, b"old").unwrap();
            let handle = lock(&path);

            let result = write(&path, b"new");

            drop(handle);
            assert!(result.is_err());
            assert_eq!(fs::read(&path).unwrap(), b"old");
        }
    }
}
