#!/usr/bin/env node
import * as fs from 'node:fs';
import {
  appendHistory,
  loadHistoryWithSkips,
  markdownRunReport,
  repeatOffenders,
  summarize,
  toHistoryRecord,
  type PlaywrightJsonReport,
} from '../governance/runReport';
import { howToRun, parseFlags, runCli, UsageError } from './args';

const USAGE = `automation-run-report - what a test run did: failures, flaky tests, slowest tests, repeat offenders

  automation-run-report [--input test-results/results.json] [--out report.md]
                        [--history history.jsonl [--append]] [--fail-on-flaky N] [--min-executed N] [--slowest 10]

Reads Playwright's JSON report (the shared Playwright config writes test-results/results.json). With --history it also
reads earlier runs from that file and lists tests that were flaky or failed in several of the last 10 - keep the file
as a CI cache or artifact between runs; --append adds this run to it. A corrupt history line is skipped (and counted),
never fatal.

Gates (the report is written first, whatever they say):
  --fail-on-flaky N   exit 1 when N or more tests needed a retry to pass
  --min-executed N    exit 1 when fewer than N tests actually ran (default 1: an all-skipped or empty run is not a
                      pass; --min-executed 0 allows it)
  and always exit 1 when the report carries top-level errors (a config or global-setup failure).

Exit codes: 0 ok, 1 a gate failed, 2 the report could not be read or the command line is wrong. Numbers must be whole;
an unknown option is an error, so a typo cannot switch a gate off.
${howToRun('automation-run-report', 'run-report', 'runReport')}`;

function main(): void {
  const flags = parseFlags(process.argv.slice(2).filter((a) => a !== '-h'), {
    '--input': 'string',
    '--out': 'string',
    '--history': 'string',
    '--append': 'boolean',
    '--fail-on-flaky': 'int',
    '--min-executed': 'int',
    '--slowest': 'int',
    '--help': 'boolean',
  });
  if (flags['--help'] || process.argv.includes('-h')) return void process.stdout.write(USAGE);

  if (flags['--fail-on-flaky'] === 0)
    throw new UsageError('--fail-on-flaky 0 would fail every run; use 1 to fail on any flaky test');

  const input = (flags['--input'] as string | undefined) ?? 'test-results/results.json';
  if (!fs.existsSync(input)) {
    process.stderr.write(`no report at ${input} - run the tests first (the shared Playwright config writes it)\n`);
    process.exit(2);
  }
  let parsed: PlaywrightJsonReport;
  try {
    parsed = JSON.parse(fs.readFileSync(input, 'utf8')) as PlaywrightJsonReport;
  } catch (error) {
    process.stderr.write(`${input} is not valid JSON: ${(error as Error).message}\n`);
    return process.exit(2);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.suites)) {
    process.stderr.write(`${input} is not a Playwright JSON report (no "suites" array)\n`);
    return process.exit(2);
  }
  const summary = summarize(parsed);

  const historyFile = flags['--history'] as string | undefined;
  const loaded = historyFile ? loadHistoryWithSkips(historyFile) : { records: [], skipped: 0 };
  if (loaded.skipped > 0)
    process.stderr.write(`skipped ${loaded.skipped} unreadable line(s) in ${historyFile}\n`);
  const current = [...loaded.records, toHistoryRecord(summary)];
  const text = markdownRunReport(summary, {
    slowest: (flags['--slowest'] as number | undefined) ?? 10,
    offenders: historyFile ? repeatOffenders(current) : undefined,
  });
  const out = flags['--out'] as string | undefined;
  if (out) fs.writeFileSync(out, text);
  else process.stdout.write(`${text}\n`);
  if (historyFile && flags['--append']) appendHistory(historyFile, toHistoryRecord(summary));

  const problems: string[] = [];
  if (summary.errors.length > 0)
    problems.push(`the run reported ${summary.errors.length} error(s) of its own: ${summary.errors.join('; ')}`);
  const minExecuted = (flags['--min-executed'] as number | undefined) ?? 1;
  if (summary.executed < minExecuted)
    problems.push(
      `only ${summary.executed} test(s) executed (minimum ${minExecuted}; ${summary.skipped} skipped) - a run that checked nothing is not a pass`,
    );
  const flakyLimit = flags['--fail-on-flaky'] as number | undefined;
  if (flakyLimit !== undefined && summary.flaky >= flakyLimit)
    problems.push(`${summary.flaky} flaky test(s) (limit ${flakyLimit}) - fix them before they become failures`);
  if (problems.length > 0) {
    process.stderr.write(`${problems.join('\n')}\n`);
    process.exit(1);
  }
}

runCli(USAGE, main);
