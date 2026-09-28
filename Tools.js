import { db, nextId, log, save } from "./store.js";

const today = () => new Date().toISOString().slice(0, 10);
const same = (a, b) => (a || "").toLowerCase() === (b || "").toLowerCase();

// ---------- Helpers ----------
function findMember(name) {
  const m = db().team.find((t) => same(t.name, name));
  if (!m) {
    const team = db().team.map((t) => t.name).join(", ") || "(empty)";
    throw new Error(`"${name}" is not on the team. Team: ${team}. Use add_team_member
first.`);
  }
  return m;
}

function findGoal(id) {
  const g = db().goals.find((x) => x.id === id);
  if (!g) throw new Error(`Goal ${id} not found.`);
  return g;
}

function findTask(id) {
  const t = db().tasks.find((x) => x.id === id);
  if (!t) throw new Error(`Task ${id} not found.`);
  return t;
}

function progress(goalId) {
  const ts = db().tasks.filter((t) => t.goalId === goalId);
  if (!ts.length) return 0;
  return Math.round((100 * ts.filter((t) => t.status === "done").length) / ts.length);
}

const obj = (properties = {}, required = []) => ({ type: "object", properties, required });
const str = (description) => ({ type: "string", description });
const STATUSES = ["todo", "in_progress", "blocked", "done"];
const PRIORITIES = ["low", "medium", "high"];

// ---------- Tool definitions (what the model sees) ----------
export const tools = [
  {
    name: "setup_profile",
    description: "Onboarding: save the user's profile. Also adds them to the team.",
  input_schema: obj({ name: str("User's name"), role: str("User's role") }, ["name"]),
},
{
  name: "create_goal",
  description: "Create a new goal. After creating, break it into tasks with add_tasks.",
  input_schema: obj(
    { title: str("Goal title"), description: str("Details"), due_date: str("YYYY-MM-DD") },
    ["title"]
  ),
},
{
  name: "list_goals",
  description: "List goals with progress.",
  input_schema: obj({ status: { type: "string", enum: ["active", "paused", "completed"] } }),
},
{
  name: "update_goal",
  description: "Update a goal's title, status or due date.",
  input_schema: obj(
    {
      goal_id: str("e.g. G-1"),
      title: str("New title"),
      status: { type: "string", enum: ["active", "paused", "completed"] },
      due_date: str("YYYY-MM-DD"),
    },
    ["goal_id"]
  ),
},
{
  name: "add_tasks",
  description: "Add one or more tasks to a goal (use this to break a goal down).",
  input_schema: obj(
    {
      goal_id: str("e.g. G-1"),
      tasks: {
        type: "array",
        items: obj(
          {
            title: str("Task title"),
            description: str("Details"),
            assignee: str("Team member name"),
            due_date: str("YYYY-MM-DD"),
            priority: { type: "string", enum: PRIORITIES },
          },
          ["title"]
        ),
      },
    },
    ["goal_id", "tasks"]
  ),
},
{
  name: "list_tasks",
  description: "List tasks. Use mine=true for the current user's tasks (My Tasks view).",
  input_schema: obj({
    goal_id: str("Filter by goal"),
    assignee: str("Filter by team member"),
    status: { type: "string", enum: STATUSES },
    mine: { type: "boolean", description: "Only the current user's tasks" },
  }),
},
{
  name: "update_task",
  description: "Update a task's status, assignee, due date, priority or title.",
  input_schema: obj(
    {
      task_id: str("e.g. T-3"),
      title: str("New title"),
      status: { type: "string", enum: STATUSES },
      assignee: str("Team member name"),
      due_date: str("YYYY-MM-DD"),
      priority: { type: "string", enum: PRIORITIES },
    },
    ["task_id"]
  ),
},
{
  name: "add_team_member",
  description: "Add a person to the team.",
  input_schema: obj({ name: str("Name"), role: str("Role"), email: str("Email") }, ["name"]),
},
{
  name: "list_team",
  description: "List team members with their open-task workload.",
  input_schema: obj(),
},
{
  name: "get_status_report",
    description:
      "Get data for a status update: progress per goal, task counts, overdue, blocked, unassigned,
workload.",
    input_schema: obj(),
  },
  {
    name: "get_activity",
    description: "Get the agent activity log (what Flex has done).",
    input_schema: obj({ limit: { type: "integer", description: "Default 15" } }),
  },
  {
    name: "get_settings",
    description: "Get current settings.",
    input_schema: obj(),
  },
  {
    name: "update_settings",
    description:
      "Update settings. autonomy: 'auto' (Flex acts freely) or 'confirm' (asks before changes).",
    input_schema: obj({
      autonomy: { type: "string", enum: ["auto", "confirm"] },
      tone: str("e.g. 'formal', 'casual and short'"),
      status_frequency: { type: "string", enum: ["daily", "weekly", "monthly"] },
    }),
  },
  {
    name: "get_time",
    description: "Get the current date and time.",
    input_schema: obj(),
  },
];

// ---------- Handlers (what actually runs) ----------
const handlers = {
  setup_profile: ({ name, role = "" }) => {
    db().profile = { name, role };
    if (!db().team.some((t) => same(t.name, name))) db().team.push({ name, role, email: "" });
    return `Profile saved for ${name}.`;
  },

 create_goal: ({ title, description = "", due_date = null }) => {
  const goal = {
    id: nextId("G"),
    title,
    description,
    dueDate: due_date,
    status: "active",
    createdAt: today(),
  };
  db().goals.push(goal);
  return goal;
},

list_goals: ({ status } = {}) =>
  db()
    .goals.filter((g) => !status || g.status === status)
    .map((g) => ({
      ...g,
      progress: `${progress(g.id)}%`,
      taskCount: db().tasks.filter((t) => t.goalId === g.id).length,
    })),

update_goal: ({ goal_id, title, status, due_date }) => {
  const g = findGoal(goal_id);
  if (title) g.title = title;
  if (status) g.status = status;
  if (due_date) g.dueDate = due_date;
  return g;
},

add_tasks: ({ goal_id, tasks }) => {
 findGoal(goal_id);
 // Validate everything first so we never half-create a batch
 const assignees = tasks.map((t) => (t.assignee ? findMember(t.assignee).name : null));
 return tasks.map((t, i) => {
   const task = {
     id: nextId("T"),
     goalId: goal_id,
     title: t.title,
     description: t.description || "",
     assignee: assignees[i],
     dueDate: t.due_date || null,
     priority: t.priority || "medium",
     status: "todo",
     createdAt: today(),
   };
   db().tasks.push(task);
   return task;
   });
 },

 list_tasks: ({ goal_id, assignee, status, mine } = {}) => {
   let who = assignee;
   if (mine) {
     if (!db().profile) throw new Error("No profile yet. Run onboarding (setup_profile) first.");
     who = db().profile.name;
   }
   return db().tasks.filter(
     (t) =>
       (!goal_id || t.goalId === goal_id) &&
       (!who || same(t.assignee, who)) &&
       (!status || t.status === status)
   );
 },

 update_task: ({ task_id, title, status, assignee, due_date, priority }) => {
   const t = findTask(task_id);
   if (title) t.title = title;
   if (assignee) t.assignee = findMember(assignee).name;
   if (due_date) t.dueDate = due_date;
   if (priority) t.priority = priority;
   if (status) {
     t.status = status;
     t.completedAt = status === "done" ? today() : null;
   }
   return t;
 },

 add_team_member: ({ name, role = "", email = "" }) => {
   if (db().team.some((t) => same(t.name, name))) throw new Error(`${name} is already on the
team.`);
   const member = { name, role, email };
   db().team.push(member);
   return member;
 },

 list_team: () =>
   db().team.map((m) => ({
     ...m,
     openTasks: db().tasks.filter((t) => same(t.assignee, m.name) && t.status !== "done").length,
   })),
 get_status_report: () => {
   const { goals, tasks, team } = db();
   const now = today();
   const open = tasks.filter((t) => t.status !== "done");
   const brief = (t) => ({ id: t.id, title: t.title, assignee: t.assignee, dueDate: t.dueDate });
   return {
     date: now,
     goals: goals.map((g) => ({
       id: g.id,
       title: g.title,
       status: g.status,
       dueDate: g.dueDate,
       progress: `${progress(g.id)}%`,
     })),
     taskCounts: Object.fromEntries(
       STATUSES.map((s) => [s, tasks.filter((t) => t.status === s).length])
     ),
     overdue: open.filter((t) => t.dueDate && t.dueDate < now).map(brief),
     blocked: tasks.filter((t) => t.status === "blocked").map(brief),
     unassigned: open.filter((t) => !t.assignee).map(brief),
     workload: team.map((m) => ({
       name: m.name,
       open: open.filter((t) => same(t.assignee, m.name)).length,
     })),
   };
 },

 get_activity: ({ limit = 15 } = {}) => db().activity.slice(-limit),

 get_settings: () => db().settings,

 update_settings: ({ autonomy, tone, status_frequency }) => {
   const s = db().settings;
   if (autonomy) s.autonomy = autonomy;
   if (tone) s.tone = tone;
   if (status_frequency) s.statusFrequency = status_frequency;
   return s;
 },

  get_time: () => new Date().toString(),
};

// Tools that change data (logged to activity, saved to disk, may need confirmation)
const WRITE_TOOLS = new Set([
  "setup_profile",
  "create_goal",
  "update_goal",
  "add_tasks",
  "update_task",
  "add_team_member",
  "update_settings",
]);

export async function execute(name, input, { confirm }) {
 const handler = handlers[name];
 if (!handler) return `Unknown tool: ${name}`;

    const isWrite = WRITE_TOOLS.has(name);
    const summary = JSON.stringify(input).slice(0, 200);

    // Settings: "confirm" mode makes Flex ask before changing anything (except onboarding)
    if (isWrite && name !== "setup_profile" && db().settings.autonomy === "confirm") {
      const ok = await confirm(`Flex wants to run ${name} ${summary}`);
      if (!ok) {
        log("flex", `${name} (declined by user)`, summary);
        await save();
        return "The user declined this action. Do not retry it; ask what they'd like instead.";
      }
    }

    try {
      const result = handler(input || {});
      if (isWrite) {
        log("flex", name, summary);
        await save();
      }
      return typeof result === "string" ? result : JSON.stringify(result, null, 2);
    } catch (err) {
      return `Error: ${err.message}`;
    }
}
