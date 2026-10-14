import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { PLATFORMS } from "./assets.mjs";

const REPOSITORY = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("release workflow", () => {
  const workflow = readFileSync(join(REPOSITORY, ".github", "workflows", "release.yml"), "utf8");

  it("builds exactly the platforms of the platform table", () => {
    const platforms = [...workflow.matchAll(/^\s*- platform: (\S+)\s*$/gm)].map(
      (match) => match[1],
    );

    assert.deepEqual(platforms.sort(), Object.keys(PLATFORMS).sort());
  });

  // Without an explicit shell the runner omits `-o pipefail`, and a release script that fails
  // while piped into tee would let the job go on to publish.
  it("runs every step in a shell that fails on a broken pipeline", () => {
    assert.match(workflow, /^defaults:\n {2}run:\n(?: {4}#.*\n)* {4}shell: bash$/m);
    assert.doesNotMatch(workflow, /^\s+shell: (?!bash$)/m);
  });
});
