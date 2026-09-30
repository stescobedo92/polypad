//! The scripts tree as shown in the explorer, and its ordering.

use std::cmp::Ordering;

use serde::{Deserialize, Serialize};

use super::path::ScriptPath;

/// Folders and scripts under the scripts root.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ScriptTree {
    /// Top-level entries, folders first, each group in natural order.
    pub entries: Vec<TreeEntry>,
    /// The walk stopped at the entry limit, so some entries are missing.
    pub truncated: bool,
}

/// A folder or a script.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TreeEntry {
    /// A folder and its contents.
    Folder {
        /// Location inside the root.
        path: ScriptPath,
        /// Display name (the last path component).
        name: String,
        /// Contents, ordered like the root.
        children: Vec<TreeEntry>,
    },
    /// A `.ppad` file.
    Script {
        /// Location inside the root.
        path: ScriptPath,
        /// Display name (the last path component).
        name: String,
    },
}

impl TreeEntry {
    /// Display name.
    #[must_use]
    pub fn name(&self) -> &str {
        match self {
            Self::Folder { name, .. } | Self::Script { name, .. } => name,
        }
    }

    /// Explorer order: folders before scripts, then [`natural_cmp`] by name.
    #[must_use]
    pub fn explorer_cmp(&self, other: &Self) -> Ordering {
        let rank = |entry: &Self| matches!(entry, Self::Script { .. });
        rank(self)
            .cmp(&rank(other))
            .then_with(|| natural_cmp(self.name(), other.name()))
    }
}

/// Orders names the way people expect: case-insensitively, with digit runs compared as numbers
/// (`q2` before `q10`). Names that only differ in case or leading zeros are ordered by their
/// exact text, so the order is total.
#[must_use]
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let (mut left, mut right) = (a.chars().peekable(), b.chars().peekable());
    loop {
        let ordering = match (left.peek(), right.peek()) {
            (None, None) => return a.cmp(b),
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                compare_numbers(&digit_run(&mut left), &digit_run(&mut right))
            }
            (Some(&x), Some(&y)) => {
                left.next();
                right.next();
                x.to_lowercase().cmp(y.to_lowercase())
            }
        };
        if ordering != Ordering::Equal {
            return ordering;
        }
    }
}

fn digit_run(chars: &mut std::iter::Peekable<std::str::Chars<'_>>) -> String {
    let mut digits = String::new();
    while let Some(digit) = chars.next_if(char::is_ascii_digit) {
        digits.push(digit);
    }
    digits
}

/// Compares decimal digit strings by value without parsing, so any length works.
fn compare_numbers(a: &str, b: &str) -> Ordering {
    let (a, b) = (a.trim_start_matches('0'), b.trim_start_matches('0'));
    a.len().cmp(&b.len()).then_with(|| a.cmp(b))
}

#[cfg(test)]
mod tests {
    use std::cmp::Ordering;

    use super::natural_cmp;

    #[test]
    fn orders_names_naturally_and_case_insensitively() {
        let mut names = vec![
            "b.ppad",
            "a10.ppad",
            "A.ppad",
            "a2.ppad",
            "a1.ppad",
            "Report 3",
            "report 20",
            "report 03b",
        ];

        names.sort_by(|a, b| natural_cmp(a, b));

        assert_eq!(
            names,
            [
                "A.ppad",
                "a1.ppad",
                "a2.ppad",
                "a10.ppad",
                "b.ppad",
                "Report 3",
                "report 03b",
                "report 20",
            ]
        );
    }

    #[test]
    fn the_order_is_total_for_names_that_look_alike() {
        assert_eq!(natural_cmp("a", "A"), Ordering::Greater);
        assert_eq!(natural_cmp("A", "a"), Ordering::Less);
        assert_eq!(natural_cmp("x07", "x7"), Ordering::Less);
        assert_eq!(natural_cmp("same", "same"), Ordering::Equal);
    }

    #[test]
    fn long_digit_runs_do_not_overflow() {
        assert_eq!(
            natural_cmp("v99999999999999999999999", "v100000000000000000000000"),
            Ordering::Less
        );
    }
}
