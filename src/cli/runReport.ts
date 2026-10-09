#!/usr/bin/env node
import * as fs from 'node:fs';
import {
  appendHistory,
  loadHistory,
  markdownRunReport,
  repeatOffenders,
  summarize,
  toHistoryRecord,
  type PlaywrightJsonReport,
} from '../governance/runReport';

const USAGE = `automation-run-report - what a test run did: failures, flaky tests, slowest tests, repeat offenders

  automation-run-report [--input test-results/results.json] [--out report.md]
                        [--history history.jsonl [--append]] [--fail-on-flaky N] [--slowest 10]

Reads Playwright's JSON report (the shared Playwright config writes test-results/results.json). With --history it also
reads earlier runs from that file and lists tests that were flaky or failed in several of the last 10 - keep the file
as a CI cache or artifact between runs; --append adds this run to it. --fail-on-flaky N exits 1 when N or more tests
needed a retry to pass (a quality gate for flakiness).
`;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write(USAGE);
} else {
  const input = arg('--input') ?? 'test-results/results.json';
  if (!fs.existsSync(input)) {
    process.stderr.write(
      `no report at ${input} - run the tests first (the shared Playwright config writes it)\n`,
    );
    process.exit(2);
  }
  const summary = summarize(JSON.parse(fs.readFileSync(input, 'utf8')) as PlaywrightJsonReport);
  const historyFile = arg('--history');
  const history = historyFile ? loadHistory(historyFile) : [];
  const current = [...history, toHistoryRecord(summary)];
  const text = markdownRunReport(summary, {
    slowest: Number(arg('--slowest') ?? 10),
    offenders: historyFile ? repeatOffenders(current) : undefined,
  });
  const out = arg('--out');
  if (out) fs.writeFileSync(out, text);
  else process.stdout.write(`${text}\n`);
  if (historyFile && process.argv.includes('--append'))
    appendHistory(historyFile, toHistoryRecord(summary));
  const gate = arg('--fail-on-flaky');
  if (gate !== undefined && summary.flaky >= Number(gate)) {
    process.stderr.write(
      `${summary.flaky} flaky test(s) (limit ${gate}) - fix them before they become failures\n`,
    );
    process.exit(1);
  }
}
