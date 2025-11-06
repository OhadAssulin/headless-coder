#!/usr/bin/env node
/**
 * Executes a workspace script across all packages using the active package manager.
 *
 * Supports both npm (via --workspaces) and pnpm (via --recursive run).
 */

import { spawn } from 'node:child_process';
import process from 'node:process';

const [, , lifecycle, ...passedArgs] = process.argv;

if (!lifecycle) {
  console.error('Usage: node ./scripts/run-workspaces.mjs <script> [args...]');
  process.exit(1);
}

const userAgent = process.env.npm_config_user_agent ?? '';
const execPath = process.env.npm_execpath ?? '';
const nodeExec = process.env.npm_node_execpath ?? process.execPath;

/**
 * Determines whether the caller already supplied per-workspace flags.
 *
 * @returns {boolean} True when a workspace selection flag is present.
 */
function hasExplicitWorkspaceSelection() {
  return passedArgs.some(arg => arg === '--workspace' || arg === '--workspaces');
}

const hasWorkspaceOverride = hasExplicitWorkspaceSelection();

/**
 * Resolves the command and arguments to invoke the current package manager.
 *
 * @param {string[]} runArgs Arguments tailored for the detected manager.
 * @param {string} fallback Binary to invoke when execPath is unavailable.
 * @returns {{command: string, args: string[]}} Spawn configuration.
 */
function resolveCommand(runArgs, fallback) {
  if (execPath) {
    return {
      command: nodeExec,
      args: [execPath, ...runArgs],
    };
  }
  return {
    command: fallback,
    args: runArgs,
  };
}

let spawnConfig;

if (userAgent.startsWith('pnpm/')) {
  const coreArgs = ['run', '--recursive', lifecycle];
  spawnConfig = resolveCommand(coreArgs.concat(passedArgs), 'pnpm');
} else {
  // Default to npm semantics.
  const npmArgs = ['run', lifecycle];
  if (!hasWorkspaceOverride) {
    npmArgs.push('--workspaces', '--if-present');
  }
  const finalArgs =
    passedArgs.length && !hasWorkspaceOverride
      ? npmArgs.concat(['--', ...passedArgs])
      : npmArgs.concat(passedArgs);
  spawnConfig = resolveCommand(finalArgs, 'npm');
}

const child = spawn(spawnConfig.command, spawnConfig.args, {
  stdio: 'inherit',
  shell: false,
});

child.on('exit', code => {
  process.exit(code ?? 0);
});
