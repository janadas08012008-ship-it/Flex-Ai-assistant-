import fs from "node:fs/promises";

const FILE = "flex_data.json";

const DEFAULTS = {
  profile: null, // { name, role } - set during onboarding
  goals: [],
  tasks: [],
  team: [],
  activity: [],
  counters: { G: 0, T: 0 },
  settings: {
    autonomy: "auto", // "auto" = Flex acts freely, "confirm" = asks before changing anything
    tone: "concise and friendly",
    statusFrequency: "weekly",
  },
};

let data = structuredClone(DEFAULTS);

export async function load() {
  try {
    const saved = JSON.parse(await fs.readFile(FILE, "utf8"));
    data = {
      ...structuredClone(DEFAULTS),
      ...saved,
      counters: { ...DEFAULTS.counters, ...saved.counters },
      settings: { ...DEFAULTS.settings, ...saved.settings },
    };
  } catch {
    data = structuredClone(DEFAULTS);
  }
  return data;
}

export async function save() {
  await fs.writeFile(FILE, JSON.stringify(data, null, 2));
}

export const db = () => data;

export function nextId(prefix) {
 data.counters[prefix] += 1;
 return `${prefix}-${data.counters[prefix]}`;
}

export function log(actor, action, detail = "") {
  data.activity.push({ at: new Date().toISOString(), actor, action, detail });
  if (data.activity.length > 500) data.activity.shift();
}
