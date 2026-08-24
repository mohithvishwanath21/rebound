/**
 * TIMEZONE TESTS
 * ==============
 *
 * Every assertion here is a wall-clock time computed by hand and written as a literal UTC
 * instant. That is deliberate: a test that derives its expectation from the same function it is
 * testing proves only that the function is self-consistent.
 *
 * Asia/Kolkata is UTC+05:30 with no daylight saving, so the conversions are checkable by
 * arithmetic:  IST - 5h30m = UTC.
 *
 *   09:00 IST -> 03:30 UTC
 *   21:00 IST -> 15:30 UTC
 *   23:00 IST -> 17:30 UTC (same day)
 *   02:40 IST -> 21:10 UTC (PREVIOUS day)
 *
 * The last line is the one that matters most in this project and the easiest to get wrong by
 * hand: a pre-dawn IST time belongs to the previous UTC date.
 *
 * Run: node --test test/timezone.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  wallParts,
  zoneOffsetMs,
  wallTimeToInstant,
  isWithinHourWindow,
  nextInstantOutsideWindow,
} from '../src/core/timezone.js';
import { GUARDRAILS } from '../src/core/config.js';

const IST = 'Asia/Kolkata';
const QUIET = GUARDRAILS.quietHours; // { startHour: 21, endHour: 9, timezone: 'Asia/Kolkata' }

// ---------------------------------------------------------------------------------------------
// Offset and wall-clock reading
// ---------------------------------------------------------------------------------------------

test('zoneOffsetMs returns exactly +5h30m for Asia/Kolkata', () => {
  const offset = zoneOffsetMs('2026-08-24T10:00:00Z', IST);
  assert.equal(offset, 19_800_000, '5h30m in ms');
});

test('zoneOffsetMs is not thrown off by sub-second instants', () => {
  /**
   * The formatter drops milliseconds. If the offset were computed against the untruncated
   * instant it would come back short by up to 999ms, and every scheduled timestamp derived
   * from it would inherit the drift — which would show up much later as an off-by-one-second
   * boundary failure that looks like a timezone bug and is not one.
   */
  for (const ms of [0, 1, 499, 500, 999]) {
    const offset = zoneOffsetMs(`2026-08-24T10:00:00.${String(ms).padStart(3, '0')}Z`, IST);
    assert.equal(offset, 19_800_000, `offset must not depend on the .${ms} milliseconds`);
  }
});

test('wallParts reads the IST wall clock, including the date rollover', () => {
  // 2026-08-24T10:00:00Z + 5h30m = 15:30 on the same day
  assert.deepEqual(wallParts('2026-08-24T10:00:00Z', IST), {
    year: 2026, month: 8, day: 24, hour: 15, minute: 30, second: 0,
  });

  // 2026-08-24T21:10:00Z + 5h30m = 02:40 on the FOLLOWING day
  assert.deepEqual(wallParts('2026-08-24T21:10:00Z', IST), {
    year: 2026, month: 8, day: 25, hour: 2, minute: 40, second: 0,
  });
});

test('midnight IST reads as hour 0, not hour 24', () => {
  /**
   * `hour12: false` renders midnight as hour 24 under some ICU versions. Every comparison in
   * this file is written against [0, 24), so a 24 would place midnight AFTER the 21:00 quiet
   * hours start and outside the `hour < 9` tail — inverting the boundary while looking correct.
   * `hourCycle: 'h23'` is what prevents it, and this test is what would catch its removal.
   */
  const midnightIst = '2026-08-24T18:30:00Z'; // 00:00 IST on the 25th
  const { hour, day } = wallParts(midnightIst, IST);
  assert.equal(hour, 0);
  assert.equal(day, 25);
  assert.ok(hour < 24, 'hour must be in [0, 24)');
});

// ---------------------------------------------------------------------------------------------
// The inverse conversion
// ---------------------------------------------------------------------------------------------

test('wallTimeToInstant inverts wallParts for IST', () => {
  const instant = wallTimeToInstant({ year: 2026, month: 8, day: 25, hour: 9, minute: 0 }, IST);
  assert.equal(instant.toISOString(), '2026-08-25T03:30:00.000Z');
});

test('wallTimeToInstant round-trips through wallParts', () => {
  for (const hour of [0, 1, 9, 12, 20, 21, 23]) {
    const fields = { year: 2026, month: 8, day: 24, hour, minute: 15, second: 0 };
    const back = wallParts(wallTimeToInstant(fields, IST), IST);
    assert.deepEqual(back, fields, `round trip failed at ${hour}:15 IST`);
  }
});

test('the second pass in wallTimeToInstant is what makes a DST zone correct', () => {
  /**
   * IST never needs the correction, so this is the only test that can fail if it is removed.
   *
   * 2026-11-01 is the US fall-back date; the transition is at 02:00 EDT = 06:00 UTC. The wall
   * time 05:00 in New York is therefore EST (UTC-5) and the correct instant is 10:00 UTC.
   *
   * A single-pass conversion looks up the offset at the NAIVE instant 2026-11-01T05:00:00Z, at
   * which point New York is still on EDT (UTC-4), and returns 09:00 UTC — which is 04:00 EST,
   * an hour earlier than asked for. A scheduler using it would fire an hour early, twice a year,
   * in every zone that observes DST.
   */
  const NY = 'America/New_York';
  const instant = wallTimeToInstant({ year: 2026, month: 11, day: 1, hour: 5, minute: 0 }, NY);
  assert.equal(instant.toISOString(), '2026-11-01T10:00:00.000Z');
  assert.deepEqual(wallParts(instant, NY), {
    year: 2026, month: 11, day: 1, hour: 5, minute: 0, second: 0,
  });

  // And the spring-forward side, where the offset moves the other way.
  const spring = wallTimeToInstant({ year: 2026, month: 3, day: 8, hour: 9, minute: 0 }, NY);
  assert.equal(spring.toISOString(), '2026-03-08T13:00:00.000Z', '09:00 EDT is 13:00 UTC');
});

// ---------------------------------------------------------------------------------------------
// The wrapping window. This is the bug the disjunction exists to prevent.
// ---------------------------------------------------------------------------------------------

test('a window that wraps midnight is non-empty', () => {
  /**
   * Written as `hour >= startHour && hour < endHour`, the window 21->9 is the EMPTY SET: no hour
   * is both >= 21 and < 9. The predicate would return false for every instant, quiet hours would
   * never fire, and the guardrail would permit 2am messages while appearing to be configured
   * against them. Nothing else in the system would report an error.
   */
  const inside = ['2026-08-24T17:30:00Z', '2026-08-24T21:10:00Z', '2026-08-24T15:30:00Z'];
  assert.ok(
    inside.some((i) => isWithinHourWindow(i, QUIET)),
    'the configured quiet-hours window must match at least one instant'
  );
});

test('quiet-hours boundaries, to the minute', () => {
  const cases = [
    // [instant, IST wall clock, expected]
    ['2026-08-24T15:29:00Z', '20:59', false], // one minute before it starts
    ['2026-08-24T15:30:00Z', '21:00', true],  // the instant it starts — inclusive
    ['2026-08-24T17:30:00Z', '23:00', true],
    ['2026-08-24T18:30:00Z', '00:00', true],  // midnight, the hour-24 trap
    ['2026-08-24T21:10:00Z', '02:40', true],
    ['2026-08-25T03:29:00Z', '08:59', true],  // one minute before it ends
    ['2026-08-25T03:30:00Z', '09:00', false], // the instant it ends — exclusive
    ['2026-08-25T06:30:00Z', '12:00', false],
  ];

  for (const [instant, wall, expected] of cases) {
    assert.equal(
      isWithinHourWindow(instant, QUIET),
      expected,
      `${instant} is ${wall} IST and should be ${expected ? 'inside' : 'outside'} quiet hours`
    );
  }
});

test('a non-wrapping window still works', () => {
  const business = { startHour: 9, endHour: 17, timezone: IST };
  assert.equal(isWithinHourWindow('2026-08-24T03:29:00Z', business), false); // 08:59
  assert.equal(isWithinHourWindow('2026-08-24T03:30:00Z', business), true);  // 09:00
  assert.equal(isWithinHourWindow('2026-08-24T11:29:00Z', business), true);  // 16:59
  assert.equal(isWithinHourWindow('2026-08-24T11:30:00Z', business), false); // 17:00
});

test('a degenerate window matches nothing', () => {
  const empty = { startHour: 9, endHour: 9, timezone: IST };
  for (const h of [0, 8, 9, 10, 23]) {
    const instant = wallTimeToInstant({ year: 2026, month: 8, day: 24, hour: h }, IST);
    assert.equal(isWithinHourWindow(instant, empty), false);
  }
});

// ---------------------------------------------------------------------------------------------
// The instant, not just the predicate. This is why the file exists.
// ---------------------------------------------------------------------------------------------

test('nextInstantOutsideWindow from the late-evening head rolls to the next morning', () => {
  // 23:00 IST on the 24th -> 09:00 IST on the 25th
  const out = nextInstantOutsideWindow('2026-08-24T17:30:00Z', QUIET);
  assert.equal(out.toISOString(), '2026-08-25T03:30:00.000Z');
  assert.deepEqual(wallParts(out, IST).hour, 9);
});

test('nextInstantOutsideWindow from the pre-dawn tail stays on the same IST day', () => {
  /**
   * 02:40 IST on the 25th is 21:10 UTC on the 24th. The exit is 09:00 IST on the 25th — six
   * hours away, not thirty. Rolling the day here would defer the case a full extra day, and the
   * UTC date being one behind the IST date is exactly what makes that mistake easy.
   */
  const out = nextInstantOutsideWindow('2026-08-24T21:10:00Z', QUIET);
  assert.equal(out.toISOString(), '2026-08-25T03:30:00.000Z');
});

test('nextInstantOutsideWindow crosses a month boundary', () => {
  // 22:30 IST on 31 August -> 09:00 IST on 1 September
  const out = nextInstantOutsideWindow('2026-08-31T17:00:00Z', QUIET);
  assert.equal(out.toISOString(), '2026-09-01T03:30:00.000Z');
});

test('nextInstantOutsideWindow crosses a year boundary', () => {
  // 23:30 IST on 31 December 2026 -> 09:00 IST on 1 January 2027
  const out = nextInstantOutsideWindow('2026-12-31T18:00:00Z', QUIET);
  assert.equal(out.toISOString(), '2027-01-01T03:30:00.000Z');
});

test('nextInstantOutsideWindow is the identity when already outside', () => {
  /**
   * Returning the input rather than null lets callers use the result unconditionally. A version
   * that returned null here would push a branch into every call site, and one of them would
   * eventually forget it and schedule against null.
   */
  const already = '2026-08-24T06:30:00Z'; // 12:00 IST
  assert.equal(nextInstantOutsideWindow(already, QUIET).toISOString(), '2026-08-24T06:30:00.000Z');
});

test('nextInstantOutsideWindow never returns an instant in the past', () => {
  /**
   * The property the guard clause at the end of the function protects. A returned instant at or
   * before `from` would be scheduled and execute immediately, which is precisely the 2am message
   * this whole module exists to prevent — arrived at by a different route.
   */
  for (let hour = 0; hour < 24; hour += 1) {
    for (const minute of [0, 30, 59]) {
      const from = wallTimeToInstant({ year: 2026, month: 8, day: 24, hour, minute }, IST);
      const out = nextInstantOutsideWindow(from, QUIET);
      assert.ok(
        out.getTime() >= from.getTime(),
        `${hour}:${minute} IST produced an exit at or before the input`
      );
      assert.equal(
        isWithinHourWindow(out, QUIET),
        false,
        `the exit instant for ${hour}:${minute} IST is itself inside the window`
      );
    }
  }
});
