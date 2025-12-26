import {
  ChatInputCommandInteraction,
  DiscordAPIError,
  Message,
  TextChannel,
  ThreadAutoArchiveDuration,
  ThreadChannel,
} from "discord.js";

import { ollamaChatStream, coursePolicySystemPrompt, type ChatMessage } from "../ollama/ollama";

const wait = require("node:timers/promises").setTimeout;

interface QueueObject {
  [interactionId: string]: {
    interaction: ChatInputCommandInteraction;
    status: {
      position: number;
      processing: boolean;
      waiting: boolean;
    };
    thread: ThreadChannel | undefined;
  };
}

class Queue {
  queue: QueueObject;
  interval: NodeJS.Timeout | undefined;

  private static readonly CONCURRENT_QUEUE_SIZE = 3;
  private static readonly LLM_MODEL = "llama3.1:latest";

  constructor() {
    this.queue = {};
  }

  addItem(interaction: ChatInputCommandInteraction) {
    const queueLength = this.length();

    this.queue[interaction.id] = {
      interaction,
      status: {
        position: queueLength,
        processing: false,
        waiting: false,
      },
      thread: undefined,
    };

    if (this.interval === undefined) {
      console.log("Starting the queue processor");
      this.startQueue();
    }
  }

  private recomputePositions() {
    const ids = Object.keys(this.queue);
    // preserve insertion order (Object keys are insertion-ordered in modern JS)
    for (let i = 0; i < ids.length; i++) {
      this.queue[ids[i]].status.position = i;
    }
  }

  removeItem(interactionId: string) {
    console.log(`Removed ${interactionId} from queue`);
    delete this.queue[interactionId];
    this.recomputePositions();
  }

  getItem(interactionId: string) {
    return this.queue[interactionId];
  }

  length() {
    return Object.keys(this.queue).length;
  }

  isEmpty() {
    return this.length() === 0;
  }

  startQueue() {
    this.interval = setInterval(() => this.processQueue(), 2000);
  }

  stopQueue() {
    console.log("Entire queue has been processed. Stopping the queue processor");
    if (this.interval) clearInterval(this.interval);
    this.interval = undefined;
  }

  assignThread(interactionId: string, thread: ThreadChannel) {
    this.queue[interactionId].thread = thread;
  }

  private static looksLikeAnswerFishing(text: string) {
    const t = text.toLowerCase();

    const patterns: RegExp[] = [
      /just give (me )?the answer/i,
      /what('?s| is) the answer/i,
      /solve (this|it)( for me)?/i,
      /final answer/i,
      /complete solution/i,
      /\bhomework\b|\bhw\b|\bmidterm\b|\bfinal\b|\bexam\b/i,
      /do it for me/i,
    ];

    return patterns.some((r) => r.test(t));
  }

  processQueue = async () => {
    if (this.isEmpty()) {
      this.stopQueue();
      return;
    }

    const interactionIds = Object.keys(this.queue);

    // count currently processing
    const currentlyProcessing = interactionIds.reduce((acc, id) => {
      return acc + (this.queue[id].status.processing ? 1 : 0);
    }, 0);

    let availableSlots = Queue.CONCURRENT_QUEUE_SIZE - currentlyProcessing;
    if (availableSlots <= 0) return;

    for (const interactionId of interactionIds) {
      if (availableSlots <= 0) break;

      const item = this.queue[interactionId];
      if (!item) continue;

      if (!item.status.processing) {
        console.log(`Processing task with interaction id ${interactionId}`);
        item.status.processing = true;

        const interaction = item.interaction;
        const channelId = interaction.channelId;
        const channel = await interaction.client.channels.fetch(channelId);

        // Fire-and-forget; we manage completion in processTask
        this.processTask(interaction, channel as TextChannel).catch((e) => {
          console.error("processTask error:", e);
          // best-effort cleanup
          this.removeItem(interaction.id);
        });

        availableSlots--;
      } else {
        // optional: update waiting messages, but avoid spam
      }
    }
  };

  processTask = async (interaction: ChatInputCommandInteraction, channel: TextChannel) => {
    const prompt = interaction.options.getString("input") ?? "";
    const userName = interaction.user.displayName ?? interaction.user.username;

    console.log(`User ${interaction.user.id} prompt: ${prompt}`);

    const newThread = await channel.threads.create({
      name: `[${userName}] - Prompt`,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneHour,
      reason: "LLM Bot Auto Created Thread",
    });

    this.assignThread(interaction.id, newThread);

    // Hard stop if answer fishing
    if (Queue.looksLikeAnswerFishing(prompt)) {
      await newThread.send(
        [
          "I can’t provide direct answers to graded/homework/exam questions.",
          "But I *can* help you get unstuck:",
          "• Tell me what you’ve tried so far, and where you think you’re stuck.",
          "• I can point you to the relevant lecture material and give hints.",
          "If you need the official solution, please go to office hours or email your TA/professor.",
        ].join("\n")
      );

      await interaction.deleteReply().catch(() => {});
      this.removeItem(interaction.id);
      return;
    }

    // TEMP: course name placeholder (later map from channel/guild -> course)
    const courseName = "Course";

    const messages: ChatMessage[] = [
      { role: "system", content: coursePolicySystemPrompt(courseName) },
      { role: "user", content: prompt },
    ];

    let reader;
    try {
      reader = await ollamaChatStream(Queue.LLM_MODEL, messages);
    } catch (error) {
      console.error("Ollama connection error:", error);
      await newThread.send(
        "I couldn’t reach the local Ollama server. Make sure Ollama is running on this machine (localhost:11434)."
      );
      await interaction.deleteReply().catch(() => {});
      this.removeItem(interaction.id);
      return;
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let responseChunks: string[] = [];
    const sentMessages: Message[] = [];

    const throttleResponse = async () => {
      if (responseChunks.length === 0) return;

      // send new message if needed
      if (sentMessages.length === 0 || sentMessages.length !== responseChunks.length) {
        const m = await newThread.send(responseChunks[responseChunks.length - 1]);
        sentMessages.push(m);
      }

      // edit existing messages
      for (let i = 0; i < sentMessages.length; i++) {
        if (sentMessages[i].content !== responseChunks[i]) {
          await sentMessages[i].edit(responseChunks[i]).catch(() => {});
        }
      }
    };

    const throttleInterval = setInterval(() => throttleResponse(), 1500);

    const consumeLines = (onJson: (obj: any) => void) => {
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;

        try {
          onJson(JSON.parse(line));
        } catch {
          // ignore malformed line
        }
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;

        buffer += decoder.decode(value, { stream: true });

        consumeLines((obj) => {
          const chunk: string = obj?.message?.content ?? "";
          if (!chunk) return;

          if (responseChunks.length === 0) responseChunks.push("");

          const lastIdx = responseChunks.length - 1;
          const current = responseChunks[lastIdx];

          // stay under Discord message limits
          if (current.length + chunk.length > 1800) {
            responseChunks.push(chunk);
          } else {
            responseChunks[lastIdx] = current + chunk;
          }
        });
      }
    } catch (error) {
      console.error("Streaming error:", error);
      await newThread.send("An error occurred while generating the response. Please try again.");
    } finally {
      clearInterval(throttleInterval);
      await wait(500);
      await throttleResponse();

      await interaction.deleteReply().catch(() => {});
      this.removeItem(interaction.id);
    }
  };
}

export default Queue;