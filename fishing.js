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

// ====== KONFIGURASI DISCORD (isi lewat environment variable) ======
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || ''   // untuk status & log
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || ''       // untuk slash command /chat
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || ''         // opsional, agar /chat muncul instan
const ALLOWED_USER_IDS = (process.env.ALLOWED_USER_IDS || '')       // ID Discord yang boleh pakai /chat, pisah koma
  .split(',').map((s) => s.trim()).filter(Boolean)

// Daftar Akun
const ACCOUNTS = [
  { username: 'SolTheMayo', password: 'memek#1' },
  //{ username: 'Izanagi', password: 'memek#1' },//
  //{ username: 'Izanami', password: 'memek#1' },//
  //{ username: 'Itadori', password: 'memek#1' },//
]

const CONFIG = {
  host: 'valoriasmp.id',
  port: 25565,
  auth: 'offline',
  version: process.env.MC_VERSION || '1.21.6',
  eatBelow: 6,
  eatUntil: 18,
  afterLoginWaitMs: 5000,
  castTimeoutMs: 40000,
  stopWhenFull: false,
  maxReconnect: 10,
  reconnectDelayMs: 20000,
  statusUpdateIntervalMs: 25000,
  loginStaggerMs: 25000,
  chatStaggerMs: 1000,
  errorNotifyCooldownMs: 60000,
}

const AVOID_FOOD = new Set([
  'pufferfish', 'spider_eye', 'rotten_flesh', 'poisonous_potato', 'chicken',
  'suspicious_stew', 'golden_apple', 'enchanted_golden_apple', 'chorus_fruit',
  'tropical_fish',
])

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const botStates = new Map() // username (lowercase) -> botState

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ])
}

// ====== DISCORD WEBHOOK ======
function sendOrEditDiscord(message, messageId = null) {
  return new Promise((resolve) => {
    if (!DISCORD_WEBHOOK_URL) return resolve({ id: null })
    try {
      const isEdit = Boolean(messageId)
      const targetUrl = isEdit ? `${DISCORD_WEBHOOK_URL}/messages/${messageId}` : `${DISCORD_WEBHOOK_URL}?wait=true`
      const url = new URL(targetUrl)
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
          } catch (e) {}
          resolve({ id })
        })
      })

      req.on('error', () => resolve({ id: messageId }))
      req.write(data)
      req.end()
    } catch (e) {
      resolve({ id: messageId })
    }
  })
}

function sendDiscordEvent(username, text) {
  console.log(`[${username}] ${text}`)
  sendOrEditDiscord(`**[${username}]** ${text}`).catch(() => {})
}

const active = (botState) => botState.bot && !botState.shuttingDown && !botState.ended
const idle = (botState) => botState.state.paused
const isOnline = (botState) => Boolean(active(botState) && botState.bot.entity)

function generateStatusMessage(botState) {
  const b = botState.bot
  const mode = botState.state.paused ? '⏸️ Menunggu' : '🎣 Memancing'
  const hp = b ? Math.round(b.health || 0) : 0
  const food = b ? Math.round(b.food || 0) : 0
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
  const { id } = await sendOrEditDiscord(msgText, botState.discordMsgId)
  botState.discordMsgId = id
}

function startDiscordCardLoop(botState) {
  if (botState.statusInterval) clearInterval(botState.statusInterval)
  botState.statusInterval = setInterval(() => {
    if (active(botState)) {
      updateDiscordStatusCard(botState).catch(() => {})
    }
  }, CONFIG.statusUpdateIntervalMs)
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

async function fishLoop(botState, b) {
  console.log(`[${botState.username}] Siap memancing!`)
  let fullNotified = false
  let noRodNotified = false

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

  // Loop hanya berjalan selama koneksi ini masih yang aktif (mencegah loop ganda saat reconnect)
  while (botState.bot === b && active(botState)) {
    if (idle(botState)) {
      await sleep(500)
      continue
    }

    let hasRod = false
    try {
      hasRod = await ensureRod(b)
    } catch (e) {}

    if (!hasRod) {
      if (!noRodNotified) {
        noRodNotified = true
        sendDiscordEvent(botState.username, '🎣 Fishing rod tidak ditemukan di inventori.')
      }
      await sleep(3000)
      continue
    }
    noRodNotified = false

    if (b.food !== undefined && b.food <= CONFIG.eatBelow) {
      await eat(botState)
      continue
    }

    if (CONFIG.stopWhenFull && b.inventory.emptySlotCount() < 2) {
      if (!fullNotified) {
        fullNotified = true
        sendDiscordEvent(botState.username, `🎒 Inventori penuh. Total Lemparan: ${botState.stats.casts} | Total Didapat: ${botState.stats.catches}`)
      }
      await sleep(10000) // lanjut otomatis begitu ada slot kosong
      continue
    }
    fullNotified = false

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

// ====== CHAT DARI DISCORD (/chat) ======
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

      const safeText = text.replace(/`/g, "'")
      const sent = []
      for (let i = 0; i < targets.length; i++) {
        const s = targets[i]
        if (!isOnline(s)) continue
        try {
          s.bot.chat(text)
          sent.push(s.username)
          sendDiscordEvent(s.username, `💬 ${interaction.user.tag} mengirim: \`${safeText}\``)
        } catch (e) {
          console.log(`[${s.username}] Gagal chat:`, e.message)
        }
        if (i < targets.length - 1) await sleep(CONFIG.chatStaggerMs)
      }

      await interaction.editReply(
        sent.length ? `✅ Terkirim lewat ${sent.join(', ')}: \`${safeText}\`` : '⚠️ Gagal mengirim pesan.'
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
  const botState = {
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
  botStates.set(acc.username.toLowerCase(), botState)

  function connect() {
    if (botState.shuttingDown) return
    sendDiscordEvent(botState.username, `Menghubungkan ke ${CONFIG.host} (versi ${CONFIG.version})...`)

    const b = mineflayer.createBot({
      host: CONFIG.host,
      port: CONFIG.port,
      username: botState.username,
      auth: CONFIG.auth,
      ...(CONFIG.version ? { version: CONFIG.version } : {}),
    })

    botState.bot = b
    botState.ended = false
    botState.state.paused = false
    botState.state.dead = false
    let authSent = false
    let lastErrAt = 0

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
    })

    b.on('error', (e) => {
      console.log(`[${botState.username}] Error: ${e.message}`)
      // Batasi notifikasi agar webhook tidak kebanjiran
      if (Date.now() - lastErrAt > CONFIG.errorNotifyCooldownMs) {
        lastErrAt = Date.now()
        sendOrEditDiscord(`**[${botState.username}]** ⚠️ Error: ${e.message}`).catch(() => {})
      }
    })

    b.on('kicked', (r) => sendDiscordEvent(botState.username, `❌ Kicked: ${typeof r === 'string' ? r : JSON.stringify(r)}`))

    b.on('death', () => {
      sendDiscordEvent(botState.username, '💀 Bot Mati, bersiap untuk respawn...')
      botState.state.dead = true
      botState.state.paused = true
    })

    // Respawn: hanya setelah mati (bukan saat pindah dunia)
    b.on('respawn', async () => {
      if (!botState.state.dead) return
      botState.state.dead = false
      sendDiscordEvent(botState.username, '🔄 Respawned. Mengirim /back...')
      await sleep(3000)
      if (botState.bot === b && active(botState)) {
        b.chat('/back')
        await sleep(2000)
        botState.state.paused = false
      }
    })

    b.once('end', () => {
      botState.ended = true
      if (botState.statusInterval) clearInterval(botState.statusInterval)
      sendDiscordEvent(botState.username, `🔌 Terputus. Total Didapat: ${botState.stats.catches}`)
      if (!botState.shuttingDown) {
        botState.reconnects++
        if (botState.reconnects <= CONFIG.maxReconnect) {
          setTimeout(connect, CONFIG.reconnectDelayMs)
        } else {
          sendDiscordEvent(botState.username, '🛑 Batas reconnect tercapai, bot berhenti.')
        }
      }
    })

    b.once('spawn', async () => {
      sendDiscordEvent(botState.username, '✅ Berhasil masuk ke server!')
      for (let i = 0; i < 30 && !authSent; i++) await sleep(500)
      await sleep(CONFIG.afterLoginWaitMs)
      if (botState.bot !== b || !active(botState)) return
      await dismissMenu(b)
      if (botState.bot !== b || !active(botState)) return

      await updateDiscordStatusCard(botState)
      startDiscordCardLoop(botState)

      fishLoop(botState, b).catch((e) => console.log(`[${botState.username}] ERROR loop:`, e.message))
    })
  }

  setTimeout(connect, delayMs)
}

// JEDA LOGIN: 25 DETIK PER BOT
ACCOUNTS.forEach((acc, index) => {
  createBotAccount(acc, index * CONFIG.loginStaggerMs)
})

startDiscordBot().catch((e) => console.log('[discord] Gagal start:', e.message))

process.on('SIGINT', () => {
  for (const s of botStates.values()) {
    s.shuttingDown = true
    try { s.bot && s.bot.quit() } catch {}
  }
  setTimeout(() => process.exit(0), 1000)
})

// Cegah proses mati karena error dari library (contoh: "unknown chat format code")
process.on('uncaughtException', (e) => console.log('[uncaughtException]', e && e.message ? e.message : e))
process.on('unhandledRejection', (e) => console.log('[unhandledRejection]', e && e.message ? e.message : e))
