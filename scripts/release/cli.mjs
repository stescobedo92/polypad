/**
 * The commands the release workflow runs (.github/workflows/release.yml):
 *
 *   plan      --platform <name> [--tag <tag>]
 *   collect   --platform <name> --bundle-dir <dir> --out-dir <dir> [--tag <tag>]
 *   checksums --dir <dir> [--tag <tag>]
 *
 * Every command reads the version from Cargo.toml. With --tag it refuses to go on unless the
 * tag names that version, so a release can only be built from the tree it is tagged on.
 */

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  PLATFORMS,
  assetName,
  bundlesFor,
  checksumsName,
  expectedAssets,
  parseVersion,
  releaseTitle,
  versionFromTag,
  workspaceVersion,
} from "./assets.mjs";

const REPOSITORY = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The version of the workspace under `root`, checked against `tag` when there is one. */
function releaseVersion(root, tag) {
  const manifest = readFileSync(join(root, "Cargo.toml"), "utf8");
  const { version, prerelease } = parseVersion(workspaceVersion(manifest));
  if (tag && versionFromTag(tag) !== version) {
    throw new Error(`tag ${tag} does not match the workspace version ${version}`);
  }
  return { version, prerelease };
}

/** What to build for `platform`: the Rust target and the value of Tauri's `--bundles`. */
export function plan({ root, platform, tag }) {
  const { version, prerelease } = releaseVersion(root, tag);
  const bundles = bundlesFor(platform, version).map((bundle) => bundle.type);
  return { version, prerelease, target: PLATFORMS[platform].target, bundles: bundles.join(",") };
}

/**
 * Copies each installer of `platform` from Tauri's bundle directory to `outDir` under its
 * release name, and returns those names.
 */
export function collect({ root, platform, tag, bundleDir, outDir }) {
  const { version } = releaseVersion(root, tag);
  // Find every installer before copying any, so a missing one leaves nothing behind.
  const installers = bundlesFor(platform, version).map((bundle) => {
    const directory = join(bundleDir, bundle.type);
    return {
      source: join(directory, onlyFile(directory, bundle.extension)),
      name: assetName(version, platform, bundle),
    };
  });

  mkdirSync(outDir, { recursive: true });
  for (const { source, name } of installers) {
    copyFileSync(source, join(outDir, name));
  }
  return installers.map(({ name }) => name);
}

/** The single file in `directory` that ends with `extension`. */
function onlyFile(directory, extension) {
  const files = existsSync(directory)
    ? readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
        .map((entry) => entry.name)
    : [];
  if (files.length === 0) {
    throw new Error(`no ${extension} file in ${directory}`);
  }
  if (files.length > 1) {
    throw new Error(`${files.length} ${extension} files in ${directory}: ${files.join(", ")}`);
  }
  return files[0];
}

/**
 * Checks that `dir` holds exactly the installers of the release, then writes their SHA-256
 * digests next to them in the format `sha256sum -c` reads.
 */
export function checksums({ root, tag, dir }) {
  const { version, prerelease } = releaseVersion(root, tag);
  const expected = expectedAssets(version);
  const checksumsFile = checksumsName(version);
  // Our own output is left over when the publish job runs a second time.
  const present = readdirSync(dir).filter((name) => name !== checksumsFile);

  const problems = [
    ...expected.filter((name) => !present.includes(name)).map((name) => `missing: ${name}`),
    ...present.filter((name) => !expected.includes(name)).map((name) => `unexpected: ${name}`),
    ...expected
      .filter((name) => present.includes(name) && statSync(join(dir, name)).size === 0)
      .map((name) => `empty: ${name}`),
  ];
  if (problems.length > 0) {
    throw new Error(`${dir} is not the release of ${version}\n  ${problems.join("\n  ")}`);
  }

  const lines = expected.map((name) => {
    const digest = createHash("sha256")
      .update(readFileSync(join(dir, name)))
      .digest("hex");
    return `${digest}  ${name}\n`;
  });
  const file = join(dir, checksumsFile);
  writeFileSync(file, lines.join(""));
  return { version, prerelease, title: releaseTitle(version), checksums: file };
}

/** Formats `record` as the `key=value` lines a step appends to `$GITHUB_OUTPUT`. */
export function formatOutputs(record) {
  return Object.entries(record)
    .map(([key, value]) => `${key}=${value}\n`)
    .join("");
}

/** Runs the command in `argv` against this repository and returns what it prints. */
export function main(argv) {
  const [command, ...args] = argv;
  const { values } = parseArgs({
    args,
    options: {
      platform: { type: "string" },
      tag: { type: "string" },
      "bundle-dir": { type: "string" },
      "out-dir": { type: "string" },
      dir: { type: "string" },
    },
  });
  const required = (name) => {
    if (!values[name]) {
      throw new Error(`${command} needs --${name}`);
    }
    return values[name];
  };
  const common = { root: REPOSITORY, tag: values.tag };

  switch (command) {
    case "plan":
      return formatOutputs(plan({ ...common, platform: required("platform") }));
    case "collect":
      return collect({
        ...common,
        platform: required("platform"),
        bundleDir: required("bundle-dir"),
        outDir: required("out-dir"),
      })
        .map((name) => `${name}\n`)
        .join("");
    case "checksums":
      return formatOutputs(checksums({ ...common, dir: required("dir") }));
    default:
      throw new Error(`unknown command "${command ?? ""}" (expected plan, collect or checksums)`);
  }
}

if (import.meta.main) {
  try {
    process.stdout.write(main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 1;
  }
}
