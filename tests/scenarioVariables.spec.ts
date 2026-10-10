import { test, expect } from '@playwright/test';
import { ScenarioVariables, randomValue, relativeDate } from '../src/placeholders';
import { dateUtils } from '../src/index';

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

  test('{{uuid}}, {{timestamp}} and {{random:...}} are fresh every time', () => {
    const vars = new ScenarioVariables();
    expect(vars.interpolate('{{uuid}}')).toMatch(/^[0-9a-f-]{36}$/);
    expect(vars.interpolate('{{uuid}}')).not.toBe(vars.interpolate('{{uuid}}'));
    expect(vars.interpolate('{{timestamp}}')).toMatch(/^\d{13}$/);
    expect(vars.interpolate('{{random:email}}')).toMatch(/.+@.+/);
    expect(vars.interpolate('{{random:alnum(12)}}')).toMatch(/^[A-Za-z0-9]{12}$/);
    const n = Number(vars.interpolate('{{random:number(5,7)}}'));
    expect(n).toBeGreaterThanOrEqual(5);
    expect(n).toBeLessThanOrEqual(7);
  });

  test('{{date:...}} is relative to today, in any pattern', () => {
    const vars = new ScenarioVariables();
    expect(vars.interpolate('{{date:today}}')).toBe(dateUtils.formatDate(dateUtils.today()));
    expect(vars.interpolate('{{date:+7d}}')).toBe(
      dateUtils.today().add(7, 'day').format('YYYY-MM-DD'),
    );
    expect(vars.interpolate('{{date:-1M|DD/MM/YYYY}}')).toBe(
      dateUtils.today().subtract(1, 'month').format('DD/MM/YYYY'),
    );
    expect(vars.interpolate('{{date:+2w}}')).toBe(
      dateUtils.today().add(2, 'week').format('YYYY-MM-DD'),
    );
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
    expect(relativeDate('0d')).toBe(dateUtils.formatDate(dateUtils.today()));
    expect(() => randomValue('')).toThrow(/Unknown random kind/);
  });
});
