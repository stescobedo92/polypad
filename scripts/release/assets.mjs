/**
 * What a release is made of: the version rules, the platforms, and the name of every asset.
 * Pure functions only; `cli.mjs` does the file work. See docs/adr/0009.
 */

/** Lower-case product name that starts every release and asset name. */
const PRODUCT = "polypad";

// The regular expression suggested by https://semver.org for SemVer 2.0.0, without group names.
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/**
 * Every platform a release ships for. A bundle's `type` is both the value Tauri takes in
 * `--bundles` and the directory it writes that installer to; `suffix` ends the asset name.
 */
export const PLATFORMS = {
  "windows-x64": {
    target: "x86_64-pc-windows-msvc",
    bundles: [
      { type: "nsis", extension: ".exe", suffix: "-setup.exe" },
      // Windows Installer versions are numeric: Tauri rejects `1.0.0-beta.1` for an MSI.
      { type: "msi", extension: ".msi", suffix: ".msi", stableOnly: true },
    ],
  },
  "macos-arm64": {
    target: "aarch64-apple-darwin",
    bundles: [{ type: "dmg", extension: ".dmg", suffix: ".dmg" }],
  },
  "macos-x64": {
    target: "x86_64-apple-darwin",
    bundles: [{ type: "dmg", extension: ".dmg", suffix: ".dmg" }],
  },
  "linux-x64": {
    target: "x86_64-unknown-linux-gnu",
    bundles: [
      { type: "appimage", extension: ".AppImage", suffix: ".AppImage" },
      { type: "deb", extension: ".deb", suffix: ".deb" },
      { type: "rpm", extension: ".rpm", suffix: ".rpm" },
    ],
  },
};

/** Validates `text` as a release version and tells whether it is a pre-release. */
export function parseVersion(text) {
  const match = SEMVER.exec(text);
  if (!match) {
    throw new Error(`"${text}" is not a valid SemVer version (expected MAJOR.MINOR.PATCH)`);
  }
  if (match[5] !== undefined) {
    throw new Error(`"${text}" carries build metadata, which release versions do not use`);
  }
  return { version: text, prerelease: match[4] !== undefined };
}

/** The version a release tag names: `v1.2.3` is version `1.2.3`. */
export function versionFromTag(tag) {
  if (!tag.startsWith("v") || !SEMVER.test(tag.slice(1))) {
    throw new Error(`"${tag}" is not a release tag (expected vMAJOR.MINOR.PATCH)`);
  }
  return parseVersion(tag.slice(1)).version;
}

/** Reads `[workspace.package].version` from the text of the root `Cargo.toml`. */
export function workspaceVersion(manifest) {
  let inTable = false;
  for (const line of manifest.split(/\r?\n/)) {
    const header = /^\s*\[(.+)\]\s*(?:#.*)?$/.exec(line);
    if (header) {
      inTable = header[1].trim() === "workspace.package";
      continue;
    }
    const version = inTable ? /^\s*version\s*=\s*"([^"]*)"/.exec(line) : null;
    if (version) {
      return version[1];
    }
  }
  throw new Error("Cargo.toml has no version in its [workspace.package] table");
}

/** The installers `platform` ships for `version`. */
export function bundlesFor(platform, version) {
  const config = PLATFORMS[platform];
  if (!config) {
    const known = Object.keys(PLATFORMS).join(", ");
    throw new Error(`unknown platform "${platform}" (known: ${known})`);
  }
  const { prerelease } = parseVersion(version);
  return config.bundles.filter((bundle) => !(prerelease && bundle.stableOnly));
}

/** The title of the GitHub Release, which also starts the name of each of its assets. */
export function releaseTitle(version) {
  return `${PRODUCT}-v${version}`;
}

/** The name an installer is published under, e.g. `polypad-v1.2.3-windows-x64-setup.exe`. */
export function assetName(version, platform, bundle) {
  return `${releaseTitle(version)}-${platform}${bundle.suffix}`;
}

/** The name of every installer in the release of `version`, sorted. */
export function expectedAssets(version) {
  return Object.keys(PLATFORMS)
    .flatMap((platform) =>
      bundlesFor(platform, version).map((bundle) => assetName(version, platform, bundle)),
    )
    .sort();
}

/** The name of the file that lists the SHA-256 digest of every installer. */
export function checksumsName(version) {
  return `${releaseTitle(version)}-checksums.txt`;
}
