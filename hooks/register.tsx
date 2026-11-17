import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Day, OnboardPick, Pace, Plan, RoutineDay, Today, TodayExercise } from '../types'
import {
  DEFAULT_ROUTINE,
  HELP,
  NO_PLAN,
  SNOOZE,
  MINI_BARBELL,
  ROUTINES,
  SIZES,
  allPlans,
  bar,
  earnedBreatherMs,
  clockTime,
  untilText,
  paceAt,
  paceScale,
  setIdeas,
  setSizeFor,
  stepFor,
  buttonsWidth,
  canProgress,
  cells,
  cheer,
  customRoutine,
  dayKey,
  dayToFile,
  droppedText,
  exerciseGoals,
  formatDayLog,
  fullStreak,
  goalsOverFile,
  isDamagedLog,
  isMultiDay,
  isRecord,
  keepsDateStreak,
  describeRoutine,
  heatCells,
  lastDays,
  logTarget,
  matchExercise,
  moveGoal,
  nextGoal,
  noonOf,
  parseDayLog,
  parseFit,
  parseRoutine,
  parseRoutineDay,
  pickSwap,
  progressColor,
  repSteps,
  routineToFile,
  scale,
  single,
  singleDays,
  streak,
  typedGoal,
  weekdayKey,
} from './lib'
import type { Routine } from './lib'
import { DEFAULT_RANGE } from './stats'
import { drawScoreboard } from './scoreboard'

type Engine = EngineInterface

const PANE = 'gym-week'
const HELP_PANE = 'gym-help'
const ONBOARD_PANE = 'gym-onboard'
const HISTORY_DAYS = 28
const TOAST_MS = 10_000
const HOUR_MS = 60 * 60_000
// How often a session looks for reps another session, or the shell, logged.
const SYNC_MS = 10_000

// Toasts stay up long enough to read mid-set.
const toast = ($: Engine, text: string) => $.ui.toast(text, { timeoutMs: TOAST_MS })

// The pace settings, set from the options each time the module registers.
const paceConfig = { setSize: 0, windowMs: 8 * HOUR_MS }
let dueTimer: { cancel: () => void } | undefined
// Redraws the band each minute, so "rest for 13m" and "next set in 23m" count down.
let bandTicker: { cancel: () => void } | undefined
// Polls the log on disk, which every session and the shell script share.
let syncTimer: { cancel: () => void } | undefined
// The log as this session last read it: the routine's time and each day's file.
let seenOnDisk = ''
// Progressive goals, set from the options; and the day this session last moved
// a goal for, so the check runs once a day.
const progressConfig = { isOn: false }
let progressedOn = ''
// The conversation the setup last ran for. /clear and /resume change it.
let bootedFor = ''
// The routine's left-out entries as last toasted: one toast per change, not per read.
let warnedDropped = ''

const today = atom({ plugin: 'terminal-gym', key: 'today' } as const, null)
const olderStreak = atom({ plugin: 'terminal-gym', key: 'olderStreak' } as const, 0)
const pace = atom({ plugin: 'terminal-gym', key: 'pace' } as const, null)
const isWaiting = atom({ plugin: 'terminal-gym', key: 'isWaiting' } as const, false)
const history = atom({ plugin: 'terminal-gym', key: 'history' } as const, [])
const ledger = atom({ plugin: 'terminal-gym', key: 'ledger' } as const, null)
const chartDays = atom({ plugin: 'terminal-gym', key: 'chartDays' } as const, DEFAULT_RANGE)
const isIntroduced = atom({ plugin: 'terminal-gym', key: 'isIntroduced' } as const, false)
const onboardStep = atom({ plugin: 'terminal-gym', key: 'onboardStep' } as const, 0)
const onboardPick = atom({ plugin: 'terminal-gym', key: 'onboardPick' } as const, {
  program: 'Push · dip · squat rotation',
  size: 'Standard',
  hasRoutine: false,
  base: DEFAULT_ROUTINE,
  custom: {},
  isCustomInvalid: false,
})

// Same files as the `fit` shell script, so both agree.
const files = async ($: Engine) => {
  // Windows sets USERPROFILE and often no HOME; with neither, the path would
  // land at the drive root.
  const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || ''
  const dir = `${home}/.claude/fitness`
  return { routine: `${dir}/routine.json`, log: `${dir}/log` }
}

const writeRoutine = ($: Engine, routinePath: string, routine: Routine) =>
  $.fs.write(routinePath, `${JSON.stringify(routineToFile(routine), null, 2)}\n`)

// Sets `routine`'s goals in routine.json and keeps the rest as written (goalsOverFile).
// A file that is no JSON object any more is left alone: false.
const writeGoals = async ($: Engine, routinePath: string, routine: Routine) => {
  const raw: unknown = JSON.parse(await $.fs.read(routinePath))
  if (!isRecord(raw)) return false
  await $.fs.write(routinePath, `${JSON.stringify(goalsOverFile(raw, routine), null, 2)}\n`)
  return true
}

const loadRoutine = async ($: Engine, routinePath: string): Promise<Routine> => {
  if (!(await $.fs.exists(routinePath))) {
    await writeRoutine($, routinePath, DEFAULT_ROUTINE)
    return DEFAULT_ROUTINE
  }
  const { routine, dropped } = parseRoutine(JSON.parse(await $.fs.read(routinePath)))
  const warning = dropped.length === 0 ? '' : droppedText(dropped)
  if (warning !== warnedDropped) {
    warnedDropped = warning
    if (warning !== '') toast($, warning)
  }
  return routine
}

// A day's log text. A multi day's half-written by another session is read once more.
const readLog = async ($: Engine, path: string) => {
  if (!(await $.fs.exists(path))) return undefined
  const text = await $.fs.read(path)
  return isDamagedLog(text) ? $.fs.read(path) : text
}

const plansOf = (day: RoutineDay | undefined) => (day === undefined || day.plans.length === 0 ? [NO_PLAN] : day.plans)

// `/fit swap` leaves the day's plan beside its count as `<date>.swap`, in a routine day's shape.
const readSwap = async ($: Engine, logDir: string, date: string): Promise<RoutineDay | undefined> => {
  const path = `${logDir}/${date}.swap`
  if (!(await $.fs.exists(path))) return undefined
  // A damaged or odd file falls back to the routine instead of breaking every refresh.
  try {
    return parseRoutineDay(JSON.parse(await $.fs.read(path))).day
  } catch {
    return undefined
  }
}

const writeSwap = async ($: Engine, date: string, day: RoutineDay) =>
  $.fs.write(`${(await files($)).log}/${date}.swap`, `${JSON.stringify(dayToFile(day))}\n`)

// `/fit rest` leaves `<date>.skip`; `/fit rest off` writes "off" into it to undo.
const readRest = async ($: Engine, path: string) =>
  (await $.fs.exists(path)) && (await $.fs.read(path)).trim() !== 'off'

// Progressive goals: at the day's first look, today's exercise moves on from
// its last sessions, the next time it comes around. Days before are frozen at
// the goals they were trained at first. Two sessions at once compute the same
// move, and the second finds the routine already moved, so a goal moves once.
const progress = async ($: Engine, date: string) => {
  if (!progressConfig.isOn || progressedOn === date) return
  progressedOn = date
  const { routine: routinePath, log: logDir } = await files($)
  // A day with a plan of its own (`/fit swap`, `/fit goal`) isn't the routine's.
  if (await $.fs.exists(`${logDir}/${date}.swap`)) return
  const routine = await loadRoutine($, routinePath)
  const now = await $.clock.now()
  const day = routine[weekdayKey(now)]
  // A multi day moves nothing until progressive goals move each of its exercises.
  if (day === undefined || isMultiDay(day)) return
  const plan = day.plans[0]
  const singles = singleDays(routine)
  if (plan === undefined || !canProgress(singles, plan.exercise)) return
  const before = lastDays(now, HISTORY_DAYS).slice(0, -1).reverse()
  // Sessions on single days only: a multi day's exercise is no session of this goal yet.
  const days = (await Promise.all(before.map(ms => readDated($, routine, logDir, ms)))).flatMap(d => (d.isMulti ? [] : d.entries))
  const to = nextGoal(plan.goal, days.filter(day => day.exercise === plan.exercise))
  if (to === undefined) return
  await freezePastDays($, routine)
  // Single days move; multi days, and any entry the reader left out, stay as the file has them.
  if (!(await writeGoals($, routinePath, moveGoal(singles, plan.exercise, plan.goal, to)))) return
  const unit = plan.unit ?? ''
  toast($, to > plan.goal
    ? `📈 ${plan.exercise} up to ${to}${unit}: your last session hit ${plan.goal}${unit}.`
    : `${plan.exercise} back to ${to}${unit} after two short sessions. Rebuild.`)
}

// Today from disk, with its pace file: refreshPace needs both, and reads the file once.
const readToday = async ($: Engine): Promise<{ t: Today; state: DayState }> => {
  const { routine, log: logDir } = await files($)
  const date = dayKey(await $.clock.now())
  await progress($, date)
  const day =
    (await readSwap($, logDir, date)) ?? (await loadRoutine($, routine))[weekdayKey(await $.clock.now())]
  const plans = plansOf(day)
  const counts = parseDayLog(await readLog($, `${logDir}/${date}`), plans.map(plan => plan.exercise))
  const state = await readDayState($, date)
  const { last } = state
  const kind = day?.isMulti === true
    ? { isMulti: true as const, ...(day.name === undefined ? {} : { name: day.name }) }
    : { isMulti: false as const }
  const next: Today = {
    date,
    exercises: plans.map((plan, i) => ({ exercise: plan.exercise, goal: plan.goal, unit: plan.unit ?? '', count: counts[i] ?? 0 })),
    ...kind,
    isRest: await readRest($, `${logDir}/${date}.skip`),
    ...(last === undefined ? {} : { last }),
  }
  await update($, today, () => next)
  return { t: next, state }
}

const refreshToday = async ($: Engine): Promise<Today> => (await readToday($)).t

const DAY_MS = 86_400_000

// A dated day as history entries: one on a single day, one per exercise on a multi day.
const readDated = async ($: Engine, routine: Routine, logDir: string, ms: number) => {
  const date = dayKey(ms)
  const day = (await readSwap($, logDir, date)) ?? routine[weekdayKey(ms)]
  const plans = plansOf(day)
  const counts = parseDayLog(await readLog($, `${logDir}/${date}`), plans.map(plan => plan.exercise))
  const isSkipped = await readRest($, `${logDir}/${date}.skip`)
  const entries: Day[] = plans.map((plan, i) => ({
    date,
    count: counts[i] ?? 0,
    goal: plan.goal,
    exercise: plan.exercise,
    isSkipped,
    ...(plan.unit === undefined ? {} : { unit: plan.unit }),
  }))
  return { isMulti: day !== undefined && isMultiDay(day), entries }
}

const readDay = async ($: Engine, routine: Routine, logDir: string, ms: number) => (await readDated($, routine, logDir, ms)).entries

// Days with reps in a row just before the window, so a streak can outlast it.
// Cached per window: a full walk once, then one day's step as the window slides.
const olderRun = async ($: Engine, days: readonly Day[], routine: Routine, logDir: string) => {
  const first = days.filter(day => day.date === days[0]?.date)
  if (first.length === 0 || !keepsDateStreak(first)) {
    await $.store.delete('streakRun')
    return 0
  }
  const oldest = lastDays(await $.clock.now(), HISTORY_DAYS)[0] ?? 0
  const asOf = dayKey(oldest)
  const cache = (await $.store.get('streakRun')) as { asOf?: string; older?: number } | undefined
  let older: number
  if (cache?.asOf === asOf && typeof cache.older === 'number') {
    older = cache.older
  } else if (cache?.asOf === dayKey(oldest - DAY_MS) && typeof cache.older === 'number') {
    // The window moved on a day: the day that left it joins the older run.
    older = keepsDateStreak(await readDay($, routine, logDir, oldest - DAY_MS)) ? cache.older + 1 : 0
  } else {
    older = 0
    for (let back = 1; back <= 366; back++) {
      if (!keepsDateStreak(await readDay($, routine, logDir, oldest - back * DAY_MS))) break
      older++
    }
  }
  await $.store.set('streakRun', { asOf, older })
  return older
}

const refreshHistory = async ($: Engine) => {
  const { routine: routinePath, log: logDir } = await files($)
  const routine = await loadRoutine($, routinePath)
  const days = (await Promise.all(lastDays(await $.clock.now(), HISTORY_DAYS).map(ms => readDay($, routine, logDir, ms)))).flat()
  await update($, history, () => days)
  const older = await olderRun($, days, routine, logDir)
  await update($, olderStreak, () => older)
  if (await isScoreboardOpen($)) await refreshLedger($)
  return days
}

const isScoreboardOpen = async ($: Engine) => (await $.ui.panes()).some(pane => pane.id === PANE)

// The days the log holds counts for: a count's file is named by its date alone.
const loggedDates = async ($: Engine, logDir: string) =>
  (await $.fs.exists(logDir)) ? (await $.fs.list(logDir)).map(entry => entry.name).filter(name => /^\d{4}-\d{2}-\d{2}$/.test(name)).sort() : []

// All-time: every day in the log, not just the grid's. It reads a file per day,
// so it runs only while the scoreboard is open.
const refreshLedger = async ($: Engine) => {
  const { routine: routinePath, log: logDir } = await files($)
  const routine = await loadRoutine($, routinePath)
  const dates = await loggedDates($, logDir)
  const days = await Promise.all(dates.map(date => readDay($, routine, logDir, noonOf(date))))
  // A date with reps keeps every entry, so a multi day's untouched exercise still marks it short.
  await update($, ledger, () => days.filter(entries => entries.some(day => day.count > 0)).flat())
}

type Schedule = { from: number; ms: number; base: number }

// The day's pace in `<date>.day`, shared by every session: its start, a `/fit window`, a breather's end,
// the `/fit snooze`s taken and the point put off, and `last`, the exercise a bare `/fit 20` logs to.
type DayState = { start?: number; window?: Schedule; breather?: number; laters?: number; putOff?: number; last?: string }

const dayPath = async ($: Engine, date: string) => `${(await files($)).log}/${date}.day`

const isSchedule = (w: unknown): w is Schedule =>
  typeof w === 'object' && w !== null && ['from', 'ms', 'base'].every(k => typeof (w as Record<string, unknown>)[k] === 'number')

// Only the fields of the right shape: a damaged file reads as an empty day.
const asDayState = (raw: unknown): DayState => {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  return {
    ...(typeof r.start === 'number' ? { start: r.start } : {}),
    ...(isSchedule(r.window) ? { window: r.window } : {}),
    ...(typeof r.breather === 'number' ? { breather: r.breather } : {}),
    ...(typeof r.laters === 'number' ? { laters: r.laters } : {}),
    ...(typeof r.putOff === 'number' ? { putOff: r.putOff } : {}),
    ...(typeof r.last === 'string' ? { last: r.last } : {}),
  }
}

// Up to 0.1.4 these sat in the plugin store, which a session may cache. A day
// started before the update still reads from there until its file is written.
const legacyDayState = async ($: Engine, date: string): Promise<DayState> => {
  const dated = (key: string) => $.store.get(key) as Promise<{ date?: string; [k: string]: unknown } | undefined>
  const [start, window, breather] = await Promise.all([dated('dayStart'), dated('window'), dated('breather')])
  return asDayState({
    start: start?.date === date ? start.at : undefined,
    window: window?.date === date ? { from: window.from, ms: window.ms, base: window.base } : undefined,
    breather: breather?.date === date ? breather.until : undefined,
  })
}

// The file's state, or null when it doesn't parse: another session may be
// mid-write, so a damaged file is read once more before giving up.
const readDayFile = async ($: Engine, path: string): Promise<DayState | null> => {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return asDayState(JSON.parse(await $.fs.read(path)))
    } catch {
      // Read it again.
    }
  }
  return null
}

const readDayState = async ($: Engine, date: string): Promise<DayState> => {
  const path = await dayPath($, date)
  if (!(await $.fs.exists(path))) return legacyDayState($, date)
  return (await readDayFile($, path)) ?? {}
}

// A damaged file is never written over: that would make the other session's
// loss permanent. The change is skipped, and the next one finds the file whole.
const writeDayState = async ($: Engine, date: string, change: (state: DayState) => DayState) => {
  const path = await dayPath($, date)
  const state = (await $.fs.exists(path)) ? await readDayFile($, path) : await legacyDayState($, date)
  if (state === null) return false
  await $.fs.write(path, `${JSON.stringify(change(state))}\n`)
  return true
}

// The day starts at the person's first prompt; sets are spread from there.
const dayStart = async ($: Engine, date: string) => (await readDayState($, date)).start

// Prompts before this hour belong to the night before: they never start the
// day, or a 00:30 prompt would leave every set overdue by morning.
const DAY_BEGINS_HOUR = 5

const startDay = async ($: Engine) => {
  const now = await $.clock.now()
  if (new Date(now).getHours() < DAY_BEGINS_HOUR) return
  const date = dayKey(now)
  if ((await dayStart($, date)) === undefined) await writeDayState($, date, s => ({ ...s, start: now }))
}

// Ends a breather, and forgets which set a `/fit snooze` put off: with the debt
// cleared or the count lowered, that set is no longer the one due.
const endBreather = ($: Engine, date: string) =>
  writeDayState($, date, ({ breather: _b, putOff: _p, ...rest }) => rest)

// `/fit goal` and `/fit window` change which set is due. A breather sized for
// the old schedule ends. A put-off keeps its time, since the person's minutes
// set it, not the goal, and it now names the new due point.
const reschedule = async ($: Engine, date: string): Promise<Pace | null> => {
  const now = await $.clock.now()
  const { breather, putOff } = await readDayState($, date)
  const kept = putOff !== undefined && breather !== undefined && breather > now
  await writeDayState($, date, ({ breather: b, putOff: _, ...rest }) => (kept ? { ...rest, breather: b } : rest))
  const p = await refreshPace($)
  if (!kept || p === null) return p
  await writeDayState($, date, s => ({ ...s, putOff: p.required }))
  return refreshPace($)
}

// The span today's sets are spread over: the configured window from the first
// prompt, or after `/fit window`, the reps left then (above `base`) over the hours named.
const scheduleOf = ({ window, start }: DayState): Schedule | undefined => {
  if (window !== undefined) return window
  return start === undefined ? undefined : { from: start, ms: paceConfig.windowMs, base: 0 }
}

const schedule = async ($: Engine, date: string) => scheduleOf(await readDayState($, date))

// Recomputes the pace and arms a timer for the next set or breather's end.
const refreshPace = async ($: Engine): Promise<Pace | null> => {
  dueTimer?.cancel()
  dueTimer = undefined
  // Re-read today: the date may have rolled over, or the shell script logged reps.
  const { t, state: day } = await readToday($)
  const paced = scaleOf(t)
  const s = scheduleOf(day)
  const now = await $.clock.now()
  let next: Pace | null = null
  if (!t.isRest && s !== undefined) {
    const left = paceAt(Math.max(0, paced.goal - s.base), paced.count - s.base, paced.setSize, s.from, now, s.ms)
    next = {
      ...left,
      // Goal met: the schedule may still hold sets, but none are due.
      nextDueAt: paced.goal > 0 && paced.count >= paced.goal ? null : left.nextDueAt,
      required: left.required + s.base,
      // A breather still running: catch-up reps owed, but prompts not held.
      restUntil: day.breather !== undefined && day.breather > now ? day.breather : null,
      isPutOff: day.putOff !== undefined && day.putOff === left.required + s.base,
      // A window set mid-day (base > 0) is never the day's opener, even after a reset.
      isOpening: s.base === 0 && t.exercises.every(e => e.count === 0) && left.behind > 0 && left.required <= left.setSize,
      ...(t.isMulti ? { unit: '%' as const } : {}),
    }
  }
  await update($, pace, () => next)
  bandTicker?.cancel()
  bandTicker = undefined
  // Only the countdowns paceText draws: "rest for 13m" and "next set in 23m".
  const countdownTo = next === null ? null
    : next.behind > 0 ? (next.isPutOff !== true ? next.restUntil : null)
    : next.nextDueAt
  if (countdownTo !== null) {
    // Wake when the minute shown changes, so a re-arm (a sync, a prompt) never delays it.
    // Each wait is measured from the clock, so an early timer or a sleep corrects itself.
    const tick = (at: number) => {
      const left = countdownTo - at
      if (left <= 0) return
      const timer = $.clock.after(left % 60_000 || 60_000, async () => {
        $.ui.invalidate('ui.render')
        const at = await $.clock.now()
        // A refreshPace while this waited has armed its own ticker: leave it be.
        if (bandTicker === timer) tick(at)
      })
      bandTicker = timer
    }
    tick(now)
  }
  const wakeAt = Math.min(next?.nextDueAt ?? Infinity, next?.restUntil ?? Infinity)
  if (wakeAt !== Infinity && paced.count < paced.goal) {
    dueTimer = $.clock.after(Math.max(1, wakeAt - now), () => void setDue($))
  }
  return next
}

const setDue = async ($: Engine) => {
  const p = await refreshPace($)
  const t = await read($, today)
  if (t === null || p === null || p.behind <= 0 || p.restUntil !== null) return
  if (p.isOpening === true) {
    toast($, t.isMulti ? `🏁 First set to start the day: ${setText(t, p.behind)}.` : `🏁 First set: ${setText(t, p.behind)} to start the day.`)
    return
  }
  toast($, `⏱ Set due: ${setText(t, p.behind)}. ${byNow(t, p)}.`)
}

// A Close button's press: a refused close says why instead of doing nothing.
const closePane = async ($: Engine, id: string) => {
  try {
    await $.ui.close({ id })
  } catch (err) {
    toast($, `Couldn't close the panel (${err instanceof Error ? err.message : String(err)}). Try Esc or /fit hide.`)
  }
}

// Owed reps read as a set that's due, not a debt; a breather as rest left.
const paceText = (p: Pace | null, isStrict: boolean, now: number) => {
  if (p === null) return ''
  const owed = `${p.behind}${p.unit ?? ''}`
  if (p.isOpening === true) return `  🏁 first set: ${owed} to start the day`
  if (p.behind > 0 && p.restUntil !== null) {
    if (p.isPutOff === true) return `  ${owed} due · back at ${clockTime(p.restUntil)}`
    return `  ${owed} due · rest for ${untilText(p.restUntil - now)}`
  }
  if (p.behind > 0) return `  ${owed} due now${isStrict ? ' · log it to keep prompting' : ''}`
  return p.nextDueAt === null ? '' : `  next set in ${untilText(p.nextDueAt - now)}`
}

const isFinished = (e: TodayExercise) => e.goal > 0 && e.count >= e.goal

const countText = (e: TodayExercise) => `${e.count}/${e.goal}${e.unit} ${e.exercise}`

const line = (e: TodayExercise) => `${isFinished(e) ? '✅' : '💪'} ${bar(e.count, e.goal)} ${countText(e)}`

// What is left of an exercise, for a multi day's replies.
const leftText = (e: TodayExercise) =>
  e.goal <= 0 ? '' : e.count < e.goal ? ` · ${e.goal - e.count}${e.unit} to go` : ' · done'

// A multi day's name, or its exercises when it has none.
const dayName = (t: Today) => t.name ?? t.exercises.map(e => e.exercise).join(' · ')

// Today in words. A single day is its line, then `pace` and `streak`; a multi
// day is a status row (its name, `pace`, `streak`) over a line per exercise.
const todayText = (t: Today, pace = '', streakText = '') => {
  const [first] = t.exercises
  if (!t.isMulti && first !== undefined) return `${line(first)}${streakText}${pace}`
  return [`🏋 ${dayName(t)}${pace}${streakText}`, ...t.exercises.map(line)].join('\n')
}

const streakOf = (days: readonly Day[], older = 0) => {
  const run = fullStreak(days, older)
  return run > 0 ? `  🔥${run}d` : ''
}

const withStreak = (t: Today, days: readonly Day[], older = 0) => todayText(t, '', streakOf(days, older))

// The exercise a bare `/fit 20` logs to, a nudge suggests and the spinner names.
const focusOf = (t: Today) => t.exercises[logTarget(t.exercises, t.last)] ?? t.exercises[0] ?? { ...NO_PLAN, unit: '', count: 0 }

// A single day's one exercise, for the commands a multi day still refuses. Undefined on a multi day.
const paceable = (t: Today) => (t.isMulti ? undefined : t.exercises[0])

// Read at each use: the set-size option is set when the module registers.
const scaleOf = (t: Today) => paceScale(t, paceConfig.setSize)

// Each idea in its exercise's own unit, so a plank reads in seconds.
const ideasText = (t: Today) => setIdeas(t.exercises, t.last).map(e => `${e.amount}${e.unit} ${e.exercise}`).join(' or ')

// A due set where a short reply has room. A multi day is named as the band names it.
const owedOf = (t: Today, owed: number) => (t.isMulti ? `${owed}% of ${dayName(t)}` : `${owed} ${paceable(t)?.exercise ?? 'reps'}`)

// A share is no exercise anyone can do, so a toast or a held prompt offers real sets for it.
const setText = (t: Today, owed: number) => (t.isMulti ? `${owedOf(t, owed)}, e.g. ${ideasText(t)}` : owedOf(t, owed))

// "20/100 by now", in the pace's own unit.
const byNow = (t: Today, p: Pace) => `${p.required}/${scaleOf(t).goal}${p.unit ?? ''} by now`

// A multi day names the exercise, since a bare /fit logs to the last one, not the one suggested.
const logHow = (t: Today, owed: number) => {
  const [lead] = t.isMulti ? setIdeas(t.exercises, t.last) : []
  return lead === undefined ? `/fit ${owed} to log it` : `/fit ${lead.amount} ${lead.exercise} to log it`
}

// A single day keeps its unit, since the reply names reps or seconds left.
const leftOfDay = (t: Today) => {
  const { goal, count } = scaleOf(t)
  return t.isMulti ? owedOf(t, goal - count) : `${goal - count}${paceable(t)?.unit ?? ''} ${paceable(t)?.exercise ?? 'reps'}`
}

// A multi day's rows can't follow a sentence on its line, so they start below it.
const thenToday = (t: Today, paceLine = '') => `${t.isMulti ? '\n' : ' '}${todayText(t, paceLine)}`

// A set's size for an exercise: a multi day sizes each from its own goal, since
// one setting can't fit reps and seconds alike.
const setSizeOf = (t: Today, e: TodayExercise) => setSizeFor(e.goal, t.isMulti ? 0 : paceConfig.setSize)

const NOT_ON_MULTI = (command: string) => `${command} does not work on a multi day yet.`

// Writes one exercise's new count, `last`, and what follows: breathers, toasts.
// `exercise` names the one logged; absent, a bare /fit's target (focusOf).
const logReps = async ($: Engine, change: (count: number) => number, exercise?: string) => {
  const owed = await refreshPace($)
  const before = await refreshToday($)
  const at = exercise === undefined ? logTarget(before.exercises, before.last) : before.exercises.findIndex(e => e.exercise === exercise)
  const was = before.exercises[at]
  // A press from a band drawn before the plan changed: log nothing rather than the wrong exercise.
  if (was === undefined) {
    toast($, `${exercise ?? 'That exercise'} isn't on today's plan any more.`)
    return before
  }
  const logPath = `${(await files($)).log}/${before.date}`
  // Another session's write still landing: writing over it would lose its counts.
  const text = await readLog($, logPath)
  if (isDamagedLog(text)) {
    toast($, "Couldn't read today's log, so nothing was logged. If it stays this way, /fit reset starts today over at 0.")
    return before
  }
  const count = Math.max(0, change(was.count))
  const exercises = before.exercises.map((e, i) => (i === at ? { ...e, count } : e))
  await $.fs.write(logPath, formatDayLog(exercises, before.isMulti, text))
  // In the shared pace file, so a bare /fit in any session follows the last log.
  await writeDayState($, before.date, state => ({ ...state, last: was.exercise }))

  const after: Today = { ...before, exercises, last: was.exercise }
  await update($, today, () => after)
  await update($, history, days =>
    days.map(day => (day.date === after.date && (!after.isMulti || day.exercise === was.exercise) ? { ...day, count } : day)),
  )
  if (await isScoreboardOpen($)) await refreshLedger($)

  // A set that still leaves reps owed earns a breather before the rest: a short
  // one counts, and fewer reps than the band's smallest button earn a shorter
  // one. Clearing the debt or lowering the count ends one, so later sets aren't hidden.
  const added = count - was.count
  // The debt is on the schedule's scale. A multi day's set is measured against its own row's
  // buttons, since its suggestion is a set of one exercise; reps past that goal add nothing.
  const gained = scaleOf(after).count - scaleOf(before).count
  const capped = (n: number) => (after.isMulti && was.goal > 0 ? Math.min(n, was.goal) : n)
  const setReps = capped(count) - capped(was.count)
  const stillOwed = owed === null ? 0 : owed.behind - gained
  const s = await schedule($, after.date)
  if (owed !== null && s !== undefined && stillOwed > 0 && setReps > 0) {
    const smallest = repSteps(after.isMulti ? setSizeOf(after, was) : owed.setSize)[0] ?? owed.setSize
    const until = (await $.clock.now()) + earnedBreatherMs(setReps, scaleOf(after).goal - s.base, owed.setSize, s.ms, smallest)
    const isFullSet = setReps >= smallest
    // Reps never cut short a longer breather or put-off already running. A
    // full set means it's no longer the set that was put off; a few reps under
    // a put-off that ends later leave its hold and its mark alone.
    await writeDayState($, after.date, state => {
      const isLater = state.breather !== undefined && state.breather > until
      if (isLater && !isFullSet) return state
      const { putOff: _, ...rest } = state
      return { ...rest, breather: isLater ? state.breather : until }
    })
  } else if (stillOwed <= 0 || setReps < 0) {
    await endBreather($, after.date)
  }
  await refreshPace($)
  const { goal, unit } = was
  if (goal > 0 && was.count < goal && count >= goal) {
    const left = exercises.filter(e => e.goal > 0 && e.count < e.goal)
    if (after.isMulti && left.length > 0) {
      toast($, `✅ ${was.exercise} done: ${count}/${goal}${unit}. Still to go: ${left.map(e => `${e.goal - e.count}${e.unit} ${e.exercise}`).join(', ')}.`)
    } else if (after.isMulti) {
      toast($, `✅ ${after.name === undefined ? 'All done today' : `${after.name} done`}: ${exercises.map(countText).join(', ')}. That's the work.`)
    } else {
      // The routine's goal hit, by the rule `nextGoal` moves it on: say where the
      // next session of it goes. A swap counts; a goal of its own does not; a multi day moves nothing yet.
      const routine = singleDays(await loadRoutine($, (await files($)).routine))
      const isPlanned = progressConfig.isOn && !after.isMulti && canProgress(routine, was.exercise) &&
        allPlans(routine).some(plan => plan.exercise === was.exercise && plan.goal === goal)
      const next = isPlanned ? ` Next ${was.exercise} day: ${goal + stepFor(goal)}${unit}.` : ''
      toast($, `✅ Done. ${count}/${goal}${unit} ${was.exercise}. That's the work.${next}`)
    }
  } else if (added > 0) {
    toast($, cheer(added, count, goal, was.exercise, unit))
  } else if (added < 0 && after.isMulti) {
    // A multi day names which count went down, since the band shows several.
    toast($, `${was.exercise} back to ${count}${unit}.${goal > count ? ` ${goal - count}${unit} to go.` : ''}`)
  }
  return after
}

// `/fit reset`: every exercise today back to 0, with no breather and no `last`. A log
// still damaged after readLog's second read is written over on purpose: the way out.
const resetDay = async ($: Engine) => {
  const t = await refreshToday($)
  const logPath = `${(await files($)).log}/${t.date}`
  await readLog($, logPath)
  await $.fs.write(logPath, formatDayLog(t.exercises.map(e => ({ ...e, count: 0 })), t.isMulti))
  await writeDayState($, t.date, ({ breather: _b, putOff: _p, last: _l, ...rest }) => rest)
  await refreshHistory($)
  await refreshPace($)
  return refreshToday($)
}

// Everything on disk another session can change, as one string: the routine's
// modification time, then each log file's name, size and time. A directory's
// own time only moves when a file is added, not when today's count is rewritten.
const diskFingerprint = async ($: Engine) => {
  const { routine, log: logDir } = await files($)
  const routineAt = (await $.fs.exists(routine)) ? (await $.fs.stat(routine)).mtimeMs : 0
  const entries = (await $.fs.exists(logDir)) ? await $.fs.list(logDir) : []
  return [routineAt, ...entries.map(entry => `${entry.name}:${entry.size}:${entry.mtimeMs}`)].join('|')
}

// Re-reads today, the history and the pace when the files changed since this
// session last looked (or always, when forced). Two sessions share one log:
// a set logged in one shows in the other's band within a poll.
const syncFromDisk = async ($: Engine, isForced = false) => {
  let now: string
  try {
    now = await diskFingerprint($)
  } catch {
    // A missing or unreadable directory: nothing to catch up on this time.
    return false
  }
  if (!isForced && now === seenOnDisk) return false
  seenOnDisk = now
  await refreshHistory($)
  await refreshPace($)
  return true
}

// The set the last nudge suggested, for the spinner. Replaced whole, never changed field by field.
let nudged = { reps: 0, exercise: '' }

// Easy mode: once a turn runs long, a suggestion sized to the set due; none on pace or in a
// breather. A multi day suggests its focus exercise, or the first one still short.
const nudge = async ($: Engine) => {
  const p = await refreshPace($)
  const t = await read($, today)
  if (t === null || t.isRest) return
  const e = [focusOf(t), ...t.exercises].find(entry => !isFinished(entry))
  if (e === undefined) return
  if (p !== null && (p.behind <= 0 || p.restUntil !== null)) return
  // A multi day's pace is in percent, so its nudge is the exercise's own set.
  nudged = { reps: p === null || t.isMulti ? setSizeOf(t, e) : Math.min(p.behind, p.setSize), exercise: e.exercise }
  if (nudged.reps <= 0) return
  await update($, isWaiting, () => true)
  toast($, `Your agent's mid-set. You next: ${nudged.reps} ${e.exercise}.`)
}

const endRest = async ($: Engine) => {
  const t = await refreshToday($)
  if (!t.isRest) return { text: `Today isn't a rest day. ${todayText(t)}` }
  await $.fs.write(`${(await files($)).log}/${t.date}.skip`, 'off\n')
  const back = await refreshToday($)
  await refreshHistory($)
  await refreshPace($)
  return { text: `Rest day undone. Back to work. ${todayText(back)}` }
}

// The chart's range, kept for the next time the scoreboard opens.
const pickRange = async ($: Engine, days: number) => {
  await update($, chartDays, () => days)
  await $.store.set('chartDays', days)
}

const markIntroduced = async ($: Engine) => {
  await $.store.set('introduced', true)
  await update($, isIntroduced, () => true)
}

const KEEP = 'Keep my current routine'
const CUSTOM = 'Custom goals'
const DEFAULT_PROGRAM = 'Push · dip · squat rotation'

const openOnboarding = async ($: Engine) => {
  // Open first: a pane counts as asked for only while the press or command that
  // asked is still being answered. Opened after other awaits, the engine treats
  // it as unasked and leaves it undrawn below 144 columns.
  await update($, onboardStep, () => 0)
  const opened = await $.ui.open({ id: ONBOARD_PANE, title: 'TERMINAL GYM', focus: true, closeOnEscape: true })
  if (!opened.isPlaced) toast($, 'Widen the terminal to see the walkthrough, or type /fit program.')
  // A seeded default counts as no routine of their own; only custom ones get "keep".
  const { routine: routinePath } = await files($)
  const base = await loadRoutine($, routinePath)
  const hasRoutine = JSON.stringify(base) !== JSON.stringify(DEFAULT_ROUTINE)
  // Custom starts from the current routine's days and goals.
  const custom = Object.fromEntries(Object.entries(exerciseGoals(base)).map(([name, goal]) => [name, String(goal)]))
  await update($, onboardPick, () => ({
    program: hasRoutine ? KEEP : DEFAULT_PROGRAM,
    size: 'Standard',
    hasRoutine,
    base,
    custom,
    isCustomInvalid: false,
  }))
}

const pickedRoutine = (p: OnboardPick): Routine | undefined => {
  if (p.program === CUSTOM) return customRoutine(p.base, p.custom)
  const preset = ROUTINES[p.program as keyof typeof ROUTINES] as Routine | undefined
  return preset === undefined ? undefined : scale(preset, SIZES[p.size as keyof typeof SIZES] ?? 1)
}

// A new program changes today on; the days before keep the plan they were
// trained against, written down as their own plan the way `/fit swap` does.
const freezePastDays = async ($: Engine, old: Routine) => {
  const { log: logDir } = await files($)
  const recent = lastDays(await $.clock.now(), HISTORY_DAYS).slice(0, -1)
  const today = dayKey(await $.clock.now())
  // Every logged day too: all-time totals credit each one to its exercise.
  const logged = (await loggedDates($, logDir)).filter(date => date < today)
  for (const ms of new Set([...logged.map(noonOf), ...recent])) {
    const date = dayKey(ms)
    const path = `${logDir}/${date}.swap`
    // A logged day the old routine left out stays as it reads now, not the new plan's.
    const day = old[weekdayKey(ms)] ?? (logged.includes(date) ? single(NO_PLAN) : undefined)
    if (day !== undefined && !(await $.fs.exists(path))) await writeSwap($, date, day)
  }
}

const finishOnboarding = async ($: Engine) => {
  const p = await read($, onboardPick)
  const { routine: routinePath } = await files($)
  const routine = pickedRoutine(p)
  // A custom goal that isn't a number sends the person back to fix it.
  if (p.program === CUSTOM && routine === undefined) {
    await update($, onboardPick, now => ({ ...now, isCustomInvalid: true }))
    await update($, onboardStep, () => 1)
    return
  }
  if (routine !== undefined) {
    const old = await loadRoutine($, routinePath)
    if (JSON.stringify(old) !== JSON.stringify(routine)) await freezePastDays($, old)
    if (p.hasRoutine) await $.fs.write(`${routinePath}.bak`, await $.fs.read(routinePath))
    // Custom goals change goals alone, so the file keeps what the reader left out; a preset replaces it.
    if (p.program === CUSTOM) await writeGoals($, routinePath, routine)
    else await writeRoutine($, routinePath, routine)
  }
  await markIntroduced($)
  await refreshToday($)
  await refreshHistory($)
  await refreshPace($)
  await $.ui.close({ id: ONBOARD_PANE })
  const plan = routine ?? (await loadRoutine($, routinePath))
  toast($, `Program set: ${describeRoutine(plan)}. Get to work.`)
}

// A made-up fortnight for the walkthrough's example grid.
const SAMPLE_DAYS: Day[] = [1, 1, 0.4, 1, 1, 0, 1, 1, 1, 0.6, 1, 1, 1, 0.3].map((share, i) => ({
  date: `sample-${i}`,
  count: Math.round(share * 100),
  goal: 100,
  exercise: 'pushups',
  isSkipped: false,
}))

// The conversation's id, or '' where the engine can't say.
const conversationId = async ($: Engine) => {
  try {
    return await $.session.id()
  } catch {
    return ''
  }
}

// Everything a conversation needs: the /fit command and today's state.
const boot = async ($: Engine) => {
  bootedFor = await conversationId($)
  // Each conversation hears once about entries its routine leaves out.
  warnedDropped = ''
  const introduced = (await $.store.get('introduced')) === true
  await update($, isIntroduced, () => introduced)
  const range = await $.store.get('chartDays')
  if (typeof range === 'number') await update($, chartDays, () => range)
  // A new conversation looks again: the routine may have moved since.
  progressedOn = ''
  await refreshToday($)
  await refreshHistory($)
  // Re-arms the due timer, which a restart or reload drops.
  await refreshPace($)
  // Remember the log as read, then watch it for what other sessions log.
  try {
    seenOnDisk = await diskFingerprint($)
  } catch {
    seenOnDisk = ''
  }
  syncTimer?.cancel()
  syncTimer = $.clock.every(SYNC_MS, () => void syncFromDisk($))
  // Last, so a refused registration can't leave the band without its state.
  await $.command.register({
    name: 'fit',
    description: "Log reps toward today's goal",
    argumentHint: '[n [exercise] | set n [exercise] | snooze [min] | goal n | window hours | swap | streak | strict | easy | help]',
    immediate: true,
  })
}

// The setup again when the conversation changed since it last ran. A managed
// plugin (cc-plugin-sec-default) can pass classic.SessionStart on past this
// mod, so prompts and turns check too.
const bootIfSwitched = async ($: Engine) => {
  const id = await conversationId($)
  if (id === '' || id === bootedFor) return
  // Claimed before the await, so a prompt and its turn don't both run it.
  bootedFor = id
  await boot($)
}

export const register: Register = (on, options) => {
  const isStrict = options.strict === true
  const nudgeMs = Number(options.nudgeSeconds ?? 30) * 1000
  // Whole reps only: a fractional set would make fractional buttons.
  paceConfig.setSize = Math.max(0, Math.round(Number(options.setSize ?? 0)) || 0)
  paceConfig.windowMs = Math.max(1, Number(options.windowHours ?? 8)) * HOUR_MS
  progressConfig.isOn = options.progress === true
  let timer: { cancel: () => void } | undefined

  on('session.start', async ($, e, next) => {
    await boot($)
    return next(e)
  })

  // /clear and an in-session /resume switch to another conversation in the
  // same process without another session.start, so the setup runs again here.
  on('classic.SessionStart', async ($, e, next) => {
    if (e.source === 'clear' || e.source === 'resume') await boot($)
    return next(e)
  })

  on('command.run', { command: 'fit' }, async ($, e) => {
    const cmd = parseFit(e.args)
    switch (cmd.kind) {
      case 'error':
        return { text: cmd.text }
      case 'add':
      case 'set': {
        const before = await refreshToday($)
        if (before.isRest) return { text: "Today's a rest day. /fit rest off to train." }
        let exercise: string | undefined
        if (cmd.typedName !== undefined) {
          const names = before.exercises.map(e => e.exercise)
          const match = matchExercise(cmd.typedName, names)
          if (match.kind === 'many') return { text: `"${cmd.typedName}" could be ${match.names.join(' or ')}, so nothing logged. Type more of the name.` }
          if (match.kind === 'none') return { text: `No ${cmd.typedName} today, so nothing logged. Today: ${names.join(', ')}.` }
          exercise = names[match.index]
        }
        const n = cmd.n
        const t = await logReps($, count => (cmd.kind === 'add' ? count + n : n), exercise)
        const logged = exercise === undefined ? focusOf(t) : t.exercises.find(e => e.exercise === exercise)
        // The plan changed under the command: logReps logged nothing and toasted why.
        if (logged === undefined) return { text: `${exercise} isn't on today's plan any more, so nothing logged.` }
        return { text: `${line(logged)}${t.isMulti ? leftText(logged) : ''}${paceText(await read($, pace), isStrict, await $.clock.now())}` }
      }
      case 'skip': {
        const t = await refreshToday($)
        if (t.isRest) return { text: 'Already a rest day. /fit rest off to train.' }
        // Reps logged means a training day: a rest day would wipe the streak.
        const logged = t.exercises.filter(e => e.count > 0)
        if (logged.length > 0) {
          return { text: `You've logged ${logged.map(e => `${e.count}${e.unit} ${e.exercise}`).join(', ')} today, so it's a training day. /fit rest is for a day off; it resets your streak.` }
        }
        await $.fs.write(`${(await files($)).log}/${t.date}.skip`, '')
        await refreshToday($)
        await refreshHistory($)
        await refreshPace($)
        return { text: `Rest day logged. Streak resets, no sets due today. Back at it tomorrow. (/fit rest off to undo)` }
      }
      case 'unskip':
        return endRest($)
      case 'week': {
        const isOpen = await isScoreboardOpen($)
        if (isOpen && cmd.days === undefined) {
          await $.ui.close({ id: PANE })
          return { text: 'Scoreboard closed.' }
        }
        if (cmd.days !== undefined) await pickRange($, cmd.days)
        // Open first: see openOnboarding. The numbers arrive once the log is read.
        if (!isOpen) await $.ui.open({ id: PANE, title: 'TERMINAL GYM', focus: true, closeOnEscape: true })
        const days = await refreshHistory($)
        const range = cmd.days === undefined ? '' : ` · last ${cmd.days} days`
        return { text: `🔥 ${fullStreak(days, await read($, olderStreak))}-day streak${range} · Esc or /fit streak to close` }
      }
      case 'swap': {
        const before = await refreshToday($)
        const was = paceable(before)
        if (was === undefined) return { text: NOT_ON_MULTI('/fit swap') }
        const { routine: routinePath } = await files($)
        const routine = await loadRoutine($, routinePath)
        const names = [...new Set(allPlans(routine).map(p => p.exercise))]
        if (names.length === 0) return { text: 'Your program has no exercises. /fit program to pick one.' }
        const plan = pickSwap(routine, was.exercise, cmd.exercise)
        if (plan === undefined) {
          const isMultiName = Object.values(routine).some(day => isMultiDay(day) && day.name?.toLowerCase() === cmd.exercise)
          if (isMultiName) return { text: NOT_ON_MULTI(`/fit swap ${cmd.exercise ?? ''}`.trim()) }
          return { text: `No ${cmd.exercise} in your program. Pick one of: ${names.join(', ')}.` }
        }
        if (plan.exercise === was.exercise) return { text: `Already on ${plan.exercise} today.` }
        await writeSwap($, before.date, single(plan))
        await refreshHistory($)
        const amount = was.unit === '' ? `${was.count} reps` : `${was.count}${was.unit}`
        const carried = was.count > 0 ? ` Your ${amount} carry over.` : ''
        const swapped = await refreshToday($)
        await refreshPace($)
        return { text: `Swapped to ${plan.exercise} today.${carried} ${todayText(swapped)}` }
      }
      case 'goal': {
        // Today's plan with a new goal, in the same file `/fit swap` writes.
        const before = await refreshToday($)
        if (before.isRest) return { text: "Today's a rest day. /fit rest off to train." }
        const was = paceable(before)
        if (was === undefined) return { text: NOT_ON_MULTI('/fit goal') }
        await writeSwap($, before.date, single({ exercise: was.exercise, goal: cmd.n, ...(was.unit === '' ? {} : { unit: was.unit }) }))
        await refreshHistory($)
        const after = await refreshToday($)
        return { text: `Today's goal is ${cmd.n}${was.unit} ${was.exercise}. ${todayText(after)}${paceText(await reschedule($, before.date), isStrict, await $.clock.now())}` }
      }
      case 'window': {
        const t = await refreshToday($)
        const paced = scaleOf(t)
        if (cmd.hours === null) {
          await writeDayState($, t.date, ({ window: _, ...rest }) => rest)
          return {
            text: `Back to ${paceConfig.windowMs / HOUR_MS}h from your first prompt.${thenToday(t, paceText(await reschedule($, t.date), isStrict, await $.clock.now()))}`,
          }
        }
        if (t.isRest) return { text: "Today's a rest day. /fit rest off to train." }
        if (paced.goal <= 0) return { text: 'No goal today. /fit goal 60 to set one.' }
        if (paced.count >= paced.goal) return { text: `Today's goal is done.${thenToday(t)}` }
        const now = await $.clock.now()
        // Today ends at midnight: a window can't run into tomorrow's log. It ends a
        // minute early so its last set comes due today, not on the stroke of midnight.
        const d = new Date(now)
        const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
        const ms = Math.max(1, Math.min(cmd.hours * HOUR_MS, midnight - now - 60_000))
        await writeDayState($, t.date, s => ({ ...s, window: { from: now, ms, base: paced.count } }))
        const span = ms < cmd.hours * HOUR_MS ? 'between now and midnight' : `over the next ${cmd.hours}h (done by ${clockTime(now + ms)})`
        return {
          text: `${leftOfDay(t)} left, spread ${span}.${thenToday(t, paceText(await reschedule($, t.date), isStrict, await $.clock.now()))}`,
        }
      }
      case 'window-until': {
        const t = await refreshToday($)
        const paced = scaleOf(t)
        if (t.isRest) return { text: "Today's a rest day. /fit rest off to train." }
        if (paced.goal <= 0) return { text: 'No goal today. /fit goal 60 to set one.' }
        if (paced.count >= paced.goal) return { text: `Today's goal is done.${thenToday(t)}` }
        const now = await $.clock.now()
        const d = new Date(now)
        const end = new Date(d.getFullYear(), d.getMonth(), d.getDate(), cmd.hour, cmd.minute).getTime()
        const named = `${String(cmd.hour).padStart(2, '0')}:${String(cmd.minute).padStart(2, '0')}`
        if (end <= now) return { text: `${named} has already passed today. 3–4 digits are a clock time (1240 = 12:40); for hours from now, use 1–2 digits like /fit window 2.` }
        // The same window `/fit window <hours>` sets, ending at the time named.
        await writeDayState($, t.date, s => ({ ...s, window: { from: now, ms: end - now, base: paced.count } }))
        return {
          text: `${leftOfDay(t)} left, spread between now and ${named}.${thenToday(t, paceText(await reschedule($, t.date), isStrict, await $.clock.now()))}`,
        }
      }
      case 'snooze': {
        // A breather with no reps logged: the set stays owed, prompts go through
        // until the time is up. Once per due set and twice a day, so strict stays strict.
        const p = await refreshPace($)
        const t = await read($, today)
        if (t === null || t.isRest) return { text: "Today's a rest day. Nothing to put off." }
        const paced = scaleOf(t)
        if (paced.goal > 0 && paced.count >= paced.goal) return { text: `Today's goal is done.${thenToday(t)}` }
        if (p === null) return { text: 'Nothing is due yet. The day starts with your first prompt.' }
        if (p.behind <= 0) {
          return { text: p.nextDueAt === null ? 'Nothing is due.' : `Nothing is due until ${clockTime(p.nextDueAt)}. Put it off then.` }
        }
        if (p.restUntil !== null) {
          return { text: `Already ${p.isPutOff === true ? 'put off' : 'resting'} until ${clockTime(p.restUntil)}. Log a set, even a short one, when it ends.` }
        }
        const day = await readDayState($, t.date)
        if (day.putOff === p.required) {
          const short = t.isMulti ? `e.g. ${ideasText(t)}` : `/fit ${repSteps(p.setSize)[0] ?? p.setSize} earns a breather`
          return { text: `This set was already put off once. Log it, even a short one (${short}).` }
        }
        if ((day.laters ?? 0) >= SNOOZE.perDay) {
          return { text: `That's ${SNOOZE.perDay} put off today already. Log a set, even a short one, or /fit easy stops holding prompts.` }
        }
        const until = (await $.clock.now()) + cmd.minutes * 60_000
        await writeDayState($, t.date, s => ({ ...s, breather: until, laters: (s.laters ?? 0) + 1, putOff: p.required }))
        return {
          text: `${owedOf(t, p.behind)} put off until ${clockTime(until)}.${thenToday(t, paceText(await refreshPace($), isStrict, await $.clock.now()))}`,
        }
      }
      case 'program':
        await openOnboarding($)
        return { text: 'Pick your program.' }
      case 'intro':
        await $.store.delete('introduced')
        await update($, isIntroduced, () => false)
        return { text: 'Welcome is back above your prompt.' }
      case 'reset':
        return { text: `Reset. ${todayText(await resetDay($), paceText(await read($, pace), isStrict, await $.clock.now()))}` }
      case 'help':
        await markIntroduced($)
        await $.ui.open({ id: HELP_PANE, title: 'HELP' })
        return { text: 'Help opened · /fit hide to close' }
      case 'strict': {
        const { deny } = await $.config.set({ key: 'terminal-gym.strict', value: cmd.isOn })
        if (deny !== undefined) return { text: `Couldn't change strict mode: ${deny}` }
        return {
          text: cmd.isOn
            ? `Coach is strict. Today's goal is spread into sets over ${paceConfig.windowMs / HOUR_MS}h from your first prompt; fall behind and prompts wait until you catch up.`
            : 'Coach is easy. Same schedule on the band, nudges only, nothing held.',
        }
      }
      case 'progress': {
        const { deny } = await $.config.set({ key: 'terminal-gym.progress', value: cmd.isOn })
        if (deny !== undefined) return { text: `Couldn't change progressive goals: ${deny}` }
        return {
          text: cmd.isOn
            ? 'Progressive goals on. Hit a goal, and the next session of that exercise is about 5% more. Two short sessions in a row step it back.'
            : 'Progressive goals off. Goals stay where they are now.',
        }
      }
      case 'hide':
        await $.ui.close({ id: PANE })
        await $.ui.close({ id: HELP_PANE })
        return { text: 'Terminal Gym panels closed.' }
      case 'status': {
        const t = await refreshToday($)
        const run = streakOf(await refreshHistory($), await read($, olderStreak))
        return { text: todayText(t, paceText(await refreshPace($), isStrict, await $.clock.now()), run) }
      }
      case 'reload': {
        // Every session reads the same files, so a reload is a fresh read of them.
        if (!(await syncFromDisk($, true))) return { text: "Couldn't read ~/.claude/fitness just now. Nothing changed; try again." }
        const t = await read($, today)
        if (t === null) return { text: 'Reloaded from disk.' }
        const run = streakOf(await read($, history), await read($, olderStreak))
        return { text: `Reloaded from disk. ${todayText(t, paceText(await read($, pace), isStrict, await $.clock.now()), run)}` }
      }
    }
  })

  on('prompt.submit', async ($, e, next) => {
    await bootIfSwitched($)
    // Only prompts the person typed count: background tasks, loops and other
    // sessions start turns too. Slash commands (like /fit 10) always pass.
    const isTyped = e.origin.kind === 'composer' && !e.text.trimStart().startsWith('/')
    if (!isTyped) return next(e)
    await startDay($)
    const p = await refreshPace($)
    const t = await read($, today)
    // Claude Code puts a dropped prompt back in the box itself; a fill here
    // as well left it there twice.
    if (isStrict && t !== null && p !== null && p.behind > 0 && p.restUntil === null) {
      if (p.isOpening === true) {
        return {
          drop: `Start the day with a set: ${setText(t, p.behind)}. ${logHow(t, p.behind)}, then send your prompt. /fit rest skips the day (breaks streak).`,
        }
      }
      const due = t.isMulti
        ? `Set due: ${setText(t, p.behind)} (${byNow(t, p)})`
        : `${setText(t, p.behind)} due now (${byNow(t, p)})`
      return {
        drop: `${due}. ${logHow(t, p.behind)}, then send your prompt. /fit snooze 30 puts it off; /fit easy stops holding prompts.`,
      }
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await bootIfSwitched($)
    timer?.cancel()
    if (!isStrict && options.nudges !== false) timer = $.clock.after(nudgeMs, () => void nudge($))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      timer?.cancel()
      timer = undefined
      await update($, isWaiting, () => false)
      await refreshToday($)
      await refreshPace($)
    }
    return next(e)
  })

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const t = await read($, today)
    if (options.spinner === false || t === null || !(await read($, isWaiting))) return next(e)
    const { reps, exercise } = nudged
    return next({ ...e, props: { ...e.props, message: `${reps} ${exercise} while Claude works` } })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const t = await read($, today)
    if (options.band === false || e.props.hasSurvey || t === null) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)

    // Lay the band out in rows that fit, widest first: one line, then the
    // header over the buttons, then every piece on its own line.
    const cols = e.props.bodyColumns
    const WORDMARK = MINI_BARBELL.small + MINI_BARBELL.plate + MINI_BARBELL.name + MINI_BARBELL.plateRight + MINI_BARBELL.small
    const TAGLINE = 'Your agent put in the reps. You next.'
    const BUTTONS_WIDTH = buttonsWidth(['Pick your training', 'Help', 'Just train'])
    const HEADER_WIDTH = cells(WORDMARK) + 2 + cells(TAGLINE)

    if (!(await read($, isIntroduced))) {
      const buttons = (
        <Box key="buttons" flexDirection={cols >= BUTTONS_WIDTH ? 'row' : 'column'}>
          <Button key="setup" label="Pick your training" variant="primary" onPress={() => openOnboarding($)} />
          {cols >= BUTTONS_WIDTH && <Text> </Text>}
          <Button key="help" label="Help" onPress={() => $.ui.open({ id: HELP_PANE, title: 'HELP' })} />
          {cols >= BUTTONS_WIDTH && <Text> </Text>}
          <Button key="dismiss" label="Just train" onPress={() => markIntroduced($)} />
        </Box>
      )
      const header = (
        <Box key="header" flexDirection={cols >= HEADER_WIDTH ? 'row' : 'column'}>
          {cols >= cells(WORDMARK) ? (
            <Box>
              <Text dimColor>{MINI_BARBELL.small}</Text>
              <Text color="#d7af5f">{MINI_BARBELL.plate}</Text>
              <Text bold>{MINI_BARBELL.name}</Text>
              <Text color="#d7af5f">{MINI_BARBELL.plateRight}</Text>
              <Text dimColor>{MINI_BARBELL.small}</Text>
              {cols >= HEADER_WIDTH && <Text>  </Text>}
            </Box>
          ) : (
            <Text bold wrap="truncate-end">
              {MINI_BARBELL.name}
            </Text>
          )}
          <Text dimColor wrap="truncate-end">{TAGLINE}</Text>
        </Box>
      )
      const isOneLine = cols >= HEADER_WIDTH + 1 + BUTTONS_WIDTH
      return (
        <Box key="band" flexDirection={isOneLine ? 'row' : 'column'}>
          {header}
          {isOneLine && <Text> </Text>}
          {buttons}
        </Box>
      )
    }

    // A rest day is deliberate, not a miss: no rep buttons, just a way back.
    if (t.isRest) {
      const REST = `😴 Rest day · ${t.isMulti ? dayName(t) : focusOf(t).exercise} back tomorrow`
      const TRAIN = 'Train today'
      return (
        <Box key="rest" flexDirection={cols >= cells(REST) + 2 + buttonsWidth([TRAIN]) ? 'row' : 'column'}>
          <Text dimColor wrap="truncate-end">
            {REST}
            {'  '}
          </Text>
          <Button key="train" label={TRAIN} onPress={() => endRest($)} />
        </Box>
      )
    }

    const days = await read($, history)
    const streakText = streakOf(days, await read($, olderStreak))
    const paced = paceable(t)

    // A multi day: a status row, then a row per exercise with its own bar and
    // buttons sized from its own goal.
    if (paced === undefined) {
      const rows = t.exercises.map(entry => {
        const steps = isFinished(entry) ? [] : repSteps(setSizeOf(t, entry))
        const color = progressColor(entry.count, entry.goal)
        const text = `${line(entry)}${steps.length > 0 ? '  ' : ''}`
        // The line gives up columns before the buttons do, as the single day's row does.
        const room = Math.max(1, cols - buttonsWidth(steps.map(n => `+${n}${entry.unit}`)))
        return (
          <Box key={`row-${entry.exercise}`}>
            <Box {...(cells(text) > room ? { width: room } : {})}>
              <Text color={color} dimColor={color === undefined} wrap="truncate-end">
                {text}
              </Text>
            </Box>
            {steps.map((n, i) => (
              <Box key={`${entry.exercise}-step${i}`}>
                {i > 0 && <Text> </Text>}
                <Button key={`${entry.exercise}+${n}`} label={`+${n}${entry.unit}`} onPress={() => logReps($, count => count + n, entry.exercise)} />
              </Box>
            ))}
          </Box>
        )
      })
      return (
        <Box key="multi" flexDirection="column">
          <Text bold wrap="truncate-end">
            {`🏋 ${dayName(t)}${paceText(await read($, pace), isStrict, await $.clock.now())}${streakText}`}
          </Text>
          {rows}
        </Box>
      )
    }

    const color = progressColor(paced.count, paced.goal)
    const add = (n: number) => () => void logReps($, count => count + n)
    const progress = `${line(paced)}${paceText(await read($, pace), isStrict, await $.clock.now())}`
    const LOG_LABEL = 'log reps: '
    // Buttons sized to today's set: a 300 goal's 30-rep sets get +10 +20 +30.
    const steps = repSteps(setSizeFor(paced.goal, paceConfig.setSize))
    const logWidth = cells(LOG_LABEL) + buttonsWidth(steps.map(n => `+${n}`)) + cells(streakText)

    return (
      <Box key="tracker" flexDirection={cols >= cells(progress) + 2 + logWidth ? 'row' : 'column'}>
        <Text color={color} dimColor={color === undefined} wrap="truncate-end">
          {progress}
          {'  '}
        </Text>
        <Box>
          <Text dimColor>{LOG_LABEL}</Text>
          {steps.map((n, i) => (
            <Box key={`step${i}`}>
              {i > 0 && <Text> </Text>}
              <Button key={`add${n}`} label={`+${n}`} onPress={add(n)} />
            </Box>
          ))}
          {streakText !== '' && <Text>{streakText}</Text>}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) =>
    drawScoreboard(e, $.ui.resolve(e), {
      days: await read($, history),
      older: await read($, olderStreak),
      ledger: await read($, ledger),
      range: await read($, chartDays),
      now: await $.clock.now(),
      onRange: days => pickRange($, days),
      onClose: () => closePane($, PANE),
    }),
  )

  on('ui.render', { component: 'Pane', requestId: HELP_PANE }, async ($, e) => {
    const { Box, Button, Markdown, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Markdown text={HELP} />
        <Text> </Text>
        <Box>
          <Button key="setup" label="Pick your training" variant="primary" onPress={() => openOnboarding($)} />
          <Text> </Text>
          <Button key="close" label="Close" onPress={() => closePane($, HELP_PANE)} />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: ONBOARD_PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const step = await read($, onboardStep)
    const p = await read($, onboardPick)
    const go = (to: number) => async () => {
      // Custom goals must all be numbers before leaving the program step.
      if (step === 1 && to > step && p.program === CUSTOM && pickedRoutine(p) === undefined) {
        await update($, onboardPick, now => ({ ...now, isCustomInvalid: true }))
        return
      }
      await update($, onboardStep, () => to)
    }
    const choose = (patch: Partial<OnboardPick>) => () => void update($, onboardPick, now => ({ ...now, ...patch }))
    const dots = [0, 1, 2].map(i => (i === step ? '●' : '○')).join(' ')

    const header = (title: string) => (
      <Box flexDirection="column">
        <Text dimColor>
          Step {step + 1} of 3 {dots}
        </Text>
        <Text bold>{title}</Text>
        <Text> </Text>
      </Box>
    )

    const nav = (
      <Box>
        {step > 0 && <Button key="back" label="Back" onPress={go(step - 1)} />}
        {step > 0 && <Text> </Text>}
        {step < 2 ? (
          <Button key="next" label="Next" variant="primary" onPress={go(step + 1)} />
        ) : (
          <Button key="finish" label="Let's go" variant="primary" onPress={() => finishOnboarding($)} />
        )}
      </Box>
    )

    if (step === 0) {
      return (
        <Box flexDirection="column">
          {header('Your agent works the code. You work the reps.')}
          <Text>Every day has a rep goal.</Text>
          <Text>When Claude runs a long turn, that's your cue for a set.</Text>
          <Text> </Text>
          <Text>Log reps two ways:</Text>
          <Text dimColor>  type /fit 20</Text>
          <Text dimColor>  or press a + button above your prompt</Text>
          <Text> </Text>
          {nav}
        </Box>
      )
    }

    if (step === 1) {
      // The mobile app draws no Input, so Custom needs another surface there.
      const elements = $.ui.resolve(e)
      const Input = e.surface !== 'mobile' && 'Input' in elements ? elements.Input : undefined
      const programs = [...(p.hasRoutine ? [KEEP] : []), ...Object.keys(ROUTINES), ...(Input === undefined ? [] : [CUSTOM])]
      const routine = pickedRoutine(p)
      const isCustom = p.program === CUSTOM
      const setGoal = (exercise: string) => (value: string) =>
        void update($, onboardPick, now => ({ ...now, custom: { ...now.custom, [exercise]: value }, isCustomInvalid: false }))
      const fields = Input !== undefined && isCustom && (
        <Box flexDirection="column">
          <Text> </Text>
          <Text dimColor>Daily goal per exercise</Text>
          {Object.entries(exerciseGoals(p.base)).map(([exercise, goal]) => (
            <Input
              key={`goal-${exercise}`}
              label={`${exercise} `}
              placeholder={String(goal)}
              value={typedGoal(p.custom, exercise)}
              submitLabel="set"
              onInput={setGoal(exercise)}
              onSubmit={setGoal(exercise)}
            />
          ))}
          {p.isCustomInvalid && <Text color="#d75f5f">Every goal needs a whole number above 0.</Text>}
        </Box>
      )
      return (
        <Box flexDirection="column">
          {header('Pick your program')}
          {programs.map((name, i) => (
            <Button
              key={`program-${i}`}
              label={`${name === p.program ? '●' : '○'} ${name}`}
              plain
              onPress={choose({ program: name })}
            />
          ))}
          {fields}
          {routine !== undefined && !isCustom && (
            <Box flexDirection="column">
              <Text> </Text>
              <Text dimColor>Goal size</Text>
              <Box>
                {Object.keys(SIZES).map(size => (
                  <Box>
                    <Button
                      key={`size-${size}`}
                      label={`${size === p.size ? '●' : '○'} ${size}`}
                      plain
                      onPress={choose({ size })}
                    />
                    <Text>  </Text>
                  </Box>
                ))}
              </Box>
            </Box>
          )}
          <Text> </Text>
          <Text dimColor>
            {routine !== undefined
              ? describeRoutine(routine)
              : isCustom
                ? 'Your days stay as they are, at these goals.'
                : 'Your routine stays as it is.'}
          </Text>
          <Text> </Text>
          {nav}
        </Box>
      )
    }

    const routine = pickedRoutine(p)
    const exercise = routine?.mon?.plans[0]?.exercise ?? (await read($, today))?.exercises[0]?.exercise ?? 'pushups'
    const sample = withStreak(
      { date: '', exercises: [{ exercise, goal: 100, unit: '', count: 60 }], isMulti: false, isRest: false },
      // three finished days and reps today: 🔥4d
      [
        ...Array.from({ length: 3 }, (_, i) => ({ date: `d${i}`, count: 100, goal: 100, exercise, isSkipped: false })),
        { date: 'today', count: 60, goal: 100, exercise, isSkipped: false },
      ],
    )
    const preview =
      e.surface === 'terminal' ? (
        (() => {
          const { Raster } = $.ui.resolve(e)
          return <Raster key="sample-grid" {...heatCells(SAMPLE_DAYS)} />
        })()
      ) : (
        <Text dimColor>■ ■ ■ ■ ■ □ ■</Text>
      )

    return (
      <Box flexDirection="column">
        {header('Keep the streak alive')}
        <Text>Train any reps and the streak grows.</Text>
        <Text>It sits at the end of your tracker:</Text>
        <Text color="#d7af5f">  {sample}</Text>
        <Text dimColor>A day with none, or a rest day, resets it to zero.</Text>
        <Text> </Text>
        <Text>See every day as a grid:</Text>
        <Text dimColor>  type /fit streak</Text>
        {preview}
        <Text> </Text>
        {nav}
      </Box>
    )
  })
}
