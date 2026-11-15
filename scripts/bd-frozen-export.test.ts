import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { guards, frozenExport } from "./bd-frozen-export.ts";

// The digest guard the export relies on. GOOD_SHA is any 64-hex value; the file's real
// digest differs, so a correct guard refuses it.
const body = "line one\nline two\n";
const GOOD_SHA = "0".repeat(64);

const temporaryDirectories: string[] = [];
afterAll(() => {
  for (const dir of temporaryDirectories)
    rmSync(dir, { recursive: true, force: true });
});

const writeTemp = (content: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "bd-frozen-"));
  temporaryDirectories.push(dir);
  const path = join(dir, "export.jsonl");
  writeFileSync(path, content);
  return path;
};

describe("frozenExport digest guard (mutation pair)", () => {
  test("refuses a file whose SHA256 does not match the expected digest", () => {
    const path = writeTemp(body);
    expect(() => frozenExport({ file: path, sha256: GOOD_SHA })).toThrow(
      /BD_IMPORT_FROZEN_SHA256 mismatch/,
    );
  });

  test("bypassing the real guard allows bytes with the wrong digest", () => {
    const path = writeTemp(body);
    const real = guards.assertDigest;
    guards.assertDigest = () => {}; // deliberate mutation: the digest check is bypassed
    try {
      // Observe the forbidden output with the actual guard bypassed.
      expect(frozenExport({ file: path, sha256: GOOD_SHA }).toString()).toBe(
        body,
      );
    } finally {
      guards.assertDigest = real; // restore the real guard
    }
  });
});
