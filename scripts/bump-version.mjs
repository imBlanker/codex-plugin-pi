#!/usr/bin/env node
/**
 * Version bumper for codex-plugin-pi (port of cc's scripts/bump-version.mjs).
 * Copyright 2026 imBlanker (Apache-2.0). Derived from openai/codex-plugin-cc.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const TARGETS = [
  {
    file: "package.json",
    values: [
      {
        label: "version",
        get: (json) => json.version,
        set: (json, version) => {
          json.version = version;
        }
      }
    ]
  },
  {
    file: "package-lock.json",
    values: [
      {
        label: "version",
        get: (json) => json.version,
        set: (json, version) => {
          json.version = version;
        }
      },
      {
        label: 'packages[""].version',
        get: (json) => json.packages?.[""]?.version,
        set: (json, version) => {
          requireObject(json.packages?.[""], 'package-lock.json packages[""]');
          json.packages[""].version = version;
        }
      }
    ]
  }
];

function usage() {
  return [
    "Usage:",
    "  node scripts/bump-version.mjs <version>",
    "  node scripts/bump-version.mjs --check [version]",
    "",
    "Options:",
    "  --check       Verify manifest versions. Uses package.json when version is omitted.",
    "  --root <dir>  Run against a different repository root.",
    "  --help        Print this help."
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    check: false,
    root: process.cwd(),
    version: null
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--check") {
      options.check = true;
    } else if (arg === "--root") {
      const root = argv[i + 1];
      if (!root) {
        throw new Error("--root requires a directory.");
      }
      options.root = root;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (options.version) {
      throw new Error(`Unexpected extra argument: ${arg}`);
    } else {
      options.version = arg;
    }
  }

  options.root = path.resolve(options.root);
  return options;
}

function validateVersion(version) {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`Expected a semver-like version such as 1.0.3, got: ${version}`);
  }
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected ${label} to be an object.`);
  }
}

function readJson(root, file) {
  const filePath = path.join(root, file);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(root, file, json) {
  const filePath = path.join(root, file);
  fs.writeFileSync(filePath, `${JSON.stringify(json, null, 2)}\n`);
}

function readPackageVersion(root) {
  const packageJson = readJson(root, "package.json");
  if (typeof packageJson.version !== "string") {
    throw new Error("package.json version must be a string.");
  }
  validateVersion(packageJson.version);
  return packageJson.version;
}

function checkVersions(root, expectedVersion) {
  const mismatches = [];

  for (const target of TARGETS) {
    const json = readJson(root, target.file);
    for (const value of target.values) {
      const actual = value.get(json);
      if (actual !== expectedVersion) {
        mismatches.push(`${target.file} ${value.label}: expected ${expectedVersion}, found ${actual ?? "<missing>"}`);
      }
    }
  }

  return mismatches;
}

function bumpVersion(root, version) {
  const changedFiles = [];

  for (const target of TARGETS) {
    const json = readJson(root, target.file);
    const before = JSON.stringify(json);

    for (const value of target.values) {
      value.set(json, version);
    }

    if (JSON.stringify(json) !== before) {
      writeJson(root, target.file, json);
      changedFiles.push(target.file);
    }
  }

  return changedFiles;
}

function main(argv) {
  let options;

  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    process.exitCode = 1;
    return;
  }

  if (options.help) {
    console.log(usage());
    return;
  }

  try {
    if (options.check) {
      const expectedVersion = options.version ?? readPackageVersion(options.root);
      validateVersion(expectedVersion);
      const mismatches = checkVersions(options.root, expectedVersion);
      if (mismatches.length > 0) {
        for (const mismatch of mismatches) {
          console.error(mismatch);
        }
        process.exitCode = 1;
        return;
      }
      console.log(`All release metadata matches ${expectedVersion}.`);
      return;
    }

    if (!options.version) {
      console.error(usage());
      process.exitCode = 1;
      return;
    }

    validateVersion(options.version);
    const changedFiles = bumpVersion(options.root, options.version);
    if (changedFiles.length === 0) {
      console.log(`No changes; metadata already at ${options.version}.`);
    } else {
      for (const file of changedFiles) {
        console.log(`Updated ${file} to ${options.version}.`);
      }
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

main(process.argv.slice(2));
