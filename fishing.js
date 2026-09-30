const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')

const CONFIG = {
  host: 'play.sunnysmp.xyz',
  port: 25565,
  username: 'Solaris',
  auth: 'offline',
  password: 'memek#1',
  owner: 'SolTheMayo',
  chatRegex: /^(?:(?:\[[^\]]*\]|\([^)]*\)|\{[^}]*\})\s*)*SolTheMayo\s*[:»>›\-]+\s*(\S+)\s*$/,
  debugChat: true,
  eatBelow: 6,
  eatUntil: 18,
  afterLoginWaitMs: 5000,
  startCommands: [],
  waterMin: 2,
  waterMax: 32,
  castTimeoutMs: 45000,
  maxTimeoutsInRow: 10,
  stopWhenFull: true,
  maxReconnect: 10,
  reconnectDelayMs: 20000,
}

const COMMANDS = new Set(['sini1', 'info1', 'stop1', 'lanjut1', 'ikut1'])

const AVOID_FOOD = new Set([
  'pufferfish', 'spider_eye', 'rotten_flesh', 'poisonous_potato', 'chicken',
  'suspicious_stew', 'golden_apple', 'enchanted_golden_apple', 'chorus_fruit',
  'tropical_fish',
])

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const stats = { casts: 0, catches: 0, meals: 0 }
const state = { paused: false, following: false, needFace: true }
const lastCmd = { name: '', t: 0 }
let bot = null
let shuttingDown = false
let reconnects = 0
let followTimer = null

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ])
}

function shutdown(code) {
  if (shuttingDown) return
  shuttingDown = true
  clearInterval(followTimer)
  console.log(`Berhenti. Lemparan: ${stats.casts}, tangkapan: ${stats.catches}, makan: ${stats.meals}`)
  try { bot.quit() } catch {}
  setTimeout(() => process.exit(code), 500)
}

process.on('SIGINT', () => shutdown(0))
process.on('uncaughtException', (e) => {
  console.log('CRASH:', e && e.stack ? e.stack : e)
  shutdown(1)
})

const active = (b) => b === bot && !shuttingDown
const idle = () => state.paused || state.following

function tell(b, text) {
  console.log('[balas]', text)
  try { b.chat(`/msg ${CONFIG.owner} ${text}`) } catch {}
}

async function dropRod(b) {
  try { await b.unequip('hand') } catch {}
}

function stopFollow(b) {
  state.following = false
  clearInterval(followTimer)
  followTimer = null
  try { b.pathfinder.setGoal(null) } catch {}
}

async function pauseWith(b, reason) {
  state.paused = true
  stopFollow(b)
  await dropRod(b)
  tell(b, reason)
}

function statusText(b) {
  const mode = state.following ? 'mengikuti' : state.paused ? 'berhenti' : 'memancing'
  const p = b.entity.position
  return `Status: ${mode} | food ${b.food}/20 | hp ${Math.round(b.health)} | lempar ${stats.casts} | dapat ${stats.catches} | makan ${stats.meals} | slot kosong ${b.inventory.emptySlotCount()} | pos ${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`
}

function startFollow(b) {
  const entity = b.players[CONFIG.owner] && b.players[CONFIG.owner].entity
  if (!entity) {
    tell(b, 'Saya tidak melihat kamu. Kirim sini1 dulu.')
    return
  }
  state.paused = false
  state.following = true
  dropRod(b)
  const movements = new Movements(b)
  movements.canDig = false
  movements.allow1by1towers = false
  movements.allowSprinting = true
  b.pathfinder.setMovements(movements)
  b.pathfinder.setGoal(new goals.GoalFollow(entity, 2), true)
  clearInterval(followTimer)
  followTimer = setInterval(() => {
    if (!state.following) return
    const e = b.players[CONFIG.owner] && b.players[CONFIG.owner].entity
    if (e) b.pathfinder.setGoal(new goals.GoalFollow(e, 2), true)
  }, 3000)
  tell(b, 'Mengikuti kamu. Kirim stop1 untuk berhenti.')
}

async function runCommand(b, cmd) {
  if (cmd === 'info1') {
    tell(b, statusText(b))
  } else if (cmd === 'stop1') {
    await pauseWith(b, 'Berhenti. Kirim lanjut1 untuk mulai memancing lagi.')
  } else if (cmd === 'lanjut1') {
    stopFollow(b)
    state.paused = false
    state.needFace = true
    tell(b, 'Lanjut memancing dari posisi ini.')
  } else if (cmd === 'ikut1') {
    startFollow(b)
  } else if (cmd === 'sini1') {
    state.paused = true
    stopFollow(b)
    await dropRod(b)
    b.chat(`/tpa ${CONFIG.owner}`)
    await sleep(2000)
    tell(b, 'Sudah kirim /tpa, tolong /tpaccept. Setelah sampai kirim lanjut1 atau ikut1.')
  }
}

function handleChat(b, raw) {
  const msg = raw.replace(/§./g, '').trim()
  if (msg.includes(CONFIG.owner)) console.log('[chat-owner]', JSON.stringify(msg))
  const m = msg.match(CONFIG.chatRegex)
  if (!m) return
  const cmd = m[1].toLowerCase()
  if (!COMMANDS.has(cmd)) return
  const now = Date.now()
  if (cmd === lastCmd.name && now - lastCmd.t < 2000) return
  lastCmd.name = cmd
  lastCmd.t = now
  console.log('Perintah dari', CONFIG.owner + ':', cmd)
  runCommand(b, cmd).catch((e) => console.log('Gagal menjalankan perintah:', e.message))
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
  for (let i = 0; i < 12 && active(b) && !idle() && b.food < CONFIG.eatUntil; i++) {
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
  if (!water) return false
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

async function fishLoop(b) {
  console.log('Bot siap. Menunggu perintah atau mulai memancing')
  let timeoutsInRow = 0
  while (active(b)) {
    if (idle()) {
      await sleep(500)
      continue
    }
    if (state.needFace) {
      if (!(await faceWater(b))) {
        await pauseWith(b, 'Tidak ada air dalam jangkauan. Kirim sini1 atau ikut1, lalu lanjut1 di dekat air.')
        continue
      }
      state.needFace = false
    }
    if (b.food !== undefined && b.food <= CONFIG.eatBelow) {
      await eat(b)
      state.needFace = true
      continue
    }
    if (CONFIG.stopWhenFull && b.inventory.emptySlotCount() < 2) {
      await pauseWith(b, 'Inventori penuh, berhenti memancing.')
      continue
    }
    let hasRod = false
    try {
      hasRod = await ensureRod(b)
    } catch (e) {
      console.log('Gagal memegang pancingan:', e.message)
    }
    if (!hasRod) {
      if (!idle()) await pauseWith(b, 'Tidak ada fishing rod di inventori, berhenti.')
      continue
    }

    stats.casts++
    try {
      await withTimeout(b.fish(), CONFIG.castTimeoutMs)
      stats.catches++
      timeoutsInRow = 0
      reconnects = 0
    } catch (e) {
      if (idle()) {
        timeoutsInRow = 0
      } else if (e.message === 'timeout') {
        timeoutsInRow++
        try { b.activateItem() } catch {}
        await sleep(1500)
        if (timeoutsInRow === 5) state.needFace = true
        if (timeoutsInRow >= CONFIG.maxTimeoutsInRow) {
          timeoutsInRow = 0
          await pauseWith(b, 'Terlalu sering tidak ada gigitan, mungkin pelampung tidak jatuh di air. Berhenti.')
        }
      } else {
        console.log('Error memancing:', e.message)
        await sleep(2000)
      }
    }
    if (stats.casts % 20 === 0) {
      console.log(`Lemparan ${stats.casts}, tangkapan ${stats.catches}, makan ${stats.meals}, food ${b.food}/20`)
    }
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
  state.following = false
  state.needFace = true
  let authSent = false

  b.on('messagestr', (msg) => {
    if (CONFIG.debugChat) console.log('[raw]', msg)
    if (/login|register|password|afk|kick|cooldown/i.test(msg)) console.log('[chat]', msg)
    if (!authSent) {
      if (/\/register/i.test(msg)) {
        authSent = true
        b.chat(`/register ${CONFIG.password} ${CONFIG.password}`)
      } else if (/\/login/i.test(msg)) {
        authSent = true
        b.chat(`/login ${CONFIG.password}`)
      }
    }
    handleChat(b, msg)
  })

  b.on('windowOpen', (w) => console.log('Window dibuka:', JSON.stringify(w.title)))
  b.on('error', (e) => console.log('Error:', e.message))
  b.on('kicked', (r) => console.log('Kicked:', r))
  b.on('death', () => {
    console.log('Bot mati')
    state.paused = true
    stopFollow(b)
  })
  b.on('respawn', async () => {
    await sleep(3000)
    if (active(b)) tell(b, 'Bot mati dan respawn. Kirim sini1, lalu lanjut1 atau ikut1.')
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
