import test from 'node:test';
import assert from 'node:assert/strict';
import { titleOf, slugOf, workspaceLabel, tabLabel, agentName, branchName, commitSubject, commitMessage, ticketOf } from '../runner/names.js';

test('title and slug come from the first brief line', () => {
  assert.equal(titleOf('# Repository onboarding\n\nExplore this repo.'), 'Repository onboarding');
  assert.equal(slugOf('# Repository onboarding\n\nExplore this repo.'), 'repository-onboarding');
  assert.equal(titleOf(''), 'task');
  assert.equal(slugOf('!!!'), 'task');
  assert.equal(slugOf('Remove the unused legacy Kotlin/Ktor backend so backend-ts is the only API'), 'remove-the-unused-legacy-kotlin-ktor-bac');
  assert.equal(slugOf('Café already — résumé'), 'cafe-already-resume');
});

test('worker commit subjects prefer assignment titles and never use agent ids', () => {
  assert.equal(commitSubject({ title: 'Implement an improvement', assignment: '# Fix the greeting copy\n\nUpdate value.txt.' }), 'Fix the greeting copy');
  assert.equal(commitSubject({ title: 'Implement an improvement', assignment: 'assignment.md' }), 'Implement an improvement');
  assert.equal(commitSubject({ assignment: 'workers/ab971192/handoff.md', handoff: 'Updated the greeting.' }), 'Updated the greeting.');
  assert.equal(commitSubject({}), 'Apply worker changes');
  assert.equal(commitMessage({ title: 'Implement an improvement', assignment: 'Fix the greeting copy', handoff: 'Updated value.txt.\n\nTests pass.' }).body, 'Updated value.txt.\n\nTests pass.');
});

test('worker commit subjects include a ticket id from the brief', () => {
  assert.equal(ticketOf('Fix greeting', 'Ticket: MEA-48\nUse UTF-8.'), 'MEA-48');
  assert.equal(ticketOf('See #25 for the wording.'), '#25');
  assert.equal(ticketOf('Keep UTF-8 and SHA-256.'), '');
  assert.equal(commitSubject({ title: 'Implement an improvement', assignment: 'Fix the greeting copy', brief: 'Ticket: MEA-48' }), 'MEA-48: Fix the greeting copy');
  assert.equal(commitSubject({ title: 'MEA-48 Implement an improvement', assignment: 'Fix the greeting copy' }), 'MEA-48: Fix the greeting copy');
  assert.equal(commitSubject({ title: 'MEA-48: Fix the greeting copy' }), 'MEA-48: Fix the greeting copy');
  assert.equal(commitSubject({ assignment: 'Fix the greeting copy', ticket: '#25' }), '#25: Fix the greeting copy');
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
