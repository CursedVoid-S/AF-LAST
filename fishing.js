const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')

// DAFTAR AKUN BOT
const ACCOUNTS = [
  { username: 'Solaris', password: 'memek#1' },
  { username: 'Izanagi', password: 'memek#1' },
  { username: 'Izanami', password: 'memek#1' },
  { username: 'Itadori', password: 'memek#1' },
]

const CONFIG = {
  host: 'play.sunnysmp.xyz',
  port: 25565,
  auth: 'offline',
  owner: 'SolTheMayo',
  chatRegex: /^(?:(?:\[[^\]]*\]|\([^)]*\)|\{[^}]*\})\s*)*SolTheMayo\s*[:»>›\-]+\s*(\S+)\s*$/,
  debugChat: true,
  eatBelow: 6,
  eatUntil: 18,
  afterLoginWaitMs: 5000,
  startCommands: [],
  castTimeoutMs: 45000,
  maxTimeoutsInRow: 5,
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

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ])
}

const active = (botState) => botState.bot && !botState.shuttingDown
const idle = (botState) => botState.state.paused || botState.state.following

function tell(botState, text) {
  console.log(`[${botState.account.username}][balas]`, text)
  try { botState.bot.chat(`/msg ${CONFIG.owner} ${text}`) } catch {}
}

async function dropRod(botState) {
  try { await botState.bot.unequip('hand') } catch {}
}

function stopFollow(botState) {
  botState.state.following = false
  clearInterval(botState.followTimer)
  botState.followTimer = null
  try { botState.bot.pathfinder.setGoal(null) } catch {}
}

async function pauseWith(botState, reason) {
  botState.state.paused = true
  stopFollow(botState)
  await dropRod(botState)
  tell(botState, reason)
}

function statusText(botState) {
  const b = botState.bot
  const mode = botState.state.following ? 'mengikuti' : botState.state.paused ? 'berhenti' : 'memancing'
  const p = b.entity.position
  return `Status: ${mode} | food ${b.food}/20 | hp ${Math.round(b.health)} | lempar ${botState.stats.casts} | dapat ${botState.stats.catches} | makan ${botState.stats.meals} | slot kosong ${b.inventory.emptySlotCount()} | pos ${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`
}

function startFollow(botState) {
  const b = botState.bot
  const entity = b.players[CONFIG.owner] && b.players[CONFIG.owner].entity
  if (!entity) {
    tell(botState, 'Saya tidak melihat kamu. Kirim sini1 dulu.')
    return
  }
  botState.state.paused = false
  botState.state.following = true
  dropRod(botState)
  const movements = new Movements(b)
  movements.canDig = false
  movements.allow1by1towers = false
  movements.allowSprinting = true
  b.pathfinder.setMovements(movements)
  b.pathfinder.setGoal(new goals.GoalFollow(entity, 2), true)
  clearInterval(botState.followTimer)
  botState.followTimer = setInterval(() => {
    if (!botState.state.following) return
    const e = b.players[CONFIG.owner] && b.players[CONFIG.owner].entity
    if (e) b.pathfinder.setGoal(new goals.GoalFollow(e, 2), true)
  }, 3000)
  tell(botState, 'Mengikuti kamu. Kirim stop1 untuk berhenti.')
}

async function runCommand(botState, cmd) {
  if (cmd === 'info1') {
    tell(botState, statusText(botState))
  } else if (cmd === 'stop1') {
    await pauseWith(botState, 'Berhenti manual. Kirim lanjut1 untuk memancing lagi.')
  } else if (cmd === 'lanjut1') {
    stopFollow(botState)
    botState.state.paused = false
    tell(botState, 'Melanjutkan memancing ke arah pandang saat ini.')
  } else if (cmd === 'ikut1') {
    startFollow(botState)
  } else if (cmd === 'sini1') {
    botState.state.paused = true
    stopFollow(botState)
    await dropRod(botState)
    botState.bot.chat(`/tpa ${CONFIG.owner}`)
    await sleep(2000)
    tell(botState, 'Sudah kirim /tpa, tolong /tpaccept. Setelah sampai kirim lanjut1 atau ikut1.')
  }
}

function handleChat(botState, raw) {
  const msg = raw.replace(/§./g, '').trim()
  if (msg.includes(CONFIG.owner)) console.log(`[${botState.account.username}][chat-owner]`, JSON.stringify(msg))
  const m = msg.match(CONFIG.chatRegex)
  if (!m) return
  const cmd = m[1].toLowerCase()
  if (!COMMANDS.has(cmd)) return
  const now = Date.now()
  if (cmd === botState.lastCmd.name && now - botState.lastCmd.t < 2000) return
  botState.lastCmd.name = cmd
  botState.lastCmd.t = now
  console.log(`[${botState.account.username}] Perintah dari ${CONFIG.owner}:`, cmd)
  runCommand(botState, cmd).catch((e) => console.log(`[${botState.account.username}] Gagal perintah:`, e.message))
}

async function dismissMenu(b) {
  for (let i = 0; i < 3; i++) {
    if (b.currentWindow) {
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

async function eat(botState) {
  const b = botState.bot
  console.log(`[${botState.account.username}] Lapar (food ${b.food}/20), mulai makan`)
  for (let i = 0; i < 12 && active(botState) && !idle(botState) && b.food < CONFIG.eatUntil; i++) {
    const item = pickFood(b)
    if (!item) return
    try {
      await b.equip(item, 'hand')
      await withTimeout(b.consume(), 8000)
      botState.stats.meals++
    } catch (e) {
      await sleep(1500)
    }
  }
}

async function ensureRod(b) {
  const rod = b.inventory.items().find((i) => i.name === 'fishing_rod')
  if (!rod) return false
  if (!b.heldItem || b.heldItem.name !== 'fishing_rod') {
    await b.equip(rod, 'hand')
  }
  return true
}

async function fishLoop(botState) {
  const b = botState.bot
  console.log(`[${botState.account.username}] Siap memancing...`)
  let timeoutsInRow = 0

  while (active(botState)) {
    if (idle(botState)) {
      await sleep(500)
      continue
    }

    let hasRod = false
    try {
      hasRod = await ensureRod(b)
    } catch (e) {}

    if (!hasRod) {
      await sleep(3000)
      continue
    }

    if (b.food !== undefined && b.food <= CONFIG.eatBelow) {
      await eat(botState)
      continue
    }

    if (CONFIG.stopWhenFull && b.inventory.emptySlotCount() < 2) {
      await pauseWith(botState, 'Inventori penuh, berhenti memancing.')
      continue
    }

    botState.stats.casts++
    try {
      await withTimeout(b.fish(), CONFIG.castTimeoutMs)
      botState.stats.catches++
      timeoutsInRow = 0
      botState.reconnects = 0
    } catch (e) {
      if (idle(botState)) {
        timeoutsInRow = 0
      } else if (e.message === 'timeout') {
        timeoutsInRow++
        try { b.activateItem() } catch {}
        await sleep(1500)
      } else {
        await sleep(2000)
      }
    }

    if (botState.stats.casts % 20 === 0) {
      console.log(`[${botState.account.username}] Lemparan ${botState.stats.casts}, tangkapan ${botState.stats.catches}`)
    }
    await sleep(300)
  }
}

function startBot(account, index) {
  const botState = {
    account,
    bot: null,
    shuttingDown: false,
    reconnects: 0,
    followTimer: null,
    stats: { casts: 0, catches: 0, meals: 0 },
    state: { paused: false, following: false },
    lastCmd: { name: '', t: 0 }
  }

  function connect() {
    console.log(`[${account.username}] Menghubungkan ke ${CONFIG.host}...`)
    const b = mineflayer.createBot({
      host: CONFIG.host,
      port: CONFIG.port,
      username: account.username,
      auth: CONFIG.auth,
    })

    botState.bot = b
    b.loadPlugin(pathfinder)
    botState.state.paused = false
    botState.state.following = false
    let authSent = false

    b.on('messagestr', (msg) => {
      if (!authSent) {
        if (/\/register/i.test(msg)) {
          authSent = true
          b.chat(`/register ${account.password} ${account.password}`)
        } else if (/\/login/i.test(msg)) {
          authSent = true
          b.chat(`/login ${account.password}`)
        }
      }
      handleChat(botState, msg)
    })

    b.on('error', (e) => console.log(`[${account.username}] Error:`, e.message))
    b.on('kicked', (r) => console.log(`[${account.username}] Kicked:`, r))
    b.on('death', () => {
      console.log(`[${account.username}] Mati, bersiap untuk respawn...`)
      botState.state.paused = true
      stopFollow(botState)
    })

    b.on('respawn', async () => {
      console.log(`[${account.username}] Respawned. Menunggu 3 detik sebelum mengirim /back...`)
      await sleep(3000)
      if (active(botState)) {
        b.chat('/back')
        console.log(`[${account.username}] Mengirim /back dan melanjutkan memancing.`)
        await sleep(2000)
        botState.state.paused = false
      }
    })

    b.once('end', () => {
      console.log(`[${account.username}] Terputus.`)
      if (!botState.shuttingDown) {
        botState.reconnects++
        if (botState.reconnects <= CONFIG.maxReconnect) {
          setTimeout(connect, CONFIG.reconnectDelayMs)
        }
      }
    })

    b.once('spawn', async () => {
      console.log(`[${account.username}] Sudah masuk server`)
      for (let i = 0; i < 30 && !authSent; i++) await sleep(500)
      await sleep(CONFIG.afterLoginWaitMs)
      await dismissMenu(b)
      fishLoop(botState).catch((e) => console.log(`[${account.username}] ERROR loop:`, e.message))
    })
  }

  // Jeda masuk antar bot diset 15 detik (15000 ms)
  setTimeout(connect, index * 15000)
}

ACCOUNTS.forEach((account, i) => startBot(account, i))
