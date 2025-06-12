require("dotenv").config();
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const pool = require("./db");
const { sendOTP } = require("./email");
const cron = require("node-cron");
const rateLimit = require("express-rate-limit");

// ── PASTE YOUR DOUBTS CHANNEL ID HERE ────────────────────────────────────
const QUESTIONS_CHANNEL_ID = "1381593523698143232"; 
// ─────────────────────────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// Generate a 6-digit OTP
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Schedule daily reminders for unresolved doubts
function scheduleDoubtReminders() {
  // runs daily at 10:00 AM server time
  cron.schedule("0 10 * * *", async () => {
    const { rows } = await pool.query(
      "SELECT author_id, array_agg(id) AS pending_ids FROM doubts WHERE resolved = false GROUP BY author_id"
    );
    for (const r of rows) {
      try {
        const user = await client.users.fetch(r.author_id);
        await user.send(
          `🔔 You have ${r.pending_ids.length} unresolved doubts (IDs: ${r.pending_ids.join(", ")}).`
        );
      } catch {
        console.warn(`Could not DM reminder to ${r.author_id}`);
      }
    }
  });
}

client.once("ready", () => {
  console.log(`✅ Bot online as ${client.user.tag}`);
  scheduleDoubtReminders();
});

// Welcome DM handler
client.on("guildMemberAdd", async (member) => {
  try {
    const welcomeEmbed = new EmbedBuilder()
      .setTitle('👋 Welcome to AlgoPath!')
      .setDescription([
        `Hi **${member.user.username}**, welcome aboard!`,
        '',
        '**Note**: You will only be able to join the AlgoPath community if your email is registered with AlgoPath.',
        '',
        '**If already registered**, then follow the below steps to get verified and join the community',
        '',
        '**Getting Started Tips:**',
        '- Use `!verify your@algopath.com` in #welcome to register',
        '- Follow the DM instructions to complete OTP verification',
        '- Then ask doubts in #doubts with `!ask`',
        '- View or resolve them with `!doubts`/`!resolve`',
        '',
        '_If you don’t see the email, check your spam folder or wait a minute._'
      ].join('\n'))
      .setFooter({ text: 'Need help? Use !help' })
      .setTimestamp();

    await member.send({ embeds: [welcomeEmbed] });
  } catch {
    console.warn(`DM failed for ${member.user.tag}`);
  }
});

client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild) return;

  const [command, ...args] = message.content.trim().split(/\s+/);

  // ── RESTRICT DOUBT COMMANDS TO #questions ───────────────────────────────────
  const doubtCommands = ["!ask", "!resolve", "!doubts"];
  if (doubtCommands.includes(command) && message.channel.id !== QUESTIONS_CHANNEL_ID) {
    return message.reply(`❌ Please use this command only in <#${QUESTIONS_CHANNEL_ID}>.`);
  }
  // ─────────────────────────────────────────────────────────────────────────────

  // ---- Doubt commands ----
  if (command === "!ask") {
    const question = args.join(" ");
    if (!question) return message.reply("❌ Please provide a question after !ask.");
    const { rows } = await pool.query(
      "INSERT INTO doubts (author_id, question) VALUES ($1, $2) RETURNING id",
      [message.author.id, question]
    );
    return message.reply(`✅ Doubt submitted (ID: ${rows[0].id}). Someone will help soon!`);
  }

  if (command === "!resolve") {
    const id = parseInt(args[0]);
    if (!id) return message.reply("❌ Please provide a valid doubt ID.");
    const { rows } = await pool.query(
      "SELECT resolved, author_id FROM doubts WHERE id = $1",
      [id]
    );
    if (!rows.length || rows[0].author_id !== message.author.id) {
      return message.reply("❌ Doubt ID not found or not your doubt.");
    }
    if (rows[0].resolved) return message.reply("ℹ️ This doubt is already resolved.");

    await pool.query(
      "UPDATE doubts SET resolved = true, resolved_by = $1, resolved_at = NOW() WHERE id = $2",
      [message.author.id, id]
    );
    return message.reply(`✅ Doubt ${id} marked as resolved. Great job!`);
  }

  if (command === "!doubts") {
    const filter = args[0];
    let sql = "SELECT id, question, resolved FROM doubts WHERE author_id = $1";
    const params = [message.author.id];
    if (filter === "open") sql += " AND resolved = false";
    else if (filter === "closed") sql += " AND resolved = true";
    sql += " ORDER BY id";

    const { rows } = await pool.query(sql, params);
    if (!rows.length) return message.reply("ℹ️ You have no doubts matching that filter.");

    const total = rows.length;
    const open = rows.filter(d => !d.resolved).length;
    const closed = total - open;
    const embed = new EmbedBuilder()
      .setTitle(`Your Doubts (${filter || 'all'})`)
      .setDescription(
        rows.map(d => `• [${d.id}] ${d.question} — ${d.resolved ? '✅' : '❌'}`).join("\n")
      )
      .setFooter({ text: `Total: ${total} | Open: ${open} | Closed: ${closed}` });

    return message.reply({ embeds: [embed] });
  }

  // ---- Verification commands (unchanged) ----
  if (command === "!verify") {
    const email = args[0];
    if (!email || !email.includes("@")) return message.reply("❌ Please provide a valid email.");
    try {
      const allowed = await pool.query(
        "SELECT 1 FROM allowed_emails WHERE email = $1",
        [email]
      );
      if (!allowed.rows.length) return message.reply("❌ This email is not authorized.");

      const otp = generateOTP();
      const expires = new Date(Date.now() + 5 * 60 * 1000);
      await pool.query(
        "INSERT INTO users (discord_id, email, otp, otp_expires, verified) VALUES ($1,$2,$3,$4,false) ON CONFLICT (email) DO UPDATE SET otp = EXCLUDED.otp, otp_expires = EXCLUDED.otp_expires",
        [message.author.id, email, otp, expires]
      );
      await sendOTP(email, otp);
      return message.reply("📧 OTP has been sent to your email. Use `!otp <code>` to verify.");
    } catch (err) {
      console.error(err);
      return message.reply("⚠️ Error sending OTP. Please try again later.");
    }
  }

  if (command === "!otp") {
    const otp = args[0];
    if (!otp) return message.reply("❌ Please enter the OTP code.");
    try {
      const { rows } = await pool.query(
        "SELECT discord_id FROM users WHERE discord_id = $1 AND otp = $2 AND otp_expires > NOW()",
        [message.author.id, otp]
      );
      if (!rows.length) return message.reply("❌ Invalid or expired OTP.");

      await pool.query(
        "UPDATE users SET verified = true WHERE discord_id = $1",
        [message.author.id]
      );
      const member = await message.guild.members.fetch(message.author.id);
      const role = message.guild.roles.cache.find(r => r.name === "Member");
      if (role) await member.roles.add(role);
      return message.reply("✅ Verification successful! You've been granted access.");
    } catch (err) {
      console.error(err);
      return message.reply("⚠️ Something went wrong. Try again later.");
    }
  }
});


// ─── Web-server for invite page ─────────────────────────────────────────
const express = require("express");
const path    = require("path");
const app     = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Rate limiter: max 5 requests per 15 minutes per IP
const inviteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,                   // Limit each IP to 5 requests
  message: {
    error: "Too many requests. Please try again after 15 minutes."
  }
});

// Apply to invite endpoint only
app.use('/get-discord-invite', inviteLimiter);

app.post("/get-discord-invite", async (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes("@")) {
    return res.status(400).json({ error: "Please provide a valid email." });
  }

  try {
    const { rows } = await pool.query(
      "SELECT 1 FROM allowed_emails WHERE email = $1", [email]
    );
    if (!rows.length) {
      return res.status(403).json({ error: "Email not authorized." });
    }

    const channel = await client.channels.fetch(process.env.INVITE_CHANNEL_ID);
    const invite  = await channel.createInvite({
      maxUses: 1, maxAge: 3600, unique: true
    });

    return res.json({ invite: `https://discord.gg/${invite.code}` });
  } catch (err) {
    console.error("Invite generation error:", err);
    return res.status(500).json({ error: "Server error. Try again later." });
  }
});

const WEB_PORT = process.env.WEB_PORT || 3000;
app.listen(WEB_PORT, () =>
  console.log(`🌐 Invite server listening on http://localhost:${WEB_PORT}`)
);
// ─────────────────────────────────────────────────────────────────────────
client.login(process.env.DISCORD_TOKEN);
