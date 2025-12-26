import { ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from "discord.js";
import Queue from "../../queue/queue";

const queue = new Queue();

module.exports = {
  data: new SlashCommandBuilder()
    .setName("prompt")
    .setDescription("Ask the course assistant (policy-enforced).")
    .addStringOption((option) =>
      option.setName("input").setDescription("Your question").setRequired(true)
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    // ephemeral so the public response goes into the thread only
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    queue.addItem(interaction);
  },
};