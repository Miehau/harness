#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { capturePage } from "../scripts/screenshot.mjs";

export const help = `Usage: node .agent-plan/ui.mjs <command> [--url URL] [--screenshot PATH] [--video PATH.webm]
  tasks list
  tasks open <id>
  tasks add <description>       Creates a task and starts its workflow
  workspace open                Opens the repository dialog and loads access policy
  workspace close               Closes the repository dialog
  workspace extra-root <path> <read-only|read/write>
  workspace any on|off
  workspace save-policy
  workspace keyboard            Tab through policy controls and operate the access checkbox
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
    const [noun, verb, value, extra] = command;
    const valid = noun === "tasks" ? (verb === "list" ? command.length === 2 : ["open", "add"].includes(verb) && command.length === 3)
      : noun === "workspace" ? (
          ["open", "close", "save-policy", "keyboard"].includes(verb) && command.length === 2
          || verb === "any" && command.length === 3 && ["on", "off"].includes(value)
          || verb === "extra-root" && command.length === 4 && ["read-only", "read/write"].includes(extra)
        )
      : ["stage", "tab", "click"].includes(noun) && command.length === 2;
    if (!valid) throw new Error(`Unknown UI command: ${command.join(" ")}`);
  }
  if (!Array.isArray(assertions) || assertions.length > 50 || assertions.some((assertion) => {
    if (!assertion || typeof assertion.selector !== "string" || !assertion.selector.trim()) return true;
    const hasText = typeof assertion.text === "string" && assertion.text.trim();
    const hasValue = typeof assertion.value === "string" && assertion.value.trim();
    return !hasText && !hasValue;
  })) {
    throw new Error("Assertions require a selector and non-empty expected text or value");
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
  const press = async (key, modifiers = 0) => {
    const codes = { Tab: 9, Enter: 13, " ": 32, ArrowDown: 40, ArrowUp: 38, Home: 36, a: 65 };
    for (const type of ["keyDown", "keyUp"]) await globalThis.__agentPlanInput("Input.dispatchKeyEvent", { type, key, code: key === " " ? "Space" : key, windowsVirtualKeyCode: codes[key], modifiers });
  };
  const clickElement = async (element) => {
    element.scrollIntoView({ block: "center" });
    const box = element.getBoundingClientRect();
    const x = (Math.max(0, box.left) + Math.min(innerWidth, box.right)) / 2;
    const y = (Math.max(0, box.top) + Math.min(innerHeight, box.bottom)) / 2;
    if (!element.contains(document.elementFromPoint(x, y))) throw new Error(`UI target is covered: ${element.id || element.textContent}`);
    for (const type of ["mousePressed", "mouseReleased"]) await globalThis.__agentPlanInput("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  };
  const click = async (selector) => {
    const element = await wait(() => {
      const matches = [...document.querySelectorAll(selector)].filter(visible);
      if (matches.length > 1) throw new Error(`Ambiguous UI target: ${selector}`);
      return matches[0] && !matches[0].disabled ? matches[0] : null;
    }, `visible enabled ${selector}`);
    await clickElement(element);
  };
  const fill = async (selector, value) => {
    await click(selector);
    await press("a", /Mac/.test(navigator.platform) ? 4 : 2);
    await globalThis.__agentPlanInput("Input.insertText", { text: value });
  };
  await wait(() => visible(document.querySelector("#free-text-open")), "dashboard loaded");
  const results = [];
  for (const [commandIndex, command] of commands.entries()) {
    try {
    const [noun, verb, value, extra] = command;
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
      await fill('#free-text-form [name="description"]', value);
      await click('#free-text-form button[type="submit"]');
      await wait(() => !document.querySelector("#free-text-dialog").open && document.querySelector("#ticket-header h2")?.textContent === value.split("\n")[0], "new task selected");
      results.push({ added: value.split("\n")[0] });
    } else if (noun === "workspace") {
      if (verb === "open") {
        await click("#workspace-settings");
        await wait(() => document.querySelector("#workspace-dialog")?.open && document.querySelector("#access-policy-form")?.dataset.loaded === "true", "workspace access policy loaded");
      } else if (verb === "close") {
        await click("#workspace-dialog [data-close-dialog]");
        await wait(() => !document.querySelector("#workspace-dialog")?.open, "workspace dialog closed");
      } else if (verb === "any") {
        const box = document.querySelector("#access-any");
        if (box.checked !== (value === "on")) await click("#access-any");
        await wait(() => document.querySelector("#access-mode-status")?.textContent.includes(value === "on" ? "Any access" : "Restricted"), "access mode label");
      } else if (verb === "extra-root") {
        const before = document.querySelectorAll("[data-extra-root]").length;
        await click("#add-extra-root");
        await wait(() => document.querySelectorAll("[data-extra-root]").length === before + 1, "extra root row added");
        const row = [...document.querySelectorAll("[data-extra-root]")].at(-1);
        const input = row.querySelector(".extra-root-path");
        await fill(`[data-extra-root]:last-child .extra-root-path`, value);
        const select = row.querySelector(".extra-root-mode");
        await click("[data-extra-root]:last-child .extra-root-mode");
        const targetIndex = [...select.options].findIndex((option) => option.value === extra);
        await press("Home");
        for (let i = 0; i < targetIndex; i++) await press("ArrowDown");
        await press("Enter");
        await wait(() => row.querySelector(".extra-root-path")?.value === value && row.querySelector(".extra-root-mode")?.value === extra, "extra root filled");
      } else if (verb === "save-policy") {
        await click("#save-access-policy");
        await wait(() => {
          const error = document.querySelector("#access-policy-error");
          error?.scrollIntoView({ block: "center" });
          return Boolean(error?.textContent.trim()) || /saved/i.test(document.querySelector("#access-policy-status")?.textContent || "");
        }, "access policy submit result");
      } else {
        const dialog = document.querySelector("#workspace-dialog");
        const controls = [...dialog.querySelectorAll("button, input, select")].filter((element) => !element.disabled && visible(element));
        if (controls.length < 4) throw new Error("Policy controls are not keyboard-reachable");
        const reached = new Set();
        for (let i = 0; i < controls.length + 2; i++) {
          await press("Tab");
          reached.add(document.activeElement);
        }
        const missing = controls.filter((control) => !reached.has(control));
        if (missing.length) throw new Error(`Keyboard cannot reach: ${missing.map((control) => control.id || control.textContent.trim()).join(", ")}`);
        const checkbox = document.querySelector("#access-any");
        for (let i = 0; document.activeElement !== checkbox && i <= controls.length; i++) await press("Tab");
        const before = checkbox.checked;
        await press(" ");
        await wait(() => checkbox.checked !== before, "Space operates access checkbox");
        await press(" ");
        await wait(() => checkbox.checked === before, "Space restores access checkbox");
      }
    } else if (noun === "stage" || noun === "tab") {
      await click(`[data-${noun}=${JSON.stringify(verb)}]`);
    } else {
      const matches = [...document.querySelectorAll("button")].filter((element) => visible(element) && (element.getAttribute("aria-label") || element.textContent).trim() === verb);
      if (matches.length !== 1 || matches[0].disabled) throw new Error(`Missing, disabled or ambiguous button: ${verb}`);
      await clickElement(matches[0]);
    }
    } catch (error) { throw new Error(`Journey action ${commandIndex + 1} (${command.join(" ")}): ${error.message}`); }
  }
  for (const { selector, text, value } of assertions) await wait(() => {
    const matches = [...document.querySelectorAll(selector)].filter(visible).filter((element) => (
      (text == null || element.textContent.includes(text)) && (value == null || element.value === value)
    ));
    return matches.length === 1;
  }, `${selector} matches ${JSON.stringify({ text, value })}`);
  return { results, assertions, url: location.href };
}

export async function runJourney({ url, commands, assertions = [], screenshot, video, width = 1440, height = 900, capture = capturePage }) {
  validateJourney(commands, assertions);
  if (![width, height].every((value) => Number.isInteger(value) && value >= 240 && value <= 4096)) throw new Error("Viewport dimensions must be integers between 240 and 4096");
  if (video && !video.endsWith(".webm")) throw new Error("UI recordings must use .webm");
  const parsedUrl = new URL(url);
  if (!["http:", "https:"].includes(parsedUrl.protocol)) throw new Error("UI URL must use HTTP or HTTPS");
  let result;
  try { await capture({ url, out: screenshot, video, width, height, interact: async ({ evaluate }) => {
    result = await evaluate(`(${navigate.toString()})(${JSON.stringify(commands)}, ${JSON.stringify(assertions)})`);
  } }); }
  catch (error) {
    if (screenshot) await writeFile(`${screenshot}.failure.json`, JSON.stringify({ url, commands, assertions, error: error.message }, null, 2));
    throw error;
  }
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
