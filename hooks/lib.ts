import type { Day, Pace, Plan, RoutineDay } from '../types'

// Weekday key to its day, every day in the one internal shape.
export type Routine = Record<string, RoutineDay>

// A multi day holds at most this many exercises.
export const MAX_EXERCISES = 5

// A day with no plan: no goal, counted as reps.
export const NO_PLAN: Plan = { exercise: 'reps', goal: 0 }

export const single = (plan: Plan): RoutineDay => ({ plans: [plan] })

export const isMultiDay = (day: RoutineDay) => day.isMulti === true

// A day as routine.json and a `.swap` file hold it: a single day as its plan
// object, a multi day as `{ name?, exercises }`.
export const dayToFile = (day: RoutineDay) =>
  day.isMulti === true
    ? { ...(day.name === undefined ? {} : { name: day.name }), exercises: day.plans }
    : day.plans[0] ?? NO_PLAN

export const routineToFile = (routine: Routine) =>
  Object.fromEntries(Object.entries(routine).map(([weekday, day]) => [weekday, dayToFile(day)]))

// Every plan in a routine, day by day, multi days' exercises in their order.
export const allPlans = (routine: Routine) => Object.values(routine).flatMap(day => day.plans)

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

export const isRecord = (raw: unknown): raw is Record<string, unknown> => typeof raw === 'object' && raw !== null && !Array.isArray(raw)

// A name from a file as it is shown: no C0 or C1 control characters, so no terminal escape or newline.
const shown = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '')

// A single day's plan reads as it always has: any named exercise with a numeric goal, 0
// included (a frozen no-plan day is `reps`/0). Its other fields stay, so a rewrite keeps them.
const asPlan = (raw: unknown): Plan | undefined => {
  if (!isRecord(raw) || typeof raw.exercise !== 'string' || shown(raw.exercise).trim() === '') return undefined
  if (typeof raw.goal !== 'number' || !Number.isFinite(raw.goal)) return undefined
  const { unit, ...rest } = raw
  return { ...rest, exercise: shown(raw.exercise), goal: raw.goal, ...(typeof unit === 'string' ? { unit: shown(unit) } : {}) }
}

// One routine day from its file form. `dropped` names each entry left out, for
// the toast; `day` is undefined when nothing usable is left.
export const parseRoutineDay = (raw: unknown, where = ''): { day?: RoutineDay; dropped: string[] } => {
  const at = where === '' ? '' : `${where} `
  if (isRecord(raw) && 'exercises' in raw) {
    if (!Array.isArray(raw.exercises)) return { dropped: [`${at}(exercises is not a list)`] }
    const dropped: string[] = []
    const seen = new Set<string>()
    const plans: Plan[] = []
    for (const [i, entry] of raw.exercises.entries()) {
      const name = isRecord(entry) && typeof entry.exercise === 'string' ? shown(entry.exercise).trim() : ''
      const plan = asPlan(entry)
      const why =
        name === '' ? 'no name'
        : plan === undefined || plan.goal <= 0 ? 'goal must be above 0'
        : seen.has(name.toLowerCase()) ? 'listed twice'
        : plans.length >= MAX_EXERCISES ? `over ${MAX_EXERCISES} exercises`
        : undefined
      if (why !== undefined || plan === undefined) {
        dropped.push(`${at}${name === '' ? `#${i + 1}` : name} (${why})`)
        continue
      }
      seen.add(name.toLowerCase())
      plans.push({ ...plan, exercise: name })
    }
    const named = typeof raw.name === 'string' ? shown(raw.name).trim() : ''
    const name = named === '' ? undefined : named
    return { ...(plans.length === 0 ? {} : { day: { isMulti: true, ...(name === undefined ? {} : { name }), plans } }), dropped }
  }
  const plan = asPlan(raw)
  return plan === undefined ? { dropped: [`${at}(not a plan)`] } : { day: single(plan), dropped: [] }
}

// routine.json's contents as a Routine, and every weekday entry it left out. Other keys are no day.
export const parseRoutine = (raw: unknown): { routine: Routine; dropped: string[] } => {
  const routine: Routine = {}
  const dropped: string[] = []
  for (const [weekday, value] of Object.entries(isRecord(raw) ? raw : {})) {
    if (!WEEKDAYS.includes(weekday)) continue
    const read = parseRoutineDay(value, weekday)
    if (read.day !== undefined) routine[weekday] = read.day
    dropped.push(...read.dropped)
  }
  return { routine, dropped }
}

// The one toast for a routine with entries left out.
export const droppedText = (dropped: readonly string[]) => `routine.json: left out ${dropped.join(', ')}.`

// The counts of a multi day's log, or undefined when it is not a whole JSON
// object: another session may be mid-write.
const countsObject = (trimmed: string): Record<string, unknown> | undefined => {
  try {
    const raw: unknown = JSON.parse(trimmed)
    return isRecord(raw) ? raw : undefined
  } catch {
    return undefined
  }
}

// A log that started as counts per exercise and doesn't parse: never written over.
export const isDamagedLog = (text: string | undefined) =>
  text !== undefined && text.trim().startsWith('{') && countsObject(text.trim()) === undefined

// A day's log: a plain count on a single day, counts per exercise on a multi day. A plain number on a
// multi day counts for its first exercise; an object on a single day gives its exercise's count, else the first.
export const parseDayLog = (text: string | undefined, exercises: readonly string[]): number[] => {
  const zeros = exercises.map(() => 0)
  if (text === undefined) return zeros
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) {
    const raw = countsObject(trimmed)
    if (raw === undefined) return zeros
    const counts = new Map(Object.entries(raw).flatMap(([key, value]) =>
      typeof value === 'number' && Number.isFinite(value) ? [[key.toLowerCase(), Math.max(0, value)] as const] : []))
    const read = exercises.map(exercise => counts.get(exercise.toLowerCase()))
    if (exercises.length === 1 && read[0] === undefined) return [[...counts.values()][0] ?? 0]
    return read.map(count => count ?? 0)
  }
  const n = parseInt(trimmed, 10)
  return zeros.map((zero, i) => (i === 0 && Number.isFinite(n) ? n : zero))
}

// A multi day's log keeps the counts `before` (the file's text) holds for exercises off its plan now.
export const formatDayLog = (entries: readonly { exercise: string; count: number }[], isMulti: boolean, before?: string) => {
  if (!isMulti) return `${entries[0]?.count ?? 0}\n`
  const planned = new Set(entries.map(({ exercise }) => exercise.toLowerCase()))
  const kept = Object.entries(countsObject(before?.trim() ?? '') ?? {}).filter(([key]) => !planned.has(key.toLowerCase()))
  return `${JSON.stringify(Object.fromEntries([...entries.map(({ exercise, count }) => [exercise, count] as const), ...kept]))}\n`
}

// One day of routine.json with the day's goals set in it. A multi day's entries
// match its plans as the parser kept them; an entry it left out stays as written.
const dayGoalsOverFile = (rawDay: unknown, day: RoutineDay) => {
  if (!isRecord(rawDay)) return dayToFile(day)
  if (!isMultiDay(day)) return { ...rawDay, goal: day.plans[0]?.goal ?? rawDay.goal }
  if (!Array.isArray(rawDay.exercises)) return dayToFile(day)
  const left = [...day.plans]
  const exercises = rawDay.exercises.map((entry: unknown) => {
    const plan = asPlan(entry)
    const at = plan === undefined || plan.goal <= 0 ? -1 : left.findIndex(kept => kept.exercise === plan.exercise.trim())
    const [match] = at < 0 ? [] : left.splice(at, 1)
    return match === undefined || !isRecord(entry) ? entry : { ...entry, goal: match.goal }
  })
  return { ...rawDay, exercises }
}

// routine.json's contents with `routine`'s goals set in place: other keys, days and left-out entries stay as written.
export const goalsOverFile = (raw: Record<string, unknown>, routine: Routine): Record<string, unknown> => ({
  ...raw,
  ...Object.fromEntries(Object.entries(routine).map(([weekday, day]) => [weekday, dayGoalsOverFile(raw[weekday], day)])),
})

// Which exercise a bare `/fit 20` logs to: the one logged last today, or the first.
export const logTarget = (exercises: readonly { exercise: string }[], last: string | undefined) =>
  Math.max(0, exercises.findIndex(entry => entry.exercise === last))

export type ExerciseMatch = { kind: 'one'; index: number } | { kind: 'many'; names: string[] } | { kind: 'none' }

// A name as matching compares it: one space between words, lowercase.
const normalName = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase()

// Which of `names` a typed name means: a whole name in any case, else the only one it starts.
export const matchExercise = (typed: string, names: readonly string[]): ExerciseMatch => {
  const wanted = normalName(typed)
  if (wanted === '') return { kind: 'none' }
  const normalNames = names.map(normalName)
  const whole = normalNames.indexOf(wanted)
  if (whole >= 0) return { kind: 'one', index: whole }
  const starts = normalNames.flatMap((name, i) => (name.startsWith(wanted) ? [i] : []))
  const [only, ...more] = starts
  if (only === undefined) return { kind: 'none' }
  return more.length === 0 ? { kind: 'one', index: only } : { kind: 'many', names: starts.map(i => names[i] ?? '') }
}

export const DEFAULT_ROUTINE: Routine = {
  mon: single({ exercise: 'pushups', goal: 100 }),
  tue: single({ exercise: 'dips', goal: 100 }),
  wed: single({ exercise: 'squats', goal: 300 }),
  thu: single({ exercise: 'pushups', goal: 100 }),
  fri: single({ exercise: 'dips', goal: 100 }),
  sat: single({ exercise: 'squats', goal: 300 }),
  sun: single({ exercise: 'pushups', goal: 100 }),
}

const DAY_MS = 86_400_000

const pad = (n: number) => String(n).padStart(2, '0')

export const dayKey = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export const weekdayKey = (ms: number) => WEEKDAYS[new Date(ms).getDay()] ?? 'sun'

// Noon anchors keep day arithmetic clear of DST shifts.
export const lastDays = (ms: number, n: number) => {
  const d = new Date(ms)
  const noon = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12).getTime()
  return Array.from({ length: n }, (_, i) => noon - (n - 1 - i) * DAY_MS)
}

// Noon of a dated day, as `lastDays` anchors them.
export const noonOf = (date: string) => {
  const [y = 0, m = 1, d = 1] = date.split('-').map(Number)
  return new Date(y, m - 1, d, 12).getTime()
}

export const bar = (count: number, goal: number, width = 10) => {
  const filled = goal > 0 ? Math.min(width, Math.floor((count / goal) * width)) : 0
  return '▓'.repeat(filled) + '░'.repeat(width - filled)
}

export type FitCommand =
  | { kind: 'status' }
  // `days`: open on that chart range. Absent: toggle the scoreboard.
  | { kind: 'week'; days?: number }
  | { kind: 'skip' }
  | { kind: 'unskip' }
  | { kind: 'help' }
  | { kind: 'hide' }
  | { kind: 'reload' }
  | { kind: 'reset' }
  | { kind: 'intro' }
  | { kind: 'program' }
  | { kind: 'swap'; exercise?: string }
  | { kind: 'strict'; isOn: boolean }
  | { kind: 'progress'; isOn: boolean }
  // `typedName`: what was typed after the number, all or the start of a name; absent, a bare /fit's target.
  | { kind: 'add'; n: number; typedName?: string }
  | { kind: 'set'; n: number; typedName?: string }
  | { kind: 'goal'; n: number }
  // null: back to the configured window from the first prompt.
  | { kind: 'window'; hours: number | null }
  | { kind: 'window-until'; hour: number; minute: number }
  | { kind: 'snooze'; minutes: number }
  | { kind: 'error'; text: string }

// How long a set can be put off, and how often.
export const SNOOZE = { defaultMinutes: 30, maxMinutes: 60, perDay: 2 } as const

const USAGE = 'usage: /fit [<n> [exercise] | set <n> [exercise] | reset | goal <n> | window <hours>|<hhmm>|off | snooze [minutes] | swap [exercise] | rest [off] | streak [days] | program | progress [off] | help | strict | easy | reload | start | hide]'

// The name typed after `/fit 20` or `/fit set 80`: names may be several words ("jumping jacks").
const namedAfter = (args: string, words: number) => {
  const name = normalName(args.trim().split(/\s+/).slice(words).join(' '))
  return name === '' ? {} : { typedName: name }
}

export const parseFit = (args: string): FitCommand => {
  const [head = '', value] = args.trim().split(/\s+/)
  if (head === '' || head === 'status') return { kind: 'status' }
  if (head === 'streak') {
    if (value === undefined) return { kind: 'week' }
    const days = /^\d+d?$/.test(value) ? parseInt(value, 10) : NaN
    return days >= 2 && days <= 365
      ? { kind: 'week', days }
      : { kind: 'error', text: 'fit: streak charts 2 to 365 days, like /fit streak 90' }
  }
  if (head === 'rest') return value === 'off' ? { kind: 'unskip' } : { kind: 'skip' }
  if (head === 'program') return { kind: 'program' }
  if (head === 'swap') {
    // Names may be several words ("jumping jacks"): keep everything after "swap".
    const name = args.trim().replace(/^swap\s*/, '').replace(/\s+/g, ' ').toLowerCase()
    return name === '' ? { kind: 'swap' } : { kind: 'swap', exercise: name }
  }
  if (head === 'help' || head === 'rules') return { kind: 'help' }
  if (head === 'hide') return { kind: 'hide' }
  if (head === 'reload' || head === 'sync') return { kind: 'reload' }
  if (head === 'reset') return { kind: 'reset' }
  if (head === 'start') return { kind: 'intro' }
  if (head === 'strict') return { kind: 'strict', isOn: value !== 'off' }
  if (head === 'easy') return { kind: 'strict', isOn: false }
  if (head === 'progress') return { kind: 'progress', isOn: value !== 'off' }
  if (head === 'set') {
    return value !== undefined && /^\d+$/.test(value)
      ? { kind: 'set', n: Number(value), ...namedAfter(args, 2) }
      : { kind: 'error', text: 'fit: set needs a number' }
  }
  if (head === 'goal') {
    return value !== undefined && /^\d+$/.test(value) && Number(value) > 0
      ? { kind: 'goal', n: Number(value) }
      : { kind: 'error', text: 'fit: goal needs a number of reps, like /fit goal 60' }
  }
  if (head === 'window') {
    if (value === 'off') return { kind: 'window', hours: null }
    // "1240", "940" or "12:40": an end time today, on the 24-hour clock.
    const clock = value === undefined ? null : /^(\d{1,2}):?(\d{2})$/.exec(value)
    if (clock !== null && (value?.includes(':') === true || (value?.length ?? 0) >= 3)) {
      const hour = Number(clock[1])
      const minute = Number(clock[2])
      return hour < 24 && minute < 60
        ? { kind: 'window-until', hour, minute }
        : { kind: 'error', text: 'fit: window needs a time like 1240 or 12:40 (24-hour clock)' }
    }
    // "3", "1.5" or "3h": hours from now, up to a day.
    const hours = value !== undefined && /^\d+(\.\d+)?h?$/.test(value) ? parseFloat(value) : NaN
    return hours > 0 && hours <= 24
      ? { kind: 'window', hours }
      : { kind: 'error', text: 'fit: window needs hours from now (up to 24) like /fit window 3, an end time like 1240, or off' }
  }
  if (head === 'snooze' || head === 'later') {
    // "30" or "30m": minutes from now, within the cap.
    const minutes = value === undefined ? SNOOZE.defaultMinutes : /^\d+m?$/.test(value) ? parseInt(value, 10) : NaN
    return minutes > 0 && minutes <= SNOOZE.maxMinutes
      ? { kind: 'snooze', minutes }
      : { kind: 'error', text: `fit: snooze takes minutes from now, up to ${SNOOZE.maxMinutes}, like /fit snooze 30` }
  }
  if (/^-?\d+$/.test(head)) return { kind: 'add', n: Number(head), ...namedAfter(args, 1) }
  return { kind: 'error', text: USAGE }
}

export const isDone = (day: Day) => !day.isSkipped && day.goal > 0 && day.count >= day.goal

// Any reps keep a streak alive; only a day with none, or a rest day, breaks it.
const keepsStreak = (day: Day) => !day.isSkipped && day.count > 0

// History and the ledger hold one entry per exercise, so anything that counts days groups
// a date's entries first. Input is in date order; each group is one date's entries.
export const byDate = (days: readonly Day[]): Day[][] => {
  const groups: Day[][] = []
  for (const day of days) {
    const last = groups[groups.length - 1]
    if (last?.[0]?.date === day.date) last.push(day)
    else groups.push([day])
  }
  return groups
}

// Each date's entries by its date key.
export const entriesByDate = (days: readonly Day[]) => new Map(byDate(days).map(entries => [entries[0]?.date, entries]))

// A date is hit only when every exercise on it hit, and kept by any reps.
export const isDateDone = (entries: readonly Day[]) => entries.length > 0 && entries.every(isDone)
export const keepsDateStreak = (entries: readonly Day[]) => entries.some(keepsStreak)
const isDateSkipped = (entries: readonly Day[]) => entries.some(day => day.isSkipped)
const dateCount = (entries: readonly Day[]) => entries.reduce((total, day) => total + day.count, 0)

// Today counts once it has reps; an empty today does not break the run yet,
// but a rest day taken today does.
export const streak = (history: readonly Day[]) => {
  const dates = byDate(history)
  let run = 0
  for (let i = dates.length - 1; i >= 0; i--) {
    const entries = dates[i]
    if (entries === undefined) break
    if (keepsDateStreak(entries)) run++
    else if (i !== dates.length - 1 || isDateSkipped(entries)) break
  }
  return run
}

// The engine environment has Uint8Array#toBase64; es2023 typings do not.
type Base64Bytes = Uint8Array & { toBase64: () => string }

export const encodeCells = (words: Uint32Array) => (new Uint8Array(words.buffer) as Base64Bytes).toBase64()

const ACCENT = 0xc8a86b
const PARTIAL = 0x6b5d3f
export const EMPTY = 0x343434
export const DEFAULT = 0x01000000

// The streak, counting days older than the window when every day in it has reps.
export const fullStreak = (history: readonly Day[], older: number) => {
  const run = streak(history)
  const dates = byDate(history)
  const last = dates[dates.length - 1]
  const coversWindow = run === dates.length || (run === dates.length - 1 && last !== undefined && !keepsDateStreak(last) && !isDateSkipped(last))
  return coversWindow ? run + older : run
}

// The grid's colors as text colors, for its legend.
export const GRID_COLORS = {
  goal: `#${ACCENT.toString(16)}`,
  some: `#${PARTIAL.toString(16)}`,
  none: `#${EMPTY.toString(16)}`,
} as const

// One row per week, seven 2-cell days with a gap: 20 columns. A blank row
// between weeks keeps the days square, so it reads as a grid, not bars.
export const heatCells = (history: readonly Day[]) => {
  const dates = byDate(history)
  const weeks = Math.ceil(dates.length / 7)
  const columns = 20
  const rows = Math.max(1, weeks * 2 - 1)
  const words = new Uint32Array(columns * rows * 3)
  for (let row = 0; row < rows; row++) {
    const week = row / 2
    for (let col = 0; col < columns; col++) {
      const entries = row % 2 === 1 ? undefined : dates[week * 7 + Math.floor(col / 3)]
      const isGap = col % 3 === 2 || entries === undefined
      const color = isGap
        ? DEFAULT
        : isDateDone(entries)
          ? ACCENT
          : dateCount(entries) > 0
            ? PARTIAL
            : EMPTY
      const at = (row * columns + col) * 3
      // Today, the last day, is drawn shaded so it stands out from finished days.
      const isToday = row % 2 === 0 && week * 7 + Math.floor(col / 3) === dates.length - 1
      words[at] = isGap ? 0x20 : isToday ? 0x2592 : 0x2588
      words[at + 1] = color
      words[at + 2] = DEFAULT
    }
  }
  return { columns, rows, cells: encodeCells(words) }
}

// Grey until the first rep, then yellow on the way and green for the last fifth.
// No red: an unfinished day is work in progress, not an error. No goal: undefined draws dim.
export const progressColor = (count: number, goal: number) => {
  if (goal <= 0 || count <= 0) return undefined
  const share = count / goal
  return share >= 0.8 ? '#87af87' : '#d7af5f'
}

export const daily = (exercise: string, goal: number): Routine =>
  Object.fromEntries(WEEKDAYS.map(day => [day, single({ exercise, goal })]))

// The routine with each plan changed, days and names kept.
const mapPlans = (routine: Routine, change: (plan: Plan) => Plan): Routine =>
  Object.fromEntries(Object.entries(routine).map(([weekday, day]) => [weekday, { ...day, plans: day.plans.map(change) }]))

export const ROUTINES = {
  'Push · dip · squat rotation': DEFAULT_ROUTINE,
  'Daily pushups': daily('pushups', 100),
  'Daily squats': daily('squats', 200),
} as const satisfies Record<string, Routine>

export const SIZES = { Light: 0.5, Standard: 1, Heavy: 2 } as const satisfies Record<string, number>

export const scale = (routine: Routine, factor: number): Routine =>
  mapPlans(routine, plan => ({ ...plan, goal: Math.max(5, Math.round((plan.goal * factor) / 5) * 5) }))

// Each exercise in a routine once, with its first day's goal.
export const exerciseGoals = (routine: Routine): Record<string, number> => {
  const goals = new Map<string, number>()
  for (const plan of allPlans(routine)) if (!goals.has(plan.exercise)) goals.set(plan.exercise, plan.goal)
  return Object.fromEntries(goals)
}

// The goal typed for an exercise: an own field only, so `constructor` is never Object's.
export const typedGoal = (typed: Record<string, string>, exercise: string) =>
  Object.hasOwn(typed, exercise) ? (typed[exercise] ?? '') : ''

// A custom program: the base routine's days, each exercise at the goal typed
// for it. A field left at its prefill changes nothing, so days that differ keep
// their own goals. Undefined while any goal isn't a whole number above zero.
export const customRoutine = (base: Routine, goals: Record<string, string>): Routine | undefined => {
  const parsed = new Map<string, number>()
  for (const [exercise, prefill] of Object.entries(exerciseGoals(base))) {
    const text = typedGoal(goals, exercise).trim()
    if (!/^\d+$/.test(text) || Number(text) <= 0) return undefined
    if (Number(text) !== prefill) parsed.set(exercise, Number(text))
  }
  return mapPlans(base, plan => ({ ...plan, goal: parsed.get(plan.exercise) ?? plan.goal }))
}

// "30 burpees" typed under Other: one exercise every day.
export const parseCustom = (text: string): Routine | undefined => {
  const match = /^\s*(\d+)\s+([a-z][a-z -]*?)\s*$/i.exec(text)
  if (match === null) return undefined
  const [, goal = '0', exercise = ''] = match
  return Number(goal) > 0 ? daily(exercise.toLowerCase(), Number(goal)) : undefined
}

// Monday first, as people read a week, with the name an error uses for its line.
export const WEEK_LINES = [
  ['mon', 'Monday'], ['tue', 'Tuesday'], ['wed', 'Wednesday'], ['thu', 'Thursday'], ['fri', 'Friday'], ['sat', 'Saturday'], ['sun', 'Sunday'],
] as const

const planLine = (plan: Plan) => `${plan.goal}${plan.unit ?? ''} ${plan.exercise}`

// A day as its Custom days line, `[<name>:] <goal>[unit] <exercise>, ...`; no plan is an empty line.
export const dayLine = (day: RoutineDay | undefined) =>
  day === undefined ? '' : `${day.isMulti === true && day.name !== undefined ? `${day.name}: ` : ''}${day.plans.map(planLine).join(', ')}`

// A Custom days line as a day: one exercise and no name is a single day, more or a name a multi day.
// It goes through the routine reader, so a line and routine.json share one set of rules.
export const parseDayLine = (line: string, units: readonly string[] = ['s']): { day: RoutineDay } | { error: string } => {
  const text = shown(line).replace(/\s+/g, ' ')
  // The last colon, so a day name may hold one.
  const colon = text.lastIndexOf(':')
  const name = colon < 0 ? '' : text.slice(0, colon).trim()
  const parts = text.slice(colon + 1).split(',').map(part => part.trim()).filter(part => part !== '')
  if (parts.length === 0) return { error: 'no exercise' }
  const errors: string[] = []
  const exercises = parts.flatMap(part => {
    const match = /^(\d+)([a-z]*) (.+)$/i.exec(part)
    const [, goal = '', typedUnit = '', exercise = ''] = match ?? []
    const unit = units.find(known => known !== '' && known.toLowerCase() === typedUnit.toLowerCase())
    const why =
      match === null ? `"${part}" should read like 100 dips or 180s plank`
      : typedUnit !== '' && unit === undefined ? `${exercise} (${typedUnit} is no unit; 180s is seconds)`
      : !Number.isSafeInteger(Number(goal)) ? `${exercise} (goal too large)`
      : undefined
    if (why !== undefined) errors.push(why)
    return why === undefined ? [{ exercise, goal: Number(goal), ...(unit === undefined ? {} : { unit }) }] : []
  })
  const read = parseRoutineDay({ ...(name === '' ? {} : { name }), exercises })
  errors.push(...read.dropped)
  const [first] = read.day?.plans ?? []
  if (errors.length > 0 || read.day === undefined || first === undefined) return { error: errors.join('; ') }
  return { day: name === '' && read.day.plans.length === 1 ? single(first) : read.day }
}

// The Custom days program, each weekday as its line reads, or each line that does not read, by weekday.
// A line left at its prefill keeps its day, and an emptied line leaves its weekday with no plan.
export const customDays = (base: Routine, lines: Record<string, string>): { routine: Routine } | { errors: string[] } => {
  const routine: Routine = { ...base }
  const errors: string[] = []
  // A unit routine.json already uses reads too, so its days' lines read back.
  const units = [...new Set(['s', ...allPlans(base).flatMap(plan => (plan.unit === undefined ? [] : [plan.unit]))])]
  for (const [weekday, label] of WEEK_LINES) {
    const line = (Object.hasOwn(lines, weekday) ? (lines[weekday] ?? '') : '').trim()
    if (line === dayLine(base[weekday]).trim()) continue
    if (line === '') {
      delete routine[weekday]
      continue
    }
    const read = parseDayLine(line, units)
    if ('error' in read) errors.push(`${label}: ${read.error}`)
    else routine[weekday] = read.day
  }
  return errors.length > 0 ? { errors } : { routine }
}

const PLAN_FIELDS = ['exercise', 'goal', 'unit']

// Fields a line cannot type (a `cue`, say) are the person's own, so a retyped day carries them over.
const otherFields = (raw: unknown, typed: readonly string[]) =>
  isRecord(raw) ? Object.fromEntries(Object.entries(raw).filter(([key]) => !typed.includes(key))) : {}

const planCount = (exercises: readonly unknown[]) => parseRoutineDay({ exercises }).day?.plans.length ?? 0

// Which entries the reader keeps is the parser's call, so a rewrite asks it rather than repeat its rules.
const keptAndLeft = (rawDay: unknown) => {
  if (!isRecord(rawDay) || !Array.isArray(rawDay.exercises)) return { kept: asPlan(rawDay) === undefined ? [] : [rawDay], left: [] }
  const entries: unknown[] = rawDay.exercises
  const kept: unknown[] = []
  const left: unknown[] = []
  entries.forEach((entry, i) => (planCount(entries.slice(0, i + 1)) > planCount(entries.slice(0, i)) ? kept : left).push(entry))
  return { kept, left }
}

// A retyped day over the day routine.json holds: each exercise keeps its entry's other fields, a multi
// day its own, and an entry the reader left out stays while it would still be left out.
const dayOverFile = (rawDay: unknown, day: RoutineDay) => {
  const { kept, left } = keptAndLeft(rawDay)
  const byName = new Map(kept.flatMap(entry => {
    const plan = asPlan(entry)
    return plan === undefined ? [] : [[plan.exercise.trim().toLowerCase(), entry] as const]
  }))
  const plans = day.plans.map(plan => ({ ...plan, ...otherFields(byName.get(plan.exercise.toLowerCase()), PLAN_FIELDS) }))
  if (!isMultiDay(day)) return plans[0] ?? NO_PLAN
  const exercises: unknown[] = [...plans]
  for (const entry of left) {
    if (planCount([...exercises, entry]) === plans.length) exercises.push(entry)
  }
  const own = isRecord(rawDay) && Array.isArray(rawDay.exercises) ? otherFields(rawDay, ['name', 'exercises']) : {}
  return { ...(day.name === undefined ? {} : { name: day.name }), ...own, exercises }
}

// routine.json's contents with each day of `routine` that differs from `base` written over it, and each
// day `routine` dropped taken out; the days left as they were, other keys and the rest stay as written.
export const daysOverFile = (raw: Record<string, unknown>, routine: Routine, base: Routine): Record<string, unknown> => ({
  ...Object.fromEntries(Object.entries(raw).filter(([key]) => !Object.hasOwn(base, key) || Object.hasOwn(routine, key))),
  ...Object.fromEntries(Object.entries(routine)
    .filter(([weekday, day]) => JSON.stringify(day) !== JSON.stringify(base[weekday]))
    .map(([weekday, day]) => [weekday, dayOverFile(raw[weekday], day)])),
})

// A goal's step: a twentieth (5%) in fives, at least 5.
export const stepFor = (goal: number) => Math.max(5, Math.round(goal / 20 / 5) * 5)

// Where an exercise's goal goes next, from its days before today, newest first.
// Only days with reps count as sessions: rest days and empty days are passed
// over. The last session must have been trained at `goal`, so a day with a goal
// of its own (`/fit goal`) or one already counted moves nothing. A hit steps up;
// two short sessions in a row step back. Undefined: the goal stays.
export const nextGoal = (goal: number, past: readonly Day[]) => {
  const [last, before] = past.filter(day => !day.isSkipped && day.count > 0)
  if (last === undefined || goal <= 0 || last.goal !== goal) return undefined
  if (last.count >= goal) return goal + stepFor(goal)
  if (before === undefined || before.goal !== goal || before.count >= goal) return undefined
  // Never below 5, and a goal already there stays.
  const down = Math.max(5, goal - stepFor(goal))
  return down < goal ? down : undefined
}

// Whether an exercise's goal can move: every routine day of it at one goal. A
// routine that sets two goals for one exercise trades sessions between them,
// so neither is the last session of the other.
export const canProgress = (routine: Routine, exercise: string) =>
  new Set(allPlans(routine).filter(plan => plan.exercise === exercise).map(plan => plan.goal)).size === 1

// Whether a session at `goal` moves the exercise on: the routine's one goal for it, not a goal of its own.
export const progressesAt = (routine: Routine, exercise: string, goal: number) =>
  canProgress(routine, exercise) && allPlans(routine).some(plan => plan.exercise === exercise && plan.goal === goal)

// The routine with an exercise's goal moved: only the days at the old goal, so
// days a custom program set apart keep theirs.
export const moveGoal = (routine: Routine, exercise: string, from: number, to: number): Routine =>
  mapPlans(routine, plan => (plan.exercise === exercise && plan.goal === from ? { ...plan, goal: to } : plan))

// Today's exercise, swapped: the next one in the routine, or the one named.
export const pickSwap = (routine: Routine, current: string, wanted?: string) => {
  const plans = [...new Map(allPlans(routine).map(plan => [plan.exercise, plan])).values()]
  if (wanted !== undefined) return plans.find(plan => plan.exercise.toLowerCase() === wanted)
  if (plans.length === 0) return undefined
  const at = plans.findIndex(plan => plan.exercise === current)
  return plans[(at + 1) % plans.length]
}

// The scoreboard's barbell, the name across the bar. 34 columns wide.
export const BARBELL = {
  plates: ' ▐█▌▐█▌                    ▐█▌▐█▌ ',
  left: '━▐█▌▐█▌━━━ ',
  name: 'TERMINAL GYM',
  right: ' ━━━▐█▌▐█▌━',
  width: 34,
} as const

// Terminal cells a string takes: emoji draw two cells wide.
export const cells = (text: string) =>
  [...text].reduce((w, ch) => w + ((ch.codePointAt(0) ?? 0) >= 0x1f000 || ch === '✅' ? 2 : 1), 0)

// The terminal draws a Button as `[ label ]`, and a row puts one cell between buttons.
export const buttonsWidth = (labels: readonly string[]) =>
  labels.reduce((w, label) => w + cells(label) + 4, 0) + labels.length - 1

// The band's one-line barbell wordmark.
// Small plate, big plate, bar: ❚█═TERMINAL-GYM═█❚
export const MINI_BARBELL = { small: '❚', plate: '█═', name: 'TERMINAL-GYM', plateRight: '═█' } as const

// A set is a tenth of the goal, rounded to fives, unless the person picked a size.
export const setSizeFor = (goal: number, setting: number) => {
  if (goal <= 0) return 0
  if (setting > 0) return Math.min(setting, goal)
  return Math.min(goal, Math.max(5, Math.round(goal / 10 / 5) * 5))
}

// The band's quick-log buttons: a third, two thirds and a whole set, in fives
// (tens from a 60-rep set); the last is the set exactly. A set too small for
// three steps gets half, one and two, without repeats.
export const repSteps = (setSize: number) => {
  if (setSize <= 0) return [5, 10, 25]
  const step = setSize >= 60 ? 10 : 5
  const [third, twoThirds] = [1, 2].map(i => Math.round((setSize * i) / 3 / step) * step) as [number, number]
  if (third > 0 && third < twoThirds && twoThirds < setSize) return [third, twoThirds, setSize]
  return [...new Set([Math.ceil(setSize / 2), setSize, setSize * 2])]
}

// The goal as evenly spaced sets: the first due at the start, the last at the
// end of the window. `required` is what should be done by `now`.
const setGap = (goal: number, setSize: number, windowMs: number) => {
  const sets = Math.ceil(goal / setSize)
  return sets > 1 ? windowMs / (sets - 1) : windowMs
}

export const paceAt = (
  goal: number,
  count: number,
  setSize: number,
  startedAt: number,
  now: number,
  windowMs: number,
): Pace => {
  if (goal <= 0 || setSize <= 0) return { required: 0, behind: 0, setSize, nextDueAt: null, restUntil: null }
  const sets = Math.ceil(goal / setSize)
  const gap = setGap(goal, setSize, windowMs)
  const due = Math.min(sets, 1 + Math.floor(Math.max(0, now - startedAt) / gap))
  const required = Math.min(goal, due * setSize)
  return {
    required,
    behind: Math.max(0, required - count),
    setSize,
    nextDueAt: due < sets ? startedAt + due * gap : null,
    restUntil: null,
  }
}

// Behind, a set logged (a short one counts) earns a breather of half the gap
// between sets before the rest is due: catching up never means back-to-back sets.
export const breatherMs = (goal: number, setSize: number, windowMs: number) =>
  goal <= 0 || setSize <= 0 ? 0 : setGap(goal, setSize, windowMs) / 2

// Fewer reps than the band's smallest button (`smallest`; a multi day passes its exercise's own)
// earn their share of the breather: 2 of a 5-rep button, two fifths. A full button or more earns it all.
export const earnedBreatherMs = (added: number, goal: number, setSize: number, windowMs: number, smallest = repSteps(setSize)[0] ?? setSize) => {
  if (added <= 0) return 0
  return breatherMs(goal, setSize, windowMs) * Math.min(1, added / Math.max(1, smallest))
}

// Percent, so reps and seconds add up on one schedule; a set is the tenth a single day's default is.
const MULTI_PACE = { goal: 100, setSize: 10 } as const

// A count against its goal: what the share and the set ideas read.
type Tally = { count: number; goal: number }

// What the set schedule paces, in the units its numbers are in.
export type PaceScale = { goal: number; count: number; setSize: number }

// Capped so extra dips never cover a skipped plank; whole percent so a due share reads
// cleanly. The nudge keeps a float like 9.999… from flooring a full tenth to 9.
export const dayShare = (exercises: readonly Tally[]) => {
  if (exercises.length === 0) return 0
  const shares = exercises.reduce((sum, e) => sum + (e.goal > 0 ? Math.min(1, Math.max(0, e.count) / e.goal) : 1), 0)
  return Math.floor((shares / exercises.length) * MULTI_PACE.goal + 1e-9)
}

// One schedule for both kinds of day: a multi day's exercises can't share a rep count,
// so it is paced by its share instead. A day with no exercise has nothing to pace.
export const paceScale = (day: { isMulti: boolean; exercises: readonly Tally[] }, setSetting: number): PaceScale => {
  if (day.isMulti) return { goal: MULTI_PACE.goal, count: dayShare(day.exercises), setSize: MULTI_PACE.setSize }
  const goal = day.exercises[0]?.goal ?? 0
  return { goal, count: day.exercises[0]?.count ?? 0, setSize: setSizeFor(goal, setSetting) }
}

// A due share is no exercise a person can do, so it is offered as real sets, the one
// logged last first: each the share a set is of the day, of that exercise's goal, never past it.
export const setIdeas = <E extends Tally & { exercise: string }>(exercises: readonly E[], last: string | undefined) => {
  const open = exercises.filter(e => e.goal > 0 && e.count < e.goal)
  const lead = open.find(e => e.exercise === last) ?? open[0]
  const ordered = lead === undefined ? [] : [lead, ...open.filter(e => e !== lead)]
  return ordered.map(e => ({ ...e, amount: Math.min(Math.ceil((e.goal * MULTI_PACE.setSize) / MULTI_PACE.goal), e.goal - e.count) }))
}

// Time left, rounded up to the minute: "23m", "1h", "1h 5m".
export const untilText = (ms: number) => {
  const minutes = Math.max(1, Math.ceil(ms / 60_000))
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return h === 0 ? `${m}m` : m === 0 ? `${h}h` : `${h}h ${m}m`
}

export const clockTime = (ms: number) => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const CHEERS = ['Good set.', 'Strong set.', 'Reps in the bank.', 'Keep stacking.', 'Clean work.', "That's how it's built."]

// The toast for a logged set short of the goal. The line turns with the set's
// number, not the rep count: sets come in fives, so a count like 30, 60, 90
// would land on one line every time.
export const cheer = (added: number, count: number, goal: number, exercise: string, unit = '') => {
  if (goal > 0 && count >= goal) return `💪 +${added}${unit} ${exercise}, done (${count}/${goal}${unit}).`
  const line = CHEERS[Math.floor(count / Math.max(1, added)) % CHEERS.length] ?? CHEERS[0]
  const left = goal > count ? ` ${goal - count}${unit} to go.` : ''
  return `💪 +${added}${unit} ${exercise}. ${line}${left}`
}

export const describeRoutine = (routine: Routine) =>
  [...new Set(allPlans(routine).map(planLine))].join(' / ')

export const HELP = `## Help

**Your agent put in the reps. You next.**
When a turn runs long, drop and do a set.

### Log a set
\`/fit 20\` adds 20 reps
or press a **+** button above the prompt (sized to your set)

### Commands
| Command | Does |
|---|---|
| \`/fit\` | today's progress |
| \`/fit set 80 [exercise]\` | fix today's count (the exercise named, or the one logged last) |
| \`/fit reset\` | today back to 0 |
| \`/fit goal 60\` | change today's goal |
| \`/fit window 3\` | finish today in the next 3h |
| \`/fit snooze 30\` | put the due set off 30 min (twice a day) |
| \`/fit swap\` | switch today's exercise |
| \`/fit rest\` | rest day, before any reps (breaks streak) |
| \`/fit rest off\` | undo today's rest day |
| \`/fit streak\` | scoreboard: all-time totals, charts, the year |
| \`/fit streak 90\` | chart the last 90 days |
| \`/fit program\` | pick your training |
| \`/fit progress\` | hit a goal, the next session of it goes up 5% (\`off\` to stop) |
| \`/fit strict\` / \`/fit easy\` | strict mode on / off |
| \`/fit help\` | this list |
| \`/fit reload\` | re-read the log now (other sessions sync every 10s anyway) |
| \`/fit start\` | replay the welcome |
| \`/fit hide\` | close panels |

### Strict mode
Off by default. When it's on:
- today's goal is split into sets, spread over 8 hours (by default) from your first prompt
- \`/fit window 3\` spreads what's left over the next 3 hours instead (ending by midnight)
- prompts before 5am count as the night before
- the first set is due right away
- fall behind and your prompts wait until you catch up
- log a set, even a short one, and you get a breather before the rest (a few reps buy a shorter one)
- just eaten? \`/fit snooze 30\` puts the due set off, once per set and twice a day
- a toast tells you when each set comes due
- \`/fit easy\` stops holding prompts; \`/fit rest\` (before any reps) takes the day off

**Turn it on:** type \`/fit strict\`
**Turn it off:** type \`/fit easy\`

### Multi-exercise days
A day in \`~/.claude/fitness/routine.json\` can hold up to 5 exercises, each with its own goal:
\`"tue": { "name": "Arms day", "exercises": [ { "exercise": "dips", "goal": 100 }, { "exercise": "plank", "goal": 180, "unit": "s" } ] }\`
- or type them in \`/fit program\` under **Custom days**, a line per weekday: \`arms: 100 dips, 100 pushups, 180s plank\` (a name, then goals, \`s\` for seconds); \`30 burpees\` is a one-exercise day, and an empty line no plan
- the band shows the day's name, pace and streak, then a row per exercise with its own bar and **+** buttons (seconds for a timed one)
- a **+** logs to its row; \`/fit 20\` logs to the exercise you logged last, or the first
- \`/fit 20 dips\` logs to dips: any case, or the start of a name (\`/fit 20 di\`) when only one exercise starts that way
- \`/fit set 80 dips\` fixes one exercise; \`/fit set 80\` fixes the one you logged last; \`/fit reset\` puts every exercise back to 0
- a toast lists what is left when an exercise finishes, and every count when the day does
- a finished exercise shows ✅; the day counts once for the streak, and as hit when every exercise is
- entries with no name, a goal of 0 or less, a repeated name or past the fifth are left out, and a toast names them
- in strict mode a multi day is paced as a whole: each exercise's share of its goal, capped at 100%, averaged, in 10 sets of 10%; extra dips never cover a skipped plank
- a due set suggests a tenth of an exercise's goal, the one you logged last first: "10% of arms, e.g. 10 dips or 18s plank"; breathers, \`/fit snooze\` and \`/fit window\` work in those percent
- with progressive goals on, each exercise's goal moves on its own sessions
- not yet on a multi day: \`/fit swap\` and \`/fit goal\`

### Your data
Stays on this machine, in \`~/.claude/fitness\`.`
