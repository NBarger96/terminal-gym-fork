import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { amount, axisText, barCells, barSvg, bestStreak, bucketDays, bucketLabel, changeText, chartBars, chartWidth, commas, exerciseColors, exerciseTotals, faded, nextMilestone, rangeSummary, yearCells } from '../hooks/stats'
import { buttonsWidth, canProgress, cells, cheer, customDays, customRoutine, dayLine, dayShare, daysOverFile, describeRoutine, droppedText, exerciseGoals, formatDayLog, heatCells, HELP, logTarget, matchExercise, moveGoal, nextGoal, paceAt, paceScale, parseCustom, parseDayLine, parseDayLog, parseFit, parseRoutine, pickSwap, progressColor, progressesAt, repSteps, routineToFile, scale, setIdeas, setSizeFor, stepFor, streak, swappedLog, untilText } from '../hooks/lib'

// A routine as routine.json would hold it, read into the shape the helpers take.
const asRoutine = (raw: object) => parseRoutine(raw).routine

const HOME = '/home/t'
const LOG = `${HOME}/.claude/fitness/log`
const MONDAY_9AM = new Date(2026, 9, 5, 9).getTime()

// The world beneath Terminal Gym: files in memory, a held clock, and the engine
// calls it makes answered quietly, toasts recorded.
const world = (
  on: On,
  files = new Map<string, string>(),
  {
    introduced = true,
    store = {} as Record<string, unknown>,
    now = MONDAY_9AM,
    storeGate = Promise.resolve(),
    env = { HOME } as Record<string, string>,
    // The engine on Windows passes `/home/t/x` as `C:\home\t\x`; this keys files as `/home/t/x`.
    slashes = false,
  } = {},
) => {
  const at = (path: string) => (slashes ? path.replace(/\\/g, '/').replace(/^[A-Za-z]:(?=\/)/, '') : path)
  const clock = mock.clock(on, { now })
  // By hand, not mock.store, so a test can read back what the mod kept.
  const stored = new Map<string, unknown>(Object.entries({ ...(introduced ? { introduced: true } : {}), ...store }))
  on('store.get', ($, e) => ({ value: stored.get(e.key) }))
  on('store.set', async ($, e) => {
    await storeGate
    stored.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    stored.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...stored.keys()] }))
  mock.env(on, env)
  const toasts: string[] = []
  on('fs.read', ($, e) => {
    const text = files.get(at(e.path))
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  // When each file was last written, the way a real disk would tell it.
  const mtimes = new Map<string, number>()
  const touch = (path: string, text: string) => {
    files.set(path, text)
    mtimes.set(path, clock.now())
  }
  on('fs.write', ($, e) => {
    touch(at(e.path), e.text)
    return { value: undefined }
  })
  const entry = (path: string) => ({
    kind: 'file' as const,
    size: files.get(path)?.length ?? 0,
    mtimeMs: mtimes.get(path) ?? 0,
    isLink: false,
  })
  on('fs.list', ($, e) => {
    const dir = at(e.path)
    return {
      value: [...files.keys()]
        .filter(path => path.startsWith(`${dir}/`) && !path.slice(dir.length + 1).includes('/'))
        .map(path => ({ name: path.slice(dir.length + 1), ...entry(path) })),
    }
  })
  on('fs.stat', ($, e) => {
    const path = at(e.path)
    if (files.has(path)) return { value: entry(path) }
    const isDir = [...files.keys()].some(file => file.startsWith(`${path}/`))
    if (!isDir) throw new Error(`ENOENT ${e.path}`)
    return { value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false } }
  })
  const calls: string[] = []
  on('fs.exists', ($, e) => {
    calls.push('fs.exists')
    const path = at(e.path)
    const isDir = [...files.keys()].some(file => file.startsWith(`${path}/`))
    return { value: files.has(path) || isDir }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  const registered: string[] = []
  on('command.register', ($, e) => {
    registered.push(e.name)
    return { value: { command: e.name } }
  })
  const config = new Map<string, unknown>()
  on('config.set', ($, e) => {
    config.set(e.key, e.value)
    return { value: e.value }
  })
  const open = new Set<string>()
  on('ui.open', ($, e) => {
    calls.push(`ui.open:${e.id}`)
    open.add(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', ($, e) => {
    open.delete(e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: [...open].map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })) }))
  // The prompt box: what fills write and what the mod reads back.
  const box = { text: '' }
  on('prompt.fill', ($, e) => {
    box.text = e.mode === 'append' ? box.text + e.text : e.text
    return { isFilled: true }
  })
  on('prompt.read', () => ({ value: { text: box.text, cursor: box.text.length } }))
  // What sits beneath the mod: a settings hook may refuse the prompt.
  const below = { refuse: undefined as string | undefined }
  on('prompt.submit', ($, e) => (below.refuse === undefined ? { text: e.text } : { drop: below.refuse }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  // The conversation's id: /clear and /resume change it.
  const session = { id: 's1' }
  on('session.id', () => ({ value: session.id }))
  return { clock, files, touch, toasts, open, config, calls, registered, below, box, stored, session }
}

// A day's pace file, as the mod writes it beside the count.
const day = (state: { start?: number; window?: { from: number; ms: number; base: number }; breather?: number }) =>
  `${JSON.stringify(state)}\n`

const fit = ($: Engine, args: string) =>
  $.command.run({
    command: 'fit',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })

// A prompt the person typed: in strict mode, the one thing that costs reps.
const send = ($: Engine, text = 'go') => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })

const start = ($: Engine) =>
  $.session.start({ cwd: HOME, surface: 'terminal', isInteractive: true })

describe('lib', () => {
  test('parses /fit arguments', async () => {
    expect(parseFit('')).toEqual({ kind: 'status' })
    expect(parseFit('20')).toEqual({ kind: 'add', n: 20 })
    expect(parseFit('-5')).toEqual({ kind: 'add', n: -5 })
    expect(parseFit('set 80')).toEqual({ kind: 'set', n: 80 })
    expect(parseFit('set x').kind).toBe('error')
    expect(parseFit('dance').kind).toBe('error')
    expect(parseFit('strict')).toEqual({ kind: 'strict', isOn: true })
    expect(parseFit('help')).toEqual({ kind: 'help' })
    expect(parseFit('rules')).toEqual({ kind: 'help' })
    expect(parseFit('strict off')).toEqual({ kind: 'strict', isOn: false })
    expect(parseFit('window 1240')).toEqual({ kind: 'window-until', hour: 12, minute: 40 })
    expect(parseFit('window 9:05')).toEqual({ kind: 'window-until', hour: 9, minute: 5 })
    expect(parseFit('window 940')).toEqual({ kind: 'window-until', hour: 9, minute: 40 })
    expect(parseFit('window 3')).toEqual({ kind: 'window', hours: 3 })
    expect(parseFit('window 2560').kind).toBe('error')
    expect(parseFit('window 0930')).toEqual({ kind: 'window-until', hour: 9, minute: 30 })
    expect(parseFit('window 100')).toEqual({ kind: 'window-until', hour: 1, minute: 0 })
    expect(parseFit('window 12')).toEqual({ kind: 'window', hours: 12 })
    expect(parseFit('easy')).toEqual({ kind: 'strict', isOn: false })
    expect(parseFit('snooze')).toEqual({ kind: 'snooze', minutes: 30 })
    expect(parseFit('snooze 45')).toEqual({ kind: 'snooze', minutes: 45 })
    expect(parseFit('snooze 20m')).toEqual({ kind: 'snooze', minutes: 20 })
    expect(parseFit('snooze 90').kind).toBe('error')
    expect(parseFit('snooze 0').kind).toBe('error')
    // The old name still works.
    expect(parseFit('later 20')).toEqual({ kind: 'snooze', minutes: 20 })
    expect(parseFit('reset')).toEqual({ kind: 'reset' })
    expect(parseFit('rest')).toEqual({ kind: 'skip' })
    expect(parseFit('rest off')).toEqual({ kind: 'unskip' })
    expect(parseFit('start')).toEqual({ kind: 'intro' })
    expect(parseFit('coach strict').kind).toBe('error')
  })

  test('streak counts days with any reps and forgives an empty today', async () => {
    // Each its own date: entries that share one are one day's exercises.
    let n = 0
    const day = (count: number, isSkipped = false) => ({ date: `d${n++}`, count, goal: 100, exercise: 'dips', isSkipped })
    expect(streak([day(0), day(100), day(120), day(40)])).toBe(3)
    expect(streak([day(0), day(100), day(40), day(0)])).toBe(2)
    expect(streak([day(100), day(100, true), day(100)])).toBe(1)
    // A rest day taken today ends the run now, not tomorrow.
    expect(streak([day(100), day(40), day(0, true)])).toBe(0)
  })
})

describe('setup helpers', () => {
  test('custom routines, scaling and colors', async () => {
    expect(parseCustom('30 burpees')?.mon).toEqual(asRoutine({ mon: { exercise: 'burpees', goal: 30 } }).mon)
    expect(parseCustom('burpees')).toBeUndefined()
    expect(scale(asRoutine({ mon: { exercise: 'dips', goal: 100 } }), 0.5).mon?.plans[0]?.goal).toBe(50)
    expect(progressColor(0, 100)).toBeUndefined()
    expect(progressColor(1, 100)).toBe('#d7af5f')
    expect(progressColor(33, 100)).toBe('#d7af5f')
    expect(progressColor(79, 100)).toBe('#d7af5f')
    expect(progressColor(80, 100)).toBe('#87af87')
    expect(progressColor(100, 100)).toBe('#87af87')
    expect(progressColor(5, 0)).toBeUndefined()
  })
})

describe('logging', () => {
  test('/fit adds reps to the shared log file and seeds a routine', async ($, on) => {
    const { files, toasts } = world(on)
    await start($)
    const ran = await fit($, '60')
    expect(ran.text).toContain('60/100 pushups')
    expect(files.get(`${LOG}/2026-10-05`)).toBe('60\n')
    expect(files.has(`${HOME}/.claude/fitness/routine.json`)).toBe(true)
    expect(toasts.some(t => t.startsWith('💪 +60 pushups.') && t.endsWith('40 to go.'))).toBe(true)

    toasts.length = 0
    await fit($, '40')
    expect(files.get(`${LOG}/2026-10-05`)).toBe('100\n')
    expect(toasts.some(t => t.includes("That's the work"))).toBe(true)
    // The goal's own toast, not a cheer as well.
    expect(toasts.some(t => t.startsWith('💪'))).toBe(false)
  })

  test('a set short of the goal gets a cheer; a lowered count does not', async ($, on) => {
    const { toasts } = world(on)
    await start($)
    await fit($, '10')
    await fit($, '10')
    const cheers = toasts.filter(t => t.startsWith('💪 +10 pushups.'))
    expect(cheers.length).toBe(2)
    // The line turns with the set number.
    expect(cheers[0]).not.toBe(cheers[1])

    toasts.length = 0
    await fit($, '-5')
    await fit($, 'reset')
    expect(toasts.some(t => t.startsWith('💪'))).toBe(false)
  })

  test('back-to-back sets of any size get different lines', () => {
    // 30-rep sets: counts 30, 60, 90 are all multiples of the six lines.
    for (const size of [5, 10, 25, 30, 60]) {
      const lines = [1, 2, 3].map(set => cheer(size, set * size, 300, 'squats').split('. ')[1])
      expect(new Set(lines).size).toBe(3)
    }
  })

  test('/fit reads counts the shell script already wrote', async ($, on) => {
    world(on, new Map([[`${LOG}/2026-10-05`, '30\n']]))
    await start($)
    const ran = await fit($, '')
    expect(ran.text).toContain('30/100 pushups')
  })
})

describe('two sessions', () => {
  test('reps logged in another session reach the band within a poll', async ($, on) => {
    const { clock, touch, calls } = world(on)
    await start($)
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...BAND })
    expect(await ui.find({ type: 'Text', text: '0/100 pushups' })).toBeDefined()

    // A quiet log: polls look, but read nothing back in.
    calls.length = 0
    await clock.advance(10_000)
    expect(calls.filter(call => call === 'fs.exists').length).toBeLessThan(5)

    // Another session (or the shell script) writes today's count.
    await clock.advance(1_000)
    touch(`${LOG}/2026-10-05`, '40\n')
    await clock.advance(10_000)
    expect(await ui.find({ type: 'Text', text: '40/100 pushups' })).toBeDefined()
    await ui.unmount()
  })

  test('/fit reload reads the log now, without waiting for a poll', async ($, on) => {
    const { touch } = world(on)
    await start($)
    touch(`${LOG}/2026-10-05`, '25\n')
    const ran = await fit($, 'reload')
    expect(ran.text).toContain('Reloaded from disk. 💪')
    expect(ran.text).toContain('25/100 pushups')
    expect(parseFit('sync')).toEqual({ kind: 'reload' })
  })
})

describe('nudges', () => {
  test('a long turn nudges without blocking when strict is off', async ($, on) => {
    const { clock, toasts } = world(on)
    await start($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await clock.advance(31_000)
    expect(toasts.some(t => t.includes("You next: 10 pushups."))).toBe(true)
    const submitted = await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } })
    expect(submitted.drop).toBeUndefined()
  })

  test('/fit rest marks the day and holds nothing', { options: { strict: true } }, async ($, on) => {
    const { files } = world(on)
    await start($)
    await send($)
    await fit($, 'rest')
    expect(files.has(`${LOG}/2026-10-05.skip`)).toBe(true)
    const submitted = await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } })
    expect(submitted.drop).toBeUndefined()
  })

  test('/fit rest refuses once reps are logged today', async ($, on) => {
    const { files } = world(on, new Map([[`${LOG}/2026-10-05`, '20\n']]))
    await start($)
    expect((await fit($, 'rest')).text).toContain("so it's a training day")
    expect(files.has(`${LOG}/2026-10-05.skip`)).toBe(false)
  })

  test('a nudge suggests the set that is due, and none right after one', async ($, on) => {
    const { clock, toasts } = world(on, new Map([[`${LOG}/2026-10-05.swap`, '{"exercise":"squats","goal":500}\n']]))
    await start($)
    await send($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await clock.advance(31_000)
    expect(toasts.some(t => t.includes('You next: 50 squats.'))).toBe(true)
    await fit($, '50')
    toasts.length = 0
    await $.turn.start({ text: 'go', turnId: 't2' })
    await clock.advance(31_000)
    expect(toasts.some(t => t.includes('You next'))).toBe(false)
  })

  test('no nudge once the goal is met', async ($, on) => {
    const { clock, toasts } = world(on, new Map([[`${LOG}/2026-10-05`, '100\n']]))
    await start($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await clock.advance(31_000)
    expect(toasts.some(t => t.includes("mid-set"))).toBe(false)
  })
})

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 6,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 6 },
    view: {},
  },
} as const

const PANE = {
  component: 'Pane',
  requestId: 'gym-week',
  props: {
    title: 'TERMINAL GYM',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

describe('drawing', () => {
  test('the band shows progress and its buttons log reps', async ($, on) => {
    const { files } = world(on)
    await start($)
    let total = 0
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'terminal-gym', surface, ...BAND })
      expect(await ui.find({ type: 'Text', text: `${total}/100 pushups` })).toBeDefined()
      await ui.press({ key: 'add10' })
      await ui.press({ key: 'add20' })
      total += 30
      expect(files.get(`${LOG}/2026-10-05`)).toBe(`${total}\n`)
      expect(await ui.find({ type: 'Text', text: `${total}/100 pushups` })).toBeDefined()
      await ui.unmount()
    }
  })

  test('the week pane shows the streak on every surface', async ($, on) => {
    world(
      on,
      new Map([
        [`${LOG}/2026-10-03`, '300\n'],
        [`${LOG}/2026-10-04`, '100\n'],
      ]),
    )
    await start($)
    await fit($, 'streak')
    for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
      const ui = await $.ui.mount({ plugin: 'terminal-gym', surface, ...PANE })
      expect(await ui.find({ type: 'Text', text: /2-day streak/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'TERMINAL GYM' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('the spinner names the set during a long turn', async ($, on) => {
    const { clock } = world(on)
    on('ui.render', { component: 'Spinner' }, ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>{e.props.message ?? e.props.word}</Text>
    })
    await start($)
    const spinner = {
      component: 'Spinner',
      props: { word: 'Sauteing', message: null, suffix: '…', mode: 'responding' },
    } as const
    await $.turn.start({ text: 'go', turnId: 't1' })
    await clock.advance(31_000)
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...spinner })
    expect(await ui.find({ type: 'Text', text: /10 pushups while Claude works/ })).toBeDefined()
    await ui.unmount()
  })
})

describe('first run', () => {
  test('the band introduces Terminal Gym until set up or dismissed', async ($, on) => {
    world(on, new Map(), { introduced: false })
    await start($)
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...BAND })
    expect(await ui.find({ type: 'Text', text: /You next/ })).toBeDefined()
    await ui.press({ key: 'dismiss' })
    expect(await ui.find({ type: 'Text', text: /0\/100 pushups/ })).toBeDefined()
    await ui.unmount()
  })

  test('/fit help opens a help pane with its own close button', async ($, on) => {
    const { open } = world(on)
    await start($)
    await fit($, 'help')
    expect(open.has('gym-help')).toBe(true)
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...PANE, requestId: 'gym-help' })
    expect(await ui.find({ type: 'Markdown', text: /\/fit help/ })).toBeDefined()
    await ui.press({ key: 'close' })
    expect(open.has('gym-help')).toBe(false)
  })

  test('/fit streak toggles the pane', async ($, on) => {
    const { open } = world(on)
    await start($)
    await fit($, 'streak')
    expect(open.has('gym-week')).toBe(true)
    const again = await fit($, 'streak')
    expect((await fit($, 'score')).text).toContain('usage')
    expect(again.text).toContain('closed')
    expect(open.has('gym-week')).toBe(false)
  })
})

describe('strict command', () => {
  test('/fit strict flips the setting', async ($, on) => {
    const { config } = world(on)
    await start($)
    const ran = await fit($, 'strict')
    expect(ran.text).toContain('Coach is strict')
    expect(config.get('terminal-gym.strict')).toBe(true)
  })
})

const ONBOARD = {
  component: 'Pane',
  requestId: 'gym-onboard',
  props: { ...PANE.props, title: 'TERMINAL GYM' },
} as const

describe('walkthrough', () => {
  test('three steps, back and next, then a saved program and a streak', async ($, on) => {
    const { files, open } = world(
      on,
      new Map([
        [`${LOG}/2026-10-03`, '400\n'],
        [`${LOG}/2026-10-04`, '400\n'],
      ]),
      { introduced: false },
    )
    await start($)
    const band = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...BAND })
    await band.press({ key: 'setup' })
    expect(open.has('gym-onboard')).toBe(true)

    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...ONBOARD })
    expect(await ui.find({ type: 'Text', text: /Step 1 of 3/ })).toBeDefined()
    expect(await ui.find({ key: 'back' })).toBeUndefined()
    await ui.press({ key: 'next' })
    expect(await ui.find({ type: 'Text', text: /Pick your program/ })).toBeDefined()
    await ui.press({ key: 'back' })
    expect(await ui.find({ type: 'Text', text: /Step 1 of 3/ })).toBeDefined()
    await ui.press({ key: 'next' })
    await ui.press({ key: 'program-2' })
    await ui.press({ key: 'size-Heavy' })
    expect(await ui.find({ type: 'Text', text: '400 squats' })).toBeDefined()
    await ui.press({ key: 'next' })
    expect(await ui.find({ type: 'Text', text: /🔥4d/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /fit streak/ })).toBeDefined()
    await ui.press({ key: 'finish' })
    await ui.unmount()

    expect(JSON.parse(files.get(`${HOME}/.claude/fitness/routine.json`) ?? '{}').mon).toEqual({ exercise: 'squats', goal: 400 })
    expect(open.has('gym-onboard')).toBe(false)
    expect(await band.find({ type: 'Text', text: /0\/400 squats/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: '🔥2d' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: 'log reps: ' })).toBeDefined()
    await band.unmount()
  })

  test('custom goals are typed per exercise and keep the days', async ($, on) => {
    const { files } = world(on)
    await start($)
    await fit($, 'program')
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...ONBOARD })
    await ui.press({ key: 'next' })
    expect(await ui.find({ key: 'goal-pushups' })).toBeUndefined()
    await ui.press({ key: 'program-3' })
    expect(await ui.find({ key: 'size-Heavy' })).toBeUndefined()
    await ui.input({ key: 'goal-pushups', text: '120', kind: 'change' })
    await ui.input({ key: 'goal-squats', text: 'lots' })
    await ui.press({ key: 'next' })
    expect(await ui.find({ type: 'Text', text: /whole number above 0/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Pick your program/ })).toBeDefined()
    await ui.input({ key: 'goal-squats', text: '250' })
    expect(await ui.find({ type: 'Text', text: '120 pushups / 100 dips / 250 squats' })).toBeDefined()
    await ui.press({ key: 'next' })
    await ui.press({ key: 'finish' })
    await ui.unmount()

    const routine = JSON.parse(files.get(`${HOME}/.claude/fitness/routine.json`) ?? '{}')
    expect(routine.mon).toEqual({ exercise: 'pushups', goal: 120 })
    expect(routine.tue).toEqual({ exercise: 'dips', goal: 100 })
    expect(routine.sat).toEqual({ exercise: 'squats', goal: 250 })
  })

  test('the mobile walkthrough offers no custom goals', async ($, on) => {
    world(on)
    await start($)
    await fit($, 'program')
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'mobile', ...ONBOARD })
    await ui.press({ key: 'next' })
    expect(await ui.find({ key: 'program-2' })).toBeDefined()
    expect(await ui.find({ key: 'program-3' })).toBeUndefined()
    await ui.unmount()
  })

  test('a new program leaves the days before it at the goals they had', async ($, on) => {
    // Sunday's 100 pushups were the goal then; a squats program mustn't rewrite it.
    const { files } = world(on, new Map([[`${LOG}/2026-10-04`, '100\n'], [`${LOG}/2026-10-03.swap`, '{"exercise":"burpees","goal":20}\n']]))
    await start($)
    await fit($, 'program')
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...ONBOARD })
    await ui.press({ key: 'next' })
    await ui.press({ key: 'program-2' })
    await ui.press({ key: 'next' })
    await ui.press({ key: 'finish' })
    await ui.unmount()
    expect(JSON.parse(files.get(`${LOG}/2026-10-04.swap`) ?? '{}')).toEqual({ exercise: 'pushups', goal: 100 })
    // A day already swapped keeps its own plan, and today takes the new one.
    expect(JSON.parse(files.get(`${LOG}/2026-10-03.swap`) ?? '{}')).toEqual({ exercise: 'burpees', goal: 20 })
    expect(files.has(`${LOG}/2026-10-05.swap`)).toBe(false)
  })

  test('custom goals left as filled keep days that differ', async () => {
    const base = asRoutine({ mon: { exercise: 'pushups', goal: 100 }, thu: { exercise: 'pushups', goal: 50 }, tue: { exercise: 'dips', goal: 80 } })
    expect(customRoutine(base, { pushups: '100', dips: '80' })).toEqual(base)
    expect(customRoutine(base, { pushups: '120', dips: '80' })?.thu?.plans[0]?.goal).toBe(120)
    expect(customRoutine(base, { pushups: '', dips: '80' })).toBeUndefined()
  })

  test('re-picking the same program writes no history', async ($, on) => {
    const { files } = world(on)
    await start($)
    await fit($, 'program')
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...ONBOARD })
    await ui.press({ key: 'next' })
    await ui.press({ key: 'next' })
    await ui.press({ key: 'finish' })
    await ui.unmount()
    expect([...files.keys()].some(path => path.endsWith('.swap'))).toBe(false)
  })

  test('/fit reset puts today back to zero', async ($, on) => {
    const { files } = world(on, new Map([[`${LOG}/2026-10-05`, '70\n']]))
    await start($)
    const ran = await fit($, 'reset')
    expect(ran.text).toContain('0/100 pushups')
    expect(files.get(`${LOG}/2026-10-05`)).toBe('0\n')
  })
})

test('/fit start brings the welcome band back', async ($, on) => {
  world(on)
  await start($)
  await fit($, 'start')
  const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /You next/ })).toBeDefined()
  await ui.unmount()
})

test('/fit program opens the walkthrough', async ($, on) => {
  const { open } = world(on)
  await start($)
  const ran = await fit($, 'program')
  expect(ran.text).toContain('Pick your program')
  expect(open.has('gym-onboard')).toBe(true)
})

describe('swap', () => {
  test('pickSwap cycles or picks by name', async () => {
    const routine = asRoutine({
      mon: { exercise: 'pushups', goal: 100 },
      tue: { exercise: 'dips', goal: 100 },
      wed: { exercise: 'squats', goal: 300 },
    })
    const on = (exercise: string) => ({ plans: [{ exercise, goal: 100 }] })
    expect(pickSwap(routine, on('pushups'))).toEqual({ kind: 'day', day: { plans: [{ exercise: 'dips', goal: 100 }] } })
    expect(pickSwap(routine, on('squats'))).toEqual({ kind: 'day', day: { plans: [{ exercise: 'pushups', goal: 100 }] } })
    expect(pickSwap(routine, on('pushups'), 'squats')).toEqual({ kind: 'day', day: { plans: [{ exercise: 'squats', goal: 300 }] } })
    expect(pickSwap(routine, on('pushups'), 'burpees')).toMatchObject({ kind: 'refuse' })
  })

  test('/fit swap changes today and sticks for the day', async ($, on) => {
    const { files } = world(on)
    await start($)
    const ran = await fit($, 'swap squats')
    expect(ran.text).toContain('0/300 squats')
    expect(files.has(`${LOG}/2026-10-05.swap`)).toBe(true)
    expect((await fit($, '')).text).toContain('squats')
    expect((await fit($, 'swap')).text).toContain('pushups')
    expect((await fit($, 'swap burpees')).text).toContain('No burpees')
  })
})

describe('swap edge cases', () => {
  test('multi-word names, empty routines and same-exercise swaps', async ($, on) => {
    expect(parseFit('swap jumping jacks')).toEqual({ kind: 'swap', typedName: 'jumping jacks' })
    expect(parseFit('swap Jumping   Jacks')).toEqual({ kind: 'swap', typedName: 'jumping jacks' })
    expect(pickSwap({}, { plans: [{ exercise: 'pushups', goal: 100 }] })).toEqual({ kind: 'refuse', text: 'Your program has no exercises. /fit program to pick one.' })
    const { files } = world(on, new Map([[`${HOME}/.claude/fitness/routine.json`, JSON.stringify({ mon: { exercise: 'jumping jacks', goal: 50 }, tue: { exercise: 'dips', goal: 100 } })]]))
    await start($)
    expect((await fit($, 'swap jumping jacks')).text).toContain('Already on jumping jacks')
    expect((await fit($, 'swap dips')).text).toContain('0/100 dips')
    files.set(`${HOME}/.claude/fitness/routine.json`, '{}')
    expect((await fit($, 'swap')).text).toContain('no exercises')
  })

  test('a damaged swap file falls back to the routine', async ($, on) => {
    world(on, new Map([[`${LOG}/2026-10-05.swap`, '{oops']]))
    await start($)
    expect((await fit($, '')).text).toContain('0/100 pushups')
  })

  test('reps carry over and the reply says so', async ($, on) => {
    world(on, new Map([[`${LOG}/2026-10-05`, '40\n']]))
    await start($)
    expect((await fit($, 'swap squats')).text).toContain('Your 40 reps carry over')
  })
})

test('the scoreboard draws the barbell when it fits and the name alone when narrow', async ($, on) => {
  world(on)
  await start($)
  await fit($, 'streak')
  const wide = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...PANE })
  expect(await wide.find({ type: 'Text', text: '▐█▌▐█▌━━━' })).toBeDefined()
  await wide.unmount()
  const narrow = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...PANE, props: { ...PANE.props, bodyColumns: 24 } })
  expect(await narrow.find({ type: 'Text', text: '▐█▌' })).toBeUndefined()
  expect(await narrow.find({ type: 'Text', text: 'TERMINAL GYM' })).toBeDefined()
  await narrow.unmount()
})

test('the barbell is terminal-only; other surfaces show the name', async ($, on) => {
  world(on)
  await start($)
  await fit($, 'streak')
  for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: '▐█▌' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'TERMINAL GYM' })).toBeDefined()
    await ui.unmount()
  }
})

test('the bands stack instead of squeezing on narrow terminals', async ($, on) => {
  const { files } = world(on, new Map(), { introduced: false })
  await start($)
  for (const bodyColumns of [140, 70, 40]) {
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...BAND, props: { ...BAND.props, bodyColumns } })
    expect(await ui.find({ type: 'Text', text: 'Your agent put in the reps. You next.' })).toBeDefined()
    expect(await ui.find({ key: 'setup' })).toBeDefined()
    expect(await ui.find({ key: 'dismiss' })).toBeDefined()
    await ui.unmount()
  }
  const narrow = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...BAND, props: { ...BAND.props, bodyColumns: 40 } })
  await narrow.press({ key: 'dismiss' })
  await narrow.press({ key: 'add10' })
  expect(files.get(`${LOG}/2026-10-05`)).toBe('10\n')
  await narrow.unmount()
})

test('time left reads in minutes, then hours', () => {
  expect(untilText(1)).toBe('1m')
  expect(untilText(22.5 * 60_000)).toBe('23m')
  expect(untilText(60 * 60_000)).toBe('1h')
  expect(untilText(65 * 60_000)).toBe('1h 5m')
})

test('band widths follow the labels', async () => {
  expect(buttonsWidth(['Pick your training', 'Help', 'Just train'])).toBe(46)
  expect(buttonsWidth(['+5', '+10', '+25'])).toBe(22)
  expect(cells('✅ 💪 🔥')).toBe(8)
})

test('rep buttons scale with the set, the last one the set exactly', async () => {
  expect(repSteps(30)).toEqual([10, 20, 30])
  expect(repSteps(15)).toEqual([5, 10, 15])
  expect(repSteps(10)).toEqual([5, 10, 20])
  expect(repSteps(5)).toEqual([3, 5, 10])
  expect(repSteps(60)).toEqual([20, 40, 60])
  expect(repSteps(65)).toEqual([20, 40, 65])
  expect(repSteps(13)).toEqual([5, 10, 13])
  expect(repSteps(2)).toEqual([1, 2, 4])
  // Never two buttons with the same key.
  expect(repSteps(1)).toEqual([1, 2])
  expect(repSteps(0)).toEqual([5, 10, 25])
})

test('a 300 goal gets +10 +20 +30', async ($, on) => {
  const { files } = world(on, new Map([[`${LOG}/2026-10-05.swap`, '{"exercise":"squats","goal":300}\n']]))
  await start($)
  const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...BAND })
  expect(await ui.find({ key: 'add5' })).toBeUndefined()
  await ui.press({ key: 'add30' })
  expect(files.get(`${LOG}/2026-10-05`)).toBe('30\n')
  await ui.unmount()
})

test('the welcome band changes layout with width', async ($, on) => {
  world(on, new Map(), { introduced: false })
  await start($)
  const layout = async (bodyColumns: number) => {
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...BAND, props: { ...BAND.props, bodyColumns } })
    const dirs = await Promise.all(['band', 'header', 'buttons'].map(async key => (await ui.find({ key }))?.props.flexDirection))
    await ui.unmount()
    return dirs
  }
  expect(await layout(104)).toEqual(['row', 'row', 'row'])
  expect(await layout(103)).toEqual(['column', 'row', 'row'])
  expect(await layout(57)).toEqual(['column', 'row', 'row'])
  expect(await layout(56)).toEqual(['column', 'column', 'row'])
  expect(await layout(45)).toEqual(['column', 'column', 'column'])
})

test('the band wordmark is a mini barbell', async ($, on) => {
  world(on, new Map(), { introduced: false })
  await start($)
  const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: '█═' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'TERMINAL-GYM' })).toBeDefined()
  await ui.unmount()
})

test('below the wordmark width the band shows the bare name', async ($, on) => {
  world(on, new Map(), { introduced: false })
  await start($)
  const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...BAND, props: { ...BAND.props, bodyColumns: 16 } })
  expect(await ui.find({ type: 'Text', text: '█═' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'TERMINAL-GYM' })).toBeDefined()
  await ui.unmount()
})

test('a rest day hides the rep buttons and offers a way back', async ($, on) => {
  world(on)
  await start($)
  await fit($, 'rest')
  const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /Rest day · pushups back tomorrow/ })).toBeDefined()
  expect(await ui.find({ key: 'add5' })).toBeUndefined()
  await ui.press({ key: 'train' })
  await ui.unmount()

  const back = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...BAND })
  expect(await back.find({ key: 'add5' })).toBeDefined()
  await back.unmount()
})

describe('rest days', () => {
  test('/fit rest off undoes the rest day and reps count again', async ($, on) => {
    const { files } = world(on)
    await start($)
    await fit($, 'rest')
    expect((await fit($, '10')).text).toContain("Today's a rest day")
    expect(files.get(`${LOG}/2026-10-05`)).toBeUndefined()

    expect((await fit($, 'rest off')).text).toContain('Rest day undone')
    expect((await fit($, '10')).text).toContain('10/100 pushups')
    expect((await fit($, 'rest off')).text).toContain("Today isn't a rest day")
  })

  test('no nudges or held prompts on a rest day', { options: { strict: true } }, async ($, on) => {
    const { clock, toasts } = world(on)
    await start($)
    await fit($, 'rest')
    await $.turn.start({ text: 'go', turnId: 't1' })
    await clock.advance(31_000)
    expect(toasts.some(t => t.includes('mid-set'))).toBe(false)
    const submitted = await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } })
    expect(submitted.drop).toBeUndefined()
  })

  test('a rest day marked by hand holds nothing, even when behind', { options: { strict: true } }, async ($, on) => {
    const { files } = world(on)
    await start($)
    await send($)
    // A rest day marked outside /fit rest, after falling behind.
    files.set(`${LOG}/2026-10-05.skip`, '')
    await fit($, '')
    const submitted = await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } })
    expect(submitted.drop).toBeUndefined()
  })

  test('/fit rest twice says it already is one', async ($, on) => {
    world(on)
    await start($)
    await fit($, 'rest')
    expect((await fit($, 'rest')).text).toContain('Already a rest day')
  })
})

test('Pick your training opens the walkthrough before any other work', async ($, on) => {
  // The engine only counts an open as asked for while the press is still being
  // answered; opening after file reads left the pane undrawn on narrow terminals.
  const { calls } = world(on, new Map(), { introduced: false })
  await start($)
  const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...BAND })
  calls.length = 0
  await ui.press({ key: 'setup' })
  expect(calls[0]).toBe('ui.open:gym-onboard')
  await ui.unmount()
})

test('score rows name each day\'s exercise', async ($, on) => {
  world(on, new Map([[`${LOG}/2026-10-03`, '300\n'], [`${LOG}/2026-10-05`, '15\n']]))
  await start($)
  await fit($, 'streak')
  const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /300\/300  squats/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /15\/100   pushups/ })).toBeDefined()
  // Each day carries its own bar; today's progress isn't repeated above.
  expect(await ui.find({ type: 'Text', text: '━━━━━━━━━━' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '━' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '─────────' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /💪/ })).toBeUndefined()
  await ui.unmount()
})

test('the grid leaves a blank row between weeks', async () => {
  const day = (i: number) => ({ date: `d${i}`, count: 0, goal: 100, exercise: 'dips', isSkipped: false })
  expect(heatCells(Array.from({ length: 28 }, (_, i) => day(i))).rows).toBe(7)
  expect(heatCells(Array.from({ length: 7 }, (_, i) => day(i))).rows).toBe(1)
})

test('/clear and /resume run the setup again', async ($, on) => {
  on('classic.SessionStart', () => ({}))
  const { registered } = world(on)
  await start($)
  expect(registered).toEqual(['fit'])
  await $.classic.SessionStart({ source: 'clear' })
  expect(registered).toEqual(['fit', 'fit'])
  await $.classic.SessionStart({ source: 'resume' })
  expect(registered).toEqual(['fit', 'fit', 'fit'])
  await $.classic.SessionStart({ source: 'compact' })
  expect(registered).toEqual(['fit', 'fit', 'fit'])
})

test('a new conversation runs the setup again when classic.SessionStart never arrives', async ($, on) => {
  const { registered, session } = world(on)
  await start($)
  expect(registered).toEqual(['fit'])
  // Same conversation: nothing runs again.
  await send($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  expect(registered).toEqual(['fit'])
  // /clear with the classic event passed on past the mod: the next prompt
  // sees the new id and runs the setup once, not again for its turn.
  session.id = 's2'
  await send($, '/fit 10')
  await $.turn.start({ text: 'go', turnId: 't2' })
  expect(registered).toEqual(['fit', 'fit'])
})

test('with no HOME, as on Windows, the data goes under USERPROFILE', async ($, on) => {
  const files = new Map<string, string>()
  world(on, files, { env: { USERPROFILE: 'C:\\Users\\t' } })
  await start($)
  // The engine writes native separators, so compare with slashes.
  const written = [...files.keys()].map(path => path.replace(/\\/g, '/'))
  expect(written).toContain('C:/Users/t/.claude/fitness/routine.json')
  expect(written.some(path => path.startsWith('/.claude'))).toBe(false)
})

test('easy mode still waits for a long turn before nudging', async ($, on) => {
  const { clock, toasts } = world(on)
  await start($)
  await $.turn.start({ text: 'quick one', turnId: 't1' })
  expect(toasts.some(t => t.includes('mid-set'))).toBe(false)
  await clock.advance(31_000)
  expect(toasts.some(t => t.includes('You next: 10 pushups'))).toBe(true)
})

describe('pace', () => {
  const HOUR = 60 * 60_000
  const GAP = (8 * HOUR) / 9 // 100 pushups in sets of 10: ten sets, nine gaps

  test('sets are spread evenly from the first prompt', async () => {
    expect(setSizeFor(100, 0)).toBe(10)
    expect(setSizeFor(300, 0)).toBe(30)
    expect(setSizeFor(12, 0)).toBe(5)
    expect(setSizeFor(3, 0)).toBe(3)
    expect(setSizeFor(100, 15)).toBe(15)
    expect(paceAt(100, 0, 10, 0, 0, 8 * HOUR)).toEqual({ required: 10, behind: 10, setSize: 10, nextDueAt: GAP, restUntil: null })
    expect(paceAt(100, 10, 10, 0, GAP - 1, 8 * HOUR).behind).toBe(0)
    expect(paceAt(100, 10, 10, 0, GAP, 8 * HOUR).behind).toBe(10)
    expect(paceAt(100, 40, 10, 0, 8 * HOUR, 8 * HOUR)).toEqual({ required: 100, behind: 60, setSize: 10, nextDueAt: null, restUntil: null })
    expect(paceAt(0, 0, 0, 0, 0, 8 * HOUR).behind).toBe(0)
  })

  test('strict: the first prompt of the day needs the opening set', { options: { strict: true } }, async ($, on) => {
    world(on)
    await start($)
    const first = await send($)
    expect(first.drop).toContain('Start the day with a set: 10 pushups')
    await fit($, '10')
    expect((await send($)).drop).toBeUndefined()
  })

  // Claude Code restores a dropped prompt; a fill of the mod's own doubled it.
  test('strict: a held prompt is left to Claude Code to restore', { options: { strict: true } }, async ($, on) => {
    const { box } = world(on)
    await start($)
    expect((await send($, 'a long prompt')).drop).toContain('Start the day with a set')
    expect(box.text).toBe('')
  })

  test('/fit goal changes today only, and the pace follows', async ($, on) => {
    const { files } = world(on)
    await start($)
    expect(parseFit('goal 60')).toEqual({ kind: 'goal', n: 60 })
    expect(parseFit('goal').kind).toBe('error')
    expect(parseFit('goal 0').kind).toBe('error')
    const ran = await fit($, 'goal 60')
    expect(ran.text).toContain("Today's goal is 60 pushups")
    expect(JSON.parse(files.get(`${LOG}/2026-10-05.swap`) ?? '{}')).toEqual({ exercise: 'pushups', goal: 60 })
    expect((await fit($, '')).text).toContain('0/60 pushups')
    expect((await fit($, '60')).text).toContain('60/60 pushups')
  })

  test('strict: /fit window spreads what is left over the hours named', { options: { strict: true } }, async ($, on) => {
    const { clock, toasts } = world(on)
    expect(parseFit('window 3')).toEqual({ kind: 'window', hours: 3 })
    expect(parseFit('window 1.5h')).toEqual({ kind: 'window', hours: 1.5 })
    expect(parseFit('window off')).toEqual({ kind: 'window', hours: null })
    expect(parseFit('window').kind).toBe('error')
    expect(parseFit('window 30').kind).toBe('error')
    await start($)
    await send($)
    await fit($, '10')
    await clock.advance(HOUR)
    // 90 left in sets of 10 over 3h: the first due now, then every 22.5 minutes.
    const ran = await fit($, 'window 3')
    expect(ran.text).toContain('90 pushups left, spread over the next 3h (done by 13:00)')
    expect((await send($)).drop).toContain('(20/100 by now)')
    expect((await fit($, '10')).text).toContain('next set in 23m')
    await clock.advance(23 * 60_000)
    expect(toasts.some(t => t.includes('⏱ Set due: 10 pushups. 30/100 by now.'))).toBe(true)
    // Off: back to 8h from the 9:00 start, where 20 done covers 10:23.
    expect((await fit($, 'window off')).text).toContain('Back to 8h')
    expect((await send($)).drop).toBeUndefined()
  })

  test('a late window ends at midnight, and a day with no goal gets none', async ($, on) => {
    const { clock } = world(on, new Map(), { now: new Date(2026, 9, 5, 23, 0).getTime() })
    await start($)
    expect((await fit($, 'window 3')).text).toContain('100 pushups left, spread between now and midnight')
    // The last of the ten sets comes due before midnight, not on it.
    await fit($, '90')
    await clock.set(new Date(2026, 9, 5, 23, 59).getTime())
    expect((await fit($, '')).text).toContain('10 due now')
    await fit($, 'goal 1')
    await fit($, '1')
    expect((await fit($, 'window 3')).text).toContain("Today's goal is done")
  })

  test('/fit window 1240 ends the window at that time today', async ($, on) => {
    world(on)
    await start($)
    expect((await fit($, 'window 1240')).text).toContain('100 pushups left, spread between now and 12:40')
    expect((await fit($, 'window 0830')).text).toContain('08:30 has already passed today')
  })

  test('strict: a mid-day hold points to /fit easy, never a refused /fit rest', { options: { strict: true } }, async ($, on) => {
    world(on, new Map([[`${LOG}/2026-10-05`, '10\n'], [`${LOG}/2026-10-05.day`, day({ start: MONDAY_9AM - GAP })]]))
    await start($)
    const held = (await send($)).drop ?? ''
    expect(held).toContain('10 pushups due now')
    expect(held).toContain('/fit easy')
    expect(held).not.toContain('/fit rest')
  })

  test('a reset under a mid-day window is not the day\'s opener', { options: { strict: true } }, async ($, on) => {
    world(on, new Map([[`${LOG}/2026-10-05`, '30\n']]))
    await start($)
    await fit($, 'window 3')
    await fit($, 'reset')
    expect((await send($)).drop).not.toContain('Start the day')
  })

  test('a window is only for today', { options: { strict: true } }, async ($, on) => {
    world(on, new Map([[`${LOG}/2026-10-04.day`, day({ window: { from: MONDAY_9AM - 20 * HOUR, ms: HOUR, base: 0 } })]]))
    await start($)
    expect((await send($)).drop).toContain('Start the day with a set: 10 pushups')
  })

  test('a day started in the plugin store before 0.1.5 still counts, until its file is written', { options: { strict: true } }, async ($, on) => {
    const { files } = world(on, new Map(), {
      store: {
        dayStart: { date: '2026-10-05', at: MONDAY_9AM - GAP },
        window: { date: '2026-10-04', from: MONDAY_9AM - 20 * HOUR, ms: HOUR, base: 0 },
      },
    })
    await start($)
    expect((await send($)).drop).toContain('20 pushups due now')
    // The first write moves the day to its file, yesterday's window left behind.
    await fit($, '10')
    expect(JSON.parse(files.get(`${LOG}/2026-10-05.day`) ?? '{}')).toEqual({ start: MONDAY_9AM - GAP, breather: MONDAY_9AM + GAP / 2 })
  })

  test('strict: the next set comes due on schedule, with a toast', { options: { strict: true } }, async ($, on) => {
    const { clock, toasts } = world(on)
    await start($)
    await send($)
    await fit($, '10')
    await clock.advance(GAP - 1_000)
    expect((await send($)).drop).toBeUndefined()
    await clock.advance(2_000)
    expect(toasts.some(t => t.includes('⏱ Set due: 10 pushups. 20/100 by now.'))).toBe(true)
    expect((await send($)).drop).toContain('10 pushups due now')
    await fit($, '10')
    expect((await send($)).drop).toBeUndefined()
  })

  test('a met goal shows no next set', async ($, on) => {
    world(on)
    await start($)
    await send($)
    expect((await fit($, '100')).text).not.toContain('next set')
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...BAND })
    expect(await ui.find({ type: 'Text', text: /100\/100 pushups/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /next set/ })).toBeUndefined()
    await ui.unmount()
  })

  test('easy: same schedule on the band, nothing held', async ($, on) => {
    const { clock, toasts } = world(on)
    await start($)
    expect((await send($)).drop).toBeUndefined()
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...BAND })
    expect(await ui.find({ type: 'Text', text: /first set: 10 to start the day/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /keep prompting/ })).toBeUndefined()
    await ui.press({ key: 'add10' })
    expect(await ui.find({ type: 'Text', text: /next set in 54m/ })).toBeDefined()
    // The band counts down each minute.
    await clock.advance(60_000)
    expect(await ui.find({ type: 'Text', text: /next set in 53m/ })).toBeDefined()
    await ui.unmount()
    await clock.advance(GAP)
    expect(toasts.some(t => t.includes('Set due'))).toBe(true)
    expect((await send($)).drop).toBeUndefined()
  })

  test('strict: the band says to log the due set to keep prompting', { options: { strict: true } }, async ($, on) => {
    world(on)
    await start($)
    await send($)
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...BAND })
    expect(await ui.find({ type: 'Text', text: /first set: 10 to start the day/ })).toBeDefined()
    await ui.unmount()
  })

  test('strict: turns you did not start never start the day or get held', { options: { strict: true } }, async ($, on) => {
    world(on)
    await start($)
    const bg = await $.prompt.submit({ text: 'task done', wait: false, origin: { kind: 'task-notification' } })
    expect(bg.drop).toBeUndefined()
    expect((await send($, '/fit streak')).drop).toBeUndefined()
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...BAND })
    expect(await ui.find({ type: 'Text', text: /behind/ })).toBeUndefined()
    await ui.unmount()
  })

  test('strict: a rest day holds nothing', { options: { strict: true } }, async ($, on) => {
    world(on)
    await start($)
    await fit($, 'rest')
    expect((await send($)).drop).toBeUndefined()
  })

  test('the day start survives a restart and the due timer comes back', async ($, on) => {
    const { clock, toasts } = world(
      on,
      new Map([[`${LOG}/2026-10-05`, '10\n'], [`${LOG}/2026-10-05.day`, day({ start: MONDAY_9AM - 60_000 })]]),
    )
    await start($)
    await clock.advance(GAP - 60_000 + 1_000)
    expect(toasts.some(t => t.includes('⏱ Set due: 10 pushups'))).toBe(true)
  })

  test('strict: a set logged while two behind earns a breather, then the rest is due', { options: { strict: true } }, async ($, on) => {
    const { clock, toasts } = world(on, new Map([[`${LOG}/2026-10-05.day`, day({ start: MONDAY_9AM - GAP })]]))
    await start($)
    expect((await send($)).drop).toContain('20 pushups due now')
    expect((await fit($, '10')).text).toContain('10 due · rest for 27m')
    expect((await send($)).drop).toBeUndefined()
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...BAND })
    expect(await ui.find({ type: 'Text', text: /rest for 27m/ })).toBeDefined()
    await ui.unmount()
    await clock.advance(GAP / 2 - 1_000)
    expect((await send($)).drop).toBeUndefined()
    expect(toasts.some(t => t.includes('Set due'))).toBe(false)
    await clock.advance(2_000)
    expect(toasts.some(t => t.includes('⏱ Set due: 10 pushups. 20/100 by now.'))).toBe(true)
    expect((await send($)).drop).toContain('10 pushups due now')
    await fit($, '10')
    expect((await send($)).drop).toBeUndefined()
  })

  test('strict: fewer reps than the smallest button earn a shorter breather', { options: { strict: true } }, async ($, on) => {
    const { clock, toasts } = world(on, new Map([[`${LOG}/2026-10-05.day`, day({ start: MONDAY_9AM - GAP })]]))
    await start($)
    // 2 of the 5-rep button: two fifths of the 27m breather, about 11m.
    expect((await fit($, '2')).text).toContain('18 due · rest for 11m')
    expect((await send($)).drop).toBeUndefined()
    // One more rep never cuts the breather short.
    expect((await fit($, '1')).text).toContain('17 due · rest for 11m')
    await clock.advance((GAP / 2) * (2 / 5) + 1_000)
    expect(toasts.some(t => t.includes('⏱ Set due: 17 pushups'))).toBe(true)
    expect((await send($)).drop).toContain('17 pushups due now')
  })

  test('strict: clearing the debt earns no breather', { options: { strict: true } }, async ($, on) => {
    world(on, new Map([[`${LOG}/2026-10-05.day`, day({ start: MONDAY_9AM - GAP })]]))
    await start($)
    await fit($, '20')
    expect((await send($)).drop).toBeUndefined()
    expect((await fit($, '')).text).not.toContain('rest for')
  })

  test('strict: a short set still earns a breather, the rest stays owed', { options: { strict: true } }, async ($, on) => {
    world(on, new Map([[`${LOG}/2026-10-05.swap`, '{"exercise":"squats","goal":500}\n']]))
    await start($)
    expect((await send($)).drop).toContain('Start the day with a set: 50 squats')
    // 20 of a 50-rep set: short, but a real set.
    expect((await fit($, '20')).text).toContain('30 due · rest for 27m')
    expect((await send($)).drop).toBeUndefined()
  })

  test('strict: clearing the debt or resetting ends the breather, so the next set is not hidden', { options: { strict: true } }, async ($, on) => {
    const { clock, toasts } = world(on, new Map([[`${LOG}/2026-10-05.day`, day({ start: MONDAY_9AM - 2 * GAP + 60_000 })]]))
    await start($)
    expect((await fit($, '10')).text).toContain('rest for')
    await fit($, '10')
    await clock.advance(61_000)
    expect(toasts.some(t => t.includes('⏱ Set due: 10 pushups. 30/100 by now.'))).toBe(true)
    expect((await send($)).drop).toContain('10 pushups due now')
    expect((await fit($, '10')).text).not.toContain('rest for')
    await fit($, '10')
    expect((await send($)).drop).toBeUndefined()
    await fit($, 'reset')
    expect((await send($)).drop).toContain('30 pushups due now')
  })

  test('a breather is only for today', { options: { strict: true } }, async ($, on) => {
    world(on, new Map([[`${LOG}/2026-10-04.day`, day({ breather: MONDAY_9AM + HOUR })]]))
    await start($)
    expect((await send($)).drop).toContain('Start the day with a set: 10 pushups')
  })

  test('yesterday\'s start does not count today', { options: { strict: true } }, async ($, on) => {
    world(on, new Map([[`${LOG}/2026-10-04.day`, day({ start: MONDAY_9AM - 20 * HOUR })]]))
    await start($)
    expect((await send($)).drop).toContain('Start the day with a set: 10 pushups')
  })

  test('strict: /fit snooze puts the due set off, once per set and twice a day', { options: { strict: true } }, async ($, on) => {
    const { clock, toasts } = world(on, new Map([[`${LOG}/2026-10-05.day`, day({ start: MONDAY_9AM - GAP })]]))
    await start($)
    expect((await send($)).drop).toContain('/fit snooze 30 puts it off')
    expect((await fit($, 'snooze')).text).toContain('20 pushups put off until 09:30. 💪')
    // Prompts go through; the band says when the set is back; nothing is logged.
    expect((await send($)).drop).toBeUndefined()
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...BAND })
    expect(await ui.find({ type: 'Text', text: /0\/100 pushups  20 due · back at 09:30/ })).toBeDefined()
    await ui.unmount()
    // The same set can't be put off again, now or after the time is up.
    expect((await fit($, 'snooze 10')).text).toContain('Already put off until 09:30')
    await clock.advance(30 * 60_000 + 1_000)
    expect(toasts.some(t => t.includes('⏱ Set due: 20 pushups'))).toBe(true)
    expect((await send($)).drop).toContain('20 pushups due now')
    expect((await fit($, 'snooze')).text).toContain('already put off once')
    // A short set earns its breather as before; the next set due can be put off once more.
    expect((await fit($, '5')).text).toContain('rest for')
    await clock.advance(GAP)
    expect((await send($)).drop).toContain('pushups due now')
    expect((await fit($, 'snooze 15')).text).toContain('put off until')
    expect((await send($)).drop).toBeUndefined()
    // Twice a day is the limit.
    await clock.advance(15 * 60_000 + GAP)
    expect((await send($)).drop).toContain('pushups due now')
    expect((await fit($, 'snooze')).text).toContain("That's 2 put off today already")
  })

  test('strict: a rep or two during /fit snooze keeps the put-off', { options: { strict: true } }, async ($, on) => {
    const { clock } = world(on, new Map([[`${LOG}/2026-10-05.day`, day({ start: MONDAY_9AM - GAP })]]))
    await start($)
    await fit($, 'snooze 30')
    // 1 rep earns about 5m, short of the 30m put-off: the put-off stands, still marked.
    expect((await fit($, '1')).text).toContain('19 due · back at 09:30')
    await clock.advance(30 * 60_000 + 1_000)
    expect((await fit($, 'snooze')).text).toContain('already put off once')
  })

  test('strict: a full set during a longer /fit snooze keeps the hold but clears the put-off', { options: { strict: true } }, async ($, on) => {
    const { clock } = world(on, new Map([[`${LOG}/2026-10-05.day`, day({ start: MONDAY_9AM - GAP })]]))
    await start($)
    await fit($, 'snooze 30')
    // 5 reps earn the full 27m breather; the 30m hold stands, now as rest.
    expect((await fit($, '5')).text).toContain('15 due · rest for 30m')
    await clock.advance(30 * 60_000 + 1_000)
    // The set put off was logged, so the one due now can be put off.
    expect((await fit($, 'snooze 10')).text).toContain('put off until')
  })

  test('/fit snooze needs a set that is due', { options: { strict: true } }, async ($, on) => {
    world(on, new Map([[`${LOG}/2026-10-05`, '10\n'], [`${LOG}/2026-10-05.day`, day({ start: MONDAY_9AM - 60_000 })]]))
    await start($)
    expect((await fit($, 'snooze')).text).toContain('Nothing is due until')
    await fit($, 'set 100')
    expect((await fit($, 'snooze')).text).toContain("Today's goal is done")
  })

  test('/fit goal and /fit window keep a put-off; clearing the debt forgets it', { options: { strict: true } }, async ($, on) => {
    const { clock, files } = world(on, new Map([[`${LOG}/2026-10-05.day`, day({ start: MONDAY_9AM - GAP })]]))
    await start($)
    expect((await fit($, 'snooze')).text).toContain('20 pushups put off until 09:30')
    // The goal changes which set is due, not the time asked for: the band still says so.
    expect((await fit($, 'goal 60')).text).toContain('due · back at 09:30')
    expect((await send($)).drop).toBeUndefined()
    expect((await fit($, 'snooze')).text).toContain('Already put off until 09:30')
    // When the time is up, it's the new set that was put off, so it can't be put off again.
    await clock.advance(30 * 60_000 + 1_000)
    expect((await send($)).drop).toContain('pushups due now')
    expect((await fit($, 'snooze')).text).toContain('already put off once')
    // Clearing the debt forgets the set that was put off.
    await fit($, 'set 30')
    expect(JSON.parse(files.get(`${LOG}/2026-10-05.day`) ?? '{}')).not.toHaveProperty('putOff')
    // A fresh window's first set is due now, and is a set of its own: it can be put off.
    expect((await fit($, 'window 2')).text).toContain('due now')
    expect((await fit($, 'snooze 10')).text).toContain('put off until')
    // Without a put-off, a window change still ends an ordinary breather: two
    // sets in, a short set leaves reps owed and earns one.
    await clock.advance(34 * 60_000 + 1_000)
    expect((await fit($, '5')).text).toContain('rest for')
    expect((await fit($, 'window 1')).text).toContain('due now')
    expect((await send($)).drop).toContain('pushups due now')
  })

  test('a half-written day file is left alone until it is whole again', { options: { strict: true } }, async ($, on) => {
    const { clock, files, touch } = world(on, new Map([[`${LOG}/2026-10-05.day`, '{"start": 17']]))
    await start($)
    // Another session is mid-write: this one neither starts the day over nor holds the prompt.
    expect((await send($)).drop).toBeUndefined()
    expect(files.get(`${LOG}/2026-10-05.day`)).toBe('{"start": 17')
    // Nor does a set logged now write over it.
    await fit($, '10')
    expect(files.get(`${LOG}/2026-10-05.day`)).toBe('{"start": 17')
    // Whole again, the next poll reads it: the day started a gap ago, so a set is due.
    touch(`${LOG}/2026-10-05.day`, day({ start: MONDAY_9AM - GAP }))
    await clock.advance(10_000)
    expect((await send($)).drop).toContain('10 pushups due now')
  })

  test('strict: a breather earned in another session holds nothing here', { options: { strict: true } }, async ($, on) => {
    const { clock, touch } = world(on, new Map([[`${LOG}/2026-10-05.day`, day({ start: MONDAY_9AM - GAP })]]))
    await start($)
    expect((await send($)).drop).toContain('20 pushups due now')
    // The other session logs a set and earns its breather; this one sees both at its next poll.
    await clock.advance(1_000)
    touch(`${LOG}/2026-10-05`, '10\n')
    touch(`${LOG}/2026-10-05.day`, day({ start: MONDAY_9AM - GAP, breather: MONDAY_9AM + GAP / 2 }))
    await clock.advance(10_000)
    expect((await send($)).drop).toBeUndefined()
    expect((await fit($, '')).text).toContain('10 due · rest for')
  })
})

test('a 00:30 prompt never starts the day, so 9am is not a wall of overdue sets', { options: { strict: true } }, async ($, on) => {
  const { clock } = world(on, new Map(), { now: new Date(2026, 9, 5, 0, 30).getTime() })
  await start($)
  expect((await send($)).drop).toBeUndefined()
  await clock.set(new Date(2026, 9, 5, 9, 0).getTime())
  expect((await send($)).drop).toContain('Start the day with a set: 10 pushups')
})

test('the shell script catching you up is seen by the gate', { options: { strict: true } }, async ($, on) => {
  const { files } = world(on)
  await start($)
  expect((await send($)).drop).toContain('Start the day with a set')
  files.set(`${LOG}/2026-10-05`, '10\n')
  expect((await send($)).drop).toBeUndefined()
})

describe('streaks and today', () => {
  const daysBefore = (n: number) => {
    const files = new Map<string, string>([
      [`${HOME}/.claude/fitness/routine.json`, JSON.stringify(Object.fromEntries(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map(d => [d, { exercise: 'pushups', goal: 10 }])))],
    ])
    for (let i = 1; i <= n; i++) {
      const d = new Date(2026, 9, 5 - i, 12)
      files.set(`${LOG}/${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, '10\n')
    }
    return files
  }

  test('a streak longer than the 28-day grid keeps counting', async ($, on) => {
    world(on, daysBefore(40))
    await start($)
    expect((await fit($, '')).text).toContain('🔥40d')
    await fit($, '10')
    expect((await fit($, '')).text).toContain('🔥41d')
  })

  test('a partial day keeps the streak', async ($, on) => {
    world(on, new Map([[`${LOG}/2026-10-04`, '60\n']]))
    await start($)
    expect((await fit($, '')).text).toContain('🔥1d')
  })

  test('a missed day ends the streak', async ($, on) => {
    const files = daysBefore(40)
    files.delete(`${LOG}/2026-10-01`)
    world(on, files)
    await start($)
    expect((await fit($, '')).text).toContain('🔥3d')
  })

  test('the scoreboard marks today', async ($, on) => {
    world(on)
    await start($)
    await fit($, 'streak')
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...PANE })
    expect(await ui.find({ type: 'Text', text: /pushups  ◀ today/ })).toBeDefined()
    await ui.unmount()
  })

  test('the scoreboard opens closable with Esc, and Close closes it', async ($, on) => {
    const { open, calls } = world(on)
    await start($)
    await fit($, 'streak')
    expect(open.has('gym-week')).toBe(true)
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...PANE })
    await ui.press({ key: 'close' })
    expect(open.has('gym-week')).toBe(false)
    await ui.unmount()
    expect(calls).toContain('ui.open:gym-week')
  })
})

test('a long streak is cached, so later refreshes skip the walk back', async ($, on) => {
  const routine = JSON.stringify(Object.fromEntries(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map(d => [d, { exercise: 'pushups', goal: 10 }])))
  const files = new Map<string, string>([[`${HOME}/.claude/fitness/routine.json`, routine]])
  for (let i = 1; i <= 40; i++) {
    const d = new Date(2026, 9, 5 - i, 12)
    files.set(`${LOG}/${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, '10\n')
  }
  const { calls } = world(on, files)
  await start($)
  calls.length = 0
  expect((await fit($, '')).text).toContain('🔥40d')
  // The window's 28 days are re-read (three files each), plus today's own few;
  // nothing older is, which would be another 120.
  expect(calls.filter(c => c === 'fs.exists').length).toBeLessThan(28 * 3 + 12)
})

describe('progressive goals', () => {
  const ROUTINE = `${HOME}/.claude/fitness/routine.json`
  const routineOf = (files: Map<string, string>) => JSON.parse(files.get(ROUTINE) ?? '{}')
  const session = (count: number, goal = 100, isSkipped = false) => ({ date: 'd', count, goal, exercise: 'pushups', isSkipped })

  test('a hit steps up 5% in fives; two short sessions step back', async () => {
    expect(stepFor(100)).toBe(5)
    expect(stepFor(145)).toBe(5)
    expect(stepFor(150)).toBe(10)
    expect(stepFor(300)).toBe(15)
    expect(stepFor(20)).toBe(5)
    expect(nextGoal(100, [session(100)])).toBe(105)
    expect(nextGoal(100, [session(80)])).toBeUndefined()
    expect(nextGoal(100, [session(80), session(90)])).toBe(95)
    // Rest days and empty days are passed over, never counted as misses.
    expect(nextGoal(100, [session(0, 100, true), session(0), session(100)])).toBe(105)
    expect(nextGoal(100, [session(0), session(0)])).toBeUndefined()
    // A session at another goal (`/fit goal`, or one already counted) moves nothing.
    expect(nextGoal(100, [session(60, 60)])).toBeUndefined()
    expect(nextGoal(105, [session(100, 100)])).toBeUndefined()
    expect(nextGoal(110, [session(80, 110), session(90, 105)])).toBeUndefined()
    // At the floor, or under it from a custom goal, a step back never moves up.
    expect(nextGoal(5, [session(1, 5), session(2, 5)])).toBeUndefined()
    expect(nextGoal(3, [session(1, 3), session(2, 3)])).toBeUndefined()
    expect(nextGoal(10, [session(1, 10), session(2, 10)])).toBe(5)
    expect(parseFit('progress')).toEqual({ kind: 'progress', isOn: true })
    expect(parseFit('progress off')).toEqual({ kind: 'progress', isOn: false })
  })

  test('moving a goal leaves days a custom program set apart', async () => {
    const routine = { mon: { exercise: 'pushups', goal: 100 }, thu: { exercise: 'pushups', goal: 50 }, tue: { exercise: 'dips', goal: 100 } }
    expect(moveGoal(asRoutine(routine), 'pushups', 100, 105)).toEqual(asRoutine({ ...routine, mon: { exercise: 'pushups', goal: 105 } }))
  })

  test('an exercise with two goals in one routine stays put, and promises nothing', { options: { progress: true } }, async ($, on) => {
    const routine = { mon: { exercise: 'pushups', goal: 100 }, thu: { exercise: 'pushups', goal: 50 }, sun: { exercise: 'pushups', goal: 100 } }
    expect(canProgress(asRoutine(routine), 'pushups')).toBe(false)
    expect(canProgress(asRoutine({ mon: routine.mon, sun: routine.sun }), 'pushups')).toBe(true)
    const { files, toasts } = world(on, new Map([[ROUTINE, JSON.stringify(routine)], [`${LOG}/2026-10-04`, '100\n']]))
    await start($)
    expect(routineOf(files).mon.goal).toBe(100)
    await fit($, '100')
    expect(toasts.some(t => t.includes('Next pushups day'))).toBe(false)
  })

  test('off by default: a hit changes nothing', async ($, on) => {
    const { files } = world(on, new Map([[`${LOG}/2026-10-04`, '100\n']]))
    await start($)
    expect((await fit($, '')).text).toContain('0/100 pushups')
    expect(files.has(`${LOG}/2026-10-04.swap`)).toBe(false)
  })

  test('the last session hit: today goes up, the days before keep theirs', { options: { progress: true } }, async ($, on) => {
    // Sunday 2026-10-04 was the last pushups day; Saturday's squats stay out of it.
    const { files, toasts } = world(on, new Map([[`${LOG}/2026-10-04`, '100\n'], [`${LOG}/2026-10-03`, '300\n']]))
    await start($)
    expect((await fit($, '')).text).toContain('0/105 pushups')
    const routine = routineOf(files)
    expect([routine.mon.goal, routine.thu.goal, routine.sun.goal]).toEqual([105, 105, 105])
    expect(routine.sat).toEqual({ exercise: 'squats', goal: 300 })
    expect(JSON.parse(files.get(`${LOG}/2026-10-04.swap`) ?? '{}')).toEqual({ exercise: 'pushups', goal: 100 })
    expect(files.has(`${LOG}/2026-10-05.swap`)).toBe(false)
    expect(toasts.some(t => t.includes('pushups up to 105'))).toBe(true)
  })

  test('a second session the same day moves nothing again', { options: { progress: true } }, async ($, on) => {
    const { files } = world(on, new Map([[`${LOG}/2026-10-04`, '100\n']]))
    await start($)
    await start($)
    expect(routineOf(files).mon.goal).toBe(105)
    expect((await fit($, '')).text).toContain('0/105 pushups')
  })

  test('a rest day is passed over; the session before it counts', { options: { progress: true } }, async ($, on) => {
    const { files } = world(on, new Map([[`${LOG}/2026-10-04.skip`, ''], [`${LOG}/2026-10-01`, '100\n']]))
    await start($)
    expect(routineOf(files).mon.goal).toBe(105)
  })

  test('a day with its own goal moves nothing', { options: { progress: true } }, async ($, on) => {
    const { files } = world(on, new Map([[`${LOG}/2026-10-04`, '60\n'], [`${LOG}/2026-10-04.swap`, '{"exercise":"pushups","goal":60}\n']]))
    await start($)
    expect((await fit($, '')).text).toContain('0/100 pushups')
    expect(routineOf(files).mon.goal).toBe(100)
  })

  test('two short sessions in a row step back', { options: { progress: true } }, async ($, on) => {
    const { files, toasts } = world(on, new Map([[`${LOG}/2026-10-04`, '80\n'], [`${LOG}/2026-10-01`, '90\n']]))
    await start($)
    expect((await fit($, '')).text).toContain('0/95 pushups')
    expect(routineOf(files).thu.goal).toBe(95)
    expect(toasts.some(t => t.includes('back to 95'))).toBe(true)
  })

  test('days never trained are not misses', { options: { progress: true } }, async ($, on) => {
    world(on)
    await start($)
    expect((await fit($, '')).text).toContain('0/100 pushups')
  })

  test('a day swapped by hand keeps its plan', { options: { progress: true } }, async ($, on) => {
    const { files } = world(on, new Map([[`${LOG}/2026-10-04`, '100\n'], [`${LOG}/2026-10-05.swap`, '{"exercise":"dips","goal":100}\n']]))
    await start($)
    expect(routineOf(files).mon.goal).toBe(100)
  })

  test('hitting the goal says where the next session goes', { options: { progress: true } }, async ($, on) => {
    const { toasts } = world(on)
    await start($)
    await fit($, '100')
    expect(toasts.some(t => t.includes('Next pushups day: 105.'))).toBe(true)
  })

  test('a swap day promises the next session; a goal of its own does not', { options: { progress: true } }, async ($, on) => {
    const { toasts } = world(on)
    await start($)
    await fit($, 'swap dips')
    await fit($, '100')
    expect(toasts.some(t => t.includes('Next dips day: 105.'))).toBe(true)
    await fit($, 'goal 120')
    await fit($, '20')
    expect(toasts.some(t => t.includes('Next dips day: 125'))).toBe(false)
  })

  test('a /fit goal day at the routine goal counts like any other', { options: { progress: true } }, async ($, on) => {
    const { files } = world(on, new Map([[`${LOG}/2026-10-04`, '100\n'], [`${LOG}/2026-10-04.swap`, '{"exercise":"pushups","goal":100}\n']]))
    await start($)
    expect(routineOf(files).mon.goal).toBe(105)
  })

  test('/fit progress flips the setting', async ($, on) => {
    const { config } = world(on)
    await start($)
    expect((await fit($, 'progress')).text).toContain('Progressive goals on')
    expect(config.get('terminal-gym.progress')).toBe(true)
    await fit($, 'progress off')
    expect(config.get('terminal-gym.progress')).toBe(false)
  })
})

// A Raster's cells back as words: [codePoint, foreground, background] triplets.
const words = (cells: string) => new Uint32Array(Uint8Array.from(atob(cells), c => c.charCodeAt(0)).buffer)
const glyphRow = (grid: { columns: number; cells: string }, row: number) => {
  const all = words(grid.cells)
  return Array.from({ length: grid.columns }, (_, col) => String.fromCodePoint(all[(row * grid.columns + col) * 3] ?? 0x20)).join('')
}

const [GOLD, BLUE, PINK] = [0xb88a20, 0x2f9bdc, 0xd4608f]

const logged = (date: string, count: number, exercise = 'pushups', goal = 100, unit?: string) => ({
  date,
  count,
  goal,
  exercise,
  isSkipped: false,
  ...(unit === undefined ? {} : { unit }),
})

describe('scoreboard numbers', () => {
  test('totals add up each exercise, most reps first, and keep the best day', () => {
    const rows = exerciseTotals([
      logged('2026-09-01', 100),
      logged('2026-09-02', 300, 'squats', 300),
      logged('2026-09-04', 120),
      logged('2026-09-07', 120),
      logged('2026-09-08', 90, 'plank', 60, 's'),
    ])
    expect(rows.map(row => row.exercise)).toEqual(['pushups', 'squats', 'plank'])
    expect(rows[0]).toEqual({ exercise: 'pushups', unit: '', total: 340, days: 3, goalsHit: 3, best: 120, bestDate: '2026-09-04' })
    expect(rows[2]?.unit).toBe('s')
  })

  test('milestones are the next round number, past the ladder too', () => {
    expect(nextMilestone(0)).toBe(100)
    expect(nextMilestone(100)).toBe(250)
    expect(nextMilestone(9_999)).toBe(10_000)
    expect(nextMilestone(1_000_000)).toBe(2_000_000)
    expect(nextMilestone(2_345_678)).toBe(3_000_000)
  })

  test('numbers read with commas and their unit', () => {
    expect(commas(999)).toBe('999')
    expect(commas(1234567)).toBe('1,234,567')
    expect(amount(1200)).toBe('1,200 reps')
    expect(amount(1200, 's')).toBe('1,200s')
  })

  test('the best streak is the longest run, across months and rest days', () => {
    expect(bestStreak([])).toBe(0)
    expect(bestStreak([
      logged('2026-08-30', 5),
      logged('2026-08-31', 5),
      logged('2026-09-01', 5),
      logged('2026-09-03', 5),
    ])).toBe(3)
    expect(bestStreak([logged('2026-09-01', 5), { ...logged('2026-09-02', 5), isSkipped: true }, logged('2026-09-03', 5)])).toBe(1)
  })

  test('a range compares with the same span before it', () => {
    const ledger = [logged('2026-09-25', 100), logged('2026-09-28', 100), logged('2026-10-03', 150), logged('2026-10-05', 150, 'squats'), logged('2026-10-05', 80)]
    expect(rangeSummary(ledger, 'pushups', MONDAY_9AM, 7)).toEqual({ total: 230, sessions: 2, change: 15 })
    expect(rangeSummary(ledger, 'squats', MONDAY_9AM, 7).change).toBeUndefined()
    expect(changeText(15)).toBe('▲ 15%')
    expect(changeText(-8)).toBe('▼ 8%')
    expect(changeText(0)).toBe('= same')
    expect(changeText(undefined)).toBe('')
  })

  test('a bar a day while they fit, else whole weeks ending today', () => {
    expect(bucketDays(30, 40)).toBe(1)
    expect(bucketDays(90, 40)).toBe(7)
    expect(bucketDays(365, 40)).toBe(14)
    expect(bucketLabel(1)).toBe('a bar a day')
    expect(bucketLabel(7)).toBe('a bar a week')
    expect(bucketLabel(14)).toBe('a bar per 2 weeks')
  })

  test('exercises take colours by first day logged, and later ones share grey', () => {
    const colors = exerciseColors([
      logged('2026-09-01', 5, 'pushups'),
      logged('2026-09-02', 5, 'dips'),
      logged('2026-09-03', 5, 'pushups'),
      logged('2026-09-04', 5, 'squats'),
      logged('2026-09-05', 5, 'burpees'),
      logged('2026-09-06', 5, 'lunges'),
    ])
    expect(colors.get('pushups')).toBe(GOLD)
    expect(colors.get('dips')).toBe(BLUE)
    expect(colors.get('squats')).toBe(PINK)
    expect(colors.get('burpees')).toBe(colors.get('lunges'))
  })

  test('one chart: a bar holds its day, bright for a goal and faded when short', () => {
    const ledger = [logged('2026-10-03', 100, 'pushups'), logged('2026-10-04', 60, 'dips')]
    const bars = chartBars(ledger, exerciseColors(ledger), MONDAY_9AM, 3, 40)
    expect(bars).toEqual([
      { segments: [{ reps: 100, color: GOLD }] },
      { segments: [{ reps: 60, color: faded(BLUE) }] },
      { segments: [] },
    ])
  })

  test('a week bar stacks each exercise, split by goal hit and short', () => {
    const ledger = [logged('2026-10-05', 40, 'dips'), logged('2026-10-04', 100, 'pushups'), logged('2026-10-03', 100, 'dips'), logged('2026-09-28', 20, 'dips')]
    const colors = exerciseColors([...ledger].reverse())
    const bars = chartBars(ledger, colors, MONDAY_9AM, 14, 7)
    expect(bars.length).toBe(2)
    expect(bars[0]?.segments).toEqual([{ reps: 20, color: faded(GOLD) }])
    const stack = bars[1]?.segments ?? []
    // One exercise's parts stay together: dips, goal then short, then pushups.
    expect(stack).toEqual([{ reps: 100, color: GOLD }, { reps: 40, color: faded(GOLD) }, { reps: 100, color: BLUE }])
  })

  test('bars scale to the tallest, on five rows of eighths', () => {
    const grid = barCells([{ segments: [] }, { segments: [{ reps: 50, color: GOLD }] }, { segments: [{ reps: 100, color: BLUE }] }], 6)
    expect(grid.columns).toBe(5)
    expect(grid.rows).toBe(5)
    expect(glyphRow(grid, 0)).toBe('    █')
    expect(glyphRow(grid, 2)).toBe('  ▄ █')
    expect(glyphRow(grid, 4)).toBe('▁ █ █')
    // The empty day's tick is the dim one; the bar next to it wears its colour.
    expect(words(grid.cells)[(4 * 5 + 0) * 3 + 1]).toBe(0x343434)
    expect(words(grid.cells)[(4 * 5 + 2) * 3 + 1]).toBe(GOLD)
  })

  test('a stack meeting inside a cell draws one colour over the other', () => {
    const grid = barCells([{ segments: [{ reps: 3, color: GOLD }, { reps: 37, color: BLUE }] }], 1)
    expect([...words(grid.cells).subarray(4 * 3, 5 * 3)]).toEqual([0x2583, GOLD, BLUE])
    expect(glyphRow(grid, 0)).toBe('█')
  })

  test('a stack ending inside a cell stands as tall as one color would', () => {
    const lone = barCells([{ segments: [{ reps: 5, color: GOLD }] }, { segments: [{ reps: 40, color: GOLD }] }], 4)
    const stack = barCells([{ segments: [{ reps: 2, color: GOLD }, { reps: 3, color: BLUE }] }, { segments: [{ reps: 40, color: GOLD }] }], 4)
    expect(glyphRow(stack, 4)[0]).toBe(glyphRow(lone, 4)[0])
    const top = words(stack.cells).subarray(4 * stack.columns * 3, 4 * stack.columns * 3 + 3)
    expect([...top]).toEqual([0x2585, BLUE, 0x01000000])
  })

  test('where three colors meet in a cell, the lowest keeps its height', () => {
    const grid = barCells([{ segments: [{ reps: 12, color: GOLD }, { reps: 1, color: BLUE }, { reps: 9, color: PINK }, { reps: 18, color: GOLD }] }], 1)
    const row3 = words(grid.cells).subarray(3 * 3, 4 * 3)
    expect([...row3]).toEqual([0x2584, GOLD, PINK])
  })

  test('a tiny segment still shows beside a huge one', () => {
    const grid = barCells([{ segments: [{ reps: 1, color: GOLD }, { reps: 10000, color: BLUE }] }], 1)
    expect(words(grid.cells)[4 * 3 + 1]).toBe(GOLD)
  })

  test('bars touch when they only just fit, and the chart stays inside its width', () => {
    const bars = Array.from({ length: 30 }, () => ({ segments: [{ reps: 5, color: GOLD }] }))
    expect(chartWidth(30, 40)).toBe(30)
    expect(chartWidth(7, 40)).toBeLessThanOrEqual(40)
    expect(barCells(bars, 40).columns).toBe(30)
  })

  test('other surfaces get the same stacks as SVG', () => {
    const svg = barSvg([{ segments: [] }, { segments: [{ reps: 100, color: GOLD }] }])
    expect(svg).toContain('viewBox="0 0 20 80"')
    expect(svg).toContain('fill="#b88a20"')
  })

  test('the axis names the first day and today, or today alone when tight', () => {
    expect(axisText(7, MONDAY_9AM, 20)).toBe('09-29          today')
    expect(axisText(7, MONDAY_9AM, 8)).toBe('today')
  })

  test('the year grid ends this week and leaves later days blank', () => {
    // A Monday: Sunday and today are drawn, Tuesday on are blank.
    const ledger = [logged('2026-10-04', 100)]
    const grid = yearCells(ledger, exerciseColors(ledger), MONDAY_9AM, 40)
    expect(grid.columns).toBe(40)
    expect(grid.rows).toBe(4)
    const all = words(grid.cells)
    const lastColumn = (row: number) => all.subarray((row * 40 + 39) * 3, (row * 40 + 40) * 3)
    expect([...lastColumn(0)]).toEqual([0x2580, GOLD, 0x87af87])
    expect([...lastColumn(1)]).toEqual([0x20, 0x01000000, 0x01000000])
    expect(grid.months).toContain('Oct')
    expect(yearCells([], new Map(), MONDAY_9AM, 200).columns).toBe(53)
  })
})

describe('the scoreboard pane', () => {
  // A day each for three exercises, more than the 28-day grid reaches.
  const season = () => new Map([
    [`${HOME}/.claude/fitness/routine.json`, `${JSON.stringify({ mon: { exercise: 'pushups', goal: 100 }, tue: { exercise: 'plank', goal: 60, unit: 's' }, sat: { exercise: 'squats', goal: 300 } })}\n`],
    [`${LOG}/2026-01-05`, '1200\n'],
    [`${LOG}/2026-01-05.swap`, `${JSON.stringify({ exercise: 'squats', goal: 300 })}\n`],
    [`${LOG}/2026-10-03`, '300\n'],
    [`${LOG}/2026-10-05`, '40\n'],
    [`${LOG}/2026-10-05.day`, '{}\n'],
    [`${LOG}/2026-10-05.skip`, 'off\n'],
    [`${LOG}/2026-09-29`, '90\n'],
    [`${LOG}/not-a-day`, '9999\n'],
  ])
  const WIDE = { ...PANE, props: { ...PANE.props, bodyColumns: 70 } }

  test('all-time totals reach past the grid, with the next milestone and best day', async ($, on) => {
    world(on, season())
    await start($)
    await fit($, 'streak')
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...WIDE })
    // The plank's seconds stay out of the reps, and the stray file out of both.
    expect(await ui.find({ type: 'Text', text: /1,540 reps · 4 days trained · 3 goals hit/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '1,500' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /→ 2,500/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /best 1,200/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '90s' })).toBeDefined()
    await ui.unmount()
  })

  test('one chart holds every exercise, and the range buttons change it and stick', async ($, on) => {
    const { stored } = world(on, season())
    await start($)
    await fit($, 'streak')
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...WIDE })
    expect(await ui.find({ type: 'Text', text: /LAST 30 DAYS · a bar a day · peak 300/ })).toBeDefined()
    for (const key of ['chart', 'year']) expect(await ui.find({ type: 'Raster', key })).toBeDefined()
    for (const line of [/^300 reps · 1 session$/, /^40 reps · 1 session$/, /^90s · 1 session$/]) {
      expect(await ui.find({ type: 'Text', text: line })).toBeDefined()
    }
    await ui.press({ key: 'range-90' })
    expect(await ui.find({ type: 'Text', text: /LAST 90 DAYS · a bar a week/ })).toBeDefined()
    expect(stored.get('chartDays')).toBe(90)
    await ui.unmount()
  })

  test('a range press redraws at once and returns once the range is kept', async ($, on) => {
    let finishSave = () => {}
    const storeGate = new Promise<void>(resolve => {
      finishSave = resolve
    })
    const { stored } = world(on, season(), { storeGate })
    await start($)
    await fit($, 'streak')
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...WIDE })
    let hasReturned = false
    const press = ui.press({ key: 'range-90' }).then(() => {
      hasReturned = true
    })
    // The save is held: only the redraw can arrive. A few looks let it land.
    let redrawn = await ui.find({ type: 'Text', text: /LAST 90 DAYS/ })
    for (let look = 0; look < 50 && redrawn === undefined; look++) {
      redrawn = await ui.find({ type: 'Text', text: /LAST 90 DAYS/ })
    }
    expect(redrawn).toBeDefined()
    // Time for a press that didn't wait for the save to come back.
    for (let look = 0; look < 50; look++) await ui.find({ type: 'Text', text: /LAST 90 DAYS/ })
    expect(hasReturned).toBe(false)
    finishSave()
    await press
    expect(stored.get('chartDays')).toBe(90)
    await ui.unmount()
  })

  test('a new session opens on the range kept from the last', async ($, on) => {
    world(on, season(), { store: { chartDays: 90 } })
    await start($)
    await fit($, 'streak')
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...WIDE })
    expect(await ui.find({ type: 'Text', text: /LAST 90 DAYS/ })).toBeDefined()
    await ui.unmount()
  })

  test('/fit streak 90 opens a closed scoreboard on that range', async ($, on) => {
    const { open, calls } = world(on, season())
    await start($)
    await fit($, 'streak 90')
    expect(open.has('gym-week')).toBe(true)
    expect(calls).toContain('ui.open:gym-week')
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...WIDE })
    expect(await ui.find({ type: 'Text', text: /LAST 90 DAYS/ })).toBeDefined()
    await ui.unmount()
  })

  test('a pane past the widest Raster keeps the chart and its axis inside it', async ($, on) => {
    world(on, season())
    await start($)
    await fit($, 'streak 90')
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...PANE, props: { ...PANE.props, bodyColumns: 630 } })
    const chart = await ui.find({ type: 'Raster', key: 'chart' })
    expect(chart?.props.columns).toBe(449)
    // The axis spans the chart, not the pane.
    expect(await ui.find({ type: 'Text', text: /^.{444}today$/ })).toBeDefined()
    await ui.unmount()
  })

  test('/fit streak 90 picks the range and an open pane stays open', async ($, on) => {
    const { open } = world(on, season())
    await start($)
    await fit($, 'streak')
    const text = (await fit($, 'streak 90')).text
    expect(text).toContain('last 90 days')
    expect(open.has('gym-week')).toBe(true)
    expect((await fit($, 'streak nope')).text).toContain('2 to 365')
    expect((await fit($, 'streak 1')).text).toContain('2 to 365')
    expect(parseFit('streak 45d')).toEqual({ kind: 'week', days: 45 })
  })

  test('a range with no reps says so instead of drawing empty charts', async ($, on) => {
    world(on, new Map([[`${LOG}/2026-01-05`, '100\n']]))
    await start($)
    await fit($, 'streak')
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...WIDE })
    expect(await ui.find({ type: 'Text', text: 'No reps in the last 30 days.' })).toBeDefined()
    await ui.unmount()
  })

  test('with nothing logged it points at the first set', async ($, on) => {
    world(on)
    await start($)
    await fit($, 'streak')
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...PANE })
    expect(await ui.find({ type: 'Text', text: /fit 10 logs your first set/ })).toBeDefined()
    await ui.unmount()
  })

  test('a set logged while it is open moves the totals', async ($, on) => {
    world(on, season())
    await start($)
    await fit($, 'streak')
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...WIDE })
    await fit($, '10')
    expect(await ui.find({ type: 'Text', text: /1,550 reps/ })).toBeDefined()
    await ui.unmount()
  })

  test('remote surfaces get SVG charts and no year grid', async ($, on) => {
    world(on, season())
    await start($)
    await fit($, 'streak')
    for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
      const ui = await $.ui.mount({ plugin: 'terminal-gym', surface, ...WIDE })
      expect(await ui.find({ type: 'Svg' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /THE PAST YEAR/ })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('a narrow pane drops the meter and keeps the total', async ($, on) => {
    world(on, season())
    await start($)
    await fit($, 'streak')
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...PANE, props: { ...PANE.props, bodyColumns: 24 } })
    expect(await ui.find({ type: 'Text', text: '1,500' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /→/ })).toBeUndefined()
    await ui.unmount()
  })

  test('a new program freezes logged days past the grid, so totals keep their exercise', async ($, on) => {
    const { files } = world(on, new Map([[`${LOG}/2026-01-06`, '50\n']]))
    await start($)
    await fit($, 'program')
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...PANE, requestId: 'gym-onboard' })
    await ui.press({ key: 'next' })
    await ui.press({ key: 'program-1' })
    await ui.press({ key: 'next' })
    await ui.press({ key: 'finish' })
    await ui.unmount()
    // A Tuesday under the default rotation.
    expect(files.get(`${LOG}/2026-01-06.swap`)).toBe(`${JSON.stringify({ exercise: 'dips', goal: 100 })}\n`)
  })
  // Walks the walkthrough to the first preset program.
  const pickProgram = async ($: Engine) => {
    await fit($, 'program')
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...PANE, requestId: 'gym-onboard' })
    await ui.press({ key: 'next' })
    await ui.press({ key: 'program-1' })
    await ui.press({ key: 'next' })
    await ui.press({ key: 'finish' })
    await ui.unmount()
  }

  test('a new program leaves today alone, so today follows it', async ($, on) => {
    const { files } = world(on, new Map([[`${LOG}/2026-10-05`, '40\n']]))
    await start($)
    await pickProgram($)
    expect(files.has(`${LOG}/2026-10-05.swap`)).toBe(false)
  })

  test('a logged day the old routine left out keeps reading as it did', async ($, on) => {
    const { files } = world(on, new Map([
      [`${HOME}/.claude/fitness/routine.json`, `${JSON.stringify({ mon: { exercise: 'dips', goal: 50 } })}\n`],
      // Sundays, one outside the grid and one in it, with no plan in that routine.
      [`${LOG}/2026-01-04`, '50\n'],
      [`${LOG}/2026-10-04`, '60\n'],
    ]))
    await start($)
    await pickProgram($)
    for (const date of ['2026-01-04', '2026-10-04']) {
      expect(files.get(`${LOG}/${date}.swap`)).toBe(`${JSON.stringify({ exercise: 'reps', goal: 0 })}\n`)
    }
    // An unlogged day in the grid stays unwritten, as before.
    expect(files.has(`${LOG}/2026-10-03.swap`)).toBe(false)
  })
})

describe('multi days', () => {
  const ROUTINE = `${HOME}/.claude/fitness/routine.json`
  const TODAY_LOG = `${LOG}/2026-10-05`
  const ARMS = {
    name: 'Arms day',
    exercises: [{ exercise: 'dips', goal: 100 }, { exercise: 'pushups', goal: 50 }, { exercise: 'plank', goal: 180, unit: 's' }],
  }
  const WEEK = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
  // Monday the 5th, today, is an arms day; Tuesday stays a single day.
  const armsMonday = (more: [string, string][] = []) =>
    new Map<string, string>([[ROUTINE, JSON.stringify({ mon: ARMS, tue: { exercise: 'dips', goal: 100 } })], ...more])
  const armsDaily = (more: [string, string][] = []) =>
    new Map<string, string>([[ROUTINE, JSON.stringify(Object.fromEntries(WEEK.map(d => [d, ARMS])))], ...more])
  // Paths keyed with slashes, so these run on Windows too.
  const multiWorld = (on: On, files: Map<string, string>) => world(on, files, { slashes: true })
  const dayState = (files: Map<string, string>) => JSON.parse(files.get(`${TODAY_LOG}.day`) ?? '{}')

  test('routine.json reads both forms and writes each back as it came', () => {
    const raw = {
      mon: ARMS,
      tue: { exercise: 'dips', goal: 100 },
      wed: { exercises: [{ exercise: 'squats', goal: 300 }, { exercise: 'lunges', goal: 60 }] },
    }
    const { routine, dropped } = parseRoutine(raw)
    expect(dropped).toEqual([])
    expect(routine.mon).toEqual({ isMulti: true, name: 'Arms day', plans: ARMS.exercises })
    expect(routine.tue).toEqual({ plans: [{ exercise: 'dips', goal: 100 }] })
    expect(routineToFile(routine)).toEqual(raw)
    // A list of one stays a list, and a plan's own fields stay with it.
    const kept = { thu: { exercises: [{ exercise: 'plank', goal: 60, unit: 's' }] }, fri: { exercise: 'dips', goal: 100, note: 'slow' } }
    expect(routineToFile(parseRoutine(kept).routine)).toEqual(kept)
    expect(parseRoutine({ sat: { exercises: [{ exercise: ' dips ', goal: 10 }] } }).routine.sat?.plans[0]?.exercise).toBe('dips')
  })

  test('the routine helpers work across single and multi days', () => {
    const routine = asRoutine({ mon: ARMS, tue: { exercise: 'dips', goal: 80 } })
    expect(exerciseGoals(routine)).toEqual({ dips: 100, pushups: 50, plank: 180 })
    expect(describeRoutine(routine)).toBe('100 dips / 50 pushups / 180s plank / 80 dips')
    const halved = scale(routine, 0.5)
    expect(halved.mon).toEqual({ isMulti: true, name: 'Arms day', plans: [{ exercise: 'dips', goal: 50 }, { exercise: 'pushups', goal: 25 }, { exercise: 'plank', goal: 90, unit: 's' }] })
    // A goal left at its prefill keeps the days that differ; a typed one sets the exercise everywhere.
    const custom = customRoutine(routine, { dips: '100', pushups: '60', plank: '180' })
    expect(custom?.mon?.plans.map(plan => plan.goal)).toEqual([100, 60, 180])
    expect(custom?.tue?.plans[0]?.goal).toBe(80)
    expect(moveGoal(routine, 'pushups', 50, 55).mon?.plans[1]?.goal).toBe(55)
    expect(canProgress(routine, 'dips')).toBe(false)
    // A bare swap moves day by day: from Tuesday's dips to the arms day.
    expect(pickSwap(routine, { plans: [{ exercise: 'dips', goal: 80 }] })).toEqual({ kind: 'day', day: routine.mon })
  })

  test('bad, repeated and extra entries are left out, each named', () => {
    const { routine, dropped } = parseRoutine({
      mon: {
        name: 'Big',
        exercises: [
          { exercise: 'dips', goal: 100 },
          { goal: 10 },
          { exercise: 'plank', goal: 0 },
          { exercise: 'DIPS', goal: 50 },
          ...['a', 'b', 'c', 'd', 'e'].map(exercise => ({ exercise, goal: 1 })),
          'junk',
        ],
      },
      tue: { exercises: [] },
      wed: { exercises: [{ exercise: 'x', goal: -5 }] },
      thu: { exercises: 'dips' },
    })
    expect(routine.mon?.plans.map(plan => plan.exercise)).toEqual(['dips', 'a', 'b', 'c', 'd'])
    // An empty list, or none left, is no plan.
    expect([routine.tue, routine.wed, routine.thu]).toEqual([undefined, undefined, undefined])
    expect(dropped).toEqual([
      'mon #2 (no name)',
      'mon plank (goal must be above 0)',
      'mon DIPS (listed twice)',
      'mon e (over 5 exercises)',
      'mon #10 (no name)',
      'wed x (goal must be above 0)',
      'thu (exercises is not a list)',
    ])
  })

  test('a day list is read only so far, and the toast names the first few left out, then counts the rest', () => {
    const many = Array.from({ length: 1000 }, (_, i) => ({ exercise: `x${i}`, goal: 0 }))
    const raw = { mon: { exercises: [{ exercise: 'dips', goal: 100 }, ...many] } }
    const { routine, dropped } = parseRoutine(raw)
    expect(routine.mon?.plans.map(plan => plan.exercise)).toEqual(['dips'])
    // 49 entries read and left out, then one line for the 951 never read.
    expect(dropped.length).toBe(50)
    expect(dropped.at(-1)).toBe('mon (951 more entries past the first 50, not read)')
    const firstFive = [0, 1, 2, 3, 4].map(i => `mon x${i} (goal must be above 0)`).join(', ')
    expect(droppedText(dropped)).toBe(`routine.json: left out ${firstFive} and 45 more.`)
    expect(droppedText(dropped.slice(0, 2))).toBe('routine.json: left out mon x0 (goal must be above 0), mon x1 (goal must be above 0).')
    // A retyped day keeps every entry the reader left out, read or not.
    const typed = customDays(routine, { mon: '120 dips, 10 squats' })
    expect('routine' in typed).toBe(true)
    if (!('routine' in typed)) return
    const written = daysOverFile(raw, typed.routine, routine) as { mon: { exercises: unknown[] } }
    expect(written.mon.exercises).toEqual([{ exercise: 'dips', goal: 120 }, { exercise: 'squats', goal: 10 }, ...many])
  })

  test('names lose bidi controls and zero-width characters too', () => {
    const { routine, dropped } = parseRoutine({
      mon: { name: '⁦Arms⁩ day﻿', exercises: [{ exercise: 'di‮ps​', goal: 100 }, { exercise: 'x‏', goal: 0 }] },
      tue: { exercise: '⁠squats‍', goal: 300 },
    })
    expect(routine.mon).toEqual({ isMulti: true, name: 'Arms day', plans: [{ exercise: 'dips', goal: 100 }] })
    expect(routine.tue?.plans[0]?.exercise).toBe('squats')
    expect(dropped).toEqual(['mon x (goal must be above 0)'])
  })

  test('an exercise is one exercise in any case or spacing: its plans, the last log, progress and the scoreboard', () => {
    const routine = asRoutine({ mon: { exercise: ' Dips ', goal: 100 }, tue: { name: 'Arms', exercises: [{ exercise: 'dips', goal: 100 }, { exercise: 'plank', goal: 60, unit: 's' }] } })
    expect(routine.mon?.plans[0]?.exercise).toBe('Dips')
    expect(exerciseGoals(routine)).toEqual({ Dips: 100, plank: 60 })
    expect(customRoutine(routine, { Dips: '120', plank: '60' })?.tue?.plans[0]?.goal).toBe(120)
    expect(canProgress(asRoutine({ mon: { exercise: 'Dips', goal: 100 }, tue: { exercise: 'dips', goal: 80 } }), 'dips')).toBe(false)
    expect(progressesAt(routine, 'DIPS', 100)).toBe(true)
    const moved = moveGoal(routine, 'dips', 100, 105)
    expect([moved.mon?.plans[0]?.goal, moved.tue?.plans[0]?.goal]).toEqual([105, 105])
    expect(logTarget([{ exercise: 'dips' }, { exercise: 'plank' }], 'Plank')).toBe(1)
    const ledger = [logged('2026-10-03', 100, 'Dips'), logged('2026-10-04', 50, 'dips')]
    expect(exerciseTotals(ledger).map(row => [row.exercise, row.total, row.days])).toEqual([['Dips', 150, 2]])
    const colors = exerciseColors(ledger)
    expect([...colors.keys()]).toEqual(['Dips'])
    expect(rangeSummary(ledger, 'dips', MONDAY_9AM, 7).total).toBe(150)
    expect(chartBars(ledger, colors, MONDAY_9AM, 3, 40)).toEqual([
      { segments: [{ reps: 100, color: GOLD }] },
      { segments: [{ reps: 50, color: faded(GOLD) }] },
      { segments: [] },
    ])
  })

  test('one toast a conversation names what the routine left out, and the mod carries on', async ($, on) => {
    const { toasts, session } = multiWorld(on, new Map([[ROUTINE, JSON.stringify({ mon: { name: 'Arms day', exercises: [{ exercise: 'dips', goal: 100 }, { exercise: 'Dips', goal: 5 }, { exercise: 'plank' }] } })]]))
    // Its own conversation: the toast's once-per-conversation mark starts clear whatever ran before.
    session.id = 'left-out'
    await start($)
    await fit($, '')
    expect((await fit($, '10')).text).toContain('10/100 dips')
    const text = 'routine.json: left out mon Dips (listed twice), mon plank (goal must be above 0).'
    expect(toasts.filter(t => t.startsWith('routine.json'))).toEqual([text])
    // Another conversation (/clear) hears it once more.
    session.id = 'after-clear'
    await send($)
    expect(toasts.filter(t => t.startsWith('routine.json'))).toEqual([text, text])
  })

  test('a day log is a plain count on a single day and a count per exercise on a multi day', () => {
    expect(parseDayLog('40\n', ['pushups'])).toEqual([40])
    expect(parseDayLog(undefined, ['dips', 'plank'])).toEqual([0, 0])
    expect(parseDayLog('30\n', ['dips', 'plank'])).toEqual([30, 0])
    expect(parseDayLog('{"dips":40,"plank":20}\n', ['dips', 'pushups', 'plank'])).toEqual([40, 0, 20])
    expect(parseDayLog('{"dips":40,"plank":20}\n', ['plank'])).toEqual([20])
    expect(parseDayLog('{"dips":40}\n', ['squats'])).toEqual([40])
    expect(parseDayLog('{"dips', ['dips'])).toEqual([0])
    expect(formatDayLog([{ exercise: 'pushups', count: 40 }], false)).toBe('40\n')
    expect(formatDayLog([{ exercise: 'dips', count: 40 }, { exercise: 'pushups', count: 20 }, { exercise: 'plank', count: 0 }], true))
      .toBe('{"dips":40,"pushups":20,"plank":0}\n')
  })

  test('a plain count on a day that is now multi counts for its first exercise', async ($, on) => {
    multiWorld(on, armsMonday([[TODAY_LOG, '30\n']]))
    await start($)
    const text = (await fit($, '')).text
    expect(text).toContain('🏋 Arms day')
    expect(text).toContain('30/100 dips')
    expect(text).toContain('0/50 pushups')
    expect(text).toContain('0/180s plank')
  })

  test('a + press logs to its row, and a bare /fit follows the last log', async ($, on) => {
    const { files, toasts } = multiWorld(on, armsMonday())
    await start($)
    // Nothing logged yet: the first exercise.
    expect((await fit($, '20')).text).toContain('20/100 dips · 80 to go')
    expect(files.get(TODAY_LOG)).toBe('{"dips":20,"pushups":0,"plank":0}\n')
    expect(dayState(files).last).toBe('dips')

    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...BAND })
    await ui.press({ key: 'pushups+5' })
    expect(files.get(TODAY_LOG)).toBe('{"dips":20,"pushups":5,"plank":0}\n')
    expect(dayState(files).last).toBe('pushups')
    await ui.unmount()

    toasts.length = 0
    expect((await fit($, '10')).text).toContain('15/50 pushups · 35 to go')
    expect(toasts.some(t => t.startsWith('💪 +10 pushups.') && t.endsWith('35 to go.'))).toBe(true)
    // Past the goal still counts.
    expect((await fit($, '40')).text).toContain('55/50 pushups · done')
    // A lower count names its exercise too.
    await fit($, 'set 30')
    expect(toasts).toContain('pushups back to 30. 20 to go.')
  })

  test('a log that leaves a count as it was still names the exercise and what is left', async ($, on) => {
    const { toasts } = multiWorld(on, armsMonday([[TODAY_LOG, '{"dips":20,"pushups":50,"plank":0}\n']]))
    await start($)
    await fit($, '0')
    expect(toasts).toContain('dips stays at 20. 80 to go.')
    await fit($, 'set 50 pushups')
    expect(toasts).toContain('pushups stays at 50. Done.')
  })

  test('a damaged multi log is never written over by a log, and /fit reset is the way out', async ($, on) => {
    const { files, toasts } = multiWorld(on, armsMonday([[TODAY_LOG, '{"dips":40,"pus']]))
    await start($)
    const refused = "Couldn't read today's log, so nothing was logged. If it stays this way, /fit reset starts today over at 0."
    // The reply says so too, with no count line that reads like a set logged.
    expect((await fit($, '10')).text).toBe(refused)
    expect(files.get(TODAY_LOG)).toBe('{"dips":40,"pus')
    expect(toasts).toContain(refused)
    // Still damaged on reset's own second read: written over on purpose, and logging works again.
    expect((await fit($, 'reset')).text).toContain('0/100 dips')
    expect(files.get(TODAY_LOG)).toBe('{"dips":0,"pushups":0,"plank":0}\n')
    expect((await fit($, '10')).text).toContain('10/100 dips')
  })

  test('/fit reset over a damaged single-day log writes it over too', async ($, on) => {
    const { files } = multiWorld(on, new Map([[TODAY_LOG, '{"pushups":4']]))
    await start($)
    await fit($, '10')
    expect(files.get(TODAY_LOG)).toBe('{"pushups":4')
    await fit($, 'reset')
    expect(files.get(TODAY_LOG)).toBe('0\n')
  })

  test('a log half-written when first read is read once more, so its counts show', async ($, on) => {
    // Today's log reads half-written once, the way another session's landing write would.
    const files = new (class extends Map<string, string> {
      isHalf = false
      override get(path: string) {
        if (this.isHalf && path === TODAY_LOG) {
          this.isHalf = false
          return '{"dips":40,"pu'
        }
        return super.get(path)
      }
    })(armsMonday([[TODAY_LOG, '{"dips":40,"pushups":0,"plank":0}\n']]))
    multiWorld(on, files)
    await start($)
    files.isHalf = true
    expect((await fit($, '')).text).toContain('40/100 dips')
    expect(files.isHalf).toBe(false)
  })

  test('a press for an exercise no longer on the plan logs nothing', async ($, on) => {
    const { files, toasts } = multiWorld(on, armsMonday())
    await start($)
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...BAND })
    files.set(ROUTINE, JSON.stringify({ mon: { name: 'Arms day', exercises: ARMS.exercises.slice(0, 2) } }))
    await ui.press({ key: 'plank+20' })
    await ui.unmount()
    expect(toasts).toContain("plank isn't on today's plan any more.")
    expect(files.has(TODAY_LOG)).toBe(false)
  })

  test('each log toasts its exercise and what is left of it', async ($, on) => {
    const { toasts } = multiWorld(on, armsMonday([[TODAY_LOG, '{"dips":90,"pushups":50,"plank":0}\n']]))
    await start($)
    await fit($, '10')
    expect(toasts).toContain('✅ dips done: 100/100. Still to go: 180s plank.')
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...BAND })
    await ui.press({ key: 'plank+20' })
    expect(toasts.some(t => t.startsWith('💪 +20s plank.') && t.endsWith('160s to go.'))).toBe(true)
    await ui.unmount()
    await fit($, 'set 180')
    expect(toasts.some(t => t.startsWith('✅ Arms day done: 100/100 dips, 50/50 pushups, 180/180s plank.'))).toBe(true)
  })

  test('the band: a status row, then a row per exercise with buttons from its own goal', async ($, on) => {
    const { files } = multiWorld(on, armsMonday([
      [TODAY_LOG, '{"dips":100,"pushups":10,"plank":0}\n'],
      // Sunday, a day with no plan, trained: the streak runs into today.
      [`${LOG}/2026-10-04`, '10\n'],
    ]))
    await start($)
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...BAND })
    expect(await ui.find({ type: 'Text', text: /^🏋 Arms day {2}🔥2d$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^✅ ▓{10} 100\/100 dips/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /10\/50 pushups/ })).toBeDefined()
    // A finished exercise has no buttons; the others step from their own goals.
    for (const key of ['dips+5', 'dips+10', 'dips+20', 'add5', 'add10']) expect(await ui.find({ key })).toBeUndefined()
    for (const key of ['pushups+3', 'pushups+5', 'pushups+10', 'plank+5', 'plank+15', 'plank+20']) expect(await ui.find({ key })).toBeDefined()
    expect((await ui.find({ key: 'plank+20' }))?.props.label).toBe('+20s')
    await ui.press({ key: 'plank+20' })
    expect(files.get(TODAY_LOG)).toBe('{"dips":100,"pushups":10,"plank":20}\n')
    await ui.unmount()
  })

  test('the band stops at six rows: a status row and five exercises', async ($, on) => {
    const seven = ['dips', 'pushups', 'squats', 'lunges', 'burpees', 'situps', 'plank'].map(exercise => ({ exercise, goal: 50 }))
    multiWorld(on, new Map([[ROUTINE, JSON.stringify({ mon: { name: 'Full body', exercises: seven } })]]))
    await start($)
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...BAND })
    expect(await ui.find({ type: 'Text', text: /^🏋 Full body/ })).toBeDefined()
    for (const { exercise } of seven.slice(0, 5)) expect(await ui.find({ key: `row-${exercise}` })).toBeDefined()
    for (const { exercise } of seven.slice(5)) expect(await ui.find({ key: `row-${exercise}` })).toBeUndefined()
    await ui.unmount()
  })

  test('the streak, the scoreboard and its grids count a multi date once', async ($, on) => {
    multiWorld(on, armsDaily([
      [`${LOG}/2026-10-04`, '{"dips":100,"pushups":50,"plank":180}\n'],
      [`${LOG}/2026-10-03`, '{"dips":10}\n'],
    ]))
    await start($)
    expect((await fit($, '')).text).toContain('🔥2d')
    await fit($, 'streak')
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...PANE, props: { ...PANE.props, bodyColumns: 70 } })
    expect(await ui.find({ type: 'Text', text: /2-day streak/ })).toBeDefined()
    // Totals and goals count each exercise; days trained count dates.
    expect(await ui.find({ type: 'Text', text: /160 reps · 2 days trained · 3 goals hit/ })).toBeDefined()
    expect((await ui.find({ key: 'total-plank' }))?.text).toMatch(/plank\s+180s/)
    await ui.unmount()
  })

  test('a multi date is hit only when every exercise hit, and counts once', () => {
    const arms = (date: string, dips: number, plank: number) => [logged(date, dips, 'dips', 100), logged(date, plank, 'plank', 60, 's')]
    // An empty today forgives; yesterday counts once, not once per exercise.
    expect(streak([...arms('2026-10-04', 100, 0), ...arms('2026-10-05', 0, 0)])).toBe(1)
    expect(bestStreak([...arms('2026-10-01', 10, 0), ...arms('2026-10-02', 0, 5), ...arms('2026-10-04', 5, 5)])).toBe(2)
    const heat = (days: ReturnType<typeof arms>) => words(heatCells(days).cells)[1]
    expect(heat(arms('2026-10-04', 100, 60))).toBe(0xc8a86b)
    expect(heat(arms('2026-10-04', 100, 30))).toBe(0x6b5d3f)
    // Sunday the 4th tops this week's column; Monday below it is today.
    const year = (ledger: ReturnType<typeof arms>) => words(yearCells(ledger, exerciseColors(ledger), MONDAY_9AM, 1).cells)[1]
    expect(year(arms('2026-10-04', 100, 60))).toBe(GOLD)
    expect(year(arms('2026-10-04', 100, 30))).toBe(faded(GOLD))
    // An untouched exercise is no session of it.
    expect(exerciseTotals(arms('2026-10-04', 100, 0)).map(row => row.exercise)).toEqual(['dips'])
  })

  describe('strict on a multi day', () => {
    const HOUR = 60 * 60_000
    const GAP = (8 * HOUR) / 9 // the gap between sets in the default window
    // The spec's demo day.
    const PAIR = { name: 'arms', exercises: [{ exercise: 'dips', goal: 100 }, { exercise: 'plank', goal: 180, unit: 's' }] }
    const pairWorld = (on: On, more: [string, string][] = []) =>
      multiWorld(on, new Map<string, string>([[ROUTINE, JSON.stringify({ mon: PAIR })], ...more]))
    const startedAt = (start: number): [string, string] => [`${TODAY_LOG}.day`, day({ start })]

    test('the day is paced by its capped average share, as sets of 10%', () => {
      const pair = (dips: number, plank: number) => [{ exercise: 'dips', count: dips, goal: 100 }, { exercise: 'plank', count: plank, goal: 180 }]
      expect(dayShare(pair(10, 18))).toBe(10)
      expect(dayShare(pair(200, 0))).toBe(50)
      expect(dayShare(pair(5, 0))).toBe(2)
      expect(dayShare(pair(100, 180))).toBe(100)
      expect(dayShare([10, 5, 18].map((count, i) => ({ count, goal: [100, 50, 180][i] ?? 1 })))).toBe(10)
      expect(paceScale({ isMulti: true, exercises: pair(30, 90) }, 15)).toEqual({ goal: 100, count: 40, setSize: 10 })
      expect(paceScale({ isMulti: false, exercises: [{ count: 40, goal: 100 }] }, 0)).toEqual({ goal: 100, count: 40, setSize: 10 })
      expect(paceScale({ isMulti: false, exercises: [{ count: 40, goal: 100 }] }, 15)?.setSize).toBe(15)
      const ideas = (dips: number, plank: number, last?: string) => setIdeas(pair(dips, plank), last).map(e => `${e.amount} ${e.exercise}`)
      // Each idea alone covers a tenth of the day: on n exercises, n tenths of its goal.
      expect(ideas(0, 0)).toEqual(['20 dips', '36 plank'])
      expect(ideas(0, 0, 'plank')).toEqual(['36 plank', '20 dips'])
      expect(dayShare(pair(20, 0))).toBe(10)
      expect(dayShare(pair(0, 36))).toBe(10)
      // A finished exercise is never suggested, and a set is never more than what is left.
      expect(ideas(100, 170, 'dips')).toEqual(['10 plank'])
      // A day of more exercises suggests more tenths of each.
      const trio = setIdeas([{ exercise: 'dips', count: 0, goal: 100 }, { exercise: 'pushups', count: 0, goal: 50 }, { exercise: 'plank', count: 0, goal: 180 }], undefined)
      expect(trio.map(e => e.amount)).toEqual([30, 15, 54])
    })

    test('a prompt is held while the share is behind and goes through once it catches up', { options: { strict: true } }, async ($, on) => {
      const { clock, toasts } = pairWorld(on)
      await start($)
      expect((await send($)).drop).toBe('Start the day with a set: 10% of arms, e.g. 20 dips or 36s plank. /fit 20 dips to log it, then send your prompt. /fit rest skips the day (breaks streak).')
      const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...BAND })
      expect(await ui.find({ type: 'Text', text: /🏋 arms  🏁 first set: 10% to start the day/ })).toBeDefined()
      await ui.unmount()
      await fit($, '20')
      expect((await send($)).drop).toBeUndefined()
      expect((await fit($, '')).text).toContain('next set in 54m')
      await clock.advance(GAP + 1_000)
      expect(toasts).toContain('⏱ Set due: 10% of arms, e.g. 20 dips or 36s plank. 20/100% by now.')
      expect((await send($)).drop).toBe('Set due: 10% of arms, e.g. 20 dips or 36s plank (20/100% by now). /fit 20 dips to log it, then send your prompt. /fit snooze 30 puts it off; /fit easy stops holding prompts.')
      // Enough dips to cover the share due: caught up, with no breather needed.
      await fit($, '20')
      expect((await fit($, '')).text).not.toContain('due')
      expect((await send($)).drop).toBeUndefined()
    })

    test('extra reps past one goal never release a hold another exercise owes', { options: { strict: true } }, async ($, on) => {
      const { toasts } = pairWorld(on, [[TODAY_LOG, '{"dips":100,"plank":0}\n'], startedAt(MONDAY_9AM - 8 * HOUR)])
      await start($)
      const held = (await send($)).drop
      // A bare /fit would log to dips, so the hold names the plank.
      expect(held).toContain('Set due: 50% of arms, e.g. 36s plank (100/100% by now). /fit 36 plank to log it')
      await fit($, '50')
      expect((await fit($, '')).text).not.toContain('rest for')
      expect((await send($)).drop).toContain('Set due: 50% of arms')
      expect(toasts.some(t => t.includes('150/100'))).toBe(true)
      // The command the hold names logs the plank, and earns a breather.
      expect((await fit($, '36 plank')).text).toContain('36/180s plank')
      expect((await send($)).drop).toBeUndefined()
    })

    test('a set earns a breather on the percent scale, a short one a shorter breather', { options: { strict: true } }, async ($, on) => {
      const { clock, toasts } = pairWorld(on, [startedAt(MONDAY_9AM - GAP)])
      await start($)
      expect((await send($)).drop).toContain('Set due: 20% of arms')
      // Short of the dips row's smallest button: its share of the breather.
      expect((await fit($, '4')).text).toContain('18% due · rest for 22m')
      expect((await send($)).drop).toBeUndefined()
      // A full button or more: the whole breather, from now.
      expect((await fit($, '10')).text).toContain('13% due · rest for 27m')
      await clock.advance(GAP / 2 + 1_000)
      expect(toasts).toContain('⏱ Set due: 13% of arms, e.g. 20 dips or 36s plank. 20/100% by now.')
      expect((await send($)).drop).toContain('Set due: 13% of arms')
    })

    test('the suggested set of one exercise earns the whole breather on a longer day too', { options: { strict: true } }, async ($, on) => {
      multiWorld(on, armsMonday([startedAt(MONDAY_9AM - GAP)]))
      await start($)
      expect((await send($)).drop).toContain('Set due: 20% of Arms day, e.g. 30 dips or 15 pushups or 54s plank')
      // The suggested dips: a tenth of the day, and the whole breather.
      expect((await fit($, '30')).text).toContain('10% due · rest for 27m')
    })

    test('a suggested set smaller than its row\'s smallest button still earns the whole breather', { options: { strict: true } }, async ($, on) => {
      const SHORT = { name: 'short', exercises: [{ exercise: 'squats', goal: 10 }, { exercise: 'dips', goal: 100 }] }
      multiWorld(on, new Map([[ROUTINE, JSON.stringify({ mon: SHORT })], startedAt(MONDAY_9AM - GAP)]))
      await start($)
      // The squats' suggested set is under the squats row's smallest button.
      expect((await send($)).drop).toContain('Set due: 20% of short, e.g. 2 squats or 20 dips')
      expect((await fit($, '2 squats')).text).toContain('10% due · rest for 27m')
    })

    test('an opener put off comes back as a toast naming the day by its exercises', { options: { strict: true } }, async ($, on) => {
      const { clock, toasts } = multiWorld(on, new Map([[ROUTINE, JSON.stringify({ mon: { exercises: PAIR.exercises } })]]))
      await start($)
      expect((await send($)).drop).toContain('Start the day with a set: 10% of dips · plank, e.g. 20 dips or 36s plank.')
      expect((await fit($, 'snooze')).text).toContain('10% of dips · plank put off until 09:30.')
      await clock.advance(30 * 60_000 + 1_000)
      expect(toasts).toContain('🏁 First set to start the day: 10% of dips · plank, e.g. 20 dips or 36s plank.')
    })

    test('easy mode paces a multi day too: nothing held, a nudge only when behind, sized by the exercise', async ($, on) => {
      const { clock, toasts } = pairWorld(on)
      await start($)
      expect((await send($)).drop).toBeUndefined()
      await $.turn.start({ text: 'go', turnId: 't1' })
      await clock.advance(31_000)
      expect(toasts).toContain("Your agent's mid-set. You next: 10 dips.")
      await fit($, '20')
      await $.turn.start({ text: 'go', turnId: 't2' })
      await clock.advance(31_000)
      expect(toasts.filter(t => t.includes('mid-set'))).toHaveLength(1)
    })

    test('/fit snooze puts a multi day\'s due share off', { options: { strict: true } }, async ($, on) => {
      pairWorld(on, [startedAt(MONDAY_9AM - GAP)])
      await start($)
      expect((await fit($, 'snooze')).text).toContain('20% of arms put off until 09:30.\n🏋 arms  20% due · back at 09:30')
      expect((await send($)).drop).toBeUndefined()
      const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...BAND })
      expect(await ui.find({ type: 'Text', text: /🏋 arms  20% due · back at 09:30/ })).toBeDefined()
      await ui.unmount()
      expect((await fit($, 'snooze 10')).text).toContain('Already put off until 09:30')
    })

    test('/fit window spreads the share left over the hours named', { options: { strict: true } }, async ($, on) => {
      const { files } = pairWorld(on, [[TODAY_LOG, '{"dips":50,"plank":0}\n']])
      await start($)
      expect((await fit($, 'window 3')).text).toContain('75% of arms left, spread over the next 3h (done by 12:00).\n🏋 arms  10% due now')
      expect(dayState(files).window).toEqual({ from: MONDAY_9AM, ms: 3 * HOUR, base: 25 })
      expect((await send($)).drop).toContain('Set due: 10% of arms, e.g. 20 dips or 36s plank (35/100% by now)')
      expect((await fit($, 'window 1240')).text).toContain('75% of arms left, spread between now and 12:40.')
      expect((await fit($, 'window off')).text).toContain('Back to 8h from your first prompt.\n🏋 arms')
      expect(dayState(files).window).toBeUndefined()
    })

    test('a swap between a multi day and a single day keeps a window to what is left, over the hours left', { options: { strict: true } }, async ($, on) => {
      const { clock, files } = multiWorld(on, new Map([
        [ROUTINE, JSON.stringify({ mon: PAIR, tue: { exercise: 'pushups', goal: 100 } })],
        [TODAY_LOG, '{"dips":50,"plank":0}\n'],
      ]))
      await start($)
      await fit($, 'window 3')
      await clock.advance(HOUR)
      // Percent becomes reps: the window ends when it did, and starts again from the pushups' count.
      const single = (await fit($, 'swap')).text
      expect(single).toContain('Swapped to pushups today. 💪')
      expect(single).toContain('0/100 pushups  🏁 first set: 10 to start the day')
      expect(dayState(files).window).toEqual({ from: MONDAY_9AM + HOUR, ms: 2 * HOUR, base: 0 })
      // And back: the day's share, over the same end.
      const multi = (await fit($, 'swap')).text
      expect(multi).toMatch(/^Swapped to arms today\. Kept: 50 dips\.\n🏋 arms  10% due now/)
      expect(dayState(files).window).toEqual({ from: MONDAY_9AM + HOUR, ms: 2 * HOUR, base: 25 })
    })

    test('swap and goal replies on a multi day put the pace on the status row, over a row per exercise', { options: { strict: true } }, async ($, on) => {
      multiWorld(on, new Map([[ROUTINE, JSON.stringify({ mon: PAIR, tue: { exercise: 'situps', goal: 60 } })], startedAt(MONDAY_9AM - GAP)]))
      await start($)
      expect((await fit($, 'goal 50 dips')).text).toBe("Today's goal is 50 dips.\n🏋 arms  20% due now · log it to keep prompting\n💪 ░░░░░░░░░░ 0/50 dips\n💪 ░░░░░░░░░░ 0/180s plank")
      expect((await fit($, 'swap dips situps')).text).toMatch(/^Swapped dips for situps today\.\n🏋 arms  20% due now/)
    })

    test('the help names the multi-day strict rule', () => {
      expect(HELP).toContain('in strict mode a multi day is paced as a whole')
      expect(HELP).not.toContain('`/fit window`, `/fit snooze`, strict holds')
    })
  })

  test('a single day swaps to a multi day by its name, and an exercise of one is still a single day\'s swap', async ($, on) => {
    const { files } = multiWorld(on, new Map([[ROUTINE, JSON.stringify({ mon: { exercise: 'pushups', goal: 100 }, tue: ARMS })]]))
    await start($)
    expect((await fit($, 'swap plank')).text).toContain('0/180s plank')
    await fit($, 'swap pushups')
    await fit($, '30')
    const text = (await fit($, 'swap arms')).text
    expect(text).toContain('Swapped to Arms day today. Kept: 30 pushups.')
    expect(text).toContain('30/50 pushups')
    expect(files.get(TODAY_LOG)).toBe('{"dips":0,"pushups":30,"plank":0}\n')
    expect(JSON.parse(files.get(`${TODAY_LOG}.swap`) ?? '{}')).toEqual(ARMS)
  })

  // routine.json as the mod left it: a day's goals read as the file holds them, single or multi.
  const routineFile = (files: Map<string, string>): Record<string, unknown> => {
    const raw: unknown = JSON.parse(files.get(ROUTINE) ?? '{}')
    return typeof raw === 'object' && raw !== null ? { ...raw } : {}
  }
  const goalOf = (entry: unknown): unknown => (typeof entry === 'object' && entry !== null && 'goal' in entry ? entry.goal : undefined)
  const goalsOf = (routine: Record<string, unknown>, weekday: string): unknown[] => {
    const entry = routine[weekday]
    if (typeof entry === 'object' && entry !== null && 'exercises' in entry && Array.isArray(entry.exercises)) return entry.exercises.map(goalOf)
    return [goalOf(entry)]
  }

  test('progressive goals on a single-day routine work as before', { options: { progress: true } }, async ($, on) => {
    const { files, toasts } = multiWorld(on, new Map([[`${LOG}/2026-10-04`, '100\n'], [`${LOG}/2026-10-03`, '300\n']]))
    await start($)
    const routine = routineFile(files)
    expect(['mon', 'thu', 'sun', 'sat'].map(weekday => goalsOf(routine, weekday)[0])).toEqual([105, 105, 105, 300])
    expect(toasts).toContain('📈 pushups up to 105: your last session hit 100.')
    await fit($, '105')
    expect(toasts.some(t => t.endsWith('Next pushups day: 110.'))).toBe(true)
  })

  test('progressive goals move each exercise of a multi day on its own history', { options: { progress: true } }, async ($, on) => {
    const typo = { exercise: 'lunges', goal: 0 }
    const { files, toasts } = multiWorld(on, new Map([
      [ROUTINE, JSON.stringify({ _note: 'mine', mon: { ...ARMS, exercises: [...ARMS.exercises, typo] }, tue: { exercise: 'squats', goal: 300 }, thu: ARMS })],
      // Last Monday dips hit and plank fell short once; pushups had no reps, so that day is no session of it.
      [`${LOG}/2026-09-28`, '{"dips":100,"plank":100}\n'],
      [`${LOG}/2026-09-21`, '{"dips":50,"pushups":20}\n'],
      [`${LOG}/2026-09-14`, '{"pushups":30}\n'],
    ]))
    await start($)
    const routine = routineFile(files)
    expect(routine.mon).toEqual({ name: 'Arms day', exercises: [{ exercise: 'dips', goal: 105 }, { exercise: 'pushups', goal: 45 }, { exercise: 'plank', goal: 180, unit: 's' }, typo] })
    // Every day at the old goal moves with it; a single day of another exercise and other keys stay.
    expect(goalsOf(routine, 'thu')).toEqual([105, 45, 180])
    expect(routine.tue).toEqual({ exercise: 'squats', goal: 300 })
    expect(routine._note).toBe('mine')
    const text = (await fit($, '')).text
    for (const shown of ['0/105 dips', '0/45 pushups', '0/180s plank']) expect(text).toContain(shown)
    expect(toasts.some(t => t.includes('dips up to 105') && t.includes('pushups back to 45'))).toBe(true)
  })

  test('an exercise a multi day shares at another goal stays put, and promises nothing', { options: { progress: true } }, async ($, on) => {
    // Dips is 80 on Tuesday and pushups 100 on Sunday; plank is set once, so it moves.
    const { files, toasts } = multiWorld(on, new Map([
      [ROUTINE, JSON.stringify({ mon: ARMS, tue: { exercise: 'dips', goal: 80 }, sun: { exercise: 'pushups', goal: 100 } })],
      [`${LOG}/2026-09-28`, '{"dips":100,"pushups":50,"plank":180}\n'],
    ]))
    await start($)
    const routine = routineFile(files)
    expect(goalsOf(routine, 'mon')).toEqual([100, 50, 190])
    expect([...goalsOf(routine, 'tue'), ...goalsOf(routine, 'sun')]).toEqual([80, 100])
    await fit($, '100')
    expect(toasts.some(t => t.startsWith('✅ dips done: 100/100.'))).toBe(true)
    expect(toasts.some(t => t.includes('Next dips day'))).toBe(false)
  })

  test('a single day shares its goal with a multi day: neither moves when they differ', { options: { progress: true } }, async ($, on) => {
    const { files } = multiWorld(on, new Map([
      [ROUTINE, JSON.stringify({ mon: { exercise: 'pushups', goal: 100 }, sun: { exercise: 'pushups', goal: 100 }, wed: ARMS })],
      [`${LOG}/2026-10-04`, '100\n'],
    ]))
    await start($)
    const routine = routineFile(files)
    expect([...goalsOf(routine, 'mon'), ...goalsOf(routine, 'sun'), ...goalsOf(routine, 'wed')]).toEqual([100, 100, 100, 50, 180])
  })

  test("a single day moves on a multi day's session too, and moves the multi day's entry with it", { options: { progress: true } }, async ($, on) => {
    const typo = { name: 'Legs', exercises: [{ exercise: 'squats', goal: 100 }, { exercise: 'lunges', goal: 0 }] }
    const { files, toasts } = multiWorld(on, new Map([
      [ROUTINE, JSON.stringify({ mon: { exercise: 'pushups', goal: 100 }, sun: { ...ARMS, exercises: [{ exercise: 'dips', goal: 100 }, { exercise: 'pushups', goal: 100 }] }, wed: typo })],
      // Sunday's arms day hit pushups alone: the last session of pushups, and none of dips.
      [`${LOG}/2026-10-04`, '{"pushups":100}\n'],
    ]))
    await start($)
    const routine = routineFile(files)
    expect(routine.mon).toEqual({ exercise: 'pushups', goal: 105 })
    expect(routine.sun).toEqual({ name: 'Arms day', exercises: [{ exercise: 'dips', goal: 100 }, { exercise: 'pushups', goal: 105 }] })
    // An entry the reader left out stays in the file for the person to fix.
    expect(routine.wed).toEqual(typo)
    expect(toasts.some(t => t.includes('pushups up to 105'))).toBe(true)
  })

  test('hitting a goal on a multi day says where its next session goes', { options: { progress: true } }, async ($, on) => {
    const { toasts } = multiWorld(on, armsMonday([[TODAY_LOG, '{"dips":0,"pushups":50,"plank":0}\n']]))
    await start($)
    await fit($, '100')
    expect(toasts).toContain('✅ dips done: 100/100. Still to go: 180s plank. Next dips day: 105.')
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...BAND })
    await ui.press({ key: 'plank+20' })
    await ui.unmount()
    await fit($, 'set 180')
    // The day's last exercise finishes the day: its toast lists every count, then the promise.
    expect(toasts).toContain("✅ Arms day done: 100/100 dips, 50/50 pushups, 180/180s plank. That's the work. Next plank day: 190s.")
  })

  test('progressive goals count a session of an exercise spelled in another case', { options: { progress: true } }, async ($, on) => {
    const { files } = multiWorld(on, new Map([
      [ROUTINE, JSON.stringify({ mon: { exercise: 'Pushups', goal: 100 }, sun: { exercise: 'pushups', goal: 100 } })],
      [`${LOG}/2026-10-04`, '100\n'],
    ]))
    await start($)
    const routine = routineFile(files)
    expect([...goalsOf(routine, 'mon'), ...goalsOf(routine, 'sun')]).toEqual([105, 105])
  })

  test('a goal move routine.json refuses is said once and made at the next look', { options: { progress: true } }, async ($, on) => {
    // routine.json reads as no JSON object once, at the move's own read, as a hand edit mid-save would:
    // the first read is the look's, the second the write's.
    const files = new (class extends Map<string, string> {
      reads = 0
      override get(path: string) {
        if (path === ROUTINE && ++this.reads === 2) return '[]'
        return super.get(path)
      }
    })([[ROUTINE, JSON.stringify({ mon: { exercise: 'pushups', goal: 100 }, sun: { exercise: 'pushups', goal: 100 } })], [`${LOG}/2026-10-04`, '100\n']])
    const { toasts } = multiWorld(on, files)
    await start($)
    expect(toasts.filter(t => t.startsWith('routine.json holds no JSON object just now'))).toHaveLength(1)
    expect(goalsOf(routineFile(files), 'mon')).toEqual([105])
    expect(toasts).toContain('📈 pushups up to 105: your last session hit 100.')
  })

  test('a swap file holds a multi day too', async ($, on) => {
    multiWorld(on, new Map([[`${TODAY_LOG}.swap`, `${JSON.stringify(ARMS)}\n`]]))
    await start($)
    expect((await fit($, '')).text).toContain('🏋 Arms day')
  })

  test('/fit reset puts every exercise back to 0', async ($, on) => {
    const { files } = multiWorld(on, armsMonday([[TODAY_LOG, '{"dips":40,"pushups":20,"plank":60}\n']]))
    await start($)
    expect((await fit($, 'reset')).text).toContain('0/50 pushups')
    expect(files.get(TODAY_LOG)).toBe('{"dips":0,"pushups":0,"plank":0}\n')
  })

  test('/fit rest names what was logged on a multi day', async ($, on) => {
    multiWorld(on, armsMonday([[TODAY_LOG, '{"dips":40,"pushups":0,"plank":60}\n']]))
    await start($)
    expect((await fit($, 'rest')).text).toContain("You've logged 40 dips, 60s plank today")
  })

  test('/fit program keeps a routine with multi days, and a new one freezes them as they were', async ($, on) => {
    const { files } = multiWorld(on, armsMonday([[`${LOG}/2026-09-28`, '{"dips":100}\n']]))
    await start($)
    const walk = async (program?: string) => {
      await fit($, 'program')
      const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...PANE, requestId: 'gym-onboard' })
      await ui.press({ key: 'next' })
      if (program !== undefined) await ui.press({ key: program })
      await ui.press({ key: 'next' })
      await ui.press({ key: 'finish' })
      await ui.unmount()
    }
    const kept = files.get(ROUTINE)
    await walk()
    expect(files.get(ROUTINE)).toBe(kept)
    // program-0 is "Keep my current routine"; program-1 the first preset.
    await walk('program-1')
    expect(JSON.parse(files.get(`${LOG}/2026-09-28.swap`) ?? '{}')).toEqual(ARMS)
    expect(JSON.parse(files.get(ROUTINE) ?? '{}').mon).toEqual({ exercise: 'pushups', goal: 100 })
  })

  test('/fit help describes multi days', async ($, on) => {
    multiWorld(on, new Map())
    await start($)
    await fit($, 'help')
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...PANE, requestId: 'gym-help' })
    expect(await ui.find({ type: 'Markdown', text: /### Multi-exercise days[\s\S]*"exercises"[\s\S]*a row per exercise/ })).toBeDefined()
    // The rule the reader applies: a goal of 0 or less is left out.
    expect(await ui.find({ type: 'Markdown', text: /entries with no name, a goal of 0 or less,/ })).toBeDefined()
    await ui.unmount()
  })

  test('a day log reads an object on a one-exercise day by its key, else its first count, and only numbers', () => {
    expect(parseDayLog('{"dips":40,"plank":20}\n', ['squats'])).toEqual([40])
    expect(parseDayLog('{"dips":"40","plank":20}\n', ['squats'])).toEqual([20])
    expect(parseDayLog('{"dips":"40"}\n', ['dips'])).toEqual([0])
    expect(parseDayLog('{"dips":"40","pushups":10}\n', ['dips', 'pushups'])).toEqual([0, 10])
  })

  test('a multi day nudges its first exercise still short, and the spinner names it', async ($, on) => {
    const { clock, toasts } = multiWorld(on, armsMonday([[TODAY_LOG, '{"dips":100,"pushups":10,"plank":0}\n']]))
    on('ui.render', { component: 'Spinner' }, ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>{e.props.message ?? e.props.word}</Text>
    })
    await start($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await clock.advance(31_000)
    // Dips, the bare /fit target, is done: pushups' own set of 5 is next.
    expect(toasts).toContain("Your agent's mid-set. You next: 5 pushups.")
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', component: 'Spinner', props: { word: 'Sauteing', message: null, suffix: '…', mode: 'responding' } })
    expect(await ui.find({ type: 'Text', text: '5 pushups while Claude works' })).toBeDefined()
    await ui.unmount()
  })

  test('the streak cached before the window joins the day that left it, by any exercise with reps', async ($, on) => {
    // Tuesday the 6th: the window starts 9 September; the cache was kept when it started the 8th.
    const files = armsDaily()
    for (let i = 1; i <= 28; i++) {
      const d = new Date(2026, 9, 6 - i, 12)
      files.set(`${LOG}/${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, '{"pushups":5}\n')
    }
    const { stored } = world(on, files, { slashes: true, now: MONDAY_9AM + 86_400_000, store: { streakRun: { asOf: '2026-09-08', older: 12 } } })
    await start($)
    // The window's days, then the day that left it (pushups only, no dips) on top of the cached run.
    expect((await fit($, '')).text).toContain('🔥40d')
    expect(stored.get('streakRun')).toEqual({ asOf: '2026-09-09', older: 13 })
  })

  test('/fit reset ends a breather and forgets the last exercise logged', async ($, on) => {
    const breather = MONDAY_9AM + 60 * 60_000
    const { files } = multiWorld(on, armsMonday([
      [TODAY_LOG, '{"dips":10,"pushups":20,"plank":0}\n'],
      [`${TODAY_LOG}.day`, JSON.stringify({ start: MONDAY_9AM, breather, putOff: 20, last: 'pushups' })],
    ]))
    await start($)
    await fit($, 'reset')
    expect(dayState(files)).toEqual({ start: MONDAY_9AM })
    // With no `last`, a bare /fit logs to the first exercise again.
    expect((await fit($, '5')).text).toContain('5/100 dips')
  })

  test('/fit reset on a single day ends its breather and forgets the last exercise too', async ($, on) => {
    const { files } = multiWorld(on, new Map([
      [TODAY_LOG, '40\n'],
      [`${TODAY_LOG}.day`, JSON.stringify({ start: MONDAY_9AM, breather: MONDAY_9AM + 60 * 60_000, last: 'pushups' })],
    ]))
    await start($)
    await fit($, 'reset')
    expect(files.get(TODAY_LOG)).toBe('0\n')
    expect(dayState(files)).toEqual({ start: MONDAY_9AM })
  })

  test('the ledger keeps a multi date whose first exercise has no reps', async ($, on) => {
    multiWorld(on, armsMonday([[`${LOG}/2026-09-28`, '{"dips":0,"pushups":20,"plank":0}\n']]))
    await start($)
    await fit($, 'streak')
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...PANE, props: { ...PANE.props, bodyColumns: 70 } })
    expect(await ui.find({ type: 'Text', text: /20 reps · 1 day trained · 0 goals hit/ })).toBeDefined()
    expect(await ui.find({ key: 'total-pushups' })).toBeDefined()
    await ui.unmount()
  })

  test('counts of an exercise taken off the plan survive the next log, and return with it', async ($, on) => {
    const { files } = multiWorld(on, armsMonday([[TODAY_LOG, '{"dips":10,"pushups":0,"plank":20}\n']]))
    await start($)
    // The operator edits plank out of today's routine, then logs.
    files.set(ROUTINE, JSON.stringify({ mon: { ...ARMS, exercises: ARMS.exercises.slice(0, 2) } }))
    await fit($, '5')
    expect(JSON.parse(files.get(TODAY_LOG) ?? '{}')).toEqual({ dips: 15, pushups: 0, plank: 20 })
    files.set(ROUTINE, JSON.stringify({ mon: ARMS }))
    expect((await fit($, '')).text).toContain('20/180s plank')
  })

  test('a routine edit that makes today a single day keeps the other counts through its logs', async ($, on) => {
    const { files } = multiWorld(on, armsMonday([[TODAY_LOG, '{"dips":40,"pushups":20,"plank":0}\n']]))
    await start($)
    files.set(ROUTINE, JSON.stringify({ mon: { exercise: 'dips', goal: 100 } }))
    expect((await fit($, '5')).text).toContain('45/100 dips')
    expect(files.get(TODAY_LOG)).toBe('{"dips":45,"pushups":20,"plank":0}\n')
    files.set(ROUTINE, JSON.stringify({ mon: ARMS }))
    expect((await fit($, '')).text).toContain('20/50 pushups')
    // A single day's log with nothing else to keep stays a plain count.
    expect(formatDayLog([{ exercise: 'dips', count: 45 }], false, '40\n')).toBe('45\n')
    expect(formatDayLog([{ exercise: 'dips', count: 45 }], false, '{"Dips":40}\n')).toBe('45\n')
  })

  test('custom goals keep what routine.json holds beyond the goals typed', async ($, on) => {
    const written = {
      _note: 'my program',
      mon: { name: 'Arms day', cue: 'slow', exercises: [ARMS.exercises[0], { exercise: 'lunges', goal: 0 }, ...ARMS.exercises.slice(1)] },
      tue: { exercise: 'dips', goal: 100, cue: 'deep' },
    }
    const { files } = multiWorld(on, new Map([[ROUTINE, JSON.stringify(written)]]))
    await start($)
    await fit($, 'program')
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...ONBOARD })
    await ui.press({ key: 'next' })
    // Custom goals, after Keep and the presets.
    await ui.press({ key: 'program-4' })
    await ui.input({ key: 'goal-dips', text: '120' })
    await ui.press({ key: 'next' })
    await ui.press({ key: 'finish' })
    await ui.unmount()
    expect(JSON.parse(files.get(ROUTINE) ?? '{}')).toEqual({
      _note: 'my program',
      mon: { ...written.mon, exercises: [{ exercise: 'dips', goal: 120 }, ...written.mon.exercises.slice(1)] },
      tue: { exercise: 'dips', goal: 120, cue: 'deep' },
    })
  })

  test('a key of routine.json that is no weekday is passed over without a toast', async ($, on) => {
    expect(parseRoutine({ _note: 'mine', Mon: { exercise: 'dips', goal: 10 }, tue: { exercise: 'dips', goal: 10 } })).toEqual({
      routine: { tue: { plans: [{ exercise: 'dips', goal: 10 }] } },
      dropped: [],
    })
    const { toasts } = multiWorld(on, new Map([[ROUTINE, JSON.stringify({ _note: 'my program', mon: ARMS })]]))
    await start($)
    expect((await fit($, '')).text).toContain('🏋 Arms day')
    expect(toasts.some(t => t.startsWith('routine.json'))).toBe(false)
  })

  test('a log past the goal names the exercise and says it is done', async ($, on) => {
    const { toasts } = multiWorld(on, armsMonday([[TODAY_LOG, '{"dips":100,"pushups":0,"plank":0}\n']]))
    await start($)
    await fit($, '10')
    expect(toasts).toContain('💪 +10 dips, done (110/100).')
  })

  test('a log past a single day\'s goal names the exercise and says it is done', async ($, on) => {
    const { toasts } = multiWorld(on, new Map([[TODAY_LOG, '100\n']]))
    await start($)
    await fit($, '10')
    expect(toasts).toContain('💪 +10 pushups, done (110/100).')
  })

  test('today\'s last exercise is read on a single day too', async ($, on) => {
    multiWorld(on, new Map([[`${TODAY_LOG}.day`, JSON.stringify({ last: 'pushups' })]]))
    // What the mod holds as today: the last value it wrote there.
    let held: unknown
    on('state.set', ($, e, next) => {
      if (e.plugin === 'terminal-gym' && e.key === 'today') held = e.value
      return next(e)
    })
    await start($)
    await fit($, '')
    expect(held).toMatchObject({ isMulti: false, last: 'pushups' })
  })

  test('names lose their control characters before they reach a reply, the band or a toast', async ($, on) => {
    const { toasts } = multiWorld(on, new Map([[ROUTINE, JSON.stringify({
      mon: { name: 'Arms\u001b[31m day\n', exercises: [{ exercise: 'di\u0007ps', goal: 100 }, { exercise: 'push\u009bups', goal: 50 }, { exercise: 'x\u001b', goal: 0 }] },
    })]]))
    await start($)
    const controls = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/
    const text = (await fit($, '10')).text
    expect(text).toContain('10/100 dips')
    expect(text).not.toMatch(controls)
    expect(toasts).toContain('routine.json: left out mon x (goal must be above 0).')
    expect(toasts.some(t => controls.test(t))).toBe(false)
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...BAND })
    expect(await ui.find({ type: 'Text', text: /^🏋 Arms\[31m day/ })).toBeDefined()
    expect(await ui.find({ key: 'row-pushups' })).toBeDefined()
    await ui.unmount()
  })

  test('a swap file\'s names lose their control characters too', async ($, on) => {
    multiWorld(on, new Map([[`${TODAY_LOG}.swap`, `${JSON.stringify({ exercise: 'squ\u001bats', goal: 50 })}\n`]]))
    await start($)
    const text = (await fit($, '')).text
    expect(text).toContain('0/50 squats')
    expect(text).not.toMatch(/\u001b/)
  })

  test('an exercise named like an Object field still gets its custom goal', async ($, on) => {
    expect(Object.entries(exerciseGoals(asRoutine({ mon: { exercise: 'constructor', goal: 40 }, tue: { exercise: 'toString', goal: 30 } }))))
      .toEqual([['constructor', 40], ['toString', 30]])
    const { files } = multiWorld(on, new Map([[ROUTINE, JSON.stringify({ mon: { exercise: 'constructor', goal: 40 }, tue: { exercise: 'dips', goal: 30 } })]]))
    await start($)
    await fit($, 'program')
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...ONBOARD })
    await ui.press({ key: 'next' })
    await ui.press({ key: 'program-4' })
    expect(await ui.find({ key: 'goal-constructor' })).toBeDefined()
    await ui.input({ key: 'goal-constructor', text: '60' })
    await ui.press({ key: 'next' })
    await ui.press({ key: 'finish' })
    await ui.unmount()
    expect(JSON.parse(files.get(ROUTINE) ?? '{}').mon).toEqual({ exercise: 'constructor', goal: 60 })
  })

  test('a narrow band truncates a row\'s line, not its buttons', async ($, on) => {
    multiWorld(on, armsMonday())
    await start($)
    // The row's line, its first child: its type and the width it is held to, read with checks.
    const lineOf = async (columns: number) => {
      const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...BAND, props: { ...BAND.props, bodyColumns: columns } })
      const row = await ui.find({ key: 'row-plank' })
      await ui.unmount()
      expect(row).toBeDefined()
      const line: unknown = row?.children[0]
      if (typeof line !== 'object' || line === null || !('type' in line)) throw new Error(`row-plank has no line at ${columns} columns`)
      const props: unknown = 'props' in line ? line.props : undefined
      const width = typeof props === 'object' && props !== null && 'width' in props ? props.width : undefined
      return { type: line.type, width }
    }
    // The line gets the columns plank's buttons leave.
    expect(buttonsWidth(['+5s', '+15s', '+20s'])).toBe(25)
    expect(await lineOf(30)).toEqual({ type: 'Box', width: 5 })
    expect(await lineOf(100)).toEqual({ type: 'Box', width: undefined })
  })

  test('a typed name matches an exercise in any case, or by the only name it starts', () => {
    const names = ['dips', 'pushups', 'plank', 'jumping jacks']
    expect(matchExercise('dips', names)).toEqual({ kind: 'one', index: 0 })
    expect(matchExercise('DIPS', names)).toEqual({ kind: 'one', index: 0 })
    expect(matchExercise('di', names)).toEqual({ kind: 'one', index: 0 })
    expect(matchExercise('push', names)).toEqual({ kind: 'one', index: 1 })
    expect(matchExercise('Jumping  Jacks', names)).toEqual({ kind: 'one', index: 3 })
    expect(matchExercise('p', names)).toEqual({ kind: 'many', names: ['pushups', 'plank'] })
    expect(matchExercise('lunges', names)).toEqual({ kind: 'none' })
    expect(matchExercise('  ', names)).toEqual({ kind: 'none' })
    // A whole name wins over a longer one it starts.
    expect(matchExercise('dip', ['dips', 'dip'])).toEqual({ kind: 'one', index: 1 })
  })

  test('/fit <n> and /fit set <n> take an exercise name after the number', () => {
    expect(parseFit('20 dips')).toEqual({ kind: 'add', n: 20, typedName: 'dips' })
    expect(parseFit('-5 Dips')).toEqual({ kind: 'add', n: -5, typedName: 'dips' })
    expect(parseFit(' 20  jumping   jacks ')).toEqual({ kind: 'add', n: 20, typedName: 'jumping jacks' })
    expect(parseFit('set 80 dips')).toEqual({ kind: 'set', n: 80, typedName: 'dips' })
    expect(parseFit('set 80')).toEqual({ kind: 'set', n: 80 })
    expect(parseFit('20')).toEqual({ kind: 'add', n: 20 })
    expect(parseFit('set dips').kind).toBe('error')
  })

  test('/fit <n> <name> logs to the exercise named, in any case or by its start, and sets last', async ($, on) => {
    const { files } = multiWorld(on, armsMonday())
    await start($)
    await fit($, '5 pushups')
    expect(dayState(files).last).toBe('pushups')
    expect((await fit($, '20 dips')).text).toContain('20/100 dips')
    expect((await fit($, '20 DIPS')).text).toContain('40/100 dips')
    expect((await fit($, '20 di')).text).toContain('60/100 dips')
    expect(files.get(TODAY_LOG)).toBe('{"dips":60,"pushups":5,"plank":0}\n')
    expect(dayState(files).last).toBe('dips')
    // A bare /fit follows the named log.
    expect((await fit($, '10')).text).toContain('70/100 dips')
  })

  test('an ambiguous or unknown name logs nothing and says which exercises it could be', async ($, on) => {
    const { files } = multiWorld(on, armsMonday([[TODAY_LOG, '{"dips":10,"pushups":0,"plank":0}\n']]))
    await start($)
    const many = (await fit($, '20 p')).text
    expect(many).toContain('pushups or plank')
    expect(many).toContain('nothing logged')
    const none = (await fit($, '20 lunges')).text
    expect(none).toContain('No lunges today')
    expect(none).toContain('dips, pushups, plank')
    expect((await fit($, 'set 5 lunges')).text).toContain('No lunges today')
    expect(files.get(TODAY_LOG)).toBe('{"dips":10,"pushups":0,"plank":0}\n')
    expect(dayState(files).last).toBeUndefined()
  })

  test('/fit set fixes the named exercise, or the last one logged; /fit reset zeroes the day', async ($, on) => {
    const { files } = multiWorld(on, armsMonday([[TODAY_LOG, '{"dips":10,"pushups":20,"plank":30}\n']]))
    await start($)
    expect((await fit($, 'set 80 dips')).text).toContain('80/100 dips')
    await fit($, '5 plank')
    expect((await fit($, 'set 90')).text).toContain('90/180s plank')
    expect(files.get(TODAY_LOG)).toBe('{"dips":80,"pushups":20,"plank":90}\n')
    await fit($, 'reset')
    expect(files.get(TODAY_LOG)).toBe('{"dips":0,"pushups":0,"plank":0}\n')
  })

  test('a bare /fit shows every exercise and the streak', async ($, on) => {
    multiWorld(on, armsMonday([[TODAY_LOG, '{"dips":40,"pushups":50,"plank":0}\n'], [`${LOG}/2026-10-04`, '10\n']]))
    await start($)
    const text = (await fit($, '')).text
    expect(text).toMatch(/^🏋 Arms day {2}🔥2d/)
    for (const row of ['40/100 dips', '✅ ▓▓▓▓▓▓▓▓▓▓ 50/50 pushups', '0/180s plank']) expect(text).toContain(row)
  })

  test('the day\'s last exercise to finish toasts every count, from a press too', async ($, on) => {
    const { toasts } = multiWorld(on, armsMonday([[TODAY_LOG, '{"dips":100,"pushups":40,"plank":160}\n']]))
    await start($)
    await fit($, '15 push')
    expect(toasts).toContain('✅ pushups done: 55/50. Still to go: 20s plank.')
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...BAND })
    await ui.press({ key: 'plank+20' })
    await ui.unmount()
    expect(toasts).toContain("✅ Arms day done: 100/100 dips, 55/50 pushups, 180/180s plank. That's the work.")
  })

  test('a single day takes its own exercise\'s name and refuses another', async ($, on) => {
    const { files } = multiWorld(on, new Map())
    await start($)
    expect((await fit($, '20')).text).toContain('20/100 pushups')
    expect((await fit($, '10 Push')).text).toContain('30/100 pushups')
    expect((await fit($, '10 dips')).text).toContain('No dips today')
    expect(files.get(TODAY_LOG)).toBe('30\n')
  })

  test('/fit help describes the named /fit forms', async ($, on) => {
    multiWorld(on, new Map())
    await start($)
    await fit($, 'help')
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...PANE, requestId: 'gym-help' })
    expect(await ui.find({ type: 'Markdown', text: /`\/fit 20 dips` logs to dips[\s\S]*`\/fit set 80 dips` fixes one exercise/ })).toBeDefined()
    // The named forms are in "Log a set" and the Commands table too, not only the multi-day list.
    expect(await ui.find({ type: 'Markdown', text: /### Log a set\n`\/fit 20` adds 20 reps, `\/fit 20 dips` adds them to dips/ })).toBeDefined()
    expect(await ui.find({ type: 'Markdown', text: /\| `\/fit 20 \[exercise\]` \|[\s\S]*\| `\/fit set 80 \[exercise\]` \|[\s\S]*\| `\/fit goal 60 \[exercise\]` \|/ })).toBeDefined()
    await ui.unmount()
  })

  const CORE = { name: 'core', exercises: [{ exercise: 'situps', goal: 60 }, { exercise: 'plank', goal: 120, unit: 's' }] }
  const armsAndCore = (more: [string, string][] = []) =>
    new Map<string, string>([[ROUTINE, JSON.stringify({ mon: ARMS, tue: { exercise: 'dips', goal: 100 }, wed: CORE })], ...more])
  const swapFile = (files: Map<string, string>) => JSON.parse(files.get(`${TODAY_LOG}.swap`) ?? '{}')

  test('the parser reads swap and goal names', () => {
    expect(parseFit('swap')).toEqual({ kind: 'swap' })
    expect(parseFit('swap Core')).toEqual({ kind: 'swap', typedName: 'core' })
    expect(parseFit('swap Dips   situps')).toEqual({ kind: 'swap', typedName: 'dips situps' })
    expect(parseFit('goal 60')).toEqual({ kind: 'goal', n: 60 })
    expect(parseFit('goal 60 Dips')).toEqual({ kind: 'goal', n: 60, typedName: 'dips' })
    expect(parseFit('goal dips').kind).toBe('error')
  })

  test('pickSwap reads a day name, one exercise or two names', () => {
    const routine = asRoutine({ mon: ARMS, tue: { exercise: 'dips', goal: 100 }, wed: CORE, thu: { exercise: 'core', goal: 30 }, fri: { exercise: 'cossacks', goal: 20 } })
    const arms = routine.mon ?? { plans: [] }
    const withSitups = { isMulti: true as const, name: 'Arms day', plans: [{ exercise: 'situps', goal: 60 }, ...ARMS.exercises.slice(1)] }
    expect(pickSwap(routine, arms, 'dips situps')).toEqual({ kind: 'moved', day: withSitups, moved: { from: 'dips', to: 'situps' } })
    // Starts of names work for both, as /fit 20 di does.
    expect(pickSwap(routine, arms, 'di sit')).toEqual({ kind: 'moved', day: withSitups, moved: { from: 'dips', to: 'situps' } })
    // A day's name wins over an exercise of the same name, or the start of several, and says it did.
    expect(pickSwap(routine, arms, 'core')).toEqual({ kind: 'day', day: routine.wed, alsoExercises: ['core'] })
    expect(pickSwap(routine, arms, 'co')).toEqual({ kind: 'day', day: routine.wed, alsoExercises: ['core', 'cossacks'] })
    // A bare swap from a day with one exercise swapped moves on from the day of its name.
    expect(pickSwap(routine, withSitups)).toEqual({ kind: 'day', day: routine.tue })
    expect(pickSwap(routine, arms, 'arms day')).toEqual({ kind: 'same', name: 'Arms day' })
    expect(pickSwap(routine, arms, 'situps')).toMatchObject({ kind: 'refuse' })
    expect(pickSwap(routine, arms, 'dips plank')).toEqual({ kind: 'refuse', text: "plank is already on today's plan. Today: dips, pushups, plank." })
    expect(pickSwap(routine, arms, 'p situps')).toEqual({ kind: 'refuse', text: '"p" could be pushups or plank, so nothing swapped. Type more of the name.' })
    expect(pickSwap(routine, arms, 'dips dips')).toEqual({ kind: 'same', name: 'dips' })
  })

  test('pickSwap: a whole name beats a start, and a reply names what it could not place', () => {
    const DIPS_DAY = { name: 'Dips day', exercises: [{ exercise: 'pullups', goal: 50 }, { exercise: 'rows', goal: 50 }] }
    const COOLDOWN = { name: 'cooldown', exercises: [{ exercise: 'walk', goal: 600, unit: 's' }, { exercise: 'stretch', goal: 300, unit: 's' }] }
    const routine = asRoutine({ mon: { exercise: 'pushups', goal: 100 }, tue: DIPS_DAY, wed: { exercise: 'dips', goal: 100 }, thu: CORE, fri: COOLDOWN, sat: { exercise: 'cossacks', goal: 20 } })
    const pushups = routine.mon ?? { plans: [] }
    // An exercise typed in full beats a day it only starts.
    expect(pickSwap(routine, pushups, 'dips')).toEqual({ kind: 'day', day: routine.wed })
    // The start of two days and one exercise: nothing swapped, and the reply names all three.
    expect(pickSwap(routine, pushups, 'co')).toEqual({ kind: 'refuse', text: '"co" could be core or cooldown or cossacks, so nothing swapped. Type more of the name.' })
    const core = routine.thu ?? { plans: [] }
    // The word with no exercise is named, not everything typed.
    expect(pickSwap(routine, core, 'situps lunges')).toMatchObject({ kind: 'refuse', text: expect.stringMatching(/^No lunges in your program\./) })
    expect(pickSwap(routine, core, 'dips rows')).toEqual({ kind: 'refuse', text: "dips isn't on today's plan, so nothing swapped. Today: situps, plank." })
    expect(pickSwap(routine, core, 'situps p')).toEqual({ kind: 'refuse', text: '"p" could be pushups or pullups or plank, so nothing swapped. Type more of the name.' })
  })

  test('a bare swap from an unnamed multi day with an exercise swapped moves on to the next day', () => {
    const PAIR = { exercises: [{ exercise: 'dips', goal: 100 }, { exercise: 'plank', goal: 180, unit: 's' }] }
    const routine = asRoutine({ mon: { exercise: 'pushups', goal: 100 }, tue: PAIR, wed: { exercise: 'squats', goal: 100 } })
    const pair = routine.tue ?? { plans: [] }
    const moved = pickSwap(routine, pair, 'dips pushups')
    expect(moved).toMatchObject({ kind: 'moved' })
    const withPushups = 'day' in moved ? moved.day : pair
    expect(pickSwap(routine, withPushups)).toEqual({ kind: 'day', day: routine.wed })
  })

  test('/fit swap <out> <in> puts one exercise in place of another and carries its count', async ($, on) => {
    const { files } = multiWorld(on, armsAndCore([[TODAY_LOG, '{"dips":40,"pushups":20,"plank":0}\n'], [`${TODAY_LOG}.day`, '{"last":"dips"}\n']]))
    const routine = files.get(ROUTINE)
    await start($)
    const text = (await fit($, 'swap dips situps')).text
    expect(text).toContain('Swapped dips for situps today. Your 40 reps carry over.')
    expect(text).toContain('40/60 situps')
    expect(files.get(TODAY_LOG)).toBe('{"situps":40,"pushups":20,"plank":0}\n')
    expect(swapFile(files)).toEqual({ ...ARMS, exercises: [{ exercise: 'situps', goal: 60 }, ...ARMS.exercises.slice(1)] })
    expect(files.get(ROUTINE)).toBe(routine)
    // The last exercise logged moves with it, so a bare /fit 5 logs to situps.
    expect((await fit($, '5')).text).toContain('45/60 situps')
    // A bare swap moves on from the arms day, not back to the routine's first day.
    expect((await fit($, 'swap')).text).toContain('Swapped to dips today.')
  })

  test('/fit swap <day name> makes today that day and keeps counts for exercises on both', async ($, on) => {
    const { files } = multiWorld(on, armsAndCore([[TODAY_LOG, '{"dips":40,"pushups":20,"plank":30}\n']]))
    await start($)
    const text = (await fit($, 'swap Core')).text
    // The sentence, then the status row, then a row per exercise, as every multi-day reply reads.
    expect(text).toContain('Swapped to core today. Kept: 30s plank.\n🏋 core\n💪 ░░░░░░░░░░ 0/60 situps')
    expect(text).toContain('30/120s plank')
    expect(swapFile(files)).toEqual(CORE)
    // The counts off the new plan stay in the log, so swapping back finds them.
    expect(files.get(TODAY_LOG)).toBe('{"situps":0,"plank":30,"dips":40,"pushups":20}\n')
    expect((await fit($, 'swap arms day')).text).toContain('40/100 dips')
  })

  test('a word naming a day and an exercise swaps the day and says so', async ($, on) => {
    multiWorld(on, new Map([[ROUTINE, JSON.stringify({ mon: ARMS, wed: CORE, thu: { exercise: 'core', goal: 30 } })]]))
    await start($)
    const text = (await fit($, 'swap core')).text
    expect(text).toContain('Swapped to core today.')
    expect(text).toContain("core is an exercise too, and the day's name wins")
  })

  test('one exercise name on a multi day asks for the two-name form; a bare swap goes to the next different day', async ($, on) => {
    const { files } = multiWorld(on, armsMonday([[TODAY_LOG, '{"dips":40,"pushups":20,"plank":0}\n']]))
    await start($)
    const unknown = (await fit($, 'swap squats')).text
    expect(unknown).toContain('No squats in your program')
    expect(unknown).toContain('/fit swap <out> <in>')
    const asked = (await fit($, 'swap dips')).text
    expect(asked).toContain('/fit swap dips <in>')
    expect(files.has(`${TODAY_LOG}.swap`)).toBe(false)
    const text = (await fit($, 'swap')).text
    expect(text).toContain('Swapped to dips today. Kept: 40 dips.')
    expect(text).toContain('40/100 dips')
    expect(swapFile(files)).toEqual({ exercise: 'dips', goal: 100 })
    // The other counts stay in the log, so swapping back finds them.
    expect(files.get(TODAY_LOG)).toBe('{"dips":40,"pushups":20,"plank":0}\n')
    const back = (await fit($, 'swap')).text
    expect(back).toContain('🏋 Arms day')
    expect(back).toContain('20/50 pushups')
  })

  test('a day swapped to a single day keeps the other counts through its logs and swaps, so the way back finds them', async ($, on) => {
    const { files } = multiWorld(on, armsAndCore([[TODAY_LOG, '{"dips":40,"pushups":20,"plank":0}\n']]))
    await start($)
    expect((await fit($, 'swap')).text).toContain('Swapped to dips today.')
    expect((await fit($, '5')).text).toContain('45/100 dips')
    expect(files.get(TODAY_LOG)).toBe('{"dips":45,"pushups":20,"plank":0}\n')
    // A single day to another carries its one count, and the other counts still stay.
    expect((await fit($, 'swap situps')).text).toContain('45/60 situps')
    expect(files.get(TODAY_LOG)).toBe('{"situps":45,"pushups":20,"plank":0}\n')
    expect((await fit($, 'swap arms day')).text).toContain('20/50 pushups')
    expect(swappedLog([{ exercise: 'dips', count: 40 }], { plans: [{ exercise: 'squats', goal: 300 }] }, '{"dips":40,"pushups":20}\n'))
      .toBe('{"squats":40,"pushups":20}\n')
  })

  test('/fit goal <n> <exercise> changes one goal for today only; a bare /fit goal asks which', async ($, on) => {
    const { files } = multiWorld(on, armsMonday())
    const routine = files.get(ROUTINE)
    await start($)
    const bare = (await fit($, 'goal 60')).text
    expect(bare).toContain('name the one to change')
    expect((await fit($, 'goal 60 p')).text).toContain('could be pushups or plank, so no goal changed')
    expect((await fit($, 'goal 60 lunges')).text).toContain('No lunges today')
    expect(files.has(`${TODAY_LOG}.swap`)).toBe(false)
    const text = (await fit($, 'goal 60 Dips')).text
    expect(text).toContain("Today's goal is 60 dips.")
    expect(text).toContain('0/60 dips')
    expect((await fit($, 'goal 90 plank')).text).toContain("Today's goal is 90s plank.")
    expect(swapFile(files)).toEqual({ ...ARMS, exercises: [{ exercise: 'dips', goal: 60 }, ARMS.exercises[1], { exercise: 'plank', goal: 90, unit: 's' }] })
    expect(files.get(ROUTINE)).toBe(routine)
  })

  test('a single day swaps and sets its goal as before', async ($, on) => {
    const { files } = multiWorld(on, new Map())
    await start($)
    await fit($, '40')
    const text = (await fit($, 'swap squats')).text
    expect(text).toContain('Swapped to squats today. Your 40 reps carry over.')
    expect(text).toContain('40/300 squats')
    expect(files.get(TODAY_LOG)).toBe('40\n')
    expect((await fit($, 'goal 60')).text).toContain("Today's goal is 60 squats.")
    expect(swapFile(files)).toEqual({ exercise: 'squats', goal: 60 })
    expect((await fit($, 'swap')).text).toContain('Swapped to pushups today.')
    expect((await fit($, 'swap pushups')).text).toContain('Already on pushups today.')
    expect((await fit($, 'swap burpees')).text).toContain('No burpees')
    expect((await fit($, 'goal 70 dips')).text).toContain('No dips today')
  })

  test('a swap never writes over a log another session is still writing', async ($, on) => {
    const { files } = multiWorld(on, armsAndCore([[TODAY_LOG, '{"dips":4']]))
    await start($)
    expect((await fit($, 'swap dips situps')).text).toContain("Couldn't read today's log, so nothing swapped")
    expect(files.has(`${TODAY_LOG}.swap`)).toBe(false)
    expect(files.get(TODAY_LOG)).toBe('{"dips":4')
  })

  test('a swap written in another session reaches the band within a poll', async ($, on) => {
    const { touch, clock } = multiWorld(on, armsAndCore([[TODAY_LOG, '{"dips":40,"pushups":20,"plank":0}\n']]))
    await start($)
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...BAND })
    await clock.advance(1_000)
    touch(`${TODAY_LOG}.swap`, `${JSON.stringify({ ...ARMS, exercises: [{ exercise: 'situps', goal: 60 }, ...ARMS.exercises.slice(1)] })}\n`)
    touch(TODAY_LOG, '{"situps":40,"pushups":20,"plank":0}\n')
    await clock.advance(10_000)
    expect(await ui.find({ type: 'Text', text: /40\/60 situps/ })).toBeDefined()
    await ui.unmount()
  })

  test('/fit help describes the multi-day swap and goal forms', async ($, on) => {
    multiWorld(on, new Map())
    await start($)
    await fit($, 'help')
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...PANE, requestId: 'gym-help' })
    expect(await ui.find({ type: 'Markdown', text: /`\/fit swap dips situps`[\s\S]*`\/fit swap arms day`[\s\S]*`\/fit goal 60 dips`/ })).toBeDefined()
    await ui.unmount()
  })
})

describe('custom days', () => {
  const ROUTINE = `${HOME}/.claude/fitness/routine.json`
  const routineOf = (files: Map<string, string>) => JSON.parse(files.get(ROUTINE) ?? '{}')
  // Paths keyed with slashes, so these run on Windows too.
  const daysWorld = (on: On, files = new Map<string, string>()) => world(on, files, { slashes: true })
  const ARMS_LINE = 'arms: 100 dips, 100 pushups, 180s plank'
  const ARMS_DAY = {
    name: 'arms',
    exercises: [{ exercise: 'dips', goal: 100 }, { exercise: 'pushups', goal: 100 }, { exercise: 'plank', goal: 180, unit: 's' }],
  }
  // The routine customDays returned: an errors result fails the test with its errors.
  const routineFrom = (typed: ReturnType<typeof customDays>) => {
    if (!('routine' in typed)) throw new Error(`customDays refused the lines: ${typed.errors.join('; ')}`)
    return typed.routine
  }
  type Mounted = Awaited<ReturnType<Engine['ui']['mount']>>
  // With no routine of their own, program-3 is Custom goals and program-4 Custom days; with one, each is one later.
  const openDays = async ($: Engine, program = 'program-4') => {
    await fit($, 'program')
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...ONBOARD })
    await ui.press({ key: 'next' })
    await ui.press({ key: program })
    return ui
  }
  const finish = async (ui: Mounted) => {
    await ui.press({ key: 'next' })
    await ui.press({ key: 'finish' })
    await ui.unmount()
  }

  test('a day line reads a named multi day with seconds, a one-exercise day, and a name alone as multi', () => {
    expect(parseDayLine(ARMS_LINE)).toEqual({ day: { isMulti: true, name: 'arms', plans: ARMS_DAY.exercises } })
    expect(parseDayLine('30 burpees')).toEqual({ day: { plans: [{ exercise: 'burpees', goal: 30 }] } })
    expect(parseDayLine('legs: 300 squats')).toEqual({ day: { isMulti: true, name: 'legs', plans: [{ exercise: 'squats', goal: 300 }] } })
    expect(parseDayLine(' 100 dips ,50 jumping jacks, ')).toEqual({
      day: { isMulti: true, plans: [{ exercise: 'dips', goal: 100 }, { exercise: 'jumping jacks', goal: 50 }] },
    })
  })

  test('a day line that breaks the reader\'s rules says why', () => {
    expect(parseDayLine('100 dips, 0 pushups')).toEqual({ error: 'pushups (goal must be above 0)' })
    expect(parseDayLine('100 dips, 50 Dips')).toEqual({ error: 'Dips (listed twice)' })
    expect(parseDayLine('1 a, 1 b, 1 c, 1 d, 1 e, 1 f')).toEqual({ error: 'f (over 5 exercises)' })
    expect(parseDayLine('dips')).toEqual({ error: '"dips" should read like 100 dips or 180s plank' })
    expect(parseDayLine('arms:')).toEqual({ error: 'no exercise' })
    expect(parseDayLine('')).toEqual({ error: 'no exercise' })
    expect(parseDayLine(`${'9'.repeat(20)} dips`)).toEqual({ error: 'dips (goal too large)' })
    expect(parseDayLine('100x dips')).toEqual({ error: 'dips (x is no unit; 180s is seconds)' })
    expect(parseDayLine('100 jumping  jacks, 50 jumping jacks')).toEqual({ error: 'jumping jacks (listed twice)' })
    // Every fault of a line at once, its syntax first.
    expect(parseDayLine('0 dips, squats')).toEqual({ error: '"squats" should read like 100 dips or 180s plank; dips (goal must be above 0)' })
  })

  test('a day line takes s in any case, a unit the routine already uses, and a name with a colon', () => {
    expect(parseDayLine('180S plank')).toEqual({ day: { plans: [{ exercise: 'plank', goal: 180, unit: 's' }] } })
    expect(parseDayLine('5km run', ['s', 'km'])).toEqual({ day: { plans: [{ exercise: 'run', goal: 5, unit: 'km' }] } })
    expect(parseDayLine('Arms: heavy: 100 dips')).toEqual({ day: { isMulti: true, name: 'Arms: heavy', plans: [{ exercise: 'dips', goal: 100 }] } })
  })

  test('a day prints as the line that reads back as the same day', () => {
    const days = asRoutine({
      mon: { exercise: 'pushups', goal: 100 },
      tue: { name: 'Arms day', exercises: ARMS_DAY.exercises },
      wed: { exercises: [{ exercise: 'dips', goal: 100 }, { exercise: 'plank', goal: 60, unit: 's' }] },
      thu: { exercise: 'plank', goal: 60, unit: 's' },
      fri: { name: 'Arms: heavy', exercises: ARMS_DAY.exercises },
    })
    expect(dayLine(days.tue)).toBe('Arms day: 100 dips, 100 pushups, 180s plank')
    expect(dayLine(days.thu)).toBe('60s plank')
    expect(dayLine(undefined)).toBe('')
    for (const day of Object.values(days)) expect(parseDayLine(dayLine(day))).toEqual({ day })
  })

  test('a day line quotes a name it cannot hold, and reads back decimal goals and the file\'s own units', () => {
    const days = asRoutine({
      mon: { name: 'Push, pull', exercises: [{ exercise: 'push, ups', goal: 2.5 }, { exercise: 'bar: hang', goal: 30, unit: 's' }, { exercise: '7" box jumps', goal: 10 }] },
      tue: { exercise: 'run', goal: 5.5, unit: 'km/h' },
    })
    expect(dayLine(days.mon)).toBe('"Push, pull": 2.5 "push, ups", 30s "bar: hang", 10 "7"" box jumps"')
    expect(dayLine(days.tue)).toBe('5.5km/h run')
    for (const day of Object.values(days)) expect(parseDayLine(dayLine(day), ['s', 'km/h'])).toEqual({ day })
    expect(parseDayLine('10 7" box jumps')).toEqual({ error: 'a " is not closed (a name holding , : or " goes in double quotes, with "" for a quote)' })
    // A goal retyped on such a day reads, beside the rest of its line.
    const typed = customDays(days, { mon: dayLine(days.mon).replace('2.5', '3'), tue: dayLine(days.tue) })
    expect(typed).toEqual({ routine: { ...days, mon: { isMulti: true, name: 'Push, pull', plans: [{ exercise: 'push, ups', goal: 3 }, ...(days.mon?.plans.slice(1) ?? [])] } } })
  })

  test('custom days name each wrong line by weekday, keep a line left as filled, and empty a cleared one', () => {
    // A multi day of one with no name prints as a single day's line; left as filled, it stays multi.
    const base = asRoutine({ mon: { exercises: [{ exercise: 'dips', goal: 100 }] }, tue: { exercise: 'dips', goal: 100 } })
    const lines = { mon: '100 dips', tue: '100 dips, 0 pushups', wed: 'squats', thu: '', fri: '', sat: '', sun: '' }
    expect(customDays(base, lines)).toEqual({
      errors: ['Tuesday: pushups (goal must be above 0)', 'Wednesday: "squats" should read like 100 dips or 180s plank'],
    })
    expect(customDays(base, { ...lines, tue: ' 100 dips ', wed: '' })).toEqual({ routine: base })
    expect(customDays(base, { ...lines, tue: '', wed: '30 burpees' })).toEqual({
      routine: { mon: base.mon, wed: { plans: [{ exercise: 'burpees', goal: 30 }] } },
    })
  })

  test('only retyped days are written, keeping their fields and the entries the reader left out', () => {
    const raw = {
      _note: 'mine',
      mon: { exercises: [{ exercise: 'dips', goal: 100 }, { exercise: 'lunges', goal: 0 }] },
      tue: {
        name: 'Arms',
        cue: 'slow',
        exercises: [
          { exercise: 'dips', goal: 100, cue: 'deep' },
          { exercise: 'lunges', goal: 0 },
          ...['a', 'b', 'c', 'd', 'e'].map(exercise => ({ exercise, goal: 10 })),
        ],
      },
      wed: { exercise: 'squats', goal: 300, cue: 'low' },
      thu: { exercise: 'dips', goal: 50 },
    }
    const base = asRoutine(raw)
    const lines = { mon: dayLine(base.mon), tue: 'Arms: 120 dips, 10 a, 10 b', wed: '300 squats, 50 lunges', thu: '', fri: '', sat: '', sun: '' }
    const routine = routineFrom(customDays(base, lines))
    // Thursday's line was emptied, so it goes.
    expect(daysOverFile(raw, routine, base)).toEqual({
      _note: 'mine',
      mon: raw.mon,
      // Lunges (goal 0) is still left out where it stands; e, past the fifth before, would join the plan now.
      tue: { name: 'Arms', cue: 'slow', exercises: [{ exercise: 'dips', goal: 120, cue: 'deep' }, { exercise: 'a', goal: 10 }, { exercise: 'b', goal: 10 }, { exercise: 'lunges', goal: 0 }] },
      wed: { exercises: [{ exercise: 'squats', goal: 300, cue: 'low' }, { exercise: 'lunges', goal: 50 }] },
    })
  })

  test('a repeat left out of a retyped day stays while its first is typed, and goes once the line takes that out', () => {
    const raw = { mon: { exercises: [{ exercise: 'dips', goal: 100 }, { exercise: 'pushups', goal: 50 }, { exercise: 'dips', goal: 80, cue: 'x' }] } }
    const base = asRoutine(raw)
    const retyped = (line: string) => daysOverFile(raw, routineFrom(customDays(base, { mon: line })), base).mon
    expect(retyped('100 dips, 20 squats')).toEqual({ exercises: [{ exercise: 'dips', goal: 100 }, { exercise: 'squats', goal: 20 }, { exercise: 'dips', goal: 80, cue: 'x' }] })
    // With the first dips gone, the repeat would join the plan, so it goes.
    expect(retyped('50 pushups, 20 squats')).toEqual({ exercises: [{ exercise: 'pushups', goal: 50 }, { exercise: 'squats', goal: 20 }] })
  })

  test('/fit program offers Custom days after the existing choices, each line filled from the routine', async ($, on) => {
    daysWorld(on)
    await start($)
    const ui = await openDays($)
    expect((await ui.find({ key: 'program-3' }))?.props.label).toBe('○ Custom goals')
    expect((await ui.find({ key: 'program-4' }))?.props.label).toBe('● Custom days')
    expect(await ui.find({ key: 'size-Heavy' })).toBeUndefined()
    expect((await ui.find({ key: 'day-mon' }))?.props.value).toBe('100 pushups')
    expect((await ui.find({ key: 'day-wed' }))?.props.value).toBe('300 squats')
    await ui.unmount()
  })

  test('the mobile walkthrough offers no custom days', async ($, on) => {
    daysWorld(on)
    await start($)
    await fit($, 'program')
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'mobile', ...ONBOARD })
    await ui.press({ key: 'next' })
    expect(await ui.find({ key: 'program-2' })).toBeDefined()
    expect(await ui.find({ key: 'program-4' })).toBeUndefined()
    await ui.unmount()
  })

  test('typed lines write a named multi day and a one-exercise day, and freeze the days before', async ($, on) => {
    const { files } = daysWorld(on, new Map([[`${LOG}/2026-10-04`, '100\n']]))
    await start($)
    const ui = await openDays($)
    await ui.input({ key: 'day-tue', text: ARMS_LINE })
    await ui.input({ key: 'day-wed', text: '30 burpees', kind: 'change' })
    await ui.input({ key: 'day-sat', text: '' })
    expect(await ui.find({ type: 'Text', text: '100 pushups / 100 dips / 180s plank / 30 burpees' })).toBeDefined()
    await finish(ui)
    const routine = routineOf(files)
    expect(routine.tue).toEqual(ARMS_DAY)
    expect(routine.wed).toEqual({ exercise: 'burpees', goal: 30 })
    expect(routine.mon).toEqual({ exercise: 'pushups', goal: 100 })
    expect(Object.hasOwn(routine, 'sat')).toBe(false)
    expect(JSON.parse(files.get(`${LOG}/2026-10-04.swap`) ?? '{}')).toEqual({ exercise: 'pushups', goal: 100 })
  })

  test('a wrong line keeps the step open, names it, and writes nothing until every line reads', async ($, on) => {
    const { files } = daysWorld(on)
    await start($)
    const before = files.get(ROUTINE)
    const ui = await openDays($)
    await ui.input({ key: 'day-tue', text: '100 dips, 0 pushups' })
    await ui.input({ key: 'day-fri', text: 'lots of dips' })
    await ui.press({ key: 'next' })
    expect(await ui.find({ type: 'Text', text: /Pick your program/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Tuesday: pushups (goal must be above 0)' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Friday: "lots of dips" should read like 100 dips or 180s plank' })).toBeDefined()
    expect(await ui.find({ key: 'finish' })).toBeUndefined()
    expect(files.get(ROUTINE)).toBe(before)
    // Fixing one line clears its error and leaves the other line's in view.
    await ui.input({ key: 'day-tue', text: '100 dips, 50 pushups' })
    expect(await ui.find({ type: 'Text', text: 'Tuesday: pushups (goal must be above 0)' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'Friday: "lots of dips" should read like 100 dips or 180s plank' })).toBeDefined()
    await ui.input({ key: 'day-fri', text: '100 dips' })
    await finish(ui)
    expect(routineOf(files).tue).toEqual({ exercises: [{ exercise: 'dips', goal: 100 }, { exercise: 'pushups', goal: 50 }] })
  })

  test('lines left as filled write back the same plans, and routine.json keeps what it holds', async ($, on) => {
    const written = {
      _note: 'my program',
      mon: { exercises: [{ exercise: 'dips', goal: 100 }] },
      tue: { name: 'Arms day', exercises: [{ exercise: 'dips', goal: 100 }, { exercise: 'lunges', goal: 0 }, { exercise: 'plank', goal: 180, unit: 's' }] },
      wed: { exercise: 'squats', goal: 300, cue: 'low' },
    }
    const { files } = daysWorld(on, new Map([[ROUTINE, JSON.stringify(written)]]))
    await start($)
    // Keep comes first when there is a routine of their own.
    const ui = await openDays($, 'program-5')
    expect((await ui.find({ key: 'day-tue' }))?.props.value).toBe('Arms day: 100 dips, 180s plank')
    await ui.input({ key: 'day-thu', text: '20 burpees' })
    await finish(ui)
    expect(routineOf(files)).toEqual({ ...written, thu: { exercise: 'burpees', goal: 20 } })
  })

  test('a routine.json that is no JSON object is left alone, and the toast says so', async ($, on) => {
    const { files, toasts } = daysWorld(on, new Map([[ROUTINE, '[]'], [`${LOG}/2026-10-04`, '100\n']]))
    await start($)
    // Keep comes first: an unreadable file is a routine of their own, not the default.
    const ui = await openDays($, 'program-5')
    await ui.input({ key: 'day-tue', text: '30 burpees' })
    await finish(ui)
    expect(files.get(ROUTINE)).toBe('[]')
    expect(toasts).toContain('routine.json holds no JSON object, so the program was not written. Fix the file, or pick a preset.')
    expect(toasts.some(t => t.startsWith('Program set'))).toBe(false)
    // Nothing half-applied: no day frozen, no backup.
    expect(files.has(`${LOG}/2026-10-04.swap`)).toBe(false)
    expect(files.has(`${ROUTINE}.bak`)).toBe(false)
  })

  test('a routine.json that is no JSON reads as no plan, says so once, and takes no typed program', async ($, on) => {
    const { files, toasts } = daysWorld(on, new Map([[ROUTINE, '{"mon": '], [`${LOG}/2026-10-04`, '100\n']]))
    await start($)
    expect((await fit($, '')).text).toContain('0/0 reps')
    const unreadable = "routine.json doesn't read as JSON, so no day has a plan. Fix the file, or pick a program with /fit program."
    expect(toasts.filter(t => t === unreadable)).toHaveLength(1)
    const ui = await openDays($, 'program-5')
    await ui.input({ key: 'day-tue', text: '30 burpees' })
    await ui.press({ key: 'next' })
    await ui.press({ key: 'finish' })
    await ui.unmount()
    expect(files.get(ROUTINE)).toBe('{"mon": ')
    expect(toasts).toContain('routine.json holds no JSON object, so the program was not written. Fix the file, or pick a preset.')
    expect(files.has(`${LOG}/2026-10-04.swap`)).toBe(false)
    expect(files.has(`${ROUTINE}.bak`)).toBe(false)
  })

  test('a typed exercise the routine already has keeps its spelling', () => {
    const base = asRoutine({ mon: { exercise: 'Dips', goal: 100 } })
    expect(customDays(base, { mon: '100 Dips', tue: 'arms: 50 dips, 30s plank' })).toEqual({
      routine: { mon: base.mon, tue: { isMulti: true, name: 'arms', plans: [{ exercise: 'Dips', goal: 50 }, { exercise: 'plank', goal: 30, unit: 's' }] } },
    })
  })

  test('/fit help describes custom days', async ($, on) => {
    daysWorld(on)
    await start($)
    await fit($, 'help')
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...PANE, requestId: 'gym-help' })
    expect(await ui.find({ type: 'Markdown', text: /\*\*Custom days\*\*[\s\S]*arms: 100 dips, 100 pushups, 180s plank/ })).toBeDefined()
    await ui.unmount()
  })
})
