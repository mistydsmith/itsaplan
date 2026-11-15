// Non-DB tests for the optional routing, skills and close sections of the gate manifest: what
// loadTrackerRulesConfig returns for a sound section and the refusal for each malformed one.
// The interpreter, owner and file pins are read from the composed owner CONFIG, which this suite
// never writes. Nothing is spawned: only the manifest is parsed. Each case writes its own
// manifest in a suite-owned temp dir, because the config is cached per env triple.
// Run from packages/db: bun test --env-file=/dev/null src/__tests__/tracker_gate_policy.test.ts

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTrackerRulesConfig, TRACKER_GATE_ENV } from '../tracker-gate';
import type { TrackerRoutingGrant, TrackerRoutingPolicy } from '../tracker-routing-facts';

const OWNER_CONFIG =
  process.env.TRACKER_GATE_TEST_OWNER_CONFIG ??
  '/Users/misty/Output/reports/itsaplan_cutover_20261114_ROOT_R1/8364_owner_composition/CONFIG.json';
const owner = JSON.parse(readFileSync(OWNER_CONFIG, 'utf8')) as {
  python: string;
  owner: string;
  pythonSha256: string;
  fileSha256: Record<string, string>;
};
const PINS = { pythonSha256: owner.pythonSha256, fileSha256: owner.fileSha256 };
const HEX = 'a'.repeat(64);

let dir: string;
let written = 0;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tracker-gate-policy-'));
});
afterAll(() => {
  expect(readdirSync(dir)).toHaveLength(written);
  rmSync(dir, { recursive: true, force: true });
});

// Loads one manifest: the composed pins plus the given sections. The three variables get their
// prior values back.
async function load(sections: Record<string, unknown>) {
  const path = join(dir, `manifest-${written++}.json`);
  writeFileSync(path, JSON.stringify({ ...PINS, ...sections }), 'utf8');
  const next = [owner.python, owner.owner, path];
  const names = [TRACKER_GATE_ENV.python, TRACKER_GATE_ENV.owner, TRACKER_GATE_ENV.manifest];
  const prior = names.map((name) => process.env[name]);
  names.forEach((name, i) => (process.env[name] = next[i]));
  try {
    return await loadTrackerRulesConfig();
  } finally {
    names.forEach((name, i) => {
      if (prior[i] === undefined) delete process.env[name];
      else process.env[name] = prior[i];
    });
  }
}

async function expectInvalid(cases: [string, Record<string, unknown>, string][]) {
  for (const [name, sections, fragment] of cases) {
    const state = await load(sections);
    expect(state.state, name).toBe('refusal');
    if (state.state !== 'refusal') continue;
    expect(state.code, name).toBe('tracker-rules-manifest-invalid');
    expect(state.message, name).toContain(fragment);
  }
}

const LANES: TrackerRoutingPolicy['lanes'] = {
  qwen2: { execution: 'local' },
  opus: { execution: 'cloud' },
};
const GRANT: TrackerRoutingGrant = {
  bead_id: 'sentinel-prod-1',
  lane: 'opus',
  role: 'author',
  scope: 'legal-template',
  reason: 'operator ruling',
  required_reviews: ['muse'],
};
const SKILLS = {
  templates: { path: '/srv/skills/templates.md', sha256: HEX },
  law_library: { path: '/srv/skills/law-library.md', sha256: HEX },
};
const CLOSE = {
  rigs: {
    'sentinel-prod': {
      repos: { tracker: { repoRoot: '/srv/repos/tracker', targetRef: 'main' } },
      artifactRoots: ['/srv/reports'],
    },
  },
};
const rig = (target: unknown) => ({ close: { rigs: { 'sentinel-prod': target } } });

test('sound routing, skills and close sections come back beside the composed pins', async () => {
  const state = await load({
    routing: { lanes: LANES, grants: [GRANT] },
    skills: SKILLS,
    close: CLOSE,
  });
  expect(state).toEqual({
    state: 'configured',
    config: { python: owner.python, owner: owner.owner, ...PINS },
    routing: { lanes: LANES, grants: [GRANT] },
    skills: SKILLS,
    close: CLOSE,
  });
});

test('a manifest with no optional section configures with none of them', async () => {
  const state = await load({});
  expect(state).toEqual({
    state: 'configured',
    config: { python: owner.python, owner: owner.owner, ...PINS },
  });
  for (const section of ['routing', 'skills', 'close']) expect(state).not.toHaveProperty(section);
});

test('routing with no grants gets an empty grant list, and one skill may be pinned alone', async () => {
  const state = await load({ routing: { lanes: LANES }, skills: { templates: SKILLS.templates } });
  expect(state).toMatchObject({
    state: 'configured',
    routing: { lanes: LANES, grants: [] },
    skills: { templates: SKILLS.templates },
  });
  expect(state).not.toHaveProperty('close');
});

test('a malformed routing section refuses', async () => {
  const grants = (grant: unknown) => ({ routing: { lanes: LANES, grants: [grant] } });
  await expectInvalid([
    ['not-mapping', { routing: [] }, 'routing section must be a mapping'],
    ['no-lanes', { routing: { grants: [] } }, 'needs a lanes mapping'],
    ['lane-case', { routing: { lanes: { Qwen2: { execution: 'local' } } } }, 'lowercase token'],
    ['lane-padded', { routing: { lanes: { ' opus': { execution: 'cloud' } } } }, 'lowercase token'],
    [
      'execution-unknown',
      { routing: { lanes: { opus: { execution: 'remote' } } } },
      'local or cloud',
    ],
    ['execution-missing', { routing: { lanes: { opus: {} } } }, 'local or cloud'],
    ['lane-not-mapping', { routing: { lanes: { opus: 'cloud' } } }, 'local or cloud'],
    ['grants-not-list', { routing: { lanes: LANES, grants: {} } }, 'grants must be a list'],
    ['grant-not-mapping', grants('opus'), 'grant must be a mapping'],
    ['grant-no-reason', grants({ ...GRANT, reason: ' ' }), 'a bead_id, a scope and a reason'],
    ['grant-no-bead', grants({ ...GRANT, bead_id: undefined }), 'a bead_id, a scope and a reason'],
    ['grant-unknown-lane', grants({ ...GRANT, lane: 'gemini' }), 'no lanes entry: gemini'],
    ['grant-role', grants({ ...GRANT, role: 'owner' }), 'author, reviewer or mechanical'],
    [
      'grant-reviews',
      grants({ ...GRANT, required_reviews: 'muse' }),
      'must be a list of lane names',
    ],
    [
      'grant-review-blank',
      grants({ ...GRANT, required_reviews: [''] }),
      'must be a list of lane names',
    ],
  ]);
});

test('a malformed skills section refuses', async () => {
  await expectInvalid([
    ['not-mapping', { skills: [] }, 'skills section must be a mapping'],
    ['unknown-skill', { skills: { pleading: SKILLS.templates } }, 'unknown skill: pleading'],
    [
      'relative-path',
      { skills: { templates: { path: 'skills/t.md', sha256: HEX } } },
      'absolute path',
    ],
    ['no-path', { skills: { templates: { sha256: HEX } } }, 'absolute path'],
    ['short-sha', { skills: { templates: { path: '/t.md', sha256: 'abc123' } } }, 'hex sha256'],
    [
      'upper-sha',
      { skills: { law_library: { path: '/l.md', sha256: 'A'.repeat(64) } } },
      'hex sha256',
    ],
    ['pin-null', { skills: { templates: null } }, 'absolute path'],
  ]);
});

test('a malformed close section refuses', async () => {
  const repo = (entry: unknown) =>
    rig({ repos: { tracker: entry }, artifactRoots: ['/srv/reports'] });
  const good = { repoRoot: '/srv/repos/tracker', targetRef: 'main' };
  await expectInvalid([
    ['no-rigs', { close: {} }, 'needs a rigs mapping'],
    ['rigs-list', { close: { rigs: [] } }, 'needs a rigs mapping'],
    ['close-null', { close: null }, 'needs a rigs mapping'],
    ['repos-missing', rig({ artifactRoots: [] }), 'repos must be a mapping'],
    [
      'repo-relative',
      repo({ ...good, repoRoot: 'repos/tracker' }),
      'repoRoot must be an absolute path',
    ],
    ['repo-no-root', repo({ targetRef: 'main' }), 'repoRoot must be an absolute path'],
    ['ref-missing', repo({ repoRoot: good.repoRoot }), 'targetRef must be a nonempty ref name'],
    ['ref-blank', repo({ ...good, targetRef: '  ' }), 'targetRef must be a nonempty ref name'],
    [
      'roots-missing',
      rig({ repos: { tracker: good } }),
      'artifactRoots must be a list of absolute',
    ],
    [
      'root-relative',
      rig({ repos: { tracker: good }, artifactRoots: ['reports'] }),
      'artifactRoots must be a list of absolute',
    ],
  ]);
});

test('a bad optional section refuses even when the pins are sound, and names its own section', async () => {
  const state = await load({ routing: { lanes: LANES }, skills: SKILLS, close: { rigs: 7 } });
  expect(state).toEqual({
    state: 'refusal',
    code: 'tracker-rules-manifest-invalid',
    message: 'the rule manifest is invalid: the manifest close section needs a rigs mapping',
  });
});
