// The weekly offer is expressed in Dublin wall time, never in a fixed UTC offset.
export const EDUCATION_BOOKING = Object.freeze({
  timezone: 'Europe/Dublin', durationMinutes: 40, intervalMinutes: 15,
  holdHours: 24, horizonDays: 28, minNoticeHours: 24,
  weekday: Object.freeze({ startMinute: 19 * 60 + 30, endMinute: 21 * 60 }),
  weekend: Object.freeze({ startMinute: 12 * 60, endMinute: 17 * 60 })
});

const formatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: EDUCATION_BOOKING.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short'
});

export function dublinParts(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Choose a valid call time.');
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`, minute: Number(parts.hour) * 60 + Number(parts.minute),
    second: Number(parts.second), weekend: parts.weekday === 'Sat' || parts.weekday === 'Sun'
  };
}

export function dublinWallTime(date, minute) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw new Error('Choose a valid calendar date.');
  const base = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(base) || new Date(base).toISOString().slice(0, 10) !== date) throw new Error('Choose a valid calendar date.');
  const target = base + minute * 60_000;
  let instant = target;
  for (let i = 0; i < 3; i += 1) {
    const wall = dublinParts(instant);
    const represented = Date.parse(`${wall.date}T00:00:00.000Z`) + wall.minute * 60_000;
    instant += target - represented;
  }
  const wall = dublinParts(instant);
  if (wall.date !== date || wall.minute !== minute) throw new Error('This local time is unavailable.');
  return new Date(instant).toISOString();
}

export function validateEducationSlot(startAt, { now = Date.now(), enforceHorizon = true, minNoticeHours = EDUCATION_BOOKING.minNoticeHours } = {}) {
  if (typeof startAt !== 'string' || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(startAt)) throw new Error('Call time must include its timezone.');
  const start = Date.parse(startAt);
  if (!Number.isFinite(start) || start <= now) throw new Error('Choose a future call time.');
  if (start < Number(now) + Number(minNoticeHours) * 3_600_000) throw new Error('Walkthroughs must be booked at least 24 hours in advance so Gerry can review your analysis and prepare.');
  if (enforceHorizon && start > now + EDUCATION_BOOKING.horizonDays * 86_400_000) throw new Error('Choose a call within the next 28 days.');
  const wall = dublinParts(start);
  const window = wall.weekend ? EDUCATION_BOOKING.weekend : EDUCATION_BOOKING.weekday;
  if (start % 60_000 !== 0 || wall.minute % EDUCATION_BOOKING.intervalMinutes !== 0
    || wall.minute < window.startMinute || wall.minute + EDUCATION_BOOKING.durationMinutes > window.endMinute) {
    throw new Error('Choose a 15-minute start within the available hours. The full 40-minute call must fit.');
  }
  return { startAt: new Date(start).toISOString(), endAt: new Date(start + 40 * 60_000).toISOString() };
}

export function educationSlots({ from = dublinParts(Date.now()).date, now = Date.now(), minNoticeHours = EDUCATION_BOOKING.minNoticeHours } = {}) {
  // Validate the date even when the requested range lies beyond the booking horizon.
  dublinWallTime(from, 12 * 60);
  const first = Date.parse(`${from}T00:00:00.000Z`);
  const horizon = now + EDUCATION_BOOKING.horizonDays * 86_400_000;
  const slots = [];
  for (let day = 0; day <= EDUCATION_BOOKING.horizonDays; day += 1) {
    const date = new Date(first + day * 86_400_000).toISOString().slice(0, 10);
    if (Date.parse(`${date}T00:00:00.000Z`) > horizon + 86_400_000) break;
    const window = dublinParts(dublinWallTime(date, 12 * 60)).weekend ? EDUCATION_BOOKING.weekend : EDUCATION_BOOKING.weekday;
    for (let minute = window.startMinute; minute + EDUCATION_BOOKING.durationMinutes <= window.endMinute; minute += EDUCATION_BOOKING.intervalMinutes) {
      const startAt = dublinWallTime(date, minute);
      const start = Date.parse(startAt);
      if (start > now && start >= Number(now) + Number(minNoticeHours) * 3_600_000 && start <= horizon) slots.push({ startAt, endAt: new Date(start + 40 * 60_000).toISOString() });
    }
  }
  return slots;
}

export function intervalsOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}
