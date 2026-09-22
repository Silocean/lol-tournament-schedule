/** @typedef {{ id?: string, teams?: Array<{ code?: string, name?: string, image?: string, result?: { gameWins?: number, outcome?: string } }>, strategy?: { count?: number }, state?: string }} PlayoffMatch */

/**
 * @param {PlayoffMatch} match
 * @param {import('../src/api.js').LEAGUES['lpl']['playoff']} config
 */
export function winnerCode(match) {
  const teams = match?.teams || []
  const w = teams.find((t) => t.result?.outcome === 'win')
  if (w?.code && w.code !== 'TBD') return w.code
  const target = Math.ceil((Number(match?.strategy?.count) || 5) / 2)
  const byWins = teams.find((t) => (Number(t.result?.gameWins) || 0) >= target)
  return byWins?.code && byWins.code !== 'TBD' ? byWins.code : ''
}

/**
 * @param {PlayoffMatch} match
 * @param {{ match?: PlayoffMatch, event?: object } | null} live
 */
export function matchStatus(match, live) {
  const event = live?.event
  if (event?.state === 'inProgress') return 'live'
  const teams = match?.teams || []
  const target = Math.ceil((Number(match?.strategy?.count) || 5) / 2)
  if (teams.some((t) => (Number(t.result?.gameWins) || 0) >= target)) return 'completed'
  if (teams.some((t) => t.result?.outcome === 'win' || t.result?.outcome === 'loss')) return 'completed'
  if (match?.state === 'completed') return 'completed'
  if (match?.state === 'inProgress') return 'live'
  if (event?.startTime && Date.parse(event.startTime) <= Date.now()) return 'live'
  return 'upcoming'
}

function findStage(stages, slug) {
  return stages.find((s) => s.slug === slug)
}

function enrichMatch(match, eventById) {
  if (!match) return null
  const live = eventById.get(String(match.id))
  if (!live?.match) return { match, event: live || null }

  const standTeams = match.teams || []
  const liveTeams = live.match.teams || []
  const teams =
    liveTeams.length >= 2
      ? liveTeams.map((t, i) => {
          const stand = standTeams[i] || {}
          const code = t?.code && t.code !== 'TBD' ? t.code : stand.code
          return {
            ...stand,
            ...t,
            code: code || t?.code || stand.code,
            image: t?.image || stand.image,
            name: t?.name || stand.name,
            result:
              t?.result?.gameWins != null || t?.result?.outcome
                ? t.result
                : stand.result,
          }
        })
      : standTeams

  return {
    match: {
      ...match,
      teams: teams.length ? teams : standTeams,
      strategy: live.match.strategy || match.strategy,
      games: live.match.games || match.games,
    },
    event: live,
  }
}

function enrichEvent(event) {
  if (!event?.match) return null
  return { match: event.match, event }
}

function findStageAny(stages, slugs) {
  for (const slug of slugs || []) {
    const hit = findStage(stages, slug)
    if (hit) return hit
  }
  return null
}

/**
 * @param {object[]} standings
 * @param {object[]} events — current split schedule events
 * @param {object} config — league.playoff
 */
export function buildPlayoffData(standings, events, config) {
  if (!config?.bracket) return null

  const stages = standings?.[0]?.stages || []
  const playoffSlug = config.playoffStage || 'playoffs'
  const playoffsStage = findStage(stages, playoffSlug)
  const playoffMatches = playoffsStage?.sections?.[0]?.matches || []
  if (!playoffMatches.length) return null

  const eventById = new Map()
  for (const e of events) {
    const id = e.match?.id
    if (id) eventById.set(String(id), e)
  }

  const pick = (indices) =>
    (indices || [])
      .map((i) => enrichMatch(playoffMatches[i], eventById))
      .filter(Boolean)

  const finalEvent = events.find((e) => {
    const block = e.blockName || ''
    return block === '决赛' || (block.includes('决赛') && !block.includes('淘汰'))
  })

  const playInStage = findStageAny(
    stages,
    config.playInStages || ['playoff_play_in_knights_rival', 'playoff_play_in', 'play_ins'],
  )
  const qualifierStage = findStageAny(stages, config.qualifierStages || ['regional_qualifier'])
  const swissStage = config.swissStage ? findStage(stages, config.swissStage) : null

  const final =
    config.finalSlot != null
      ? enrichMatch(playoffMatches[config.finalSlot], eventById)
      : enrichEvent(finalEvent)

  const upper = (config.bracket.upper || []).map((col) => ({
    label: col.label,
    matches: pick(col.slots),
  }))
  const lower = (config.bracket.lower || []).map((col) => ({
    label: col.label,
    matches: pick(col.slots),
  }))

  const knights = (playInStage?.sections?.[0]?.matches || [])
    .map((m) => enrichMatch(m, eventById))
    .filter(Boolean)
  const qualifier = (qualifierStage?.sections?.[0]?.matches || [])
    .map((m) => enrichMatch(m, eventById))
    .filter(Boolean)
  const swissAll = (swissStage?.sections?.[0]?.matches || [])
    .map((m) => enrichMatch(m, eventById))
    .filter(Boolean)
  const swissKnown = swissAll.filter((item) =>
    (item.match?.teams || []).some((t) => t?.code && t.code !== 'TBD'),
  )

  return {
    bracket: { upper, lower, final },
    knights,
    qualifier,
    swiss: {
      label: config.swissLabel || '瑞士轮',
      total: swissAll.length,
      known: swissKnown,
    },
    playoffMatches: playoffMatches.map((m) => enrichMatch(m, eventById)),
  }
}

/** @param {ReturnType<typeof buildPlayoffData>} data */
export function playoffHighlight(data) {
  if (!data) return null
  const pool = [
    ...data.knights,
    ...(data.swiss?.known || []),
    ...data.playoffMatches,
    ...(data.bracket.final ? [data.bracket.final] : []),
    ...data.qualifier,
  ].filter(Boolean)

  const live = pool.find((item) => matchStatus(item.match, item) === 'live')
  if (live) return live

  const upcoming = pool
    .filter((item) => matchStatus(item.match, item) === 'upcoming' && item.event?.startTime)
    .sort((a, b) => String(a.event.startTime).localeCompare(String(b.event.startTime)))
  if (upcoming[0]) return upcoming[0]

  const done = pool
    .filter((item) => matchStatus(item.match, item) === 'completed')
    .sort((a, b) => String(b.event?.startTime || '').localeCompare(String(a.event?.startTime || '')))
  return done[0] || pool[0] || null
}

export function formatPlayoffScore(match, status) {
  const teams = match?.teams || []
  if (teams.length < 2) return 'TBD'
  const [a, b] = teams
  const aw = Number(a.result?.gameWins)
  const bw = Number(b.result?.gameWins)
  if (status === 'upcoming' && !Number.isFinite(aw) && !Number.isFinite(bw)) {
    const bo = match.strategy?.count
    return bo ? `BO${bo}` : 'VS'
  }
  return `${Number.isFinite(aw) ? aw : 0} : ${Number.isFinite(bw) ? bw : 0}`
}

/** node -e "import('./lib/playoff.js').then(m => m.selfCheck())" */
export function selfCheck() {
  const m = {
    teams: [
      { code: 'TES', result: { gameWins: 0, outcome: 'loss' } },
      { code: 'LGD', result: { gameWins: 3, outcome: 'win' } },
    ],
    strategy: { count: 5 },
    state: 'completed',
  }
  console.assert(winnerCode(m) === 'LGD', 'winnerCode')
  console.assert(matchStatus(m, null) === 'completed', 'completed status')
  console.assert(formatPlayoffScore(m, 'completed') === '0 : 3', 'score')

  // LCK S3: standings order interleaves UB Final (5) before LB R2 (6)
  const lckCfg = {
    playoffStage: 'regional_championship',
    playInStages: ['play_ins'],
    finalSlot: 9,
    bracket: {
      upper: [
        { label: '首轮', slots: [0, 1] },
        { label: '第二轮', slots: [2, 3] },
        { label: '胜者组决赛', slots: [5] },
      ],
      lower: [
        { label: '败者组首轮', slots: [4] },
        { label: '败者组第二轮', slots: [6] },
        { label: '败者组第三轮', slots: [7] },
        { label: '败者组决赛', slots: [8] },
      ],
    },
  }
  const standings = [
    {
      stages: [
        {
          slug: 'play_ins',
          sections: [{ matches: [{ id: 'pi0', teams: [{ code: 'BRO' }, { code: 'KT' }] }] }],
        },
        {
          slug: 'regional_championship',
          sections: [
            {
              matches: Array.from({ length: 10 }, (_, i) => ({
                id: `m${i}`,
                teams: [{ code: i === 0 ? 'BFX' : 'TBD' }, { code: i === 0 ? 'T1' : 'TBD' }],
              })),
            },
          ],
        },
      ],
    },
  ]
  const data = buildPlayoffData(standings, [], lckCfg)
  console.assert(data?.bracket.upper[2].matches[0]?.match?.id === 'm5', 'lck ub final slot')
  console.assert(data?.bracket.lower[1].matches[0]?.match?.id === 'm6', 'lck lb r2 slot')
  console.assert(data?.bracket.final?.match?.id === 'm9', 'lck final slot')
  console.assert(data?.knights.length === 1, 'lck play-in')
  console.log('playoff selfCheck ok')
}
