import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { applyCordisPatch } from "./lib/patcher.js";

const load = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const header = "# Your patch layer for this dsh profile, applied after every bundle layer:\n"
  + "# a top-level YAML array of loader patch entries (id-targeted config\n"
  + "# overrides, disables, and insert lists; `!!js` expressions allowed).\n";
const mount = "- insert:\n    - id: fujiang-armor\n      name: 'fujiang-armor'\n";
const nested = "- id: custom\n  config:\n    items: []\n    example: |\n      []\n";
const cases = [
  { name: "missing file" },
  { name: "empty file", input: "" },
  { name: "bare empty array", input: "[]\n" },
  { name: "default commented empty array", input: header + "[]\n", keep: header.trim() },
  { name: "CRLF and inline comment", input: (header + "[] # empty patch\n").replace(/\n/g, "\r\n"), keep: "# empty patch" },
  { name: "BOM and whitespace", input: "\uFEFF\n" + header + "  []  \n", keep: header.trim() },
  { name: "existing entries", input: header + nested, keep: nested.trim() },
  { name: "already broken install", input: header + "[]\n\n" + mount, keep: mount.trim() },
];

// Exercise only the profile-writing sections; never run an installer against
// the user's DSH home, install dependencies, or apply host compatibility patches.
const shellWriter = load("install.sh").match(/<<'NODE'\r?\n([\s\S]*?)\r?\nNODE/)[1];
const psInstaller = load("install.ps1");
const psWriter = psInstaller.slice(psInstaller.indexOf("    # 4c."), psInstaller.indexOf("    # ---------- [4.5]"));
const windowsPowerShell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const psBin = process.env.FUJIANG_TEST_POWERSHELL || (existsSync(windowsPowerShell) ? windowsPowerShell : "pwsh");
const hasPowerShell = spawnSync(psBin, ["-NoProfile", "-NonInteractive", "-Command", "exit 0"]).status === 0;

function checkProcess(result) {
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout || ""}\n${result.stderr || ""}`);
}

const writers = [
  { name: "compatibility patcher", run: (dir) => {
    assert.notEqual(applyCordisPatch(dir).status, "error");
  } },
  { name: "shell installer Node section", run: (dir) => {
    checkProcess(spawnSync(process.execPath, ["-", path.join(dir, "package.json"), path.join(dir, "cordis.patch.yml"), "fujiang-armor"], {
      input: shellWriter, encoding: "utf8",
    }));
  } },
  { name: "PowerShell installer section", skip: !hasPowerShell, run: (dir) => {
    const setup = "$ErrorActionPreference = 'Stop'\n$pDir = $env:FUJIANG_TEST_PROFILE\n"
      + "$pluginName = 'fujiang-armor'\n$legacyPlugins = @()\n"
      + "$utf8NoBom = New-Object System.Text.UTF8Encoding($false)\nfunction Write-Ok {}\n";
    checkProcess(spawnSync(psBin, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(setup + psWriter, "utf16le").toString("base64")], {
      env: { ...process.env, FUJIANG_TEST_PROFILE: dir }, encoding: "utf8",
    }));
  } },
];

for (const writer of writers) {
  for (const fixture of cases) {
    test(`${writer.name}: ${fixture.name}`, { skip: writer.skip }, () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), "fujiang-cordis-"));
      try {
        const file = path.join(dir, "cordis.patch.yml");
        writeFileSync(path.join(dir, "package.json"), "{}");
        if (fixture.input !== undefined) writeFileSync(file, fixture.input);
        writer.run(dir);
        const output = readFileSync(file, "utf8");
        // The first actual root node must be a block-sequence entry, not [].
        const firstNode = output.replace(/^\uFEFF/, "").split(/\r?\n/).find((line) => line.trim() && !line.trimStart().startsWith("#"));
        assert.match(firstNode, /^- /);
        assert.equal((output.match(/- id: fujiang-armor\b/g) || []).length, 1);
        if (fixture.keep) assert.ok(output.includes(fixture.keep), `lost existing content: ${fixture.keep}`);
        if (!fixture.input?.includes("fujiang-armor")) assert.match(output, /- id: system-prompt\b/);
        writer.run(dir);
        assert.equal(readFileSync(file, "utf8"), output, "repeated installation must not change the file");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
}
