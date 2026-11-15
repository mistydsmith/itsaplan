#!/usr/bin/env bun
// Frozen board export for the bd import seam (bead 8364 cutover). It stands in for
// `bd export --all`: it prints ONE pre-exported JSONL snapshot whose bytes are pinned
// by an operator-set SHA256, so every tick and restart reads identical bytes. It never
// calls bd, touches the database, or reaches the network.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// The path and expected digest are trusted server configuration.
export const FROZEN_ENV = {
  file: "BD_IMPORT_FROZEN_FILE",
  sha256: "BD_IMPORT_FROZEN_SHA256",
} as const;

// The digest guard lives in one mutable holder so a test can bypass it on the real code
// path (mutation testing) without editing this file.
export const guards = {
  assertDigest(actual: string, expected: string): void {
    if (actual !== expected) {
      throw new Error(
        `${FROZEN_ENV.sha256} mismatch: expected ${expected}, got ${actual}`,
      );
    }
  },
};

export function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

// Reads the frozen export ONCE, verifies its SHA256 against the expected digest, and
// returns the same bytes. Refuses when the path is missing, relative, unreadable, or the
// digest does not match.
export function frozenExport(input: {
  file?: string;
  sha256?: string;
}): Buffer {
  const file = (input.file ?? "").trim();
  const expected = (input.sha256 ?? "").trim().toLowerCase();

  if (!file.startsWith("/")) {
    throw new Error(
      `${FROZEN_ENV.file} must be an absolute path, got ${JSON.stringify(input.file)}`,
    );
  }
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    throw new Error(
      `${FROZEN_ENV.sha256} must be a 64-hex digest, got ${JSON.stringify(input.sha256)}`,
    );
  }

  let data: Buffer;
  try {
    data = readFileSync(file);
  } catch (error) {
    throw new Error(
      `${FROZEN_ENV.file} at ${file} cannot be read: ${(error as Error).message}`,
    );
  }

  guards.assertDigest(sha256Hex(data), expected);
  return data;
}

// CLI entry: accept only `export --all`, then print the frozen bytes to stdout.
export function run(argv: string[]): Buffer {
  const args = argv.slice(2);
  if (args.length !== 2 || args[0] !== "export" || args[1] !== "--all") {
    process.stderr.write(
      "bd-frozen-export: usage: bd-frozen-export export --all\n",
    );
    process.exit(1);
  }
  let data: Buffer;
  try {
    data = frozenExport({
      file: process.env[FROZEN_ENV.file],
      sha256: process.env[FROZEN_ENV.sha256],
    });
  } catch (error) {
    process.stderr.write(`bd-frozen-export: ${(error as Error).message}\n`);
    process.exit(1);
  }
  process.stdout.write(data);
  return data;
}

if (import.meta.main) run(process.argv);
