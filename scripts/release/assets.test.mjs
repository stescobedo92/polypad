import assert from "node:assert/strict";
import { describe, it } from "node:test";

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

describe("parseVersion", () => {
  it("accepts a stable version", () => {
    assert.deepEqual(parseVersion("1.2.3"), { version: "1.2.3", prerelease: false });
  });

  it("flags a version with a pre-release part", () => {
    assert.deepEqual(parseVersion("0.2.0-beta.1"), { version: "0.2.0-beta.1", prerelease: true });
  });

  for (const text of ["", "1.2", "1.2.3.4", "v1.2.3", "01.2.3", "1.2.3-", "1.2.3-01", "1.2.x"]) {
    it(`rejects ${JSON.stringify(text)}, which is not SemVer`, () => {
      assert.throws(() => parseVersion(text), /not a valid SemVer version/);
    });
  }

  it("rejects build metadata, which cannot appear in a tag-derived file name", () => {
    assert.throws(() => parseVersion("1.2.3+build.5"), /build metadata/);
  });
});

describe("versionFromTag", () => {
  it("strips the leading v", () => {
    assert.equal(versionFromTag("v1.2.3"), "1.2.3");
    assert.equal(versionFromTag("v0.2.0-rc.1"), "0.2.0-rc.1");
  });

  for (const tag of ["1.2.3", "polypad-v1.2.3", "V1.2.3", "v1.2", "v"]) {
    it(`rejects the tag ${JSON.stringify(tag)}`, () => {
      assert.throws(() => versionFromTag(tag), /release tag/);
    });
  }
});

describe("workspaceVersion", () => {
  const manifest = [
    "[workspace]",
    'members = ["crates/*"]',
    "",
    "[workspace.package]",
    'edition = "2024"',
    'version = "0.4.1" # the app version',
    "",
    "[workspace.dependencies]",
    'serde = { version = "1.0.229" }',
    'version = "9.9.9"',
  ].join("\n");

  it("reads the version of the [workspace.package] table only", () => {
    assert.equal(workspaceVersion(manifest), "0.4.1");
  });

  it("reads a manifest with Windows line endings", () => {
    assert.equal(workspaceVersion(manifest.replaceAll("\n", "\r\n")), "0.4.1");
  });

  it("fails when the table has no version", () => {
    assert.throws(
      () => workspaceVersion('[workspace.package]\nedition = "2024"\n[package]\nversion = "1.0.0"'),
      /\[workspace\.package\]/,
    );
  });
});

describe("bundlesFor", () => {
  const types = (platform, version) => bundlesFor(platform, version).map((bundle) => bundle.type);

  it("lists every installer of a platform for a stable version", () => {
    assert.deepEqual(types("windows-x64", "1.0.0"), ["nsis", "msi"]);
    assert.deepEqual(types("macos-arm64", "1.0.0"), ["dmg"]);
    assert.deepEqual(types("macos-x64", "1.0.0"), ["dmg"]);
    assert.deepEqual(types("linux-x64", "1.0.0"), ["appimage", "deb", "rpm"]);
  });

  it("leaves the MSI out of a pre-release: Windows Installer rejects its version", () => {
    assert.deepEqual(types("windows-x64", "1.0.0-beta.1"), ["nsis"]);
    assert.deepEqual(types("linux-x64", "1.0.0-beta.1"), ["appimage", "deb", "rpm"]);
  });

  it("names the known platforms when asked for an unknown one", () => {
    assert.throws(() => bundlesFor("windows-arm64", "1.0.0"), /windows-x64, macos-arm64/);
  });
});

describe("assetName", () => {
  it("joins product, version, platform and installer kind", () => {
    const name = (platform, type) =>
      assetName(
        "0.2.0",
        platform,
        PLATFORMS[platform].bundles.find((bundle) => bundle.type === type),
      );

    assert.equal(name("windows-x64", "nsis"), "polypad-v0.2.0-windows-x64-setup.exe");
    assert.equal(name("windows-x64", "msi"), "polypad-v0.2.0-windows-x64.msi");
    assert.equal(name("macos-arm64", "dmg"), "polypad-v0.2.0-macos-arm64.dmg");
    assert.equal(name("macos-x64", "dmg"), "polypad-v0.2.0-macos-x64.dmg");
    assert.equal(name("linux-x64", "appimage"), "polypad-v0.2.0-linux-x64.AppImage");
    assert.equal(name("linux-x64", "deb"), "polypad-v0.2.0-linux-x64.deb");
    assert.equal(name("linux-x64", "rpm"), "polypad-v0.2.0-linux-x64.rpm");
  });
});

describe("expectedAssets", () => {
  it("lists the installers of every platform, sorted", () => {
    assert.deepEqual(expectedAssets("0.2.0"), [
      "polypad-v0.2.0-linux-x64.AppImage",
      "polypad-v0.2.0-linux-x64.deb",
      "polypad-v0.2.0-linux-x64.rpm",
      "polypad-v0.2.0-macos-arm64.dmg",
      "polypad-v0.2.0-macos-x64.dmg",
      "polypad-v0.2.0-windows-x64-setup.exe",
      "polypad-v0.2.0-windows-x64.msi",
    ]);
  });

  it("expects no MSI for a pre-release", () => {
    const assets = expectedAssets("0.2.0-beta.1");
    assert.equal(assets.length, 6);
    assert.ok(!assets.some((name) => name.endsWith(".msi")));
    assert.ok(assets.includes("polypad-v0.2.0-beta.1-windows-x64-setup.exe"));
  });
});

describe("release names", () => {
  it("titles the release after the product and the tag", () => {
    assert.equal(releaseTitle("0.2.0"), "polypad-v0.2.0");
  });

  it("names the checksums file after the release", () => {
    assert.equal(checksumsName("0.2.0"), "polypad-v0.2.0-checksums.txt");
  });
});
