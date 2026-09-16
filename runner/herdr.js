import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { exec, assert } from './io.js';
const extension = fileURLToPath(new URL('./pi-extension.js', import.meta.url));
export class Herdr {
  async call(...args) {
    try {
      const { stdout } = await exec('herdr', args, { timeout: 45000, maxBuffer: 1024 * 1024 });
      const value = JSON.parse(stdout); return value.result ?? value;
    } catch (error) {
      // execFile's default message includes argv, which contains the agent credential.
      error.message = `Herdr ${args[0]} ${args[1] ?? ''} failed (${error.code ?? 'unknown'})`;
      try { const detail = JSON.parse(error.stderr || error.stdout).error; error.message = detail.message; error.code = detail.code; } catch {}
      for (const arg of args.filter(a => /^RUNNER_(?:TOKEN|REPLY_TOKEN)=/.test(a))) error.message = String(error.message).replaceAll(arg.slice(arg.indexOf('=') + 1), '[redacted]');
      throw error;
    }
  }
  async create(task, agent, url) {
    const env = ['--env', `PATH=${resolve(dirname(extension), '../node_modules/.bin')}:${process.env.PATH}`, '--env', `RUNNER_URL=${url}`, '--env', `RUNNER_TOKEN=${agent.token}`, '--env', `RUNNER_REPLY_TOKEN=${agent.replyToken}`];
    let row;
    try { row = task.workspace
      ? await this.call('tab', 'create', '--workspace', task.workspace, '--cwd', agent.cwd, '--label', `${agent.role} ${agent.id.slice(0, 8)}`, ...env, '--no-focus')
      : await this.call('workspace', 'create', '--cwd', agent.cwd, '--label', `runner ${task.id.slice(0, 8)}`, ...env, '--no-focus');
    } catch (error) {
      if (!task.workspace || !['workspace_not_found', 'target_not_found'].includes(error.code)) throw error;
      row = await this.call('workspace', 'create', '--cwd', agent.cwd, '--label', `runner ${task.id.slice(0, 8)}`, ...env, '--no-focus');
    }
    assert(row.root_pane?.pane_id && row.tab?.tab_id, 'Herdr did not return a pane and tab');
    return { pane: row.root_pane.pane_id, tab: row.tab.tab_id, workspace: row.workspace?.workspace_id ?? task.workspace };
  }
  async availableModels(query) {
    let stdout;
    try { ({ stdout } = await exec(process.execPath, [resolve(dirname(extension), '../node_modules/@earendil-works/pi-coding-agent/dist/cli.js'), '--list-models', ...(query ? [query] : [])], { timeout: 20000, maxBuffer: 1024 * 1024 })); }
    catch { throw new Error('Could not inspect Pi model availability; inspect Pi configuration before retrying'); }
    return stdout.split('\n').map(line => line.trim().split(/\s+/)).filter(row => row.length >= 3 && /\d/.test(row[2])).map(row => ({ provider: row[0], model: row[1] }));
  }
  async resolveModel(selection) {
    if (!selection.model && !selection.provider) return selection;
    assert(selection.model, 'Specify a model with the provider');
    const matches = (await this.availableModels(selection.model)).filter(row => row.model === selection.model && (!selection.provider || row.provider === selection.provider));
    assert(matches.length === 1, 'Model is unavailable or ambiguous in Pi; configure a provider/model with credentials');
    return matches[0];
  }
  async start(agent, config) {
    // Herdr 0.8 requires a settled foreground shell. Never blindly retry agent start.
    const waitForShell = async () => {
      const deadline = Date.now() + 15000;
      while (true) {
        const info = (await this.call('pane', 'process-info', '--pane', agent.place.pane)).process_info;
        const processes = info?.foreground_processes ?? [];
        const process = processes[0];
        if (processes.length === 1 && /^(?:-?zsh|-?bash|sh|fish)$/.test(process.name) && [info.shell_pid, info.foreground_process_group_id].every(value => !Number.isFinite(Number(value)) || Number(value) === Number(process.pid))) break;
        assert(Date.now() < deadline, 'Herdr pane did not become an idle shell');
        await sleep(200);
      }
    };
    await waitForShell();
    const args = ['--no-extensions', '--no-skills', '--no-prompt-templates', '--tools', 'runner_read,runner_write,runner_action', '-e', extension, '--session', agent.session];
    if (config.model) args.push('--model', config.model);
    if (config.provider) args.push('--provider', config.provider);
    const previous = (await this.call('workspace', 'list')).workspaces?.find(w => w.focused);
    await this.call('tab', 'focus', agent.place.tab);
    try {
      await waitForShell();
      const launch = () => this.call('agent', 'start', agent.name, '--kind', 'pi', '--pane', agent.place.pane, '--timeout', '30000', '--', ...args);
      try { await launch(); } catch (error) {
        // This explicit rejection means no agent was launched; other failures are uncertain.
        if (!error.message.includes('is not an available shell')) throw error;
        await sleep(300); await waitForShell(); await launch();
      }
    } finally {
      const current = (await this.call('workspace', 'list').catch(() => ({}))).workspaces?.find(w => w.focused);
      if (previous?.active_tab_id && current?.active_tab_id === agent.place.tab) {
        await this.call('workspace', 'focus', previous.workspace_id).catch(() => {});
        await this.call('tab', 'focus', previous.active_tab_id).catch(() => {});
      }
    }
  }
  async ready() {
    try { await this.call('workspace', 'list'); } catch (error) { throw new Error(`Start Herdr first: ${error.message}`); }
  }
  async open(agent) {
    assert(agent.place, 'This task has no Herdr session; inspect its launch error');
    await this.call('workspace', 'focus', agent.place.workspace);
    await this.call('tab', 'focus', agent.place.tab);
    return agent.place;
  }
  async status(agent) {
    try { const row = await this.call('agent', 'get', agent.name); return row.agent?.agent_status ?? row.agent_status ?? 'unknown'; }
    catch (e) { if (['agent_not_found', 'target_not_found'].includes(e.code)) return 'missing'; return 'unknown'; }
  }
  async stop(agent) {
    if (!agent.place) return;
    // Close only the exact tab created for this attempt, never a user workspace.
    try { await this.call('tab', 'close', agent.place.tab); } catch (error) { if (!['tab_not_found', 'workspace_not_found', 'target_not_found'].includes(error.code)) throw error; }
  }
}
