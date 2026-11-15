import { describe, expect, it } from 'bun:test';
import { sql, type SQL } from 'drizzle-orm';
import { highestMintableRoot } from '../issue-identity';

// The parameter-binding proof of the highest-mintable-root helper runs WITHOUT a
// database: it is the guard against the class of bug where the SQL spelled its
// rig_id as a literal $1 and only worked while a sibling interpolation happened
// to bind that position (Root, 8363.1 review, 2026-11-15). toQuery with
// inlineParams renders the bound values into the text, so an unbound placeholder
// or a cross-bound rig id is visible in the string.
function inlineOf(query: SQL): string {
  return (
    query as unknown as { toQuery: (c: object) => { sql: string; params: unknown[] } }
  ).toQuery({
    inlineParams: true,
  }).sql;
}

describe('highestMintableRoot parameter binding (pure, no database)', () => {
  it('binds its own rig_id twice; no $1 placeholder survives standalone use', () => {
    const text = inlineOf(sql`SELECT ${highestMintableRoot(9010)} AS highest`);
    expect((text.match(/rig_id = 9010/g) ?? []).length).toBe(2);
    expect(text).not.toContain('$1');
  });

  it('the allocation statement composes three bound rig positions in statement order', () => {
    const text = inlineOf(
      sql`SELECT ${highestMintableRoot(9010)} AS highest, (SELECT next_root FROM rig WHERE id = ${9010}) AS next_root`,
    );
    expect((text.match(/= 9010/g) ?? []).length).toBe(3);
  });

  it('two distinct rigs bind distinctly; no caller borrows another caller value', () => {
    const a = inlineOf(sql`SELECT ${highestMintableRoot(111)} AS h`);
    const b = inlineOf(sql`SELECT ${highestMintableRoot(222)} AS h`);
    expect(a).toContain('rig_id = 111');
    expect(a).not.toContain('222');
    expect(b).toContain('rig_id = 222');
    expect(b).not.toContain('111');
  });

  it('bound mode carries the rig id as a parameter, twice, for the standalone shape', () => {
    const query = sql`SELECT ${highestMintableRoot(9010)} AS highest`;
    const { params } = (
      query as unknown as { toQuery: (c: object) => { sql: string; params: unknown[] } }
    ).toQuery({
      casing: 'SnakeCase',
      escapeName: (s: string) => `"${s}"`,
      escapeParam: (_v: string, i: number) => `$${i + 1}`,
      prepareTyping: (v: unknown) => v,
    });
    expect(params).toEqual([9010, 9010]);
  });
});
