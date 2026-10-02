/**
 * Row-count verification for the primary/standby database mesh.
 *
 * Pure functions, no imports, no I/O — the CLI scripts (counts.mjs,
 * sync.mjs) fetch the counts; this module decides whether two sets of
 * counts mean "the standby is a faithful copy" and renders the verdict
 * in plain words an operator (or the shop owner) can act on.
 *
 * A count set is a plain object: { tableName: rowCount, ... }.
 * A missing key means "table not seen" (discovery failed or the table
 * does not exist there), which is NOT the same as zero rows.
 */

/**
 * Compare primary vs standby counts.
 *
 * @param {Object<string, number>} primary  counts on the live database
 * @param {Object<string, number>} standby  counts on the hot standby
 * @param {object} [opts]
 * @param {number} [opts.tolerance=0]       rows of slack allowed per table
 *                                          (0 = copies must be exact;
 *                                          a sync-in-progress snapshot can
 *                                          legitimately lag by a few rows
 *                                          written during the dump)
 * @returns {{ ok: boolean, missing: string[], extra: string[],
 *             mismatches: Array<{table, primary, standby, delta}>,
 *             tablesChecked: number, totalPrimary: number,
 *             totalStandby: number }}
 */
export function compareCounts(primary, standby, opts = {}) {
  const tolerance = Math.max(0, opts.tolerance | 0);
  const missing = []; // in primary, not seen on standby
  const extra = []; // seen on standby, not in primary
  const mismatches = []; // seen in both, counts differ beyond tolerance
  let totalPrimary = 0;
  let totalStandby = 0;

  const tables = new Set([...Object.keys(primary || {}), ...Object.keys(standby || {})]);
  for (const table of tables) {
    const p = primary ? primary[table] : undefined;
    const s = standby ? standby[table] : undefined;
    if (typeof p === 'number') totalPrimary += p;
    if (typeof s === 'number') totalStandby += s;
    if (typeof p === 'number' && typeof s !== 'number') {
      missing.push(table);
    } else if (typeof s === 'number' && typeof p !== 'number') {
      extra.push(table);
    } else if (typeof p === 'number' && typeof s === 'number') {
      const delta = s - p;
      if (Math.abs(delta) > tolerance) {
        mismatches.push({ table, primary: p, standby: s, delta });
      }
    }
  }
  missing.sort();
  extra.sort();
  mismatches.sort((a, b) => a.table.localeCompare(b.table));

  return {
    ok: missing.length === 0 && extra.length === 0 && mismatches.length === 0,
    missing,
    extra,
    mismatches,
    tablesChecked: tables.size,
    totalPrimary,
    totalStandby,
  };
}

/**
 * Render a compareCounts verdict as plain-language lines for logs,
 * the GitHub Actions summary, or a message to the shop owner.
 * Never contains connection details — table names and counts only.
 */
export function formatReport(result, meta = {}) {
  const lines = [];
  const when = meta.at ? ` at ${meta.at}` : '';
  lines.push(`Database copy check${when}: ${result.tablesChecked} tables compared.`);
  lines.push(`Rows — live database: ${result.totalPrimary}, safety copy: ${result.totalStandby}.`);
  if (result.ok) {
    lines.push('Result: OK — the safety copy matches the live database.');
    return lines.join('\n');
  }
  lines.push('Result: NOT matching yet — details below.');
  for (const t of result.missing) {
    lines.push(`  - Table "${t}" exists on the live database but was not found on the safety copy.`);
  }
  for (const t of result.extra) {
    lines.push(`  - Table "${t}" exists on the safety copy but not on the live database.`);
  }
  for (const m of result.mismatches) {
    const ahead = m.delta > 0 ? `safety copy has ${m.delta} MORE` : `safety copy is missing ${-m.delta}`;
    lines.push(`  - Table "${m.table}": live has ${m.primary} rows, ${ahead} (safety copy has ${m.standby}).`);
  }
  lines.push(
    'A small gap right after a sync usually means sales were written while the copy was being made. ' +
      'Run the sync again; if the same table stays behind, something is wrong and this run should be treated as an alarm.',
  );
  return lines.join('\n');
}

export default compareCounts;
