require("dotenv").config();

import { REST, Routes } from "discord.js";
import fs from "fs";
import path from "path";

const BOT_TOKEN = process.env.DISCORD_LLM_BOT_TOKEN;
const CLIENT_ID = process.env.DISCORD_LLM_BOT_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_TEST_GUILD_ID; // <-- ADD THIS

export default async function deployCommands() {
  if (!BOT_TOKEN) throw new Error("Missing DISCORD_LLM_BOT_TOKEN in .env");
  if (!CLIENT_ID) throw new Error("Missing DISCORD_LLM_BOT_CLIENT_ID in .env");
  if (!GUILD_ID) throw new Error("Missing DISCORD_TEST_GUILD_ID in .env"); // <-- ADD THIS

  const commands: any[] = [];

  // IMPORTANT: when compiled, __dirname will be dist/deploy, so this points to dist/commands
  const foldersPath = path.join(__dirname, "../commands");
  const commandFolders = fs.readdirSync(foldersPath);

  for (const folder of commandFolders) {
    const commandsPath = path.join(foldersPath, folder);
    const commandFiles = fs.readdirSync(commandsPath).filter((file) => file.endsWith(".js"));

    for (const file of commandFiles) {
      const filePath = path.join(commandsPath, file);
      const command = require(filePath);

      if ("data" in command && "execute" in command) {
        commands.push(command.data.toJSON());
      } else {
        console.log(`[WARNING] The command at ${filePath} is missing "data" or "execute".`);
      }
    }
  }

  const rest = new REST().setToken(BOT_TOKEN);

  try {
    console.log(`Started refreshing ${commands.length} guild (/) commands...`);

    // CHANGE THIS LINE: global -> guild
    const data: any = await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: commands }
    );

    console.log(`Successfully reloaded ${data.length} guild (/) commands.`);
  } catch (error) {
    console.error(error);
  }
}

if (require.main === module) {
  deployCommands().catch((e) => {
    console.error("Deploy failed:", e);
    process.exit(1);
  });
}