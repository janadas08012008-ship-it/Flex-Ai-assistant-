import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { load, db } from "./store.js";
import { tools, execute } from "./tools.js";

// ---------- Config ----------
const client = new Anthropic(); // reads ANTHROPIC_API_KEY from .env
const MODEL = process.env.FLEX_MODEL || "claude-sonnet-5";
const MAX_HISTORY = 40;
const MAX_TOOL_ROUNDS = 12;

// ---------- System prompts (Agent mode + AI Mentor mode) ----------
function systemPrompt(mode) {
  const { profile, settings } = db();
  const date = new Date().toISOString().slice(0, 10);
  const who = profile ? `The user is ${profile.name}${profile.role ? ` (${profile.role})` : ""}.` : "";

  if (mode === "mentor") {
    return `You are Flex's AI Mentor: a supportive, practical project coach.
Today is ${date}. ${who} Tone: ${settings.tone}.
- First look at the real situation with get_status_report or list_tasks (mine=true).
- Then advise on prioritisation, unblocking, workload and the next 1-3 actions.
- Ask at most one question at a time.
- Do NOT change any data unless the user explicitly asks.`;
  }

 return `You are Flex, an autonomous project management assistant. You break goals into
tasks,
coordinate the team, and handle status updates so the user doesn't have to.
Today is ${date}. ${who} Tone: ${settings.tone}.

ONBOARDING: ${
   profile
    ? "Done."
    : "The user has no profile yet. Greet them, ask their name and role, and ask who is on their
team. Then call setup_profile and add_team_member."
 }

RULES
- When the user states a goal: create_goal, then break it into 4-8 concrete tasks with add_tasks.
  Assign tasks to team members by role and workload (check list_team); leave unassigned if
unsure.
- Never guess data. Use list_goals, list_tasks, list_team, get_status_report.
- Status updates: call get_status_report, then write a short update covering progress, what's
done,
  in progress, blocked, overdue, and recommended next steps.
- "My tasks" means list_tasks with mine=true.
- Always mention IDs (G-1, T-3) so the user can refer to items.
- If the user declines an action, don't retry it.`;
}

// ---------- Agent loop ----------
async function runTurn(history, ctx) {
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: systemPrompt(ctx.mode),
      tools,
      messages: history,
    });

     history.push({ role: "assistant", content: response.content });

     if (response.stop_reason !== "tool_use") {
       return response.content
         .filter((b) => b.type === "text")
         .map((b) => b.text)
         .join("\n");
     }

     const results = [];
     for (const block of response.content) {
       if (block.type !== "tool_use") continue;
       console.log(` [tool] ${block.name}`);
       const out = await execute(block.name, block.input, ctx);
       results.push({ type: "tool_result", tool_use_id: block.id, content: out });
     }
     history.push({ role: "user", content: results });
    }
    return "I hit my step limit for this request. Tell me to continue and I'll pick up.";
}

// ---------- CLI helpers ----------
function printActivity(n = 15) {
  const items = db().activity.slice(-n);
    if (!items.length) return console.log("\nNo activity yet.\n");
    console.log("\nAgent activity:");
    for (const a of items) {
      console.log(` ${a.at.replace("T", " ").slice(0, 16)} ${a.actor}: ${a.action}`);
    }
    console.log();
}

const HELP = `
Commands:
 /status Flex writes a project status update
 /mentor Switch to AI Mentor mode (coaching)
 /agent     Switch back to Agent mode
 /activity Show what Flex has done
 /help     Show this list
 exit      Quit

Just talk to Flex to add goals, tasks, teammates, or change settings
(e.g. "set autonomy to confirm").
`;

// ---------- Main ----------
async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Missing ANTHROPIC_API_KEY. Add it to your .env file.");
    process.exit(1);
  }

    await load();
    const rl = readline.createInterface({ input, output });
    const ctx = {
      mode: "agent",
      confirm: async (q) =>
       (await rl.question(`\n${q}\nAllow? (y/n) `)).trim().toLowerCase().startsWith("y"),
    };
    const history = [];

    console.log("Flex is ready. Type /help for commands.\n");

    async function send(text) {
     history.push({ role: "user", content: text });
     try {
       console.log(`\nFlex: ${await runTurn(history, ctx)}\n`);
     } catch (err) {
            console.error(`\nError: ${err.message}\n`);
            history.pop();
        }
        while (history.length > MAX_HISTORY) history.shift();
        while (history.length && !(history[0].role === "user" && typeof history[0].content === "string"))
{
            history.shift();
        }
    }

    // First launch: Flex starts the onboarding conversation itself
    if (!db().profile) await send("Hi! This is my first time here. Please start onboarding.");

    while (true) {
     const text = (await rl.question("You: ")).trim();
     if (!text) continue;

  const cmd = text.toLowerCase();
  if (cmd === "exit" || cmd === "quit") break;
  if (cmd === "/help") { console.log(HELP); continue; }
  if (cmd === "/activity") { printActivity(); continue; }
  if (cmd === "/mentor") { ctx.mode = "mentor"; console.log("\nMentor mode on. /agent to
switch back.\n"); continue; }
  if (cmd === "/agent") { ctx.mode = "agent"; console.log("\nAgent mode on.\n"); continue; }
  if (cmd === "/status") { await send("Give me a status update on all my projects."); continue; }

        await send(text);
    }

    rl.close();
    console.log("Flex: Bye!");
}

main();
