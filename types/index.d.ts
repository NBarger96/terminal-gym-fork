// One exercise of a routine day: `{ exercise, goal, unit? }`, as routine.json holds it.
export type Plan = { exercise: string; goal: number; unit?: string }

// Every routine day as the mod holds it after reading. A single day (a plain
// plan in the file) is a list of one; a multi day came as `{ name?, exercises }`.
export type RoutineDay =
  | { isMulti?: false; name?: undefined; plans: Plan[] }
  | { isMulti: true; name?: string; plans: Plan[] }

// One of today's exercises and its count so far.
export type TodayExercise = {
  exercise: string
  goal: number
  unit: string
  count: number
}

export type Today = {
  date: string
  // One entry on a single day, one per exercise on a multi day.
  exercises: TodayExercise[]
  isRest: boolean
  // The exercise logged last today (`last` in the day's pace file), if any.
  last?: string
} & (
  | { isMulti: false; name?: undefined }
  // A multi day's name is optional in routine.json.
  | { isMulti: true; name?: string }
)

export type Day = {
  date: string
  count: number
  goal: number
  exercise: string
  isSkipped: boolean
  // "s" for timed exercises; absent for reps.
  unit?: string
}

export type OnboardPick = {
  program: string
  size: string
  hasRoutine: boolean
  // Custom: the routine whose days it keeps, and each exercise's goal as typed.
  base: Record<string, RoutineDay>
  custom: Record<string, string>
  // Custom days: each weekday's line as typed.
  days: Record<string, string>
  // A Next on Custom goals or Custom days found input that does not read.
  isCustomInvalid: boolean
}

// Where today stands against the schedule of sets.
export type Pace = {
  required: number
  behind: number
  setSize: number
  nextDueAt: number | null
  // While a breather runs, catch-up reps are owed but prompts are not held.
  restUntil: number | null
  // The day's first set, before any reps: an opener, not a debt.
  isOpening?: boolean
  // The breather is a `/fit snooze`: the set was put off, not partly done.
  isPutOff?: boolean
  // A multi day's pace is in percent of the day, so every text that prints its numbers adds this.
  unit?: '%'
}

declare module 'claude-code' {
  interface PluginState {
    'terminal-gym': {
      today: Today | null
      pace: Pace | null
      isWaiting: boolean
      isIntroduced: boolean
      onboardStep: number
      onboardPick: OnboardPick
      history: Day[]
      // Every day with reps, oldest first; null until the scoreboard first loads it.
      ledger: Day[] | null
      chartDays: number
      olderStreak: number
    }
  }
}
