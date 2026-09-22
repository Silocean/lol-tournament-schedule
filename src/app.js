import {
  LEAGUE_ORDER,
  ROLE_CN,
  ROLE_ORDER,
  getLeague,
  loadLeagueData,
  loadSnapshot,
  readCache,
  readStoredLeagueId,
  writeStoredLeagueId,
  fetchTeamDetail,
  fetchGpr,
} from './api.js'
import {
  buildPlayoffData,
  formatPlayoffScore,
  matchStatus as playoffMatchStatus,
  playoffHighlight,
  winnerCode as playoffWinnerCode,
} from '../lib/playoff.js'

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

export const state = {
  leagueId: readStoredLeagueId(),
  splitId: '',
  filter: 'all',
  team: '',
  stage: 'all',
  events: [],
  standings: [],
  liveIds: new Set(),
  fetchedAt: null,
  source: 'live',
  teamModal: null, // { code, loading, detail, error }
  gpr: null,
  gprError: '',
  gprScope: 'all',
  gprOpen: false,
  gprExpanded: false,
  playoffOpen: false,
}

export function currentLeague() {
  return getLeague(state.leagueId)
}

export function currentSplit() {
  const splits = currentLeague().splits
  return splits.find((s) => s.id === state.splitId) || splits.find((s) => s.current) || splits[0]
}

function ensureSplitId() {
  const splits = currentLeague().splits
  if (!splits.some((s) => s.id === state.splitId)) {
    state.splitId = splits.find((s) => s.current)?.id || splits[0].id
  }
}

ensureSplitId()

export function toLocalDate(iso) {
  return new Date(Date.parse(iso))
}

export function leagueDateKey(isoOrDate) {
  const d = typeof isoOrDate === 'string' ? toLocalDate(isoOrDate) : isoOrDate
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function todayLocal() {
  return leagueDateKey(new Date())
}

/** @deprecated use todayLocal */
export function todayLeague() {
  return todayLocal()
}

export function formatDate(iso) {
  const d = toLocalDate(iso)
  return `${d.getMonth() + 1}月${d.getDate()}日 周${WEEKDAYS[d.getDay()]}`
}

export function formatTime(iso) {
  const d = toLocalDate(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function httpsUrl(url) {
  const raw = String(url || '').trim()
  if (!raw) return ''
  if (raw.startsWith('//')) return `https:${raw}`
  return raw.replace(/^http:\/\//i, 'https://')
}

function teamImg(url, alt = '', extraClass = '') {
  const src = httpsUrl(url)
  const cls = extraClass ? ` class="${extraClass}"` : ''
  if (!src) return `<span class="team-img-fallback" aria-hidden="true"></span>`
  return `<img${cls} src="${src}" alt="${escapeHtml(alt)}" loading="lazy" decoding="async" />`
}

export function teamLabel(team) {
  const names = currentLeague().teamNames || {}
  return names[team.code] || team.name || team.code
}

export function stageOf(event) {
  const block = event.blockName || ''
  if (block.includes('资格')) return 'qualifier'
  if (block.includes('骑士') || block.includes('入围')) return 'knights'
  if (block.includes('瑞士')) return 'regular'
  if (
    block.includes('淘汰') ||
    block.includes('决赛') ||
    block.includes('四分') ||
    block.includes('半决')
  ) {
    return 'playoffs'
  }
  return 'regular'
}

function seriesTargetWins(event) {
  return Math.ceil((Number(event.match?.strategy?.count) || 1) / 2)
}

function isSeriesDecided(event) {
  const teams = event.match?.teams || []
  const target = seriesTargetWins(event)
  const wins = teams.map((t) => Number(t.result?.gameWins) || 0)
  if (wins.some((w) => w >= target)) return true
  if (target === 1) {
    return teams.some((t) => t.result?.outcome === 'win' || t.result?.outcome === 'loss')
  }
  return false
}

function gamesPlayed(event) {
  return (event.match?.teams || []).reduce((sum, t) => sum + (Number(t.result?.gameWins) || 0), 0)
}

function hasGameplayStarted(event) {
  if (gamesPlayed(event) > 0) return true
  return (event.match?.games || []).some((g) => g.state === 'inProgress' || g.state === 'completed')
}

function liveGameLabel(event) {
  const games = event.match?.games || []
  const playing = games.find((g) => g.state === 'inProgress')
  if (playing?.number) return `第${playing.number}局`
  const played = gamesPlayed(event)
  if (played > 0) return `第${played + 1}局`
  return ''
}

export function matchStatus(event, now = Date.now()) {
  if (isSeriesDecided(event)) return 'completed'
  if (hasGameplayStarted(event)) return 'live'
  if (event.state === 'inProgress') return 'live'
  if (state.liveIds.has(String(event.match?.id || ''))) return 'live'

  const start = Date.parse(event.startTime)
  const started = Number.isFinite(start) && start <= now

  // 赛程 API 有时在赛果同步前就把 state 标成 completed（0-0 且无 outcome）
  if (event.state === 'completed' && started) return 'live'

  if (!started) return 'upcoming'
  return 'upcoming'
}

export function countdown(iso, now = Date.now()) {
  let diff = Date.parse(iso) - now
  if (diff <= 0) return ''
  const days = Math.floor(diff / 86400000)
  diff %= 86400000
  const hours = Math.floor(diff / 3600000)
  diff %= 3600000
  const mins = Math.floor(diff / 60000)
  if (days > 0) return `${days}天${hours}时后`
  if (hours > 0) return `${hours}时${mins}分后`
  return `${mins}分钟后`
}

export function venueForDate(iso) {
  const split = currentSplit()
  if (!split.venues) return null
  const key = leagueDateKey(iso)
  return split.venues.find((v) => key >= v.start && key <= v.end) || null
}

export function activeVenue() {
  const split = currentSplit()
  if (!split.venues) return null
  const today = todayLeague()
  return (
    split.venues.find((v) => today >= v.start && today <= v.end) ||
    split.venues.find((v) => today < v.start) ||
    split.venues.at(-1)
  )
}

export function splitEvents() {
  const split = currentSplit()
  return state.events.filter((e) => {
    if (e.type && e.type !== 'match') return false
    const teams = e.match?.teams || []
    if (!teams.some((t) => t?.code && t.code !== 'TBD')) return false
    const day = leagueDateKey(e.startTime)
    return day >= split.start && day <= split.end
  })
}

function playoffEvents() {
  const split = currentSplit()
  const list = state.events.filter((e) => {
    if (e.type && e.type !== 'match') return false
    const block = e.blockName || ''
    if (!block.match(/淘汰|决赛|资格|入围|瑞士|四分|半决/)) return false
    const day = leagueDateKey(e.startTime)
    return day >= split.start && day <= split.end
  })
  for (const e of state.events) {
    if (e.type && e.type !== 'match') continue
    if ((e.blockName || '') !== '决赛') continue
    const day = leagueDateKey(e.startTime)
    if (day < split.start || day > split.end) continue
    if (!list.some((x) => String(x.match?.id) === String(e.match?.id))) list.push(e)
  }
  return list
}

export function filteredEvents() {
  const today = todayLeague()
  return splitEvents()
    .filter((e) => {
      const status = matchStatus(e)
      if (state.filter === 'today') return leagueDateKey(e.startTime) === today
      if (state.filter === 'upcoming') return status === 'upcoming' || status === 'live'
      if (state.filter === 'completed') return status === 'completed'
      return true
    })
    .filter((e) => (state.stage === 'all' ? true : stageOf(e) === state.stage))
    .filter((e) => {
      if (!state.team) return true
      return (e.match?.teams || []).some((t) => t.code === state.team)
    })
}

export function teamCodes() {
  const codes = new Map()
  for (const event of splitEvents()) {
    for (const team of event.match?.teams || []) {
      if (team.code) codes.set(team.code, team)
    }
  }
  return [...codes.values()]
    .filter((t) => t.code && t.code !== 'TBD')
    .sort((a, b) => a.code.localeCompare(b.code))
}

export function gameDiffMap() {
  const map = new Map()
  for (const event of splitEvents()) {
    if (matchStatus(event) !== 'completed') continue
    const teams = event.match?.teams || []
    if (teams.length < 2) continue
    const [a, b] = teams
    const aw = a.result?.gameWins || 0
    const bw = b.result?.gameWins || 0
    const recA = map.get(a.code) || { gf: 0, ga: 0 }
    const recB = map.get(b.code) || { gf: 0, ga: 0 }
    recA.gf += aw
    recA.ga += bw
    recB.gf += bw
    recB.ga += aw
    map.set(a.code, recA)
    map.set(b.code, recB)
  }
  return map
}

export function normalizeSections(standings) {
  const stages = standings?.[0]?.stages || []
  const groupStage = pickStandingsStage(stages)
  const ascent = new Set(currentLeague().ascentTeams || [])
  const nirvana = new Set(currentLeague().nirvanaTeams || [])
  const sections = (groupStage?.sections || [])
    .map((section) => {
      const rankings = sectionHasRankings(section)
        ? section.rankings
        : rankingsFromMatches(section.matches)
      const codes = new Set((rankings || []).flatMap((row) => (row.teams || []).map((t) => t.code)))
      const ascentN = [...codes].filter((c) => ascent.has(c)).length
      const nirvanaN = [...codes].filter((c) => nirvana.has(c)).length
      let name = section.name
      if (ascentN >= 6) name = '登峰组'
      else if (nirvanaN >= 3) name = '涅槃组'
      else if ((groupStage?.slug === 'swiss' || (section.name || '').includes('瑞士')) && name) {
        name = section.name || '瑞士轮'
      }
      return { ...section, name, rankings }
    })
    .filter((section) => (section.rankings || []).some((row) => (row.teams || []).length))
  const order = { 登峰组: 0, 涅槃组: 1, 传奇组: 0, 突破组: 1, 瑞士轮: 0 }
  sections.sort((a, b) => (order[a.name] ?? 9) - (order[b.name] ?? 9))
  return sections
}

function sectionHasRankings(section) {
  return (section?.rankings || []).some((row) => (row.teams || []).length)
}

function stageHasStandings(stage) {
  return (stage?.sections || []).some(
    (section) =>
      sectionHasRankings(section) ||
      (section.matches || []).some((m) => m.state === 'completed' && (m.teams || []).length >= 2),
  )
}

function pickStandingsStage(stages) {
  const preferred = ['group_stage', 'groups', 'regular_season', 'swiss']
  for (const slug of preferred) {
    const stage = stages.find((s) => s.slug === slug)
    if (stage && stageHasStandings(stage)) return stage
  }
  return stages.find(stageHasStandings) || stages[0]
}

function rankingsFromMatches(matches) {
  const rec = new Map()
  for (const match of matches || []) {
    if (match.state !== 'completed') continue
    const teams = match.teams || []
    if (teams.length < 2) continue
    for (const team of teams) {
      if (!team?.code || team.code === 'TBD') continue
      const row = rec.get(team.code) || {
        code: team.code,
        name: team.name,
        image: team.image,
        record: { wins: 0, losses: 0 },
      }
      row.name = team.name || row.name
      row.image = team.image || row.image
      if (team.result?.outcome === 'win') row.record.wins += 1
      else if (team.result?.outcome === 'loss') row.record.losses += 1
      rec.set(team.code, row)
    }
  }
  const sorted = [...rec.values()].sort(
    (a, b) => b.record.wins - a.record.wins || a.record.losses - b.record.losses || a.code.localeCompare(b.code),
  )
  const rankings = []
  let ordinal = 0
  let prevKey = ''
  sorted.forEach((team, index) => {
    const key = `${team.record.wins}-${team.record.losses}`
    if (key !== prevKey) {
      ordinal = index + 1
      prevKey = key
    }
    rankings.push({ ordinal, teams: [team] })
  })
  return rankings
}

function promotionTag(groupName, rank, groupSize, team) {
  if ((groupName || '').includes('瑞士')) {
    const wins = team?.record?.wins ?? 0
    const losses = team?.record?.losses ?? 0
    if (wins >= 3) return { text: '晋级', cls: 'ok' }
    if (losses >= 3) return { text: '淘汰', cls: 'bad' }
    return { text: '进行中', cls: 'warn' }
  }
  if (groupName === '登峰组' || groupName === '传奇组') {
    if (rank <= (groupName === '传奇组' ? 2 : 6)) return { text: '直接晋级', cls: 'ok' }
    return { text: groupName === '传奇组' ? '竞争区' : '骑士之路', cls: 'warn' }
  }
  if (groupName === '涅槃组' || groupName === '突破组') {
    if (rank <= 2) return { text: groupName === '突破组' ? '入围赛' : '骑士之路', cls: 'warn' }
    return { text: '淘汰区', cls: 'bad' }
  }
  if (rank <= Math.ceil(groupSize / 2)) return { text: '晋级区', cls: 'ok' }
  return { text: '', cls: '' }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function teamMini(team, right = false) {
  const code = team.code || ''
  const clickable = code && code !== 'TBD'
  const cls = ['team-mini', right ? 'right' : ''].filter(Boolean).join(' ')
  const body = `${teamImg(team.image, code)}<b>${escapeHtml(code)}</b>`
  if (!clickable) return `<div class="${cls}">${body}</div>`
  return `<div class="${cls}"><button type="button" class="team-hit" data-open-team="${escapeHtml(code)}" title="查看 ${escapeHtml(code)} 详情">${body}</button></div>`
}

function teamCell(team, align = 'left', winnerCode) {
  const code = team.code || ''
  const clickable = code && code !== 'TBD'
  const cls = [
    'team',
    align === 'right' ? 'right' : '',
    winnerCode && team.code === winnerCode ? 'winner' : '',
    winnerCode && team.code !== winnerCode ? 'loser' : '',
  ]
    .filter(Boolean)
    .join(' ')
  const body = `
      ${teamImg(team.image, code)}
      <b>${escapeHtml(code)}</b>
  `
  if (!clickable) return `<div class="${cls}">${body}</div>`
  return `
    <div class="${cls}">
      <button type="button" class="team-hit" data-open-team="${escapeHtml(code)}" title="查看 ${escapeHtml(code)} 详情">
        ${body}
      </button>
    </div>
  `
}

function statusBadge(status, event) {
  const now = Date.now()
  if (status === 'live') {
    const game = liveGameLabel(event)
    return `<span class="badge live">LIVE${game ? ` · ${escapeHtml(game)}` : ''}</span>`
  }
  if (status === 'upcoming') {
    const start = Date.parse(event.startTime)
    let text = countdown(event.startTime) || '未开始'

    // 开赛时间到了但 live 数据尚未标记 inProgress（例如延迟/还没开始加载局间数据）
    if (Number.isFinite(start) && start <= now) {
      const mins = Math.floor((now - start) / 60000)
      text = mins <= 10 ? `等待开打` : mins <= 45 ? `已延迟${mins}分` : `可能进行中`
    }
    return `<span class="badge soon">${escapeHtml(text)}</span>`
  }
  return `<span class="badge done">已结束</span>`
}

export function renderClock() {
  const el = document.querySelector('#clock')
  if (!el) return
  const now = new Date()
  el.textContent = `本地时间 ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`
}

export function renderSync(text, cls = '') {
  const el = document.querySelector('#sync-status')
  if (!el) return
  el.className = `sync ${cls}`
  el.textContent = text
}

export function renderBrand() {
  const league = currentLeague()
  const mark = document.querySelector('.brand-mark')
  const title = document.querySelector('.brand h1')
  const sub = document.querySelector('.brand p')
  if (mark) {
    mark.textContent = 'LoL'
    mark.classList.remove('is-long')
  }
  if (title) title.textContent = '全球赛事赛程'
  if (sub) sub.textContent = `${league.code} · ${league.region} · 2026`
  document.title = `全球赛事赛程 | ${league.code} 2026`

  const switchEl = document.querySelector('#league-switch')
  if (switchEl) {
    switchEl.innerHTML = LEAGUE_ORDER.map((id) => {
      const item = getLeague(id)
      const active = id === state.leagueId
      return `<button type="button" class="league-btn${active ? ' active' : ''}" data-league="${id}" role="radio" aria-checked="${active ? 'true' : 'false'}" title="${escapeHtml(item.name)}">${escapeHtml(item.code)}</button>`
    }).join('')
  }
}

export function renderHero() {
  const league = currentLeague()
  const split = currentSplit()
  const today = todayLeague()
  const todays = splitEvents()
    .filter((e) => leagueDateKey(e.startTime) === today)
    .sort((a, b) => a.startTime.localeCompare(b.startTime))

  const title = `${split.name}赛程`
  const subtitle = `${split.start.replaceAll('-', '.')} - ${split.end.replaceAll('-', '.')}`

  const next = splitEvents()
    .filter((e) => matchStatus(e) === 'upcoming' || matchStatus(e) === 'live')
    .sort((a, b) => a.startTime.localeCompare(b.startTime))[0]
  const nextHome = next?.match?.teams?.[0]?.code || ''
  const nextAway = next?.match?.teams?.[1]?.code || ''
  const nextLabel = next
    ? `下一场 ${formatTime(next.startTime)} ${nextHome} vs ${nextAway}`
    : ''

  document.querySelector('#hero').innerHTML = `
    <article class="hero-card">
      <div class="kicker">${escapeHtml(league.code)} 2026 · ${escapeHtml(split.name)}</div>
      <h2>${escapeHtml(title)}</h2>
      <p>${escapeHtml(subtitle)}${nextLabel ? ` · ${escapeHtml(nextLabel)}` : ''}</p>
    </article>
    <div class="today-list${todays.length ? '' : ' is-empty'}">
      <h3>今日赛程</h3>
      ${
        todays.length
          ? todays
              .map((event) => {
                const [home, away] = event.match?.teams || [{}, {}]
                const status = matchStatus(event)
                const score =
                  status === 'upcoming'
                    ? '<span class="vs">VS</span>'
                    : `${home.result?.gameWins ?? 0} : ${away.result?.gameWins ?? 0}`
                return `
                  <article class="today-card">
                    <div class="time">${formatTime(event.startTime)}<div>${statusBadge(status, event)}</div></div>
                    ${teamMini(home)}
                    <div class="score-mini">${score}</div>
                    ${teamMini(away, true)}
                  </article>
                `
              })
              .join('')
          : `<div class="today-empty">
              <strong>${
                currentLeague().overview && !nextLabel
                  ? '世界赛赛程待公布'
                  : '今日暂无比赛'
              }</strong>
              <p>${
                nextLabel
                  ? escapeHtml(nextLabel)
                  : currentLeague().overview
                    ? escapeHtml(
                        `${currentLeague().overview.subtitle || ''} · 展开上方对阵面板查看阶段与场馆`,
                      )
                    : '本赛段后续赛程见下方列表'
              }</p>
            </div>`
      }
    </div>
  `

  const venuesEl = document.querySelector('#venues')
  if (venuesEl) {
    venuesEl.innerHTML = ''
    venuesEl.style.display = 'none'
  }
}

function formatGprDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

function gprDelta(team) {
  if (team.prevRank == null) return { text: '—', cls: '' }
  const diff = team.prevRank - team.rank
  if (diff > 0) return { text: `↑${diff}`, cls: 'up' }
  if (diff < 0) return { text: `↓${Math.abs(diff)}`, cls: 'down' }
  return { text: '→', cls: 'same' }
}

export function renderGpr() {
  const root = document.querySelector('#gpr')
  if (!root) return
  const data = state.gpr
  if (!data && state.gprError) {
    root.classList.add('is-collapsed')
    root.innerHTML = `<div class="gpr-empty">全球战力榜暂时无法加载</div>`
    return
  }
  if (!data) {
    root.classList.add('is-collapsed')
    root.innerHTML = `<div class="gpr-empty">正在加载全球战力榜…</div>`
    return
  }

  const league = currentLeague()
  const leagueTeams = data.teams.filter(
    (t) => t.leagueSlug === league.slug || t.league === league.code,
  )
  const scoped = state.gprScope === 'league' ? leagueTeams : data.teams
  const open = state.gprOpen
  const limit = state.gprExpanded ? 24 : 12
  const shown = open ? scoped.slice(0, limit) : []
  const canExpand = open && scoped.length > 12
  const preview = data.teams.slice(0, 3)
  root.classList.toggle('is-collapsed', !open)

  root.innerHTML = `
    <div class="gpr-top">
      <button type="button" class="gpr-toggle" data-gpr-open aria-expanded="${open ? 'true' : 'false'}" aria-label="${open ? '收起全球战力榜' : '展开全球战力榜'}">
        <div>
          <h2>全球战力榜</h2>
          <p class="hint">${data.updatedAt ? `${formatGprDate(data.updatedAt)} 更新` : '官方 GPR'} · 跨赛区综合实力</p>
        </div>
        ${
          open
            ? ''
            : `<div class="gpr-preview">
                ${preview
                  .map(
                    (team) =>
                      `<span><b>#${team.rank}</b> ${escapeHtml(team.code)} ${team.gpr}</span>`,
                  )
                  .join('')}
              </div>`
        }
      </button>
      ${
        open
          ? `<div class="gpr-actions">
              <div class="gpr-scope" role="radiogroup" aria-label="战力榜范围">
                <button type="button" class="${state.gprScope === 'all' ? 'active' : ''}" data-gpr-scope="all" role="radio" aria-checked="${state.gprScope === 'all'}">全球 Top</button>
                <button type="button" class="${state.gprScope === 'league' ? 'active' : ''}" data-gpr-scope="league" role="radio" aria-checked="${state.gprScope === 'league'}">${escapeHtml(league.code)}</button>
              </div>
              <a class="gpr-official" href="https://lolesports.com/en-GB/gpr/2026/current" target="_blank" rel="noopener noreferrer">官方榜单</a>
            </div>`
          : ''
      }
    </div>
    ${
      open
        ? `
    <div class="gpr-body">
      <div class="gpr-leagues">
        ${(data.leagues || [])
          .map((item) => {
            const active = item.slug === league.slug || item.name === league.code
            return `
              <div class="gpr-league${active ? ' is-current' : ''}">
                ${teamImg(item.image, item.name, 'gpr-league-img')}
                <b>${escapeHtml(item.name)}</b>
                <span>${item.elo}</span>
              </div>
            `
          })
          .join('')}
      </div>
      <div class="gpr-list">
        ${
          shown.length
            ? shown
                .map((team) => {
                  const delta = gprDelta(team)
                  const home = team.leagueSlug === league.slug || team.league === league.code
                  return `
                    <article class="gpr-row${home ? ' is-home' : ''}">
                      <span class="gpr-rank">${team.rank}</span>
                      <button type="button" class="team-hit" data-open-team="${escapeHtml(team.code)}" title="查看 ${escapeHtml(team.code)} 详情">
                        ${teamImg(team.image, team.code)}
                        <b>${escapeHtml(team.code)}</b>
                      </button>
                      <span class="gpr-league-tag">${escapeHtml(team.league)}</span>
                      <span class="gpr-score">${team.gpr}</span>
                      <span class="gpr-delta ${delta.cls}">${delta.text}</span>
                    </article>
                  `
                })
                .join('')
            : `<div class="gpr-empty">当前联赛暂无上榜战队</div>`
        }
      </div>
      ${
        canExpand
          ? `<button type="button" class="gpr-more" data-gpr-expand>${state.gprExpanded ? '显示更少' : `显示更多（${scoped.length}）`}</button>`
          : ''
      }
    </div>`
        : ''
    }
  `
}

export function bindGprEvents() {
  if (bindGprEvents.bound) return
  bindGprEvents.bound = true
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-gpr-open]')) {
      state.gprOpen = !state.gprOpen
      if (!state.gprOpen) state.gprExpanded = false
      renderGpr()
      return
    }
    const scopeBtn = e.target.closest('[data-gpr-scope]')
    if (scopeBtn) {
      state.gprScope = scopeBtn.getAttribute('data-gpr-scope') === 'league' ? 'league' : 'all'
      state.gprExpanded = false
      renderGpr()
      return
    }
    if (e.target.closest('[data-gpr-expand]')) {
      state.gprExpanded = !state.gprExpanded
      renderGpr()
    }
  })
}

export async function loadGprPanel({ force = false } = {}) {
  try {
    state.gpr = await fetchGpr({ force })
    state.gprError = ''
  } catch (err) {
    console.warn('gpr failed', err)
    if (!state.gpr) state.gprError = 'failed'
  }
  renderGpr()
}

function playoffPreviewText(item) {
  if (!item?.match) return ''
  const teams = item.match.teams || []
  const [a, b] = teams
  const codeA = a?.code && a.code !== 'TBD' ? a.code : '待定'
  const codeB = b?.code && b.code !== 'TBD' ? b.code : '待定'
  const status = playoffMatchStatus(item.match, item)
  const score = formatPlayoffScore(item.match, status)
  const label = item.event?.blockName || ''
  return `${codeA} ${score} ${codeB}${label ? ` · ${label}` : ''}`
}

function bracketTeamRow(team, winner, align = 'left') {
  const code = team?.code && team.code !== 'TBD' ? team.code : '待定'
  const clickable = code !== '待定'
  const cls = [
    'team',
    align === 'right' ? 'right' : '',
    winner && team?.code === winner ? 'winner' : '',
    winner && team?.code && team.code !== winner ? 'loser' : '',
  ]
    .filter(Boolean)
    .join(' ')
  const body = `${teamImg(team?.image, code)}<b>${escapeHtml(code)}</b>`
  if (!clickable) return `<div class="${cls}">${body}</div>`
  return `
    <div class="${cls}">
      <button type="button" class="team-hit" data-open-team="${escapeHtml(code)}" title="查看 ${escapeHtml(code)} 详情">
        ${body}
      </button>
    </div>
  `
}

function hidePlayoffPanel(root) {
  root.hidden = true
  root.classList.add('is-collapsed')
  root.innerHTML = ''
}

function renderBracketMatch(item, label = '') {
  if (!item?.match) return ''
  const match = item.match
  const teams = match.teams || [{ code: 'TBD' }, { code: 'TBD' }]
  const [home, away] = teams.length >= 2 ? teams : [teams[0], { code: 'TBD' }]
  const status = playoffMatchStatus(match, item)
  const winner = status === 'completed' ? playoffWinnerCode(match) : ''
  const score = formatPlayoffScore(match, status)
  const time = item.event?.startTime ? formatTime(item.event.startTime) : ''
  const day = item.event?.startTime ? formatDate(item.event.startTime).split(' ')[0] : ''
  return `
    <article class="bracket-match ${status === 'live' ? 'is-live' : ''}">
      ${label ? `<div class="bracket-match-label">${escapeHtml(label)}</div>` : ''}
      <div class="bracket-row">
        ${bracketTeamRow(home, winner)}
        <div class="bracket-score">${escapeHtml(score)}</div>
        ${bracketTeamRow(away, winner, 'right')}
      </div>
      <div class="bracket-meta">
        ${status === 'live' ? `<span class="badge live">LIVE</span>` : status === 'upcoming' && time ? `<span class="badge soon">${escapeHtml(day)} ${escapeHtml(time)}</span>` : status === 'completed' ? `<span class="badge done">已结束</span>` : ''}
      </div>
    </article>
  `
}

function renderBracketColumns(columns) {
  return columns
    .map(
      (col) => `
        <div class="bracket-col">
          <div class="bracket-col-label">${escapeHtml(col.label)}</div>
          <div class="bracket-col-matches">
            ${col.matches.map((item) => renderBracketMatch(item)).join('')}
          </div>
        </div>
      `,
    )
    .join('')
}

export function renderPlayoffBracket() {
  const root = document.querySelector('#playoff')
  if (!root) return
  const league = currentLeague()
  const config = league.playoff
  if (!config) {
    hidePlayoffPanel(root)
    return
  }

  const data = buildPlayoffData(state.standings, playoffEvents(), config)
  if (!data) {
    hidePlayoffPanel(root)
    return
  }

  root.hidden = false
  const open = state.playoffOpen
  const highlight = playoffHighlight(data)
  const preview = highlight ? playoffPreviewText(highlight) : config.label || '对阵图'
  root.classList.toggle('is-collapsed', !open)

  const playInLabel = config.playInLabel || '入围赛'
  const formatHint = config.format || '双败淘汰'
  const upperLabel = config.upperLabel || '胜者组'
  const hasLower = data.bracket.lower.some((col) => col.matches.length)
  const overview = league.overview

  const overviewHtml = overview
    ? `
      <div class="playoff-overview">
        <div class="playoff-overview-head">
          <strong>${escapeHtml(overview.title || config.label || '赛程概览')}</strong>
          ${overview.subtitle ? `<span>${escapeHtml(overview.subtitle)}</span>` : ''}
        </div>
        <div class="playoff-overview-stages">
          ${(overview.stages || [])
            .map(
              (stage) => `
            <article class="playoff-overview-card">
              <div class="playoff-overview-name">${escapeHtml(stage.name || '')}</div>
              <div class="playoff-overview-date">${escapeHtml(stage.date || '')}</div>
              <div class="playoff-overview-venue">${escapeHtml(stage.venue || '')}</div>
              ${stage.note ? `<p>${escapeHtml(stage.note)}</p>` : ''}
            </article>`,
            )
            .join('')}
        </div>
      </div>`
    : ''

  const knightsHtml = data.knights.length
    ? `
      <div class="playoff-knights">
        <h3>${escapeHtml(playInLabel)}</h3>
        <div class="playoff-knights-matches">
          ${data.knights.map((item) => renderBracketMatch(item)).join('')}
        </div>
      </div>`
    : ''

  const swiss = data.swiss
  const swissHtml =
    swiss && swiss.total
      ? `
      <div class="playoff-swiss">
        <h3>${escapeHtml(swiss.label || '瑞士轮')}</h3>
        ${
          swiss.known.length
            ? `<div class="playoff-swiss-matches">
                ${swiss.known.map((item) => renderBracketMatch(item)).join('')}
              </div>
              ${
                swiss.known.length < swiss.total
                  ? `<p class="hint">已确定 ${swiss.known.length} / ${swiss.total} 场 · 其余对阵待抽签公布</p>`
                  : ''
              }`
            : `<div class="playoff-swiss-placeholder">
                <p><strong>${swiss.total} 场赛程占位已就绪</strong></p>
                <p class="hint">16 支队伍 · 先到 3 胜晋级八强 · 对阵与开赛时间待官方公布</p>
              </div>`
        }
      </div>`
      : ''

  const qualifierHtml = data.qualifier.length
    ? `
      <div class="playoff-qualifier">
        <h3>赛区资格赛</h3>
        <div class="playoff-qualifier-matches">
          ${data.qualifier.map((item, i) => renderBracketMatch(item, `R${i + 1}`)).join('')}
        </div>
      </div>`
    : ''

  const finalHtml = data.bracket.final
    ? `
      <div class="playoff-grand">
        <h3>总决赛</h3>
        ${renderBracketMatch(data.bracket.final)}
      </div>`
    : ''

  root.innerHTML = `
    <div class="playoff-top">
      <button type="button" class="playoff-toggle" data-playoff-open aria-expanded="${open ? 'true' : 'false'}" aria-label="${open ? '收起对阵图' : '展开对阵图'}">
        <div>
          <h2>${escapeHtml(config.label || '季后赛对阵')}</h2>
          <p class="hint">${escapeHtml(currentSplit().name)} · ${escapeHtml(formatHint)} · 实时同步赛程</p>
        </div>
        ${open ? '' : `<div class="playoff-preview">${escapeHtml(preview)}</div>`}
      </button>
    </div>
    ${
      open
        ? `
    <div class="playoff-body">
      ${overviewHtml}
      ${knightsHtml}
      ${swissHtml}
      <div class="playoff-bracket">
        <div class="playoff-bracket-section">
          <h3>${escapeHtml(upperLabel)}</h3>
          <div class="bracket-columns">${renderBracketColumns(data.bracket.upper)}</div>
        </div>
        ${
          hasLower
            ? `<div class="playoff-bracket-section">
          <h3>败者组</h3>
          <div class="bracket-columns">${renderBracketColumns(data.bracket.lower)}</div>
        </div>`
            : ''
        }
      </div>
      ${finalHtml}
      ${qualifierHtml}
    </div>`
        : ''
    }
  `
}

export function bindPlayoffEvents() {
  if (bindPlayoffEvents.bound) return
  bindPlayoffEvents.bound = true
  document.addEventListener('click', (e) => {
    if (!e.target.closest('[data-playoff-open]')) return
    state.playoffOpen = !state.playoffOpen
    renderPlayoffBracket()
  })
}

export function renderFilters() {
  const teams = teamCodes()
  const splits = currentLeague().splits
  const stageFilters = currentLeague().stageFilters || []
  document.querySelector('#filters').innerHTML = `
    <div class="filter-chips">
    ${['all:全部', 'today:今日', 'upcoming:未赛', 'completed:赛果']
      .map((item) => {
        const [id, label] = item.split(':')
        return `<button type="button" class="chip ${state.filter === id ? 'active' : ''}" data-filter="${id}">${label}</button>`
      })
      .join('')}
    </div>
    <div class="filter-selects">
    <select class="select" data-stage>
      ${stageFilters
        .map(
          (s) =>
            `<option value="${escapeHtml(s.id)}" ${state.stage === s.id ? 'selected' : ''}>${escapeHtml(s.label)}</option>`,
        )
        .join('')}
    </select>
    <select class="select" data-team>
      <option value="">全部战队</option>
      ${teams
        .map(
          (t) =>
            `<option value="${escapeHtml(t.code)}" ${state.team === t.code ? 'selected' : ''}>${escapeHtml(t.code)} · ${escapeHtml(teamLabel(t))}</option>`,
        )
        .join('')}
    </select>
    <select class="select" data-split>
      ${splits
        .map(
          (s) =>
            `<option value="${s.id}" ${state.splitId === s.id ? 'selected' : ''}>${escapeHtml(s.name)}</option>`,
        )
        .join('')}
    </select>
    </div>
  `

  document.querySelector('#filters').onclick = (e) => {
    const btn = e.target.closest('[data-filter]')
    if (!btn) return
    state.filter = btn.dataset.filter
    renderAll()
  }
  document.querySelector('#filters').onchange = async (e) => {
    const el = e.target
    if (el.matches('[data-team]')) state.team = el.value
    if (el.matches('[data-stage]')) state.stage = el.value
    if (el.matches('[data-split]')) {
      state.splitId = el.value
      state.team = ''
      state.filter = 'all'
      await bootstrap({ silent: true, force: false })
      return
    }
    renderAll()
  }
}

export function renderSchedule() {
  const events = filteredEvents()
  const root = document.querySelector('#schedule')
  if (!events.length) {
    const overview = currentLeague().overview
    if (overview) {
      root.innerHTML = `
        <div class="empty empty-rich">
          <strong>${escapeHtml(overview.title || '赛程即将公布')}</strong>
          <p>${escapeHtml(overview.subtitle || '官方赛程与对阵发布后将自动同步到此')}</p>
          <ul class="empty-stages">
            ${(overview.stages || [])
              .map(
                (s) =>
                  `<li><b>${escapeHtml(s.name || '')}</b> ${escapeHtml(s.date || '')} · ${escapeHtml(s.venue || '')}</li>`,
              )
              .join('')}
          </ul>
        </div>`
    } else {
      root.innerHTML = `<div class="empty">没有符合筛选条件的比赛</div>`
    }
    return
  }

  const groups = new Map()
  for (const event of events) {
    const key = leagueDateKey(event.startTime)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(event)
  }

  root.innerHTML = [...groups.entries()]
    .map(([day, list]) => {
      const venue = venueForDate(list[0].startTime)
      return `
        <section class="day-group">
          <div class="day-title">
            <strong>${formatDate(list[0].startTime)}</strong>
            <span>${venue ? `${venue.city} · ${venue.host}` : list[0].blockName || ''}</span>
          </div>
          ${list
            .map((event) => {
              const [home, away] = event.match?.teams || [{ code: 'TBD' }, { code: 'TBD' }]
              const status = matchStatus(event)
              const winner =
                status === 'completed'
                  ? home.result?.outcome === 'win'
                    ? home.code
                    : away.result?.outcome === 'win'
                      ? away.code
                      : ''
                  : ''
              const score =
                status === 'upcoming'
                  ? `<div class="vs">VS</div><small>${event.match?.strategy?.count ? `BO${event.match.strategy.count}` : ''}</small>`
                  : `${home.result?.gameWins ?? 0} : ${away.result?.gameWins ?? 0}`
              return `
                <article class="match ${status === 'live' ? 'live-row' : ''}">
                  <div class="time-col">
                    <b>${formatTime(event.startTime)}</b>
                    ${statusBadge(status, event)}
                  </div>
                  ${teamCell(home, 'left', winner)}
                  <div class="score">${score}</div>
                  ${teamCell(away, 'right', winner)}
                  <div class="match-meta">${escapeHtml(event.blockName || '')}<br>${escapeHtml(event.match?.strategy?.count ? `BO${event.match.strategy.count}` : '')}</div>
                </article>
              `
            })
            .join('')}
        </section>
      `
    })
    .join('')
}

export function renderStandings() {
  const sections = normalizeSections(state.standings)
  const diffs = gameDiffMap()
  const root = document.querySelector('#standings')
  if (!sections.length) {
    const overview = currentLeague().overview
    root.innerHTML = overview
      ? `<div class="empty empty-rich">
          <strong>积分 / 瑞士轮战绩待更新</strong>
          <p>出线队伍与赛果同步后将显示于此。可先查看上方「世界赛对阵」占位图。</p>
        </div>`
      : `<div class="empty">暂无积分榜</div>`
    return
  }

  root.innerHTML = sections
    .map((section) => {
      const rows = []
      for (const group of section.rankings || []) {
        for (const team of group.teams || []) {
          rows.push({ rank: group.ordinal, team })
        }
      }
      return `
        <section class="table">
          <h3>${escapeHtml(section.name)}</h3>
          <table>
            <thead>
              <tr><th>#</th><th>战队</th><th>胜负</th><th>净胜</th><th></th></tr>
            </thead>
            <tbody>
              ${rows
                .map(({ rank, team }) => {
                  const rec = team.record || {}
                  const diff = diffs.get(team.code)
                  const diffText = diff ? `${diff.gf - diff.ga > 0 ? '+' : ''}${diff.gf - diff.ga}` : '-'
                  const tag = promotionTag(section.name, rank, rows.length, team)
                  return `
                    <tr>
                      <td class="rank">${rank}</td>
                      <td>
                        <div class="rank-team">
                          <button type="button" class="team-hit" data-open-team="${escapeHtml(team.code)}" title="查看 ${escapeHtml(team.code)} 详情">
                            ${teamImg(team.image, team.code)}
                            <b>${escapeHtml(team.code)}</b>
                          </button>
                        </div>
                      </td>
                      <td>${rec.wins ?? 0}-${rec.losses ?? 0}</td>
                      <td>${diffText}</td>
                      <td>${tag.text ? `<span class="tag ${tag.cls}">${tag.text}</span>` : ''}</td>
                    </tr>
                  `
                })
                .join('')}
            </tbody>
          </table>
        </section>
      `
    })
    .join('')
}

function hideBootScreen() {
  const el = document.querySelector('#boot-screen')
  if (!el || el.classList.contains('is-done')) return
  el.classList.add('is-done')
  el.addEventListener('transitionend', () => el.remove(), { once: true })
  window.setTimeout(() => el.remove(), 400)
}

function findStandingRow(code) {
  for (const section of normalizeSections(state.standings)) {
    const rows = []
    for (const group of section.rankings || []) {
      for (const team of group.teams || []) {
        rows.push({ rank: group.ordinal, team, section: section.name })
      }
    }
    const hit = rows.find((r) => r.team.code === code)
    if (hit) return { ...hit, groupSize: rows.length }
  }
  return null
}

function teamRecentMatches(code, limit = 6) {
  return splitEvents()
    .filter((e) => (e.match?.teams || []).some((t) => t.code === code))
    .sort((a, b) => b.startTime.localeCompare(a.startTime))
    .slice(0, limit)
}

function sortPlayers(players) {
  return [...(players || [])].sort((a, b) => {
    const ia = ROLE_ORDER.indexOf(a.role)
    const ib = ROLE_ORDER.indexOf(b.role)
    const ra = ia === -1 ? 99 : ia
    const rb = ib === -1 ? 99 : ib
    if (ra !== rb) return ra - rb
    return String(a.summonerName || '').localeCompare(String(b.summonerName || ''))
  })
}

function roleLabel(role) {
  return ROLE_CN[role] || role || '未知'
}

function teamBasicFromSchedule(code) {
  for (const event of splitEvents()) {
    const hit = (event.match?.teams || []).find((t) => t.code === code)
    if (hit) return hit
  }
  for (const section of normalizeSections(state.standings)) {
    for (const group of section.rankings || []) {
      const hit = (group.teams || []).find((t) => t.code === code)
      if (hit) return hit
    }
  }
  return { code, name: currentLeague().teamNames?.[code] || code, image: '' }
}

export function closeTeamModal() {
  state.teamModal = null
  renderTeamModal()
  document.body.classList.remove('modal-open')
}

export async function openTeamModal(code) {
  if (!code || code === 'TBD') return
  state.teamModal = { code, loading: true, detail: null, error: null }
  document.body.classList.add('modal-open')
  renderTeamModal()
  try {
    const detail = await fetchTeamDetail(code, { leagueId: state.leagueId })
    if (state.teamModal?.code !== code) return
    state.teamModal = { code, loading: false, detail, error: detail ? null : '暂无阵容数据' }
  } catch (err) {
    console.error(err)
    if (state.teamModal?.code !== code) return
    state.teamModal = { code, loading: false, detail: null, error: '阵容加载失败' }
  }
  renderTeamModal()
}

export function renderTeamModal() {
  const root = document.querySelector('#team-modal')
  if (!root) return
  const modal = state.teamModal
  if (!modal) {
    root.hidden = true
    root.innerHTML = ''
    document.body.classList.remove('modal-open')
    return
  }

  const basic = teamBasicFromSchedule(modal.code)
  const detail = modal.detail
  const image = detail?.image || detail?.alternativeImage || basic.image
  const name = detail?.name || teamLabel(basic)
  const region = detail?.homeLeague?.region || detail?.homeLeague?.name || currentLeague().region
  const standing = findStandingRow(modal.code)
  const diffs = gameDiffMap().get(modal.code)
  const diffText = diffs ? `${diffs.gf - diffs.ga > 0 ? '+' : ''}${diffs.gf - diffs.ga}` : null
  const players = sortPlayers(detail?.players)
  const recent = teamRecentMatches(modal.code)

  root.hidden = false
  root.innerHTML = `
    <div class="team-modal-backdrop" data-close-team-modal></div>
    <aside class="team-drawer" role="dialog" aria-modal="true" aria-labelledby="team-drawer-title">
      <button type="button" class="team-drawer-close" data-close-team-modal aria-label="关闭">×</button>
      <header class="team-drawer-head">
        ${teamImg(image, modal.code, 'team-drawer-logo')}
        <div>
          <div class="team-drawer-code">${escapeHtml(modal.code)}</div>
          <h2 id="team-drawer-title">${escapeHtml(name)}</h2>
          <p>${escapeHtml(region)}${currentLeague().teamNames?.[modal.code] ? ` · ${escapeHtml(currentLeague().teamNames[modal.code])}` : ''}</p>
        </div>
      </header>

      <section class="team-drawer-stats">
        <div>
          <span>积分榜</span>
          <b>${standing ? `#${standing.rank} · ${escapeHtml(standing.section)}` : '—'}</b>
        </div>
        <div>
          <span>胜负</span>
          <b>${standing ? `${standing.team.record?.wins ?? 0}-${standing.team.record?.losses ?? 0}` : '—'}</b>
        </div>
        <div>
          <span>净胜局</span>
          <b>${diffText ?? '—'}</b>
        </div>
      </section>

      <section class="team-drawer-section">
        <h3>现役阵容</h3>
        ${
          modal.loading
            ? `<div class="team-drawer-loading">正在加载队员…</div>`
            : players.length
              ? `<div class="player-grid">
                  ${players
                    .map(
                      (p) => `
                    <article class="player-card">
                      ${teamImg(p.image, p.summonerName || '')}
                      <div>
                        <b>${escapeHtml(p.summonerName || '—')}</b>
                        <span class="player-role">${escapeHtml(roleLabel(p.role))}</span>
                        <small>${escapeHtml([p.firstName, p.lastName].filter(Boolean).join(' ') || '')}</small>
                      </div>
                    </article>`,
                    )
                    .join('')}
                </div>`
              : `<div class="team-drawer-empty">${escapeHtml(modal.error || '暂无队员信息')}</div>`
        }
      </section>

      <section class="team-drawer-section">
        <h3>本赛段近期赛程</h3>
        ${
          recent.length
            ? `<div class="team-recent">
                ${recent
                  .map((event) => {
                    const [home, away] = event.match?.teams || [{}, {}]
                    const status = matchStatus(event)
                    const score =
                      status === 'upcoming'
                        ? 'VS'
                        : `${home.result?.gameWins ?? 0}:${away.result?.gameWins ?? 0}`
                    return `
                      <div class="team-recent-row">
                        <span>${formatDate(event.startTime).split(' ')[0]} ${formatTime(event.startTime)}</span>
                        <b>${escapeHtml(home.code || '')} ${score} ${escapeHtml(away.code || '')}</b>
                        <em>${status === 'completed' ? '已结束' : status === 'live' ? 'LIVE' : '未赛'}</em>
                      </div>`
                  })
                  .join('')}
              </div>`
            : `<div class="team-drawer-empty">本赛段暂无相关比赛</div>`
        }
      </section>

      <footer class="team-drawer-foot">
        <button type="button" class="chip" data-filter-team="${escapeHtml(modal.code)}">只看该队赛程</button>
      </footer>
    </aside>
  `
}

export function bindTeamModalEvents() {
  if (bindTeamModalEvents.bound) return
  bindTeamModalEvents.bound = true

  document.addEventListener('click', (e) => {
    const open = e.target.closest('[data-open-team]')
    if (open) {
      const code = open.getAttribute('data-open-team')
      if (code) {
        e.preventDefault()
        openTeamModal(code)
      }
      return
    }
    if (e.target.closest('[data-close-team-modal]')) {
      closeTeamModal()
      return
    }
    const filterBtn = e.target.closest('[data-filter-team]')
    if (filterBtn) {
      state.team = filterBtn.getAttribute('data-filter-team') || ''
      state.filter = 'all'
      closeTeamModal()
      renderAll()
    }
  })

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.teamModal) closeTeamModal()
    if ((e.key === 'Enter' || e.key === ' ') && e.target.closest?.('[data-open-team]')) {
      const code = e.target.closest('[data-open-team]').getAttribute('data-open-team')
      if (code) {
        e.preventDefault()
        openTeamModal(code)
      }
    }
  })
}

export function renderAll() {
  renderBrand()
  renderClock()
  renderHero()
  renderGpr()
  renderPlayoffBracket()
  renderFilters()
  renderSchedule()
  renderStandings()
  renderTeamModal()
  hideBootScreen()
}

function mergeLiveEvents(events, liveEvents) {
  const slug = currentLeague().slug
  const liveMap = new Map()
  for (const live of liveEvents || []) {
    const league = (live.league?.slug || live.league?.name || '').toLowerCase()
    if (league && league !== slug) continue
    const id = live.match?.id || live.id
    if (id) liveMap.set(String(id), live)
  }
  state.liveIds = new Set(liveMap.keys())
  return (events || []).map((event) => {
    const live = liveMap.get(String(event.match?.id || ''))
    if (!live) return event
    return {
      ...event,
      state: live.state || 'inProgress',
      match: {
        ...event.match,
        ...live.match,
        teams: live.match?.teams?.length ? live.match.teams : event.match?.teams,
        strategy: live.match?.strategy || event.match?.strategy,
        games: live.match?.games || event.match?.games,
      },
    }
  })
}

function applyPayload(payload, source) {
  const split = currentSplit()
  const live = Array.isArray(payload.live)
    ? payload.live
    : payload.live?.data?.schedule?.events || []
  state.events = mergeLiveEvents(payload.events || [], live)
  const standingsWrap = payload.standings?.[split.tournamentId]
  state.standings = standingsWrap?.data?.standings || standingsWrap || payload.standings || []
  if (!Array.isArray(state.standings)) state.standings = state.standings.data?.standings || []
  state.fetchedAt = payload.fetchedAt || null
  state.source = source
}

export async function switchLeague(leagueId) {
  if (!getLeague(leagueId) || leagueId === state.leagueId) return
  closeTeamModal()
  state.leagueId = leagueId
  writeStoredLeagueId(leagueId)
  state.team = ''
  state.filter = 'all'
  state.stage = 'all'
  state.playoffOpen = false
  state.events = []
  state.standings = []
  ensureSplitId()
  renderBrand()
  renderPlayoffBracket()
  await bootstrap({ silent: false, force: true })
}

export function bindLeagueSwitch() {
  if (bindLeagueSwitch.bound) return
  bindLeagueSwitch.bound = true
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-league]')
    if (!btn) return
    const id = btn.getAttribute('data-league')
    if (id) switchLeague(id)
  })
}

export async function bootstrap({ silent = false, force = true } = {}) {
  ensureSplitId()
  renderBrand()
  if (!silent) renderSync('同步中…')
  loadGprPanel({ force: silent ? false : force })
  const cache = readCache(state.leagueId)
  if (cache?.events?.length) {
    applyPayload(cache, 'cache')
    renderAll()
    renderSync('已显示缓存，正在刷新…', 'stale')
  } else if (state.leagueId === 'lpl') {
    const snapshot = await loadSnapshot()
    if (snapshot?.events?.length) {
      applyPayload(snapshot, 'snapshot')
      renderAll()
      renderSync('已显示本地快照，正在刷新…', 'stale')
    } else if (!silent) {
      document.querySelector('#schedule').innerHTML = `<div class="loading">正在加载赛程…</div>`
      hideBootScreen()
    }
  } else if (!silent) {
    document.querySelector('#schedule').innerHTML = `<div class="loading">正在加载赛程…</div>`
    hideBootScreen()
  }

  try {
    const live = await loadLeagueData(state.leagueId, currentSplit(), { force })
    applyPayload(live, 'live')
    renderAll()
    const t = live.fetchedAt ? new Date(live.fetchedAt) : new Date()
    const time = t.toLocaleTimeString('zh-CN', { hour12: false })
    if (live.partial) renderSync(`已同步赛程 ${time}（部分数据降级）`, 'stale')
    else renderSync(`已同步 ${time}`, 'ok')
  } catch (err) {
    console.error(err)
    if (!state.events.length) {
      if (state.leagueId === 'lpl') {
        const snapshot = await loadSnapshot()
        if (snapshot) {
          applyPayload(snapshot, 'snapshot')
          renderAll()
          renderSync('接口暂不可用，已显示本地快照', 'stale')
          return
        }
      }
      document.querySelector('#schedule').innerHTML = `<div class="error">赛程加载失败，请稍后重试</div>`
      hideBootScreen()
    }
    renderSync('刷新失败，仍显示上次数据', 'err')
  }
}
