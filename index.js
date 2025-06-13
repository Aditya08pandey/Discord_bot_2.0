
require("dotenv").config();
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const pool = require("./db");
const { sendOTP } = require("./email");
const cron = require("node-cron");
const rateLimit = require("express-rate-limit");
const fs = require("fs");


// ── CHANNEL IDS ──────────────────────────────────────────────────────────
const QUESTIONS_CHANNEL_ID = "1381593523698143232"; 
const CHALLENGE_CHANNEL_ID = "1382729944110727249"; // Replace with actual ID
const SUBMISSION_CHANNEL_ID = "1382730050960625737"; // Replace with actual ID
// ─────────────────────────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
});

// Generate a 6-digit OTP
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Load challenges from JSON file
function loadChallenges() {
  try {
    const data = fs.readFileSync('./challenges.json', 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error loading challenges:', error);
    return [];
  }
}

// Get random challenge
function getRandomChallenge() {
  const challenges = loadChallenges();
  if (challenges.length === 0) return null;
  return challenges[Math.floor(Math.random() * challenges.length)];
}

// Schedule weekly challenge system
function scheduleChallengeSystem() {
  // Post weekly challenge every Monday at 9:00 AM
  cron.schedule("0 9 * * 1", async () => {
    const challenge = getRandomChallenge();
    if (!challenge) {
      console.error('No challenges available');
      return;
    }

    try {
      // Clear previous challenge data
      await pool.query("DELETE FROM submission_votes");
      await pool.query("DELETE FROM challenge_submissions");
      
      const challengeChannel = await client.channels.fetch(CHALLENGE_CHANNEL_ID);
      
      const challengeEmbed = new EmbedBuilder()
        .setTitle('🏆 Weekly Challenge!')
        .setDescription(challenge.description || challenge.title || challenge.name)
        .addFields(
          { name: '📅 Submission Deadline', value: 'Thursday 11:59 PM', inline: true },
          { name: '🗳️ Voting Period', value: 'Thursday - Saturday', inline: true },
          { name: '📝 How to Submit', value: `Post your solution in <#${SUBMISSION_CHANNEL_ID}>`, inline: false }
        )
        .setColor('#00FF00')
        .setTimestamp()
        .setFooter({ text: 'Good luck everyone! 🚀' });

      const message = await challengeChannel.send({ embeds: [challengeEmbed] });
      
      // Store current challenge info in database
      await pool.query(
        "INSERT INTO current_challenge (message_id, challenge_data, status, created_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (id) DO UPDATE SET message_id = EXCLUDED.message_id, challenge_data = EXCLUDED.challenge_data, status = EXCLUDED.status, created_at = EXCLUDED.created_at",
        [message.id, JSON.stringify(challenge), 'active']
      );

      console.log('✅ Weekly challenge posted successfully, previous data cleared');
    } catch (error) {
      console.error('Error posting weekly challenge:', error);
    }
  });

  // Close challenge submissions every Thursday at 11:59 PM
  cron.schedule("59 23 * * 4", async () => {
    try {
      const challengeChannel = await client.channels.fetch(CHALLENGE_CHANNEL_ID);
      
      const closeEmbed = new EmbedBuilder()
        .setTitle('⏰ Challenge Submissions Closed!')
        .setDescription('The submission period for this week\'s challenge has ended.')
        .addFields(
          { name: '🗳️ What\'s Next?', value: 'Voting is now open! Check the submissions and vote for your favorites.', inline: false },
          { name: '📊 Voting Deadline', value: 'Saturday 11:59 PM', inline: true }
        )
        .setColor('#FF9900')
        .setTimestamp();

      await challengeChannel.send({ embeds: [closeEmbed] });
      
      // Update challenge status
      await pool.query(
        "UPDATE current_challenge SET status = $1 WHERE id = 1",
        ['voting']
      );

      console.log('✅ Challenge submissions closed');
    } catch (error) {
      console.error('Error closing challenge submissions:', error);
    }
  });

  // Close voting every Saturday at 11:59 PM
  cron.schedule("59 23 * * 6", async () => {
    try {
      const challengeChannel = await client.channels.fetch(CHALLENGE_CHANNEL_ID);
      
      const votingCloseEmbed = new EmbedBuilder()
        .setTitle('🗳️ Voting Period Ended!')
        .setDescription('The voting period for this week\'s challenge has ended.')
        .addFields(
          { name: '🎉 Results', value: 'Thank you everyone for participating! Check back Monday for the next challenge.', inline: false }
        )
        .setColor('#FF0000')
        .setTimestamp();

      await challengeChannel.send({ embeds: [votingCloseEmbed] });
      
      // Update challenge status
      await pool.query(
        "UPDATE current_challenge SET status = $1 WHERE id = 1",
        ['completed']
      );

      console.log('✅ Voting period closed');
    } catch (error) {
      console.error('Error closing voting period:', error);
    }
  });
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

// Handle voting reactions
async function handleVotingReaction(reaction, user) {
  // Don't handle bot reactions
  if (user.bot) return;

  const message = reaction.message;
  
  // Check if this is in the submission channel
  if (message.channel.id !== SUBMISSION_CHANNEL_ID) return;

  // Check if it's a valid voting emoji (1-5)
  const validEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];
  if (!validEmojis.includes(reaction.emoji.name)) return;

  try {
    // Check if voting is active (allow both 'voting' and 'active' for testing)
    const { rows: challengeRows } = await pool.query(
      "SELECT status FROM current_challenge WHERE id = 1"
    );
    
    if (!challengeRows.length || (challengeRows[0].status !== 'voting' && challengeRows[0].status !== 'active')) {
      // Remove the reaction if voting is not active
      await reaction.users.remove(user.id);
      return;
    }

    // Check if user is trying to vote on their own submission
    if (message.author.id === user.id) {
      await reaction.users.remove(user.id);
      try {
        await user.send('❌ You cannot vote on your own submission!');
      } catch (error) {
        console.log('Could not DM user about self-voting');
      }
      return;
    }

    // Check if user has already voted on this submission
    const { rows: existingVotes } = await pool.query(
      "SELECT emoji FROM submission_votes WHERE message_id = $1 AND voter_id = $2",
      [message.id, user.id]
    );

    // If user already voted, handle the vote change
    if (existingVotes.length > 0) {
      const oldEmoji = existingVotes[0].emoji;
      if (oldEmoji !== reaction.emoji.name) {
        // Remove old reaction from Discord
        const oldReaction = message.reactions.cache.find(r => r.emoji.name === oldEmoji);
        if (oldReaction) {
          await oldReaction.users.remove(user.id);
        }
        
        // Update vote in database
        await pool.query(
          "UPDATE submission_votes SET emoji = $1, voted_at = NOW() WHERE message_id = $2 AND voter_id = $3",
          [reaction.emoji.name, message.id, user.id]
        );
        console.log(`Updated vote: ${user.username} changed from ${oldEmoji} to ${reaction.emoji.name}`);
      } else {
        // Same emoji clicked again - this is handled by Discord naturally
        console.log(`Same vote maintained: ${user.username} voted ${reaction.emoji.name}`);
      }
    } else {
      // New vote - store in database
      await pool.query(
        "INSERT INTO submission_votes (message_id, voter_id, emoji, voted_at) VALUES ($1, $2, $3, NOW())",
        [message.id, user.id, reaction.emoji.name]
      );
      console.log(`New vote: ${user.username} voted ${reaction.emoji.name}`);
    }

    // CRITICAL: Remove all other emoji reactions from this user on this message
    const allReactions = message.reactions.cache;
    for (const [emojiName, reactionObj] of allReactions) {
      if (validEmojis.includes(emojiName) && emojiName !== reaction.emoji.name) {
        // Check if user has reacted to this emoji
        const userReacted = await reactionObj.users.fetch().then(users => users.has(user.id)).catch(() => false);
        if (userReacted) {
          await reactionObj.users.remove(user.id);
          console.log(`Removed old reaction ${emojiName} from ${user.username}`);
        }
      }
    }

  } catch (error) {
    console.error('Error handling voting reaction:', error);
  }
}

// Handle reaction removal
async function handleVotingReactionRemove(reaction, user) {
  if (user.bot) return;
  
  const message = reaction.message;
  if (message.channel.id !== SUBMISSION_CHANNEL_ID) return;
  
  const validEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];
  if (!validEmojis.includes(reaction.emoji.name)) return;

  try {
    // Remove vote from database
    await pool.query(
      "DELETE FROM submission_votes WHERE message_id = $1 AND voter_id = $2 AND emoji = $3",
      [message.id, user.id, reaction.emoji.name]
    );
  } catch (error) {
    console.error('Error removing vote:', error);
  }
}

client.once("ready", () => {
  console.log(`✅ Bot online as ${client.user.tag}`);
  scheduleDoubtReminders();
  scheduleChallengeSystem();
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
        '_If you don not see the email, check your spam folder or wait a minute._'
      ].join('\n'))
      .setFooter({ text: 'Need help? Use !help' })
      .setTimestamp();

    await member.send({ embeds: [welcomeEmbed] });
  } catch {
    console.warn(`DM failed for ${member.user.tag}`);
  }
});

// Handle reactions
client.on('messageReactionAdd', handleVotingReaction);
client.on('messageReactionRemove', handleVotingReactionRemove);

client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild) return;

  const [command, ...args] = message.content.trim().split(/\s+/);

  // ── RESTRICT DOUBT COMMANDS TO #questions ───────────────────────────────────
  const doubtCommands = ["!ask", "!resolve", "!doubts"];
  if (doubtCommands.includes(command) && message.channel.id !== QUESTIONS_CHANNEL_ID) {
    return message.reply(`❌ Please use this command only in <#${QUESTIONS_CHANNEL_ID}>.`);
  }
  // ─────────────────────────────────────────────────────────────────────────────

  // Handle submissions in submission channel
  if (message.channel.id === SUBMISSION_CHANNEL_ID && !message.content.startsWith('!')) {
    try {
      // Check if challenge is active
      const { rows: challengeRows } = await pool.query(
        "SELECT status FROM current_challenge WHERE id = 1"
      );
      
      if (challengeRows.length > 0 && challengeRows[0].status === 'active') {
        // Add voting emojis to the submission
        const votingEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];
        for (const emoji of votingEmojis) {
          await message.react(emoji);
        }
        
        // Store submission in database
        await pool.query(
          "INSERT INTO challenge_submissions (message_id, author_id, content, submitted_at) VALUES ($1, $2, $3, NOW())",
          [message.id, message.author.id, message.content]
        );
      } else {
        // Challenge is not active for submissions
        await message.reply('❌ No active challenge for submissions right now. Check back on Monday for the new challenge!');
      }
    } catch (error) {
      console.error('Error handling submission:', error);
    }
  }

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

  // ---- TESTING COMMANDS FOR CHALLENGE SYSTEM ----
  if (command === "!test-challenge") {
    // Check if channel IDs are properly configured
    if (CHALLENGE_CHANNEL_ID.includes("REPLACE_WITH") || SUBMISSION_CHANNEL_ID.includes("REPLACE_WITH")) {
      return message.reply('❌ Please update the CHALLENGE_CHANNEL_ID and SUBMISSION_CHANNEL_ID in your code with actual Discord channel IDs.');
    }

    // Manual trigger for posting a challenge
    const challenge = getRandomChallenge();
    if (!challenge) {
      return message.reply('❌ No challenges available in challenges.json');
    }

    try {
      // Clear previous challenge data (submissions and votes)
      await pool.query("DELETE FROM submission_votes");
      await pool.query("DELETE FROM challenge_submissions");
      
      const challengeChannel = await client.channels.fetch(CHALLENGE_CHANNEL_ID);
      
      const challengeEmbed = new EmbedBuilder()
        .setTitle('🏆 Test Challenge!')
        .setDescription(challenge.description || challenge.title || challenge.name)
        .addFields(
          { name: '📅 Submission Deadline', value: 'Test Mode - No deadline', inline: true },
          { name: '🗳️ Voting Period', value: 'Test Mode - Vote anytime', inline: true },
          { name: '📝 How to Submit', value: `Post your solution in <#${SUBMISSION_CHANNEL_ID}>`, inline: false }
        )
        .setColor('#00FF00')
        .setTimestamp()
        .setFooter({ text: 'Test Challenge - Good luck! 🚀' });

      const challengeMessage = await challengeChannel.send({ embeds: [challengeEmbed] });
      
      // Store current challenge info in database
      await pool.query(
        "INSERT INTO current_challenge (message_id, challenge_data, status, created_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (id) DO UPDATE SET message_id = EXCLUDED.message_id, challenge_data = EXCLUDED.challenge_data, status = EXCLUDED.status, created_at = EXCLUDED.created_at",
        [challengeMessage.id, JSON.stringify(challenge), 'active']
      );

      return message.reply('✅ Test challenge posted! Previous challenge data cleared. Go submit solutions in the submission channel.');
    } catch (error) {
      console.error('Error posting test challenge:', error);
      return message.reply('❌ Error posting test challenge. Check console for details.');
    }
  }

  if (command === "!test-voting") {
    // Enable voting mode
    try {
      await pool.query(
        "UPDATE current_challenge SET status = $1 WHERE id = 1",
        ['voting']
      );
      
      const challengeChannel = await client.channels.fetch(CHALLENGE_CHANNEL_ID);
      const testEmbed = new EmbedBuilder()
        .setTitle('🗳️ Test Voting Mode Enabled!')
        .setDescription('Voting is now active for testing. Go vote on submissions!')
        .setColor('#FF9900')
        .setTimestamp();

      await challengeChannel.send({ embeds: [testEmbed] });
      return message.reply('✅ Voting mode enabled! You can now vote on submissions.');
    } catch (error) {
      console.error('Error enabling voting:', error);
      return message.reply('❌ Error enabling voting mode.');
    }
  }

  if (command === "!test-close") {
    // Close voting and reset
    try {
      await pool.query(
        "UPDATE current_challenge SET status = $1 WHERE id = 1",
        ['completed']
      );
      
      const challengeChannel = await client.channels.fetch(CHALLENGE_CHANNEL_ID);
      const closeEmbed = new EmbedBuilder()
        .setTitle('🔒 Test Challenge Closed!')
        .setDescription('Test challenge has been closed. Use !test-challenge to start a new one.')
        .setColor('#FF0000')
        .setTimestamp();

      await challengeChannel.send({ embeds: [closeEmbed] });
      return message.reply('✅ Test challenge closed!');
    } catch (error) {
      console.error('Error closing test challenge:', error);
      return message.reply('❌ Error closing test challenge.');
    }
  }

  if (command === "!test-status") {
    // Check current challenge status with improved JSON handling
    try {
      const { rows } = await pool.query(
        "SELECT status, challenge_data, created_at FROM current_challenge WHERE id = 1"
      );
      
      if (!rows.length) {
        return message.reply('❌ No challenge data found. Use !test-challenge to start one.');
      }

      // Safe JSON parsing with error handling
      let challengeData = null;
      try {
        if (rows[0].challenge_data) {
          // Handle case where challenge_data might already be an object
          if (typeof rows[0].challenge_data === 'string') {
            challengeData = JSON.parse(rows[0].challenge_data);
          } else {
            challengeData = rows[0].challenge_data;
          }
        }
      } catch (parseError) {
        console.error('JSON parse error for challenge_data:', parseError);
        challengeData = null;
      }
      
      const createdAt = rows[0].created_at ? new Date(rows[0].created_at).toLocaleString() : 'N/A';
      
      const statusEmbed = new EmbedBuilder()
        .setTitle('📊 Challenge Status')
        .addFields(
          { name: 'Status', value: rows[0].status || 'inactive', inline: true },
          { name: 'Created', value: createdAt, inline: true },
          { name: 'Challenge', value: challengeData ? (challengeData.title || challengeData.name || 'Unknown') : 'None', inline: false }
        )
        .setColor('#0099FF')
        .setTimestamp();

      return message.reply({ embeds: [statusEmbed] });
    } catch (error) {
      console.error('Error checking status:', error);
      return message.reply(`❌ Error checking challenge status: ${error.message}`);
    }
  }

  if (command === "!test-debug") {
    // Debug command to check database and system status
    try {
      // Check if tables exist
      const tableCheck = await pool.query(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name IN ('current_challenge', 'challenge_submissions', 'submission_votes')
      `);
      
      const tables = tableCheck.rows.map(row => row.table_name);
      
      let debugInfo = '**🔍 Debug Information:**\n\n';
      debugInfo += `**Tables Found:** ${tables.join(', ') || 'None'}\n`;
      
      if (tables.includes('current_challenge')) {
        const challengeData = await pool.query('SELECT * FROM current_challenge WHERE id = 1');
        debugInfo += `**Challenge Records:** ${challengeData.rows.length}\n`;
        if (challengeData.rows.length > 0) {
          debugInfo += `**Current Status:** ${challengeData.rows[0].status}\n`;
        }
      }
      
      if (tables.includes('challenge_submissions')) {
        const submissionData = await pool.query('SELECT COUNT(*) as count FROM challenge_submissions');
        debugInfo += `**Total Submissions:** ${submissionData.rows[0].count}\n`;
      }
      
      if (tables.includes('submission_votes')) {
        const voteData = await pool.query('SELECT COUNT(*) as count FROM submission_votes');
        debugInfo += `**Total Votes:** ${voteData.rows[0].count}\n`;
      }
      
      debugInfo += `\n**Channel IDs:**\n`;
      debugInfo += `Challenge: ${CHALLENGE_CHANNEL_ID}\n`;
      debugInfo += `Submission: ${SUBMISSION_CHANNEL_ID}\n`;
      
      return message.reply(debugInfo);
    } catch (error) {
      console.error('Debug error:', error);
      return message.reply(`❌ Debug error: ${error.message}`);
    }
  }

  if (command === "!test-votes") {
    // Show voting statistics for current challenge only
    try {
      const { rows } = await pool.query(`
        SELECT 
          cs.message_id,
          cs.author_id,
          LEFT(cs.content, 50) || '...' as content_preview,
          COUNT(sv.id) as vote_count,
          STRING_AGG(sv.emoji, ', ') as votes,
          AVG(CASE 
            WHEN sv.emoji = '1️⃣' THEN 1
            WHEN sv.emoji = '2️⃣' THEN 2
            WHEN sv.emoji = '3️⃣' THEN 3
            WHEN sv.emoji = '4️⃣' THEN 4
            WHEN sv.emoji = '5️⃣' THEN 5
            ELSE 0
          END) as avg_rating
        FROM challenge_submissions cs
        LEFT JOIN submission_votes sv ON cs.message_id = sv.message_id
        GROUP BY cs.message_id, cs.author_id, cs.content
        ORDER BY avg_rating DESC NULLS LAST, vote_count DESC
      `);

      if (!rows.length) {
        return message.reply('❌ No submissions found for current challenge.');
      }

      const voteEmbed = new EmbedBuilder()
        .setTitle('📈 Current Challenge Voting Statistics')
        .setDescription(
          rows.map((row, index) => 
            `**${index + 1}.** <@${row.author_id}>\n` +
            `Votes: ${row.vote_count} ${row.votes ? `(${row.votes})` : ''}\n` +
            `Avg Rating: ${row.avg_rating ? parseFloat(row.avg_rating).toFixed(1) : 'N/A'}\n` +
            `Preview: ${row.content_preview}\n`
          ).join('\n')
        )
        .setColor('#9932CC')
        .setTimestamp();

      return message.reply({ embeds: [voteEmbed] });
    } catch (error) {
      console.error('Error fetching vote stats:', error);
      return message.reply('❌ Error fetching voting statistics.');
    }
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


//==================================================================================================

//old code

// require("dotenv").config();
// const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
// const pool = require("./db");
// const { sendOTP } = require("./email");
// const cron = require("node-cron");
// const rateLimit = require("express-rate-limit");

// // ── PASTE YOUR DOUBTS CHANNEL ID HERE ────────────────────────────────────
// const QUESTIONS_CHANNEL_ID = "1381593523698143232"; 
// // ─────────────────────────────────────────────────────────────────────────────

// const client = new Client({
//   intents: [
//     GatewayIntentBits.Guilds,
//     GatewayIntentBits.GuildMembers,
//     GatewayIntentBits.GuildMessages,
//     GatewayIntentBits.MessageContent,
//   ],
// });

// // Generate a 6-digit OTP
// function generateOTP() {
//   return Math.floor(100000 + Math.random() * 900000).toString();
// }

// // Schedule daily reminders for unresolved doubts
// function scheduleDoubtReminders() {
//   // runs daily at 10:00 AM server time
//   cron.schedule("0 10 * * *", async () => {
//     const { rows } = await pool.query(
//       "SELECT author_id, array_agg(id) AS pending_ids FROM doubts WHERE resolved = false GROUP BY author_id"
//     );
//     for (const r of rows) {
//       try {
//         const user = await client.users.fetch(r.author_id);
//         await user.send(
//           `🔔 You have ${r.pending_ids.length} unresolved doubts (IDs: ${r.pending_ids.join(", ")}).`
//         );
//       } catch {
//         console.warn(`Could not DM reminder to ${r.author_id}`);
//       }
//     }
//   });
// }

// client.once("ready", () => {
//   console.log(`✅ Bot online as ${client.user.tag}`);
//   scheduleDoubtReminders();
// });

// // Welcome DM handler
// client.on("guildMemberAdd", async (member) => {
//   try {
//     const welcomeEmbed = new EmbedBuilder()
//       .setTitle('👋 Welcome to AlgoPath!')
//       .setDescription([
//         `Hi **${member.user.username}**, welcome aboard!`,
//         '',
//         '**Note**: You will only be able to join the AlgoPath community if your email is registered with AlgoPath.',
//         '',
//         '**If already registered**, then follow the below steps to get verified and join the community',
//         '',
//         '**Getting Started Tips:**',
//         '- Use `!verify your@algopath.com` in #welcome to register',
//         '- Follow the DM instructions to complete OTP verification',
//         '- Then ask doubts in #doubts with `!ask`',
//         '- View or resolve them with `!doubts`/`!resolve`',
//         '',
//         '_If you don’t see the email, check your spam folder or wait a minute._'
//       ].join('\n'))
//       .setFooter({ text: 'Need help? Use !help' })
//       .setTimestamp();

//     await member.send({ embeds: [welcomeEmbed] });
//   } catch {
//     console.warn(`DM failed for ${member.user.tag}`);
//   }
// });

// client.on("messageCreate", async (message) => {
//   if (message.author.bot || !message.guild) return;

//   const [command, ...args] = message.content.trim().split(/\s+/);

//   // ── RESTRICT DOUBT COMMANDS TO #questions ───────────────────────────────────
//   const doubtCommands = ["!ask", "!resolve", "!doubts"];
//   if (doubtCommands.includes(command) && message.channel.id !== QUESTIONS_CHANNEL_ID) {
//     return message.reply(`❌ Please use this command only in <#${QUESTIONS_CHANNEL_ID}>.`);
//   }
//   // ─────────────────────────────────────────────────────────────────────────────

//   // ---- Doubt commands ----
//   if (command === "!ask") {
//     const question = args.join(" ");
//     if (!question) return message.reply("❌ Please provide a question after !ask.");
//     const { rows } = await pool.query(
//       "INSERT INTO doubts (author_id, question) VALUES ($1, $2) RETURNING id",
//       [message.author.id, question]
//     );
//     return message.reply(`✅ Doubt submitted (ID: ${rows[0].id}). Someone will help soon!`);
//   }

//   if (command === "!resolve") {
//     const id = parseInt(args[0]);
//     if (!id) return message.reply("❌ Please provide a valid doubt ID.");
//     const { rows } = await pool.query(
//       "SELECT resolved, author_id FROM doubts WHERE id = $1",
//       [id]
//     );
//     if (!rows.length || rows[0].author_id !== message.author.id) {
//       return message.reply("❌ Doubt ID not found or not your doubt.");
//     }
//     if (rows[0].resolved) return message.reply("ℹ️ This doubt is already resolved.");

//     await pool.query(
//       "UPDATE doubts SET resolved = true, resolved_by = $1, resolved_at = NOW() WHERE id = $2",
//       [message.author.id, id]
//     );
//     return message.reply(`✅ Doubt ${id} marked as resolved. Great job!`);
//   }

//   if (command === "!doubts") {
//     const filter = args[0];
//     let sql = "SELECT id, question, resolved FROM doubts WHERE author_id = $1";
//     const params = [message.author.id];
//     if (filter === "open") sql += " AND resolved = false";
//     else if (filter === "closed") sql += " AND resolved = true";
//     sql += " ORDER BY id";

//     const { rows } = await pool.query(sql, params);
//     if (!rows.length) return message.reply("ℹ️ You have no doubts matching that filter.");

//     const total = rows.length;
//     const open = rows.filter(d => !d.resolved).length;
//     const closed = total - open;
//     const embed = new EmbedBuilder()
//       .setTitle(`Your Doubts (${filter || 'all'})`)
//       .setDescription(
//         rows.map(d => `• [${d.id}] ${d.question} — ${d.resolved ? '✅' : '❌'}`).join("\n")
//       )
//       .setFooter({ text: `Total: ${total} | Open: ${open} | Closed: ${closed}` });

//     return message.reply({ embeds: [embed] });
//   }

//   // ---- Verification commands (unchanged) ----
//   if (command === "!verify") {
//     const email = args[0];
//     if (!email || !email.includes("@")) return message.reply("❌ Please provide a valid email.");
//     try {
//       const allowed = await pool.query(
//         "SELECT 1 FROM allowed_emails WHERE email = $1",
//         [email]
//       );
//       if (!allowed.rows.length) return message.reply("❌ This email is not authorized.");

//       const otp = generateOTP();
//       const expires = new Date(Date.now() + 5 * 60 * 1000);
//       await pool.query(
//         "INSERT INTO users (discord_id, email, otp, otp_expires, verified) VALUES ($1,$2,$3,$4,false) ON CONFLICT (email) DO UPDATE SET otp = EXCLUDED.otp, otp_expires = EXCLUDED.otp_expires",
//         [message.author.id, email, otp, expires]
//       );
//       await sendOTP(email, otp);
//       return message.reply("📧 OTP has been sent to your email. Use `!otp <code>` to verify.");
//     } catch (err) {
//       console.error(err);
//       return message.reply("⚠️ Error sending OTP. Please try again later.");
//     }
//   }

//   if (command === "!otp") {
//     const otp = args[0];
//     if (!otp) return message.reply("❌ Please enter the OTP code.");
//     try {
//       const { rows } = await pool.query(
//         "SELECT discord_id FROM users WHERE discord_id = $1 AND otp = $2 AND otp_expires > NOW()",
//         [message.author.id, otp]
//       );
//       if (!rows.length) return message.reply("❌ Invalid or expired OTP.");

//       await pool.query(
//         "UPDATE users SET verified = true WHERE discord_id = $1",
//         [message.author.id]
//       );
//       const member = await message.guild.members.fetch(message.author.id);
//       const role = message.guild.roles.cache.find(r => r.name === "Member");
//       if (role) await member.roles.add(role);
//       return message.reply("✅ Verification successful! You've been granted access.");
//     } catch (err) {
//       console.error(err);
//       return message.reply("⚠️ Something went wrong. Try again later.");
//     }
//   }
// });


// // ─── Web-server for invite page ─────────────────────────────────────────
// const express = require("express");
// const path    = require("path");
// const app     = express();

// app.use(express.json());
// app.use(express.static(path.join(__dirname, "public")));

// // Rate limiter: max 5 requests per 15 minutes per IP
// const inviteLimiter = rateLimit({
//   windowMs: 15 * 60 * 1000, // 15 minutes
//   max: 5,                   // Limit each IP to 5 requests
//   message: {
//     error: "Too many requests. Please try again after 15 minutes."
//   }
// });

// // Apply to invite endpoint only
// app.use('/get-discord-invite', inviteLimiter);

// app.post("/get-discord-invite", async (req, res) => {
//   const { email } = req.body;
//   if (!email || !email.includes("@")) {
//     return res.status(400).json({ error: "Please provide a valid email." });
//   }

//   try {
//     const { rows } = await pool.query(
//       "SELECT 1 FROM allowed_emails WHERE email = $1", [email]
//     );
//     if (!rows.length) {
//       return res.status(403).json({ error: "Email not authorized." });
//     }

//     const channel = await client.channels.fetch(process.env.INVITE_CHANNEL_ID);
//     const invite  = await channel.createInvite({
//       maxUses: 1, maxAge: 3600, unique: true
//     });

//     return res.json({ invite: `https://discord.gg/${invite.code}` });
//   } catch (err) {
//     console.error("Invite generation error:", err);
//     return res.status(500).json({ error: "Server error. Try again later." });
//   }
// });

// const WEB_PORT = process.env.WEB_PORT || 3000;
// app.listen(WEB_PORT, () =>
//   console.log(`🌐 Invite server listening on http://localhost:${WEB_PORT}`)
// );
// // ─────────────────────────────────────────────────────────────────────────
// client.login(process.env.DISCORD_TOKEN);