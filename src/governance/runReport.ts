import * as fs from 'node:fs';
import * as path from 'node:path';

interface JsonResult {
  status?: string;
  duration?: number;
  retry?: number;
  error?: { message?: string };
}
interface JsonTest {
  projectName?: string;
  status?: string;
  results?: JsonResult[];
}
interface JsonSpec {
  title: string;
  file?: string;
  tests?: JsonTest[];
}
interface JsonSuite {
  title?: string;
  file?: string;
  specs?: JsonSpec[];
  suites?: JsonSuite[];
}
export interface PlaywrightJsonReport {
  suites?: JsonSuite[];
  stats?: { duration?: number };
  /** Errors of the run itself (a config or global-setup failure, "no tests found"), not of any one test. */
  errors?: Array<{ message?: string }>;
}

export interface TestOutcome {
  title: string;
  file: string;
  project: string;
  status: 'passed' | 'failed' | 'flaky' | 'skipped';
  attempts: number;
  /** Duration of the final attempt, ms. */
  ms: number;
  error?: string;
}

export interface RunSummary {
  total: number;
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
  durationMs: number;
  /** Tests that actually ran: passed + failed + flaky (not skipped). */
  executed: number;
  /** Top-level errors of the run (see PlaywrightJsonReport.errors), first line each. */
  errors: string[];
  outcomes: TestOutcome[];
  byProject: Record<string, { passed: number; failed: number; flaky: number; skipped: number }>;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

function collect(suite: JsonSuite, titles: string[], file: string, out: TestOutcome[]): void {
  const here = suite.title && suite.title !== file ? [...titles, suite.title] : titles;
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      const results = test.results ?? [];
      const last = results[results.length - 1];
      const status =
        test.status === 'skipped'
          ? 'skipped'
          : test.status === 'flaky'
            ? 'flaky'
            : test.status === 'unexpected'
              ? 'failed'
              : 'passed';
      out.push({
        title: [...here, spec.title].join(' > '),
        file: spec.file ?? suite.file ?? file,
        project: test.projectName ?? '',
        status,
        attempts: results.length,
        ms: last?.duration ?? 0,
        ...(status === 'failed' && last?.error?.message
          ? {
              error: (
                last.error.message
                  .replace(ANSI, '')
                  .split('\n')
                  .find((l) => l.trim()) ?? ''
              )
                .trim()
                .slice(0, 200),
            }
          : {}),
      });
    }
  }
  for (const child of suite.suites ?? []) collect(child, here, suite.file ?? file, out);
}

export function summarize(report: PlaywrightJsonReport): RunSummary {
  const outcomes: TestOutcome[] = [];
  for (const suite of report.suites ?? [])
    collect(suite, [], suite.file ?? suite.title ?? '', outcomes);
  const byProject: RunSummary['byProject'] = {};
  for (const o of outcomes) {
    const p = (byProject[o.project] ??= { passed: 0, failed: 0, flaky: 0, skipped: 0 });
    p[o.status]++;
  }
  return {
    total: outcomes.length,
    passed: outcomes.filter((o) => o.status === 'passed').length,
    failed: outcomes.filter((o) => o.status === 'failed').length,
    flaky: outcomes.filter((o) => o.status === 'flaky').length,
    skipped: outcomes.filter((o) => o.status === 'skipped').length,
    durationMs: report.stats?.duration ?? 0,
    executed: outcomes.filter((o) => o.status !== 'skipped').length,
    errors: (report.errors ?? []).map(
      (e) =>
        (e.message ?? 'unknown error')
          .replace(ANSI, '')
          .split('\n')
          .find((l) => l.trim())
          ?.trim()
          .slice(0, 300) ?? 'unknown error',
    ),
    outcomes,
    byProject,
  };
}

export interface HistoryRecord {
  at: string;
  total: number;
  failed: number;
  flaky: number;
  failedTitles: string[];
  flakyTitles: string[];
}

export function toHistoryRecord(summary: RunSummary, at = new Date()): HistoryRecord {
  const titles = (status: TestOutcome['status']) =>
    summary.outcomes
      .filter((o) => o.status === status)
      .map((o) => `${o.project ? `[${o.project}] ` : ''}${o.title}`);
  return {
    at: at.toISOString(),
    total: summary.total,
    failed: summary.failed,
    flaky: summary.flaky,
    failedTitles: titles('failed'),
    flakyTitles: titles('flaky'),
  };
}

export function appendHistory(file: string, record: HistoryRecord): void {
  fs.mkdirSync(path.dirname(file), { recursive: true }); // the CI cache is empty on the first run: no .ci-history/ yet
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
}

function isHistoryRecord(value: unknown): value is HistoryRecord {
  const r = value as Partial<HistoryRecord> | null;
  return (
    r !== null &&
    typeof r === 'object' &&
    typeof r.at === 'string' &&
    Array.isArray(r.failedTitles) &&
    Array.isArray(r.flakyTitles)
  );
}

/** The history file's records, and how many lines were unreadable (a half-written append, a merge conflict) and skipped. */
export function loadHistoryWithSkips(file: string): { records: HistoryRecord[]; skipped: number } {
  if (!fs.existsSync(file)) return { records: [], skipped: 0 };
  const records: HistoryRecord[] = [];
  let skipped = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isHistoryRecord(parsed)) records.push(parsed);
      else skipped++;
    } catch {
      skipped++;
    }
  }
  return { records, skipped };
}

/** Like `loadHistoryWithSkips`, records only: one corrupt line never kills the report. */
export function loadHistory(file: string): HistoryRecord[] {
  return loadHistoryWithSkips(file).records;
}

export interface Offender {
  title: string;
  /** In how many of the last `runs` runs it was flaky or failed. */
  bad: number;
  runs: number;
  flaky: number;
  failed: number;
}

/** Tests that were flaky or failed in at least `minBad` of the last `window` runs - the ones worth fixing first. */
export function repeatOffenders(
  history: HistoryRecord[],
  options: { window?: number; minBad?: number } = {},
): Offender[] {
  const { window = 10, minBad = 2 } = options;
  const recent = history.slice(-window);
  const counts = new Map<string, { flaky: number; failed: number }>();
  for (const run of recent) {
    for (const t of new Set(run.flakyTitles))
      counts.set(t, {
        ...(counts.get(t) ?? { flaky: 0, failed: 0 }),
        flaky: (counts.get(t)?.flaky ?? 0) + 1,
      });
    for (const t of new Set(run.failedTitles))
      counts.set(t, {
        ...(counts.get(t) ?? { flaky: 0, failed: 0 }),
        failed: (counts.get(t)?.failed ?? 0) + 1,
      });
  }
  return [...counts.entries()]
    .map(([title, c]): Offender => ({
      title,
      bad: Math.min(recent.length, c.flaky + c.failed),
      runs: recent.length,
      flaky: c.flaky,
      failed: c.failed,
    }))
    .filter((o) => o.bad >= minBad)
    .sort((a, b) => b.bad - a.bad || a.title.localeCompare(b.title));
}

export function markdownRunReport(
  summary: RunSummary,
  options: { slowest?: number; offenders?: Offender[] } = {},
): string {
  const lines = ['# Test run report', ''];
  if (summary.errors.length)
    lines.push(
      '**The run itself reported errors** - the numbers below may be incomplete:',
      '',
      ...summary.errors.map((e) => `- ${e}`),
      '',
    );
  lines.push(
    `${summary.total} tests: **${summary.passed} passed**, ${summary.failed ? `**${summary.failed} failed**` : '0 failed'}, ${summary.flaky ? `**${summary.flaky} flaky**` : '0 flaky'}, ${summary.skipped} skipped, in ${(summary.durationMs / 1000).toFixed(1)} s.`,
    '',
  );
  const projects = Object.entries(summary.byProject);
  if (projects.length > 1) {
    lines.push('| Project | Passed | Failed | Flaky | Skipped |', '|---|---|---|---|---|');
    for (const [name, p] of projects)
      lines.push(`| ${name || '-'} | ${p.passed} | ${p.failed} | ${p.flaky} | ${p.skipped} |`);
    lines.push('');
  }
  const failed = summary.outcomes.filter((o) => o.status === 'failed');
  if (failed.length) {
    lines.push('## Failed', '');
    for (const o of failed)
      lines.push(
        `- **${o.title}**${o.project ? ` [${o.project}]` : ''} - ${o.error ?? 'no message'}`,
      );
    lines.push('');
  }
  const flaky = summary.outcomes.filter((o) => o.status === 'flaky');
  if (flaky.length) {
    lines.push(
      '## Flaky (failed, then passed on retry)',
      '',
      'A test that needs a retry to pass is hiding a defect - in the test, the data or the system. Fix these before they become failures.',
      '',
    );
    for (const o of flaky)
      lines.push(
        `- ${o.title}${o.project ? ` [${o.project}]` : ''} - passed on attempt ${o.attempts}`,
      );
    lines.push('');
  }
  if (options.offenders?.length) {
    lines.push(
      '## Repeat offenders (flaky or failed in several recent runs)',
      '',
      '| Test | Bad runs | Flaky | Failed |',
      '|---|---|---|---|',
    );
    for (const o of options.offenders)
      lines.push(`| ${o.title} | ${o.bad} of ${o.runs} | ${o.flaky} | ${o.failed} |`);
    lines.push('');
  }
  const slowest = [...summary.outcomes]
    .filter((o) => o.status !== 'skipped')
    .sort((a, b) => b.ms - a.ms)
    .slice(0, options.slowest ?? 10);
  lines.push('## Slowest tests', '', '| Test | Duration |', '|---|---|');
  for (const o of slowest)
    lines.push(
      `| ${o.title}${o.project ? ` [${o.project}]` : ''} | ${(o.ms / 1000).toFixed(1)} s |`,
    );
  lines.push('');
  return lines.join('\n');
}
