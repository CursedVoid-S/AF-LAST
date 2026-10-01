const mineflayer = require('mineflayer')
const https = require('https')
const { URL } = require('url')
const {
  Client,
  GatewayIntentBits,
  Events,
  MessageFlags,
  SlashCommandBuilder,
} = require('discord.js')

// ====== KONFIGURASI (isi lewat environment variable) ======
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || ''   // untuk status & log
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || ''       // untuk slash command /chat
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || ''         // opsional, agar /chat muncul instan
const ALLOWED_USER_IDS = (process.env.ALLOWED_USER_IDS || '')       // ID Discord yang boleh pakai /chat, pisah koma
  .split(',').map((s) => s.trim()).filter(Boolean)

const PASSWORD = 'memek#1'
const ACCOUNTS = [
  { username: 'Solaris', password: PASSWORD },
  { username: 'Izanagi', password: PASSWORD },
  // { username: 'Izanami', password: PASSWORD },
  { username: 'Itadori', password: PASSWORD },
]

const CONFIG = {
  host: 'play.sunnysmp.xyz',
  port: 25565,
  auth: 'offline',
  eatBelow: 6,
  eatUntil: 18,
  afterLoginWaitMs: 5000,
  castTimeoutMs: 40000,
  bobberSettleMs: 2000,
  stopWhenFull: false,
  maxReconnect: 10,
  reconnectDelayMs: 20000,
  statusUpdateIntervalMs: 25000,
  loginStaggerMs: 25000,
  chatStaggerMs: 1000,
}

const AVOID_FOOD = new Set([
  'pufferfish', 'spider_eye', 'rotten_flesh', 'poisonous_potato', 'chicken',
  'suspicious_stew', 'golden_apple', 'enchanted_golden_apple', 'chorus_fruit',
  'tropical_fish',
])

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const botStates = new Map() // username (lowercase) -> botState

function withTimeout(promise, ms) {
  let t
  return Promise.race([
    promise,
    new Promise((_, reject) => { t = setTimeout(() => reject(new Error('timeout')), ms) }),
  ]).finally(() => clearTimeout(t))
}

// ====== DISCORD WEBHOOK ======
function sendOrEditDiscord(message, messageId = null) {
  return new Promise((resolve) => {
    if (!DISCORD_WEBHOOK_URL) return resolve({ id: null })
    try {
      const isEdit = Boolean(messageId)
      const target = isEdit
        ? `${DISCORD_WEBHOOK_URL}/messages/${messageId}`
        : `${DISCORD_WEBHOOK_URL}?wait=true`
      const url = new URL(target)
      const data = JSON.stringify({ content: message, allowed_mentions: { parse: [] } })

      const req = https.request({
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: isEdit ? 'PATCH' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      })

      req.setTimeout(10000, () => req.destroy())

      req.on('response', (res) => {
        let body = ''
        res.on('data', (chunk) => { body += chunk })
        res.on('end', () => {
          // Pesan kartu terhapus -> reset supaya dibuat ulang
          if (res.statusCode === 404) return resolve({ id: null })
          let id = messageId
          try {
            const parsed = JSON.parse(body)
            if (parsed && parsed.id) id = parsed.id
          } catch {}
          resolve({ id })
        })
      })

      req.on('error', () => resolve({ id: messageId }))
      req.write(data)
      req.end()
    } catch {
      resolve({ id: messageId })
    }
  })
}

function sendDiscordEvent(username, text) {
  console.log(`[${username}] ${text}`)
  sendOrEditDiscord(`**[${username}]** ${text}`).catch(() => {})
}

// ====== STATE HELPERS ======
const isAlive = (s, b) => s.bot === b && !s.ended && !s.shuttingDown
const isOnline = (s) => Boolean(s.bot && s.bot.entity && !s.ended && !s.shuttingDown)

function generateStatusMessage(s) {
  const b = s.bot
  const mode = s.state.paused ? '⏸️ Menunggu' : '🎣 Memancing'
  const hp = b ? Math.round(b.health || 0) : 0
  const food = b ? Math.round(b.food || 0) : 0
  const emptySlots = b && b.inventory ? b.inventory.emptySlotCount() : 0

  return `📊 **[${s.username}] LIVE STATUS**
\`\`\`
- Status         : ${mode}
- Total Lemparan : ${s.stats.casts}
- Total Didapat  : ${s.stats.catches}
- Item Terakhir  : ${s.stats.lastCatch}
- Darah / Food   : ❤️ ${hp}/20 | 🍖 ${food}/20
- Slot Kosong    : ${emptySlots}
- Makan          : ${s.stats.meals}x
\`\`\`
*(Update otomatis setiap ${Math.round(CONFIG.statusUpdateIntervalMs / 1000)} detik)*`
}

async function updateDiscordStatusCard(s) {
  if (!s.bot) return
  const { id } = await sendOrEditDiscord(generateStatusMessage(s), s.discordMsgId)
  s.discordMsgId = id
}

function startDiscordCardLoop(s, b) {
  if (s.statusInterval) clearInterval(s.statusInterval)
  s.statusInterval = setInterval(() => {
    if (isAlive(s, b)) updateDiscordStatusCard(s).catch(() => {})
  }, CONFIG.statusUpdateIntervalMs)
}

// ====== MAKAN ======
function pickFood(b) {
  let best = null
  for (const item of b.inventory.items()) {
    const food = b.registry.foodsByName[item.name]
    if (!food || AVOID_FOOD.has(item.name)) continue
    if (!best || food.foodPoints < best.points) best = { item, points: food.foodPoints }
  }
  return best ? best.item : null
}

async function eat(s, b) {
  console.log(`[${s.username}] Lapar (food ${b.food}/20), mulai makan...`)
  for (let i = 0; i < 12 && isAlive(s, b) && !s.state.paused && b.food < CONFIG.eatUntil; i++) {
    const item = pickFood(b)
    if (!item) return
    try {
      await b.equip(item, 'hand')
      await withTimeout(b.consume(), 8000)
      s.stats.meals++
    } catch {
      await sleep(1500)
    }
  }
}

// ====== MEMANCING ======
async function ensureRod(b) {
  const rod = b.inventory.items().find((i) => i.name === 'fishing_rod')
  if (!rod) return false
  if (!b.heldItem || b.heldItem.name !== 'fishing_rod') await b.equip(rod, 'hand')
  return true
}

function customFish(b) {
  return new Promise((resolve, reject) => {
    let bobberId = null
    let settleAt = 0
    let timer = null
    let done = false

    const isBobber = (e) => e && (e.name === 'fishing_bobber' || e.name === 'fishing_float' || e.entityType === 101)

    const onSpawn = (entity) => {
      if (bobberId || !isBobber(entity) || !b.entity) return
      if (entity.position.distanceTo(b.entity.position) < 4) {
        bobberId = entity.id
        settleAt = Date.now() + CONFIG.bobberSettleMs // abaikan gerakan saat pelampung baru jatuh
      }
    }

    const onUpdate = (entity) => {
      if (!bobberId || entity.id !== bobberId || Date.now() < settleAt) return
      const falling = entity.velocity && entity.velocity.y < -0.08
      const biting = Array.isArray(entity.metadata) && entity.metadata.some((m) => m === true || m === 1)
      if (falling || biting) {
        finish(null, true)
      }
    }

    const onGone = (entity) => {
      if (bobberId && entity.id === bobberId) finish(new Error('bobber hilang'), false)
    }

    const onEnd = () => finish(new Error('terputus'), false)

    function cleanup() {
      b.removeListener('entitySpawn', onSpawn)
      b.removeListener('entityUpdate', onUpdate)
      b.removeListener('entityVelocity', onUpdate)
      b.removeListener('entityGone', onGone)
      b.removeListener('end', onEnd)
      if (timer) clearTimeout(timer)
    }

    function finish(err, reel) {
      if (done) return
      done = true
      cleanup()
      if (reel) { try { b.activateItem() } catch {} }
      err ? reject(err) : resolve()
    }

    b.on('entitySpawn', onSpawn)
    b.on('entityUpdate', onUpdate)
    b.on('entityVelocity', onUpdate)
    b.on('entityGone', onGone)
    b.on('end', onEnd)

    try {
      b.activateItem() // lempar
    } catch (err) {
      return finish(err, false)
    }

    timer = setTimeout(() => {
      // Tarik pancingan hanya jika pelampung memang ada, agar tidak melempar dua kali
      finish(new Error('timeout'), Boolean(bobberId))
    }, CONFIG.castTimeoutMs)
  })
}

function toRoman(num) {
  const roman = { M: 1000, CM: 900, D: 500, CD: 400, C: 100, XC: 90, L: 50, XL: 40, X: 10, IX: 9, V: 5, IV: 4, I: 1 }
  let str = ''
  for (const key in roman) {
    while (num >= roman[key]) {
      str += key
      num -= roman[key]
    }
  }
  return str || String(num)
}

function formatEnchantName(name) {
  return String(name)
    .replace(/^minecraft:/, '')
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

function trackCatches(s, b) {
  b.on('playerCollect', (collector, collected) => {
    if (collector !== b.entity) return
    try {
      const rawItem = collected.metadata.find((m) => m && m.itemId)
      if (!rawItem) return
      const itemObj = b.registry.items[rawItem.itemId]
      if (!itemObj) return

      const name = itemObj.displayName || itemObj.name
      let enchants = []

      if (rawItem.nbtData && rawItem.nbtData.value) {
        const nbt = rawItem.nbtData.value
        const list = nbt.Enchantments || nbt.StoredEnchantments
        if (list && list.value && list.value.value) {
          enchants = list.value.value.map((e) => {
            const eName = formatEnchantName(e.id ? e.id.value : 'unknown')
            const eLvl = e.lvl ? e.lvl.value : 1
            return `${eName} ${toRoman(eLvl)}`
          })
        }
      }

      s.stats.lastCatch = enchants.length ? `${name} ✨ (${enchants.join(', ')})` : name
    } catch {}
  })
}

async function fishLoop(s, b) {
  console.log(`[${s.username}] Siap memancing!`)
  let fullNotified = false

  while (isAlive(s, b)) {
    if (s.state.paused) {
      await sleep(500)
      continue
    }

    let hasRod = false
    try { hasRod = await ensureRod(b) } catch {}
    if (!hasRod) {
      await sleep(3000)
      continue
    }

    if (b.food !== undefined && b.food <= CONFIG.eatBelow) {
      await eat(s, b)
      continue
    }

    if (CONFIG.stopWhenFull && b.inventory.emptySlotCount() < 2) {
      if (!fullNotified) {
        fullNotified = true
        sendDiscordEvent(s.username, `🎒 Inventori penuh. Lemparan: ${s.stats.casts} | Didapat: ${s.stats.catches}`)
      }
      await sleep(10000) // lanjut otomatis begitu ada slot kosong
      continue
    }
    fullNotified = false

    s.stats.casts++
    try {
      await customFish(b)
      s.stats.catches++
      s.reconnects = 0
      console.log(`[${s.username}] Berhasil! Lemparan: ${s.stats.casts} | Didapat: ${s.stats.catches}`)
    } catch (e) {
      await sleep(e.message === 'timeout' ? 1500 : 2000)
    }

    await sleep(1000)
  }
}

// ====== CHAT DARI DISCORD ======
function sanitizeChat(text) {
  return String(text)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/§./g, '')
    .trim()
    .slice(0, 256)
}

function isAuthorized(interaction) {
  if (ALLOWED_USER_IDS.length > 0) return ALLOWED_USER_IDS.includes(interaction.user.id)
  return Boolean(interaction.memberPermissions && interaction.memberPermissions.has('Administrator'))
}

async function startDiscordBot() {
  if (!DISCORD_BOT_TOKEN) {
    console.log('[discord] DISCORD_BOT_TOKEN kosong, fitur /chat dinonaktifkan.')
    return
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds] })

  const chatCommand = new SlashCommandBuilder()
    .setName('chat')
    .setDescription('Kirim chat atau command Minecraft lewat bot')
    .addStringOption((o) => o
      .setName('bot')
      .setDescription('Nama bot, atau "semua"')
      .setRequired(true)
      .setAutocomplete(true))
    .addStringOption((o) => o
      .setName('pesan')
      .setDescription('Isi chat, atau command diawali / (contoh: /tpa)')
      .setRequired(true)
      .setMaxLength(256))

  client.once(Events.ClientReady, async (c) => {
    try {
      await c.application.commands.set([chatCommand.toJSON()], DISCORD_GUILD_ID || undefined)
      console.log(`[discord] Login sebagai ${c.user.tag}, command /chat terdaftar.`)
    } catch (e) {
      console.log('[discord] Gagal mendaftarkan command:', e.message)
    }
  })

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isAutocomplete()) {
        if (interaction.commandName !== 'chat') return
        const q = String(interaction.options.getFocused() || '').toLowerCase()
        const names = ['semua', ...ACCOUNTS.map((a) => a.username)]
        await interaction.respond(
          names.filter((n) => n.toLowerCase().includes(q)).slice(0, 25).map((n) => ({ name: n, value: n }))
        )
        return
      }

      if (!interaction.isChatInputCommand() || interaction.commandName !== 'chat') return

      if (!isAuthorized(interaction)) {
        await interaction.reply({ content: '⛔ Kamu tidak punya izin memakai /chat.', flags: MessageFlags.Ephemeral })
        return
      }

      const target = interaction.options.getString('bot', true).trim().toLowerCase()
      const text = sanitizeChat(interaction.options.getString('pesan', true))
      if (!text) {
        await interaction.reply({ content: '⚠️ Pesan kosong.', flags: MessageFlags.Ephemeral })
        return
      }

      let targets
      if (target === 'semua') {
        targets = [...botStates.values()].filter(isOnline)
      } else {
        const s = botStates.get(target)
        if (!s) {
          await interaction.reply({ content: `⚠️ Bot "${target}" tidak ditemukan.`, flags: MessageFlags.Ephemeral })
          return
        }
        if (!isOnline(s)) {
          await interaction.reply({ content: `⚠️ ${s.username} sedang offline.`, flags: MessageFlags.Ephemeral })
          return
        }
        targets = [s]
      }

      if (targets.length === 0) {
        await interaction.reply({ content: '⚠️ Tidak ada bot yang online.', flags: MessageFlags.Ephemeral })
        return
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral })

      const sent = []
      for (let i = 0; i < targets.length; i++) {
        const s = targets[i]
        if (!isOnline(s)) continue
        try {
          s.bot.chat(text)
          sent.push(s.username)
          sendDiscordEvent(s.username, `💬 ${interaction.user.tag} mengirim: \`${text.replace(/`/g, "'")}\``)
        } catch (e) {
          console.log(`[${s.username}] Gagal chat:`, e.message)
        }
        if (i < targets.length - 1) await sleep(CONFIG.chatStaggerMs)
      }

      await interaction.editReply(
        sent.length
          ? `✅ Terkirim lewat ${sent.join(', ')}: \`${text.replace(/`/g, "'")}\``
          : '⚠️ Gagal mengirim pesan.'
      )
    } catch (e) {
      console.log('[discord] Error interaksi:', e.message)
      try {
        if (interaction.deferred || interaction.replied) await interaction.editReply('⚠️ Terjadi error.')
        else if (interaction.isRepliable()) await interaction.reply({ content: '⚠️ Terjadi error.', flags: MessageFlags.Ephemeral })
      } catch {}
    }
  })

  client.on('error', (e) => console.log('[discord] Error:', e.message))
  await client.login(DISCORD_BOT_TOKEN)
}

// ====== BOT MINECRAFT ======
function createBotAccount(acc, delayMs) {
  const s = {
    username: acc.username,
    password: acc.password,
    bot: null,
    ended: true,
    shuttingDown: false,
    reconnects: 0,
    discordMsgId: null,
    statusInterval: null,
    stats: { casts: 0, catches: 0, meals: 0, lastCatch: 'Belum ada' },
    state: { paused: false, dead: false },
  }
  botStates.set(acc.username.toLowerCase(), s)

  function connect() {
    if (s.shuttingDown) return
    sendDiscordEvent(s.username, `Menghubungkan ke ${CONFIG.host}...`)

    const b = mineflayer.createBot({
      host: CONFIG.host,
      port: CONFIG.port,
      username: s.username,
      auth: CONFIG.auth,
    })

    s.bot = b
    s.ended = false
    s.state.paused = false
    s.state.dead = false

    let authSent = false
    let firstSpawn = true

    b.on('messagestr', (msg) => {
      if (authSent) return
      if (/\/register/i.test(msg)) {
        authSent = true
        b.chat(`/register ${s.password} ${s.password}`)
      } else if (/\/login/i.test(msg)) {
        authSent = true
        b.chat(`/login ${s.password}`)
      }
    })

    b.on('error', (e) => sendDiscordEvent(s.username, `⚠️ Error: ${e.message}`))
    b.on('kicked', (r) => sendDiscordEvent(s.username, `❌ Kicked: ${typeof r === 'string' ? r : JSON.stringify(r)}`))

    b.on('death', () => {
      s.state.dead = true
      s.state.paused = true
      sendDiscordEvent(s.username, '💀 Bot mati, menunggu respawn...')
    })

    b.once('end', () => {
      s.ended = true
      if (s.statusInterval) clearInterval(s.statusInterval)
      sendDiscordEvent(s.username, `🔌 Terputus. Total didapat: ${s.stats.catches}`)
      if (s.shuttingDown) return
      s.reconnects++
      if (s.reconnects <= CONFIG.maxReconnect) {
        setTimeout(connect, CONFIG.reconnectDelayMs)
      } else {
        sendDiscordEvent(s.username, '🛑 Batas reconnect tercapai, bot berhenti.')
      }
    })

    trackCatches(s, b)

    b.on('spawn', async () => {
      try {
        if (firstSpawn) {
          firstSpawn = false
          sendDiscordEvent(s.username, '✅ Berhasil masuk ke server!')
          for (let i = 0; i < 30 && !authSent && isAlive(s, b); i++) await sleep(500)
          await sleep(CONFIG.afterLoginWaitMs)
          if (!isAlive(s, b)) return

          // tutup menu/GUI yang mungkin terbuka setelah login
          for (let i = 0; i < 3 && isAlive(s, b); i++) {
            if (b.currentWindow) { try { b.closeWindow(b.currentWindow) } catch {} }
            await sleep(1000)
          }
          if (!isAlive(s, b)) return

          await updateDiscordStatusCard(s)
          startDiscordCardLoop(s, b)
          fishLoop(s, b).catch((e) => console.log(`[${s.username}] ERROR loop:`, e.message))
          return
        }

        // spawn berikutnya: hanya tangani respawn setelah mati
        if (!s.state.dead) return
        s.state.dead = false
        sendDiscordEvent(s.username, '🔄 Respawn, mengirim /back...')
        await sleep(3000)
        if (!isAlive(s, b)) return
        b.chat('/back')
        await sleep(2000)
        s.state.paused = false
      } catch (e) {
        console.log(`[${s.username}] Error spawn:`, e.message)
        s.state.paused = false
      }
    })
  }

  setTimeout(connect, delayMs)
}

// ====== START ======
ACCOUNTS.forEach((acc, index) => createBotAccount(acc, index * CONFIG.loginStaggerMs))

startDiscordBot().catch((e) => console.log('[discord] Gagal start:', e.message))

process.on('SIGINT', () => {
  for (const s of botStates.values()) {
    s.shuttingDown = true
    try { s.bot && s.bot.quit() } catch {}
  }
  setTimeout(() => process.exit(0), 1000)
})

process.on('unhandledRejection', (e) => console.log('[unhandledRejection]', e && e.message ? e.message : e))
