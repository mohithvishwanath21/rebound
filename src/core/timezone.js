/**
 * TIMEZONE ARITHMETIC, WITHOUT A TIMEZONE LIBRARY
 * ===============================================
 *
 * Quiet hours are declared in `GUARDRAILS.quietHours` as `{ startHour: 21, endHour: 9,
 * timezone: 'Asia/Kolkata' }`. Two questions follow from that, and they are not the same
 * question:
 *
 *   1. Is this instant inside quiet hours?          -> a predicate
 *   2. When does the window next open?              -> an instant
 *
 * A guardrail that can only answer (1) has to report "forbidden", and the case then either
 * stops or gets retried by whatever polls next. A guardrail that can answer (2) reports
 * "not yet, try at 09:00 IST", which is a different decision with a different outcome. That
 * distinction is the reason this file exists rather than a one-line `hour >= 21 || hour < 9`.
 *
 * WHY NOT JUST ADD 5.5 HOURS
 * --------------------------
 * IST is UTC+05:30 and has had no daylight saving since 1945, so hardcoding the offset would
 * be correct for this project today and wrong the moment anybody points it at a merchant in
 * Europe or the US. The config names an IANA zone; honouring the zone rather than the number
 * costs about twenty lines.
 *
 * WHY NOT A DEPENDENCY
 * --------------------
 * `Intl.DateTimeFormat` with a `timeZone` option ships in Node and carries the full IANA
 * database, which is the same data a date library would bundle. The awkward part is that it
 * converts UTC -> wall time and there is no built-in inverse. The inverse is reconstructed
 * below by formatting, reading the wall clock back as though it were UTC, and taking the
 * difference — which yields the zone's offset at that instant.
 *
 * THE TWO-PASS CONVERSION
 * -----------------------
 * `wallTimeToInstant` runs the offset lookup twice. The first pass uses the offset in effect
 * at an approximate instant; if that lands on the far side of a DST transition the offset is
 * wrong by an hour, so the second pass recomputes it at the candidate instant and corrects.
 * For Asia/Kolkata the second pass never changes anything and the code path is dead weight.
 * It is here because the alternative is a function that is silently wrong twice a year in
 * every zone that observes DST, and "correct only in the zone I tested" is exactly the class
 * of bug this project keeps finding in its own history.
 */

/**
 * The wall-clock fields of `instant` as read in `timeZone`.
 *
 * `hourCycle: 'h23'` matters. With `hour12: false` some ICU versions render midnight as hour
 * `24`, which reads as "tomorrow" to any comparison written against `[0, 24)` and silently
 * inverts a midnight boundary test.
 */
export function wallParts(instant, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const out = {};
  for (const { type, value } of fmt.formatToParts(new Date(instant))) {
    if (type !== 'literal') out[type] = Number(value);
  }
  return out;
}

/**
 * Milliseconds to add to a UTC instant to get the wall clock in `timeZone`.
 * Positive east of Greenwich: +19_800_000 (5h30m) for Asia/Kolkata.
 */
export function zoneOffsetMs(instant, timeZone) {
  const p = wallParts(instant, timeZone);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // The formatter drops milliseconds, so compare against a truncated instant or the offset
  // comes back off by up to 999ms and every derived timestamp inherits the drift.
  return asIfUtc - Math.floor(new Date(instant).getTime() / 1000) * 1000;
}

/**
 * The inverse of `wallParts`: given wall-clock fields in `timeZone`, the UTC instant.
 *
 * Ambiguous and nonexistent wall times (the hour that repeats or vanishes at a DST
 * transition) are resolved to whatever the two-pass fixpoint lands on rather than raising.
 * That is a deliberate choice for a scheduler: refusing to schedule is worse than
 * scheduling an hour off, and the affected window is one hour twice a year in zones this
 * project does not currently target.
 */
export function wallTimeToInstant({ year, month, day, hour = 0, minute = 0, second = 0 }, timeZone) {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);
  const firstGuess = naive - zoneOffsetMs(naive, timeZone);
  const corrected = naive - zoneOffsetMs(firstGuess, timeZone);
  return new Date(corrected);
}

/**
 * Is `instant` inside a window that may wrap midnight?
 *
 * `startHour: 21, endHour: 9` means 21:00 to 09:00 the following morning, so the test is a
 * disjunction rather than a range. Writing it as `hour >= start && hour < end` yields an
 * empty set for every wrapping window — the window would never fire and the guardrail would
 * silently permit 2am messages while appearing to be configured against them.
 */
export function isWithinHourWindow(instant, { startHour, endHour, timezone }) {
  const { hour } = wallParts(instant, timezone);
  if (startHour === endHour) return false;
  return startHour < endHour ? hour >= startHour && hour < endHour : hour >= startHour || hour < endHour;
}

/**
 * The next instant at or after `instant` that falls outside the window.
 *
 * Returns `instant` itself when already outside, so callers can use the result
 * unconditionally instead of branching on the predicate first.
 */
export function nextInstantOutsideWindow(instant, window) {
  const from = new Date(instant);
  if (!isWithinHourWindow(from, window)) return from;

  const { startHour, endHour, timezone } = window;
  const p = wallParts(from, timezone);

  // For a wrapping window the exit is `endHour` — today if we are in the pre-dawn tail,
  // tomorrow if we are in the late-evening head.
  const rollToNextDay = startHour > endHour && p.hour >= startHour;

  const target = wallTimeToInstant(
    { year: p.year, month: p.month, day: p.day + (rollToNextDay ? 1 : 0), hour: endHour, minute: 0, second: 0 },
    timezone
  );

  // `day + 1` past the end of the month is handled by Date.UTC's normalisation inside
  // wallTimeToInstant. Guard anyway: if the arithmetic somehow failed to advance, a caller
  // that trusted this value would schedule into the past and execute immediately, which is
  // the failure this whole function exists to prevent.
  return target.getTime() > from.getTime() ? target : new Date(from.getTime() + 3_600_000);
}
