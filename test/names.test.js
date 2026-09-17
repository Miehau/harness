import test from 'node:test';
import assert from 'node:assert/strict';
import { titleOf, slugOf, workspaceLabel, tabLabel, agentName, branchName } from '../runner/names.js';

test('title and slug come from the first brief line', () => {
  assert.equal(titleOf('# Repository onboarding\n\nExplore this repo.'), 'Repository onboarding');
  assert.equal(slugOf('# Repository onboarding\n\nExplore this repo.'), 'repository-onboarding');
  assert.equal(titleOf(''), 'task');
  assert.equal(slugOf('!!!'), 'task');
  assert.equal(slugOf('Remove the unused legacy Kotlin/Ktor backend so backend-ts is the only API'), 'remove-the-unused-legacy-kotlin-ktor-bac');
  assert.equal(slugOf('Café already — résumé'), 'cafe-already-resume');
});

test('branches, workspace labels and agent names stay readable and unique', () => {
  const task = { id: '8f374acc-909f-4c3b-a9f7-b69797b4ee41', title: 'Remove unused Kotlin backend', slug: 'remove-unused-kotlin-backend' };
  assert.equal(workspaceLabel(task), 'Remove unused Kotlin backend');
  assert.equal(branchName(task, 'integration'), 'runner/remove-unused-kotlin-backend-8f374acc');
  assert.equal(branchName(task, 'discovery-a1b2c3'), 'runner/remove-unused-kotlin-backend-8f374acc-discovery-a1b2c3');
  assert.equal(tabLabel({ role: 'orchestrator' }), 'Coordinator');
  assert.equal(tabLabel({ role: 'worker', stage: 'discovery' }), 'Discovery worker');
  assert.equal(agentName(task, { id: '9979bc7b-f88d-4d00-0000-000000000000', role: 'orchestrator' }), 'remove-unused-kotlin-bac-coord-9979');
});
