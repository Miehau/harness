#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { capturePage } from "../scripts/screenshot.mjs";

export const help = `Usage: node .agent-plan/ui.mjs <command> [--url URL] [--screenshot PATH] [--video PATH.webm]
  tasks list
  tasks open <id>
  tasks add <description>       Creates a task and starts its workflow
  journey <scenario.json>      Runs commands and assertions in one browser session

Scenario: {"commands":[["tasks","open","id"],["stage","verify"],["tab","details"]],
           "assertions":[{"selector":"#ticket-header","text":"Expected title"}]}
Journey commands also support click <exact button label>. An ambiguous or missing button fails.
URL defaults to AGENT_PLAN_CAPTURE_URL or http://127.0.0.1:4317.
Use isolated fixtures for tests. No API shortcuts are used for navigation.
`;

export function validateJourney(commands, assertions = []) {
  if (!Array.isArray(commands) || !commands.length || commands.length > 50) throw new Error("A journey needs 1–50 commands");
  for (const command of commands) {
    if (!Array.isArray(command) || command.some((word) => typeof word !== "string" || !word.trim())) throw new Error("Commands must be non-empty string arrays");
    const [noun, verb] = command;
    const valid = noun === "tasks" ? (verb === "list" ? command.length === 2 : ["open", "add"].includes(verb) && command.length === 3)
      : ["stage", "tab", "click"].includes(noun) && command.length === 2;
    if (!valid) throw new Error(`Unknown UI command: ${command.join(" ")}`);
  }
  if (!Array.isArray(assertions) || assertions.length > 50 || assertions.some((assertion) => !assertion || typeof assertion.selector !== "string" || !assertion.selector.trim() || typeof assertion.text !== "string" || !assertion.text.trim())) {
    throw new Error("Assertions require a selector and non-empty expected text");
  }
}

// Executed in the browser; keep project selectors and UI assertions together.
async function navigate(commands, assertions) {
  const visible = (element) => element && element.getClientRects().length && getComputedStyle(element).visibility !== "hidden";
  const wait = async (predicate, description) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const value = predicate();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`UI assertion failed: ${description}`);
  };
  const click = async (selector) => {
    const element = await wait(() => {
      const matches = [...document.querySelectorAll(selector)].filter(visible);
      if (matches.length > 1) throw new Error(`Ambiguous UI target: ${selector}`);
      return matches[0] && !matches[0].disabled ? matches[0] : null;
    }, `visible enabled ${selector}`);
    element.scrollIntoView({ block: "center" });
    element.click();
  };
  await wait(() => visible(document.querySelector("#free-text-open")), "dashboard loaded");
  const results = [];
  for (const [noun, verb, value] of commands) {
    if (noun === "tasks" && verb === "list") {
      await wait(() => document.querySelector("#ticket-list")?.textContent.trim(), "task list loaded");
      results.push([...document.querySelectorAll("[data-ticket]")].map((element) => ({ id: element.dataset.ticket, text: element.innerText })));
    } else if (noun === "tasks" && verb === "open") {
      const selector = `[data-ticket=${JSON.stringify(value)}]`;
      const title = await wait(() => document.querySelector(selector)?.querySelector("strong")?.textContent, `task ${value} exists`);
      await click(selector);
      await wait(() => document.querySelector("#ticket-header h2")?.textContent === title, `selected task ${value} title`);
      results.push({ selected: value, title });
    } else if (noun === "tasks" && verb === "add") {
      await click("#free-text-open");
      const input = document.querySelector('#free-text-form [name="description"]');
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await click('#free-text-form button[type="submit"]');
      await wait(() => !document.querySelector("#free-text-dialog").open && document.querySelector("#ticket-header h2")?.textContent === value.split("\n")[0], "new task selected");
      results.push({ added: value.split("\n")[0] });
    } else if (noun === "stage" || noun === "tab") {
      await click(`[data-${noun}=${JSON.stringify(verb)}]`);
    } else {
      const matches = [...document.querySelectorAll("button")].filter((element) => visible(element) && (element.getAttribute("aria-label") || element.textContent).trim() === verb);
      if (matches.length !== 1 || matches[0].disabled) throw new Error(`Missing, disabled or ambiguous button: ${verb}`);
      matches[0].click();
    }
  }
  for (const { selector, text } of assertions) await wait(() => {
    const matches = [...document.querySelectorAll(selector)].filter(visible);
    return matches.length === 1 && matches[0].textContent.includes(text);
  }, `${selector} contains ${JSON.stringify(text)}`);
  return { results, assertions, url: location.href };
}

export async function runJourney({ url, commands, assertions = [], screenshot, video, width = 1440, height = 900, capture = capturePage }) {
  validateJourney(commands, assertions);
  if (![width, height].every((value) => Number.isInteger(value) && value >= 240 && value <= 4096)) throw new Error("Viewport dimensions must be integers between 240 and 4096");
  if (video && !video.endsWith(".webm")) throw new Error("UI recordings must use .webm");
  const parsedUrl = new URL(url);
  if (!["http:", "https:"].includes(parsedUrl.protocol)) throw new Error("UI URL must use HTTP or HTTPS");
  let result;
  await capture({ url, out: screenshot, video, width, height, interact: async ({ evaluate }) => {
    result = await evaluate(`(${navigate.toString()})(${JSON.stringify(commands)}, ${JSON.stringify(assertions)})`);
  } });
  return { ...result, commands, screenshot: screenshot || null, video: video || null };
}

export async function runUi(argv, { stdout = process.stdout } = {}) {
  if (!argv.length || argv.includes("--help")) { stdout.write(help); return; }
  const args = [...argv];
  const options = {};
  for (let index = 0; index < args.length;) {
    if (!args[index].startsWith("--")) { index++; continue; }
    const name = args[index].slice(2);
    if (!["url", "screenshot", "video"].includes(name) || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`Invalid option: ${args[index]}`);
    options[name] = args[index + 1];
    args.splice(index, 2);
  }
  const scenario = args[0] === "journey" && args.length === 2 ? JSON.parse(await readFile(args[1], "utf8")) : { commands: [args] };
  const result = await runJourney({ ...scenario, ...options, url: options.url || process.env.AGENT_PLAN_CAPTURE_URL || "http://127.0.0.1:4317" });
  stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runUi(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
