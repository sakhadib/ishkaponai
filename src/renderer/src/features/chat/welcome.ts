/**
 * The welcome screen's copy (the new-session page).
 *
 * Pure and free of React so it can be reasoned about — and checked — without
 * rendering anything. Two things are generated from the local clock: a greeting
 * that knows what time it is, and a second line that changes as the day goes on.
 *
 * Design rules this file follows, which are not obvious from the output:
 *
 * - **The name is short.** Only the first two words are used. A full legal name
 *   makes a greeting read like a form letter, and in Bangla the family name is
 *   often the part a student does not lead with.
 * - **The prompt line never repeats the name.** "Good morning, Nusrat" followed
 *   by "Nusrat, what brings you here?" reads as a rubber stamp. The greeting
 *   carries the name; the prompt line carries the invitation.
 * - **Nothing changes while the student is looking at it.** Both strings are
 *   pure functions of the day and the time band, so a re-render with the same
 *   clock produces the same words. See `pick` below.
 */

/** The five parts of a day. */
export type DayBand = 'night' | 'morning' | 'noon' | 'afternoon' | 'evening'

/**
 * The bands that start at or after midnight. Hours 0–4 are the tail of the
 * night that began at 22:00, and are handled in `bandFor` rather than listed
 * twice, so a single row really is a contiguous run of hours.
 *
 * Widths are uneven on purpose, matching how the words are actually used:
 * "good afternoon" stops being a greeting well before 6pm, and nobody says
 * "good evening" at 3pm.
 */
const BANDS: ReadonlyArray<{ band: DayBand; from: number; to: number }> = [
  { band: 'morning', from: 5, to: 11 },
  { band: 'noon', from: 12, to: 13 },
  { band: 'afternoon', from: 14, to: 17 },
  { band: 'evening', from: 18, to: 21 },
  { band: 'night', from: 22, to: 23 }
]

/** The hour, normalised, so 25 and -1 cannot fall through to a default. */
export function bandFor(hour: number): DayBand {
  const h = ((Math.floor(hour) % 24) + 24) % 24
  // 0–4 is the small-hours end of the night that started at 22.
  if (h <= 4) return 'night'
  for (const entry of BANDS) {
    if (h >= entry.from && h <= entry.to) return entry.band
  }
  return 'afternoon'
}

/**
 * The first two words of a name, or the whole thing if it is shorter.
 *
 * Splitting on whitespace rather than a fixed character count is what makes this
 * work for Bangla names, where "words" are separated by spaces like any other
 * script and a character limit would cut mid-name.
 */
export function shortName(name: string): string {
  const words = name.trim().split(/\s+/u).filter((word) => word !== '')
  return words.slice(0, 2).join(' ')
}

/** `{name}` is substituted. An entry without it is used verbatim. */
const GREETINGS: Record<DayBand, { withName: readonly string[]; plain: readonly string[] }> = {
  morning: {
    withName: [
      'Good morning, {name}',
      'Morning, {name}',
      'Early bird, {name}',
      'Good morning, {name}. Ready when you are.'
    ],
    plain: ['Good morning', 'Morning', 'Another morning, another problem']
  },
  noon: {
    withName: [
      'Hello, {name} — hello, noon',
      'Hello noon moon, {name}',
      'Midday, {name}',
      'Good day, {name}'
    ],
    plain: ['Hello, noon', 'Hello noon moon', 'Midday']
  },
  afternoon: {
    withName: [
      'Good afternoon, {name}',
      'Energetic afternoon, {name}',
      'Afternoon, {name} — still going strong',
      'Good afternoon, {name}. Post-lunch brain?'
    ],
    plain: ['Good afternoon', 'Energetic afternoon', 'Afternoon']
  },
  evening: {
    withName: [
      'Good evening, {name}',
      'Evening, {name}',
      'Good evening, {name} — one more problem?',
      'Winding down, {name}?'
    ],
    plain: ['Good evening', 'Evening']
  },
  night: {
    withName: [
      'Hi, night owl {name}',
      'Still up, {name}?',
      'Burning the midnight oil, {name}',
      'Up late, {name}. What are we solving?'
    ],
    plain: [
      'Burning the midnight oil',
      'Late night',
      'Still up?'
    ]
  }
}

/**
 * The line under the greeting. Name-free on purpose — see the note at the top.
 *
 * Kept to ten so the day-to-day rotation below has enough range not to feel
 * like a loop, and phrased as an invitation rather than a suggestion, because
 * the student is the one who knows what they are stuck on.
 */
const PROMPTS: readonly string[] = [
  'What brings you here today?',
  'What are we working on?',
  'Which problem are we tackling?',
  'Got a problem in mind?',
  'Physics, chemistry, or maths today?',
  'What is on the exam?',
  'Where are we stuck?',
  'Which one do we start with?',
  'Ready when you are — what is it?',
  'What shall we solve?'
]

/** Order matters only for the seed below; kept alphabetical for readability. */
const BAND_INDEX: Record<DayBand, number> = {
  night: 0,
  morning: 1,
  noon: 2,
  afternoon: 3,
  evening: 4
}

/**
 * Days since 1 January, counted by walking month lengths rather than dividing
 * elapsed milliseconds. A division is off by one twice a year at a daylight
 * saving boundary, which is a silly way to get a slightly different greeting.
 */
function dayOfYear(date: Date): number {
  const lengths = [31, isLeap(date.getFullYear()) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  let day = date.getDate()
  // NoUncheckedIndexedAccess: the bound is `getMonth()`, which is 0–11, so the
  // index is always in range. The assertion says that rather than a `?? 0` that
  // would silently make a wrong day look like a right one.
  for (let month = 0; month < date.getMonth(); month++) day += lengths[month] as number
  return day
}

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

/**
 * Picks a stable item from a list.
 *
 * The seed is the day and the band, so the choice changes when the student comes
 * back later in the day and does **not** change while they are looking at it. A
 * rotating line would move under the cursor between reading it and clicking
 * Send, which reads as a glitch rather than as personality.
 *
 * 31 and 7 are coprime with the list length, so a fixed band does not re-roll
 * the same prompt on the same day-of-month every month.
 */
function pick(list: readonly string[], date: Date, band: DayBand): string {
  const seed = (dayOfYear(date) * 31 + BAND_INDEX[band] * 7) % list.length
  return list[seed] as string
}

/** The heading. `name` may be empty, in which case the plain variant is used. */
export function greetingFor(date: Date, name: string): string {
  const band = bandFor(date.getHours())
  const short = shortName(name)

  if (short === '') {
    const list = GREETINGS[band].plain
    return pick(list, date, band)
  }

  const list = GREETINGS[band].withName
  return (pick(list, date, band) as string).replace('{name}', short)
}

/** The line between the greeting and the composer. */
export function promptFor(date: Date): string {
  return pick(PROMPTS, date, bandFor(date.getHours()))
}
