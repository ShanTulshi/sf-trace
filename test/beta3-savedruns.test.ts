import fs from 'node:fs';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodeBundle, encodeBundle } from '../shared/beta3/bundle';
import { decodeResult, encodeResult } from '../shared/beta3/results';
import { TPERIODS, type RunResult, type Scenario, type TrafficResult } from '../shared/beta3/types';
import { decodeRunFile, encodeRunFile, RETENTION, runFileName, toEvict, type SavedRunMeta } from '../client/beta3/savedRuns';

const per = <T>(f: (i: number) => T) => Object.fromEntries(TPERIODS.map((p, i) => [p, f(i)])) as Record<(typeof TPERIODS)[number], T>;
const traffic: TrafficResult = {
  flow: per((i) => Float32Array.from([i, i + 1])),
  time: per((i) => Float32Array.from([10 + i])),
  gaps: per(() => 1e-4),
  iterations: per(() => 3),
  vehicles: per(() => 100),
  summary: { vmt: per(() => 1), vht: per(() => 2), delay: per(() => 3), speed: { freeway: per(() => 50) }, vehicles: per(() => 100), peninsula: { 'US-101 N': { vmt: per(() => 4), vht: per(() => 5) } } },
  base: { vmt: per(() => 1), vht: per(() => 2), delay: per(() => 3), speed: {}, vehicles: per(() => 100) },
  trips: [{ name: 'Mission to Downtown', period: 'AM', base: 12, scenario: 11 }],
  convergence: [0.1, 0.01],
  loadings: 4,
  changes: [{ name: 'Geary Blvd', base: 100, scenario: 90 }],
};
const result = (): RunResult => ({
  scenario: 'x',
  ms: 1,
  bundleId: 'b#1',
  runMode: 'quick',
  summary: { trips: { da: 1, sr: 2, tnc: 0, transit: 3, walk: 4, bike: 0 }, residentTrips: { da: 1, sr: 2, tnc: 0, transit: 3, walk: 4, bike: 0 }, byPurpose: {}, boardings: { muni: 5 }, transitTrips: 3, vkt: 9, logsum: 1, opCost: 2, revenueHours: 3, avgTransitMin: 30 } as unknown as RunResult['summary'],
  lines: [{ line: 0, boardings: per(() => 1), loads: per((i) => Float32Array.from([i])), peakLoadFactor: 0.5, revenueHours: 1, passengerKm: 2 }],
  stopOn: Float32Array.from([1]),
  stopOff: Float32Array.from([2]),
  zoneTransitShare: Float32Array.from([0.1]),
  zoneJobs45: Float32Array.from([5]),
  zoneLogsum: Float32Array.from([-1]),
  finalCrowd: { AM: { 0: Float32Array.from([1.2]) }, MD: {}, PM: {}, NT: {} } as unknown as RunResult['finalCrowd'],
  finalLotPrice: { 3: 1.5 },
  traffic,
});
const scenario: Scenario = { name: 'Free Muni', edits: [{ kind: 'fare', feed: 'muni', factor: 0 }], day: 'wkd', runMode: 'quick' };

describe('beta3 saved runs: the file', () => {
  it('round-trips a run with its scenario and traffic, without the warm-start data', () => {
    const run = decodeRunFile(encodeRunFile({ scenario, result: result(), savedAt: 123 }));
    expect(run.savedAt).toBe(123);
    expect(run.scenario).toEqual(scenario);
    expect(run.result.finalCrowd).toBeUndefined();
    expect(run.result.finalLotPrice).toBeUndefined();
    expect(run.result.runMode).toBe('quick');
    expect(run.result.bundleId).toBe('b#1');
    expect([...run.result.traffic!.flow.PM]).toEqual([2, 3]);
    expect([...run.result.traffic!.time.NT]).toEqual([13]);
    expect(run.result.traffic!.changes[0].name).toBe('Geary Blvd');
    expect(run.result.traffic!.summary.peninsula!['US-101 N'].vmt.AM).toBe(4);
    expect([...run.result.lines[0].loads.MD]).toEqual([1]);
  });

  it('keeps the baseline format as it was (crowding kept, no traffic)', () => {
    const r = result();
    delete r.traffic;
    const d = decodeResult(encodeResult(r));
    expect(d.finalCrowd!.AM[0][0]).toBeCloseTo(1.2, 5);
    expect(d.finalLotPrice).toEqual({ 3: 1.5 });
    expect(d.traffic).toBeUndefined();
  });

  it.skipIf(!fs.existsSync('client/beta3/model/base-quick.bin.gz'))('saves a real result in well under a megabyte', () => {
    const base = decodeResult(zlib.gunzipSync(fs.readFileSync('client/beta3/model/base-quick.bin.gz')));
    const bytes = encodeRunFile({ scenario, result: base, savedAt: 1 });
    const back = decodeRunFile(bytes).result;
    expect(back.stopOn).toEqual(base.stopOn);
    expect(back.lines.length).toBe(base.lines.length);
    expect(back.summary).toEqual(base.summary);
    // (the retention policy's recent runs then take a few MB)
    expect(bytes.byteLength).toBeLessThan(1e6);
  });

  it('turns away what is not a saved run', () => {
    expect(() => decodeRunFile(new TextEncoder().encode('hello'))).toThrow(/not a saved SF-TRACE run/);
    // a model bundle, or a baseline result, is not one either
    expect(() => decodeRunFile(encodeResult(result()))).toThrow(/not a saved SF-TRACE run/);
    const newer = encodeBundle({ format: 'sf-trace-run', v: 99 } as never, {});
    expect(() => decodeRunFile(newer)).toThrow(/newer version/);
  });

  it('turns away a file with text where the panels print numbers', () => {
    const bytes = encodeRunFile({ scenario, result: result(), savedAt: 1 });
    const { header, a } = decodeBundle(zlib.gunzipSync(bytes));
    type H = { arrays?: unknown; result: { summary: Record<string, unknown>; traffic: { changes: { base: unknown }[] } } };
    /** the file with its header changed by f */
    const tamper = (f: (h: H) => void) => {
      const h = JSON.parse(JSON.stringify(header)) as H;
      delete h.arrays;
      f(h);
      return encodeBundle(h as never, a as never);
    };
    expect(() => decodeRunFile(tamper(() => {}))).not.toThrow();
    expect(() => decodeRunFile(tamper((h) => (h.result.summary.transitTrips = '<img src=x onerror=alert(1)>')))).toThrow(/damaged/);
    expect(() => decodeRunFile(tamper((h) => (h.result.traffic.changes[0].base = '<b>')))).toThrow(/damaged/);
    expect(() => decodeRunFile(tamper((h) => (h.result.summary['<x>'] = 1)))).toThrow(/damaged/);
  });

  it('names files after the scenario, day, and run mode', () => {
    expect(runFileName(scenario)).toBe('free-muni-wkd-quick.sftrace');
    expect(runFileName({ name: '  ¡¡¡  ', edits: [], day: 'sat' })).toBe('scenario-sat-precise.sftrace');
  });
});

describe('beta3 saved runs: retention', () => {
  const DAY = 86_400_000, now = 1_000 * DAY;
  const meta = (id: string, ageDays: number, kept = false): SavedRunMeta => ({ id, key: id, name: id, day: 'wkd', runMode: 'quick', savedAt: now - ageDays * DAY, usedAt: now - ageDays * DAY, kept, size: 1 });

  it(`keeps the last ${RETENTION.recent} recent runs`, () => {
    const runs = Array.from({ length: RETENTION.recent + 3 }, (_, i) => meta(`r${i}`, i));
    expect(toEvict(runs, now)).toEqual(['r12', 'r13', 'r14']);
  });

  it(`removes recent runs not used for ${RETENTION.days} days`, () => {
    expect(toEvict([meta('new', 1), meta('old', RETENTION.days + 1)], now)).toEqual(['old']);
  });

  it('never removes kept runs, and they leave the recent ones their room', () => {
    const kept = Array.from({ length: 30 }, (_, i) => meta(`k${i}`, 365 + i, true));
    const recent = Array.from({ length: RETENTION.recent }, (_, i) => meta(`r${i}`, i));
    expect(toEvict([...kept, ...recent], now)).toEqual([]);
  });
});
