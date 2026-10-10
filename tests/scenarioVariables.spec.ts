import { test, expect } from '@playwright/test';
import dayjs from 'dayjs';
import { ConfigReader } from '../src/config/env';
import { ScenarioVariables, isForbiddenEnvName, randomValue, relativeDate } from '../src/placeholders';

const pad = (n: number, width = 2) => String(n).padStart(width, '0');
/** YYYY-MM-DD for a JS Date, written out by hand - an oracle that shares no code with the date helpers under test. */
const ymd = (d: Date) => `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDaysJs = (d: Date, days: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);
/**
 * Renders at "now" and accepts the answer for either calendar day the call could have straddled, so the test cannot
 * fail by running across midnight (a one-sided "today" comparison does).
 */
function aroundNow(render: () => string, expected: (day: Date) => string): void {
  const before = expected(new Date());
  const rendered = render();
  const after = expected(new Date());
  expect([before, after]).toContain(rendered);
}

test.describe('ScenarioVariables', () => {
  test('set / get / require / has / all / clear', () => {
    const vars = new ScenarioVariables().set('a', '1').set('obj', { x: 1 });
    expect(vars.get('a')).toBe('1');
    expect(vars.get('obj')).toBe('{"x":1}');
    expect(vars.has('a')).toBe(true);
    expect(vars.has('zzz')).toBe(false);
    expect(vars.all()).toEqual({ a: '1', obj: '{"x":1}' });
    vars.clear();
    expect(vars.all()).toEqual({});
  });

  test('a missing variable names the ones that are known', () => {
    const vars = new ScenarioVariables().set('known', 'x');
    expect(() => vars.require('nope')).toThrow(/No scenario variable "nope". Known: known/);
    expect(() => new ScenarioVariables().require('nope')).toThrow(/None have been set yet/);
  });

  test('interpolates saved values, several per string, with spaces inside the braces', () => {
    const vars = new ScenarioVariables().set('first', 'Ada').set('last', 'Lovelace');
    expect(vars.interpolate('{{first}} {{ last }}!')).toBe('Ada Lovelace!');
    expect(vars.interpolate('no placeholders')).toBe('no placeholders');
  });

  test('{{env:NAME}} reads the environment, with an explicit fallback and a loud failure without one', () => {
    process.env.SCENARIO_VARS_TEST = 'from-env';
    try {
      const vars = new ScenarioVariables();
      expect(vars.interpolate('{{env:SCENARIO_VARS_TEST}}')).toBe('from-env');
      expect(vars.interpolate('{{env:SCENARIO_VARS_MISSING|fallback}}')).toBe('fallback');
      expect(vars.interpolate('{{env:SCENARIO_VARS_MISSING|a|b}}')).toBe('a|b');
      expect(() => vars.interpolate('{{env:SCENARIO_VARS_MISSING}}')).toThrow(
        /SCENARIO_VARS_MISSING is not set/,
      );
    } finally {
      delete process.env.SCENARIO_VARS_TEST;
    }
  });

  test('{{env:...}} refuses the credentials a CI system injects, even with a fallback', () => {
    process.env.CI_JOB_TOKEN = 'job-token-value-123';
    try {
      const vars = new ScenarioVariables();
      for (const name of ['CI_JOB_TOKEN', 'CI_REGISTRY_PASSWORD', 'CI_DEPLOY_PASSWORD', 'CI_BUILD_TOKEN', 'CI_JOB_JWT', 'CI_JOB_JWT_V2', 'CI_RUNNER_AUTHENTICATION_TOKEN', 'CI_REPOSITORY_URL']) {
        expect(() => vars.interpolate(`{{env:${name}}}`)).toThrow(new RegExp(`${name} is a credential the CI system injects`));
      }
      expect(() => vars.interpolate('{{env:CI_JOB_TOKEN|none}}')).toThrow(/CI_JOB_TOKEN is a credential/);
      expect(() => vars.interpolate('{{env: CI_JOB_TOKEN }}')).toThrow(/CI_JOB_TOKEN is a credential/);
      try {
        vars.interpolate('{{env:CI_JOB_TOKEN}}');
      } catch (error) {
        expect((error as Error).message).not.toContain('job-token-value-123');
      }
    } finally {
      delete process.env.CI_JOB_TOKEN;
    }
  });

  test('isForbiddenEnvName: only the credential variables, not ordinary CI_ or project variables', () => {
    for (const ok of ['CI_COMMIT_SHA', 'CI_PIPELINE_ID', 'CI_PROJECT_NAME', 'SAP_PASSWORD', 'BASE_URL', 'MY_JOB_TOKEN']) expect(isForbiddenEnvName(ok)).toBe(false);
    for (const bad of ['CI_JOB_TOKEN', 'CI_JOB_JWT_V1', 'CI_RUNNER_TOKEN', 'CI_REGISTRY_PASSWORD']) expect(isForbiddenEnvName(bad)).toBe(true);
  });

  test('{{env:NAME}} reads a real environment variable first, then the supplied ConfigReader (.env files), once per instance', () => {
    const reader = new ConfigReader({ FROM_FILE: 'file-value', BOTH: 'file' });
    process.env.BOTH = 'process';
    try {
      const vars = new ScenarioVariables(reader);
      expect(vars.interpolate('{{env:FROM_FILE}}')).toBe('file-value');
      expect(vars.interpolate('{{env:BOTH}}')).toBe('process');
    } finally {
      delete process.env.BOTH;
    }
  });

  test('{{uuid}}, {{timestamp}} and {{random:...}} are fresh every time', () => {
    const vars = new ScenarioVariables();
    expect(vars.interpolate('{{uuid}}')).toMatch(/^[0-9a-f-]{36}$/);
    expect(vars.interpolate('{{uuid}}')).not.toBe(vars.interpolate('{{uuid}}'));
    expect(vars.interpolate('{{timestamp}}')).toMatch(/^\d{13}$/);
    expect(vars.interpolate('{{random:email}}')).toMatch(/@example\.(com|org|net)$/);
    expect(vars.interpolate('{{random:alnum(12)}}')).toMatch(/^[A-Za-z0-9]{12}$/);
    const n = Number(vars.interpolate('{{random:number(5,7)}}'));
    expect(n).toBeGreaterThanOrEqual(5);
    expect(n).toBeLessThanOrEqual(7);
  });

  test('{{date:...}} is relative to today, in any pattern (checked against hand-computed calendar arithmetic)', () => {
    const vars = new ScenarioVariables();
    aroundNow(() => vars.interpolate('{{date:today}}'), (day) => ymd(day));
    aroundNow(() => vars.interpolate('{{date:+7d}}'), (day) => ymd(addDaysJs(day, 7)));
    aroundNow(() => vars.interpolate('{{date:-3d}}'), (day) => ymd(addDaysJs(day, -3)));
    aroundNow(() => vars.interpolate('{{date:+2w}}'), (day) => ymd(addDaysJs(day, 14)));
    aroundNow(
      () => vars.interpolate('{{date:+0d|DD/MM/YYYY}}'),
      (day) => `${pad(day.getDate())}/${pad(day.getMonth() + 1)}/${pad(day.getFullYear(), 4)}`,
    );
  });

  test('relativeDate from a fixed start gives known answers, including month-end clamping and leap years', () => {
    const from = (iso: string) => dayjs(iso);
    expect(relativeDate('+7d', undefined, from('2026-01-31'))).toBe('2026-02-07');
    expect(relativeDate('+1M', undefined, from('2026-01-31'))).toBe('2026-02-28');
    expect(relativeDate('+1M', undefined, from('2028-01-31'))).toBe('2028-02-29'); // leap year
    expect(relativeDate('-1M', 'DD/MM/YYYY', from('2026-03-31'))).toBe('28/02/2026');
    expect(relativeDate('+1y', undefined, from('2028-02-29'))).toBe('2029-02-28');
    expect(relativeDate('-1d', undefined, from('2026-01-01'))).toBe('2025-12-31');
    expect(relativeDate('+90m', 'YYYY-MM-DD HH:mm', from('2026-01-01T23:30:00'))).toBe('2026-01-02 01:00');
    expect(relativeDate('today', undefined, from('2026-06-15T13:00:00'))).toBe('2026-06-15');
  });

  test('values that cannot be resolved throw instead of leaking "{{typo}}" into a system', () => {
    const vars = new ScenarioVariables();
    expect(() => vars.interpolate('{{random:banana}}')).toThrow(/Unknown random kind "banana"/);
    expect(() => vars.interpolate('{{date:+7 fortnights}}')).toThrow(/Bad date offset/);
    expect(() => vars.interpolate('x {{missing}} y')).toThrow(/No scenario variable "missing"/);
  });

  test('interpolateDeep reaches into objects and arrays, leaves non-strings and keys alone', () => {
    const vars = new ScenarioVariables().set('id', '42');
    expect(
      vars.interpolateDeep({
        '{{id}}': 'key stays',
        a: '{{id}}',
        b: ['x-{{id}}', 7, null, true],
        c: { d: '{{id}}' },
      }),
    ).toEqual({
      '{{id}}': 'key stays',
      a: '42',
      b: ['x-42', 7, null, true],
      c: { d: '42' },
    });
  });

  test('randomValue and relativeDate are usable on their own', () => {
    expect(randomValue('uuid')).toMatch(/^[0-9a-f-]{36}$/);
    expect(randomValue('first-name').length).toBeGreaterThan(0);
    aroundNow(() => relativeDate('0d'), (day) => ymd(day));
    expect(() => randomValue('')).toThrow(/Unknown random kind/);
  });
});
