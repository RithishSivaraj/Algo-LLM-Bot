require("dotenv").config();

import path from "path";
import fs from "fs";
import { Client, Collection, Events, GatewayIntentBits, Partials } from "discord.js";
import deployCommands from "./deploy/deployCommands";

const BOT_TOKEN = process.env.DISCORD_LLM_BOT_TOKEN;

if (!BOT_TOKEN) {
  throw new Error("Missing DISCORD_LLM_BOT_TOKEN in .env");
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageTyping,
    GatewayIntentBits.MessageContent, // needed for mention-only + profanity moderation
  ],
  partials: [Partials.Channel],
});

// NOTE: you likely have a types/discord.d.ts that adds `commands` onto Client
client.commands = new Collection();

const foldersPath = path.join(__dirname, "commands");
const commandFolders = fs.readdirSync(foldersPath);

for (const folder of commandFolders) {
  const commandsPath = path.join(foldersPath, folder);
  const commandFiles = fs.readdirSync(commandsPath).filter((file) => file.endsWith(".js"));

  for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    const command = require(filePath);

    if ("data" in command && "execute" in command) {
      client.commands.set(command.data.name, command);
    } else {
      console.log(`[WARNING] The command at ${filePath} is missing "data" or "execute".`);
    }
  }
}

client.once(Events.ClientReady, async () => {
  console.log(`Bot is online! Logged in as ${client.user?.tag}`);

  // Optional: auto deploy commands on startup (toggle with env var)
  const shouldDeploy = (process.env.DISCORD_DEPLOY_COMMANDS ?? "true").toLowerCase() === "true";
  if (shouldDeploy) {
    await deployCommands();
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const command = interaction.client.commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction);
  } catch (error) {
    console.error(error);
    const msg = "There was an error while executing this command!";
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: msg, ephemeral: true });
    } else {
      await interaction.reply({ content: msg, ephemeral: true });
    }
  }
});

// (Optional) Mention-only behavior + profanity moderation will be added later
// Here we keep current behavior primarily via /prompt threads.

client.login(BOT_TOKEN);