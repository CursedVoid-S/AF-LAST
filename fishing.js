const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')

const CONFIG = {
  host: process.env.MC_HOST || 'play.sunnysmp.xyz',
  port: 25565,
  username: (process.env.MC_USER || '').trim(),
  password: process.env.MC_PASS || '',
  auth: 'offline',
  eatBelow: 6,
  eatUntil: 18,
  afterLoginWaitMs: 5000,
  startCommands: [],
  backRetries: 3,
  backWaitMs: 8000,
  waterMin: 2,
  waterMax: 32,
  castTimeoutMs: 45000,
  maxTimeoutsInRow: 10,
  stopWhenFull: true,
  maxReconnect: 10,
  reconnectDelayMs: 20000,
}

if (!/^[A-Za-z0-9_]{3,16}$/.test(CONFIG.username) || !CONFIG.password) {
  console.log('Username (3-16 huruf/angka/_) dan password wajib diisi (MC_USER dan MC_PASS).')
  process.exit(1)
}

const AVOID_FOOD = new Set([
  'pufferfish', 'spider_eye', 'rotten_flesh', 'poisonous_potato', 'chicken',
  'suspicious_stew', 'golden_apple', 'enchanted_golden_apple', 'chorus_fruit',
  'tropical_fish',
])

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const stats = { casts: 0, catches: 0, meals: 0, deaths: 0 }
const state = { dead: false, recovering: false, needFace: true }
let bot = null
let shuttingDown = false
let reconnects = 0
let moving = false

const statsText = () =>
  `Lemparan ${stats.casts}, dapat ${stats.catches}, makan ${stats.meals}, mati ${stats.deaths}x`

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ])
}

function report(text) {
  console.log('[laporan]', text)
}

function shutdown(code) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`Berhenti. ${statsText()}`)
  try { bot.quit() } catch {}
  setTimeout(() => process.exit(code), 500)
}

const onStopSignal = () => {
  if (shuttingDown) return
  report(`Bot dihentikan. ${statsText()}.`)
  shutdown(0)
}
process.on('SIGINT', onStopSignal)
process.on('SIGTERM', onStopSignal)
process.on('uncaughtException', (e) => {
  console.log('CRASH:', e && e.stack ? e.stack : e)
  report(`Bot crash: ${e && e.message ? e.message : e}`)
  shutdown(1)
})

const active = (b) => b === bot && !shuttingDown

async function wiggle(b) {
  if (moving) return
  moving = true
  console.log('Bergerak supaya chat tidak diblokir anti-spambot')
  try {
    const start = b.entity.position.clone()
    const movements = new Movements(b)
    movements.canDig = false
    movements.allow1by1towers = false
    b.pathfinder.setMovements(movements)
    const offsets = [[5, 0], [-5, 0], [0, 5], [0, -5]]
    let moved = false
    for (const [dx, dz] of offsets) {
      try {
        await withTimeout(b.pathfinder.goto(new goals.GoalNearXZ(start.x + dx, start.z + dz, 1)), 8000)
      } catch {
        try { b.pathfinder.setGoal(null) } catch {}
      }
      if (b.entity.position.distanceTo(start) >= 3) {
        moved = true
        break
      }
    }
    if (!moved) {
      console.log('Pathfinder gagal, bergerak lurus')
      b.setControlState('forward', true)
      await sleep(1200)
      b.setControlState('forward', false)
    }
    console.log(`Bot bergeser ${b.entity.position.distanceTo(start).toFixed(1)} blok`)
  } catch (e) {
    console.log('Gagal bergerak:', e.message)
  }
  try { b.clearControlStates() } catch {}
  moving = false
}

async function dismissMenu(b) {
  for (let i = 0; i < 3; i++) {
    if (b.currentWindow) {
      console.log('Menu terbuka setelah login, ditutup (Esc)')
      try { b.closeWindow(b.currentWindow) } catch {}
    }
    await sleep(1000)
  }
}

function pickFood(b) {
  let best = null
  for (const item of b.inventory.items()) {
    const food = b.registry.foodsByName[item.name]
    if (!food || AVOID_FOOD.has(item.name)) continue
    if (!best || food.foodPoints < best.points) best = { item, points: food.foodPoints }
  }
  return best ? best.item : null
}

async function eat(b) {
  console.log(`Lapar (food ${b.food}/20), mulai makan`)
  for (let i = 0; i < 12 && active(b) && !state.dead && b.food < CONFIG.eatUntil; i++) {
    const item = pickFood(b)
    if (!item) {
      console.log('Tidak ada makanan di inventori, lanjut memancing')
      return
    }
    try {
      await b.equip(item, 'hand')
      await withTimeout(b.consume(), 8000)
      stats.meals++
    } catch (e) {
      console.log('Gagal makan:', e.message)
      await sleep(1500)
    }
  }
  console.log(`Selesai makan (food ${b.food}/20)`)
}

async function ensureRod(b) {
  const rod = b.inventory.items().find((i) => i.name === 'fishing_rod')
  if (!rod) return false
  if (!b.heldItem || b.heldItem.name !== 'fishing_rod') {
    await b.equip(rod, 'hand')
  }
  return true
}

async function faceWater(b) {
  const water = b.registry.blocksByName.water
  if (!water || !b.entity) return false
  const eye = b.entity.position.offset(0, b.entity.height, 0)
  const spots = b
    .findBlocks({ matching: water.id, maxDistance: CONFIG.waterMax, count: 200 })
    .map((p) => ({ p, d: p.offset(0.5, 0.5, 0.5).distanceTo(eye) }))
    .filter((x) => x.d >= CONFIG.waterMin)
    .sort((x, y) => x.d - y.d)
  if (!spots.length) return false
  await b.lookAt(spots[0].p.offset(0.5, 0.9, 0.5), true)
  return true
}

async function recover(b) {
  if (state.recovering) return
  state.recovering = true
  console.log('Bot mati dan sudah respawn, mencoba /back')
  await sleep(3000)
  let ok = false
  for (let i = 1; i <= CONFIG.backRetries && active(b); i++) {
    const from = b.entity ? b.entity.position.clone() : null
    console.log(`Kirim /back (percobaan ${i}/${CONFIG.backRetries})`)
    b.chat('/back')
    await sleep(CONFIG.backWaitMs)
    const moved = from && b.entity ? b.entity.position.distanceTo(from) > 3 : true
    if (moved && (await faceWater(b))) {
      ok = true
      break
    }
    console.log('Belum kembali ke spot memancing')
  }
  if (!active(b)) return
  report(`Mati ke-${stats.deaths}. ${statsText()}.`)
  if (!ok) {
    report('Gagal kembali ke spot memancing, berhenti.')
    return shutdown(1)
  }
  state.needFace = false
  state.dead = false
  state.recovering = false
  console.log('Kembali ke spot, lanjut memancing')
}

async function fishLoop(b) {
  console.log('Mulai auto fishing')
  report('Online dan mulai memancing.')
  let timeoutsInRow = 0
  while (active(b)) {
    if (state.dead || state.recovering) {
      await sleep(500)
      continue
    }
    if (state.needFace) {
      if (!(await faceWater(b))) {
        report('Tidak ada air dalam jangkauan di posisi bot, berhenti memancing.')
        return shutdown(1)
      }
      state.needFace = false
    }
    if (b.food !== undefined && b.food <= CONFIG.eatBelow) {
      await eat(b)
      state.needFace = true
      continue
    }
    if (CONFIG.stopWhenFull && b.inventory.emptySlotCount() < 2) {
      report(`Inventori penuh, berhenti. ${statsText()}.`)
      return shutdown(0)
    }
    let hasRod = false
    try {
      hasRod = await ensureRod(b)
    } catch (e) {
      console.log('Gagal memegang pancingan:', e.message)
    }
    if (!hasRod) {
      if (state.dead || state.recovering) continue
      report(`Tidak ada fishing rod, berhenti. ${statsText()}.`)
      return shutdown(1)
    }

    stats.casts++
    try {
      await withTimeout(b.fish(), CONFIG.castTimeoutMs)
      stats.catches++
      timeoutsInRow = 0
      reconnects = 0
    } catch (e) {
      if (state.dead || state.recovering) {
        timeoutsInRow = 0
      } else if (e.message === 'timeout') {
        timeoutsInRow++
        try { b.activateItem() } catch {}
        await sleep(1500)
        if (timeoutsInRow === 5) state.needFace = true
        if (timeoutsInRow >= CONFIG.maxTimeoutsInRow) {
          report(`Terlalu sering tidak ada gigitan, berhenti. ${statsText()}.`)
          return shutdown(1)
        }
      } else {
        console.log('Error memancing:', e.message)
        await sleep(2000)
      }
    }
    if (stats.casts % 20 === 0) console.log(`${statsText()}, food ${b.food}/20`)
    await sleep(300)
  }
}

function scheduleReconnect() {
  if (shuttingDown) return
  reconnects++
  if (reconnects > CONFIG.maxReconnect) {
    console.log('Terlalu banyak gagal sambung ulang')
    return shutdown(1)
  }
  console.log(`Sambung ulang dalam ${CONFIG.reconnectDelayMs / 1000} detik (${reconnects}/${CONFIG.maxReconnect})`)
  setTimeout(start, CONFIG.reconnectDelayMs)
}

function start() {
  if (shuttingDown) return
  console.log('Menghubungkan ke', CONFIG.host, 'sebagai', CONFIG.username)
  const b = mineflayer.createBot({
    host: CONFIG.host,
    port: CONFIG.port,
    username: CONFIG.username,
    auth: CONFIG.auth,
  })
  bot = b
  b.loadPlugin(pathfinder)
  state.dead = false
  state.recovering = false
  state.needFace = true
  let authSent = false

  b.on('messagestr', (msg) => {
    if (/have to move/i.test(msg)) wiggle(b)
    if (/login|register|password|afk|kick|cooldown/i.test(msg)) console.log('[chat]', msg)
    if (authSent) return
    if (/\/register/i.test(msg)) {
      authSent = true
      b.chat(`/register ${CONFIG.password} ${CONFIG.password}`)
    } else if (/\/login/i.test(msg)) {
      authSent = true
      b.chat(`/login ${CONFIG.password}`)
    }
  })

  b.on('error', (e) => console.log('Error:', e.message))
  b.on('kicked', (r) => console.log('Kicked:', r))
  b.on('death', () => {
    stats.deaths++
    state.dead = true
    console.log(`Bot mati (ke-${stats.deaths})`)
  })
  b.on('respawn', () => {
    if (state.dead) recover(b).catch((e) => console.log('ERROR recover:', e.message))
  })
  b.once('end', (r) => {
    console.log('Koneksi terputus:', r)
    if (b === bot) scheduleReconnect()
  })

  b.once('spawn', async () => {
    console.log('Bot sudah masuk server')
    for (let i = 0; i < 30 && !authSent; i++) await sleep(500)
    console.log(`Menunggu ${CONFIG.afterLoginWaitMs / 1000} detik setelah login`)
    await sleep(CONFIG.afterLoginWaitMs)
    await dismissMenu(b)
    await wiggle(b)
    for (const cmd of CONFIG.startCommands) {
      b.chat(cmd)
      await sleep(3000)
    }
    fishLoop(b).catch((e) => {
      console.log('ERROR loop:', e && e.stack ? e.stack : e)
      shutdown(1)
    })
  })
}

start()
