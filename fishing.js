const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const https = require('https')
const { URL } = require('url')

// URL DISCORD WEBHOOK
const DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/1555117262136938526/4QwH449Ji2rLzAtGk0scAwkesLUWeHRXcsQ5BW_R3dYoB2e4jEtdyceA4MvywJIsjt7U'

// Daftar 4 Akun
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
  eatBelow: 6,
  eatUntil: 18,
  afterLoginWaitMs: 5000,
  castTimeoutMs: 40000,
  stopWhenFull: false,
  maxReconnect: 10,
  reconnectDelayMs: 20000,
  statusUpdateIntervalMs: 25000,
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

function sendOrEditDiscord(message, messageId = null) {
  return new Promise((resolve) => {
    if (!DISCORD_WEBHOOK_URL) return resolve(null)
    try {
      const isEdit = Boolean(messageId)
      const targetUrl = isEdit ? `${DISCORD_WEBHOOK_URL}/messages/${messageId}` : `${DISCORD_WEBHOOK_URL}?wait=true`
      const url = new URL(targetUrl)
      const data = JSON.stringify({ content: message })

      const req = https.request({
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: isEdit ? 'PATCH' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      })

      req.on('response', (res) => {
        let body = ''
        res.on('data', (chunk) => { body += chunk })
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body)
            resolve(parsed.id || messageId)
          } catch (e) {
            resolve(messageId)
          }
        })
      })

      req.on('error', () => resolve(messageId))
      req.write(data)
      req.end()
    } catch (e) {
      resolve(messageId)
    }
  })
}

function sendDiscordEvent(username, text) {
  const fullMessage = `**[${username}]**${text}`
  console.log(`[${username}]${text}`)
  sendOrEditDiscord(fullMessage).catch(() => {})
}

const active = (botState) => botState.bot && !botState.shuttingDown
const idle = (botState) => botState.state.paused || botState.state.following

function tell(botState, text) {
  console.log(`[${botState.username}][balas]`, text)
  try { botState.bot.chat(`/msg ${CONFIG.owner}${text}`) } catch {}
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
  sendDiscordEvent(botState.username, `Berhenti: ${reason}`)
}

function generateStatusMessage(botState) {
  const b = botState.bot
  const mode = botState.state.following ? '🏃 Mengikuti' : botState.state.paused ? '⏸️ Berhenti' : '🎣 Memancing'
  const hp = b ? Math.round(b.health) : 0
  const food = b ? Math.round(b.food) : 0
  const emptySlots = b && b.inventory ? b.inventory.emptySlotCount() : 0
  const lastCatchText = botState.stats.lastCatch ? botState.stats.lastCatch : 'Belum ada'

  return `📊 **[${botState.username}] LIVE STATUS**
\`\`\`
• Status        : ${mode}
• Total Lemparan : ${botState.stats.casts}
• Total Didapat  : ${botState.stats.catches}
• Item Terakhir : ${lastCatchText}
• Darah / Food  : ❤️ ${hp}/20 | 🍖 ${food}/20
• Slot Kosong   : ${emptySlots}
• Makan         : ${botState.stats.meals}x
\`\`\`
*(Update otomatis setiap 25 detik)*`
}

async function updateDiscordStatusCard(botState) {
  if (!botState.bot) return
  const msgText = generateStatusMessage(botState)
  const newMsgId = await sendOrEditDiscord(msgText, botState.discordMsgId)
  if (newMsgId) {
    botState.discordMsgId = newMsgId
  }
}

function startDiscordCardLoop(botState) {
  if (botState.statusInterval) clearInterval(botState.statusInterval)
  botState.statusInterval = setInterval(() => {
    if (active(botState)) {
      updateDiscordStatusCard(botState).catch(() => {})
    }
  }, CONFIG.statusUpdateIntervalMs)
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
  sendDiscordEvent(botState.username, `Mulai mengikuti ${CONFIG.owner}`)
}

async function runCommand(botState, cmd) {
  if (cmd === 'info1') {
    tell(botState, `Status: ${botState.state.paused ? 'Berhenti' : 'Memancing'} | Lemparan: ${botState.stats.casts} \vert{} Didapat:${botState.stats.catches}`)
  } else if (cmd === 'stop1') {
    await pauseWith(botState, 'Berhenti manual. Kirim lanjut1 untuk memancing lagi.')
  } else if (cmd === 'lanjut1') {
    stopFollow(botState)
    botState.state.paused = false
    tell(botState, 'Melanjutkan memancing ke arah pandang saat ini.')
    sendDiscordEvent(botState.username, 'Melanjutkan memancing')
  } else if (cmd === 'ikut1') {
    startFollow(botState)
  } else if (cmd === 'sini1') {
    botState.state.paused = true
    stopFollow(botState)
    await dropRod(botState)
    botState.bot.chat(`/tpa ${CONFIG.owner}`)
    await sleep(2000)
    tell(botState, 'Sudah kirim /tpa, tolong /tpaccept. Setelah sampai kirim lanjut1 atau ikut1.')
    sendDiscordEvent(botState.username, `Mengirim /tpa ke ${CONFIG.owner}`)
  }
}

function handleChat(botState, raw) {
  const msg = raw.replace(/§./g, '').trim()
  if (msg.includes(CONFIG.owner)) console.log(`[${botState.username}][chat-owner]`, JSON.stringify(msg))
  const m = msg.match(CONFIG.chatRegex)
  if (!m) return
  const cmd = m[1].toLowerCase()
  if (!COMMANDS.has(cmd)) return
  const now = Date.now()
  if (cmd === botState.lastCmd.name && now - botState.lastCmd.t < 2000) return
  botState.lastCmd.name = cmd
  botState.lastCmd.t = now
  sendDiscordEvent(botState.username, `Menerima perintah dari ${CONFIG.owner}: \`${cmd}\``)
  runCommand(botState, cmd).catch((e) => console.log(`[${botState.username}] Gagal perintah:`, e.message))
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
  console.log(`[${botState.username}] Lapar (food ${b.food}/20), mulai makan...`)
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

function customFish(botState) {
  return new Promise((resolve, reject) => {
    const b = botState.bot
    let myBobberId = null
    let fishTimeout = null

    const onEntitySpawn = (entity) => {
      if (entity.name === 'fishing_bobber' || entity.entityType === 101) {
        if (entity.position.distanceTo(b.entity.position) < 4) {
          myBobberId = entity.id
        }
      }
    }

    const onEntityUpdate = (entity) => {
      if (myBobberId && entity.id === myBobberId) {
        const hasVelocityY = entity.velocity && entity.velocity.y < -0.08
        const isBiting = entity.metadata && entity.metadata.some((m) => m === true || m === 1)

        if (hasVelocityY || isBiting) {
          cleanup()
          b.activateItem()
          resolve()
        }
      }
    }

    const cleanup = () => {
      b.removeListener('entitySpawn', onEntitySpawn)
      b.removeListener('entityUpdate', onEntityUpdate)
      if (fishTimeout) clearTimeout(fishTimeout)
    }

    b.on('entitySpawn', onEntitySpawn)
    b.on('entityUpdate', onEntityUpdate)

    try {
      b.activateItem()
      fishTimeout = setTimeout(() => {
        cleanup()
        try { b.activateItem() } catch {}
        reject(new Error('timeout'))
      }, CONFIG.castTimeoutMs)
    } catch (err) {
      cleanup()
      return reject(err)
    }
  })
}

// Format Angka Romawi untuk Level Enchantment
function toRoman(num) {
  const roman = { M: 1000, CM: 900, D: 500, CD: 400, C: 100, XC: 90, L: 50, XL: 40, X: 10, IX: 9, V: 5, IV: 4, I: 1 }
  let str = ''
  for (let i in roman) {
    while (num >= roman[i]) {
      str += i
      num -= roman[i]
    }
  }
  return str || num
}

// Merapikan Nama Enchantment
function formatEnchantName(name) {
  return name
    .replace(/^minecraft:/, '')
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

async function fishLoop(botState) {
  const b = botState.bot
  console.log(`[${botState.username}] Siap memancing!`)

  // Deteksi item yang ditangkap beserta Enchantment-nya
  b.on('playerCollect', (collector, collected) => {
    if (collector === b.entity) {
      try {
        const rawItem = collected.metadata.find((m) => m && m.itemId)
        if (rawItem) {
          const itemObj = b.registry.items[rawItem.itemId]
          if (itemObj) {
            let name = itemObj.displayName || itemObj.name
            let enchants = []

            // Ekstrak data NBT Enchantment
            if (rawItem.nbtData && rawItem.nbtData.value) {
              const nbt = rawItem.nbtData.value
              const enchantList = nbt.Enchantments || nbt.StoredEnchantments

              if (enchantList && enchantList.value && enchantList.value.value) {
                enchants = enchantList.value.value.map((e) => {
                  const eName = formatEnchantName(e.id ? e.id.value : 'unknown')
                  const eLvl = e.lvl ? e.lvl.value : 1
                  return `${eName} ${toRoman(eLvl)}`
                })
              }
            }

            if (enchants.length > 0) {
              botState.stats.lastCatch = `${name} ✨ (${enchants.join(', ')})`
            } else {
              botState.stats.lastCatch = name
            }
          }
        }
      } catch (e) {}
    }
  })

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
      await pauseWith(botState, `Inventori penuh. Total Lemparan: ${botState.stats.casts} | Total Didapat: ${botState.stats.catches}`)
      continue
    }

    botState.stats.casts++
    try {
      await customFish(botState)
      botState.stats.catches++
      botState.reconnects = 0
      console.log(`[${botState.username}] Berhasil! Lemparan: ${botState.stats.casts} | Didapat: ${botState.stats.catches}`)
    } catch (e) {
      if (idle(botState)) {
      } else if (e.message === 'timeout') {
        await sleep(1500)
      } else {
        await sleep(2000)
      }
    }

    await sleep(1000)
  }
}

function createBotAccount(acc, delayMs) {
  setTimeout(() => {
    const botState = {
      username: acc.username,
      password: acc.password,
      bot: null,
      shuttingDown: false,
      reconnects: 0,
      followTimer: null,
      discordMsgId: null,
      statusInterval: null,
      stats: { casts: 0, catches: 0, meals: 0, lastCatch: 'Belum ada' },
      state: { paused: false, following: false },
      lastCmd: { name: '', t: 0 }
    }

    function connect() {
      sendDiscordEvent(botState.username, `Menghubungkan ke ${CONFIG.host}...`)
      
      const b = mineflayer.createBot({
        host: CONFIG.host,
        port: CONFIG.port,
        username: botState.username,
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
            b.chat(`/register ${botState.password} ${botState.password}`)
          } else if (/\/login/i.test(msg)) {
            authSent = true
            b.chat(`/login ${botState.password}`)
          }
        }
        handleChat(botState, msg)
      })

      b.on('error', (e) => sendDiscordEvent(botState.username, `⚠️ Error: ${e.message}`))
      b.on('kicked', (r) => sendDiscordEvent(botState.username, `❌ Kicked: ${JSON.stringify(r)}`))
      b.on('death', () => {
        sendDiscordEvent(botState.username, '💀 Bot Mati, bersiap untuk respawn...')
        botState.state.paused = true
        stopFollow(botState)
      })

      b.on('respawn', async () => {
        sendDiscordEvent(botState.username, '🔄 Respawned. Mengirim /back...')
        await sleep(3000)
        if (active(botState)) {
          b.chat('/back')
          await sleep(2000)
          botState.state.paused = false
        }
      })

      b.once('end', () => {
        if (botState.statusInterval) clearInterval(botState.statusInterval)
        sendDiscordEvent(botState.username, `🔌 Terputus. Total Didapat: ${botState.stats.catches}`)
        if (!botState.shuttingDown) {
          botState.reconnects++
          if (botState.reconnects <= CONFIG.maxReconnect) {
            setTimeout(connect, CONFIG.reconnectDelayMs)
          }
        }
      })

      b.once('spawn', async () => {
        sendDiscordEvent(botState.username, '✅ Berhasil masuk ke server!')
        for (let i = 0; i < 30 && !authSent; i++) await sleep(500)
        await sleep(CONFIG.afterLoginWaitMs)
        await dismissMenu(b)
        
        await updateDiscordStatusCard(botState)
        startDiscordCardLoop(botState)

        fishLoop(botState).catch((e) => console.log(`[${botState.username}] ERROR loop:`, e.message))
      })
    }

    connect()
  }, delayMs)
}

// JEDA LOGIN: 25 DETIK PER BOT
ACCOUNTS.forEach((acc, index) => {
  createBotAccount(acc, index * 25000)
})
