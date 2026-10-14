import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { expectedAssets } from "./assets.mjs";
import { checksums, collect, formatOutputs, plan } from "./cli.mjs";

const REPOSITORY = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

let root;

/** Writes `files` (relative path to content) under the temporary root. */
function write(files) {
  for (const [file, content] of Object.entries(files)) {
    const target = join(root, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

function workspace(version) {
  write({ "Cargo.toml": `[workspace.package]\nversion = "${version}"\n` });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "polypad-release-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("plan", () => {
  it("describes the build of a platform from the workspace version", () => {
    workspace("0.2.0");

    assert.deepEqual(plan({ root, platform: "windows-x64" }), {
      version: "0.2.0",
      prerelease: false,
      target: "x86_64-pc-windows-msvc",
      bundles: "nsis,msi",
    });
  });

  it("drops the MSI from a pre-release", () => {
    workspace("0.2.0-beta.1");

    const result = plan({ root, platform: "windows-x64", tag: "v0.2.0-beta.1" });

    assert.equal(result.prerelease, true);
    assert.equal(result.bundles, "nsis");
  });

  it("treats an empty tag as no tag, as a dry run passes it", () => {
    workspace("0.2.0");

    assert.equal(plan({ root, platform: "linux-x64", tag: "" }).bundles, "appimage,deb,rpm");
  });

  it("refuses to build a tag that does not match the workspace version", () => {
    workspace("0.2.0");

    assert.throws(
      () => plan({ root, platform: "linux-x64", tag: "v0.3.0" }),
      /tag v0\.3\.0 .* workspace version 0\.2\.0/,
    );
  });

  it("refuses a workspace version that is not SemVer", () => {
    workspace("0.2");

    assert.throws(() => plan({ root, platform: "linux-x64" }), /not a valid SemVer version/);
  });
});

describe("formatOutputs", () => {
  it("writes one key=value line per entry, as GITHUB_OUTPUT expects", () => {
    assert.equal(
      formatOutputs({ version: "0.2.0", prerelease: false }),
      "version=0.2.0\nprerelease=false\n",
    );
  });
});

describe("collect", () => {
  const windowsBundles = {
    "bundle/nsis/PolyPad_0.2.0_x64-setup.exe": "nsis installer",
    "bundle/msi/PolyPad_0.2.0_x64_en-US.msi": "msi installer",
  };

  const collectWindows = () =>
    collect({
      root,
      platform: "windows-x64",
      bundleDir: join(root, "bundle"),
      outDir: join(root, "dist"),
    });

  it("copies each installer under its release name", () => {
    workspace("0.2.0");
    write(windowsBundles);

    const names = collectWindows();

    assert.deepEqual(names, [
      "polypad-v0.2.0-windows-x64-setup.exe",
      "polypad-v0.2.0-windows-x64.msi",
    ]);
    assert.deepEqual(readdirSync(join(root, "dist")).sort(), names);
    assert.equal(readFileSync(join(root, "dist", names[0]), "utf8"), "nsis installer");
    assert.equal(readFileSync(join(root, "dist", names[1]), "utf8"), "msi installer");
  });

  it("ignores what Tauri leaves next to an installer", () => {
    workspace("0.2.0");
    write({
      "bundle/appimage/PolyPad_0.2.0_amd64.AppImage": "appimage",
      "bundle/appimage/PolyPad.AppDir/usr/bin/polypad": "binary",
      "bundle/deb/PolyPad_0.2.0_amd64.deb": "deb",
      "bundle/deb/PolyPad_0.2.0_amd64/control.tar.gz": "staging",
      "bundle/rpm/PolyPad-0.2.0-1.x86_64.rpm": "rpm",
    });

    const names = collect({
      root,
      platform: "linux-x64",
      bundleDir: join(root, "bundle"),
      outDir: join(root, "dist"),
    });

    assert.deepEqual(names, [
      "polypad-v0.2.0-linux-x64.AppImage",
      "polypad-v0.2.0-linux-x64.deb",
      "polypad-v0.2.0-linux-x64.rpm",
    ]);
  });

  it("fails when an installer was not built", () => {
    workspace("0.2.0");
    write({ "bundle/nsis/PolyPad_0.2.0_x64-setup.exe": "nsis installer" });

    assert.throws(collectWindows, /no \.msi file in .*msi/);
  });

  it("fails when two files could be the installer, instead of picking one", () => {
    workspace("0.2.0");
    write({ ...windowsBundles, "bundle/nsis/PolyPad_0.1.0_x64-setup.exe": "stale installer" });

    assert.throws(collectWindows, /2 \.exe files in .*nsis/);
  });

  it("does not expect an MSI for a pre-release", () => {
    workspace("0.2.0-beta.1");
    write({ "bundle/nsis/PolyPad_0.2.0-beta.1_x64-setup.exe": "nsis installer" });

    assert.deepEqual(collectWindows(), ["polypad-v0.2.0-beta.1-windows-x64-setup.exe"]);
  });
});

describe("checksums", () => {
  const dist = () => join(root, "dist");

  function writeAssets(names) {
    write(Object.fromEntries(names.map((name) => [`dist/${name}`, `content of ${name}`])));
  }

  it("writes a sha256sum file covering every expected asset", () => {
    workspace("0.2.0");
    const assets = expectedAssets("0.2.0");
    writeAssets(assets);

    const result = checksums({ root, dir: dist(), tag: "v0.2.0" });

    const file = join(dist(), "polypad-v0.2.0-checksums.txt");
    assert.deepEqual(result, {
      version: "0.2.0",
      prerelease: false,
      title: "polypad-v0.2.0",
      checksums: file,
    });
    const digest = (name) => createHash("sha256").update(`content of ${name}`).digest("hex");
    assert.equal(
      readFileSync(file, "utf8"),
      assets.map((name) => `${digest(name)}  ${name}\n`).join(""),
    );
  });

  it("can run again over its own output, as a re-run of the publish job does", () => {
    workspace("0.2.0");
    writeAssets(expectedAssets("0.2.0"));

    const first = checksums({ root, dir: dist() });
    const content = readFileSync(first.checksums, "utf8");
    const second = checksums({ root, dir: dist() });

    assert.equal(readFileSync(second.checksums, "utf8"), content);
  });

  it("refuses to publish when a platform is missing", () => {
    workspace("0.2.0");
    writeAssets(expectedAssets("0.2.0").filter((name) => !name.includes("macos-x64")));

    assert.throws(
      () => checksums({ root, dir: dist() }),
      /missing: polypad-v0\.2\.0-macos-x64\.dmg/,
    );
  });

  it("refuses to publish a file nobody planned", () => {
    workspace("0.2.0");
    writeAssets([...expectedAssets("0.2.0"), "polypad-v0.1.0-linux-x64.deb"]);

    assert.throws(
      () => checksums({ root, dir: dist() }),
      /unexpected: polypad-v0\.1\.0-linux-x64\.deb/,
    );
  });

  it("refuses to publish an empty installer", () => {
    workspace("0.2.0");
    writeAssets(expectedAssets("0.2.0"));
    write({ "dist/polypad-v0.2.0-linux-x64.rpm": "" });

    assert.throws(() => checksums({ root, dir: dist() }), /empty: polypad-v0\.2\.0-linux-x64\.rpm/);
  });
});

describe("command line", () => {
  const run = (...args) =>
    spawnSync(process.execPath, [join(REPOSITORY, "scripts", "release", "cli.mjs"), ...args], {
      encoding: "utf8",
    });

  it("plans a build of this repository", () => {
    const { status, stdout } = run("plan", "--platform", "linux-x64", "--tag", "");

    assert.equal(status, 0);
    assert.match(stdout, /^version=\d+\.\d+\.\d+/m);
    assert.match(stdout, /^target=x86_64-unknown-linux-gnu$/m);
    assert.match(stdout, /^bundles=appimage,deb,rpm$/m);
  });

  it("reports a mistake on stderr and fails", () => {
    const { status, stdout, stderr } = run("plan");

    assert.equal(status, 1);
    assert.equal(stdout, "");
    assert.match(stderr, /^error: plan needs --platform/);
  });
});
